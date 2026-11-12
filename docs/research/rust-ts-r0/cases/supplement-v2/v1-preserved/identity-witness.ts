import { mkdirSync,readFileSync,writeFileSync } from 'node:fs';
import { join,resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { analyzerIdentity } from './baseline-source/scripts/analyzer-identity.ts';
const root=import.meta.dir,out=resolve(process.argv[2]??join(root,'observed'));
const baseline=join(root,'baseline-source');
const hash=(path:string)=>createHash('sha256').update(readFileSync(path)).digest('hex');
const guarded=['scripts/analyzer-identity.ts','packages/app-services/src/analyzer-identity-generated.ts'];
const before=guarded.map(path=>({path,sha256:hash(join(baseline,path))}));
const control=analyzerIdentity(baseline);
const fixture=join(out,'fixtures','identity-crlf');
mkdirSync(join(fixture,'packages'),{recursive:true});mkdirSync(join(fixture,'apps/cli/src'),{recursive:true});
mkdirSync(join(fixture,'scripts'),{recursive:true});
for(const name of ['apps/cli/package.json','tsconfig.json','tsconfig.base.json','scripts/analyzer-identity.ts','scripts/build-plugin-runtime.ts','scripts/build-cli-package.ts'])writeFileSync(join(fixture,name),'{}\n');
writeFileSync(join(fixture,'bun.lock'),'CRLF witness\r\n');
let rejection='NO_THROW';try{analyzerIdentity(fixture);}catch(e){rejection=(e as Error).message;}
const after=guarded.map(path=>({path,sha256:hash(join(baseline,path))}));
writeFileSync(join(out,'identity-observations.json'),JSON.stringify({control,rejection,before,after},null,2)+'\n');
console.log(JSON.stringify({rejection,guardedFilesUnchanged:JSON.stringify(before)===JSON.stringify(after)}));
