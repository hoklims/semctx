import {mkdirSync,writeFileSync} from 'node:fs';import {join,resolve}from'node:path';
const runtime=resolve(process.argv[2]),out=resolve(process.argv[3]);
const {createGlobSelectionConfig}=await import(join(runtime,'baseline-source/packages/core/src/index.ts'));
const {inspectModuleConfiguration}=await import(join(runtime,'baseline-source/packages/ts-analyzer/src/index.ts'));
const {outlineTopLevel}=await import(join(runtime,'baseline-source/packages/ts-analyzer/src/top-level-outline.ts'));
const {observeOperation}=await import('./capture.ts');
const variants={
 'constructor-dot':"function helper() { return 1; } const observed = helper.constructor; export {};",
 'constructor-bracket':"function helper() { return 1; } const observed = helper['constructor']; export {};",
 'callback-call':"[1].map.call([1], value => value); export {};",
 'callback-apply':"[1].map.apply([1], [value => value]); export {};",
 'callback-bind':"[1].map.bind([1], value => value); export {};",
 'sdk-math-primitive':"Math.max = 1; export {};",
 'sdk-math-callable':"Math.max = () => 1; export {};",
};
const results=[];for(const[id,text]of Object.entries(variants)){const dir=join(out,'additions',id);mkdirSync(dir,{recursive:true});const file=join(dir,'main.ts');writeFileSync(file,text);const snapshot=new Map([[file,text]]);results.push({id,source:text,request:{operation:'module-configuration.inspect',source:'main.ts',retainedFiles:[['main.ts',text]],repositoryRoot:'$FIXTURE',optionsContract:'baseline retained semantic Program (recorded by actual-use instrumentation)'},configuration:inspectModuleConfiguration(file,dir,snapshot)});}
const pairs=[
 ['digest-operator','function f() { count++; }','function f() { count--; }','different'],
 ['digest-keyword-flags','let x = 1;','var x = 1;','different'],
 ['digest-type-keyword','export { foo };','export type { foo };','different'],
 ['digest-raw-template','const p = String.raw`a\\d`;','const p = String.raw`a\\x64`;','different'],
 ['digest-trivia','const a = f(1, 2);','const a = f(\n  1,\n  2,\n)','equal'],
];
const digestPairs=[];
for(const[id,before,after,relation]of pairs){const rows=[];for(const[side,text]of [['before',before],['after',after]]){const dir=join(out,'additions',id+'-'+side);mkdirSync(dir,{recursive:true});writeFileSync(join(dir,'main.ts'),text);const outline=observeOperation('outlineTopLevel',[text,'main.ts'],()=>outlineTopLevel(text,'main.ts'));const digest=outline.statements.map((s:any)=>s.digest).join(',');rows.push({id:id+'-'+side,source:text,request:{operation:'typescript.outline-top-level',source:text,relativePath:'main.ts'},outline,digest});}const equal=rows[0].digest===rows[1].digest;if(equal!==(relation==='equal'))throw Error('Baseline digest contrast mismatch:'+id);results.push(...rows);digestPairs.push({id,relation,observedBefore:rows[0].digest,observedAfter:rows[1].digest});}
writeFileSync(join(out,'additional-observables.json'),JSON.stringify({baseline:'3e94997fcbefa72ad4d49b2cad180ee79b7c0a9b',results,digestPairs},null,2)+'\n');
