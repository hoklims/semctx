use super::*;
use serde_json::{Value, json};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DiscoveredRequest {
    analysis: Request,
    discovered_sources: Vec<DiscoveredSource>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DiscoveredSource {
    rel_path: String,
    content: String,
}

pub(super) fn observe(descriptor: Value, sdk: &Sdk) -> Result<Value, String> {
    let request: DiscoveredRequest = serde_json::from_value(descriptor)
        .map_err(|error| format!("RETAINED_DISCOVERY_REQUEST_INVALID:{error}"))?;
    let analysis = &request.analysis;
    if !analysis.retained {
        return Err("SOURCE_SNAPSHOT_REQUIRED".into());
    }
    if !analysis.raw_files.is_empty() || !analysis.utf16_files.is_empty() {
        return Err("RETAINED_DISCOVERY_TEXT_CAPTURE_REQUIRED".into());
    }
    let normalizer = CaptureFs::new(BTreeMap::new(), analysis.case_sensitive);
    let mut captured = BTreeMap::new();
    for (path, content) in &analysis.files {
        if captured.insert(normalizer.key(path), content).is_some() {
            return Err(format!("conflicting captured key: {path}"));
        }
    }
    let mut roots = BTreeMap::new();
    for path in &analysis.roots {
        let relative = relative_source_path(&analysis.cwd, path, analysis.case_sensitive)?;
        if [".d.ts", ".d.mts", ".d.cts"]
            .iter()
            .any(|suffix| path.ends_with(suffix))
        {
            continue;
        }
        if ![".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]
            .iter()
            .any(|suffix| path.ends_with(suffix))
        {
            return Err(format!("RETAINED_DISCOVERY_UNSUPPORTED_SOURCE:{relative}"));
        }
        if roots.insert(normalizer.key(path), relative).is_some() {
            return Err("RETAINED_DISCOVERY_DUPLICATE_ROOT".into());
        }
    }
    if roots.is_empty() {
        return Err("RETAINED_DISCOVERY_SOURCE_ROOT_REQUIRED".into());
    }
    let mut discovered = BTreeMap::new();
    for source in request.discovered_sources {
        if source.rel_path.is_empty()
            || source.rel_path.contains(['\\', ':', '\0'])
            || source
                .rel_path
                .split('/')
                .any(|part| matches!(part, "" | "." | ".."))
        {
            return Err("RETAINED_DISCOVERY_RELATIVE_PATH_INVALID".into());
        }
        let key = normalizer.key(&format!("{}/{}", analysis.cwd, source.rel_path));
        if !roots.contains_key(&key) {
            return Err(format!(
                "RETAINED_DISCOVERY_FOREIGN_SOURCE:{}",
                source.rel_path
            ));
        }
        if discovered.insert(key, source.content).is_some() {
            return Err("RETAINED_DISCOVERY_DUPLICATE_SOURCE".into());
        }
    }
    for (key, relative) in &roots {
        let content = discovered
            .get(key)
            .ok_or_else(|| format!("RETAINED_DISCOVERY_SOURCE_MISSING:{relative}"))?;
        if captured.get(key).copied() != Some(content) {
            return Err(format!("SOURCE_SNAPSHOT_MISMATCH: {relative}"));
        }
    }
    let observed = analyze(request.analysis, sdk.clone())?;
    Ok(
        json!({"state":"RETAINED_DISCOVERY_OBSERVED","executed":true,"snapshot_guard_passed":true,"unsupported":[],"native_analysis":observed,"global_admission_inferred":false}),
    )
}

pub fn run(descriptor: Value, sdk: &Sdk) -> Value {
    observe(descriptor, sdk).unwrap_or_else(|error| json!({"state":"RETAINED_DISCOVERY_REFUSED","executed":false,"snapshot_guard_passed":false,"unsupported":[error],"global_admission_inferred":false}))
}

#[cfg(test)]
mod tests {
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
        changed["discovered_sources"][0]["content"] =
            json!("export const changedBeforeAnalysis=107;");
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
}
