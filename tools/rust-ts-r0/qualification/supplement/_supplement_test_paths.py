"""Repository-relative input/runtime lookup for pure supplement tests."""
import os
from pathlib import Path
import sys

HERE=Path(__file__).resolve().parent
configured=os.environ.get('SEMCTX_SUPPLEMENT_TEST_REPOSITORY')
candidates=[Path(configured)] if configured else [*HERE.parents,Path.cwd(),*Path.cwd().parents]
REPOSITORY=next((path.resolve() for path in candidates if (path/'docs/research/rust-ts-r0/cases/supplement-v2/manifest-sha256.json').is_file()),None)
if REPOSITORY is None:
    raise RuntimeError('Set SEMCTX_SUPPLEMENT_TEST_REPOSITORY or run the portable test runner with --repo')
FROZEN=REPOSITORY/'docs/research/rust-ts-r0/cases/supplement-v2'
RUNTIME=Path(os.environ.get('SEMCTX_SUPPLEMENT_TEST_RUNTIME',str(REPOSITORY/'tools/rust-ts-r0/qualification/supplement'))).resolve()
if not (RUNTIME/'public_runtime.py').is_file():
    raise RuntimeError('Vendored supplement runtime absent')
sys.path.insert(0,str(RUNTIME))
