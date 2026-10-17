"""Unpack archived research inputs in an explicitly copied capture directory.

This publication utility is not part of the measured A3 runtime.
"""

import argparse
import hashlib
import io
import json
import re
import stat
import zipfile
from pathlib import Path

MAX_BYTES = 64 * 1024 * 1024
MAX_MEMBERS = 1000


def destination(root, name):
    if (
        not isinstance(name, str)
        or "\\" in name
        or ":" in name
        or "\x00" in name
        or any(part in ("", ".", "..") for part in name.split("/"))
    ):
        raise ValueError("invalid captured input path")
    parts = name.split("/")
    path = root
    for index, part in enumerate(parts):
        if (
            part.endswith((".", " "))
            or any(ord(character) < 32 or character in '<>"|?*' for character in part)
            or re.fullmatch(
                r"CON|CONIN\$|CONOUT\$|PRN|AUX|NUL|COM[1-9\u00b9\u00b2\u00b3]|LPT[1-9\u00b9\u00b2\u00b3]",
                part.split(".", 1)[0].rstrip(" ").upper(),
            )
        ):
            raise ValueError("captured input path has nonportable Windows spelling")
        path = path / part
        if path.is_symlink():
            raise ValueError("captured input path contains symlink")
        if index < len(parts) - 1 and path.exists() and not path.is_dir():
            raise ValueError("captured input ancestor is not a directory")
    if not path.resolve().is_relative_to(root.resolve()):
        raise ValueError("captured input path escapes copied root")
    return path


def validate_destinations(root, names):
    """Preflight predictable file/ancestor and case aliases before any writes.

    This is a conservative spelling policy, not a filesystem transaction or a
    defense against concurrent replacement of the copied directory.
    """
    files, directories, spellings = set(), set(), {}
    for name in names:
        destination(root, name)
        parts = tuple(name.split("/"))
        key = tuple(part.upper() for part in parts)
        ancestors = [key[:index] for index in range(1, len(key))]
        if (
            key in files
            or key in directories
            or any(parent in files for parent in ancestors)
        ):
            raise ValueError(
                "captured input destinations collide with a file or ancestor"
            )
        for index in range(1, len(parts) + 1):
            prefix = key[:index]
            spelling = parts[:index]
            if prefix in spellings and spellings[prefix] != spelling:
                raise ValueError("captured input destinations contain case aliases")
            spellings[prefix] = spelling
        files.add(key)
        directories.update(ancestors)


def unpack_inputs(root):
    root = Path(root)
    if root.is_symlink():
        raise ValueError("copied root must not be a symlink")
    manifest = json.loads(destination(root, "CAPTURED-INPUTS.json").read_bytes())
    archive = manifest["archive"]
    if (
        archive["path"] != "captured-inputs.zip"
        or type(archive["bytes"]) is not int
        or not 0 <= archive["bytes"] <= MAX_BYTES
    ):
        raise ValueError("invalid input archive size or path")
    with destination(root, archive["path"]).open("rb") as stream:
        raw = stream.read(MAX_BYTES + 1)
    # Verify the complete archive bytes BEFORE the ZIP parser inspects any member.
    if (
        len(raw) != archive["bytes"]
        or hashlib.sha256(raw).hexdigest() != archive["sha256"]
    ):
        raise ValueError("captured input archive SHA-256 or size mismatch")
    result = json.loads(destination(root, "result.json").read_bytes())
    expected = {}
    for pair in result["pairs"]:
        if (
            pair["engine"] not in ("T", "Y", "S", "L")
            or pair["workspace"] not in ("fixture", "pico")
            or pair["sample"] not in (1, 2, 3)
        ):
            raise ValueError("invalid captured input pair identity")
        prefix = f"{pair['engine']}-{pair['workspace']}-{pair['sample']}/inputs/"
        for item in pair["workspaceInputs"]:
            name = prefix + item["capturePath"]
            destination(root, name)
            if name in expected or not re.fullmatch(r"[0-9a-f]{64}", item["sha256"]):
                raise ValueError("duplicate or invalid expected input inventory")
            expected[name] = item["sha256"]
    members = manifest["members"]
    if not 0 < len(members) <= MAX_MEMBERS or len(
        {item["path"] for item in members}
    ) != len(members):
        raise ValueError("duplicate or invalid captured input inventory")
    if {item["path"]: item["sha256"] for item in members} != expected:
        raise ValueError("captured input inventory differs from original result")
    validate_destinations(root, expected)
    declared = {item["path"]: item for item in members}
    payloads = []
    try:
        with zipfile.ZipFile(io.BytesIO(raw)) as bundle:
            entries = bundle.infolist()
            if len(entries) != len(declared) or {
                item.filename for item in entries
            } != set(declared):
                raise ValueError("archive member inventory mismatch")
            total = 0
            for item in entries:
                target = destination(root, item.filename)
                if (
                    item.filename != item.orig_filename
                    or item.is_dir()
                    or stat.S_IFMT(item.external_attr >> 16) not in (0, stat.S_IFREG)
                    or item.compress_type != zipfile.ZIP_STORED
                ):
                    raise ValueError("invalid captured input member type")
                size = declared[item.filename]["bytes"]
                if type(size) is not int or size < 0 or size != item.file_size:
                    raise ValueError("captured input member size mismatch")
                total += size
                if total > MAX_BYTES:
                    raise ValueError("captured input byte budget exceeded")
                if target.exists():
                    raise ValueError("captured input destination already exists")
                payload = bundle.read(item)
                if (
                    len(payload) != size
                    or hashlib.sha256(payload).hexdigest() != expected[item.filename]
                ):
                    raise ValueError("captured input member SHA-256 mismatch")
                payloads.append((target, payload))
            if (
                type(archive["uncompressedBytes"]) is not int
                or total != archive["uncompressedBytes"]
            ):
                raise ValueError("captured input total size mismatch")
    except zipfile.BadZipFile as error:
        raise ValueError("invalid captured input ZIP") from error
    # Validate every member before creating any input directory or file.
    for target, payload in payloads:
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open("xb") as stream:
            stream.write(payload)
    return {"members": len(payloads), "bytes": sum(len(raw) for _, raw in payloads)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--root",
        type=Path,
        required=True,
        help="Explicit copied capture directory, never the tracked publication",
    )
    args = parser.parse_args()
    print(json.dumps(unpack_inputs(args.root), ensure_ascii=True))


if __name__ == "__main__":
    main()
