from _supplement_test_paths import FROZEN, RUNTIME
"""Pure transport/dedup/projection guard regressions. No native process is invoked."""
import copy
import json
from pathlib import Path
import tempfile
import unittest

import public_bridge as b

HERE=Path(__file__).resolve().parent
PUBLIC=RUNTIME


def capture(stdout='{}',stderr='',kind='success',code=0):
    value={'kind':kind,'exit_code':code,'stdout':stdout,'stderr':stderr}
    for name in ('stdout','stderr'):
        raw=value[name].encode()
        value[name+'_bytes']=len(raw)
        value[name+'_hash']=b.digest(raw)
    return value


class BridgeComparatorTests(unittest.TestCase):
    def test_positive_transport_guard_is_not_native_evidence(self):
        self.assertIsNone(b.complete_success_capture(capture()))

    def test_review2_coherent_diagnostic_refuses_positive_projection(self):
        api=b.runtime(PUBLIC)
        request={'operation':'relative_import_specifiers','source':"import './x';",'filename':'main.ts'}
        request_id='sha256:'+b.digest(api.native_canonical(request).encode())
        artifact='sha256:'+'a'*64
        native={'request_descriptor_id':request_id,'producer_artifact_id':artifact,'specifiers':['./x'],'executed':True,'unsupported':[]}
        outcome=capture(json.dumps(native),'unexpected diagnostic\n')
        prepared={'request':request,'surface':'primitive_cli','baseline_function':'extractRelativeImportSpecifiers','relocations':[],'path_normalization':{'roots':[]},'source_capture_stream_sha256':'sha256:'+'b'*64}
        document={'invocations':[{'key':'dev','prepared':prepared,'auxiliaries':[]}],
            'rows':[{'id':'dev','required_outputs':[1],'operations':[{'sequence':1,'parent':None,'required_consumer_output':True,'invocation_key':'dev'}]}]}
        evidence={'binding_verified':True,'outcome':outcome,'binding':{'request_descriptor_id':request_id,'producer_artifact_id':artifact,'capture_stream_sha256':prepared['source_capture_stream_sha256']},'native_invocation_id':'synthetic-comparator-control-only'}
        with tempfile.TemporaryDirectory(dir=HERE) as directory:
            root=Path(directory); (root/'dev').mkdir()
            expected=root/'expected-comparator-control.json'
            expected.write_text(json.dumps(['./x']))
            operation=document['rows'][0]['operations'][0]
            operation['prepared_projection']=prepared
            operation['expected_ref']={'path':str(expected),'json_pointer':'','sha256':b.digest(expected.read_bytes())}
            healthy=copy.deepcopy(evidence);healthy['outcome']=capture(json.dumps(native))
            (root/'dev/bridge-evidence.json').write_text(json.dumps(healthy))
            control=b.project(document,root,PUBLIC,None,None)
            self.assertEqual(control['rows'][0]['observations'][0]['status'],'MATCH','synthetic positive comparator carrier must be valid before poisoning')
            (root/'dev/bridge-evidence.json').write_text(json.dumps(evidence))
            report=b.project(document,root,PUBLIC,None,None)
        result=report['rows'][0]['observations'][0]
        self.assertEqual(result['status'],'UNKNOWN')
        self.assertEqual(result['gap'],'NATIVE_STDERR_NONEMPTY')
        self.assertNotEqual(report['rows'][0]['state'],'CONSUMER_OUTPUTS_MATCH')

    def test_review4_valid_digest_stdout_nonzero_never_admitted(self):
        text=json.dumps({'outlines':{'main.ts':{'outline':{'statements':[{'digest':'same-valid-digest'}]}}}})
        outcome=capture(text,kind='nonzero',code=1)
        with self.assertRaisesRegex(ValueError,'NATIVE_PROCESS_NOT_SUCCESS'):
            b.complete_success_capture(outcome)
        self.assertEqual(json.loads(outcome['stdout'])['outlines']['main.ts']['outline']['statements'][0]['digest'],'same-valid-digest')

    def test_truncated_or_rehashed_capture_cannot_pass(self):
        for field,value in [('stdout_bytes',999),('stdout_hash','0'*64),('stderr_hash','0'*64),('exit_code',False)]:
            poisoned=capture(); poisoned[field]=value
            with self.subTest(field=field),self.assertRaises(ValueError):
                b.complete_success_capture(poisoned)

    def test_dedup_keeps_temporal_parent_and_distinct_equal_byte_map_handles(self):
        prepared={'request':{'id':'first','files':{'main.ts':'export {};'}},'surface':'raw_cli','baseline_function':'inspectModuleConfiguration','physical_setup':[]}
        operation={'parent':7,'sequence':1,'request':{'arguments':[{'$mapIdentity':1,'$map':[['main.ts','export {};']]}]}}
        vector={'id':'dev','rawStream':{'sha256':'a'*64},'actualSemanticPrograms':[]}
        key=b.invocation_key(prepared,operation,vector)
        same=copy.deepcopy(prepared);same['request']['id']='different-transport-id'
        self.assertEqual(key,b.invocation_key(same,operation,vector))
        other=copy.deepcopy(operation);other['request']['arguments'][0]['$mapIdentity']=2
        self.assertNotEqual(key,b.invocation_key(prepared,other,vector))
        other=copy.deepcopy(operation);other['parent']=8
        self.assertNotEqual(key,b.invocation_key(prepared,other,vector))
        different=copy.deepcopy(prepared);different['request']['files']['main.ts']='export const changed=1;'
        self.assertNotEqual(key,b.invocation_key(different,operation,vector))

    def test_full619_preflight_has_real_invocation_refs_not677_fake_calls(self):
        with tempfile.TemporaryDirectory(dir=HERE) as directory:
            document=b.plan(FROZEN, RUNTIME, Path(directory)/'planned', '/sdk/lib', True)
        operations=[op for row in document['rows'] for op in row['operations']]
        self.assertEqual(len(operations),677)
        self.assertEqual(sum('invocation_key' in op for op in operations),619)
        self.assertEqual(len(document['invocations']),573)
        self.assertEqual(document['native_queries_performed'],0)
        self.assertEqual(sum(len(i['operation_refs']) for i in document['invocations']),619)


if __name__=='__main__':
    unittest.main()
