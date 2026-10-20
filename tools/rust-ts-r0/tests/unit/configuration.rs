
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
