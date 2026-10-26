use serde_json::{Value, json};
use std::{path::PathBuf, process::Command};

fn observe(request: Value, name: &str) -> Value {
    let path = std::env::temp_dir().join(format!(
        "semctx-extraction-oracle-{name}-{}.json",
        std::process::id()
    ));
    std::fs::write(&path, serde_json::to_vec(&request).unwrap()).unwrap();
    let sdk = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../rust-ts-r0/sdk/sdk-input.json");
    let output = Command::new(env!("CARGO_BIN_EXE_t00-ts7-oracle-q-extraction"))
        .arg(&path)
        .arg(sdk)
        .env_remove("GOPORT_BUILD_VERSION")
        .env("GOPORT_LIB_PARSE_SNAPSHOT", "0")
        .env("GOPORT_LIB_SNAPSHOT", "0")
        .output()
        .unwrap();
    std::fs::remove_file(path).unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}

#[test]
fn dynamic_literal_imports_keep_native_resolution_without_proven_bindings() {
    let observation = observe(
        json!({"files":{
        "/project/spec.ts":"export async function spec() { return import('./main'); }\nexport async function missing() { return import('./absent'); }",
        "/project/main.ts":"export function main(){return 1;}"
    },"roots":["/project/spec.ts"]}),
        "dynamic-resolution",
    );
    assert_eq!(
        observation["imports"],
        json!([
            {"fromRelPath":"spec.ts","moduleSpecifier":"./main","names":[],"line":1,"resolvedRelPath":"main.ts"},
            {"fromRelPath":"spec.ts","moduleSpecifier":"./absent","names":[],"line":2}
        ])
    );
    let native = observation["resolvedModuleSpecifiers"].as_array().unwrap();
    assert!(
        native
            .iter()
            .any(|specifier| specifier["moduleSpecifier"] == "./main"
                && specifier["resolvedRelPath"] == "main.ts")
    );
    assert!(
        native
            .iter()
            .any(|specifier| specifier["moduleSpecifier"] == "./absent"
                && specifier.get("resolvedRelPath").is_none())
    );
}

#[test]
fn ordinary_imports_keep_local_names_and_omit_retained_binding_targets() {
    for retained in [false, true] {
        let observation = observe(
            json!({"files":{
            "/project/spec.ts":"import { main as renamed } from './main'; export function spec() { return renamed(); }",
            "/project/main.ts":"export function main(){return 1;}"
        },"roots":["/project/spec.ts"],"retained":retained}),
            if retained {
                "retained-bindings"
            } else {
                "ordinary-bindings"
            },
        );
        let import = &observation["imports"][0];
        assert_eq!(import["resolvedRelPath"], "main.ts");
        if retained {
            assert_eq!(import["names"], json!(["main"]));
            assert_eq!(
                import["bindingTargets"],
                json!([{"relPath":"main.ts","symbolPath":"main"}])
            );
        } else {
            assert_eq!(import["names"], json!(["renamed"]));
            assert!(import.get("bindingTargets").is_none());
        }
    }
}

#[test]
fn ts7_checker_separates_runtime_alias_references_from_type_queries() {
    let observation = observe(
        json!({"files":{
            "/project/a.ts":"import { leaf, unused } from './b'; export function outer(){return leaf();} type T = typeof unused;",
            "/project/b.ts":"export function leaf(){return 1;} export function unused(){return 2;}"
        },"roots":["/project/a.ts"]}),
        "runtime-aliases",
    );
    assert_eq!(observation["modules"], json!(["b.ts", "a.ts"]));
    assert_eq!(
        observation["imports"][0]["bindingTargets"],
        json!([
            {"relPath":"b.ts","symbolPath":"leaf"},
            {"relPath":"b.ts","symbolPath":"unused","runtimeUsed":false}
        ])
    );
    assert_eq!(observation["calls"][0]["calleeRelPath"], "b.ts");
    assert_eq!(
        observation["resolvedModuleSpecifiers"][0]["resolvedRelPath"],
        "b.ts"
    );
}
