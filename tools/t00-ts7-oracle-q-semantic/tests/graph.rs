mod support;

use serde_json::{Value, json};
use std::{fs, path::Path, process::Command};

fn invoke(directory: &Path, request: &Value) -> std::process::Output {
    let sdk = support::canonical_sdk();
    let path = directory.join("request.json");
    fs::write(&path, request.to_string()).unwrap();
    Command::new(env!("CARGO_BIN_EXE_t00-ts7-oracle-q-semantic"))
        .env("GOPORT_LIB_PARSE_SNAPSHOT", "0")
        .env("GOPORT_LIB_SNAPSHOT", "0")
        .args([path.to_str().unwrap(), sdk])
        .output()
        .unwrap()
}

fn facts(directory: &Path, request: &Value) -> Value {
    let output = invoke(directory, request);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}

#[test]
fn graph_queries_resolve_properties_and_location_types_across_fresh_processes() {
    let directory = std::env::temp_dir().join(format!("t00-semantic-graph-{}", std::process::id()));
    fs::create_dir_all(&directory).unwrap();
    let mut request = json!({"files":{"/project/main.ts":"export const callbacks: {run: (value: number) => number} = {run: value => value}; type Recursive = () => Recursive; declare const recursive: Recursive; recursive();"}});
    let first = facts(&directory, &request);
    let file = &first["files"][0];
    let graph = &file["factsGraph"];
    assert_eq!(graph["truncated"], false);
    let callbacks = file["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|node| node["kind"] == "Identifier" && node["literalText"] == "callbacks")
        .unwrap();
    let target = graph["types"]
        .as_array()
        .unwrap()
        .iter()
        .find(|ty| ty["id"] == callbacks["typeId"])
        .unwrap();
    let property_query = json!({"id":"callbacks-properties","file":"/project/main.ts","route":target["route"],"operation":"properties"});
    request["factQueries"] = json!([property_query]);
    let second = facts(&directory, &request);
    let graph = &second["files"][0]["factsGraph"];
    let properties = graph["queryResults"][0]["value"].as_array().unwrap();
    assert_eq!(properties.len(), 1);
    let member = graph["symbols"]
        .as_array()
        .unwrap()
        .iter()
        .find(|symbol| symbol["id"] == properties[0])
        .unwrap();
    assert_eq!(member["name"], "run");
    request["factQueries"].as_array_mut().unwrap().push(json!({"id":"callback-type","file":"/project/main.ts","route":member["route"],"operation":"symbolType","location":callbacks["anchor"]}));
    let third = facts(&directory, &request);
    let graph = &third["files"][0]["factsGraph"];
    let target = graph["types"]
        .as_array()
        .unwrap()
        .iter()
        .find(|ty| ty["id"] == graph["queryResults"][1]["value"])
        .unwrap();
    assert_eq!(target["callSignatures"].as_array().unwrap().len(), 1);
    let signature = graph["signatures"]
        .as_array()
        .unwrap()
        .iter()
        .find(|signature| signature["id"] == target["callSignatures"][0])
        .unwrap();
    assert_eq!(signature["parameters"].as_array().unwrap().len(), 1);
    let source = third["files"][0]["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|node| node["kind"] == "SourceFile")
        .unwrap();
    let mut export_route = source["route"].clone();
    export_route["steps"]
        .as_array_mut()
        .unwrap()
        .push(json!({"op":"symbol"}));
    request["factQueries"].as_array_mut().unwrap().push(json!({"id":"exports","file":"/project/main.ts","route":export_route,"operation":"moduleExports"}));
    let fourth = facts(&directory, &request);
    let exports = fourth["files"][0]["factsGraph"]["queryResults"][2]["value"]
        .as_array()
        .unwrap();
    assert_eq!(exports.len(), 1);
    let exported = fourth["files"][0]["factsGraph"]["symbols"]
        .as_array()
        .unwrap()
        .iter()
        .find(|symbol| symbol["id"] == exports[0])
        .unwrap();
    assert_eq!(exported["name"], "callbacks");
    let recursive = third["files"][0]["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|node| node["text"] == "recursive()")
        .unwrap();
    let recursive_signature = graph["signatures"]
        .as_array()
        .unwrap()
        .iter()
        .find(|signature| signature["id"] == recursive["signatureId"])
        .unwrap();
    let recursive_type = graph["types"]
        .as_array()
        .unwrap()
        .iter()
        .find(|ty| ty["id"] == recursive_signature["returnType"])
        .unwrap();
    assert_eq!(
        recursive_type["callSignatures"][0],
        recursive_signature["id"]
    );
    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn invalid_graph_queries_refuse_without_partial_facts() {
    let directory =
        std::env::temp_dir().join(format!("t00-semantic-graph-invalid-{}", std::process::id()));
    fs::create_dir_all(&directory).unwrap();
    for query in [
        json!({"id":"missing","file":"/project/main.ts","route":{"anchor":{"path":"/project/absent.ts","kind":"Identifier","start":0,"end":1},"steps":[]},"operation":"node"}),
        json!({"id":"wrong-kind","file":"/project/main.ts","route":{"anchor":{"path":"/project/main.ts","kind":"SourceFile","start":0,"end":10},"steps":[]},"operation":"properties"}),
        json!({"id":"unknown-file","file":"/project/missing.ts","route":{"anchor":{"path":"/project/main.ts","kind":"Identifier","start":6,"end":7},"steps":[]},"operation":"node"}),
        json!({"id":"unknown-operation","file":"/project/main.ts","route":{"anchor":{"path":"/project/main.ts","kind":"Identifier","start":6,"end":7},"steps":[]},"operation":"guess"}),
    ] {
        let output = invoke(
            &directory,
            &json!({"files":{"/project/main.ts":"const x=1;"},"factQueries":[query]}),
        );
        assert!(!output.status.success());
        assert!(output.stdout.is_empty());
    }
    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn graph_exhaustion_is_explicit_instead_of_complete_empty_facts() {
    let directory =
        std::env::temp_dir().join(format!("t00-semantic-graph-limit-{}", std::process::id()));
    fs::create_dir_all(&directory).unwrap();
    let output = facts(
        &directory,
        &json!({"files":{"/project/main.ts":"0;".repeat(5000)}}),
    );
    assert_eq!(output["files"][0]["factsGraph"]["truncated"], true);
    assert!(
        !output["files"][0]["factsGraph"]["nodes"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    fs::remove_dir_all(directory).unwrap();
}
