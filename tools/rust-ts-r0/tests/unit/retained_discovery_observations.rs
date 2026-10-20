
use super::*;

fn descriptor() -> Value {
    json!({"analysis":{"id":"retainedDiscoveryGuardDev","cwd":"/repo","sdk_directory":"/sdk/lib","case_sensitive":ts_goport::frontend::vfs::osvfs_fs().use_case_sensitive_file_names(),"roots":["/repo/guard.ts"],"files":{"/repo/guard.ts":"export const guardFactory=97;"},"options":{"target":"ES2022","module":"ESNext","moduleResolution":"Bundler","allowJs":true,"jsx":"Preserve","skipLibCheck":true,"noEmit":true,"strict":false},"retained":true,"raw_files":{},"utf16_files":{}},"discovered_sources":[{"relPath":"guard.ts","content":"export const guardFactory=97;"}]})
}

fn sdk() -> Sdk {
    serde_json::from_slice(
        &std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/sdk/sdk-input.json")).unwrap(),
    )
    .unwrap()
}

#[test]
fn retained_discovery_refuses_incomplete_foreign_and_mismatching_metadata() {
    let sdk = sdk();
    for (pointer, value, expected) in [
        (
            "/discovered_sources",
            json!([]),
            "RETAINED_DISCOVERY_SOURCE_MISSING:guard.ts",
        ),
        (
            "/discovered_sources/0/content",
            json!("export const liveFactory=101;"),
            "SOURCE_SNAPSHOT_MISMATCH: guard.ts",
        ),
        (
            "/analysis/files",
            json!({}),
            "SOURCE_SNAPSHOT_MISMATCH: guard.ts",
        ),
        (
            "/analysis/retained",
            json!(false),
            "SOURCE_SNAPSHOT_REQUIRED",
        ),
        (
            "/analysis/roots",
            json!([]),
            "RETAINED_DISCOVERY_SOURCE_ROOT_REQUIRED",
        ),
        (
            "/discovered_sources/0/relPath",
            json!("other.ts"),
            "RETAINED_DISCOVERY_FOREIGN_SOURCE:other.ts",
        ),
        (
            "/discovered_sources",
            json!([{"relPath":"guard.ts","content":"export const guardFactory=97;"},{"relPath":"guard.ts","content":"export const guardFactory=97;"}]),
            "RETAINED_DISCOVERY_DUPLICATE_SOURCE",
        ),
        (
            "/analysis/roots",
            json!(["/repo/guard.ts", "/repo/./guard.ts"]),
            "RETAINED_DISCOVERY_DUPLICATE_ROOT",
        ),
        (
            "/analysis/raw_files",
            json!({"/repo/bytes.ts":{"bytes":[65],"profile":"retained_utf8"}}),
            "RETAINED_DISCOVERY_TEXT_CAPTURE_REQUIRED",
        ),
        (
            "/analysis/utf16_files",
            json!({"/repo/units.ts":[65]}),
            "RETAINED_DISCOVERY_TEXT_CAPTURE_REQUIRED",
        ),
    ] {
        let mut changed = descriptor();
        *changed
            .pointer_mut(pointer)
            .unwrap_or_else(|| panic!("missing mutation pointer {pointer}")) = value;
        let observed = run(changed, &sdk);
        assert_eq!(observed["executed"], false, "{pointer}:{observed}");
        assert_eq!(
            observed["unsupported"],
            json!([expected]),
            "{pointer}:{observed}"
        );
        assert!(observed.get("native_analysis").is_none());
    }
}

#[test]
fn retained_discovery_mismatch_precedes_analyze_preconditions() {
    let mut changed = descriptor();
    changed["discovered_sources"][0]["content"] = json!("export const changedBeforeAnalysis=107;");
    changed["analysis"]["options"] = Value::Null;
    let mut foreign_sdk = sdk();
    foreign_sdk.version = "foreign-version-dev".into();
    let result = run(changed, &foreign_sdk);
    assert_eq!(
        result["unsupported"],
        json!(["SOURCE_SNAPSHOT_MISMATCH: guard.ts"])
    );
    assert_eq!(result["executed"], false);
    assert!(result.get("native_analysis").is_none());
}

#[test]
fn retained_discovery_descriptor_and_paths_fail_closed() {
    let sdk = sdk();
    for path in [
        "",
        "./guard.ts",
        "../guard.ts",
        "nested/../guard.ts",
        "/guard.ts",
        "nested//guard.ts",
        "nested\\guard.ts",
        "C:guard.ts",
        "guard\0.ts",
    ] {
        let mut changed = descriptor();
        changed["discovered_sources"][0]["relPath"] = json!(path);
        let observed = run(changed, &sdk);
        assert_eq!(
            observed["unsupported"],
            json!(["RETAINED_DISCOVERY_RELATIVE_PATH_INVALID"]),
            "{path}:{observed}"
        );
    }
    let original = descriptor();
    let mut foreign = original.clone();
    foreign["extra"] = json!(true);
    let mut missing = original.clone();
    missing
        .as_object_mut()
        .unwrap()
        .remove("discovered_sources");
    let mut missing_content = original.clone();
    missing_content["discovered_sources"][0]
        .as_object_mut()
        .unwrap()
        .remove("content");
    for changed in [
        foreign,
        missing,
        missing_content,
        Value::Null,
        json!({}),
        json!({"analysis":descriptor()["analysis"],"discovered_sources":null}),
        json!({"analysis":descriptor()["analysis"],"discovered_sources":[{"relPath":"guard.ts","content":12}]}),
        json!({"analysis":descriptor()["analysis"],"discovered_sources":[{"relPath":"guard.ts","content":"export const guardFactory=97;","extra":true}]}),
    ] {
        let observed = run(changed, &sdk);
        assert_eq!(observed["executed"], false, "{observed}");
        assert!(
            observed["unsupported"][0]
                .as_str()
                .unwrap()
                .starts_with("RETAINED_DISCOVERY_REQUEST_INVALID:")
        );
    }
}
#[test]
fn retained_discovery_cli_does_not_skip_missing_inputs() {
    for args in [
        vec!["probe", "--analyze-retained-discovery"],
        vec!["probe", "--analyze-retained-discovery", "request.json"],
        vec![
            "probe",
            "--analyze-retained-discovery",
            "request.json",
            "sdk.json",
            "extra",
        ],
    ] {
        let args = args.into_iter().map(String::from).collect::<Vec<_>>();
        assert!(
            additional_observation(&args)
                .unwrap_err()
                .contains("expected --analyze-retained-discovery REQUEST.json SDK.json")
        );
    }
    let directory = std::env::temp_dir().join(format!(
        "retained-discovery-inputs-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir(&directory).unwrap();
    let request = directory.join("request.json");
    let sdk = directory.join("sdk.json");
    let args = vec![
        "probe".into(),
        "--analyze-retained-discovery".into(),
        request.to_string_lossy().into_owned(),
        sdk.to_string_lossy().into_owned(),
    ];
    assert!(additional_observation(&args).is_err());
    std::fs::write(&request, b"{").unwrap();
    assert!(additional_observation(&args).is_err());
    std::fs::write(&request, serde_json::to_vec(&descriptor()).unwrap()).unwrap();
    assert!(additional_observation(&args).is_err());
    std::fs::write(&sdk, b"{").unwrap();
    assert!(additional_observation(&args).is_err());
    std::fs::write(&sdk, b"{}").unwrap();
    assert!(additional_observation(&args).is_err());
    std::fs::remove_dir_all(directory).unwrap();
}
