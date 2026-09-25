from __future__ import annotations

import contextlib
import importlib.util
import hashlib
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any
from unittest import mock


SCRIPT_DIR = Path(__file__).parents[1] / "scripts"
CONTROL_SCRIPT = SCRIPT_DIR / "index_control.py"
WORKER_SCRIPT = SCRIPT_DIR / "reconcile_worker.py"


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


index_control = load_module("index_control", CONTROL_SCRIPT)
reconcile_worker = load_module("reconcile_worker", WORKER_SCRIPT)


def write_graphify_fixture(
    output_root: Path,
    payload: dict,
    manifest: dict[str, dict] | None = None,
    *,
    status: str = "REBUILT",
) -> index_control.CommandResult:
    graph = output_root / "graphify-out" / "graph.json"
    graph.parent.mkdir(parents=True, exist_ok=True)
    encoded = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    graph.write_bytes(encoded)
    (graph.parent / "manifest.json").write_text(
        json.dumps(manifest or {"main.py": {}}), encoding="utf-8"
    )
    connection = sqlite3.connect(graph.parent / "query.sqlite")
    try:
        connection.execute("CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
        connection.execute(
            "INSERT INTO metadata VALUES (?, ?)",
            ("graph_sha256", f"sha256:{hashlib.sha256(encoded).hexdigest()}"),
        )
        connection.commit()
    finally:
        connection.close()
    return index_control.CommandResult(
        0,
        json.dumps(
            {
                "status": status,
                "graph_sha256": f"sha256:{hashlib.sha256(encoded).hexdigest()}",
                "query_index": "query.sqlite",
            }
        ),
        "",
        0.1,
    )


def git(repo: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", *args],
        cwd=repo,
        check=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    return result.stdout.strip()


def write_test_admission(home: Path) -> None:
    admission = home / ".agents" / "index-control-plane" / "admission.json"
    admission.parent.mkdir(parents=True, exist_ok=True)
    admission.write_text(
        json.dumps(
            {
                "schema_version": 1,
                "denylist_roots": [],
                "denylist_path_fragments": [],
                "vendor_dir_names": ["node_modules", ".venv", "vendor", "dist", "build"],
                "structural_extension_exclusions": [],
                "graphify": {"min_code_files": 1},
            }
        ),
        encoding="utf-8",
    )


class RepositoryFixture:
    def __init__(self, root: Path, *, providers: tuple[str, ...] = (), with_code: bool = True) -> None:
        self.root = root
        write_test_admission(root.parent)
        git(root, "init", "-q")
        git(root, "config", "user.email", "index-worker@example.invalid")
        git(root, "config", "user.name", "Index Worker Test")
        source = root / ("main.py" if with_code else "README.md")
        source.write_text("def one():\n    return 1\n" if with_code else "# Notes\n", encoding="utf-8")
        (root / ".gitignore").write_text(
            ".cocoindex_code/\n.semctx/*.db*\ngraphify-out/\n",
            encoding="utf-8",
        )
        if "ccc" in providers:
            settings = root / ".cocoindex_code" / "settings.yml"
            settings.parent.mkdir()
            settings.write_text("include_patterns: ['**/*.py']\n", encoding="utf-8")
        if "semctx" in providers:
            semctx = root / ".semctx"
            semctx.mkdir()
            (semctx / "config.json").write_text('{"version":1}\n', encoding="utf-8")
        git(root, "add", ".gitignore", source.name)
        if "semctx" in providers:
            git(root, "add", ".semctx/config.json")
        git(root, "commit", "-qm", "initial")


class SourceFingerprintTests(unittest.TestCase):
    def test_provider_corpus_fingerprints_ignore_unrelated_files(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            RepositoryFixture(repo, providers=("ccc", "semctx"))
            first = index_control.fingerprint_repository(repo)

            (repo / "README.md").write_text("# Changed documentation\n", encoding="utf-8")
            second = index_control.fingerprint_repository(repo)

            self.assertNotEqual(first["state_id"], second["state_id"])
            self.assertEqual(
                first["provider_corpus_state_ids"]["graphify"],
                second["provider_corpus_state_ids"]["graphify"],
            )
            self.assertNotEqual(
                first["provider_corpus_state_ids"]["ccc"],
                second["provider_corpus_state_ids"]["ccc"],
            )
            self.assertNotEqual(
                first["provider_corpus_state_ids"]["semctx"],
                second["provider_corpus_state_ids"]["semctx"],
            )

    def test_tracked_generated_index_outputs_do_not_dirty_source_fingerprint(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            RepositoryFixture(repo)
            generated = repo / "graphify-out" / "graph.json"
            generated.parent.mkdir()
            generated.write_text('{"nodes":[]}\n', encoding="utf-8")
            git(repo, "add", "-f", "graphify-out/graph.json")
            git(repo, "commit", "-qm", "tracked generated graph")
            first = index_control.fingerprint_repository(repo)
            generated.write_text('{"nodes":[{"id":"changed"}]}\n', encoding="utf-8")
            second = index_control.fingerprint_repository(repo)
            self.assertEqual(first["state_id"], second["state_id"])
            (repo / "main.py").write_text("def two():\n    return 2\n", encoding="utf-8")
            third = index_control.fingerprint_repository(repo)
            self.assertNotEqual(second["state_id"], third["state_id"])

    def test_policy_change_changes_desired_state_fingerprint(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            repo = base / "repo"
            repo.mkdir()
            RepositoryFixture(repo)
            policy = base / ".agents" / "index-control-plane" / "policy.json"
            policy.parent.mkdir(parents=True, exist_ok=True)
            policy.write_text('{"reconcile_seconds":60}\n', encoding="utf-8")
            first = index_control.fingerprint_repository(repo, home=base)
            policy.write_text('{"reconcile_seconds":30}\n', encoding="utf-8")
            second = index_control.fingerprint_repository(repo, home=base)
            self.assertNotEqual(first["desired_state_hash"], second["desired_state_hash"])
            self.assertNotEqual(first["state_id"], second["state_id"])


class EventQueueTests(unittest.TestCase):
    def test_events_are_unique_atomic_and_shared_across_hosts(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            repo = base / "repo"
            repo.mkdir()
            RepositoryFixture(repo)
            first = index_control.enqueue_reconcile_event(
                "codex",
                repo,
                kind="source_mutated",
                reason="WRITE",
                home=base,
            )
            second = index_control.enqueue_reconcile_event(
                "claude",
                repo,
                kind="checkpoint",
                reason="STOP",
                home=base,
            )
            self.assertNotEqual(first, second)
            self.assertEqual(first.parent, second.parent)
            self.assertEqual(list(first.parent.glob("*.tmp")), [])
            payloads = [json.loads(path.read_text(encoding="utf-8")) for path in (first, second)]
            self.assertEqual({payload["host"] for payload in payloads}, {"codex", "claude"})


class SchedulerTests(unittest.TestCase):
    def test_provider_generation_is_carried_forward_when_its_corpus_is_unchanged(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            repo = base / "repo"
            repo.mkdir()
            RepositoryFixture(repo)
            worker = reconcile_worker.ReconcileWorker(repo, home=base)
            old_source = index_control.fingerprint_repository(repo, home=base)
            worker.state.update({"generation": 1, "source": old_source, "observed_source_state_id": old_source["state_id"]})
            worker.state["providers"] = {
                "graphify": {
                    "status": "READY",
                    "indexed_generation": 1,
                    "indexed_source_state_id": old_source["state_id"],
                    "indexed_corpus_state_id": old_source["provider_corpus_state_ids"]["graphify"],
                }
            }
            (repo / "README.md").write_text("documentation only\n", encoding="utf-8")
            new_source = index_control.fingerprint_repository(repo, home=base)
            worker.state.update({"generation": 2, "source": new_source, "observed_source_state_id": new_source["state_id"]})

            self.assertFalse(worker._provider_due("graphify", worker.policies["graphify"], new_source, 100.0))
            provider = worker.state["providers"]["graphify"]
            self.assertEqual(provider["indexed_generation"], 2)
            self.assertEqual(provider["indexed_source_state_id"], new_source["state_id"])
            self.assertTrue(provider["carried_forward"])

    def test_runtime_policy_allows_environment_idle_ttl_override(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            with mock.patch.dict(
                os.environ,
                {"INDEX_CONTROL_WORKER_IDLE_TTL_SECONDS": "42.5"},
            ):
                poll, reconcile, idle_ttl = reconcile_worker.load_runtime_policy(base)

            self.assertEqual(poll, reconcile_worker.DEFAULT_POLL_SECONDS)
            self.assertEqual(reconcile, reconcile_worker.DEFAULT_RECONCILE_SECONDS)
            self.assertEqual(idle_ttl, 42.5)

    def test_worker_loop_exits_after_settled_idle_ttl(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            repo = base / "repo"
            repo.mkdir()
            RepositoryFixture(repo)
            worker = reconcile_worker.ReconcileWorker(repo, home=base)
            source = {"state_id": "settled-source", "dirty": False}
            worker.state.update(
                {
                    "generation": 3,
                    "source": source,
                    "observed_source_state_id": source["state_id"],
                    "available_providers": {"ccc": False, "graphify": True, "semctx": False},
                    "providers": {
                        "graphify": {
                            "status": "READY",
                            "indexed_generation": 3,
                            "indexed_source_state_id": source["state_id"],
                        }
                    },
                }
            )

            def settled_cycle(*, now, force_reconcile):
                return worker.state

            worker.run_cycle = settled_cycle
            with (
                mock.patch.object(reconcile_worker.time, "monotonic", side_effect=(100.0, 106.0)),
                mock.patch.object(reconcile_worker.time, "sleep", return_value=None),
            ):
                self.assertEqual(
                    reconcile_worker._run_loop(
                        worker,
                        poll_seconds=0.25,
                        reconcile_seconds=60.0,
                        idle_ttl_seconds=5.0,
                    ),
                    0,
                )

            state = json.loads(worker.paths.worker_state.read_text(encoding="utf-8"))
            self.assertEqual(state["worker_exit_reason"], "IDLE_TTL_EXPIRED")
            self.assertEqual(state["worker_idle_ttl_seconds"], 5.0)
            self.assertIn("worker_heartbeat_at", state)
            self.assertIsNone(state["worker_pid"])

    def test_successful_cycle_clears_persisted_cycle_failure_metadata(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            repo = base / "repo"
            repo.mkdir()
            RepositoryFixture(repo, with_code=False)
            worker = reconcile_worker.ReconcileWorker(repo, home=base)
            worker.state.update({"consecutive_cycle_failures": 3, "last_cycle_error": "old"})

            self.assertEqual(reconcile_worker._run_loop(worker, 0.25, 5.0), 0)

            state = json.loads(worker.paths.worker_state.read_text(encoding="utf-8"))
            self.assertEqual(state["consecutive_cycle_failures"], 0)
            self.assertNotIn("last_cycle_error", state)

    def test_retry_and_debounce_keep_worker_lease_active(self) -> None:
        source = {"state_id": "pending-source", "dirty": True}
        base_state = {
            "generation": 4,
            "source": source,
            "available_providers": {"ccc": True, "graphify": False, "semctx": False},
            "providers": {"ccc": {"status": "STALE"}},
            "dirty_since_monotonic": 98.0,
        }
        policy = {"ccc": reconcile_worker.ProviderPolicy(quiet_seconds=8.0, checkpoint_required=False)}

        self.assertTrue(reconcile_worker._has_pending_work(base_state, policy, now=100.0))

        retry_state = json.loads(json.dumps(base_state))
        retry_state["providers"]["ccc"]["next_retry_at_monotonic"] = 150.0
        self.assertTrue(reconcile_worker._has_pending_work(retry_state, policy, now=100.0))

    def test_worker_loop_exits_when_repository_has_no_index_provider(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            repo = base / "repo"
            repo.mkdir()
            RepositoryFixture(repo, with_code=False)
            worker = reconcile_worker.ReconcileWorker(repo, home=base)

            with mock.patch.object(
                reconcile_worker.time,
                "sleep",
                side_effect=AssertionError("unsupported repositories must not keep an idle worker"),
            ):
                self.assertEqual(reconcile_worker._run_loop(worker, 0.25, 5.0), 0)

            state = json.loads(worker.paths.worker_state.read_text(encoding="utf-8"))
            self.assertEqual(state["overall_status"], "UNSUPPORTED")
            self.assertFalse(any(state["available_providers"].values()))

    def test_code_repository_gets_zero_setup_graphify_provider(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            repo = base / "repo"
            repo.mkdir()
            RepositoryFixture(repo)

            providers = index_control.discover_providers(repo, home=base)

            self.assertEqual(providers, {"ccc": False, "graphify": True, "semctx": False})
            self.assertFalse((repo / "graphify-out").exists())

    def _checkpointed_dirty_worker(self, base: Path, repo: Path):
        RepositoryFixture(repo, providers=("semctx",))
        (repo / "uncommitted.py").write_text("print('dirty')\n", encoding="utf-8")
        worker = reconcile_worker.ReconcileWorker(repo, home=base)
        source = index_control.fingerprint_repository(repo, home=base)
        self.assertTrue(source["dirty"])
        worker.state.update(
            {
                "generation": 7,
                "source": source,
                "observed_source_state_id": source["state_id"],
                "dirty_since_monotonic": 0.0,
                "checkpoint_generation": 7,
                "checkpoint_worktree_identity": reconcile_worker.worktree_identity(source),
                "checkpoint_host": "claude",
                "providers": {"semctx": {"status": "STALE", "reasons": [], "indexed_generation": None}},
            }
        )
        return worker, source

    def test_checkpoint_survives_a_generation_bumped_by_the_control_plane_itself(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            repo = base / "repo"
            repo.mkdir()
            worker, source = self._checkpointed_dirty_worker(base, repo)
            # Only desired_state_hash moves: this is what a controller upgrade
            # does to every repository at once, with no working-tree change.
            upgraded = dict(source)
            upgraded["desired_state_hash"] = "controller-2.6.0"
            upgraded["state_id"] = "sha256:bumped-by-controller-upgrade"
            worker.state.update({"generation": 8, "source": upgraded})

            self.assertTrue(worker._provider_due("semctx", worker.policies["semctx"], upgraded, 1000.0))
            self.assertNotEqual(
                worker.state["providers"]["semctx"].get("reasons"), ["WAITING_FOR_CHECKPOINT"]
            )

    def test_checkpoint_is_revoked_when_the_working_tree_actually_changes(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            repo = base / "repo"
            repo.mkdir()
            worker, _ = self._checkpointed_dirty_worker(base, repo)
            (repo / "uncommitted.py").write_text("print('edited after the seal')\n", encoding="utf-8")
            drifted = index_control.fingerprint_repository(repo, home=base)
            worker.state.update({"generation": 8, "source": drifted})

            self.assertFalse(worker._provider_due("semctx", worker.policies["semctx"], drifted, 1000.0))
            self.assertEqual(worker.state["providers"]["semctx"]["reasons"], ["WAITING_FOR_CHECKPOINT"])

    def test_unattributed_checkpoint_waits_instead_of_guessing_a_builder(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            repo = base / "repo"
            repo.mkdir()
            worker, source = self._checkpointed_dirty_worker(base, repo)
            # A grant recorded before builds were host-scoped carries no host.
            # Guessing one would stamp the shared store with an arbitrary host's
            # tool version, so the build waits for the next attributed checkpoint.
            worker.state.pop("checkpoint_host")

            self.assertFalse(worker._provider_due("semctx", worker.policies["semctx"], source, 1000.0))
            self.assertEqual(worker.state["providers"]["semctx"]["reasons"], ["WAITING_FOR_ATTRIBUTED_HOST"])
            state = {**worker.state, "available_providers": {"ccc": False, "graphify": False, "semctx": True}}
            # Waiting on an attribution is not pending work: the idle worker may exit.
            self.assertFalse(reconcile_worker._has_pending_work(state, worker.policies, now=1000.0))

    def test_observation_age_ignores_worker_heartbeat_without_reobservation(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            repo = base / "repo"
            repo.mkdir()
            RepositoryFixture(repo)
            worker = reconcile_worker.ReconcileWorker(
                repo,
                home=base,
                provider_executor=lambda provider, before, paths: {"status": "READY", "reasons": []},
            )
            stamps = iter(f"2026-01-01T00:00:{second:02d}+00:00" for second in range(60))
            with mock.patch.object(index_control, "utc_now", side_effect=lambda: next(stamps)):
                worker.run_cycle(now=100.0, force_reconcile=True)
                observed_after_reconcile = worker.state["source_observed_at"]
                heartbeats = []
                for tick in range(3):
                    # No events, no force: the cached source is reused, so the
                    # worktree is NOT re-fingerprinted on these cycles.
                    worker.run_cycle(now=102.0 + tick, force_reconcile=False)
                    heartbeats.append(worker.state["updated_at"])

            # updated_at keeps moving -- it is a liveness heartbeat...
            self.assertEqual(len(set(heartbeats)), 3)
            self.assertGreater(heartbeats[-1], observed_after_reconcile)
            # ...while the observation axis stays pinned to the last real
            # fingerprint. This is the ~60 s false-current window, closed.
            self.assertEqual(worker.state["source_observed_at"], observed_after_reconcile)

    def test_cycle_exception_does_not_refresh_the_source_observation(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            repo = base / "repo"
            repo.mkdir()
            RepositoryFixture(repo)
            worker = reconcile_worker.ReconcileWorker(repo, home=base)
            stale_observation = "2000-01-01T00:00:00+00:00"
            worker.state["source_observed_at"] = stale_observation
            calls = 0

            def flaky_cycle(*, now, force_reconcile):
                nonlocal calls
                calls += 1
                if calls == 1:
                    raise ValueError("Not a Git worktree (git rev-parse failed)")
                raise KeyboardInterrupt

            worker.run_cycle = flaky_cycle
            with mock.patch.object(reconcile_worker.time, "sleep", return_value=None):
                self.assertEqual(reconcile_worker._run_loop(worker, 0.25, 5.0), 0)

            state = json.loads(worker.paths.worker_state.read_text(encoding="utf-8"))
            self.assertEqual(state["overall_status"], "FAILED")
            # The backoff caps under the observation TTL, so a worker that cannot
            # fingerprint must not keep rejuvenating the observation and leaving
            # last-generation artefacts usable.
            self.assertEqual(state["source_observed_at"], stale_observation)
            self.assertNotEqual(state["updated_at"], stale_observation)

    def test_worker_loop_survives_a_transient_cycle_exception(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            repo = base / "repo"
            repo.mkdir()
            RepositoryFixture(repo)
            worker = reconcile_worker.ReconcileWorker(repo, home=base)
            calls = 0

            def flaky_cycle(*, now, force_reconcile):
                nonlocal calls
                calls += 1
                if calls == 1:
                    raise OSError("transient git failure")
                raise KeyboardInterrupt

            worker.run_cycle = flaky_cycle
            with mock.patch.object(reconcile_worker.time, "sleep", return_value=None):
                self.assertEqual(reconcile_worker._run_loop(worker, 0.25, 5.0), 0)
            self.assertEqual(calls, 2)
            state = json.loads(worker.paths.worker_state.read_text(encoding="utf-8"))
            self.assertEqual(state["overall_status"], "FAILED")
            self.assertIn("WORKER_CYCLE_EXCEPTION", state["reasons"])

    def test_coalesces_events_and_runs_cheap_providers_after_quiet_period(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            repo = base / "repo"
            repo.mkdir()
            RepositoryFixture(repo, providers=("ccc",))
            calls: list[str] = []

            def executor(provider, before, paths):
                calls.append(provider)
                return {"status": "READY", "reasons": [], "provider": provider}

            worker = reconcile_worker.ReconcileWorker(
                repo,
                home=base,
                clock=lambda: 100.0,
                provider_executor=executor,
                policies={
                    "ccc": reconcile_worker.ProviderPolicy(quiet_seconds=5, checkpoint_required=False),
                    "graphify": reconcile_worker.ProviderPolicy(quiet_seconds=20, checkpoint_required=False),
                    "semctx": reconcile_worker.ProviderPolicy(quiet_seconds=30, checkpoint_required=True),
                },
            )
            index_control.enqueue_reconcile_event("codex", repo, kind="source_mutated", home=base)
            index_control.enqueue_reconcile_event("codex", repo, kind="source_mutated", home=base)
            state = worker.run_cycle(now=100.0)
            self.assertEqual(state["generation"], 1)
            self.assertEqual(calls, [])
            state = worker.run_cycle(now=106.0)
            self.assertEqual(calls, ["ccc"])
            self.assertEqual(state["providers"]["ccc"]["indexed_generation"], 1)

    def test_semctx_waits_for_checkpoint_on_dirty_worktree(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            repo = base / "repo"
            repo.mkdir()
            RepositoryFixture(repo, providers=("semctx",))
            (repo / "main.py").write_text("def dirty():\n    return 2\n", encoding="utf-8")
            calls: list[str] = []

            def executor(provider, before, paths):
                calls.append(provider)
                return {"status": "READY", "reasons": []}

            worker = reconcile_worker.ReconcileWorker(
                repo,
                home=base,
                clock=lambda: 0.0,
                provider_executor=executor,
                policies={
                    "ccc": reconcile_worker.ProviderPolicy(quiet_seconds=0, checkpoint_required=False),
                    "graphify": reconcile_worker.ProviderPolicy(quiet_seconds=0, checkpoint_required=False),
                    "semctx": reconcile_worker.ProviderPolicy(quiet_seconds=10, checkpoint_required=True),
                },
            )
            index_control.enqueue_reconcile_event("claude", repo, kind="source_mutated", home=base)
            worker.run_cycle(now=20.0)
            self.assertEqual(calls, ["graphify"])
            index_control.enqueue_reconcile_event("claude", repo, kind="checkpoint", home=base)
            worker.run_cycle(now=21.0)
            worker.run_cycle(now=32.0)
            self.assertEqual(calls, ["graphify", "semctx"])

    def test_default_graphify_policy_requires_checkpoint_for_dirty_worktree(self) -> None:
        self.assertTrue(reconcile_worker.DEFAULT_POLICIES["graphify"].checkpoint_required)
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            repo = base / "repo"
            repo.mkdir()
            RepositoryFixture(repo)
            (repo / "main.py").write_text("def dirty():\n    return 4\n", encoding="utf-8")
            calls: list[str] = []

            def executor(provider, before, paths):
                calls.append(provider)
                return {"status": "READY", "reasons": []}

            worker = reconcile_worker.ReconcileWorker(
                repo,
                home=base,
                clock=lambda: 0.0,
                provider_executor=executor,
                policies={"graphify": reconcile_worker.DEFAULT_POLICIES["graphify"]},
            )
            index_control.enqueue_reconcile_event("codex", repo, kind="source_mutated", home=base)
            worker.run_cycle(now=30.0)
            self.assertEqual(calls, [])
            worker.run_cycle(now=51.0)
            self.assertEqual(worker.state["providers"]["graphify"]["reasons"], ["WAITING_FOR_CHECKPOINT"])

            index_control.enqueue_reconcile_event("codex", repo, kind="jit", home=base)
            worker.run_cycle(now=52.0)
            self.assertEqual(calls, ["graphify"])

    def test_architecture_jit_does_not_trigger_semctx_seal(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            repo = base / "repo"
            repo.mkdir()
            RepositoryFixture(repo, providers=("semctx",))
            (repo / "main.py").write_text("def dirty():\n    return 4\n", encoding="utf-8")
            calls: list[str] = []

            def executor(provider, before, paths):
                calls.append(provider)
                return {"status": "READY", "reasons": []}

            worker = reconcile_worker.ReconcileWorker(
                repo,
                home=base,
                provider_executor=executor,
                policies={"semctx": reconcile_worker.DEFAULT_POLICIES["semctx"]},
            )
            index_control.enqueue_reconcile_event("codex", repo, kind="source_mutated", home=base)
            worker.run_cycle(now=40.0)
            index_control.enqueue_reconcile_event("codex", repo, kind="jit", reason="ARCHITECTURE_REQUEST", home=base)
            worker.run_cycle(now=90.0)

            self.assertEqual(calls, [])
            self.assertEqual(worker.state["providers"]["semctx"]["reasons"], ["WAITING_FOR_CHECKPOINT"])

    def test_external_drift_is_found_by_periodic_reconciliation(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            repo = base / "repo"
            repo.mkdir()
            RepositoryFixture(repo, providers=("ccc",))
            worker = reconcile_worker.ReconcileWorker(repo, home=base)
            initial = worker.run_cycle(now=1.0, force_reconcile=True)
            initial_generation = initial["generation"]
            (repo / "main.py").write_text("def external():\n    return 3\n", encoding="utf-8")
            changed = worker.run_cycle(now=100.0, force_reconcile=True)
            self.assertEqual(changed["generation"], initial_generation + 1)
            self.assertIn("PERIODIC_RECONCILIATION_DRIFT", changed["reasons"])

    def test_session_start_without_source_change_does_not_create_a_generation(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            repo = base / "repo"
            repo.mkdir()
            RepositoryFixture(repo, providers=("ccc",))
            calls: list[str] = []

            def executor(provider, before, paths):
                calls.append(provider)
                return {"status": "READY", "reasons": []}

            policies = {
                "ccc": reconcile_worker.ProviderPolicy(quiet_seconds=0, checkpoint_required=False),
                "graphify": reconcile_worker.ProviderPolicy(0, False),
                "semctx": reconcile_worker.ProviderPolicy(0, True),
            }
            worker = reconcile_worker.ReconcileWorker(
                repo,
                home=base,
                provider_executor=executor,
                policies=policies,
            )
            index_control.enqueue_reconcile_event("codex", repo, kind="session_start", home=base)
            first = worker.run_cycle(now=1.0)
            self.assertEqual(first["generation"], 1)
            self.assertEqual(calls, ["ccc", "graphify"])
            index_control.enqueue_reconcile_event("claude", repo, kind="session_start", home=base)
            second = worker.run_cycle(now=2.0)
            self.assertEqual(second["generation"], 1)
            self.assertEqual(calls, ["ccc", "graphify"])

    def test_change_during_provider_run_discards_ready_result(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            repo = base / "repo"
            repo.mkdir()
            RepositoryFixture(repo, providers=("ccc",))

            def executor(provider, before, paths):
                (repo / "main.py").write_text("def raced():\n    return 4\n", encoding="utf-8")
                return {"status": "READY", "reasons": []}

            worker = reconcile_worker.ReconcileWorker(
                repo,
                home=base,
                provider_executor=executor,
                policies={
                    "ccc": reconcile_worker.ProviderPolicy(quiet_seconds=0, checkpoint_required=False),
                    "graphify": reconcile_worker.ProviderPolicy(quiet_seconds=0, checkpoint_required=False),
                    "semctx": reconcile_worker.ProviderPolicy(quiet_seconds=0, checkpoint_required=True),
                },
            )
            index_control.enqueue_reconcile_event("codex", repo, kind="session_start", home=base)
            state = worker.run_cycle(now=1.0)
            provider = state["providers"]["ccc"]
            self.assertEqual(provider["status"], "STALE")
            self.assertIn("SOURCE_CHANGED_DURING_PROVIDER_RUN", provider["reasons"])
            self.assertIsNone(provider.get("indexed_generation"))

    def test_change_during_second_provider_invalidates_first_provider_snapshot(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            repo = base / "repo"
            repo.mkdir()
            RepositoryFixture(repo, providers=("ccc",))
            graph = index_control.shared_state_paths(repo, home=base).providers / "graphify" / "graphify-out" / "graph.json"
            graph.parent.mkdir(parents=True)
            graph.write_text('{"nodes":[{"id":"main","source_file":"main.py"}],"edges":[]}\n', encoding="utf-8")
            (graph.parent / "manifest.json").write_text('{"main.py":{}}\n', encoding="utf-8")

            def executor(provider, before, paths):
                if provider == "graphify":
                    (repo / "main.py").write_text("def raced_again():\n    return 5\n", encoding="utf-8")
                return {"status": "READY", "reasons": []}

            worker = reconcile_worker.ReconcileWorker(
                repo,
                home=base,
                provider_executor=executor,
                policies={
                    "ccc": reconcile_worker.ProviderPolicy(0, False),
                    "graphify": reconcile_worker.ProviderPolicy(0, False),
                    "semctx": reconcile_worker.ProviderPolicy(0, True),
                },
            )
            index_control.enqueue_reconcile_event("codex", repo, kind="session_start", home=base)
            state = worker.run_cycle(now=1.0)
            self.assertEqual(state["generation"], 2)
            self.assertEqual(state["overall_status"], "STALE")
            self.assertIsNone(state["providers"]["ccc"].get("indexed_generation"))
            self.assertIsNone(state["providers"]["ccc"].get("indexed_source_state_id"))
            self.assertIsNone(state["providers"]["graphify"].get("indexed_generation"))

    def test_transient_failure_uses_capped_exponential_backoff(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            repo = base / "repo"
            repo.mkdir()
            RepositoryFixture(repo, providers=("ccc",))

            def executor(provider, before, paths):
                return {"status": "FAILED", "reasons": ["PROVIDER_TIMEOUT"], "failure_class": "transient"}

            worker = reconcile_worker.ReconcileWorker(
                repo,
                home=base,
                provider_executor=executor,
                policies={
                    "ccc": reconcile_worker.ProviderPolicy(
                        quiet_seconds=0,
                        checkpoint_required=False,
                        retry_base_seconds=10,
                        retry_max_seconds=25,
                    ),
                    "graphify": reconcile_worker.ProviderPolicy(0, False),
                    "semctx": reconcile_worker.ProviderPolicy(0, True),
                },
            )
            index_control.enqueue_reconcile_event("codex", repo, kind="session_start", home=base)
            state = worker.run_cycle(now=100.0)
            provider = state["providers"]["ccc"]
            self.assertEqual(provider["consecutive_failures"], 1)
            self.assertEqual(provider["next_retry_at_monotonic"], 110.0)
            worker.run_cycle(now=110.0)
            worker.run_cycle(now=130.0)
            provider = worker.state["providers"]["ccc"]
            self.assertLessEqual(provider["next_retry_at_monotonic"] - 130.0, 25.0)

    def test_deterministic_failure_waits_for_a_new_generation(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            repo = base / "repo"
            repo.mkdir()
            RepositoryFixture(repo, providers=("ccc",))
            calls: list[str] = []

            def executor(provider, before, paths):
                calls.append(provider)
                return {"status": "FAILED", "reasons": ["INVALID_OUTPUT"], "failure_class": "deterministic"}

            worker = reconcile_worker.ReconcileWorker(
                repo,
                home=base,
                provider_executor=executor,
                policies={
                    "ccc": reconcile_worker.ProviderPolicy(0, False),
                    "graphify": reconcile_worker.ProviderPolicy(0, False),
                    "semctx": reconcile_worker.ProviderPolicy(0, True),
                },
            )
            index_control.enqueue_reconcile_event("codex", repo, kind="session_start", home=base)
            worker.run_cycle(now=1.0)
            worker.run_cycle(now=2.0)
            self.assertEqual(calls, ["ccc", "graphify"])
            index_control.enqueue_reconcile_event("codex", repo, kind="source_mutated", home=base)
            worker.run_cycle(now=3.0)
            self.assertEqual(calls, ["ccc", "graphify", "ccc", "graphify"])


class ProviderExecutorTests(unittest.TestCase):
    def test_graph_coverage_uses_relative_paths_not_basenames(self) -> None:
        payload = {
            "nodes": [
                {"id": "a_index", "source_file": "a/index.ts"},
            ],
            "edges": [],
        }
        manifest = {"a/index.ts": {}, "b/index.ts": {}}
        expected, covered, ratio = reconcile_worker._graph_coverage(payload, manifest, Path("C:/repo"))
        self.assertEqual(expected, {"a/index.ts", "b/index.ts"})
        self.assertEqual(covered, {"a/index.ts"})
        self.assertEqual(ratio, 0.5)

    def test_initial_coverage_floor_tolerates_legitimate_zero_node_config_files(self) -> None:
        self.assertEqual(reconcile_worker._initial_coverage_floor({"main.py"}), 0.7)
        self.assertEqual(reconcile_worker._initial_coverage_floor({"a.py", "config.json"}), 0.5)
        self.assertEqual(reconcile_worker._initial_coverage_floor({f"file-{index}.json" for index in range(20)}), 0.3)

    def test_deferred_graphify_publish_keeps_active_artifact_until_commit(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            repo = base / "repo"
            repo.mkdir()
            RepositoryFixture(repo)
            paths = index_control.shared_state_paths(repo, home=base)
            active = paths.providers / "graphify" / "graphify-out" / "graph.json"
            active.parent.mkdir(parents=True)
            active.write_text('{"nodes":[{"id":"old","source_file":"main.py"}],"edges":[]}\n', encoding="utf-8")
            (active.parent / "manifest.json").write_text('{"main.py":{}}\n', encoding="utf-8")

            def runner(argv, cwd, env, timeout):
                output_root = Path(argv[argv.index("--output-root") + 1])
                return write_graphify_fixture(
                    output_root,
                    {"nodes": [{"id": "new", "source_file": "main.py"}], "edges": []},
                )

            result = reconcile_worker.execute_graphify(
                repo, paths, runner=runner, timeout_seconds=60, defer_publish=True
            )
            self.assertEqual(json.loads(active.read_text(encoding="utf-8"))["nodes"][0]["id"], "old")
            with mock.patch.object(
                reconcile_worker,
                "_atomic_copy",
                wraps=reconcile_worker._atomic_copy,
            ) as atomic_copy:
                published = reconcile_worker.publish_staged_graphify(result)
            self.assertTrue(published["published_atomically"])
            self.assertEqual(json.loads(active.read_text(encoding="utf-8"))["nodes"][0]["id"], "new")
            copied_targets = {call.args[1].name for call in atomic_copy.call_args_list}
            self.assertEqual(copied_targets, {"query.sqlite", "manifest.json", "graph.json"})

    def test_source_change_during_graphify_does_not_publish_staged_artifact(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            repo = base / "repo"
            repo.mkdir()
            RepositoryFixture(repo)
            paths = index_control.shared_state_paths(repo, home=base)
            active = paths.providers / "graphify" / "graphify-out" / "graph.json"
            active.parent.mkdir(parents=True)
            active.write_text('{"nodes":[{"id":"old","source_file":"main.py"}],"edges":[]}\n', encoding="utf-8")
            (active.parent / "manifest.json").write_text('{"main.py":{}}\n', encoding="utf-8")

            def runner(argv, cwd, env, timeout):
                output_root = Path(argv[argv.index("--output-root") + 1])
                result = write_graphify_fixture(
                    output_root,
                    {"nodes": [{"id": "new", "source_file": "main.py"}], "edges": []},
                )
                (repo / "main.py").write_text("def changed_during_build():\n    return 9\n", encoding="utf-8")
                return result

            worker = reconcile_worker.ReconcileWorker(
                repo,
                home=base,
                runner=runner,
                policies={
                    "ccc": reconcile_worker.ProviderPolicy(0, False),
                    "graphify": reconcile_worker.ProviderPolicy(0, False),
                    "semctx": reconcile_worker.ProviderPolicy(0, True),
                },
            )
            index_control.enqueue_reconcile_event("codex", repo, kind="session_start", home=base)
            state = worker.run_cycle(now=1.0)
            self.assertEqual(state["overall_status"], "STALE")
            self.assertEqual(json.loads(active.read_text(encoding="utf-8"))["nodes"][0]["id"], "old")
            self.assertEqual(list((paths.providers / "graphify" / ".staging").glob("*/graphify-out/graph.json")), [])

    def test_graphify_code_index_is_written_outside_the_repository(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            repo = base / "repo"
            repo.mkdir()
            RepositoryFixture(repo)
            paths = index_control.shared_state_paths(repo, home=base)

            def runner(argv, cwd, env, timeout):
                self.assertIn("graphify_incremental.py", Path(argv[1]).name)
                self.assertIn("--force-rebuild", argv)
                output_root = Path(argv[argv.index("--output-root") + 1])
                return write_graphify_fixture(
                    output_root,
                    {"nodes": [{"id": "main", "source_file": "main.py"}], "links": []},
                )

            result = reconcile_worker.execute_graphify(repo, paths, runner=runner, timeout_seconds=60)
            self.assertEqual(result["status"], "READY")
            graph_path = Path(result["graph_path"])
            self.assertTrue(graph_path.is_file())
            self.assertFalse(str(graph_path).lower().startswith(str(repo).lower()))

    def test_graphify_invalid_incremental_baseline_forces_full_rebuild(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            repo = base / "repo"
            repo.mkdir()
            RepositoryFixture(repo)
            paths = index_control.shared_state_paths(repo, home=base)
            graph = paths.providers / "graphify" / "graphify-out" / "graph.json"
            graph.parent.mkdir(parents=True)
            graph.write_text('{"nodes":[],"edges":[]}\n', encoding="utf-8")
            (graph.parent / "manifest.json").write_text('{"main.py":{}}\n', encoding="utf-8")

            def runner(argv, cwd, env, timeout):
                self.assertIn("--force-rebuild", argv)
                output_root = Path(argv[argv.index("--output-root") + 1])
                return write_graphify_fixture(
                    output_root,
                    {"nodes": [{"id": "main", "source_file": "main.py"}], "edges": []},
                )

            result = reconcile_worker.execute_graphify(repo, paths, runner=runner, timeout_seconds=60)
            self.assertEqual(result["status"], "READY")
            self.assertEqual(result["coverage_ratio"], 1.0)

    def test_graphify_incremental_retains_unchanged_sources(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base_dir = Path(tmp)
            repo = base_dir / "repo"
            repo.mkdir()
            RepositoryFixture(repo)
            (repo / "other.py").write_text("def other():\n    return 2\n", encoding="utf-8")
            git(repo, "add", "other.py")
            git(repo, "commit", "-qm", "add other")
            output_root = base_dir / "out"
            interpreter = index_control.resolve_graphify_python(repo)
            if interpreter is None:
                self.skipTest("Graphify interpreter unavailable")
            initial = subprocess.run(
                [
                    str(interpreter), str(SCRIPT_DIR / "graphify_incremental.py"),
                    "--root", str(repo), "--output-root", str(output_root), "--force-rebuild",
                ],
                capture_output=True,
                text=True,
                encoding="utf-8",
                timeout=120,
                check=False,
            )
            self.assertEqual(initial.returncode, 0, initial.stderr)
            graph_path = output_root / "graphify-out" / "graph.json"
            query_index = output_root / "graphify-out" / "query.sqlite"
            self.assertTrue(query_index.is_file())
            connection = sqlite3.connect(query_index)
            try:
                indexed = connection.execute(
                    "SELECT payload FROM nodes_fts WHERE nodes_fts MATCH ? LIMIT 10",
                    ("other*",),
                ).fetchall()
            finally:
                connection.close()
            self.assertTrue(any("other" in payload.lower() for (payload,) in indexed))
            before = json.loads(graph_path.read_text(encoding="utf-8"))
            other_ids = {
                node["id"]
                for node in before["nodes"]
                if node.get("label") == "other" or "other" in str(node.get("id", "")).lower()
            }
            self.assertTrue(other_ids)
            (repo / "main.py").write_text("def changed():\n    return 3\n", encoding="utf-8")
            completed = subprocess.run(
                [
                    str(interpreter),
                    str(SCRIPT_DIR / "graphify_incremental.py"),
                    "--root",
                    str(repo),
                    "--output-root",
                    str(output_root),
                ],
                capture_output=True,
                text=True,
                encoding="utf-8",
                timeout=120,
                check=False,
            )
            self.assertEqual(completed.returncode, 0, completed.stderr)
            self.assertEqual(json.loads(completed.stdout)["status"], "REBUILT")
            merged = json.loads(graph_path.read_text(encoding="utf-8"))
            self.assertTrue(other_ids <= {node["id"] for node in merged["nodes"]})

    def test_graphify_keeps_repo_relative_paths_when_all_code_is_nested(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            repo = base / "repo"
            repo.mkdir()
            RepositoryFixture(repo)
            (repo / "main.py").unlink()
            nested = repo / "src" / "nested.py"
            nested.parent.mkdir()
            nested.write_text("def nested():\n    return 1\n", encoding="utf-8")
            git(repo, "add", "-A")
            git(repo, "commit", "-qm", "nested only")
            interpreter = index_control.resolve_graphify_python(repo)
            if interpreter is None:
                self.skipTest("Graphify interpreter unavailable")
            output_root = base / "out"
            completed = subprocess.run(
                [
                    str(interpreter), str(SCRIPT_DIR / "graphify_incremental.py"),
                    "--root", str(repo), "--output-root", str(output_root), "--force-rebuild",
                ],
                capture_output=True,
                text=True,
                encoding="utf-8",
                timeout=120,
                check=False,
            )
            self.assertEqual(completed.returncode, 0, completed.stderr)
            graph = json.loads((output_root / "graphify-out" / "graph.json").read_text(encoding="utf-8"))
            sources = {node.get("source_file") for node in graph["nodes"]}
            self.assertIn("src/nested.py", sources)

    def test_semctx_index_requires_machine_valid_receipt(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            RepositoryFixture(repo, providers=("semctx",))

            def invalid_runner(argv, cwd, env, timeout):
                return index_control.CommandResult(0, "{}", "", 0.1)

            result = reconcile_worker.execute_semctx(repo, host="codex", runner=invalid_runner, timeout_seconds=60)
            self.assertEqual(result["status"], "FAILED")
            self.assertIn("INVALID_INDEX_OUTPUT", result["reasons"])


FAKE_BUN = "C:/fake/bun.exe"


class SemctxHostBindingTests(unittest.TestCase):
    """The host that authorizes a semctx build builds it; every host judges it."""

    @staticmethod
    def _isolated_home(home: Path) -> contextlib.ExitStack:
        stack = contextlib.ExitStack()
        stack.enter_context(mock.patch.object(Path, "home", return_value=home))
        found = {"bun": FAKE_BUN, "bun.exe": FAKE_BUN}
        stack.enter_context(mock.patch.object(index_control.shutil, "which", side_effect=found.get))
        return stack

    @staticmethod
    def _plugins(home: Path) -> dict[str, Path]:
        # Claude installed 0.3.0; Codex runs the newer 0.3.1.
        claude = home / ".claude" / "plugins" / "cache" / "semctx-stable" / "semctx" / "0.3.0"
        codex = home / ".codex" / "plugins" / "cache" / "semctx-stable" / "semctx-control" / "0.3.1"
        scripts = {"claude": claude / "dist" / "semctx.js", "codex": codex / "dist" / "semctx.js"}
        for host, script in scripts.items():
            script.parent.mkdir(parents=True)
            script.write_text(f"// {host} semctx\n", encoding="utf-8")
        record = home / ".claude" / "plugins" / "installed_plugins.json"
        record.write_text(
            json.dumps({"plugins": {"semctx@semctx-stable": [{"scope": "user", "installPath": str(claude)}]}}),
            encoding="utf-8",
        )
        return scripts

    def _worker(
        self,
        base: Path,
        repo: Path,
        calls: list[list[str]],
        *,
        status_verdicts: dict[str, str] | None = None,
    ):
        RepositoryFixture(repo, providers=("semctx",))
        (repo / "main.py").write_text("def dirty():\n    return 2\n", encoding="utf-8")
        scripts = self._plugins(base)

        def runner(argv, cwd, env, timeout):
            argv = list(argv)
            calls.append(argv)
            if argv[-2:] == ["index", "--json"]:
                return index_control.CommandResult(0, '{"indexed":true,"freshnessSeal":{}}', "", 0.1)
            if argv[-2:] == ["status", "--json"]:
                if status_verdicts is not None:
                    host = next(host for host, script in scripts.items() if argv[1] == str(script))
                    verdict = status_verdicts[host]
                    exit_code = 0 if verdict == "FRESH" else 3
                    return index_control.CommandResult(exit_code, json.dumps({"verdict": verdict}), "", 0.1)
                # Each consumer reads the store built by the last builder's version.
                builder = next(call for call in reversed(calls) if call[-2:] == ["index", "--json"])
                if argv[1] == builder[1]:
                    return index_control.CommandResult(0, '{"verdict":"DIRTY_KNOWN","reasons":["WORKING_TREE_DIRTY"]}', "", 0.1)
                return index_control.CommandResult(3, '{"verdict":"STALE","reasons":["TOOL_VERSION_MISMATCH"]}', "", 0.1)
            raise AssertionError(argv)

        worker = reconcile_worker.ReconcileWorker(
            repo,
            home=base,
            runner=runner,
            policies={"semctx": reconcile_worker.ProviderPolicy(quiet_seconds=0, checkpoint_required=True)},
        )
        return worker, scripts

    @staticmethod
    def _builds(calls: list[list[str]]) -> list[str]:
        return [call[1] for call in calls if call[-2:] == ["index", "--json"]]

    def test_semctx_build_uses_the_binary_of_the_host_that_authorized_it(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            repo = base / "repo"
            repo.mkdir()
            calls: list[list[str]] = []
            with self._isolated_home(base):
                worker, scripts = self._worker(base, repo, calls)
                index_control.enqueue_reconcile_event("codex", repo, kind="source_mutated", home=base)
                index_control.enqueue_reconcile_event("claude", repo, kind="checkpoint", home=base)
                worker.run_cycle(now=100.0)
                claude = index_control.routing_advisory(repo, host="claude", home=base)["providers"]["semctx"]
                codex = index_control.routing_advisory(repo, host="codex", home=base)["providers"]["semctx"]

            self.assertEqual(self._builds(calls), [str(scripts["claude"])])
            self.assertEqual(worker.state["providers"]["semctx"]["builder_host"], "claude")
            self.assertTrue(claude["usable"])
            self.assertEqual(claude["consumer_verdict"], "DIRTY_KNOWN")
            self.assertTrue(codex["artifact_ready"])
            self.assertFalse(codex["usable"])
            self.assertIn("TOOL_VERSION_MISMATCH", codex["reasons"])
            self.assertIn("SEMCTX_HOST_VERSION_SKEW", codex["reasons"])

    def test_version_skew_is_reported_and_never_rebuilt_away(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            repo = base / "repo"
            repo.mkdir()
            calls: list[list[str]] = []
            with self._isolated_home(base):
                worker, _ = self._worker(base, repo, calls)
                index_control.enqueue_reconcile_event("claude", repo, kind="source_mutated", home=base)
                index_control.enqueue_reconcile_event("claude", repo, kind="checkpoint", home=base)
                worker.run_cycle(now=100.0)
                # The skewed host checkpoints the same working state: rebuilding
                # with its binary would only move the skew to the other host.
                index_control.enqueue_reconcile_event("codex", repo, kind="checkpoint", home=base)
                worker.run_cycle(now=200.0)
                worker.run_cycle(now=300.0, force_reconcile=True)
                controller = index_control.IndexController(host="codex", root=repo, home=base, runner=worker.runner)
                controller.refresh(probe_graphify=False)
                codex = index_control.routing_advisory(repo, host="codex", home=base)["providers"]["semctx"]

            self.assertEqual(len(self._builds(calls)), 1)
            # The negative verdict is retried at the next source observation.
            self.assertEqual(sum(call[-2:] == ["status", "--json"] for call in calls), 5)
            self.assertFalse(codex["usable"])
            self.assertIn("SEMCTX_HOST_VERSION_SKEW", codex["reasons"])

    def test_operator_record_recovers_negative_verdict_without_rebuild(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            repo = base / "repo"
            repo.mkdir()
            calls: list[list[str]] = []
            status_verdicts = {"claude": "UNSEALED", "codex": "FRESH"}
            with self._isolated_home(base):
                worker, scripts = self._worker(base, repo, calls, status_verdicts=status_verdicts)
                index_control.enqueue_reconcile_event("claude", repo, kind="source_mutated", home=base)
                index_control.enqueue_reconcile_event("claude", repo, kind="checkpoint", home=base)
                worker.run_cycle(now=100.0)
                first = index_control.routing_advisory(repo, host="claude", home=base)["providers"]["semctx"]
                self.assertEqual(first["consumer_verdict"], "UNSEALED")
                self.assertFalse(first["usable"])
                source_state = worker.state["source"]["state_id"]
                builds = len(self._builds(calls))

                # The operator seals the same store with index --record; source stays unchanged.
                status_verdicts["claude"] = "FRESH"
                controller = index_control.IndexController(host="claude", root=repo, home=base, runner=worker.runner)
                controller.refresh(probe_graphify=False)
                refreshed = index_control.routing_advisory(repo, host="claude", home=base)["providers"]["semctx"]
                self.assertTrue(refreshed["usable"])
                self.assertEqual(refreshed["consumer_verdict"], "FRESH")
                self.assertIn("Semctx only when configured and READY (yes)",
                              index_control._read_json_file(index_control.state_paths("claude", repo, home=base).route_cache)["additional_context"])

                worker.run_cycle(now=200.0, force_reconcile=True)
                recovered = index_control.routing_advisory(repo, host="claude", home=base)["providers"]["semctx"]
                self.assertTrue(recovered["usable"])
                self.assertEqual(recovered["consumer_verdict"], "FRESH")
                self.assertEqual(worker.state["source"]["state_id"], source_state)
                self.assertEqual(len(self._builds(calls)), builds)
                self.assertEqual(sum(call[1] == str(scripts["claude"]) and call[-2:] == ["status", "--json"] for call in calls), 2)

                worker.run_cycle(now=300.0, force_reconcile=True)
                self.assertEqual(sum(call[-2:] == ["status", "--json"] for call in calls), 3)
                self.assertEqual(len(self._builds(calls)), builds)

    def test_negative_verdict_recovers_on_worker_reconciliation_without_refresh(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            repo = base / "repo"
            repo.mkdir()
            calls: list[list[str]] = []
            status_verdicts = {"claude": "UNSEALED", "codex": "FRESH"}
            with self._isolated_home(base):
                worker, _ = self._worker(base, repo, calls, status_verdicts=status_verdicts)
                index_control.enqueue_reconcile_event("claude", repo, kind="source_mutated", home=base)
                index_control.enqueue_reconcile_event("claude", repo, kind="checkpoint", home=base)
                worker.run_cycle(now=100.0)
                self.assertFalse(index_control.routing_advisory(repo, host="claude", home=base)["providers"]["semctx"]["usable"])
                builds = len(self._builds(calls))
                worker.run_cycle(now=101.0)
                self.assertEqual(sum(call[-2:] == ["status", "--json"] for call in calls), 2)

                status_verdicts["claude"] = "FRESH"
                worker.run_cycle(now=200.0, force_reconcile=True)
                self.assertTrue(index_control.routing_advisory(repo, host="claude", home=base)["providers"]["semctx"]["usable"])
                self.assertEqual(len(self._builds(calls)), builds)
                worker.run_cycle(now=300.0, force_reconcile=True)
                self.assertEqual(sum(call[-2:] == ["status", "--json"] for call in calls), 3)

    def test_failed_retry_remains_refused_until_a_successful_probe(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            repo = base / "repo"
            repo.mkdir()
            calls: list[list[str]] = []
            status_verdicts = {"claude": "UNSEALED", "codex": "FRESH"}
            with self._isolated_home(base):
                worker, _ = self._worker(base, repo, calls, status_verdicts=status_verdicts)
                index_control.enqueue_reconcile_event("claude", repo, kind="source_mutated", home=base)
                index_control.enqueue_reconcile_event("claude", repo, kind="checkpoint", home=base)
                worker.run_cycle(now=100.0)
                builds = len(self._builds(calls))
                normal_probe = worker.consumer_prober

                def failed_claude(host: str) -> dict[str, Any]:
                    if host == "claude":
                        raise TimeoutError("status timed out")
                    return normal_probe(host)

                worker.consumer_prober = failed_claude
                worker.run_cycle(now=200.0, force_reconcile=True)
                refused = index_control.routing_advisory(repo, host="claude", home=base)["providers"]["semctx"]
                self.assertFalse(refused["usable"])
                self.assertIn("CONSUMER_PROBE_EXCEPTION", refused["reasons"])
                self.assertEqual(len(self._builds(calls)), builds)

                worker.consumer_prober = normal_probe
                status_verdicts["claude"] = "FRESH"
                worker.run_cycle(now=300.0, force_reconcile=True)
                self.assertTrue(index_control.routing_advisory(repo, host="claude", home=base)["providers"]["semctx"]["usable"])
                self.assertEqual(len(self._builds(calls)), builds)

    def test_explicit_takeover_rebuilds_with_the_requesting_hosts_binary(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            repo = base / "repo"
            repo.mkdir()
            calls: list[list[str]] = []
            with self._isolated_home(base):
                worker, scripts = self._worker(base, repo, calls)
                index_control.enqueue_reconcile_event("claude", repo, kind="source_mutated", home=base)
                index_control.enqueue_reconcile_event("claude", repo, kind="checkpoint", home=base)
                worker.run_cycle(now=100.0)
                worker.invalidate_provider("semctx", "OPERATOR_TAKEOVER")
                index_control.enqueue_reconcile_event("codex", repo, kind="checkpoint", home=base)
                worker.run_cycle(now=200.0)
                codex = index_control.routing_advisory(repo, host="codex", home=base)["providers"]["semctx"]

            self.assertEqual(self._builds(calls), [str(scripts["claude"]), str(scripts["codex"])])
            self.assertTrue(codex["usable"])

    def test_head_only_change_retakes_verdicts_without_rebuilding(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            repo = base / "repo"
            repo.mkdir()
            calls: list[list[str]] = []
            with self._isolated_home(base):
                worker, _ = self._worker(base, repo, calls)
                index_control.enqueue_reconcile_event("claude", repo, kind="source_mutated", home=base)
                index_control.enqueue_reconcile_event("claude", repo, kind="checkpoint", home=base)
                worker.run_cycle(now=100.0)
                # Same tree, new HEAD: the corpus carries the build forward, but
                # semctx judges HEAD too, so its verdicts must be taken again.
                git(repo, "commit", "--allow-empty", "-qm", "message only")
                worker.run_cycle(now=200.0, force_reconcile=True)

            self.assertEqual(len(self._builds(calls)), 1)
            self.assertTrue(worker.state["providers"]["semctx"].get("carried_forward"))
            self.assertEqual(sum(call[-2:] == ["status", "--json"] for call in calls), 4)

    def test_a_real_change_is_rebuilt_by_the_host_that_checkpoints_it(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            repo = base / "repo"
            repo.mkdir()
            calls: list[list[str]] = []
            with self._isolated_home(base):
                worker, scripts = self._worker(base, repo, calls)
                index_control.enqueue_reconcile_event("claude", repo, kind="source_mutated", home=base)
                index_control.enqueue_reconcile_event("claude", repo, kind="checkpoint", home=base)
                worker.run_cycle(now=100.0)
                (repo / "main.py").write_text("def edited_by_codex():\n    return 3\n", encoding="utf-8")
                index_control.enqueue_reconcile_event("codex", repo, kind="source_mutated", home=base)
                index_control.enqueue_reconcile_event("codex", repo, kind="checkpoint", home=base)
                worker.run_cycle(now=200.0)
                claude = index_control.routing_advisory(repo, host="claude", home=base)["providers"]["semctx"]
                codex = index_control.routing_advisory(repo, host="codex", home=base)["providers"]["semctx"]

            self.assertEqual(self._builds(calls), [str(scripts["claude"]), str(scripts["codex"])])
            self.assertTrue(codex["usable"])
            self.assertFalse(claude["usable"])
            self.assertIn("SEMCTX_HOST_VERSION_SKEW", claude["reasons"])


if __name__ == "__main__":
    unittest.main()
