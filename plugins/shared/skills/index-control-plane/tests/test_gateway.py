from __future__ import annotations

import json
import importlib.util
import os
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


GATEWAY = Path(__file__).parents[1] / "scripts" / "gateway.py"
SPEC = importlib.util.spec_from_file_location("index_gateway", GATEWAY)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"Cannot load {GATEWAY}")
gateway_module = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = gateway_module
SPEC.loader.exec_module(gateway_module)


def run_gateway(requests: list[dict], *, env: dict[str, str] | None = None) -> list[dict]:
    command = [sys.executable, str(GATEWAY), "--host", "codex"]
    payload = "".join(json.dumps(request) + "\n" for request in requests)
    completed = subprocess.run(
        command,
        input=payload,
        capture_output=True,
        text=True,
        encoding="utf-8",
        env={**os.environ, **(env or {})},
        timeout=10,
    )
    if completed.returncode != 0:
        return [{"gateway_process_error": completed.stderr.strip(), "returncode": completed.returncode}]
    return [json.loads(line) for line in completed.stdout.splitlines() if line.strip()]


def fake_controller(path: Path, route: dict) -> None:
    path.write_text(
        "from __future__ import annotations\n"
        "import json, os, sys\n"
        f"ROUTE = {route!r}\n"
        "command = sys.argv[1] if len(sys.argv) > 1 else ''\n"
        "if command == 'route':\n"
        "    print(json.dumps(ROUTE))\n"
        "elif command == 'consumer-ready':\n"
        "    print(json.dumps({'status':'READY','generation':ROUTE['generation'],'source_state_id':ROUTE['source_state_id']}))\n"
        "elif command == 'consumer-stale':\n"
        "    print(json.dumps({'status':'STALE'}))\n"
        "else:\n"
        "    print(json.dumps({'error':'unsupported fake command'})); sys.exit(2)\n",
        encoding="utf-8",
    )


def stateful_graph_controller(path: Path, route: dict, marker: Path) -> None:
    path.write_text(
        "from __future__ import annotations\n"
        "import json, pathlib, sys\n"
        f"ROUTE = {route!r}\n"
        f"MARKER = pathlib.Path({str(marker)!r})\n"
        "command = sys.argv[1] if len(sys.argv) > 1 else ''\n"
        "if command == 'route':\n"
        "    if MARKER.exists() and 'ready' in MARKER.read_text(encoding='utf-8').splitlines():\n"
        "        graph = ROUTE['providers']['graphify']; graph['usable'] = True; graph['consumer_ready'] = True; graph['consumer_generation'] = ROUTE['generation']; graph['status'] = 'READY'\n"
        "    print(json.dumps(ROUTE))\n"
        "elif command == 'consumer-ready':\n"
        "    with MARKER.open('a', encoding='utf-8') as stream: stream.write('ready\\n')\n"
        "    print(json.dumps({'status':'READY','generation':ROUTE['generation'],'source_state_id':ROUTE['source_state_id']}))\n"
        "elif command == 'consumer-stale':\n"
        "    with MARKER.open('a', encoding='utf-8') as stream: stream.write('stale\\n')\n"
        "    print(json.dumps({'status':'STALE'}))\n"
        "else:\n"
        "    print(json.dumps({'error':'unsupported fake command'})); sys.exit(2)\n",
        encoding="utf-8",
    )


class GatewayProtocolTests(unittest.TestCase):
    def test_exact_search_limit_is_independent_from_rg_emission_order(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()

            def record(path: str, line: int) -> str:
                return json.dumps({
                    "type": "match",
                    "data": {
                        "path": {"text": path},
                        "line_number": line,
                        "lines": {"text": f"match in {path}\n"},
                    },
                })

            first_order = "\n".join([record("b.py", 2), record("a.py", 1)])
            second_order = "\n".join([record("a.py", 1), record("b.py", 2)])
            executions = [
                subprocess.CompletedProcess(["rg"], 0, first_order, ""),
                subprocess.CompletedProcess(["rg"], 0, second_order, ""),
            ]

            with mock.patch.object(gateway_module.shutil, "which", return_value="rg"), mock.patch.object(
                gateway_module, "_run", side_effect=executions
            ):
                first, _ = gateway_module.Gateway.exact_search(root, "match", 1)
                second, _ = gateway_module.Gateway.exact_search(root, "match", 1)

            self.assertEqual(first, second)
            self.assertEqual(first[0]["path"], "a.py")

    def test_route_cache_remains_valid_until_source_observation_ttl(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            cached = {
                "root": str(root),
                "source_state_id": "sha256:ttl",
                "generation": 8,
                "source_observation_age_seconds": 1.0,
                "source_observation_ttl_seconds": 75.0,
                "source_observation_fresh": True,
                "providers": {"ccc": {"usable": False}},
            }
            gateway = gateway_module.Gateway("codex")
            gateway.route_cache[str(root).lower()] = (gateway_module.time.monotonic() - 6.0, cached)
            gateway.in_process_route = mock.Mock(side_effect=AssertionError("fresh TTL cache was recomputed"))

            result = gateway.route(root)

            self.assertEqual(result["source_state_id"], "sha256:ttl")
            gateway.in_process_route.assert_not_called()

    def test_default_route_is_computed_in_process_without_python_spawn(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            expected = {
                "root": str(root),
                "source_state_id": "sha256:fast",
                "generation": 7,
                "source_observation_fresh": True,
                "providers": {"ccc": {"usable": False}},
            }
            gateway = gateway_module.Gateway("codex")
            gateway.in_process_route = mock.Mock(return_value=expected)

            with mock.patch.object(
                gateway_module,
                "_run",
                side_effect=AssertionError("default route spawned a Python subprocess"),
            ):
                result = gateway.route(root)

            self.assertEqual(result["source_state_id"], "sha256:fast")
            gateway.in_process_route.assert_called_once_with(root, host="codex", verify_expired=True)

    def test_ccc_search_exposes_structured_source_locations(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            gateway = gateway_module.Gateway("codex")
            gateway.route = mock.Mock(return_value={
                "source_state_id": "sha256:ccc",
                "generation": 4,
                "providers": {"ccc": {"usable": True, "artifact_generation": 4, "consumer_generation": 4}},
            })
            output = (
                "--- Result 1 (score: 0.9) ---\n"
                "File: src/invoice.ts:12-18 [typescript]\n"
                "first result\n"
                "--- Result 2 (score: 0.8) ---\n"
                "File: C:\\outside\\helper.py:7 [python]\n"
                "second result\n"
            )

            with mock.patch.object(
                gateway_module,
                "_run",
                return_value=subprocess.CompletedProcess(["ccc"], 0, output, ""),
            ):
                result = gateway.search({"root": str(root), "query": "invoice", "limit": 2})

            self.assertEqual(
                result["sources"],
                [
                    {"path": "src/invoice.ts", "line": 12, "end_line": 18},
                    {"path": "C:/outside/helper.py", "line": 7},
                ],
            )

    def test_ccc_search_relies_on_native_daemon_lifecycle_without_local_lease(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            gateway = gateway_module.Gateway("codex")
            gateway.route = mock.Mock(return_value={
                "source_state_id": "sha256:ccc",
                "generation": 6,
                "providers": {"ccc": {"usable": True, "artifact_generation": 6, "consumer_generation": 6}},
            })

            with mock.patch.object(
                gateway_module,
                "_run",
                return_value=subprocess.CompletedProcess(
                    ["ccc"], 0, "File: src/native.py:1 [python]\n", ""
                ),
            ):
                result = gateway.search({"root": str(root), "query": "native lifecycle", "limit": 1})

            self.assertEqual(result["provider"], "ccc")
            self.assertFalse(hasattr(gateway, "ccc_lease_file"))
            self.assertFalse(hasattr(gateway, "ccc_activity_dir"))

    def test_cold_ccc_search_falls_back_and_starts_one_bounded_warmup(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            gateway = gateway_module.Gateway("codex")
            gateway.route = mock.Mock(return_value={
                "source_state_id": "sha256:ccc",
                "generation": 6,
                "providers": {"ccc": {"usable": True, "artifact_generation": 6, "consumer_generation": 6}},
            })
            gateway.exact_search = mock.Mock(return_value=([{"path": "src/fallback.py", "line": 1}], [{"path": "src/fallback.py", "line": 1}]))

            with mock.patch.object(gateway_module, "_run", side_effect=subprocess.TimeoutExpired(["ccc"], 2.0)), mock.patch.object(
                gateway_module.shutil, "which", return_value="ccc"
            ), mock.patch.object(gateway_module.subprocess, "Popen") as popen:
                first = gateway.search({"root": str(root), "query": "cold concept", "limit": 1})
                second = gateway.search({"root": str(root), "query": "cold concept", "limit": 1})

            self.assertEqual(first["provider"], "source")
            self.assertTrue(first["fallback_used"])
            self.assertEqual(second["provider"], "source")
            popen.assert_called_once()
            self.assertEqual(popen.call_args.args[0][1:3], ["search", "--limit"])

    def test_ccc_warmup_launch_failure_does_not_break_source_fallback(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            gateway = gateway_module.Gateway("codex")
            gateway.route = mock.Mock(return_value={
                "source_state_id": "sha256:ccc",
                "generation": 6,
                "providers": {"ccc": {"usable": True, "artifact_generation": 6, "consumer_generation": 6}},
            })
            gateway.exact_search = mock.Mock(return_value=([], []))

            with mock.patch.object(gateway_module, "_run", side_effect=subprocess.TimeoutExpired(["ccc"], 2.0)), mock.patch.object(
                gateway_module.shutil, "which", return_value="ccc"
            ), mock.patch.object(gateway_module.subprocess, "Popen", side_effect=OSError("launch failed")):
                result = gateway.search({"root": str(root), "query": "cold concept", "limit": 1})

            self.assertEqual(result["provider"], "source")
            self.assertTrue(result["fallback_used"])

    def test_stale_status_wakes_the_reconcile_worker_without_blocking(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            repo = base / "repo"
            repo.mkdir()
            controller = base / "fake_controller.py"
            marker = base / "launcher.json"
            launcher = base / "fake_launcher.py"
            route = {
                "root": str(repo), "source_state_id": "sha256:stale", "generation": 8,
                "source_observation_fresh": False,
                "providers": {"ccc": {"usable": False}, "graphify": {"usable": False}, "semctx": {"usable": False}},
            }
            fake_controller(controller, route)
            launcher.write_text(
                "import json, pathlib, sys\n"
                f"pathlib.Path({str(marker)!r}).write_text(json.dumps(sys.argv[1:]), encoding='utf-8')\n",
                encoding="utf-8",
            )

            responses = run_gateway(
                [
                    {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}},
                    {"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": "status", "arguments": {"root": str(repo)}}},
                ],
                env={
                    "INDEX_CONTROL_GATEWAY_CONTROLLER": str(controller),
                    "INDEX_CONTROL_GATEWAY_PYTHON": sys.executable,
                    "INDEX_CONTROL_GATEWAY_LAUNCHER": str(launcher),
                    "INDEX_CONTROL_GATEWAY_WORKER": str(controller),
                    "INDEX_CONTROL_GATEWAY_STDERR": str(base / "worker.stderr.log"),
                },
            )

            result = responses[1]["result"]["structuredContent"]
            self.assertEqual(result["freshness"], "STALE")
            self.assertTrue(result["refresh_scheduled"])
            launch_args = json.loads(marker.read_text(encoding="utf-8"))
            self.assertIn("--mode", launch_args)
            self.assertIn("worker", launch_args)
            self.assertIn(str(repo.resolve()), launch_args)

    def test_initialize_and_tools_list_expose_the_stable_contract(self) -> None:
        responses = run_gateway(
            [
                {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18"}},
                {"jsonrpc": "2.0", "method": "notifications/initialized", "params": {}},
                {"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}},
            ]
        )

        self.assertEqual(responses[0]["result"]["serverInfo"]["name"], "index-intelligence-gateway")
        self.assertEqual(responses[0]["result"]["protocolVersion"], "2025-06-18")
        names = [tool["name"] for tool in responses[1]["result"]["tools"]]
        self.assertEqual(names, ["status", "search", "symbols", "architecture", "intent"])

    def test_status_returns_the_generation_envelope(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            repo = base / "repo"
            repo.mkdir()
            controller = base / "fake_controller.py"
            route = {
                "root": str(repo),
                "source_state_id": "sha256:current",
                "generation": 9,
                "source_observation_fresh": True,
                "providers": {
                    "ccc": {"usable": True, "artifact_generation": 9, "consumer_generation": None},
                    "graphify": {"usable": False, "artifact_generation": 8, "consumer_generation": None},
                    "semctx": {"usable": False, "artifact_generation": 7, "consumer_generation": None},
                },
            }
            fake_controller(controller, route)

            responses = run_gateway(
                [
                    {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}},
                    {"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": "status", "arguments": {"root": str(repo)}}},
                ],
                env={"INDEX_CONTROL_GATEWAY_CONTROLLER": str(controller), "INDEX_CONTROL_GATEWAY_PYTHON": sys.executable},
            )

            result = responses[1]["result"]["structuredContent"]
            self.assertEqual(result["provider"], "control-plane")
            self.assertEqual(result["source_state_id"], "sha256:current")
            self.assertEqual(result["artifact_generation"], 9)
            self.assertEqual(result["freshness"], "READY")
            self.assertFalse(result["fallback_used"])
            self.assertEqual(result["sources"], [])

    def test_search_falls_back_to_exact_source_when_ccc_is_not_usable(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            repo = base / "repo"
            repo.mkdir()
            (repo / "service.py").write_text("def calculate_invoice_total():\n    return 42\n", encoding="utf-8")
            controller = base / "fake_controller.py"
            route = {
                "root": str(repo),
                "source_state_id": "sha256:fallback",
                "generation": 3,
                "source_observation_fresh": True,
                "providers": {
                    "ccc": {"usable": False, "artifact_generation": 2, "consumer_generation": None},
                    "graphify": {"usable": False, "artifact_generation": None, "consumer_generation": None},
                    "semctx": {"usable": False, "artifact_generation": None, "consumer_generation": None},
                },
            }
            fake_controller(controller, route)

            responses = run_gateway(
                [
                    {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}},
                    {"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": "search", "arguments": {"root": str(repo), "query": "calculate_invoice_total"}}},
                ],
                env={"INDEX_CONTROL_GATEWAY_CONTROLLER": str(controller), "INDEX_CONTROL_GATEWAY_PYTHON": sys.executable},
            )

            result = responses[1]["result"]["structuredContent"]
            self.assertEqual(result["provider"], "source")
            self.assertTrue(result["fallback_used"])
            self.assertEqual(result["freshness"], "SOURCE_CURRENT")
            self.assertEqual(result["sources"][0]["path"], "service.py")
            self.assertIn("calculate_invoice_total", result["matches"][0]["text"])

    def test_symbols_returns_source_locations_without_starting_a_daemon(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            repo = base / "repo"
            repo.mkdir()
            (repo / "service.py").write_text(
                "def calculate_total():\n    return 42\n\nresult = calculate_total()\n",
                encoding="utf-8",
            )
            controller = base / "fake_controller.py"
            route = {
                "root": str(repo), "source_state_id": "sha256:symbol", "generation": 4,
                "source_observation_fresh": True,
                "providers": {"ccc": {"usable": False}, "graphify": {"usable": False}, "semctx": {"usable": False}},
            }
            fake_controller(controller, route)

            responses = run_gateway(
                [
                    {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}},
                    {"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": "symbols", "arguments": {"root": str(repo), "symbol": "calculate_total"}}},
                ],
                env={"INDEX_CONTROL_GATEWAY_CONTROLLER": str(controller), "INDEX_CONTROL_GATEWAY_PYTHON": sys.executable},
            )

            result = responses[1]["result"]["structuredContent"]
            self.assertEqual(result["provider"], "source")
            self.assertEqual(result["recommended_lane"], "source-exact")
            self.assertEqual(result["semantic_capability"], "textual")
            self.assertEqual(result["freshness"], "SOURCE_CURRENT")
            self.assertTrue(result["fallback_used"])
            self.assertEqual([item["line"] for item in result["sources"]], [1, 4])

    def test_architecture_loads_exact_artifact_before_acknowledging_consumer(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            repo = base / "repo"
            repo.mkdir()
            graph = base / "graph.json"
            graph.write_text("the gateway must not load the full graph", encoding="utf-8")
            query_index = base / "query.sqlite"
            connection = sqlite3.connect(query_index)
            try:
                connection.executescript(
                    """
                    CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                    CREATE VIRTUAL TABLE nodes_fts USING fts5(id UNINDEXED, search_text, payload UNINDEXED);
                    CREATE TABLE edges (source TEXT NOT NULL, target TEXT NOT NULL, payload TEXT NOT NULL);
                    CREATE INDEX edges_source ON edges(source);
                    CREATE INDEX edges_target ON edges(target);
                    """
                )
                connection.execute("INSERT INTO metadata VALUES (?, ?)", ("graph_sha256", "sha256:test"))
                connection.executemany(
                    "INSERT INTO nodes_fts(id, search_text, payload) VALUES (?, ?, ?)",
                    [
                        ("invoice", "invoice invoiceservice src invoice py", json.dumps({"id": "invoice", "name": "InvoiceService", "file": "src/invoice.py"})),
                        ("repo", "repo invoicerepository src repository py", json.dumps({"id": "repo", "name": "InvoiceRepository", "path": "src/repository.py"})),
                    ],
                )
                connection.execute(
                    "INSERT INTO edges VALUES (?, ?, ?)",
                    ("invoice", "repo", json.dumps({"source": "invoice", "target": "repo", "type": "USES"})),
                )
                connection.commit()
            finally:
                connection.close()
            marker = base / "consumer-ready.marker"
            controller = base / "fake_controller.py"
            route = {
                "root": str(repo), "source_state_id": "sha256:graph", "generation": 11,
                "source_observation_fresh": True,
                "providers": {
                    "ccc": {"usable": False},
                    "graphify": {"usable": False, "artifact_ready": True, "artifact_generation": 11, "consumer_ready": False, "consumer_generation": None, "status": "ARTIFACT_READY", "graph_path": str(graph), "query_index_path": str(query_index), "graph_sha256": "sha256:test"},
                    "semctx": {"usable": False},
                },
            }
            stateful_graph_controller(controller, route, marker)

            responses = run_gateway(
                [
                    {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}},
                    {"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": "architecture", "arguments": {"root": str(repo), "query": "InvoiceService"}}},
                ],
                env={"INDEX_CONTROL_GATEWAY_CONTROLLER": str(controller), "INDEX_CONTROL_GATEWAY_PYTHON": sys.executable},
            )

            result = responses[1]["result"]["structuredContent"]
            self.assertEqual(marker.read_text(encoding="utf-8").splitlines(), ["ready", "stale"])
            self.assertEqual(result["provider"], "graphify")
            self.assertEqual(result["consumer_generation"], 11)
            self.assertEqual(result["freshness"], "READY")
            self.assertFalse(result["fallback_used"])
            self.assertEqual(result["sources"][0]["path"], "src/invoice.py")
            self.assertEqual(result["nodes"][0]["name"], "InvoiceService")

    def test_architecture_query_index_rejects_a_different_graph_digest(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            query_index = Path(tmp) / "query.sqlite"
            connection = sqlite3.connect(query_index)
            try:
                connection.executescript(
                    """
                    CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                    CREATE VIRTUAL TABLE nodes_fts USING fts5(id UNINDEXED, search_text, payload UNINDEXED);
                    CREATE TABLE edges (source TEXT NOT NULL, target TEXT NOT NULL, payload TEXT NOT NULL);
                    """
                )
                connection.execute("INSERT INTO metadata VALUES (?, ?)", ("graph_sha256", "sha256:actual"))
                connection.commit()
            finally:
                connection.close()

            with self.assertRaisesRegex(RuntimeError, "does not match"):
                gateway_module.Gateway._query_graph_index(
                    query_index,
                    "invoice",
                    10,
                    "sha256:routed",
                )

    def test_intent_uses_semctx_only_when_the_sealed_provider_is_usable(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            repo = base / "repo"
            repo.mkdir()
            controller = base / "fake_controller.py"
            semctx = base / "fake_semctx.py"
            semctx.write_text(
                "import json\nprint(json.dumps({'matches':[{'kind':'invariant','text':'Invoices are tenant scoped'}],'sources':[{'path':'docs/invariants.md','line':12}]}))\n",
                encoding="utf-8",
            )
            route = {
                "root": str(repo), "source_state_id": "sha256:intent", "generation": 6,
                "source_observation_fresh": True,
                "providers": {
                    "ccc": {"usable": False}, "graphify": {"usable": False},
                    "semctx": {"usable": True, "artifact_generation": 6, "consumer_generation": None},
                },
            }
            fake_controller(controller, route)

            responses = run_gateway(
                [
                    {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}},
                    {"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": "intent", "arguments": {"root": str(repo), "query": "tenant scope"}}},
                ],
                env={
                    "INDEX_CONTROL_GATEWAY_CONTROLLER": str(controller),
                    "INDEX_CONTROL_GATEWAY_PYTHON": sys.executable,
                    "INDEX_CONTROL_GATEWAY_SEMCTX": str(semctx),
                },
            )

            result = responses[1]["result"]["structuredContent"]
            self.assertEqual(result["provider"], "semctx")
            self.assertEqual(result["freshness"], "READY")
            self.assertFalse(result["fallback_used"])
            self.assertEqual(result["sources"], [{"path": "docs/invariants.md", "line": 12}])


    def test_status_exposes_the_observation_axis(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            repo = base / "repo"
            repo.mkdir()
            controller = base / "fake_controller.py"
            route = {
                "root": str(repo), "source_state_id": "sha256:axis", "generation": 12,
                "source_observation_fresh": True,
                "source_observation_age_seconds": 3.5,
                "source_observation_ttl_seconds": 75.0,
                # "observed", not "verified_live": the latter deliberately wakes
                # a detached worker, which is not what this test is about.
                "source_observation_mode": "observed",
                "host_dirty_generation_acknowledged": True,
                "providers": {"ccc": {"usable": True}, "graphify": {"usable": False}, "semctx": {"usable": False}},
            }
            fake_controller(controller, route)

            responses = run_gateway(
                [
                    {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}},
                    {"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": "status", "arguments": {"root": str(repo)}}},
                ],
                env={
                    "INDEX_CONTROL_GATEWAY_CONTROLLER": str(controller),
                    "INDEX_CONTROL_GATEWAY_PYTHON": sys.executable,
                },
            )

            result = responses[1]["result"]["structuredContent"]
            # A caller must be able to separate a cold cache from real staleness
            # without guessing; freshness alone collapses both to one boolean.
            self.assertEqual(result["source_observation_age_seconds"], 3.5)
            self.assertEqual(result["source_observation_ttl_seconds"], 75.0)
            self.assertTrue(result["source_observation_fresh"])
            self.assertEqual(result["source_observation_mode"], "observed")
            self.assertTrue(result["host_dirty_generation_acknowledged"])
            self.assertEqual(result["freshness"], "READY")

    def test_gateway_wake_memo_expires_and_rewakes_a_dead_worker(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp).resolve()
            gateway = gateway_module.Gateway("claude")
            launches = 0

            def fake_run(*args, **kwargs):
                nonlocal launches
                launches += 1
                return subprocess.CompletedProcess(args=[], returncode=0, stdout="", stderr="")

            with mock.patch.object(gateway_module, "_run", side_effect=fake_run):
                self.assertTrue(gateway.wake_worker(repo))
                self.assertTrue(gateway.wake_worker(repo))
                self.assertEqual(launches, 1)
                # Past the lease, a worker that died in the meantime must be
                # relaunched instead of the memo reporting a phantom wake.
                gateway.refresh_scheduled[str(repo)] = (
                    gateway_module.time.monotonic() - gateway_module.WAKE_LEASE_SECONDS - 1.0
                )
                self.assertTrue(gateway.wake_worker(repo))
                self.assertEqual(launches, 2)

    def _intent_layer_case(self, base: Path, repo: Path, symbol_payload: str) -> dict:
        controller = base / "fake_controller.py"
        semctx = base / "fake_semctx.py"
        # Branches on the inspect kind, like the real CLI: an unauthored
        # semantic layer answers `capability` with an empty envelope.
        semctx.write_text(
            "import json, sys\n"
            "kind = sys.argv[4]\n"
            "EMPTY = {'matchedNodes': [], 'relatedClaims': [], 'relations': [], 'evidence': [], 'filesToRead': []}\n"
            f"SYMBOL = {symbol_payload}\n"
            "print(json.dumps(SYMBOL if kind == 'symbol' else EMPTY))\n",
            encoding="utf-8",
        )
        route = {
            "root": str(repo), "source_state_id": "sha256:layer", "generation": 6,
            "source_observation_fresh": True,
            "providers": {
                "ccc": {"usable": False}, "graphify": {"usable": False},
                "semctx": {"usable": True, "artifact_generation": 6, "consumer_generation": None},
            },
        }
        fake_controller(controller, route)
        responses = run_gateway(
            [
                {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}},
                {"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": "intent", "arguments": {"root": str(repo), "query": "LeaseRepository"}}},
            ],
            env={
                "INDEX_CONTROL_GATEWAY_CONTROLLER": str(controller),
                "INDEX_CONTROL_GATEWAY_PYTHON": sys.executable,
                "INDEX_CONTROL_GATEWAY_SEMCTX": str(semctx),
            },
        )
        return responses[1]["result"]["structuredContent"]

    def test_intent_falls_back_to_symbols_when_the_semantic_layer_is_not_authored(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            repo = base / "repo"
            repo.mkdir()
            result = self._intent_layer_case(
                base,
                repo,
                "{'matchedNodes': [{'name': 'LeaseRepository', 'filePath': 'src/lease.ts'}], 'sources': [{'path': 'src/lease.ts'}]}",
            )

            self.assertEqual(result["provider"], "semctx")
            self.assertEqual(result["intent_layer"], "extracted_symbol")
            self.assertEqual(result["reason"], "SEMANTIC_LAYER_NOT_AUTHORED")
            # The caller must be told this is extracted structure, not authored
            # intent, so it never reads the answer as "no invariants exist".
            self.assertTrue(result["fallback_used"])
            self.assertEqual(result["result"]["matchedNodes"][0]["name"], "LeaseRepository")

    def test_intent_never_serves_an_empty_authored_layer_as_authoritative(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            repo = base / "repo"
            repo.mkdir()
            (repo / "lease.ts").write_text("export class LeaseRepository {}\n", encoding="utf-8")
            result = self._intent_layer_case(base, repo, "dict(EMPTY)")

            self.assertTrue(result["fallback_used"])
            self.assertNotEqual(result.get("intent_layer"), "authored_capability")
            self.assertEqual(result["reason"], "SEMCTX_HAS_NO_MATCH")


if __name__ == "__main__":
    unittest.main()
