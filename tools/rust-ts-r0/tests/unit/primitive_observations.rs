
use super::*;
use serde_json::json;

#[test]
fn retained_test_scan_uses_strict_literal_calls_and_skips_missing_capture() {
    let descriptor = json!({"operation":"test_dynamic_imports","retained_texts":{"checks/probe.test.mts":"// 🪴\r\nexport async function check(){\r\nconst first=import('./native'); const repeated=import('./native');\r\nconst computed=import(name); const template=import(`./template`); const options=import('./options',{}); const parenthesized=import(('./parenthesized')); return first;}","unselected.ts":"import('./ignored');"},"test_paths":["checks/probe.test.mts","checks/missing.test.ts"]});
    let observed = handle_observation(descriptor.clone()).unwrap();
    assert_eq!(
        observed["dynamic_keys"],
        json!(["checks/probe.test.mts:3:./native"])
    );
    assert_eq!(
        observed["source_states"]["checks/probe.test.mts"]["state"],
        "present"
    );
    assert_eq!(
        observed["source_states"]["checks/missing.test.ts"],
        json!({"state":"missing"})
    );
    assert_eq!(
        observed["request_descriptor_id"],
        identity::digest(&descriptor)
    );
    assert_eq!(observed["observation_scope"], "private_retained_test_scan");
    assert_eq!(observed["public_reachability_claimed"], false);
    assert_eq!(observed["global_admission_inferred"], false);
    let empty = handle_observation(json!({"operation":"test_dynamic_imports","retained_texts":{"empty.test.ts":""},"test_paths":["empty.test.ts"]})).unwrap();
    assert_eq!(empty["dynamic_keys"], json!([]));
    assert_eq!(empty["source_states"]["empty.test.ts"]["state"], "present");
}

#[test]
fn retained_test_scan_refuses_malformed_capture_and_ambiguous_paths() {
    let valid = json!({"operation":"test_dynamic_imports","retained_texts":{"probe.test.ts":"import('./present');"},"test_paths":["probe.test.ts"]});
    for path in [
        "",
        "/probe.test.ts",
        "./probe.test.ts",
        "nested/../probe.test.ts",
        "nested//probe.test.ts",
        "probe\\test.ts",
        "C:probe.test.ts",
        "probe\0.test.ts",
    ] {
        for field in ["test_paths", "retained_texts"] {
            let mut changed = valid.clone();
            changed[field] = if field == "test_paths" {
                json!([path])
            } else {
                json!({path:""})
            };
            assert_eq!(
                handle_observation(changed).unwrap_err(),
                "TEST_DYNAMIC_SCAN_RELATIVE_PATH_INVALID"
            );
        }
    }
    let mut duplicate = valid.clone();
    duplicate["test_paths"] = json!(["probe.test.ts", "probe.test.ts"]);
    assert_eq!(
        handle_observation(duplicate).unwrap_err(),
        "TEST_DYNAMIC_SCAN_DUPLICATE_TEST_PATH"
    );
    let mut unsupported = valid.clone();
    unsupported["test_paths"] = json!(["probe.test.vue"]);
    assert_eq!(
        handle_observation(unsupported).unwrap_err(),
        "TEST_DYNAMIC_SCAN_SCRIPT_KIND_UNSUPPORTED"
    );
    for (field, value) in [
        ("retained_texts", Value::Null),
        ("retained_texts", json!({"probe.test.ts":false})),
        ("test_paths", Value::Null),
        ("test_paths", json!([7])),
        ("extra", json!(true)),
    ] {
        let mut changed = valid.clone();
        changed[field] = value;
        assert!(
            handle_observation(changed)
                .unwrap_err()
                .starts_with("PRIMITIVE_INVALID_REQUEST:")
        );
    }
    for field in ["retained_texts", "test_paths"] {
        let mut changed = valid.clone();
        changed.as_object_mut().unwrap().remove(field);
        assert!(
            handle_observation(changed)
                .unwrap_err()
                .starts_with("PRIMITIVE_INVALID_REQUEST:")
        );
    }
    let empty = handle_observation(
        json!({"operation":"test_dynamic_imports","retained_texts":{},"test_paths":[]}),
    )
    .unwrap();
    assert_eq!(empty["dynamic_keys"], json!([]));
    assert_eq!(empty["source_states"], json!({}));
}

#[test]
fn canonical_file_key_uses_the_supplied_system_alias_before_normalizing() {
    let system = json!({"/Dev/link.ts":"/Dev/source/Real.ts","/Dev/source/Real.ts":"/Dev/source/Real.ts","/Dev/source/Other.ts":"/Dev/source/Other.ts"});
    let query = |path: &str| {
        handle_observation(json!({"operation":"canonical_file_key","path":path,"case_sensitive":true,"realpath_results":system})).unwrap()
    };
    let alias = query("/Dev/link.ts");
    let real = query("/Dev/source/Real.ts");
    let other = query("/Dev/source/Other.ts");
    assert_eq!(alias["key"], "/Dev/source/Real.ts");
    assert_eq!(alias["key"], real["key"]);
    assert_ne!(real["key"], other["key"]);
    assert_eq!(alias["realpath_result"], "/Dev/source/Real.ts");
    assert_eq!(alias["realpath_source"], "supplied_controlled_system");
    let descriptor = json!({"operation":"canonical_file_key","path":"alias-dev","case_sensitive":false,"realpath_results":{"alias-dev":".\\Section\\..\\Thing.TS"}});
    let normalized = handle_observation(descriptor.clone()).unwrap();
    assert_eq!(normalized["key"], "section/../thing.ts");
    assert_eq!(
        normalized["request_descriptor_id"],
        identity::digest(&descriptor)
    );
    let unicode=handle_observation(json!({"operation":"canonical_file_key","path":"alias-dev","case_sensitive":false,"realpath_results":{"alias-dev":"./ÅFile.ts"}})).unwrap();
    assert_eq!(unicode["key"], "åfile.ts");
}

#[test]
fn canonical_file_key_refuses_unobserved_or_malformed_controlled_system_context() {
    let valid = json!({"operation":"canonical_file_key","path":"dev-alias","case_sensitive":true,"realpath_results":{"dev-alias":"/Dev/Real.ts"}});
    for field in ["path", "case_sensitive", "realpath_results"] {
        let mut missing = valid.clone();
        missing.as_object_mut().unwrap().remove(field);
        assert!(handle_observation(missing).is_err(), "{field}");
    }
    for (field, value) in [
        ("path", json!(null)),
        ("case_sensitive", json!("true")),
        ("realpath_results", json!(null)),
        ("realpath_results", json!([])),
        ("realpath_results", json!({"dev-alias":7})),
        ("unexpected", json!(true)),
    ] {
        let mut malformed = valid.clone();
        malformed[field] = value;
        assert!(handle_observation(malformed).is_err(), "{field}");
    }
    let missing=handle_observation(json!({"operation":"canonical_file_key","path":"Cargo.toml","case_sensitive":true,"realpath_results":{}})).unwrap_err();
    assert_eq!(missing, "PRIMITIVE_CONTROLLED_REALPATH_MISSING");
    for (path, resolved) in [
        ("", "/Dev/Real.ts"),
        ("bad\0path", "/Dev/Real.ts"),
        ("dev-alias", ""),
        ("dev-alias", "bad\0result"),
    ] {
        let mut request = valid.clone();
        request["path"] = json!(path);
        request["realpath_results"] =
            serde_json::to_value(BTreeMap::from([(path, resolved)])).unwrap();
        assert_eq!(
            handle_observation(request).unwrap_err(),
            "PRIMITIVE_CONTROLLED_REALPATH_INVALID"
        );
    }
}

#[test]
fn relative_import_primitive_observes_syntax_order_without_runtime_resolution() {
    let source = "import './same-dev'; export { item } from '../owner-dev'; import './same-dev'; const load = () => import('./lazy-dev', {with:{type:'json'}}); require('./legacy-dev'); import(name); import(`./template-dev`); import 'package-dev'; import '/absolute-dev'; const view = <section>{import('./jsx-dev')}</section>;";
    let observed = handle_observation(json!({"operation":"relative_import_specifiers","source":source,"filename":"suggestions-dev.ts"})).unwrap();
    assert_eq!(
        observed["specifiers"],
        json!([
            "./same-dev",
            "../owner-dev",
            "./same-dev",
            "./lazy-dev",
            "./jsx-dev"
        ])
    );
    assert_eq!(observed["runtime_dependency_claim"], false);
    assert_eq!(observed["executed"], true);
    assert_eq!(observed["unsupported"], json!([]));
    for request in [
        json!({"operation":"relative_import_specifiers","filename":"source.ts"}),
        json!({"operation":"relative_import_specifiers","source":7,"filename":"source.ts"}),
        json!({"operation":"relative_import_specifiers","source":"","filename":null}),
        json!({"operation":"relative_import_specifiers","source":"","filename":"source.ts","unknown":true}),
    ] {
        assert!(
            handle_observation(request)
                .unwrap_err()
                .starts_with("PRIMITIVE_INVALID_REQUEST:")
        );
    }
}

#[test]
fn primitive_decoder_observes_actual_utf16_units_and_canonical_source_identity() {
    let observed = handle_observation(json!({
        "operation":"decode",
        "bytes":[255,254,65,0,13,0,10,0,0,216,90,0],
        "profile":"compiler_system",
        "offsets_utf16":[0,1,3,4,5]
    }))
    .unwrap();
    assert_eq!(
        observed["decoded_utf16_units"],
        json!([65, 13, 10, 55296, 90])
    );
    assert_eq!(
        observed["canonical_source_utf16_units"],
        json!([65, 10, 55296, 90])
    );
    assert_eq!(
        observed["decoded_utf8_replacement_sha256"],
        "sha256:64de2db461a4826fd8395bc7367b27e7db1e7a688876791dcb9f150f809423c2"
    );
    assert_eq!(
        observed["canonical_source_utf8_replacement_sha256"],
        "sha256:ee17405bdb51e7abbb79d8a5545a681a8bb577610b6765c771985a4c27874795"
    );
    assert_eq!(observed["boundaries_sdk"][2]["sdk_line"], 1);
    assert_eq!(observed["boundaries_sdk"][2]["sdk_character"], 0);
}

#[test]
fn primitive_utf16_preserves_surrogates_and_observes_sdk_boundary_limits() {
    let request = json!({
        "operation":"utf16",
        "units":[65,55357,56960,13,10,55299,66,56325],
        "offsets_utf16":[0,1,2,3,5,6,8]
    });
    let observed = handle_observation(request.clone()).unwrap();
    assert_eq!(observed["decoded_utf16_units"], request["units"]);
    assert_eq!(
        observed["canonical_source_utf16_units"],
        json!([65, 55357, 56960, 10, 55299, 66, 56325])
    );
    assert_eq!(
        observed["request_descriptor_id"],
        identity::digest(&request)
    );
    assert_eq!(observed["boundaries_sdk"][2]["scalar_boundary"], false);
    assert_eq!(observed["boundaries_sdk"][3]["scalar_boundary"], true);
    assert_eq!(observed["boundaries_sdk"][4]["sdk_line"], 1);
    assert_eq!(observed["boundaries_sdk"][4]["sdk_character"], 0);
    assert_eq!(observed["boundaries_sdk"][5]["sdk_character"], 3);
    assert_eq!(observed["boundaries_sdk"][5]["utf16_character"], 1);
    assert_eq!(observed["boundaries_sdk"][6]["utf16_character"], 3);
}

#[test]
fn primitive_boundary_refuses_foreign_shapes_profiles_units_and_offsets() {
    for request in [
        json!({"operation":"unknown"}),
        json!({"operation":"decode","bytes":[],"profile":"unknown","offsets_utf16":[]}),
        json!({"operation":"decode","bytes":[256],"profile":"compiler_system","offsets_utf16":[]}),
        json!({"operation":"decode","bytes":[],"profile":"compiler_system","offsets_utf16":[],"foreign":true}),
        json!({"operation":"utf16","units":[65536],"offsets_utf16":[]}),
        json!({"operation":"utf16","units":[65],"offsets_utf16":[-1]}),
        json!({"operation":"utf16","units":[65],"offsets_utf16":[2]}),
    ] {
        assert!(handle_observation(request).is_err());
    }
}

#[test]
fn primitive_canonical_descriptor_preserves_javascript_order_and_request_binding() {
    let request = json!({"operation":"canonical_json","value":{"z":1,"2":2,"a":[true,null]}});
    let observed = handle_observation(request.clone()).unwrap();
    assert_eq!(
        observed["canonical_json"],
        "{\"2\":2,\"a\":[true,null],\"z\":1}"
    );
    assert_eq!(
        observed["request_descriptor_id"],
        identity::digest(&request)
    );
    assert!(
        handle_observation(json!({"operation":"canonical_json","value":null,"foreign":0})).is_err()
    );
}

#[test]
fn primitive_semantic_key_resolves_native_lexical_paths_without_realpath() {
    let cwd = std::env::current_dir()
        .unwrap()
        .to_string_lossy()
        .into_owned();
    let sensitive = handle_observation(json!({"operation":"semantic_key","cwd":cwd,"path":"alpha/../Leaf.ts","case_sensitive":true})).unwrap();
    assert_eq!(
        sensitive["key"],
        format!("{}/Leaf.ts", cwd.replace('\\', "/"))
    );
    let folded = handle_observation(json!({"operation":"semantic_key","cwd":cwd,"path":"alpha/../Leaf.ts","case_sensitive":false})).unwrap();
    assert_eq!(
        folded["key"],
        format!("{}/leaf.ts", cwd.replace('\\', "/").to_lowercase())
    );
    assert!(
        handle_observation(
            json!({"operation":"semantic_key","cwd":"relative","path":"x.ts","case_sensitive":true})
        )
        .is_err()
    );
}

#[test]
fn primitive_utf16_lines_cover_bom_crlf_astral_and_ecma_separators() {
    let observed = handle_observation(json!({
        "operation":"utf16",
        "units":[65279,65,55356,57099,13,10,55314,8232,90,8233],
        "offsets_utf16":[0,2,3,4,6,7,8,10]
    }))
    .unwrap();
    assert_eq!(observed["line_starts_utf16"], json!([0, 6, 8, 10]));
    let coordinates = observed["boundaries_sdk"]
        .as_array()
        .unwrap()
        .iter()
        .map(|boundary| json!([boundary["utf16_line"], boundary["utf16_character"]]))
        .collect::<Vec<_>>();
    assert_eq!(
        coordinates,
        json!([
            [0, 0],
            [0, 2],
            [0, 3],
            [0, 4],
            [1, 0],
            [1, 1],
            [2, 0],
            [3, 0]
        ])
        .as_array()
        .unwrap()
        .clone()
    );
    assert_eq!(observed["boundaries_sdk"][2]["scalar_boundary"], false);
    assert_eq!(observed["boundaries_sdk"][5]["sdk_character"], 3);
    assert_eq!(observed["boundaries_sdk"][5]["utf16_character"], 1);
}

#[test]
fn primitive_raw_decoding_keeps_compiler_and_retained_profiles_distinct() {
    let ordinary = handle_observation(json!({"operation":"decode","bytes":[239,187,191,81,13,10],"profile":"compiler_system","offsets_utf16":[]})).unwrap();
    let retained = handle_observation(json!({"operation":"decode","bytes":[239,187,191,81,13,10],"profile":"retained_utf8","offsets_utf16":[]})).unwrap();
    assert_eq!(ordinary["decoded_utf16_units"], json!([81, 13, 10]));
    assert_eq!(retained["decoded_utf16_units"], json!([65279, 81, 13, 10]));
    assert_eq!(ordinary["raw_bytes_sha256"], retained["raw_bytes_sha256"]);
    assert_ne!(
        ordinary["decoded_utf8_replacement_sha256"],
        retained["decoded_utf8_replacement_sha256"]
    );
    assert_ne!(
        ordinary["request_descriptor_id"],
        retained["request_descriptor_id"]
    );
}

#[test]
#[cfg(not(windows))]
fn primitive_posix_key_replaces_backslashes_after_native_resolution() {
    let observed=handle_observation(json!({"operation":"semantic_key","cwd":"/fixture-primitive","path":"part\\..\\Leaf.ts","case_sensitive":true})).unwrap();
    assert_eq!(observed["key"], "/fixture-primitive/part/../Leaf.ts");
    let folded=handle_observation(json!({"operation":"semantic_key","cwd":"/fixture-primitive","path":"ΟΣ.ts","case_sensitive":false})).unwrap();
    assert_eq!(folded["key"], "/fixture-primitive/οσ.ts");
}

#[test]
#[cfg(windows)]
fn primitive_windows_key_preserves_native_drive_and_unc_resolution() {
    for (cwd, path, expected) in [
        (
            "C:\\Dev\\Semantic",
            "branch\\..\\Leaf.ts",
            "C:/Dev/Semantic/Leaf.ts",
        ),
        ("C:\\Dev\\Semantic", "\\other\\Leaf.ts", "C:/other/Leaf.ts"),
        ("C:\\Dev\\Semantic", "D:\\Leaf.ts", "D:/Leaf.ts"),
        (
            "\\\\server\\share\\project",
            "..\\Leaf.ts",
            "//server/share/Leaf.ts",
        ),
    ] {
        let observed = handle_observation(
            json!({"operation":"semantic_key","cwd":cwd,"path":path,"case_sensitive":true}),
        )
        .unwrap();
        assert_eq!(observed["key"], expected);
    }
    assert!(handle_observation(json!({"operation":"semantic_key","cwd":"C:\\Dev","path":"C:relative.ts","case_sensitive":true})).is_err());
}

#[test]
fn primitive_parser_reports_actual_declaration_name_and_statement_utf16_spans() {
    let observed = handle_observation(json!({
            "operation":"utf16",
            "units":[65279,13,10,99,111,110,115,116,32,112,114,105,109,105,116,105,118,101,70,108,97,103,32,61,32,57,59],
            "offsets_utf16":[],
            "filename":"primitive-positions.ts"
        })).unwrap();
    let parser = &observed["source_parsing_observation"];
    assert_eq!(parser["executed"], true);
    assert_eq!(parser["diagnostics"], json!([]));
    assert_eq!(parser["statements"][0]["kind"], "VariableStatement");
    assert_eq!(parser["statements"][0]["start_utf16"], 3);
    assert_eq!(parser["statements"][0]["end_utf16"], 27);
    assert_eq!(parser["statements"][0]["start_line"], 1);
    let declaration = &parser["declarations"][0];
    assert_eq!(declaration["kind"], "VariableDeclaration");
    assert_eq!(declaration["start_utf16"], 9);
    assert_eq!(declaration["name"]["start_utf16"], 9);
    assert_eq!(declaration["name"]["end_utf16"], 22);
    assert_eq!(
        declaration["name"]["identifier_utf16_units"],
        json!([
            112, 114, 105, 109, 105, 116, 105, 118, 101, 70, 108, 97, 103
        ])
    );
    assert!(
        handle_observation(
            json!({"operation":"utf16","units":[],"offsets_utf16":[],"filename":"unknown.css"})
        )
        .is_err()
    );
}

#[test]
fn primitive_parser_exposes_recovery_diagnostic_without_successful_analysis_claim() {
    let observed = handle_observation(json!({
        "operation":"decode","bytes":b"const flag = ;".to_vec(),
        "profile":"compiler_system","offsets_utf16":[0,14],"filename":"primitive-broken.ts"
    }))
    .unwrap();
    let parser = &observed["source_parsing_observation"];
    assert_eq!(parser["has_syntax_errors"], true);
    assert_eq!(
        parser["diagnostics"],
        json!([{"code":1109,"message":"Expression expected.","start_utf16":13,"end_utf16":14}])
    );
    assert!(observed.get("analysis_success").is_none());
    let empty=handle_observation(json!({"operation":"utf16","units":[],"offsets_utf16":[0],"filename":"primitive-empty.tsx"})).unwrap();
    assert_eq!(empty["source_parsing_observation"]["script_kind"], "TSX");
    assert_eq!(empty["source_parsing_observation"]["statements"], json!([]));
    assert_eq!(empty["boundaries_sdk"][0]["utf16_character"], 0);
}
