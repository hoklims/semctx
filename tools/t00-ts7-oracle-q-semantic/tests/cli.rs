use serde_json::{Value, json};
use std::{fs, process::Command};

#[test]
fn compiler_facts_preserve_sdk_origin_aliases_and_signatures() {
    let sdk = std::env::var("T00_ORACLE_TEST_SDK").expect("explicit TS7 SDK test input");
    let dir = std::env::temp_dir().join(format!("t00-semantic-oracle-test-{}", std::process::id()));
    fs::create_dir_all(&dir).unwrap();
    let request = dir.join("request.json");
    fs::write(&request, serde_json::to_vec(&json!({"files": {
        "/project/dependency.ts": "export const identity = (value: number) => value;",
        "/project/main.ts": "import {identity as local} from './dependency'; export const answer = Math.abs(local(-42));"
    }})).unwrap()).unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_t00-ts7-oracle-q-semantic"))
        .env("GOPORT_LIB_PARSE_SNAPSHOT", "0")
        .env("GOPORT_LIB_SNAPSHOT", "0")
        .args([request.to_str().unwrap(), &sdk])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let facts: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(facts["sdkLibraries"], 115);
    let nodes = facts["files"]
        .as_array()
        .unwrap()
        .iter()
        .find(|file| file["path"] == "/project/main.ts")
        .unwrap()["nodes"]
        .as_array()
        .unwrap();
    assert!(nodes.iter().any(|node| {
        node["text"] == "Math.abs"
            && node["symbol"]["declarations"]
                .as_array()
                .unwrap()
                .iter()
                .any(|declaration| declaration["sdk"] == true)
    }));
    assert!(
        nodes
            .iter()
            .any(|node| node["text"] == "local" && node["aliasedSymbol"]["name"] == "identity")
    );
    assert!(nodes.iter().any(|node| {
        node["kind"] == "CallExpression"
            && node["signature"]["text"]
                .as_str()
                .is_some_and(|text| text.contains("number"))
    }));
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn invalid_inputs_fail_without_fact_output() {
    let sdk = std::env::var("T00_ORACLE_TEST_SDK").expect("explicit TS7 SDK test input");
    let dir = std::env::temp_dir().join(format!(
        "t00-semantic-oracle-invalid-{}",
        std::process::id()
    ));
    fs::create_dir_all(&dir).unwrap();
    for (index, request) in [
        "not json".to_string(),
        json!({"files": {}}).to_string(),
        json!({"files":{"/project/a.ts":"const x = 1"},"options":{"strict":true}}).to_string(),
        json!({"files":{"/project/../escape.ts":"const x = 1"}}).to_string(),
        json!({"files":{"/project/a.ts":"const x = 1"},"roots":["/project/missing.ts"]})
            .to_string(),
    ]
    .iter()
    .enumerate()
    {
        let path = dir.join(format!("{index}.json"));
        fs::write(&path, request).unwrap();
        let output = Command::new(env!("CARGO_BIN_EXE_t00-ts7-oracle-q-semantic"))
            .env("GOPORT_LIB_PARSE_SNAPSHOT", "0")
            .env("GOPORT_LIB_SNAPSHOT", "0")
            .args([path.to_str().unwrap(), &sdk])
            .output()
            .unwrap();
        assert!(!output.status.success(), "invalid request {index} accepted");
        assert!(output.stdout.is_empty());
    }
    let request = dir.join("valid.json");
    fs::write(
        &request,
        json!({"files":{"/project/a.ts":"const x = 1"}}).to_string(),
    )
    .unwrap();
    let mut foreign_sdk: Value = serde_json::from_slice(&fs::read(&sdk).unwrap()).unwrap();
    foreign_sdk["version"] = json!("5.9.3");
    for (index, content) in [
        Some(foreign_sdk.to_string()),
        Some(json!({"version":"7.1.0-dev","files":{}}).to_string()),
        Some("not json".to_string()),
        None,
    ]
    .iter()
    .enumerate()
    {
        let invalid_sdk = dir.join(format!("sdk-{index}.json"));
        if let Some(content) = content {
            fs::write(&invalid_sdk, content).unwrap();
        }
        let output = Command::new(env!("CARGO_BIN_EXE_t00-ts7-oracle-q-semantic"))
            .env("GOPORT_LIB_PARSE_SNAPSHOT", "0")
            .env("GOPORT_LIB_SNAPSHOT", "0")
            .args([request.to_str().unwrap(), invalid_sdk.to_str().unwrap()])
            .output()
            .unwrap();
        assert!(!output.status.success(), "invalid SDK {index} accepted");
        assert!(output.stdout.is_empty());
    }
    fs::remove_dir_all(dir).unwrap();
}
