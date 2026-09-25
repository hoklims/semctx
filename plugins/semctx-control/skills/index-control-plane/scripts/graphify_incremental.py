from __future__ import annotations

import argparse
import hashlib
import json
import os
import sqlite3
import uuid
from pathlib import Path
from typing import Any, Sequence


QUERY_INDEX_SCHEMA_VERSION = "1"


def _write_query_index(path: Path, payload: dict[str, Any], graph_sha256: str) -> None:
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    connection: sqlite3.Connection | None = None
    try:
        connection = sqlite3.connect(temporary)
        connection.executescript(
            """
            PRAGMA journal_mode=OFF;
            PRAGMA synchronous=OFF;
            CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE VIRTUAL TABLE nodes_fts USING fts5(id UNINDEXED, search_text, payload UNINDEXED);
            CREATE TABLE edges (source TEXT NOT NULL, target TEXT NOT NULL, payload TEXT NOT NULL);
            CREATE INDEX edges_source ON edges(source);
            CREATE INDEX edges_target ON edges(target);
            """
        )
        connection.executemany(
            "INSERT INTO metadata(key, value) VALUES (?, ?)",
            [
                ("schema_version", QUERY_INDEX_SCHEMA_VERSION),
                ("graph_sha256", graph_sha256),
                ("nodes", str(len(payload.get("nodes", [])))),
                ("edges", str(len(payload.get("edges", [])))),
            ],
        )
        for node in payload.get("nodes", []):
            if not isinstance(node, dict):
                continue
            encoded = json.dumps(node, ensure_ascii=False, separators=(",", ":"))
            connection.execute(
                "INSERT INTO nodes_fts(id, search_text, payload) VALUES (?, ?, ?)",
                (str(node.get("id", "")), encoded, encoded),
            )
        connection.executemany(
            "INSERT INTO edges(source, target, payload) VALUES (?, ?, ?)",
            [
                (
                    str(edge.get("source", edge.get("from", ""))),
                    str(edge.get("target", edge.get("to", ""))),
                    json.dumps(edge, ensure_ascii=False, separators=(",", ":")),
                )
                for edge in payload.get("edges", [])
                if isinstance(edge, dict)
            ],
        )
        connection.commit()
        connection.close()
        connection = None
        os.replace(temporary, path)
    finally:
        if connection is not None:
            connection.close()
        temporary.unlink(missing_ok=True)


def _query_index_matches(path: Path, graph_sha256: str) -> bool:
    if not path.is_file():
        return False
    try:
        connection = sqlite3.connect(path)
        try:
            row = connection.execute(
                "SELECT value FROM metadata WHERE key = 'graph_sha256'"
            ).fetchone()
            schema = connection.execute(
                "SELECT value FROM metadata WHERE key = 'schema_version'"
            ).fetchone()
        finally:
            connection.close()
        return row == (graph_sha256,) and schema == (QUERY_INDEX_SCHEMA_VERSION,)
    except sqlite3.Error:
        return False


def _write_graph(path: Path, graph: Any, token_source: dict[str, Any]) -> dict[str, Any]:
    payload = {
        "nodes": [{"id": node, **attributes} for node, attributes in graph.nodes(data=True)],
        "edges": [
            {
                **{
                    key: value
                    for key, value in attributes.items()
                    if key not in {"_src", "_tgt", "source", "target"}
                },
                "source": attributes.get("_src", source),
                "target": attributes.get("_tgt", target),
            }
            for source, target, attributes in graph.edges(data=True)
        ],
        "hyperedges": list(graph.graph.get("hyperedges", [])),
        "input_tokens": token_source.get("input_tokens", 0),
        "output_tokens": token_source.get("output_tokens", 0),
        "directed": graph.is_directed(),
    }
    encoded = json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8")
    graph_sha256 = f"sha256:{hashlib.sha256(encoded).hexdigest()}"
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        temporary.write_bytes(encoded)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)
    _write_query_index(path.with_name("query.sqlite"), payload, graph_sha256)
    communities = {
        attributes.get("community")
        for _, attributes in graph.nodes(data=True)
        if attributes.get("community") is not None
    }
    return {
        "nodes": len(payload["nodes"]),
        "edges": len(payload["edges"]),
        "communities": len(communities),
        "graph_sha256": graph_sha256,
        "query_index": "query.sqlite",
    }


def update(root: Path, output_root: Path, *, force_rebuild: bool = False) -> tuple[int, dict[str, Any]]:
    from graphify.build import build
    from graphify.detect import detect_incremental, save_manifest
    from graphify.extract import extract

    graphify_out = output_root / "graphify-out"
    graph_path = graphify_out / "graph.json"
    manifest_path = graphify_out / "manifest.json"
    query_index_path = graphify_out / "query.sqlite"
    graphify_out.mkdir(parents=True, exist_ok=True)

    detection = detect_incremental(root, manifest_path=str(manifest_path), kind="ast")
    new_files = detection.get("new_files", {})
    changed_code = [Path(path) for path in new_files.get("code", [])]
    deleted = list(detection.get("deleted_files", []))
    excluded = list(detection.get("excluded_files", []))
    all_code = [Path(path) for path in detection.get("files", {}).get("code", [])]
    scan_corpus = {path for paths in detection.get("files", {}).values() for path in paths}
    needs_rebuild = force_rebuild or not graph_path.is_file() or bool(changed_code or deleted or excluded)
    if not needs_rebuild:
        graph_bytes = graph_path.read_bytes()
        graph_sha256 = f"sha256:{hashlib.sha256(graph_bytes).hexdigest()}"
        indexed = False
        if not _query_index_matches(query_index_path, graph_sha256):
            _write_query_index(
                query_index_path,
                json.loads(graph_bytes.decode("utf-8")),
                graph_sha256,
            )
            indexed = True
        save_manifest(
            detection.get("files", {}),
            manifest_path=str(manifest_path),
            kind="ast",
            root=root,
            scan_corpus=scan_corpus,
        )
        return 0, {
            "status": "INDEXED" if indexed else "UNCHANGED",
            "changed_code_files": 0,
            "graph_sha256": graph_sha256,
            "query_index": query_index_path.name,
            "changed_non_code_files": sum(
                len(paths) for kind, paths in new_files.items() if kind != "code"
            ),
        }

    # Extract the complete code corpus on every changed generation. Graphify's
    # content cache keeps this incremental in cost, while the full materialized
    # graph makes deletes/renames and same-basename paths deterministic.
    previous_cwd = Path.cwd()
    try:
        os.chdir(output_root)
        # The root directory is a non-extractable sentinel that pins Graphify's
        # inferred source root even when every code file lives under one nested
        # directory. It emits no node and keeps source_file paths repo-relative.
        # Disable Graphify's ProcessPool on Windows: spawned python.exe workers
        # can surface one console window per CPU. The content cache keeps normal
        # incremental runs fast without parallel child processes.
        delta = extract([root, *all_code], parallel=False)
    finally:
        os.chdir(previous_cwd)
    graph = build([delta], root=root, directed=True)
    try:
        from graphify.cluster import cluster, label_communities_by_hub

        communities = cluster(graph)
        labels = label_communities_by_hub(graph, communities)
        for community_id, members in communities.items():
            for node_id in members:
                if node_id in graph:
                    graph.nodes[node_id]["community"] = community_id
                    graph.nodes[node_id]["community_name"] = labels[community_id]
    except Exception:
        # Directional structural navigation remains useful if optional
        # community detection is unavailable in a constrained runtime.
        pass
    counts = _write_graph(graph_path, graph, delta)
    save_manifest(
        detection.get("files", {}),
        manifest_path=str(manifest_path),
        kind="ast",
        root=root,
        scan_corpus=scan_corpus,
    )
    return 0, {
        "status": "REBUILT",
        "changed_code_files": len(changed_code),
        "deleted_files": len(deleted),
        "excluded_files": len(excluded),
        "forced": force_rebuild,
        "changed_non_code_files": sum(
            len(paths) for kind, paths in new_files.items() if kind != "code"
        ),
        **counts,
    }


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Safe incremental code-only Graphify update.")
    parser.add_argument("--root", required=True)
    parser.add_argument("--output-root", required=True)
    parser.add_argument("--force-rebuild", action="store_true")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    code, result = update(
        Path(args.root).resolve(),
        Path(args.output_root).resolve(),
        force_rebuild=args.force_rebuild,
    )
    print(json.dumps(result, ensure_ascii=False))
    return code


if __name__ == "__main__":
    raise SystemExit(main())
