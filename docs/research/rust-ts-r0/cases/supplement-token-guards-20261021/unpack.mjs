import fs from 'node:fs';
import path from 'node:path';
import {gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const home=path.dirname(fileURLToPath(import.meta.url));
const hash=b=>createHash('sha256').update(b).digest('hex');
export function unpack(destination){
 const pin=JSON.parse(fs.readFileSync(path.join(home,'index.json'),'utf8'));
 const encoded=fs.readFileSync(path.join(home,pin.archive.file));if(hash(encoded)!==pin.archive.base64Sha256)throw Error('base64 hash mismatch');
 const compressed=Buffer.from(encoded.toString('ascii').trim(),'base64');if(hash(compressed)!==pin.archive.gzipSha256)throw Error('gzip hash mismatch');
 const tar=gunzipSync(compressed);if(hash(tar)!==pin.archive.tarSha256)throw Error('tar hash mismatch');
 const manifest=fs.readFileSync(path.join(home,'manifest.json'));if(hash(manifest)!==pin.originalManifestSha256)throw Error('manifest hash mismatch');
 const expected=new Map(JSON.parse(manifest).files.map(f=>[f.path,f]));
 for(const name of ['expected.json','baseline-authority.json']){const b=fs.readFileSync(path.join(home,name));if(hash(b)!==expected.get(name)?.sha256)throw Error('outer original copy mismatch '+name);}
 const freeze=JSON.parse(fs.readFileSync(path.join(home,'freeze.json'),'utf8'));if(freeze.manifestSha256!==pin.originalManifestSha256)throw Error('original freeze mismatch');
 for(const extra of ['manifest.json','freeze.json']){const b=fs.readFileSync(path.join(home,extra));expected.set(extra,{path:extra,bytes:b.length,sha256:hash(b)});}
 const entries=[],seen=new Set();let offset=0;
 const str=b=>b.toString('utf8').replace(/\0.*$/s,'');
 while(offset+512<=tar.length){const header=tar.subarray(offset,offset+512);if(header.every(v=>v===0))break;
  const oct=b=>{const s=str(b).trim();if(!/^[0-7]*$/.test(s))throw Error('invalid tar number');return parseInt(s||'0',8);};
  const checksum=oct(header.subarray(148,156));let sum=0;for(let i=0;i<512;i++)sum+=i>=148&&i<156?32:header[i];if(sum!==checksum)throw Error('tar checksum');
  const prefix=str(header.subarray(345,500));let name=(prefix?prefix+'/':'')+str(header.subarray(0,100));
  name=name.replace(/^\.\//,'').replace(/\/$/,'');const type=String.fromCharCode(header[156]||48),size=oct(header.subarray(124,136));
  if(!['0','5'].includes(type)||str(header.subarray(157,257)))throw Error('links or special entries forbidden');
  if(name==='.'||name===''){if(type!=='5')throw Error('root file forbidden');}else{
   if(name.includes('\\')||name.startsWith('/')||name.includes(':')||name.split('/').some(p=>!p||p==='.'||p==='..'))throw Error('unsafe archive path '+name);
   if(seen.has(name.toLowerCase()))throw Error('duplicate archive path '+name);seen.add(name.toLowerCase());
   if(type==='0'){const wanted=expected.get(name),bytes=tar.subarray(offset+512,offset+512+size);if(bytes.length!==size||!wanted||size!==wanted.bytes||hash(bytes)!==wanted.sha256)throw Error('unexpected or changed file '+name);entries.push({name,bytes});}
  }
  offset+=512+Math.ceil(size/512)*512;
 }
 if(entries.length!==expected.size||entries.length!==1906)throw Error('file count mismatch');
 const dest=path.resolve(destination),parent=path.dirname(dest);if(fs.existsSync(dest))throw Error('fresh nonexistent destination required');
 if(!fs.existsSync(parent)||fs.realpathSync(parent).toLowerCase()!==parent.toLowerCase())throw Error('existing real parent required');
 for(let d=parent;;d=path.dirname(d)){if(fs.existsSync(path.join(d,'.git')))throw Error('destination must be outside Git repository');if(path.dirname(d)===d)break;}
 fs.mkdirSync(dest);for(const e of entries){const target=path.join(dest,...e.name.split('/'));fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,e.bytes,{flag:'wx'});}
 return {destination:dest,manifestSha256:hash(manifest),validatedManifestFiles:1904,totalRegularFiles:1906,links:0};
}
export function replay(destination,bun){
 const result=unpack(destination),root=result.destination;
 const fixture=path.join(root,'fixture');fs.mkdirSync(fixture,{recursive:true});
 const gitEnv={...process.env};for(const k of Object.keys(gitEnv))if(k.startsWith('GIT_'))delete gitEnv[k];
 const init=spawnSync('git',['init','--quiet',fixture],{cwd:root,env:gitEnv});
 fs.writeFileSync(path.join(root,'fixture-git-init.stdout'),init.stdout??Buffer.alloc(0));fs.writeFileSync(path.join(root,'fixture-git-init.stderr'),init.stderr??Buffer.alloc(0));
 if(init.status!==0)throw Error('fixture-only git init failed '+init.status);
 const commands=[{exe:'git',args:['init','--quiet',fixture],cwd:root,exit:init.status,environment:'Inherited with GIT_* overrides removed; no config mutation or commits'}];
 // Relocate dependency paths and the passive observer only; untouched authority and vendor stay pinned.
 fs.cpSync(path.join(root,'authority'),path.join(root,'runtime'),{recursive:true});
 const config=JSON.parse(fs.readFileSync(path.join(root,'authority/tsconfig.json'),'utf8'));delete config.extends;
 for(const [k,v]of Object.entries(config.compilerOptions.paths))config.compilerOptions.paths[k]=v.map(p=>path.resolve(root,'runtime',p));
 for(const e of fs.readdirSync(path.join(root,'authority/packages'),{withFileTypes:true})){if(!e.isDirectory())continue;const p=path.join(root,'authority/packages',e.name,'package.json');if(!fs.existsSync(p))continue;const pkg=JSON.parse(fs.readFileSync(p,'utf8'));for(const [k,v]of Object.entries(pkg.exports??{}))if(k!=='.'&&typeof v==='string')config.compilerOptions.paths[pkg.name+k.slice(1)]=[path.resolve(root,'runtime/packages',e.name,v)];}
 config.compilerOptions.paths.typescript=[path.join(root,'vendor/typescript/lib/typescript.js')];config.compilerOptions.paths.zod=[path.join(root,'vendor/zod/index.js')];fs.writeFileSync(path.join(root,'tsconfig.json'),JSON.stringify(config,null,2)+'\n');
 const semantic=path.join(root,'runtime/packages/ts-analyzer/src/semantic-dependency-diagnostics.ts'),anchor='  const { program, retained } = context;';let source=fs.readFileSync(semantic,'utf8');if(source.split(anchor).length!==2)throw Error('observer anchor mismatch');source='import {observe as __observe} from '+JSON.stringify(path.join(root,'observer.ts').replaceAll('\\','/'))+';\n'+source.replace(anchor,anchor+'\n  __observe(program, inputs, sourcePath);');fs.writeFileSync(semantic,source);
 const before=hash(fs.readFileSync(path.join(root,'expected.json'))),run=spawnSync(bun,['--tsconfig-override',path.join(root,'tsconfig.json'),path.join(root,'driver.ts')],{cwd:root});fs.writeFileSync(path.join(root,'replay.stdout'),run.stdout??Buffer.alloc(0));fs.writeFileSync(path.join(root,'replay.stderr'),run.stderr??Buffer.alloc(0));if(run.status!==0)throw Error('baseline replay failed '+run.status);if(hash(fs.readFileSync(path.join(root,'expected.json')))!==before)throw Error('expected bytes changed');
 const check=spawnSync(process.execPath,[path.join(root,'verify.mjs')],{cwd:root});fs.writeFileSync(path.join(root,'replay-verify.stdout'),check.stdout??Buffer.alloc(0));fs.writeFileSync(path.join(root,'replay-verify.stderr'),check.stderr??Buffer.alloc(0));if(check.status!==0)throw Error('verification failed '+check.status);
 commands.push({exe:bun,args:['--tsconfig-override',path.join(root,'tsconfig.json'),path.join(root,'driver.ts')],cwd:root,exit:run.status},{exe:process.execPath,args:[path.join(root,'verify.mjs')],cwd:root,exit:check.status});
 const pinned=['expected.json','driver.ts','observer.ts','verify.mjs','tsconfig.json','runtime/packages/ts-analyzer/src/semantic-dependency-diagnostics.ts','vendor/typescript/lib/typescript.js','vendor/typescript/package.json','vendor/zod/package.json','fixture/main.ts','fixture/package.json','fixture/.git/config','raw-observations.json'].map(name=>({path:name,sha256:hash(fs.readFileSync(path.join(root,name)))}));
 fs.writeFileSync(path.join(root,'v3-replay-provenance.json'),JSON.stringify({version:3,node:process.version,commands,gitEnvelope:{fixtureRoot:fixture,gitDirectory:path.join(fixture,'.git'),outsideEnclosingRepository:true,commitCreated:false,globalConfigMutated:false,precondition:'V1 inherited enclosing Git checkout; V3 explicitly initializes only the standalone fixture before the unchanged driver runs'},expectedSha256Before:before,expectedSha256After:hash(fs.readFileSync(path.join(root,'expected.json'))),pinned,sourceSDKJoin:'raw-observations.json actualProgramRecords pin actual retained bytes, actual SDK default-library hashes and actual Program roots/options after relocation; original archive retains exact V1 authority/SDK bytes'},null,2)+'\n');
 return {...result,replayExit:run.status,verifyExit:check.status,outputDirectory:root};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const [mode,destination,bun]=process.argv.slice(2);if(!destination||!['--extract','--replay'].includes(mode)||(mode==='--replay'&&!bun))throw Error('Usage: node unpack.mjs --extract FRESH_OUTSIDE_REPO | --replay FRESH_OUTSIDE_REPO BUN_EXE');
 console.log(JSON.stringify(mode==='--extract'?unpack(destination):replay(destination,bun)));
}
