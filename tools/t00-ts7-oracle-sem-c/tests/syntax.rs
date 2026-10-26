mod support;

use serde_json::{Value, json};
use std::{fs, process::Command};

#[test]
fn syntax_facts_preserve_native_text_imports_templates_and_control_flow() {
    let sdk = support::canonical_sdk();
    let dir = std::env::temp_dir().join(format!("t00-semantic-syntax-{}", std::process::id()));
    fs::create_dir_all(&dir).unwrap();
    let request = dir.join("request.json");
    fs::write(&request, json!({"files": {
        "/project/dep.ts": "export interface Thing {}",
        "/project/main.tsx": r#"/// <reference path="./dep.ts"/>
import type {Thing as Alias} from './dep'; export type {Alias}; async function* stream(){ for await (const value of [1]) { yield `${import.meta.url}:${value}`; } } const escaped = 'a\u0062'; const view = <box:item/>; class Base {} class Child extends Base {} type Shape = Alias | string;"#
    }}).to_string()).unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_t00-ts7-oracle-sem-c"))
        .env("GOPORT_LIB_PARSE_SNAPSHOT", "0")
        .env("GOPORT_LIB_SNAPSHOT", "0")
        .args([request.to_str().unwrap(), sdk])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let facts: Value = serde_json::from_slice(&output.stdout).unwrap();
    let file = facts["files"]
        .as_array()
        .unwrap()
        .iter()
        .find(|file| file["path"] == "/project/main.tsx")
        .unwrap();
    let nodes = file["nodes"].as_array().unwrap();
    let kind = |name: &str| nodes.iter().find(|node| node["kind"] == name).unwrap();
    assert_eq!(
        kind("ImportDeclaration")["fields"]["importClause"]["kind"],
        "ImportClause"
    );
    assert_eq!(kind("ImportClause")["syntaxValues"]["isTypeOnly"], true);
    assert_eq!(
        kind("ImportClause")["fields"]["namedBindings"]["kind"],
        "NamedImports"
    );
    assert_eq!(
        kind("ExportDeclaration")["fields"]["exportClause"]["kind"],
        "NamedExports"
    );
    assert_eq!(
        kind("ExportDeclaration")["syntaxValues"]["isTypeOnly"],
        true
    );
    assert!(
        nodes
            .iter()
            .any(|node| node["kind"] == "StringLiteral" && node["literalText"] == "ab")
    );
    assert_eq!(
        kind("FunctionDeclaration")["fields"]["asteriskToken"]["kind"],
        "AsteriskToken"
    );
    assert_eq!(
        kind("ForOfStatement")["fields"]["awaitModifier"]["kind"],
        "AwaitKeyword"
    );
    assert_eq!(
        kind("MetaProperty")["syntaxValues"]["keywordToken"],
        "ImportKeyword"
    );
    assert_eq!(
        kind("TemplateExpression")["fields"]["templateSpans"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        kind("JsxSelfClosingElement")["fields"]["tagName"]["kind"],
        "JsxNamespacedName"
    );
    assert_eq!(
        kind("JsxNamespacedName")["fields"]["namespace"]["kind"],
        "Identifier"
    );
    assert_eq!(
        kind("HeritageClause")["syntaxValues"]["token"],
        "ExtendsKeyword"
    );
    assert_eq!(
        kind("UnionType")["fields"]["types"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert_eq!(kind("UnionType")["isTypeNode"], true);
    assert_eq!(file["isDeclarationFile"], false);
    assert_eq!(file["referencedFiles"][0]["fileName"], "./dep.ts");
    assert_eq!(file["defaultLibrary"], false);
    assert_eq!(
        facts["compilerConstants"]["useCaseSensitiveFileNames"],
        true
    );
    assert!(
        facts["sourceFiles"]
            .as_array()
            .unwrap()
            .iter()
            .any(|file| file["path"] == "/sdk/lib/lib.es5.d.ts"
                && file["defaultLibrary"] == true
                && file["text"].as_str().unwrap().contains("interface Number"))
    );
    fs::remove_dir_all(dir).unwrap();
}
