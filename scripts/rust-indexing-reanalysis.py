"""Explicitly pinned research reanalysis; never a Semctx product benchmark.

Config: pins [{path, sha256}], env {allowlisted key: value}, python, node,
T {runtime, wasm, grammar}, Y {binary}, S {binary, decoder, config}, L {binary},
workspaces [{name, path, files, target, lsp_args: []}]. Paths must be absolute.
Provide fixture (five files, app/src/main.rs) and pico (one file, src/lib.rs).
Only copies under the new output directory are modified. No downloads/builds.
"""

import argparse
import importlib.util
import hashlib
import json
import math
import os
import re
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path

APPEND = "\npub fn semctx_reindex_probe() -> usize { 17 }\n"
SYMBOL = "semctx_reindex_probe"
CLEANUP_TIMEOUT = 5.0
OUTPUT_LIMIT = 64 * 1024 * 1024
WINDOWS_SCIP_LIMIT = "NONCONFORMING_WINDOWS_SCIP_PATHS: diagnostic matching only; native SCIP remains non-portable, without conformance or production admission."
ENV_KEYS = {
    "PATH",
    "PATHEXT",
    "SYSTEMROOT",
    "WINDIR",
    "TEMP",
    "TMP",
    "COMSPEC",
    "HOME",
    "USERPROFILE",
    "LOCALAPPDATA",
    "APPDATA",
    "RUSTUP_HOME",
    "CARGO_HOME",
    "RUSTUP_TOOLCHAIN",
    "RUST_SRC_PATH",
    "CARGO_NET_OFFLINE",
}
LSP_SPEC = importlib.util.spec_from_file_location(
    "research_lsp", Path(__file__).with_name("rust-indexing-lsp.py")
)
LSP = importlib.util.module_from_spec(LSP_SPEC)
LSP_SPEC.loader.exec_module(LSP)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def save(path, value):
    path.write_text(
        json.dumps(value, ensure_ascii=True, indent=2) + "\n", encoding="utf-8"
    )


def finite_duration(value):
    if (
        isinstance(value, bool)
        or not isinstance(value, (int, float))
        or not math.isfinite(value)
        or value < 0
    ):
        raise ValueError("invalid native timing")
    return value


def require_added(before, after):
    if SYMBOL in before or SYMBOL not in after:
        raise ValueError(
            "added symbol absent after reanalysis or already present before"
        )


def tsv_symbols(stdout):
    names = []
    for line in stdout.decode("utf-8").splitlines():
        fields = line.split("\t")
        if fields[0] == "symbol":
            if len(fields) != 6 or not fields[3].isdigit() or not fields[4].isdigit():
                raise ValueError("invalid native symbol TSV")
            if fields[1] == "fn":
                names.append(fields[2])
    return names


def native_parse_ns(stderr):
    matches = re.findall(rb"(?m)^timing\tparse_ns\t([0-9]+)\r?$", stderr)
    if len(matches) != 1:
        raise ValueError("missing or invalid syn parse timing")
    return int(matches[0])


def scip_document_path(value, path_mode):
    if path_mode not in ("strict-posix", "windows-diagnostic"):
        raise ValueError("invalid SCIP path mode")
    if not isinstance(value, str) or not value or "\x00" in value:
        raise ValueError("invalid SCIP relative path")
    if "\\" in value and path_mode != "windows-diagnostic":
        raise ValueError("nonconforming SCIP path separator")
    matched = value.replace("\\", "/") if path_mode == "windows-diagnostic" else value
    if (
        matched.startswith("/")
        or re.match(r"^[A-Za-z]:", matched)
        or any(part in ("", ".", "..") for part in matched.split("/"))
    ):
        raise ValueError("invalid SCIP relative path")
    return matched


def scip_symbols(index, target, path_mode="strict-posix"):
    documents = index.get("documents")
    if not isinstance(documents, list):
        raise ValueError("SCIP documents must be a list")
    paths = [
        scip_document_path(doc.get("relativePath"), path_mode) for doc in documents
    ]
    if len(paths) != len(set(paths)):
        raise ValueError("ambiguous SCIP document paths")
    target = scip_document_path(target, "strict-posix")
    matched = [
        doc for doc, path in zip(documents, paths, strict=True) if path == target
    ]
    if len(matched) != 1:
        raise ValueError("SCIP target document missing or duplicated")
    names = []
    for item in matched[0].get("symbols", []):
        # SCIP term descriptor for this simple ASCII top-level Rust function.
        # Inspect symbol definitions, never raw JSON text or reference occurrences.
        symbol = item.get("symbol", "")
        match = re.search(r"(?:^|[/#. ])([A-Za-z_][A-Za-z_0-9]*)\(\)\.$", symbol)
        if match:
            names.append(match.group(1))
    return names


def checked_source(root, relative):
    if Path(relative).is_absolute() or ".." in Path(relative).parts:
        raise ValueError("source path must be relative without traversal")
    path = (root / relative).resolve()
    if (
        not path.is_relative_to(root.resolve())
        or not path.is_file()
        or path.suffix != ".rs"
    ):
        raise ValueError("source must be a regular Rust file inside workspace")
    return path


def retained_path(root, relative):
    relative = Path(relative)
    if relative.is_absolute() or ".." in relative.parts:
        raise ValueError("retained path must be relative without traversal")
    path = root
    for part in relative.parts:
        path = path / part
        if path.is_symlink():
            raise ValueError("retained path must not contain symlinks")
    if not path.resolve().is_relative_to(root.resolve()):
        raise ValueError("retained path escapes result root")
    return path


def source_pin(config, world, file):
    # Host paths identify pins; validation never opens these external paths.
    identity = (world["path"].replace("\\", "/").rstrip("/") + "/" + file).casefold()
    matches = [
        p["sha256"]
        for p in config["pins"]
        if p["path"].replace("\\", "/").casefold() == identity
    ]
    if len(matches) != 1:
        raise ValueError("selected source pin missing or duplicated")
    return matches[0]


def capture_path(relative):
    path = Path(relative)
    return path.as_posix() + (
        ".capture" if path.name in ("Cargo.toml", "Cargo.toml.snapshot") else ""
    )


def validate_pair(result, world, output, config=None):
    """Reinspect original native output, not a copied success flag."""
    engine = result["engine"]
    expected_sources = {}
    folder = f"{engine}-{world['name']}-{result['sample']}"
    for file in world["files"]:
        source = retained_path(output, Path(folder, "inputs", file)).read_bytes()
        expected_sources[file] = {
            "beforeSha256": sha(source),
            "afterSha256": sha(
                source + (APPEND.encode() if file == world["target"] else b"")
            ),
        }
    if result["sources"] != expected_sources or result["appendSha256"] != sha(
        APPEND.encode()
    ):
        raise ValueError("pair input source hash mismatch")
    for item in result.get("workspaceInputs", []):
        if item["capturePath"] != capture_path(item["path"]):
            raise ValueError("invalid workspace capture mapping")
        if (
            sha(
                retained_path(
                    output, Path(folder, "inputs", item["capturePath"])
                ).read_bytes()
            )
            != item["sha256"]
        ):
            raise ValueError("workspace input digest mismatch")
    for state in ("before", "after"):
        raw = retained_path(output, Path(folder, f"target.{state}.rs")).read_bytes()
        if sha(raw) != expected_sources[world["target"]][f"{state}Sha256"]:
            raise ValueError("retained target image digest mismatch")
    commands = result["commands"]
    if len(commands) != {"T": 1, "Y": 2 * len(world["files"]), "S": 4, "L": 1}[engine]:
        raise ValueError("native command count mismatch")
    outputs = []
    invocations = []
    for position, command in enumerate(commands):
        prefix = command["prefix"]
        if not re.fullmatch(r"command-[0-9]{4}", prefix):
            raise ValueError("invalid native command identity")
        if (
            json.loads(retained_path(output, prefix + ".timing.json").read_bytes())
            != command
            or command["exitCode"] != 0
        ):
            raise ValueError("native command observation mismatch")
        finite_duration(command["elapsedMs"])
        argv_raw = retained_path(output, prefix + ".argv.json").read_bytes()
        if sha(argv_raw) != command["argvSha256"]:
            raise ValueError("native argv digest mismatch")
        invocation = json.loads(argv_raw)
        argv = invocation["argv"]
        if (
            not isinstance(argv, list)
            or not argv
            or not all(isinstance(arg, str) for arg in argv)
            or not isinstance(invocation["cwd"], str)
        ):
            raise ValueError("invalid native argv capture")
        if config is not None:
            executable = {
                "T": config.get("node"),
                "Y": config.get("Y", {}).get("binary"),
                "S": config.get("S", {}).get("binary")
                if position % 2 == 0
                else config.get("node"),
                "L": config.get("python"),
            }[engine]
            if (
                not isinstance(executable, str)
                or argv[0].replace("\\", "/").casefold()
                != executable.replace("\\", "/").casefold()
            ):
                raise ValueError("native executable differs from configured engine")
        invocations.append(invocation)
        raw, stderr = (
            retained_path(output, prefix + ".stdout").read_bytes(),
            retained_path(output, prefix + ".stderr").read_bytes(),
        )
        if (
            sha(raw) != command["stdoutSha256"]
            or sha(stderr) != command["stderrSha256"]
        ):
            raise ValueError("native output digest mismatch")
        outputs.append((raw, stderr))
    if engine == "T":
        capture = result["adapterInput"]
        if capture["path"] != f"{folder}/adapter.json":
            raise ValueError("invalid native adapter capture path")
        adapter_raw = retained_path(output, capture["path"]).read_bytes()
        if sha(adapter_raw) != capture["sha256"]:
            raise ValueError("native adapter input digest mismatch")
        adapter = json.loads(adapter_raw)
        referenced_adapter = (
            invocations[0]["cwd"].replace("\\", "/").rsplit("/", 1)[0] + "/adapter.json"
        )
        if (
            len(invocations[0]["argv"]) != 3
            or invocations[0]["argv"][2].replace("\\", "/").casefold()
            != referenced_adapter.casefold()
        ):
            raise ValueError("native argv does not reference captured adapter input")
        if (
            adapter["files"] != world["files"]
            or adapter["target"] != world["target"]
            or adapter["append"] != APPEND
            or adapter["workspace"] != invocations[0]["cwd"]
        ):
            raise ValueError("native adapter input profile mismatch")
        if config is not None and any(
            adapter[key] != value for key, value in config["T"].items()
        ):
            raise ValueError("native adapter tool profile mismatch")
        native = json.loads(outputs[0][0])
        if len(native["files"]) != len(expected_sources) or {
            row["file"] for row in native["files"]
        } != set(expected_sources):
            raise ValueError("native parser file inventory mismatch")
        for row in native["files"]:
            if {
                key: row[key] for key in ("beforeSha256", "afterSha256")
            } != expected_sources[row["file"]]:
                raise ValueError("native parser source hash mismatch")
        row = next(row for row in native["files"] if row["file"] == world["target"])
        require_added(
            [s["name"] for s in row["before"]["symbols"]],
            [s["name"] for s in row["after"]["symbols"]],
        )
        timings = native["timingsMs"]
        if set(timings) != {"coldParse", "incrementalParse"}:
            raise ValueError("native parser timings missing")
    elif engine == "Y":
        count = len(world["files"])
        offset = world["files"].index(world["target"])
        require_added(
            tsv_symbols(outputs[offset][0]), tsv_symbols(outputs[count + offset][0])
        )
        parsed = []
        for raw, stderr in outputs:
            tsv_symbols(raw)
            parsed.append(native_parse_ns(stderr))
        timings = {
            "coldFullParse": finite_duration(sum(parsed[:count]) / 1_000_000),
            "editedFullParse": finite_duration(sum(parsed[count:]) / 1_000_000),
        }
    elif engine == "S":
        path_mode = (
            config["S"].get("pathMode", "strict-posix") if config else "strict-posix"
        )
        limitation = WINDOWS_SCIP_LIMIT if path_mode == "windows-diagnostic" else None
        if (
            result["scipPathMode"] != path_mode
            or result["scipPathLimitation"] != limitation
        ):
            raise ValueError("SCIP path mode or limitation mismatch")
        require_added(
            scip_symbols(json.loads(outputs[1][0]), world["target"], path_mode),
            scip_symbols(json.loads(outputs[3][0]), world["target"], path_mode),
        )
        if [a["path"].replace("\\", "/") for a in result["artifacts"]] != [
            f"{folder}/before.scip",
            f"{folder}/after.scip",
        ]:
            raise ValueError("SCIP artifact inventory mismatch")
        for artifact in result["artifacts"]:
            path = retained_path(output, artifact["path"])
            if (
                not path.resolve().is_relative_to(output.resolve())
                or sha(path.read_bytes()) != artifact["sha256"]
            ):
                raise ValueError("SCIP artifact digest mismatch")
        timings = None
    else:
        native = json.loads(outputs[0][0])
        proof = native["editProof"]
        if (
            native["exitCode"] != 0
            or proof["addedSymbol"] != SYMBOL
            or proof["appendSha256"] != sha(APPEND.encode())
        ):
            raise ValueError("LSP edit provenance mismatch")
        if any(
            proof[key] != value
            for key, value in expected_sources[world["target"]].items()
        ):
            raise ValueError("LSP input source hash mismatch")
        LSP.prove_added_symbol(native["symbols"], native["editedSymbols"], SYMBOL)
        timings = native["timingsMs"]
        if not {"ready", "documentSymbolAfterEdit", "changeToDocumentSymbol"} <= set(
            timings
        ):
            raise ValueError("LSP native timings missing")
    if timings is not None:
        for value in timings.values():
            finite_duration(value)
        if timings != result["nativeTimingsMs"]:
            raise ValueError("native timing projection mismatch")


def validate_series(output):
    config_path = retained_path(output, "config.json")
    config = json.loads(config_path.read_bytes())
    result = json.loads(retained_path(output, "result.json").read_bytes())
    engines = result["engines"]
    if (
        "S" in engines
        and config["S"].get("pathMode", "strict-posix") == "windows-diagnostic"
        and WINDOWS_SCIP_LIMIT not in result["limitations"]
    ):
        raise ValueError("missing nonconforming Windows SCIP limitation")
    if not engines or len(set(engines)) != len(engines) or set(engines) - set("TYSL"):
        raise ValueError("invalid engine inventory")
    worlds = config["workspaces"]
    if [w["name"] for w in worlds] != ["fixture", "pico"] or [
        len(w["files"]) for w in worlds
    ] != [5, 1]:
        raise ValueError("invalid workspace inventory")
    if [w["target"] for w in worlds] != ["app/src/main.rs", "src/lib.rs"] or any(
        len(set(w["files"])) != len(w["files"]) for w in worlds
    ):
        raise ValueError("invalid target or selected-file inventory")
    if (
        result["configSha256"] != sha(config_path.read_bytes())
        or result["status"] != "COMPLETE"
    ):
        raise ValueError("series incomplete or configuration digest mismatch")
    expected = [
        (sample, world["name"], engine)
        for sample in range(1, 4)
        for world in config["workspaces"]
        for engine in engines
    ]
    if [
        (row["sample"], row["workspace"], row["engine"]) for row in result["pairs"]
    ] != expected:
        raise ValueError("series sample, workspace or engine coverage mismatch")
    commands = []
    for pair in result["pairs"]:
        world = next(w for w in config["workspaces"] if w["name"] == pair["workspace"])
        validate_pair(pair, world, output, config)
        prefix = world["path"].replace("\\", "/").rstrip("/") + "/"
        declared = {
            pin["path"].replace("\\", "/")[len(prefix) :]: pin["sha256"]
            for pin in config["pins"]
            if pin["path"].replace("\\", "/").startswith(prefix)
        }
        if {
            item["path"]: item["sha256"] for item in pair["workspaceInputs"]
        } != declared:
            raise ValueError("workspace input inventory differs from declared pins")
        for file in world["files"]:
            if pair["sources"][file]["beforeSha256"] != source_pin(config, world, file):
                raise ValueError("retained source differs from declared input pin")
        for item in pair["workspaceInputs"]:
            if item["sha256"] != source_pin(config, world, item["path"]):
                raise ValueError("workspace input differs from declared pin")
        commands.extend(command["prefix"] for command in pair["commands"])
    if len(commands) != len(set(commands)):
        raise ValueError("native command reused across pairs")
    return {
        "status": "VALID",
        "pairs": len(expected),
        "states": len(expected) * 2,
        "engines": engines,
    }


def validate_config(config, engines):
    if "S" in engines and config["S"].get("pathMode", "strict-posix") not in (
        "strict-posix",
        "windows-diagnostic",
    ):
        raise ValueError("invalid SCIP path mode")
    pins = config.get("pins", [])
    if not pins or len({str(Path(p["path"]).resolve()) for p in pins}) != len(pins):
        raise ValueError("pins must be nonempty and unique")
    pinned = set()
    for pin in pins:
        path = Path(pin["path"])
        if not path.is_absolute() or sha(path.read_bytes()) != pin["sha256"]:
            raise ValueError("input pin mismatch")
        pinned.add(path.resolve())
    required = [
        Path(__file__).resolve(),
        Path(sys.executable),
        Path(__file__).with_name("rust-indexing-lsp.py"),
    ]
    for engine in engines:
        required.extend(
            Path(config[engine][key])
            for key in {
                "T": ("runtime", "wasm", "grammar"),
                "Y": ("binary",),
                "S": ("binary", "decoder", "config"),
                "L": ("binary",),
            }[engine]
        )
    if "T" in engines:
        required += [Path(config["node"]), Path(__file__).with_suffix(".mjs")]
    if "S" in engines:
        required += [Path(config["node"])]
    if "L" in engines:
        required += [
            Path(config["python"]),
            Path(__file__).with_name("rust-indexing-lsp.py"),
        ]
    if any(not p.is_absolute() or p.resolve() not in pinned for p in required):
        raise ValueError("required executable, adapter or configuration is not pinned")
    if set(config.get("env", {})) - ENV_KEYS:
        raise ValueError("environment contains non-allowlisted keys")
    if "L" in engines:
        sysroot = config.get("env", {}).get("RUST_SRC_PATH")
        if (
            not isinstance(sysroot, str)
            or not sysroot
            or not Path(sysroot).is_absolute()
            or not Path(sysroot).is_dir()
        ):
            raise ValueError("L requires an explicit pinned RUST_SRC_PATH directory")
        root = Path(sysroot)
        for directory, folders, files in os.walk(root):
            for path in (
                Path(directory),
                *(Path(directory, name) for name in folders + files),
            ):
                if path.is_symlink() or getattr(path.lstat(), "st_reparse_tag", 0):
                    raise ValueError("L sysroot input must not be a link")
                if not path.is_dir() and (
                    not path.is_file() or path.resolve() not in pinned
                ):
                    raise ValueError("L sysroot input is not a pinned regular file")
    worlds = config["workspaces"]
    if [w["name"] for w in worlds] != ["fixture", "pico"]:
        raise ValueError("expected fixture and pico workspaces in that order")
    for world, count, target in zip(
        worlds, (5, 1), ("app/src/main.rs", "src/lib.rs"), strict=True
    ):
        if (
            len(world["files"]) != count
            or len(set(world["files"])) != count
            or world["target"] != target
        ):
            raise ValueError("unexpected normal-file selection or edit target")
        if target not in world["files"] or not Path(world["path"]).is_absolute():
            raise ValueError(
                "target must belong to selected files in an absolute workspace"
            )
        for file in world["files"]:
            checked_source(Path(world["path"]), file).read_bytes().decode("utf-8")
        for directory, folders, files in os.walk(world["path"]):
            folders[:] = [
                name
                for name in folders
                if name not in ("target", "__pycache__", ".git")
            ]
            for name in folders:
                path = Path(directory, name)
                if path.is_symlink() or getattr(path.lstat(), "st_reparse_tag", 0):
                    raise ValueError("workspace directory link is not permitted")
            for name in files:
                path = Path(directory, name)
                if path.name == "Cargo.toml":
                    raise ValueError(
                        "research input manifests must retain Cargo.toml.snapshot names"
                    )
                if path.is_symlink() or path.resolve() not in pinned:
                    raise ValueError("workspace input is a symlink or is not pinned")
    return pins


def stop_command_tree(process):
    """Stop cooperative, non-detached descendants before propagating a refusal.

    This research supervisor is not an isolation boundary. On Windows taskkill
    requires the owned parent to remain alive until tree enumeration.
    """
    deadline = time.monotonic() + CLEANUP_TIMEOUT
    try:
        if os.name == "nt":
            import ctypes

            buffer = ctypes.create_unicode_buffer(32768)
            kernel = ctypes.WinDLL("kernel32", use_last_error=True)
            size = kernel.GetSystemDirectoryW(buffer, len(buffer))
            if not 0 < size < len(buffer):
                raise RuntimeError("cannot resolve Windows system directory")
            taskkill = Path(buffer.value) / "taskkill.exe"
            if not taskkill.is_file():
                raise RuntimeError("Windows system taskkill is unavailable")
            cleanup_env = {key.upper(): value for key, value in os.environ.items()}
            # taskkill can stall when a reduced caller omits SystemDrive. Derive
            # it from the native system directory, not an inherited spelling.
            cleanup_env["SYSTEMDRIVE"] = Path(buffer.value).drive
            result = subprocess.run(
                [str(taskkill), "/PID", str(process.pid), "/T", "/F"],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                timeout=max(0.001, deadline - time.monotonic()),
                env=cleanup_env,
                check=False,
            )
            if result.returncode:
                raise RuntimeError(
                    f"owned process-tree cleanup failed: taskkill exit {result.returncode}"
                )
        else:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass  # The owned process group has already exited.
        process.wait(timeout=max(0.001, deadline - time.monotonic()))
    except (OSError, RuntimeError, subprocess.TimeoutExpired) as error:
        # Bound the direct child as well, but do not claim tree cleanup succeeded.
        try:
            if process.poll() is None:
                process.kill()
                process.wait(timeout=max(0.001, deadline - time.monotonic()))
        except (OSError, subprocess.TimeoutExpired) as fallback_error:
            raise RuntimeError(
                f"owned process-tree cleanup failed ({error}); direct-child fallback failed: {fallback_error}"
            ) from fallback_error
        raise RuntimeError(
            f"owned process-tree cleanup could not be established: {error}"
        ) from error


class OutputLimitError(RuntimeError):
    pass


def available_output(pipe, maximum):
    """Read a bounded ready chunk, None while pending, or b'' at EOF.

    Only this supervisor reads the pipes. PeekNamedPipe avoids blocking reads
    on Windows Python 3.11, which cannot set anonymous pipes nonblocking.
    """
    if os.name == "nt":
        import ctypes
        import msvcrt
        from ctypes import wintypes

        available = wintypes.DWORD()
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        peek = kernel.PeekNamedPipe
        peek.argtypes = [
            wintypes.HANDLE,
            ctypes.c_void_p,
            wintypes.DWORD,
            ctypes.c_void_p,
            ctypes.POINTER(wintypes.DWORD),
            ctypes.c_void_p,
        ]
        peek.restype = wintypes.BOOL
        if not peek(
            msvcrt.get_osfhandle(pipe.fileno()),
            None,
            0,
            None,
            ctypes.byref(available),
            None,
        ):
            error = ctypes.get_last_error()
            if error == 109:  # ERROR_BROKEN_PIPE: every writer closed its handle.
                return b""
            raise ctypes.WinError(error)
        if not available.value:
            return None
        maximum = min(maximum, available.value)
    else:
        import select

        if not select.select([pipe], [], [], 0)[0]:
            return None
    return os.read(pipe.fileno(), maximum)


class Runner:
    def __init__(self, config, output, deadline, output_limit=OUTPUT_LIMIT):
        if type(output_limit) is not int or output_limit <= 0:
            raise ValueError("output byte limit must be a positive integer")
        self.output_limit = output_limit
        self.config, self.output, self.deadline = config, output, deadline
        self.env = {
            key.upper(): value
            for key, value in os.environ.items()
            if key.upper() in ENV_KEYS
        }
        self.env.update(config.get("env", {}))
        self.env["CARGO_NET_OFFLINE"] = "true"
        self.sequence = 0

    def command(self, argv, cwd):
        remaining = self.deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("research budget exhausted")
        prefix = self.output / f"command-{self.sequence:04d}"
        self.sequence += 1
        save(
            prefix.with_suffix(".argv.json"),
            {"argv": [str(v) for v in argv], "cwd": str(cwd)},
        )
        started = time.monotonic()
        with (
            prefix.with_suffix(".stdout").open("wb") as stdout,
            prefix.with_suffix(".stderr").open("wb") as stderr,
        ):
            try:
                process = subprocess.Popen(
                    argv,
                    cwd=cwd,
                    env=self.env,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    bufsize=0,
                    start_new_session=os.name != "nt",
                )
                try:
                    try:
                        pipes = {process.stdout: stdout, process.stderr: stderr}
                        retained = 0
                        while pipes or process.poll() is None:
                            if time.monotonic() >= self.deadline:
                                raise subprocess.TimeoutExpired(argv, remaining)
                            progressed = False
                            for pipe, destination in list(pipes.items()):
                                chunk = available_output(
                                    pipe,
                                    min(64 * 1024, self.output_limit - retained + 1),
                                )
                                if chunk is None:
                                    continue
                                progressed = True
                                if not chunk:
                                    del pipes[pipe]
                                    continue
                                accepted = chunk[: self.output_limit - retained]
                                destination.write(accepted)
                                retained += len(accepted)
                                if len(accepted) != len(chunk):
                                    raise OutputLimitError(
                                        "native command output byte limit exceeded"
                                    )
                            if not progressed:
                                time.sleep(
                                    min(0.005, max(0, self.deadline - time.monotonic()))
                                )
                        process.wait(
                            timeout=max(0.001, self.deadline - time.monotonic())
                        )
                    except BaseException:
                        if os.name != "nt" or process.poll() is None:
                            stop_command_tree(process)
                        raise
                    if process.returncode != 0 and os.name != "nt":
                        stop_command_tree(process)
                    rss = LSP.direct_child_rss(process)
                    exit_code = process.returncode
                finally:
                    process.stdout.close()
                    process.stderr.close()
                    if process.poll() is None:
                        try:
                            process.kill()
                            process.wait(timeout=CLEANUP_TIMEOUT)
                        except (OSError, subprocess.TimeoutExpired) as error:
                            raise RuntimeError(
                                f"owned direct-child cleanup failed: {error}"
                            ) from error
            except (subprocess.TimeoutExpired, RuntimeError) as error:
                save(
                    prefix.with_suffix(".timing.json"),
                    {
                        "status": "TIMEOUT"
                        if isinstance(error, subprocess.TimeoutExpired)
                        else "OUTPUT_LIMIT"
                        if isinstance(error, OutputLimitError)
                        else "CLEANUP_FAILED",
                        "elapsedMs": (time.monotonic() - started) * 1000,
                        **(
                            {"cleanupError": str(error)}
                            if isinstance(error, RuntimeError)
                            and not isinstance(error, OutputLimitError)
                            else {}
                        ),
                        **(
                            {"outputLimitBytes": self.output_limit}
                            if isinstance(error, OutputLimitError)
                            else {}
                        ),
                    },
                )
                raise
        duration = finite_duration((time.monotonic() - started) * 1000)
        raw = prefix.with_suffix(".stdout").read_bytes()
        errors = prefix.with_suffix(".stderr").read_bytes()
        observation = {
            "prefix": prefix.name,
            "exitCode": exit_code,
            "elapsedMs": duration,
            "stdoutSha256": sha(raw),
            "stderrSha256": sha(errors),
            "argvSha256": sha(prefix.with_suffix(".argv.json").read_bytes()),
            "directChildPeakRss": rss,
            "rssLimit": "PSAPI direct-process peak only; descendants are not aggregated.",
        }
        save(prefix.with_suffix(".timing.json"), observation)
        if exit_code != 0:
            raise RuntimeError(
                f"native command failed: {prefix.name}, exit {exit_code}"
            )
        return raw, errors, observation

    def pair(self, engine, world, sample):
        folder = self.output / f"{engine}-{world['name']}-{sample}"
        workspace = folder / "workspace"
        shutil.copytree(
            world["path"],
            workspace,
            ignore=shutil.ignore_patterns("target", "__pycache__", ".git"),
        )
        workspace_inputs = []
        for path in sorted(workspace.rglob("*")):
            if path.is_file():
                relative = path.relative_to(workspace).as_posix()
                captured = capture_path(relative)
                destination = folder / "inputs" / captured
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(path, destination)
                workspace_inputs.append(
                    {
                        "path": relative,
                        "capturePath": captured,
                        "sha256": sha(path.read_bytes()),
                    }
                )
        if any((folder / "inputs").rglob("Cargo.toml.snapshot")) or any(
            (folder / "inputs").rglob("Cargo.toml")
        ):
            raise ValueError("capture must not create discoverable Cargo manifests")
        for snapshot in sorted(workspace.rglob("Cargo.toml.snapshot")):
            if snapshot.with_name("Cargo.toml").exists():
                raise ValueError("materialization would overwrite Cargo.toml")
            snapshot.rename(snapshot.with_name("Cargo.toml"))
        baseline = {
            file: checked_source(workspace, file).read_bytes()
            for file in world["files"]
        }
        for file, data in baseline.items():
            path = folder / "inputs" / file
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
        target = checked_source(workspace, world["target"])
        before = baseline[world["target"]]
        after = before + APPEND.encode("utf-8")
        (folder / "target.before.rs").write_bytes(before)
        (folder / "target.after.rs").write_bytes(after)
        sources = {
            file: {
                "beforeSha256": sha(data),
                "afterSha256": sha(after if file == world["target"] else data),
            }
            for file, data in baseline.items()
        }
        result = {
            "engine": engine,
            "workspace": world["name"],
            "sample": sample,
            "sources": sources,
            "appendSha256": sha(APPEND.encode()),
            "commands": [],
            "workspaceInputs": workspace_inputs,
        }
        if engine == "T":
            adapter = {
                **self.config["T"],
                "workspace": str(workspace),
                "files": world["files"],
                "target": world["target"],
                "append": APPEND,
            }
            save(folder / "adapter.json", adapter)
            result["adapterInput"] = {
                "path": f"{folder.name}/adapter.json",
                "sha256": sha((folder / "adapter.json").read_bytes()),
            }
            raw, _, command = self.command(
                [
                    self.config["node"],
                    str(Path(__file__).with_suffix(".mjs")),
                    str(folder / "adapter.json"),
                ],
                workspace,
            )
            native = json.loads(raw)
            if len(native["files"]) != len(baseline) or {
                row["file"] for row in native["files"]
            } != set(baseline):
                raise ValueError("native parser file inventory mismatch")
            for row in native["files"]:
                if any(
                    row[key] != value for key, value in sources[row["file"]].items()
                ):
                    raise ValueError("native parser source hash mismatch")
            record = next(
                row for row in native["files"] if row["file"] == world["target"]
            )
            require_added(
                [s["name"] for s in record["before"]["symbols"]],
                [s["name"] for s in record["after"]["symbols"]],
            )
            result["nativeTimingsMs"] = {
                k: finite_duration(v) for k, v in native["timingsMs"].items()
            }
            result["commands"].append(command)
        elif engine == "Y":
            symbols, native_times = [], []
            for state in ("before", "after"):
                if state == "after":
                    target.write_bytes(after)
                state_symbols, parse_ns = [], 0
                for file in world["files"]:
                    raw, errors, command = self.command(
                        [
                            self.config["Y"]["binary"],
                            str(checked_source(workspace, file)),
                        ],
                        workspace,
                    )
                    result["commands"].append(command)
                    parse_ns += native_parse_ns(errors)
                    if file == world["target"]:
                        state_symbols = tsv_symbols(raw)
                symbols.append(state_symbols)
                native_times.append(finite_duration(parse_ns / 1_000_000))
            require_added(*symbols)
            result["nativeTimingsMs"] = dict(
                zip(("coldFullParse", "editedFullParse"), native_times, strict=True)
            )
        elif engine == "S":
            symbols = []
            path_mode = self.config["S"].get("pathMode", "strict-posix")
            result["scipPathMode"] = path_mode
            result["scipPathLimitation"] = (
                WINDOWS_SCIP_LIMIT if path_mode == "windows-diagnostic" else None
            )
            result["artifacts"] = []
            for state in ("before", "after"):
                if state == "after":
                    target.write_bytes(after)
                artifact = folder / f"{state}.scip"
                _, _, command = self.command(
                    [
                        self.config["S"]["binary"],
                        "scip",
                        str(workspace),
                        "--output",
                        str(artifact),
                        "--num-threads",
                        "4",
                        "--config-path",
                        self.config["S"]["config"],
                    ],
                    workspace,
                )
                result["commands"].append(command)
                if not artifact.is_file() or not artifact.stat().st_size:
                    raise ValueError("SCIP artifact missing or empty")
                result["artifacts"].append(
                    {
                        "path": str(artifact.relative_to(self.output)),
                        "sha256": sha(artifact.read_bytes()),
                    }
                )
                raw, _, decode = self.command(
                    [self.config["node"], self.config["S"]["decoder"], str(artifact)],
                    workspace,
                )
                result["commands"].append(decode)
                symbols.append(
                    scip_symbols(json.loads(raw), world["target"], path_mode)
                )
            require_added(*symbols)
        else:
            raw, _, command = self.command(
                [
                    self.config["python"],
                    str(Path(__file__).with_name("rust-indexing-lsp.py")),
                    self.config["L"]["binary"],
                    str(workspace),
                    world["target"],
                    "--timeout",
                    str(max(0.001, self.deadline - time.monotonic())),
                    "--append-text",
                    APPEND,
                    "--expect-added-symbol",
                    SYMBOL,
                    *world.get("lsp_args", []),
                ],
                workspace,
            )
            native = json.loads(raw)
            proof = native["editProof"]
            if (
                native["exitCode"] != 0
                or proof["addedSymbol"] != SYMBOL
                or any(proof[k] != v for k, v in sources[world["target"]].items())
            ):
                raise ValueError("LSP edit provenance mismatch")
            result["nativeTimingsMs"] = {
                k: finite_duration(v) for k, v in native["timingsMs"].items()
            }
            result["commands"].append(command)
        expected = after if engine in ("Y", "S") else before
        if target.read_bytes() != expected or any(
            checked_source(workspace, file).read_bytes() != data
            for file, data in baseline.items()
            if file != world["target"]
        ):
            raise ValueError("unexpected source mutation during measurement")
        save(folder / "pair.json", result)
        validate_pair(result, world, self.output, self.config)
        return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument(
        "--validate",
        type=Path,
        help="Reinspect retained native outputs without running engines",
    )
    parser.add_argument(
        "--engines", nargs="+", choices=list("TYSL"), default=list("TYSL")
    )
    parser.add_argument("--samples", type=int, choices=[3], default=3)
    parser.add_argument("--budget-seconds", type=float, default=600)
    args = parser.parse_args()
    if args.validate:
        if args.config or args.output:
            parser.error("--validate cannot be combined with --config or --output")
        print(json.dumps(validate_series(args.validate.resolve()), ensure_ascii=True))
        return
    if args.config is None or args.output is None:
        parser.error("--config and --output are required for measurement")
    finite_duration(args.budget_seconds)
    if args.budget_seconds == 0 or len(set(args.engines)) != len(args.engines):
        raise ValueError("positive budget and unique engines required")
    config = json.loads(args.config.read_text(encoding="utf-8"))
    pins = validate_config(config, args.engines)
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    shutil.copyfile(args.config, output / "config.json")
    started = time.monotonic()
    result = {
        "status": "INCOMPLETE",
        "pairs": [],
        "engines": args.engines,
        "configSha256": sha(args.config.read_bytes()),
        "pins": pins,
        "limitations": [
            "Research engine reanalysis only; no Semctx product reindex claim or ranking.",
            "Cold means no previous engine index in fresh scratch; OS caches are not flushed.",
            "T/Y parse exactly selected files. S/L additionally load the Cargo workspace and configured sysroot.",
            "T old-tree incremental parse; Y separate full parses; S two full batch processes; L one persistent server per pair.",
            "PSAPI direct-child peak working set, no descendant aggregation. L also reports its server peak separately.",
            "Native parse time and process wall time are distinct.",
        ],
    }
    runner = Runner(config, output, started + args.budget_seconds)
    if (
        "S" in args.engines
        and config["S"].get("pathMode", "strict-posix") == "windows-diagnostic"
    ):
        result["limitations"].append(WINDOWS_SCIP_LIMIT)
    try:
        for sample in range(1, args.samples + 1):
            for world in config["workspaces"]:
                for engine in args.engines:
                    validate_config(config, args.engines)
                    result["pairs"].append(runner.pair(engine, world, sample))
                    save(output / "result.json", result)
        validate_config(config, args.engines)
        result["status"] = "COMPLETE"
        if time.monotonic() > runner.deadline:
            raise TimeoutError("research budget exhausted before final validation")
        save(output / "result.json", result)
        validate_series(output)
    except Exception as error:
        result["status"] = "INCOMPLETE"
        result["failure"] = {"type": type(error).__name__, "message": str(error)}
        raise
    finally:
        result["elapsedMs"] = (time.monotonic() - started) * 1000
        save(output / "result.json", result)


if __name__ == "__main__":
    main()
