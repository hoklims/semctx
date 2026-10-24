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

#[test]
fn structured_facts_connect_syntax_types_and_signature_parameters() {
    let sdk = std::env::var("T00_ORACLE_TEST_SDK").expect("explicit TS7 SDK test input");
    let dir = std::env::temp_dir().join(format!("t00-semantic-structured-{}", std::process::id()));
    fs::create_dir_all(&dir).unwrap();
    let request = dir.join("request.json");
    fs::write(&request, json!({"files": {
        "/project/main.ts": "declare const choice: string | number; declare const combined: {a: number} & {b: string}; const callback = (value: number) => value + 1; const result = Math.max(...[1, 2]); const object = new Date(); [1].map(callback); type Recursive = () => Recursive; declare const recursive: Recursive; recursive();"
    }}).to_string()).unwrap();
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
    let nodes = facts["files"][0]["nodes"].as_array().unwrap();
    let call = nodes
        .iter()
        .find(|node| node["text"] == "Math.max(...[1, 2])")
        .unwrap();
    assert_eq!(
        call["fields"]["expression"]["kind"],
        "PropertyAccessExpression"
    );
    let reference = &call["fields"]["expression"];
    let callee = nodes
        .iter()
        .find(|node| {
            node["kind"] == reference["kind"]
                && node["start"] == reference["start"]
                && node["end"] == reference["end"]
        })
        .unwrap();
    assert_eq!(callee["parent"]["start"], call["start"]);
    assert!(call["children"].as_array().unwrap().contains(reference));
    assert_eq!(
        call["signature"]["parameters"][0]["type"]["text"],
        "number[]"
    );
    assert_eq!(call["signature"]["hasRestParameter"], true);
    assert_eq!(
        call["signature"]["parameters"][0]["type"]["numberIndexType"]["flagsBits"],
        64
    );
    assert_eq!(callee["receiverPropertySymbol"]["name"], "max");
    assert!(
        call["signature"]["parameters"][0]["type"]["computedProperties"]
            .as_array()
            .unwrap()
            .iter()
            .any(|property| {
                property["nameExpressionSymbol"]["name"] == "iterator"
                    && property["nameExpressionSymbol"]["declarations"][0]["defaultLibrary"] == true
            })
    );
    assert_eq!(callee["symbol"]["declarations"][0]["defaultLibrary"], true);
    assert_eq!(callee["symbol"]["declarations"][0]["parentName"], "Math");
    let union = nodes.iter().find(|node| node["text"] == "choice").unwrap();
    assert_eq!(union["type"]["unionTypes"].as_array().unwrap().len(), 2);
    let intersection = nodes
        .iter()
        .find(|node| node["text"] == "combined")
        .unwrap();
    assert_eq!(
        intersection["type"]["intersectionTypes"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    let binary = nodes
        .iter()
        .find(|node| node["text"] == "value + 1")
        .unwrap();
    assert_eq!(binary["fields"]["operatorToken"]["kind"], "PlusToken");
    assert_eq!(binary["fields"]["left"]["kind"], "Identifier");
    let constructor = nodes.iter().find(|node| node["text"] == "Date").unwrap();
    assert!(
        !constructor["type"]["constructSignatures"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    let callback = nodes
        .iter()
        .find(|node| node["text"] == "callback")
        .unwrap();
    assert_eq!(
        callback["symbol"]["declarations"][0]["defaultLibrary"],
        false
    );
    assert_eq!(
        callback["type"]["callSignatures"][0]["parameters"][0]["type"]["flagsBits"],
        64
    );
    let map_call = nodes
        .iter()
        .find(|node| node["text"] == "[1].map(callback)")
        .unwrap();
    assert_eq!(
        map_call["signature"]["parameters"][0]["type"]["callSignatureCount"],
        1
    );
    assert_eq!(
        map_call["signature"]["parameters"][0]["type"]["constructSignatureCount"],
        0
    );
    let recursive_call = nodes
        .iter()
        .find(|node| node["text"] == "recursive()")
        .unwrap();
    assert_eq!(
        recursive_call["signature"]["returnType"]["text"],
        "Recursive"
    );
    fs::remove_dir_all(dir).unwrap();
}
