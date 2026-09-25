from __future__ import annotations

import argparse
import json
import math
import os
import statistics
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, BinaryIO, Sequence


SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from gateway import Gateway


DEFAULT_MANIFEST = Path(__file__).parents[1] / "evals" / "lsp-benchmark-tasks.json"
NODE = Path(r"C:\nvm4w\nodejs\node.exe")
TYPESCRIPT_SERVER = Path(r"C:\ProgramData\nvm\v22.21.1\node_modules\typescript-language-server\lib\cli.mjs")
PYRIGHT_SERVER = Path(r"C:\ProgramData\nvm\v22.21.1\node_modules\pyright\langserver.index.js")


def percentile(values: list[float], fraction: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    return ordered[max(0, math.ceil(fraction * len(ordered)) - 1)]


def path_uri(path: Path) -> str:
    return path.resolve().as_uri()


def location_paths(value: Any) -> set[str]:
    if value is None:
        return set()
    items = value if isinstance(value, list) else [value]
    paths: set[str] = set()
    for item in items:
        if not isinstance(item, dict):
            continue
        uri = item.get("uri") or (item.get("targetUri") if isinstance(item.get("targetUri"), str) else None)
        if isinstance(uri, str) and uri.startswith("file:"):
            from urllib.parse import unquote, urlparse

            parsed = urlparse(uri)
            raw = unquote(parsed.path)
            if parsed.netloc:
                raw = f"//{parsed.netloc}{raw}"
            if os.name == "nt" and raw.startswith("/") and len(raw) > 2 and raw[2] == ":":
                raw = raw[1:]
            paths.add(str(Path(raw)).replace("\\", "/").lower())
    return paths


def anchor_position(path: Path, anchor: str, occurrence: int = 1) -> tuple[int, int]:
    text = path.read_text(encoding="utf-8")
    start = 0
    found = -1
    for _ in range(occurrence):
        found = text.find(anchor, start)
        if found < 0:
            raise ValueError(f"anchor {anchor!r} occurrence {occurrence} not found in {path}")
        start = found + len(anchor)
    line = text.count("\n", 0, found)
    line_start = text.rfind("\n", 0, found) + 1
    return line, found - line_start


def process_tree_rss_mb(pid: int) -> float | None:
    script = (
        "$all=Get-CimInstance Win32_Process;"
        f"$ids=@({pid});"
        "do{$before=$ids.Count;$ids+=@($all|Where-Object{$ids -contains $_.ParentProcessId}|ForEach-Object ProcessId);"
        "$ids=@($ids|Select-Object -Unique)}while($ids.Count -gt $before);"
        "$sum=($all|Where-Object{$ids -contains $_.ProcessId}|Measure-Object WorkingSetSize -Sum).Sum;"
        "[Console]::Write($sum)"
    )
    completed = subprocess.run(
        ["pwsh", "-NoProfile", "-Command", script],
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=15,
        check=False,
    )
    try:
        return round(int(completed.stdout.strip()) / 1024 / 1024, 3)
    except (TypeError, ValueError):
        return None


class LspProcess:
    def __init__(self, command: Sequence[str], root: Path) -> None:
        self.command = list(command)
        self.root = root.resolve()
        self.process: subprocess.Popen[bytes] | None = None
        self.next_id = 1

    def __enter__(self) -> "LspProcess":
        self.process = subprocess.Popen(
            self.command,
            cwd=self.root,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )
        return self

    def _streams(self) -> tuple[BinaryIO, BinaryIO]:
        if self.process is None or self.process.stdin is None or self.process.stdout is None:
            raise RuntimeError("LSP process is not running")
        return self.process.stdin, self.process.stdout

    def send(self, message: dict[str, Any]) -> None:
        stdin, _ = self._streams()
        payload = json.dumps(message, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        stdin.write(f"Content-Length: {len(payload)}\r\n\r\n".encode("ascii") + payload)
        stdin.flush()

    def read(self) -> dict[str, Any]:
        _, stdout = self._streams()
        length: int | None = None
        while True:
            line = stdout.readline()
            if not line:
                stderr = b""
                if self.process is not None and self.process.stderr is not None:
                    stderr = self.process.stderr.read()
                raise RuntimeError(f"LSP process closed output: {stderr.decode('utf-8', errors='replace')[-2000:]}")
            if line in {b"\r\n", b"\n"}:
                break
            name, _, value = line.decode("ascii", errors="replace").partition(":")
            if name.lower() == "content-length":
                length = int(value.strip())
        if length is None:
            raise RuntimeError("LSP response omitted Content-Length")
        return json.loads(stdout.read(length).decode("utf-8"))

    def notify(self, method: str, params: dict[str, Any]) -> None:
        self.send({"jsonrpc": "2.0", "method": method, "params": params})

    def request(self, method: str, params: dict[str, Any]) -> Any:
        request_id = self.next_id
        self.next_id += 1
        self.send({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params})
        while True:
            message = self.read()
            if message.get("id") == request_id:
                if "error" in message:
                    raise RuntimeError(f"{method} failed: {message['error']}")
                return message.get("result")
            if "id" in message and "method" in message:
                self.send({"jsonrpc": "2.0", "id": message["id"], "result": self._server_request_result(message)})

    @staticmethod
    def _server_request_result(message: dict[str, Any]) -> Any:
        if message.get("method") == "workspace/configuration":
            items = (message.get("params") or {}).get("items") or []
            return [{} for _ in items]
        if message.get("method") == "workspace/workspaceFolders":
            return None
        return None

    def initialize(self) -> None:
        self.request(
            "initialize",
            {
                "processId": os.getpid(),
                "rootUri": path_uri(self.root),
                "workspaceFolders": [{"uri": path_uri(self.root), "name": self.root.name}],
                "capabilities": {
                    "workspace": {"configuration": True, "workspaceFolders": True},
                    "textDocument": {
                        "definition": {"linkSupport": True},
                        "references": {},
                        "synchronization": {"didSave": True},
                    },
                },
            },
        )
        self.notify("initialized", {})

    def open_document(self, path: Path, language: str) -> None:
        self.notify(
            "textDocument/didOpen",
            {
                "textDocument": {
                    "uri": path_uri(path),
                    "languageId": language,
                    "version": 1,
                    "text": path.read_text(encoding="utf-8"),
                }
            },
        )

    def close(self) -> float:
        if self.process is None:
            return 0.0
        started = time.perf_counter()
        try:
            self.request("shutdown", {})
            self.notify("exit", {})
            self.process.wait(timeout=5)
        except Exception:
            self.process.kill()
            self.process.wait(timeout=5)
        return (time.perf_counter() - started) * 1000

    def __exit__(self, exc_type, exc, tb) -> None:
        self.close()


def server_command(language: str) -> list[str]:
    if language == "typescript":
        return [str(NODE), str(TYPESCRIPT_SERVER), "--stdio"]
    if language == "python":
        return [str(NODE), str(PYRIGHT_SERVER), "--stdio"]
    raise ValueError(f"unsupported language: {language}")


def gateway_comparison(task: dict[str, Any]) -> dict[str, Any]:
    gateway = Gateway("codex")
    started = time.perf_counter()
    try:
        result = gateway.symbols({"root": task["root"], "symbol": task["symbol"], "limit": 50})
    finally:
        gateway.close()
    paths = {
        str(item.get("path", "")).replace("\\", "/").lower()
        for item in [*(result.get("sources") or []), *(result.get("matches") or [])]
        if isinstance(item, dict)
    }
    expected = str(Path(task["root"]) / task["expected"]).replace("\\", "/").lower()
    return {
        "elapsed_ms": round((time.perf_counter() - started) * 1000, 3),
        "correct": expected in paths or any(path.endswith(task["expected"].replace("\\", "/").lower()) for path in paths),
        "paths": sorted(paths),
        "provider": result.get("provider"),
        "fallback_used": bool(result.get("fallback_used")),
    }


def run(manifest: Path, *, warm_runs: int = 10) -> dict[str, Any]:
    payload = json.loads(manifest.read_text(encoding="utf-8"))
    tasks = payload.get("tasks") or []
    rows: list[dict[str, Any]] = []
    lifecycle: list[dict[str, Any]] = []
    for language in ("typescript", "python"):
        language_tasks = [task for task in tasks if task["language"] == language]
        roots = {str(Path(task["root"]).resolve()).lower() for task in language_tasks}
        if len(roots) != 1:
            raise ValueError(f"{language} tasks must share exactly one root")
        root = Path(language_tasks[0]["root"]).resolve()
        server = LspProcess(server_command(language), root)
        server.__enter__()
        cold_started = time.perf_counter()
        server.initialize()
        opened: set[Path] = set()
        cold_query_ms = 0.0
        cold_total_ms = 0.0
        shutdown_ms = 0.0
        try:
            for task_index, task in enumerate(language_tasks):
                document = root / task["document"]
                if document not in opened:
                    server.open_document(document, language)
                    opened.add(document)
                line, character = anchor_position(document, task["anchor"], int(task.get("occurrence", 1)))
                params = {"textDocument": {"uri": path_uri(document)}, "position": {"line": line, "character": character}}
                if task["request"] == "references":
                    params["context"] = {"includeDeclaration": True}
                if language == "typescript" and task["request"] == "definition":
                    method = "workspace/executeCommand"
                    params = {
                        "command": "_typescript.goToSourceDefinition",
                        "arguments": [path_uri(document), {"line": line, "character": character}],
                    }
                else:
                    method = f"textDocument/{task['request']}"
                durations: list[float] = []
                result: Any = None
                for run_index in range(warm_runs + 1):
                    started = time.perf_counter()
                    result = server.request(method, params)
                    elapsed = (time.perf_counter() - started) * 1000
                    if task_index == 0 and run_index == 0:
                        cold_query_ms = elapsed
                        cold_total_ms = (time.perf_counter() - cold_started) * 1000
                    if run_index > 0:
                        durations.append(elapsed)
                paths = location_paths(result)
                expected = str((root / task["expected"]).resolve()).replace("\\", "/").lower()
                comparison = gateway_comparison(task)
                rows.append(
                    {
                        **task,
                        "line": line,
                        "character": character,
                        "lsp_correct": expected in paths,
                        "lsp_locations": len(paths),
                        "lsp_paths": sorted(paths),
                        "lsp_p50_ms": round(statistics.median(durations), 3),
                        "lsp_p95_ms": round(percentile(durations, 0.95), 3),
                        "gateway": comparison,
                    }
                )
            rss_mb = process_tree_rss_mb(server.process.pid if server.process is not None else -1)
        finally:
            shutdown_ms = server.close()
        lifecycle.append(
            {
                "language": language,
                "server_command": server.command,
                "server_version": payload.get("server_versions", {}).get(language),
                "cold_initialize_and_first_query_ms": round(cold_total_ms, 3),
                "cold_first_query_ms": round(cold_query_ms, 3),
                "peak_observed_process_tree_rss_mb": rss_mb,
                "shutdown_ms": round(shutdown_ms, 3),
                "process_exited": server.process is not None and server.process.poll() is not None,
            }
        )
    return {
        "schema_version": 1,
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "manifest": str(manifest.resolve()),
        "warm_runs_per_task": warm_runs,
        "lifecycle": lifecycle,
        "coverage": {
            "tasks": len(rows),
            "lsp_correct": sum(bool(row["lsp_correct"]) for row in rows),
            "gateway_correct": sum(bool(row["gateway"]["correct"]) for row in rows),
        },
        "rows": rows,
        "decision": "Keep native LSP as the definition/reference lane; do not add a persistent LSP MCP. Start servers on demand per editor/session and terminate them with the owning session.",
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Native TypeScript/Python LSP lifecycle benchmark.")
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--warm-runs", type=int, default=10)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    result = run(args.manifest, warm_runs=max(1, args.warm_runs))
    rendered = json.dumps(result, ensure_ascii=False, indent=2)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered + "\n", encoding="utf-8")
    print(rendered)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
