from __future__ import annotations

import argparse
import json
import math
import re
import statistics
import sys
import time
import tracemalloc
from pathlib import Path
from typing import Any

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from gateway import Gateway


DEFAULT_MANIFEST = Path(__file__).parents[1] / "evals" / "benchmark-tasks.json"
CCC_FILE = re.compile(r"^File:\s+(.+?):\d+(?:-\d+)?\s+\[", re.MULTILINE)


def percentile(values: list[float], fraction: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    index = max(0, math.ceil(fraction * len(ordered)) - 1)
    return ordered[index]


def result_paths(result: dict[str, Any]) -> set[str]:
    paths = {
        str(item.get("path", "")).replace("\\", "/").removeprefix("./").lower()
        for item in [*(result.get("sources") or []), *(result.get("matches") or [])]
        if isinstance(item, dict) and item.get("path")
    }
    output = result.get("output")
    if isinstance(output, str):
        paths.update(match.replace("\\", "/").removeprefix("./").lower() for match in CCC_FILE.findall(output))
    return paths


def summarize(rows: list[dict[str, Any]]) -> dict[str, Any]:
    grouped: dict[str, list[dict[str, Any]]] = {}
    for row in rows:
        grouped.setdefault(row["lane"], []).append(row)
    summary: dict[str, Any] = {}
    for lane, items in grouped.items():
        durations = [float(item["elapsed_ms"]) for item in items]
        time_to_correct = [float(item["time_to_correct_ms"]) for item in items]
        summary[lane] = {
            "tasks": len(items),
            "correct": sum(bool(item["correct"]) for item in items),
            "precision": round(sum(bool(item["correct"]) for item in items) / len(items), 4),
            "p50_ms": round(statistics.median(durations), 3),
            "p95_ms": round(percentile(durations, 0.95), 3),
            "total_ms": round(sum(durations), 3),
            "time_to_correct_p50_ms": round(statistics.median(time_to_correct), 3),
            "time_to_correct_p95_ms": round(percentile(time_to_correct, 0.95), 3),
            "time_to_correct_total_ms": round(sum(time_to_correct), 3),
            "fallback_rate": round(sum(bool(item.get("fallback_used")) for item in items) / len(items), 4),
            "stale_rate": round(sum(item.get("freshness") == "STALE" for item in items) / len(items), 4),
            "estimated_tokens": sum(int(item.get("estimated_tokens") or 0) for item in items),
            "peak_allocated_mb": round(max(float(item.get("peak_allocated_mb") or 0.0) for item in items), 3),
        }
    return summary


def exact_result(gateway: Gateway, root: Path, query: str) -> dict[str, Any]:
    matches, sources = gateway.exact_search(root, query, 10)
    return {"provider": "source", "freshness": "SOURCE_CURRENT", "fallback_used": False, "sources": sources, "matches": matches}


def smart_result(gateway: Gateway, task: dict[str, Any]) -> dict[str, Any]:
    arguments = {"root": task["root"], "limit": 10}
    if task["mode"] == "symbol":
        arguments["symbol"] = task["query"]
        return gateway.symbols(arguments)
    arguments["query"] = task["query"]
    if task["mode"] == "architecture":
        return gateway.architecture(arguments)
    return gateway.search(arguments)


def run(manifest: Path, *, host: str, miss_penalty_ms: float = 2000.0) -> dict[str, Any]:
    payload = json.loads(manifest.read_text(encoding="utf-8"))
    tasks = payload.get("tasks") or []
    if not 30 <= len(tasks) <= 50:
        raise ValueError("benchmark manifest must contain 30 to 50 tasks")
    gateway = Gateway(host)
    rows: list[dict[str, Any]] = []
    tracemalloc.start()
    try:
        for root_value in dict.fromkeys(str(task["root"]) for task in tasks):
            root = Path(root_value).resolve()
            deadline = time.monotonic() + 15.0
            while True:
                route = gateway.route(root)
                ccc = (route.get("providers") or {}).get("ccc", {})
                ccc_settled = not ccc.get("available") or ccc.get("usable") or ccc.get("status") in {"FAILED", "UNSUPPORTED"}
                if route.get("source_observation_fresh") and ccc_settled:
                    break
                if time.monotonic() >= deadline:
                    break
                gateway.route_cache.pop(str(root).lower(), None)
                time.sleep(0.25)
        for task in tasks:
            root = Path(task["root"]).resolve()
            for lane in ("exact", "smart"):
                before_peak = tracemalloc.get_traced_memory()[1]
                started = time.perf_counter()
                result = exact_result(gateway, root, task["query"]) if lane == "exact" else smart_result(gateway, task)
                elapsed_ms = (time.perf_counter() - started) * 1000.0
                peak = max(0, tracemalloc.get_traced_memory()[1] - before_peak)
                expected = str(task["expected"]).replace("\\", "/").lower()
                serialized = json.dumps(result, ensure_ascii=False)
                correct = expected in result_paths(result)
                rows.append(
                    {
                        **task,
                        "lane": lane,
                        "provider": result.get("provider"),
                        "correct": correct,
                        "elapsed_ms": round(elapsed_ms, 3),
                        "time_to_correct_ms": round(elapsed_ms if correct else elapsed_ms + miss_penalty_ms, 3),
                        "freshness": result.get("freshness"),
                        "fallback_used": bool(result.get("fallback_used")),
                        "estimated_tokens": math.ceil(len(serialized) / 4),
                        "peak_allocated_mb": round(peak / 1024 / 1024, 3),
                        "artifact_generation": result.get("artifact_generation"),
                        "consumer_generation": result.get("consumer_generation"),
                    }
                )
    finally:
        gateway.close()
        tracemalloc.stop()
    summary = summarize(rows)
    exact = summary["exact"]
    smart = summary["smart"]
    return {
        "schema_version": 1,
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "manifest": str(manifest.resolve()),
        "task_count": len(tasks),
        "miss_penalty_ms": miss_penalty_ms,
        "limitations": [
            "symbol mode measures the gateway source locator; native editor LSP latency is not observable from this headless runner",
            "estimated_tokens are serialized-output characters divided by four",
            "peak_allocated_mb is Python allocation delta, not total provider RSS",
        ],
        "summary": summary,
        "smart_vs_exact": {
            "precision_delta": round(smart["precision"] - exact["precision"], 4),
            "time_reduction": round(1.0 - smart["total_ms"] / exact["total_ms"], 4) if exact["total_ms"] else 0.0,
            "time_to_correct_reduction": round(
                1.0 - smart["time_to_correct_total_ms"] / exact["time_to_correct_total_ms"], 4
            ) if exact["time_to_correct_total_ms"] else 0.0,
        },
        "providers": {
            provider: {
                "tasks": len(items),
                "correct": sum(bool(item["correct"]) for item in items),
                "precision": round(sum(bool(item["correct"]) for item in items) / len(items), 4),
                "p50_ms": round(statistics.median(float(item["elapsed_ms"]) for item in items), 3),
            }
            for provider in sorted({str(row.get("provider")) for row in rows if row["lane"] == "smart"})
            if (items := [row for row in rows if row["lane"] == "smart" and str(row.get("provider")) == provider])
        },
        "rows": rows,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Reproducible code-intelligence ROI benchmark.")
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--host", choices=("codex", "claude"), default="codex")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--miss-penalty-ms", type=float, default=2000.0)
    args = parser.parse_args()
    result = run(args.manifest, host=args.host, miss_penalty_ms=max(0.0, args.miss_penalty_ms))
    rendered = json.dumps(result, ensure_ascii=False, indent=2)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered + "\n", encoding="utf-8")
    print(rendered)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
