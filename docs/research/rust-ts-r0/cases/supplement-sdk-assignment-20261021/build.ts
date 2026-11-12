import {mkdirSync,readFileSync,writeFileSync,readdirSync,copyFileSync,existsSync,realpathSync} from 'node:fs';
import {join,dirname,resolve,relative} from 'node:path';
import {createHash} from 'node:crypto';
const root=import.meta.dir, repo='C:/maintenence/semctx.codex-t00-review-20261021';
const baseline='3e94997fcbefa72ad4d49b2cad180ee79b7c0a9b';
const hash=(x:any)=>createHash('sha256').update(x).digest('hex');
const exec=(args:string[],cwd=root)=>{const r=Bun.spawnSync(args,{cwd,stdout:'pipe',stderr:'pipe'});if(r.exitCode)throw Error(new TextDecoder().decode(r.stderr));return r.stdout;};
const copy=(a:string,b:string)=>{mkdirSync(b,{recursive:true});for(const e of readdirSync(a,{withFileTypes:true})){const from=join(a,e.name),to=join(b,e.name);if(e.isDirectory())copy(from,to);else if(e.isFile())copyFileSync(from,to);}};
mkdirSync(join(root,'authority'),{recursive:true});
exec(['git','archive','--format=tar','-o',join(root,'baseline.tar'),baseline,'packages/ts-analyzer/src','packages/core/src','packages/core/package.json'],repo);
exec(['tar','-xf',join(root,'baseline.tar'),'-C',join(root,'authority')]);
const dependencies=[];
for(const name of ['typescript','zod']){let at=dirname(realpathSync(Bun.resolveSync(name,join(repo,'packages/core/src/schemas.ts'))));while(!existsSync(join(at,'package.json')))at=dirname(at);const pkg=JSON.parse(readFileSync(join(at,'package.json'),'utf8'));if(pkg.version!==(name==='typescript'?'5.9.3':'3.25.76'))throw Error('Unexpected dependency');copy(at,join(root,'vendor',name));dependencies.push({name,version:pkg.version});}
writeFileSync(join(root,'baseline-authority.json'),JSON.stringify({baseline,scope:'T00 coordinate 115:0 SDK global variable assignment only',gitArchiveSha256:hash(readFileSync(join(root,'baseline.tar'))),dependencies,bun:Bun.version,node:process.versions.node,archiveCommand:['git','archive','--format=tar','-o','baseline.tar',baseline,'packages/ts-analyzer/src','packages/core/src','packages/core/package.json'],forbiddenObserved:false},null,2)+'\n');
const cases=[
 ['binary-global','navigator = 1; export {};',true,'binary identifier'],
 ['binary-local','let navigator = 1; navigator = 2; export {};',false,'binary identifier'],
 ['array-global','[navigator] = [1]; export {};',true,'array element'],
 ['array-local','let navigator = 1; [navigator] = [2]; export {};',false,'array element'],
 ['object-global','({navigator} = {navigator: 1}); export {};',true,'object shorthand'],
 ['object-local','let navigator = 1; ({navigator} = {navigator: 2}); export {};',false,'object shorthand'],
];
mkdirSync(join(root,'inputs'),{recursive:true});for(const[id,text]of cases)writeFileSync(join(root,'inputs',id+'.ts'),text+'\n');
writeFileSync(join(root,'cases.json'),JSON.stringify(cases.map(([id,text,positive,branch])=>({id,path:'inputs/'+id+'.ts',positive,branch})),null,2)+'\n');
console.log(JSON.stringify({baseline,cases:cases.length,dependencies}));
