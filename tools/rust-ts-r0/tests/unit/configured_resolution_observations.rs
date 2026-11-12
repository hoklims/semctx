use super::*;

fn descriptor() -> serde_json::Value {
    serde_json::json!({
        "root":"/repo", "sdk_directory":"/sdk/lib",
        "case_sensitive":ts_goport::frontend::vfs::osvfs_fs().use_case_sensitive_file_names(),
        "files":{"/repo/source.ts":"export const sourceDev = 61;", "/repo/leaf.ts":"export const leafDev = 67;"},
        "directories":["/repo/.git"], "containing_file":"/repo/source.ts", "specifier":"./leaf"
    })
}

fn sdk() -> Sdk {
    serde_json::from_slice(
        &std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/sdk/sdk-input.json")).unwrap(),
    )
    .unwrap()
}

#[test]
fn canonical_capture_aliases_do_not_create_phantom_parent_directories() {
    let mut value = descriptor();
    value["directories"] = serde_json::json!(["/repo/directory-phantom/../.git"]);
    value["files"]
        .as_object_mut()
        .unwrap()
        .remove("/repo/source.ts");
    value["files"]["/repo/source-phantom/../source.ts"] =
        serde_json::json!("export const sourceDev = 79;");
    let parsed: Request = serde_json::from_value(value.clone()).unwrap();
    let fs = capture(&parsed, &sdk()).unwrap();
    assert!(!fs.directory_exists("/repo/directory-phantom"));
    assert!(!fs.directory_exists("/repo/source-phantom"));
    assert!(fs.directory_exists("/repo/.git"));
    assert_eq!(run(value, &sdk())["resolved_relative_path"], "leaf.ts");
}

#[test]
fn explicit_query_refuses_ambiguous_or_unconfined_capture_and_foreign_sdk() {
    let original = descriptor();
    let mut invalid = vec![];
    let mut value = original.clone();
    value["surprise"] = serde_json::json!(true);
    invalid.push(value);
    let mut value = original.clone();
    value["files"]["/repo/./source.ts"] = serde_json::json!("alias");
    invalid.push(value);
    let mut value = original.clone();
    value["files"]["/repo/../outside.ts"] = serde_json::json!("outside");
    invalid.push(value);
    let mut value = original.clone();
    value["files"]["relative.ts"] = serde_json::json!("relative");
    invalid.push(value);
    let mut value = original.clone();
    value["files"]["/repo/parent"] = serde_json::json!("file");
    value["files"]["/repo/parent/child.ts"] = serde_json::json!("child");
    invalid.push(value);
    for directories in [
        serde_json::json!(["/repo/.git", "/repo/./.git"]),
        serde_json::json!(["/repo/source.ts"]),
        serde_json::json!(["/repo/source.ts/nested"]),
        serde_json::json!(["/repo/../outside"]),
        serde_json::json!(["relative"]),
    ] {
        let mut value = original.clone();
        value["directories"] = directories;
        invalid.push(value);
    }
    for source in ["/repo/missing.ts", "/outside.ts", "source.ts"] {
        let mut value = original.clone();
        value["containing_file"] = serde_json::json!(source);
        invalid.push(value);
    }
    let mut value = original.clone();
    value["case_sensitive"] = serde_json::json!(!original["case_sensitive"].as_bool().unwrap());
    invalid.push(value);
    let mut value = original.clone();
    value["sdk_directory"] = serde_json::json!("/repo/sdk");
    invalid.push(value);
    let mut value = original.clone();
    value["specifier"] = serde_json::json!("");
    invalid.push(value);
    for value in invalid {
        let observed = run(value, &sdk());
        assert_eq!(observed["executed"], false, "{observed}");
        assert!(!observed["unsupported"].as_array().unwrap().is_empty());
        assert!(observed.get("resolved_relative_path").is_none());
    }
    let mut foreign = sdk();
    foreign.version = "7.1.0-dev".into();
    assert_eq!(run(original.clone(), &foreign)["executed"], false);
    let mut foreign = sdk();
    foreign.archive_sha256 = "wrong".into();
    assert_eq!(run(original.clone(), &foreign)["executed"], false);
    let mut foreign = sdk();
    foreign.files.clear();
    assert_eq!(run(original.clone(), &foreign)["executed"], false);
    let mut foreign = sdk();
    foreign
        .files
        .insert("/sdk/lib/../escape.d.ts".into(), "escape".into());
    assert_eq!(run(original.clone(), &foreign)["executed"], false);
    assert_eq!(run(original, &sdk())["resolved_relative_path"], "leaf.ts");
}

#[test]
fn explicit_query_keeps_unresolved_distinct_from_native_resolution_failure_and_restoration() {
    let mut value = descriptor();
    value["specifier"] = serde_json::json!("missing-dev");
    let missing = run(value.clone(), &sdk());
    assert_eq!(missing["executed"], true);
    assert_eq!(missing["unsupported"], serde_json::json!([]));
    assert_eq!(missing["resolved_relative_path"], serde_json::Value::Null);
    assert_eq!(missing["native_error"], serde_json::Value::Null);
    value["specifier"] = serde_json::json!("failure-dev");
    value["files"]["/repo/node_modules/failure-dev/index.ts"] =
        serde_json::json!("export const failureDev = 71;");
    for mapping in [
        serde_json::json!("index.ts"),
        serde_json::json!([7]),
        serde_json::json!(["index.ts"]),
    ] {
        value["files"]["/repo/node_modules/failure-dev/package.json"] = serde_json::json!(
            serde_json::json!({"types":"index.ts","typesVersions":{"<6":{"*":mapping}}})
                .to_string()
        );
        let observed = run(value.clone(), &sdk());
        assert_eq!(observed["executed"], true, "{observed}");
        if mapping == serde_json::json!(["index.ts"]) {
            assert_eq!(observed["unsupported"], serde_json::json!([]));
            assert_eq!(observed["native_error"], serde_json::Value::Null);
            assert_eq!(
                observed["resolved_relative_path"],
                "node_modules/failure-dev/index.ts"
            );
        } else {
            assert!(
                observed["unsupported"]
                    .as_array()
                    .unwrap()
                    .contains(&serde_json::json!("NATIVE_MODULE_RESOLUTION_ERROR")),
                "{observed}"
            );
            assert!(
                observed["native_error"]
                    .as_str()
                    .is_some_and(|error| error.contains("VERSION_PATH")),
                "{observed}"
            );
            assert!(
                !observed["resolutionObservations"]["errors"]
                    .as_object()
                    .unwrap()
                    .is_empty()
            );
        }
    }
}

#[test]
fn configured_optional_boundary_preserves_physical_capture_and_git_declaration_stop() {
    // DEV input, derived from the baseline optional-root API contract.
    let mut value = descriptor();
    value["root"] = serde_json::json!("/capture");
    value["containing_file"] = serde_json::json!("/capture/repo/pkg/src/main.ts");
    value["specifier"] = serde_json::json!("#shared");
    value["directories"] = serde_json::json!(["/capture/repo/.git"]);
    value["repository_boundary"] = serde_json::json!({"mode":"absent"});
    value["files"] = serde_json::json!({
        "/capture/pnpm-workspace.yaml":"packages:\n  - 'repo/*'\n",
        "/capture/repo/pkg/package.json":"{\"name\":\"consumer\",\"devDependencies\":{\"config\":\"workspace:*\"}}",
        "/capture/repo/pkg/tsconfig.json":"{\"extends\":\"config/tsconfig.json\"}",
        "/capture/repo/pkg/src/main.ts":"export const main = 1;",
        "/capture/repo/pkg/src/leaf.ts":"export const leaf = 2;",
        "/capture/repo/config/package.json":"{\"name\":\"config\",\"version\":\"1.0.0\"}",
        "/capture/repo/config/tsconfig.json":"{\"compilerOptions\":{\"baseUrl\":\".\",\"paths\":{\"#shared\":[\"shared.ts\"]}}}",
        "/capture/repo/config/shared.ts":"export const shared = 3;"
    });
    let libraries = sdk();
    let parsed: Request = serde_json::from_value(value.clone()).unwrap();
    let captured = capture(&parsed, &libraries).unwrap();
    assert!(
        captured
            .files
            .contains_key(&captured.key("/capture/pnpm-workspace.yaml"))
    );
    assert!(captured.read_file("/capture/repo/pkg/tsconfig.json").1);
    let observed = run(value.clone(), &libraries);
    assert_eq!(observed["executed"], true, "{observed}");
    assert_eq!(observed["unsupported"], serde_json::json!([]), "{observed}");
    assert_eq!(observed["resolved_file_name"], serde_json::Value::Null);
    assert!(
        observed["configuration"]["reasons"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r
                .as_str()
                .unwrap()
                .starts_with("SOURCE_CONFIGURATION_INVALID:6053:"))
    );
    assert!(
        observed["workspaceMappings"]
            .as_object()
            .unwrap()
            .is_empty()
    );
    assert!(
        observed["probes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|p| p["operation"] == "read_file"
                && p["path"] == "/capture/repo/pkg/tsconfig.json"
                && p["found"] == true
                && p["content_id"].is_string())
    );
    let config_text = value["files"]["/capture/repo/pkg/tsconfig.json"]
        .as_str()
        .unwrap();
    assert!(
        observed["probes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|p| p["operation"] == "read_file"
                && p["path"] == "/capture/repo/pkg/tsconfig.json"
                && p["content_id"] == identity::digest_bytes(config_text.as_bytes()))
    );
    value["specifier"] = serde_json::json!("./leaf");
    let positive = run(value.clone(), &libraries);
    assert_eq!(positive["executed"], true, "{positive}");
    assert_eq!(positive["resolved_relative_path"], "repo/pkg/src/leaf.ts");
    value["files"]["/capture/repo/package.json"] =
        serde_json::json!("{\"private\":true,\"workspaces\":[\"pkg\",\"config\"]}");
    value["specifier"] = serde_json::json!("#shared");
    let inner = run(value.clone(), &libraries);
    assert_eq!(inner["executed"], true, "{inner}");
    assert_eq!(inner["unsupported"], serde_json::json!([]), "{inner}");
    assert_eq!(
        inner["resolved_relative_path"], "repo/config/shared.ts",
        "{inner}"
    );
    for source_or_directory in [true, false] {
        let mut outside = value.clone();
        if source_or_directory {
            outside["files"]["/outside/escape.ts"] = serde_json::json!("foreign");
        } else {
            outside["directories"]
                .as_array_mut()
                .unwrap()
                .push(serde_json::json!("/outside"));
        }
        assert_eq!(run(outside, &libraries)["executed"], false);
    }
    let mut explicit = value.clone();
    explicit
        .as_object_mut()
        .unwrap()
        .remove("repository_boundary");
    assert_eq!(run(explicit, &libraries)["executed"], false);
    value["repository_boundary"] = serde_json::json!({"mode":"capture_root"});
    assert_eq!(run(value.clone(), &libraries)["executed"], false);
    for boundary in [
        serde_json::Value::Null,
        serde_json::json!({"mode":"unknown"}),
        serde_json::json!({"mode":"absent","surprise":true}),
    ] {
        value["repository_boundary"] = boundary;
        assert_eq!(run(value.clone(), &libraries)["executed"], false);
    }
}
