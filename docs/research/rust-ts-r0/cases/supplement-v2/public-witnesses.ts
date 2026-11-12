import {mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {hash,validateRuntime} from './integrity.ts';
const root=import.meta.dir,runtime=resolve(process.argv[2]??join(root,'primary')),source=join(runtime,'baseline-source'),out=resolve(process.argv[3]??join(runtime,'observed'));
mkdirSync(out,{recursive:true});const scratch=join(out,'scratch');mkdirSync(scratch,{recursive:true});
export const cases=[
 ['directory-alias','packages/ts-analyzer/test/discovery-missing-import-alias.test.ts','',3],
 ['reference-confinement','packages/ts-analyzer/test/discovery-selection.test.ts','records relative imports and reference paths escaping',1],
 ['native-inert','packages/ts-analyzer/test/create-require.test.ts','type-only native bindings',1],
 ['mixed-fallback','packages/ts-analyzer/test/javascript.test.ts','keeps mixed extraction in one semantic Program',1],
 ['external-partition','packages/ts-analyzer/test/parallel-extraction.test.ts','does not connect independent roots through the same external',1],
 ['namespace-owners','packages/ts-analyzer/test/semantic-js-contracts.test.ts','non-call namespace members retain|namespace destructuring preserves|unmodeled object members cannot claim',3],
 ['runtime-erased','packages/ts-analyzer/test/runtime-value-imports.test.ts','unused, erased and shadowed',1],
 ['workspace-boundaries','packages/ts-analyzer/test/workspace-configuration-links.test.ts','installed dependency keeps precedence|workspace declared above|legacy TS-only extraction',3],
 ['opaque-ownership','packages/ts-analyzer/test/opaque-inline-ownership.test.ts','opaque inline ownership|actual test binding ownership|anonymous default declaration',7],
 ['scope-admission','packages/app-services/test/qualified-analysis.test.ts','unretained generated reference|manifest optional dependencies|excluded parse-failed or computed',3],
 ['pilot-builtin','scripts/test/impact-pilot.test.ts','extractRelativeImportSpecifiers keeps only relative',1],
] as const;
const negative=process.argv.find(a=>a.startsWith('--negative='))?.split('=')[1];
const selected:any[]=negative==='missing'?[['negative-missing','packages/ts-analyzer/test/ABSENT-T00.test.ts','',1]]:negative==='zero'?[['negative-zero',cases[2][1],'T00_IMPOSSIBLE_MATCH_ZERO',1]]:[...cases];
const manifest=[];
for(const [id,file,pattern,expectedTests]of selected){
 const logPrefix=join(out,id);let runtimeEvidence:any,error:string|undefined;
 try{runtimeEvidence=validateRuntime(source,join(root,'v1-preserved'));const patches=JSON.parse(readFileSync(join(runtime,'instrumentation-manifest.json'),'utf8'));for(const f of patches.files)if(hash(readFileSync(join(source,f.path)))!==f.observedSha256)throw Error('INSTRUMENTATION_BYTES_MISMATCH:'+f.path);if(!existsSync(join(source,file)))throw Error('PUBLIC_WITNESS_FILE_MISSING:'+file);}catch(e){error=String((e as Error).message);}
 let exitCode:number|null=null,stdout='',stderr='',signalCode:any=null;
 const argv=['test','--timeout','60000',file,...pattern?['--test-name-pattern',pattern]:[]];
 if(!error){const r=Bun.spawnSync([process.execPath,...argv],{cwd:source,env:{...process.env,TMP:scratch,TEMP:scratch,T00_SCRATCH:scratch,T00_WITNESS:id,T00_CAPTURE_FILE:join(out,id+'.operations.jsonl'),NO_COLOR:'1',FORCE_COLOR:'0'},stdout:'pipe',stderr:'pipe',timeout:120000});exitCode=r.exitCode;signalCode=r.signalCode;stdout=new TextDecoder().decode(r.stdout);stderr=new TextDecoder().decode(r.stderr);}
 writeFileSync(logPrefix+'.stdout',stdout);writeFileSync(logPrefix+'.stderr',stderr);
 const passed=Number(stderr.match(/(?:^|\n)\s*(\d+) pass\b/)?.[1]??0),failed=Number(stderr.match(/(?:^|\n)\s*(\d+) fail\b/)?.[1]??0);
 const names=[...stderr.matchAll(/^\(pass\) (.+?)(?: \[[\d.]+(?:ms|s)\])?$/gm)].map(m=>m[1]);
 const status=!error&&exitCode===0&&passed===expectedTests&&failed===0&&names.length===expectedTests?'BASELINE_OBSERVED':'UNKNOWN';
 manifest.push({id,authority:{baseline:'3e94997fcbefa72ad4d49b2cad180ee79b7c0a9b',file},argv,expectedTests,passed,failed,names,exitCode,signalCode,status,error:error??(status==='UNKNOWN'?'EXIT_OR_EXPECTED_TEST_COUNT_NOT_ESTABLISHED':undefined),runtimeEvidence,raw:{stdout:hash(stdout),stderr:hash(stderr)}});
 console.log(JSON.stringify({id,status,passed,expectedTests,error}));
}
writeFileSync(join(out,'public-witness-executions.json'),JSON.stringify(manifest,null,2)+'\n');
if(manifest.some(r=>r.status==='UNKNOWN'))process.exitCode=1;
