"""Hash a host-local verifier runtime/plan into a fresh fixture fragment. Never runs it."""
import argparse
import hashlib
import json
from pathlib import Path

parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--runtime',type=Path,required=True)
parser.add_argument('--python',type=Path,required=True)
parser.add_argument('--node',type=Path,required=True)
parser.add_argument('--plan',type=Path,required=True)
parser.add_argument('--output',type=Path,required=True)
args=parser.parse_args()
def sha(path):return hashlib.sha256(path.read_bytes()).hexdigest()
runtime=args.runtime.resolve()
manifest=json.loads((runtime/'runtime-manifest.json').read_text())
files=[]
for row in manifest['files']:
    path=runtime/row['path']
    if sha(path)!=row['sha256']:
        raise ValueError('verifier runtime bytes differ: '+row['path'])
    files.append({'path':str(path),'sha256':row['sha256']})
for path in [args.python.resolve(),args.node.resolve()]:
    files.append({'path':str(path),'sha256':sha(path)})
document=json.loads(args.plan.read_text())
if document['native_queries_performed']!=0 or document['manifest_sha256']!=manifest['frozen_manifest_sha256']:
    raise ValueError('plan is not an unexecuted frozen-input plan')
fragment={'supplement_python_path':str(args.python.resolve()),'supplement_node_path':str(args.node.resolve()),'supplement_bridge_cli_path':str(runtime/'public_bridge.py'),'supplement_public_module_dir':str(runtime),'supplement_graph_module_path':str(runtime/'public_graph_projection.cjs'),'supplement_public_plan_path':str(args.plan.resolve()),'supplement_public_plan_sha256':sha(args.plan),'supplement_frozen_root':document['frozen_root'],'supplement_verifier_files':files,'public_lifecycle_execution_enabled':False,'candidate_execution_authorized':False}
if args.output.exists():raise ValueError('fixture fragment output must be fresh')
args.output.write_text(json.dumps(fragment,indent=2)+'\n',encoding='utf-8')
print(json.dumps({'status':'FIXTURE_FRAGMENT_ONLY_DISABLED','files':len(files),'output_sha256':sha(args.output),'native_queries':0}))
