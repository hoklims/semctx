use super::*;

#[test]
fn sdk59_module_root_diagnostics_preserve_messages_and_none_refusal() {
    assert_sdk59_target_fixture(
        include_str!("../fixtures/sdk59-module-root-expected.json"),
        3,
    );
}

#[test]
fn sdk59_module_diagnostics_preserve_exact_messages_and_order() {
    assert_sdk59_target_fixture(
        include_str!("../fixtures/sdk59-module-diagnostic-expected.json"),
        2,
    );
}

#[test]
fn sdk59_target_cycles_preserve_display_case_in_insensitive_filesystem() {
    assert_sdk59_target_fixture(
        include_str!("../fixtures/sdk59-target-cycle-case-expected.json"),
        3,
    );
}

#[test]
fn sdk59_target_shape_errors_preserve_pre_option_order() {
    assert_sdk59_target_fixture(
        include_str!("../fixtures/sdk59-target-shape-order-expected.json"),
        3,
    );
}

#[test]
fn sdk59_target_cycles_preserve_diagnostic_context_and_order() {
    assert_sdk59_target_fixture(
        include_str!("../fixtures/sdk59-target-cycle-expected.json"),
        3,
    );
}

#[test]
fn sdk59_target_cycle_selected_neighbors_preserve_source_multiplicity_and_order() {
    assert_sdk59_target_fixture(
        include_str!("../fixtures/sdk59-target-cycle-selected-neighbors-expected.json"),
        2,
    );
}

#[test]
fn sdk59_target_configuration_matches_frozen_public_baseline() {
    assert_sdk59_target_fixture(
        include_str!("../fixtures/sdk59-target-public-expected.json"),
        21,
    );
}

#[test]
fn sdk59_target_diagnostics_preserve_inherited_multiplicity() {
    assert_sdk59_target_fixture(
        include_str!("../fixtures/sdk59-target-multiplicity-expected.json"),
        3,
    );
}

#[test]
fn sdk59_target_diagnostics_preserve_source_order() {
    assert_sdk59_target_fixture(
        include_str!("../fixtures/sdk59-target-diagnostic-order-expected.json"),
        3,
    );
}

#[test]
fn sdk59_target_diagnostics_preserve_inherited_duplicate_properties() {
    assert_sdk59_target_fixture(
        include_str!("../fixtures/sdk59-target-duplicate-key-expected.json"),
        3,
    );
}

#[test]
fn sdk59_target_diagnostics_preserve_order_with_other_options() {
    assert_sdk59_target_fixture(
        include_str!("../fixtures/sdk59-target-mixed-diagnostic-expected.json"),
        3,
    );
}

#[test]
fn sdk59_target_diagnostics_insert_newer_targets_in_native_option_order() {
    assert_sdk59_target_fixture(
        include_str!("../fixtures/sdk59-target-mixed-insertion-expected.json"),
        3,
    );
}

fn assert_sdk59_target_fixture(json: &str, expected_count: usize) {
    let fixture: serde_json::Value = serde_json::from_str(json).unwrap();
    assert_eq!(fixture["typescript_version"], "5.9.3");
    let cases = fixture["cases"].as_array().unwrap();
    assert_eq!(cases.len(), expected_count);
    let mut mismatches = vec![];
    for case in cases {
        let files = case["files"]
            .as_object()
            .unwrap()
            .iter()
            .map(|(path, text)| (path.clone(), text.as_str().unwrap().to_owned()))
            .collect();
        let result = inspect(
            Rc::new(CaptureFs::new(
                files,
                case["case_sensitive"].as_bool().unwrap_or(true),
            )),
            case["source_path"].as_str().unwrap(),
            case["repository_root"].as_str().unwrap(),
        )
        .unwrap();
        let expected: Vec<String> =
            serde_json::from_value(case["expected_reasons"].clone()).unwrap();
        if result.reasons != expected {
            mismatches.push(format!(
                "{}: expected {expected:?}, native {:?}",
                case["id"].as_str().unwrap(),
                result.reasons
            ));
        }
        if let Some(expected_target) = case["expected_native_target_flag"].as_i64()
            && i64::from(result.options.target.0) != expected_target
        {
            mismatches.push(format!(
                "{}: expected target {expected_target}, native {:?}",
                case["id"].as_str().unwrap(),
                result.options.target
            ));
        }
    }
    assert!(mismatches.is_empty(), "{}", mismatches.join("\n"));
}

#[test]
fn configuration_discovery_root_candidates_have_one_separator() {
    for (source, root, expected) in [
        (
            "/repo/main.ts",
            "/repo",
            vec!["/repo/tsconfig.json", "/tsconfig.json"],
        ),
        (
            "C:/repo/main.ts",
            "C:/repo",
            vec!["C:/repo/tsconfig.json", "C:/tsconfig.json"],
        ),
    ] {
        let fs = Rc::new(CaptureFs::new(BTreeMap::new(), true));
        let result = inspect(fs.clone(), source, root).unwrap();
        assert!(result.raw.is_none());
        let log = fs.log.borrow();
        let paths = log
            .iter()
            .filter(|probe| probe.operation == "configuration_discovery_file_exists")
            .map(|probe| probe.path.as_str())
            .collect::<Vec<_>>();
        assert_eq!(
            paths, expected,
            "configuration probe must describe the actual local root path"
        );
    }
}

#[test]
fn parses_inherited_options_from_captured_configuration_and_rejects_invalid_text() {
    let fs = Rc::new(CaptureFs::new(
        BTreeMap::from([
            (
                "/repo/tsconfig.json".into(),
                "{\"extends\":\"./foundation.json\",\"compilerOptions\":{\"allowJs\":true,},}"
                    .into(),
            ),
            (
                "/repo/foundation.json".into(),
                "{\"compilerOptions\":{\"module\":\"nodenext\"}}".into(),
            ),
        ]),
        true,
    ));
    let result = inspect(fs.clone(), "/repo/src/main.ts", "/repo").unwrap();
    assert_eq!(result.options.module, ModuleKind::NODE_NEXT);
    assert!(
        result
            .reasons
            .contains(&"SOURCE_CONFIGURATION_MODULE_UNSUPPORTED:NodeNext".into())
    );
    assert!(result.consumed.contains("/repo/foundation.json"));
    assert_eq!(
        result
            .raw_chain
            .iter()
            .map(|(path, _)| path.as_str())
            .collect::<Vec<_>>(),
        vec!["/repo/foundation.json", "/repo/tsconfig.json"]
    );
    let invalid = Rc::new(CaptureFs::new(
        BTreeMap::from([("/repo/tsconfig.json".into(), "{ invalid".into())]),
        true,
    ));
    assert!(
        inspect(invalid, "/repo/main.ts", "/repo")
            .unwrap()
            .reasons
            .iter()
            .any(|reason| reason.starts_with("SOURCE_CONFIGURATION_INVALID:"))
    );
}

#[test]
fn named_configuration_must_be_consumed_by_an_actual_source_lineage() {
    for inherited in [false, true] {
        let fs = Rc::new(CaptureFs::new(
            BTreeMap::from([
                (
                    "/repo/main.ts".into(),
                    "export const t00DevelopmentConfigWitness=157;".into(),
                ),
                (
                    "/repo/tsconfig.json".into(),
                    if inherited {
                        "{\"extends\":\"./tsconfig.used.json\"}"
                    } else {
                        "{}"
                    }
                    .into(),
                ),
                ("/repo/tsconfig.used.json".into(), "{}".into()),
            ]),
            true,
        ));
        let result = unconsumed_named(
            fs,
            "/repo",
            &[
                "/repo/main.ts".into(),
                "/repo/tsconfig.json".into(),
                "/repo/tsconfig.used.json".into(),
            ],
        )
        .unwrap();
        assert_eq!(
            result,
            if inherited {
                vec![]
            } else {
                vec!["SOURCE_NAMED_CONFIGURATION_UNSUPPORTED"]
            }
        );
    }
}

#[test]
fn nearest_parent_configuration_outside_root_is_not_silently_absent() {
    let fs = Rc::new(CaptureFs::new(
        BTreeMap::from([("/tsconfig.json".into(), "{}".into())]),
        true,
    ));
    let result = inspect(fs, "/repo/source.ts", "/repo").unwrap();
    assert_eq!(
        result.reasons,
        vec!["SOURCE_CONFIGURATION_OUTSIDE_REPOSITORY"]
    );
    assert!(result.consumed.is_empty());
}

#[test]
fn missing_package_configuration_keeps_6053_despite_negative_ancestor_package_probes() {
    let fs = Rc::new(CaptureFs::with_workspace_root(
        BTreeMap::from([
            (
                "/repo/app/package.json".into(),
                r#"{"name":"dev-app"}"#.into(),
            ),
            (
                "/repo/app/source.ts".into(),
                "export const sourceDev = 73;".into(),
            ),
            (
                "/repo/app/tsconfig.json".into(),
                r#"{"extends":"@dev/missing/base.json"}"#.into(),
            ),
        ]),
        true,
        "/repo",
        None,
    ));
    let observed = inspect(fs.clone(), "/repo/app/source.ts", "/repo").unwrap();
    assert!(
        fs.log
            .borrow()
            .iter()
            .any(|probe| probe.operation == "directory_exists"
                && probe.path == "/node_modules"
                && !probe.found)
    );
    assert!(
        observed
            .reasons
            .iter()
            .any(|reason| reason.starts_with("SOURCE_CONFIGURATION_INVALID:6053")),
        "{:?}",
        observed.reasons
    );
    assert!(
        !observed
            .reasons
            .contains(&"SOURCE_CONFIGURATION_OUTSIDE_REPOSITORY".into())
    );
}

#[test]
fn inherited_configuration_outside_repository_is_never_consumed() {
    let fs = Rc::new(CaptureFs::new(
        BTreeMap::from([
            (
                "/repo/tsconfig.json".into(),
                "{\"extends\":\"../private-options.json\"}".into(),
            ),
            (
                "/private-options.json".into(),
                "{\"compilerOptions\":{\"module\":\"CommonJS\"}}".into(),
            ),
        ]),
        true,
    ));
    let result = inspect(fs.clone(), "/repo/source.ts", "/repo").unwrap();
    assert_eq!(
        result.reasons,
        vec!["SOURCE_CONFIGURATION_OUTSIDE_REPOSITORY"]
    );
    assert!(!result.consumed.contains("/private-options.json"));
    assert!(
        !fs.log
            .borrow()
            .iter()
            .any(|probe| probe.operation == "read_file"
                && probe.path == "/private-options.json"
                && probe.found)
    );
}

#[test]
fn refuses_inherited_configuration_outside_repository() {
    let fs = Rc::new(CaptureFs::new(
        BTreeMap::from([(
            "/repo/tsconfig.json".into(),
            "{\"extends\":\"../outside.json\"}".into(),
        )]),
        true,
    ));
    let result = inspect(fs, "/repo/main.ts", "/repo").unwrap();
    assert!(
        result
            .reasons
            .contains(&"SOURCE_CONFIGURATION_OUTSIDE_REPOSITORY".into())
    );
}

#[test]
fn sdk59_module_none_is_explicitly_unsupported_and_not_a_native_invalid_option() {
    for (base, leaf, expected) in [
        ("{}", "{\"compilerOptions\":{\"module\":\"none\"}}", true),
        (
            "{\"compilerOptions\":{\"module\":\"ESNext\"}}",
            "{\"extends\":\"./base.json\",\"compilerOptions\":{\"module\":\"none\"}}",
            true,
        ),
        (
            "{\"compilerOptions\":{\"module\":\"none\"}}",
            "{\"extends\":\"./base.json\",\"compilerOptions\":{\"module\":\"ESNext\"}}",
            false,
        ),
        (
            "{\"compilerOptions\":{\"module\":\"none\"}}",
            "{\"extends\":\"./base.json\",\"compilerOptions\":{\"module\":null}}",
            false,
        ),
    ] {
        let fs = Rc::new(CaptureFs::new(
            BTreeMap::from([
                ("/repo/base.json".into(), base.into()),
                ("/repo/tsconfig.json".into(), leaf.into()),
            ]),
            true,
        ));
        let result = inspect(fs, "/repo/source.ts", "/repo").unwrap();
        assert_eq!(
            result.reasons,
            if expected {
                vec!["SOURCE_CONFIGURATION_MODULE_UNSUPPORTED:None"]
            } else {
                vec![]
            }
        );
        if expected {
            assert_eq!(result.options.module, ModuleKind::NONE);
        }
    }
    let fs = Rc::new(CaptureFs::new(
        BTreeMap::from([
            (
                "/repo/base.json".into(),
                "{\"compilerOptions\":{\"module\":\"none\"}}".into(),
            ),
            (
                "/repo/tsconfig.json".into(),
                "{\"extends\":\"./base.json\",\"compilerOptions\":{\"module\":\"wrong-kind\"}}"
                    .into(),
            ),
        ]),
        true,
    ));
    let result = inspect(fs, "/repo/source.ts", "/repo").unwrap();
    assert!(
        result
            .reasons
            .iter()
            .any(|reason| reason.starts_with("SOURCE_CONFIGURATION_INVALID:6046:"))
    );
}
