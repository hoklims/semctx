'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),cp=require('node:child_process');
const {derive}=require('./derive_sdk_origin_assertions.cjs');
const options=JSON.parse(process.env.SDK_ORIGIN_DERIVE_OPTIONS || '{}');

test('raw full TypeScript expressions are unchanged and DTO leaf is derived from actual TS AST',()=>{
  const raw=JSON.parse(fs.readFileSync(process.env.SDK_ORIGIN_RAW_V2));
  const old=JSON.parse(fs.readFileSync(process.env.SDK_ORIGIN_RAW_ORIGINAL));
  const requests=JSON.parse(fs.readFileSync(path.join(__dirname,'sdk-origin-test-requests.json')));
  const ts=require(path.join(options['--typescript'],'lib/typescript.js'));
  assert.equal(ts.version,'5.9.3');
  let count=0,propertyCount=0;
  for(const unit of raw.units){
    const original=old.units.find(u=>u.unit_id===unit.unit_id);
    const calls=[];
    for(const [filename,text] of Object.entries(requests[unit.unit_id].files)){
      const source=ts.createSourceFile('/project/'+filename,text,ts.ScriptTarget.ES2022,true);
      const visit=node=>{if(ts.isCallExpression(node))calls.push({source,node});ts.forEachChild(node,visit);};visit(source);
    }
    assert.equal(calls.length,unit.calls.length);
    unit.calls.forEach((call,index)=>{
      const {callee_dto,...unchanged}=call;
      assert.deepEqual(unchanged,original.calls[index]);
      const {source,node}=calls.find(({source,node})=>source.fileName===call.file&&node.getStart(source)===call.call.start_utf16&&node.end===call.call.end_utf16);
      assert.equal(call.callee_text,node.expression.getText(source));
      const leaf=ts.isPropertyAccessExpression(node.expression)?node.expression.name.text:node.expression.getText(source);
      assert.equal(callee_dto.text,leaf);
      if(ts.isPropertyAccessExpression(node.expression)){assert.notEqual(call.callee_text,leaf);propertyCount++;}
      count++;
    });
  }
  assert.equal(count,13);assert.equal(propertyCount,12);
});

test('LF and CRLF formatting of both JSON fixtures leaves the fresh TS-derived document identical',()=>{
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'t00-sdk-fixture-eol-'));
  try{
    const scriptNames=['derive_sdk_origin_assertions.cjs','sdk_origin_baseline_oracle.cjs'];
    const fixtureNames=['sdk-origin-test-requests.json','sdk-origin-package-pins.json'];
    const expected=derive(options);
    for(const mode of ['LF','CRLF']){
      const folder=path.join(temporary,mode);fs.mkdirSync(folder);
      for(const name of scriptNames)fs.copyFileSync(path.join(__dirname,name),path.join(folder,name));
      for(const name of fixtureNames){const text=fs.readFileSync(path.join(__dirname,name),'utf8').replaceAll('\r\n','\n');fs.writeFileSync(path.join(folder,name),mode==='CRLF'?text.replaceAll('\n','\r\n'):text);}
      const check=path.join(folder,'expected.json');fs.writeFileSync(check,JSON.stringify(expected));
      const args=Object.entries(options).flatMap(([flag,value])=>[flag,value]);
      const run=cp.spawnSync(process.execPath,[path.join(folder,scriptNames[0]),...args,'--check',check],{encoding:'utf8'});
      assert.equal(run.status,0,mode+': '+run.stderr);
      assert.match(run.stdout,/match fresh TS5.9.3 execution/);
    }
  }finally{fs.rmSync(temporary,{recursive:true,force:true});}
});
