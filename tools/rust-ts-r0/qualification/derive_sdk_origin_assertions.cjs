'use strict';
// Executes the standalone public TS5 oracle, never the native producer.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),cp=require('node:child_process');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const canonical=v=>JSON.stringify(v,(_,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
const equal=(a,b)=>canonical(a)===canonical(b);
const ensure=(v,m)=>{if(!v)throw Error(m);};
const sorted=values=>values.sort((a,b)=>{const x=canonical(a),y=canonical(b);return x<y?-1:x>y?1:0;});
function derive(options){
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'t00-public-sdk-origin-'));
  try {
    const sdkBytes=fs.readFileSync(options['--sdk']);
    ensure(hash(sdkBytes)==='f57257876a383d13839a94adefb42b3d40bad2e93489a0f1a5ab29f045f139e5','public shared SDK bytes mismatch');
    fs.writeFileSync(path.join(temporary,'shared-sdk.json'),sdkBytes);
    fs.copyFileSync(path.join(__dirname,'sdk-origin-package-pins.json'),path.join(temporary,'sdk-package-byte-identity.json'));
    const recipeBytes=fs.readFileSync(options['--recipes']);
    const requestFixtureBytes=fs.readFileSync(path.join(__dirname,'sdk-origin-test-requests.json'));
    const originalRequests=JSON.parse(requestFixtureBytes);
    const selectedRecipes=JSON.parse(recipeBytes).recipes;
    ensure(Object.keys(originalRequests).length===12,'bounded original request fixtures');
    for(const [id,request] of Object.entries(originalRequests)) {
      const matches=selectedRecipes.filter(r=>r.unit_id===id);
      ensure(matches.length===1 && matches[0].requests.length===1 && equal(matches[0].requests[0],request),`changed original request ${id}`);
    }
    // Checks may have been appended to the prepared recipe, but its 12 complete request DTOs
    // must match the prior public oracle fixtures before any TypeScript execution.
    cp.execFileSync(process.execPath,[path.join(__dirname,'sdk_origin_baseline_oracle.cjs'),options['--recipes'],options['--typescript'],options['--repository']],{env:{...process.env,SDK_ORIGIN_ORACLE_OUTPUT:temporary,SDK_ORIGIN_RECIPE_SHA256:hash(recipeBytes)},stdio:'pipe'});
    const rawBytes=fs.readFileSync(path.join(temporary,'raw-observations.json'));
    const raw=JSON.parse(rawBytes),pins=JSON.parse(fs.readFileSync(path.join(temporary,'input-closure-pins.json'))), sdk=JSON.parse(sdkBytes);
    const recipes=JSON.parse(fs.readFileSync(options['--recipes'])).recipes;
    const references={
      'index.json':'79f2edac4b4346f787ab1163ee714fb4b706585e06b891bf3923f0de677380f1',
      'qualification/scenarios.json':'b17b5ea68e702a2d45c6b04ae50654a93611584ec84e60a318ac3bce9d609906',
      'allocation/input-index.json':'2b661e61877daf5a4ce14ab76a3ce31f0703f288b01b0853cbc3a8b448c0cded',
    };
    const frozen=Object.fromEntries(Object.entries(references).map(([name,sha])=>{
      const bytes=fs.readFileSync(path.join(options['--repository'],'docs/research/rust-ts-r0/cases',name));
      ensure(hash(bytes)===sha,`frozen document mismatch ${name}`);return [name,JSON.parse(bytes)];
    }));
    const assertions=raw.units.map(unit=>{
      const input=pins.inputs.find(x=>x.unit_id===unit.unit_id), recipe=recipes.find(x=>x.unit_id===unit.unit_id);
      const frozenIndex=Number(recipe.frozen_unit_pointer.replace('/execution_units/',''));
      const frozenUnit=frozen['qualification/scenarios.json'].execution_units[frozenIndex];
      const spec=frozen['allocation/input-index.json'].qualification_records.find(x=>x.case_id===recipe.case_id);
      const index=frozen['index.json'].qualification_records.find(x=>x.id===recipe.case_id);
      ensure(frozenUnit.unit_id===unit.unit_id && hash(Buffer.from(canonical(frozenUnit)))===unit.frozen_unit_sha256,'frozen unit mismatch');
      ensure(spec.input_specification_sha256===hash(Buffer.from(canonical(spec.input_specification))),'frozen specification mismatch');
      ensure(index.execution_unit_ids.includes(unit.unit_id) && equal(spec.input_specification,frozenUnit.variant_input_or_observation),'index/scenario input binding');
      ensure(equal(input.request.files,spec.input_specification.files) && equal(input.request.roots,spec.input_specification.root_files),'frozen source/root mismatch');
      ensure(equal(input.request,recipe.requests[0]),'recipe request mismatch');
      ensure(unit.diagnostics.length===0 && unit.unknown_reads.length===0,'oracle incomplete');
      const successful=new Map(unit.host_reads.filter(r=>r.found).map(r=>[r.path,r]));
      const declarations=values=>sorted(values.map(d=>{
        const read=successful.get(d.file);
        ensure(read && read.sha256===d.source.sha256,'oracle declaration without matching read');
        return {file:d.file,start_utf16:d.getStart_utf16,end_utf16:d.end_utf16,default_library:d.isSourceFileDefaultLibrary,source_content_id:'sha256:'+read.sha256};
      }));
      const calls=sorted(unit.calls.map(c=>({file:c.file,start_utf16:c.call.start_utf16,end_utf16:c.call.end_utf16,callee_text:c.callee_dto.text,symbol_name:c.callee_symbol.symbol?.name??null,declarations:declarations(c.callee_symbol.declarations)})));
      const sdkReads=sorted([...successful.values()].filter(r=>r.role==='captured_sdk_library').map(r=>({file:r.path,content_id:'sha256:'+r.sha256,size_bytes:r.size_bytes})));
      return {unit_id:unit.unit_id,frozen_unit_pointer:recipe.frozen_unit_pointer,frozen_unit_sha256:unit.frozen_unit_sha256,request_canonical_sha256:hash(Buffer.from(canonical(input.request))),projection:{calls,sdk_supplied_count:Object.keys(sdk.files).length,sdk_consumed_count:sdkReads.length,sdk_reads:sdkReads}};
    });
    ensure(assertions.length===12,'bounded rows');
    if(options['--raw-output']) fs.writeFileSync(options['--raw-output'],rawBytes,{flag:'wx'});
    if(options['--evidence-output']) {
      const units=raw.units.map(unit=>{
        const input=pins.inputs.find(x=>x.unit_id===unit.unit_id);
        return {unit_id:unit.unit_id,raw_callee_observations:unit.calls.map(c=>({full_ts_expression:c.callee_text,dto:c.callee_dto})),request:{...input.request,cwd:'/project',files:Object.fromEntries(Object.entries(input.request.files).map(([name,text])=>['/project/'+name,text]))},
          observed:{calls:unit.calls.map(c=>({file:c.file,start_utf16:c.call.start_utf16,end_utf16:c.call.end_utf16,callee_text:c.callee_dto.text,symbol_name:c.callee_symbol.symbol?.name??null,declarations:c.callee_symbol.declarations.map(d=>({file:d.file,start_utf16:d.getStart_utf16,end_utf16:d.end_utf16,default_library:d.isSourceFileDefaultLibrary}))})),capture_probes:unit.host_reads.map(r=>({operation:'read_file',path:r.normalized_path,found:r.found,...(r.found?{content_id:'sha256:'+r.sha256}:{})}))},expected:assertions.find(a=>a.unit_id===unit.unit_id).projection};
      });
      fs.writeFileSync(options['--evidence-output'],JSON.stringify({scope:'TS oracle DTO adapter for comparator tests only; no native execution or producer binding claimed',sdk,units}));
    }
    return {schema_version:2,status:'ADDITIONAL_ASSERTIONS_EXISTING_INPUTS_ONLY_NOT_QUALIFICATION',scope:'Static callee declarations and reported successful reads, not runtime origin; original inputs/assertions unchanged.',callee_dto_contract:'PropertyAccessExpression: actual TS AST expression.name.text; other expressions: expression.getText(source). Raw callee_text remains the complete TS expression. No string-split normalization or native-output-derived expectation.',fixture_pin_encoding:'SHA256 over UTF-8 canonical JSON (recursively sorted object keys, no spaces or newline), independent of LF/CRLF fixture formatting.',oracle:{typescript:'5.9.3',baseline:pins.baseline,typescript_runtime_entry:pins.typescript_runtime_entry,shared_sdk_sha256:hash(sdkBytes),raw_observations_sha256:hash(rawBytes),oracle_script_sha256:hash(fs.readFileSync(path.join(__dirname,'sdk_origin_baseline_oracle.cjs'))),original_request_fixture_canonical_sha256:hash(Buffer.from(canonical(originalRequests),'utf8')),sdk_package_pin_manifest_canonical_sha256:hash(Buffer.from(canonical(JSON.parse(fs.readFileSync(path.join(__dirname,'sdk-origin-package-pins.json')))),'utf8'))},frozen_documents:references,options_binding:'Frozen SDK program_options text realized by unchanged baseline ts-symbols.ts154-163 defaults; no literal frozen options object claimed.',assertions};
  } finally { fs.rmSync(temporary,{recursive:true,force:true}); }
}
function main(){
  const options={};
  for(let i=2;i<process.argv.length;i+=2){const flag=process.argv[i];ensure(['--recipes','--sdk','--typescript','--repository','--output','--check','--evidence-output','--raw-output'].includes(flag)&&!options[flag]&&process.argv[i+1],'invalid arguments');options[flag]=path.resolve(process.argv[i+1]);}
  ensure(['--recipes','--sdk','--typescript','--repository'].every(k=>options[k])&&Boolean(options['--output'])!==Boolean(options['--check']),'Usage: --recipes file --sdk file --typescript package-dir --repository repo (--output newfile | --check file)');
  const derived=derive(options);
  if(options['--check']){ensure(equal(derived,JSON.parse(fs.readFileSync(options['--check']))),'SDK-origin assertions differ from fresh TypeScript observation');console.log('PASS: 12 SDK-origin rows match fresh TS5.9.3 execution');}
  else {fs.writeFileSync(options['--output'],JSON.stringify(derived,null,2)+'\n',{flag:'wx'});console.log('Derived 12 additional SDK-origin assertion rows');}
}
if(require.main===module){try{main();}catch(e){console.error(e.message);process.exitCode=1;}}
module.exports={derive,canonical};
