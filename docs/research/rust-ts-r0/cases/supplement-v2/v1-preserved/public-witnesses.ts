import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
const root=import.meta.dir, cwd=join(root,'baseline-source');
const out=resolve(process.argv[2]??join(root,'observed'));
const tmp=join(out,'scratch');mkdirSync(tmp,{recursive:true});
const cases=[
 ['directory-alias','packages/ts-analyzer/test/discovery-missing-import-alias.test.ts',''],
 ['reference-confinement','packages/ts-analyzer/test/discovery-selection.test.ts','records relative imports and reference paths escaping'],
 ['native-inert','packages/ts-analyzer/test/create-require.test.ts','type-only native bindings'],
 ['mixed-fallback','packages/ts-analyzer/test/javascript.test.ts','keeps mixed extraction in one semantic Program'],
 ['external-partition','packages/ts-analyzer/test/parallel-extraction.test.ts','does not connect independent roots through the same external'],
 ['namespace-owners','packages/ts-analyzer/test/semantic-js-contracts.test.ts','non-call namespace members retain|namespace destructuring preserves|unmodeled object members cannot claim'],
 ['runtime-erased','packages/ts-analyzer/test/runtime-value-imports.test.ts','unused, erased and shadowed'],
 ['workspace-boundaries','packages/ts-analyzer/test/workspace-configuration-links.test.ts','installed dependency keeps precedence|workspace declared above|legacy TS-only extraction'],
 ['opaque-ownership','packages/ts-analyzer/test/opaque-inline-ownership.test.ts','opaque inline ownership|actual test binding ownership|anonymous default declaration'],
 ['scope-admission','packages/app-services/test/qualified-analysis.test.ts','unretained generated reference|manifest optional dependencies|excluded parse-failed or computed'],
 ['pilot-builtin','scripts/test/impact-pilot.test.ts','extractRelativeImportSpecifiers keeps only relative'],
];
const results=[];
for(const [id,file,pattern]of cases){const argv=[process.execPath,'test','--timeout','60000',file,...pattern?['--test-name-pattern',pattern]:[]];const r=Bun.spawnSync(argv,{cwd,env:{...process.env,TMP:tmp,TEMP:tmp,NO_COLOR:'1',FORCE_COLOR:'0'},stdout:'pipe',stderr:'pipe',timeout:120000});writeFileSync(join(out,id+'.stdout'),r.stdout);writeFileSync(join(out,id+'.stderr'),r.stderr);results.push({id,authority:{baseline:'3e94997fcbefa72ad4d49b2cad180ee79b7c0a9b',file},argv:argv.slice(1),exitCode:r.exitCode,signalCode:r.signalCode,stdoutBytes:r.stdout.length,stderrBytes:r.stderr.length});console.log(id,r.exitCode);}
writeFileSync(join(out,'public-witness-executions.json'),JSON.stringify(results,null,2)+'\n');
