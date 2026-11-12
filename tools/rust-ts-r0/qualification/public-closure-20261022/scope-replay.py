import copy
import hashlib
import json
import os
import pathlib
import subprocess
import sys
import time

freeze_path, baseline_path, bun, oracle_path, output_path = sys.argv[1:]
out = pathlib.Path(output_path)
out.mkdir(parents=True, exist_ok=False)
freeze = json.loads(pathlib.Path(freeze_path).read_bytes())
def sha(data):
    return hashlib.sha256(data).hexdigest()
def save(path, value):
    path.write_text(json.dumps(value, indent=2) + '\n')
def invoke(argv, cwd):
    start = time.monotonic()
    p = subprocess.run(argv, cwd=cwd, capture_output=True, timeout=40, env={**os.environ,"GOPORT_LIB_PARSE_SNAPSHOT":"0","GOPORT_LIB_SNAPSHOT":"0"})
    return {'kind':'success' if p.returncode == 0 else 'nonzero', 'exit_code':p.returncode, 'duration_ms':int((time.monotonic()-start)*1000), 'stdout':p.stdout.decode(), 'stderr':p.stderr.decode(), 'stdout_bytes':len(p.stdout), 'stderr_bytes':len(p.stderr), 'stdout_hash':sha(p.stdout), 'stderr_hash':sha(p.stderr)}
for key in ['artifact','helper','sdk']:
    if sha(pathlib.Path(freeze[key+'_path']).read_bytes()) != freeze[key+'_sha256']:
        raise ValueError('immutable input mismatch '+key)
base = {'src/main.ts':'export function main() { return 1; }\n', 'base.json':'{"compilerOptions":{"module":"ESNext","moduleResolution":"Bundler"}}', 'tsconfig.json':'{"extends":"./base.json"}', '.gitignore':'.semctx/\nbuild/\n'}
cases = [
 ('inherited-positive', {}, 'export function main() { return 2; }\n'),
 ('unretained-reference', {'build/generated.ts':'export const generated = 1;\n'}, '/// <reference path="../build/generated.ts" />\nexport function main() { return 2; }\n'),
 ('declared-optional', {'package.json':'{"name":"fixture","optionalDependencies":{"optional":"1.0.0"}}'}, "import { value } from 'optional'; export function main() { return value(); }\n"),
 ('undeclared-optional', {'package.json':'{"name":"fixture"}'}, "import { value } from 'optional'; export function main() { return value(); }\n"),
 ('excluded-dependent', {'hidden.ts':"import { main } from './src/main'; export function hidden() { return main(); }\n"}, 'export function main() { return 2; }\n'),
 ('excluded-computed', {'hidden.ts':"const name = './src/main'; export function hidden() { return import(name); }\n"}, 'export function main() { return 2; }\n'),
 ('excluded-unresolved', {'hidden.ts':"import { value } from './absent'; export const hidden = value;\n"}, 'export function main() { return 2; }\n')]
units=[]
for id, extra, main in cases:
    d=out/id
    root=d/'workspace'
    root.mkdir(parents=True)
    files={**base,**extra}
    for path,text in files.items():
        target=root/path
        target.parent.mkdir(parents=True,exist_ok=True)
        target.write_text(text)
    setup=[]
    for args in [['init','-q'],['add','.'],['-c','user.name=T00Fixture','-c','user.email=t00@example.test','commit','-qm','initial']]:
        capture=invoke(['git']+args,root)
        setup.append(capture)
        if capture['exit_code'] != 0: raise ValueError(capture)
    head=invoke(['git','rev-parse','--verify','HEAD'],root)['stdout'].strip()
    (root/'src/main.ts').write_text(main)
    files['src/main.ts']=main
    retained={str(root/path):text for path,text in files.items() if not path.startswith('build/')}
    request={'id':id,'cwd':str(root),'case_sensitive':sys.platform != 'darwin','files':retained,'roots':[str(root/'src/main.ts')], 'options':{'target':'ES2022','module':'ESNext','moduleResolution':'Bundler','allowJs':True,'jsx':'Preserve','skipLibCheck':True,'noEmit':True,'strict':False},'retained':True,'qualified':True,'sdk_directory':'/sdk/lib','roles':{},'selection':{},'disabled':[],'utf16_files':{},'raw_files':{}}
    request_path=d/'request.json'
    save(request_path,request)
    index=invoke([freeze['artifact_path'],'--batch',str(request_path),freeze['sdk_path']],root)
    save(d/'index-capture.json',index)
    descriptor={'repositoryRoot':str(root),'processHelper':freeze['helper_path'],'include':['src/**/*.ts'],'exclude':['node_modules','dist','.semctx','.git','coverage'],'index':{'analysis':request,'outcome':index,'baseCommit':head}}
    descriptor_path=d/'descriptor.json'
    save(descriptor_path,descriptor)
    verification=invoke([freeze['artifact_path'],'verify','working-tree',str(descriptor_path),freeze['sdk_path'],'--fail-on','none'],root)
    save(d/'native-capture.json',verification)
    try: report=json.loads(verification['stdout'])
    except ValueError: report={'error':verification['stderr']}
    save(d/'native-report.json',report)
    if id == 'inherited-positive':
        corrupted = copy.deepcopy(descriptor)
        corrupted['index']['outcome']['stdout_hash'] = '0'*64
        corrupted_path = d/'corrupted-index-descriptor.json'
        save(corrupted_path, corrupted)
        guard = invoke([freeze['artifact_path'],'verify','working-tree',str(corrupted_path),freeze['sdk_path'],'--fail-on','none'],root)
        save(d/'corrupted-index-capture.json', guard)

    units.append({'id':id,'root':str(root),'requestSha256':sha(request_path.read_bytes()),'descriptorSha256':sha(descriptor_path.read_bytes()),'nativeExit':verification['exit_code'],'native':report})
paths = {}
baseline = pathlib.Path(baseline_path)
for package in (baseline/'packages').glob('*/package.json'):
    metadata = json.loads(package.read_bytes())
    name = metadata.get('name')
    exports = metadata.get('exports')
    if isinstance(exports, dict):
        for key, value in exports.items():
            if isinstance(value, str):
                paths[name + ('' if key == '.' else key[1:])] = [str(package.parent/value)]
    if name not in paths:
        paths[name] = [str(package.parent/metadata.get('main', 'src/index.ts'))]
for package in (baseline/'node_modules/.bun').glob('*/node_modules/**/package.json'):
    if '/node_modules/' in str(package.relative_to(baseline/'node_modules/.bun')).split('/node_modules/', 1)[-1]:
        continue
    metadata = json.loads(package.read_bytes())
    name = metadata.get('name')
    entry = metadata.get('module', metadata.get('main'))
    if name and entry and name not in paths:
        paths[name] = [str(package.parent/entry)]
save(out/'oracle-tsconfig.json', {'extends':str(baseline/'tsconfig.json'), 'compilerOptions':{'baseUrl':str(baseline), 'paths':paths}})
save(out/'oracle-input.json' ,{'units':[{'id':u['id'],'root':u['root']} for u in units]})
oracle=invoke([bun,'--tsconfig-override',str(out/'oracle-tsconfig.json'),oracle_path,baseline_path,str(out/'oracle-input.json'),str(out/'oracle-output.json')],baseline_path)
save(out/'oracle-capture.json',oracle)
for key in ['artifact','helper','sdk']:
    if sha(pathlib.Path(freeze[key+'_path']).read_bytes()) != freeze[key+'_sha256']:
        raise ValueError('immutable input changed '+key)
save(out/'observations.json',{'freeze':freeze,'units':units,'oracleExit':oracle['exit_code']})
print(json.dumps({'output':str(out),'oracleExit':oracle['exit_code'],'nativeExits':[[u['id'],u['nativeExit']] for u in units]}))
