import argparse
import asyncio
import json
import math
import hashlib
import os
import ctypes
import time
from pathlib import Path
from email.message import Message


# Research probes retain responses for inspection; timeouts alone do not bound memory.
MAX_HEADER_BYTES = 8 * 1024
MAX_FRAME_BYTES = 4 * 1024 * 1024
MAX_WIRE_BYTES = 16 * 1024 * 1024
MAX_MESSAGES = 10_000
CLEANUP_TIMEOUT = 1.0


def direct_child_rss(process):
    """Peak working set of this one native process; never descendant RSS."""
    result = {"peakRssBytes": None, "scope": "direct process peak working set"}
    if os.name != "nt":
        return {**result, "reason": "Windows PSAPI accounting unavailable on this OS"}
    from ctypes import wintypes

    class Counters(ctypes.Structure):
        _fields_ = [("cb", wintypes.DWORD), ("PageFaultCount", wintypes.DWORD),
                    *[(name, ctypes.c_size_t) for name in (
                        "PeakWorkingSetSize", "WorkingSetSize", "QuotaPeakPagedPoolUsage",
                        "QuotaPagedPoolUsage", "QuotaPeakNonPagedPoolUsage",
                        "QuotaNonPagedPoolUsage", "PagefileUsage", "PeakPagefileUsage")]]

    counters = Counters()
    counters.cb = ctypes.sizeof(counters)
    try:
        query = ctypes.WinDLL("psapi", use_last_error=True).GetProcessMemoryInfo
        query.argtypes = [wintypes.HANDLE, ctypes.POINTER(Counters), wintypes.DWORD]
        query.restype = wintypes.BOOL
        if not query(wintypes.HANDLE(int(process._handle)), ctypes.byref(counters), counters.cb):
            return {**result, "win32Error": ctypes.get_last_error(), "reason": "GetProcessMemoryInfo failed"}
        return {**result, "peakRssBytes": counters.PeakWorkingSetSize}
    except (AttributeError, OSError, ValueError) as error:
        return {**result, "reason": f"GetProcessMemoryInfo handle/API unavailable: {error}"}


async def discard_output(reader):
    # Drain without retaining output after protocol inspection has finished.
    while await reader.read(64 * 1024):
        pass


async def cleanup_process(process, drain):
    if process.returncode is None:
        try:
            process.kill()
        except ProcessLookupError:
            pass  # Exit can race the cancellation/refusal path.
    process.stdin.close()
    if drain is None:
        drain = asyncio.create_task(discard_output(process.stdout))
    waiter = asyncio.create_task(process.wait())
    tasks = {drain, waiter}
    try:
        _, pending = await asyncio.wait(tasks, timeout=CLEANUP_TIMEOUT)
        if pending:
            raise TimeoutError("LSP direct-child cleanup deadline exceeded")
        for task in tasks:
            task.result()
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


def reject_json_constant(value):
    raise ValueError(f"invalid JSON numeric constant: {value}")


def finite_json_float(value):
    number = float(value)
    if not math.isfinite(number):
        raise ValueError("JSON number exceeds finite float range")
    return number


async def receive(reader, budget=None):
    if budget is None:
        budget = {"wire_bytes": 0, "messages": 0}
    if budget["messages"] >= MAX_MESSAGES:
        raise ValueError("LSP message count limit exceeded")
    header = bytearray()
    while not header.endswith(b"\r\n\r\n"):
        if len(header) >= MAX_HEADER_BYTES:
            raise ValueError("LSP header byte limit exceeded")
        if budget["wire_bytes"] >= MAX_WIRE_BYTES:
            raise ValueError("LSP wire byte limit exceeded")
        header.extend(await reader.readexactly(1))
        budget["wire_bytes"] += 1
    lengths = []
    content_types = []
    for line in header.decode("ascii").split("\r\n")[:-2]:
        name, separator, value = line.partition(":")
        if not separator:
            raise ValueError("invalid LSP header")
        if name.lower() == "content-length":
            lengths.append(value.strip())
        if name.lower() == "content-type":
            content_types.append(value.strip())
    if len(content_types) > 1:
        raise ValueError("duplicate LSP Content-Type")
    if content_types:
        content_type = Message()
        content_type["Content-Type"] = content_types[0]
        charsets = [value for name, value in content_type.get_params()[1:] if name.lower() == "charset"]
        if len(charsets) > 1 or (charsets and (
                not isinstance(charsets[0], str) or charsets[0].lower() not in ("utf-8", "utf8"))):
            raise ValueError("unsupported or duplicate LSP charset")
    if len(lengths) != 1 or not lengths[0] or not all("0" <= char <= "9" for char in lengths[0]):
        raise ValueError("invalid or duplicate LSP Content-Length")
    # Compare decimal text first, so even an enormous integer advertisement is refused.
    length_text = lengths[0].lstrip("0") or "0"
    maximum = str(MAX_FRAME_BYTES)
    if len(length_text) > len(maximum) or (len(length_text) == len(maximum) and length_text > maximum):
        raise ValueError("LSP frame byte limit exceeded")
    length = int(length_text)
    if budget["wire_bytes"] + length > MAX_WIRE_BYTES:
        raise ValueError("LSP wire byte limit exceeded")
    budget["wire_bytes"] += length
    budget["messages"] += 1
    body = await reader.readexactly(length)
    return json.loads(body.decode("utf-8"), parse_constant=reject_json_constant, parse_float=finite_json_float)


def newline_change(source, sync, appended="\n"):
    kind = sync.get("change", 0) if isinstance(sync, dict) else sync
    if kind == 1:
        return {"text": source + appended}
    if kind != 2:
        raise ValueError("server does not support document changes")
    lines = source.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    end = {"line": len(lines) - 1, "character": len(lines[-1].encode("utf-16-le")) // 2}
    return {"range": {"start": end, "end": end}, "text": appended}


def symbol_names(symbols):
    if not isinstance(symbols, list):
        raise ValueError("document symbols must be a list")
    names = []
    for symbol in symbols:
        if not isinstance(symbol, dict) or not isinstance(symbol.get("name"), str):
            raise ValueError("invalid document symbol")
        names.append(symbol["name"])
        names.extend(symbol_names(symbol.get("children", [])))
    return names


def prove_added_symbol(before, after, expected):
    if expected in symbol_names(before) or expected not in symbol_names(after):
        raise ValueError("added symbol absent after edit or already present before edit")


async def probe(args):
    root = Path(args.workspace).resolve()
    process = await asyncio.create_subprocess_exec(
        args.binary,
        cwd=root,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
    )
    native_process = process._transport.get_extra_info("subprocess") if hasattr(process, "_transport") else None
    messages = []
    budget = {"wire_bytes": 0, "messages": 0}
    drain = None

    async def send(message):
        body = json.dumps(message).encode()
        process.stdin.write(f"Content-Length: {len(body)}\r\n\r\n".encode() + body)
        await process.stdin.drain()

    async def next_message():
        message = await receive(process.stdout, budget)
        messages.append(message)
        if "method" in message and "id" in message:
            if message["method"] in (
                "window/workDoneProgress/create",
                "client/registerCapability",
            ):
                await send({"jsonrpc": "2.0", "id": message["id"], "result": None})
            else:
                await send({
                    "jsonrpc": "2.0", "id": message["id"],
                    "error": {"code": -32601, "message": "unsupported probe request"},
                })
        return message

    timings = {}

    async def request(identifier, method, params):
        started = time.monotonic()
        await send({"jsonrpc": "2.0", "id": identifier, "method": method, "params": params})
        while True:
            message = await next_message()
            if message.get("id") == identifier and "method" not in message:
                timings[method] = (time.monotonic() - started) * 1000
                if "error" in message:
                    raise RuntimeError(message["error"])
                return message["result"]

    try:
        started = time.monotonic()
        cargo_options = {"buildScripts": {"enable": False}, "offline": True}
        if args.target:
            cargo_options["target"] = args.target
        if args.features:
            cargo_options["features"] = args.features
        initialization_options = {
            "cargo": cargo_options, "procMacro": {"enable": False}, "checkOnSave": False,
        }
        if os.environ.get("RUST_SRC_PATH"):
            initialization_options["cargo"]["sysrootSrc"] = os.environ["RUST_SRC_PATH"]
        initialized = await request(1, "initialize", {
            "processId": None,
            "rootUri": root.as_uri(),
            "capabilities": {
                "experimental": {"serverStatusNotification": True},
                "textDocument": {"callHierarchy": {"dynamicRegistration": False}},
                "general": {"positionEncodings": ["utf-16"]},
            },
            "initializationOptions": initialization_options,
        })
        if initialized["capabilities"].get("positionEncoding", "utf-16") != "utf-16":
            raise ValueError("server did not negotiate UTF-16 positions")
        await send({"jsonrpc": "2.0", "method": "initialized", "params": {}})
        while True:
            message = await next_message()
            if message.get("method") == "experimental/serverStatus":
                if message["params"]["quiescent"]:
                    break
        timings["ready"] = (time.monotonic() - started) * 1000
        document = {"uri": (root / args.file).as_uri()}
        source = (root / args.file).read_bytes().decode("utf-8")
        await send({"jsonrpc": "2.0", "method": "textDocument/didOpen", "params": {
            "textDocument": {**document, "languageId": "rust", "version": 1, "text": source},
        }})
        symbols = await request(2, "textDocument/documentSymbol", {"textDocument": document})
        timings["documentSymbolBeforeEdit"] = timings["textDocument/documentSymbol"]
        unknown = await request(3, "workspace/symbol", {"query": "semctx_missing_346"})
        hierarchy = await request(4, "textDocument/prepareCallHierarchy", {
            "textDocument": document,
            "position": {"line": args.line, "character": args.character},
        })
        calls = None
        if hierarchy:
            calls = await request(5, "callHierarchy/outgoingCalls", {"item": hierarchy[0]})
        definition = await request(6, "textDocument/definition", {
            "textDocument": document,
            "position": {"line": args.definition_line, "character": args.definition_character},
        })
        appended = getattr(args, "append_text", "\n")
        changed_started = time.monotonic()
        await send({"jsonrpc": "2.0", "method": "textDocument/didChange", "params": {
            "textDocument": {**document, "version": 2},
            "contentChanges": [newline_change(source, initialized["capabilities"].get("textDocumentSync"), appended)],
        }})
        edited_symbols = await request(8, "textDocument/documentSymbol", {"textDocument": document})
        timings["changeToDocumentSymbol"] = (time.monotonic() - changed_started) * 1000
        timings["documentSymbolAfterEdit"] = timings.pop("textDocument/documentSymbol")
        expected = getattr(args, "expect_added_symbol", None)
        if expected:
            prove_added_symbol(symbols, edited_symbols, expected)
        await request(7, "shutdown", None)
        await send({"jsonrpc": "2.0", "method": "exit"})
        drain = asyncio.create_task(discard_output(process.stdout))
        await process.wait()
        rss = direct_child_rss(native_process)
        return {
            "initialization": initialized, "symbols": symbols, "unknown": unknown,
            "hierarchy": hierarchy, "calls": calls, "definition": definition,
            "editedSymbols": edited_symbols,
            "serverPeakRss": rss,
            "editProof": {
                "addedSymbol": expected,
                "beforeSha256": hashlib.sha256(source.encode("utf-8")).hexdigest(),
                "afterSha256": hashlib.sha256((source + appended).encode("utf-8")).hexdigest(),
                "appendSha256": hashlib.sha256(appended.encode("utf-8")).hexdigest(),
            },
            "timingsMs": timings, "messages": messages, "exitCode": process.returncode,
        }
    finally:
        await cleanup_process(process, drain)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("binary")
    parser.add_argument("workspace")
    parser.add_argument("file")
    parser.add_argument("--line", type=int, default=6)
    parser.add_argument("--character", type=int, default=4)
    parser.add_argument("--definition-line", type=int, default=9)
    parser.add_argument("--definition-character", type=int, default=26)
    parser.add_argument("--timeout", type=float, default=90)
    parser.add_argument("--target")
    parser.add_argument("--features", nargs="*", default=[])
    parser.add_argument("--append-text", default="\n")
    parser.add_argument("--expect-added-symbol")
    args = parser.parse_args()
    result = asyncio.run(asyncio.wait_for(probe(args), timeout=args.timeout))
    print(json.dumps(result, ensure_ascii=True, indent=2))
    if result["exitCode"] != 0:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
