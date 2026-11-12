"""Copy an externally pinned finite public manifest; no qualification authority."""
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import shutil

ROOT = None
ALLOWED_SOURCE_DESTINATIONS = {'work/native-96fedbbe-portable/PORTABLE-PUBLIC-INDEX.json': 'portable-public-index.original.json', 'work/native-96fedbbe-portable/macos/manifest.json.gz': 'macos/manifest.json.gz', 'work/native-96fedbbe-portable/macos/pack.json': 'macos/pack.json', 'work/native-96fedbbe-portable/macos/capture.part0001': 'macos/capture.part0001', 'work/native-96fedbbe-portable/macos/capture.part0002': 'macos/capture.part0002', 'work/native-96fedbbe-portable/macos/capture.part0003': 'macos/capture.part0003', 'work/native-final-stage-96fedbbe14e8585ae1c89e2656604bf5ecabf2c3/complete-macos-import-f1/complete-import-receipt.json': 'macos-custody/complete-import-receipt.json', 'work/native-final-stage-96fedbbe14e8585ae1c89e2656604bf5ecabf2c3/complete-macos-import-f1/complete-export-receipt.json': 'macos-custody/complete-export-receipt.json', 'work/native-96fedbbe-prepared-export/prepared-macos.tar.gz': 'preparation/prepared-macos.tar.gz', 'work/native-96fedbbe-portable/linux/manifest.json.gz': 'linux/manifest.json.gz', 'work/native-96fedbbe-portable/linux/pack.json': 'linux/pack.json', 'work/native-96fedbbe-portable/linux/capture.part0001': 'linux/capture.part0001', 'work/native-96fedbbe-portable/linux/capture.part0002': 'linux/capture.part0002', 'work/native-96fedbbe-portable/linux/capture.part0003': 'linux/capture.part0003', 'work/native-final-stage-96fedbbe14e8585ae1c89e2656604bf5ecabf2c3/complete-linux-import-f1/complete-import-receipt.json': 'linux-custody/complete-import-receipt.json', 'work/native-final-stage-96fedbbe14e8585ae1c89e2656604bf5ecabf2c3/complete-linux-import-f1/complete-export-receipt.json': 'linux-custody/complete-export-receipt.json', 'work/native-96fedbbe-prepared-export/prepared-linux.tar.gz': 'preparation/prepared-linux.tar.gz', 'work/native-96fedbbe-assessment/download-v1/assessment-macos.native.json': 'macos-custody/assessment-macos.native.json', 'work/native-96fedbbe-assessment/download-v1/public-download-receipt.json': 'macos-custody/public-download-receipt.json', 'work/native-96fedbbe-assessment/download-v1/macos-hosts.native.json': 'macos-custody/macos-hosts.native.json', 'work/native-96fedbbe-assessment/download-v1/macos-assessment-driver.receipt.json': 'macos-custody/macos-assessment-driver.receipt.json', 'work/native-final-stage-96fedbbe14e8585ae1c89e2656604bf5ecabf2c3/complete-linux-import-f1/assessment-linux.native.json': 'linux-custody/assessment-linux.native.json', 'work/native-final-stage-96fedbbe14e8585ae1c89e2656604bf5ecabf2c3/complete-linux-import-f1/transport-receipt.json': 'linux-custody/transport-receipt.json', 'work/native-final-stage-96fedbbe14e8585ae1c89e2656604bf5ecabf2c3/complete-linux-import-f1/linux-hosts.native.json': 'linux-custody/linux-hosts.native.json', 'work/native-final-stage-96fedbbe14e8585ae1c89e2656604bf5ecabf2c3/complete-linux-import-f1/linux-assessment-driver.receipt.json': 'linux-custody/linux-assessment-driver.receipt.json', 'work/retained-scope-observer-fix/native-freeze-c01cb627/freeze-receipt.json': 'protocol/native/freeze-receipt.json', 'work/retained-scope-observer-fix/native-freeze-c01cb627/native-assessor.zip': 'protocol/native/native-assessor.zip', 'work/retained-scope-observer-fix/windows-freeze-c01cb627/freeze-receipt.json': 'protocol/windows/freeze-receipt.json', 'work/retained-scope-observer-fix/windows-freeze-c01cb627/windows-assessor.zip': 'protocol/windows/windows-assessor.zip', 'work/native-96fedbbe-prepared-export/prepared-two-os-summary.json': 'preparation/prepared-two-os-summary.json', 'work/public-native-regression-96fedbbe/PUBLIC-96-FINAL-PROOF-INDEX.json': 'public-regression/final-proof-index.original.json', 'work/public-native-regression-96fedbbe/execution-v3/PUBLIC-96-RAW-ADJUDICATION.json': 'public-regression/PUBLIC-96-RAW-ADJUDICATION.json', 'work/public-native-regression-96fedbbe/execution-v3/raw-archives/PUBLIC-96-MACOS-RAW.tar.gz': 'public-regression/PUBLIC-96-MACOS-RAW.tar.gz', 'work/public-native-regression-96fedbbe/execution-v3/raw-archives/PUBLIC-96-LINUX-RAW.tar.gz': 'public-regression/PUBLIC-96-LINUX-RAW.tar.gz', 'work/public-scoped-call-witness/PUBLIC-ACTUAL-TWO-HOST.json': 'public-scoped-method/PUBLIC-ACTUAL-TWO-HOST.json', 'work/public-scoped-call-witness/manifest.frozen.json': 'public-scoped-method/manifest.frozen.json', 'work/public-scoped-call-witness/expected-oracle.json': 'public-scoped-method/expected-oracle.json', 'work/public-scoped-call-witness/identity_scope_reader.py': 'public-scoped-method/identity_scope_reader.py', 'work/public-scoped-call-witness/baseline.actual.json': 'public-scoped-method/baseline.actual.json', 'work/public-scoped-call-witness/baseline.cjs': 'public-scoped-method/baseline.cjs', 'work/public-scoped-call-witness/staging-v1/raw-macos-one-shot.tar.gz': 'public-scoped-method/raw-macos-one-shot.tar.gz', 'work/public-scoped-call-witness/staging-v1/raw-linux-one-shot.tar.gz': 'public-scoped-method/raw-linux-one-shot.tar.gz', 'work/r0-source-selection-96fedbbe/root-source-review-v1/current-source-mechanisms.json': 'source-selection/current-source-mechanisms.original.json', 'work/r0-terminal-ledger-preparation-v3/current-96-draft-v1.json': 'draft-ledger/current-96-draft-v1.original.json', 'work/native-96fedbbe-portable-index/build_index.py': 'portable-index-join/build_index.py', 'work/native-96fedbbe-portable-index/join-validation.json': 'portable-index-join/join-validation.json', 'work/portable-public-capture-delivery/capture_pack.py': 'capture-tool/capture_pack.py', 'work/portable-public-capture-delivery/test_capture_pack.py': 'capture-tool/test_capture_pack.py', 'work/native-96fedbbe-portable-index/assemble.py': 'assemble.py', 'work/native-96fedbbe-portable-index/README.md': 'README.md', 'work/native-96fedbbe-portable-index/publication-location-map.json': 'publication-location-map.json'}


def sha(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def canonical_relative(value):
    if not isinstance(value, str) or not value or "\\" in value or ":" in value or any(ord(c) < 32 for c in value):
        raise ValueError("noncanonical relative path")
    path = PurePosixPath(value)
    if path.is_absolute() or path.as_posix() != value or any(p in (".", "..") or p.endswith((".", " ")) for p in path.parts):
        raise ValueError("noncanonical relative path")
    return path


def no_alias(path):
    for part in (path, *path.parents):
        if part.is_symlink() or part.is_junction():
            raise ValueError("symlink/junction path refused")
    if path.absolute() != path.resolve():
        raise ValueError("aliased path refused")


def prepare(manifest_path, external_sha, output):
    output = output.absolute()
    if output.exists() or output.is_symlink():
        raise FileExistsError("output must be new")
    no_alias(output.parent)
    if not output.parent.is_dir() or any(output == p or output in p.parents for p in (ROOT, manifest_path.absolute())):
        raise ValueError("invalid output parent or source ancestor")
    no_alias(manifest_path.absolute())
    raw = manifest_path.read_bytes()
    if hashlib.sha256(raw).hexdigest() != external_sha:
        raise ValueError("external manifest SHA256 mismatch")
    data = json.loads(raw)
    if set(data) != {"schema_version", "source_head", "kind", "files", "total_file_bytes", "qualification_credit", "R0_decision"}:
        raise ValueError("manifest schema mismatch")
    if type(data["schema_version"]) is not int or data["schema_version"] != 1 or data["source_head"] != "96fedbbe14e8585ae1c89e2656604bf5ecabf2c3" or data["kind"] != "FINITE_PUBLIC_BYTE_COPY_MANIFEST":
        raise ValueError("manifest identity mismatch")
    if type(data["qualification_credit"]) is not int or data["qualification_credit"] != 0 or data["R0_decision"] is not None:
        raise ValueError("manifest cannot grant qualification")
    rows = data["files"]
    if type(rows) is not list or len(rows) != len(ALLOWED_SOURCE_DESTINATIONS):
        raise ValueError("finite allowlist length mismatch")
    observed = {}
    destinations = set()
    for row in rows:
        if type(row) is not dict or set(row) != {"source_path", "destination", "sha256", "bytes"}:
            raise ValueError("file schema mismatch")
        source_key = canonical_relative(row["source_path"]).as_posix()
        destination = canonical_relative(row["destination"]).as_posix()
        if source_key in observed or destination.casefold() in destinations or ALLOWED_SOURCE_DESTINATIONS.get(source_key) != destination:
            raise ValueError("file outside exact public allowlist")
        source = ROOT / source_key
        no_alias(source)
        if not source.is_file() or type(row["bytes"]) is not int or row["bytes"] < 0 or source.stat().st_size != row["bytes"] or sha(source) != row["sha256"]:
            raise ValueError("source pin mismatch: " + source_key)
        observed[source_key] = destination
        destinations.add(destination.casefold())
    if observed != ALLOWED_SOURCE_DESTINATIONS or type(data["total_file_bytes"]) is not int or data["total_file_bytes"] != sum(row["bytes"] for row in rows):
        raise ValueError("incomplete finite manifest")
    return output, raw, rows


def main():
    global ROOT
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-root", required=True, type=Path)
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--manifest-sha256", required=True)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--validate-only", action="store_true")
    args = parser.parse_args()
    ROOT = args.source_root.absolute()
    no_alias(ROOT)
    output, raw, rows = prepare(args.manifest, args.manifest_sha256, args.output)
    if args.validate_only:
        print(json.dumps({"state": "VALIDATED_NO_OUTPUT_CREATED", "files": len(rows), "bytes": sum(r["bytes"] for r in rows)}))
        return
    output.mkdir(exist_ok=False)
    for row in rows:
        target = output / row["destination"]
        target.parent.mkdir(parents=True, exist_ok=True)
        with (ROOT / row["source_path"]).open("rb") as source, target.open("xb") as destination:
            shutil.copyfileobj(source, destination, 1024 * 1024)
        if target.stat().st_size != row["bytes"] or sha(target) != row["sha256"]:
            raise ValueError("copied bytes differ; partial output retained")
    with (output / "assembly-manifest.json").open("xb") as destination:
        destination.write(raw)
    print(json.dumps({"state": "COPIED_EXACT_PUBLIC_BYTES", "files": len(rows) + 1, "payload_bytes": sum(r["bytes"] for r in rows), "qualification_credit": 0, "R0_decision": None}))


if __name__ == "__main__":
    main()
