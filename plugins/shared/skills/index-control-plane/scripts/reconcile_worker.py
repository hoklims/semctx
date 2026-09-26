from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import time
import traceback
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Mapping, Sequence


SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

import index_control


WORKER_VERSION = "2.5.0"
DEFAULT_POLL_SECONDS = 2.0
DEFAULT_RECONCILE_SECONDS = 60.0
DEFAULT_IDLE_TTL_SECONDS = 300.0
DEFAULT_TIMEOUT_SECONDS = 900


@dataclass(frozen=True)
class ProviderPolicy:
    quiet_seconds: float
    checkpoint_required: bool
    retry_base_seconds: float = 15.0
    retry_max_seconds: float = 300.0


DEFAULT_POLICIES: dict[str, ProviderPolicy] = {
    "ccc": ProviderPolicy(quiet_seconds=8.0, checkpoint_required=False),
    "graphify": ProviderPolicy(quiet_seconds=20.0, checkpoint_required=True),
    "semctx": ProviderPolicy(quiet_seconds=45.0, checkpoint_required=True),
}


def worktree_identity(source: Mapping[str, Any] | None) -> dict[str, Any] | None:
    """What a checkpoint actually seals: the operator's working state.

    Deliberately excludes desired_state_hash, which folds the controller's own
    version and scripts into state_id. Upgrading the control plane bumps the
    generation on every repository at once while no working tree changed; that
    must not revoke a checkpoint, or every semctx-gated repository starves on
    each release. Any real change to HEAD, the working tree or provider config
    still changes this identity and re-engages the gate.
    """
    if not isinstance(source, Mapping):
        return None
    head = source.get("head")
    working_tree_hash = source.get("working_tree_hash")
    config_hash = source.get("config_hash")
    if not head or not working_tree_hash or not config_hash:
        return None
    return {"head": head, "working_tree_hash": working_tree_hash, "config_hash": config_hash}


ProviderExecutor = Callable[[str, dict[str, Any], index_control.SharedStatePaths], dict[str, Any]]

GRAPHIFY_CODE_EXTENSIONS = index_control.GRAPHIFY_CODE_EXTENSIONS


def load_policies(home: Path | None = None) -> dict[str, ProviderPolicy]:
    base = (home or Path.home()).resolve()
    payload = _read_json(base / ".agents" / "index-control-plane" / "policy.json")
    if payload is None:
        return dict(DEFAULT_POLICIES)
    configured = payload.get("providers")
    if not isinstance(configured, dict):
        return dict(DEFAULT_POLICIES)
    policies: dict[str, ProviderPolicy] = {}
    for name, default in DEFAULT_POLICIES.items():
        value = configured.get(name)
        if not isinstance(value, dict):
            policies[name] = default
            continue
        policies[name] = ProviderPolicy(
            quiet_seconds=max(0.0, float(value.get("quiet_seconds", default.quiet_seconds))),
            checkpoint_required=bool(value.get("checkpoint_required", default.checkpoint_required)),
            retry_base_seconds=max(1.0, float(value.get("retry_base_seconds", default.retry_base_seconds))),
            retry_max_seconds=max(1.0, float(value.get("retry_max_seconds", default.retry_max_seconds))),
        )
    return policies


def _environment_float(name: str, default: float) -> float:
    value = os.environ.get(name)
    if value is None:
        return default
    try:
        return float(value)
    except ValueError:
        return default


def load_runtime_policy(home: Path | None = None) -> tuple[float, float, float]:
    base = (home or Path.home()).resolve()
    payload = _read_json(base / ".agents" / "index-control-plane" / "policy.json") or {}
    poll = max(0.25, float(payload.get("poll_seconds", DEFAULT_POLL_SECONDS)))
    reconcile = max(5.0, float(payload.get("reconcile_seconds", DEFAULT_RECONCILE_SECONDS)))
    configured_idle_ttl = float(payload.get("idle_ttl_seconds", DEFAULT_IDLE_TTL_SECONDS))
    idle_ttl = max(
        0.0,
        _environment_float("INDEX_CONTROL_WORKER_IDLE_TTL_SECONDS", configured_idle_ttl),
    )
    return poll, reconcile, idle_ttl


def _read_json(path: Path) -> dict[str, Any] | None:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return value if isinstance(value, dict) else None


def _parse_json_output(text: str) -> dict[str, Any] | None:
    stripped = text.strip()
    if not stripped:
        return None
    candidates = [stripped, stripped.splitlines()[-1]]
    for candidate in candidates:
        try:
            value = json.loads(candidate)
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            return value
    return None


def _failure(reason: str, result: index_control.CommandResult | None = None) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "status": "FAILED",
        "reasons": [reason],
        "failure_class": "transient" if result is not None and result.returncode == 124 else "deterministic",
    }
    if result is not None:
        payload.update(
            {
                "exit_code": result.returncode,
                "duration_seconds": round(result.duration_seconds, 3),
                "stdout_tail": result.stdout[-index_control.MAX_CAPTURE_CHARS :],
                "stderr_tail": result.stderr[-index_control.MAX_CAPTURE_CHARS :],
            }
        )
    return payload


def _normalized_reasons(value: Any, *extra: str) -> list[str]:
    items = value if isinstance(value, (list, tuple, set)) else ([] if value is None else [value])
    return sorted({str(reason) for reason in [*items, *extra] if reason is not None})


def execute_ccc(
    root: Path,
    before: dict[str, Any],
    *,
    home: Path | None = None,
    runner: index_control.Runner = index_control.run_command,
    timeout_seconds: int = DEFAULT_TIMEOUT_SECONDS,
) -> dict[str, Any]:
    controller = index_control.IndexController(
        "codex",
        root,
        home=home,
        runner=runner,
        timeout_seconds=timeout_seconds,
    )
    result = controller._probe_ccc(before, refresh=True)
    if result.get("status") == "FAILED" and result.get("index_command_exit_code") == 124:
        result["failure_class"] = "transient"
    return result


def _relative_source_key(value: object, root: Path) -> str | None:
    if not isinstance(value, str) or not value:
        return None
    candidate = Path(value)
    if candidate.is_absolute():
        try:
            candidate = candidate.resolve().relative_to(root.resolve())
        except (OSError, RuntimeError, ValueError):
            return None
    normalized = candidate.as_posix()
    while normalized.startswith("./"):
        normalized = normalized[2:]
    return normalized.casefold() if os.name == "nt" else normalized


def _graph_coverage(
    payload: dict[str, Any] | None,
    manifest_payload: dict[str, Any] | None,
    root: Path,
) -> tuple[set[str], set[str], float]:
    expected = {
        key
        for relative in (manifest_payload or {})
        if Path(str(relative)).suffix.lower() in GRAPHIFY_CODE_EXTENSIONS
        for key in [_relative_source_key(str(relative), root)]
        if key is not None
    }
    nodes = payload.get("nodes") if isinstance(payload, dict) else None
    covered = {
        key
        for node in (nodes or [])
        if isinstance(node, dict)
        for key in [_relative_source_key(node.get("source_file"), root)]
        if key is not None
    }
    ratio = 1.0 if not expected else len(expected & covered) / len(expected)
    return expected, covered, ratio


def _initial_coverage_floor(expected_sources: set[str]) -> float:
    if not expected_sources:
        return 1.0
    # Some supported structural formats legitimately emit zero symbols (for
    # example small JSON evidence files). Require meaningful corpus coverage
    # without rejecting healthy small repositories merely for containing them.
    return min(0.70, max(0.30, 1 / len(expected_sources)))


def _atomic_copy(source: Path, target: Path) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name(f".{target.name}.{uuid.uuid4().hex}.tmp")
    try:
        shutil.copy2(source, temporary)
        os.replace(temporary, target)
    finally:
        temporary.unlink(missing_ok=True)


def publish_staged_graphify(result: dict[str, Any]) -> dict[str, Any]:
    staged_root_value = result.get("_staging_root")
    staged_out_value = result.get("_staging_graphify_out")
    if not isinstance(staged_root_value, str) or not isinstance(staged_out_value, str):
        return result
    staged_root = Path(staged_root_value)
    staged_out = Path(staged_out_value)
    active_graph = Path(str(result["graph_path"]))
    active_out = active_graph.parent
    if result.get("_publish_required") is False:
        shutil.rmtree(staged_root, ignore_errors=True)
        published = {key: value for key, value in result.items() if not key.startswith("_staging_") and key != "_publish_required"}
        published["published_atomically"] = False
        return published
    active_out.mkdir(parents=True, exist_ok=True)
    try:
        for source in staged_out.rglob("*"):
            if not source.is_file() or source.name in {"graph.json", "manifest.json"}:
                continue
            relative = source.relative_to(staged_out)
            target = active_out / relative
            _atomic_copy(source, target)
        _atomic_copy(staged_out / "manifest.json", active_out / "manifest.json")
        # graph.json is the consumer-visible commit point and is replaced last.
        _atomic_copy(staged_out / "graph.json", active_graph)
    finally:
        shutil.rmtree(staged_root, ignore_errors=True)
    published = {
        key: value
        for key, value in result.items()
        if not key.startswith("_staging_") and key != "_publish_required"
    }
    published["published_atomically"] = True
    return published


def discard_staged_graphify(result: dict[str, Any]) -> None:
    staged_root = result.get("_staging_root")
    if isinstance(staged_root, str):
        shutil.rmtree(staged_root, ignore_errors=True)


def execute_graphify(
    root: Path,
    paths: index_control.SharedStatePaths,
    *,
    runner: index_control.Runner = index_control.run_command,
    timeout_seconds: int = DEFAULT_TIMEOUT_SECONDS,
    defer_publish: bool = False,
) -> dict[str, Any]:
    interpreter = index_control.resolve_graphify_python(root)
    if interpreter is None:
        return _failure("GRAPHIFY_INTERPRETER_MISSING")
    output_root = paths.providers / "graphify"
    output_root.mkdir(parents=True, exist_ok=True)
    graph = output_root / "graphify-out" / "graph.json"
    manifest = output_root / "graphify-out" / "manifest.json"
    query_index = output_root / "graphify-out" / "query.sqlite"
    existing_payload = _read_json(graph)
    manifest_payload = _read_json(manifest)
    existing_nodes = existing_payload.get("nodes") if existing_payload else None
    existing_expected, existing_covered, existing_coverage = _graph_coverage(
        existing_payload, manifest_payload, root
    )
    existing_floor = _initial_coverage_floor(existing_expected)
    valid_baseline = (
        isinstance(existing_nodes, list)
        and bool(existing_nodes)
        and existing_coverage >= existing_floor
        and manifest.is_file()
    )
    staging_root = output_root / ".staging" / uuid.uuid4().hex
    staging_out = staging_root / "graphify-out"
    if graph.parent.is_dir():
        shutil.copytree(graph.parent, staging_out, dirs_exist_ok=True)
    else:
        staging_out.mkdir(parents=True, exist_ok=True)
    command = [
        str(interpreter),
        str(SCRIPT_DIR / "graphify_incremental.py"),
        "--root",
        str(root),
        "--output-root",
        str(staging_root),
    ]
    if not valid_baseline:
        command.append("--force-rebuild")
    try:
        execution = runner(command, root, {"PYTHONUTF8": "1"}, timeout_seconds)
    except Exception:
        shutil.rmtree(staging_root, ignore_errors=True)
        raise
    if execution.returncode != 0:
        shutil.rmtree(staging_root, ignore_errors=True)
        return _failure("GRAPHIFY_INDEX_FAILED", execution)
    staged_graph = staging_out / "graph.json"
    staged_manifest = staging_out / "manifest.json"
    staged_query_index = staging_out / "query.sqlite"
    program_result = _parse_json_output(execution.stdout) or {}
    payload = _read_json(staged_graph)
    if payload is None or not isinstance(payload.get("nodes"), list):
        shutil.rmtree(staging_root, ignore_errors=True)
        return _failure("INVALID_GRAPH_OUTPUT", execution)
    edges = payload.get("links") if isinstance(payload.get("links"), list) else payload.get("edges")
    if (
        not isinstance(edges, list)
        or not staged_manifest.is_file()
        or not staged_query_index.is_file()
        or not isinstance(program_result.get("graph_sha256"), str)
    ):
        shutil.rmtree(staging_root, ignore_errors=True)
        return _failure("INVALID_GRAPH_OUTPUT", execution)
    staged_manifest_payload = _read_json(staged_manifest) or {}
    expected_sources, covered_sources, coverage = _graph_coverage(payload, staged_manifest_payload, root)
    covered_expected = len(expected_sources & covered_sources)
    allowed_regression = max(0.01, 2 / max(1, len(expected_sources)))
    initial_floor = _initial_coverage_floor(expected_sources)
    minimum_coverage = max(initial_floor, existing_coverage - allowed_regression) if valid_baseline else initial_floor
    if coverage < minimum_coverage:
        shutil.rmtree(staging_root, ignore_errors=True)
        return {
            **_failure("GRAPH_COVERAGE_REGRESSION", execution),
            "graph_path": str(graph),
            "nodes": len(payload["nodes"]),
            "edges": len(edges),
            "covered_code_files": covered_expected,
            "manifest_code_files": len(expected_sources),
            "coverage_ratio": round(coverage, 4),
            "minimum_coverage_ratio": round(minimum_coverage, 4),
        }
    result = {
        "status": "READY",
        "reasons": [],
        "command": command,
        "exit_code": execution.returncode,
        "duration_seconds": round(execution.duration_seconds, 3),
        "stdout_tail": execution.stdout[-index_control.MAX_CAPTURE_CHARS :],
        "stderr_tail": execution.stderr[-index_control.MAX_CAPTURE_CHARS :],
        "graph_path": str(graph),
        "manifest_path": str(manifest),
        "query_index_path": str(query_index),
        "graph_sha256": program_result["graph_sha256"],
        "nodes": len(payload["nodes"]),
        "edges": len(edges),
        "covered_code_files": covered_expected,
        "manifest_code_files": len(expected_sources),
        "coverage_ratio": round(coverage, 4),
        "incremental": valid_baseline,
        "incremental_fallback": None if valid_baseline else {"reason": "BASELINE_MISSING_OR_PATH_COVERAGE_INVALID"},
        "territory": "structural-code-only",
        "_staging_root": str(staging_root),
        "_staging_graphify_out": str(staging_out),
        "_publish_required": program_result.get("status") != "UNCHANGED",
    }
    return result if defer_publish else publish_staged_graphify(result)


def semctx_builder_host(state: Mapping[str, Any], source: Mapping[str, Any] | None) -> str | None:
    """The host whose own grant authorizes a semctx build; it builds with its binary.

    A dirty worktree is sealed by a checkpoint, so the checkpointing host builds; a
    clean one by the latest attributed event. Nothing attributable means no build:
    guessing would stamp the shared store with an arbitrary host's tool version.
    """
    key = "checkpoint_host" if isinstance(source, Mapping) and source.get("dirty") else "last_event_host"
    host = state.get(key)
    return host if host in index_control.HOSTS else None


def execute_semctx(
    root: Path,
    *,
    host: str,
    home: Path | None = None,
    runner: index_control.Runner = index_control.run_command,
    timeout_seconds: int = DEFAULT_TIMEOUT_SECONDS,
) -> dict[str, Any]:
    executable = index_control.resolve_semctx_command(host, home=home)
    if executable is None:
        return _failure("SEMCTX_EXECUTABLE_MISSING")
    command = [*executable, "index", "--json"]
    execution = runner(command, root, {"NO_COLOR": "1"}, timeout_seconds)
    if execution.returncode != 0:
        return _failure("SEMCTX_INDEX_FAILED", execution)
    payload = _parse_json_output(execution.stdout)
    valid = (
        isinstance(payload, dict)
        and payload.get("indexed") is True
        and isinstance(payload.get("freshnessSeal"), dict)
    )
    if not valid:
        return _failure("INVALID_INDEX_OUTPUT", execution)
    return {
        "status": "READY",
        "reasons": [],
        "command": command,
        "exit_code": execution.returncode,
        "duration_seconds": round(execution.duration_seconds, 3),
        "stdout_tail": execution.stdout[-index_control.MAX_CAPTURE_CHARS :],
        "stderr_tail": execution.stderr[-index_control.MAX_CAPTURE_CHARS :],
        "freshness": payload,
        "territory": "semantic-context-seal",
        "builder_host": host,
    }


class ReconcileWorker:
    def __init__(
        self,
        root: Path | str,
        *,
        home: Path | None = None,
        clock: Callable[[], float] = time.monotonic,
        provider_executor: ProviderExecutor | None = None,
        policies: Mapping[str, ProviderPolicy] | None = None,
        runner: index_control.Runner = index_control.run_command,
        timeout_seconds: int = DEFAULT_TIMEOUT_SECONDS,
        consumer_prober: Callable[[str], dict[str, Any]] | None = None,
    ) -> None:
        self.root = index_control.canonical_root(root)
        self.home = home
        self.paths = index_control.shared_state_paths(self.root, home=home)
        self.clock = clock
        self.policies = load_policies(home) if policies is None else dict(policies)
        self.runner = runner
        self.timeout_seconds = timeout_seconds
        self.provider_executor = provider_executor or self._execute_provider
        self.consumer_prober = consumer_prober or self._probe_consumer
        loaded = _read_json(self.paths.worker_state)
        self.state = loaded or self._initial_state()
        if loaded:
            now = self.clock()
            if isinstance(self.state.get("dirty_since_monotonic"), (int, float)):
                self.state["dirty_since_monotonic"] = now
            for provider_state in (self.state.get("providers") or {}).values():
                if isinstance(provider_state, dict):
                    provider_state.pop("next_retry_at_monotonic", None)

    def _initial_state(self) -> dict[str, Any]:
        return {
            "schema_version": 2,
            "controller_version": index_control.CONTROLLER_VERSION,
            "worker_version": WORKER_VERSION,
            "root": str(self.root),
            "generation": 0,
            "observed_source_state_id": None,
            "source": None,
            "dirty_since_monotonic": None,
            "checkpoint_generation": None,
            "jit_generation": None,
            "active_hosts": [],
            "reasons": [],
            "providers": {},
        }

    def _execute_provider(
        self,
        provider: str,
        before: dict[str, Any],
        paths: index_control.SharedStatePaths,
    ) -> dict[str, Any]:
        if provider == "ccc":
            return execute_ccc(
                self.root,
                before,
                home=self.home,
                runner=self.runner,
                timeout_seconds=self.timeout_seconds,
            )
        if provider == "graphify":
            return execute_graphify(
                self.root,
                paths,
                runner=self.runner,
                timeout_seconds=self.timeout_seconds,
                defer_publish=True,
            )
        if provider == "semctx":
            host = semctx_builder_host(self.state, before)
            if host is None:
                return _failure("SEMCTX_BUILDER_HOST_UNKNOWN")
            return execute_semctx(
                self.root,
                host=host,
                home=self.home,
                runner=self.runner,
                timeout_seconds=self.timeout_seconds,
            )
        return _failure("UNKNOWN_PROVIDER")

    def _probe_consumer(self, host: str) -> dict[str, Any]:
        return index_control.probe_semctx_consumer(
            host,
            self.root,
            home=self.home,
            runner=self.runner,
            timeout_seconds=min(self.timeout_seconds, 300),
        )

    def _refresh_probed_consumers(self, available: Mapping[str, bool], *, retry_negative: bool) -> None:
        """Take each host's verdict and revisit negative results on reconciliation.

        A verdict never schedules a rebuild. A host whose plugin version differs from
        the builder's is reported as skewed instead of being "fixed" by reindexing
        the shared store with its binary, which would only move the skew to the
        other host and start a reindex ping-pong between them.
        """
        provider_state = (self.state.get("providers") or {}).get("semctx")
        source = self.state.get("source") if isinstance(self.state.get("source"), dict) else {}
        if not available.get("semctx") or not isinstance(provider_state, dict):
            return
        builder = provider_state.get("command")
        attempted_at = provider_state.get("attempted_at")
        current_build = (
            provider_state.get("status") == "READY"
            and provider_state.get("indexed_generation") == self.state.get("generation")
            and provider_state.get("indexed_source_state_id") == source.get("state_id")
            and provider_state.get("indexed_corpus_state_id")
            == (source.get("provider_corpus_state_ids") or {}).get("semctx")
            and isinstance(builder, list)
            and len(builder) > 2
            and bool(attempted_at)
        )
        if not current_build:
            return
        consumers = dict(provider_state.get("consumers") or {})
        changed = False
        for host in index_control.HOSTS:
            refreshed = index_control._read_json_file(self.paths.consumers / host / "semctx.json")
            previous = index_control.probed_consumer_verdict(provider_state, host, source.get("state_id"), refreshed)
            if previous and (previous.get("status") == "READY" or not retry_negative):
                continue
            try:
                verdict = dict(self.consumer_prober(host))
            except Exception as error:  # noqa: BLE001 - a failed probe is a verdict, not a crash
                verdict = {
                    "host": host,
                    "status": "FAILED",
                    "reasons": ["CONSUMER_PROBE_EXCEPTION", type(error).__name__],
                }
            verdict["build_attempted_at"] = attempted_at
            verdict["source_state_id"] = source.get("state_id")
            verdict["observed_at"] = index_control.utc_now()
            skewed = (
                verdict.get("status") != "READY"
                and "TOOL_VERSION_MISMATCH" in (verdict.get("upstream_reasons") or [])
                and list(verdict.get("command") or [])[:-2] != builder[:-2]
            )
            if skewed:
                verdict["reasons"] = _normalized_reasons(verdict.get("reasons"), "SEMCTX_HOST_VERSION_SKEW")
            consumers[host] = verdict
            changed = True
        if changed:
            provider_state["consumers"] = consumers
            index_control.atomic_write_json(self.paths.provider_receipts / "semctx.json", provider_state)

    def _drain_events(self, now: float) -> list[dict[str, Any]]:
        events: list[dict[str, Any]] = []
        if not self.paths.events.is_dir():
            return events
        for path in sorted(self.paths.events.glob("*.json")):
            payload = _read_json(path)
            if payload is not None and payload.get("root") == str(self.root):
                events.append(payload)
            try:
                path.unlink()
            except OSError:
                pass
        if not events:
            return events
        hosts = set(self.state.get("active_hosts") or [])
        hosts.update(str(event.get("host")) for event in events if event.get("host") in {"codex", "claude"})
        self.state["active_hosts"] = sorted(hosts)
        attributed = [str(event["host"]) for event in events if event.get("host") in index_control.HOSTS]
        if attributed:
            self.state["last_event_host"] = attributed[-1]
        mutating = any(event.get("kind") == "source_mutated" for event in events)
        if mutating:
            self.state["generation"] = int(self.state.get("generation") or 0) + 1
            self.state["dirty_since_monotonic"] = now
        event_reasons = [str(event.get("reason")) for event in events if event.get("reason")]
        self.state["reasons"] = sorted(set(event_reasons))
        self.state["last_events"] = events[-20:]
        return events

    def _reconcile_source(
        self,
        now: float,
        *,
        force_reconcile: bool,
        events: list[dict[str, Any]],
    ) -> dict[str, Any]:
        observed = self.state.get("observed_source_state_id")
        source_event = any(event.get("kind") == "source_mutated" for event in events)
        reconcile_requested = force_reconcile or bool(events) or observed is None
        if not reconcile_requested and isinstance(self.state.get("source"), dict):
            return dict(self.state["source"])
        source = index_control.fingerprint_repository(self.root, home=self.home)
        if observed is None:
            if not source_event:
                self.state["generation"] = max(1, int(self.state.get("generation") or 0))
                self.state["dirty_since_monotonic"] = now
            reasons = list(self.state.get("reasons") or [])
            reasons.append("INITIAL_RECONCILIATION")
            self.state["reasons"] = sorted(set(reasons))
        elif source["state_id"] != observed and not source_event:
            self.state["generation"] = int(self.state.get("generation") or 0) + 1
            self.state["dirty_since_monotonic"] = now
            reasons = list(self.state.get("reasons") or [])
            reasons.append("PERIODIC_RECONCILIATION_DRIFT" if force_reconcile and not events else "EVENT_RECONCILIATION_DRIFT")
            self.state["reasons"] = sorted(set(reasons))
        self.state["observed_source_state_id"] = source["state_id"]
        self.state["source"] = source
        # The only writer of source_observed_at. Reaching this line means the
        # worktree was just re-fingerprinted; the early return above deliberately
        # leaves the stamp untouched when the cached source is reused, so the
        # observation axis ages honestly between reconciles instead of tracking
        # the worker heartbeat in updated_at.
        self.state["source_observed_at"] = index_control.utc_now()
        checkpoints = [event for event in events if event.get("kind") == "checkpoint"]
        if checkpoints:
            self.state["checkpoint_generation"] = int(self.state.get("generation") or 0)
            self.state["checkpoint_worktree_identity"] = worktree_identity(source)
            host = checkpoints[-1].get("host")
            self.state["checkpoint_host"] = host if host in index_control.HOSTS else None
        if any(event.get("kind") == "jit" for event in events):
            self.state["jit_generation"] = int(self.state.get("generation") or 0)
        return source

    def _provider_due(self, provider: str, policy: ProviderPolicy, source: dict[str, Any], now: float) -> bool:
        generation = int(self.state.get("generation") or 0)
        corpus_state_id = (source.get("provider_corpus_state_ids") or {}).get(provider)
        provider_state = self.state.setdefault("providers", {}).setdefault(
            provider,
            {"status": "STALE", "reasons": ["GENERATION_PENDING"], "indexed_generation": None},
        )
        if (
            provider_state.get("indexed_generation") == generation
            and provider_state.get("indexed_source_state_id") == source.get("state_id")
            and provider_state.get("indexed_corpus_state_id") == corpus_state_id
            and provider_state.get("status") == "READY"
        ):
            return False
        if (
            corpus_state_id
            and provider_state.get("indexed_corpus_state_id") == corpus_state_id
            and provider_state.get("status") == "READY"
        ):
            provider_state.update(
                {
                    "indexed_generation": generation,
                    "indexed_source_state_id": source.get("state_id"),
                    "carried_forward": True,
                    "reasons": [],
                }
            )
            return False
        if provider_state.get("blocked_generation") == generation:
            return False
        retry_at = provider_state.get("next_retry_at_monotonic")
        if isinstance(retry_at, (int, float)) and now < float(retry_at):
            return False
        dirty_since = self.state.get("dirty_since_monotonic")
        if not isinstance(dirty_since, (int, float)):
            return False
        if now - float(dirty_since) < policy.quiet_seconds:
            return False
        if policy.checkpoint_required and source.get("dirty"):
            checkpoint = self.state.get("checkpoint_generation")
            jit = self.state.get("jit_generation")
            authorized = isinstance(checkpoint, int) and checkpoint >= generation
            # A checkpoint seals a working state, not a generation number. If the
            # generation only advanced because the control plane itself changed,
            # the sealed working tree is still the one on disk and the grant holds.
            if not authorized and isinstance(checkpoint, int):
                sealed = self.state.get("checkpoint_worktree_identity")
                authorized = sealed is not None and sealed == worktree_identity(source)
            if provider == "graphify":
                authorized = authorized or (isinstance(jit, int) and jit >= generation)
            if not authorized:
                provider_state["status"] = "STALE"
                provider_state["reasons"] = ["WAITING_FOR_CHECKPOINT"]
                return False
        if provider == "semctx" and semctx_builder_host(self.state, source) is None:
            provider_state["status"] = "STALE"
            provider_state["reasons"] = ["WAITING_FOR_ATTRIBUTED_HOST"]
            return False
        return True

    def _record_provider_result(
        self,
        provider: str,
        result: dict[str, Any],
        *,
        generation: int,
        now: float,
        before: dict[str, Any],
        after: dict[str, Any],
    ) -> None:
        current = {key: value for key, value in result.items() if not key.startswith("_")}
        current["provider"] = provider
        current["attempted_generation"] = generation
        current["attempted_at"] = index_control.utc_now()
        current["source_before"] = before
        current["source_after"] = after
        previous = self.state.setdefault("providers", {}).get(provider, {})
        if after["state_id"] != before["state_id"]:
            discard_staged_graphify(result)
            current["status"] = "STALE"
            current["reasons"] = _normalized_reasons(
                current.get("reasons"), "SOURCE_CHANGED_DURING_PROVIDER_RUN"
            )
            current["indexed_generation"] = None
            current["indexed_source_state_id"] = None
            current["consecutive_failures"] = int(previous.get("consecutive_failures") or 0)
            current.pop("next_retry_at_monotonic", None)
            self.state["generation"] = max(
                int(self.state.get("generation") or 0), generation
            ) + 1
            self.state["observed_source_state_id"] = after["state_id"]
            self.state["source"] = after
            self.state["dirty_since_monotonic"] = now
            self.state["checkpoint_generation"] = None
            self.state["checkpoint_worktree_identity"] = None
            self.state["checkpoint_host"] = None
            self.state["jit_generation"] = None
            for name, provider_state in self.state.setdefault("providers", {}).items():
                if not isinstance(provider_state, dict):
                    continue
                invalidated = dict(provider_state)
                invalidated["status"] = "STALE"
                invalidated["reasons"] = _normalized_reasons(
                    invalidated.get("reasons"), "SOURCE_GENERATION_SUPERSEDED"
                )
                invalidated["indexed_generation"] = None
                invalidated["indexed_source_state_id"] = None
                invalidated.pop("next_retry_at_monotonic", None)
                invalidated.pop("blocked_generation", None)
                self.state["providers"][name] = invalidated
                index_control.atomic_write_json(
                    self.paths.provider_receipts / f"{name}.json", invalidated
                )
        elif current.get("status") == "READY":
            current["indexed_generation"] = generation
            current["indexed_source_state_id"] = before["state_id"]
            current["indexed_corpus_state_id"] = (before.get("provider_corpus_state_ids") or {}).get(provider)
            current["carried_forward"] = False
            current["consecutive_failures"] = 0
            current.pop("next_retry_at_monotonic", None)
            current.pop("blocked_generation", None)
        else:
            current["indexed_generation"] = previous.get("indexed_generation")
            current["indexed_source_state_id"] = previous.get("indexed_source_state_id")
            current["indexed_corpus_state_id"] = previous.get("indexed_corpus_state_id")
            failures = int(previous.get("consecutive_failures") or 0) + 1
            current["consecutive_failures"] = failures
            if current.get("failure_class") == "transient":
                policy = self.policies[provider]
                delay = min(policy.retry_base_seconds * (2 ** (failures - 1)), policy.retry_max_seconds)
                current["next_retry_at_monotonic"] = now + delay
                current.pop("blocked_generation", None)
            else:
                current["next_retry_at_monotonic"] = None
                current["blocked_generation"] = generation
        self.state["providers"][provider] = current
        index_control.atomic_write_json(self.paths.provider_receipts / f"{provider}.json", current)

    def _publish(self) -> None:
        available = index_control.discover_providers(self.root, home=self.home)
        active = [name for name, enabled in available.items() if enabled]
        providers = {name: self.state.get("providers", {}).get(name, {}) for name in active}
        overall = index_control._overall_status(providers)
        generation = int(self.state.get("generation") or 0)
        source_state_id = (self.state.get("source") or {}).get("state_id")
        corpus_state_ids = (self.state.get("source") or {}).get("provider_corpus_state_ids") or {}
        if active and any(
            provider.get("indexed_generation") != generation
            or provider.get("indexed_source_state_id") != source_state_id
            or provider.get("indexed_corpus_state_id") != corpus_state_ids.get(name)
            for name, provider in providers.items()
        ):
            if overall not in {"FAILED", "BUILDING"}:
                overall = "STALE"
        self.state.update(
            {
                "schema_version": 2,
                "controller_version": index_control.CONTROLLER_VERSION,
                "worker_version": WORKER_VERSION,
                "updated_at": index_control.utc_now(),
                "overall_status": overall,
                "available_providers": available,
            }
        )
        index_control.atomic_write_json(self.paths.worker_state, self.state)
        hosts = set(self.state.get("active_hosts") or []) or {"codex", "claude"}
        for host in hosts:
            if host not in {"codex", "claude"}:
                continue
            host_paths = index_control.state_paths(host, self.root, home=self.home)
            dirty = index_control._read_dirty_generation(host_paths.dirty_marker)
            receipt = {
                "schema_version": 2,
                "controller_version": index_control.CONTROLLER_VERSION,
                "worker_version": WORKER_VERSION,
                "run_id": f"worker-generation-{generation}",
                "host": host,
                "completed_at": index_control.utc_now(),
                "overall_status": overall,
                "repository": self.state.get("source"),
                "providers": providers,
                "available_providers": available,
                "generation": generation,
                "acknowledged_dirty_generation": dirty.generation if dirty.valid else None,
                "dirty_generation": dirty.generation,
                "shared_state": str(self.paths.worker_state),
                "receipt": str(host_paths.receipt),
            }
            index_control.atomic_write_json(host_paths.receipt, receipt)
            index_control.publish_route_cache(host, self.root, home=self.home)

    def invalidate_provider(self, provider: str, reason: str) -> dict[str, Any]:
        if provider not in self.policies:
            raise ValueError(f"Unknown provider: {provider}")
        current = dict(self.state.setdefault("providers", {}).get(provider, {}))
        current.update(
            {
                "status": "STALE",
                "reasons": _normalized_reasons(current.get("reasons"), reason),
                "indexed_generation": None,
                "indexed_source_state_id": None,
                "invalidated_at": index_control.utc_now(),
            }
        )
        current.pop("next_retry_at_monotonic", None)
        current.pop("blocked_generation", None)
        self.state["providers"][provider] = current
        self._publish()
        return self.state

    def run_cycle(self, *, now: float | None = None, force_reconcile: bool = False) -> dict[str, Any]:
        current_time = self.clock() if now is None else now
        self.state.pop("worker_exit_reason", None)
        self.state.pop("worker_exited_at", None)
        self.state.pop("worker_idle_ttl_seconds", None)
        events = self._drain_events(current_time)
        source = self._reconcile_source(current_time, force_reconcile=force_reconcile, events=events)
        available = index_control.discover_providers(self.root, home=self.home)
        for provider, policy in self.policies.items():
            if not available.get(provider) or not self._provider_due(provider, policy, source, current_time):
                continue
            generation = int(self.state.get("generation") or 0)
            before = index_control.fingerprint_repository(self.root, home=self.home)
            try:
                result = self.provider_executor(provider, before, self.paths)
            except Exception as error:
                result = {
                    "status": "FAILED",
                    "reasons": ["PROVIDER_EXCEPTION", type(error).__name__, str(error)],
                    "failure_class": "transient",
                    "traceback_tail": traceback.format_exc()[-index_control.MAX_CAPTURE_CHARS :],
                }
            after = index_control.fingerprint_repository(self.root, home=self.home)
            if (
                provider == "graphify"
                and result.get("status") == "READY"
                and after["state_id"] == before["state_id"]
            ):
                try:
                    result = publish_staged_graphify(result)
                except OSError as error:
                    discard_staged_graphify(result)
                    result = {
                        "status": "FAILED",
                        "reasons": ["GRAPHIFY_ATOMIC_PUBLISH_FAILED", str(error)],
                        "failure_class": "transient",
                    }
                after = index_control.fingerprint_repository(self.root, home=self.home)
            self._record_provider_result(
                provider,
                result,
                generation=generation,
                now=current_time,
                before=before,
                after=after,
            )
            source = after
        self._refresh_probed_consumers(available, retry_negative=force_reconcile or bool(events))
        self._publish()
        return self.state


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Shared generation-based code-index reconciler.")
    sub = parser.add_subparsers(dest="command", required=True)
    signal = sub.add_parser("signal")
    signal.add_argument("--host", choices=("codex", "claude"), required=True)
    signal.add_argument("--root", required=True)
    signal.add_argument("--kind", choices=("source_mutated", "session_start", "checkpoint", "jit"), required=True)
    signal.add_argument("--reason")
    worker = sub.add_parser("worker")
    worker.add_argument("--root", required=True)
    worker.add_argument("--poll-seconds", type=float)
    worker.add_argument("--reconcile-seconds", type=float)
    worker.add_argument(
        "--idle-ttl-seconds",
        type=float,
        help="Exit after this many settled idle seconds; 0 disables idle exit.",
    )
    worker.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT_SECONDS)
    once = sub.add_parser("once")
    once.add_argument("--root", required=True)
    once.add_argument("--force-reconcile", action="store_true")
    once.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT_SECONDS)
    status = sub.add_parser("status")
    status.add_argument("--root", required=True)
    invalidate = sub.add_parser("invalidate")
    invalidate.add_argument("--root", required=True)
    invalidate.add_argument("--provider", choices=tuple(DEFAULT_POLICIES), required=True)
    invalidate.add_argument("--reason", default="OPERATOR_INVALIDATION")
    sync = sub.add_parser("sync")
    sync.add_argument("--host", choices=("codex", "claude"), default="codex")
    sync.add_argument("--root", required=True)
    sync.add_argument("--checkpoint", action="store_true")
    sync.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT_SECONDS)
    return parser


def _has_pending_work(
    state: Mapping[str, Any],
    policies: Mapping[str, ProviderPolicy],
    *,
    now: float,
) -> bool:
    generation = int(state.get("generation") or 0)
    source = state.get("source") if isinstance(state.get("source"), dict) else {}
    source_state_id = source.get("state_id")
    available = state.get("available_providers") or {}
    providers = state.get("providers") or {}
    for provider, enabled in available.items():
        if not enabled:
            continue
        provider_state = providers.get(provider) if isinstance(providers, dict) else None
        if not isinstance(provider_state, dict):
            return True
        if (
            provider_state.get("status") == "READY"
            and provider_state.get("indexed_generation") == generation
            and provider_state.get("indexed_source_state_id") == source_state_id
        ):
            continue
        retry_at = provider_state.get("next_retry_at_monotonic")
        if isinstance(retry_at, (int, float)):
            return True
        if provider_state.get("blocked_generation") == generation:
            continue
        policy = policies.get(provider)
        if policy is None:
            return True
        checkpoint = state.get("checkpoint_generation")
        jit = state.get("jit_generation")
        authorized = isinstance(checkpoint, int) and checkpoint >= generation
        if not authorized and isinstance(checkpoint, int):
            sealed = state.get("checkpoint_worktree_identity")
            authorized = sealed is not None and sealed == worktree_identity(source)
        if provider == "graphify":
            authorized = authorized or (isinstance(jit, int) and jit >= generation)
        if (
            policy.checkpoint_required
            and source.get("dirty")
            and not authorized
        ):
            continue
        if provider == "semctx" and semctx_builder_host(state, source) is None:
            continue
        dirty_since = state.get("dirty_since_monotonic")
        if isinstance(dirty_since, (int, float)) and now - float(dirty_since) < policy.quiet_seconds:
            return True
        return True
    return False


def _work_marker(state: Mapping[str, Any]) -> tuple[Any, ...]:
    providers = state.get("providers") or {}
    attempts = tuple(
        sorted(
            (name, value.get("attempted_at"))
            for name, value in providers.items()
            if isinstance(value, dict)
        )
    )
    return (
        state.get("generation"),
        state.get("observed_source_state_id"),
        attempts,
    )


def _record_idle_exit(worker: ReconcileWorker, idle_ttl_seconds: float) -> None:
    now = index_control.utc_now()
    worker.state.update(
        {
            "updated_at": now,
            "worker_exit_reason": "IDLE_TTL_EXPIRED",
            "worker_exited_at": now,
            "worker_heartbeat_at": now,
            "worker_pid": None,
            "worker_idle_ttl_seconds": idle_ttl_seconds,
        }
    )
    index_control.atomic_write_json(worker.paths.worker_state, worker.state)
    hosts = set(worker.state.get("active_hosts") or []) or {"codex", "claude"}
    for host in hosts:
        if host in {"codex", "claude"}:
            index_control.publish_route_cache(host, worker.root, home=worker.home)


def _run_loop(
    worker: ReconcileWorker,
    poll_seconds: float,
    reconcile_seconds: float,
    idle_ttl_seconds: float = DEFAULT_IDLE_TTL_SECONDS,
) -> int:
    lock = index_control.AtomicLock(worker.paths.worker_lock, ttl_seconds=0)
    if not lock.acquire():
        return 0
    try:
        observation_ttl = index_control._route_observation_ttl_seconds()
        if observation_ttl > 0 and reconcile_seconds >= observation_ttl - 10.0:
            # Warn, never derive the TTL from the cadence: widening the gate to
            # fit a slow reconcile would trade the gate's meaning for green.
            print(
                f"index-control: reconcile_seconds={reconcile_seconds} leaves no margin under "
                f"observation TTL={observation_ttl}; freshness will flap. Lower reconcile_seconds.",
                file=sys.stderr,
            )
        started_at = index_control.utc_now()
        worker.state.update(
            {
                "worker_pid": os.getpid(),
                "worker_started_at": started_at,
                "worker_heartbeat_at": started_at,
            }
        )
        next_reconcile = 0.0
        idle_since: float | None = None
        consecutive_cycle_failures = 0
        while True:
            now = time.monotonic()
            force = now >= next_reconcile
            had_events = worker.paths.events.is_dir() and any(worker.paths.events.glob("*.json"))
            before_marker = _work_marker(worker.state)
            try:
                worker.state["worker_heartbeat_at"] = index_control.utc_now()
                state = worker.run_cycle(now=now, force_reconcile=force)
                consecutive_cycle_failures = 0
                worker.state["consecutive_cycle_failures"] = 0
                worker.state.pop("last_cycle_error", None)
                index_control.atomic_write_json(worker.paths.worker_state, worker.state)
                if not any((state.get("available_providers") or {}).values()):
                    worker.state.update(
                        {
                            "worker_pid": None,
                            "worker_exit_reason": "NO_AVAILABLE_PROVIDER",
                            "worker_exited_at": index_control.utc_now(),
                        }
                    )
                    index_control.atomic_write_json(worker.paths.worker_state, worker.state)
                    return 0
            except Exception as error:
                consecutive_cycle_failures += 1
                worker.state.update(
                    {
                        "updated_at": index_control.utc_now(),
                        "overall_status": "FAILED",
                        "reasons": ["WORKER_CYCLE_EXCEPTION", type(error).__name__, str(error)],
                        "consecutive_cycle_failures": consecutive_cycle_failures,
                        "last_cycle_error": str(error),
                        "worker_heartbeat_at": index_control.utc_now(),
                    }
                )
                index_control.atomic_write_json(worker.paths.worker_state, worker.state)
                traceback.print_exc(file=sys.stderr)
                time.sleep(min(5.0 * (2 ** min(consecutive_cycle_failures - 1, 4)), 60.0))
                next_reconcile = 0.0
                continue
            if force:
                next_reconcile = now + max(5.0, reconcile_seconds)
            useful_work = had_events or _work_marker(state) != before_marker
            if useful_work or _has_pending_work(state, worker.policies, now=now):
                idle_since = None
            elif idle_ttl_seconds > 0:
                if idle_since is None:
                    idle_since = now
                elif now - idle_since >= idle_ttl_seconds:
                    _record_idle_exit(worker, idle_ttl_seconds)
                    return 0
            time.sleep(max(0.25, poll_seconds))
    except KeyboardInterrupt:
        return 0
    finally:
        lock.release()


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    if args.command == "signal":
        path = index_control.enqueue_reconcile_event(
            args.host,
            args.root,
            kind=args.kind,
            reason=args.reason,
        )
        print(json.dumps({"queued": True, "event": str(path)}))
        return 0
    if args.command == "status":
        paths = index_control.shared_state_paths(args.root)
        payload = _read_json(paths.worker_state) or {
            "overall_status": "UNKNOWN",
            "reasons": ["WORKER_STATE_MISSING"],
            "shared_state": str(paths.worker_state),
        }
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return 0
    if args.command == "invalidate":
        worker = ReconcileWorker(args.root)
        lock = index_control.AtomicLock(worker.paths.worker_lock, ttl_seconds=0)
        if not lock.acquire():
            print(json.dumps({"overall_status": "BUILDING", "reasons": ["WORKER_ALREADY_RUNNING"]}))
            return 0
        try:
            payload = worker.invalidate_provider(args.provider, args.reason)
        finally:
            lock.release()
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return 0
    if args.command == "worker":
        worker = ReconcileWorker(args.root, timeout_seconds=args.timeout)
        default_poll, default_reconcile, default_idle_ttl = load_runtime_policy()
        return _run_loop(
            worker,
            args.poll_seconds if args.poll_seconds is not None else default_poll,
            args.reconcile_seconds if args.reconcile_seconds is not None else default_reconcile,
            args.idle_ttl_seconds if args.idle_ttl_seconds is not None else default_idle_ttl,
        )
    if args.command == "once":
        worker = ReconcileWorker(args.root, timeout_seconds=args.timeout)
        lock = index_control.AtomicLock(worker.paths.worker_lock, ttl_seconds=0)
        if not lock.acquire():
            print(json.dumps({"overall_status": "BUILDING", "reasons": ["WORKER_ALREADY_RUNNING"]}))
            return 0
        try:
            payload = worker.run_cycle(force_reconcile=args.force_reconcile)
        finally:
            lock.release()
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return 0
    if args.command == "sync":
        index_control.enqueue_reconcile_event(args.host, args.root, kind="jit", reason="JIT_SYNC")
        if args.checkpoint:
            index_control.enqueue_reconcile_event(args.host, args.root, kind="checkpoint", reason="JIT_CHECKPOINT")
        zero_quiet = {
            name: ProviderPolicy(
                quiet_seconds=0,
                checkpoint_required=policy.checkpoint_required,
                retry_base_seconds=policy.retry_base_seconds,
                retry_max_seconds=policy.retry_max_seconds,
            )
            for name, policy in DEFAULT_POLICIES.items()
        }
        worker = ReconcileWorker(args.root, policies=zero_quiet, timeout_seconds=args.timeout)
        lock = index_control.AtomicLock(worker.paths.worker_lock, ttl_seconds=0)
        if not lock.acquire():
            print(json.dumps({"overall_status": "BUILDING", "reasons": ["WORKER_ALREADY_RUNNING"]}))
            return 0
        try:
            payload = worker.run_cycle(force_reconcile=True)
        finally:
            lock.release()
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return 2 if payload.get("overall_status") == "FAILED" else 0
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
