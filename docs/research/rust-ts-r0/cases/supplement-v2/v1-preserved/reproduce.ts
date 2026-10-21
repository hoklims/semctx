import {mkdirSync,existsSync,copyFileSync,writeFileSync,readdirSync,readFileSync,symlinkSync} from 'node:fs';
import {resolve,join,dirname} from 'node:path';
// bun reproduce.ts <repository-with-baseline-object> <official-typescript-package> <NEW-output-directory>
const [repository,typescriptPackage,destination]=process.argv.slice(2);
if(!repository||!typescriptPackage||!destination)throw new Error('Expected repository, TypeScript package directory, NEW output directory');
const out=resolve(destination);if(existsSync(out))throw new Error('Output directory must not exist');
const base='3e94997fcbefa72ad4d49b2cad180ee79b7c0a9b';
const pkg=JSON.parse(readFileSync(join(typescriptPackage,'package.json'),'utf8'));if(pkg.name!=='typescript'||pkg.version!=='5.9.3')throw new Error('TypeScript 5.9.3 required');
if(Bun.version!=='1.4.3')throw new Error('Bun 1.4.3 required');
mkdirSync(out,{recursive:true});const source=join(out,'baseline-source');mkdirSync(source);
const run=(argv:string[],cwd:string)=>{const r=Bun.spawnSync(argv,{cwd,stdout:'pipe',stderr:'pipe',timeout:180000});if(r.exitCode!==0)throw new Error(new TextDecoder().decode(r.stderr));return r;};
run(['git','archive','--format=tar','-o',join(out,'baseline.tar'),base],resolve(repository));
run(['tar','-xf',join(out,'baseline.tar'),'-C',source],out);
if(process.argv.includes('--recover-oracle-deps')){const before=readFileSync(join(source,'bun.lock'));const recovery=run([process.execPath,'install','--frozen-lockfile','--ignore-scripts','--registry','https://registry.npmjs.org'],source);writeFileSync(join(out,'dependency-recovery.stdout'),recovery.stdout);writeFileSync(join(out,'dependency-recovery.stderr'),recovery.stderr);if(!before.equals(readFileSync(join(source,'bun.lock'))))throw new Error('Lockfile changed');}
mkdirSync(join(source,'node_modules'),{recursive:true});
if(!existsSync(join(source,'node_modules/typescript')))symlinkSync(resolve(typescriptPackage),join(source,'node_modules/typescript'),process.platform==='win32'?'junction':'dir');
for(const name of readdirSync(join(source,'packages'))){const path=join(source,'packages',name,'package.json');if(existsSync(path)){const p=JSON.parse(readFileSync(path,'utf8'));const to=join(source,'node_modules',p.name);mkdirSync(dirname(to),{recursive:true});if(!existsSync(to))symlinkSync(dirname(path),to,process.platform==='win32'?'junction':'dir');}}
for(const name of ['observe.ts','identity-witness.ts','public-witnesses.ts'])copyFileSync(join(import.meta.dir,name),join(out,name));
const observed=join(out,'observed');mkdirSync(observed);
for(const name of ['observe.ts','identity-witness.ts','public-witnesses.ts']){const r=run([process.execPath,join(out,name),observed],source);writeFileSync(join(out,name+'.stdout'),r.stdout);writeFileSync(join(out,name+'.stderr'),r.stderr);}
console.log(JSON.stringify({baseline:base,output:out,notice:'Public scope-admission remains UNKNOWN when optional baseline runtime dependencies are unavailable; inspect raw execution manifest.'}));
