"""Verify pre-query frozen source/case bytes without any host report or native query."""
import argparse,json
from pathlib import Path
import assess_final as a

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--repo',type=Path,required=True)
    mode=p.add_mutually_exclusive_group(required=True)
    mode.add_argument('--source-head')
    mode.add_argument('--working-tree-only',action='store_true',help='Content-only preparation check; cannot replace committed candidate preflight')
    p.add_argument('--protocol-sha256',required=True)
    p.add_argument('--scope-map',type=Path,default=Path(__file__).resolve().parent/'scope-map.json.gz')
    args=p.parse_args();a.REPO=args.repo.resolve();a.SCOPE_MAP=args.scope_map.resolve()
    if args.source_head:assert len(args.source_head)==40 and all(c in '0123456789abcdef' for c in args.source_head),'exact Git SHA required'
    assert a.pin(a.SCOPE_MAP)['sha256']==args.protocol_sha256,'pre-query protocol pin differs'
    protocol=a.scope_protocol()
    for path,pin in protocol['verifier_git_sources'].items():
        if args.working_tree_only:assert a.pin(a.REPO/path)['sha256']==pin['sha256'],'working source differs: '+path
        else:a.frozen_git_source(args.source_head,path)
    print(json.dumps({'kind':'UNCOMMITTED_SOURCE_CONTENT_MATCH_ONLY' if args.working_tree_only else 'SOURCE_PROTOCOL_CONTENT_MATCH_ONLY','source_head':args.source_head,
      'evaluation_protocol_ref':a.pin(a.SCOPE_MAP),'verifier_sources':protocol['verifier_git_sources'],
      'frozen_case_files':len(protocol['frozen_case_files']),'native_queries':0,'qualification_credit':0}))
if __name__=='__main__':main()
