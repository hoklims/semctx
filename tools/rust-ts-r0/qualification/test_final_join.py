"""DEV metadata consistency fixture only; no native artifact or qualification claim."""
import hashlib,json,sys,tempfile,unittest
from pathlib import Path
PACKAGE=Path(__file__).resolve().parent/'property_assessor';sys.path.insert(0,str(PACKAGE))
import final_join

class FinalJoinMetadataTests(unittest.TestCase):
    def test_boolean_false_exit_is_not_integer_zero(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);head='1'*40
            def pin(path):
                raw=path.read_bytes();return {'path':str(path),'sha256':hashlib.sha256(raw).hexdigest(),'bytes':len(raw)}
            def save(name,value):
                path=root/name;path.write_text(json.dumps(value),encoding='utf-8');return pin(path)
            artifacts={}
            for name in ('artifact','helper','sdk','qualification_observer'):
                path=root/(name+'.DEV');path.write_bytes(('DEV metadata bytes only: '+name).encode());artifacts[name]=pin(path)
            recipes=save('recipes.json',{'recipes':[]})
            fixture={'source_head':head,'platform':'macos','optimized_frozen':True,'recipes_sha256':recipes['sha256'],**{name+'_sha256':value['sha256'] for name,value in artifacts.items()}}
            fixture_ref=save('fixture.json',fixture);empty=save('empty.json',{});source=save('source.json',{'head':head,'status':'','files':{}})
            report=save('report.json',{'artifact_sha256':fixture['artifact_sha256'],'helper_sha256':fixture['helper_sha256'],'units':[{'DEV':True} for _ in range(354)],'supports':[{'DEV':True} for _ in range(51)]})
            receipt={'argv':['DEV_NO_COMMAND_EXECUTED'],'exitCode':0,'timedOut':False};receipt_ref=save('build.receipt.json',receipt)
            host={'original':{'report':report,'freeze':fixture_ref,'recipes':recipes},'supplement':{'report':empty,'fixture':fixture_ref,'registry':empty,'addenda':empty,'plan':empty},'source':{'before':source,'after':source},'build_receipts':[receipt_ref],'artifact_files':artifacts}
            _,identity=final_join.validate_host_epoch(host,head,'macos')
            self.assertEqual(identity['source_head'],head) # The complete healthy fixture must be accepted first.
            receipt['exitCode']=False;host['build_receipts'][0]=save('build.receipt.json',receipt)
            with self.assertRaisesRegex(ValueError,'required native build command failed/missing exit'):
                final_join.validate_host_epoch(host,head,'macos')

if __name__=='__main__':unittest.main(verbosity=2)
