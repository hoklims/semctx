"""Join existing public bytes; never acquire, pack, extract, or qualify."""
import gzip
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
WORK = ROOT / "work"
OUT = Path(__file__).resolve().parent
HEAD = "96fedbbe14e8585ae1c89e2656604bf5ecabf2c3"
PACKAGE = WORK / "native-96fedbbe-portable"
STAGE = WORK / f"native-final-stage-{HEAD}"
INDEX = PACKAGE / "PORTABLE-PUBLIC-INDEX.json"


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def ref(path):
    return {"path": path.relative_to(ROOT).as_posix(), "sha256": digest(path), "bytes": path.stat().st_size}


def load(path):
    return json.loads(path.read_text(encoding="utf-8"))


def write_new(path, value):
    with path.open("x", encoding="utf-8", newline="\n") as stream:
        stream.write(json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def main():
    assert not INDEX.exists(), "never overwrite an existing index"
    tool = WORK / "portable-public-capture-delivery/capture_pack.py"
    assert digest(tool) == "07b7dbedaa22cdc06afd28be7f9896f9c87ba7eebeaad4a7ca690738098b91ec"
    platforms = {}
    checked = []
    for os_name in ("macos", "linux"):
        directory = PACKAGE / os_name
        pack_path = directory / "pack.json"
        pack = load(pack_path)
        manifest_path = directory / "manifest.json.gz"
        assert digest(manifest_path) == pack["manifest_sha256"]
        assert manifest_path.stat().st_size == pack["manifest_bytes"]
        manifest = json.loads(gzip.decompress(manifest_path.read_bytes()))
        for key in ("format", "source_archive", "tar", "member_count", "regular_bytes", "parts", "tree_restoration_policy"):
            assert manifest[key] == pack[key], (os_name, key)
        assert manifest["max_part_bytes"] == 24000000
        assert len(manifest["blobs"]) == pack["unique_blobs"]
        assert len(pack["parts"]) == 3
        for part in pack["parts"]:
            path = directory / part["name"]
            assert path.name == part["name"] and path.parent == directory
            assert digest(path) == part["sha256"]
            assert path.stat().st_size == part["bytes"] <= 24000000
            checked.append(ref(path))
        assert sum(p["bytes"] for p in pack["parts"]) == pack["packed_blob_bytes"]
        imported = STAGE / f"complete-{os_name}-import-f1"
        import_path = imported / "complete-import-receipt.json"
        receipt = load(import_path)
        assert receipt["source_head"] == HEAD
        archive = imported / "complete-evidence.tar.gz"
        assert receipt["archive_sha256"] == pack["source_archive"]["sha256"]
        assert receipt["archive_bytes"] == pack["source_archive"]["bytes"] == archive.stat().st_size
        assert receipt["total_members"] == pack["member_count"]
        assert receipt["regular_members"] + receipt["directory_members"] + receipt["links_retained_only_in_archive"] == receipt["total_members"]
        assert receipt["links_retained_only_in_archive"] == 24
        export_path = imported / "complete-export-receipt.json"
        if os_name == "macos":
            assert digest(export_path) == receipt["export_receipt_sha256"]
            custody = WORK / "native-96fedbbe-assessment/download-v1/public-download-receipt.json"
            assessment = custody.parent / "assessment-macos.native.json"
            custody_data = load(custody)
            assert custody_data["source_head"] == HEAD
            entry = next(f for f in custody_data["files"] if Path(f["local_path"]).name == assessment.name)
            assert digest(assessment) == entry["sha256"] == "f07710107109f559681c14bcbe3b7b742d748a329c094192ca0ce5e2d17e7380"
            assert assessment.stat().st_size == entry["bytes"] and entry["scp_exit_code"] == 0
            assessment_custody = {"mode": "separate_exact_scp_custody", "receipt": ref(custody), "assessment_present_in_source_archive": False}
        else:
            custody = imported / "transport-receipt.json"
            assert digest(custody) == receipt["transport_receipt_sha256"]
            assessment = imported / "assessment-linux.native.json"
            assert digest(assessment) == receipt["assessment_sha256"] == "5bd9f1014e1872dd4bd1ffcf5706e2e78cde7839eb0644ec0b3258fe0091f71b"
            assessment_custody = {"mode": "verified_native_export_transport", "receipt": ref(custody)}
        data = load(assessment)
        assert data["candidate_head"] == HEAD and data["counts"] == {os_name: {"RELEVANT_PASS": 446}}
        assert len(data["rows"]) == 446 and data["qualified"] is False
        assert data["qualification_credit"] == 0 and data["R0_decision"] is None
        assert sum(row["kind"] == "property" for row in data["rows"]) == 395
        assert sum(row["kind"] == "support" for row in data["rows"]) == 51
        raw_nonpass = [(row, comparison) for row in data["rows"] for comparison in row["hosts"][os_name]["comparisons"] if comparison["state"] == "NONPASS"]
        assert len(raw_nonpass) == 5 and len({id(row) for row, _ in raw_nonpass}) == 4
        platforms[os_name] = {
            "source_archive": {**pack["source_archive"], "local_path": archive.relative_to(ROOT).as_posix(), "identity_source": "existing_verified_import_receipt", "rehashed_in_this_join": False},
            "import_receipt": ref(import_path), "export_receipt": ref(export_path),
            "package_directory": directory.relative_to(ROOT).as_posix(), "pack_receipt": ref(pack_path),
            "manifest": ref(manifest_path), "parts": pack["parts"],
            "part_count": len(pack["parts"]), "packed_blob_bytes": pack["packed_blob_bytes"],
            "unique_blobs": pack["unique_blobs"], "member_count": pack["member_count"],
            "regular_members": receipt["regular_members"], "directory_members": receipt["directory_members"],
            "links_retained_as_archive_data": receipt["links_retained_only_in_archive"],
            "exact_uncompressed_tar": pack["tar"], "tree_restoration_policy": pack["tree_restoration_policy"],
            "original_gzip_reconstructed": False, "native_extraction_run": False,
            "offline_assessor_rerun_from_portable_package": False,
            "prior_pack_and_verify_execution": {"exit_codes": {"pack": 0, "verify": 0}, "provenance": "parent-reported actual tool history; existing pack.json", "separate_raw_process_logs_or_receipts": None, "reexecuted_by_this_join": False},
            "assessment": ref(assessment), "assessment_custody": assessment_custody,
            "native_row_counts": {"properties": 395, "supports": 51, "RELEVANT_PASS": 446, "raw_NONPASS_comparisons_preserved": 5, "rows_with_raw_NONPASS": 4},
        }
        checked += [ref(pack_path), ref(manifest_path), ref(import_path), ref(export_path), ref(custody), ref(assessment)]
    public_refs = []
    for relative, expected in [
        ("public-native-regression-96fedbbe/PUBLIC-96-FINAL-PROOF-INDEX.json", "1d9920b5ef80dab084e8ccf07d18e60687824cab329dce8adb394a383abe7031"),
        ("public-native-regression-96fedbbe/execution-v3/PUBLIC-96-RAW-ADJUDICATION.json", "11630b7ee0fb290d99c83e05229e5343044d1822b14c0cde250058e42e264ea8"),
        ("public-scoped-call-witness/PUBLIC-ACTUAL-TWO-HOST.json", "bfcf5090773c5dbd3c1c119d0040f7cda2b362a56feec8fa7c19b84143449052"),
    ]:
        path = WORK / relative
        assert digest(path) == expected
        public_refs.append(ref(path))
    index = {
        "schema_version": 1, "state": "CURRENT_96_PUBLIC_PORTABLE_BYTES_JOINED_TO_EXISTING_PACK_AND_VERIFY",
        "source_head": HEAD, "reviewed_tool": ref(tool), "platforms": platforms,
        "public_diagnostic_evidence_refs": public_refs,
        "public_diagnostic_counts_reported_by_bound_aggregates": {"public_regression": 38, "scoped_method": 2},
        "qualified_obligations": 0, "R0_decision": None,
        "missing_before_terminal_delivery": ["Windows native acquisition", "completed old exposed reserved regression", "fresh sealed reserved run", "root property and support adequacy", "fresh canonical proof audit", "exact delivery-head CI"],
        "limits": ["Part and manifest bytes were freshly hashed by this join; no pack conversion or full reconstruction verifier was rerun.", "The original gzip identities are inherited from exact verified import receipts; only their current byte sizes were checked here.", "Unsafe fixture links are preserved as archive data; full native tree restoration and offline reassessment are not claimed.", "Raw version discrepancies remain under their individually scoped arbitrations; 446 RELEVANT_PASS is not qualification.", "All historical captures retain their original source identity; this record does not retag them."],
    }
    write_new(INDEX, index)
    result = {"kind": "PUBLIC_PORTABLE_METADATA_AND_BYTE_JOIN", "script": ref(Path(__file__)), "index": ref(INDEX), "freshly_checked_files": checked + public_refs, "native_queries": 0, "builds": 0, "pack_or_full_verify_reruns": 0, "qualification_credit": 0, "R0_decision": None}
    write_new(OUT / "join-validation.json", result)
    print(json.dumps({"index": ref(INDEX), "freshly_checked_files": len(result["freshly_checked_files"]), "platforms": 2, "qualification_credit": 0}))


if __name__ == "__main__":
    main()
