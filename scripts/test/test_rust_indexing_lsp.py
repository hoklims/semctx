import asyncio
import importlib.util
import io
import json
import tempfile
import sys
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

spec = importlib.util.spec_from_file_location(
    "rust_indexing_lsp", Path(__file__).parents[1] / "rust-indexing-lsp.py"
)
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


class LspTransportTest(unittest.IsolatedAsyncioTestCase):
    async def test_refuses_unsupported_or_duplicate_charset(self):
        accepted = []
        for content_type in (
            b"application/vscode-jsonrpc; charset=utf-16",
            b"application/vscode-jsonrpc; charset=iso-8859-1",
            b"application/vscode-jsonrpc; charset*=utf-8''utf-16",
            b"application/vscode-jsonrpc; charset=utf-8; charset=utf8",
            b"application/vscode-jsonrpc; charset=utf-8\r\nContent-Type: application/vscode-jsonrpc",
        ):
            reader = asyncio.StreamReader()
            reader.feed_data(b"Content-Length: 2\r\nContent-Type: " + content_type + b"\r\n\r\n{}")
            reader.feed_eof()
            try:
                await probe.receive(reader)
            except ValueError:
                pass
            else:
                accepted.append(content_type)
        self.assertEqual(accepted, [], "LSP charset must identify UTF-8 unambiguously")

    async def test_refuses_nonfinite_json_constants(self):
        accepted = []
        for constant in (b"NaN", b"Infinity", b"-Infinity", b"1e400", b"-1e400"):
            body = b'{"result":' + constant + b'}'
            reader = asyncio.StreamReader()
            reader.feed_data(f"Content-Length: {len(body)}\r\n\r\n".encode() + body)
            reader.feed_eof()
            try:
                await probe.receive(reader)
            except ValueError:
                pass
            else:
                accepted.append(constant)
        self.assertEqual(accepted, [], "LSP bodies must contain valid JSON numeric constants")

    async def test_utf8_charset_aliases_and_finite_json_preserve_next_frame(self):
        reader = asyncio.StreamReader()
        values = [0, 1.5, "é🦀", {}, 1e20, "NaN", "Infinity"]
        charsets = (None, "UTF-8", "utf8", '"uTf-8"', None, "UTF-8", "utf8")
        for charset, value in zip(charsets, values, strict=True):
            body = json.dumps({"result": value}, ensure_ascii=False).encode("utf-8")
            header = f"Content-Length: {len(body)}\r\n"
            if charset:
                header += f"Content-Type: application/vscode-jsonrpc; charset={charset}\r\n"
            reader.feed_data(header.encode("ascii") + b"\r\n" + body)
        for value in values:
            self.assertEqual(await probe.receive(reader), {"result": value})

    async def test_refuses_utf16_and_utf32_json_bodies(self):
        accepted = []
        source = json.dumps({"result": "é🦀"}, ensure_ascii=False)
        for encoding, bom in (("utf-16-le", b"\xff\xfe"), ("utf-16-be", b"\xfe\xff"),
                              ("utf-32-le", b"\xff\xfe\x00\x00"),
                              ("utf-32-be", b"\x00\x00\xfe\xff")):
            for prefix in (b"", bom):
                reader = asyncio.StreamReader()
                body = prefix + source.encode(encoding)
                reader.feed_data(f"Content-Length: {len(body)}\r\n\r\n".encode() + body)
                reader.feed_eof()
                try:
                    await probe.receive(reader)
                except (UnicodeDecodeError, json.JSONDecodeError):
                    pass
                else:
                    accepted.append((encoding, bool(prefix)))
        self.assertEqual(accepted, [], "LSP JSON bodies must use UTF-8, without encoding autodetection")

    async def test_refuses_oversized_advertisement_before_reading_body(self):
        class HeaderOnlyReader(asyncio.StreamReader):
            async def readexactly(self, size):
                self.assert_body_not_requested(size)
                return await super().readexactly(size)

            def assert_body_not_requested(self, size):
                if size > 1:
                    raise AssertionError("oversized body was requested before refusal")

        reader = HeaderOnlyReader()
        reader.feed_data(b"Content-Length: 4194305\r\n\r\n")
        with self.assertRaisesRegex(ValueError, "frame byte limit"):
            await probe.receive(reader)

    async def test_accepts_exact_frame_byte_limit(self):
        reader = asyncio.StreamReader()
        body = b'"' + b"x" * (4 * 1024 * 1024 - 2) + b'"'
        reader.feed_data(f"Content-Length: {len(body)}\r\n\r\n".encode() + body)
        self.assertEqual(await probe.receive(reader), "x" * (len(body) - 2))

    async def test_refuses_invalid_or_duplicate_lengths(self):
        for fields in (b"Content-Length: -1", b"Content-Length: nope",
                       b"Content-Length: 2\r\ncontent-length: 2"):
            with self.subTest(fields=fields):
                reader = asyncio.StreamReader()
                reader.feed_data(fields + b"\r\n\r\n{}")
                reader.feed_eof()
                error = None
                try:
                    await probe.receive(reader)
                except Exception as caught:
                    error = caught
                self.assertIsInstance(error, ValueError, "invalid framing must be refused explicitly")
                self.assertIn("Content-Length", str(error))

    async def test_refuses_header_over_byte_limit(self):
        reader = asyncio.StreamReader()
        reader.feed_data(b"X: " + b"x" * 8192 + b"\r\nContent-Length: 2\r\n\r\n{}")
        with self.assertRaisesRegex(ValueError, "header byte limit"):
            await probe.receive(reader)

    async def assert_probe_refuses_notifications(self, frames, overrides, reason):
        reader = asyncio.StreamReader()
        reader.feed_data(frames)
        reader.feed_eof()
        process = SimpleNamespace(
            stdin=SimpleNamespace(write=Mock(), drain=AsyncMock(), close=Mock()),
            stdout=reader, returncode=None, kill=Mock(),
        )

        async def wait():
            process.returncode = -1

        process.wait = AsyncMock(side_effect=wait)
        with tempfile.TemporaryDirectory() as directory:
            args = SimpleNamespace(binary="diagnostic-server", workspace=directory,
                                   target=None, features=[])
            with patch.object(probe.asyncio, "create_subprocess_exec", AsyncMock(return_value=process)), \
                    patch.multiple(probe, create=True, **overrides):
                error = None
                try:
                    await probe.probe(args)
                except Exception as caught:
                    error = caught
        self.assertIsInstance(error, ValueError, "probe must refuse the output budget explicitly")
        self.assertIn(reason, str(error))
        process.kill.assert_called_once_with()
        process.wait.assert_awaited_once_with()

    async def test_probe_bounds_cumulative_wire_bytes_and_cleans_up(self):
        frame = b'Content-Length: 14\r\n\r\n{"method":"n"}'
        await self.assert_probe_refuses_notifications(
            frame * 4, {"MAX_WIRE_BYTES": len(frame) * 2}, "wire byte limit",
        )

    async def test_probe_bounds_message_count_and_cleans_up(self):
        frame = b'Content-Length: 14\r\n\r\n{"method":"n"}'
        await self.assert_probe_refuses_notifications(
            frame * 4, {"MAX_MESSAGES": 2}, "message count limit",
        )

    async def exercise_edit(self, appended=None, expected=None, edited_symbols=None, check_payload=True):
        responses = [
            {"id": 1, "result": {"capabilities": {"textDocumentSync": {"change": 2}}}},
            {"method": "experimental/serverStatus", "params": {"quiescent": True}},
            *({"id": identifier, "result": []} for identifier in (2, 3, 4, 6)),
            {"id": 8, "result": edited_symbols or []},
            {"id": 7, "result": None},
        ]
        reader = asyncio.StreamReader()
        for message in responses:
            body = json.dumps(message).encode()
            reader.feed_data(f"Content-Length: {len(body)}\r\n\r\n".encode() + body)
        reader.feed_eof()
        frames = []
        process = SimpleNamespace(
            stdin=SimpleNamespace(write=frames.append, drain=AsyncMock(), close=Mock()),
            stdout=reader,
            returncode=None,
            kill=Mock(),
        )

        async def wait():
            process.returncode = 0

        process.wait = wait
        with tempfile.TemporaryDirectory() as directory:
            Path(directory, "source.rs").write_text("fn f() {}\n// 🦀", encoding="utf-8")
            args = SimpleNamespace(
                binary="diagnostic-server", workspace=directory, file="source.rs",
                target=None, features=[], line=0, character=0,
                definition_line=0, definition_character=0,
            )
            if appended is not None:
                args.append_text = appended
                args.expect_added_symbol = expected
            with patch.object(probe.asyncio, "create_subprocess_exec", AsyncMock(return_value=process)):
                result = await probe.probe(args)
        messages = [json.loads(frame.split(b"\r\n\r\n", 1)[1]) for frame in frames]
        edit = next(message for message in messages if message.get("method") == "textDocument/didChange")
        if check_payload:
            self.assertEqual(edit["params"]["contentChanges"], [{
                "range": {"start": {"line": 1, "character": 5}, "end": {"line": 1, "character": 5}},
                "text": appended if appended is not None else "\n",
            }])
        process.kill.assert_not_called()
        return result

    async def test_probe_sends_negotiated_incremental_edit(self):
        await self.exercise_edit()

    async def test_custom_append_is_sent_and_structured_symbol_is_proven(self):
        appended = "\npub fn semctx_reindex_probe() -> usize { 17 }\n"
        result = await self.exercise_edit(appended, "semctx_reindex_probe", [
            {"name": "container", "children": [{"name": "semctx_reindex_probe"}]},
        ])
        self.assertEqual(result["editProof"]["addedSymbol"], "semctx_reindex_probe")
        self.assertNotEqual(result["editProof"]["beforeSha256"], result["editProof"]["afterSha256"])
        self.assertGreaterEqual(result["timingsMs"]["changeToDocumentSymbol"], 0)

    async def test_stale_symbols_refuse_custom_append(self):
        with self.assertRaisesRegex(ValueError, "added symbol"):
            await self.exercise_edit("\nfn semctx_reindex_probe() {}\n", "semctx_reindex_probe", [
                {"name": "stale", "detail": "semctx_reindex_probe"},
            ], check_payload=False)

    async def test_reads_utf8_bytes_and_preserves_next_message(self):
        reader = asyncio.StreamReader()
        body = json.dumps({"result": "é🦀"}, ensure_ascii=False).encode()
        frame = f"Content-Length: {len(body)}\r\n\r\n".encode() + body
        reader.feed_data(frame + b"Content-Length: 2\r\n\r\n{}")
        self.assertEqual(await probe.receive(reader), {"result": "é🦀"})
        self.assertEqual(await probe.receive(reader), {})

    async def test_truncated_body_is_an_error(self):
        reader = asyncio.StreamReader()
        reader.feed_data(b"Content-Length: 12\r\n\r\n{}")
        reader.feed_eof()
        with self.assertRaises(asyncio.IncompleteReadError):
            await probe.receive(reader)

    async def test_corrupt_body_is_an_error(self):
        reader = asyncio.StreamReader()
        reader.feed_data(b"Content-Length: 1\r\n\r\nx")
        with self.assertRaises(json.JSONDecodeError):
            await probe.receive(reader)


LIFECYCLE_SERVER = r"""
import json, sys, time
mode = sys.argv[1]
def send(message):
    body = json.dumps(message).encode()
    sys.stdout.buffer.write(f"Content-Length: {len(body)}\r\n\r\n".encode() + body)
    sys.stdout.buffer.flush()
if mode == "refusal":
    sys.stdout.buffer.write(b"Content-Length: 4194305\r\n\r\n" + b"x" * 1048576)
    sys.stdout.buffer.flush()
    time.sleep(60)
while True:
    length = None
    while True:
        line = sys.stdin.buffer.readline()
        if not line:
            sys.exit(0)
        if line == b"\r\n":
            break
        if line.lower().startswith(b"content-length:"):
            length = int(line.split(b":", 1)[1])
    message = json.loads(sys.stdin.buffer.read(length))
    method = message.get("method")
    if method == "exit":
        if mode != "quiet":
            sys.stdout.buffer.write(b"x" * 1048576)
            sys.stdout.buffer.flush()
        if mode == "stall":
            time.sleep(60)
        sys.exit(0)
    if "id" in message:
        result = {"capabilities": {"textDocumentSync": 2}} if method == "initialize" else []
        send({"id": message["id"], "result": result})
        if method == "initialize":
            send({"method": "experimental/serverStatus", "params": {"quiescent": True}})
"""


class LspProcessLifecycleTest(unittest.IsolatedAsyncioTestCase):
    async def run_server(self, mode, expected_error=None):
        create = asyncio.create_subprocess_exec
        children = []

        async def factory(*_args, **kwargs):
            child = await create(sys.executable, "-u", "-c", LIFECYCLE_SERVER, mode, **kwargs)
            children.append(child)
            return child

        with tempfile.TemporaryDirectory() as directory:
            Path(directory, "source.rs").write_text("fn f() {}", encoding="utf-8")
            args = SimpleNamespace(binary="owned-test-server", workspace=directory, file="source.rs",
                                   target=None, features=[], line=0, character=0,
                                   definition_line=0, definition_character=0)
            with patch.object(probe.asyncio, "create_subprocess_exec", factory):
                task = asyncio.create_task(asyncio.wait_for(probe.probe(args), timeout=2))
                done, _ = await asyncio.wait({task}, timeout=4)
                completed = bool(done)
                # Watchdog releases only the owned child's pipe; a regression is
                # an assertion failure rather than a test-runner timeout.
                if not completed:
                    for child in children:
                        if child.returncode is None:
                            child.kill()
                        while await child.stdout.read(65536):
                            pass
                    task.cancel()
                outcome = (await asyncio.gather(task, return_exceptions=True))[0]
                for child in children:
                    child.stdin.close()
                await asyncio.sleep(0)
        self.assertTrue(completed, "LSP direct-child cleanup exceeded its bounded deadline")
        self.assertTrue(children, "the regression must execute a real OS child")
        self.assertIsNotNone(children[0].returncode, "owned direct child must be reaped")
        if expected_error:
            self.assertIsInstance(outcome, expected_error)
        else:
            self.assertIsInstance(outcome, dict)
            self.assertEqual(outcome["exitCode"], 0)
            if sys.platform == "win32":
                self.assertIsInstance(outcome["serverPeakRss"]["peakRssBytes"], int, outcome["serverPeakRss"])
                self.assertGreater(outcome["serverPeakRss"]["peakRssBytes"], 0)

    async def test_real_exit_flood_is_drained(self):
        await self.run_server("flood")

    async def test_real_timeout_flood_cleanup_is_bounded(self):
        await self.run_server("stall", TimeoutError)

    async def test_real_refusal_flood_cleanup_is_bounded(self):
        await self.run_server("refusal", ValueError)

    async def test_real_quiet_server_exit_is_preserved(self):
        await self.run_server("quiet")


class LspEditTest(unittest.TestCase):
    def test_incremental_eof_handles_empty_trailing_newline_and_crlf(self):
        for source, line, character in [("", 0, 0), ("x\n", 1, 0), ("x\r\n🦀", 1, 2)]:
            with self.subTest(source=source):
                end = {"line": line, "character": character}
                self.assertEqual(probe.newline_change(source, 2), {
                    "range": {"start": end, "end": end}, "text": "\n",
                })

    def test_full_sync_preserves_the_whole_source(self):
        self.assertEqual(probe.newline_change("🦀\r\n", {"change": 1}), {"text": "🦀\r\n\n"})

    def test_absent_or_disabled_sync_refuses_edit(self):
        for sync in (None, 0, {}, {"change": 0}, 9):
            with self.subTest(sync=sync), self.assertRaisesRegex(ValueError, "document changes"):
                probe.newline_change("fn f() {}", sync)

    def run_main(self, exit_code):
        output = io.StringIO()
        with patch.object(probe, "probe", AsyncMock(return_value={"exitCode": exit_code})), \
                patch("sys.argv", ["rust-indexing-lsp.py", "server", ".", "source.rs"]), \
                redirect_stdout(output):
            if exit_code:
                with self.assertRaises(SystemExit) as error:
                    probe.main()
                self.assertEqual(error.exception.code, 1)
            else:
                self.assertIsNone(probe.main())
        self.assertEqual(json.loads(output.getvalue())["exitCode"], exit_code)

    def test_cli_preserves_diagnostics_and_refuses_server_failure(self):
        self.run_main(23)

    def test_cli_accepts_clean_server_exit(self):
        self.run_main(0)

    def test_cli_serializes_unicode_on_ascii_stdout(self):
        buffer = io.BytesIO()
        output = io.TextIOWrapper(buffer, encoding="ascii", write_through=True)
        result = {"exitCode": 0, "symbol": "é🦀"}
        with patch.object(probe, "probe", AsyncMock(return_value=result)), \
                patch("sys.argv", ["rust-indexing-lsp.py", "server", ".", "source.rs"]), \
                redirect_stdout(output):
            try:
                probe.main()
            except UnicodeEncodeError:
                self.fail("diagnostic JSON must preserve Unicode on a legacy stdout encoding")
        self.assertEqual(json.loads(buffer.getvalue().decode("utf-8")), result)


if __name__ == "__main__":
    unittest.main()
