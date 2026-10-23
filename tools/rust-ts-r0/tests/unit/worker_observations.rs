use super::*;
fn empty_sdk() -> Sdk {
    Sdk {
        version: "7.1.0-dev".into(),
        source_revision: "780dc512d64f40afebffa6a7028207649fb7ed1c".into(),
        library_manifest_sha256: "b1fa7b60aa83d187453b26c0b56a096875a47e61977954aba7deba16161fd7ad"
            .into(),
        files: BTreeMap::new(),
    }
}
#[test]
fn malformed_worker_protocol_refuses_before_repository_or_compiler_access() {
    let valid = serde_json::json!({"schemaVersion":1,"jobId":"dev-worker-guard","repoRoot":"/absent/dev-worker-never-read","rootAbsPaths":[],"emitAbsPaths":[]});
    for (key, value) in [
        ("schemaVersion", serde_json::json!(2)),
        ("jobId", serde_json::json!(3)),
        ("repoRoot", serde_json::json!([])),
        ("rootAbsPaths", serde_json::json!([false])),
        ("emitAbsPaths", serde_json::Value::Null),
    ] {
        let mut request = valid.clone();
        request[key] = value;
        let result = run(request, &empty_sdk());
        assert_eq!(result["ok"], false, "{key}");
        assert_eq!(result["jobId"], "unbound");
        assert_eq!(result["error"], "malformed extraction request");
        assert_eq!(result["extraction_started"], false);
    }
}
#[test]
fn missing_worker_repository_is_an_explicit_bound_failure() {
    let sdk: Sdk = serde_json::from_slice(
        &std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/sdk/sdk-input.json")).unwrap(),
    )
    .unwrap();
    let result = run(
        serde_json::json!({"schemaVersion":1,"jobId":"dev-worker-missing","repoRoot":"/absent/dev-worker-never-read","rootAbsPaths":[],"emitAbsPaths":[]}),
        &sdk,
    );
    assert_eq!(result["ok"], false);
    assert_eq!(result["jobId"], "dev-worker-missing");
    assert_eq!(result["extraction_started"], false);
    assert!(
        result["error"]
            .as_str()
            .unwrap()
            .starts_with("worker repository unavailable:")
    );
}

#[test]
fn native_worker_refuses_a_relative_import_escape_before_extraction() {
    let root = std::env::temp_dir().join(format!(
        "semctx-worker-confinement-dev-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&root).unwrap();
    let source = root.join("guardConsumer.ts");
    std::fs::write(
        &source,
        "import { guardedValue } from '../guardOutside'; export const observed = guardedValue;",
    )
    .unwrap();
    let sdk: Sdk = serde_json::from_slice(
        &std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/sdk/sdk-input.json")).unwrap(),
    )
    .unwrap();
    let observed = run(
        serde_json::json!({"schemaVersion":1,"jobId":"guard-worker-dev","repoRoot":root,"rootAbsPaths":[source],"emitAbsPaths":[source]}),
        &sdk,
    );
    std::fs::remove_dir_all(root).unwrap();
    assert_eq!(observed["ok"], false);
    assert_eq!(observed["extraction_started"], false);
    assert_eq!(
        observed["error"],
        "IMPORT_OUTSIDE_REPOSITORY: ../guardOutside"
    );
}

#[test]
#[cfg(unix)]
fn native_worker_refuses_external_symlink_imports_and_references_before_extraction() {
    let directory = std::env::temp_dir().join(format!(
        "semctx-worker-symlink-dev-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let root = directory.join("repo");
    std::fs::create_dir_all(&root).unwrap();
    let outside = directory.join("outside.ts");
    std::fs::write(&outside, "export const leaf = 1;").unwrap();
    std::os::unix::fs::symlink(&outside, root.join("external-link.ts")).unwrap();
    let source = root.join("consumer.ts");
    let sdk: Sdk = serde_json::from_slice(
        &std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/sdk/sdk-input.json")).unwrap(),
    )
    .unwrap();
    let results = [
            ("import {leaf} from './external-link.ts'; export const value = leaf;", "IMPORT_OUTSIDE_REPOSITORY: ./external-link.ts"),
            ("import {leaf} from './external-link'; export const value = leaf;", "IMPORT_OUTSIDE_REPOSITORY: ./external-link"),
            ("/// <reference path=\"./external-link.ts\" />\nexport const value = 1;", "REFERENCE_OUTSIDE_REPOSITORY: ./external-link.ts"),
        ].map(|(text, expected)| {
            std::fs::write(&source, text).unwrap();
            (run(serde_json::json!({"schemaVersion":1,"jobId":"guard-symlink-dev","repoRoot":root,"rootAbsPaths":[source],"emitAbsPaths":[source]}), &sdk), expected)
        });
    std::fs::remove_dir_all(directory).unwrap();
    for (observed, expected) in results {
        assert_eq!(observed["ok"], false, "{expected}: {observed}");
        assert_eq!(observed["extraction_started"], false);
        assert_eq!(observed["error"], expected);
        assert!(observed.get("extraction").is_none());
    }
}

#[test]
fn captured_worker_reads_are_sorted_and_oversized_files_are_refused_before_reading() {
    let root = std::env::temp_dir().join(format!(
        "semctx-worker-capture-dev-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(root.join("child")).unwrap();
    std::fs::write(root.join("z.ts"), "z").unwrap();
    std::fs::write(root.join("a.ts"), "a").unwrap();
    std::fs::write(root.join("child/b.ts"), "b").unwrap();
    let (_, reads) = read_repository(&root).unwrap();
    assert!(
        reads
            .windows(2)
            .all(|pair| pair[0]["path"].as_str() < pair[1]["path"].as_str())
    );
    std::fs::File::create(root.join("oversized.ts"))
        .unwrap()
        .set_len(33_554_433)
        .unwrap();
    assert_eq!(
        read_repository(&root).unwrap_err(),
        "worker capture limit exceeded"
    );
    std::fs::remove_dir_all(root).unwrap();
}
#[cfg(target_os = "linux")]
#[test]
fn native_worker_refuses_lossy_utf8_capture_paths_before_extraction() {
    use std::os::unix::{ffi::OsStringExt, fs::symlink};
    let sdk: Sdk = serde_json::from_slice(
        &std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/sdk/sdk-input.json")).unwrap(),
    )
    .unwrap();
    for canonical_alias in [false, true] {
        let root = std::env::temp_dir().join(format!(
            "semctx-worker-utf8-dev-{}-{}-{canonical_alias}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let invalid = root.join(std::ffi::OsString::from_vec(b"z-invalid-\xff.ts".to_vec()));
        std::fs::write(&invalid, "nonrepresentable bytes").unwrap();
        std::fs::write(
            root.join("z-invalid-\u{fffd}.ts"),
            "different replacement-name bytes",
        )
        .unwrap();
        if canonical_alias {
            symlink(&invalid, root.join("a-valid-alias.ts")).unwrap();
        }
        let result = run(
            serde_json::json!({"schemaVersion":1,"jobId":"worker-utf8-development","repoRoot":root,"rootAbsPaths":[],"emitAbsPaths":[]}),
            &sdk,
        );
        std::fs::remove_dir_all(&root).unwrap();
        assert_eq!(result["ok"], false, "{result}");
        assert_eq!(result["extraction_started"], false);
        assert_eq!(result["jobId"], "worker-utf8-development");
        assert_eq!(result["error"], "worker capture path is not UTF-8");
    }
}
#[cfg(unix)]
#[test]
fn native_worker_refuses_literal_backslash_capture_aliases_before_extraction() {
    let sdk: Sdk = serde_json::from_slice(
        &std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/sdk/sdk-input.json")).unwrap(),
    )
    .unwrap();
    let root = std::env::temp_dir().join(format!(
        "semctx-worker-separator-dev-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(root.join("part")).unwrap();
    let replacement = root.join("valid-\u{fffd}.ts");
    std::fs::write(&replacement, "valid replacement-character spelling").unwrap();
    let valid = run(
        serde_json::json!({"schemaVersion":1,"jobId":"worker-unicode-development","repoRoot":root,"rootAbsPaths":[],"emitAbsPaths":[]}),
        &sdk,
    );
    assert_eq!(valid["ok"], true, "{valid}");
    assert_eq!(
        valid["read_observations"][0]["path"],
        serde_json::json!(replacement)
    );
    std::fs::remove_file(replacement).unwrap();
    std::fs::write(root.join("part/leaf.ts"), "directory-entry bytes").unwrap();
    std::fs::write(root.join("part\\leaf.ts"), "literal-backslash bytes").unwrap();
    let result = run(
        serde_json::json!({"schemaVersion":1,"jobId":"worker-separator-development","repoRoot":root,"rootAbsPaths":[],"emitAbsPaths":[]}),
        &sdk,
    );
    std::fs::remove_dir_all(&root).unwrap();
    assert_eq!(result["ok"], false, "{result}");
    assert_eq!(result["extraction_started"], false);
    assert_eq!(
        result["error"],
        "worker capture path contains a nonportable separator"
    );
}
#[test]
fn relative_worker_roots_and_emit_paths_resolve_from_the_callers_directory() {
    assert_eq!(
        absolute_worker_path("").unwrap(),
        ts_goport::frontend::tspath::normalize_path(
            &std::env::current_dir().unwrap().to_string_lossy()
        )
    );
    let relative = format!(
        "target/semctx-worker-relative-dev-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    );
    let root = std::env::current_dir().unwrap().join(&relative);
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(
        root.join("owner.ts"),
        "export const relativeWorkerDev = 401;\n",
    )
    .unwrap();
    let sdk: Sdk = serde_json::from_slice(
        &std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/sdk/sdk-input.json")).unwrap(),
    )
    .unwrap();
    let request = serde_json::json!({"schemaVersion":1,"jobId":"relative-worker-dev","repoRoot":root,"rootAbsPaths":[format!("{relative}/./owner.ts")],"emitAbsPaths":[format!("{relative}/owner.ts")]});
    let result = run(request, &sdk);
    assert_eq!(result["ok"], true, "{result}");
    assert_eq!(
        result["extraction"]["modules"],
        serde_json::json!(["owner.ts"])
    );
    std::fs::remove_dir_all(root).unwrap();
}
#[test]
fn native_worker_emits_only_requested_roots_and_keeps_cross_file_call_target() {
    let root = std::env::temp_dir().join(format!(
        "semctx-r0-worker-dev-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&root).unwrap();
    let owner = root.join("worker-development-owner.ts");
    let caller = root.join("worker-development-caller.ts");
    std::fs::write(
        &owner,
        "export function workerDevelopmentOwner(){return 4;}\n",
    )
    .unwrap();
    std::fs::write(&caller, "import {workerDevelopmentOwner as invokeDevelopmentOwner} from './worker-development-owner';\nexport function workerDevelopmentCaller(){return invokeDevelopmentOwner();}\n").unwrap();
    let sdk: Sdk = serde_json::from_slice(
        &std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/sdk/sdk-input.json")).unwrap(),
    )
    .unwrap();
    let request = serde_json::json!({"schemaVersion":1,"jobId":"worker-dev-subset","repoRoot":root,"rootAbsPaths":[owner,caller],"emitAbsPaths":[caller]});
    let result = run(request.clone(), &sdk);
    assert_eq!(result["ok"], true, "{result}");
    assert_eq!(result["frontendCapabilityObservation"]["executed"], true);
    assert_eq!(
        result["frontendCapabilityObservation"]["unsupported"],
        serde_json::json!([])
    );
    assert!(
        result["frontendCapabilityObservation"]["roots"]
            .as_array()
            .unwrap()
            .iter()
            .all(|source| source["loaded"] == true
                && source["parseDiagnosticCodes"] == serde_json::json!([]))
    );
    assert_eq!(
        result["captured_repository_input_id"],
        serde_json::json!(identity::digest(
            &serde_json::json!({owner.to_string_lossy().replace('\\',"/"):"export function workerDevelopmentOwner(){return 4;}\n",caller.to_string_lossy().replace('\\',"/"):"import {workerDevelopmentOwner as invokeDevelopmentOwner} from './worker-development-owner';\nexport function workerDevelopmentCaller(){return invokeDevelopmentOwner();}\n"})
        ))
    );
    assert_eq!(
        result["extraction"]["modules"],
        serde_json::json!(["worker-development-caller.ts"])
    );
    assert_eq!(result["extraction"]["symbols"].as_array().unwrap().len(), 1);
    assert_eq!(
        result["extraction"]["symbols"][0]["name"],
        "workerDevelopmentCaller"
    );
    assert_eq!(
        result["extraction"]["imports"][0]["names"],
        serde_json::json!(["invokeDevelopmentOwner"])
    );
    assert!(
        result["extraction"]["imports"][0]
            .get("bindingTargets")
            .is_none()
    );
    assert_eq!(
        result["extraction"]["calls"][0]["calleeRelPath"],
        "worker-development-owner.ts"
    );
    assert_eq!(
        result["extraction"]["calls"][0]["calleeSymbolPath"],
        "workerDevelopmentOwner"
    );
    assert_eq!(result["read_observations"].as_array().unwrap().len(), 2);
    let mut duplicate = request.clone();
    duplicate["rootAbsPaths"] = serde_json::json!([owner, caller, caller]);
    let duplicated = run(duplicate, &sdk);
    assert_eq!(duplicated["extraction"], result["extraction"]);
    let mut empty = request.clone();
    empty["emitAbsPaths"] = serde_json::json!([]);
    let result = run(empty, &sdk);
    for key in ["modules", "symbols", "imports", "calls"] {
        assert_eq!(result["extraction"][key], serde_json::json!([]));
    }
    let missing = root.join("worker-development-absent.ts");
    let mut absent = request;
    absent["rootAbsPaths"] = serde_json::json!([missing]);
    absent["emitAbsPaths"] = serde_json::json!([missing]);
    let result = run(absent, &sdk);
    assert_eq!(result["ok"], false);
    assert_eq!(result["extraction_started"], false);
    assert_eq!(
        result["error"],
        "SOURCE_SNAPSHOT_MISSING: worker-development-absent.ts"
    );
    assert!(result.get("frontendCapabilityObservation").is_none());
    assert!(result.get("extraction").is_none());
    std::fs::remove_dir_all(&root).unwrap();
}

#[test]
fn native_worker_refuses_incomplete_foreign_or_changed_sdk_before_extraction() {
    let root = std::env::temp_dir().join(format!(
        "semctx-worker-sdk-inventory-dev-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&root).unwrap();
    let source = root.join("source.ts");
    std::fs::write(&source, "export const sdkInventoryWorkerDev = 431;").unwrap();
    let sdk: Sdk = serde_json::from_slice(
        &std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/sdk/sdk-input.json")).unwrap(),
    )
    .unwrap();
    let request = serde_json::json!({"schemaVersion":1,"jobId":"sdk-worker-dev","repoRoot":root,"rootAbsPaths":[source],"emitAbsPaths":[source]});
    let control = run(request.clone(), &sdk);
    let observations = ["missing", "extra", "bytes"].map(|mutation| {
        let mut mutated = sdk.clone();
        let expected = match mutation {
            "missing" => {
                mutated.files.remove("/sdk/lib/lib.es5.d.ts");
                "SDK_LIBRARY_MISSING:lib.es5.d.ts"
            }
            "extra" => {
                mutated.files.insert(
                    "/sdk/lib/lib.foreign.d.ts".into(),
                    "declare const foreign: number;".into(),
                );
                "SDK_LIBRARY_UNEXPECTED:lib.foreign.d.ts"
            }
            _ => {
                mutated
                    .files
                    .get_mut("/sdk/lib/lib.es5.d.ts")
                    .unwrap()
                    .replace_range(0..1, " ");
                "SDK_LIBRARY_CONTENT_MISMATCH:lib.es5.d.ts"
            }
        };
        (run(request.clone(), &mutated), expected)
    });
    std::fs::remove_dir_all(root).unwrap();
    assert_eq!(control["ok"], true, "{control}");
    assert_eq!(control["extraction_started"], true);
    for (observed, expected) in observations {
        assert_eq!(observed["ok"], false, "{expected}: {observed}");
        assert_eq!(observed["error"], expected);
        assert_eq!(observed["extraction_started"], false);
        assert!(observed.get("extraction").is_none());
    }
}
