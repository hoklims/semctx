from __future__ import annotations

import argparse
import json
import math
import statistics
import time
import tracemalloc
from pathlib import Path
from typing import Any


def percentile(values: list[float], fraction: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    return ordered[max(0, math.ceil(len(ordered) * fraction) - 1)]


def normalize_path(value: str) -> str:
    return value.replace("\\", "/").removeprefix("./").lower()


def symbol_paths(index: dict[str, Any], query: str, *, definitions_only: bool) -> list[str]:
    needle = f"/{query.lower()}"
    paths: set[str] = set()
    for document in index.get("documents") or []:
        path = normalize_path(str(document.get("relative_path") or ""))
        for occurrence in document.get("occurrences") or []:
            symbol = str(occurrence.get("symbol") or "").lower()
            roles = int(occurrence.get("symbol_roles") or 0)
            if needle in symbol and (not definitions_only or roles & 1):
                paths.add(path)
                break
    return sorted(paths)


def definition_paths(index: dict[str, Any], query: str) -> list[str]:
    return symbol_paths(index, query, definitions_only=True)


def select_tasks(manifest: dict[str, Any], *, project: str | None, language: str | None) -> list[dict[str, Any]]:
    tasks = manifest.get("tasks") or []
    if project:
        return [task for task in tasks if task.get("project") == project and task.get("mode") == "symbol"]
    if language:
        return [task for task in tasks if task.get("language") == language]
    raise ValueError("project or language is required")


def run(
    index_json: Path,
    manifest: Path,
    *,
    project: str | None,
    language: str | None,
    repetitions: int,
    expected_documents: int | None,
) -> dict[str, Any]:
    raw = index_json.read_bytes()
    tracemalloc.start()
    started = time.perf_counter()
    index = json.loads(raw)
    parse_ms = (time.perf_counter() - started) * 1000
    parse_peak_mb = tracemalloc.get_traced_memory()[1] / 1024 / 1024
    tracemalloc.stop()
    task_payload = json.loads(manifest.read_text(encoding="utf-8"))
    tasks = select_tasks(task_payload, project=project, language=language)
    rows: list[dict[str, Any]] = []
    for task in tasks:
        samples: list[float] = []
        paths: list[str] = []
        for _ in range(max(1, repetitions)):
            started = time.perf_counter()
            paths = symbol_paths(
                index,
                str(task["symbol"] if "symbol" in task else task["query"]),
                definitions_only=task.get("request") != "references",
            )
            samples.append((time.perf_counter() - started) * 1000)
        expected = normalize_path(str(task["expected"]))
        correct = any(path == expected or expected.endswith(f"/{path}") or path.endswith(f"/{expected}") for path in paths)
        rows.append(
            {
                "query": task.get("symbol") or task.get("query"),
                "expected": task["expected"],
                "correct": correct,
                "p50_ms": round(statistics.median(samples), 4),
                "p95_ms": round(percentile(samples, 0.95), 4),
                "paths": paths[:20],
            }
        )
    documents = len(index.get("documents") or [])
    coverage = documents / expected_documents if expected_documents else None
    return {
        "schema_version": 1,
        "query_surface": "scip-v0.9.0-print-json",
        "index_json": str(index_json.resolve()),
        "json_bytes": len(raw),
        "parse_ms": round(parse_ms, 3),
        "parse_peak_mb": round(parse_peak_mb, 3),
        "documents": documents,
        "expected_documents": expected_documents,
        "document_coverage": round(coverage, 4) if coverage is not None else None,
        "tasks": len(rows),
        "correct": sum(bool(row["correct"]) for row in rows),
        "precision": round(sum(bool(row["correct"]) for row in rows) / len(rows), 4) if rows else 0.0,
        "query_p50_ms": round(statistics.median(row["p50_ms"] for row in rows), 4) if rows else 0.0,
        "query_p95_ms": round(percentile([row["p95_ms"] for row in rows], 0.95), 4),
        "rows": rows,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Probe the stable JSON output of the official SCIP CLI.")
    parser.add_argument("--index-json", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    selection = parser.add_mutually_exclusive_group(required=True)
    selection.add_argument("--project")
    selection.add_argument("--language")
    parser.add_argument("--repetitions", type=int, default=20)
    parser.add_argument("--expected-documents", type=int)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    result = run(
        args.index_json,
        args.manifest,
        project=args.project,
        language=args.language,
        repetitions=max(1, args.repetitions),
        expected_documents=args.expected_documents,
    )
    rendered = json.dumps(result, ensure_ascii=False, indent=2)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered + "\n", encoding="utf-8")
    print(rendered)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
