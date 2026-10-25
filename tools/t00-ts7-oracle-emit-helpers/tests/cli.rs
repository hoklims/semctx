mod support;

use serde_json::json;
use std::{fs, process::Command};

#[test]
fn invalid_requests_fail_without_fact_output() {
    let directory = std::env::temp_dir().join(format!(
        "t00-emit-helpers-oracle-invalid-{}",
        std::process::id()
    ));
    fs::create_dir_all(&directory).unwrap();
    let absent = directory.join("missing");
    let empty_sdk = directory.join("empty-sdk");
    fs::create_dir_all(&empty_sdk).unwrap();
    let sdk_file = directory.join("sdk-file");
    fs::write(&sdk_file, "not a directory").unwrap();
    let corrupt_sdk = directory.join("corrupt-sdk");
    fs::create_dir_all(corrupt_sdk.join("lib.d.ts")).unwrap();
    for (index, request) in [
        "not json".to_string(),
        json!({}).to_string(),
        json!({"sdk_directory":17}).to_string(),
        json!({"sdk_directory":absent}).to_string(),
        json!({"sdk_directory":sdk_file}).to_string(),
        json!({"sdk_directory":empty_sdk}).to_string(),
        json!({"sdk_directory":corrupt_sdk}).to_string(),
        json!({"options":17}).to_string(),
        json!({"options":{"unknown":true}}).to_string(),
        json!({"options":{"target":true}}).to_string(),
        json!({"options":{"target":"ES5"}}).to_string(),
        json!({"options":{"module":"amd"}}).to_string(),
        json!({"options":{"target":"unknown"}}).to_string(),
        json!({"options":{"importHelpers":"true"}}).to_string(),
    ]
    .iter()
    .enumerate()
    {
        let path = directory.join(format!("request-{index}.json"));
        fs::write(&path, request).unwrap();
        let output = Command::new(env!("CARGO_BIN_EXE_t00-ts7-oracle-emit-helpers"))
            .env_remove("GOPORT_BUILD_VERSION")
            .arg(path)
            .output()
            .unwrap();
        assert!(!output.status.success(), "invalid request {index} accepted");
        assert!(output.stdout.is_empty());
        assert!(!output.stderr.is_empty());
    }
    let missing_request = Command::new(env!("CARGO_BIN_EXE_t00-ts7-oracle-emit-helpers"))
        .arg(directory.join("absent-request.json"))
        .output()
        .unwrap();
    assert!(!missing_request.status.success());
    assert!(missing_request.stdout.is_empty());
    let missing_argument = Command::new(env!("CARGO_BIN_EXE_t00-ts7-oracle-emit-helpers"))
        .output()
        .unwrap();
    assert_eq!(missing_argument.status.code(), Some(2));
    assert!(missing_argument.stdout.is_empty());
    let forged_version_request = directory.join("version.json");
    fs::write(&forged_version_request, "{}").unwrap();
    let forged_version = Command::new(env!("CARGO_BIN_EXE_t00-ts7-oracle-emit-helpers"))
        .env("GOPORT_BUILD_VERSION", "forged-version")
        .arg(forged_version_request)
        .output()
        .unwrap();
    assert!(!forged_version.status.success());
    assert!(forged_version.stdout.is_empty());
    assert!(String::from_utf8_lossy(&forged_version.stderr).contains("GOPORT_BUILD_VERSION"));
    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn absolute_source_paths_preserve_authored_casing_and_compiler_facts() {
    let executable = std::path::Path::new(env!("CARGO_BIN_EXE_t00-ts7-oracle-emit-helpers"));
    let sdk = support::install_sdk(executable);
    let directory = std::env::temp_dir().join(format!(
        "t00-emit-helpers-oracle-absolute-{}",
        std::process::id()
    ));
    fs::create_dir_all(&directory).unwrap();
    let mut observations = Vec::new();
    for (index, filename) in ["main.jsx", "/Users/CaseSensitive/Repository/Main.jsx"]
        .iter()
        .enumerate()
    {
        let request = directory.join(format!("request-{index}.json"));
        fs::write(&request, json!({
            "sdk_directory":sdk,"file_name":filename,
            "source":"export async function run() { return 1; }\n",
            "options":{"target":"es2015","module":"esnext","moduleResolution":"bundler","jsx":"preserve","importHelpers":true}
        }).to_string()).unwrap();
        let output = Command::new(executable)
            .env_remove("GOPORT_BUILD_VERSION")
            .arg(request)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{filename}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let result: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(result["observation"]["imports"], json!(["tslib"]));
        observations.push(result["observation"].clone());
    }
    observations[0].as_object_mut().unwrap().remove("fileName");
    assert_eq!(
        observations[1]["fileName"],
        "/Users/CaseSensitive/Repository/Main.jsx"
    );
    observations[1].as_object_mut().unwrap().remove("fileName");
    assert_eq!(observations[0], observations[1]);
    fs::remove_dir_all(directory).unwrap();
}
