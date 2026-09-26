from __future__ import annotations

import importlib.util
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).parents[1] / "scripts" / "lsp_benchmark.py"
SPEC = importlib.util.spec_from_file_location("lsp_benchmark", SCRIPT)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"Cannot load {SCRIPT}")
lsp_benchmark = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(lsp_benchmark)


class LspBenchmarkTests(unittest.TestCase):
    def test_anchor_position_selects_the_requested_occurrence(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "sample.py"
            source.write_text("value = symbol\nresult = symbol()\n", encoding="utf-8")
            self.assertEqual(lsp_benchmark.anchor_position(source, "symbol", 2), (1, 9))

    def test_location_paths_accepts_locations_and_location_links(self) -> None:
        source = Path(r"C:\repo\source.py")
        target = Path(r"C:\repo\target.py")
        paths = lsp_benchmark.location_paths(
            [
                {"uri": source.as_uri(), "range": {}},
                {"targetUri": target.as_uri(), "targetRange": {}},
            ]
        )
        self.assertEqual(paths, {"c:/repo/source.py", "c:/repo/target.py"})

    def test_percentile_uses_nearest_rank(self) -> None:
        self.assertEqual(lsp_benchmark.percentile([1, 2, 3, 4, 5], 0.95), 5)


if __name__ == "__main__":
    unittest.main()
