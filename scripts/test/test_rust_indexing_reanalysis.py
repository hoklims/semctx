import copy
import ctypes
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import time
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location(
    "reanalysis", Path(__file__).parents[1] / "rust-indexing-reanalysis.py"
)
reanalysis = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(reanalysis)
UNPACK_SPEC = importlib.util.spec_from_file_location(
    "research_unpack", Path(__file__).parents[1] / "rust-indexing-unpack.py"
)
unpack = importlib.util.module_from_spec(UNPACK_SPEC)
UNPACK_SPEC.loader.exec_module(unpack)


def process_alive(pid):
    if os.name == "nt":
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.OpenProcess.restype = ctypes.c_void_p
        handle = kernel.OpenProcess(0x1000 | 0x100000, False, pid)
        if not handle:
            return False
        try:
            return kernel.WaitForSingleObject(ctypes.c_void_p(handle), 0) == 258
        finally:
            kernel.CloseHandle(ctypes.c_void_p(handle))
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    status = Path(f"/proc/{pid}/stat")
    return not status.exists() or status.read_text().split(")", 1)[1].split()[0] != "Z"


class RunnerCleanupTest(unittest.TestCase):
    @unittest.skipIf(os.name == "nt", "Windows taskkill requires a live parent")
    def test_failed_exit_reaps_owned_descendant_before_refusal(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            record = root / "pids.json"
            runner = reanalysis.Runner({}, root, time.monotonic() + 10)
            try:
                with self.assertRaisesRegex(
                    RuntimeError, "native command failed: command-0000, exit 7"
                ):
                    runner.command(
                        [
                            sys.executable,
                            "-c",
                            "import json,os,subprocess,sys; from pathlib import Path; "
                            "child=subprocess.Popen([sys.executable,'-c','import time; time.sleep(120)'],"
                            "stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL); "
                            f"Path({str(record)!r}).write_text(json.dumps({{'parent':os.getpid(),'child':child.pid,'group':os.getpgrp()}})); "
                            "os.write(1,b'parent-stdout\\n'); os.write(2,b'parent-stderr\\n'); sys.exit(7)",
                        ],
                        root,
                    )
                pids = json.loads(record.read_text())
                self.assertEqual(pids["group"], pids["parent"])
                self.assertNotEqual(pids["group"], os.getpgrp())
                timing = json.loads((root / "command-0000.timing.json").read_text())
                self.assertEqual(timing["exitCode"], 7)
                self.assertEqual(
                    (root / "command-0000.stdout").read_bytes(), b"parent-stdout\n"
                )
                self.assertEqual(
                    (root / "command-0000.stderr").read_bytes(), b"parent-stderr\n"
                )
                deadline = time.monotonic() + 1
                while process_alive(pids["child"]) and time.monotonic() < deadline:
                    time.sleep(0.01)
                print(
                    f"failed-exit owned PIDs: {pids}; child alive: {process_alive(pids['child'])}"
                )
                self.assertFalse(
                    process_alive(pids["child"]),
                    "owned descendant survived failed-exit refusal",
                )
            finally:
                if record.exists():
                    pids = json.loads(record.read_text())
                    if pids["group"] != pids["parent"] or pids["group"] == os.getpgrp():
                        raise RuntimeError("owned fixture process-group mismatch")
                    try:
                        os.killpg(pids["group"], 9)
                    except ProcessLookupError:
                        pass
                    deadline = time.monotonic() + 3
                    while any(process_alive(pids[key]) for key in ("parent", "child")):
                        if time.monotonic() >= deadline:
                            raise RuntimeError(
                                "owned failed-exit fixture cleanup failed"
                            )
                        time.sleep(0.01)
                    print(f"failed-exit fixture PIDs dead: {pids}")

    def test_output_limit_refuses_one_extra_byte_on_either_or_combined_streams(self):
        for out_size, err_size in ((129, 0), (0, 129), (64, 65), (131072, 131072)):
            with self.subTest(stdout=out_size, stderr=err_size):
                with tempfile.TemporaryDirectory() as directory:
                    root = Path(directory)
                    runner = reanalysis.Runner({}, root, time.monotonic() + 10)
                    runner.output_limit = 128
                    with self.assertRaisesRegex(RuntimeError, "output byte limit"):
                        runner.command(
                            [
                                sys.executable,
                                "-c",
                                "import os,time; "
                                # Keep the Windows parent alive through taskkill enumeration.
                                f"os.write(1,b'o'*{out_size}); os.write(2,b'e'*{err_size}); time.sleep(120)",
                            ],
                            root,
                        )
                    captured = [
                        (root / f"command-0000.{stream}").read_bytes()
                        for stream in ("stdout", "stderr")
                    ]
                    self.assertEqual(sum(map(len, captured)), 128)
                    timing = json.loads((root / "command-0000.timing.json").read_text())
                    self.assertEqual(timing["status"], "OUTPUT_LIMIT")
                    self.assertEqual(timing["outputLimitBytes"], 128)
                    self.assertGreaterEqual(timing["elapsedMs"], 0)

    def test_output_limit_accepts_exact_combined_boundary(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            runner = reanalysis.Runner({}, root, time.monotonic() + 10)
            runner.output_limit = 128
            stdout, stderr, _ = runner.command(
                [
                    sys.executable,
                    "-c",
                    "import os; os.write(1,b'o'*64); os.write(2,b'e'*64)",
                ],
                root,
            )
            self.assertEqual((stdout, stderr), (b"o" * 64, b"e" * 64))

    def test_output_limit_requires_positive_integer(self):
        for value in (True, False, 0, -1, 1.5, float("inf"), "128", None):
            with self.subTest(value=value), self.assertRaises(ValueError):
                reanalysis.Runner({}, Path("unused"), 0, output_limit=value)

    def test_output_limit_accepts_empty_streams(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            runner = reanalysis.Runner({}, root, time.monotonic() + 10, output_limit=1)
            self.assertEqual(
                runner.command([sys.executable, "-c", "pass"], root)[:2], (b"", b"")
            )

    def test_output_overflow_reaps_owned_descendants(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            record = root / "pids.json"
            runner = reanalysis.Runner({}, root, time.monotonic() + 10)
            runner.output_limit = 128
            try:
                with self.assertRaisesRegex(RuntimeError, "output byte limit"):
                    runner.command(
                        [
                            sys.executable,
                            "-c",
                            "import json,os,subprocess,sys,time; from pathlib import Path; "
                            "child=subprocess.Popen([sys.executable,'-c','import time; time.sleep(120)']); "
                            f"Path({str(record)!r}).write_text(json.dumps([os.getpid(),child.pid])); "
                            "os.write(2,b'e'*129); time.sleep(120)",
                        ],
                        root,
                    )
                self.assertEqual(
                    sum(
                        (root / f"command-0000.{stream}").stat().st_size
                        for stream in ("stdout", "stderr")
                    ),
                    128,
                )
                timing = json.loads((root / "command-0000.timing.json").read_text())
                self.assertEqual(timing["status"], "OUTPUT_LIMIT")
                pids = json.loads(record.read_text())
                deadline = time.monotonic() + 1
                while (
                    any(process_alive(pid) for pid in pids)
                    and time.monotonic() < deadline
                ):
                    time.sleep(0.01)
                self.assertTrue(all(not process_alive(pid) for pid in pids), pids)
                print(f"overflow owned PIDs dead: {pids}")
            finally:
                if record.exists():
                    pids = json.loads(record.read_text())
                    for pid in pids:
                        if process_alive(pid):
                            os.kill(pid, 9)
                    cleanup_deadline = time.monotonic() + 3
                    while any(process_alive(pid) for pid in pids):
                        if time.monotonic() >= cleanup_deadline:
                            raise RuntimeError(
                                "owned overflow fixture cleanup could not be established"
                            )
                        time.sleep(0.01)

    def test_exited_parent_with_inherited_pipe_handles_obeys_deadline(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            record = root / "child.pid"
            runner = reanalysis.Runner({}, root, time.monotonic() + 1)
            native_popen = subprocess.Popen

            def launch_exited_parent(*args, **kwargs):
                process = native_popen(*args, **kwargs)
                try:
                    # Establish the precondition before Runner observes pipes.
                    # Waiting for exit does not drain the inherited handles.
                    self.assertEqual(process.wait(timeout=3), 0)
                    self.assertIsNotNone(process.poll())
                    print(f"pipe fixture parent exited before drain: {process.pid}")
                    return process
                except BaseException:
                    if process.poll() is None:
                        process.kill()
                        process.wait(timeout=3)
                    process.stdout.close()
                    process.stderr.close()
                    raise

            started = time.monotonic()
            try:
                with (
                    patch.object(
                        reanalysis.subprocess, "Popen", side_effect=launch_exited_parent
                    ),
                    self.assertRaises(subprocess.TimeoutExpired),
                ):
                    runner.command(
                        [
                            sys.executable,
                            "-c",
                            "import subprocess,sys; from pathlib import Path; "
                            "child=subprocess.Popen([sys.executable,'-c','import time; time.sleep(120)']); "
                            f"Path({str(record)!r}).write_text(str(child.pid))",
                        ],
                        root,
                    )
                self.assertLess(
                    time.monotonic() - started, 1 + reanalysis.CLEANUP_TIMEOUT + 2
                )
                if os.name != "nt":
                    pid = int(record.read_text())
                    deadline = time.monotonic() + 1
                    while process_alive(pid) and time.monotonic() < deadline:
                        time.sleep(0.01)
                    self.assertFalse(process_alive(pid))
            finally:
                if record.exists():
                    pid = int(record.read_text())
                    if process_alive(pid):
                        # Windows taskkill cannot enumerate a tree after its
                        # parent exits; the fixture owns this exact descendant.
                        os.kill(pid, 9)
                    deadline = time.monotonic() + 3
                    while process_alive(pid) and time.monotonic() < deadline:
                        time.sleep(0.01)
                    self.assertFalse(
                        process_alive(pid), "owned pipe fixture cleanup failed"
                    )
                    print(f"inherited pipe fixture PID cleaned: {pid}")

    def exercise_timeout(self, real_lsp, minimal_env=False):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            record = root / "pids.json"
            server = root / "server.py"
            server.write_text(
                "import json, os, subprocess, sys, time\n"
                "from pathlib import Path\n"
                "child = subprocess.Popen([sys.executable, '-c', "
                "'import time; time.sleep(120)'], stdout=subprocess.DEVNULL, "
                "stderr=subprocess.DEVNULL)\n"
                f"Path({str(record)!r}).write_text(json.dumps("
                "{'launcher':os.getppid(), 'parent':os.getpid(), 'child':child.pid, "
                "'parentAliveBefore':True, 'childAliveBefore':child.poll() is None}))\n"
                "time.sleep(120)\n",
                encoding="utf-8",
            )
            if real_lsp:
                executable = root / ("server.cmd" if os.name == "nt" else "server")
                executable.write_text(
                    f'@"{sys.executable}" -B "{server}"\n'
                    if os.name == "nt"
                    else f'#!{sys.executable}\nexec(compile(open({str(server)!r}).read(), {str(server)!r}, "exec"))\n',
                    encoding="utf-8",
                )
                executable.chmod(0o700)
                (root / "source.rs").write_text("fn main() {}\n")
                argv = [
                    sys.executable,
                    str(Path(reanalysis.__file__).with_name("rust-indexing-lsp.py")),
                    str(executable),
                    str(root),
                    "source.rs",
                    "--timeout",
                    "120",
                ]
            else:
                argv = [
                    sys.executable,
                    "-c",
                    "import subprocess,sys,time; "
                    f"subprocess.Popen([sys.executable, {str(server)!r}]); time.sleep(120)",
                ]
            runner = reanalysis.Runner({}, root, time.monotonic() + 3)
            try:
                if minimal_env:
                    reduced = {
                        key.upper(): value
                        for key, value in os.environ.items()
                        if key.upper() in {"PATH", "SYSTEMROOT", "TEMP", "TMP"}
                    }
                    # Restore the host environment before fixture cleanup, even
                    # when the native timeout path refuses or the mutant fails.
                    with patch.dict(os.environ, reduced, clear=True):
                        self.assertNotIn("SYSTEMDRIVE", os.environ)
                        with self.assertRaises(subprocess.TimeoutExpired):
                            runner.command(argv, root)
                else:
                    with self.assertRaises(subprocess.TimeoutExpired):
                        runner.command(argv, root)
                pids = json.loads(record.read_text())
                self.assertTrue(pids["parentAliveBefore"])
                self.assertTrue(pids["childAliveBefore"])
                self.assertFalse(
                    process_alive(pids["parent"]),
                    "owned server survived Runner timeout",
                )
                self.assertFalse(
                    process_alive(pids["child"]),
                    "owned descendant survived Runner timeout",
                )
                timing = json.loads((root / "command-0000.timing.json").read_text())
                self.assertEqual(timing["status"], "TIMEOUT")
            finally:
                if record.exists():
                    pids = json.loads(record.read_text())
                    for pid in (pids["launcher"], pids["parent"], pids["child"]):
                        if process_alive(pid):
                            if os.name == "nt":
                                system = ctypes.create_unicode_buffer(32768)
                                size = ctypes.WinDLL("kernel32").GetSystemDirectoryW(
                                    system, len(system)
                                )
                                self.assertTrue(0 < size < len(system))
                                cleanup_env = {
                                    key.upper(): value
                                    for key, value in os.environ.items()
                                }
                                cleanup_env["SYSTEMDRIVE"] = Path(system.value).drive
                                subprocess.run(
                                    [
                                        str(Path(system.value) / "taskkill.exe"),
                                        "/PID",
                                        str(pid),
                                        "/T",
                                        "/F",
                                    ],
                                    check=True,
                                    stdout=subprocess.PIPE,
                                    stderr=subprocess.PIPE,
                                    env=cleanup_env,
                                    timeout=5,
                                )
                            else:
                                os.kill(pid, 9)
                    deadline = time.monotonic() + 3
                    while any(
                        process_alive(pid) for pid in pids.values() if type(pid) is int
                    ):
                        if time.monotonic() >= deadline:
                            raise AssertionError("owned fixture cleanup failed")
                        time.sleep(0.01)

    def test_outer_timeout_reaps_owned_descendants_before_propagation(self):
        self.exercise_timeout(False)

    def test_outer_timeout_reaps_real_lsp_wrapper_server_and_descendant(self):
        self.exercise_timeout(True)

    @unittest.skipUnless(os.name == "nt", "Windows taskkill environment contract")
    def test_outer_timeout_reaps_descendants_without_inherited_systemdrive(self):
        self.exercise_timeout(False, minimal_env=True)

    def test_cleanup_failure_refuses_tree_guarantee_and_still_reaps_direct_child(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            runner = reanalysis.Runner({}, root, time.monotonic() + 1)
            native_popen = subprocess.Popen
            children = []

            def launch_owned_child(*args, **kwargs):
                process = native_popen(*args, **kwargs)
                children.append(process)
                return process

            failure = (
                patch.object(Path, "is_file", return_value=False)
                if os.name == "nt"
                else patch.object(
                    reanalysis.os, "killpg", side_effect=PermissionError("denied")
                )
            )
            with (
                failure,
                patch.object(
                    reanalysis.subprocess, "Popen", side_effect=launch_owned_child
                ),
                self.assertRaises((RuntimeError, subprocess.TimeoutExpired)) as caught,
            ):
                runner.command(
                    [
                        sys.executable,
                        "-c",
                        "import time; time.sleep(120)",
                    ],
                    root,
                )
            self.assertIsInstance(caught.exception, RuntimeError)
            self.assertIn("cleanup could not be established", str(caught.exception))
            timing = json.loads((root / "command-0000.timing.json").read_text())
            self.assertEqual(timing["status"], "CLEANUP_FAILED")
            self.assertIn("cleanup could not be established", timing["cleanupError"])
            self.assertEqual(len(children), 1)
            self.assertFalse(process_alive(children[0].pid))

    def test_success_preserves_native_streams_and_command_provenance(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            runner = reanalysis.Runner({}, root, time.monotonic() + 15)
            argv = [
                sys.executable,
                "-c",
                "import os; os.write(1,b'raw\\x00out'); os.write(2,b'raw\\x00err')",
            ]
            stdout, stderr, observation = runner.command(argv, root)
            self.assertEqual(stdout, b"raw\x00out")
            self.assertEqual(stderr, b"raw\x00err")
            self.assertEqual(observation["exitCode"], 0)
            self.assertEqual(observation["stdoutSha256"], reanalysis.sha(stdout))
            self.assertEqual(observation["stderrSha256"], reanalysis.sha(stderr))
            self.assertEqual(
                json.loads((root / "command-0000.argv.json").read_text()),
                {"argv": argv, "cwd": str(root)},
            )


class DirectoryInputBoundaryTest(unittest.TestCase):
    def make_config(self, root):
        marker = root / "engine-observed-config.txt"
        probe = (
            "from pathlib import Path\n"
            f"Path({str(marker)!r}).write_text(Path('.cargo/config.toml').read_text())\n"
            "raise SystemExit(7)\n"
        )
        worlds = []
        sources = []
        for name, files in (
            ("fixture", ["app/src/main.rs", "a.rs", "b.rs", "c.rs", "d.rs"]),
            ("pico", ["src/lib.rs"]),
        ):
            workspace = root / name
            for relative in files:
                path = workspace / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(probe, encoding="utf-8")
                sources.append(path)
            worlds.append(
                {
                    "name": name,
                    "path": str(workspace),
                    "files": files,
                    "target": files[0],
                }
            )
        required = [
            Path(reanalysis.__file__).resolve(),
            Path(sys.executable).resolve(),
            Path(reanalysis.__file__).with_name("rust-indexing-lsp.py").resolve(),
        ]
        config = {
            "pins": [
                {"path": str(path), "sha256": reanalysis.sha(path.read_bytes())}
                for path in required + sources
            ],
            "Y": {"binary": sys.executable},
            "workspaces": worlds,
        }
        return config, marker

    def link_directory(self, target, link, kind="symlink"):
        if kind == "junction":
            import _winapi

            _winapi.CreateJunction(str(target), str(link))
        else:
            link.symlink_to(target, target_is_directory=True)

    def make_lsp_config(self, root):
        config, marker = self.make_config(root)
        server = root / "server.py"
        server.write_text(
            "import json, os, sys\nfrom pathlib import Path\n"
            "headers = {}\nwhile True:\n"
            "    line = sys.stdin.buffer.readline()\n"
            "    if line == b'\\r\\n': break\n"
            "    key, value = line.decode().split(':', 1)\n"
            "    headers[key.lower()] = value.strip()\n"
            "message = json.loads(sys.stdin.buffer.read(int(headers['content-length'])))\n"
            "selected = message['params']['initializationOptions']['cargo'].get('sysrootSrc')\n"
            f"Path({str(marker)!r}).write_text(json.dumps({{'sysroot': selected, "
            "'source': (Path(selected)/'src/lib.rs').read_text(), 'pid': os.getpid()}))\n"
            "raise SystemExit(7)\n",
            encoding="utf-8",
        )
        executable = root / ("server.cmd" if os.name == "nt" else "server")
        executable.write_text(
            f'@"{sys.executable}" -B "{server}"\n'
            if os.name == "nt"
            else f'#!{sys.executable}\nexec(compile(open({str(server)!r}).read(), {str(server)!r}, "exec"))\n',
            encoding="utf-8",
        )
        executable.chmod(0o700)
        for path in (server, executable):
            config["pins"].append(
                {"path": str(path), "sha256": reanalysis.sha(path.read_bytes())}
            )
        config.update({"python": sys.executable, "L": {"binary": str(executable)}})
        return config, marker

    def test_cli_refuses_ambient_lsp_sysroot_before_engine(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config, marker = self.make_lsp_config(root)
            config_path = root / "config.json"
            reanalysis.save(config_path, config)
            for name in ("first", "second"):
                sysroot = root / name
                (sysroot / "src").mkdir(parents=True)
                (sysroot / "src/lib.rs").write_text(name)
                output = root / (name + "-output")
                env = dict(os.environ, RUST_SRC_PATH=str(sysroot))
                result = subprocess.run(
                    [
                        sys.executable,
                        "-B",
                        reanalysis.__file__,
                        "--config",
                        str(config_path),
                        "--output",
                        str(output),
                        "--engines",
                        "L",
                        "--budget-seconds",
                        "10",
                    ],
                    env=env,
                    capture_output=True,
                    timeout=15,
                    check=False,
                )
                observed = json.loads(marker.read_text()) if marker.exists() else None
                if observed:
                    self.assertFalse(process_alive(observed["pid"]))
                    marker.unlink()
                print(
                    json.dumps(
                        {
                            "hostSysroot": str(sysroot),
                            "configSha256": reanalysis.sha(config_path.read_bytes()),
                            "exit": result.returncode,
                            "engineObserved": observed,
                            "outputExists": output.exists(),
                            "stdout": result.stdout.decode(errors="replace"),
                            "stderr": result.stderr.decode(errors="replace"),
                        }
                    )
                )
                self.assertNotEqual(result.returncode, 0)
                self.assertIsNone(
                    observed, "native L server consumed ambient unpinned sysroot"
                )
                self.assertFalse(output.exists())
                self.assertIn(b"explicit pinned RUST_SRC_PATH", result.stderr)

    def test_cli_requires_complete_explicit_lsp_sysroot_pins(self):
        for mode in ("unpinned", "partial", "complete"):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                config, marker = self.make_lsp_config(root)
                sysroot = root / "sysroot"
                (sysroot / "src").mkdir(parents=True)
                source = sysroot / "src/lib.rs"
                source.write_text("benign-pinned-source")
                extra = sysroot / "src/extra.rs"
                extra.write_text("second-source")
                config["env"] = {"RUST_SRC_PATH": str(sysroot)}
                for path in (
                    ()
                    if mode == "unpinned"
                    else (source,)
                    if mode == "partial"
                    else (source, extra)
                ):
                    config["pins"].append(
                        {"path": str(path), "sha256": reanalysis.sha(path.read_bytes())}
                    )
                config_path = root / "config.json"
                reanalysis.save(config_path, config)
                output = root / "output"
                result = subprocess.run(
                    [
                        sys.executable,
                        "-B",
                        reanalysis.__file__,
                        "--config",
                        str(config_path),
                        "--output",
                        str(output),
                        "--engines",
                        "L",
                        "--budget-seconds",
                        "10",
                    ],
                    capture_output=True,
                    timeout=15,
                    check=False,
                )
                observed = json.loads(marker.read_text()) if marker.exists() else None
                if observed:
                    self.assertFalse(process_alive(observed["pid"]))
                print(
                    json.dumps(
                        {
                            "pinMode": mode,
                            "exit": result.returncode,
                            "engineObserved": observed,
                            "outputExists": output.exists(),
                            "stdout": result.stdout.decode(errors="replace"),
                            "stderr": result.stderr.decode(errors="replace"),
                        }
                    )
                )
                self.assertNotEqual(
                    result.returncode, 0
                )  # The benign server deliberately exits 7.
                if mode == "complete":
                    self.assertIsNotNone(observed)
                    self.assertEqual(observed["source"], "benign-pinned-source")
                    self.assertTrue(output.exists())
                else:
                    self.assertIsNone(
                        observed, "native L server consumed incompletely pinned sysroot"
                    )
                    self.assertFalse(output.exists())
                    self.assertIn(b"L sysroot input", result.stderr)

    def test_cli_refuses_linked_configuration_before_output_copy_or_engine(self):
        kinds = ("symlink", "junction") if os.name == "nt" else ("symlink",)
        for kind in kinds:
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                config, marker = self.make_config(root)
                external = root / "external"
                external.mkdir()
                (external / "config.toml").write_text("benign-external-config\n")
                self.link_directory(external, root / "fixture" / ".cargo", kind)
                if kind == "junction":
                    # os.walk already visits junctions on Windows. Pinning the
                    # target isolates the still-missing link-structure refusal.
                    path = external / "config.toml"
                    config["pins"].append(
                        {"path": str(path), "sha256": reanalysis.sha(path.read_bytes())}
                    )
                config_path = root / "config.json"
                reanalysis.save(config_path, config)
                output = root / "output"
                argv = [
                    sys.executable,
                    "-B",
                    reanalysis.__file__,
                    "--config",
                    str(config_path),
                    "--output",
                    str(output),
                    "--engines",
                    "Y",
                    "--budget-seconds",
                    "10",
                ]
                result = subprocess.run(
                    argv, capture_output=True, timeout=15, check=False
                )
                print(
                    json.dumps(
                        {
                            "linkKind": kind,
                            "externalConfigPinned": kind == "junction",
                            "argv": argv,
                            "exit": result.returncode,
                            "engineObserved": marker.read_text()
                            if marker.exists()
                            else None,
                            "outputExists": output.exists(),
                            "stdout": result.stdout.decode(errors="replace"),
                            "stderr": result.stderr.decode(errors="replace"),
                        }
                    )
                )
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(
                    marker.exists(),
                    "configured native probe consumed linked config before refusal",
                )
                self.assertFalse(
                    output.exists(),
                    "refusal must precede output creation and workspace copy",
                )
                self.assertIn(b"workspace directory link", result.stderr)

    def test_normal_pinned_directories_and_ignored_cache_links_are_accepted(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config, _ = self.make_config(root)
            cargo = root / "fixture" / ".cargo"
            cargo.mkdir()
            path = cargo / "config.toml"
            path.write_text("benign-pinned-config\n")
            config["pins"].append(
                {"path": str(path), "sha256": reanalysis.sha(path.read_bytes())}
            )
            external = root / "external"
            external.mkdir()
            (external / "unmanaged").write_text("ignored\n")
            for name in ("target", "__pycache__", ".git"):
                self.link_directory(external, root / "fixture" / name)
            self.assertEqual(reanalysis.validate_config(config, ["Y"]), config["pins"])


class NativeEvidenceTest(unittest.TestCase):
    def make_destination_archive(self, root, names):
        payload = b"captured input\n"
        digest = reanalysis.sha(payload)
        archive = root / "captured-inputs.zip"
        members = []
        with zipfile.ZipFile(archive, "w") as bundle:
            for name in names:
                path = "Y-pico-1/inputs/" + name
                bundle.writestr(path, payload)
                members.append({"path": path, "sha256": digest, "bytes": len(payload)})
        reanalysis.save(
            root / "result.json",
            {
                "pairs": [
                    {
                        "engine": "Y",
                        "workspace": "pico",
                        "sample": 1,
                        "workspaceInputs": [
                            {"capturePath": name, "sha256": digest} for name in names
                        ],
                    }
                ]
            },
        )
        reanalysis.save(
            root / "CAPTURED-INPUTS.json",
            {
                "archive": {
                    "path": archive.name,
                    "sha256": reanalysis.sha(archive.read_bytes()),
                    "bytes": archive.stat().st_size,
                    "uncompressedBytes": len(payload) * len(names),
                },
                "members": members,
            },
        )

    def assert_destination_refused_without_writes(self, names, existing_ancestor=False):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.make_destination_archive(root, names)
            if existing_ancestor:
                parent = root / "Y-pico-1/inputs/a"
                parent.parent.mkdir(parents=True)
                parent.write_bytes(b"preexisting sentinel")

            def snapshot():
                return {
                    path.relative_to(root).as_posix(): reanalysis.sha(path.read_bytes())
                    if path.is_file()
                    else "directory"
                    for path in root.rglob("*")
                }

            before = snapshot()
            error = None
            try:
                unpack.unpack_inputs(root)
            except (ValueError, OSError) as caught:
                error = caught
            self.assertEqual(
                snapshot(), before, "invalid destination inventory wrote before refusal"
            )
            self.assertIsInstance(
                error, ValueError, "destination preflight must refuse before extraction"
            )

    def test_input_archive_refuses_file_ancestor_collisions_before_any_write(self):
        for names in (("a", "a/b"), ("a/b", "a")):
            with self.subTest(names=names):
                self.assert_destination_refused_without_writes(names)

    def test_input_archive_refuses_portable_windows_aliases_before_any_write(self):
        for names in (
            ("a", "A"),
            ("name", "name."),
            ("name", "name "),
            ("valid.rs", "NUL"),
            ("valid.rs", "NUL.txt"),
            ("valid.rs", "NUL .txt"),
            ("valid.rs", "bad?"),
            ("src/a.rs", "SRC/b.rs"),
        ):
            with self.subTest(names=names):
                self.assert_destination_refused_without_writes(names)

    def test_input_archive_refuses_existing_file_ancestor_before_any_write(self):
        self.assert_destination_refused_without_writes(
            ("valid.rs", "a/b"), existing_ancestor=True
        )

    def make_input_archive(self, root):
        payload = b"fn example() {}\n"
        name = "Y-pico-1/inputs/src/lib.rs"
        archive = root / "captured-inputs.zip"
        with zipfile.ZipFile(archive, "w") as bundle:
            bundle.writestr(name, payload)
        sha = reanalysis.sha(payload)
        reanalysis.save(
            root / "result.json",
            {
                "pairs": [
                    {
                        "engine": "Y",
                        "workspace": "pico",
                        "sample": 1,
                        "workspaceInputs": [
                            {"capturePath": "src/lib.rs", "sha256": sha}
                        ],
                    }
                ]
            },
        )
        manifest = {
            "archive": {
                "path": archive.name,
                "sha256": reanalysis.sha(archive.read_bytes()),
                "bytes": archive.stat().st_size,
                "uncompressedBytes": len(payload),
            },
            "members": [{"path": name, "sha256": sha, "bytes": len(payload)}],
        }
        reanalysis.save(root / "CAPTURED-INPUTS.json", manifest)
        return manifest, name, payload

    def test_input_archive_extracts_verified_bytes_and_refuses_existing_destination(
        self,
    ):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            _, name, payload = self.make_input_archive(root)
            self.assertEqual(
                unpack.unpack_inputs(root), {"members": 1, "bytes": len(payload)}
            )
            self.assertEqual((root / name).read_bytes(), payload)
            with self.assertRaisesRegex(ValueError, "already exists"):
                unpack.unpack_inputs(root)

    def test_input_archive_sha_mismatch_is_refused_before_any_extraction(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest, _, _ = self.make_input_archive(root)
            manifest["archive"]["sha256"] = "0" * 64
            reanalysis.save(root / "CAPTURED-INPUTS.json", manifest)
            with self.assertRaisesRegex(ValueError, "archive SHA-256"):
                unpack.unpack_inputs(root)
            self.assertFalse((root / "Y-pico-1/inputs").exists())

    def test_input_archive_refuses_malformed_or_unknown_members_without_writes(self):
        for kind in ("malformed", "unknown", "symlink", "traversal"):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                manifest, name, payload = self.make_input_archive(root)
                archive = root / "captured-inputs.zip"
                if kind == "malformed":
                    archive.write_bytes(b"not-a-zip")
                else:
                    with zipfile.ZipFile(archive, "w") as bundle:
                        item = zipfile.ZipInfo(name)
                        if kind == "symlink":
                            item.create_system = 3
                            item.external_attr = 0o120777 << 16
                        bundle.writestr(item, payload)
                        if kind in ("unknown", "traversal"):
                            bundle.writestr(
                                "unknown.rs" if kind == "unknown" else "../escape.rs",
                                b"bad",
                            )
                manifest["archive"]["bytes"] = archive.stat().st_size
                manifest["archive"]["sha256"] = reanalysis.sha(archive.read_bytes())
                reanalysis.save(root / "CAPTURED-INPUTS.json", manifest)
                with self.assertRaises(ValueError):
                    unpack.unpack_inputs(root)
                self.assertFalse((root / "Y-pico-1/inputs").exists())

    def test_input_archive_refuses_missing_member_before_creating_inputs(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive = root / "captured-inputs.zip"
            with zipfile.ZipFile(archive, "w"):
                pass
            name = "Y-pico-1/inputs/src/lib.rs"
            expected = reanalysis.sha(b"fn example() {}\n")
            reanalysis.save(
                root / "result.json",
                {
                    "pairs": [
                        {
                            "engine": "Y",
                            "workspace": "pico",
                            "sample": 1,
                            "workspaceInputs": [
                                {"capturePath": "src/lib.rs", "sha256": expected}
                            ],
                        }
                    ]
                },
            )
            reanalysis.save(
                root / "CAPTURED-INPUTS.json",
                {
                    "archive": {
                        "path": archive.name,
                        "sha256": reanalysis.sha(archive.read_bytes()),
                        "bytes": archive.stat().st_size,
                        "uncompressedBytes": 16,
                    },
                    "members": [{"path": name, "sha256": expected, "bytes": 16}],
                },
            )
            with self.assertRaisesRegex(ValueError, "inventory"):
                unpack.unpack_inputs(root)
            self.assertFalse((root / "Y-pico-1/inputs").exists())

    def test_public_reanalysis_series_proves_all_native_postimages_and_portable_custody(
        self,
    ):
        public = (
            Path(__file__).parents[2]
            / "docs/research/rust-indexing/results/reanalysis-windows-2026-10-17"
        )
        result = json.loads((public / "result.json").read_bytes())
        config = json.loads((public / "config.json").read_bytes())
        provenance = json.loads((public / "PROVENANCE.json").read_bytes())
        self.assertEqual(
            provenance["measuredHead"], "1f08463191369097fe15dda1721324a4c7ab4215"
        )
        self.assertEqual(
            provenance["resultSha256"],
            reanalysis.sha((public / "result.json").read_bytes()),
        )
        self.assertEqual(
            provenance["configSha256"],
            reanalysis.sha((public / "config.json").read_bytes()),
        )
        self.assertFalse(provenance["publicationTestIsMeasuredRuntimeInput"])
        helper = provenance["publicationUnpackHelper"]
        self.assertEqual(helper["path"], "scripts/rust-indexing-unpack.py")
        self.assertFalse(helper["measuredRuntimeInput"])
        self.assertEqual(
            helper["sha256"],
            reanalysis.sha((Path(__file__).parents[2] / helper["path"]).read_bytes()),
        )
        for path, digest in provenance["measuredHarnessSha256"].items():
            matching = [
                pin["sha256"]
                for pin in config["pins"]
                if pin["path"].replace("\\", "/").endswith("/" + path)
            ]
            self.assertEqual(matching, [digest], "original measured harness identity")
        self.assertEqual(result["engines"], list("TYSL"))
        self.assertEqual(len(result["pairs"]), 24)
        self.assertEqual(
            {
                (pair["sample"], pair["workspace"], pair["engine"])
                for pair in result["pairs"]
            },
            {
                (sample, workspace, engine)
                for sample in (1, 2, 3)
                for workspace in ("fixture", "pico")
                for engine in "TYSL"
            },
        )
        for pair in result["pairs"]:
            world = next(
                item
                for item in config["workspaces"]
                if item["name"] == pair["workspace"]
            )
            commands = pair["commands"]
            for command in commands:
                self.assertRegex(command["prefix"], r"^command-[0-9]{4}$")

            def native(index, commands=commands):
                return (public / (commands[index]["prefix"] + ".stdout")).read_bytes()

            if pair["engine"] == "T":
                document = next(
                    item
                    for item in json.loads(native(0))["files"]
                    if item["file"] == world["target"]
                )
                before = [item["name"] for item in document["before"]["symbols"]]
                after = [item["name"] for item in document["after"]["symbols"]]
            elif pair["engine"] == "Y":
                target_index = world["files"].index(world["target"])
                before = reanalysis.tsv_symbols(native(target_index))
                after = reanalysis.tsv_symbols(
                    native(len(world["files"]) + target_index)
                )
            elif pair["engine"] == "S":
                self.assertEqual(config["S"]["pathMode"], "windows-diagnostic")
                self.assertEqual(
                    pair["scipPathLimitation"], reanalysis.WINDOWS_SCIP_LIMIT
                )
                before = reanalysis.scip_symbols(
                    json.loads(native(1)), world["target"], config["S"]["pathMode"]
                )
                after = reanalysis.scip_symbols(
                    json.loads(native(3)), world["target"], config["S"]["pathMode"]
                )
            else:
                document = json.loads(native(0))
                before = reanalysis.LSP.symbol_names(document["symbols"])
                after = reanalysis.LSP.symbol_names(document["editedSymbols"])
            label = f"{pair['engine']}/{pair['workspace']}/{pair['sample']}"
            self.assertNotIn(
                reanalysis.SYMBOL, before, label + " baseline must lack probe function"
            )
            self.assertIn(
                reanalysis.SYMBOL,
                after,
                label + " native postimage must contain probe function",
            )

        # Keep native symbol assertions ahead of custody validation, so a stale
        # well-formed postimage is an assertion failure, not a digest ERROR.
        catalogue = json.loads((public / "CATALOG.json").read_bytes())
        for entry in catalogue["files"]:
            self.assertEqual(
                reanalysis.sha(
                    reanalysis.retained_path(public, entry["path"]).read_bytes()
                ),
                entry["sha256"],
                entry["path"],
            )
        logical = catalogue["logicalOriginals"]
        self.assertEqual(len(logical), 607)
        self.assertEqual(len({entry["path"] for entry in logical}), 607)
        physical = {entry["path"]: entry for entry in catalogue["files"]}
        archived = {
            entry["path"]: entry
            for entry in json.loads((public / "CAPTURED-INPUTS.json").read_bytes())[
                "members"
            ]
        }
        self.assertEqual(len(archived), 204)
        for entry in logical:
            storage = entry["storage"]
            if "member" in storage:
                self.assertEqual(
                    storage, {"archive": "captured-inputs.zip", "member": entry["path"]}
                )
                stored = archived[entry["path"]]
            else:
                self.assertEqual(storage, {"file": entry["path"]})
                stored = physical[entry["path"]]
            self.assertEqual(
                (entry["bytes"], entry["sha256"]), (stored["bytes"], stored["sha256"])
            )
        with tempfile.TemporaryDirectory() as directory:
            portable = Path(directory) / "copied-records"
            shutil.copytree(public, portable)
            unpacked = unpack.unpack_inputs(portable)
            self.assertEqual(unpacked["members"], 204)
            read_bytes = Path.read_bytes

            def local_read(path):
                self.assertTrue(
                    path.resolve().is_relative_to(portable.resolve()),
                    "validation attempted an original host/tool read",
                )
                return read_bytes(path)

            with (
                patch.object(Path, "read_bytes", local_read),
                patch.object(
                    reanalysis.Runner,
                    "command",
                    side_effect=AssertionError("validation must not execute engines"),
                ),
            ):
                validation = reanalysis.validate_series(portable)
            self.assertEqual(
                validation,
                {"status": "VALID", "pairs": 24, "states": 48, "engines": list("TYSL")},
            )

    def test_five_file_syn_timings_sum_native_integer_nanoseconds_once(self):
        # Actual parse_ns from commands 0001..0010 of the interrupted
        # reindex382-measurements-8f3afa1 series. These are unit-test inputs,
        # not fresh native executions or a replacement campaign receipt.
        values = [
            347700,
            234600,
            206400,
            316400,
            198200,
            225800,
            217200,
            182100,
            290900,
            194600,
        ]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            original = root / "original"
            files = [
                "app/src/main.rs",
                "domain/src/lib.rs",
                "domain/src/model.rs",
                "domain/src/operations.rs",
                "domain/tests/dispatch.rs",
            ]
            for file in files:
                path = original / file
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(b"fn existing() {}\n")
            output = root / "captures"
            output.mkdir()
            world = {
                "name": "fixture",
                "path": str(original),
                "files": files,
                "target": files[0],
            }
            runner = reanalysis.Runner(
                {"Y": {"binary": "C:/native-syn.exe"}}, output, time.monotonic() + 10
            )

            def capture(argv, cwd):
                index = runner.sequence
                runner.sequence += 1
                name = (
                    reanalysis.SYMBOL
                    if reanalysis.SYMBOL.encode() in Path(argv[1]).read_bytes()
                    else "existing"
                )
                raw = f"symbol\tfn\t{name}\t0\t16\t\n".encode()
                stderr = f"timing\tparse_ns\t{values[index]}\n".encode()
                stem = output / f"command-{index:04d}"
                stem.with_suffix(".stdout").write_bytes(raw)
                stem.with_suffix(".stderr").write_bytes(stderr)
                reanalysis.save(
                    stem.with_suffix(".argv.json"), {"argv": argv, "cwd": str(cwd)}
                )
                observation = {
                    "prefix": stem.name,
                    "exitCode": 0,
                    "elapsedMs": 1,
                    "stdoutSha256": reanalysis.sha(raw),
                    "stderrSha256": reanalysis.sha(stderr),
                    "argvSha256": reanalysis.sha(
                        stem.with_suffix(".argv.json").read_bytes()
                    ),
                }
                reanalysis.save(stem.with_suffix(".timing.json"), observation)
                return raw, stderr, observation

            with patch.object(runner, "command", side_effect=capture):
                pair = runner.pair("Y", world, 1)
            self.assertEqual(
                pair["nativeTimingsMs"],
                {
                    "coldFullParse": sum(values[:5]) / 1_000_000,
                    "editedFullParse": sum(values[5:]) / 1_000_000,
                },
            )
            pair["nativeTimingsMs"]["editedFullParse"] += 0.0001
            with self.assertRaisesRegex(ValueError, "timing projection mismatch"):
                reanalysis.validate_pair(pair, world, output, runner.config)

    def test_captured_manifests_cannot_be_rediscovered_as_replay_inputs(self):
        names = (
            "Cargo.toml.snapshot",
            "app/Cargo.toml.snapshot",
            "domain/Cargo.toml",
            "Cargo.lock",
            "src/lib.rs",
        )
        captured = [reanalysis.capture_path(name) for name in names]
        self.assertEqual(
            captured[:3],
            [
                "Cargo.toml.snapshot.capture",
                "app/Cargo.toml.snapshot.capture",
                "domain/Cargo.toml.capture",
            ],
        )
        self.assertFalse(
            any(
                Path(name).name in ("Cargo.toml", "Cargo.toml.snapshot")
                for name in captured
            )
        )
        self.assertEqual(captured[3:], list(names[3:]))

    def test_symbol_oracle_refuses_stale_and_raw_substring_matches(self):
        for before, after in (
            ([], []),
            ([reanalysis.SYMBOL], [reanalysis.SYMBOL]),
            ([], [reanalysis.SYMBOL + "_other"]),
        ):
            with (
                self.subTest(before=before, after=after),
                self.assertRaisesRegex(ValueError, "added symbol"),
            ):
                reanalysis.require_added(before, after)
        reanalysis.require_added(["existing"], [reanalysis.SYMBOL])

    def test_scip_uses_target_definition_descriptor_not_raw_text(self):
        index = {
            "documents": [
                {
                    "relativePath": "src/lib.rs",
                    "symbols": [
                        {
                            "symbol": "scip-rust cargo pico-args 0.5.0 semctx_reindex_probe()."
                        },
                        {
                            "symbol": "scip-rust cargo pico-args 0.5.0 semctx_reindex_probe_other()."
                        },
                        {
                            "symbol": "scip-rust cargo pico-args 0.5.0 unrelated().",
                            "displayName": reanalysis.SYMBOL,
                        },
                    ],
                    "occurrences": [{"symbol": reanalysis.SYMBOL}],
                }
            ]
        }
        self.assertEqual(
            reanalysis.scip_symbols(index, "src/lib.rs"),
            [reanalysis.SYMBOL, reanalysis.SYMBOL + "_other", "unrelated"],
        )
        with self.assertRaisesRegex(ValueError, "target document"):
            reanalysis.scip_symbols(index, "missing.rs")

    def test_scip_windows_diagnostic_is_explicit_and_preserves_native_paths(self):
        before = {"documents": [{"relativePath": "app\\src\\main.rs", "symbols": []}]}
        after = copy.deepcopy(before)
        after["documents"][0]["symbols"] = [
            {"symbol": "scip-rust cargo fixture 0.1.0 semctx_reindex_probe()."}
        ]
        with self.assertRaisesRegex(ValueError, "nonconforming"):
            reanalysis.scip_symbols(before, "app/src/main.rs")
        reanalysis.require_added(
            reanalysis.scip_symbols(before, "app/src/main.rs", "windows-diagnostic"),
            reanalysis.scip_symbols(after, "app/src/main.rs", "windows-diagnostic"),
        )
        self.assertEqual(after["documents"][0]["relativePath"], "app\\src\\main.rs")

    def test_scip_diagnostic_refuses_colliding_or_unsafe_document_paths(self):
        index = {
            "documents": [
                {"relativePath": "app/src/main.rs"},
                {"relativePath": "app\\src\\main.rs"},
            ]
        }
        with self.assertRaisesRegex(ValueError, "ambiguous"):
            reanalysis.scip_symbols(index, "app/src/main.rs", "windows-diagnostic")
        for path in (
            "",
            "/src/lib.rs",
            "C:/src/lib.rs",
            "C:src/lib.rs",
            "\\\\server\\src\\lib.rs",
            "./src/lib.rs",
            "src/../lib.rs",
            "src//lib.rs",
            "src/./lib.rs",
            "src/",
            "src\\..\\lib.rs",
        ):
            with (
                self.subTest(path=path),
                self.assertRaisesRegex(ValueError, "relative path"),
            ):
                reanalysis.scip_symbols(
                    {"documents": [{"relativePath": path}]},
                    "src/lib.rs",
                    "windows-diagnostic",
                )

    def test_timings_refuse_nan_infinite_negative_boolean_and_missing(self):
        for value in (float("nan"), float("inf"), -1, True, None, "12"):
            with (
                self.subTest(value=value),
                self.assertRaisesRegex(ValueError, "native timing"),
            ):
                reanalysis.finite_duration(value)

    def make_pair(self, directory):
        root = Path(directory)
        workspace = root / "original"
        (workspace / "src").mkdir(parents=True)
        source = b"fn existing() {}\n"
        (workspace / "src/lib.rs").write_bytes(source)
        inputs = root / "Y-pico-1/inputs/src"
        inputs.mkdir(parents=True)
        (inputs / "lib.rs").write_bytes(source)
        (root / "Y-pico-1/target.before.rs").write_bytes(source)
        (root / "Y-pico-1/target.after.rs").write_bytes(
            source + reanalysis.APPEND.encode()
        )
        world = {
            "name": "pico",
            "path": str(workspace),
            "files": ["src/lib.rs"],
            "target": "src/lib.rs",
        }
        pair = {
            "engine": "Y",
            "workspace": "pico",
            "sample": 1,
            "sources": {
                "src/lib.rs": {
                    "beforeSha256": reanalysis.sha(source),
                    "afterSha256": reanalysis.sha(source + reanalysis.APPEND.encode()),
                }
            },
            "appendSha256": reanalysis.sha(reanalysis.APPEND.encode()),
            "commands": [],
            "nativeTimingsMs": {"coldFullParse": 0.001, "editedFullParse": 0.001},
        }
        for number, name in enumerate(("existing", reanalysis.SYMBOL)):
            raw = (
                f"summary\titems\t1\tmethods\t0\nsymbol\tfn\t{name}\t0\t16\t\n".encode()
            )
            stderr = b"timing\tparse_ns\t1000\n"
            stem = root / f"command-{number:04d}"
            stem.with_suffix(".stdout").write_bytes(raw)
            stem.with_suffix(".stderr").write_bytes(stderr)
            reanalysis.save(
                stem.with_suffix(".argv.json"),
                {
                    "argv": ["C:/native-syn.exe", "C:/scratch/src/lib.rs"],
                    "cwd": "C:/scratch",
                },
            )
            command = {
                "prefix": stem.name,
                "exitCode": 0,
                "elapsedMs": 1,
                "stdoutSha256": reanalysis.sha(raw),
                "stderrSha256": reanalysis.sha(stderr),
                "argvSha256": reanalysis.sha(
                    stem.with_suffix(".argv.json").read_bytes()
                ),
            }
            reanalysis.save(stem.with_suffix(".timing.json"), command)
            pair["commands"].append(command)
        return root, world, pair

    def test_retained_command_argv_mutation_is_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            root, world, pair = self.make_pair(directory)
            reanalysis.validate_pair(pair, world, root)
            reanalysis.save(
                root / "command-0001.argv.json",
                {"argv": ["C:/wrong-tool.exe", "different.rs"], "cwd": "C:/scratch"},
            )
            with self.assertRaisesRegex(ValueError, "argv"):
                reanalysis.validate_pair(pair, world, root)

    def test_retained_command_executable_must_match_configured_engine(self):
        with tempfile.TemporaryDirectory() as directory:
            root, world, pair = self.make_pair(directory)
            with self.assertRaisesRegex(ValueError, "executable"):
                reanalysis.validate_pair(
                    pair, world, root, {"Y": {"binary": "C:/different.exe"}}
                )

    def test_retained_native_output_is_reinspected_and_stale_symbol_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            root, world, pair = self.make_pair(directory)
            reanalysis.validate_pair(pair, world, root)
            stem = root / "command-0001"
            raw = (
                stem.with_suffix(".stdout")
                .read_bytes()
                .replace(reanalysis.SYMBOL.encode(), b"stale")
            )
            stem.with_suffix(".stdout").write_bytes(raw)
            pair["commands"][1]["stdoutSha256"] = reanalysis.sha(raw)
            reanalysis.save(stem.with_suffix(".timing.json"), pair["commands"][1])
            with self.assertRaisesRegex(ValueError, "added symbol"):
                reanalysis.validate_pair(pair, world, root)

    def test_retained_input_hash_and_failed_command_are_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            root, world, pair = self.make_pair(directory)
            wrong = copy.deepcopy(pair)
            wrong["sources"]["src/lib.rs"]["afterSha256"] = "0" * 64
            with self.assertRaisesRegex(ValueError, "source hash"):
                reanalysis.validate_pair(wrong, world, root)
            pair["commands"][1]["exitCode"] = 9
            reanalysis.save(root / "command-0001.timing.json", pair["commands"][1])
            with self.assertRaisesRegex(ValueError, "command observation"):
                reanalysis.validate_pair(pair, world, root)

    def test_series_refuses_missing_or_duplicate_sample_without_engine_execution(self):
        with tempfile.TemporaryDirectory() as directory:
            root, world, pair = self.make_pair(directory)
            fixture = {
                "name": "fixture",
                "target": "app/src/main.rs",
                "files": ["a.rs", "b.rs", "c.rs", "d.rs", "e.rs"],
            }
            config = {"workspaces": [fixture, world]}
            reanalysis.save(root / "config.json", config)
            result = {
                "status": "COMPLETE",
                "engines": ["Y"],
                "pairs": [pair],
                "configSha256": reanalysis.sha((root / "config.json").read_bytes()),
            }
            reanalysis.save(root / "result.json", result)
            with (
                self.assertRaisesRegex(ValueError, "coverage mismatch"),
            ):
                reanalysis.validate_series(root)

    def test_retained_paths_refuse_absolute_traversal_and_symlink_escape(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for path in (str(root / "file"), "../outside"):
                with (
                    self.subTest(path=path),
                    self.assertRaisesRegex(ValueError, "relative"),
                ):
                    reanalysis.retained_path(root, path)
            with (
                patch.object(Path, "is_symlink", return_value=True),
                self.assertRaisesRegex(ValueError, "symlinks"),
            ):
                reanalysis.retained_path(root, "linked/file")

    def test_native_windows_psapi_retains_real_child_peak_after_exit(self):
        if os.name != "nt":
            self.skipTest("PSAPI is Windows-only")
        with subprocess.Popen(
            [sys.executable, "-c", "data=bytearray(32*1024*1024); print(len(data))"],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        ) as process:
            stdout, stderr = process.communicate(timeout=15)
            self.assertEqual(process.returncode, 0, stderr)
            self.assertEqual(stdout.strip(), b"33554432")
            measurement = reanalysis.LSP.direct_child_rss(process)
            self.assertIsInstance(measurement["peakRssBytes"], int, measurement)
            self.assertGreater(measurement["peakRssBytes"], 0)


if __name__ == "__main__":
    unittest.main()
