import {readFileSync,writeFileSync,mkdirSync,copyFileSync}from'node:fs';import{join}from'node:path';
const root=import.meta.dir,dependency=join(root,'../t00-supplement-sdk-assignment-addendum');
let run=readFileSync(join(dependency,'run.ts'),'utf8');
run=run.replace("const root=import.meta.dir,out=resolve(process.argv[2]??join(root,'primary'));",`const root=import.meta.dir,out=resolve(process.argv[2]??join(root,'primary'));
const index=process.argv.indexOf('--dependency-root');if(index<0)throw Error('--dependency-root required');
const dependency=resolve(process.argv[index+1]);
const h=(b:any)=>createHash('sha256').update(b).digest('hex');
const manifestBytes=readFileSync(join(dependency,'manifest.json'));
if(h(manifestBytes)!=='a302eb10889e2c14f38f5736894a44d817b7fc14362fa569100a8fb3c820db1d')throw Error('Dependency seal mismatch');
for(const f of JSON.parse(manifestBytes).files){const bytes=readFileSync(join(dependency,f.path));if(bytes.length!==f.size||h(bytes)!==f.sha256)throw Error('Dependency byte mismatch:'+f.path);}
`);
run=run.replaceAll("join(root,'authority')","join(dependency,'authority')").replaceAll("join(root,'vendor/","join(dependency,'vendor/").replaceAll("SOURCE_SDK_GLOBAL_MUTATION_UNSUPPORTED","SOURCE_COERCION_UNSUPPORTED");
run=run.replace("v.replaceAll(out.replaceAll", "v.replaceAll(dependency.replaceAll('\\\\','/'),'$DEPENDENCY').replaceAll(dependency,'$DEPENDENCY').replaceAll(out.replaceAll");
writeFileSync(join(root,'run.ts'),run);copyFileSync(join(dependency,'verify.ts'),join(root,'verify.ts'));
mkdirSync(join(root,'inputs'),{recursive:true});
writeFileSync(join(root,'inputs/binary-object.ts'),'({}) + 1; export {};\n');
writeFileSync(join(root,'inputs/binary-primitive.ts'),'1 + 2; export {};\n');
writeFileSync(join(root,'cases.json'),JSON.stringify([{id:'binary-object',path:'inputs/binary-object.ts',positive:true,branch:'coercingBinary PlusToken, object left operand'},{id:'binary-primitive',path:'inputs/binary-primitive.ts',positive:false,branch:'coercingBinary PlusToken, primitive operands'}],null,2)+'\n');
writeFileSync(join(root,'dependency.json'),JSON.stringify({relativeRoot:'../t00-supplement-sdk-assignment-addendum',manifestSha256:'a302eb10889e2c14f38f5736894a44d817b7fc14362fa569100a8fb3c820db1d',baseline:'3e94997fcbefa72ad4d49b2cad180ee79b7c0a9b',used:['authority baseline source','vendor/typescript 5.9.3 SDK and runtime','vendor/zod 3.25.76','run.ts authoring template','verify.ts exact comparison']},null,2)+'\n');
