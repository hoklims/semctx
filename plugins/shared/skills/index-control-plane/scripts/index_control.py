from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterable, Sequence


CONTROLLER_VERSION = "2.5.0"
DEFAULT_TIMEOUT_SECONDS = 900
DEFAULT_LOCK_TTL_SECONDS = 1800
MAX_CAPTURE_CHARS = 32_000
MAX_HISTORY_RECEIPTS = 100
DEFAULT_ROUTE_OBSERVATION_TTL_SECONDS = 75.0
READY_STATES = {"READY", "FRESH", "CLEAN", "DIRTY_KNOWN", "PASS"}
STALE_STATES = {"STALE", "UNSEALED", "DIRTY_UNKNOWN"}
SEMCTX_EXIT_3_STATES = {"STALE", "UNSEALED"}
GENERATED_PATH_PREFIXES = (
    ".cocoindex_code/",
    ".omx/",
    ".serena/",
    ".semctx/",
    "graphify-out/",
)
GRAPHIFY_CODE_EXTENSIONS = {
    ".bash", ".c", ".cc", ".cpp", ".cs", ".css", ".cxx", ".f", ".f03",
    ".f08", ".f90", ".f95", ".go", ".h", ".hpp", ".html", ".java", ".js",
    ".json", ".kt", ".kts", ".lua", ".php", ".ps1", ".py", ".rb", ".rs",
    ".scala", ".sh", ".sql", ".swift", ".toc", ".toml", ".ts", ".tsx",
}
CONSUMER_BOUND_PROVIDERS = {"graphify"}
# Consumers the control plane probes itself, once per host and per artefact build,
# instead of trusting a registration. The .semctx store is shared by both hosts but
# stamped with the tool version that built it, so one build can be FRESH for one
# host's plugin and TOOL_VERSION_MISMATCH for the other's.
PROBED_CONSUMER_PROVIDERS = {"semctx"}
HOSTS = ("codex", "claude")
CLAUDE_SEMCTX_PLUGIN = "semctx@semctx-stable"


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _subprocess_window_options(platform: str | None = None) -> dict[str, Any]:
    """Keep every controller child process off the interactive Windows desktop."""
    if (platform or os.name) != "nt":
        return {}
    startup = subprocess.STARTUPINFO()
    startup.dwFlags |= subprocess.STARTF_USESHOWWINDOW
    startup.wShowWindow = subprocess.SW_HIDE
    return {
        "creationflags": subprocess.CREATE_NO_WINDOW,
        "startupinfo": startup,
    }


def canonical_root(root: Path | str) -> Path:
    candidate = Path(root).expanduser().resolve()
    result: subprocess.CompletedProcess[str] | None = None
    for attempt in range(3):
        result = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            cwd=candidate,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            check=False,
            **_subprocess_window_options(),
        )
        if result.returncode == 0:
            break
        time.sleep(0.05 * (attempt + 1))
    if result is None or result.returncode != 0:
        detail = (result.stderr if result is not None else "git did not run").strip()
        raise ValueError(f"Not a Git worktree: {candidate} ({detail or 'git rev-parse failed'})")
    return Path(result.stdout.strip()).resolve()


def fast_worktree_root(root: Path | str) -> Path:
    """Resolve an already-open worktree without spawning Git on the prompt path."""
    candidate = Path(root).expanduser().resolve()
    if candidate.is_file():
        candidate = candidate.parent
    for current in (candidate, *candidate.parents):
        if (current / ".git").exists():
            return current
    raise ValueError(f"Not a Git worktree: {candidate}")


def _path_key(root: Path) -> str:
    normalized = os.path.normcase(str(root.resolve())).replace("\\", "/")
    digest = hashlib.sha256(normalized.encode("utf-8")).hexdigest()[:16]
    name = re.sub(r"[^a-zA-Z0-9._-]+", "-", root.name).strip("-") or "repo"
    return f"{name}-{digest}"


@dataclass(frozen=True)
class StatePaths:
    receipt: Path
    history: Path
    lock: Path
    dirty_marker: Path
    route_cache: Path


@dataclass(frozen=True)
class SharedStatePaths:
    root: Path
    events: Path
    worker_state: Path
    worker_lock: Path
    providers: Path
    provider_receipts: Path
    consumers: Path
    logs: Path


def state_paths(host: str, root: Path | str, home: Path | None = None) -> StatePaths:
    if host not in {"codex", "claude"}:
        raise ValueError("host must be 'codex' or 'claude'")
    base = (home or Path.home()).resolve()
    repo = canonical_root(root)
    key = _path_key(repo)
    host_root = base / f".{host}" / "index-control-plane" / "repos" / key
    shared_root = base / ".agents" / "index-control-plane"
    return StatePaths(
        receipt=host_root / "latest.json",
        history=host_root / "history",
        lock=shared_root / "locks" / f"{key}.lock",
        dirty_marker=host_root / "dirty-generation.json",
        route_cache=host_root / "route-cache.json",
    )


def shared_state_paths(root: Path | str, home: Path | None = None) -> SharedStatePaths:
    base = (home or Path.home()).resolve()
    repo = canonical_root(root)
    key = _path_key(repo)
    shared_root = base / ".agents" / "index-control-plane" / "repos" / key
    return SharedStatePaths(
        root=shared_root,
        events=shared_root / "events",
        worker_state=shared_root / "worker-state.json",
        worker_lock=shared_root / "worker.lock",
        providers=shared_root / "providers",
        provider_receipts=shared_root / "provider-receipts",
        consumers=shared_root / "consumers",
        logs=shared_root / "logs",
    )


def _shared_state_paths_fast(repo: Path, home: Path | None = None) -> SharedStatePaths:
    base = (home or Path.home()).resolve()
    shared_root = base / ".agents" / "index-control-plane" / "repos" / _path_key(repo)
    return SharedStatePaths(
        root=shared_root,
        events=shared_root / "events",
        worker_state=shared_root / "worker-state.json",
        worker_lock=shared_root / "worker.lock",
        providers=shared_root / "providers",
        provider_receipts=shared_root / "provider-receipts",
        consumers=shared_root / "consumers",
        logs=shared_root / "logs",
    )


def _host_state_paths_fast(host: str, repo: Path, home: Path | None = None) -> StatePaths:
    if host not in {"codex", "claude"}:
        raise ValueError("host must be 'codex' or 'claude'")
    base = (home or Path.home()).resolve()
    key = _path_key(repo)
    host_root = base / f".{host}" / "index-control-plane" / "repos" / key
    shared_root = base / ".agents" / "index-control-plane"
    return StatePaths(
        receipt=host_root / "latest.json",
        history=host_root / "history",
        lock=shared_root / "locks" / f"{key}.lock",
        dirty_marker=host_root / "dirty-generation.json",
        route_cache=host_root / "route-cache.json",
    )


def enqueue_reconcile_event(
    host: str,
    root: Path | str,
    *,
    kind: str,
    reason: str | None = None,
    home: Path | None = None,
) -> Path:
    if host not in {"codex", "claude"}:
        raise ValueError("host must be 'codex' or 'claude'")
    if kind not in {"source_mutated", "session_start", "checkpoint", "jit"}:
        raise ValueError(f"Unsupported reconcile event: {kind}")
    repo = canonical_root(root)
    paths = shared_state_paths(repo, home=home)
    event_id = uuid.uuid4().hex
    target = paths.events / f"{time.time_ns()}-{event_id}.json"
    atomic_write_json(
        target,
        {
            "schema_version": 2,
            "controller_version": CONTROLLER_VERSION,
            "event_id": event_id,
            "created_at": utc_now(),
            "host": host,
            "root": str(repo),
            "kind": kind,
            "reason": reason or kind.upper(),
        },
    )
    return target


def atomic_write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        with temporary.open("w", encoding="utf-8", newline="\n") as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2, sort_keys=True)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        try:
            temporary.unlink(missing_ok=True)
        except OSError:
            pass


def prune_history(path: Path, keep: int = MAX_HISTORY_RECEIPTS) -> None:
    if keep < 1 or not path.is_dir():
        return
    receipts = sorted(
        (item for item in path.glob("*.json") if item.is_file()),
        key=lambda item: item.stat().st_mtime,
        reverse=True,
    )
    for receipt in receipts[keep:]:
        try:
            receipt.unlink()
        except OSError:
            pass


def _pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False
    return True


class AtomicLock:
    def __init__(self, path: Path, ttl_seconds: int = DEFAULT_LOCK_TTL_SECONDS) -> None:
        self.path = path
        self.ttl_seconds = ttl_seconds
        self.token = uuid.uuid4().hex
        self.acquired = False
        self._descriptor: int | None = None

    @staticmethod
    def _lock_descriptor(descriptor: int) -> None:
        os.lseek(descriptor, 0, os.SEEK_SET)
        if os.name == "nt":
            import msvcrt

            msvcrt.locking(descriptor, msvcrt.LK_NBLCK, 1)
        else:
            import fcntl

            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)

    @staticmethod
    def _unlock_descriptor(descriptor: int) -> None:
        os.lseek(descriptor, 0, os.SEEK_SET)
        if os.name == "nt":
            import msvcrt

            msvcrt.locking(descriptor, msvcrt.LK_UNLCK, 1)
        else:
            import fcntl

            fcntl.flock(descriptor, fcntl.LOCK_UN)

    def acquire(self) -> bool:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        descriptor = os.open(self.path, os.O_CREAT | os.O_RDWR, 0o600)
        try:
            if os.fstat(descriptor).st_size == 0:
                os.write(descriptor, b"\0")
            self._lock_descriptor(descriptor)
        except OSError:
            os.close(descriptor)
            return False
        payload = json.dumps(
            {"pid": os.getpid(), "token": self.token, "created_at": utc_now()},
            separators=(",", ":"),
        ).encode("utf-8")
        os.ftruncate(descriptor, 0)
        os.lseek(descriptor, 0, os.SEEK_SET)
        os.write(descriptor, payload)
        os.fsync(descriptor)
        self._descriptor = descriptor
        self.acquired = True
        return True

    def release(self) -> None:
        if not self.acquired:
            return
        try:
            if self._descriptor is not None:
                self._unlock_descriptor(self._descriptor)
                os.close(self._descriptor)
        except OSError:
            pass
        finally:
            self._descriptor = None
            self.acquired = False

    def __enter__(self) -> "AtomicLock":
        if not self.acquire():
            raise RuntimeError(f"Lock already held: {self.path}")
        return self

    def __exit__(self, exc_type, exc_value, traceback) -> None:
        self.release()


@dataclass(frozen=True)
class CommandResult:
    returncode: int
    stdout: str
    stderr: str
    duration_seconds: float


Runner = Callable[[Sequence[str], Path, dict[str, str], int], CommandResult]


def run_command(
    argv: Sequence[str],
    cwd: Path,
    env: dict[str, str],
    timeout: int,
) -> CommandResult:
    started = time.monotonic()
    try:
        completed = subprocess.run(
            list(argv),
            cwd=cwd,
            env={**os.environ, **env},
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
            check=False,
            **_subprocess_window_options(),
        )
        return CommandResult(
            completed.returncode,
            completed.stdout,
            completed.stderr,
            time.monotonic() - started,
        )
    except subprocess.TimeoutExpired as error:
        stdout = error.stdout.decode("utf-8", "replace") if isinstance(error.stdout, bytes) else (error.stdout or "")
        stderr = error.stderr.decode("utf-8", "replace") if isinstance(error.stderr, bytes) else (error.stderr or "")
        return CommandResult(124, stdout, stderr + "\nTIMEOUT", time.monotonic() - started)
    except OSError as error:
        return CommandResult(127, "", str(error), time.monotonic() - started)


def _git_bytes(repo: Path, *args: str) -> bytes:
    completed: subprocess.CompletedProcess[bytes] | None = None
    for attempt in range(3):
        current = subprocess.run(
            ["git", *args],
            cwd=repo,
            capture_output=True,
            check=False,
            **_subprocess_window_options(),
        )
        completed = current
        if current.returncode == 0:
            break
        time.sleep(0.05 * (attempt + 1))
    if completed is None:
        raise RuntimeError(f"git {' '.join(args)} did not run")
    if completed.returncode != 0:
        message = completed.stderr.decode("utf-8", "replace").strip()
        raise RuntimeError(f"git {' '.join(args)} failed: {message}")
    return completed.stdout


def _hash_file(path: Path, digest: Any) -> None:
    if path.is_symlink():
        digest.update(b"symlink\0")
        digest.update(os.readlink(path).encode("utf-8", "surrogateescape"))
        return
    if not path.is_file():
        digest.update(b"missing\0")
        return
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)


def _is_generated_relative(relative: str) -> bool:
    # removeprefix, not lstrip: lstrip("./") strips every leading "." and "/"
    # character, so ".omx/logs/x.jsonl" became "omx/logs/x.jsonl" and stopped
    # matching the ".omx/" prefix. Every dotted generated directory was silently
    # hashed into the working tree, so their churn kept bumping the generation.
    normalized = relative.replace("\\", "/").removeprefix("./").lower()
    return any(normalized == prefix.rstrip("/") or normalized.startswith(prefix) for prefix in GENERATED_PATH_PREFIXES)


def _working_tree_hash(repo: Path) -> tuple[str, bool, int]:
    digest = hashlib.sha256()
    exclusions = [f":(exclude){prefix}**" for prefix in GENERATED_PATH_PREFIXES]
    diff = _git_bytes(repo, "diff", "--binary", "--no-ext-diff", "HEAD", "--", ".", *exclusions)
    digest.update(b"tracked-diff\0")
    digest.update(diff)
    raw_untracked = _git_bytes(repo, "ls-files", "--others", "--exclude-standard", "-z")
    untracked = [
        entry
        for entry in raw_untracked.split(b"\0")
        if entry and not _is_generated_relative(entry.decode("utf-8", "surrogateescape"))
    ]
    for raw_path in sorted(untracked):
        relative_text = raw_path.decode("utf-8", "surrogateescape")
        relative = Path(relative_text)
        digest.update(b"untracked\0")
        digest.update(raw_path)
        digest.update(b"\0")
        _hash_file(repo / relative, digest)
    dirty = bool(diff or untracked)
    return digest.hexdigest(), dirty, len(untracked)


def _config_hash(repo: Path) -> tuple[str, list[str]]:
    candidates = (
        Path(".index-control.json"),
        Path(".cocoindex_code/settings.yml"),
        Path(".semctx/config.json"),
    )
    digest = hashlib.sha256()
    present: list[str] = []
    for relative in candidates:
        path = repo / relative
        if not path.is_file():
            continue
        name = relative.as_posix()
        present.append(name)
        digest.update(name.encode("utf-8"))
        digest.update(b"\0")
        _hash_file(path, digest)
    return digest.hexdigest(), present


def _identity_file(digest: Any, path: Path) -> None:
    digest.update(str(path.resolve()).encode("utf-8", "surrogateescape"))
    digest.update(b"\0")
    try:
        stat = path.stat()
    except OSError:
        digest.update(b"missing\0")
        return
    digest.update(f"{stat.st_size}:{stat.st_mtime_ns}".encode("ascii"))
    digest.update(b"\0")
    if stat.st_size <= 2 * 1024 * 1024:
        _hash_file(path, digest)
        digest.update(b"\0")


def _provider_distribution_metadata(interpreter: Path, distribution_prefix: str) -> list[Path]:
    site_packages = interpreter.parent.parent / "Lib" / "site-packages"
    if not site_packages.is_dir():
        return []
    return sorted(site_packages.glob(f"{distribution_prefix}*.dist-info/METADATA"))


def desired_state_identity(root: Path, *, home: Path | None = None) -> str:
    base = (home or Path.home()).resolve()
    digest = hashlib.sha256()
    digest.update(f"controller:{CONTROLLER_VERSION}\0".encode("ascii"))
    for path in (
        base / ".agents" / "index-control-plane" / "policy.json",
        Path(__file__).resolve(),
        Path(__file__).with_name("reconcile_worker.py"),
        Path(__file__).with_name("graphify_incremental.py"),
    ):
        _identity_file(digest, path)
    ccc = resolve_ccc_command()
    if ccc:
        executable = Path(ccc[0])
        _identity_file(digest, executable)
        for metadata in _provider_distribution_metadata(executable.with_name("python.exe"), "cocoindex_code"):
            _identity_file(digest, metadata)
    graphify = resolve_graphify_python(root)
    if graphify:
        _identity_file(digest, graphify)
        for metadata in _provider_distribution_metadata(graphify, "graphify"):
            _identity_file(digest, metadata)
    for command in semctx_toolchain(home=home):
        for item in command:
            candidate = Path(item)
            if candidate.is_file():
                _identity_file(digest, candidate)
            else:
                digest.update(item.encode("utf-8", "surrogateescape"))
                digest.update(b"\0")
    return digest.hexdigest()


def _provider_desired_state_identity(repo: Path, provider: str, *, home: Path | None = None) -> str:
    base = (home or Path.home()).resolve()
    digest = hashlib.sha256()
    digest.update(f"provider:{provider}\0".encode("ascii"))
    _identity_file(digest, base / ".agents" / "index-control-plane" / "policy.json")
    if provider == "ccc":
        command = resolve_ccc_command()
        if command:
            executable = Path(command[0])
            _identity_file(digest, executable)
            for metadata in _provider_distribution_metadata(executable.with_name("python.exe"), "cocoindex_code"):
                _identity_file(digest, metadata)
    elif provider == "graphify":
        _identity_file(digest, Path(__file__).with_name("graphify_incremental.py"))
        interpreter = resolve_graphify_python(repo)
        if interpreter:
            _identity_file(digest, interpreter)
            for metadata in _provider_distribution_metadata(interpreter, "graphify"):
                _identity_file(digest, metadata)
    elif provider == "semctx":
        for command in semctx_toolchain(home=home):
            for item in command:
                candidate = Path(item)
                if candidate.is_file():
                    _identity_file(digest, candidate)
                else:
                    digest.update(item.encode("utf-8", "surrogateescape"))
                    digest.update(b"\0")
    return digest.hexdigest()


def _provider_corpus_state_ids(repo: Path, *, home: Path | None = None) -> dict[str, str]:
    raw_paths = _git_bytes(repo, "ls-files", "-z", "-co", "--exclude-standard")
    paths = sorted(
        {
            raw.decode("utf-8", "surrogateescape")
            for raw in raw_paths.split(b"\0")
            if raw
        }
    )
    tracked_records: dict[str, bytes] = {}
    for record in _git_bytes(repo, "ls-files", "-s", "-z").split(b"\0"):
        if not record or b"\t" not in record:
            continue
        metadata, raw_path = record.split(b"\t", 1)
        tracked_records[raw_path.decode("utf-8", "surrogateescape")] = metadata
    changed = {
        raw.decode("utf-8", "surrogateescape")
        for raw in _git_bytes(repo, "diff", "--name-only", "-z", "HEAD", "--", ".").split(b"\0")
        if raw
    }
    explicit_configs = {
        "ccc": {".index-control.json", ".cocoindex_code/settings.yml"},
        "graphify": {".index-control.json"},
        "semctx": {".index-control.json", ".semctx/config.json"},
    }
    result: dict[str, str] = {}
    for provider in ("ccc", "graphify", "semctx"):
        digest = hashlib.sha256()
        digest.update(_provider_desired_state_identity(repo, provider, home=home).encode("ascii"))
        digest.update(b"\0")
        candidates = set(paths) | explicit_configs[provider]
        for relative in sorted(candidates):
            normalized = relative.replace("\\", "/")
            explicit = normalized in explicit_configs[provider]
            if not explicit and _is_generated_relative(normalized):
                continue
            if provider == "graphify" and not explicit and Path(normalized).suffix.lower() not in GRAPHIFY_CODE_EXTENSIONS:
                continue
            path = repo / Path(relative)
            if explicit and not path.exists():
                continue
            digest.update(normalized.encode("utf-8", "surrogateescape"))
            digest.update(b"\0")
            if relative in changed or relative not in tracked_records:
                _hash_file(path, digest)
            else:
                digest.update(tracked_records[relative])
            digest.update(b"\0")
        result[provider] = f"sha256:{digest.hexdigest()}"
    return result


def fingerprint_repository(root: Path | str, *, home: Path | None = None) -> dict[str, Any]:
    repo = canonical_root(root)
    head = _git_bytes(repo, "rev-parse", "HEAD").decode("ascii", "replace").strip()
    working_tree_hash, dirty, untracked_count = _working_tree_hash(repo)
    config_hash, config_files = _config_hash(repo)
    desired_state_hash = desired_state_identity(repo, home=home)
    provider_corpus_state_ids = _provider_corpus_state_ids(repo, home=home)
    state_digest = hashlib.sha256()
    for value in (head, working_tree_hash, config_hash, desired_state_hash):
        state_digest.update(value.encode("ascii"))
        state_digest.update(b"\0")
    return {
        "root": str(repo),
        "head": head,
        "working_tree_hash": working_tree_hash,
        "config_hash": config_hash,
        "config_files": config_files,
        "desired_state_hash": desired_state_hash,
        "provider_corpus_state_ids": provider_corpus_state_ids,
        "dirty": dirty,
        "untracked_files": untracked_count,
        "state_id": f"sha256:{state_digest.hexdigest()}",
    }


ADMISSION_REFUSED: dict[str, bool] = {"ccc": False, "graphify": False, "semctx": False}


def _admission_config(home: Path | None = None) -> dict[str, Any]:
    # Deliberately separate from policy.json: policy.json is hashed into
    # desired_state_identity, so editing it would force a full reindex everywhere.
    base = (home or Path.home()).resolve()
    return _read_json_file(base / ".agents" / "index-control-plane" / "admission.json")


def _admission_denial_reason(repo: Path, config: dict[str, Any]) -> str | None:
    normalized = str(repo).replace("\\", "/").rstrip("/").lower()
    for entry in config.get("denylist_roots", ()):
        candidate = str(entry).replace("\\", "/").rstrip("/").lower()
        if candidate and (normalized == candidate or normalized.startswith(candidate + "/")):
            return f"DENYLIST_ROOT:{entry}"
    for fragment in config.get("denylist_path_fragments", ()):
        needle = str(fragment).replace("\\", "/").lower()
        if needle and needle in normalized + "/":
            return f"DENYLIST_FRAGMENT:{fragment}"
    return None


def _admission_code_extensions(config: dict[str, Any]) -> set[str]:
    excluded = {str(item).lower() for item in config.get("structural_extension_exclusions", ())}
    return GRAPHIFY_CODE_EXTENSIONS - excluded


def _is_vendor_relative(relative: str, vendor_dirs: frozenset[str]) -> bool:
    parts = relative.replace("\\", "/").removeprefix("./").lower().split("/")
    return any(part in vendor_dirs for part in parts[:-1])


def _code_file_count(repo: Path, extensions: set[str], config: dict[str, Any]) -> int:
    # `git ls-files -co --exclude-standard` only excludes what .gitignore excludes.
    # A freshly `git init`-ed repo with node_modules and no .gitignore would
    # otherwise clear every threshold on vendored code alone.
    try:
        output = _git_bytes(repo, "ls-files", "-z", "-co", "--exclude-standard")
    except (OSError, subprocess.SubprocessError, RuntimeError):
        return 0
    vendor_dirs = frozenset(str(name).lower() for name in config.get("vendor_dir_names", ()))
    total = 0
    for raw in output.split(b"\0"):
        if not raw:
            continue
        relative = raw.decode("utf-8", "surrogateescape")
        if _is_generated_relative(relative) or _is_vendor_relative(relative, vendor_dirs):
            continue
        if Path(relative).suffix.lower() in extensions:
            total += 1
    return total


def discover_providers(root: Path | str, home: Path | None = None) -> dict[str, bool]:
    repo = canonical_root(root)
    config = _admission_config(home)
    # Fail closed. A missing or unparseable admission.json must not silently
    # restore the ungoverned behaviour it exists to replace.
    if not config:
        return dict(ADMISSION_REFUSED)
    if _admission_denial_reason(repo, config):
        return dict(ADMISSION_REFUSED)
    code_files = _code_file_count(repo, _admission_code_extensions(config), config)
    graphify_floor = max(1, int(config.get("graphify", {}).get("min_code_files", 5)))
    return {
        "ccc": (repo / ".cocoindex_code" / "settings.yml").is_file(),
        # Zero-setup structural lane. Artifacts stay under ~/.agents, so a Git
        # worktree carrying enough real code needs no repository-local setup.
        "graphify": code_files >= graphify_floor,
        "semctx": (repo / ".semctx").is_dir(),
    }


def _read_json_file(path: Path) -> dict[str, Any]:
    if not path.is_file():
        return {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return payload if isinstance(payload, dict) else {}


def _observation_age_seconds(state: dict[str, Any]) -> float | None:
    # source_observed_at, not updated_at: the latter is a worker heartbeat that
    # is rewritten on every poll even when the source was not re-fingerprinted.
    # No fallback on purpose -- a state written by an older worker has no
    # observation axis, so it must read as expired rather than as current.
    raw = state.get("source_observed_at")
    if not isinstance(raw, str) or not raw:
        return None
    try:
        observed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return None
    if observed.tzinfo is None:
        observed = observed.replace(tzinfo=timezone.utc)
    return max(0.0, (datetime.now(timezone.utc) - observed).total_seconds())


def _route_observation_ttl_seconds() -> float:
    raw = os.environ.get("INDEX_CONTROL_ROUTE_OBSERVATION_TTL_SECONDS")
    if raw is None:
        return DEFAULT_ROUTE_OBSERVATION_TTL_SECONDS
    try:
        return max(0.0, float(raw))
    except ValueError:
        return DEFAULT_ROUTE_OBSERVATION_TTL_SECONDS


def verify_source_observation(
    root: Path | str,
    state: dict[str, Any],
    *,
    home: Path | None = None,
) -> tuple[bool, dict[str, Any]]:
    """Re-fingerprint the worktree and check it still equals the recorded source.

    This can only confirm a binding the worker already recorded; it can never
    create one, and it never starts a provider. A true result means "the
    worktree hashes identically to the one the artefacts are bound to, right
    now" -- which is exactly the property the freshness gate exists to assert.
    A false result is strictly more informative than an expired clock.
    """
    recorded = state.get("source") if isinstance(state.get("source"), dict) else None
    if not recorded or not recorded.get("state_id"):
        return False, {"reason": "SOURCE_OBSERVATION_FAILED", "detail": "no recorded source fingerprint"}
    try:
        observed = fingerprint_repository(root, home=home)
    except Exception as error:  # noqa: BLE001 - any failure must fail closed
        return False, {"reason": "SOURCE_OBSERVATION_FAILED", "detail": f"{type(error).__name__}: {error}"}
    if observed.get("state_id") != recorded.get("state_id"):
        return False, {"reason": "SOURCE_DRIFTED_SINCE_OBSERVATION", "observed": observed}
    if (observed.get("provider_corpus_state_ids") or {}) != (recorded.get("provider_corpus_state_ids") or {}):
        return False, {"reason": "SOURCE_DRIFTED_SINCE_OBSERVATION", "observed": observed}
    return True, {"observed": observed}


def register_consumer(
    host: str,
    root: Path | str,
    provider: str,
    *,
    home: Path | None = None,
) -> dict[str, Any]:
    if provider not in CONSUMER_BOUND_PROVIDERS:
        raise ValueError(f"Provider does not require a generation-bound consumer: {provider}")
    repo = fast_worktree_root(root)
    paths = _shared_state_paths_fast(repo, home=home)
    state = _read_json_file(paths.worker_state)
    generation = state.get("generation")
    source = state.get("source") or {}
    source_state_id = source.get("state_id")
    corpus_state_id = (source.get("provider_corpus_state_ids") or {}).get(provider)
    evidence = (state.get("providers") or {}).get(provider, {})
    corpus_matches = (
        evidence.get("indexed_corpus_state_id") == corpus_state_id
        if evidence.get("indexed_corpus_state_id") is not None
        else evidence.get("indexed_source_state_id") == source_state_id
    )
    artifact_ready = bool(
        evidence.get("status") == "READY"
        and evidence.get("indexed_generation") == generation
        and evidence.get("indexed_source_state_id") == source_state_id
        and corpus_matches
    )
    receipt = {
        "schema_version": 1,
        "controller_version": CONTROLLER_VERSION,
        "host": host,
        "provider": provider,
        "root": str(repo),
        "consumer_generation": generation if artifact_ready else None,
        "consumer_source_state_id": source_state_id if artifact_ready else None,
        "status": "READY" if artifact_ready else "STALE",
        "reasons": [] if artifact_ready else ["ARTIFACT_NOT_READY"],
        "observed_at": utc_now(),
    }
    atomic_write_json(paths.consumers / host / f"{provider}.json", receipt)
    publish_route_cache(host, repo, home=home)
    return receipt


def invalidate_consumer(
    host: str,
    root: Path | str,
    provider: str,
    *,
    reason: str = "CONSUMER_STOPPED",
    home: Path | None = None,
) -> dict[str, Any]:
    repo = fast_worktree_root(root)
    paths = _shared_state_paths_fast(repo, home=home)
    receipt = {
        "schema_version": 1,
        "controller_version": CONTROLLER_VERSION,
        "host": host,
        "provider": provider,
        "root": str(repo),
        "consumer_generation": None,
        "consumer_source_state_id": None,
        "status": "STALE",
        "reasons": [reason],
        "observed_at": utc_now(),
    }
    atomic_write_json(paths.consumers / host / f"{provider}.json", receipt)
    publish_route_cache(host, repo, home=home)
    return receipt


def probed_consumer_verdict(
    evidence: dict[str, Any],
    host: str,
    source_state_id: str | None,
    refreshed: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """The host's own verdict on this exact build and source state, or nothing.

    Bound to the build and the observed source rather than the generation: a rebuild
    at the same generation drops every verdict taken on the previous store, and a
    HEAD-only change that carries the artefact forward still forces a new verdict.
    """
    def current(verdict: Any) -> bool:
        return bool(
            isinstance(verdict, dict)
            and evidence.get("attempted_at")
            and source_state_id
            and verdict.get("host") == host
            and verdict.get("build_attempted_at") == evidence.get("attempted_at")
            and verdict.get("source_state_id") == source_state_id
        )

    worker_verdict = (evidence.get("consumers") or {}).get(host)
    if not current(worker_verdict):
        worker_verdict = {}
    if refreshed and refreshed.get("probe_kind") == "semctx_status" and refreshed.get("provider") == "semctx" and current(refreshed):
        if refreshed.get("observed_at", "") > worker_verdict.get("observed_at", ""):
            return refreshed
    return worker_verdict


def routing_advisory(
    root: Path | str,
    *,
    host: str = "codex",
    home: Path | None = None,
    verify_expired: bool = False,
) -> dict[str, Any]:
    repo = fast_worktree_root(root)
    paths = _shared_state_paths_fast(repo, home=home)
    host_paths = _host_state_paths_fast(host, repo, home=home)
    state = _read_json_file(paths.worker_state)
    host_receipt = _read_json_file(host_paths.receipt)
    source = state.get("source") if isinstance(state.get("source"), dict) else {}
    source_state_id = source.get("state_id")
    corpus_state_ids = source.get("provider_corpus_state_ids") or {}
    generation = state.get("generation")
    available = state.get("available_providers")
    if not isinstance(available, dict):
        available = {
            "ccc": (repo / ".cocoindex_code" / "settings.yml").is_file(),
            "graphify": (paths.providers / "graphify" / "graphify-out" / "graph.json").is_file(),
            "semctx": (repo / ".semctx").is_dir(),
        }
    age = _observation_age_seconds(state)
    ttl = _route_observation_ttl_seconds()
    observation_fresh = age is not None and (ttl == 0 or age <= ttl)
    observation_mode = "observed" if observation_fresh else "expired"
    expired_reason = "SOURCE_OBSERVATION_EXPIRED"
    if not observation_fresh and verify_expired:
        # Recover by re-observing the source, never by re-indexing it.
        verified, detail = verify_source_observation(repo, state, home=home)
        if verified:
            observation_fresh = True
            observation_mode = "verified_live"
        else:
            observation_mode = "expired"
            expired_reason = str(detail.get("reason") or expired_reason)
    dirty = _read_dirty_generation(host_paths.dirty_marker)
    dirty_acknowledged = bool(
        dirty.valid and host_receipt.get("acknowledged_dirty_generation") == dirty.generation
    )
    providers: dict[str, dict[str, Any]] = {}
    for name, is_available in available.items():
        evidence = (state.get("providers") or {}).get(name, {})
        corpus_state_id = corpus_state_ids.get(name)
        corpus_matches = (
            evidence.get("indexed_corpus_state_id") == corpus_state_id
            if evidence.get("indexed_corpus_state_id") is not None
            else evidence.get("indexed_source_state_id") == source_state_id
        )
        artifact_ready = bool(
            is_available
            and observation_fresh
            and dirty_acknowledged
            and evidence.get("status") == "READY"
            and evidence.get("indexed_generation") == generation
            and evidence.get("indexed_source_state_id") == source_state_id
            and corpus_matches
        )
        probed = name in PROBED_CONSUMER_PROVIDERS
        consumer_required = probed or name in CONSUMER_BOUND_PROVIDERS
        if probed:
            refreshed = _read_json_file(paths.consumers / host / f"{name}.json")
            consumer = probed_consumer_verdict(evidence, host, source_state_id, refreshed)
            consumer_ready = consumer.get("status") == "READY"
        else:
            consumer = _read_json_file(paths.consumers / host / f"{name}.json") if consumer_required else {}
            consumer_ready = bool(
                not consumer_required
                or (
                    consumer.get("status") == "READY"
                    and consumer.get("consumer_generation") == generation
                    and consumer.get("consumer_source_state_id") == source_state_id
                )
            )
        reasons = list(evidence.get("reasons") or [])
        if not observation_fresh:
            reasons.append(expired_reason)
        if not dirty_acknowledged:
            reasons.append("HOST_DIRTY_GENERATION_UNACKNOWLEDGED")
        if artifact_ready and not consumer_ready:
            if probed:
                reasons.extend(consumer.get("reasons") or ["CONSUMER_VERDICT_MISSING"])
            else:
                reasons.append("CONSUMER_GENERATION_MISMATCH")
        usable = artifact_ready and consumer_ready
        providers[name] = {
            "available": bool(is_available),
            "status": "READY" if usable else ("ARTIFACT_READY" if artifact_ready else (evidence.get("status") or ("UNKNOWN" if is_available else "UNSUPPORTED"))),
            "artifact_ready": artifact_ready,
            "artifact_generation": evidence.get("indexed_generation"),
            "corpus_state_id": corpus_state_id,
            "indexed_corpus_state_id": evidence.get("indexed_corpus_state_id"),
            "consumer_required": consumer_required,
            "consumer_ready": consumer_ready,
            "consumer_generation": (
                (evidence.get("indexed_generation") if consumer_ready else None)
                if probed
                else consumer.get("consumer_generation")
            ),
            "usable": usable,
            "reasons": sorted(set(reasons)),
        }
        if probed:
            providers[name]["consumer_verdict"] = consumer.get("verdict")
        if name == "graphify":
            providers[name]["graph_path"] = str(paths.providers / "graphify" / "graphify-out" / "graph.json")
            providers[name]["query_index_path"] = evidence.get("query_index_path") or str(
                paths.providers / "graphify" / "graphify-out" / "query.sqlite"
            )
            providers[name]["graph_sha256"] = evidence.get("graph_sha256")

    ready = [name for name, value in providers.items() if value["usable"]]
    not_ready = [name for name, value in providers.items() if not value["usable"]]
    graph_path = providers["graphify"].get("graph_path") if "graphify" in ready else None
    graph_route = (
        f"architecture, cross-module paths and broad impact -> structural Graphify only when READY (yes; graph={graph_path})"
        if graph_path
        else "architecture, cross-module paths and broad impact -> structural Graphify only when READY (no)"
    )
    additional_context = (
        "Code intelligence routing (generation- and freshness-gated): exact literals/file names -> rg/Grep; "
        "definitions/references/implementations/call hierarchy -> native LSP, Serena only for symbolic edits/fallback; "
        f"unknown concepts/behavior -> CCC only when READY ({'yes' if 'ccc' in ready else 'no'}); "
        f"{graph_route}; "
        f"authored intent/invariants/semantic impact -> Semctx only when configured and READY ({'yes' if 'semctx' in ready else 'no'}). "
        "If an index is not READY, fall back to source/LSP and do not treat cached output as evidence. "
        "Indexes scope discovery; source and tests prove claims. Do not write query answers back into repository or graph memory automatically."
    )
    return {
        "schema_version": 1,
        "controller_version": CONTROLLER_VERSION,
        "host": host,
        "root": str(repo),
        "source_state_id": source_state_id,
        "generation": generation,
        "source_observation_age_seconds": round(age, 3) if age is not None else None,
        "source_observation_ttl_seconds": ttl,
        "source_observation_fresh": observation_fresh,
        "source_observation_mode": observation_mode,
        "host_dirty_generation_acknowledged": dirty_acknowledged,
        "providers": providers,
        "ready_providers": ready,
        "not_ready_providers": not_ready,
        "additional_context": additional_context,
    }


def publish_route_cache(
    host: str,
    root: Path | str,
    *,
    home: Path | None = None,
) -> dict[str, Any]:
    route = routing_advisory(root, host=host, home=home)
    repo = fast_worktree_root(root)
    host_paths = _host_state_paths_fast(host, repo, home=home)
    age = route.get("source_observation_age_seconds")
    ttl = float(route.get("source_observation_ttl_seconds") or 0.0)
    remaining = max(0.0, ttl - float(age)) if isinstance(age, (int, float)) and ttl > 0 else 0.0
    expires_at = datetime.now(timezone.utc).timestamp() + remaining
    cache = {
        "schema_version": 1,
        "controller_version": CONTROLLER_VERSION,
        "host": host,
        "root": str(repo),
        "generation": route.get("generation"),
        "source_state_id": route.get("source_state_id"),
        "published_at": utc_now(),
        "expires_at_unix": expires_at,
        "additional_context": route["additional_context"],
        "fallback_context": (
            "Code intelligence routing (safe fallback): exact literals/file names -> rg/Grep; "
            "definitions/references/implementations/call hierarchy -> native LSP, Serena only for symbolic edits/fallback; "
            "CCC, Graphify and Semctx are not usable because the cached source observation expired. "
            "Indexes scope discovery; source and tests prove claims."
        ),
    }
    atomic_write_json(host_paths.route_cache, cache)
    return cache


def _tail(text: str) -> str:
    return text[-MAX_CAPTURE_CHARS:]


def _parse_ccc_stats(output: str) -> tuple[int | None, int | None]:
    files_match = re.search(r"(?im)^\s*Files:\s*(\d+)", output)
    chunks_match = re.search(r"(?im)^\s*Chunks:\s*(\d+)", output)
    files = int(files_match.group(1)) if files_match else None
    chunks = int(chunks_match.group(1)) if chunks_match else None
    return files, chunks


def _first_existing(paths: Iterable[Path]) -> Path | None:
    for path in paths:
        if path.is_file():
            return path
    return None


def resolve_ccc_command(explicit: Sequence[str] | None = None) -> list[str] | None:
    if explicit:
        return list(explicit)
    override = os.environ.get("INDEX_CONTROL_CCC")
    if override:
        return [override]
    found = shutil.which("ccc")
    if found:
        return [found]
    home = Path.home()
    known = _first_existing(
        (
            home / "pipx/venvs/cocoindex-code-py314/Scripts/ccc.exe",
            home / ".local/bin/ccc.exe",
            home / "pipx/venvs/cocoindex-code/Scripts/ccc.exe",
        )
    )
    return [str(known)] if known else None


def ccc_version(command: Sequence[str] | None) -> str | None:
    if not command:
        return None
    executable = Path(command[0])
    if not executable.is_file():
        return None
    python = executable.with_name("python.exe")
    if not python.is_file():
        return None
    result = subprocess.run(
        [
            str(python),
            "-c",
            "import importlib.metadata as m; print(m.version('cocoindex-code'))",
        ],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
        timeout=15,
        **_subprocess_window_options(),
    )
    return result.stdout.strip() if result.returncode == 0 else None


def resolve_graphify_python(repo: Path) -> Path | None:
    override = os.environ.get("INDEX_CONTROL_GRAPHIFY_PYTHON")
    candidates: list[Path] = []
    if override:
        candidates.append(Path(override))
    pointer = repo / "graphify-out" / ".graphify_python"
    if pointer.is_file():
        try:
            candidates.append(Path(pointer.read_text(encoding="utf-8").strip()))
        except OSError:
            pass
    candidates.extend(
        (
            Path(r"C:\maintenence\.mcp-venvs\graphify\Scripts\python.exe"),
            Path(sys.executable),
        )
    )
    return _first_existing(candidates)


def _version_key(name: str) -> tuple[int, ...] | None:
    # Numeric, never lexicographic: "0.10.0" must outrank "0.9.0".
    parts = name.split(".")
    if not all(part.isdigit() for part in parts):
        return None
    return tuple(int(part) for part in parts)


def _semctx_plugin_script(host: str, base: Path) -> tuple[bool, Path | None]:
    """Return (declared, script) for the host's own semctx plugin.

    A declared plugin whose script is missing is a broken consumer; it is reported
    as missing, never replaced by another host's binary.
    """
    if host == "claude":
        # Claude's own install record, not a cache scan: an upgrade leaves the
        # previous versions (0.1.20 and 0.3.0 beside 0.3.3) in the cache.
        record = _read_json_file(base / ".claude" / "plugins" / "installed_plugins.json")
        installs = (record.get("plugins") or {}).get(CLAUDE_SEMCTX_PLUGIN)
        for install in installs if isinstance(installs, list) else ():
            if isinstance(install, dict) and install.get("scope") == "user" and install.get("installPath"):
                script = Path(str(install["installPath"])) / "dist" / "semctx.js"
                return True, script if script.is_file() else None
        return False, None
    # Codex keeps no install record for git-marketplace plugins. Its cache holds the
    # installed version, sometimes beside an emptied predecessor directory.
    cache = base / ".codex" / "plugins" / "cache" / "semctx-stable" / "semctx-control"
    versions = [
        (key, directory)
        for directory in (cache.iterdir() if cache.is_dir() else ())
        if directory.is_dir() and (key := _version_key(directory.name)) is not None
    ]
    installed = [
        (key, directory / "dist" / "semctx.js")
        for key, directory in versions
        if (directory / "dist" / "semctx.js").is_file()
    ]
    if not installed:
        return bool(versions), None
    return True, max(installed, key=lambda item: item[0])[1]


def resolve_semctx_command(host: str, *, home: Path | None = None) -> list[str] | None:
    """The semctx binary of this host's own consumer.

    Host-scoped on purpose: the tool version that builds the shared .semctx store
    decides which host's consumer can read it, so a Claude request must never run
    Codex's plugin, nor the reverse.
    """
    if host not in HOSTS:
        raise ValueError("host must be 'codex' or 'claude'")
    override = os.environ.get("INDEX_CONTROL_SEMCTX")
    if override:
        return [override]
    bun = shutil.which("bun") or shutil.which("bun.exe")
    if bun:
        declared, script = _semctx_plugin_script(host, (home or Path.home()).resolve())
        if declared:
            return [bun, str(script)] if script else None
    found = shutil.which("semctx")
    return [found] if found else None


def semctx_toolchain(*, home: Path | None = None) -> list[list[str]]:
    """Every host's semctx consumer, in fixed host order, without duplicates.

    The fingerprint binds this set rather than one host's binary: the state id must
    not depend on which host observes it, and a plugin change on either host must
    invalidate the semctx corpus.
    """
    commands: list[list[str]] = []
    for host in HOSTS:
        command = resolve_semctx_command(host, home=home)
        if command and command not in commands:
            commands.append(command)
    return commands


def probe_semctx_consumer(
    host: str,
    root: Path,
    *,
    home: Path | None = None,
    runner: Runner = run_command,
    timeout_seconds: int = 300,
) -> dict[str, Any]:
    """Ask one host's own semctx binary for its read-only freshness verdict."""
    executable = resolve_semctx_command(host, home=home)
    if not executable:
        return {"host": host, "status": "FAILED", "reasons": ["SEMCTX_EXECUTABLE_MISSING"]}
    command = [*executable, "status", "--json"]
    execution = runner(command, root, {}, timeout_seconds)
    result: dict[str, Any] = {
        "host": host,
        "command": command,
        "exit_code": execution.returncode,
        "duration_seconds": round(execution.duration_seconds, 3),
        "stdout_tail": _tail(execution.stdout),
        "stderr_tail": _tail(execution.stderr),
        "reasons": [],
    }
    payload: dict[str, Any] | None = None
    try:
        parsed = json.loads(execution.stdout.strip().splitlines()[-1])
        if isinstance(parsed, dict):
            payload = parsed
    except (IndexError, json.JSONDecodeError):
        pass
    if payload is not None:
        result["freshness"] = payload
    verdict = str((payload or {}).get("verdict") or (payload or {}).get("status") or "UNKNOWN").upper()
    expected_stale_exit = execution.returncode == 3 and verdict in SEMCTX_EXIT_3_STATES
    if execution.returncode != 0 and not expected_stale_exit:
        result["status"] = "FAILED"
        result["reasons"].append("STATUS_COMMAND_FAILED")
        return result
    if payload is None:
        result["status"] = "FAILED"
        result["reasons"].append("INVALID_STATUS_OUTPUT")
        return result
    upstream_reasons = payload.get("reasons") or []
    result["verdict"] = verdict
    result["upstream_reasons"] = upstream_reasons
    if verdict in READY_STATES:
        result["status"] = "READY"
    elif verdict in STALE_STATES:
        result["status"] = "STALE"
        result["reasons"].extend(str(reason) for reason in upstream_reasons)
        if not result["reasons"]:
            result["reasons"].append(f"SEMCTX_{verdict}")
    else:
        result["status"] = "FAILED" if execution.returncode != 0 else "UNKNOWN"
        result["reasons"].append(f"SEMCTX_{verdict}")
    return result


def _overall_status(providers: dict[str, dict[str, Any]]) -> str:
    statuses = {provider.get("status", "UNKNOWN") for provider in providers.values()}
    if not statuses:
        return "UNSUPPORTED"
    if "FAILED" in statuses:
        return "FAILED"
    if "STALE" in statuses:
        return "STALE"
    if "BUILDING" in statuses or "BUSY" in statuses:
        return "BUILDING"
    if statuses <= {"READY"}:
        return "READY"
    return "UNKNOWN"


def _downgrade_ready_providers(
    providers: dict[str, dict[str, Any]],
    reason: str,
) -> None:
    for provider in providers.values():
        if provider.get("status") == "READY":
            provider["status"] = "STALE"
            reasons = list(provider.get("reasons") or [])
            reasons.append(reason)
            provider["reasons"] = sorted(set(reasons))


@dataclass(frozen=True)
class DirtyGeneration:
    generation: str | None
    valid: bool


def _read_dirty_generation(path: Path) -> DirtyGeneration:
    if not path.is_file():
        return DirtyGeneration(None, True)
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return DirtyGeneration(None, False)
    generation = payload.get("generation")
    if not isinstance(generation, str) or not generation:
        return DirtyGeneration(None, False)
    return DirtyGeneration(generation, True)


class IndexController:
    def __init__(
        self,
        host: str,
        root: Path | str,
        *,
        home: Path | None = None,
        runner: Runner = run_command,
        ccc_command: Sequence[str] | None = None,
        timeout_seconds: int = DEFAULT_TIMEOUT_SECONDS,
    ) -> None:
        self.host = host
        self.root = canonical_root(root)
        self.home = home
        self.paths = state_paths(host, self.root, home=home)
        self.runner = runner
        self.ccc_command = resolve_ccc_command(ccc_command)
        self.timeout_seconds = timeout_seconds

    def _probe_ccc(self, before: dict[str, Any], *, refresh: bool) -> dict[str, Any]:
        if self.ccc_command is None:
            return {
                "status": "FAILED",
                "reasons": ["CCC_EXECUTABLE_MISSING"],
            }
        env = {"PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1"}
        index_result: CommandResult | None = None
        if refresh:
            index_result = self.runner(
                [*self.ccc_command, "index"],
                self.root,
                env,
                self.timeout_seconds,
            )
        status_result = self.runner(
            [*self.ccc_command, "status"],
            self.root,
            env,
            min(self.timeout_seconds, 120),
        )
        files, chunks = _parse_ccc_stats(status_result.stdout)
        result: dict[str, Any] = {
            "command": self.ccc_command,
            "tool_version": ccc_version(self.ccc_command),
            "status_command_exit_code": status_result.returncode,
            "files": files,
            "chunks": chunks,
            "stdout_tail": _tail(status_result.stdout),
            "stderr_tail": _tail(status_result.stderr),
            "reasons": [],
        }
        if index_result is not None:
            result.update(
                {
                    "index_command_exit_code": index_result.returncode,
                    "index_duration_seconds": round(index_result.duration_seconds, 3),
                    "index_stdout_tail": _tail(index_result.stdout),
                    "index_stderr_tail": _tail(index_result.stderr),
                }
            )
        if status_result.returncode != 0:
            result["status"] = "FAILED"
            result["reasons"].append("STATUS_COMMAND_FAILED")
            return result
        if refresh and index_result is not None and index_result.returncode != 0:
            result["status"] = "FAILED"
            result["reasons"].append("INDEX_COMMAND_FAILED")
            return result
        if files is None or chunks is None:
            result["status"] = "FAILED"
            result["reasons"].append("INVALID_STATUS_OUTPUT")
            return result
        if not refresh:
            result["status"] = "UNKNOWN"
            result["reasons"].append("NO_EXACT_REFRESH_RECEIPT")
            return result
        after = fingerprint_repository(self.root, home=self.home)
        if after["state_id"] != before["state_id"]:
            result["status"] = "STALE"
            result["reasons"].append("REPOSITORY_CHANGED_DURING_REFRESH")
        else:
            result["status"] = "READY"
        return result

    def _probe_graphify(self) -> dict[str, Any]:
        graph = self.root / "graphify-out" / "graph.json"
        manifest = self.root / "graphify-out" / "manifest.json"
        if not graph.is_file():
            return {"status": "UNSUPPORTED", "reasons": ["GRAPH_MISSING"]}
        if not manifest.is_file():
            return {"status": "STALE", "reasons": ["MANIFEST_MISSING"]}
        interpreter = resolve_graphify_python(self.root)
        if interpreter is None:
            return {"status": "FAILED", "reasons": ["GRAPHIFY_INTERPRETER_MISSING"]}
        program = (
            "import json,sys; from pathlib import Path; "
            "from graphify.detect import detect_incremental; "
            "r=detect_incremental(Path(sys.argv[1])); "
            "print(json.dumps({'new_total':r.get('new_total',0),"
            "'deleted_count':len(r.get('deleted_files',[])),"
            "'changed_by_type':{k:len(v) for k,v in r.get('new_files',{}).items()},"
            "'total_files':sum(len(v) for v in r.get('files',{}).values())}))"
        )
        command = [str(interpreter), "-c", program, str(self.root)]
        execution = self.runner(command, self.root, {}, min(self.timeout_seconds, 300))
        result: dict[str, Any] = {
            "command": command[:2] + ["<probe>", str(self.root)],
            "exit_code": execution.returncode,
            "duration_seconds": round(execution.duration_seconds, 3),
            "stdout_tail": _tail(execution.stdout),
            "stderr_tail": _tail(execution.stderr),
            "reasons": [],
        }
        if execution.returncode != 0:
            result["status"] = "FAILED"
            result["reasons"].append("INCREMENTAL_DETECT_FAILED")
            return result
        try:
            payload = json.loads(execution.stdout.strip().splitlines()[-1])
        except (IndexError, json.JSONDecodeError):
            result["status"] = "FAILED"
            result["reasons"].append("INVALID_DETECT_OUTPUT")
            return result
        required_counts = ("new_total", "deleted_count", "total_files")
        changed_by_type = payload.get("changed_by_type")
        valid_payload = (
            all(type(payload.get(name)) is int and payload[name] >= 0 for name in required_counts)
            and isinstance(changed_by_type, dict)
            and all(type(value) is int and value >= 0 for value in changed_by_type.values())
        )
        if not valid_payload:
            result["status"] = "FAILED"
            result["reasons"].append("INVALID_DETECT_OUTPUT")
            return result
        result.update(payload)
        if payload.get("new_total", 0) or payload.get("deleted_count", 0):
            result["status"] = "STALE"
            result["reasons"].append("CORPUS_CHANGED")
        else:
            result["status"] = "READY"
        return result

    def _probe_semctx(self) -> dict[str, Any]:
        return probe_semctx_consumer(
            self.host,
            self.root,
            home=self.home,
            runner=self.runner,
            timeout_seconds=min(self.timeout_seconds, 300),
        )

    def refresh(
        self,
        *,
        probe_graphify: bool = True,
        probe_semctx: bool = True,
    ) -> dict[str, Any]:
        run_id = uuid.uuid4().hex
        started_at = utc_now()
        started = time.monotonic()
        lock = AtomicLock(self.paths.lock)
        if not lock.acquire():
            return {
                "schema_version": 1,
                "controller_version": CONTROLLER_VERSION,
                "run_id": run_id,
                "host": self.host,
                "root": str(self.root),
                "overall_status": "BUILDING",
                "reasons": ["REFRESH_ALREADY_RUNNING"],
                "lock": str(self.paths.lock),
            }
        try:
            before = fingerprint_repository(self.root, home=self.home)
            dirty_before = _read_dirty_generation(self.paths.dirty_marker)
            available = discover_providers(self.root, home=self.home)
            providers: dict[str, dict[str, Any]] = {}
            shared = shared_state_paths(self.root, home=self.home)
            semctx_before: dict[str, Any] = {}
            if available["ccc"]:
                providers["ccc"] = self._probe_ccc(before, refresh=True)
            if available["graphify"] and probe_graphify:
                providers["graphify"] = self._probe_graphify()
            if available["semctx"] and probe_semctx:
                semctx_before = _read_json_file(shared.worker_state)
                providers["semctx"] = self._probe_semctx()
            after = fingerprint_repository(self.root, home=self.home)
            dirty_after = _read_dirty_generation(self.paths.dirty_marker)
            if after["state_id"] != before["state_id"]:
                _downgrade_ready_providers(providers, "REPOSITORY_CHANGED_DURING_REFRESH")
            if not dirty_before.valid or not dirty_after.valid:
                _downgrade_ready_providers(providers, "DIRTY_MARKER_INVALID")
            elif dirty_after.generation != dirty_before.generation:
                _downgrade_ready_providers(providers, "SOURCE_MUTATED_DURING_REFRESH")
            acknowledged_generation = (
                dirty_after.generation
                if dirty_before.valid
                and dirty_after.valid
                and dirty_after.generation == dirty_before.generation
                else None
            )
            receipt = {
                "schema_version": 1,
                "controller_version": CONTROLLER_VERSION,
                "run_id": run_id,
                "host": self.host,
                "started_at": started_at,
                "completed_at": utc_now(),
                "duration_seconds": round(time.monotonic() - started, 3),
                "overall_status": _overall_status(providers),
                "repository": after,
                "providers": providers,
                "available_providers": available,
                "acknowledged_dirty_generation": acknowledged_generation,
                "dirty_generation": dirty_after.generation,
                "shared_lock": str(self.paths.lock),
                "receipt": str(self.paths.receipt),
            }
            atomic_write_json(self.paths.receipt, receipt)
            history_path = self.paths.history / f"{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}-{run_id}.json"
            atomic_write_json(history_path, receipt)
            published_generation = _read_dirty_generation(self.paths.dirty_marker)
            publication_reason: str | None = None
            if not published_generation.valid:
                publication_reason = "DIRTY_MARKER_INVALID"
            elif published_generation.generation != receipt["acknowledged_dirty_generation"]:
                publication_reason = "DIRTY_GENERATION_MISMATCH"
            if publication_reason:
                _downgrade_ready_providers(providers, publication_reason)
                receipt["overall_status"] = _overall_status(providers)
                if receipt["overall_status"] == "READY":
                    receipt["overall_status"] = "STALE"
                receipt["dirty_generation"] = published_generation.generation
                reasons = list(receipt.get("reasons") or [])
                reasons.append(publication_reason)
                receipt["reasons"] = sorted(set(reasons))
                atomic_write_json(self.paths.receipt, receipt)
                atomic_write_json(history_path, receipt)
            elif "semctx" in providers:
                # An operator may seal the store with index --record between worker
                # cycles. Bind this read-only status probe to the build observed both
                # before and after the probe, then make it visible to the route.
                semctx_after = _read_json_file(shared.worker_state)
                old_build = (semctx_before.get("providers") or {}).get("semctx") or {}
                build = (semctx_after.get("providers") or {}).get("semctx") or {}
                if (
                    old_build.get("attempted_at")
                    and old_build.get("attempted_at") == build.get("attempted_at")
                    and semctx_before.get("generation") == semctx_after.get("generation")
                    and (semctx_before.get("source") or {}).get("state_id") == before["state_id"]
                    and (semctx_after.get("source") or {}).get("state_id") == after["state_id"]
                    and build.get("status") == "READY"
                    and build.get("indexed_generation") == semctx_after.get("generation")
                    and build.get("indexed_source_state_id") == after["state_id"]
                    and build.get("indexed_corpus_state_id") == (after.get("provider_corpus_state_ids") or {}).get("semctx")
                ):
                    verdict = dict(providers["semctx"])
                    verdict.update({
                        "probe_kind": "semctx_status",
                        "provider": "semctx",
                        "build_attempted_at": build["attempted_at"],
                        "source_state_id": after["state_id"],
                        "observed_at": receipt["completed_at"],
                    })
                    if (
                        verdict.get("status") != "READY"
                        and "TOOL_VERSION_MISMATCH" in (verdict.get("upstream_reasons") or [])
                        and list(verdict.get("command") or [])[:-2] != list(build.get("command") or [])[:-2]
                    ):
                        verdict["reasons"] = sorted(set([*(verdict.get("reasons") or []), "SEMCTX_HOST_VERSION_SKEW"]))
                    atomic_write_json(shared.consumers / self.host / "semctx.json", verdict)
                    publish_route_cache(self.host, self.root, home=self.home)
            prune_history(self.paths.history)
            return receipt
        finally:
            lock.release()

    def live_status(self) -> dict[str, Any]:
        cached = cached_status(self.host, self.root, home=self.home)
        current = fingerprint_repository(self.root, home=self.home)
        available = discover_providers(self.root, home=self.home)
        providers: dict[str, dict[str, Any]] = {}
        if available["ccc"]:
            cached_ccc = cached.get("providers", {}).get("ccc", {})
            cached_state = cached.get("repository", {}).get("state_id")
            cached_version = cached_ccc.get("tool_version")
            current_version = ccc_version(self.ccc_command)
            ccc = dict(cached_ccc)
            ccc.update(
                {
                    "command": self.ccc_command,
                    "tool_version": current_version or cached_version,
                    "observation_mode": "cached_receipt",
                }
            )
            version_matches = not cached_version or not current_version or cached_version == current_version
            if cached_state == current["state_id"] and cached_ccc.get("status") == "READY" and version_matches:
                ccc["status"] = "READY"
                ccc["reasons"] = []
            elif cached_version and current_version and cached_version != current_version:
                ccc["status"] = "STALE"
                ccc["reasons"] = ["TOOL_VERSION_MISMATCH"]
            elif not cached_ccc:
                ccc["status"] = "UNKNOWN"
                ccc["reasons"] = ["NO_EXACT_REFRESH_RECEIPT"]
            elif cached_state != current["state_id"]:
                ccc["status"] = "STALE"
                ccc["reasons"] = ["SOURCE_CHANGED_AFTER_REFRESH"]
            providers["ccc"] = ccc
        for provider in ("graphify", "semctx"):
            if not available[provider]:
                continue
            observed = dict(cached.get("providers", {}).get(provider, {}))
            observed["observation_mode"] = "cached_receipt"
            if not cached.get("providers", {}).get(provider):
                observed["status"] = "UNKNOWN"
                observed["reasons"] = ["NO_EXACT_REFRESH_RECEIPT"]
            elif cached.get("repository", {}).get("state_id") != current["state_id"]:
                observed["status"] = "STALE"
                observed["reasons"] = ["SOURCE_CHANGED_AFTER_REFRESH"]
            providers[provider] = observed
        return {
            "schema_version": 1,
            "controller_version": CONTROLLER_VERSION,
            "host": self.host,
            "overall_status": _overall_status(providers),
            "repository": current,
            "providers": providers,
            "available_providers": available,
            "cached_receipt": str(self.paths.receipt),
        }


def cached_status(
    host: str,
    root: Path | str,
    *,
    home: Path | None = None,
) -> dict[str, Any]:
    repo = canonical_root(root)
    paths = state_paths(host, repo, home=home)
    current = fingerprint_repository(repo, home=home)
    if not paths.receipt.is_file():
        return {
            "schema_version": 1,
            "controller_version": CONTROLLER_VERSION,
            "host": host,
            "overall_status": "UNKNOWN",
            "reasons": ["RECEIPT_MISSING"],
            "repository": current,
            "providers": {},
            "receipt": str(paths.receipt),
        }
    try:
        receipt = json.loads(paths.receipt.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        return {
            "schema_version": 1,
            "controller_version": CONTROLLER_VERSION,
            "host": host,
            "overall_status": "FAILED",
            "reasons": ["RECEIPT_INVALID", str(error)],
            "repository": current,
            "providers": {},
            "receipt": str(paths.receipt),
        }
    result = dict(receipt)
    result["current_repository"] = current
    result["receipt"] = str(paths.receipt)
    reasons = list(result.get("reasons") or [])
    if receipt.get("repository", {}).get("state_id") != current["state_id"]:
        result["overall_status"] = "STALE"
        reasons.append("REPOSITORY_STATE_MISMATCH")
    dirty_generation = _read_dirty_generation(paths.dirty_marker)
    result["dirty_generation"] = dirty_generation.generation
    dirty_reason: str | None = None
    if not dirty_generation.valid:
        dirty_reason = "DIRTY_MARKER_INVALID"
    elif receipt.get("acknowledged_dirty_generation") != dirty_generation.generation:
        dirty_reason = "DIRTY_GENERATION_MISMATCH"
    if dirty_reason:
        if result.get("overall_status") not in {"FAILED", "BUILDING"}:
            result["overall_status"] = "STALE"
        reasons.append(dirty_reason)
        _downgrade_ready_providers(result.setdefault("providers", {}), dirty_reason)
    result["reasons"] = sorted(set(reasons))
    return result


def mark_dirty(
    host: str,
    root: Path | str,
    *,
    reason: str = "SOURCE_MUTATED",
    home: Path | None = None,
) -> dict[str, Any]:
    repo = canonical_root(root)
    paths = state_paths(host, repo, home=home)
    marker = {
        "schema_version": 1,
        "controller_version": CONTROLLER_VERSION,
        "host": host,
        "root": str(repo),
        "generation": uuid.uuid4().hex,
        "reason": reason,
        "invalidated_at": utc_now(),
    }
    atomic_write_json(paths.dirty_marker, marker)
    existing: dict[str, Any] = {}
    if paths.receipt.is_file():
        try:
            existing = json.loads(paths.receipt.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            existing = {}
    reasons = list(existing.get("reasons") or [])
    reasons.append(reason)
    existing.update(
        {
            "schema_version": 1,
            "controller_version": CONTROLLER_VERSION,
            "host": host,
            "overall_status": "STALE",
            "reasons": sorted(set(reasons)),
            "invalidated_at": utc_now(),
            "invalidated_root": str(repo),
            "dirty_generation": marker["generation"],
            "receipt": str(paths.receipt),
        }
    )
    providers = existing.get("providers") or {}
    for provider in providers.values():
        if provider.get("status") == "READY":
            provider["status"] = "STALE"
            provider_reasons = list(provider.get("reasons") or [])
            provider_reasons.append(reason)
            provider["reasons"] = sorted(set(provider_reasons))
    existing["providers"] = providers
    atomic_write_json(paths.receipt, existing)
    enqueue_reconcile_event(
        host,
        repo,
        kind="source_mutated",
        reason=reason,
        home=home,
    )
    publish_route_cache(host, repo, home=home)
    return existing


def text_summary(payload: dict[str, Any]) -> str:
    lines = [
        f"Index control: {payload.get('overall_status', 'UNKNOWN')}",
        f"Root: {payload.get('repository', payload.get('current_repository', {})).get('root', payload.get('root', 'unknown'))}",
        f"Host: {payload.get('host', 'unknown')}",
    ]
    for name, provider in sorted((payload.get("providers") or {}).items()):
        reasons = ", ".join(provider.get("reasons") or [])
        suffix = f" ({reasons})" if reasons else ""
        lines.append(f"- {name}: {provider.get('status', 'UNKNOWN')}{suffix}")
    for reason in payload.get("reasons") or []:
        lines.append(f"- control: {reason}")
    return "\n".join(lines)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Govern code-index freshness across Codex and Claude.")
    subparsers = parser.add_subparsers(dest="command", required=True)
    for name in ("refresh", "hook", "status", "mark-dirty"):
        command = subparsers.add_parser(name)
        command.add_argument("--host", choices=("codex", "claude"), required=True)
        command.add_argument("--root", default=os.getcwd())
        command.add_argument("--format", choices=("json", "text"), default="json")
        command.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT_SECONDS)
        if name in {"refresh", "hook"}:
            command.add_argument("--no-graphify", action="store_true")
            command.add_argument("--no-semctx", action="store_true")
        if name == "status":
            command.add_argument("--live", action="store_true")
        if name == "mark-dirty":
            command.add_argument("--reason", default="SOURCE_MUTATED")
    doctor = subparsers.add_parser("doctor")
    doctor.add_argument("--root", default=os.getcwd())
    doctor.add_argument("--format", choices=("json", "text"), default="json")
    route = subparsers.add_parser("route")
    route.add_argument("--host", choices=("codex", "claude"), default="codex")
    route.add_argument("--root", default=os.getcwd())
    route.add_argument("--format", choices=("json", "text"), default="text")
    route.add_argument(
        "--verify-expired",
        action="store_true",
        help="On an expired observation, re-fingerprint the worktree to recover. Never starts a provider.",
    )
    consumer = subparsers.add_parser("consumer-ready")
    consumer.add_argument("--host", choices=("codex", "claude"), required=True)
    consumer.add_argument("--root", default=os.getcwd())
    consumer.add_argument("--provider", choices=tuple(sorted(CONSUMER_BOUND_PROVIDERS)), required=True)
    consumer.add_argument("--format", choices=("json", "text"), default="json")
    consumer_stale = subparsers.add_parser("consumer-stale")
    consumer_stale.add_argument("--host", choices=("codex", "claude"), required=True)
    consumer_stale.add_argument("--root", default=os.getcwd())
    consumer_stale.add_argument("--provider", choices=tuple(sorted(CONSUMER_BOUND_PROVIDERS)), required=True)
    consumer_stale.add_argument("--reason", default="CONSUMER_STOPPED")
    consumer_stale.add_argument("--format", choices=("json", "text"), default="json")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        if args.command == "doctor":
            root = canonical_root(args.root)
            payload = {
                "schema_version": 1,
                "controller_version": CONTROLLER_VERSION,
                "root": str(root),
                "providers": discover_providers(root),
                "ccc_command": resolve_ccc_command(),
                "graphify_python": str(resolve_graphify_python(root) or ""),
                "semctx_commands": {host: resolve_semctx_command(host) for host in HOSTS},
            }
        elif args.command == "route":
            payload = routing_advisory(args.root, host=args.host, verify_expired=args.verify_expired)
        elif args.command == "consumer-ready":
            payload = register_consumer(args.host, args.root, args.provider)
        elif args.command == "consumer-stale":
            payload = invalidate_consumer(args.host, args.root, args.provider, reason=args.reason)
        else:
            controller = IndexController(
                host=args.host,
                root=args.root,
                timeout_seconds=args.timeout,
            )
            if args.command in {"refresh", "hook"}:
                payload = controller.refresh(
                    probe_graphify=not args.no_graphify,
                    probe_semctx=not args.no_semctx,
                )
            elif args.command == "mark-dirty":
                payload = mark_dirty(args.host, args.root, reason=args.reason)
            elif args.live:
                payload = controller.live_status()
            else:
                payload = cached_status(args.host, args.root)
        if args.format == "json":
            print(json.dumps(payload, ensure_ascii=False, indent=2))
        elif args.command == "route":
            print(payload["additional_context"])
        else:
            print(text_summary(payload))
        return 2 if payload.get("overall_status") == "FAILED" else 0
    except Exception as error:
        failure = {
            "schema_version": 1,
            "controller_version": CONTROLLER_VERSION,
            "overall_status": "FAILED",
            "reasons": [type(error).__name__, str(error)],
        }
        print(json.dumps(failure, ensure_ascii=False, indent=2), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
