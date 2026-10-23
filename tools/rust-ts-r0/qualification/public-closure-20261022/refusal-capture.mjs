import { validatePublicUnits, rawContextChecks } from "./public-native-context.mjs";
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import os from 'node:os';

const [baseline, freezePath, inputPath, outputRoot] = process.argv.slice(2);
if (!outputRoot) throw new Error('expected baseline freeze inputs fresh-output-root');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const identity = async path => ({path, sha256:hash(await readFile(path))});
const canonical = value => JSON.stringify(value, (_key, field) => field && !Array.isArray(field) && typeof field === 'object' ? Object.fromEntries(Object.entries(field).sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0)) : field);
const normalizeExtraction = (value, native = false) => {
  const result = structuredClone(value);
  for (const key of ['modules','symbols','imports','calls']) {
    if (native && key === 'symbols') for (const symbol of result[key]) { delete symbol.startUtf16; delete symbol.endUtf16; }
    result[key].sort((a,b) => canonical(a) < canonical(b) ? -1 : canonical(a) > canonical(b) ? 1 : 0);
  }
  return result;
};
const freeze = JSON.parse(await readFile(freezePath));
const inputBytes = await readFile(inputPath);
const inputs = JSON.parse(inputBytes);
validatePublicUnits(inputs);
const sdk = JSON.parse(await readFile(freeze.sdk_path));
const ts = (await import(resolve(baseline,'node_modules/typescript/lib/typescript.js'))).default;
if (ts.version !== '5.9.3') throw new Error('requires exact TypeScript 5.9.3');
const symbols = await import(resolve(baseline,'packages/ts-analyzer/src/ts-symbols.ts'));
const analyze = await import(resolve(baseline,'packages/ts-analyzer/src/analyze.ts'));
const boundPaths = [freeze.artifact_path,freeze.sdk_path,resolve(baseline,'packages/ts-analyzer/src/ts-symbols.ts'),resolve(baseline,'packages/ts-analyzer/src/analyze.ts'),resolve(inputPath),import.meta.path,resolve(import.meta.dir,"public-native-context.mjs")];
const before = await Promise.all(boundPaths.map(identity));
if (before[0].sha256 !== freeze.artifact_sha256 || before[1].sha256 !== freeze.sdk_sha256) throw new Error('frozen inputs differ');
await mkdir(outputRoot);
const reports = [];
for (const unit of inputs.units) {
  const directory = resolve(outputRoot,unit.id);
  const root = resolve(directory,'repository');
  await mkdir(root,{recursive:true});
  const files = {};
  for (const [path,text] of Object.entries(unit.files)) {
    const target = resolve(root,path);
    await mkdir(dirname(target),{recursive:true});
    await writeFile(target,text);
    files[target] = text;
  }
  for (const [path,text] of Object.entries(unit.outside)) await writeFile(resolve(directory,path),text);
  const roots = Object.keys(files);
  const retained = unit.retained ? new Map(Object.entries(files)) : undefined;
  let expected;
  try {
    const extraction = symbols.extractTypeScript(roots,root,retained);
    if (unit.owner === 'analyzeRepository') {
      const config = {version:2,repositoryRoot:root,selectionMode:unit.qualified ? 'qualified-static-v1' : 'explicit-v1',analysisProfile:'public-monorepo-static-v1'};
      const discovered = Object.entries(files).map(([absPath,content]) => ({absPath,relPath:absPath.slice(root.length+1),role:'source',language:'typescript',content}));
      const analysis = analyze.analyzeRepository(config,discovered,retained);
      expected = {kind:'success',analysis,extraction};
    } else expected = {kind:'success',extraction};
  } catch (error) { expected = {kind:'exception',error:error.message}; }
  await writeFile(resolve(directory,'typescript-owning-outcome.json'),JSON.stringify(expected,null,2)+'\n');
  const request = {id:unit.id,cwd:root,sdk_directory:'/sdk/lib',case_sensitive:ts.sys.useCaseSensitiveFileNames,roots,files,options:{target:'ES2022',module:'ESNext',moduleResolution:'Bundler',allowJs:true,jsx:'Preserve',skipLibCheck:true,noEmit:true,strict:false},retained:unit.retained,qualified:unit.qualified,roles:{},selection:{},disabled:[],utf16_files:{},raw_files:{}};
  const requestPath = resolve(directory,'native-request.json');
  await writeFile(requestPath,JSON.stringify(request,null,2)+'\n');
  const argv = [freeze.artifact_path,requestPath,freeze.sdk_path];
  const start = performance.now();
  const processResult = spawnSync(argv[0],argv.slice(1),{cwd:root,env:{...process.env,GOPORT_LIB_PARSE_SNAPSHOT:'0',GOPORT_LIB_SNAPSHOT:'0'},timeout:40000,maxBuffer:33554432});
  const stdout = processResult.stdout ?? Buffer.alloc(0);
  const stderr = processResult.stderr ?? Buffer.alloc(0);
  await writeFile(resolve(directory,'native-stdout.bin'),stdout);
  await writeFile(resolve(directory,'native-stderr.bin'),stderr);
  const processEvidence = {argv,cwd:root,timeoutMs:40000,outputCapBytes:33554432,status:processResult.status,signal:processResult.signal,error:processResult.error?.message ?? null,durationMs:performance.now()-start,stdout:{bytes:stdout.length,sha256:hash(stdout)},stderr:{bytes:stderr.length,sha256:hash(stderr)},request:await identity(requestPath)};
  await writeFile(resolve(directory,'process-invocation.json'),JSON.stringify(processEvidence,null,2)+'\n');
  const checks = [];
  const check = (name,actual,expectedValue) => checks.push({name,actual,expected:expectedValue,pass:canonical(actual) === canonical(expectedValue)});
  check('no-process-error',processEvidence.error,null);
  check('no-process-signal',processEvidence.signal,null);
  if (expected.kind === 'exception') {
    check('refusal-exit-code',processResult.status,1);
    check('refusal-stdout-complete',stdout.toString(),'');
    const mappedError = unit.owner === 'analyzeRepository' && expected.error === 'SOURCE_SNAPSHOT_REQUIRED: qualified analysis requires retained source and configuration inputs' ? 'SOURCE_SNAPSHOT_REQUIRED' : expected.error;
    check('complete-stderr-json-bytes',stderr.toString(),JSON.stringify({error:mappedError})+'\n');
  } else {
    check('success-exit-code',processResult.status,0);
    check('success-stderr-complete',stderr.toString(),'');
    const observed = JSON.parse(stdout);
    check('producer-binding',observed.producer_artifact_id,'sha256:'+freeze.artifact_sha256);
    for (const [name, pass] of Object.entries(rawContextChecks(observed, request, sdk))) check('raw-context-'+name, pass, true);
    check('complete-extraction',normalizeExtraction(observed.raw_extraction,true),normalizeExtraction(expected.extraction));
    if (unit.id === 'in-root-call-control') check('real-call-target',expected.extraction.calls.some(call => call.calleeRelPath === 'leaf.ts' && call.calleeSymbolPath === 'leaf'),true);
  }
  reports.push({id:unit.id,obligation_indices:unit.obligation_indices,owner:unit.owner,pass:checks.every(check => check.pass),ownerBoundaryMatched:unit.owner === 'extractTypeScript',checks,rawDirectory:directory,process:processEvidence,typescriptOutcomeSha256:hash(await readFile(resolve(directory,'typescript-owning-outcome.json')))});
}
const after = await Promise.all(boundPaths.map(identity));
if (canonical(before) !== canonical(after)) throw new Error('bound inputs changed');
const report = {schemaVersion:1,platform:process.platform,architecture:os.arch(),baseline:inputs.baseline,typescript:ts.version,freeze:await identity(freezePath),sourceIdentities:before,boundInputsStable:true,units:reports,pass:reports.every(unit => unit.pass),formalR0Qualified:false,limitations:['Snapshot obligation 4 uses native raw analyze guard; retained runtime rejects ordinary missing snapshots before that guard. Its analyzeRepository owner boundary is not claimed closed.','Snapshot required message maps the entire baseline explanatory error to the native stable reason through the explicit sole mapping in this capture; no prefix-only stderr acceptance.']};
await writeFile(resolve(outputRoot,'result.json'),JSON.stringify(report,null,2)+'\n');
process.stdout.write(JSON.stringify({pass:report.pass,units:reports.map(unit => ({id:unit.id,pass:unit.pass,failures:unit.checks.filter(check => !check.pass)}))},null,2)+'\n');
