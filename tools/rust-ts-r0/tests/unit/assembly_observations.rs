
use super::*;

fn fixture() -> (Value, Sdk) {
    let sensitive = ts_goport::frontend::vfs::osvfs_fs().use_case_sensitive_file_names();
    let analysis = json!({"id":"controlledAssemblyDev","cwd":"/repo","sdk_directory":"/sdk/lib","case_sensitive":sensitive,"roots":["/repo/factory.ts","/repo/use.test.ts"],"files":{"/repo/factory.ts":"export function nativeOwnedFactory(){return 67;}","/repo/use.test.ts":"export async function observedCheck(){const dep=await import('./factory');return dep.nativeOwnedFactory();}","/repo/package.json":"{\"type\":\"module\"}"},"options":{"target":"ES2022","module":"ESNext","moduleResolution":"Bundler","allowJs":true,"jsx":"Preserve","skipLibCheck":true,"noEmit":true,"strict":false},"roles":{"factory.ts":"source","use.test.ts":"test"},"selection":{},"disabled":[],"retained":true,"qualified":true,"utf16_files":{},"raw_files":{}});
    let descriptor = json!({"analysis":analysis,"control":{"fromRelPath":"use.test.ts","moduleSpecifier":"./factory","line":1,"bindingTargets":[{"relPath":"factory.ts","symbolPath":"nativeOwnedFactory"}]}});
    let sdk = serde_json::from_slice(
        &std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/sdk/sdk-input.json")).unwrap(),
    )
    .unwrap();
    (descriptor, sdk)
}

#[test]
fn private_consumer_distinguishes_defined_binding_arrays_without_public_reachability_credit() {
    let (descriptor, sdk) = fixture();
    let bound = run(descriptor.clone(), &sdk);
    assert_eq!(bound["executed"], true, "{bound}");
    assert_eq!(bound["unsupported"], json!([]));
    assert_eq!(
        bound["native_original_import"]["bindingTargets"],
        Value::Null
    );
    assert!(
        bound["native_original_import"]
            .get("bindingTargets")
            .is_none()
    );
    assert_eq!(
        bound["dynamic_imports"],
        json!([["use.test.ts", 1, "./factory"]])
    );
    assert!(
        bound["assembly"]["integrityReasons"]
            .as_object()
            .unwrap()
            .is_empty()
    );
    let coverage = |value: &Value| {
        value["assembly"]["edges"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|edge| edge["kind"] == "covers" || edge["kind"] == "tested_by")
            .count()
    };
    assert_eq!(coverage(&bound), 2);
    assert_eq!(bound["public_extractor_reachability_claimed"], false);
    assert_eq!(bound["global_admission_inferred"], false);
    let mut missing_coordinate = descriptor.clone();
    missing_coordinate["control"]["bindingTargets"][0]["symbolPath"] = json!("missingFactory");
    let missing_coordinate = run(missing_coordinate, &sdk);
    assert_eq!(missing_coordinate["executed"], true);
    assert_eq!(coverage(&missing_coordinate), 0);
    assert_eq!(
        missing_coordinate["assembly"]["integrityReasons"]["use.test.ts"],
        json!(["QUALIFIED_TEST_BINDING_MISSING:factory.ts:missingFactory"])
    );
    let mut empty = descriptor;
    empty["control"]["bindingTargets"] = json!([]);
    let empty = run(empty, &sdk);
    assert_eq!(empty["executed"], true, "{empty}");
    assert_eq!(empty["controlled_import"]["bindingTargets"], json!([]));
    assert!(
        empty["assembly"]["integrityReasons"]
            .as_object()
            .unwrap()
            .is_empty()
    );
    assert_eq!(coverage(&empty), 0);
    assert_eq!(
        empty["native_original_import"],
        bound["native_original_import"]
    );
}

#[test]
fn private_control_rejects_missing_malformed_or_foreign_context() {
    let (descriptor, sdk) = fixture();
    let mut malformed = vec![json!({})];
    for replacement in [
        Value::Null,
        json!("absent"),
        json!({}),
        json!([{"relPath":"factory.ts"}]),
        json!([{"relPath":"factory.ts","symbolPath":"nativeOwnedFactory","runtimeUsed":true}]),
    ] {
        let mut bad = descriptor.clone();
        bad["control"]["bindingTargets"] = replacement;
        malformed.push(bad);
    }
    let mut missing = descriptor.clone();
    missing["control"]
        .as_object_mut()
        .unwrap()
        .remove("bindingTargets");
    malformed.push(missing);
    let mut extra = descriptor.clone();
    extra["request_descriptor_id"] = json!("forged");
    malformed.push(extra);
    let mut wrong_mode = descriptor.clone();
    wrong_mode["analysis"]["qualified"] = json!(false);
    malformed.push(wrong_mode);
    let mut raw = descriptor.clone();
    raw["analysis"]["raw_files"] = json!({"/repo/raw.ts":{"bytes":[65],"profile":"retained_utf8"}});
    assert_eq!(
        run(raw.clone(), &sdk)["unsupported"],
        json!(["CONTROLLED_ASSEMBLY_TEXT_CAPTURE_REQUIRED"])
    );
    malformed.push(raw);
    let mut decoded = descriptor.clone();
    decoded["analysis"]["utf16_files"] = json!({"/repo/decoded.ts":[65]});
    assert_eq!(
        run(decoded.clone(), &sdk)["unsupported"],
        json!(["CONTROLLED_ASSEMBLY_TEXT_CAPTURE_REQUIRED"])
    );
    malformed.push(decoded);
    let mut source_role = descriptor.clone();
    source_role["analysis"]["roles"]["use.test.ts"] = json!("source");
    malformed.push(source_role);
    let mut two_arguments = descriptor.clone();
    two_arguments["analysis"]["files"]["/repo/use.test.ts"] = json!(
        "export async function observedCheck(){return import('./factory',{with:{type:'json'}});}"
    );
    malformed.push(two_arguments);
    let mut absent = descriptor.clone();
    absent["control"]["line"] = json!(2);
    malformed.push(absent);
    let mut ambiguous = descriptor.clone();
    ambiguous["analysis"]["files"]["/repo/use.test.ts"] = json!(
        "export async function observedCheck(){await import('./factory');return import('./factory');}"
    );
    malformed.push(ambiguous);
    for bad in malformed {
        let refused = run(bad, &sdk);
        assert_eq!(refused["state"], "CONTROLLED_ASSEMBLY_REFUSED", "{refused}");
        assert_eq!(refused["executed"], false);
        assert!(!refused["unsupported"].as_array().unwrap().is_empty());
        assert_eq!(refused["global_admission_inferred"], false);
    }
    let mut empty_sdk = sdk;
    empty_sdk.files.clear();
    assert_eq!(run(descriptor, &empty_sdk)["executed"], false);
}

#[test]
fn private_command_requires_sdk_and_binds_actual_descriptor_and_artifact() {
    let (descriptor, sdk) = fixture();
    let root = std::env::temp_dir().join(format!(
        "semctx-controlled-assembly-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir(&root).unwrap();
    let path = root.join("descriptor.json");
    let sdk_path = root.join("sdk.json");
    std::fs::write(&path, serde_json::to_vec(&descriptor).unwrap()).unwrap();
    std::fs::write(&sdk_path, serde_json::to_vec(&sdk).unwrap()).unwrap();
    let args = vec![
        "probe".to_owned(),
        "--observe-controlled-assembly".to_owned(),
        path.to_string_lossy().into_owned(),
        sdk_path.to_string_lossy().into_owned(),
    ];
    for count in [2, 3] {
        assert!(additional_observation(&args[..count]).is_err());
    }
    let mut extra = args.clone();
    extra.push("extra".into());
    assert!(additional_observation(&extra).is_err());
    let observed = additional_observation(&args)
        .unwrap()
        .expect("recognized private command");
    assert_eq!(observed["executed"], true, "{observed}");
    assert_eq!(
        observed["request_descriptor_id"],
        identity::digest(&descriptor)
    );
    assert_eq!(
        observed["sdk_input_id"],
        identity::digest(&serde_json::to_value(sdk).unwrap())
    );
    assert_eq!(
        observed["producer_artifact_id"],
        identity::digest_bytes(&std::fs::read(std::env::current_exe().unwrap()).unwrap())
    );
    std::fs::remove_dir_all(root).unwrap();
}
