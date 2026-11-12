"""DEV ordinary-physical capsule fixtures from the existing Rust DTO contract."""
import copy,sys,unittest
from pathlib import Path
PACKAGE=Path(__file__).resolve().parent/'property_assessor';sys.path.insert(0,str(PACKAGE))
from physical_system_carrier import physical_system_contract,digest
from raw_compare import sha

class PhysicalSystemCarrierTests(unittest.TestCase):
    def fixture(self,paths=None,absent=False):
        root='/DEV/physical';paths=['src/main.ts'] if paths is None else paths;text='export const actualDisk="🌳";\n';files={root+'/'+p:text for p in paths} if not absent else {}
        request={'profile':'workspace','root':root,'case_sensitive':True,'files':files,'utf16_files':{},'raw_files':{},'sdk_directory':None,'queries':[{'operation':'read_file','path':root+'/'+p} for p in paths]}
        pins=[{'path':root+'/'+p,'relative':p,'present':not absent,'bytes':len(text.encode()) if not absent else None,'content_sha256':'sha256:'+sha(text.encode()) if not absent else None} for p in paths]
        before={'kind':'ordinary-physical-system-input-v1','context':'ordinary_workspace_only','request_descriptor_id':digest(request),'pins':pins,'retained_map_modified':False,'claim':'bounded sequential physical acquisition, not atomic OS sandboxing'}
        after={k:copy.deepcopy(v) for k,v in before.items() if k!='claim'};after['matched_before']=True
        results=[{'operation':'read_file','path':p['path'],'executed':True,'unsupported':[],'refusals':[],'found':p['present'],'value':text if p['present'] else None,'contentId':p['content_sha256'],'physicalPath':p['path'] if p['present'] else None} for p in pins]
        observed={'executed':True,'reasons':[],'unsupported':[],'workspaceIssues':[],'workspaceMappings':{},'status':'development_observation_not_qualification','request_descriptor_id':digest(request),'producer_artifact_id':'sha256:'+'a'*64,'results':results}
        return [request,observed,before,after,paths,root,True,'a'*64]
    def test_present_and_absent_acquisitions_preserve_raw_inputs(self):
        for args in (self.fixture(),self.fixture(absent=True)):
            original=copy.deepcopy(args);result=physical_system_contract(*args);self.assertEqual(args,original);self.assertFalse(result['retained_map_modified']);self.assertFalse(result['sdk_consumed_claimed'])
        args=self.fixture();self.assertNotEqual(args[0]['files'],{}) # Old empty-map-only reader rejects this actual supported input shape.
        self.assertEqual(physical_system_contract(*args)['actual_physical_source_count'],1)
    def test_coherently_rehashed_foreign_inputs_are_refused(self):
        changes=[
          ('retained-profile',lambda r,o,b,a:r.update(profile='retained')),
          ('sdk-joined',lambda r,o,b,a:r.update(sdk_directory='/sdk/lib')),
          ('retained-map-field',lambda r,o,b,a:r.update(retained=True)),
          ('raw-source',lambda r,o,b,a:r['raw_files'].update({'x':{'bytes':[1]}})),
          ('utf16-source',lambda r,o,b,a:r['utf16_files'].update({'x':[1]})),
          ('old-empty-map',lambda r,o,b,a:r.update(files={})),
          ('unpinned-extra-map',lambda r,o,b,a:r['files'].update({'/DEV/physical/extra.ts':'foreign'})),
          ('changed-query',lambda r,o,b,a:r['queries'][0].update(path='/DEV/foreign.ts')),
          ('foreign-context',lambda r,o,b,a:b.update(context='retained_map')),
          ('retained-mutated',lambda r,o,b,a:a.update(retained_map_modified=True)),
          ('after-not-matched',lambda r,o,b,a:a.update(matched_before=False)),
          ('after-unstable-pin',lambda r,o,b,a:a['pins'][0].update(content_sha256='sha256:'+'0'*64)),
          ('foreign-pin-path',lambda r,o,b,a:(b['pins'][0].update(path='/DEV/foreign.ts'),a['pins'][0].update(path='/DEV/foreign.ts'))),
          ('foreign-pin-bytes',lambda r,o,b,a:(b['pins'][0].update(bytes=1),a['pins'][0].update(bytes=1))),
          ('foreign-pin-hash',lambda r,o,b,a:(b['pins'][0].update(content_sha256='sha256:'+'0'*64),a['pins'][0].update(content_sha256='sha256:'+'0'*64))),
          ('pin-presence-integer',lambda r,o,b,a:(b['pins'][0].update(present=1),a['pins'][0].update(present=1))),
          ('foreign-artifact',lambda r,o,b,a:o.update(producer_artifact_id='sha256:'+'0'*64)),
          ('missing-read',lambda r,o,b,a:o.update(results=[])),
          ('foreign-result-path',lambda r,o,b,a:o['results'][0].update(path='/DEV/foreign.ts')),
          ('missing-found',lambda r,o,b,a:o['results'][0].update(found=False)),
          ('foreign-value',lambda r,o,b,a:o['results'][0].update(value='retained bytes cannot substitute actual disk')),
          ('foreign-content',lambda r,o,b,a:o['results'][0].update(contentId='sha256:'+'0'*64)),
          ('foreign-physical',lambda r,o,b,a:o['results'][0].update(physicalPath='/DEV/foreign.ts')),
          ('native-refusal',lambda r,o,b,a:o['results'][0].update(refusals=['REFUSED'])),
          ('native-unsupported',lambda r,o,b,a:o['results'][0].update(unsupported=['UNKNOWN']))]
        for name,change in changes:
            args=self.fixture();change(*args[:4]);rid=digest(args[0]);args[1]['request_descriptor_id']=args[2]['request_descriptor_id']=args[3]['request_descriptor_id']=rid
            with self.subTest(name=name),self.assertRaises(ValueError):physical_system_contract(*args)
        self.assertEqual(len(changes),25)
    def test_capsule_request_identity_is_not_repaired(self):
        for position in (1,2,3):
            args=self.fixture();args[position]['request_descriptor_id']='sha256:'+'0'*64
            with self.subTest(position=position),self.assertRaises(ValueError):physical_system_contract(*args)
    def test_top_component_refusals_are_not_hidden_by_coherent_result_rows(self):
        changes=[('unexecuted',{'executed':False}),('unsupported',{'unsupported':['CAPTURED_SYSTEM_REQUEST_INVALID']}),('reasons',{'reasons':['REFUSED']}),('issues',{'workspaceIssues':[{'path':'/DEV/physical','kind':'refusal','detail':'OUTSIDE'}]}),('status',{'status':'qualified'}),('mappings-shape',{'workspaceMappings':[]})]
        for name,values in changes:
            args=self.fixture();args[1].update(values)
            with self.subTest(name=name),self.assertRaises(ValueError):physical_system_contract(*args)
        args=self.fixture([]);args[1].update(executed=False,unsupported=['CAPTURED_SYSTEM_QUERY_COUNT_INVALID'])
        with self.assertRaises(ValueError):physical_system_contract(*args)
        self.assertEqual(len(changes),6)

if __name__=='__main__':unittest.main(verbosity=2)
