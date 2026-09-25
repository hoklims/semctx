from __future__ import annotations

import contextlib
import importlib.util
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import tomllib
import unittest
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest import mock


SCRIPT = Path(__file__).parents[1] / "scripts" / "index_control.py"
SPEC = importlib.util.spec_from_file_location("index_control", SCRIPT)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"Cannot load {SCRIPT}")
index_control = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = index_control
SPEC.loader.exec_module(index_control)

LAUNCHER_SCRIPT = SCRIPT.with_name("launch_detached.py")
LAUNCHER_SPEC = importlib.util.spec_from_file_location("index_control_launch_detached", LAUNCHER_SCRIPT)
if LAUNCHER_SPEC is None or LAUNCHER_SPEC.loader is None:
    raise RuntimeError(f"Cannot load {LAUNCHER_SCRIPT}")
launch_detached = importlib.util.module_from_spec(LAUNCHER_SPEC)
sys.modules[LAUNCHER_SPEC.name] = launch_detached
LAUNCHER_SPEC.loader.exec_module(launch_detached)


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
    def __init__(self, root: Path) -> None:
        self.root = root
        write_test_admission(root.parent)
        git(root, "init", "-q")
        git(root, "config", "user.email", "index-control@example.invalid")
        git(root, "config", "user.name", "Index Control Test")
        (root / "tracked.txt").write_text("one\n", encoding="utf-8")
        (root / "main.py").write_text("def one():\n    return 1\n", encoding="utf-8")
        (root / ".gitignore").write_text(".cocoindex_code/\n.semctx/\ngraphify-out/\n", encoding="utf-8")
        git(root, "add", "tracked.txt", "main.py", ".gitignore")
        git(root, "commit", "-qm", "initial")


FAKE_BUN = "C:/fake/bun.exe"


def write_semctx_plugins(
    home: Path,
    *,
    claude_installed: str | None = None,
    claude_cached: tuple[str, ...] = (),
    codex_cached: tuple[str, ...] = (),
) -> dict[str, Path]:
    """Lay out each host's semctx plugin the way that host installs it."""
    scripts: dict[str, Path] = {}
    claude_cache = home / ".claude" / "plugins" / "cache" / "semctx-stable" / "semctx"
    codex_cache = home / ".codex" / "plugins" / "cache" / "semctx-stable" / "semctx-control"
    for host, cache, versions in (("claude", claude_cache, claude_cached), ("codex", codex_cache, codex_cached)):
        for version in versions:
            script = cache / version / "dist" / "semctx.js"
            script.parent.mkdir(parents=True, exist_ok=True)
            script.write_text(f"// {host} semctx {version}\n", encoding="utf-8")
            scripts[f"{host}:{version}"] = script
    if claude_installed is not None:
        record = home / ".claude" / "plugins" / "installed_plugins.json"
        record.parent.mkdir(parents=True, exist_ok=True)
        install = {"scope": "user", "installPath": str(claude_cache / claude_installed), "version": claude_installed}
        record.write_text(json.dumps({"version": 2, "plugins": {"semctx@semctx-stable": [install]}}), encoding="utf-8")
    return scripts


def isolated_semctx_home(home: Path, *, global_semctx: str | None = None) -> contextlib.ExitStack:
    """Resolve plugins under a fixture home; never find the machine's real bun or semctx."""
    stack = contextlib.ExitStack()
    stack.enter_context(mock.patch.object(Path, "home", return_value=home))
    found = {"bun": FAKE_BUN, "bun.exe": FAKE_BUN, "semctx": global_semctx}
    stack.enter_context(mock.patch.object(index_control.shutil, "which", side_effect=found.get))
    return stack


class RoutingTests(unittest.TestCase):
    def test_route_only_marks_provider_usable_for_exact_current_generation(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            repo = base / "repo"
            repo.mkdir()
            RepositoryFixture(repo)
            (repo / "main.py").write_text("print('ready')\n", encoding="utf-8")
            git(repo, "add", "main.py")
            git(repo, "commit", "-qm", "code")
            source = index_control.fingerprint_repository(repo, home=base)
            paths = index_control.shared_state_paths(repo, home=base)
            index_control.atomic_write_json(
                paths.worker_state,
                {
                    "generation": 3,
                    "updated_at": index_control.utc_now(),
                    "source_observed_at": index_control.utc_now(),
                    "source": source,
                    "available_providers": {"ccc": False, "graphify": True, "semctx": False},
                    "providers": {
                        "graphify": {
                            "status": "READY",
                            "indexed_generation": 3,
                            "indexed_source_state_id": source["state_id"],
                        }
                    },
                },
            )
            host_paths = index_control.state_paths("codex", repo, home=base)
            index_control.atomic_write_json(
                host_paths.receipt,
                {"acknowledged_dirty_generation": None},
            )
            consumer = index_control.register_consumer("codex", repo, "graphify", home=base)
            self.assertEqual(consumer["status"], "READY")

            route = index_control.routing_advisory(repo, home=base)

            self.assertTrue(route["providers"]["graphify"]["usable"])
            self.assertFalse(route["providers"]["ccc"]["usable"])
            self.assertIn("Graphify only when READY (yes; graph=", route["additional_context"])
            self.assertIn("Do not write query answers", route["additional_context"])

            index_control.mark_dirty("codex", repo, home=base)
            stale = index_control.routing_advisory(repo, home=base)
            self.assertFalse(stale["providers"]["graphify"]["usable"])

    def test_route_fails_closed_when_consumer_generation_does_not_match(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            repo = base / "repo"
            repo.mkdir()
            RepositoryFixture(repo)
            (repo / "main.py").write_text("print('ready')\n", encoding="utf-8")
            git(repo, "add", "main.py")
            git(repo, "commit", "-qm", "code")
            source = index_control.fingerprint_repository(repo, home=base)
            paths = index_control.shared_state_paths(repo, home=base)
            index_control.atomic_write_json(
                paths.worker_state,
                {
                    "generation": 8,
                    "updated_at": index_control.utc_now(),
                    "source_observed_at": index_control.utc_now(),
                    "source": source,
                    "available_providers": {"ccc": False, "graphify": True, "semctx": False},
                    "providers": {"graphify": {"status": "READY", "indexed_generation": 8, "indexed_source_state_id": source["state_id"]}},
                },
            )
            index_control.atomic_write_json(
                index_control.state_paths("codex", repo, home=base).receipt,
                {"acknowledged_dirty_generation": None},
            )

            route = index_control.routing_advisory(repo, home=base)

            self.assertTrue(route["providers"]["graphify"]["artifact_ready"])
            self.assertFalse(route["providers"]["graphify"]["consumer_ready"])
            self.assertFalse(route["providers"]["graphify"]["usable"])
            self.assertIn("CONSUMER_GENERATION_MISMATCH", route["providers"]["graphify"]["reasons"])

    def test_route_fails_closed_when_worker_observation_expires(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            repo = base / "repo"
            repo.mkdir()
            RepositoryFixture(repo)
            source = index_control.fingerprint_repository(repo, home=base)
            paths = index_control.shared_state_paths(repo, home=base)
            index_control.atomic_write_json(
                paths.worker_state,
                {
                    "generation": 1,
                    # A live worker heartbeat must not grant freshness on its
                    # own: only source_observed_at carries the observation axis.
                    "updated_at": index_control.utc_now(),
                    "source_observed_at": "2000-01-01T00:00:00+00:00",
                    "source": source,
                    "available_providers": {"ccc": True, "graphify": False, "semctx": False},
                    "providers": {"ccc": {"status": "READY", "indexed_generation": 1, "indexed_source_state_id": source["state_id"]}},
                },
            )
            index_control.atomic_write_json(
                index_control.state_paths("codex", repo, home=base).receipt,
                {"acknowledged_dirty_generation": None},
            )

            route = index_control.routing_advisory(repo, home=base)

            self.assertFalse(route["providers"]["ccc"]["usable"])
            self.assertIn("SOURCE_OBSERVATION_EXPIRED", route["providers"]["ccc"]["reasons"])

    def _expired_observation_fixture(self, base: Path, repo: Path) -> dict:
        RepositoryFixture(repo)
        (repo / "main.py").write_text("print('ready')\n", encoding="utf-8")
        git(repo, "add", "main.py")
        git(repo, "commit", "-qm", "code")
        source = index_control.fingerprint_repository(repo, home=base)
        paths = index_control.shared_state_paths(repo, home=base)
        index_control.atomic_write_json(
            paths.worker_state,
            {
                "generation": 4,
                "updated_at": index_control.utc_now(),
                # Observation long past the TTL: the worker is gone.
                "source_observed_at": "2000-01-01T00:00:00+00:00",
                "source": source,
                "available_providers": {"ccc": True, "graphify": False, "semctx": False},
                "providers": {
                    "ccc": {
                        "status": "READY",
                        "indexed_generation": 4,
                        "indexed_source_state_id": source["state_id"],
                        "indexed_corpus_state_id": source["provider_corpus_state_ids"]["ccc"],
                    }
                },
            },
        )
        index_control.atomic_write_json(
            index_control.state_paths("codex", repo, home=base).receipt,
            {"acknowledged_dirty_generation": None},
        )
        return source

    def test_expired_observation_is_recoverable_by_live_verification_without_reindex(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            repo = base / "repo"
            repo.mkdir()
            self._expired_observation_fixture(base, repo)
            shared = index_control.shared_state_paths(repo, home=base)
            before_state = shared.worker_state.read_bytes()

            expired = index_control.routing_advisory(repo, home=base)
            self.assertFalse(expired["providers"]["ccc"]["usable"])
            self.assertEqual(expired["source_observation_mode"], "expired")
            self.assertIn("SOURCE_OBSERVATION_EXPIRED", expired["providers"]["ccc"]["reasons"])

            recovered = index_control.routing_advisory(repo, home=base, verify_expired=True)

            self.assertTrue(recovered["providers"]["ccc"]["usable"])
            self.assertTrue(recovered["source_observation_fresh"])
            self.assertEqual(recovered["source_observation_mode"], "verified_live")
            self.assertEqual(recovered["providers"]["ccc"]["reasons"], [])
            # Recovery must come from re-observing, never from re-indexing: the
            # artefact evidence and the honest observation age are untouched.
            self.assertEqual(shared.worker_state.read_bytes(), before_state)
            self.assertGreater(recovered["source_observation_age_seconds"], recovered["source_observation_ttl_seconds"])

    def test_live_verification_refuses_when_source_drifted(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            repo = base / "repo"
            repo.mkdir()
            self._expired_observation_fixture(base, repo)
            (repo / "main.py").write_text("print('drifted')\n", encoding="utf-8")

            route = index_control.routing_advisory(repo, home=base, verify_expired=True)

            self.assertFalse(route["providers"]["ccc"]["usable"])
            self.assertFalse(route["source_observation_fresh"])
            self.assertEqual(route["source_observation_mode"], "expired")
            self.assertIn("SOURCE_DRIFTED_SINCE_OBSERVATION", route["providers"]["ccc"]["reasons"])
            self.assertNotIn("SOURCE_OBSERVATION_EXPIRED", route["providers"]["ccc"]["reasons"])

    def test_live_verification_fails_closed_when_git_is_unavailable(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            repo = base / "repo"
            repo.mkdir()
            self._expired_observation_fixture(base, repo)

            with mock.patch.object(
                index_control,
                "fingerprint_repository",
                side_effect=ValueError("Not a Git worktree (git rev-parse failed)"),
            ):
                route = index_control.routing_advisory(repo, home=base, verify_expired=True)

            self.assertFalse(route["providers"]["ccc"]["usable"])
            self.assertFalse(route["source_observation_fresh"])
            self.assertIn("SOURCE_OBSERVATION_FAILED", route["providers"]["ccc"]["reasons"])

    def test_published_route_cache_contains_expiring_safe_fallback(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            repo = base / "repo"
            repo.mkdir()
            RepositoryFixture(repo)
            source = index_control.fingerprint_repository(repo, home=base)
            shared = index_control.shared_state_paths(repo, home=base)
            index_control.atomic_write_json(
                shared.worker_state,
                {
                    "generation": 2,
                    "updated_at": index_control.utc_now(),
                    "source_observed_at": index_control.utc_now(),
                    "source": source,
                    "available_providers": {"ccc": False, "graphify": False, "semctx": False},
                    "providers": {},
                },
            )
            host_paths = index_control.state_paths("codex", repo, home=base)
            index_control.atomic_write_json(host_paths.receipt, {"acknowledged_dirty_generation": None})

            cache = index_control.publish_route_cache("codex", repo, home=base)

            self.assertTrue(host_paths.route_cache.is_file())
            self.assertGreater(cache["expires_at_unix"], time.time())
            self.assertIn("safe fallback", cache["fallback_context"])

    def test_consumer_invalidation_removes_graphify_usability(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            repo = base / "repo"
            repo.mkdir()
            RepositoryFixture(repo)
            (repo / "main.py").write_text("print('ready')\n", encoding="utf-8")
            git(repo, "add", "main.py")
            git(repo, "commit", "-qm", "code")
            source = index_control.fingerprint_repository(repo, home=base)
            shared = index_control.shared_state_paths(repo, home=base)
            index_control.atomic_write_json(
                shared.worker_state,
                {
                    "generation": 5,
                    "updated_at": index_control.utc_now(),
                    "source_observed_at": index_control.utc_now(),
                    "source": source,
                    "available_providers": {"ccc": False, "graphify": True, "semctx": False},
                    "providers": {"graphify": {"status": "READY", "indexed_generation": 5, "indexed_source_state_id": source["state_id"]}},
                },
            )
            index_control.atomic_write_json(
                index_control.state_paths("codex", repo, home=base).receipt,
                {"acknowledged_dirty_generation": None},
            )
            index_control.register_consumer("codex", repo, "graphify", home=base)
            self.assertTrue(index_control.routing_advisory(repo, home=base)["providers"]["graphify"]["usable"])

            index_control.invalidate_consumer("codex", repo, "graphify", home=base)

            route = index_control.routing_advisory(repo, home=base)
            self.assertFalse(route["providers"]["graphify"]["usable"])
            self.assertFalse(route["providers"]["graphify"]["consumer_ready"])

    def test_route_command_emits_compact_context(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            RepositoryFixture(repo)
            completed = subprocess.run(
                [sys.executable, str(SCRIPT), "route", "--root", str(repo), "--format", "text"],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=20,
                check=False,
            )
            self.assertEqual(completed.returncode, 0, completed.stderr)
            self.assertIn("freshness-gated", completed.stdout)
            self.assertIn("native LSP", completed.stdout)


class SemctxHostBindingTests(unittest.TestCase):
    """Semctx freshness belongs to each host's own consumer binary."""

    @staticmethod
    def _semctx_repository(base: Path) -> Path:
        repo = base / "repo"
        repo.mkdir()
        RepositoryFixture(repo)
        (repo / ".semctx").mkdir()
        return repo

    @staticmethod
    def _probe(base: Path, repo: Path, host: str) -> dict:
        def runner(argv, cwd, env, timeout):
            return index_control.CommandResult(0, '{"verdict":"FRESH","reasons":[]}', "", 0.01)

        controller = index_control.IndexController(
            host=host,
            root=repo,
            home=base,
            runner=runner,
            ccc_command=["fake-ccc"],
        )
        return controller.refresh(probe_graphify=False)["providers"]["semctx"]

    def test_each_host_probes_semctx_with_its_own_installed_plugin(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            repo = self._semctx_repository(base)
            with isolated_semctx_home(base):
                # Claude's cache keeps an orphan newer than its installed plugin,
                # and Codex installed a version Claude does not have.
                scripts = write_semctx_plugins(
                    base,
                    claude_installed="0.3.0",
                    claude_cached=("0.1.20", "0.3.0", "0.9.0"),
                    codex_cached=("0.3.1",),
                )
                claude = self._probe(base, repo, "claude")
                codex = self._probe(base, repo, "codex")

            self.assertEqual(claude["command"], [FAKE_BUN, str(scripts["claude:0.3.0"]), "status", "--json"])
            self.assertEqual(codex["command"], [FAKE_BUN, str(scripts["codex:0.3.1"]), "status", "--json"])
            # FRESH is semctx's clean verdict; it must not degrade to UNKNOWN.
            self.assertEqual(claude["status"], "READY")
            self.assertEqual(codex["status"], "READY")

    def test_semctx_plugin_versions_are_ordered_numerically(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            repo = self._semctx_repository(base)
            with isolated_semctx_home(base):
                scripts = write_semctx_plugins(base, codex_cached=("0.9.0", "0.10.0"))
                # A version directory without its bundle is not an installed plugin.
                (base / ".codex" / "plugins" / "cache" / "semctx-stable" / "semctx-control" / "0.11.0").mkdir()
                codex = self._probe(base, repo, "codex")

            self.assertEqual(codex["command"][:2], [FAKE_BUN, str(scripts["codex:0.10.0"])])

    def test_declared_plugin_is_never_replaced_by_another_hosts_binary(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            with isolated_semctx_home(base, global_semctx="C:/fake/semctx.exe"):
                # Claude declares 0.3.3 but its bundle is gone: a broken consumer.
                scripts = write_semctx_plugins(base, claude_installed="0.3.3", codex_cached=("0.3.1",))
                claude = index_control.resolve_semctx_command("claude", home=base)
                codex = index_control.resolve_semctx_command("codex", home=base)
                (base / ".claude" / "plugins" / "installed_plugins.json").unlink()
                undeclared = index_control.resolve_semctx_command("claude", home=base)

            self.assertIsNone(claude)
            self.assertEqual(codex, [FAKE_BUN, str(scripts["codex:0.3.1"])])
            # Only a host with no plugin at all falls back to the global CLI.
            self.assertEqual(undeclared, ["C:/fake/semctx.exe"])

    def test_a_plugin_change_on_either_host_invalidates_only_the_semctx_corpus(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            repo = self._semctx_repository(base)
            with isolated_semctx_home(base):
                write_semctx_plugins(
                    base,
                    claude_installed="0.3.0",
                    claude_cached=("0.3.0", "0.3.3"),
                    codex_cached=("0.9.0",),
                )
                before = index_control.fingerprint_repository(repo, home=base)
                # Claude upgrades while Codex keeps a newer, unchanged plugin.
                write_semctx_plugins(base, claude_installed="0.3.3")
                after = index_control.fingerprint_repository(repo, home=base)

            self.assertNotEqual(
                before["provider_corpus_state_ids"]["semctx"], after["provider_corpus_state_ids"]["semctx"]
            )
            for provider in ("ccc", "graphify"):
                self.assertEqual(
                    before["provider_corpus_state_ids"][provider], after["provider_corpus_state_ids"][provider]
                )

    def _ready_semctx_build(self, base: Path, repo: Path, consumers: dict) -> None:
        with isolated_semctx_home(base):
            source = index_control.fingerprint_repository(repo, home=base)
        for host, verdict in consumers.items():
            verdict.setdefault("host", host)
            verdict.setdefault("source_state_id", source["state_id"])
        index_control.atomic_write_json(
            index_control.shared_state_paths(repo, home=base).worker_state,
            {
                "generation": 5,
                "updated_at": index_control.utc_now(),
                "source_observed_at": index_control.utc_now(),
                "source": source,
                "available_providers": {"ccc": False, "graphify": False, "semctx": True},
                "providers": {
                    "semctx": {
                        "status": "READY",
                        "indexed_generation": 5,
                        "indexed_source_state_id": source["state_id"],
                        "indexed_corpus_state_id": source["provider_corpus_state_ids"]["semctx"],
                        "attempted_at": "2026-09-24T10:00:00+00:00",
                        "command": [FAKE_BUN, "codex/semctx.js", "index", "--json"],
                        "consumers": consumers,
                    }
                },
            },
        )
        for host in ("codex", "claude"):
            index_control.atomic_write_json(
                index_control.state_paths(host, repo, home=base).receipt,
                {"acknowledged_dirty_generation": None},
            )

    def test_route_marks_semctx_usable_only_for_hosts_whose_consumer_reads_the_build(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            repo = self._semctx_repository(base)
            build = "2026-09-24T10:00:00+00:00"
            self._ready_semctx_build(
                base,
                repo,
                {
                    "codex": {"status": "READY", "verdict": "FRESH", "reasons": [], "build_attempted_at": build},
                    "claude": {
                        "status": "STALE",
                        "verdict": "STALE",
                        "reasons": ["SEMCTX_HOST_VERSION_SKEW", "TOOL_VERSION_MISMATCH"],
                        "build_attempted_at": build,
                    },
                },
            )

            codex = index_control.routing_advisory(repo, host="codex", home=base)
            claude = index_control.routing_advisory(repo, host="claude", home=base)

            self.assertTrue(codex["providers"]["semctx"]["usable"])
            self.assertIn("Semctx only when configured and READY (yes)", codex["additional_context"])
            semctx = claude["providers"]["semctx"]
            self.assertTrue(semctx["artifact_ready"])
            self.assertTrue(semctx["consumer_required"])
            self.assertFalse(semctx["usable"])
            self.assertEqual(semctx["status"], "ARTIFACT_READY")
            self.assertEqual(semctx["consumer_verdict"], "STALE")
            self.assertIn("SEMCTX_HOST_VERSION_SKEW", semctx["reasons"])
            self.assertIn("Semctx only when configured and READY (no)", claude["additional_context"])

    def test_route_ignores_consumer_verdicts_taken_on_another_build_or_source(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            repo = self._semctx_repository(base)
            self._ready_semctx_build(
                base,
                repo,
                {
                    # Taken on the store a previous build left behind.
                    "codex": {"status": "READY", "verdict": "FRESH", "build_attempted_at": "2026-09-23T08:00:00+00:00"},
                    # Right build, but before a HEAD-only change carried it forward.
                    "claude": {
                        "status": "READY",
                        "verdict": "FRESH",
                        "build_attempted_at": "2026-09-24T10:00:00+00:00",
                        "source_state_id": "sha256:before-an-amended-commit",
                    },
                },
            )

            for host in ("codex", "claude"):
                semctx = index_control.routing_advisory(repo, host=host, home=base)["providers"]["semctx"]
                self.assertTrue(semctx["artifact_ready"], host)
                self.assertFalse(semctx["usable"], host)
                self.assertIn("CONSUMER_VERDICT_MISSING", semctx["reasons"], host)

            refreshed_path = index_control.shared_state_paths(repo, home=base).consumers / "claude" / "semctx.json"
            built_source = index_control._read_json_file(index_control.shared_state_paths(repo, home=base).worker_state)["source"]["state_id"]
            probe = {
                "probe_kind": "semctx_status",
                "provider": "semctx",
                "host": "claude",
                "status": "READY",
                "verdict": "FRESH",
                "observed_at": index_control.utc_now(),
                "build_attempted_at": "2026-09-23T08:00:00+00:00",
                "source_state_id": built_source,
            }
            index_control.atomic_write_json(refreshed_path, probe)
            self.assertFalse(index_control.routing_advisory(repo, host="claude", home=base)["providers"]["semctx"]["usable"])
            probe["build_attempted_at"] = "2026-09-24T10:00:00+00:00"
            probe["source_state_id"] = "sha256:old-source"
            index_control.atomic_write_json(refreshed_path, probe)
            self.assertFalse(index_control.routing_advisory(repo, host="claude", home=base)["providers"]["semctx"]["usable"])
            probe["source_state_id"] = built_source
            index_control.atomic_write_json(refreshed_path, probe)
            self.assertTrue(index_control.routing_advisory(repo, host="claude", home=base)["providers"]["semctx"]["usable"])
            probe["host"] = "codex"
            index_control.atomic_write_json(refreshed_path, probe)
            self.assertFalse(index_control.routing_advisory(repo, host="claude", home=base)["providers"]["semctx"]["usable"])
            probe.pop("host")
            index_control.atomic_write_json(refreshed_path, probe)
            self.assertFalse(index_control.routing_advisory(repo, host="claude", home=base)["providers"]["semctx"]["usable"])
            probe["host"] = "claude"
            probe["provider"] = "graphify"
            index_control.atomic_write_json(refreshed_path, probe)
            self.assertFalse(index_control.routing_advisory(repo, host="claude", home=base)["providers"]["semctx"]["usable"])
            probe["provider"] = "semctx"
            probe.pop("probe_kind")
            index_control.atomic_write_json(refreshed_path, probe)
            self.assertFalse(index_control.routing_advisory(repo, host="claude", home=base)["providers"]["semctx"]["usable"])


class WindowsProcessVisibilityTests(unittest.TestCase):
    @unittest.skipUnless(os.name == "nt", "Windows console flags are Windows-specific")
    def test_all_controller_children_request_no_console_window(self) -> None:
        options = index_control._subprocess_window_options("nt")
        self.assertTrue(options["creationflags"] & subprocess.CREATE_NO_WINDOW)
        startup = options["startupinfo"]
        self.assertTrue(startup.dwFlags & subprocess.STARTF_USESHOWWINDOW)
        self.assertEqual(startup.wShowWindow, subprocess.SW_HIDE)

    @unittest.skipUnless(os.name == "nt", "Windows console flags are Windows-specific")
    def test_canonical_git_probe_uses_no_console_window(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp).resolve()
            completed = subprocess.CompletedProcess(
                ["git", "rev-parse", "--show-toplevel"], 0, str(repo) + "\n", ""
            )
            with mock.patch.object(index_control.subprocess, "run", return_value=completed) as run:
                self.assertEqual(index_control.canonical_root(repo), repo)
            kwargs = run.call_args.kwargs
            self.assertTrue(kwargs["creationflags"] & subprocess.CREATE_NO_WINDOW)
            self.assertEqual(kwargs["startupinfo"].wShowWindow, subprocess.SW_HIDE)

    @unittest.skipUnless(os.name == "nt", "pythonw selection is Windows-specific")
    def test_detached_worker_uses_pythonw_when_available(self) -> None:
        selected = launch_detached.background_python(Path(r"C:\Python314\python.exe"), platform="nt")
        self.assertEqual(selected.name.casefold(), "pythonw.exe")
        self.assertTrue(selected.is_file())


class FingerprintTests(unittest.TestCase):
    def test_dotted_vendor_tree_does_not_admit_graphify(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            repo = base / "repo"
            repo.mkdir()
            RepositoryFixture(repo)
            admission = base / ".agents" / "index-control-plane" / "admission.json"
            config = json.loads(admission.read_text(encoding="utf-8"))
            config["graphify"]["min_code_files"] = 5
            admission.write_text(json.dumps(config), encoding="utf-8")
            vendor = repo / ".venv"
            vendor.mkdir()
            for index in range(5):
                (vendor / f"dependency_{index}.py").write_text("def imported(): pass\n", encoding="utf-8")
            git(repo, "add", "-f", ".venv")

            self.assertFalse(index_control.discover_providers(repo, home=base)["graphify"])

    def test_fingerprint_tracks_head_tracked_and_untracked_content(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            RepositoryFixture(repo)

            clean = index_control.fingerprint_repository(repo)
            (repo / "tracked.txt").write_text("two\n", encoding="utf-8")
            tracked = index_control.fingerprint_repository(repo)
            self.assertEqual(clean["head"], tracked["head"])
            self.assertNotEqual(clean["working_tree_hash"], tracked["working_tree_hash"])

            (repo / "untracked.txt").write_text("alpha\n", encoding="utf-8")
            untracked_a = index_control.fingerprint_repository(repo)
            (repo / "untracked.txt").write_text("beta\n", encoding="utf-8")
            untracked_b = index_control.fingerprint_repository(repo)
            self.assertNotEqual(
                untracked_a["working_tree_hash"],
                untracked_b["working_tree_hash"],
            )

            git(repo, "add", "tracked.txt", "untracked.txt")
            git(repo, "commit", "-qm", "second")
            committed = index_control.fingerprint_repository(repo)
            self.assertNotEqual(clean["head"], committed["head"])
            self.assertFalse(committed["dirty"])

    def test_provider_config_hash_changes_without_changing_git_diff(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            RepositoryFixture(repo)
            settings = repo / ".cocoindex_code" / "settings.yml"
            settings.parent.mkdir()
            settings.write_text("include_patterns: ['**/*.py']\n", encoding="utf-8")
            first = index_control.fingerprint_repository(repo)
            settings.write_text("include_patterns: ['**/*.ts']\n", encoding="utf-8")
            second = index_control.fingerprint_repository(repo)
            self.assertEqual(first["working_tree_hash"], second["working_tree_hash"])
            self.assertNotEqual(first["config_hash"], second["config_hash"])
            self.assertNotEqual(first["state_id"], second["state_id"])


class StateAndLockTests(unittest.TestCase):
    def test_host_receipts_are_separate_but_lock_is_shared(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            repo = base / "repo"
            repo.mkdir()
            RepositoryFixture(repo)
            codex = index_control.state_paths("codex", repo, home=base)
            claude = index_control.state_paths("claude", repo, home=base)
            self.assertNotEqual(codex.receipt, claude.receipt)
            self.assertEqual(codex.lock, claude.lock)

    def test_lock_excludes_concurrent_refresh_and_reuses_unlocked_metadata(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            lock_path = Path(tmp) / "shared.lock"
            first = index_control.AtomicLock(lock_path, ttl_seconds=1)
            second = index_control.AtomicLock(lock_path, ttl_seconds=1)
            self.assertTrue(first.acquire())
            self.assertFalse(second.acquire())
            first.release()
            self.assertTrue(second.acquire())
            second.release()

            lock_path.write_text(
                json.dumps({"pid": 99999999, "created_at": "stale"}),
                encoding="utf-8",
            )
            old = time.time() - 60
            os.utime(lock_path, (old, old))
            recovered = index_control.AtomicLock(lock_path, ttl_seconds=1)
            self.assertTrue(recovered.acquire())
            recovered.release()

    def test_lock_excludes_a_separate_process(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            lock_path = Path(tmp) / "cross-process.lock"
            child_code = (
                "import importlib.util,sys,time;"
                f"s=importlib.util.spec_from_file_location('index_control_child',r'{SCRIPT}');"
                "m=importlib.util.module_from_spec(s);sys.modules[s.name]=m;s.loader.exec_module(m);"
                f"lock=m.AtomicLock(m.Path(r'{lock_path}'));"
                "assert lock.acquire();print('LOCKED',flush=True);time.sleep(1.5);lock.release()"
            )
            child = subprocess.Popen(
                [sys.executable, "-c", child_code],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                encoding="utf-8",
            )
            try:
                stdout_stream = child.stdout
                self.assertIsNotNone(stdout_stream)
                if stdout_stream is None:
                    raise AssertionError("child stdout pipe is unavailable")
                self.assertEqual(stdout_stream.readline().strip(), "LOCKED")
                contender = index_control.AtomicLock(lock_path)
                self.assertFalse(contender.acquire())
            finally:
                stdout, stderr = child.communicate(timeout=5)
            self.assertEqual(child.returncode, 0, f"stdout={stdout} stderr={stderr}")

    def test_atomic_json_never_leaves_temporary_file(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "nested" / "latest.json"
            index_control.atomic_write_json(target, {"status": "READY"})
            self.assertEqual(json.loads(target.read_text(encoding="utf-8"))["status"], "READY")
            self.assertEqual(list(target.parent.glob("*.tmp")), [])

    def test_history_pruning_keeps_only_the_newest_receipts(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            history = Path(tmp)
            for position in range(5):
                receipt = history / f"{position}.json"
                receipt.write_text("{}", encoding="utf-8")
                stamp = time.time() + position
                os.utime(receipt, (stamp, stamp))
            index_control.prune_history(history, keep=2)
            self.assertEqual(
                sorted(path.name for path in history.glob("*.json")),
                ["3.json", "4.json"],
            )


class ControllerTests(unittest.TestCase):
    def test_live_status_reuses_ccc_receipt_without_starting_ccc(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            repo = base / "repo"
            repo.mkdir()
            RepositoryFixture(repo)
            settings = repo / ".cocoindex_code" / "settings.yml"
            settings.parent.mkdir()
            settings.write_text("include_patterns: ['**/*.txt']\n", encoding="utf-8")

            def forbidden_runner(argv, cwd, env, timeout):
                raise AssertionError(f"live status must not execute CCC: {argv}")

            controller = index_control.IndexController(
                host="codex",
                root=repo,
                home=base,
                runner=forbidden_runner,
                ccc_command=["fake-ccc"],
            )
            source = index_control.fingerprint_repository(repo, home=base)
            controller.paths.receipt.parent.mkdir(parents=True, exist_ok=True)
            controller.paths.receipt.write_text(
                json.dumps(
                    {
                        "schema_version": 1,
                        "repository": source,
                        "providers": {
                            "ccc": {
                                "status": "READY",
                                "reasons": [],
                                "tool_version": "0.2.37",
                                "files": 2,
                                "chunks": 12,
                            }
                        },
                    }
                ),
                encoding="utf-8",
            )

            with mock.patch.object(index_control, "ccc_version", return_value="0.2.37"):
                status = controller.live_status()

            self.assertEqual(status["providers"]["ccc"]["status"], "READY")
            self.assertEqual(status["providers"]["ccc"]["observation_mode"], "cached_receipt")
            self.assertEqual(status["providers"]["ccc"]["files"], 2)
            self.assertEqual(status["providers"]["ccc"]["chunks"], 12)

    def test_live_status_reuses_graphify_and_semctx_receipts_without_provider_processes(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            repo = base / "repo"
            repo.mkdir()
            RepositoryFixture(repo)
            graph = repo / "graphify-out" / "graph.json"
            graph.parent.mkdir()
            graph.write_text("{}\n", encoding="utf-8")
            (graph.parent / "manifest.json").write_text("{}\n", encoding="utf-8")
            (repo / ".semctx").mkdir()

            def forbidden_runner(argv, cwd, env, timeout):
                raise AssertionError(f"live status must not execute providers: {argv}")

            controller = index_control.IndexController(
                host="claude",
                root=repo,
                home=base,
                runner=forbidden_runner,
                ccc_command=["fake-ccc"],
            )
            source = index_control.fingerprint_repository(repo, home=base)
            controller.paths.receipt.parent.mkdir(parents=True, exist_ok=True)
            controller.paths.receipt.write_text(
                json.dumps(
                    {
                        "schema_version": 1,
                        "repository": source,
                        "providers": {
                            "graphify": {"status": "READY", "reasons": [], "node_count": 7},
                            "semctx": {"status": "READY", "reasons": [], "claim_count": 3},
                        },
                    }
                ),
                encoding="utf-8",
            )

            status = controller.live_status()

            self.assertEqual(status["providers"]["graphify"]["status"], "READY")
            self.assertEqual(status["providers"]["graphify"]["observation_mode"], "cached_receipt")
            self.assertEqual(status["providers"]["semctx"]["status"], "READY")
            self.assertEqual(status["providers"]["semctx"]["observation_mode"], "cached_receipt")

    def test_successful_refresh_binds_receipt_to_exact_repository_state(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            repo = base / "repo"
            repo.mkdir()
            RepositoryFixture(repo)
            settings = repo / ".cocoindex_code" / "settings.yml"
            settings.parent.mkdir()
            settings.write_text("include_patterns: ['**/*.txt']\n", encoding="utf-8")

            def runner(argv, cwd, env, timeout):
                if argv[-1] == "index":
                    return index_control.CommandResult(0, "indexed", "", 0.01)
                if argv[-1] == "status":
                    return index_control.CommandResult(
                        0,
                        "Index stats:\n  Chunks: 12\n  Files:  2\n",
                        "",
                        0.01,
                    )
                raise AssertionError(argv)

            controller = index_control.IndexController(
                host="codex",
                root=repo,
                home=base,
                runner=runner,
                ccc_command=["fake-ccc"],
            )
            receipt = controller.refresh(probe_graphify=False, probe_semctx=False)
            self.assertEqual(receipt["overall_status"], "READY")
            self.assertEqual(receipt["providers"]["ccc"]["status"], "READY")
            self.assertEqual(receipt["providers"]["ccc"]["files"], 2)
            self.assertEqual(receipt["providers"]["ccc"]["chunks"], 12)
            self.assertEqual(
                receipt["repository"]["state_id"],
                index_control.fingerprint_repository(repo, home=base)["state_id"],
            )
            saved = json.loads(controller.paths.receipt.read_text(encoding="utf-8"))
            self.assertEqual(saved["run_id"], receipt["run_id"])

    def test_refresh_fails_closed_when_repository_changes_during_indexing(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            repo = base / "repo"
            repo.mkdir()
            RepositoryFixture(repo)
            settings = repo / ".cocoindex_code" / "settings.yml"
            settings.parent.mkdir()
            settings.write_text("include_patterns: ['**/*.txt']\n", encoding="utf-8")

            def runner(argv, cwd, env, timeout):
                if argv[-1] == "index":
                    (repo / "tracked.txt").write_text("changed mid-index\n", encoding="utf-8")
                    return index_control.CommandResult(0, "indexed", "", 0.01)
                if argv[-1] == "status":
                    return index_control.CommandResult(0, "Files:  1\nChunks: 1\n", "", 0.01)
                raise AssertionError(argv)

            controller = index_control.IndexController(
                host="claude",
                root=repo,
                home=base,
                runner=runner,
                ccc_command=["fake-ccc"],
            )
            receipt = controller.refresh(probe_graphify=False, probe_semctx=False)
            provider = receipt["providers"]["ccc"]
            self.assertEqual(provider["status"], "STALE")
            self.assertIn("REPOSITORY_CHANGED_DURING_REFRESH", provider["reasons"])
            self.assertEqual(receipt["overall_status"], "STALE")

    def test_graphify_only_refresh_fails_closed_when_repository_changes(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            repo = base / "repo"
            repo.mkdir()
            RepositoryFixture(repo)
            graph = repo / "graphify-out" / "graph.json"
            graph.parent.mkdir()
            graph.write_text("{}\n", encoding="utf-8")
            (graph.parent / "manifest.json").write_text("{}\n", encoding="utf-8")

            def runner(argv, cwd, env, timeout):
                (repo / "tracked.txt").write_text("changed during graph probe\n", encoding="utf-8")
                return index_control.CommandResult(
                    0,
                    json.dumps(
                        {
                            "new_total": 0,
                            "deleted_count": 0,
                            "changed_by_type": {},
                            "total_files": 1,
                        }
                    ),
                    "",
                    0.01,
                )

            controller = index_control.IndexController(
                host="codex",
                root=repo,
                home=base,
                runner=runner,
                ccc_command=["fake-ccc"],
            )
            with mock.patch.object(index_control, "resolve_graphify_python", return_value=Path(sys.executable)):
                receipt = controller.refresh(probe_semctx=False)
            provider = receipt["providers"]["graphify"]
            self.assertEqual(provider["status"], "STALE")
            self.assertIn("REPOSITORY_CHANGED_DURING_REFRESH", provider["reasons"])
            self.assertEqual(receipt["overall_status"], "STALE")

    def test_graphify_invalid_detect_output_cannot_be_ready(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            repo = base / "repo"
            repo.mkdir()
            RepositoryFixture(repo)
            graph = repo / "graphify-out" / "graph.json"
            graph.parent.mkdir()
            graph.write_text("{}\n", encoding="utf-8")
            (graph.parent / "manifest.json").write_text("{}\n", encoding="utf-8")

            def runner(argv, cwd, env, timeout):
                return index_control.CommandResult(0, "{}", "", 0.01)

            controller = index_control.IndexController(
                host="codex",
                root=repo,
                home=base,
                runner=runner,
                ccc_command=["fake-ccc"],
            )
            with mock.patch.object(index_control, "resolve_graphify_python", return_value=Path(sys.executable)):
                receipt = controller.refresh(probe_semctx=False)
            provider = receipt["providers"]["graphify"]
            self.assertEqual(provider["status"], "FAILED")
            self.assertIn("INVALID_DETECT_OUTPUT", provider["reasons"])

    def test_semctx_only_refresh_fails_closed_when_repository_changes(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            repo = base / "repo"
            repo.mkdir()
            RepositoryFixture(repo)
            (repo / ".semctx").mkdir()

            def runner(argv, cwd, env, timeout):
                (repo / "tracked.txt").write_text("changed during semctx probe\n", encoding="utf-8")
                return index_control.CommandResult(0, '{"verdict":"CLEAN"}', "", 0.01)

            controller = index_control.IndexController(
                host="claude",
                root=repo,
                home=base,
                runner=runner,
                ccc_command=["fake-ccc"],
            )
            with mock.patch.dict(os.environ, {"INDEX_CONTROL_SEMCTX": "fake-semctx"}):
                receipt = controller.refresh(probe_graphify=False)
            provider = receipt["providers"]["semctx"]
            self.assertEqual(provider["status"], "STALE")
            self.assertIn("REPOSITORY_CHANGED_DURING_REFRESH", provider["reasons"])
            self.assertEqual(receipt["overall_status"], "STALE")

    def test_semctx_nonzero_exit_cannot_be_ready_even_with_clean_json(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            repo = base / "repo"
            repo.mkdir()
            RepositoryFixture(repo)
            (repo / ".semctx").mkdir()

            def runner(argv, cwd, env, timeout):
                return index_control.CommandResult(7, '{"verdict":"CLEAN"}', "boom", 0.01)

            controller = index_control.IndexController(
                host="codex",
                root=repo,
                home=base,
                runner=runner,
                ccc_command=["fake-ccc"],
            )
            with mock.patch.dict(os.environ, {"INDEX_CONTROL_SEMCTX": "fake-semctx"}):
                receipt = controller.refresh(probe_graphify=False)
            provider = receipt["providers"]["semctx"]
            self.assertEqual(provider["status"], "FAILED")
            self.assertIn("STATUS_COMMAND_FAILED", provider["reasons"])

    def test_semctx_contract_exit_three_preserves_stale_verdict(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            repo = base / "repo"
            repo.mkdir()
            RepositoryFixture(repo)
            (repo / ".semctx").mkdir()

            def runner(argv, cwd, env, timeout):
                return index_control.CommandResult(
                    3,
                    '{"verdict":"STALE","reasons":["HEAD_MISMATCH"]}',
                    "",
                    0.01,
                )

            controller = index_control.IndexController(
                host="codex",
                root=repo,
                home=base,
                runner=runner,
                ccc_command=["fake-ccc"],
            )
            with mock.patch.dict(os.environ, {"INDEX_CONTROL_SEMCTX": "fake-semctx"}):
                receipt = controller.refresh(probe_graphify=False)
            provider = receipt["providers"]["semctx"]
            self.assertEqual(provider["status"], "STALE")
            self.assertIn("HEAD_MISMATCH", provider["reasons"])

    def test_semctx_exit_three_rejects_undocumented_verdict(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            repo = base / "repo"
            repo.mkdir()
            RepositoryFixture(repo)
            (repo / ".semctx").mkdir()

            def runner(argv, cwd, env, timeout):
                return index_control.CommandResult(3, '{"verdict":"DIRTY_UNKNOWN"}', "", 0.01)

            controller = index_control.IndexController(
                host="codex",
                root=repo,
                home=base,
                runner=runner,
                ccc_command=["fake-ccc"],
            )
            with mock.patch.dict(os.environ, {"INDEX_CONTROL_SEMCTX": "fake-semctx"}):
                receipt = controller.refresh(probe_graphify=False)
            provider = receipt["providers"]["semctx"]
            self.assertEqual(provider["status"], "FAILED")
            self.assertIn("STATUS_COMMAND_FAILED", provider["reasons"])

    def test_ccc_invalid_status_output_cannot_be_ready(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            repo = base / "repo"
            repo.mkdir()
            RepositoryFixture(repo)
            settings = repo / ".cocoindex_code" / "settings.yml"
            settings.parent.mkdir()
            settings.write_text("include_patterns: ['**/*.txt']\n", encoding="utf-8")

            def runner(argv, cwd, env, timeout):
                if argv[-1] == "index":
                    return index_control.CommandResult(0, "indexed", "", 0.01)
                if argv[-1] == "status":
                    return index_control.CommandResult(0, "nonsense output", "", 0.01)
                raise AssertionError(argv)

            controller = index_control.IndexController(
                host="codex",
                root=repo,
                home=base,
                runner=runner,
                ccc_command=["fake-ccc"],
            )
            receipt = controller.refresh(probe_graphify=False, probe_semctx=False)
            provider = receipt["providers"]["ccc"]
            self.assertEqual(provider["status"], "FAILED")
            self.assertIn("INVALID_STATUS_OUTPUT", provider["reasons"])

    def test_cached_status_detects_drift_after_a_ready_receipt(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            repo = base / "repo"
            repo.mkdir()
            RepositoryFixture(repo)
            paths = index_control.state_paths("codex", repo, home=base)
            fingerprint = index_control.fingerprint_repository(repo, home=base)
            index_control.atomic_write_json(
                paths.receipt,
                {
                    "overall_status": "READY",
                    "repository": fingerprint,
                    "providers": {"ccc": {"status": "READY", "reasons": []}},
                },
            )
            clean = index_control.cached_status("codex", repo, home=base)
            self.assertEqual(clean["overall_status"], "READY")
            (repo / "tracked.txt").write_text("drift\n", encoding="utf-8")
            stale = index_control.cached_status("codex", repo, home=base)
            self.assertEqual(stale["overall_status"], "STALE")
            self.assertIn("REPOSITORY_STATE_MISMATCH", stale["reasons"])

    def test_mark_dirty_invalidates_only_the_current_host_receipt(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            repo = base / "repo"
            repo.mkdir()
            RepositoryFixture(repo)
            codex_paths = index_control.state_paths("codex", repo, home=base)
            claude_paths = index_control.state_paths("claude", repo, home=base)
            ready = {
                "overall_status": "READY",
                "repository": index_control.fingerprint_repository(repo),
                "providers": {"ccc": {"status": "READY", "reasons": []}},
            }
            index_control.atomic_write_json(codex_paths.receipt, ready)
            index_control.atomic_write_json(claude_paths.receipt, ready)

            marked = index_control.mark_dirty(
                "codex",
                repo,
                reason="SOURCE_MUTATED",
                home=base,
            )
            self.assertEqual(marked["overall_status"], "STALE")
            self.assertIn("SOURCE_MUTATED", marked["reasons"])
            claude = json.loads(claude_paths.receipt.read_text(encoding="utf-8"))
            self.assertEqual(claude["overall_status"], "READY")

    def test_dirty_generation_survives_a_racing_ready_receipt_publication(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            repo = base / "repo"
            repo.mkdir()
            RepositoryFixture(repo)
            paths = index_control.state_paths("codex", repo, home=base)
            fingerprint = index_control.fingerprint_repository(repo)

            index_control.mark_dirty("codex", repo, home=base)
            marker = json.loads(paths.dirty_marker.read_text(encoding="utf-8"))
            index_control.atomic_write_json(
                paths.receipt,
                {
                    "overall_status": "READY",
                    "repository": fingerprint,
                    "providers": {"ccc": {"status": "READY", "reasons": []}},
                    "acknowledged_dirty_generation": None,
                },
            )

            stale = index_control.cached_status("codex", repo, home=base)
            self.assertEqual(stale["overall_status"], "STALE")
            self.assertIn("DIRTY_GENERATION_MISMATCH", stale["reasons"])
            self.assertEqual(stale["dirty_generation"], marker["generation"])

    def test_corrupt_dirty_marker_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            repo = base / "repo"
            repo.mkdir()
            RepositoryFixture(repo)
            settings = repo / ".cocoindex_code" / "settings.yml"
            settings.parent.mkdir()
            settings.write_text("include_patterns: ['**/*.txt']\n", encoding="utf-8")
            paths = index_control.state_paths("codex", repo, home=base)
            paths.dirty_marker.parent.mkdir(parents=True)
            paths.dirty_marker.write_text("{broken", encoding="utf-8")

            def runner(argv, cwd, env, timeout):
                if argv[-1] == "index":
                    return index_control.CommandResult(0, "indexed", "", 0.01)
                if argv[-1] == "status":
                    return index_control.CommandResult(0, "Files: 1\nChunks: 1\n", "", 0.01)
                raise AssertionError(argv)

            controller = index_control.IndexController(
                host="codex",
                root=repo,
                home=base,
                runner=runner,
                ccc_command=["fake-ccc"],
            )
            receipt = controller.refresh(probe_graphify=False, probe_semctx=False)
            self.assertEqual(receipt["overall_status"], "STALE")
            self.assertIn("DIRTY_MARKER_INVALID", receipt["providers"]["ccc"]["reasons"])
            cached = index_control.cached_status("codex", repo, home=base)
            self.assertEqual(cached["overall_status"], "STALE")
            self.assertIn("DIRTY_MARKER_INVALID", cached["reasons"])


class AdapterTests(unittest.TestCase):
    def test_fresh_route_does_not_mutate_the_wake_lease(self) -> None:
        rustc = shutil.which("rustc")
        if rustc is None:
            self.skipTest("rustc is required for the compiled hook regression")
        source = Path(r"C:\Users\Hokli\.codex\hooks\index-control-routing.rs")
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            executable = base / "index-control-routing.exe"
            compiled = subprocess.run(
                [rustc, str(source), "-O", "-o", str(executable)],
                capture_output=True,
                text=True,
                encoding="utf-8",
                check=False,
            )
            self.assertEqual(compiled.returncode, 0, compiled.stderr)
            repo = base / "repo"
            (repo / ".git").mkdir(parents=True)
            state = base / ".codex" / "index-control-plane" / "repos" / "repo-test"
            state.mkdir(parents=True)
            (state / "route-cache.json").write_text(
                json.dumps({
                    "root": str(repo),
                    "expires_at_unix": time.time() + 60,
                    "additional_context": "fresh route",
                    "fallback_context": "safe fallback",
                }),
                encoding="utf-8",
            )
            wake = state / "wake-requested"
            wake.write_text("existing lease\n", encoding="utf-8")
            result = subprocess.run(
                [str(executable)],
                input=json.dumps({"cwd": str(repo), "hook_event_name": "UserPromptSubmit"}),
                capture_output=True,
                text=True,
                encoding="utf-8",
                env={**os.environ, "USERPROFILE": str(base)},
                timeout=5,
                check=False,
            )

            self.assertEqual(result.returncode, 0)
            self.assertIn("fresh route", result.stdout)
            self.assertEqual(wake.read_text(encoding="utf-8"), "existing lease\n")

    def test_expired_route_burst_launches_only_one_worker_wake(self) -> None:
        rustc = shutil.which("rustc")
        if rustc is None:
            self.skipTest("rustc is required for the compiled hook regression")
        source = Path(r"C:\Users\Hokli\.codex\hooks\index-control-routing.rs")
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            executable = base / "index-control-routing.exe"
            compiled = subprocess.run(
                [rustc, str(source), "-O", "-o", str(executable)],
                capture_output=True,
                text=True,
                encoding="utf-8",
                check=False,
            )
            self.assertEqual(compiled.returncode, 0, compiled.stderr)

            repo = base / "repo"
            (repo / ".git").mkdir(parents=True)
            repos_dir = base / ".codex" / "index-control-plane" / "repos"
            for index in range(20):
                (repos_dir / f"decoy-{index:02d}").mkdir(parents=True, exist_ok=True)
            cache_dir = base / ".codex" / "index-control-plane" / "repos" / "repo-test"
            cache_dir.mkdir(parents=True)
            (cache_dir / "route-cache.json").write_text(
                json.dumps({
                    "root": str(repo),
                    "expires_at_unix": time.time() - 60,
                    "fallback_context": "safe fallback",
                }),
                encoding="utf-8",
            )
            scripts = base / ".agents" / "skills" / "index-control-plane" / "scripts"
            scripts.mkdir(parents=True)
            marker = base / "wake-count.txt"
            launcher = scripts / "fake_launcher.py"
            launcher.write_text(
                "import os,pathlib\n"
                "path=pathlib.Path(os.environ['WAKE_MARKER'])\n"
                "with path.open('a', encoding='utf-8') as stream: stream.write('wake\\n')\n",
                encoding="utf-8",
            )
            worker = scripts / "fake_worker.py"
            worker.write_text("pass\n", encoding="utf-8")
            payload = json.dumps({"cwd": str(repo), "hook_event_name": "UserPromptSubmit"})
            env = {
                **os.environ,
                "USERPROFILE": str(base),
                "INDEX_CONTROL_PYTHON": sys.executable,
                "INDEX_CONTROL_LAUNCHER": str(launcher),
                "INDEX_CONTROL_WORKER": str(worker),
                "WAKE_MARKER": str(marker),
            }

            def invoke_hook():
                return subprocess.run(
                    [str(executable)],
                    input=payload,
                    capture_output=True,
                    text=True,
                    encoding="utf-8",
                    env=env,
                    timeout=5,
                    check=False,
                )

            with ThreadPoolExecutor(max_workers=6) as pool:
                outputs = list(pool.map(lambda _: invoke_hook(), range(6)))
            deadline = time.monotonic() + 2.0
            while time.monotonic() < deadline and (not marker.is_file() or len(marker.read_text(encoding="utf-8").splitlines()) < 1):
                time.sleep(0.02)

            self.assertTrue(all(item.returncode == 0 for item in outputs))
            self.assertTrue(all("safe fallback" in item.stdout for item in outputs))
            self.assertEqual(marker.read_text(encoding="utf-8").splitlines(), ["wake"])

    def test_missing_route_burst_launches_only_one_worker_wake(self) -> None:
        rustc = shutil.which("rustc")
        if rustc is None:
            self.skipTest("rustc is required for the compiled hook regression")
        source = Path(r"C:\Users\Hokli\.codex\hooks\index-control-routing.rs")
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            executable = base / "index-control-routing.exe"
            compiled = subprocess.run(
                [rustc, str(source), "-O", "-o", str(executable)],
                capture_output=True,
                text=True,
                encoding="utf-8",
                check=False,
            )
            self.assertEqual(compiled.returncode, 0, compiled.stderr)
            repo = base / "repo"
            (repo / ".git").mkdir(parents=True)
            scripts = base / ".agents" / "skills" / "index-control-plane" / "scripts"
            scripts.mkdir(parents=True)
            marker = base / "wake-count.txt"
            launcher = scripts / "fake_launcher.py"
            launcher.write_text(
                "import os,pathlib\n"
                "path=pathlib.Path(os.environ['WAKE_MARKER'])\n"
                "with path.open('a', encoding='utf-8') as stream: stream.write('wake\\n')\n",
                encoding="utf-8",
            )
            worker = scripts / "fake_worker.py"
            worker.write_text("pass\n", encoding="utf-8")
            payload = json.dumps({"cwd": str(repo), "hook_event_name": "UserPromptSubmit"})
            env = {
                **os.environ,
                "USERPROFILE": str(base),
                "INDEX_CONTROL_PYTHON": sys.executable,
                "INDEX_CONTROL_LAUNCHER": str(launcher),
                "INDEX_CONTROL_WORKER": str(worker),
                "WAKE_MARKER": str(marker),
            }

            def invoke_hook():
                return subprocess.run(
                    [str(executable)], input=payload, capture_output=True, text=True,
                    encoding="utf-8", env=env, timeout=5, check=False,
                )

            with ThreadPoolExecutor(max_workers=6) as pool:
                outputs = list(pool.map(lambda _: invoke_hook(), range(6)))
            deadline = time.monotonic() + 2.0
            while time.monotonic() < deadline and (
                not marker.is_file() or len(marker.read_text(encoding="utf-8").splitlines()) < 1
            ):
                time.sleep(0.02)

            self.assertTrue(all(item.returncode == 0 for item in outputs))
            self.assertTrue(all("safe fallback" in item.stdout for item in outputs))
            self.assertEqual(marker.read_text(encoding="utf-8").splitlines(), ["wake"])

    def test_failed_missing_route_wake_is_retried_after_the_bounded_lease(self) -> None:
        rustc = shutil.which("rustc")
        if rustc is None:
            self.skipTest("rustc is required for the compiled hook regression")
        source = Path(r"C:\Users\Hokli\.codex\hooks\index-control-routing.rs")
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            executable = base / "index-control-routing.exe"
            compiled = subprocess.run(
                [rustc, str(source), "-O", "-o", str(executable)],
                capture_output=True, text=True, encoding="utf-8", check=False,
            )
            self.assertEqual(compiled.returncode, 0, compiled.stderr)
            repo = base / "repo"
            (repo / ".git").mkdir(parents=True)
            scripts = base / ".agents" / "skills" / "index-control-plane" / "scripts"
            scripts.mkdir(parents=True)
            worker = scripts / "fake_worker.py"
            worker.write_text("pass\n", encoding="utf-8")
            launcher = scripts / "fake_launcher.py"
            marker = base / "wake-count.txt"
            payload = json.dumps({"cwd": str(repo), "hook_event_name": "UserPromptSubmit"})
            env = {
                **os.environ,
                "USERPROFILE": str(base),
                "INDEX_CONTROL_PYTHON": sys.executable,
                "INDEX_CONTROL_LAUNCHER": str(launcher),
                "INDEX_CONTROL_WORKER": str(worker),
                "WAKE_MARKER": str(marker),
            }

            first = subprocess.run(
                [str(executable)], input=payload, capture_output=True, text=True,
                encoding="utf-8", env=env, timeout=5, check=False,
            )
            self.assertEqual(first.returncode, 0)
            self.assertFalse(marker.exists())
            lease = next((base / ".codex" / "index-control-plane" / "wake-leases").rglob("wake-requested"))
            expired = time.time() - 10
            os.utime(lease, (expired, expired))
            launcher.write_text(
                "import os,pathlib\n"
                "path=pathlib.Path(os.environ['WAKE_MARKER'])\n"
                "with path.open('a', encoding='utf-8') as stream: stream.write('wake\\n')\n",
                encoding="utf-8",
            )

            second = subprocess.run(
                [str(executable)], input=payload, capture_output=True, text=True,
                encoding="utf-8", env=env, timeout=5, check=False,
            )
            deadline = time.monotonic() + 2.0
            while time.monotonic() < deadline and not marker.is_file():
                time.sleep(0.02)
            self.assertEqual(second.returncode, 0)
            self.assertEqual(marker.read_text(encoding="utf-8").splitlines(), ["wake"])

    def test_codex_adapter_routes_only_on_user_prompt_submit(self) -> None:
        adapter = Path(r"C:\Users\Hokli\.codex\hooks\claude-harness-adapter.ps1")
        source = adapter.read_text(encoding="utf-8-sig")
        session_start = source.split("if ($eventName -eq 'SessionStart')", 1)[1].split(
            "if ($eventName -eq 'UserPromptSubmit')", 1
        )[0]
        user_prompt_submit = source.split("if ($eventName -eq 'UserPromptSubmit')", 1)[1].split(
            "if ($eventName -eq 'PreToolUse')", 1
        )[0]

        self.assertNotIn("Get-IndexControlRouting", session_start)
        self.assertIn("$routing = Get-IndexControlRouting $cwd", user_prompt_submit)

    def test_codex_lifecycle_adapter_hooks_preserve_shared_console_and_are_trusted(self) -> None:
        hooks_path = Path(r"C:\Users\Hokli\.codex\hooks.json")
        config_path = Path(r"C:\Users\Hokli\.codex\config.toml")
        hooks_config = json.loads(hooks_path.read_text(encoding="utf-8"))
        config = tomllib.loads(config_path.read_text(encoding="utf-8"))
        labels = {
            "SessionStart": "session_start",
            "PreToolUse": "pre_tool_use",
            "PostToolUse": "post_tool_use",
            "UserPromptSubmit": "user_prompt_submit",
            "Stop": "stop",
        }
        found = 0
        for event, label in labels.items():
            for group_index, entry in enumerate(hooks_config["hooks"][event]):
                for handler_index, hook in enumerate(entry["hooks"]):
                    if "claude-harness-adapter.ps1" not in hook.get("command", ""):
                        continue
                    found += 1
                    self.assertNotIn("-WindowStyle", hook["command"])
                    identity = {
                        "event_name": label,
                        **({"matcher": entry["matcher"]} if entry.get("matcher") else {}),
                        "hooks": [
                            {
                                "type": "command",
                                "command": hook["command"],
                                "timeout": max(1, hook.get("timeout", 600)),
                                "async": hook.get("async", False),
                                **({"statusMessage": hook["statusMessage"]} if hook.get("statusMessage") else {}),
                            }
                        ],
                    }
                    canonical = json.dumps(identity, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
                    expected = "sha256:" + hashlib.sha256(canonical.encode("utf-8")).hexdigest()
                    key = f"{hooks_path}:{label}:{group_index}:{handler_index}"
                    self.assertEqual(config["hooks"]["state"][key]["trusted_hash"], expected)
        self.assertEqual(found, 4)
        prompt_commands = [
            hook.get("command", "")
            for entry in hooks_config["hooks"]["UserPromptSubmit"]
            for hook in entry["hooks"]
        ]
        self.assertFalse(any("claude-harness-adapter.ps1" in command for command in prompt_commands))
        self.assertEqual(sum("index-control-routing.exe" in command for command in prompt_commands), 1)

    def test_claude_index_hooks_prefer_pythonw(self) -> None:
        hooks = (
            Path(r"C:\Users\Hokli\.claude\hooks\cocoindex-index-refresh.sh"),
            Path(r"C:\Users\Hokli\.claude\hooks\index-control-mark-dirty.sh"),
        )
        for hook in hooks:
            self.assertIn("C:/Python314/pythonw.exe", hook.read_text(encoding="utf-8"), hook)

    def test_codex_stop_hook_is_registered_and_trusted(self) -> None:
        hooks_path = Path(r"C:\Users\Hokli\.codex\hooks.json")
        config_path = Path(r"C:\Users\Hokli\.codex\config.toml")
        hooks_config = json.loads(hooks_path.read_text(encoding="utf-8"))
        stop_entries = hooks_config["hooks"]["Stop"]
        matches = [
            (group_index, handler_index, entry, hook)
            for group_index, entry in enumerate(stop_entries)
            for handler_index, hook in enumerate(entry["hooks"])
            if "claude-harness-adapter.ps1" in hook.get("command", "")
        ]
        self.assertEqual(len(matches), 1)
        group_index, handler_index, entry, hook = matches[0]
        identity = {
            "event_name": "stop",
            **({"matcher": entry["matcher"]} if entry.get("matcher") else {}),
            "hooks": [
                {
                    "type": "command",
                    "command": hook["command"],
                    "timeout": max(1, hook.get("timeout", 600)),
                    "async": hook.get("async", False),
                    **({"statusMessage": hook["statusMessage"]} if hook.get("statusMessage") else {}),
                }
            ],
        }
        canonical = json.dumps(identity, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
        expected_hash = "sha256:" + hashlib.sha256(canonical.encode("utf-8")).hexdigest()
        config = tomllib.loads(config_path.read_text(encoding="utf-8"))
        state_key = f"{hooks_path}:stop:{group_index}:{handler_index}"
        self.assertEqual(config["hooks"]["state"][state_key]["trusted_hash"], expected_hash)

    @unittest.skipUnless(os.name == "nt", "Codex adapter smoke test is Windows-specific")
    def test_codex_background_refresh_does_not_hold_capture_pipe_open(self) -> None:
        adapter = Path(r"C:\Users\Hokli\.codex\hooks\claude-harness-adapter.ps1")
        powershell = shutil.which("powershell.exe")
        if powershell is None:
            self.skipTest("Windows PowerShell is unavailable")
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            repo = base / "repo"
            repo.mkdir()
            RepositoryFixture(repo)
            slow = base / "slow_controller.py"
            child_started = base / "slow-controller-started.txt"
            child_release = base / "slow-controller-release.txt"
            sentinel = base / "slow-controller-finished.txt"
            slow.write_text(
                "import pathlib,time\n"
                f"started = pathlib.Path({str(child_started)!r})\n"
                f"release = pathlib.Path({str(child_release)!r})\n"
                "started.write_text('started', encoding='utf-8')\n"
                "deadline = time.monotonic() + 8\n"
                "while not release.is_file() and time.monotonic() < deadline:\n"
                "    time.sleep(0.05)\n"
                f"pathlib.Path({str(sentinel)!r}).write_text('finished', encoding='utf-8')\n"
                "print('{}')\n",
                encoding="utf-8",
            )
            payload = {
                "hook_event_name": "SessionStart",
                "cwd": str(repo),
                "session_id": uuid.uuid4().hex,
                "source": "startup",
            }
            env = dict(os.environ)
            env.update(
                {
                    "HOME": str(base),
                    "USERPROFILE": str(base),
                    "INDEX_CONTROL_CONTROLLER": str(slow),
                    "INDEX_CONTROL_PYTHON": sys.executable,
                }
            )
            started = time.monotonic()
            try:
                completed = subprocess.run(
                    [powershell, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(adapter)],
                    input=json.dumps(payload),
                    capture_output=True,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    env=env,
                    timeout=5,
                    check=False,
                )
            except BaseException:
                child_release.write_text("release", encoding="utf-8")
                cleanup_deadline = time.monotonic() + 3
                while not sentinel.is_file() and time.monotonic() < cleanup_deadline:
                    time.sleep(0.05)
                raise
            elapsed = time.monotonic() - started
            self.assertEqual(completed.returncode, 0, completed.stderr)
            json.loads(completed.stdout.strip())
            self.assertLess(elapsed, 5.0, f"adapter waited {elapsed:.2f}s for background child")
            started_deadline = time.monotonic() + 4
            while not child_started.is_file() and time.monotonic() < started_deadline:
                time.sleep(0.05)
            self.assertTrue(child_started.is_file(), "background controller never started")
            self.assertFalse(sentinel.is_file(), "adapter waited for the background controller to finish")
            child_release.write_text("release", encoding="utf-8")
            deadline = time.monotonic() + 8
            while not sentinel.is_file() and time.monotonic() < deadline:
                time.sleep(0.05)
            self.assertTrue(sentinel.is_file(), "background controller never executed")
            error_path = base / ".codex" / "index-control-plane" / "last-hook-error.json"
            self.assertFalse(error_path.exists(), error_path.read_text(encoding="utf-8-sig") if error_path.exists() else "")

    @unittest.skipUnless(os.name == "nt", "Codex adapter smoke test is Windows-specific")
    def test_codex_adapter_records_missing_dependency_without_blocking(self) -> None:
        adapter = Path(r"C:\Users\Hokli\.codex\hooks\claude-harness-adapter.ps1")
        powershell = shutil.which("powershell.exe")
        if powershell is None:
            self.skipTest("Windows PowerShell is unavailable")
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            repo = base / "repo"
            repo.mkdir()
            RepositoryFixture(repo)
            payload = {
                "hook_event_name": "SessionStart",
                "cwd": str(repo),
                "session_id": uuid.uuid4().hex,
                "source": "startup",
            }
            env = dict(os.environ)
            env.update(
                {
                    "HOME": str(base),
                    "USERPROFILE": str(base),
                    "INDEX_CONTROL_CONTROLLER": str(base / "missing-controller.py"),
                    "INDEX_CONTROL_PYTHON": sys.executable,
                }
            )
            completed = subprocess.run(
                [powershell, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(adapter)],
                input=json.dumps(payload),
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                env=env,
                timeout=5,
                check=False,
            )
            self.assertEqual(completed.returncode, 0, completed.stderr)
            json.loads(completed.stdout.strip())
            error_path = base / ".codex" / "index-control-plane" / "last-hook-error.json"
            error = json.loads(error_path.read_text(encoding="utf-8-sig"))
            self.assertEqual(error["category"], "DEPENDENCY_MISSING")
            self.assertEqual(error["host"], "codex")

    @unittest.skipUnless(os.name == "nt", "Codex adapter smoke test is Windows-specific")
    def test_codex_adapter_treats_non_git_directory_as_unsupported(self) -> None:
        adapter = Path(r"C:\Users\Hokli\.codex\hooks\claude-harness-adapter.ps1")
        powershell = shutil.which("powershell.exe")
        if powershell is None:
            self.skipTest("Windows PowerShell is unavailable")
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            payload = {
                "hook_event_name": "PostToolUse",
                "tool_name": "Write",
                "tool_input": {"file_path": str(base / "note.txt")},
                "cwd": str(base),
                "session_id": uuid.uuid4().hex,
            }
            env = dict(os.environ)
            env.update(
                {
                    "HOME": str(base),
                    "USERPROFILE": str(base),
                    "INDEX_CONTROL_CONTROLLER": str(SCRIPT),
                    "INDEX_CONTROL_PYTHON": sys.executable,
                    "INDEX_CONTROL_LAUNCHER": str(SCRIPT.parent / "launch_detached.py"),
                }
            )
            completed = subprocess.run(
                [powershell, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(adapter)],
                input=json.dumps(payload),
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                env=env,
                timeout=5,
                check=False,
            )
            self.assertEqual(completed.returncode, 0, completed.stderr)
            json.loads(completed.stdout.strip())
            error_path = base / ".codex" / "index-control-plane" / "last-hook-error.json"
            self.assertFalse(error_path.exists(), error_path.read_text(encoding="utf-8-sig") if error_path.exists() else "")


if __name__ == "__main__":
    unittest.main()
