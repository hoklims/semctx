"""Pure evaluator controls/inventory only; does not qualify a native candidate."""
import gzip,hashlib,importlib,json,sys,unittest
from pathlib import Path

PACKAGE=Path(__file__).resolve().parent/'property_assessor'

class PropertyAssessorTests(unittest.TestCase):
    def test_existing_pure_negative_controls(self):
        sys.path.insert(0,str(PACKAGE))
        try:
            controls=importlib.import_module('poison_controls').run_controls()
        finally:sys.path.remove(str(PACKAGE))
        self.assertEqual(controls['controls'],23)
        self.assertEqual(len(set(controls['passed'])),23)
        self.assertEqual(controls['native_queries'],0)
        self.assertEqual(controls['qualification_credit'],0)

    def test_frozen_inventory_and_deduplicated_definitions(self):
        protocol=json.loads(gzip.decompress((PACKAGE/'scope-map.json.gz').read_bytes()))
        self.assertEqual(protocol['counts'],{'properties':395,'supports':51,'rows':446})
        rows=protocol['baseline_rows'];self.assertEqual(len(rows),446)
        self.assertEqual(sum(r['kind']=='property' for r in rows),395)
        self.assertEqual(sum(r['kind']=='support' for r in rows),51)
        contracts=protocol['recipe_contracts'];self.assertEqual(len(contracts['original']),354)
        self.assertEqual(len(contracts['support']),34);self.assertEqual(len(contracts['source']),92)
        for digest,definition in protocol['check_definitions'].items():
            actual=hashlib.sha256(json.dumps(definition,sort_keys=True,ensure_ascii=True,separators=(',',':')).encode()).hexdigest()
            self.assertEqual(actual,digest)
        for name in protocol['frozen_case_files']:
            self.assertFalse(Path(name).is_absolute());self.assertNotIn('..',Path(name).parts)

    def test_published_package_hashes(self):
        manifest=json.loads((PACKAGE/'package-manifest.json').read_text(encoding='utf-8'))
        for name,pin in manifest['files'].items():
            self.assertEqual(Path(name).name,name)
            data=(PACKAGE/name).read_bytes()
            self.assertEqual(hashlib.sha256(data).hexdigest(),pin['sha256'])
            self.assertEqual(len(data),pin['bytes'])
        self.assertEqual(manifest['scope_map_sha256'],manifest['files']['scope-map.json.gz']['sha256'])

if __name__=='__main__':unittest.main()
