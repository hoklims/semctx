use super::*;
use std::collections::BTreeMap;

fn scan_code(source: &str) -> QualifiedScan {
    scan_code_with_proof_state(source, false, false)
}

#[expect(
    clippy::excessive_nesting,
    reason = "The captured SDK test context requires nested program and checker callbacks."
)]
fn scan_code_with_proof_state(source: &str, observed: bool, prove_inline: bool) -> QualifiedScan {
    use sha2::Digest;
    eprintln!(
        "{}",
        serde_json::json!({"kind":"qualified-development-input", "source":source,
            "sourceSha256":format!("{:x}", sha2::Sha256::digest(source.as_bytes())), "observed":observed,
            "proveInline":prove_inline, "sdk":"captured-typescript-5.9.3"})
    );
    let files = BTreeMap::from([("/repo/qualified-development.ts".into(), source.into())]);
    crate::development::with_sdk_project(
        files,
        vec!["/repo/qualified-development.ts".into()],
        move || {
            let source = program::get_source_file("/repo/qualified-development.ts");
            assert!(source.is_some());
            program::with_type_checker_for_file(source, move |checker| {
                let mut inputs = QualifiedInputs {
                    retained_paths: BTreeSet::from(["/repo/qualified-development.ts".into()]),
                    case_sensitive: ts_goport::frontend::vfs::osvfs_fs()
                        .use_case_sensitive_file_names(),
                    retained_callable_coordinates_observed: observed,
                    inline_callback_ownership_observed: observed,
                    ..Default::default()
                };
                if prove_inline {
                    let mut nodes = vec![source];
                    while let Some(node) = nodes.pop() {
                        if node.kind() == K::ArrowFunction {
                            let map = ast::source_file_get_position_map(source);
                            inputs.inline_owned_callbacks.insert(QualifiedSpan {
                                path: "/repo/qualified-development.ts".into(),
                                start_utf16: map
                                    .utf8_to_utf16(astnav::get_start_of_node(node, source, false)),
                                end_utf16: map.utf8_to_utf16(node.end()),
                            });
                            break;
                        }
                        nodes.extend(node.iter_children());
                    }
                }
                inspect_semantic_dependencies(source, checker, &inputs)
            })
        },
    )
}

#[test]
fn observed_callback_ownership_distinguishes_refusal_proof_from_unavailable_mechanism() {
    let source = "declare function foreign(callback:()=>number):void; function leaf(){return 1;} export function run(){ foreign(()=>leaf()); }";
    let unknown = scan_code_with_proof_state(source, false, false);
    assert!(
        unknown
            .unsupported
            .contains("OPAQUE_CALLBACK_GRAPH_OWNERSHIP_PROOF_UNAVAILABLE"),
        "{unknown:?}"
    );
    let refused = scan_code_with_proof_state(source, true, false);
    assert!(
        refused
            .reasons
            .contains("SOURCE_OPAQUE_CALLBACK_UNSUPPORTED"),
        "{refused:?}"
    );
    assert!(
        !refused
            .unsupported
            .contains("OPAQUE_CALLBACK_GRAPH_OWNERSHIP_PROOF_UNAVAILABLE"),
        "{refused:?}"
    );
    let proved = scan_code_with_proof_state(source, true, true);
    assert!(
        !proved
            .reasons
            .contains("SOURCE_OPAQUE_CALLBACK_UNSUPPORTED"),
        "{proved:?}"
    );
    assert!(
        !proved
            .unsupported
            .contains("OPAQUE_CALLBACK_GRAPH_OWNERSHIP_PROOF_UNAVAILABLE"),
        "{proved:?}"
    );
}

#[test]
fn observed_missing_callable_coordinate_refuses_instead_of_claiming_unknown() {
    let source = "export function run(){ const value:any={}; value.missing(); }";
    let unknown = scan_code_with_proof_state(source, false, false);
    assert!(
        unknown
            .unsupported
            .contains("RETAINED_CALLABLE_COORDINATE_PROOF_UNAVAILABLE"),
        "{unknown:?}"
    );
    let refused = scan_code_with_proof_state(source, true, false);
    assert!(
        refused
            .reasons
            .contains("SOURCE_UNRESOLVED_CALLEE_UNSUPPORTED"),
        "{refused:?}"
    );
    assert!(
        !refused
            .unsupported
            .contains("RETAINED_CALLABLE_COORDINATE_PROOF_UNAVAILABLE"),
        "{refused:?}"
    );
}

fn scan_graph(source: &str, graph: serde_json::Value) -> QualifiedScan {
    use sha2::Digest;
    eprintln!(
        "{}",
        serde_json::json!({"kind":"qualified-graph-development-input", "source":source,
            "sourceSha256":format!("{:x}", sha2::Sha256::digest(source.as_bytes())), "graph":&graph,
            "graphSha256":format!("{:x}", sha2::Sha256::digest(serde_json::to_vec(&graph).unwrap())), "noLib":true})
    );
    let files = BTreeMap::from([("/repo/qualified-development.ts".into(), source.into())]);
    let retained_files = files.clone();
    crate::development::with_project(
        files,
        vec!["/repo/qualified-development.ts".into()],
        move || {
            let source = program::get_source_file("/repo/qualified-development.ts");
            program::with_type_checker_for_file(source, move |checker| {
                let inputs = QualifiedInputs {
                    repository_root: "/repo".into(),
                    retained_files,
                    graph: Some(graph),
                    retained_paths: BTreeSet::from(["/repo/qualified-development.ts".into()]),
                    case_sensitive: ts_goport::frontend::vfs::osvfs_fs()
                        .use_case_sensitive_file_names(),
                    ..Default::default()
                };
                inspect_semantic_dependencies(source, checker, &inputs)
            })
        },
    )
}

fn callback_graph() -> serde_json::Value {
    serde_json::json!({"nodes":[
            {"id":"run","kind":"function","name":"run","filePath":"qualified-development.ts","metadata":{"scope":""}},
            {"id":"leaf","kind":"function","name":"leaf","filePath":"qualified-development.ts","metadata":{"scope":""}}
        ],"edges":[{"kind":"calls","from":"run","to":"leaf","evidence":[{"filePath":"qualified-development.ts","startLine":1}]}]})
}

#[test]
fn inline_owned_requires_unique_owner_and_exact_call_evidence() {
    let source = "declare function foreign(callback:()=>number):void; function leaf(){return 1;} export function run(){ foreign(()=>leaf()); }";
    let proved = scan_graph(source, callback_graph());
    assert!(
        !proved
            .reasons
            .contains("SOURCE_OPAQUE_CALLBACK_UNSUPPORTED"),
        "{proved:?}"
    );
    assert!(
        !proved
            .unsupported
            .contains("OPAQUE_CALLBACK_GRAPH_OWNERSHIP_PROOF_UNAVAILABLE"),
        "{proved:?}"
    );
    let mut missing = callback_graph();
    missing["edges"] = serde_json::json!([]);
    let refused = scan_graph(source, missing);
    assert!(
        refused
            .reasons
            .contains("SOURCE_OPAQUE_CALLBACK_UNSUPPORTED"),
        "{refused:?}"
    );
    let mut wrong_line = callback_graph();
    wrong_line["edges"][0]["evidence"][0]["startLine"] = serde_json::json!(2);
    assert!(
        scan_graph(source, wrong_line)
            .reasons
            .contains("SOURCE_OPAQUE_CALLBACK_UNSUPPORTED")
    );
    let mut duplicate = callback_graph();
    let owner = duplicate["nodes"][0].clone();
    duplicate["nodes"].as_array_mut().unwrap().push(owner);
    assert!(
        scan_graph(source, duplicate)
            .reasons
            .contains("SOURCE_OPAQUE_CALLBACK_UNSUPPORTED")
    );
}

#[test]
fn inline_owned_test_pair_requires_both_edges_and_a_callable_reference() {
    let source = "declare function foreign(callback:()=>unknown):void; function leaf(){return 1;} foreign(()=>leaf);";
    let graph = serde_json::json!({"nodes":[
            {"id":"test","kind":"test","name":"spec","filePath":"qualified-development.ts"},
            {"id":"leaf","kind":"function","name":"leaf","filePath":"qualified-development.ts","metadata":{"scope":""}}
        ],"edges":[{"kind":"covers","from":"test","to":"leaf"},{"kind":"tested_by","from":"leaf","to":"test"}]});
    let proved = scan_graph(source, graph.clone());
    assert!(
        !proved
            .reasons
            .contains("SOURCE_OPAQUE_CALLBACK_UNSUPPORTED"),
        "{proved:?}"
    );
    let mut one_way = graph.clone();
    one_way["edges"].as_array_mut().unwrap().pop();
    assert!(
        scan_graph(source, one_way)
            .reasons
            .contains("SOURCE_OPAQUE_CALLBACK_UNSUPPORTED")
    );
    let no_reference = "declare function foreign(callback:()=>unknown):void; function leaf(){return 1;} foreign(()=>1);";
    assert!(
        scan_graph(no_reference, graph)
            .reasons
            .contains("SOURCE_OPAQUE_CALLBACK_UNSUPPORTED")
    );
}

#[test]
fn inline_owned_never_falls_back_through_property_owner_or_missing_named_owner() {
    let property = "declare function foreign(callback:()=>number):void; function leaf(){return 1;} const owner={run:()=>foreign(()=>leaf())};";
    let mut graph = callback_graph();
    graph["nodes"][0] = serde_json::json!({"id":"module","kind":"module","name":"mod","filePath":"qualified-development.ts"});
    graph["edges"][0]["from"] = serde_json::json!("module");
    assert!(
        scan_graph(property, graph.clone())
            .reasons
            .contains("SOURCE_OPAQUE_CALLBACK_UNSUPPORTED")
    );
    let named = "declare function foreign(callback:()=>number):void; function leaf(){return 1;} function missing(){foreign(()=>leaf());}";
    assert!(
        scan_graph(named, graph)
            .reasons
            .contains("SOURCE_OPAQUE_CALLBACK_UNSUPPORTED")
    );
}

#[test]
fn sdk_callback_signature_refuses_sdk_map_and_preserves_owned_homonym() {
    let sdk = scan_code("export function run(){ return [1,2].map(value => value + 1); }");
    assert!(
        sdk.reasons.contains("SOURCE_SDK_CALLBACK_UNSUPPORTED"),
        "{sdk:?}"
    );
    let owned = scan_code(
        "const owned={map(value:number){ return value + 1; }}; export function run(){ return owned.map(2); }",
    );
    assert!(
        !owned.reasons.contains("SOURCE_SDK_CALLBACK_UNSUPPORTED"),
        "{owned:?}"
    );
    assert!(owned.unsupported.is_empty(), "{owned:?}");
}

#[test]
fn runtime_typeof_refusal_proves_primitive_argument_but_annotation_alone_does_not() {
    let guarded = scan_code(
        "declare function sink(value:unknown):void; export function run(value:unknown){ if(typeof value !== 'string') throw 0; sink(value); }",
    );
    assert!(
        !guarded
            .reasons
            .contains("SOURCE_OPAQUE_CALLBACK_UNSUPPORTED"),
        "{guarded:?}"
    );
    let annotation = scan_code(
        "declare function sink(value:unknown):void; export function run(value:string){ sink(value); }",
    );
    assert!(
        annotation
            .reasons
            .contains("SOURCE_OPAQUE_CALLBACK_UNSUPPORTED"),
        "{annotation:?}"
    );
}

#[test]
fn sdk_symbol_protocol_definition_and_plain_computed_key_are_distinct() {
    let protocol = scan_code("export const value = { [Symbol.iterator](){ return [1]; } };");
    assert!(
        protocol
            .reasons
            .contains("SOURCE_PROTOCOL_DEFINITION_UNSUPPORTED"),
        "{protocol:?}"
    );
    let plain = scan_code("const key='ordinary'; export const value = { [key](){ return 1; } };");
    assert!(
        !plain
            .reasons
            .contains("SOURCE_PROTOCOL_DEFINITION_UNSUPPORTED"),
        "{plain:?}"
    );
    assert!(
        !plain.reasons.contains("SOURCE_PROPERTY_KEY_UNSUPPORTED"),
        "{plain:?}"
    );
}

#[test]
fn sdk_constructor_provenance_preserves_date_and_refuses_owned_construction() {
    let sdk = scan_code("export function run(){ return new Date(1); }");
    assert!(
        !sdk.reasons.contains("SOURCE_CONSTRUCTION_UNSUPPORTED"),
        "{sdk:?}"
    );
    let owned = scan_code(
        "class Date { constructor(value:number){} } export function run(){ return new Date(1); }",
    );
    assert!(
        owned.reasons.contains("SOURCE_CONSTRUCTION_UNSUPPORTED"),
        "{owned:?}"
    );
}

#[test]
fn computed_sdk_destructuring_does_not_prove_a_transparent_constructor_binding() {
    let value = scan_code(
        "const key='Instance'; const {[key]: Constructor}=WebAssembly; export function run(){ return new Constructor({} as WebAssembly.Module); }",
    );
    assert!(
        value.reasons.contains("SOURCE_CONSTRUCTION_UNSUPPORTED"),
        "{value:?}"
    );
}

#[test]
fn descriptors_distinguish_literal_data_from_getter_execution() {
    let data =
        scan_code("export function run(){ return Object.defineProperty({}, 'value', {value:1}); }");
    assert!(
        !data
            .reasons
            .contains("SOURCE_DESCRIPTOR_ACCESSOR_UNSUPPORTED"),
        "{data:?}"
    );
    let getter = scan_code(
        "export function run(){ return Object.defineProperty({}, 'value', {get(){return 1;}}); }",
    );
    assert!(
        getter
            .reasons
            .contains("SOURCE_DESCRIPTOR_ACCESSOR_UNSUPPORTED"),
        "{getter:?}"
    );
}

#[test]
fn runtime_builtin_execution_is_distinct_from_type_only_import() {
    let runtime =
        scan_code("import {exec} from 'node:child_process'; export function run(){ exec('id'); }");
    assert!(
        runtime
            .reasons
            .contains("SOURCE_PROCESS_LAUNCH_UNSUPPORTED"),
        "{runtime:?}"
    );
    let types =
        scan_code("import type {exec} from 'node:child_process'; export type Fn=typeof exec;");
    assert!(
        !types.reasons.contains("SOURCE_PROCESS_LAUNCH_UNSUPPORTED"),
        "{types:?}"
    );
}

#[test]
fn navigation_strips_browser_control_whitespace_before_reading_the_scheme() {
    assert!(unsafe_script_navigation(Some(
        " \u{0}\tjava\rscript:alert(1)"
    )));
    assert!(unsafe_script_navigation(None));
    assert!(!unsafe_script_navigation(Some("HTTPS://example.test")));
    assert!(!unsafe_script_navigation(Some("/relative/path")));
    assert!(!unsafe_script_navigation(Some("1invalid:scheme")));
}

#[test]
fn locale_shorthand_options_follow_value_provenance() {
    for (binding, refused) in [
        ("const style='decimal';", false),
        ("let style='decimal';", true),
        ("const decimal='decimal';const style=decimal;", false),
        ("const style=undefined;", false),
        ("", true),
        ("const style={toString(){return 'decimal'}};", true),
        ("const style=other;const other=style;", true),
    ] {
        let source = format!("{binding}[1].toLocaleString(undefined,{{style}});export {{}};");
        let scanned = scan_code(&source);
        assert_eq!(
            scanned.reasons.contains("SOURCE_COERCION_UNSUPPORTED"),
            refused,
            "{source}: {scanned:?}"
        );
    }
}
