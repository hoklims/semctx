from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).parents[1] / "scripts" / "scip_json_probe.py"
SPEC = importlib.util.spec_from_file_location("scip_json_probe", SCRIPT)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"Cannot load {SCRIPT}")
scip_json_probe = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(scip_json_probe)


class ScipJsonProbeTests(unittest.TestCase):
    def test_definition_paths_require_definition_role_and_symbol_segment(self) -> None:
        index = {
            "documents": [
                {
                    "relative_path": "src\\engine.py",
                    "occurrences": [
                        {"symbol": "scip-python python project 1 module/verify().", "symbol_roles": 1},
                        {"symbol": "scip-python python verify 1 module/other().", "symbol_roles": 1},
                    ],
                },
                {
                    "relative_path": "tests/test_engine.py",
                    "occurrences": [{"symbol": "scip-python python project 1 module/verify().", "symbol_roles": 0}],
                },
            ]
        }
        self.assertEqual(scip_json_probe.definition_paths(index, "verify"), ["src/engine.py"])
        self.assertEqual(
            scip_json_probe.symbol_paths(index, "verify", definitions_only=False),
            ["src/engine.py", "tests/test_engine.py"],
        )

    def test_run_reports_coverage_and_precision(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            index = base / "index.json"
            index.write_text(
                json.dumps(
                    {
                        "documents": [
                            {
                                "relative_path": "src/main.py",
                                "occurrences": [
                                    {"symbol": "scip-python python project 1 module/target().", "symbol_roles": 1}
                                ],
                            }
                        ]
                    }
                ),
                encoding="utf-8",
            )
            manifest = base / "tasks.json"
            manifest.write_text(
                json.dumps(
                    {
                        "tasks": [
                            {"language": "python", "symbol": "target", "expected": "nested/src/main.py"}
                        ]
                    }
                ),
                encoding="utf-8",
            )
            result = scip_json_probe.run(
                index,
                manifest,
                project=None,
                language="python",
                repetitions=2,
                expected_documents=1,
            )
            self.assertEqual(result["precision"], 1.0)
            self.assertEqual(result["document_coverage"], 1.0)
            self.assertEqual(result["query_surface"], "scip-v0.9.0-print-json")


if __name__ == "__main__":
    unittest.main()
