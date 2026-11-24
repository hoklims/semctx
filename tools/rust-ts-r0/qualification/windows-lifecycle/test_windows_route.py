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

    def test_native_receipt_exact_bytes_are_required_independently(self):
        supplied=os.environ.get('WINDOWS_PRIOR_NATIVE_TEST_BUNDLE')
        if not supplied:self.skipTest('external public native-review integration bundle not supplied')
        source=Path(supplied)
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary)
            for name in ('REVIEW.json','review.events.jsonl','review.prompt.exact','review-catalog.json','review.stderr'):
                shutil.copy2(source/'independent'/name,root/name)
            shutil.copy2(source.parent/'verified-native/native-evidence.json',root/'native-evidence.json')
            receipt=(source/'NATIVE-REVIEW-RECEIPT.json').read_bytes();path=root/'NATIVE-REVIEW-RECEIPT.json';path.write_bytes(receipt)
            raw=(root/'REVIEW.json').read_bytes();route.verify_bundle(raw,root,route.SOURCE_HEAD)
            changed=json.loads(receipt);changed['unchecked_extra']='changed receipt custody'
            for altered in (receipt+b' ',json.dumps(changed).encode()):
                with self.subTest(altered_sha=hashlib.sha256(altered).hexdigest()):
                    path.write_bytes(altered)
                    with self.assertRaisesRegex(ValueError,'native review receipt bytes differ'):
                        route.verify_bundle(raw,root,route.SOURCE_HEAD)


class GitPayloadTests(unittest.TestCase):
    def test_standard_bin_launcher_resolves_payload_without_execution(self):
        for layout in ('mingw64','ucrt64'):
            with self.subTest(layout=layout),tempfile.TemporaryDirectory() as temporary:
                root=Path(temporary).resolve();shim=root/'bin/git.exe';payload=root/layout/'bin/git.exe';marker=root/'launcher-executed'
                shim.parent.mkdir();payload.parent.mkdir(parents=True)
                shim.write_text('#!/bin/sh\ntouch "'+str(marker)+'"\nexit 99\n');shim.chmod(0o755);payload.write_bytes(b'actual payload')
                try:
                    selected=route.resolve_windows_git_payload(shim)
                except ValueError as error:
                    self.fail('standard top-level bin launcher refused: '+str(error))
                self.assertEqual(selected,payload);self.assertEqual(route.file_pin(selected)['sha256'],hashlib.sha256(b'actual payload').hexdigest());self.assertFalse(marker.exists())
                other=root/('ucrt64' if layout=='mingw64' else 'mingw64');(other/'bin').mkdir(parents=True);(other/'bin/git.exe').write_bytes(b'other')
                with self.assertRaisesRegex(ValueError,'absent or ambiguous'):route.resolve_windows_git_payload(shim)
                shutil.rmtree(other);other.symlink_to(root/'missing',target_is_directory=True)
                with self.assertRaisesRegex(ValueError,'link/reparse'):route.resolve_windows_git_payload(shim)
                self.assertFalse(marker.exists())

    def test_physical_resolution_cannot_redirect_regular_entry(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary).resolve()
            first=root/'first/mingw64/bin/git.exe';second=root/'second/mingw64/bin/git.exe'
            for path in (first,second):path.parent.mkdir(parents=True);path.write_bytes(b'identical payload')
            original=Path.resolve
            def physical(path,strict=False):
                return second if path==first else original(path,strict=strict)
            self.assertEqual(route.resolve_windows_git_payload(first),first)
            with patch.object(Path,'resolve',physical),self.assertRaisesRegex(ValueError,'not physically canonical'):
                route.resolve_windows_git_payload(first)

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
            self.assertEqual(calls.call_count,8)
            self.assertFalse((root/'absent').exists())


class StartupGitTests(unittest.TestCase):
    def test_raw_cli_relative_and_redundant_git_spellings_refuse(self):
        import contextlib
        from types import SimpleNamespace
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary).resolve();git=root/'mingw64/bin/git.exe';git.parent.mkdir(parents=True);git.write_bytes(b'payload')
            review=root/'review.json';review.write_bytes(b'{}')
            for raw in ('mingw64/bin/git.exe',str(root)+'//mingw64/bin/git.exe',str(git)+'/'):
                with self.subTest(raw=raw),contextlib.chdir(root):
                    argv=['collect_windows.py']
                    for name,value in [('product-root',root),('collector-root',root),('inputs',root),
                        ('prior-review',review),('review-bundle',root),('executor',Path(sys.executable)),
                        ('git',raw),('helper',Path(sys.executable)),('output',root/'absent')]:argv+=['--'+name,str(value)]
                    platform=SimpleNamespace(name='nt',environ=os.environ,fsync=os.fsync,devnull=os.devnull)
                    env={'WINDOWS_OBSERVED_GIT_PAYLOAD_PATH':str(git),
                         'WINDOWS_OBSERVED_GIT_PAYLOAD_SHA256':hashlib.sha256(b'payload').hexdigest()}
                    with (patch.object(sys,'argv',argv),patch.object(route,'os',platform),patch.dict(os.environ,env),
                          patch.object(route,'git_value',return_value='') as calls,
                          patch.object(route,'authority_matches',return_value=False),
                          self.assertRaisesRegex(ValueError,'Git entry is not lexically canonical')):
                        route.main()
                    calls.assert_not_called();self.assertFalse((root/'absent').exists())

    def test_observed_original_git_alias_refuses_before_capture(self):
        import contextlib
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary).resolve();git=root/'ucrt64/bin/git.exe';git.parent.mkdir(parents=True);git.write_bytes(b'payload')
            digest=hashlib.sha256(b'payload').hexdigest()
            with contextlib.chdir(root):
                with patch.dict(os.environ,WINDOWS_OBSERVED_GIT_PAYLOAD_PATH=str(git),WINDOWS_OBSERVED_GIT_PAYLOAD_SHA256=digest):
                    self.assertEqual(route.BoundGit.capture(str(git)).path,git)
                for raw in ('ucrt64/bin/git.exe',str(root)+'//ucrt64/bin/git.exe',str(root)+'/./ucrt64/bin/git.exe'):
                    with self.subTest(raw=raw),patch.dict(os.environ,WINDOWS_OBSERVED_GIT_PAYLOAD_PATH=raw,WINDOWS_OBSERVED_GIT_PAYLOAD_SHA256=digest):
                        with self.assertRaisesRegex(ValueError,'Git entry is not lexically canonical'):
                            route.BoundGit.capture(str(git))

    def test_raw_cli_git_entry_rejects_dot_segments_before_normalization(self):
        from types import SimpleNamespace
        for segment in ('.','ordinary/..'):
            with self.subTest(segment=segment),tempfile.TemporaryDirectory() as temporary:
                root=Path(temporary).resolve();(root/'ordinary').mkdir()
                git=root/'mingw64/bin/git.exe';git.parent.mkdir(parents=True);git.write_bytes(b'payload')
                raw=str(root)+'/'+segment+'/mingw64/bin/git.exe'
                review=root/'review.json';review.write_bytes(b'{}');argv=['collect_windows.py']
                for name,value in [('product-root',root),('collector-root',root),('inputs',root),
                    ('prior-review',review),('review-bundle',root),('executor',Path(sys.executable)),
                    ('git',raw),('helper',Path(sys.executable)),('output',root/'absent')]:argv+=['--'+name,str(value)]
                platform=SimpleNamespace(name='nt',environ=os.environ,fsync=os.fsync,devnull=os.devnull)
                env={'WINDOWS_OBSERVED_GIT_PAYLOAD_PATH':str(git),
                     'WINDOWS_OBSERVED_GIT_PAYLOAD_SHA256':hashlib.sha256(b'payload').hexdigest()}
                with (patch.object(sys,'argv',argv),patch.object(route,'os',platform),patch.dict(os.environ,env),
                      patch.object(route,'git_value',return_value='') as calls,
                      patch.object(route,'authority_matches',return_value=False),
                      self.assertRaisesRegex(ValueError,'Git entry is not lexically canonical')):
                    route.main()
                calls.assert_not_called();self.assertFalse((root/'absent').exists())

    def test_whole_main_refuses_git_change_during_last_postflight_read(self):
        from types import SimpleNamespace
        import subprocess
        import contextlib,io
        for tamper in ('stable','postflight','bundle-dry','bundle-execute','binary-helper','binary-executor','missing-helper','invalid-executor','copied-helper'):
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
                for name,path in [('HELPER',helper),('EXECUTOR',executor)]:
                    env['WINDOWS_VERIFIED_'+name+'_PATH']=str(path)
                    env['WINDOWS_VERIFIED_'+name+'_SHA256']=hashlib.sha256(path.read_bytes()).hexdigest()
                if tamper=='missing-helper':env.pop('WINDOWS_VERIFIED_HELPER_SHA256')
                if tamper=='invalid-executor':env['WINDOWS_VERIFIED_EXECUTOR_SHA256']='invalid'
                if tamper=='copied-helper':
                    alias=root/'copied-helper';alias.write_bytes(helper.read_bytes());env['WINDOWS_VERIFIED_HELPER_PATH']=str(alias)
                executed=[];tree_calls=[];printed=io.StringIO()
                def verify(*args,tamper=tamper,git=git,helper=helper,executor=executor):
                    if tamper.startswith('binary-'):
                        (helper if tamper=='binary-helper' else executor).write_bytes(b'changed after completed manifest verification')
                    if tamper.startswith("bundle-"):
                        git.write_bytes(b"changed during bundle verification")
                        os.environ["WINDOWS_OBSERVED_GIT_PAYLOAD_SHA256"]=hashlib.sha256(git.read_bytes()).hexdigest()
                    return {"test_only_prerequisite_stub":True}
                def execute(*args,executed=executed,output=output,**kwargs):
                    executed.append(True);output.mkdir();return subprocess.CompletedProcess(args,0)
                def identity(actual_git,directory,*args,git=git,tamper=tamper,executed=executed,collector=collector,tree_calls=tree_calls,product=product):
                    self.assertEqual(actual_git,git)
                    if args[0]=='ls-files':return ''
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
                      patch.object(route.BoundGit,'verify_checkout',return_value=None),
                      patch.object(route,'load_locked',return_value=[]),patch.object(route,'git_value',side_effect=identity),
                      patch.object(route.subprocess,'run',side_effect=execute),contextlib.redirect_stdout(printed)):
                    if tamper!='stable':
                        with self.assertRaisesRegex(ValueError,'runtime executable changed|observed Git payload|verified binary'):
                            route.main()
                    else:
                        route.main()
                self.assertEqual(bool(executed),tamper in ('stable','postflight'))
                if tamper=='stable':
                    provenance=json.loads((output/'CONTROLLER-PROVENANCE.json').read_bytes())
                    self.assertIn('verified_build_binaries',provenance)
                    for name in ('helper','executor'):
                        self.assertEqual(provenance['verified_build_binaries'][name],provenance['runtime_before'][name])
                        self.assertEqual(provenance['verified_build_binaries'][name],provenance['runtime_after'][name])
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
    def test_postbuild_guard_rejects_changes_before_pinned_python_launch(self):
        import subprocess,shlex
        executable=shutil.which('pwsh')
        if not executable:self.skipTest('PowerShell unavailable')
        workflow=Path(__file__).resolve().parents[4]/'.github/workflows/windows-lifecycle-collector.yml'
        parsed=subprocess.run(['ruby','-e',"require 'yaml';require 'json';puts JSON.generate(YAML.load_file(ARGV[0]))",str(workflow)],capture_output=True,check=False)
        self.assertEqual(parsed.returncode,0,parsed.stderr);steps=json.loads(parsed.stdout)['jobs']['collect']['steps']
        step=next(s for s in steps if s.get('name')=='Collect once after authority and provenance checks')
        startup=next((s for s in steps if s.get('id')=='startup_python'),None)
        if startup:
            shell,args=step['shell'].split(' ',1)
            self.assertEqual(shell,r'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe')
            self.assertIn('-NoProfile',args);self.assertNotIn('-ExecutionPolicy',args)
        for case in ('source','python','missing-pin','path-only','module-path-only','binary-helper','binary-executor'):
            with self.subTest(case=case),tempfile.TemporaryDirectory() as temporary:
                root=Path(temporary).resolve();temp=root/'temp';temp.mkdir();module_root=root/'collector/tools/rust-ts-r0/qualification/windows-lifecycle';module_root.mkdir(parents=True);(root/'product').mkdir()
                for name in ('collect_windows.py','collector.py','prior_review.py'):shutil.copy2(Path(__file__).parent/name,module_root/name)
                for name in ('examples/windows_lifecycle_collector.exe','semctx-gates.exe'):
                    built=root/'native-binaries'/name;built.parent.mkdir(parents=True,exist_ok=True);built.write_bytes(b'harmless built fixture')
                original=root/'runtime/python';original.parent.mkdir();marker=root/'original-launched';shadow_marker=root/'shadow-launched';arguments=root/'arguments'
                original.write_text('#!/bin/sh\nprintf "%s\\n" "$@" > "'+str(arguments)+'"\ntouch "'+str(marker)+'"\n');original.chmod(0o755)
                shadow=root/'shadow/python';shadow.parent.mkdir();shadow.write_text('#!/bin/sh\ntouch "'+str(shadow_marker)+'"\n');shadow.chmod(0o755)
                git=root/'git/mingw64/bin/git.exe';git.parent.mkdir(parents=True);git.write_text('#!/bin/sh\ncase "$*" in *"rev-parse HEAD"*) case "$*" in *collector*) printf "%s\\n" "$WINDOWS_APPROVED_COLLECTOR_SHA";; *) printf "%s\\n" "04b83a5f394431e1dcca533889f6c02e32d02a0d";; esac;; esac\n');git.chmod(0o755)
                env=dict(os.environ,WINDOWS_OBSERVED_GIT_PAYLOAD_PATH=str(git),WINDOWS_OBSERVED_GIT_PAYLOAD_SHA256=hashlib.sha256(git.read_bytes()).hexdigest(),WINDOWS_APPROVED_COLLECTOR_SHA='a'*40,WINDOWS_APPROVED_WORKFLOW_SHA='b'*40,WINDOWS_APPROVED_PRIOR_REVIEW_SHA256='c'*64,RUNNER_TEMP=str(temp),WINDOWS_TRUSTED_RUNNER_TEMP=str(temp))
                all_jobs=json.loads(parsed.stdout)['jobs']
                producer=next(item for item in all_jobs['build']['steps'] if item.get('name')=='Bind binaries to completed source observations')
                verifier=next(item for item in all_jobs['collect']['steps'] if item.get('name')=='Validate the exact binary transport tree')
                release=root/'collector/tools/gates/target/release';(release/'examples').mkdir(parents=True)
                for relative in ('examples/windows_lifecycle_collector.exe','semctx-gates.exe'):
                    shutil.copy2(root/'native-binaries'/relative,release/relative)
                binary_output=root/'verified-step-output'
                env.update(BUILD_SOURCE_COMMIT='a'*40,BUILD_SOURCE_TREE='d'*40,BUILD_WORKFLOW_SHA='b'*40,BUILD_RUN_ID='123',BUILD_RUN_ATTEMPT='1',GITHUB_OUTPUT=str(binary_output))
                for label,body in [('build-record',producer['run']),('verify-record',verifier['run'])]:
                    path=root/(label+'.ps1');path.write_text(body)
                    if label=='verify-record':shutil.copy2(release/'BUILD-PROVENANCE.json',root/'native-binaries/BUILD-PROVENANCE.json')
                    result=subprocess.run([executable,'-NoProfile','-NonInteractive','-File',str(path)],cwd=root,env=env,capture_output=True,check=False)
                    self.assertEqual(result.returncode,0,result.stderr)
                verified=dict(line.split('=',1) for line in binary_output.read_text().splitlines())
                for name in ('HELPER','EXECUTOR'):
                    for part in ('PATH','SHA256'):
                        key='WINDOWS_VERIFIED_'+name+'_'+part
                        self.assertIn(key,verified,'manifest verification did not preserve binary identity')
                        self.assertEqual(step.get('env',{}).get(key),'${{ steps.verified_binaries.outputs.'+key+' }}')
                        env[key]=verified[key]
                if case.startswith('binary-'):
                    changed=root/'native-binaries'/('semctx-gates.exe' if case=='binary-helper' else 'examples/windows_lifecycle_collector.exe')
                    changed.write_bytes(b'changed after completed manifest verification')
                if startup:
                    path=root/'startup.ps1';path.write_text(startup['run']);output=root/'startup-output'
                    observed=subprocess.run([executable,'-NoProfile','-NonInteractive','-File',str(path)],cwd=root,env=env|{'PATH':str(original.parent)+os.pathsep+os.environ['PATH'],'GITHUB_OUTPUT':str(output)},capture_output=True,check=False)
                    self.assertEqual(observed.returncode,0,observed.stderr);env.update(line.split('=',1) for line in output.read_text().splitlines())
                else:
                    env.update(WINDOWS_OBSERVED_PYTHON_PATH=str(original),WINDOWS_OBSERVED_PYTHON_SHA256=hashlib.sha256(original.read_bytes()).hexdigest())
                observed_python={key:env[key] for key in ('WINDOWS_OBSERVED_PYTHON_PATH','WINDOWS_OBSERVED_PYTHON_SHA256')}
                if case=='missing-pin':observed_python['WINDOWS_OBSERVED_PYTHON_SHA256']=''
                if case=='source':(module_root/'collect_windows.py').write_bytes((module_root/'collect_windows.py').read_bytes()+b'\n# altered by build\n')
                if case=='python':original.write_text(original.read_text()+'# altered by build\n')
                module_marker=root/'hostile-module-executed'
                if case=='module-path-only':
                    module=root/'modules/Microsoft.PowerShell.Utility';module.mkdir(parents=True)
                    (module/'Microsoft.PowerShell.Utility.psd1').write_text("@{RootModule='Microsoft.PowerShell.Utility.psm1';ModuleVersion='1.0';FunctionsToExport=@('Get-FileHash')}\n")
                    (module/'Microsoft.PowerShell.Utility.psm1').write_text("function Get-FileHash { [IO.File]::WriteAllText($env:CASE_MODULE_MARKER,'executed'); throw 'hostile PowerShell module executed' }\nExport-ModuleMember -Function Get-FileHash\n")
                    env.update(PSModulePath=str(root/'modules'),CASE_MODULE_MARKER=str(module_marker))
                env['PATH']=str(shadow.parent)+os.pathsep+os.environ['PATH']
                env.update(WINDOWS_OBSERVED_PYTHON_PATH=str(shadow),WINDOWS_OBSERVED_PYTHON_SHA256=hashlib.sha256(shadow.read_bytes()).hexdigest())
                for key,value in observed_python.items():
                    expression=step.get('env',{}).get(key)
                    if expression is not None:
                        self.assertEqual(expression,'${{ steps.startup_python.outputs.'+key+' }}')
                        env[key]=value
                path=root/('collect-without-extension' if startup else 'collect.ps1');path.write_text(step['run'].replace('${{ github.run_id }}','123').replace('${{ github.run_attempt }}','1'))
                shell_args=[part.format(str(path)) for part in shlex.split(args)] if startup else ['-NoProfile','-NonInteractive','-File',str(path)]
                if case=='module-path-only':
                    # Exercise the real autoload path with Utility not already resident.
                    # This is isolated child-session setup, not a Windows runtime claim.
                    env.update(CASE_POST_SCRIPT=str(path),CASE_HOSTILE_MODULES=str(root/'modules'))
                    setup="Microsoft.PowerShell.Core\\Remove-Module Microsoft.PowerShell.Utility -Force -ErrorAction SilentlyContinue; $env:PSModulePath=$env:CASE_HOSTILE_MODULES; . ([scriptblock]::Create([IO.File]::ReadAllText($env:CASE_POST_SCRIPT)))"
                    shell_args=['-NoProfile','-NonInteractive','-Command',setup]
                result=subprocess.run([executable,*shell_args],cwd=root,env=env,capture_output=True,check=False)
                self.assertFalse(module_marker.exists(),'hostile module autoload executed before the trusted postbuild guard')
                if case in ('path-only','module-path-only'):
                    self.assertEqual(result.returncode,0,result.stderr);self.assertTrue(marker.exists(),'post-build PATH replaced the pre-build interpreter')
                    launch_args=arguments.read_text().splitlines();self.assertIn('-I',launch_args);self.assertIn('-B',launch_args);self.assertIn('-X',launch_args);self.assertTrue(any(a.startswith('pycache_prefix=') for a in launch_args))
                else:
                    self.assertNotEqual(result.returncode,0,'post-build mutation reached interpreter resolution/loading')
                    self.assertIn(b'postbuild',result.stderr);self.assertFalse(marker.exists())
                self.assertFalse(shadow_marker.exists(),'post-build PATH interpreter executed')

    def test_bootstrap_loads_only_explicit_sources_with_fresh_bytecode_cache(self):
        import py_compile,subprocess,re,textwrap
        text=self.workflow().split('      - name: Collect once after authority and provenance checks\n',1)[1].split('\n      - ',1)[0]
        match=re.search(r"\$bootstrap = @'\n(.*?)\n[ ]*'@",text,re.S)
        if match:program=textwrap.dedent(match[1])
        else:program=re.search(r'"(import runpy,sys;[^\n]+run_module[^\n]+)"',text)[1]
        for case in ('package','bytecode'):
            with self.subTest(case=case),tempfile.TemporaryDirectory() as temporary:
                root=Path(temporary).resolve();marker=root/'shadow-executed'
                controller=root/'collect_windows.py';controller.write_text('from collector import TOKEN\nprint(TOKEN)\n');(root/'prior_review.py').write_text('')
                companion=root/'collector.py';safe="TOKEN='SAFE'\n";bad="TOKEN='EVIL'\nopen("+repr(str(marker))+",'w').write('x')\n"
                companion.write_text(bad);timestamp=companion.stat();py_compile.compile(str(companion),doraise=True)
                companion.write_text(safe+'#'*(len(bad)-len(safe)-1)+'\n');os.utime(companion,ns=(timestamp.st_atime_ns,timestamp.st_mtime_ns))
                if case=='package':
                    package=root/'collector';package.mkdir();(package/'__init__.py').write_text(bad)
                cache=root/'fresh';cache.mkdir();flags=['-X','pycache_prefix='+str(cache)] if '"pycache_prefix=$cache"' in text else []
                result=subprocess.run([sys.executable,'-I','-B',*flags,'-c',program,str(root)],capture_output=True,check=False)
                self.assertEqual(result.returncode,0,result.stderr);self.assertEqual(result.stdout.strip(),b'SAFE','checkout package/bytecode shadow executed before source approval');self.assertFalse(marker.exists())

    def test_actual_powershell_standard_bin_launcher_is_not_executed(self):
        import subprocess
        executable=shutil.which('pwsh')
        if not executable:self.skipTest('PowerShell unavailable')
        text=self.workflow();start=text.index('      - name: Resolve and pin host Git payload')
        block=text[start:text.index('      - uses:',start)];lines=block.splitlines();body=lines.index('        run: |')+1
        script='\n'.join(line[10:] for line in lines[body:])+'\n'
        for layout in ('mingw64','ucrt64'):
            with self.subTest(layout=layout),tempfile.TemporaryDirectory() as temporary:
                root=Path(temporary).resolve();shim=root/'bin/git.exe';payload=root/layout/'bin/git.exe';marker=root/'launcher-executed'
                shim.parent.mkdir();payload.parent.mkdir(parents=True);payload.write_bytes(b'actual payload')
                shim.write_text('#!/bin/sh\ntouch "'+str(marker)+'"\nexit 99\n');shim.chmod(0o755)
                script_path=root/'resolve.ps1';script_path.write_text(script);output=root/'output'
                env=dict(os.environ,PATH=str(shim.parent)+os.pathsep+os.environ['PATH'],GITHUB_OUTPUT=str(output))
                def invoke(script_path=script_path,env=env):return subprocess.run([executable,'-NoProfile','-NonInteractive','-File',str(script_path)],env=env,capture_output=True,check=False)
                result=invoke()
                self.assertEqual(result.returncode,0,'standard top-level bin launcher refused: '+result.stderr.decode())
                self.assertIn('WINDOWS_OBSERVED_GIT_PAYLOAD_PATH='+str(payload),output.read_text());self.assertIn(hashlib.sha256(b'actual payload').hexdigest(),output.read_text());self.assertFalse(marker.exists())
                other=root/('ucrt64' if layout=='mingw64' else 'mingw64');(other/'bin').mkdir(parents=True);(other/'bin/git.exe').write_bytes(b'other');output.unlink()
                result=invoke();self.assertNotEqual(result.returncode,0);self.assertIn(b'absent or ambiguous',result.stderr);self.assertFalse(output.exists())
                shutil.rmtree(other);other.symlink_to(root/'missing',target_is_directory=True)
                result=invoke();self.assertNotEqual(result.returncode,0);self.assertIn(b'link/reparse',result.stderr);self.assertFalse(output.exists());self.assertFalse(marker.exists())

    def test_toolchain_provisioning_follows_identity_approval_and_precedes_build(self):
        import subprocess
        ruby="require 'yaml';require 'json';puts JSON.generate(YAML.load_file(ARGV[0]))"
        path=Path(__file__).resolve().parents[4]/'.github/workflows/windows-lifecycle-collector.yml'
        result=subprocess.run(['ruby','-e',ruby,str(path)],capture_output=True,check=False)
        self.assertEqual(result.returncode,0,result.stderr);jobs=json.loads(result.stdout)['jobs'];job=jobs['build'];steps=job['steps']
        provision=[i for i,step in enumerate(steps) if step.get('name')=='Provision admitted Rust toolchain']
        self.assertEqual(len(provision),1,'declared Rust toolchain must be explicitly provisioned')
        index=provision[0];approval=next(i for i,step in enumerate(steps) if step.get('name')=='Verify checked out identities before build');build=next(i for i,step in enumerate(steps) if step.get('name')=='Build admitted transport and helper')
        guard=next(i for i,step in enumerate(steps) if step.get('name')=='Validate protected pin syntax before checkout')
        self.assertLess(guard,approval);self.assertLess(approval,index,'toolchain provisioning ran before source approval');self.assertLess(index,build,'Cargo reached before toolchain provisioning')
        receiver=jobs['collect']['steps']
        python_pin=next(i for i,step in enumerate(receiver) if step.get('id')=='startup_python')
        receiver_approval=next(i for i,step in enumerate(receiver) if step.get('name')=='Verify checked out identities before build')
        receiver_launch=next(i for i,step in enumerate(receiver) if step.get('name')=='Collect once after authority and provenance checks')
        self.assertLess(receiver_approval,python_pin);self.assertLess(python_pin,receiver_launch)
        self.assertEqual(steps[index]['run'].split(),['rustup','toolchain','install','1.95.0','--profile','minimal']);self.assertEqual(str(job['env']['RUSTUP_TOOLCHAIN']),'1.95.0')

    def test_actual_powershell_refuses_relative_and_redundant_git_spellings(self):
        import subprocess
        executable=shutil.which('pwsh')
        if not executable:self.skipTest('PowerShell unavailable')
        text=self.workflow();start=text.index('      - name: Resolve and pin host Git payload')
        block=text[start:text.index('      - uses:',start)]
        lines=block.splitlines();body=lines.index('        run: |')+1
        script='\n'.join(line[10:] for line in lines[body:])+'\n';helper=script[:script.index('$entry = (Get-Command')]
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary).resolve();git=root/'mingw64/bin/git.exe';git.parent.mkdir(parents=True);git.write_bytes(b'payload')
            marker=root/'selected';path=root/'resolve.ps1';path.write_text(helper+"$value=Resolve-GitPayload $env:RAW_ENTRY\nSet-Content -LiteralPath $env:CASE_MARKER -Value $value\n")
            def invoke(raw):
                return subprocess.run([executable,'-NoProfile','-NonInteractive','-File',str(path)],cwd=root,
                    env=dict(os.environ,RAW_ENTRY=raw,CASE_MARKER=str(marker)),capture_output=True,check=False)
            valid=invoke(str(git));self.assertEqual(valid.returncode,0,valid.stderr);self.assertEqual(marker.read_text().strip(),str(git));marker.unlink()
            for raw in ('mingw64/bin/git.exe',str(root)+'//mingw64/bin/git.exe',str(git)+'/'):
                with self.subTest(raw=raw):
                    result=invoke(raw)
                    self.assertNotEqual(result.returncode,0,'relative or redundant Git entry was normalized and accepted')
                    self.assertIn(b'Git entry is not lexically canonical',result.stderr)
                    self.assertFalse(marker.exists())

    def test_actual_artifact_identity_guard_refuses_lists_and_numeric_aliases(self):
        import subprocess
        executable=shutil.which('pwsh')
        if not executable:self.skipTest('PowerShell unavailable')
        path=Path(__file__).resolve().parents[4]/'.github/workflows/windows-lifecycle-collector.yml'
        parsed=subprocess.run(['ruby','-e',"require 'yaml';require 'json';puts JSON.generate(YAML.load_file(ARGV[0]))",str(path)],capture_output=True,check=False)
        self.assertEqual(parsed.returncode,0,parsed.stderr)
        jobs=json.loads(parsed.stdout)['jobs']
        for job_name in ('build','collect'):
            with self.subTest(job=job_name):
                steps=jobs[job_name]['steps']
                guard=next((step for step in steps if step.get('name')=='Validate exact artifact input identities'),None)
                self.assertIsNotNone(guard,'artifact selection has no exact numeric identity guard')
                self.assertLess(steps.index(guard),next(index for index,step in enumerate(steps) if 'uses' in step))
                names={'WINDOWS_INPUTS_RUN_ID':'inputs_run_id','WINDOWS_INPUTS_ARTIFACT_ID':'inputs_artifact_id',
                       'WINDOWS_REVIEW_RUN_ID':'review_run_id','WINDOWS_REVIEW_ARTIFACT_ID':'review_artifact_id'}
                self.assertEqual(guard['env'],{name:'${{ inputs.'+value+' }}' for name,value in names.items()})
                cases=[]
                for name in names:
                    for value in ('1','9007199254740991','0','01','-1','+1','1,2','1\n2',' 1','1e3','١','9007199254740992','18446744073709551616',''):
                        cases.append({'env':dict.fromkeys(names,'1')|{name:value},'accepted':value in ('1','9007199254740991')})
                with tempfile.TemporaryDirectory() as temporary:
                    root=Path(temporary);body=root/'guard.ps1';body.write_text(guard['run'])
                    matrix=root/'cases.json';matrix.write_text(json.dumps(cases));runner=root/'run.ps1'
                    runner.write_text("""$ErrorActionPreference='Stop'
        $body=[IO.File]::ReadAllText($env:GUARD_FILE)
        $cases=ConvertFrom-Json -AsHashtable ([IO.File]::ReadAllText($env:GUARD_CASES))
        $results=@(foreach ($case in $cases) {
          foreach ($name in $case.env.Keys) { [Environment]::SetEnvironmentVariable($name,$case.env[$name],'Process') }
          try { & ([ScriptBlock]::Create($body)); @{accepted=$true;diagnostic=''} }
          catch { @{accepted=$false;diagnostic=$_.Exception.Message} }
        })
        ConvertTo-Json -Compress -Depth 5 -InputObject $results
        """)
                    result=subprocess.run([executable,'-NoProfile','-NonInteractive','-File',str(runner)],
                        env=dict(os.environ,GUARD_FILE=str(body),GUARD_CASES=str(matrix)),capture_output=True,check=False)
                    self.assertEqual(result.returncode,0,result.stderr)
                    observed=json.loads(result.stdout);self.assertEqual(len(observed),len(cases))
                    for case,row in zip(cases,observed,strict=True):
                        with self.subTest(values=case['env']):
                            self.assertEqual(row['accepted'],case['accepted'],'artifact identity guard accepted an alias or refused an exact ID')
                            if not case['accepted']:self.assertIn('artifact input identity rejected',row['diagnostic'])

    def test_completed_startup_outputs_restore_git_and_protected_pins_before_capture(self):
        import re,subprocess
        executable=shutil.which('pwsh')
        if not executable:self.skipTest('PowerShell unavailable')
        ruby="require 'yaml';require 'json';puts JSON.generate(YAML.load_file(ARGV[0]))"
        path=Path(__file__).resolve().parents[4]/'.github/workflows/windows-lifecycle-collector.yml'
        parsed=subprocess.run(['ruby','-e',ruby,str(path)],capture_output=True,check=False)
        self.assertEqual(parsed.returncode,0,parsed.stderr)
        steps=json.loads(parsed.stdout)['jobs']['collect']['steps']
        startup=next(step for step in steps if step.get('name','').startswith('Resolve and pin'))
        consumers=[step for step in steps if step.get('name','').startswith(('Verify checked out','Collect once'))]
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary).resolve();shim=root/'original/cmd/git.exe';git=root/'original/ucrt64/bin/git.exe'
            shim.parent.mkdir(parents=True);git.parent.mkdir(parents=True)
            shim.write_text('#!/bin/sh\nexit 99\n');shim.chmod(0o755);git.write_bytes(b'original payload')
            replacement=root/'replacement/mingw64/bin/git.exe';replacement.parent.mkdir(parents=True);replacement.write_bytes(b'replacement payload')
            output=root/'startup-output';environment_file=root/'job-env';script=root/'startup.ps1';script.write_text(startup['run'])
            environment=dict(os.environ,PATH=str(shim.parent)+os.pathsep+os.environ['PATH'],
                GITHUB_ENV=str(environment_file),GITHUB_OUTPUT=str(output))
            result=subprocess.run([executable,'-NoProfile','-NonInteractive','-File',str(script)],env=environment,capture_output=True,check=False)
            self.assertEqual(result.returncode,0,result.stderr)
            stored=output if output.exists() else environment_file
            snapshot=dict(line.split('=',1) for line in stored.read_text().splitlines())
            protected={'WINDOWS_APPROVED_WORKFLOW_SHA':'a'*40,'WINDOWS_APPROVED_COLLECTOR_SHA':'b'*40,
                       'WINDOWS_APPROVED_PRIOR_REVIEW_SHA256':'c'*64}
            tampered=dict(protected,WINDOWS_OBSERVED_GIT_PAYLOAD_PATH=str(replacement),
                          WINDOWS_OBSERVED_GIT_PAYLOAD_SHA256=hashlib.sha256(b'replacement payload').hexdigest())
            for name in protected:tampered[name]='f'*len(protected[name])
            for consumer in consumers:
                with self.subTest(consumer=consumer['name']):
                    effective=dict(tampered)
                    # Model the documented runner precedence: explicit step env overrides
                    # GITHUB_ENV from completed prior steps; outputs come from completed startup.
                    for name,value in consumer.get('env',{}).items():
                        if name not in (*protected,'WINDOWS_OBSERVED_GIT_PAYLOAD_PATH','WINDOWS_OBSERVED_GIT_PAYLOAD_SHA256'):continue
                        expression=re.fullmatch(r'\$\{\{ steps\.([A-Za-z0-9_]+)\.outputs\.([A-Za-z0-9_]+) \}\}',value)
                        if expression:
                            self.assertEqual(expression[1],startup.get('id'));effective[name]=snapshot[expression[2]]
                        else:
                            variable=re.fullmatch(r'\$\{\{ vars\.([A-Za-z0-9_]+) \}\}',value)
                            self.assertIsNotNone(variable);effective[name]=protected[variable[1]]
                    # Both Git values were replaced BEFORE real Python capture, not afterwards.
                    with patch.dict(os.environ,effective):bound=route.BoundGit.capture(Path(effective['WINDOWS_OBSERVED_GIT_PAYLOAD_PATH']))
                    self.assertEqual(bound.path,git,'changed startup pair was accepted before capture')
                    self.assertEqual(bound.sha256,hashlib.sha256(b'original payload').hexdigest())
                    self.assertEqual({name:effective[name] for name in protected},protected)

    def test_actual_powershell_rejects_raw_dot_segments_before_normalization(self):
        import subprocess
        executable=shutil.which('pwsh')
        if not executable:self.skipTest('PowerShell unavailable')
        text=self.workflow();start=text.index('      - name: Resolve and pin host Git payload')
        block=text[start:text.index('      - uses:',start)]
        lines=block.splitlines();body=lines.index('        run: |')+1
        script='\n'.join(line[10:] for line in lines[body:])+'\n'
        helper=script[:script.index('$entry = (Get-Command')]
        for segment in ('.','ordinary/..'):
            with self.subTest(segment=segment),tempfile.TemporaryDirectory() as temporary:
                root=Path(temporary).resolve();(root/'ordinary').mkdir();git=root/'ucrt64/bin/git.exe'
                git.parent.mkdir(parents=True);git.write_bytes(b'payload')
                raw=str(root)+'/'+segment+'/ucrt64/bin/git.exe';marker=root/'ACCEPTED'
                path=root/'resolve.ps1';path.write_text(helper+"$value=Resolve-GitPayload $env:RAW_ENTRY\nSet-Content -LiteralPath $env:CASE_MARKER -Value $value\n")
                result=subprocess.run([executable,'-NoProfile','-NonInteractive','-File',str(path)],
                    env=dict(os.environ,RAW_ENTRY=raw,CASE_MARKER=str(marker)),capture_output=True,check=False)
                self.assertNotEqual(result.returncode,0,'noncanonical raw entry was normalized and accepted')
                self.assertIn(b'Git entry is not lexically canonical',result.stderr);self.assertFalse(marker.exists())

    def test_actual_powershell_direct_payload_rejects_alternative_layout(self):
        import subprocess
        executable=shutil.which('pwsh')
        if not executable:self.skipTest('PowerShell unavailable')
        text=self.workflow();start=text.index('      - name: Resolve and pin host Git payload')
        block=text[start:text.index('      - uses:',start)]
        lines=block.splitlines();body=lines.index('        run: |')+1
        script='\n'.join(line[10:] for line in lines[body:])+'\n'
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
                    env=dict(os.environ,PATH=str(direct.parent)+os.pathsep+os.environ['PATH'],GITHUB_OUTPUT=str(observed))
                    result=subprocess.run([executable,'-NoProfile','-NonInteractive','-File',str(path)],env=env,capture_output=True,check=False)
                    self.assertNotEqual(result.returncode,0,'direct payload bypassed installation checks')
                    diagnostic=b'absent or ambiguous' if mode=='ambiguous' else b'link/reparse'
                    self.assertIn(diagnostic,result.stderr)
                    self.assertFalse(observed.exists())

    def test_prior_review_bytes_are_checked_before_build(self):
        import subprocess
        executable=shutil.which('pwsh')
        if not executable:self.skipTest('PowerShell unavailable')
        bundle=os.environ.get('WINDOWS_PRIOR_NATIVE_TEST_BUNDLE')
        if not bundle:self.skipTest('Actual public native review bundle not supplied')
        workflow=Path(__file__).resolve().parents[4]/'.github/workflows/windows-lifecycle-collector.yml'
        parsed=subprocess.run(['ruby','-e',"require 'yaml';require 'json';puts JSON.generate(YAML.load_file(ARGV[0]))",str(workflow)],capture_output=True,check=False)
        self.assertEqual(parsed.returncode,0,parsed.stderr);steps=json.loads(parsed.stdout)['jobs']['build']['steps']
        verify=next(step for step in steps if step.get('name')=='Validate prior review bytes before build')
        self.assertLess(steps.index(verify),next(i for i,step in enumerate(steps) if 'cargo build' in step.get('run','')))
        self.assertLess(steps.index(verify),next(i for i,step in enumerate(steps) if 'rustup toolchain install' in step.get('run','')))
        for tamper in ('stable','report','receipt','events','prompt','catalog','evidence'):
            with self.subTest(tamper=tamper),tempfile.TemporaryDirectory() as temporary:
                root=Path(temporary).resolve();prior=root/'prior-native';prior.mkdir();origin=Path(bundle)
                for name in ('REVIEW.json','NATIVE-REVIEW-RECEIPT.json','review.events.jsonl','review.prompt.exact','review-catalog.json','review.stderr','native-evidence.json'):
                    source=origin.parent/'verified-native/native-evidence.json' if name=='native-evidence.json' else (origin/name if (origin/name).is_file() else origin/'independent'/name)
                    shutil.copy2(source,prior/name)
                component=root/'collector/tools/rust-ts-r0/qualification/windows-lifecycle/prior_review.py';component.parent.mkdir(parents=True);shutil.copy2(Path(__file__).with_name('prior_review.py'),component)
                pin=hashlib.sha256((prior/'REVIEW.json').read_bytes()).hexdigest()
                names={'report':'REVIEW.json','receipt':'NATIVE-REVIEW-RECEIPT.json','events':'review.events.jsonl','prompt':'review.prompt.exact','catalog':'review-catalog.json','evidence':'native-evidence.json'}
                if tamper!='stable':
                    target=prior/names[tamper];target.write_bytes(target.read_bytes()+b' ')
                marker=root/'BUILD';script=root/'verify.ps1';script.write_text(verify['run']+"\nSet-Content -LiteralPath $env:CASE_BUILD -Value 'BUILD'\n")
                python=Path(sys.executable).resolve()
                env=dict(os.environ,WINDOWS_APPROVED_PRIOR_REVIEW_SHA256=pin,WINDOWS_OBSERVED_PYTHON_PATH=str(python),WINDOWS_OBSERVED_PYTHON_SHA256=hashlib.sha256(python.read_bytes()).hexdigest(),WINDOWS_TRUSTED_RUNNER_TEMP=str(root),CASE_BUILD=str(marker))
                child=subprocess.run([executable,'-NoProfile','-NonInteractive','-File',str(script)],cwd=root,env=env,capture_output=True,check=False)
                self.assertEqual(child.returncode==0,tamper=='stable',child.stderr)
                self.assertEqual(marker.exists(),tamper=='stable',child.stderr)
                if tamper!='stable':self.assertIn(b'prior review',child.stderr)

    def test_trusted_git_identity_reads_ignore_inherited_repository_overrides(self):
        import subprocess
        executable=shutil.which('pwsh');git=shutil.which('git')
        if not executable or not git:self.skipTest('PowerShell/Git unavailable')
        git=str(Path(git).resolve());text=self.workflow()
        clean={key:value for key,value in os.environ.items() if not key.startswith('GIT_')}
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary).resolve();actual=root/'actual';shadow=root/'shadow'
            for path in (actual,shadow):
                path.mkdir();subprocess.run([git,'init',str(path)],env=clean,capture_output=True,check=True)
                (path/'tracked').write_text(path.name)
                subprocess.run([git,'-C',str(path),'add','tracked'],env=clean,capture_output=True,check=True)
                subprocess.run([git,'-C',str(path),'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','fixture'],env=clean,capture_output=True,check=True)
            expected=subprocess.check_output([git,'-C',str(actual),'rev-parse','HEAD'],env=clean).strip()
            self.assertNotEqual(expected,subprocess.check_output([git,'-C',str(shadow),'rev-parse','HEAD'],env=clean).strip())
            for label in ('Verify checked out identities before build','Collect once after authority and provenance checks'):
                with self.subTest(step=label):
                    start=text.index('      - name: '+label);block=text[start:];lines=block.splitlines();body=lines.index('        run: |')+1
                    script='\n'.join(line[10:] for line in lines[body:]);helper=script[:script.index('$git = $env:')]
                    path=root/'read.ps1';path.write_text(helper+"$value=Invoke-ObservedGit $env:CASE_GIT $env:CASE_SHA $env:CASE_ROOT @('rev-parse','HEAD')\nWrite-Output $value\n")
                    env=dict(clean,CASE_GIT=git,CASE_SHA=hashlib.sha256(Path(git).read_bytes()).hexdigest(),CASE_ROOT=str(actual),GIT_DIR=str(shadow/'.git'),GIT_WORK_TREE=str(shadow),GIT_INDEX_FILE=str(shadow/'.git/index'))
                    result=subprocess.run([executable,'-NoProfile','-NonInteractive','-File',str(path)],cwd=root,env=env,capture_output=True,check=False)
                    self.assertEqual(result.returncode,0,result.stderr)
                    self.assertEqual(result.stdout.strip(),expected,'trusted Git read inherited the shadow repository')

    def test_controller_launch_disables_global_site_initialization(self):
        import re,subprocess,venv
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary).resolve();environment=root/'venv'
            venv.EnvBuilder(with_pip=False,symlinks=True).create(environment)
            packages=environment/'lib'/('python'+str(sys.version_info.major)+'.'+str(sys.version_info.minor))/'site-packages'
            self.assertTrue(packages.is_dir())
            marker=root/'global-pth-executed'
            (packages/'fixture.pth').write_text('import pathlib; pathlib.Path('+repr(str(marker))+').write_text("executed")\n')
            text=self.workflow();prefix=text[text.index('$arguments = @('):].split('"-c"',1)[0]
            flags=[value.replace('$cache',str(root/'cache')) for value in re.findall(r'"([^"]+)"',prefix)]
            result=subprocess.run([str(environment/'bin/python'),*flags,'-c','print("SAFE")'],capture_output=True,check=False)
            self.assertEqual(result.returncode,0,result.stderr);self.assertEqual(result.stdout.strip(),b'SAFE')
            self.assertFalse(marker.exists(),'global .pth executed before the pinned source loader')

    def test_real_git_hidden_index_flags_refuse_identity(self):
        import subprocess
        executable=shutil.which('pwsh');git=shutil.which('git')
        if not executable or not git:self.skipTest('PowerShell/Git unavailable')
        git=Path(git).resolve();text=self.workflow()
        clean={key:value for key,value in os.environ.items() if not key.startswith('GIT_')}
        for flag in ('--assume-unchanged','--skip-worktree'):
            with tempfile.TemporaryDirectory() as temporary:
                root=Path(temporary).resolve();repository=root/'repository';repository.mkdir()
                def call(*args,repository=repository):return subprocess.run([str(git),'-C',str(repository),*args],env=clean,capture_output=True,check=True).stdout
                call('init');tracked=repository/'controller.py';tracked.write_text('original source')
                call('add','controller.py');call('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','fixture')
                bound=route.BoundGit(git,hashlib.sha256(git.read_bytes()).hexdigest())
                self.assertEqual(bound.read(repository,'status','--porcelain'),'')
                call('update-index',flag,'controller.py');tracked.write_text('hidden changed source')
                self.assertEqual(call('status','--porcelain'),b'','fixture did not hide its mutation')
                with self.subTest(flag=flag,boundary='Python'):
                    with self.assertRaisesRegex(ValueError,'hidden Git index entries'):
                        bound.read(repository,'status','--porcelain')
                for step in ('Verify checked out identities before build','Collect once after authority and provenance checks'):
                    with self.subTest(flag=flag,boundary=step):
                        start=text.index('      - name: '+step);lines=text[start:].splitlines();body=lines.index('        run: |')+1
                        script='\n'.join(line[10:] for line in lines[body:]);helper=script[:script.index('$git = $env:')]
                        marker=root/'BUILD';path=root/'hidden.ps1';path.write_text(helper+"Invoke-ObservedGit $env:CASE_GIT $env:CASE_SHA $env:CASE_ROOT @('status','--porcelain')\nSet-Content -LiteralPath $env:CASE_BUILD -Value 'BUILD'\n")
                        env=dict(clean,CASE_GIT=str(git),CASE_SHA=hashlib.sha256(git.read_bytes()).hexdigest(),CASE_ROOT=str(repository),CASE_BUILD=str(marker))
                        result=subprocess.run([executable,'-NoProfile','-NonInteractive','-File',str(path)],env=env,capture_output=True,check=False)
                        self.assertNotEqual(result.returncode,0,'hidden source mutation reached BUILD')
                        self.assertIn(b'hidden Git index entries',result.stderr);self.assertFalse(marker.exists())

    def test_physical_source_bytes_refuse_worktree_and_statcache_redirects(self):
        import contextlib,io,subprocess,time
        executable=shutil.which('pwsh');git=shutil.which('git')
        if not executable or not git:self.skipTest('PowerShell/Git unavailable')
        git=Path(git).resolve();text=self.workflow()
        clean={key:value for key,value in os.environ.items() if not key.startswith('GIT_')}
        for case in ('core-worktree','statcache'):
            with tempfile.TemporaryDirectory() as temporary:
                root=Path(temporary).resolve();repository=root/'repository';repository.mkdir()
                def call(*args,repository=repository):return subprocess.run([str(git),'-C',str(repository),*args],env=clean,capture_output=True,check=True).stdout
                call('init');tracked=repository/'controller.py';tracked.write_bytes(b'ORIGINAL')
                old=time.time_ns()-5_000_000_000;os.utime(tracked,ns=(old,old))
                call('add','controller.py');call('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','fixture')
                head=call('rev-parse','HEAD').decode().strip();tree=call('rev-parse','HEAD^{tree}').decode().strip()
                review=root/'review.json';review.write_bytes(b'test-only prior-admission prerequisite stub')
                for filename in ('preflight.json','public-plan.json','source-snapshot.json'):(root/filename).write_bytes(b'test-only locked-input prerequisite stub')
                argv=['collect_windows.py']
                for name,value in [('product-root',repository),('collector-root',repository),('inputs',root),('prior-review',review),('review-bundle',root),('executor',git),('git',git),('helper',git),('output',root/'output')]:argv+=['--'+name,str(value)]
                def invoke(argv=argv,head=head,tree=tree):
                    with (patch.object(sys,'argv',argv),patch.object(route,'SOURCE_HEAD',head),patch.object(route,'SOURCE_TREE',tree),
                          patch.object(route,'authority_matches',return_value=True),patch.object(route,'verify_bundle',return_value={'test_only_prerequisite_stub':True}),patch.object(route,'load_locked',return_value=[])):
                        route.main()
                with contextlib.redirect_stdout(io.StringIO()):invoke()
                if case=='core-worktree':
                    shadow=root/'shadow';shadow.mkdir();(shadow/'controller.py').write_bytes(b'ORIGINAL')
                    call('config','core.worktree',str(shadow))
                else:
                    call('config','core.trustctime','false');call('config','core.checkStat','minimal')
                    self.assertLess(tracked.stat().st_mtime_ns,(repository/'.git/index').stat().st_mtime_ns-1_000_000_000)
                timestamp=tracked.stat();tracked.write_bytes(b'MODIFIED');os.utime(tracked,ns=(timestamp.st_atime_ns,timestamp.st_mtime_ns))
                self.assertEqual(call('status','--porcelain','--untracked-files=all'),b'','fixture mutation was not hidden')
                self.assertTrue(call('ls-files','-v','-z').startswith(b'H '))
                with self.subTest(case=case,boundary='Python main'),contextlib.redirect_stdout(io.StringIO()) as captured:
                    with self.assertRaisesRegex(ValueError,'physical tracked source bytes differ'):invoke()
                    self.assertEqual(captured.getvalue(),'');self.assertFalse((root/'output').exists())
                for step in ('Verify checked out identities before build','Collect once after authority and provenance checks'):
                    with self.subTest(case=case,boundary=step):
                        start=text.index('      - name: '+step);lines=text[start:].splitlines();body=lines.index('        run: |')+1
                        script='\n'.join(line[10:] for line in lines[body:]);helper=script[:script.index('$git = $env:')]
                        marker=root/'BUILD';path=root/'physical.ps1';path.write_text(helper+"Assert-TrackedSource $env:CASE_GIT $env:CASE_SHA $env:CASE_ROOT\nSet-Content -LiteralPath $env:CASE_BUILD -Value 'BUILD'\n")
                        env=dict(clean,CASE_GIT=str(git),CASE_SHA=hashlib.sha256(git.read_bytes()).hexdigest(),CASE_ROOT=str(repository),CASE_BUILD=str(marker))
                        result=subprocess.run([executable,'-NoProfile','-NonInteractive','-File',str(path)],env=env,capture_output=True,check=False)
                        self.assertNotEqual(result.returncode,0,'hidden physical source reached BUILD')
                        self.assertIn(b'physical tracked source bytes differ',result.stderr);self.assertFalse(marker.exists())

    def test_collection_uses_a_fresh_job_and_exact_same_run_binary_transport(self):
        import subprocess
        path=Path(__file__).resolve().parents[4]/'.github/workflows/windows-lifecycle-collector.yml'
        parsed=subprocess.run(['ruby','-e',"require 'yaml';require 'json';puts JSON.generate(YAML.load_file(ARGV[0]))",str(path)],capture_output=True,check=False)
        self.assertEqual(parsed.returncode,0,parsed.stderr);jobs=json.loads(parsed.stdout)['jobs']
        self.assertEqual(set(jobs),{'build','collect'});build=jobs['build'];collect=jobs['collect']
        self.assertEqual(collect['needs'],'build')
        for job in (build,collect):
            self.assertEqual(job['runs-on'],'windows-latest')
            for name in ('WORKFLOW_SHA','COLLECTOR_SHA','PRIOR_REVIEW_SHA256'):
                variable='WINDOWS_APPROVED_'+name;self.assertEqual(job['env'][variable],'${{ vars.'+variable+' }}')
        self.assertTrue(any('cargo build' in step.get('run','') for step in build['steps']))
        for step in collect['steps']:self.assertNotRegex(step.get('run',''),r'(?im)^\s*(?:cargo|rustup)\b')
        self.assertNotIn('${{ needs.',self.workflow(),'build outputs became receiver authority')
        upload=next(step for step in build['steps'] if step.get('uses','').startswith('actions/upload-artifact@'))
        self.assertEqual(upload['uses'],'actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9')
        self.assertEqual(upload['with']['name'],'windows-lifecycle-admitted-binaries')
        self.assertEqual(upload['with']['path'].splitlines(),['collector/tools/gates/target/release/examples/windows_lifecycle_collector.exe','collector/tools/gates/target/release/semctx-gates.exe','collector/tools/gates/target/release/BUILD-PROVENANCE.json'])
        receive=next(step for step in collect['steps'] if step.get('with',{}).get('name')==upload['with']['name'])
        self.assertEqual(receive['uses'],'actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333')
        self.assertEqual(receive['with'],{'name':'windows-lifecycle-admitted-binaries','path':'native-binaries'})
        verify=next(step for step in collect['steps'] if step.get('name')=='Validate the exact binary transport tree')
        launch=next(step for step in collect['steps'] if step.get('name')=='Collect once after authority and provenance checks')
        self.assertLess(collect['steps'].index(receive),collect['steps'].index(verify));self.assertLess(collect['steps'].index(verify),collect['steps'].index(launch))
        identity='Verify checked out identities before build'
        self.assertEqual(next(s['run'] for s in build['steps'] if s.get('name')==identity),next(s['run'] for s in collect['steps'] if s.get('name')==identity))
        executable=shutil.which('pwsh')
        if not executable:self.skipTest('PowerShell unavailable')
        for case in ('exact','foreign','linked'):
            with self.subTest(artifact=case),tempfile.TemporaryDirectory() as temporary:
                root=Path(temporary).resolve();files=root/'native-binaries';(files/'examples').mkdir(parents=True)
                (files/'examples/windows_lifecycle_collector.exe').write_bytes(b'harmless fixture');(files/'semctx-gates.exe').write_bytes(b'harmless fixture');(files/'BUILD-PROVENANCE.json').write_bytes(b'{}')
                if case=='foreign':(files/'extra.dll').write_bytes(b'foreign fixture')
                if case=='linked':
                    target=root/'outside';target.write_bytes(b'harmless fixture');(files/'semctx-gates.exe').unlink();(files/'semctx-gates.exe').symlink_to(target)
                script=root/'artifact.ps1';script.write_text(verify['run'].split('$record = ConvertFrom-Json',1)[0])
                observed=subprocess.run([executable,'-NoProfile','-NonInteractive','-File',str(script)],cwd=root,capture_output=True,check=False)
                self.assertEqual(observed.returncode==0,case=='exact',observed.stderr)
                if case!='exact':self.assertIn(b'binary transport',observed.stderr)

    def test_binary_build_provenance_binds_retry_source_and_payload(self):
        import subprocess
        path=Path(__file__).resolve().parents[4]/'.github/workflows/windows-lifecycle-collector.yml'
        parsed=subprocess.run(['ruby','-e',"require 'yaml';require 'json';puts JSON.generate(YAML.load_file(ARGV[0]))",str(path)],capture_output=True,check=False)
        self.assertEqual(parsed.returncode,0,parsed.stderr);jobs=json.loads(parsed.stdout)['jobs']
        producers=[step for step in jobs['build']['steps'] if step.get('name')=='Bind binaries to completed source observations']
        self.assertEqual(len(producers),1,'binary artifact has no completed-source/run-attempt binding')
        producer=producers[0];verify=next(step for step in jobs['collect']['steps'] if step.get('name')=='Validate the exact binary transport tree')
        identity=next(step for step in jobs['build']['steps'] if step.get('name')=='Verify checked out identities before build')
        self.assertEqual(identity.get('id'),'build_identity')
        self.assertEqual(producer['env']['BUILD_SOURCE_COMMIT'],'${{ steps.build_identity.outputs.collector_commit }}')
        self.assertEqual(producer['env']['BUILD_SOURCE_TREE'],'${{ steps.build_identity.outputs.collector_tree }}')
        for name,expression in [('BUILD_WORKFLOW_SHA','${{ github.workflow_sha }}'),('BUILD_RUN_ID','${{ github.run_id }}'),('BUILD_RUN_ATTEMPT','${{ github.run_attempt }}')]:
            self.assertEqual(producer['env'][name],expression);self.assertEqual(verify['env'][name],expression)
        self.assertEqual(verify['env']['BUILD_SOURCE_COMMIT'],'${{ vars.WINDOWS_APPROVED_COLLECTOR_SHA }}')
        executable=shutil.which('pwsh')
        if not executable:self.skipTest('PowerShell unavailable')
        for case in ('exact','retry','source','tree','workflow','run','payload'):
            with self.subTest(binding=case),tempfile.TemporaryDirectory() as temporary:
                root=Path(temporary).resolve();release=root/'collector/tools/gates/target/release';(release/'examples').mkdir(parents=True)
                (release/'examples/windows_lifecycle_collector.exe').write_bytes(b'collector fixture');(release/'semctx-gates.exe').write_bytes(b'helper fixture')
                environment=dict(os.environ,BUILD_SOURCE_COMMIT='b'*40,BUILD_SOURCE_TREE='c'*40,BUILD_WORKFLOW_SHA='a'*40,BUILD_RUN_ID='123',BUILD_RUN_ATTEMPT='1',GITHUB_OUTPUT=str(root/'step-output'))
                script=root/'produce.ps1';script.write_text(producer['run'])
                result=subprocess.run([executable,'-NoProfile','-NonInteractive','-File',str(script)],cwd=root,env=environment,capture_output=True,check=False)
                self.assertEqual(result.returncode,0,result.stderr)
                shutil.copytree(release,root/'native-binaries')
                if case=='retry':environment['BUILD_RUN_ATTEMPT']='2'
                if case=='source':environment['BUILD_SOURCE_COMMIT']='d'*40
                if case=='tree':environment['BUILD_SOURCE_TREE']='f'*40
                if case=='workflow':environment['BUILD_WORKFLOW_SHA']='e'*40
                if case=='run':environment['BUILD_RUN_ID']='124'
                if case=='payload':(root/'native-binaries/semctx-gates.exe').write_bytes(b'substituted fixture')
                script=root/'verify.ps1';script.write_text(verify['run']+"\nWrite-Output 'EXECUTE_SENTINEL'\n")
                result=subprocess.run([executable,'-NoProfile','-NonInteractive','-File',str(script)],cwd=root,env=environment,capture_output=True,check=False)
                self.assertEqual(result.returncode==0,case=='exact',result.stderr)
                self.assertEqual(b'EXECUTE_SENTINEL' in result.stdout,case=='exact',result.stderr)
                if case!='exact':self.assertIn(b'binary build provenance',result.stderr)

    def test_manifest_json_scalar_types_are_not_coerced(self):
        import subprocess
        path=Path(__file__).resolve().parents[4]/'.github/workflows/windows-lifecycle-collector.yml'
        parsed=subprocess.run(['ruby','-e',"require 'yaml';require 'json';puts JSON.generate(YAML.load_file(ARGV[0]))",str(path)],capture_output=True,check=False)
        self.assertEqual(parsed.returncode,0,parsed.stderr);jobs=json.loads(parsed.stdout)['jobs']
        producer=next(step for step in jobs['build']['steps'] if step.get('name')=='Bind binaries to completed source observations')
        verify=next(step for step in jobs['collect']['steps'] if step.get('name')=='Validate the exact binary transport tree')
        executable=shutil.which('pwsh')
        if not executable:self.skipTest('PowerShell unavailable')
        cases=[('schema',True),('schema','1'),('schema',1.0),('bytes','1'),('bytes',1.0),('bytes',True),('path',True),('sha256',True)]
        for field,value in cases:
            with self.subTest(field=field,value=value),tempfile.TemporaryDirectory() as temporary:
                root=Path(temporary).resolve();release=root/'collector/tools/gates/target/release';(release/'examples').mkdir(parents=True)
                for file in ['examples/windows_lifecycle_collector.exe','semctx-gates.exe']:(release/file).write_bytes(b'x')
                env=dict(os.environ,BUILD_SOURCE_COMMIT='b'*40,BUILD_SOURCE_TREE='c'*40,BUILD_WORKFLOW_SHA='a'*40,BUILD_RUN_ID='123',BUILD_RUN_ATTEMPT='1',GITHUB_OUTPUT=str(root/'step-output'))
                script=root/'produce.ps1';script.write_text(producer['run'])
                result=subprocess.run([executable,'-NoProfile','-NonInteractive','-File',str(script)],cwd=root,env=env,capture_output=True,check=False)
                self.assertEqual(result.returncode,0,result.stderr);shutil.copytree(release,root/'native-binaries')
                manifest=root/'native-binaries/BUILD-PROVENANCE.json';record=json.loads(manifest.read_bytes())
                if field=='schema':record[field]=value
                else:record['files'][0][field]=value
                manifest.write_text(json.dumps(record))
                script=root/'verify.ps1';script.write_text(verify['run']+"\nWrite-Output 'EXECUTE_SENTINEL'\n")
                result=subprocess.run([executable,'-NoProfile','-NonInteractive','-File',str(script)],cwd=root,env=env,capture_output=True,check=False)
                self.assertNotEqual(result.returncode,0,'coerced manifest scalar reached execution')
                self.assertIn(b'binary build provenance',result.stderr);self.assertNotIn(b'EXECUTE_SENTINEL',result.stdout)

    def test_manifest_original_json_is_one_object_with_unique_keys(self):
        import subprocess
        path=Path(__file__).resolve().parents[4]/'.github/workflows/windows-lifecycle-collector.yml'
        parsed=subprocess.run(['ruby','-e',"require 'yaml';require 'json';puts JSON.generate(YAML.load_file(ARGV[0]))",str(path)],capture_output=True,check=False)
        self.assertEqual(parsed.returncode,0,parsed.stderr)
        jobs=json.loads(parsed.stdout)['jobs']
        producer=next(step for step in jobs['build']['steps'] if step.get('name')=='Bind binaries to completed source observations')
        verify=next(step for step in jobs['collect']['steps'] if step.get('name')=='Validate the exact binary transport tree')
        executable=shutil.which('pwsh')
        if not executable:self.skipTest('PowerShell unavailable')
        for case in ('root-array','duplicate-root','duplicate-nested'):
            with self.subTest(case=case),tempfile.TemporaryDirectory() as temporary:
                root=Path(temporary).resolve();release=root/'collector/tools/gates/target/release';(release/'examples').mkdir(parents=True)
                for file in ['examples/windows_lifecycle_collector.exe','semctx-gates.exe']:(release/file).write_bytes(b'x')
                env=dict(os.environ,BUILD_SOURCE_COMMIT='b'*40,BUILD_SOURCE_TREE='c'*40,BUILD_WORKFLOW_SHA='a'*40,BUILD_RUN_ID='123',BUILD_RUN_ATTEMPT='1',GITHUB_OUTPUT=str(root/'step-output'))
                script=root/'produce.ps1';script.write_text(producer['run'])
                result=subprocess.run([executable,'-NoProfile','-NonInteractive','-File',str(script)],cwd=root,env=env,capture_output=True,check=False)
                self.assertEqual(result.returncode,0,result.stderr);shutil.copytree(release,root/'native-binaries')
                manifest=root/'native-binaries/BUILD-PROVENANCE.json'
                original=json.dumps(json.loads(manifest.read_bytes()),separators=(',',':'))
                if case=='root-array':altered='['+original+']'
                elif case=='duplicate-root':altered='{"schema":0,'+original[1:]
                else:
                    self.assertIn('"bytes":1',original)
                    altered=original.replace('"bytes":1','"bytes":0,"bytes":1',1)
                manifest.write_bytes(altered.encode())
                script=root/'verify.ps1';script.write_text(verify['run']+"\nWrite-Output 'EXECUTE_SENTINEL'\n")
                result=subprocess.run([executable,'-NoProfile','-NonInteractive','-File',str(script)],cwd=root,env=env,capture_output=True,check=False)
                self.assertNotEqual(result.returncode,0,'malformed original manifest reached execution')
                self.assertIn(b'binary build provenance',result.stderr)
                self.assertNotIn(b'EXECUTE_SENTINEL',result.stdout)

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
        block=text[identity:text.index('      - uses:',identity)]
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
        lines=block.splitlines();body=lines.index('        run: |')+1
        script='\n'.join(line[10:] for line in lines[body:])+'\n'
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
        lines=block.splitlines();body=lines.index('        run: |')+1
        script='\n'.join(line[10:] for line in lines[body:])+'\n'
        for layout in ('mingw64','ucrt64'):
            with self.subTest(layout=layout),tempfile.TemporaryDirectory() as temporary:
                root=Path(temporary).resolve();shim=root/'cmd/git.exe';payload=root/layout/'bin/git.exe'
                shim.parent.mkdir();payload.parent.mkdir(parents=True)
                shim.write_text('#!/bin/sh\nexit 99\n');shim.chmod(0o755);payload.write_bytes(b'payload bytes')
                path=root/'resolver.ps1';path.write_text(script);observed=root/'environment'
                env=dict(os.environ,PATH=str(shim.parent)+os.pathsep+os.environ['PATH'],GITHUB_OUTPUT=str(observed))
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
        lines=block.splitlines();body=lines.index('        run: |')+1
        script='\n'.join(line[10:] for line in lines[body:])+'\n'
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
        for step,message in (('Verify checked out identities before build',b'prebuild Git payload changed'),('Collect once after authority and provenance checks',b'postbuild runtime payload changed')):
            text=self.workflow();start=text.index('      - name: '+step)
            block=text[start:]
            lines=block.splitlines();body=lines.index('        run: |')+1
            script='\n'.join(line[10:] for line in lines[body:])+'\n'
            helper=script[:script.index('$git = $env:')]
            for mode in ('stable','before','during'):
                with self.subTest(mode=mode),tempfile.TemporaryDirectory() as temporary:
                    root=Path(temporary).resolve();payload=root/'ucrt64/bin/git.exe';payload.parent.mkdir(parents=True)
                    payload.write_text('#!/bin/sh\ncase "$*" in *"ls-files -v -z"*) exit 0;; esac\nrun() {\n printf "read-result\\n"\n : > "$CASE_CALLED"\n if [ "$CASE_CHANGE" = "1" ]; then /bin/cp "$CASE_REPLACEMENT" "$0"; fi\n}\nrun\n')
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
                        self.assertNotEqual(result.returncode,0);self.assertIn(message,result.stderr)
                        self.assertNotIn(b'read-result',result.stdout);self.assertFalse(marker.exists())
                        self.assertEqual(called.exists(),mode=='during')


if __name__=='__main__':
    unittest.main()
