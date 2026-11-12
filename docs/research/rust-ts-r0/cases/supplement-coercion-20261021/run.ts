import {mkdirSync,readdirSync,readFileSync,writeFileSync,copyFileSync,existsSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {createHash} from 'node:crypto';
const root=import.meta.dir,out=resolve(process.argv[2]??join(root,'primary'));
const index=process.argv.indexOf('--dependency-root');if(index<0)throw Error('--dependency-root required');
const dependency=resolve(process.argv[index+1]);
const h=(b:any)=>createHash('sha256').update(b).digest('hex');
const manifestBytes=readFileSync(join(dependency,'manifest.json'));
if(h(manifestBytes)!=='a302eb10889e2c14f38f5736894a44d817b7fc14362fa569100a8fb3c820db1d')throw Error('Dependency seal mismatch');
for(const f of JSON.parse(manifestBytes).files){const bytes=readFileSync(join(dependency,f.path));if(bytes.length!==f.size||h(bytes)!==f.sha256)throw Error('Dependency byte mismatch:'+f.path);}

if(existsSync(out))throw Error('Fresh directory required');mkdirSync(out,{recursive:true});
const copy=(a:string,b:string)=>{mkdirSync(b,{recursive:true});for(const e of readdirSync(a,{withFileTypes:true}))e.isDirectory()?copy(join(a,e.name),join(b,e.name)):copyFileSync(join(a,e.name),join(b,e.name));};
copy(join(dependency,'authority'),join(out,'source'));
const src=join(out,'source');
// Dependency imports resolve exclusively to frozen, copied packages; source bodies remain baseline.
for(const base of ['packages/ts-analyzer/src','packages/core/src']){const walk=(dir:string)=>{for(const e of readdirSync(dir,{withFileTypes:true})){const p=join(dir,e.name);if(e.isDirectory())walk(p);else if(e.name.endsWith('.ts')){let text=readFileSync(p,'utf8');text=text.replaceAll('from "typescript"','from '+JSON.stringify(join(dependency,'vendor/typescript/lib/typescript.js').replaceAll('\\','/'))).replaceAll('from "zod"','from '+JSON.stringify(join(dependency,'vendor/zod/index.js').replaceAll('\\','/'))).replaceAll('from "@semantic-context/core"','from '+JSON.stringify(join(src,'packages/core/src/index.ts').replaceAll('\\','/')));writeFileSync(p,text);}}};walk(join(src,base));}
const semanticPath=join(src,'packages/ts-analyzer/src/semantic-dependency-diagnostics.ts');
let text=readFileSync(semanticPath,'utf8');const anchor='  const { program, retained } = context;';if(text.split(anchor).length!==2)throw Error('Anchor mismatch');
text='import {observe as __observe} from '+JSON.stringify(join(root,'observer.ts').replaceAll('\\','/'))+';\n'+text.replace(anchor,anchor+'\n  __observe(program, inputs, sourcePath);');writeFileSync(semanticPath,text);
const ts=(await import(join(dependency,'vendor/typescript/lib/typescript.js'))).default;
const {inspectSemanticDependencies}=await import(semanticPath);
const {inspectModuleConfiguration}=await import(join(src,'packages/ts-analyzer/src/javascript-diagnostics.ts'));
const {records}=await import(join(root,'observer.ts'));
const cases=JSON.parse(readFileSync(join(root,'cases.json'),'utf8')),results=[];
for(const c of cases){const sourceText=readFileSync(join(root,c.path),'utf8'),path=join(out,'fixtures',c.id,'main.ts');mkdirSync(dirname(path),{recursive:true});writeFileSync(path,sourceText);const inputs=new Map([[path,sourceText]]),source=ts.createSourceFile(path,sourceText,ts.ScriptTarget.Latest,true);const start=records.length;
 const semantic=inspectSemanticDependencies(source,inputs,path),configuration=inspectModuleConfiguration(path,dirname(path),inputs);
 const reason='SOURCE_COERCION_UNSUPPORTED';if(semantic.includes(reason)!==c.positive||configuration.includes(reason)!==c.positive)throw Error('Independent SDK contrast failed '+c.id);
 results.push({...c,request:{semantic:{source:{path,text:sourceText,languageVersion:ts.ScriptTarget.Latest,setParentNodes:true},snapshot:[...inputs],sourcePath:path},configuration:{path,repositoryRoot:dirname(path),compilerInputs:[...inputs],source:{$undefined:true},workspaceLinks:{$undefined:true}}},response:{semantic,configuration},actualProgramRecords:records.slice(start)});
}
const normalize=(v:any):any=>typeof v==='string'?v.replaceAll(dependency.replaceAll('\\','/'),'$DEPENDENCY').replaceAll(dependency,'$DEPENDENCY').replaceAll(out.replaceAll('\\','/'),'$RUN').replaceAll(out,'$RUN').replaceAll(root.replaceAll('\\','/'),'$ADDENDUM').replaceAll(root,'$ADDENDUM'):Array.isArray(v)?v.map(normalize):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,normalize(x)])):v;
writeFileSync(join(out,'raw.json'),JSON.stringify(results,null,2)+'\n');writeFileSync(join(out,'normalized.json'),JSON.stringify(normalize(results),null,2)+'\n');
console.log(JSON.stringify({cases:results.length,programRecords:records.length,normalizedSha256:createHash('sha256').update(readFileSync(join(out,'normalized.json'))).digest('hex')}));
