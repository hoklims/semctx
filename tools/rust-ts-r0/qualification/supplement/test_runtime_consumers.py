from _supplement_test_paths import RUNTIME
"""Synthetic receipt controls; never candidate/native observations."""
import copy
import importlib.util
from pathlib import Path
import unittest

HERE=Path(__file__).resolve().parent

spec=importlib.util.spec_from_file_location('typed_public_runtime',RUNTIME/'public_runtime.py')
api=importlib.util.module_from_spec(spec)
spec.loader.exec_module(api)

def identity(value):
    return 'sha256:'+api.a.digest(api.native_canonical(value).encode('utf-8'))

def carried(prepared,raw,value,kind):
    context={'consumer_artifact_id':'sha256:'+'c'*64,'sdk_input_id':'sha256:'+'d'*64}
    receipt={'kind':kind,'baseline_function':prepared['baseline_function'],'prepared_id':identity(prepared),
        'request_descriptor_id':identity(prepared['request']),'native_fact_id':identity(raw),
        'producer_artifact_id':raw['producer_artifact_id'],**context,'value':value}
    receipt['receipt_id']=identity(receipt)
    return {**raw,'_rust_public_consumer_receipt':receipt,'_rust_public_consumer_context':context}

class TypedRuntimeConsumers(unittest.TestCase):
    def test_resolved_declaration_with_physical_runtime_without_rust_receipt_is_unknown(self):
        prepared={'baseline_function':'resolveTypeScriptModule','surface':'configured_resolution_cli',
            'request':{'files':{'/case/dep.js':'export {}'}},'relocations':[], 'path_normalization':{'roots':[]}}
        raw={'resolved_file_name':'/case/dep.d.ts','producer_artifact_id':'sha256:'+'a'*64}
        with self.assertRaisesRegex(api.Gap,'ACTUAL_RUST_PUBLIC_CONSUMER_RECEIPT_REQUIRED'):
            api.project_operation(prepared,raw)
        native=carried(prepared,raw,'/case/dep.js','configured-runtime-companion-v1')
        self.assertEqual(api.project_operation(prepared,native),'/case/dep.js')
        changed=copy.deepcopy(native);changed['_rust_public_consumer_receipt']['value']='/case/foreign.js'
        with self.assertRaisesRegex(api.Gap,'RECEIPT_HASH_DIFFERS'):api.project_operation(prepared,changed)
        changed=copy.deepcopy(native);changed['_rust_public_consumer_context']['consumer_artifact_id']='sha256:'+'e'*64
        with self.assertRaisesRegex(api.Gap,'CONTEXT_DIFFERS'):api.project_operation(prepared,changed)

    def test_partition_projection_does_not_rebuild_missing_or_wrong_native_chunks(self):
        prepared={'baseline_function':'__partitionTypeScriptRootsForTesting','surface':'parallel_cli','partition_count':2,
            'request':{'workers':2,'rootAbsPaths':['/case/a.ts','/case/b.ts']},'relocations':[], 'path_normalization':{'roots':[]}}
        raw={'executed':True,'unsupported':[],'jobs':[{'request':{'emitAbsPaths':['/case/b.ts']}},{'request':{'emitAbsPaths':['/case/a.ts']}}],
            'producer_artifact_id':'sha256:'+'a'*64}
        with self.assertRaises(api.Gap):api.project_operation(prepared,raw)
        native=carried(prepared,raw,[['/case/b.ts'],['/case/a.ts']],'partition-native-chunks-v1')
        self.assertEqual(api.project_operation(prepared,native),[['/case/b.ts'],['/case/a.ts']])
        changed=copy.deepcopy(prepared);changed['partition_count']=1
        with self.assertRaisesRegex(api.Gap,'CONTEXT_DIFFERS'):api.project_operation(changed,native)
        changed=copy.deepcopy(native);changed['jobs'].reverse()
        with self.assertRaisesRegex(api.Gap,'CONTEXT_DIFFERS'):api.project_operation(prepared,changed)

if __name__=='__main__':unittest.main()
