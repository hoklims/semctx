from __future__ import annotations

import argparse
import os
import subprocess
import sys
from pathlib import Path
from typing import Any


def background_python(python: Path, *, platform: str | None = None) -> Path:
    if (platform or os.name) != "nt":
        return python
    pythonw = python.with_name("pythonw.exe")
    return pythonw if pythonw.is_file() else python


def open_child_log(path: Path):
    if os.name != "nt":
        return path.open("w", encoding="utf-8", newline="\n")
    import ctypes
    import msvcrt

    generic_write = 0x40000000
    share_read = 0x00000001
    share_write = 0x00000002
    share_delete = 0x00000004
    create_always = 2
    normal_attribute = 0x00000080
    create_file = ctypes.windll.kernel32.CreateFileW
    create_file.argtypes = [
        ctypes.c_wchar_p,
        ctypes.c_uint32,
        ctypes.c_uint32,
        ctypes.c_void_p,
        ctypes.c_uint32,
        ctypes.c_uint32,
        ctypes.c_void_p,
    ]
    create_file.restype = ctypes.c_void_p
    handle = create_file(
        str(path),
        generic_write,
        share_read | share_write | share_delete,
        None,
        create_always,
        normal_attribute,
        None,
    )
    invalid_handle = ctypes.c_void_p(-1).value
    if handle == invalid_handle:
        raise OSError(ctypes.get_last_error(), f"Cannot open child log: {path}")
    descriptor = msvcrt.open_osfhandle(handle, os.O_WRONLY)
    return os.fdopen(descriptor, "w", encoding="utf-8", newline="\n")


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description="Launch index-control work without inherited hook handles.")
    result.add_argument("--python", required=True)
    result.add_argument("--controller")
    result.add_argument("--program")
    result.add_argument("--mode", choices=("hook", "worker"), default="hook")
    result.add_argument("--host", choices=("codex", "claude"))
    result.add_argument("--root", required=True)
    result.add_argument("--stderr-log", required=True)
    return result


def main() -> int:
    args = parser().parse_args()
    python = Path(args.python).resolve()
    program_value = args.program or args.controller
    if not program_value:
        print("A controller or program is required.", file=sys.stderr)
        return 2
    program = Path(program_value).resolve()
    root = Path(args.root).resolve()
    stderr_log = Path(args.stderr_log).resolve()
    if not python.is_file() or not program.is_file() or not root.is_dir():
        print("Python, program, or root is unavailable.", file=sys.stderr)
        return 2
    stderr_log.parent.mkdir(parents=True, exist_ok=True)
    if args.mode == "worker":
        command = [str(background_python(python)), str(program), "worker", "--root", str(root)]
    else:
        if not args.host:
            print("--host is required in hook mode.", file=sys.stderr)
            return 2
        command = [
            str(background_python(python)),
            str(program),
            "hook",
            "--host",
            args.host,
            "--root",
            str(root),
            "--format",
            "json",
        ]
    options: dict[str, Any] = {
        "cwd": root,
        "stdin": subprocess.DEVNULL,
        "stdout": subprocess.DEVNULL,
        "close_fds": True,
    }
    if os.name == "nt":
        startup = subprocess.STARTUPINFO()
        startup.dwFlags |= subprocess.STARTF_USESHOWWINDOW
        startup.wShowWindow = subprocess.SW_HIDE
        options["creationflags"] = (
            subprocess.CREATE_NEW_PROCESS_GROUP
            | subprocess.CREATE_NO_WINDOW
            | subprocess.DETACHED_PROCESS
        )
        options["startupinfo"] = startup
    else:
        options["start_new_session"] = True
    try:
        with open_child_log(stderr_log) as stderr_stream:
            subprocess.Popen(command, stderr=stderr_stream, **options)
    except OSError as error:
        print(f"Detached launch failed: {error}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
