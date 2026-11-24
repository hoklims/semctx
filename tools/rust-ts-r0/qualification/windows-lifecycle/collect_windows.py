"""Dedicated manual Windows route. Protected approval pins default to absent."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import stat
from dataclasses import dataclass

from collector import SOURCE_HEAD, SOURCE_TREE, load_locked
from prior_review import verify_bundle


def authority_matches(context, pins, review):
    if set(pins) != {'workflow_sha','collector_sha','prior_review_sha256'}:
        return False
    if not all(isinstance(pins[name],str) and re.fullmatch('[0-9a-f]{'+str(size)+'}',pins[name])
               and pins[name] != '0'*size for name,size in
               [('workflow_sha',40),('collector_sha',40),('prior_review_sha256',64)]):
        return False
    expected={'event_name':'workflow_dispatch','repository':'hoklims/semctx','repository_id':'1289209764',
              'runner_os':'Windows','workflow_sha':pins['workflow_sha'],
              'collector_checkout_sha':pins['collector_sha'],'product_checkout_sha':SOURCE_HEAD,
              'product_dirty':False,'collector_dirty':False}
    if any(context.get(key) != value or (key.endswith('_dirty') and context[key] is not False)
           for key,value in expected.items()):
        return False
    if hashlib.sha256(review).hexdigest() != pins['prior_review_sha256']:
        return False
    try:
        decision=json.loads(review)
    except (ValueError,TypeError):
        return False
    if not isinstance(decision,dict):
        return False
    parsed=decision.get('review_report',{})
    if not isinstance(parsed,dict) or not isinstance(parsed.get('findings'),str):
        return False
    line=parsed['findings'].splitlines()
    return (bool(line) and re.fullmatch(
        'NATIVE_PUBLIC38_ADEQUATE subject=sha256:[0-9a-f]{64} product='+SOURCE_HEAD+' evidence_sha256=[0-9a-f]{64}',line[0]) is not None
        and parsed.get('capabilities')=={'execute':False,'write':False,'delegate':False}
        and parsed.get('declared_tools')==['functions.request_user_input'])


def file_pin(path):
    if path.is_symlink():
        raise ValueError('runtime input is a symlink')
    path=path.resolve(strict=True)
    if not path.is_file() or path.is_symlink():
        raise ValueError('runtime input must be a regular canonical file')
    return {'path':str(path),'sha256':hashlib.sha256(path.read_bytes()).hexdigest()}


def git_entry(path):
    raw=str(path)
    if any(part in ('.','..') for part in re.split(r'[\\/]',raw)):
        raise ValueError('Git entry is not lexically canonical')
    parsed=Path(raw)
    if not parsed.is_absolute() or str(parsed)!=raw or parsed.anchor=='//':
        raise ValueError('Git entry is not lexically canonical')
    return parsed


def resolve_windows_git_payload(path):
    path=git_entry(path)
    def regular(candidate,allow_missing=False):
        items=(*reversed(candidate.parents),candidate)
        for index,item in enumerate(items):
            try:
                metadata=item.lstat()
            except FileNotFoundError:
                if allow_missing:
                    return None
                raise
            if stat.S_ISLNK(metadata.st_mode) or getattr(metadata,'st_file_attributes',0)&0x400:
                raise ValueError('Git runtime path contains link/reparse point')
            if index<len(items)-1 and not stat.S_ISDIR(metadata.st_mode):
                raise ValueError('Git runtime ancestor is not a directory')
        if not stat.S_ISREG(metadata.st_mode):
            raise ValueError('Git payload is not a regular file')
        physical=candidate.resolve(strict=True)
        if physical!=candidate:
            raise ValueError('Git runtime path is not physically canonical')
        return physical
    path=regular(path)
    if path.name.lower() != 'git.exe':
        raise ValueError('unsupported Windows Git layout')
    direct=path.parent.name.lower()=='bin' and path.parent.parent.name.lower() in ('mingw64','ucrt64')
    if direct:
        installation=path.parent.parent.parent
    elif path.parent.name.lower()=='cmd':
        installation=path.parent.parent
    else:
        raise ValueError('unsupported Windows Git launcher layout')
    candidates=[installation/layout/'bin/git.exe' for layout in ('mingw64','ucrt64')]
    candidates=[payload for candidate in candidates if (payload:=regular(candidate,True)) is not None]
    if len(candidates)!=1:
        raise ValueError('Git payload is absent or ambiguous')
    if direct and candidates[0]!=path:
        raise ValueError('direct Git payload differs from unique installation payload')
    return regular(candidates[0])


def resolve_git_payload(path):
    path=git_entry(path)
    return resolve_windows_git_payload(path) if os.name=='nt' else path.resolve(strict=True)


def verify_observed_git(git):
    path=os.environ.get('WINDOWS_OBSERVED_GIT_PAYLOAD_PATH','')
    digest=os.environ.get('WINDOWS_OBSERVED_GIT_PAYLOAD_SHA256','')
    if os.name!='nt' and not path and not digest:
        return None
    observed=git_entry(path)
    if (not path or not re.fullmatch('[0-9a-f]{64}',digest) or digest=='0'*64
            or observed!=git):
        raise ValueError('prebuild observed Git payload identity differs')
    actual=file_pin(resolve_windows_git_payload(git))
    if actual['sha256']!=digest:
        raise ValueError('prebuild observed Git payload bytes differ')
    return actual


def git_value(git, root, *args):
    environment={'PATH':str(git.parent),'GIT_CONFIG_GLOBAL':os.devnull,'GIT_CONFIG_NOSYSTEM':'1',
                 'GIT_TERMINAL_PROMPT':'0','LC_ALL':'C'}
    if os.name=='nt':
        environment.update(SystemRoot=os.environ['SystemRoot'],WINDIR=os.environ['SystemRoot'])
    result=subprocess.run([str(git),'--no-optional-locks','-c','core.fsmonitor=false','-C',str(root),*args],
                          env=environment,capture_output=True,check=False,timeout=20)
    if result.returncode:
        raise ValueError('checkout identity read failed')
    return result.stdout.decode().strip()


@dataclass(frozen=True)
class BoundGit:
    path: Path
    sha256: str

    @classmethod
    def capture(cls,path):
        resolved=resolve_git_payload(path)
        pin=verify_observed_git(resolved) or file_pin(resolved)
        return cls(resolved,pin['sha256'])

    @property
    def pin(self):
        return {'path':str(self.path),'sha256':self.sha256}

    def check(self):
        resolved=resolve_git_payload(self.path)
        if resolved!=self.path or file_pin(resolved)!=self.pin:
            raise ValueError('observed Git payload binding changed')
        return self.pin

    def read(self,root,*args):
        self.check()
        try:
            return git_value(self.path,root,*args)
        finally:
            self.check()


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    for name in ('product-root','collector-root','inputs','prior-review','executor','git','helper','output'):
        parser.add_argument('--'+name,type=str if name=='git' else Path,required=True)
    parser.add_argument('--execute',action='store_true')
    parser.add_argument('--review-bundle',type=Path,required=True)
    args=parser.parse_args()
    bound_git=BoundGit.capture(args.git)
    git=bound_git.path
    observed_git=bound_git.pin
    pins={key:os.environ.get(variable,'') for key,variable in [
        ('workflow_sha','WINDOWS_APPROVED_WORKFLOW_SHA'),('collector_sha','WINDOWS_APPROVED_COLLECTOR_SHA'),
        ('prior_review_sha256','WINDOWS_APPROVED_PRIOR_REVIEW_SHA256')]}
    context={'event_name':os.environ.get('GITHUB_EVENT_NAME'),'repository':os.environ.get('GITHUB_REPOSITORY'),
        'repository_id':os.environ.get('GITHUB_REPOSITORY_ID'),'runner_os':os.environ.get('RUNNER_OS'),
        'workflow_sha':os.environ.get('GITHUB_WORKFLOW_SHA'),
        'collector_checkout_sha':bound_git.read(args.collector_root,'rev-parse','HEAD'),
        'collector_dirty':bool(bound_git.read(args.collector_root,'status','--porcelain','--untracked-files=all')),
        'product_checkout_sha':bound_git.read(args.product_root,'rev-parse','HEAD'),
        'product_dirty':bool(bound_git.read(args.product_root,'status','--porcelain','--untracked-files=all'))}
    review_raw=args.prior_review.read_bytes()
    bound_git.check()
    if not authority_matches(context,pins,review_raw):
        raise ValueError('protected workflow/collector/prior-review approval is absent or mismatched')
    prior_native=verify_bundle(review_raw,args.review_bundle,SOURCE_HEAD)
    if bound_git.read(args.product_root,'rev-parse','HEAD^{tree}') != SOURCE_TREE:
        raise ValueError('frozen product tree differs')
    locked_inputs={name:args.inputs/filename for name,filename in [
        ('preflight','preflight.json'),('public_plan','public-plan.json'),('source_snapshot','source-snapshot.json')]}
    input_pins={name:file_pin(path) for name,path in locked_inputs.items()}
    fixtures=load_locked(locked_inputs)
    report={'native_execution_enabled':False,'state':'INPUTS_AND_APPROVED_ROUTE_VERIFIED',
            'fixture_groups':len(fixtures),'initial_files':sum(len(row['files']) for row in fixtures),
            'product_sha':SOURCE_HEAD,'qualification_credit':0}
    if not args.execute:
        print(json.dumps(report))
        return
    if os.name != 'nt' or os.environ.get('GITHUB_ACTIONS') != 'true':
        raise ValueError('native collection requires the admitted Windows Actions runner')
    if args.output.exists() or args.output.is_relative_to(args.product_root) or args.output.is_relative_to(args.collector_root):
        raise ValueError('output must be fresh and outside both checkouts')
    runtime={'git':file_pin(git),'helper':file_pin(args.helper),
             'executor':file_pin(args.executor),'system_root':os.environ['SystemRoot']}
    if observed_git is not None and runtime['git']!=observed_git:
        raise ValueError('observed Git payload changed before collection')
    request={'schema':1,'product_sha':SOURCE_HEAD,'authority':pins,'runtime':runtime,'output':str(args.output),
             'fixtures':[{'key':row['key'],'files':{key:value.decode('utf-8') for key,value in row['files'].items()}}
                         for row in fixtures]}
    raw=json.dumps(request,sort_keys=True,separators=(',',':')).encode()
    # The runner owns this non-acquisition request file; no fixture path is written
    # until the independently approved executor validates its dispatch bindings.
    request_path=args.output.with_suffix('.request.json')
    with request_path.open('xb') as stream:
        stream.write(raw)
    environment=dict(os.environ,WINDOWS_COLLECTOR_REQUEST_SHA256=hashlib.sha256(raw).hexdigest())
    result=subprocess.run([runtime['executor']['path'],str(request_path)],env=environment,check=False)
    if result.returncode:
        raise ValueError('owned Windows collector refused; preserve all evidence')
    bound_git.check()
    runtime_after={}
    for name in ('git','helper','executor'):
        runtime_after[name]=file_pin(Path(runtime[name]['path']))
        if runtime_after[name] != runtime[name]:
            raise ValueError('runtime executable changed')
    for root,expected in ((args.product_root,SOURCE_HEAD),(args.collector_root,pins['collector_sha'])):
        if (bound_git.read(root,'rev-parse','HEAD') != expected
                or bound_git.read(root,'status','--porcelain','--untracked-files=all')):
            raise ValueError('source checkout changed during collection')
    bound_git.check()
    # This is the final executable snapshot, after the final Git identity read.
    for name in ('git','helper','executor'):
        runtime_after[name]=file_pin(Path(runtime[name]['path']))
        if runtime_after[name]!=runtime[name]:
            raise ValueError('runtime executable changed during postflight')
    if {name:file_pin(path) for name,path in locked_inputs.items()} != input_pins:
        raise ValueError('locked preparation input changed')
    with (args.output/'APPROVED-REQUEST.json').open('xb') as stream:
        stream.write(raw)
        stream.flush()
        os.fsync(stream.fileno())
    provenance={'schema':1,'context':context,'protected_approval_pins':pins,'prior_native_review':prior_native,
        'input_pins_before_after':input_pins,'prebuild_observed_git':observed_git,
        'runtime_before':runtime,'runtime_after':runtime_after,
        'request_sha256':hashlib.sha256(raw).hexdigest(),'product_tree':SOURCE_TREE,
        'workflow_run_id':os.environ.get('GITHUB_RUN_ID'),'workflow_run_attempt':os.environ.get('GITHUB_RUN_ATTEMPT'),
        'source_postflight_verified':True,'qualification_credit':0,'candidate_queries':0}
    with (args.output/'CONTROLLER-PROVENANCE.json').open('x') as stream:
        json.dump(provenance,stream,indent=2)
        stream.flush()
        os.fsync(stream.fileno())
    print(json.dumps({'state':'NATIVE_WINDOWS_FIXTURE_PREPARATION_CAPTURED','native_execution_enabled':True,
                      'qualification_credit':0,'candidate_queries':0}))


if __name__=='__main__':
    try:
        main()
    except (OSError,ValueError,KeyError,TypeError) as error:
        print('WINDOWS_COLLECTOR_REFUSED: '+str(error),file=sys.stderr)
        raise SystemExit(2) from error
