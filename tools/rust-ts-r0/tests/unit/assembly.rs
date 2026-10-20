
use super::*;
use crate::ordinary::{BindingTarget, Call, Import, Marker};

fn assemble_dev(raw: &Extraction, roles: &BTreeMap<String, String>, qualified: bool) -> Value {
    assemble(
        raw,
        roles,
        qualified,
        "/tmp/t00-development",
        &BTreeSet::new(),
    )
    .unwrap()
}
fn function(name: &str, line: u32, signature: bool) -> Symbol {
    Symbol {
        name: name.into(),
        kind: "function".into(),
        rel_path: "owners.ts".into(),
        scope: vec![],
        start_line: line,
        end_line: line,
        start_utf16: 0,
        end_utf16: 0,
        exported: true,
        signature_only: signature.then_some(true),
        jsdoc: None,
        markers: vec![],
    }
}

#[test]
fn overloads_keep_marker_lines_and_colliding_callers_never_fall_back_to_module() {
    let mut signature = function("t00DevelopmentOverload", 2, true);
    signature.markers.push(Marker {
        tag: "capability".into(),
        slug: "t00-dev-owned".into(),
        statement: Some("Owns the test behavior".into()),
    });
    let raw = Extraction {
        modules: vec!["owners.ts".into()],
        symbols: vec![
            signature,
            function("t00DevelopmentOverload", 4, false),
            function("t00DevelopmentCollision", 6, false),
            function("t00DevelopmentCollision", 8, false),
        ],
        imports: vec![],
        calls: vec![Call {
            caller_rel_path: "owners.ts".into(),
            caller_symbol_path: Some("t00DevelopmentCollision".into()),
            caller_unmodeled_reason: None,
            callee_name: "t00DevelopmentOverload".into(),
            callee_rel_path: Some("owners.ts".into()),
            callee_symbol_path: Some("t00DevelopmentOverload".into()),
            callee_unmodeled_reason: None,
            line: 9,
        }],
    };
    let output = assemble_dev(
        &raw,
        &BTreeMap::from([("owners.ts".into(), "source".into())]),
        true,
    );
    let symbols = output["symbols"].as_array().unwrap();
    assert_eq!(symbols.len(), 3);
    let overload = symbols
        .iter()
        .find(|s| s["name"] == "t00DevelopmentOverload")
        .unwrap();
    assert_eq!(overload["declarations"].as_array().unwrap().len(), 2);
    assert_eq!(overload["markers"][0]["startLine"], 2);
    assert!(
        !output["edges"]
            .as_array()
            .unwrap()
            .iter()
            .any(|edge| edge["kind"] == "calls")
    );
    assert_eq!(
        output["integrityReasons"]["owners.ts"][0],
        "QUALIFIED_CALL_COORDINATE_CALLER_AMBIGUOUS:owners.ts:t00DevelopmentCollision"
    );
}

#[test]
fn test_binding_association_is_structural_and_not_runtime_coverage() {
    let raw = Extraction {
        modules: vec!["owners.ts".into(), "owner.test.ts".into()],
        symbols: vec![function("t00DevelopmentImported", 1, false)],
        imports: vec![Import {
            from_rel_path: "owner.test.ts".into(),
            module_specifier: "./owners.js".into(),
            resolved_rel_path: Some("owners.ts".into()),
            names: vec!["t00DevelopmentImported".into()],
            binding_targets: Some(vec![BindingTarget {
                rel_path: "owners.ts".into(),
                symbol_path: "t00DevelopmentImported".into(),
                runtime_used: Some(false),
                unmodeled_reason: None,
            }]),
            line: 1,
        }],
        calls: vec![],
    };
    let output = assemble_dev(
        &raw,
        &BTreeMap::from([
            ("owners.ts".into(), "source".into()),
            ("owner.test.ts".into(), "test".into()),
        ]),
        true,
    );
    let edges = output["edges"].as_array().unwrap();
    assert!(edges.iter().any(|edge| edge["kind"] == "tested_by"));
    assert!(edges.iter().any(|edge| edge["kind"] == "covers"));
    assert!(output["integrityReasons"].as_object().unwrap().is_empty());
}
fn roles() -> BTreeMap<String, String> {
    BTreeMap::from([
        ("owners.ts".into(), "source".into()),
        ("owner.test.ts".into(), "test".into()),
    ])
}
fn node<'a>(output: &'a Value, id: &str) -> &'a Value {
    output["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|n| n["id"] == id)
        .unwrap()
}
fn edge<'a>(output: &'a Value, kind: &str, from: &str, to: &str) -> &'a Value {
    output["edges"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["kind"] == kind && e["from"] == from && e["to"] == to)
        .unwrap()
}
#[test]
fn development_repository_identity_and_module_membership_use_root_and_roles() {
    let output = assemble(
        &Extraction::default(),
        &roles(),
        false,
        "/tmp/Étude_ＡPİv2",
        &BTreeSet::new(),
    )
    .unwrap();
    let repository = node(&output, "repo:etude-apiv2");
    assert_eq!(repository["name"], "Étude_ＡPİv2");
    assert_eq!(repository["metadata"]["root"], "/tmp/Étude_ＡPİv2");
    assert_eq!(
        edge(&output, "belongs_to", "mod:owners.ts", "repo:etude-apiv2")["evidence"],
        json!([{"filePath":"owners.ts","sourceKind":"code"}])
    );
    assert_eq!(
        node(&output, "test:owner.test.ts")["evidence"],
        json!([{"filePath":"owner.test.ts","sourceKind":"test"}])
    );
}
#[test]
fn development_all_explicit_marker_tags_reach_graph_without_inference() {
    let mut symbol = function("markerOwner", 3, false);
    symbol.markers = [
        ("tag", "Critical_Flow"),
        ("capability", "PAYMENTS"),
        ("invariant", "Once"),
        ("contract", "Gateway"),
        ("risk", "Retry"),
        ("boundedContext", "Billing"),
    ]
    .into_iter()
    .map(|(tag, slug)| Marker {
        tag: tag.into(),
        slug: slug.into(),
        statement: Some("An explicit statement".into()),
    })
    .collect();
    let raw = Extraction {
        symbols: vec![symbol],
        ..Extraction::default()
    };
    let output = assemble_dev(&raw, &roles(), false);
    let id = "sym:function:owners.ts:markerOwner";
    assert_eq!(node(&output, id)["tags"], json!(["Critical_Flow"]));
    assert_eq!(node(&output, id)["boundedContext"], "Billing");
    assert!(node(&output, id)["metadata"].get("scope").is_none());
    for (kind, target) in [
        ("implements_capability", "cap:payments"),
        ("constrained_by", "inv:once"),
        ("declares", "contract:gateway"),
        ("related_to", "risk:retry"),
        ("belongs_to", "bc:billing"),
    ] {
        assert_eq!(
            edge(&output, kind, id, target)["evidence"][0]["startLine"],
            3
        );
        assert_eq!(node(&output, target)["evidence"][0]["startLine"], 3);
    }
    assert_eq!(
        node(&output, "cap:payments")["metadata"]["statement"],
        "An explicit statement"
    );
    assert_eq!(node(&output, "cap:payments")["tags"], json!(["from-code"]));
    assert_eq!(node(&output, "bc:billing")["tags"], json!([]));
}
#[test]
fn development_divergent_statements_degrade_but_repeated_same_statement_does_not() {
    let mut first = function("firstOwner", 2, false);
    first.markers = vec![
        Marker {
            tag: "invariant".into(),
            slug: "exact-name".into(),
            statement: Some("First statement".into()),
        },
        Marker {
            tag: "capability".into(),
            slug: "agreed".into(),
            statement: Some("One statement".into()),
        },
    ];
    let mut second = function("secondOwner", 7, false);
    second.markers = first.markers.clone();
    second.markers[0].statement = Some("Second statement".into());
    let output = assemble_dev(
        &Extraction {
            symbols: vec![first, second],
            ..Extraction::default()
        },
        &roles(),
        false,
    );
    assert!(
        node(&output, "inv:exact-name")["metadata"]
            .get("statement")
            .is_none()
    );
    assert_eq!(
        node(&output, "inv:exact-name")["tags"],
        json!(["from-code", "statement-divergent"])
    );
    assert_eq!(
        node(&output, "inv:exact-name")["evidence"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        node(&output, "cap:agreed")["metadata"]["statement"],
        "One statement"
    );
    assert_eq!(node(&output, "cap:agreed")["tags"], json!(["from-code"]));
}
#[test]
fn development_same_canonical_marker_id_with_different_names_fails_identity() {
    for (left, right) in [
        ("PAYMENTS".to_owned(), "payments".to_owned()),
        (
            format!("{}a", "x".repeat(60)),
            format!("{}b", "x".repeat(60)),
        ),
    ] {
        let mut first = function("firstOwner", 2, false);
        first.markers = vec![Marker {
            tag: "capability".into(),
            slug: left,
            statement: Some("First".into()),
        }];
        let mut second = function("secondOwner", 7, false);
        second.markers = vec![Marker {
            tag: "capability".into(),
            slug: right,
            statement: Some("Second".into()),
        }];
        let result = assemble(
            &Extraction {
                symbols: vec![first, second],
                ..Extraction::default()
            },
            &roles(),
            false,
            "/tmp/dev",
            &BTreeSet::new(),
        );
        assert!(
            result
                .err()
                .is_some_and(|e| e.starts_with("FACT_ID_CONFLICT:"))
        );
    }
}
fn import(specifier: &str, line: u32) -> Import {
    Import {
        from_rel_path: "owner.test.ts".into(),
        module_specifier: specifier.into(),
        resolved_rel_path: Some("owners.ts".into()),
        names: vec![],
        binding_targets: None,
        line,
    }
}
#[test]
fn development_import_specifiers_are_aggregated_metadata_and_evidence_stays_structural() {
    let raw = Extraction {
        imports: vec![
            import("./owners", 1),
            import("./owners.js", 1),
            import("./owners", 3),
        ],
        ..Extraction::default()
    };
    let output = assemble_dev(&raw, &roles(), false);
    let imports = edge(&output, "imports", "test:owner.test.ts", "mod:owners.ts");
    assert_eq!(
        imports["metadata"],
        json!({"specifiers":"[\"./owners\",\"./owners.js\"]"})
    );
    assert_eq!(
        imports["evidence"],
        json!([{"filePath":"owner.test.ts","sourceKind":"code","startLine":1},
            {"filePath":"owner.test.ts","sourceKind":"code","startLine":3}])
    );
    let output = assemble_dev(
        &Extraction {
            imports: vec![import("./owners.js", 1)],
            ..Extraction::default()
        },
        &roles(),
        false,
    );
    assert_eq!(
        edge(&output, "imports", "test:owner.test.ts", "mod:owners.ts")["metadata"],
        json!({"specifier":"./owners.js"})
    );
}
#[test]
fn development_dynamic_test_binding_requires_exact_observed_tuple_and_qualified_mode() {
    let raw = Extraction {
        modules: vec!["owners.ts".into(), "owner.test.ts".into()],
        imports: vec![import("./owners.js", 4)],
        ..Extraction::default()
    };
    let observed = BTreeSet::from([("owner.test.ts".into(), 4, "./owners.js".into())]);
    let output = assemble(&raw, &roles(), true, "/tmp/dev", &observed).unwrap();
    assert_eq!(
        output["integrityReasons"]["owner.test.ts"][0],
        "QUALIFIED_TEST_DYNAMIC_IMPORT_BINDING_UNPROVEN:owners.ts"
    );
    for (qualified, tuples) in [
        (false, observed),
        (
            true,
            BTreeSet::from([("owner.test.ts".into(), 5, "./owners.js".into())]),
        ),
    ] {
        let output = assemble(&raw, &roles(), qualified, "/tmp/dev", &tuples).unwrap();
        assert!(output["integrityReasons"].as_object().unwrap().is_empty());
    }
}
#[test]
fn development_graph_order_uses_utf16_identifiers_and_stable_edge_ids() {
    let mut astral = function("owner", 1, false);
    astral.rel_path = "src/𐀀.ts".into();
    let mut private = function("owner", 1, false);
    private.rel_path = "src/\u{e000}.ts".into();
    let selected = BTreeMap::from([
        (astral.rel_path.clone(), "source".into()),
        (private.rel_path.clone(), "source".into()),
    ]);
    let output = assemble_dev(
        &Extraction {
            symbols: vec![private, astral],
            ..Extraction::default()
        },
        &selected,
        false,
    );
    let ids = output["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|n| n["id"].as_str().unwrap())
        .collect::<Vec<_>>();
    let position = |value| ids.iter().position(|id| *id == value).unwrap();
    assert!(position("mod:src/𐀀.ts") < position("mod:src/\u{e000}.ts"));
    assert!(
        output["edges"]
            .as_array()
            .unwrap()
            .iter()
            .all(|e| e["id"].as_str().is_some_and(|s| s.starts_with("edge:")))
    );
}
#[test]
fn development_same_normalized_module_id_with_different_origin_refuses() {
    let selected = BTreeMap::from([
        ("./owners.ts".into(), "source".into()),
        ("owners.ts".into(), "source".into()),
    ]);
    assert!(
        assemble(
            &Extraction::default(),
            &selected,
            false,
            "/tmp/dev",
            &BTreeSet::new()
        )
        .err()
        .is_some_and(|reason| reason.starts_with("FACT_ID_CONFLICT:"))
    );
}
#[test]
fn development_generic_node_identity_checks_kind_name_origin_context_and_metadata() {
    let original = json!({"id":"sym:function:a.ts:owner","kind":"function","name":"owner",
            "filePath":"a.ts","boundedContext":"first","metadata":{"scope":"outer"}});
    for (field, value) in [
        ("kind", json!("class")),
        ("name", json!("other")),
        ("filePath", json!("b.ts")),
        ("boundedContext", json!("second")),
        ("metadata", json!({"scope":"different"})),
    ] {
        let mut nodes = BTreeMap::new();
        insert_node(&mut nodes, original.clone()).unwrap();
        let mut changed = original.clone();
        changed[field] = value;
        assert!(
            insert_node(&mut nodes, changed)
                .err()
                .is_some_and(|reason| reason.starts_with("FACT_ID_CONFLICT:")),
            "{field}"
        );
    }
    let mut nodes = BTreeMap::new();
    insert_node(&mut nodes, original.clone()).unwrap();
    let mut same = original;
    same["exported"] = json!(true);
    same["tags"] = json!(["explicit"]);
    same["metadata"]["statement"] = json!("declared statement");
    insert_node(&mut nodes, same).unwrap();
    assert_eq!(nodes["sym:function:a.ts:owner"]["exported"], true);
    assert_eq!(
        nodes["sym:function:a.ts:owner"]["tags"],
        json!(["explicit"])
    );
}
#[test]
fn development_repeated_markers_keep_declaration_coordinates_and_utf16_input_ranges() {
    let mut signature = function("signatureOwner", 2, true);
    signature.start_utf16 = 7;
    signature.end_utf16 = 19;
    let marker = Marker {
        tag: "invariant".into(),
        slug: "declared-once-per-line".into(),
        statement: Some("same statement".into()),
    };
    signature.markers = vec![marker.clone(), marker.clone()];
    let mut body = function("signatureOwner", 7, false);
    body.start_utf16 = 30;
    body.end_utf16 = 48;
    body.markers = vec![marker];
    let output = assemble_dev(
        &Extraction {
            symbols: vec![body, signature],
            ..Extraction::default()
        },
        &roles(),
        false,
    );
    assert_eq!(output["symbols"][0]["markers"].as_array().unwrap().len(), 2);
    assert_eq!(output["symbols"][0]["declarations"][0]["startUtf16"], 7);
    assert_eq!(output["symbols"][0]["declarations"][1]["endUtf16"], 48);
    assert_eq!(
        node(&output, "inv:declared-once-per-line")["evidence"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| e["startLine"].as_u64().unwrap())
            .collect::<Vec<_>>(),
        vec![2, 7]
    );
}
