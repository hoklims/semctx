from __future__ import annotations

import argparse
import json
import math
import sqlite3
import statistics
import time
from pathlib import Path
from typing import Any


QUERY = """
SELECT DISTINCT d.relative_path
FROM global_symbols AS g
JOIN mentions AS m ON m.symbol_id = g.id
JOIN chunks AS c ON c.id = m.chunk_id
JOIN documents AS d ON d.id = c.document_id
WHERE lower(g.symbol) LIKE lower(?) AND (m.role & 1) = 1
LIMIT 50
"""


def percentile(values: list[float], fraction: float) -> float:
    ordered = sorted(values)
    return ordered[max(0, math.ceil(len(ordered) * fraction) - 1)] if ordered else 0.0


def run(database: Path, manifest: Path, *, project: str, repetitions: int) -> dict[str, Any]:
    tasks = [
        task
        for task in json.loads(manifest.read_text(encoding="utf-8"))["tasks"]
        if task["project"] == project and task["mode"] == "symbol"
    ]
    connection = sqlite3.connect(database)
    rows: list[dict[str, Any]] = []
    try:
        for task in tasks:
            samples: list[float] = []
            paths: list[str] = []
            for _ in range(max(1, repetitions)):
                started = time.perf_counter()
                paths = [
                    str(row[0]).replace("\\", "/").lower()
                    for row in connection.execute(QUERY, (f"%/{task['query']}%",)).fetchall()
                ]
                samples.append((time.perf_counter() - started) * 1000.0)
            expected = str(task["expected"]).replace("\\", "/").lower()
            rows.append(
                {
                    "query": task["query"],
                    "expected": task["expected"],
                    "correct": expected in paths,
                    "p50_ms": round(statistics.median(samples), 4),
                    "p95_ms": round(percentile(samples, 0.95), 4),
                    "paths": paths[:10],
                }
            )
        documents = connection.execute("SELECT count(*) FROM documents").fetchone()[0]
        symbols = connection.execute("SELECT count(*) FROM global_symbols").fetchone()[0]
    finally:
        connection.close()
    return {
        "schema_version": 1,
        "database": str(database.resolve()),
        "project": project,
        "tasks": len(rows),
        "correct": sum(bool(row["correct"]) for row in rows),
        "precision": round(sum(bool(row["correct"]) for row in rows) / len(rows), 4) if rows else 0.0,
        "documents": documents,
        "global_symbols": symbols,
        "query_p50_ms": round(statistics.median(row["p50_ms"] for row in rows), 4) if rows else 0.0,
        "query_p95_ms": round(percentile([row["p95_ms"] for row in rows], 0.95), 4),
        "rows": rows,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Probe an official SCIP SQLite conversion without a daemon.")
    parser.add_argument("--database", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--project", required=True)
    parser.add_argument("--repetitions", type=int, default=20)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    result = run(args.database, args.manifest, project=args.project, repetitions=args.repetitions)
    rendered = json.dumps(result, ensure_ascii=False, indent=2)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered + "\n", encoding="utf-8")
    print(rendered)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
