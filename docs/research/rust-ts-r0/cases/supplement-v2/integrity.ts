import {readFileSync,readdirSync,realpathSync,existsSync} from 'node:fs';
import {join,dirname,relative} from 'node:path';
import {createHash} from 'node:crypto';
export const hash=(value:Uint8Array|string)=>createHash('sha256').update(value).digest('hex');
export function packageRoot(name:string,source:string){let entry:string;try{entry=Bun.resolveSync(name,name.startsWith('@lezer/')?join(source,'packages/python-analyzer'):name==='zod'?join(source,'packages/core'):source);}catch{entry=Bun.resolveSync(name,dirname(Bun.resolveSync('@lezer/python',join(source,'packages/python-analyzer'))));}let root=dirname(realpathSync(entry));while(!existsSync(join(root,'package.json')))root=dirname(root);return root;}
export function validateRuntime(source:string,authority:string){
 const expected=JSON.parse(readFileSync(join(authority,'observed/oracle-runtime-dependency-manifest.json'),'utf8'));
 const effective=[];
 if(Bun.version!=='1.4.3')throw new Error('Bun 1.4.3 required');
 for(const dep of expected.dependencies){const root=packageRoot(dep.name,source),pkg=JSON.parse(readFileSync(join(root,'package.json'),'utf8'));if(pkg.version!==dep.version)throw new Error('VERSION_MISMATCH:'+dep.name);for(const f of dep.files){const bytes=readFileSync(join(root,f.path));if(bytes.length!==f.size||hash(bytes)!==f.sha256)throw new Error('DEPENDENCY_BYTES_MISMATCH:'+dep.name+':'+f.path);}effective.push({name:dep.name,version:pkg.version,root:root.replaceAll('\\','/'),filesVerified:dep.files.length,expectedFileManifestSha256:hash(JSON.stringify(dep.files))});}
 const tsRoot=packageRoot('typescript',source),sdk=JSON.parse(readFileSync(join(authority,'observed/typescript-sdk-manifest.json'),'utf8'));for(const f of sdk.files){const b=readFileSync(join(tsRoot,'lib',f.path));if(b.length!==f.size||hash(b)!==f.sha256)throw new Error('SDK_BYTES_MISMATCH:'+f.path);}
 return {bun:Bun.version,platform:process.platform,arch:process.arch,dependencies:effective,sdkFilesVerified:sdk.files.length,sdkManifestSha256:hash(readFileSync(join(authority,'observed/typescript-sdk-manifest.json')))};
}
