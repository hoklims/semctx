from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path


SCRIPT = Path(__file__).parents[1] / "scripts" / "benchmark.py"
SPEC = importlib.util.spec_from_file_location("index_benchmark", SCRIPT)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"Cannot load {SCRIPT}")
benchmark = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = benchmark
SPEC.loader.exec_module(benchmark)


class BenchmarkTests(unittest.TestCase):
    def test_result_paths_reads_structured_and_ccc_sources(self) -> None:
        paths = benchmark.result_paths(
            {
                "sources": [{"path": "src/exact.ts", "line": 1}],
                "output": "--- Result 1 (score: 0.9) ---\nFile: src/semantic.ts:4-8 [typescript]\nbody",
            }
        )
        self.assertEqual(paths, {"src/exact.ts", "src/semantic.ts"})

    def test_summary_reports_latency_accuracy_fallback_and_stale(self) -> None:
        summary = benchmark.summarize(
            [
                {"lane": "smart", "elapsed_ms": 10.0, "time_to_correct_ms": 10.0, "correct": True, "fallback_used": False, "freshness": "READY", "estimated_tokens": 4, "peak_allocated_mb": 1.0},
                {"lane": "smart", "elapsed_ms": 30.0, "time_to_correct_ms": 2030.0, "correct": False, "fallback_used": True, "freshness": "STALE", "estimated_tokens": 6, "peak_allocated_mb": 2.0},
            ]
        )["smart"]
        self.assertEqual(summary["precision"], 0.5)
        self.assertEqual(summary["p50_ms"], 20.0)
        self.assertEqual(summary["p95_ms"], 30.0)
        self.assertEqual(summary["fallback_rate"], 0.5)
        self.assertEqual(summary["stale_rate"], 0.5)
        self.assertEqual(summary["estimated_tokens"], 10)
        self.assertEqual(summary["time_to_correct_total_ms"], 2040.0)
