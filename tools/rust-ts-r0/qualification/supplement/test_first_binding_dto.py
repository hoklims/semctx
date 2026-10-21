import copy
import unittest
import public_runtime as r

class FirstBindingDtoTests(unittest.TestCase):
    def prepared(self):
        return {'baseline_function':'analyzeRepository','repository_root':'/case/fixture-000',
            'relocations':[('C:/original/semctx-run','/case/fixture-000')],
            'path_normalization':{'roots':[{'raw':'C:/original/semctx-run','token':'$FIXTURE/0'}]}}
    def test_repository_display_name_uses_only_bound_root_node(self):
        graph={'nodes':[{'id':'repo','kind':'repository','name':'fixture-000','metadata':{'root':'/case/fixture-000'}},
            {'id':'sym','kind':'function','name':'fixture-000'}],'edges':[{'from':'sym','to':'repo'}]}
        original=copy.deepcopy(graph)
        actual=r.public_repository_graph(graph,self.prepared())
        self.assertEqual(actual['nodes'][0]['name'],'$FIXTURE_0')
        self.assertEqual(actual['nodes'][1]['name'],'fixture-000')
        self.assertEqual(actual['edges'],graph['edges'])
        self.assertEqual(graph,original)
        for field,value in [('name','foreign'),('metadata',{'root':'/foreign'})]:
            bad=copy.deepcopy(graph);bad['nodes'][0][field]=value
            with self.assertRaises(r.Gap):r.public_repository_graph(bad,self.prepared())
    def test_public_symbol_dto_preserves_actual_names_and_raw_exact_ranges(self):
        facts={'symbols':[{'name':'actual','startLine':1,'startUtf16':2,'endUtf16':9,'declarations':[{'startUtf16':2}]}], 'calls':[]}
        original=copy.deepcopy(facts)
        actual=r.public_extraction(facts)
        self.assertEqual(actual,{'symbols':[{'name':'actual','startLine':1,'declarations':[{'startUtf16':2}]}],'calls':[]})
        self.assertEqual(facts,original)
        self.assertEqual(r.public_extraction({'modules':['actual']}),{'modules':['actual']})
