'use strict';
// Public TS observations only. No native candidate, registry, or historical executable is loaded.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const dir = path.resolve(process.env.SDK_ORIGIN_ORACLE_OUTPUT || __dirname);
const recipePath = path.resolve(process.argv[2] || path.join(dir, '../t00-closure-review-recipes/replay-recipes.json'));
const packageDir = path.resolve(process.argv[3] || 'C:/maintenence/semctx.codex-t00-review-20261021/node_modules/typescript');
const baselineRepo = path.resolve(process.argv[4] || 'C:/maintenence/semctx.codex-t00-review-20261021');
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
const assert = (v, msg) => { if (!v) throw new Error(msg); };
const write = (name, value) => fs.writeFileSync(path.join(dir, name), JSON.stringify(value, null, 2) + '\n');
const recipeBytes = fs.readFileSync(recipePath);
assert(hash(recipeBytes) === (process.env.SDK_ORIGIN_RECIPE_SHA256 || '1820a9fbce9772a74dd15f83842b30eb796a44fe24944f53cb80a24278d01bde'), 'recipe custody mismatch');
const custody = JSON.parse(fs.readFileSync(path.join(dir, 'sdk-package-byte-identity.json')));
for (const entry of custody.files) {
  const bytes = fs.readFileSync(path.join(packageDir, entry.path));
  assert(bytes.length === entry.size_bytes && hash(bytes) === entry.sha256, `SDK bytes mismatch: ${entry.path}`);
}
const sdkBytes = fs.readFileSync(path.join(dir, 'shared-sdk.json'));
assert(hash(sdkBytes) === 'f57257876a383d13839a94adefb42b3d40bad2e93489a0f1a5ab29f045f139e5', 'shared SDK mismatch');
const sdk = JSON.parse(sdkBytes);
assert(Object.keys(sdk.files).length === 100, 'SDK count');
const ts = require(path.join(packageDir, 'lib/typescript.js'));
assert(ts.version === '5.9.3', 'required TypeScript 5.9.3 missing');
const baselinePath = 'packages/ts-analyzer/src/semantic-dependency-diagnostics.ts';
const baselineBytes = cp.execFileSync('git', ['-C', baselineRepo, 'show', `3e94997f:${baselinePath}`]);
const baselineCommit = cp.execFileSync('git', ['-C', baselineRepo, 'rev-parse', '3e94997f^{commit}']).toString().trim();
const ranges = [[111,115],[173,199],[312,321],[389,395],[432,448],[458,468],[528,560],[946,958]];
const lines = baselineBytes.toString('utf8').split('\n');
write('baseline-rule-excerpts.json', { commit: baselineCommit, path: baselinePath, sha256: hash(baselineBytes), excerpts: ranges.map(([start,end]) => ({start,end,text:lines.slice(start-1,end).join('\n')})) });
const pairs = [
  ['Object.defineProperty','02-01','02-05'], ['Object.assign','01-01','01-05'],
  ['Proxy.revocable','08-01','08-02'], ['Reflect.apply','09-01','09-02'],
  ['Promise.resolve','04-01','04-04'], ['Reflect.set','03-01','03-04'],
].map(([callee,a,b]) => ({callee, ids:[a,b].map(s => `V3-SDK-${s}::base`)}));
const selected = pairs.flatMap(p => p.ids);
const recipes = JSON.parse(recipeBytes).recipes;
// Only input requests, frozen IDs and frozen unit hashes are retained from recipes.
const inputs = selected.map(id => {
  const matches = recipes.filter(r => r.unit_id === id);
  assert(matches.length === 1 && matches[0].requests.length === 1, `nonunique input ${id}`);
  return {unit_id:id, frozen_unit_sha256:matches[0].frozen_unit_sha256, request:matches[0].requests[0]};
});
const normalize = p => path.posix.normalize(p.replaceAll('\\','/'));
const pin = (p,text,role) => ({path:p, role, sha256:hash(Buffer.from(text,'utf8')), size_bytes:Buffer.byteLength(text,'utf8'), utf16_length:text.length});
const observations = [];
const pins = [];
for (const input of inputs) {
  const req = input.request;
  assert(Object.keys(req.raw_files).length === 0 && Object.keys(req.utf16_files).length === 0, 'non-text input requires separate capture');
  const files = new Map(Object.entries(sdk.files));
  for (const [name,text] of Object.entries(req.files)) files.set(normalize('/project/' + name), text);
  const projectPaths = new Set(Object.keys(req.files).map(p => normalize('/project/' + p)));
  const roots = req.roots.map(p => normalize('/project/' + p));
  const converted = ts.convertCompilerOptionsFromJson(req.options, '/project');
  const probes = [];
  const reads = [];
  const directories = new Set(['/','/project','/sdk','/sdk/lib']);
  for (const p of files.keys()) { let d = path.posix.dirname(p); while (!directories.has(d)) { directories.add(d); d = path.posix.dirname(d); } }
  const readFile = p => {
    const n = normalize(p), text = files.get(n);
    reads.push({operation:'readFile', requested_path:p, normalized_path:n, found:text !== undefined, ...(text === undefined ? {} : pin(n,text,projectPaths.has(n)?'retained_project':'captured_sdk_library'))});
    return text;
  };
  const host = {
    getSourceFile(p, languageVersion, onError) { const text = readFile(p); return text === undefined ? undefined : ts.createSourceFile(normalize(p),text,languageVersion,true); },
    getDefaultLibFileName: options => '/sdk/lib/' + ts.getDefaultLibFileName(options),
    getDefaultLibLocation: () => '/sdk/lib',
    writeFile() { throw new Error('emit is outside oracle scope'); },
    getCurrentDirectory: () => '/project', getDirectories: p => { probes.push({operation:'getDirectories',path:p}); return []; },
    getCanonicalFileName: p => normalize(p), useCaseSensitiveFileNames: () => true, getNewLine: () => '\n',
    fileExists(p) { const found = files.has(normalize(p)); probes.push({operation:'fileExists',path:p,found}); return found; },
    readFile,
    directoryExists(p) { const found = directories.has(normalize(p)); probes.push({operation:'directoryExists',path:p,found}); return found; },
    realpath: normalize,
  };
  const program = ts.createProgram(roots, converted.options, host);
  const checker = program.getTypeChecker();
  const declaration = node => {
    const source = node.getSourceFile(), p = normalize(source.fileName);
    const captured = files.get(p);
    assert(captured === source.text, `uncaptured declaration file ${p}`);
    const text = source.text.slice(node.getStart(source),node.end);
    return {file:p, kind:ts.SyntaxKind[node.kind], pos_utf16:node.pos, getStart_utf16:node.getStart(source), end_utf16:node.end,
      isSourceFileDefaultLibrary:program.isSourceFileDefaultLibrary(source), ...{source:pin(p,captured,projectPaths.has(p)?'retained_project':'captured_sdk_library')},
      declaration_text:text, declaration_utf8_base64:Buffer.from(text,'utf8').toString('base64'), declaration_sha256:hash(Buffer.from(text,'utf8')),
      ancestors:(() => { const result=[]; for(let n=node.parent;n && !ts.isSourceFile(n);n=n.parent) if(n.name) result.push({kind:ts.SyntaxKind[n.kind],name:n.name.getText(source)}); return result; })()};
  };
  const symbolAt = expr => {
    const symbol = checker.getSymbolAtLocation(expr);
    if (!symbol) return {state:'UNKNOWN_NO_SYMBOL',symbol:null,declarations:[]};
    const normalized = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
    return {state:'OBSERVED',symbol:{name:normalized.getName(),flags:normalized.flags,fully_qualified_name:checker.getFullyQualifiedName(normalized),alias_name:normalized===symbol?null:symbol.getName()}, declarations:(normalized.getDeclarations() || []).map(declaration)};
  };
  const calls=[];
  for(const source of program.getSourceFiles()) if(projectPaths.has(normalize(source.fileName))) {
    const visit = node => {
      if(ts.isCallExpression(node)) {
        const callee = node.expression;
        const receiver = ts.isPropertyAccessExpression(callee)||ts.isElementAccessExpression(callee)?callee.expression:undefined;
        const calleeSymbol = symbolAt(callee), receiverSymbol = receiver ? symbolAt(receiver) : null;
        const signature = checker.getResolvedSignature(node);
        const signatureNode = signature?.getDeclaration();
        const receiverSdk = receiverSymbol && receiverSymbol.declarations.length > 0 && receiverSymbol.declarations.every(d=>d.isSourceFileDefaultLibrary);
        const memberSdk = calleeSymbol.declarations.length > 0 && calleeSymbol.declarations.every(d=>d.isSourceFileDefaultLibrary);
        const receiverProject = receiverSymbol?.declarations.some(d=>d.source.role==='retained_project');
        const runtimeOrigin = receiverSdk && memberSdk ? 'DIRECT_DEFAULT_LIBRARY_RECEIVER_AND_MEMBER_BINDING'
          : receiverProject && calleeSymbol.declarations.some(d=>d.source.role==='retained_project') ? 'DIRECT_PROJECT_RECEIVER_AND_MEMBER_BINDING' : 'UNKNOWN_RUNTIME_ORIGIN';
        calls.push({file:normalize(source.fileName),callee_text:callee.getText(source),
          callee_dto:{text:ts.isPropertyAccessExpression(callee)?callee.name.text:callee.getText(source),syntax_kind:ts.SyntaxKind[callee.kind],rule:ts.isPropertyAccessExpression(callee)?'PropertyAccessExpression.name.text':'expression.getText(source)'},call_text:node.getText(source),
          call:{pos_utf16:node.pos,start_utf16:node.getStart(source),end_utf16:node.end},
          callee:{pos_utf16:callee.pos,start_utf16:callee.getStart(source),end_utf16:callee.end},
          callee_symbol:calleeSymbol,receiver:receiver?{text:receiver.getText(source),symbol:receiverSymbol}:null,
          resolved_signature:signature?{text:checker.signatureToString(signature),declaration:signatureNode?declaration(signatureNode):null}:null,
          runtime_origin_observation:{status:runtimeOrigin,scope:'static binding only; no runtime execution, mutation or environment guarantee',alias_traversal:'not needed for the six selected direct pairs; no generalized alias resolution claimed'}});
      }
      ts.forEachChild(node,visit);
    };
    visit(source);
  }
  const diagnostic = d => ({code:d.code,category:ts.DiagnosticCategory[d.category],file:d.file?.fileName ?? null,start_utf16:d.start??null,length_utf16:d.length??null,message:ts.flattenDiagnosticMessageText(d.messageText,'\n')});
  const diagnostics = [...converted.errors,...program.getOptionsDiagnostics(),...program.getSyntacticDiagnostics(),...program.getSemanticDiagnostics()].map(diagnostic);
  const loaded = program.getSourceFiles().map(s=>({...pin(s.fileName,s.text,projectPaths.has(s.fileName)?'retained_project':'captured_sdk_library'),isSourceFileDefaultLibrary:program.isSourceFileDefaultLibrary(s)}));
  const uniqueSdkReads = [...new Set(reads.filter(r=>r.found && r.role==='captured_sdk_library').map(r=>r.path))].sort();
  observations.push({unit_id:input.unit_id,frozen_unit_sha256:input.frozen_unit_sha256,calls,diagnostics,loaded_sources:loaded,host_reads:reads,host_probes:probes,
    sdk_read_subset:{available:100,unique_read_count:uniqueSdkReads.length,paths:uniqueSdkReads},unknown_reads:reads.filter(r=>!r.found),filesystem_fallback:false});
  pins.push({...input,source_files:Object.entries(req.files).map(([name,text])=>({...pin('/project/'+name,text,'retained_project'),utf8_base64:Buffer.from(text,'utf8').toString('base64')})),converted_options:converted.options,conversion_diagnostics:converted.errors.map(diagnostic)});
}
const contrasts = pairs.map(pair=>({callee:pair.callee,units:pair.ids.map(id=>{
  const unit=observations.find(o=>o.unit_id===id), call=unit.calls.find(c=>c.callee_text===pair.callee);
  assert(call,`target call absent ${id}`);
  return {unit_id:id,runtime_origin_observation:call.runtime_origin_observation,callee_declarations:call.callee_symbol.declarations.map(d=>({file:d.file,kind:d.kind,pos_utf16:d.pos_utf16,getStart_utf16:d.getStart_utf16,end_utf16:d.end_utf16,isSourceFileDefaultLibrary:d.isSourceFileDefaultLibrary,sha256:d.declaration_sha256})),receiver_declarations:call.receiver.symbol.declarations.map(d=>({file:d.file,kind:d.kind,getStart_utf16:d.getStart_utf16,end_utf16:d.end_utf16,isSourceFileDefaultLibrary:d.isSourceFileDefaultLibrary})),diagnostic_count:unit.diagnostics.length};
})}));
write('input-closure-pins.json',{scope:'12 existing public units only; no native execution or rewritten expectations',runtime:{node:process.version,platform:process.platform,arch:process.arch},typescript_version:ts.version,typescript_runtime_entry:custody.files.find(f=>f.path==='lib/typescript.js'),baseline:{commit:baselineCommit,path:baselinePath,sha256:hash(baselineBytes)},recipe:{sha256:hash(recipeBytes),size_bytes:recipeBytes.length},sdk:{sha256:hash(sdkBytes),count:100,available_files:Object.entries(sdk.files).map(([p,text])=>pin(p,text,'captured_sdk_library'))},inputs:pins});
write('raw-observations.json',{typescript_version:ts.version,host_policy:'Only captured /project files and 100 captured /sdk/lib libraries; all readFile requests recorded; no ts.sys filesystem fallback',units:observations});
write('contrastive-pairs.json',{pairs:contrasts});
console.log(JSON.stringify({units:observations.length,calls:observations.reduce((n,o)=>n+o.calls.length,0),diagnostics:observations.reduce((n,o)=>n+o.diagnostics.length,0),sdk_available:100,sdk_read_counts:[...new Set(observations.map(o=>o.sdk_read_subset.unique_read_count))],sdk_sha256:hash(sdkBytes)}));
