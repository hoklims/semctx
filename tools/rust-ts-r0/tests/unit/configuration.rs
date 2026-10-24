use super::*;

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
fn ts7_module_none_preserves_native_invalid_option_and_retained_refusal() {
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
                vec![
                    "SOURCE_CONFIGURATION_INVALID:6046:Argument for '--module' option must be: 'commonjs', 'es6', 'es2015', 'es2020', 'es2022', 'esnext', 'node16', 'node18', 'node20', 'nodenext', 'preserve'.",
                    "SOURCE_CONFIGURATION_MODULE_UNSUPPORTED:None",
                ]
            } else if base.contains("none") {
                vec![
                    "SOURCE_CONFIGURATION_INVALID:6046:Argument for '--module' option must be: 'commonjs', 'es6', 'es2015', 'es2020', 'es2022', 'esnext', 'node16', 'node18', 'node20', 'nodenext', 'preserve'.",
                ]
            } else {
                vec![]
            }
        );
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

#[test]
fn ts7_removed_options_report_complete_native_compiler_diagnostics() {
    for (option, value, expected) in [
        (
            "module",
            "amd",
            vec![
                "SOURCE_CONFIGURATION_INVALID:5095:Option 'bundler' can only be used when 'module' is set to 'preserve', 'commonjs', or 'es2015' or later.",
                "SOURCE_CONFIGURATION_INVALID:5108:Option 'module=AMD' has been removed. Please remove it from your configuration.",
            ],
        ),
        (
            "module",
            "umd",
            vec![
                "SOURCE_CONFIGURATION_INVALID:5095:Option 'bundler' can only be used when 'module' is set to 'preserve', 'commonjs', or 'es2015' or later.",
                "SOURCE_CONFIGURATION_INVALID:5108:Option 'module=UMD' has been removed. Please remove it from your configuration.",
            ],
        ),
        (
            "module",
            "system",
            vec![
                "SOURCE_CONFIGURATION_INVALID:5095:Option 'bundler' can only be used when 'module' is set to 'preserve', 'commonjs', or 'es2015' or later.",
                "SOURCE_CONFIGURATION_INVALID:5108:Option 'module=System' has been removed. Please remove it from your configuration.",
            ],
        ),
        (
            "target",
            "es5",
            vec![
                "SOURCE_CONFIGURATION_INVALID:5108:Option 'target=ES5' has been removed. Please remove it from your configuration.",
            ],
        ),
        ("target", "es2026", vec![]),
        (
            "baseUrl",
            "./src",
            vec![
                "SOURCE_CONFIGURATION_INVALID:5102:Option 'baseUrl' has been removed. Please remove it from your configuration. Use '\"paths\": {\"*\": [\"./src/*\"]}' instead.",
            ],
        ),
    ] {
        let mut options = serde_json::json!({
            "target": "es2022",
            "module": "esnext",
            "moduleResolution": "bundler",
            "noEmit": true,
        });
        options[option] = serde_json::json!(value);
        let fs = Rc::new(CaptureFs::new(
            BTreeMap::from([(
                "/repo/tsconfig.json".into(),
                serde_json::json!({"compilerOptions": options}).to_string(),
            )]),
            true,
        ));
        let observed = inspect(fs, "/repo/main.ts", "/repo").unwrap();
        assert_eq!(
            observed
                .reasons
                .iter()
                .filter(|reason| reason.starts_with("SOURCE_CONFIGURATION_INVALID:"))
                .map(String::as_str)
                .collect::<Vec<_>>(),
            expected,
            "{option}={value}",
        );
    }
}

#[test]
fn malformed_configuration_preserves_every_native_parser_diagnostic() {
    let fs = Rc::new(CaptureFs::new(
        BTreeMap::from([("/repo/tsconfig.json".into(), "{ invalid".into())]),
        true,
    ));
    let observed = inspect(fs, "/repo/main.ts", "/repo").unwrap();
    assert_eq!(
        observed.reasons,
        vec![
            "SOURCE_CONFIGURATION_INVALID:1005:'}' expected.",
            "SOURCE_CONFIGURATION_INVALID:1136:Property assignment expected.",
        ]
    );
    assert!(observed.raw.is_none());
}

#[test]
fn option_validation_does_not_load_configured_types_or_libraries() {
    let fs = Rc::new(CaptureFs::new(
        BTreeMap::from([
            (
                "/repo/tsconfig.json".into(),
                serde_json::json!({"compilerOptions": {
                    "target": "es2022",
                    "module": "esnext",
                    "types": ["fixture"],
                    "typeRoots": ["./types"],
                    "lib": ["es2022"],
                }})
                .to_string(),
            ),
            (
                "/repo/types/fixture/index.d.ts".into(),
                "declare const fixtureValue: number;".into(),
            ),
            (
                "/repo/main.ts".into(),
                "export const value = fixtureValue;".into(),
            ),
        ]),
        true,
    ));
    let observed = inspect(fs, "/repo/main.ts", "/repo").unwrap();
    assert!(observed.reasons.is_empty(), "{:?}", observed.reasons);
    assert_eq!(
        observed.consumed,
        BTreeSet::from(["/repo/tsconfig.json".into()])
    );
}

#[test]
fn inherited_null_strict_uses_effective_options_for_native_validation() {
    for (strict, expected) in [
        (serde_json::Value::Null, vec![]),
        (
            serde_json::json!(false),
            vec![
                "SOURCE_CONFIGURATION_INVALID:5052:Option 'strictPropertyInitialization' cannot be specified without specifying option 'strictNullChecks'.",
            ],
        ),
    ] {
        let fs = Rc::new(CaptureFs::new(
            BTreeMap::from([
                ("/repo/base.json".into(), serde_json::json!({"compilerOptions":{"strict":strict}}).to_string()),
                ("/repo/tsconfig.json".into(), serde_json::json!({"extends":"./base.json","compilerOptions":{"strictPropertyInitialization":true}}).to_string()),
            ]),
            true,
        ));
        assert_eq!(
            inspect(fs, "/repo/main.ts", "/repo").unwrap().reasons,
            expected
        );
    }
}
