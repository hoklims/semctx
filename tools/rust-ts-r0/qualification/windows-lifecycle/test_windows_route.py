import copy
import hashlib
import json
import unittest
import os
from pathlib import Path
import tempfile
import shutil
from unittest.mock import patch
import sys

import collect_windows as route


class AuthorityTests(unittest.TestCase):
    def setUp(self):
        self.review=json.dumps({'review_report':{
            'findings':'NATIVE_PUBLIC38_ADEQUATE subject=sha256:'+'c'*64+' product='+route.SOURCE_HEAD+' evidence_sha256='+'d'*64,
            'declared_tools':['functions.request_user_input'],
            'capabilities':{'execute':False,'write':False,'delegate':False}}}).encode()
        self.pins={'workflow_sha':'a'*40,'collector_sha':'b'*40,
                   'prior_review_sha256':hashlib.sha256(self.review).hexdigest()}
        self.context={'event_name':'workflow_dispatch','repository':'hoklims/semctx','repository_id':'1289209764',
                      'runner_os':'Windows','workflow_sha':'a'*40,'collector_checkout_sha':'b'*40,
                      'product_checkout_sha':route.SOURCE_HEAD,'product_dirty':False,'collector_dirty':False}

    def test_exact_protected_bindings_prepare_the_route(self):
        self.assertTrue(route.authority_matches(self.context,self.pins,self.review))

    def test_missing_pins_or_foreign_runner_refuse(self):
        for key in self.pins:
            changed=copy.deepcopy(self.pins);changed[key]=''
            self.assertFalse(route.authority_matches(self.context,changed,self.review))
        for key in ('event_name','repository','repository_id','runner_os','workflow_sha',
                    'collector_checkout_sha','product_checkout_sha','product_dirty','collector_dirty'):
            changed=self.context|{key:'foreign'}
            self.assertFalse(route.authority_matches(changed,self.pins,self.review))

    def test_same_length_unapproved_or_nonfavorable_review_refuses(self):
        self.assertFalse(route.authority_matches(self.context,self.pins,self.review+b' '))
        denied=json.dumps({'product_sha':route.SOURCE_HEAD,'decision':'REJECTED','macos':'PASS','linux':'PASS','qualification_credit':0}).encode()
        pins=self.pins|{'prior_review_sha256':hashlib.sha256(denied).hexdigest()}
        self.assertFalse(route.authority_matches(self.context,pins,denied))

    def test_nonobject_report_or_nontext_findings_is_controlled_refusal(self):
        for report in (None,[],12,'text',{'findings':None},{'findings':[]},{'findings':3}):
            raw=json.dumps({'review_report':report}).encode()
            pins=self.pins|{'prior_review_sha256':hashlib.sha256(raw).hexdigest()}
            with self.subTest(report=report):
                self.assertFalse(route.authority_matches(self.context,pins,raw))

    def test_missing_authority_stops_main_before_any_output_or_executor(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary)
            review=root/'review.json';review.write_text('{}')
            output=root/'uncreated-output'
            argv=['collect_windows.py']
            for name,value in [('product-root',root),('collector-root',root),('inputs',root),
                ('prior-review',review),('review-bundle',root),('executor',Path(sys.executable)),
                ('git',Path(sys.executable)),('helper',Path(sys.executable)),('output',output)]:
                argv += ['--'+name,str(value)]
            argv.append('--execute')
            with (patch.object(sys,'argv',argv),patch.dict(os.environ,{},clear=True),
                  patch.object(route,'git_value',return_value=''),
                  patch.object(route.subprocess,'run',side_effect=AssertionError('executor reached')) as launch,
                  self.assertRaisesRegex(ValueError,'protected workflow')):
                route.main()
            launch.assert_not_called()
            self.assertFalse(output.exists())

    def test_main_verifies_the_exact_review_bytes_read_once(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary); review=root/'review.json'; review.write_bytes(self.review)
            argv=['collect_windows.py']
            for name,value in [('product-root',root),('collector-root',root),('inputs',root),
                ('prior-review',review),('review-bundle',root),('executor',Path(sys.executable)),
                ('git',Path(sys.executable)),('helper',Path(sys.executable)),('output',root/'absent')]:
                argv += ['--'+name,str(value)]
            original=Path.read_bytes; reads=[]
            def read(path):
                if path == review:
                    reads.append(path)
                    return self.review if len(reads)==1 else b'swapped review'
                return original(path)
            def verify(raw,*args):
                self.assertEqual(raw,self.review,'bundle verifier received swapped bytes')
                raise ValueError('verified same bytes sentinel')
            with (patch.object(sys,'argv',argv),patch.object(route,'git_value',return_value=''),
                  patch.object(route,'authority_matches',return_value=True),patch.object(Path,'read_bytes',read),
                  patch.object(route,'verify_bundle',side_effect=verify),
                  self.assertRaisesRegex(ValueError,'verified same bytes sentinel')):
                route.main()
            self.assertEqual(len(reads),1)
            self.assertFalse((root/'absent').exists())

    def test_actual_native_review_bundle_and_tampered_events(self):
        supplied=os.environ.get('WINDOWS_PRIOR_NATIVE_TEST_BUNDLE')
        if not supplied:
            self.skipTest('external public native-review integration bundle not supplied')
        source=Path(supplied)
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary)
            for name in ('REVIEW.json','review.events.jsonl','review.prompt.exact','review-catalog.json','review.stderr'):
                shutil.copy2(source/'independent'/name,root/name)
            shutil.copy2(source/'NATIVE-REVIEW-RECEIPT.json',root/'NATIVE-REVIEW-RECEIPT.json')
            shutil.copy2(source.parent/'verified-native/native-evidence.json',root/'native-evidence.json')
            raw=(root/'REVIEW.json').read_bytes()
            result=route.verify_bundle(raw,root,route.SOURCE_HEAD)
            self.assertEqual(result['review_sha256'],hashlib.sha256(raw).hexdigest())
            self.assertEqual(result['review_sha256'],'f6b4d734694c2184d935efca6a008ba964d063be624f103ee741583917169f0d')
            (root/'review.events.jsonl').write_bytes((root/'review.events.jsonl').read_bytes()+b'\n')
            with self.assertRaisesRegex(ValueError,'provenance bytes differ'):
                route.verify_bundle(raw,root,route.SOURCE_HEAD)


class GitPayloadTests(unittest.TestCase):
    def test_direct_payload_checks_both_layouts_before_selecting(self):
        from types import SimpleNamespace
        for layout in ('mingw64','ucrt64'):
            for mode in ('ambiguous','dangling','reparse-metadata'):
                with self.subTest(layout=layout,mode=mode),tempfile.TemporaryDirectory() as temporary:
                    root=Path(temporary).resolve();direct=root/layout/'bin/git.exe'
                    direct.parent.mkdir(parents=True);direct.write_bytes(b'direct payload')
                    alternative=root/('ucrt64' if layout=='mingw64' else 'mingw64')
                    original=Path.lstat
                    if mode=='ambiguous':
                        (alternative/'bin').mkdir(parents=True);(alternative/'bin/git.exe').write_bytes(b'alternative')
                    elif mode=='dangling':
                        alternative.symlink_to(root/'missing',target_is_directory=True)
                    else:
                        alternative.mkdir()
                    def lstat(path,alternative=alternative,original=original,mode=mode):
                        metadata=original(path)
                        if mode=='reparse-metadata' and path==alternative:
                            return SimpleNamespace(st_mode=metadata.st_mode,st_file_attributes=0x400)
                        return metadata
                    diagnostic='absent or ambiguous' if mode=='ambiguous' else 'link/reparse'
                    with patch.object(Path,'lstat',lstat),self.assertRaisesRegex(ValueError,diagnostic):
                        route.resolve_windows_git_payload(direct)

    def test_two_layouts_resolve_and_pin_payload_without_reading_launcher(self):
        for layout in ('mingw64','ucrt64'):
            with self.subTest(layout=layout),tempfile.TemporaryDirectory() as temporary:
                root=Path(temporary).resolve();shim=root/'cmd/git.exe';payload=root/layout/'bin/git.exe'
                shim.parent.mkdir();payload.parent.mkdir(parents=True)
                shim.write_bytes(b'launcher');payload.write_bytes(b'actual-payload')
                original=Path.read_bytes;reads=[]
                def read(path,reads=reads,original=original):
                    reads.append(path);return original(path)
                with patch.object(Path,'read_bytes',read):
                    resolved=route.resolve_windows_git_payload(shim)
                    self.assertEqual(resolved,payload)
                    self.assertEqual(route.resolve_windows_git_payload(payload),payload)
                    self.assertEqual(route.file_pin(resolved)['sha256'],hashlib.sha256(b'actual-payload').hexdigest())
                self.assertEqual(reads,[payload])

    def test_missing_ambiguous_unknown_and_linked_payload_refuse(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary).resolve();shim=root/'cmd/git.exe';shim.parent.mkdir();shim.write_bytes(b'launcher')
            with self.assertRaisesRegex(ValueError,'absent or ambiguous'):
                route.resolve_windows_git_payload(shim)
            for layout in ('mingw64','ucrt64'):
                payload=root/layout/'bin/git.exe';payload.parent.mkdir(parents=True);payload.write_bytes(b'payload')
            with self.assertRaisesRegex(ValueError,'absent or ambiguous'):
                route.resolve_windows_git_payload(shim)
            unknown=root/'other/git.exe';unknown.parent.mkdir();unknown.write_bytes(b'unknown')
            with self.assertRaisesRegex(ValueError,'unsupported'):
                route.resolve_windows_git_payload(unknown)
            payload=root/'ucrt64/bin/git.exe';payload.unlink();payload.symlink_to(root/'mingw64/bin/git.exe')
            with self.assertRaisesRegex(ValueError,'link/reparse'):
                route.resolve_windows_git_payload(payload)
            payload.unlink();payload.write_bytes(b'payload')
            actual=root/'mingw64/bin/git.exe';original=Path.lstat
            from types import SimpleNamespace
            def reparse(path):
                metadata=original(path)
                return SimpleNamespace(st_mode=metadata.st_mode,st_file_attributes=0x400) if path==actual else metadata
            with patch.object(Path,'lstat',reparse),self.assertRaisesRegex(ValueError,'link/reparse'):
                route.resolve_windows_git_payload(actual)
            linked=root/'linked';linked.symlink_to(root/'ucrt64',target_is_directory=True)
            with self.assertRaisesRegex(ValueError,'link/reparse'):
                route.resolve_windows_git_payload(linked/'bin/git.exe')

    def test_main_identity_reads_use_resolved_payload(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary).resolve();shim=root/'cmd/git.exe';payload=root/'mingw64/bin/git.exe'
            shim.parent.mkdir();payload.parent.mkdir(parents=True)
            shim.write_bytes(b'launcher');payload.write_bytes(b'payload')
            review=root/'review.json';review.write_bytes(b'{}');argv=['collect_windows.py']
            for name,value in [('product-root',root),('collector-root',root),('inputs',root),
                ('prior-review',review),('review-bundle',root),('executor',Path(sys.executable)),
                ('git',shim),('helper',Path(sys.executable)),('output',root/'absent')]:
                argv += ['--'+name,str(value)]
            def git_value(git,*args):
                self.assertEqual(git,payload);return ''
            with (patch.object(sys,'argv',argv),patch.object(route,'resolve_git_payload',side_effect=route.resolve_windows_git_payload),
                  patch.object(route,'git_value',side_effect=git_value) as calls,
                  patch.object(route,'authority_matches',return_value=False),
                  self.assertRaisesRegex(ValueError,'protected workflow')):
                route.main()
            self.assertEqual(calls.call_count,4)
            self.assertFalse((root/'absent').exists())


class StartupGitTests(unittest.TestCase):
    def test_whole_main_refuses_git_change_during_last_postflight_read(self):
        from types import SimpleNamespace
        import subprocess
        import contextlib,io
        for tamper in ('stable','postflight','bundle-dry','bundle-execute'):
            with self.subTest(tamper=tamper),tempfile.TemporaryDirectory() as temporary:
                root=Path(temporary).resolve();git=root/'ucrt64/bin/git.exe'
                git.parent.mkdir(parents=True);git.write_bytes(b'original payload')
                product=root/'product';collector=root/'collector';inputs=root/'inputs'
                for directory in (product,collector,inputs):directory.mkdir()
                for name in ('preflight.json','public-plan.json','source-snapshot.json'):(inputs/name).write_bytes(b'fixture')
                review=root/'review.json';review.write_bytes(b'test-only prerequisite stub')
                helper=root/'helper';executor=root/'executor'
                helper.write_bytes(b'helper fixture');executor.write_bytes(b'executor fixture')
                output=root/'output';argv=['collect_windows.py']+([] if tamper=='bundle-dry' else ['--execute'])
                for name,value in [('product-root',product),('collector-root',collector),('inputs',inputs),
                    ('prior-review',review),('review-bundle',root),('executor',executor),
                    ('git',git),('helper',helper),('output',output)]:argv += ['--'+name,str(value)]
                env={'SystemRoot':str(root),'GITHUB_ACTIONS':'true','WINDOWS_APPROVED_COLLECTOR_SHA':'b'*40,
                     'WINDOWS_OBSERVED_GIT_PAYLOAD_PATH':str(git),
                     'WINDOWS_OBSERVED_GIT_PAYLOAD_SHA256':hashlib.sha256(b'original payload').hexdigest()}
                executed=[];tree_calls=[];printed=io.StringIO()
                def verify(*args,tamper=tamper,git=git):
                    if tamper.startswith("bundle-"):
                        git.write_bytes(b"changed during bundle verification")
                        os.environ["WINDOWS_OBSERVED_GIT_PAYLOAD_SHA256"]=hashlib.sha256(git.read_bytes()).hexdigest()
                    return {"test_only_prerequisite_stub":True}
                def execute(*args,executed=executed,output=output,**kwargs):
                    executed.append(True);output.mkdir();return subprocess.CompletedProcess(args,0)
                def identity(actual_git,directory,*args,git=git,tamper=tamper,executed=executed,collector=collector,tree_calls=tree_calls,product=product):
                    self.assertEqual(actual_git,git)
                    if args[0]=='status':
                        if tamper=='postflight' and executed and directory==collector:git.write_bytes(b'changed during last read')
                        return ''
                    if args[-1]=='HEAD^{tree}':
                        tree_calls.append(True);return route.SOURCE_TREE
                    return route.SOURCE_HEAD if directory==product else 'b'*40
                platform=SimpleNamespace(name='nt',environ=os.environ,fsync=os.fsync,devnull=os.devnull)
                with (patch.object(sys,'argv',argv),patch.dict(os.environ,env),patch.object(route,'os',platform),
                      patch.object(route,'authority_matches',return_value=True),
                      patch.object(route,'verify_bundle',side_effect=verify),
                      patch.object(route,'load_locked',return_value=[]),patch.object(route,'git_value',side_effect=identity),
                      patch.object(route.subprocess,'run',side_effect=execute),contextlib.redirect_stdout(printed)):
                    if tamper!='stable':
                        with self.assertRaisesRegex(ValueError,'runtime executable changed|observed Git payload'):
                            route.main()
                    else:
                        route.main()
                self.assertEqual(bool(executed),tamper in ('stable','postflight'))
                if tamper.startswith('bundle-'):
                    self.assertFalse(tree_calls,'changed payload reached TREE read')
                    self.assertNotIn('INPUTS_AND_APPROVED_ROUTE_VERIFIED',printed.getvalue())
                self.assertEqual((output/'CONTROLLER-PROVENANCE.json').exists(),tamper=='stable')
                self.assertEqual((output/'APPROVED-REQUEST.json').exists(),tamper=='stable')
                if tamper=='stable':
                    saved=json.loads((output/'CONTROLLER-PROVENANCE.json').read_text())
                    self.assertEqual(saved['runtime_after']['git'],saved['prebuild_observed_git'])

    def test_wrapper_rejects_other_dangling_or_reparse_layout(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary).resolve();shim=root/'cmd/git.exe';shim.parent.mkdir();shim.write_bytes(b'shim')
            payload=root/'ucrt64/bin/git.exe';payload.parent.mkdir(parents=True);payload.write_bytes(b'payload')
            other=root/'mingw64';other.symlink_to(root/'missing-target',target_is_directory=True)
            with self.assertRaisesRegex(ValueError,'link/reparse'):
                route.resolve_windows_git_payload(shim)
            other.unlink();other.mkdir();original=Path.lstat
            from types import SimpleNamespace
            def reparse(path):
                metadata=original(path)
                return SimpleNamespace(st_mode=metadata.st_mode,st_file_attributes=0x400) if path==other else metadata
            with patch.object(Path,'lstat',reparse),self.assertRaisesRegex(ValueError,'link/reparse'):
                route.resolve_windows_git_payload(shim)

    def test_changed_prebuild_payload_pin_blocks_main_before_identity_reads(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary).resolve();payload=root/'mingw64/bin/git.exe'
            payload.parent.mkdir(parents=True);payload.write_bytes(b'payload')
            env={'WINDOWS_OBSERVED_GIT_PAYLOAD_PATH':str(payload),
                 'WINDOWS_OBSERVED_GIT_PAYLOAD_SHA256':hashlib.sha256(b'payload').hexdigest()}
            with patch.dict(os.environ,env):
                self.assertEqual(route.verify_observed_git(payload)['sha256'],env['WINDOWS_OBSERVED_GIT_PAYLOAD_SHA256'])
            argv=['collect_windows.py']
            for name,value in [('product-root',root),('collector-root',root),('inputs',root),
                ('prior-review',root/'absent-review'),('review-bundle',root),('executor',Path(sys.executable)),
                ('git',payload),('helper',Path(sys.executable)),('output',root/'absent')]:
                argv += ['--'+name,str(value)]
            env['WINDOWS_OBSERVED_GIT_PAYLOAD_SHA256']='f'*64
            with (patch.object(sys,'argv',argv),patch.dict(os.environ,env),
                  patch.object(route,'git_value',side_effect=AssertionError('identity reached')) as calls,
                  self.assertRaisesRegex(ValueError,'prebuild observed Git payload bytes differ')):
                route.main()
            calls.assert_not_called();self.assertFalse((root/'absent').exists())


class WorkflowTests(unittest.TestCase):
    def test_actual_powershell_direct_payload_rejects_alternative_layout(self):
        import subprocess
        executable=shutil.which('pwsh')
        if not executable:self.skipTest('PowerShell unavailable')
        text=self.workflow();start=text.index('      - name: Resolve and pin host Git payload')
        block=text[start:text.index('      - uses:',start)]
        script='\n'.join(line[10:] for line in block.splitlines()[3:])+'\n'
        for layout in ('mingw64','ucrt64'):
            for mode in ('ambiguous','dangling'):
                with self.subTest(layout=layout,mode=mode),tempfile.TemporaryDirectory() as temporary:
                    root=Path(temporary).resolve();direct=root/layout/'bin/git.exe'
                    direct.parent.mkdir(parents=True);direct.write_text('#!/bin/sh\nexit 99\n');direct.chmod(0o755)
                    alternative=root/('ucrt64' if layout=='mingw64' else 'mingw64')
                    if mode=='ambiguous':
                        (alternative/'bin').mkdir(parents=True);(alternative/'bin/git.exe').write_bytes(b'alternative')
                    else:
                        alternative.symlink_to(root/'missing',target_is_directory=True)
                    path=root/'resolve.ps1';path.write_text(script);observed=root/'environment'
                    env=dict(os.environ,PATH=str(direct.parent)+os.pathsep+os.environ['PATH'],GITHUB_ENV=str(observed))
                    result=subprocess.run([executable,'-NoProfile','-NonInteractive','-File',str(path)],env=env,capture_output=True,check=False)
                    self.assertNotEqual(result.returncode,0,'direct payload bypassed installation checks')
                    diagnostic=b'absent or ambiguous' if mode=='ambiguous' else b'link/reparse'
                    self.assertIn(diagnostic,result.stderr)
                    self.assertFalse(observed.exists())

    def workflow(self):
        return (Path(__file__).resolve().parents[4]/'.github/workflows/windows-lifecycle-collector.yml').read_text()

    def test_identity_checks_precede_all_candidate_execution(self):
        text=self.workflow()
        syntax=text.index('name: Validate protected pin syntax')
        first=text.index('uses: actions/checkout')
        second=text.index('uses: actions/checkout',first+1)
        identity=text.index('name: Verify checked out identities')
        build=text.index('run: cargo build')
        self.assertLess(syntax,first);self.assertLess(first,second)
        self.assertLess(second,identity);self.assertLess(identity,build)
        block=text[identity:build]
        resolver=text.index('name: Resolve and pin host Git payload')
        self.assertLess(syntax,resolver);self.assertLess(resolver,first)
        self.assertIn('Get-Command git.exe -CommandType Application',text[resolver:identity])
        self.assertNotIn('Get-Command',block)
        self.assertEqual(block.count('Assert-ObservedGit $git $pin'),2)
        self.assertLess(block.index('Assert-ObservedGit $git $pin'),block.index("@('rev-parse','HEAD')"))
        self.assertGreater(block.rindex('Assert-ObservedGit $git $pin'),block.index("@('status','--porcelain'"))
        self.assertIn('--no-optional-locks -c core.fsmonitor=false',block)
        self.assertIn("@('rev-parse','HEAD')",block);self.assertIn("@('status','--porcelain','--untracked-files=all')",block)
        self.assertIn('RUSTUP_TOOLCHAIN: 1.95.0',text)

    def test_main_has_no_raw_git_value_calls(self):
        import ast,inspect
        calls=[node for node in ast.walk(ast.parse(inspect.getsource(route.main))) if isinstance(node,ast.Call)]
        self.assertFalse(any(isinstance(node.func,ast.Name) and node.func.id=='git_value' for node in calls))
        text=self.workflow();start=text.index('      - name: Verify checked out identities')
        block=text[start:text.index('      - uses:',start)]
        self.assertEqual(block.count('$head = Invoke-ObservedGit'),1)
        self.assertEqual(block.count('$dirty = Invoke-ObservedGit'),1)
        self.assertNotIn('& $git',block)

    def test_actual_powershell_rejects_malformed_pin_before_build(self):
        import subprocess
        executable=shutil.which('pwsh')
        if not executable:
            self.skipTest('PowerShell unavailable; inline trusted pin guard not executed')
        text=self.workflow();start=text.index('      - name: Validate protected pin syntax')
        block=text[start:text.index('      - name: Resolve and pin host Git payload',start)]
        script='\n'.join(line[10:] for line in block.splitlines()[3:])+'\n'
        names=['WINDOWS_APPROVED_WORKFLOW_SHA','WINDOWS_APPROVED_COLLECTOR_SHA','WINDOWS_APPROVED_PRIOR_REVIEW_SHA256']
        good=dict(zip(names,['a'*40,'b'*40,'c'*64],strict=True))
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary).resolve();marker=root/'BUILD_REACHED';path=root/'guard.ps1'
            path.write_text(script+"Set-Content -LiteralPath '"+str(marker)+"' -Value 'BUILD_REACHED'\n")
            for name in names:
                for bad in ('main','0'*len(good[name]),good[name].upper(),good[name]+'\n'):
                    with self.subTest(name=name,bad=bad):
                        marker.unlink(missing_ok=True)
                        result=subprocess.run([executable,'-NoProfile','-NonInteractive','-File',str(path)],
                            env=dict(os.environ)|good|{name:bad},capture_output=True,check=False)
                        self.assertNotEqual(result.returncode,0)
                        self.assertIn(b'protected pin syntax rejected before checkout/build',result.stderr)
                        self.assertFalse(marker.exists())
            result=subprocess.run([executable,'-NoProfile','-NonInteractive','-File',str(path)],
                env=dict(os.environ)|good,capture_output=True,check=False)
            self.assertEqual(result.returncode,0,result.stderr)
            self.assertTrue(marker.exists())

    def test_actual_powershell_resolves_and_pins_payload_before_git_execution(self):
        import subprocess
        executable=shutil.which('pwsh')
        if not executable:
            self.skipTest('PowerShell unavailable')
        text=self.workflow();start=text.index('      - name: Resolve and pin host Git payload')
        block=text[start:text.index('      - uses:',start)]
        script='\n'.join(line[10:] for line in block.splitlines()[3:])+'\n'
        for layout in ('mingw64','ucrt64'):
            with self.subTest(layout=layout),tempfile.TemporaryDirectory() as temporary:
                root=Path(temporary).resolve();shim=root/'cmd/git.exe';payload=root/layout/'bin/git.exe'
                shim.parent.mkdir();payload.parent.mkdir(parents=True)
                shim.write_text('#!/bin/sh\nexit 99\n');shim.chmod(0o755);payload.write_bytes(b'payload bytes')
                path=root/'resolver.ps1';path.write_text(script);observed=root/'environment'
                env=dict(os.environ,PATH=str(shim.parent)+os.pathsep+os.environ['PATH'],GITHUB_ENV=str(observed))
                result=subprocess.run([executable,'-NoProfile','-NonInteractive','-File',str(path)],env=env,capture_output=True,check=False)
                self.assertEqual(result.returncode,0,result.stderr)
                self.assertIn('WINDOWS_OBSERVED_GIT_PAYLOAD_PATH='+str(payload),observed.read_text())
                self.assertIn(hashlib.sha256(b'payload bytes').hexdigest(),observed.read_text())
                other=root/('ucrt64' if layout=='mingw64' else 'mingw64');(other/'bin').mkdir(parents=True)
                (other/'bin/git.exe').write_bytes(b'other payload');observed.unlink()
                result=subprocess.run([executable,'-NoProfile','-NonInteractive','-File',str(path)],env=env,capture_output=True,check=False)
                self.assertNotEqual(result.returncode,0);self.assertIn(b'absent or ambiguous',result.stderr)
                self.assertFalse(observed.exists())
                shutil.rmtree(other);other.symlink_to(root/'missing',target_is_directory=True)
                result=subprocess.run([executable,'-NoProfile','-NonInteractive','-File',str(path)],env=env,capture_output=True,check=False)
                self.assertNotEqual(result.returncode,0);self.assertIn(b'link/reparse',result.stderr)
                self.assertFalse(observed.exists())

    def test_actual_prebuild_guards_refuse_identical_bytes_behind_new_link(self):
        import subprocess
        executable=shutil.which('pwsh')
        if not executable:self.skipTest('PowerShell unavailable')
        text=self.workflow();start=text.index('      - name: Verify checked out identities')
        block=text[start:text.index('      - uses:',start)]
        script='\n'.join(line[10:] for line in block.splitlines()[3:])+'\n'
        helper=script[:script.index('$git = $env:')]
        for mode in ('stable','before','during'):
            with self.subTest(mode=mode),tempfile.TemporaryDirectory() as temporary:
                root=Path(temporary).resolve();layout=root/'ucrt64';payload=layout/'bin/git.exe'
                payload.parent.mkdir(parents=True);payload.write_bytes(b'identical payload bytes')
                copy=root/'same-bytes';shutil.copytree(layout,copy)
                digest=hashlib.sha256(payload.read_bytes()).hexdigest();marker=root/'BUILD_REACHED'
                if mode=='before':
                    layout.rename(root/'old-layout');layout.symlink_to(copy,target_is_directory=True)
                self.assertEqual(hashlib.sha256(payload.read_bytes()).hexdigest(),digest)
                commands=helper+"$git=$env:CASE_PAYLOAD\n$pin=$env:CASE_SHA\nAssert-ObservedGit $git $pin\nWrite-Output 'FIRST_GUARD_PASSED'\n"
                if mode=='during':
                    commands+="Move-Item -LiteralPath $env:CASE_LAYOUT -Destination $env:CASE_OLD\nNew-Item -ItemType SymbolicLink -Path $env:CASE_LAYOUT -Target $env:CASE_COPY | Out-Null\n"
                commands+="Write-Output 'IDENTITY_READS_SIMULATED'\nAssert-ObservedGit $git $pin\nSet-Content -LiteralPath $env:CASE_BUILD -Value 'BUILD_REACHED'\n"
                path=root/'guards.ps1';path.write_text(commands)
                env=dict(os.environ,CASE_PAYLOAD=str(payload),CASE_SHA=digest,CASE_LAYOUT=str(layout),
                    CASE_OLD=str(root/'old-layout'),CASE_COPY=str(copy),CASE_BUILD=str(marker))
                result=subprocess.run([executable,'-NoProfile','-NonInteractive','-File',str(path)],env=env,capture_output=True,check=False)
                if mode=='stable':
                    self.assertEqual(result.returncode,0,result.stderr);self.assertTrue(marker.exists())
                else:
                    self.assertNotEqual(result.returncode,0)
                    self.assertIn(b'prebuild Git path contains link/reparse point',result.stderr)
                    self.assertFalse(marker.exists())
                    self.assertEqual(b'FIRST_GUARD_PASSED' in result.stdout,mode=='during')
                    self.assertEqual(b'IDENTITY_READS_SIMULATED' in result.stdout,mode=='during')


    def test_actual_powershell_wraps_each_identity_read_without_output_leak(self):
        import subprocess
        executable=shutil.which('pwsh')
        if not executable:self.skipTest('PowerShell unavailable')
        text=self.workflow();start=text.index('      - name: Verify checked out identities')
        block=text[start:text.index('      - uses:',start)]
        script='\n'.join(line[10:] for line in block.splitlines()[3:])+'\n'
        helper=script[:script.index('$git = $env:')]
        for mode in ('stable','before','during'):
            with self.subTest(mode=mode),tempfile.TemporaryDirectory() as temporary:
                root=Path(temporary).resolve();payload=root/'ucrt64/bin/git.exe';payload.parent.mkdir(parents=True)
                payload.write_text('#!/bin/sh\nrun() {\n printf "read-result\\n"\n : > "$CASE_CALLED"\n if [ "$CASE_CHANGE" = "1" ]; then /bin/cp "$CASE_REPLACEMENT" "$0"; fi\n}\nrun\n')
                payload.chmod(0o755);digest=hashlib.sha256(payload.read_bytes()).hexdigest()
                replacement=root/'changed';replacement.write_bytes(b'changed payload')
                if mode=='before':payload.write_bytes(replacement.read_bytes())
                path=root/'invoke.ps1';path.write_text(helper+"$value=Invoke-ObservedGit $env:CASE_PAYLOAD $env:CASE_SHA $env:CASE_ROOT @('rev-parse','HEAD')\nWrite-Output $value\nSet-Content -LiteralPath $env:CASE_BUILD -Value 'BUILD'\n")
                marker=root/'BUILD';called=root/'CALLED'
                env=dict(os.environ,CASE_PAYLOAD=str(payload),CASE_SHA=digest,CASE_ROOT=str(root),CASE_BUILD=str(marker),
                    CASE_CALLED=str(called),CASE_REPLACEMENT=str(replacement),CASE_CHANGE='1' if mode=='during' else '0')
                result=subprocess.run([executable,'-NoProfile','-NonInteractive','-File',str(path)],env=env,capture_output=True,check=False)
                if mode=='stable':
                    self.assertEqual(result.returncode,0,result.stderr);self.assertEqual(result.stdout.strip(),b'read-result')
                    self.assertTrue(marker.exists());self.assertTrue(called.exists())
                else:
                    self.assertNotEqual(result.returncode,0);self.assertIn(b'prebuild Git payload changed',result.stderr)
                    self.assertNotIn(b'read-result',result.stdout);self.assertFalse(marker.exists())
                    self.assertEqual(called.exists(),mode=='during')


if __name__=='__main__':
    unittest.main()
