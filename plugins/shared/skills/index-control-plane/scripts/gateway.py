from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Sequence


GATEWAY_VERSION = "1.6.0"
PROTOCOL_VERSION = "2025-06-18"
SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from index_control import routing_advisory

DEFAULT_CONTROLLER = SCRIPT_DIR / "index_control.py"
DEFAULT_LAUNCHER = SCRIPT_DIR / "launch_detached.py"
DEFAULT_WORKER = SCRIPT_DIR / "reconcile_worker.py"
# Mirrors WAKE_LEASE_SECONDS in ~/.codex/hooks/index-control-routing.rs, whose
# expiry exists so a failed launch or a crashed worker can be retried.
WAKE_LEASE_SECONDS = 5.0
CCC_INTERACTIVE_TIMEOUT_SECONDS = 2.0
CCC_WARMUP_LEASE_SECONDS = 60.0


TOOLS = [
    {
        "name": "status",
        "description": "Return freshness, artifact and consumer readiness for one canonical Git worktree.",
        "inputSchema": {
            "type": "object",
            "properties": {"root": {"type": "string"}},
            "required": ["root"],
            "additionalProperties": False,
        },
    },
    {
        "name": "search",
        "description": "Find an unknown concept using CCC only when usable, otherwise exact source search.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "root": {"type": "string"},
                "query": {"type": "string"},
                "limit": {"type": "integer", "minimum": 1, "maximum": 50, "default": 10},
            },
            "required": ["root", "query"],
            "additionalProperties": False,
        },
    },
    {
        "name": "symbols",
        "description": "Locate symbol-like definitions and references with exact source search; this gateway does not claim LSP semantics.",
        "inputSchema": {
            "type": "object",
            "properties": {"root": {"type": "string"}, "symbol": {"type": "string"}, "limit": {"type": "integer", "minimum": 1, "maximum": 50, "default": 20}},
            "required": ["root", "symbol"],
            "additionalProperties": False,
        },
    },
    {
        "name": "architecture",
        "description": "Query structural topology only from a generation-matched Graphify artifact loaded by this gateway.",
        "inputSchema": {
            "type": "object",
            "properties": {"root": {"type": "string"}, "query": {"type": "string"}, "limit": {"type": "integer", "minimum": 1, "maximum": 50, "default": 10}},
            "required": ["root", "query"],
            "additionalProperties": False,
        },
    },
    {
        "name": "intent",
        "description": "Inspect authored intent and invariants through Semctx only when sealed, otherwise authoritative-source fallback.",
        "inputSchema": {
            "type": "object",
            "properties": {"root": {"type": "string"}, "query": {"type": "string"}, "limit": {"type": "integer", "minimum": 1, "maximum": 50, "default": 10}},
            "required": ["root", "query"],
            "additionalProperties": False,
        },
    },
]


def _run(command: Sequence[str], *, cwd: Path | None = None, timeout: float = 15.0) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        list(command),
        cwd=cwd,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
        check=False,
    )


class Gateway:
    def __init__(self, host: str) -> None:
        self.host = host
        self.python = Path(os.environ.get("INDEX_CONTROL_GATEWAY_PYTHON", sys.executable))
        self.controller = Path(os.environ.get("INDEX_CONTROL_GATEWAY_CONTROLLER", DEFAULT_CONTROLLER))
        self.in_process_route = routing_advisory
        self.launcher = Path(os.environ.get("INDEX_CONTROL_GATEWAY_LAUNCHER", DEFAULT_LAUNCHER))
        self.worker = Path(os.environ.get("INDEX_CONTROL_GATEWAY_WORKER", DEFAULT_WORKER))
        self.worker_stderr = Path(
            os.environ.get(
                "INDEX_CONTROL_GATEWAY_STDERR",
                Path.home() / ".agents" / "index-control-plane" / "logs" / "gateway-worker.stderr.log",
            )
        )
        self.semctx = Path(
            os.environ.get(
                "INDEX_CONTROL_GATEWAY_SEMCTX",
                Path.home() / ".codex" / "plugins" / "cache" / "semctx-stable" / "semctx-control" / "0.1.17" / "dist" / "semctx.js",
            )
        )
        self.loaded_graphs: dict[str, dict[str, Any]] = {}
        self.refresh_scheduled: dict[str, float] = {}
        self.route_cache: dict[str, tuple[float, dict[str, Any]]] = {}
        self.ccc_warmups: dict[str, float] = {}

    def warm_ccc(self, root: Path, query: str, limit: int) -> bool:
        key = str(root).casefold()
        now = time.monotonic()
        leased_at = self.ccc_warmups.get(key)
        if leased_at is not None and now - leased_at < CCC_WARMUP_LEASE_SECONDS:
            return False
        executable = shutil.which("ccc")
        if not executable:
            return False
        options: dict[str, Any] = {
            "cwd": root,
            "stdin": subprocess.DEVNULL,
            "stdout": subprocess.DEVNULL,
            "stderr": subprocess.DEVNULL,
            "close_fds": True,
        }
        if os.name == "nt":
            startup = subprocess.STARTUPINFO()
            startup.dwFlags |= subprocess.STARTF_USESHOWWINDOW
            startup.wShowWindow = subprocess.SW_HIDE
            options["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_NO_WINDOW
            options["startupinfo"] = startup
        else:
            options["start_new_session"] = True
        try:
            subprocess.Popen(
                [executable, "search", "--limit", str(limit), query],
                **options,
            )
        except OSError:
            return False
        self.ccc_warmups[key] = now
        return True

    def wake_worker(self, root: Path) -> bool:
        key = str(root)
        leased_at = self.refresh_scheduled.get(key)
        # A bounded lease, matching the hook's WAKE_LEASE_SECONDS. An unbounded
        # memo means only the first cold call in a process ever spawns a worker,
        # so refresh_scheduled reports true while nothing was launched.
        if leased_at is not None and time.monotonic() - leased_at < WAKE_LEASE_SECONDS:
            return True
        completed = _run(
            [
                str(self.python), str(self.launcher),
                "--python", str(self.python),
                "--program", str(self.worker),
                "--mode", "worker",
                "--root", str(root),
                "--stderr-log", str(self.worker_stderr),
            ],
            timeout=5.0,
        )
        if completed.returncode == 0:
            self.refresh_scheduled[key] = time.monotonic()
            return True
        return False

    def request_refresh(self, root: Path, *, kind: str, reason: str) -> bool:
        signal = _run(
            [
                str(self.python), str(self.worker), "signal",
                "--host", self.host,
                "--root", str(root),
                "--kind", kind,
                "--reason", reason,
            ],
            timeout=5.0,
        )
        return signal.returncode == 0 and self.wake_worker(root)

    def route(self, root: Path) -> dict[str, Any]:
        key = str(root).lower()
        cached = self.route_cache.get(key)
        if cached is not None:
            elapsed = max(0.0, time.monotonic() - cached[0])
            observed_age = cached[1].get("source_observation_age_seconds")
            observation_ttl = cached[1].get("source_observation_ttl_seconds")
            if cached[1].get("source_observation_mode") == "verified_live":
                # The recorded age is the honest worker-observation age and is
                # already past the TTL; what bounds this entry is the moment the
                # live re-fingerprint happened, so budget from `elapsed` alone.
                # This also caps live verification at once per TTL per repo.
                if isinstance(observation_ttl, (int, float)) and elapsed < float(observation_ttl):
                    return dict(cached[1])
            elif (
                cached[1].get("source_observation_fresh")
                and isinstance(observed_age, (int, float))
                and isinstance(observation_ttl, (int, float))
                and float(observed_age) + elapsed < float(observation_ttl)
            ) or (observed_age is None and elapsed <= 5.0):
                return dict(cached[1])
        if self.controller.resolve() == DEFAULT_CONTROLLER.resolve():
            route = self.in_process_route(root, host=self.host, verify_expired=True)
        else:
            completed = _run(
                [str(self.python), str(self.controller), "route", "--host", self.host, "--root", str(root), "--format", "json", "--verify-expired"],
                timeout=20.0,
            )
            if completed.returncode != 0:
                raise RuntimeError(completed.stderr.strip() or "control-plane route failed")
            route = json.loads(completed.stdout)
        route["refresh_scheduled"] = False
        if not route.get("source_observation_fresh") or route.get("source_observation_mode") == "verified_live":
            # verified_live means the answer is correct but nobody is observing
            # the source any more; wake the worker to restore the axis.
            route["refresh_scheduled"] = self.wake_worker(root)
        self.route_cache[key] = (time.monotonic(), dict(route))
        return route

    @staticmethod
    def envelope(
        route: dict[str, Any],
        *,
        provider: str,
        freshness: str,
        fallback_used: bool,
        sources: list[dict[str, Any]],
        artifact_generation: int | None = None,
        consumer_generation: int | None = None,
        **payload: Any,
    ) -> dict[str, Any]:
        provider_route = (route.get("providers") or {}).get(provider, {})
        result = {
            "provider": provider,
            "source_state_id": route.get("source_state_id"),
            "corpus_state_id": provider_route.get("corpus_state_id"),
            "artifact_generation": artifact_generation if artifact_generation is not None else route.get("generation"),
            "consumer_generation": consumer_generation,
            "freshness": freshness,
            "fallback_used": fallback_used,
            "sources": sources,
        }
        result.update(payload)
        return result

    def status(self, arguments: dict[str, Any]) -> dict[str, Any]:
        route = self.route(Path(arguments["root"]).resolve())
        return self.envelope(
            route,
            provider="control-plane",
            freshness="READY" if route.get("source_observation_fresh") else "STALE",
            fallback_used=not bool(route.get("source_observation_fresh")),
            sources=[],
            providers=route.get("providers", {}),
            generation=route.get("generation"),
            root=route.get("root"),
            refresh_scheduled=bool(route.get("refresh_scheduled")),
            # Without these the caller cannot tell a cold cache from a real
            # index-behind-source condition, and reads every STALE as the
            # latter. `freshness` keeps its pinned semantics; this is additive.
            source_observation_age_seconds=route.get("source_observation_age_seconds"),
            source_observation_ttl_seconds=route.get("source_observation_ttl_seconds"),
            source_observation_fresh=route.get("source_observation_fresh"),
            source_observation_mode=route.get("source_observation_mode"),
            host_dirty_generation_acknowledged=route.get("host_dirty_generation_acknowledged"),
        )

    @staticmethod
    def exact_search(root: Path, query: str, limit: int) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
        rg = shutil.which("rg")
        if not rg:
            raise RuntimeError("rg is required for source fallback")
        completed = _run(
            [
                rg, "--json", "--fixed-strings", "--line-number",
                "--glob", "!graphify-out/**",
                "--glob", "!.cocoindex_code/**",
                "--glob", "!.semctx/**",
                "--glob", "!.omx/**",
                "--glob", "!.serena/**",
                "--", query, ".",
            ],
            cwd=root,
            timeout=15.0,
        )
        if completed.returncode not in (0, 1):
            raise RuntimeError(completed.stderr.strip() or "rg fallback failed")
        matches: list[dict[str, Any]] = []
        for line in completed.stdout.splitlines():
            record = json.loads(line)
            if record.get("type") != "match":
                continue
            data = record["data"]
            relative = str(data["path"]["text"]).replace("\\", "/").removeprefix("./")
            item = {
                "path": relative,
                "line": data.get("line_number"),
                "text": str(data["lines"]["text"]).rstrip("\r\n"),
            }
            matches.append(item)
        matches.sort(
            key=lambda item: (
                str(item.get("path", "")).casefold(),
                int(item.get("line") or 0),
                str(item.get("text", "")),
            )
        )
        matches = matches[:limit]
        sources = [{"path": item["path"], "line": item["line"]} for item in matches]
        return matches, sources

    def search(self, arguments: dict[str, Any]) -> dict[str, Any]:
        root = Path(arguments["root"]).resolve()
        query = str(arguments["query"]).strip()
        limit = max(1, min(int(arguments.get("limit", 10)), 50))
        route = self.route(root)
        ccc = route.get("providers", {}).get("ccc", {})
        if ccc.get("usable"):
            try:
                completed = _run(
                    ["ccc", "search", "--limit", str(limit), query],
                    cwd=root,
                    timeout=CCC_INTERACTIVE_TIMEOUT_SECONDS,
                )
            except subprocess.TimeoutExpired:
                self.warm_ccc(root, query, limit)
            else:
                if completed.returncode == 0:
                    return self.envelope(
                        route,
                        provider="ccc",
                        freshness="READY",
                        fallback_used=False,
                        sources=self.ccc_sources(completed.stdout, root),
                        artifact_generation=ccc.get("artifact_generation"),
                        consumer_generation=ccc.get("consumer_generation"),
                        output=completed.stdout.strip(),
                    )
        matches, sources = self.exact_search(root, query, limit)
        return self.envelope(
            route,
            provider="source",
            freshness="SOURCE_CURRENT",
            fallback_used=True,
            sources=sources,
            artifact_generation=ccc.get("artifact_generation"),
            consumer_generation=ccc.get("consumer_generation"),
            matches=matches,
        )

    @staticmethod
    def ccc_sources(output: str, root: Path) -> list[dict[str, Any]]:
        pattern = re.compile(
            r"^File:\s+(?P<path>.+):(?P<line>\d+)(?:-(?P<end_line>\d+))?(?:\s+\[[^\]\r\n]+\])?\s*$",
            re.MULTILINE,
        )
        sources: list[dict[str, Any]] = []
        seen: set[tuple[str, int, int | None]] = set()
        for match in pattern.finditer(output):
            raw_path = match.group("path").replace("\\", "/")
            candidate = Path(raw_path)
            try:
                path = candidate.resolve().relative_to(root).as_posix() if candidate.is_absolute() else raw_path.removeprefix("./")
            except ValueError:
                path = raw_path
            line = int(match.group("line"))
            end_line = int(match.group("end_line")) if match.group("end_line") else None
            key = (path, line, end_line)
            if key in seen:
                continue
            seen.add(key)
            source: dict[str, Any] = {"path": path, "line": line}
            if end_line is not None:
                source["end_line"] = end_line
            sources.append(source)
        return sources

    def symbols(self, arguments: dict[str, Any]) -> dict[str, Any]:
        root = Path(arguments["root"]).resolve()
        symbol = str(arguments["symbol"]).strip()
        limit = max(1, min(int(arguments.get("limit", 20)), 50))
        route = self.route(root)
        matches, _ = self.exact_search(root, symbol, 50)
        definition = re.compile(
            rf"\b(?:class|function|interface|type|const|let|var|def)\s+{re.escape(symbol)}\b",
            re.IGNORECASE,
        )
        matches.sort(
            key=lambda item: (
                0 if definition.search(str(item.get("text", ""))) else 1,
                len(str(item.get("path", ""))),
                str(item.get("path", "")),
                int(item.get("line") or 0),
            )
        )
        matches = matches[:limit]
        sources = [{"path": item["path"], "line": item.get("line")} for item in matches]
        return self.envelope(
            route,
            provider="source",
            freshness="SOURCE_CURRENT",
            fallback_used=True,
            sources=sources,
            matches=matches,
            recommended_lane="source-exact",
            semantic_capability="textual",
        )

    def _consumer(self, root: Path, command: str, *, reason: str | None = None) -> dict[str, Any]:
        arguments = [
            str(self.python), str(self.controller), command,
            "--host", self.host, "--root", str(root), "--provider", "graphify",
        ]
        if reason is not None:
            arguments.extend(["--reason", reason])
        arguments.extend(["--format", "json"])
        completed = _run(arguments, timeout=20.0)
        if completed.returncode != 0:
            raise RuntimeError(completed.stderr.strip() or f"{command} failed")
        self.route_cache.pop(str(root).lower(), None)
        return json.loads(completed.stdout)

    @staticmethod
    def _graph_sources(nodes: list[dict[str, Any]]) -> list[dict[str, Any]]:
        sources: list[dict[str, Any]] = []
        seen: set[str] = set()
        for node in nodes:
            value = node.get("source_file") or node.get("file") or node.get("path") or node.get("source")
            if not isinstance(value, str) or not value or value in seen:
                continue
            seen.add(value)
            sources.append({"path": value.replace("\\", "/")})
        return sources

    @staticmethod
    def _query_graph_index(
        path: Path,
        query: str,
        limit: int,
        expected_graph_sha256: str,
    ) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
        if not path.is_file():
            raise RuntimeError("Graphify query index is missing")
        tokens = [token for token in re.findall(r"[\w]+", query.lower()) if token]
        if not tokens:
            return [], []
        match = " AND ".join(f'"{token.replace(chr(34), chr(34) * 2)}"*' for token in tokens)
        connection = sqlite3.connect(f"{path.resolve().as_uri()}?mode=ro", uri=True)
        try:
            metadata = dict(connection.execute("SELECT key, value FROM metadata"))
            if metadata.get("graph_sha256") != expected_graph_sha256:
                raise RuntimeError("Graphify query index does not match the routed graph artifact")
            node_rows = connection.execute(
                "SELECT payload FROM nodes_fts WHERE nodes_fts MATCH ? ORDER BY bm25(nodes_fts) LIMIT ?",
                (match, limit),
            ).fetchall()
            nodes = [json.loads(payload) for (payload,) in node_rows]
            node_ids = [str(node.get("id")) for node in nodes if node.get("id") is not None]
            if not node_ids:
                return nodes, []
            placeholders = ",".join("?" for _ in node_ids)
            edge_rows = connection.execute(
                f"SELECT payload FROM edges WHERE source IN ({placeholders}) OR target IN ({placeholders}) LIMIT ?",
                [*node_ids, *node_ids, limit * 4],
            ).fetchall()
            return nodes, [json.loads(payload) for (payload,) in edge_rows]
        finally:
            connection.close()

    def architecture(self, arguments: dict[str, Any]) -> dict[str, Any]:
        root = Path(arguments["root"]).resolve()
        query = str(arguments["query"]).strip().lower()
        limit = max(1, min(int(arguments.get("limit", 10)), 50))
        route = self.route(root)
        graphify = route.get("providers", {}).get("graphify", {})
        generation = graphify.get("artifact_generation")
        source_state_id = route.get("source_state_id")
        graph_path_value = graphify.get("graph_path")
        query_index_value = graphify.get("query_index_path")
        graph_sha256 = graphify.get("graph_sha256")
        if (
            not route.get("source_observation_fresh")
            or not graphify.get("artifact_ready")
            or generation != route.get("generation")
            or not graph_path_value
            or not query_index_value
            or not graph_sha256
        ):
            matches, sources = self.exact_search(root, str(arguments["query"]), limit)
            refresh_scheduled = self.request_refresh(root, kind="jit", reason="ARCHITECTURE_REQUEST")
            return self.envelope(
                route,
                provider="source",
                freshness="SOURCE_CURRENT",
                fallback_used=True,
                sources=sources,
                artifact_generation=generation,
                consumer_generation=graphify.get("consumer_generation"),
                matches=matches,
                reason="GRAPHIFY_NOT_USABLE",
                refresh_scheduled=refresh_scheduled,
            )

        cache_key = str(root).lower()
        loaded = self.loaded_graphs.get(cache_key)
        needs_acceptance = (
            loaded is None
            or loaded.get("generation") != generation
            or loaded.get("source_state_id") != source_state_id
            or loaded.get("graph_sha256") != graph_sha256
        )
        nodes, edges = self._query_graph_index(
            Path(str(query_index_value)),
            query,
            limit,
            str(graph_sha256),
        )
        if needs_acceptance:
            if loaded is not None:
                self._consumer(root, "consumer-stale", reason="CONSUMER_RELOAD")
            self.loaded_graphs[cache_key] = {
                "root": root,
                "generation": generation,
                "source_state_id": source_state_id,
                "graph_sha256": graph_sha256,
            }
            self._consumer(root, "consumer-ready")
            route = self.route(root)
            graphify = route.get("providers", {}).get("graphify", {})

        if not graphify.get("usable") or graphify.get("consumer_generation") != generation:
            raise RuntimeError("Graphify consumer generation was not accepted by the control plane")

        return self.envelope(
            route,
            provider="graphify",
            freshness="READY",
            fallback_used=False,
            sources=self._graph_sources(nodes),
            artifact_generation=generation,
            consumer_generation=graphify.get("consumer_generation"),
            nodes=nodes,
            edges=edges,
        )

    def _semctx_inspect(self, root: Path, kind: str, query: str) -> dict[str, Any] | None:
        if self.semctx.suffix.lower() == ".py":
            command = [str(self.python), str(self.semctx), "--root", str(root), "inspect", kind, query, "--json"]
        else:
            bun = os.environ.get("INDEX_CONTROL_GATEWAY_BUN", str(Path.home() / "scoop" / "shims" / "bun.exe"))
            command = [bun, str(self.semctx), "--root", str(root), "inspect", kind, query, "--json"]
        completed = _run(command, cwd=root, timeout=30.0)
        if completed.returncode != 0:
            return None
        try:
            payload = json.loads(completed.stdout)
        except json.JSONDecodeError:
            return None
        return payload if isinstance(payload, dict) else None

    @staticmethod
    def _inspect_is_empty(payload: dict[str, Any] | None) -> bool:
        if payload is None:
            return True
        return not any(
            payload.get(key)
            for key in ("matchedNodes", "relatedClaims", "relations", "evidence", "filesToRead", "matches")
        )

    def intent(self, arguments: dict[str, Any]) -> dict[str, Any]:
        root = Path(arguments["root"]).resolve()
        query = str(arguments["query"]).strip()
        limit = max(1, min(int(arguments.get("limit", 10)), 50))
        route = self.route(root)
        semctx = route.get("providers", {}).get("semctx", {})
        if semctx.get("usable") and self.semctx.is_file():
            payload = self._semctx_inspect(root, "capability", query)
            if not self._inspect_is_empty(payload):
                return self.envelope(
                    route,
                    provider="semctx",
                    freshness="READY",
                    fallback_used=False,
                    sources=list(payload.get("sources", [])),
                    artifact_generation=semctx.get("artifact_generation"),
                    consumer_generation=semctx.get("consumer_generation"),
                    result=payload,
                    intent_layer="authored_capability",
                )
            # An empty authored layer must never be served as an authoritative
            # answer: a caller reads {} as "no invariants" rather than "nothing
            # authored". Fall back to the extracted symbol graph and say so.
            symbols = self._semctx_inspect(root, "symbol", query)
            if not self._inspect_is_empty(symbols):
                return self.envelope(
                    route,
                    provider="semctx",
                    freshness="READY",
                    fallback_used=True,
                    sources=list(symbols.get("sources", [])),
                    artifact_generation=semctx.get("artifact_generation"),
                    consumer_generation=semctx.get("consumer_generation"),
                    result=symbols,
                    intent_layer="extracted_symbol",
                    reason="SEMANTIC_LAYER_NOT_AUTHORED",
                )
        matches, sources = self.exact_search(root, query, limit)
        return self.envelope(
            route,
            provider="source",
            freshness="SOURCE_CURRENT",
            fallback_used=True,
            sources=sources,
            artifact_generation=semctx.get("artifact_generation"),
            consumer_generation=semctx.get("consumer_generation"),
            matches=matches,
            reason="SEMCTX_NOT_USABLE" if not semctx.get("usable") else "SEMCTX_HAS_NO_MATCH",
        )

    def close(self) -> None:
        for loaded in list(self.loaded_graphs.values()):
            try:
                self._consumer(Path(loaded["root"]), "consumer-stale", reason="CONSUMER_STOPPED")
            except Exception:
                pass
        self.loaded_graphs.clear()

    def call(self, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        if name == "status":
            return self.status(arguments)
        if name == "search":
            return self.search(arguments)
        if name == "symbols":
            return self.symbols(arguments)
        if name == "architecture":
            return self.architecture(arguments)
        if name == "intent":
            return self.intent(arguments)
        raise ValueError(f"tool not implemented yet: {name}")


def _tool_result(payload: dict[str, Any]) -> dict[str, Any]:
    return {
        "content": [{"type": "text", "text": json.dumps(payload, ensure_ascii=False)}],
        "structuredContent": payload,
        "isError": False,
    }


def _handle(gateway: Gateway, request: dict[str, Any]) -> dict[str, Any] | None:
    method = request.get("method")
    request_id = request.get("id")
    if method == "notifications/initialized":
        return None
    if method == "initialize":
        return {
            "jsonrpc": "2.0",
            "id": request_id,
            "result": {
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {"tools": {"listChanged": False}},
                "serverInfo": {"name": "index-intelligence-gateway", "version": GATEWAY_VERSION},
            },
        }
    if method == "tools/list":
        return {"jsonrpc": "2.0", "id": request_id, "result": {"tools": TOOLS}}
    if method == "tools/call":
        params = request.get("params") or {}
        try:
            payload = gateway.call(str(params.get("name", "")), dict(params.get("arguments") or {}))
            return {"jsonrpc": "2.0", "id": request_id, "result": _tool_result(payload)}
        except Exception as error:
            payload = {"error": type(error).__name__, "message": str(error), "fallback_used": True}
            result = _tool_result(payload)
            result["isError"] = True
            return {"jsonrpc": "2.0", "id": request_id, "result": result}
    if request_id is None:
        return None
    return {"jsonrpc": "2.0", "id": request_id, "error": {"code": -32601, "message": f"method not found: {method}"}}


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Lightweight freshness-gated code-intelligence MCP gateway.")
    parser.add_argument("--host", choices=("codex", "claude"), required=True)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    gateway = Gateway(args.host)
    try:
        for line in sys.stdin:
            if not line.strip():
                continue
            try:
                request = json.loads(line)
                response = _handle(gateway, request)
            except Exception as error:
                response = {"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": str(error)}}
            if response is not None:
                print(json.dumps(response, ensure_ascii=False, separators=(",", ":")), flush=True)
    finally:
        gateway.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
