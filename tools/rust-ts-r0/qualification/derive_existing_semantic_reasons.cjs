'use strict';
// Input-only capture -> Git-pinned real baseline consumers. No candidate/native loader.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),cp=require('node:child_process'),crypto=require('node:crypto');
const {createRequire,builtinModules}=require('node:module');
const canonical=value=>JSON.stringify(value,(_,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
const sha=data=>crypto.createHash('sha256').update(data).digest('hex');
const equal=(a,b)=>canonical(a)===canonical(b);
const ensure=(v,m)=>{if(!v)throw Error(m);};
const baseline='3e94997fcbefa72ad4d49b2cad180ee79b7c0a9b';
const semanticSource='packages/ts-analyzer/src/semantic-dependency-diagnostics.ts';
const configurationSource='packages/ts-analyzer/src/javascript-diagnostics.ts';
function derive(options){
  const repo=path.resolve(options['--repo']),packageDir=path.resolve(options['--typescript']);
  const requestPins=JSON.parse(fs.readFileSync(path.join(__dirname,'existing-semantic-reason-input-pins.json')));
  ensure(requestPins.rows.length===6,'six input rows only');
  const recipes=JSON.parse(fs.readFileSync(options['--recipes'])).recipes.map(({unit_id,requests,frozen_unit_pointer,frozen_unit_sha256})=>({unit_id,requests,frozen_unit_pointer,frozen_unit_sha256}));
  const sdkBytes=fs.readFileSync(options['--sdk']);
  ensure(sha(sdkBytes)==='f57257876a383d13839a94adefb42b3d40bad2e93489a0f1a5ab29f045f139e5','shared public SDK custody mismatch');
  const shared=JSON.parse(sdkBytes),packagePins=JSON.parse(fs.readFileSync(path.join(__dirname,'existing-semantic-sdk-package-pins.json')));
  for(const file of packagePins.files){const bytes=fs.readFileSync(path.join(packageDir,file.path));ensure(sha(bytes)===file.sha256&&bytes.length===file.size_bytes,'installed SDK byte mismatch '+file.path);}
  const ts=require(path.join(packageDir,'lib/typescript.js'));
  ensure(ts.version==='5.9.3','official TypeScript5.9.3 required');
  const expectedDocuments={
    'index.json':'79f2edac4b4346f787ab1163ee714fb4b706585e06b891bf3923f0de677380f1',
    'qualification/scenarios.json':'b17b5ea68e702a2d45c6b04ae50654a93611584ec84e60a318ac3bce9d609906',
    'allocation/input-index.json':'2b661e61877daf5a4ce14ab76a3ce31f0703f288b01b0853cbc3a8b448c0cded',
  };
  const frozen=Object.fromEntries(Object.entries(expectedDocuments).map(([name,hash])=>{const bytes=fs.readFileSync(path.join(repo,'docs/research/rust-ts-r0/cases',name));ensure(sha(bytes)===hash,'frozen document changed '+name);return [name,JSON.parse(bytes)];}));
  const sourceHashes={},cache=new Map(),externals=new Map();
  const git=file=>cp.execFileSync('git',['-C',repo,'show',baseline+':'+file],{maxBuffer:16*1024*1024});
  function load(file){
    file=path.posix.normalize(file);ensure(!file.startsWith('../')&&file.startsWith('packages/'),'baseline module outside packages');
    if(cache.has(file))return cache.get(file).exports;
    const bytes=git(file);sourceHashes[file]=sha(bytes);
    const module={exports:{}};cache.set(file,module);
    const externalForFile=createRequire(path.join(repo,file));
    const localRequire=specifier=>{
      if(specifier==='typescript')return ts;
      if(specifier.startsWith('.'))return load(path.posix.join(path.posix.dirname(file),specifier)+(path.posix.extname(specifier)?'':'.ts'));
      if(specifier.startsWith('@semantic-context/'))return load('packages/'+specifier.slice('@semantic-context/'.length)+'/src/index.ts');
      if(!specifier.startsWith('node:')&&!builtinModules.includes(specifier)){
        const resolved=externalForFile.resolve(specifier);externals.set(file+':'+specifier,{entry_basename:path.basename(resolved),entry_sha256:sha(fs.readFileSync(resolved))});
      }
      return externalForFile(specifier);
    };
    // CJS plumbing only: source bytes are unmodified and hashed; import.meta is transformed
    // at the TS AST MetaProperty node into the equivalent injected baseline metadata object.
    const metadata=context=>node=>{const visit=value=>ts.isMetaProperty(value)&&value.keywordToken===ts.SyntaxKind.ImportKeyword?ts.factory.createIdentifier('__baselineImportMeta'):ts.visitEachChild(value,visit,context);return ts.visitNode(node,visit);};
    const transpiled=ts.transpileModule(bytes.toString('utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true},transformers:{before:[metadata]},reportDiagnostics:true});
    ensure(!(transpiled.diagnostics||[]).some(d=>d.category===ts.DiagnosticCategory.Error),'baseline transpile diagnostic '+file);
    const filename=path.join(repo,file);
    vm.runInThisContext('(function(require,module,exports,__filename,__dirname,__baselineImportMeta){'+transpiled.outputText+'\n})',{filename:'baseline/'+file})(localRequire,module,module.exports,filename,path.dirname(filename),{dir:path.dirname(filename),url:require('node:url').pathToFileURL(filename).href});
    return module.exports;
  }
  const extractor=load('packages/ts-analyzer/src/ts-symbols.ts');
  const semantic=load(semanticSource),configuration=load(configurationSource);
  const normalize=value=>path.resolve(value).replaceAll('\\','/').toLowerCase();
  const sdkRoots=[path.join(packageDir,'lib'),fs.realpathSync(path.join(packageDir,'lib'))];
  const knownLibraries=new Map(Object.entries(shared.files).flatMap(([logical,text])=>sdkRoots.map(sdkRoot=>[normalize(path.join(sdkRoot,path.posix.basename(logical))),{logical,text,sha256:sha(Buffer.from(text,'utf8'))}])));
  const originalRead=ts.sys.readFile,originalCreate=extractor.extractionContext.createProgram;
  let current=null;
  const normalizeFile=(filename,projectRoot)=>{
    const sdk=knownLibraries.get(normalize(filename));if(sdk)return sdk.logical;
    const rel=path.relative(projectRoot,filename).replaceAll('\\','/');
    ensure(!rel.startsWith('../')&&!path.isAbsolute(rel),'Program loaded unrecognized source '+filename);
    return '/project/'+rel;
  };
  ts.sys.readFile=filename=>{
    const known=knownLibraries.get(normalize(filename));
    if(!known){if(current)current.sdk_reads.push({path:filename,found:false,refused_uncaptured:true});return undefined;}
    const actual=originalRead(filename);
    ensure(actual===known.text,'actual baseline SDK read differs from captured bytes '+known.logical);
    if(current)current.sdk_reads.push({path:known.logical,found:actual!==undefined,sha256:known.sha256,size_bytes:Buffer.byteLength(actual,'utf8')});
    return actual;
  };
  extractor.extractionContext.createProgram=function(...parameters){
    const program=Reflect.apply(originalCreate,this,parameters);
    ensure(current,'Program created outside operation');
    const convert=ts.convertCompilerOptionsFromJson(current.request.options,current.projectRoot);
    ensure(!convert.errors.length&&equal(program.getCompilerOptions(),convert.options),'baseline Program options differ from request');
    ensure(equal(program.getRootFileNames().map(p=>normalizeFile(p,current.projectRoot)),current.request.roots.map(p=>'/project/'+p)),'baseline Program roots differ');
    current.programs.push({options:program.getCompilerOptions(),roots:program.getRootFileNames().map(p=>normalizeFile(p,current.projectRoot)),sources:program.getSourceFiles().map(source=>{
      const logical=normalizeFile(source.fileName,current.projectRoot),text=source.text;
      const expected=logical.startsWith('/project/')?current.request.files[logical.slice('/project/'.length)]:shared.files[logical];
      ensure(text===expected,'bound Program source differs from retained/SDK bytes');
      return {path:logical,sha256:sha(Buffer.from(text,'utf8')),size_bytes:Buffer.byteLength(text,'utf8'),default_library:program.isSourceFileDefaultLibrary(source)};
    })});
    return program;
  };
  const raw=[];
  try{
    for(const pin of requestPins.rows){
      const matches=recipes.filter(r=>r.unit_id===pin.unit_id);ensure(matches.length===1&&equal(matches[0],pin),'selected frozen input changed '+pin.unit_id);
      const request=pin.requests[0];ensure(pin.requests.length===1&&request.retained===true,'one retained request per unit');
      const index=Number(pin.frozen_unit_pointer.replace('/execution_units/',''));
      const unit=frozen['qualification/scenarios.json'].execution_units[index];
      ensure(unit.unit_id===pin.unit_id&&sha(canonical(unit))===pin.frozen_unit_sha256,'frozen unit hash/pointer changed');
      const spec=frozen['allocation/input-index.json'].qualification_records.find(r=>r.case_id===unit.case_id);
      ensure(spec&&sha(canonical(spec.input_specification))===spec.input_specification_sha256,'frozen input canonical identity');
      const authored=unit.variant_input_or_observation;
      ensure(equal(request.files,authored.files),'source text differs from selected frozen variant');
      ensure(equal(request.roots,authored.root_files||Object.keys(authored.files)),'frozen roots differ');
      const operations=[];
      for(const name of ['inspectModuleConfiguration retained snapshot without supplied SourceFile','inspectSemanticDependencies retained source']){
        const projectRoot=path.resolve(__dirname,'virtual-project');
        const snapshot=new Map(Object.entries(request.files).map(([file,text])=>[path.join(projectRoot,file).replaceAll('\\','/'),text]));
        const filename=path.join(projectRoot,request.roots[0]).replaceAll('\\','/');
        current={name,request,projectRoot,programs:[],sdk_reads:[]};
        const reasons=name.startsWith('inspectModuleConfiguration')?configuration.inspectModuleConfiguration(filename,projectRoot.replaceAll('\\','/'),snapshot):semantic.inspectSemanticDependencies(ts.createSourceFile(filename,request.files[request.roots[0]],ts.ScriptTarget.Latest,true),snapshot,filename);
        ensure(Array.isArray(reasons)&&reasons.every(r=>typeof r==='string'),'nonstring baseline reason');
        ensure(current.programs.length>0,'baseline did not create a real Program');
        ensure(!current.sdk_reads.some(r=>!r.found),'unknown SDK read attempted '+JSON.stringify(current.sdk_reads.filter(r=>!r.found)));
        operations.push({operation:name,reasons,programs:current.programs,sdk_reads:current.sdk_reads,sdk_consumed_count:new Set(current.sdk_reads.map(r=>r.path)).size});
      }
      raw.push({unit_id:pin.unit_id,frozen_unit_pointer:pin.frozen_unit_pointer,frozen_unit_sha256:pin.frozen_unit_sha256,request_sha256:sha(canonical(request)),source_files:Object.entries(request.files).map(([file,text])=>({path:file,sha256:sha(Buffer.from(text,'utf8')),size_bytes:Buffer.byteLength(text,'utf8')})),operations});
      current=null;
    }
  }finally{ts.sys.readFile=originalRead;extractor.extractionContext.createProgram=originalCreate;}
  const assertions=raw.map(unit=>{
    const observed=unit.operations.find(o=>o.operation.startsWith('inspectModuleConfiguration'));
    const target=['subjects',{path:'main.ts'},'moduleConfigurationObservations','retainedWithoutSource','reasons'];
    return {unit_id:unit.unit_id,frozen_unit_pointer:unit.frozen_unit_pointer,frozen_unit_sha256:unit.frozen_unit_sha256,request_sha256:unit.request_sha256,source_files:unit.source_files,
      checks:[{observation:0,target,mode:'reason_constraints',expected:{exact_set:[...new Set(observed.reasons)].sort()},actual_transform:'none',operation_binding:{status:'VERIFIED_SOURCE_OPERATION',target,baseline_operation:observed.operation,authority:{baseline,path:configurationSource,sha256:sourceHashes[configurationSource],start_line:363,end_line:383,semantic_consumer:{path:semanticSource,sha256:sourceHashes[semanticSource]},scope:'Executed real retained module-configuration consumer with no supplied SourceFile; exact same retained input separately executed through inspectSemanticDependencies.'}}}]};
  });
  const pairIds=[['O50','ORD-CALLABLE-DECLARATION-PAIR::variant-01','ORD-CALLABLE-DECLARATION-PAIR::variant-02'],['O71','V2-G12-constrained-sdk-generic-unknown-input::base','V2-G11-constrained-sdk-generic-literal-input::base'],['O110','V3-SDK-02-08::base','V3-SDK-02-02::base']];
  const contrasts=pairIds.map(([obligation,positive,control])=>{
    const positiveReasons=raw.find(u=>u.unit_id===positive).operations[0].reasons,controlReasons=raw.find(u=>u.unit_id===control).operations[0].reasons;
    return {obligation,positive,existing_control:control,positive_reasons:positiveReasons,control_reasons:controlReasons,observed_positive_only_reasons:positiveReasons.filter(r=>!controlReasons.includes(r)),scope:'Two existing frozen inputs, not a newly invented counterfactual or a complete-corpus admission claim'};
  });
  return {schema_version:1,status:'REAL_BASELINE_TS593_SIX_EXISTING_INPUTS_NO_NATIVE_EXECUTION',baseline,typescript_version:ts.version,typescript_runtime_entry:packagePins.files.find(f=>f.path==='lib/typescript.js'),shared_sdk_sha256:sha(sdkBytes),sdk_supplied_count:Object.keys(shared.files).length,input_pin_canonical_sha256:sha(canonical(requestPins)),frozen_documents:expectedDocuments,baseline_sources:Object.fromEntries(Object.entries(sourceHashes).sort()),external_entry_pins:Object.fromEntries([...externals].sort()),loader_compatibility:'Git source bytes unchanged; import.meta AST MetaProperty becomes injected dir/url for CJS execution. SDK body reads are real ts.sys reads verified against public known bytes; retained project bytes are verified on bound Program SourceFiles. No uncaptured filesystem source fallback.',units:raw,contrasts,assertions};
}
function main(){
  const options={};for(let i=2;i<process.argv.length;i+=2){const key=process.argv[i];ensure(['--repo','--recipes','--sdk','--typescript','--output','--check'].includes(key)&&!options[key]&&process.argv[i+1],'invalid arguments');options[key]=path.resolve(process.argv[i+1]);}
  ensure(['--repo','--recipes','--sdk','--typescript'].every(k=>options[k])&&Boolean(options['--output'])!==Boolean(options['--check']),'--repo --recipes --sdk --typescript and --output newfile or --check file required');
  const result=derive(options);
  if(options['--check']){ensure(equal(result,JSON.parse(fs.readFileSync(options['--check']))),'real baseline semantic-reason derivation differs');console.log('PASS: six real baseline semantic/module consumers match frozen observations');}
  else{fs.writeFileSync(options['--output'],JSON.stringify(result,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(result.units.map(u=>({unit_id:u.unit_id,operations:u.operations.map(o=>({operation:o.operation,reasons:o.reasons,sdk_consumed:o.sdk_consumed_count}))}))));}
}
if(require.main===module){try{main();}catch(error){console.error(error.stack);process.exitCode=1;}}
module.exports={derive,canonical};
