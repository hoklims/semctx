use super::*;
fn component_request(id: &str, path: &str, text: &str) -> Request {
    serde_json::from_value(serde_json::json!({
            "id": id, "cwd": "/repo", "sdk_directory": "/sdk/lib",
            "case_sensitive": ts_goport::frontend::vfs::osvfs_fs().use_case_sensitive_file_names(),
            "roots": [path], "files": {path: text},
            "options": {"target":"ES2022","module":"ESNext","moduleResolution":"Bundler","allowJs":true,"jsx":"Preserve","skipLibCheck":true,"noEmit":true,"strict":false}
        })).unwrap()
}

fn component_sdk() -> Sdk {
    serde_json::from_slice(
        &std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/sdk/sdk-input.json")).unwrap(),
    )
    .unwrap()
}

fn dynamic_import_request(text: &str) -> Request {
    let mut request = component_request("dynamicImportDev", "/repo/src/target.test.ts", text);
    request.qualified = true;
    request
        .roles
        .insert("src/target.test.ts".into(), "test".into());
    request.roots.push("/repo/src/target.ts".into());
    request.files.insert(
        "/repo/src/target.ts".into(),
        "export function helper(){return 1;}\n".into(),
    );
    request.files.insert(
        "/repo/package.json".into(),
        r#"{"name":"qualified-fixture","type":"module"}"#.into(),
    );
    request
}

#[test]
fn retained_dynamic_computed_imports_refuse_with_the_scope_reason() {
    let sdk = component_sdk();
    for text in [
        "const name='./target';export async function check(){return import(name);}\n",
        "export async function check(){return import('./target',{with:{type:'json'}});}\n",
    ] {
        let request = dynamic_import_request(text);
        let observed = analyze(request.clone(), sdk.clone()).unwrap();
        let subject = observed["subjects"]
            .as_array()
            .unwrap()
            .iter()
            .find(|subject| subject["path"] == "src/target.test.ts")
            .unwrap();
        assert!(
            subject["reasons"]
                .as_array()
                .unwrap()
                .contains(&serde_json::json!(
                    "DEPENDENCY_SCOPE_COMPUTED_IMPORT:src/target.test.ts"
                ))
        );
        assert_eq!(
            serde_json::to_value(batch::build(&request, &sdk, &observed).unwrap()).unwrap()["terminal"],
            "refused"
        );
    }
}

#[test]
fn retained_unresolved_relative_import_refuses_without_inventing_a_target() {
    let sdk = component_sdk();
    let request =
        dynamic_import_request("export async function check(){return import('./missing');}\n");
    let observed = analyze(request.clone(), sdk.clone()).unwrap();
    let import = &observed["raw_extraction"]["imports"][0];
    assert_eq!(import["moduleSpecifier"], "./missing");
    assert!(import.get("resolvedRelPath").is_none());
    let subject = observed["subjects"]
        .as_array()
        .unwrap()
        .iter()
        .find(|subject| subject["path"] == "src/target.test.ts")
        .unwrap();
    assert!(
        subject["reasons"]
            .as_array()
            .unwrap()
            .contains(&serde_json::json!(
                "DEPENDENCY_SCOPE_UNRESOLVED_IMPORT:src/target.test.ts:./missing"
            ))
    );
    assert_eq!(
        serde_json::to_value(batch::build(&request, &sdk, &observed).unwrap()).unwrap()["terminal"],
        "refused"
    );
}

#[test]
fn retained_unresolved_undeclared_package_refuses_without_inventing_a_target() {
    let sdk = component_sdk();
    let request = dynamic_import_request(
        "import { missing } from 'missing';export function check(){return missing();}\n",
    );
    let observed = analyze(request.clone(), sdk.clone()).unwrap();
    let import = &observed["raw_extraction"]["imports"][0];
    assert_eq!(import["moduleSpecifier"], "missing");
    assert!(import.get("resolvedRelPath").is_none());
    let subject = observed["subjects"]
        .as_array()
        .unwrap()
        .iter()
        .find(|subject| subject["path"] == "src/target.test.ts")
        .unwrap();
    assert!(
        subject["reasons"]
            .as_array()
            .unwrap()
            .contains(&serde_json::json!(
                "DEPENDENCY_SCOPE_UNRESOLVED_IMPORT:src/target.test.ts:missing"
            ))
    );
    assert_eq!(subject["outcome"], "unsupported");
    assert_eq!(
        serde_json::to_value(batch::build(&request, &sdk, &observed).unwrap()).unwrap()["terminal"],
        "refused"
    );
}

#[test]
fn retained_unresolved_imports_distinguish_external_packages_workspaces_and_aliases() {
    let sdk = component_sdk();
    for (specifier, manifest, extra, external) in [
        (
            "external",
            r#"{"dependencies":{"external":"1"}}"#,
            None,
            true,
        ),
        (
            "@scope/external/sub",
            r#"{"devDependencies":{"@scope/external":"1"}}"#,
            None,
            true,
        ),
        (
            "externalish",
            r#"{"dependencies":{"external":"1"}}"#,
            None,
            false,
        ),
        (
            "external",
            r#"{"dependencies":{"external":1}}"#,
            None,
            false,
        ),
        (
            "external",
            "{/* retained JSONC */\"dependencies\":{\"external\":\"1\",},}",
            None,
            true,
        ),
        (
            "external",
            r#"{"dependencies":{"external":"1"},"optionalDependencies":{"external":"workspace:*"}}"#,
            None,
            false,
        ),
        (
            "external",
            r#"{"dependencies":{"external":"file:../external"}}"#,
            None,
            false,
        ),
        (
            "external",
            r#"{"dependencies":{"external":"link:../external"}}"#,
            None,
            false,
        ),
        (
            "external",
            r#"{"dependencies":{"external":"1"}}"#,
            Some((
                "/repo/packages/internal/package.json",
                r#"{"name":"external"}"#,
            )),
            false,
        ),
        (
            "external",
            r#"{"dependencies":{"external":"1"}}"#,
            Some((
                "/repo/src/package.json",
                r#"{"dependencies":{"external":"workspace:*"}}"#,
            )),
            true,
        ),
        (
            "external",
            r#"{"dependencies":{"external":"1"}}"#,
            Some((
                "/repo/tsconfig.json",
                r#"{"compilerOptions":{"paths":{"external":["./missing"]}}}"#,
            )),
            false,
        ),
        (
            "external/sub",
            r#"{"dependencies":{"external":"1"}}"#,
            Some((
                "/repo/tsconfig.json",
                r#"{"compilerOptions":{"paths":{"external/*":["./missing/*"]}}}"#,
            )),
            false,
        ),
        (
            "external/sub",
            r#"{"dependencies":{"external":"1"}}"#,
            Some((
                "/repo/config/tsconfig.extra.json",
                r#"{"compilerOptions":{"paths":{"external/*":["./missing/*"]}}}"#,
            )),
            false,
        ),
        ("node:fs", "{}", None, true),
        ("fs/promises", "{}", None, true),
        ("missing", "{broken", None, false),
        ("/repo/missing", "{}", None, false),
    ] {
        let mut request = dynamic_import_request(&format!(
            "export function check(){{return import('{specifier}');}}\n"
        ));
        request
            .files
            .insert("/repo/package.json".into(), manifest.into());
        if let Some((path, text)) = extra {
            request.files.insert(path.into(), text.into());
        }
        let observed = analyze(request, sdk.clone()).unwrap();
        let import = &observed["raw_extraction"]["imports"][0];
        assert_eq!(import["moduleSpecifier"], specifier);
        assert!(
            import.get("resolvedRelPath").is_none(),
            "{specifier} {manifest}"
        );
        let subject = observed["subjects"]
            .as_array()
            .unwrap()
            .iter()
            .find(|subject| subject["path"] == "src/target.test.ts")
            .unwrap();
        let reason = serde_json::json!(format!(
            "DEPENDENCY_SCOPE_UNRESOLVED_IMPORT:src/target.test.ts:{specifier}"
        ));
        assert_eq!(
            subject["reasons"].as_array().unwrap().contains(&reason),
            !external,
            "{specifier} {manifest} {extra:?}"
        );
        if !external {
            assert_eq!(subject["outcome"], "unsupported");
        }
        assert_eq!(observed["global_admission_inferred"], false);
    }
}

#[test]
fn unresolved_dependency_scope_refusal_requires_the_retained_qualified_profile() {
    let sdk = component_sdk();
    for retained in [true, false] {
        let mut request =
            dynamic_import_request("export function check(){return import('missing');}\n");
        request.retained = retained;
        request.qualified = false;
        let observed = analyze(request, sdk.clone()).unwrap();
        let subject = observed["subjects"]
            .as_array()
            .unwrap()
            .iter()
            .find(|subject| subject["path"] == "src/target.test.ts")
            .unwrap();
        assert!(
            !subject["reasons"]
                .as_array()
                .unwrap()
                .iter()
                .any(|reason| reason
                    .as_str()
                    .unwrap()
                    .starts_with("DEPENDENCY_SCOPE_UNRESOLVED_IMPORT:"))
        );
    }
}

#[test]
fn retained_unresolved_aliases_preserve_bun_literals_and_escapes() {
    let sdk = component_sdk();
    for (alias, specifier, local) in [
        (r"extern\al", "external", true),
        ("foo(bar)", "external", false),
        ("foo(bar)", "foo(bar)", true),
        ("[broken", "external", false),
        ("![broken", "external", true),
        (r"extern\*al", "external", false),
        (r"extern\*al", "extern*al", true),
        (r"extern\{al", "extern{al", true),
        ("!{external,other}", "external", false),
    ] {
        let mut request = dynamic_import_request(&format!(
            "export function check(){{return import('{specifier}');}}\n"
        ));
        request.files.insert(
            "/repo/package.json".into(),
            serde_json::json!({
                "dependencies": {specifier: "1"}
            })
            .to_string(),
        );
        request.files.insert(
            "/repo/tsconfig.json".into(),
            serde_json::json!({
                "compilerOptions": {"paths": {alias: ["./missing"]}}
            })
            .to_string(),
        );
        let observed = analyze(request, sdk.clone()).unwrap();
        assert!(
            observed["raw_extraction"]["imports"][0]
                .get("resolvedRelPath")
                .is_none()
        );
        let subject = observed["subjects"]
            .as_array()
            .unwrap()
            .iter()
            .find(|subject| subject["path"] == "src/target.test.ts")
            .unwrap();
        assert_eq!(
            subject["reasons"]
                .as_array()
                .unwrap()
                .contains(&serde_json::json!(format!(
                    "DEPENDENCY_SCOPE_UNRESOLVED_IMPORT:src/target.test.ts:{specifier}"
                ))),
            local,
            "{alias} {specifier}"
        );
    }
}

#[test]
fn retained_negated_globstar_alias_refuses_a_trailing_slash_import() {
    let sdk = component_sdk();
    let mut request =
        dynamic_import_request("export function check(){return import('external/');}\n");
    request.files.insert(
        "/repo/package.json".into(),
        r#"{"dependencies":{"external":"1"}}"#.into(),
    );
    request.files.insert(
        "/repo/tsconfig.json".into(),
        r#"{"compilerOptions":{"paths":{"!**/*":["./missing"]}}}"#.into(),
    );
    let observed = analyze(request.clone(), sdk.clone()).unwrap();
    let subject = observed["subjects"]
        .as_array()
        .unwrap()
        .iter()
        .find(|subject| subject["path"] == "src/target.test.ts")
        .unwrap();
    assert!(
        subject["reasons"]
            .as_array()
            .unwrap()
            .contains(&serde_json::json!(
                "DEPENDENCY_SCOPE_UNRESOLVED_IMPORT:src/target.test.ts:external/"
            ))
    );
    assert_eq!(subject["outcome"], "unsupported");
    assert_eq!(
        serde_json::to_value(batch::build(&request, &sdk, &observed).unwrap()).unwrap()["terminal"],
        "refused"
    );
}

#[test]
fn retained_alias_braces_do_not_change_globstar_kind() {
    let sdk = component_sdk();
    for (alias, specifier, local) in [
        ("!**{,a}", "external/sub", true),
        ("**{,a}", "external/sub", false),
        ("!{,a}**", "external/sub", true),
        ("{,a}**", "external/sub", false),
        ("!{external/,other/}**", "external/sub/deep", true),
        ("{external/,other/}**", "external/sub/deep", false),
    ] {
        for dynamic in [true, false] {
            let text = if dynamic {
                format!("export function check(){{return import('{specifier}');}}\n")
            } else {
                format!("import '{specifier}';export function check(){{return 1;}}\n")
            };
            let mut request = dynamic_import_request(&text);
            request.files.insert(
                "/repo/package.json".into(),
                r#"{"dependencies":{"external":"1"}}"#.into(),
            );
            request.files.insert(
                "/repo/tsconfig.json".into(),
                serde_json::json!({
                    "compilerOptions":{"paths":{alias:["./missing"]}}
                })
                .to_string(),
            );
            let observed = analyze(request.clone(), sdk.clone()).unwrap();
            let subject = observed["subjects"]
                .as_array()
                .unwrap()
                .iter()
                .find(|subject| subject["path"] == "src/target.test.ts")
                .unwrap();
            assert_eq!(
                subject["reasons"]
                    .as_array()
                    .unwrap()
                    .contains(&serde_json::json!(format!(
                        "DEPENDENCY_SCOPE_UNRESOLVED_IMPORT:src/target.test.ts:{specifier}"
                    ))),
                local,
                "{alias} {specifier} dynamic={dynamic}"
            );
            if local {
                let batch =
                    serde_json::to_value(batch::build(&request, &sdk, &observed).unwrap()).unwrap();
                assert_eq!(batch["terminal"], "refused");
                let subject = batch["subjects"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|subject| subject["subject_id"] == "src/target.test.ts")
                    .unwrap();
                assert!(
                    subject["coverage"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .all(|coverage| coverage["negative_evidence_eligible"] == false)
                );
            }
        }
    }
}

#[test]
fn retained_scope_preserves_enumerable_manifest_entries() {
    let sdk = component_sdk();
    for (manifest, specifier, local) in [
        (
            r#"{"dependencies":{"0":"1"},"compilerOptions":{"paths":"a"}}"#,
            "0",
            true,
        ),
        (
            r#"{"dependencies":{"0":"1"},"compilerOptions":{"paths":["./missing"]}}"#,
            "0",
            true,
        ),
        (
            r#"{"dependencies":{"1":"1"},"compilerOptions":{"paths":"😀"}}"#,
            "1",
            true,
        ),
        (
            r#"{"dependencies":{"0":"1"},"compilerOptions":{"paths":false}}"#,
            "0",
            false,
        ),
        (r#"{"dependencies":["1"]}"#, "0", false),
        (r#"{"dependencies":"1"}"#, "0", false),
        (r#"{"dependencies":"😀"}"#, "1", false),
        (r#"{"dependencies":"\ufdd0"}"#, "1", true),
        (r#"{"dependencies":"\ud800"}"#, "1", true),
        (
            r#"{"dependencies":["1"],"optionalDependencies":{"0":false}}"#,
            "0",
            true,
        ),
    ] {
        for dynamic in [true, false] {
            let text = if dynamic {
                format!("export function check(){{return import('{specifier}');}}\n")
            } else {
                format!("import '{specifier}';export function check(){{return 1;}}\n")
            };
            let mut request = dynamic_import_request(&text);
            request
                .files
                .insert("/repo/package.json".into(), manifest.into());
            let observed = analyze(request.clone(), sdk.clone()).unwrap();
            let subject = observed["subjects"]
                .as_array()
                .unwrap()
                .iter()
                .find(|subject| subject["path"] == "src/target.test.ts")
                .unwrap();
            assert_eq!(
                subject["reasons"]
                    .as_array()
                    .unwrap()
                    .contains(&serde_json::json!(format!(
                        "DEPENDENCY_SCOPE_UNRESOLVED_IMPORT:src/target.test.ts:{specifier}"
                    ))),
                local,
                "{manifest} {specifier} dynamic={dynamic}"
            );
            let batch =
                serde_json::to_value(batch::build(&request, &sdk, &observed).unwrap()).unwrap();
            assert_eq!(
                batch["terminal"],
                if local { "refused" } else { "complete" }
            );
            if local {
                let subject = batch["subjects"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|subject| subject["subject_id"] == "src/target.test.ts")
                    .unwrap();
                assert!(
                    subject["coverage"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .all(|entry| entry["negative_evidence_eligible"] == false)
                );
            }
        }
    }
}

#[test]
fn retained_scope_preserves_parsed_manifest_prototypes() {
    let sdk = component_sdk();
    for (manifest, specifier, local) in [
        (r#"{"dependencies":{"__proto__":"1"}}"#, "__proto__", true),
        (
            r#"{"dependencies":{"external":"1"},"__proto__":{"compilerOptions":{"paths":{"external":["./missing"]}}}}"#,
            "external",
            true,
        ),
        (
            r#"{"__proto__":{"dependencies":{"external":"1"}}}"#,
            "external",
            false,
        ),
        (
            r#"{"__proto__":{"name":"external"},"dependencies":{"external":"1"}}"#,
            "external",
            true,
        ),
        (
            r#"{"dependencies":{"__proto__":null,"__proto__":"1"},"compilerOptions":{"paths":{"__proto__":null,"__proto__":["./missing"]}}}"#,
            "__proto__",
            true,
        ),
        (
            r#"{"dependencies":{"external":"1"},"compilerOptions":{"__proto__":{"paths":{"external":["./missing"]}}}}"#,
            "external",
            true,
        ),
        (
            r#"{"dependencies":{"external":"1"},"compilerOptions":{"paths":{"__proto__":{"external":["./missing"]}}}}"#,
            "external",
            false,
        ),
        (
            r#"{"dependencies":{"__proto__":null,"__proto__":"1"}}"#,
            "__proto__",
            false,
        ),
        (
            r#"{"dependencies":{"__proto__":{},"__proto__":"1"}}"#,
            "__proto__",
            true,
        ),
        (
            r#"{"__proto__":{"compilerOptions":{"paths":{"external":["./missing"]}}},"__proto__":"ignored","dependencies":{"external":"1"}}"#,
            "external",
            true,
        ),
        (
            r#"{"__proto__":{"compilerOptions":{"paths":{"external":["./missing"]}}},"__proto__":null,"dependencies":{"external":"1"}}"#,
            "external",
            false,
        ),
        ("{'dependencies':{'external':'1'}}", "external", true),
    ] {
        for dynamic in [true, false] {
            let text = if dynamic {
                format!("export function check(){{return import('{specifier}');}}\n")
            } else {
                format!("import '{specifier}';export function check(){{return 1;}}\n")
            };
            let mut request = dynamic_import_request(&text);
            request
                .files
                .insert("/repo/package.json".into(), manifest.into());
            let observed = analyze(request.clone(), sdk.clone()).unwrap();
            let subject = observed["subjects"]
                .as_array()
                .unwrap()
                .iter()
                .find(|subject| subject["path"] == "src/target.test.ts")
                .unwrap();
            assert_eq!(
                subject["reasons"]
                    .as_array()
                    .unwrap()
                    .contains(&serde_json::json!(format!(
                        "DEPENDENCY_SCOPE_UNRESOLVED_IMPORT:src/target.test.ts:{specifier}"
                    ))),
                local,
                "{manifest} {specifier} dynamic={dynamic}"
            );
            let batch =
                serde_json::to_value(batch::build(&request, &sdk, &observed).unwrap()).unwrap();
            assert_eq!(
                batch["terminal"],
                if local { "refused" } else { "complete" }
            );
            if local {
                let subject = batch["subjects"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|subject| subject["subject_id"] == "src/target.test.ts")
                    .unwrap();
                assert!(
                    subject["coverage"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .all(|entry| entry["negative_evidence_eligible"] == false)
                );
            }
        }
    }
}

#[test]
fn retained_aliases_use_javascript_characters_instead_of_port_string_markers() {
    let sdk = component_sdk();
    for (literal, alias, local) in [
        (r"\ufdd0", "?", true),
        (r"\ufdd0", "??", false),
        (r"\ufdd0", "!?", false),
        (r"\ud800", "?", true),
        (r"\ud800", "??", false),
        (r"\ud800", r"[\ufffd]", true),
        (r"\ud800", r"[!\ufffd]", false),
        (r"\ud800\ud800", "??", true),
        (r"\ud800\ud800", "?", false),
        (r"\ud800\ud800", r"\ufffd\ufffd", true),
        (r"\ud800\udc00", "?", true),
        (r"\ud800\udc00", r"[\ufffd]", false),
        (r"\udc00\ud800", "??", true),
    ] {
        for dynamic in [true, false] {
            let text = if dynamic {
                format!("export function check(){{return import('{literal}');}}\n")
            } else {
                format!("import '{literal}';export function check(){{return 1;}}\n")
            };
            let mut request = dynamic_import_request(&text);
            request.files.insert("/repo/package.json".into(), format!(
                    r#"{{"dependencies":{{"{literal}":"1"}},"compilerOptions":{{"paths":{{"{alias}":[]}}}}}}"#
                ));
            let observed = analyze(request.clone(), sdk.clone()).unwrap();
            let subject = observed["subjects"]
                .as_array()
                .unwrap()
                .iter()
                .find(|subject| subject["path"] == "src/target.test.ts")
                .unwrap();
            assert_eq!(
                subject["reasons"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|reason| reason
                        .as_str()
                        .unwrap()
                        .starts_with("DEPENDENCY_SCOPE_UNRESOLVED_IMPORT:src/target.test.ts:")),
                local,
                "{literal} {alias} dynamic={dynamic}"
            );
            let batch =
                serde_json::to_value(batch::build(&request, &sdk, &observed).unwrap()).unwrap();
            assert_eq!(
                batch["terminal"],
                if local { "refused" } else { "complete" }
            );
            if local {
                let subject = batch["subjects"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|subject| subject["subject_id"] == "src/target.test.ts")
                    .unwrap();
                assert!(
                    subject["coverage"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .all(|entry| entry["negative_evidence_eligible"] == false)
                );
            }
        }
    }
}

#[test]
fn retained_scope_keeps_package_suffix_metadata_from_consumed_configurations() {
    let sdk = component_sdk();
    for (filename, package, configuration, local) in [
        (
            "tsconfigpackage.json",
            r#"{"dependencies":{"external":"1"}}"#,
            r#"{"name":"external"}"#,
            true,
        ),
        (
            "tsconfig.package.json",
            r#"{"dependencies":{"external":"1"}}"#,
            "{}",
            true,
        ),
        (
            "tsconfigpackage.json",
            "{}",
            r#"{"dependencies":{"external":"1"}}"#,
            false,
        ),
        (
            "configpackage.json",
            r#"{"dependencies":{"external":"1"}}"#,
            r#"{"name":"external"}"#,
            false,
        ),
    ] {
        for dynamic in [true, false] {
            let text = if dynamic {
                "export function check(){return import('external');}\n"
            } else {
                "import 'external';export function check(){return 1;}\n"
            };
            let mut request = dynamic_import_request(text);
            request
                .files
                .insert("/repo/package.json".into(), package.into());
            request
                .files
                .insert(format!("/repo/{filename}"), configuration.into());
            request.files.insert(
                "/repo/tsconfig.json".into(),
                serde_json::json!({"extends":format!("./{filename}")}).to_string(),
            );
            let observed = analyze(request.clone(), sdk.clone()).unwrap();
            let subject = observed["subjects"]
                .as_array()
                .unwrap()
                .iter()
                .find(|subject| subject["path"] == "src/target.test.ts")
                .unwrap();
            assert_eq!(
                subject["reasons"]
                    .as_array()
                    .unwrap()
                    .contains(&serde_json::json!(
                        "DEPENDENCY_SCOPE_UNRESOLVED_IMPORT:src/target.test.ts:external"
                    )),
                local,
                "{filename} {configuration} dynamic={dynamic}"
            );
            let batch =
                serde_json::to_value(batch::build(&request, &sdk, &observed).unwrap()).unwrap();
            assert_eq!(
                batch["terminal"],
                if local { "refused" } else { "complete" }
            );
            if local {
                let subject = batch["subjects"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|subject| subject["subject_id"] == "src/target.test.ts")
                    .unwrap();
                assert!(
                    subject["coverage"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .all(|entry| entry["negative_evidence_eligible"] == false)
                );
            }
        }
    }
}

#[test]
fn retained_scope_applies_same_directory_metadata_in_javascript_capture_order() {
    let sdk = component_sdk();
    for external in [false, true] {
        for dynamic in [true, false] {
            let text = if dynamic {
                "export function check(){return import('external');}\n"
            } else {
                "import 'external';export function check(){return 1;}\n"
            };
            let mut request = dynamic_import_request(text);
            request
                .files
                .insert("/repo/package.json".into(), "{}".into());
            let declaration = r#"{"dependencies":{"external":"1"}}"#;
            request.files.insert(
                "/repo/tsconfig😀package.json".into(),
                if external { "{}" } else { declaration }.into(),
            );
            request.files.insert(
                "/repo/tsconfig\u{e000}package.json".into(),
                if external { declaration } else { "{}" }.into(),
            );
            request.files.insert("/repo/tsconfig.json".into(), serde_json::json!({"extends":["./tsconfig😀package.json", "./tsconfig\u{e000}package.json"]}).to_string());
            let observed = analyze(request.clone(), sdk.clone()).unwrap();
            let subject = observed["subjects"]
                .as_array()
                .unwrap()
                .iter()
                .find(|subject| subject["path"] == "src/target.test.ts")
                .unwrap();
            assert_eq!(
                subject["reasons"]
                    .as_array()
                    .unwrap()
                    .contains(&serde_json::json!(
                        "DEPENDENCY_SCOPE_UNRESOLVED_IMPORT:src/target.test.ts:external"
                    )),
                !external,
                "external={external} dynamic={dynamic}"
            );
            let batch =
                serde_json::to_value(batch::build(&request, &sdk, &observed).unwrap()).unwrap();
            assert_eq!(
                batch["terminal"],
                if external { "complete" } else { "refused" }
            );
            if !external {
                let subject = batch["subjects"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|subject| subject["subject_id"] == "src/target.test.ts")
                    .unwrap();
                assert!(
                    subject["coverage"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .all(|entry| entry["negative_evidence_eligible"] == false)
                );
            }
        }
    }
}

#[test]
fn retained_unresolved_diagnostics_keep_exact_utf16_at_the_batch_boundary() {
    let sdk = component_sdk();
    for (literal, units) in [
        (r"\ufdd0", vec![0xfdd0]),
        (r"\ud800", vec![0xd800]),
        (r"\ud800\ud800", vec![0xd800, 0xd800]),
        (r"\udc00\ud800", vec![0xdc00, 0xd800]),
        (r"\ud800\udc00", vec![0xd800, 0xdc00]),
    ] {
        let request = dynamic_import_request(&format!(
            "export function check(){{return import('{literal}');}}\n"
        ));
        let mut expected = "DEPENDENCY_SCOPE_UNRESOLVED_IMPORT:src/target.test.ts:"
            .encode_utf16()
            .collect::<Vec<_>>();
        expected.extend(units);
        let observed = analyze(request.clone(), sdk.clone()).unwrap();
        let subject = observed["subjects"]
            .as_array()
            .unwrap()
            .iter()
            .find(|subject| subject["path"] == "src/target.test.ts")
            .unwrap();
        assert_eq!(
            subject["reasons"],
            serde_json::json!([String::from_utf16_lossy(&expected)])
        );
        assert_eq!(
            subject["unresolvedImportReasonsUtf16"],
            serde_json::json!([expected.clone()])
        );
        let batch = serde_json::to_value(batch::build(&request, &sdk, &observed).unwrap()).unwrap();
        assert_eq!(batch["terminal"], "refused");
        let diagnostics = batch["diagnostics"].as_array().unwrap();
        let diagnostic = diagnostics
            .iter()
            .find(|diagnostic| {
                diagnostic["code"]
                    .as_str()
                    .is_some_and(|code| code.starts_with("DEPENDENCY_SCOPE_UNRESOLVED_IMPORT:"))
            })
            .unwrap();
        assert_eq!(diagnostic["code_utf16"], serde_json::json!(expected));
        assert_eq!(diagnostic["message_utf16"], serde_json::json!(expected));
        assert_eq!(diagnostic["code"], String::from_utf16_lossy(&expected));
        for malformed in [
            serde_json::Value::Null,
            serde_json::json!([[65536]]),
            serde_json::json!([[]]),
            serde_json::json!([expected.clone(), expected.clone()]),
        ] {
            let mut altered = observed.clone();
            let subject = altered["subjects"]
                .as_array_mut()
                .unwrap()
                .iter_mut()
                .find(|subject| subject["path"] == "src/target.test.ts")
                .unwrap();
            subject["unresolvedImportReasonsUtf16"] = malformed;
            assert!(batch::build(&request, &sdk, &altered).is_err());
        }
    }
    let request = dynamic_import_request(
        "export function check(){return Promise.all([import('\\ud800'),import('\\ud801')]);}\n",
    );
    let observed = analyze(request.clone(), sdk.clone()).unwrap();
    let batch = serde_json::to_value(batch::build(&request, &sdk, &observed).unwrap()).unwrap();
    let diagnostics = batch["diagnostics"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|d| {
            d["code"]
                .as_str()
                .is_some_and(|c| c.starts_with("DEPENDENCY_SCOPE_UNRESOLVED_IMPORT:"))
        })
        .collect::<Vec<_>>();
    assert_eq!(diagnostics.len(), 2);
    assert_eq!(diagnostics[0]["code"], diagnostics[1]["code"]);
    assert_ne!(diagnostics[0]["code_utf16"], diagnostics[1]["code_utf16"]);
}

#[test]
fn retained_alias_inspection_keeps_valid_large_configuration_contexts() {
    let sdk = component_sdk();
    for aliases in [
        (0..1025)
            .map(|index| {
                (
                    format!("unrelated-{index}"),
                    serde_json::json!(["./missing"]),
                )
            })
            .collect::<serde_json::Map<_, _>>(),
        serde_json::Map::from_iter([("a".repeat(4097), serde_json::json!(["./missing"]))]),
    ] {
        let mut request =
            dynamic_import_request("export function check(){return import('external');}\n");
        request.files.insert(
            "/repo/package.json".into(),
            r#"{"dependencies":{"external":"1"}}"#.into(),
        );
        request.files.insert(
            "/repo/tsconfig.json".into(),
            serde_json::json!({
                "compilerOptions":{"paths":aliases}
            })
            .to_string(),
        );
        let observed = analyze(request.clone(), sdk.clone()).unwrap();
        assert_eq!(
            serde_json::to_value(batch::build(&request, &sdk, &observed).unwrap()).unwrap()["terminal"],
            "complete"
        );
    }
}

#[test]
fn retained_unresolved_builtins_keep_the_qualified_prefix_distinctions() {
    let sdk = component_sdk();
    for (specifier, external) in [
        ("sqlite", false),
        ("node:test", true),
        ("node:node:sqlite", true),
    ] {
        let request = dynamic_import_request(&format!(
            "export function check(){{return import('{specifier}');}}\n"
        ));
        let observed = analyze(request, sdk.clone()).unwrap();
        let import = &observed["raw_extraction"]["imports"][0];
        assert_eq!(import["moduleSpecifier"], specifier);
        assert!(import.get("resolvedRelPath").is_none());
        let subject = observed["subjects"]
            .as_array()
            .unwrap()
            .iter()
            .find(|subject| subject["path"] == "src/target.test.ts")
            .unwrap();
        assert_eq!(
            subject["reasons"]
                .as_array()
                .unwrap()
                .contains(&serde_json::json!(format!(
                    "DEPENDENCY_SCOPE_UNRESOLVED_IMPORT:src/target.test.ts:{specifier}"
                ))),
            !external,
            "{specifier}"
        );
    }
}

#[test]
fn retained_literal_dynamic_import_keeps_its_resolved_unproven_binding() {
    let request = dynamic_import_request(
        "export async function check(){const dep=await import('./target');return dep.helper();}\n",
    );
    let observed = analyze(request, component_sdk()).unwrap();
    assert_eq!(
        observed["test_dynamic_import_keys"],
        serde_json::json!(["src/target.test.ts:1:./target"])
    );
    assert_eq!(
        observed["raw_extraction"]["imports"][0]["resolvedRelPath"],
        "src/target.ts"
    );
    assert!(
        observed["raw_extraction"]["imports"][0]
            .get("bindingTargets")
            .is_none()
    );
    let subject = observed["subjects"]
        .as_array()
        .unwrap()
        .iter()
        .find(|subject| subject["path"] == "src/target.test.ts")
        .unwrap();
    assert!(
        subject["reasons"]
            .as_array()
            .unwrap()
            .contains(&serde_json::json!(
                "QUALIFIED_TEST_DYNAMIC_IMPORT_BINDING_UNPROVEN:src/target.ts"
            ))
    );
    assert!(
        !subject["reasons"]
            .as_array()
            .unwrap()
            .iter()
            .any(|reason| reason.as_str().unwrap().starts_with("DEPENDENCY_SCOPE_"))
    );
}

#[test]
#[cfg(unix)]
fn captured_analysis_checks_physical_aliases_and_surfaces_canonicalization_failures() {
    let directory = std::env::temp_dir().join(format!(
        "semctx-captured-alias-dev-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let root = directory.join("repo");
    let outside = directory.join("outside");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::create_dir_all(&outside).unwrap();
    std::os::unix::fs::symlink(&outside, root.join("external")).unwrap();
    std::os::unix::fs::symlink("loop", root.join("loop")).unwrap();
    std::fs::write(root.join("inside.ts"), "export const leaf = 1;").unwrap();
    std::os::unix::fs::symlink("inside.ts", root.join("alias.ts")).unwrap();
    let root_text = root.to_str().unwrap();
    let source = root.join("main.ts");
    let observe = |text: &str, leaf: Option<(&str, &str)>| {
        let mut request = component_request("physicalAliasDev", source.to_str().unwrap(), text);
        request.cwd = root_text.into();
        if let Some((path, text)) = leaf {
            request
                .files
                .insert(format!("{root_text}/{path}"), text.into());
        }
        analyze(request, component_sdk())
    };
    let missing = observe("import './external/missing'; export const value = 1;", None);
    let looped = observe("import './loop'; export const value = 1;", None);
    let internal = observe(
        "import {leaf} from './alias.ts'; export const value = leaf;",
        Some(("alias.ts", "export const leaf = 1;")),
    );
    std::fs::remove_dir_all(directory).unwrap();
    assert_eq!(
        missing.err(),
        Some("IMPORT_OUTSIDE_REPOSITORY: ./external/missing".into())
    );
    assert!(
        looped
            .unwrap_err()
            .starts_with("SOURCE_CANONICAL_PATH_UNAVAILABLE:")
    );
    assert!(internal.is_ok());
}

#[test]
fn captured_analysis_refuses_property_require_and_amd_dependencies() {
    for text in [
        "custom.require('../../guardOutside'); export const value = 1;",
        "define(['../../guardOutside'], () => 1);",
        "define('named', ['../../guardOutside'], () => 1);",
    ] {
        let request = component_request("javascriptImportsDev", "/repo/main.ts", text);
        assert_eq!(
            analyze(request, component_sdk()).err(),
            Some("IMPORT_OUTSIDE_REPOSITORY: ../../guardOutside".into()),
            "{text}"
        );
    }
}

#[test]
fn captured_analysis_keeps_sdk59_non_dependency_call_and_template_contexts() {
    for text in [
        "export const note = \"define(['../../guardOutside'])\";",
        "export const note = `${require('../../guardOutside')}`;",
        "export const note = `${custom.require('../../guardOutside')}`;",
        "(require)('../../guardOutside'); export const value = 1;",
        "custom['require']('../../guardOutside'); export const value = 1;",
        "require?.('../../guardOutside'); export const value = 1;",
        "define?.(['../../guardOutside'], () => 1);",
    ] {
        let request = component_request("nonDependencyContextDev", "/repo/main.ts", text);
        assert!(analyze(request, component_sdk()).is_ok(), "{text}");
    }
}

#[test]
fn captured_analysis_accepts_equivalent_dot_and_parent_repository_roots() {
    let directory =
        std::env::temp_dir().join(format!("semctx-root-spelling-dev-{}", std::process::id()));
    std::fs::create_dir(&directory).unwrap();
    let source = directory.join("main.ts");
    let mut request = component_request(
        "rootSpellingDev",
        source.to_str().unwrap(),
        "export const value = 1;",
    );
    request.cwd = format!("{}/./missing/..", directory.display());
    let observed = analyze(request, component_sdk());
    std::fs::remove_dir(directory).unwrap();
    assert!(observed.is_ok(), "{:?}", observed.err());
}

#[test]
fn captured_analysis_refuses_relative_import_escape_even_when_target_is_absent() {
    for outside_present in [false, true] {
        let mut request = component_request(
            "capturedConfinementDev",
            "/repo/src/guardConsumer.ts",
            "import { guardedValue } from '../../guardOutside'; export const observed = guardedValue;",
        );
        if outside_present {
            request.files.insert(
                "/guardOutside.ts".into(),
                "export const guardedValue = 109;".into(),
            );
        }
        assert_eq!(
            analyze(request, component_sdk()).err(),
            Some("IMPORT_OUTSIDE_REPOSITORY: ../../guardOutside".into()),
            "outside target present: {outside_present}"
        );
    }
}

#[test]
fn captured_analysis_keeps_a_parent_directory_import_inside_the_repository() {
    let mut request = component_request(
        "capturedConfinementParentDev",
        "/repo/src/guardConsumer.ts",
        "import { guardedValue } from '..'; export const observed = guardedValue;",
    );
    request.files.insert(
        "/repo/index.ts".into(),
        "export const guardedValue = 113;".into(),
    );
    let observed = analyze(request, component_sdk()).unwrap();
    assert_eq!(
        observed["raw_extraction"]["imports"][0]["resolvedRelPath"],
        "index.ts"
    );
}

#[test]
fn captured_analysis_checks_relative_imports_in_reached_dependencies() {
    let mut request = component_request(
        "capturedConfinementTransitiveDev",
        "/repo/src/guardConsumer.ts",
        "import { guardedValue } from './bridge'; export const observed = guardedValue;",
    );
    request.files.insert(
        "/repo/src/bridge.ts".into(),
        "import { guardedValue } from '../../guardOutside'; export { guardedValue };".into(),
    );
    assert_eq!(
        analyze(request, component_sdk()).err(),
        Some("IMPORT_OUTSIDE_REPOSITORY: ../../guardOutside".into())
    );
}

#[test]
fn captured_analysis_does_not_check_unreached_captured_sources() {
    let mut request = component_request(
        "capturedConfinementUnreachedDev",
        "/repo/src/guardConsumer.ts",
        "export const observed = 127;",
    );
    request.files.insert(
        "/repo/unreached.ts".into(),
        "import { guardedValue } from '../guardOutside'; export { guardedValue };".into(),
    );
    let observed = analyze(request, component_sdk()).unwrap();
    assert_eq!(
        observed["raw_extraction"]["modules"],
        serde_json::json!(["src/guardConsumer.ts"])
    );
}

#[test]
fn captured_analysis_refuses_an_outside_reference_and_a_traversing_root() {
    let request = component_request(
        "capturedConfinementReferenceDev",
        "/repo/src/guardConsumer.ts",
        "/// <reference path=\"../../guardOutside.d.ts\" />\nexport const observed = 131;",
    );
    assert_eq!(
        analyze(request, component_sdk()).err(),
        Some("REFERENCE_OUTSIDE_REPOSITORY: ../../guardOutside.d.ts".into())
    );
    let request = component_request(
        "capturedConfinementRootDev",
        "/repo/src/../../guardOutside.ts",
        "export const observed = 137;",
    );
    assert!(
        analyze(request, component_sdk())
            .err()
            .is_some_and(|error| error.starts_with("source outside repository:"))
    );
}

#[test]
fn captured_analysis_refuses_missing_source_bytes_before_native_analysis() {
    let mut request = component_request(
        "capturedConfinementMissingDev",
        "/repo/src/guardConsumer.ts",
        "export const observed = 139;",
    );
    request.files.clear();
    assert_eq!(
        analyze(request, component_sdk()).err(),
        Some("SOURCE_SNAPSHOT_MISSING: src/guardConsumer.ts".into())
    );
}

#[test]
fn captured_analysis_confines_the_sdk59_relative_dependency_syntaxes() {
    for source in [
        "import { x } from '../../guardOutside';",
        "export { x } from '../../guardOutside';",
        "export const x = import('../../guardOutside');",
        "const x = require('../../guardOutside');",
        "export type X = import('../../guardOutside').X;",
        "import x = require('../../guardOutside');",
    ] {
        let request = component_request(
            "capturedConfinementSyntaxDev",
            "/repo/src/guardConsumer.ts",
            source,
        );
        assert_eq!(
            analyze(request, component_sdk()).err(),
            Some("IMPORT_OUTSIDE_REPOSITORY: ../../guardOutside".into()),
            "{source}"
        );
    }
    let request = component_request(
        "capturedConfinementQuotedDev",
        "/repo/src/guardConsumer.ts",
        "export const note = \"import { x } from '../../guardOutside';\";",
    );
    assert!(analyze(request, component_sdk()).is_ok());
}

#[test]
fn loaded_module_partition_connects_selected_roots_through_an_unselected_source() {
    let mut request = component_request(
        "loadedPartitionDev",
        "/repo/a.ts",
        "import { middle } from './middle'; export const a = middle + 1\n",
    );
    request.retained = false;
    request.roots.push("/repo/b.ts".into());
    request.files.insert(
        "/repo/middle.ts".into(),
        "import { b } from './b'; export const middle = b + 1\n".into(),
    );
    request
        .files
        .insert("/repo/b.ts".into(), "export const b = 1\n".into());
    request.files.insert(
        "/repo/unloaded.ts".into(),
        "export const unloaded = 2;".into(),
    );
    let observed = analyze(request, component_sdk()).unwrap();
    let partition = &observed["partitionObservation"];
    assert_eq!(partition["executed"], true, "{partition}");
    assert_eq!(partition["unsupported"], serde_json::json!([]));
    assert_eq!(
        partition["selectedRoots"],
        serde_json::json!(["a.ts", "b.ts"])
    );
    assert_eq!(
        partition["dependencyComponents"],
        serde_json::json!([["a.ts", "b.ts"]])
    );
    assert_eq!(
        partition["loadedRepositorySources"],
        serde_json::json!(["a.ts", "b.ts", "middle.ts"])
    );
    assert_eq!(
        partition["resolvedEdges"],
        serde_json::json!([
            {"from":"a.ts","specifier":"./middle","to":"middle.ts"},
            {"from":"middle.ts","specifier":"./b","to":"b.ts"}
        ])
    );
    assert_eq!(
        observed["raw_extraction"]["modules"],
        serde_json::json!(["a.ts", "b.ts"])
    );
    assert_eq!(partition["globalAdmissionInferred"], false);
}

#[test]
fn loaded_module_partition_excludes_a_shared_external_package_from_connectivity() {
    let mut request = component_request(
        "externalPartitionDev",
        "/repo/a.ts",
        "import { marker } from 'shared-package'; export const a = marker;",
    );
    request.retained = false;
    request.roots.push("/repo/b.ts".into());
    request.files.extend([
        (
            "/repo/b.ts".into(),
            "import { marker } from 'shared-package'; export const b = marker;".into(),
        ),
        (
            "/repo/node_modules/shared-package/package.json".into(),
            r#"{"name":"shared-package","types":"index.d.ts"}"#.into(),
        ),
        (
            "/repo/node_modules/shared-package/index.d.ts".into(),
            "export declare const marker: number;".into(),
        ),
    ]);
    let observed = analyze(request, component_sdk()).unwrap();
    assert_eq!(observed["partitionObservation"]["executed"], true);
    assert_eq!(
        observed["partitionObservation"]["dependencyComponents"],
        serde_json::json!([["a.ts"], ["b.ts"]])
    );
    assert_eq!(
        observed["partitionObservation"]["loadedRepositorySources"],
        serde_json::json!(["a.ts", "b.ts"])
    );
    assert_eq!(
        observed["partitionObservation"]["resolvedEdges"],
        serde_json::json!([])
    );
    assert!(
        observed["capture_probes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|probe| {
                probe["operation"] == "read_file"
                    && probe["found"] == true
                    && probe["path"] == "/repo/node_modules/shared-package/index.d.ts"
            })
    );
}

#[test]
fn loaded_module_partition_connectivity_is_undirected() {
    let mut request = component_request("reversePartitionDev", "/repo/a.ts", "export const a=1;");
    request.retained = false;
    request.roots.push("/repo/b.ts".into());
    request.files.extend([
        (
            "/repo/middle.ts".into(),
            "import { a } from './a'; export const middle=a+1;".into(),
        ),
        (
            "/repo/b.ts".into(),
            "import { middle } from './middle'; export const b=middle+1;".into(),
        ),
    ]);
    let observed = analyze(request, component_sdk()).unwrap();
    assert_eq!(
        observed["partitionObservation"]["dependencyComponents"],
        serde_json::json!([["a.ts", "b.ts"]])
    );
    assert_eq!(
        observed["partitionObservation"]["resolvedEdges"],
        serde_json::json!([
            {"from":"b.ts","specifier":"./middle","to":"middle.ts"},
            {"from":"middle.ts","specifier":"./a","to":"a.ts"}
        ])
    );
}

#[test]
fn loaded_module_partition_does_not_claim_parallel_safety_or_retained_execution() {
    for (retained, qualified) in [(false, false), (true, false), (true, true)] {
        let mut request =
            component_request("partitionScopeDev", "/repo/global.ts", "const shared=1;");
        request.retained = retained;
        request.qualified = qualified;
        let observed = analyze(request, component_sdk()).unwrap();
        let partition = &observed["partitionObservation"];
        assert_eq!(partition["parallelSafetyEvaluated"], false);
        assert_eq!(partition["globalAdmissionInferred"], false);
        assert_eq!(partition["executed"], !retained);
        if retained {
            assert_eq!(
                partition["unsupported"],
                serde_json::json!(["COMPONENT_ORDINARY_INPUTS_NOT_ENABLED"])
            );
            assert!(partition.get("dependencyComponents").is_none());
        } else {
            assert_eq!(
                partition["dependencyComponents"],
                serde_json::json!([["global.ts"]])
            );
        }
    }
}

#[test]
fn loaded_module_partition_reports_unavailable_or_duplicate_selected_context() {
    let fs = Rc::new(CaptureFs::new(
        BTreeMap::from([
            ("/repo/a.ts".into(), "export const a=1;".into()),
            (
                "/outside/external.ts".into(),
                "export const external=2;".into(),
            ),
        ]),
        ts_goport::frontend::vfs::osvfs_fs().use_case_sensitive_file_names(),
    ));
    let mut options = compiler_options();
    options.no_lib = Tristate::True;
    let frontend = native_frontend_with_options(
        fs.clone(),
        "/repo",
        "/sdk/lib",
        vec!["/repo/a.ts".into(), "/outside/external.ts".into()],
        false,
        options,
    );
    let _current = native_program::NativeProgram::enter(&frontend.program);
    program::bind_all();
    for (roots, expected) in [
        (
            vec!["/repo/missing.ts".into()],
            "PARTITION_SELECTED_SOURCE_UNAVAILABLE",
        ),
        (
            vec!["/repo/a.ts".into(), "/repo/a.ts".into()],
            "PARTITION_DUPLICATE_SELECTED_SOURCE",
        ),
        (
            vec!["/outside/external.ts".into()],
            "PARTITION_SELECTED_SOURCE_OUTSIDE_GRAPH",
        ),
    ] {
        let observed = partition_observations::observe(&frontend.program, &fs, "/repo", &roots);
        assert_eq!(observed["executed"], false, "{observed}");
        assert_eq!(observed["unsupported"], serde_json::json!([expected]));
        assert!(observed.get("dependencyComponents").is_none());
    }
    let empty = partition_observations::observe(&frontend.program, &fs, "/repo", &[]);
    assert_eq!(empty["executed"], true);
    assert_eq!(empty["dependencyComponents"], serde_json::json!([]));
}

#[test]
fn opaque_callback_observation_tracks_actual_graph_ownership_and_edge_removal() {
    let source = "import { register } from 'opaque'; function helper() { return 1; } export function main() { return register(() => helper()); }";
    let mut request = component_request("opaqueOwnershipDev", "/repo/main.ts", source);
    request.retained = true;
    request.qualified = true;
    request.files.insert(
        "/repo/package.json".into(),
        r#"{"dependencies":{"opaque":"1.0.0"}}"#.into(),
    );
    let observed = analyze(request, component_sdk()).unwrap();
    let ownership = &observed["subjects"][0]["opaqueCallbackOwnership"];
    assert_eq!(ownership["executed"], true, "{ownership}");
    assert_eq!(ownership["unsupported"], serde_json::json!([]));
    for (phase, expected) in [
        ("beforeAnalysis", true),
        ("afterAnalysis", false),
        ("afterGraphEdgesRemoved", true),
    ] {
        let phase = &ownership[phase];
        assert_eq!(phase["executed"], true, "{phase}");
        assert_eq!(phase["unsupported"], serde_json::json!([]), "{phase}");
        assert_eq!(
            phase["reasons"]
                .as_array()
                .unwrap()
                .iter()
                .any(|reason| reason == "SOURCE_OPAQUE_CALLBACK_UNSUPPORTED"),
            expected,
            "{phase}"
        );
    }
    let graph = &observed["assembly"];
    assert_eq!(
        ownership["graphBeforeEdgeRemovalId"],
        identity::digest(graph)
    );
    let mut removed_graph = graph.clone();
    removed_graph["edges"] = serde_json::json!([]);
    assert_eq!(
        ownership["graphAfterEdgeRemovalId"],
        identity::digest(&removed_graph)
    );
    let nodes = graph["nodes"].as_array().unwrap();
    let caller = nodes.iter().find(|node| node["name"] == "main").unwrap();
    let helper = nodes.iter().find(|node| node["name"] == "helper").unwrap();
    assert!(graph["edges"].as_array().unwrap().iter().any(|edge| {
        edge["kind"] == "calls" && edge["from"] == caller["id"] && edge["to"] == helper["id"]
    }));
    assert_eq!(ownership["globalAdmissionInferred"], false);
}

#[test]
fn opaque_callback_observation_requires_retained_qualified_inputs() {
    for (retained, qualified) in [(false, false), (true, false)] {
        let mut request = component_request(
            "opaqueOwnershipModeDev",
            "/repo/mode.ts",
            "export function leaf(){return 1;}",
        );
        request.retained = retained;
        request.qualified = qualified;
        let observed = analyze(request, component_sdk()).unwrap();
        let ownership = &observed["subjects"][0]["opaqueCallbackOwnership"];
        assert_eq!(ownership["executed"], false, "{ownership}");
        assert_eq!(
            ownership["unsupported"],
            serde_json::json!(["COMPONENT_RETAINED_QUALIFIED_INPUTS_NOT_ENABLED"])
        );
        assert!(ownership.get("beforeAnalysis").is_none());
        assert!(ownership.get("afterAnalysis").is_none());
        assert!(ownership.get("afterGraphEdgesRemoved").is_none());
    }
}

#[test]
fn opaque_callback_observation_does_not_substitute_a_missing_native_phase() {
    let observed = serde_json::json!({
        "moduleConfigurationObservations":{
            "retainedWithoutSource":{"executed":true,"unsupported":[],"reasons":[]}
        }
    });
    let graph = serde_json::json!({"nodes":[],"edges":[]});
    for missing in [
        serde_json::Value::Null,
        serde_json::json!({}),
        serde_json::json!({"moduleConfigurationObservations":{"retainedWithoutSource":null}}),
        serde_json::json!({"moduleConfigurationObservations":{"retainedWithoutSource":[]}}),
    ] {
        for index in 0..3 {
            let mut phases = [&observed, &observed, &observed];
            phases[index] = &missing;
            assert!(
                component_observations::opaque_callback_ownership(
                    phases[0], phases[1], phases[2], &graph, &graph
                )
                .is_err()
            );
        }
    }
}

#[test]
fn explicit_configured_query_cli_resolves_without_inserting_an_import() {
    let directory = std::env::temp_dir().join(format!(
        "semctx-explicit-configured-query-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir(&directory).unwrap();
    let descriptor = serde_json::json!({
        "root":"/repo", "sdk_directory":"/sdk/lib",
        "case_sensitive":ts_goport::frontend::vfs::osvfs_fs().use_case_sensitive_file_names(),
        "files":{
            "/repo/source.ts":"export const sourceDev = 53;",
            "/repo/leaf.ts":"export const leafDev = 59;",
            "/repo/tsconfig.json":r##"{"compilerOptions":{"baseUrl":".","paths":{"#leaf":["./leaf.ts"]}}}"##
        },
        "directories":["/repo/.git"],
        "containing_file":"/repo/source.ts", "specifier":"#leaf"
    });
    let request = directory.join("descriptor.json");
    std::fs::write(&request, serde_json::to_vec(&descriptor).unwrap()).unwrap();
    let args = vec![
        "semctx-r0-probe".into(),
        "--observe-configured-resolution".into(),
        request.to_string_lossy().into_owned(),
        concat!(env!("CARGO_MANIFEST_DIR"), "/sdk/sdk-input.json").into(),
    ];
    let observed = additional_observation(&args).unwrap();
    std::fs::remove_dir_all(&directory).unwrap();
    let observed = observed.expect("explicit configured-resolution operation must execute");
    assert_eq!(observed["executed"], true, "{observed}");
    assert_eq!(observed["unsupported"], serde_json::json!([]));
    assert_eq!(observed["resolved_relative_path"], "leaf.ts");
    assert_eq!(
        observed["configuration"],
        serde_json::json!({"executed":true,"reasons":[],"unsupported":[]})
    );
    assert_eq!(
        observed["capturedDirectories"],
        serde_json::json!([{"path":"/repo/.git","found":true}])
    );
    assert_eq!(
        observed["request_descriptor_id"],
        serde_json::json!(identity::digest(&descriptor))
    );
    assert_eq!(observed["containing_file"], "/repo/source.ts");
    assert_eq!(observed["specifier"], "#leaf");
}

#[test]
fn retained_callable_observation_distinguishes_type_origins_and_noncallable_initializers() {
    let text = "import { callableOwnerDev, type callableOwnerDev as typeOwnerDev } from './callable-owner-dev'; import type defaultOwnerDev from './callable-owner-dev'; import type * as typeNamespaceDev from './callable-owner-dev'; export const liveDev = callableOwnerDev; export const specifierDev = typeOwnerDev; export const defaultDev = defaultOwnerDev; export const namespaceDev = typeNamespaceDev.callableOwnerDev; export const dataDev = 1; export const arrowDev = () => 17; export const observedArrowDev = arrowDev; export const observedDataDev = dataDev; export let pendingDev;";
    let mut request = component_request(
        "callableObservationDev",
        "/repo/callable-consumer-dev.ts",
        text,
    );
    request.retained = true;
    request.files.insert(
        "/repo/callable-owner-dev.ts".into(),
        "export function callableOwnerDev() {} export default function defaultOwnerDev() {}".into(),
    );
    let ordinary = Request {
        retained: false,
        ..request.clone()
    };
    let observed = analyze(request, component_sdk()).unwrap();
    let component = &observed["subjects"][0]["retainedCallableInitializers"];
    assert_eq!(component["executed"], true);
    assert_eq!(component["unsupported"], serde_json::json!([]));
    let variables = component["variables"].as_array().unwrap();
    let coordinate =
        |name: &str| &variables.iter().find(|v| v["name"] == name).unwrap()["coordinate"];
    assert_eq!(
        coordinate("liveDev"),
        &serde_json::json!({"relPath":"callable-owner-dev.ts","symbolPath":"callableOwnerDev"})
    );
    assert_eq!(
        coordinate("observedArrowDev"),
        &serde_json::json!({"relPath":"callable-consumer-dev.ts","symbolPath":"arrowDev"})
    );
    for name in [
        "specifierDev",
        "defaultDev",
        "namespaceDev",
        "observedDataDev",
    ] {
        assert_eq!(coordinate(name), &serde_json::json!({"state":"undefined"}));
    }
    assert_eq!(
        coordinate("pendingDev"),
        &serde_json::json!({"state":"no_initializer"})
    );
    let observed = analyze(ordinary, component_sdk()).unwrap();
    assert_eq!(
        observed["subjects"][0]["retainedCallableInitializers"],
        serde_json::json!({"executed":false,"unsupported":["COMPONENT_RETAINED_INPUTS_NOT_ENABLED"],"variables":[]})
    );
}

#[test]
fn retained_callable_observation_preserves_native_resolution_failures_until_restored() {
    for (mapping, error) in [
        (
            serde_json::json!("index.ts"),
            Some("NATIVE_SDK59_SCALAR_VERSION_PATH_UNAVAILABLE"),
        ),
        (
            serde_json::json!([7]),
            Some("NATIVE_SDK59_VERSION_PATH_ELEMENT_UNAVAILABLE"),
        ),
        (serde_json::json!(["index.ts"]), None),
    ] {
        let mut request = component_request(
            "callableFailureObservationDev",
            "/repo/callable-failure-dev.ts",
            "import { callableFailureDev } from 'callable-failure-dev'; export const observed = callableFailureDev;",
        );
        request.retained = true;
        request.files.insert(
            "/repo/node_modules/callable-failure-dev/package.json".into(),
            serde_json::json!({"types":"index.ts","typesVersions":{"<6":{"*":mapping}}})
                .to_string(),
        );
        request.files.insert(
            "/repo/node_modules/callable-failure-dev/index.ts".into(),
            "export function callableFailureDev() { return 19; }".into(),
        );
        let observed = analyze(request, component_sdk()).unwrap();
        let component = &observed["subjects"][0]["retainedCallableInitializers"];
        assert_eq!(component["executed"], true);
        let unsupported = component["unsupported"].as_array().unwrap();
        if let Some(error) = error {
            assert!(
                unsupported.contains(&serde_json::json!(error)),
                "{component}"
            );
            assert!(
                unsupported
                    .iter()
                    .any(|value| value.as_str().is_some_and(|reason| reason
                        .starts_with("NATIVE_MODULE_RESOLUTION_ERROR:")
                        && reason.contains(error))),
                "{component}"
            );
        } else {
            assert!(unsupported.is_empty(), "{component}");
            assert_eq!(
                component["variables"][0]["coordinate"],
                serde_json::json!({"relPath":"node_modules/callable-failure-dev/index.ts","symbolPath":"callableFailureDev"})
            );
        }
    }
}

#[test]
fn source_file_observation_reports_the_native_module_marker_independently_of_scope_refusals() {
    for (source, external) in [
        ("export const gapModuleMarker = 211;", true),
        (
            "export {}; declare global { const gapAugmentation: number; }",
            true,
        ),
        ("const gapGlobalScript = 223;", false),
    ] {
        let request = component_request("gapModuleObservation", "/repo/marker.ts", source);
        let result = analyze(request, component_sdk()).unwrap();
        let observation = &result["subjects"][0]["sourceFileObservation"];
        assert_eq!(observation["executed"], true);
        assert_eq!(observation["external_module"], external);
        assert_eq!(observation["unsupported"], serde_json::json!([]));
    }
}

#[test]
fn imported_classic_factory_observation_distinguishes_generated_and_written_calls() {
    for (jsx, generated) in [("react", true), ("preserve", false)] {
        let mut request = component_request(
            "gapImportedFactory",
            "/repo/view.tsx",
            "import { constructGap } from './factory'; export const manual=constructGap('manual',null); export function view(){return <div/>;}",
        );
        request.files.insert(
            "/repo/factory.ts".into(),
            "export function constructGap(){return 0;}".into(),
        );
        request.files.insert("/repo/tsconfig.json".into(), serde_json::json!({"compilerOptions":{"jsx":jsx,"jsxFactory":"constructGap","module":"ESNext","moduleResolution":"Bundler"}}).to_string());
        let result = analyze(request, component_sdk()).unwrap();
        let runtime = &result["subjects"][0]["runtimeConfiguration"];
        assert_eq!(runtime["emission"]["state"], "observed");
        assert_eq!(
            runtime["emission"]["observation"]["classic_factory"],
            generated
        );
        assert_eq!(
            runtime["reasons"]
                .as_array()
                .unwrap()
                .iter()
                .any(|reason| reason == "SOURCE_CLASSIC_JSX_RUNTIME_UNSUPPORTED"),
            generated
        );
    }
}

#[test]
fn ordinary_javascript_conditional_imports_keep_the_native_resolution_paths() {
    let mut request = component_request(
        "gapConditionalImportDev",
        "/repo/entry.cjs",
        "import { dualValue } from '@dev/dual'; export const observed=dualValue; export function later(){return import('@dev/dual');}",
    );
    request.retained = false;
    request.files.extend(BTreeMap::from([
            ("/repo/tsconfig.json".into(), "{\"compilerOptions\":{\"module\":\"NodeNext\",\"moduleResolution\":\"NodeNext\"}}".into()),
            ("/repo/node_modules/@dev/dual/package.json".into(), "{\"name\":\"@dev/dual\",\"exports\":{\"import\":\"./import.js\",\"require\":\"./require.js\"}}".into()),
            ("/repo/node_modules/@dev/dual/import.js".into(), "export const dualValue=233;".into()),
            ("/repo/node_modules/@dev/dual/require.js".into(), "export const dualValue=239;".into()),
        ]));
    let result = analyze(request, component_sdk()).unwrap();
    let imports = result["raw_extraction"]["imports"].as_array().unwrap();
    assert_eq!(imports.len(), 2);
    assert_eq!(
        imports[0]["resolvedRelPath"],
        "node_modules/@dev/dual/require.js"
    );
    assert_eq!(
        imports[1]["resolvedRelPath"],
        "node_modules/@dev/dual/import.js"
    );
}

#[test]
fn ordinary_javascript_resolution_errors_and_missing_context_do_not_become_empty_success() {
    let path = "/repo/resolutionErrorsDev.js";
    let fs = Rc::new(CaptureFs::new(
        BTreeMap::from([(path.into(), "export const resolutionErrorsDev=241;".into())]),
        true,
    ));
    let mut frontend = ordinary_javascript_frontend(fs, "/repo", "/sdk/lib", path).unwrap();
    assert!(
        javascript_module_resolutions(&frontend, path)
            .unwrap()
            .is_empty()
    );
    assert!(javascript_module_resolutions(&frontend, "/repo/absentDev.js").is_err());
    Rc::get_mut(&mut frontend.program)
        .unwrap()
        .module_resolution_error = Some(ts_goport::gostd::errors::new(
        "resolution error from native program",
    ));
    assert!(
        javascript_module_resolutions(&frontend, path)
            .unwrap_err()
            .contains("resolution error from native program")
    );
    Rc::get_mut(&mut frontend.program)
        .unwrap()
        .module_resolution_error = None;
    frontend
        .resolution
        .as_ref()
        .unwrap()
        .borrow_mut()
        .errors
        .insert(
            path.into(),
            "resolution error from configured resolver".into(),
        );
    assert!(
        javascript_module_resolutions(&frontend, path)
            .unwrap_err()
            .contains("resolution error from configured resolver")
    );
    frontend
        .resolution
        .as_ref()
        .unwrap()
        .borrow_mut()
        .errors
        .clear();
    assert!(
        javascript_module_resolutions(&frontend, path)
            .unwrap()
            .is_empty()
    );
}

#[test]
fn retained_configuration_keeps_workspace_links_in_ordinary_observation_only() {
    let mut request = component_request(
        "t00WorkspaceConfigurationDev",
        "/repo/apps/web/main.ts",
        "export const t00WorkspaceConfigurationDev = 379;",
    );
    request.files.extend(BTreeMap::from([
        (
            "/repo/package.json".into(),
            r#"{"private":true,"workspaces":["packages/*","apps/*"]}"#.into(),
        ),
        (
            "/repo/apps/web/package.json".into(),
            r#"{"name":"web","dependencies":{"@t00/config":"workspace:*"}}"#.into(),
        ),
        (
            "/repo/apps/web/tsconfig.json".into(),
            r#"{"extends":"@t00/config/base.json"}"#.into(),
        ),
        (
            "/repo/packages/config/package.json".into(),
            r#"{"name":"@t00/config","version":"1.0.0"}"#.into(),
        ),
        (
            "/repo/packages/config/base.json".into(),
            r#"{"compilerOptions":{"module":"ESNext"}}"#.into(),
        ),
    ]));
    let observed = analyze(request, component_sdk()).unwrap();
    let modes = &observed["subjects"][0]["moduleConfigurationObservations"];
    assert_eq!(
        modes["retainedWithoutSource"]["reasons"],
        serde_json::json!(["SOURCE_CONFIGURATION_OUTSIDE_REPOSITORY"]),
        "{modes}"
    );
    assert_eq!(
        modes["ordinaryWithoutSnapshot"]["reasons"],
        serde_json::json!([])
    );
}

#[test]
fn unsupported_workspace_configuration_stays_unknown_in_ordinary_observation() {
    let mut request = component_request(
        "t00UnknownWorkspaceDev",
        "/repo/apps/web/main.ts",
        "export const t00UnknownWorkspaceDev = 397;",
    );
    request.files.extend(BTreeMap::from([
        (
            "/repo/pnpm-workspace.yaml".into(),
            "packages: [apps/*, settings/*]".into(),
        ),
        (
            "/repo/apps/web/package.json".into(),
            r#"{"name":"web","dependencies":{"@t00/config":"workspace:*"}}"#.into(),
        ),
        (
            "/repo/apps/web/tsconfig.json".into(),
            r#"{"extends":"@t00/config/base.json"}"#.into(),
        ),
        (
            "/repo/settings/config/package.json".into(),
            r#"{"name":"@t00/config","version":"1.0.0"}"#.into(),
        ),
        ("/repo/settings/config/base.json".into(), "{}".into()),
    ]));
    let observed = analyze(request, component_sdk()).unwrap();
    let ordinary =
        &observed["subjects"][0]["moduleConfigurationObservations"]["ordinaryWithoutSnapshot"];
    assert!(
        ordinary["unsupported"]
            .as_array()
            .unwrap()
            .contains(&serde_json::json!("WORKSPACE_PNPM_DECLARATION_UNSUPPORTED")),
        "{ordinary}"
    );
}

#[test]
fn component_observation_executes_semantics_for_ordinary_ts_without_changing_admission() {
    let request = component_request(
        "t00ComponentObservationsP",
        "/repo/component-observations-p.ts",
        r#"/// <reference path="./component-absent-p.ts" />
const t00ComponentObservationsP = 227;"#,
    );
    let observed = analyze(request, component_sdk()).unwrap();
    let subject = &observed["subjects"][0];
    assert_eq!(subject["semanticObservation"]["executed"], true);
    assert_eq!(
        subject["semanticObservation"]["reasons"],
        serde_json::json!(["SOURCE_REFERENCE_PATH_UNSUPPORTED"])
    );
    assert_eq!(
        subject["semanticObservation"]["unsupported"],
        serde_json::json!([])
    );
    assert_eq!(subject["outcome"], "analyzed");
    assert_eq!(subject["reasons"], serde_json::json!([]));
    let configurations = &subject["moduleConfigurationObservations"];
    assert_eq!(configurations["retainedWithoutSource"]["executed"], true);
    assert_eq!(
        configurations["retainedWithoutSource"]["reasons"],
        serde_json::json!(["SOURCE_REFERENCE_PATH_UNSUPPORTED"])
    );
    assert_eq!(
        configurations["retainedWithSource"]["reasons"],
        serde_json::json!([
            "SOURCE_REFERENCE_PATH_UNSUPPORTED",
            "SOURCE_GLOBAL_SCRIPT_UNSUPPORTED"
        ])
    );
    assert_eq!(
        configurations["ordinaryWithoutSnapshot"]["reasons"],
        serde_json::json!([])
    );
}

#[test]
fn component_observation_keeps_snapshot_profile_out_of_ordinary_configuration() {
    let mut request = component_request(
        "t00ComponentProfileQ",
        "/repo/component-profile-q.ts",
        "const t00ComponentProfileQ = 229; export default t00ComponentProfileQ;",
    );
    request.files.insert(
        "/repo/tsconfig.json".into(),
        r#"{"compilerOptions":{"module":"CommonJS","moduleResolution":"Node10"}}"#.into(),
    );
    let observed = analyze(request, component_sdk()).unwrap();
    let modes = &observed["subjects"][0]["moduleConfigurationObservations"];
    let expected = serde_json::json!([
        "SOURCE_DEFAULT_EXPRESSION_UNSUPPORTED",
        "SOURCE_CONFIGURATION_MODULE_UNSUPPORTED:CommonJS",
        "SOURCE_CONFIGURATION_RESOLUTION_UNSUPPORTED:Node10"
    ]);
    assert_eq!(modes["retainedWithoutSource"]["reasons"], expected);
    assert_eq!(modes["retainedWithSource"]["reasons"], expected);
    assert_eq!(
        modes["ordinaryWithoutSnapshot"]["reasons"],
        serde_json::json!([])
    );
}

#[test]
fn component_observation_source_parser_uses_source_codes_for_javascript() {
    let request = component_request(
        "t00ComponentParserR",
        "/repo/component-parser-r.js",
        "export const t00ComponentParserR = ;",
    );
    let observed = analyze(request, component_sdk()).unwrap();
    let parsing = &observed["subjects"][0]["sourceParsingObservation"];
    assert_eq!(parsing["executed"], true);
    assert_eq!(
        parsing["reasons"],
        serde_json::json!(["SOURCE_PARSE_ERROR:1109:Expression expected."])
    );
    assert_eq!(parsing["diagnosticCodes"], serde_json::json!([1109]));
    assert_eq!(parsing["diagnostics"][0]["start_utf16"], 35);
    assert_eq!(parsing["diagnostics"][0]["end_utf16"], 36);
}

#[test]
fn component_observation_outside_configuration_short_circuits_all_source_reasons() {
    let mut request = component_request(
        "t00ComponentOutsideS",
        "/repo/component-outside-s.ts",
        "const t00ComponentOutsideS = 233; export default t00ComponentOutsideS;",
    );
    request.files.insert(
        "/tsconfig.json".into(),
        r#"{"compilerOptions":{"module":"CommonJS"}}"#.into(),
    );
    let observed = analyze(request, component_sdk()).unwrap();
    let modes = &observed["subjects"][0]["moduleConfigurationObservations"];
    for mode in [
        "retainedWithoutSource",
        "retainedWithSource",
        "ordinaryWithoutSnapshot",
    ] {
        assert_eq!(modes[mode]["executed"], true);
        assert_eq!(
            modes[mode]["reasons"],
            serde_json::json!(["SOURCE_CONFIGURATION_OUTSIDE_REPOSITORY"])
        );
        assert_eq!(modes[mode]["unsupported"], serde_json::json!([]));
    }
}

#[test]
fn component_observation_invalid_json_configuration_preserves_source_and_parser_reasons() {
    let mut request = component_request(
        "t00ComponentInvalidT",
        "/repo/component-invalid-t.ts",
        "const t00ComponentInvalidT = 239; export default t00ComponentInvalidT;",
    );
    request.files.insert(
        "/repo/tsconfig.json".into(),
        r#"{"compilerOptions": "#.into(),
    );
    let observed = analyze(request, component_sdk()).unwrap();
    let modes = &observed["subjects"][0]["moduleConfigurationObservations"];
    let retained = modes["retainedWithoutSource"]["reasons"]
        .as_array()
        .unwrap();
    let ordinary = modes["ordinaryWithoutSnapshot"]["reasons"]
        .as_array()
        .unwrap();
    assert_eq!(
        retained.first().unwrap(),
        "SOURCE_DEFAULT_EXPRESSION_UNSUPPORTED"
    );
    assert!(!ordinary.is_empty());
    assert!(ordinary.iter().all(|reason| {
        reason
            .as_str()
            .unwrap()
            .starts_with("SOURCE_CONFIGURATION_INVALID:")
    }));
    assert_eq!(&retained[1..], ordinary);
}

#[test]
fn component_observation_distinguishes_explicit_module_none_from_omission() {
    let mut request = component_request(
        "t00ComponentNoneV",
        "/repo/component-none-v.ts",
        "export const t00ComponentNoneV = 241;",
    );
    request.files.insert(
        "/repo/tsconfig.json".into(),
        r#"{"compilerOptions":{"module":"none"}}"#.into(),
    );
    let observed = analyze(request.clone(), component_sdk()).unwrap();
    let modes = &observed["subjects"][0]["moduleConfigurationObservations"];
    assert_eq!(
        modes["retainedWithoutSource"]["reasons"],
        serde_json::json!([
            "SOURCE_CONFIGURATION_INVALID:6046:Argument for '--module' option must be: 'commonjs', 'es6', 'es2015', 'es2020', 'es2022', 'esnext', 'node16', 'node18', 'node20', 'nodenext', 'preserve'.",
            "SOURCE_CONFIGURATION_MODULE_UNSUPPORTED:None",
        ])
    );
    assert_eq!(
        modes["ordinaryWithoutSnapshot"]["reasons"],
        serde_json::json!([
            "SOURCE_CONFIGURATION_INVALID:6046:Argument for '--module' option must be: 'commonjs', 'es6', 'es2015', 'es2020', 'es2022', 'esnext', 'node16', 'node18', 'node20', 'nodenext', 'preserve'.",
        ])
    );
    request
        .files
        .insert("/repo/tsconfig.json".into(), "{}".into());
    let omitted = analyze(request, component_sdk()).unwrap();
    assert_eq!(
        omitted["subjects"][0]["moduleConfigurationObservations"]["retainedWithoutSource"]["reasons"],
        serde_json::json!([])
    );
}

#[test]
fn component_observation_distinguishes_absent_and_invalid_configuration_for_jsx() {
    let mut request = component_request(
        "t00ComponentViewU",
        "/repo/component-view-u.tsx",
        "/** @jsxRuntime automatic */\nconst t00ComponentViewU=<aside/>; export {};",
    );
    let absent = analyze(request.clone(), component_sdk()).unwrap();
    assert_eq!(
        absent["subjects"][0]["moduleConfigurationObservations"]["retainedWithoutSource"]["reasons"],
        serde_json::json!(["SOURCE_AUTOMATIC_JSX_RUNTIME_UNSUPPORTED"])
    );
    request.files.insert(
        "/repo/tsconfig.json".into(),
        r#"{"compilerOptions": "#.into(),
    );
    let invalid = analyze(request, component_sdk()).unwrap();
    let reasons = invalid["subjects"][0]["moduleConfigurationObservations"]["retainedWithoutSource"]["reasons"].as_array().unwrap();
    assert!(!reasons.is_empty());
    assert!(reasons.iter().all(|reason| {
        reason
            .as_str()
            .unwrap()
            .starts_with("SOURCE_CONFIGURATION_INVALID:")
    }));
}

#[test]
fn case_mode_accepts_matching_native_semantics_and_rejects_mismatch() {
    assert!(validate_case_mode(false, false).is_ok());
    assert!(validate_case_mode(true, true).is_ok());
    assert!(validate_case_mode(true, false).is_err());
    assert!(validate_case_mode(false, true).is_err());
}
#[test]
fn case_insensitive_capture_preserves_spelling_and_read_only_disposition() {
    let fs = CaptureFs::new(
        BTreeMap::from([("/repo/CamelName.ts".into(), "export const leaf = 1;".into())]),
        false,
    );
    assert_eq!(
        fs.read_file("/REPO/camelname.ts"),
        ("export const leaf = 1;".into(), true)
    );
    assert_eq!(fs.realpath("/repo/camelname.ts"), "/repo/CamelName.ts");
    assert_eq!(
        fs.get_accessible_entries("/REPO").files,
        vec!["CamelName.ts"]
    );
    assert!(matches!(
        fs.write_file("/repo/CamelName.ts", "changed"),
        Err(FsError::Permission)
    ));
    assert_eq!(fs.read_file("/etc/passwd"), (String::new(), false));
    assert!(!fs.log.borrow().last().unwrap().found);
    assert!(fs.log.borrow().last().unwrap().content_id.is_none());
}

#[test]
fn development_driver_extracts_alias_calls_and_structural_test_binding() {
    let request: Request = serde_json::from_value(serde_json::json!({
            "id":"t00DevelopmentDriverA","cwd":"/repo","sdk_directory":"/sdk/lib",
            "case_sensitive":ts_goport::frontend::vfs::osvfs_fs().use_case_sensitive_file_names(),
            "roots":["/repo/leaf.ts","/repo/entry.test.ts"],
            "files":{"/repo/leaf.ts":"export function t00DevelopmentDriverLeaf() { return 19; }","/repo/entry.test.ts":"import { t00DevelopmentDriverLeaf as t00DevelopmentDriverAlias } from './leaf.js'; export function t00DevelopmentDriverCaller() { return t00DevelopmentDriverAlias(); }"},
            "roles":{"leaf.ts":"source","entry.test.ts":"test"},
            "options":{"target":"ES2022","module":"ESNext","moduleResolution":"Bundler","allowJs":true,"jsx":"Preserve","skipLibCheck":true,"noEmit":true,"strict":false}
        })).unwrap();
    let sdk: Sdk = serde_json::from_slice(
        &std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/sdk/sdk-input.json")).unwrap(),
    )
    .unwrap();
    let result = analyze(request, sdk).unwrap();
    assert_eq!(
        result["raw_extraction"]["symbols"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    let edges = result["assembly"]["edges"].as_array().unwrap();
    assert!(edges.iter().any(|edge| edge["kind"] == "calls"
        && edge["from"] == "sym:function:entry.test.ts:t00DevelopmentDriverCaller"
        && edge["to"] == "sym:function:leaf.ts:t00DevelopmentDriverLeaf"));
    assert!(edges.iter().any(|edge| edge["kind"] == "tested_by"));
    assert_eq!(result["subjects"].as_array().unwrap().len(), 2);
    assert_eq!(result["complete"], true);
    assert_eq!(result["global_admission_inferred"], false);
}

#[test]
fn development_driver_observes_configured_aliases_and_runtime_jsx_boundary() {
    let request:Request=serde_json::from_value(serde_json::json!({"id":"t00DevelopmentIntegratedConfigC","cwd":"/repo","sdk_directory":"/sdk/lib","case_sensitive":ts_goport::frontend::vfs::osvfs_fs().use_case_sensitive_file_names(),"roots":["/repo/leaf.ts","/repo/use.jsx"],"files":{"/repo/leaf.ts":"export function t00DevelopmentConfiguredLeafC(){ return 149; }","/repo/use.jsx":"import {t00DevelopmentConfiguredLeafC} from '@t00-owned'; export function t00DevelopmentConfiguredUseC(){ t00DevelopmentConfiguredLeafC(); return <main />; }","/repo/tsconfig.json":"{\"compilerOptions\":{\"module\":\"ESNext\",\"moduleResolution\":\"Bundler\",\"paths\":{\"@t00-owned\":[\"./leaf.ts\"]},\"jsx\":\"react-jsx\"}}"},"qualified":true,"options":{"target":"ES2022","module":"ESNext","moduleResolution":"Bundler","allowJs":true,"jsx":"Preserve","skipLibCheck":true,"noEmit":true,"strict":false}})).unwrap();
    let sdk: Sdk = serde_json::from_slice(
        &std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/sdk/sdk-input.json")).unwrap(),
    )
    .unwrap();
    let result = analyze(request, sdk).unwrap();
    assert_eq!(
        result["raw_extraction"]["calls"][0]["calleeRelPath"],
        "leaf.ts"
    );
    let subject = result["subjects"]
        .as_array()
        .unwrap()
        .iter()
        .find(|subject| subject["path"] == "use.jsx")
        .unwrap();
    assert!(
        subject["reasons"]
            .as_array()
            .unwrap()
            .iter()
            .any(|reason| reason == "SOURCE_AUTOMATIC_JSX_RUNTIME_UNSUPPORTED")
    );
    assert_eq!(
        subject["javascript"]["staticModuleLinks"][0]["resolution"],
        "resolved"
    );
    assert_eq!(subject["outcome"], "unsupported");
}

#[test]
fn development_driver_keeps_assembly_coordinate_refusal_at_consumer_boundary() {
    let request:Request=serde_json::from_value(serde_json::json!({"id":"t00DevelopmentCoordinateDriverD","cwd":"/repo","sdk_directory":"/sdk/lib","case_sensitive":ts_goport::frontend::vfs::osvfs_fs().use_case_sensitive_file_names(),"roots":["/repo/duplicates.ts"],"files":{"/repo/duplicates.ts":"export function t00DevelopmentDuplicateD(){ return t00DevelopmentLeafD(); } export function t00DevelopmentDuplicateD(){ return t00DevelopmentLeafD(); } export function t00DevelopmentLeafD(){ return 163; }"},"qualified":true,"options":{"target":"ES2022","module":"ESNext","moduleResolution":"Bundler","allowJs":true,"jsx":"Preserve","skipLibCheck":true,"noEmit":true,"strict":false}})).unwrap();
    let sdk: Sdk = serde_json::from_slice(
        &std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/sdk/sdk-input.json")).unwrap(),
    )
    .unwrap();
    let result = analyze(request, sdk).unwrap();
    assert!(
        result["subjects"][0]["reasons"]
            .as_array()
            .unwrap()
            .iter()
            .any(|reason| reason
                .as_str()
                .unwrap_or_default()
                .starts_with("QUALIFIED_CALL_COORDINATE_CALLER_AMBIGUOUS:"))
    );
    assert_eq!(result["subjects"][0]["outcome"], "unsupported");
}

#[test]
fn development_selection_exclusion_is_distinct_from_disabled_analysis() {
    let request:Request=serde_json::from_value(serde_json::json!({"id":"t00DevelopmentSelectionE","cwd":"/repo","sdk_directory":"/sdk/lib","case_sensitive":ts_goport::frontend::vfs::osvfs_fs().use_case_sensitive_file_names(),"roots":["/repo/live.ts","/repo/disabled.ts"],"files":{"/repo/live.ts":"export function t00DevelopmentLiveE(){return 173;}","/repo/disabled.ts":"export function t00DevelopmentDisabledE(){return 179;}"},"selection":{"disabled.ts":"excluded"},"options":{"target":"ES2022","module":"ESNext","moduleResolution":"Bundler","allowJs":true,"jsx":"Preserve","skipLibCheck":true,"noEmit":true,"strict":false}})).unwrap();
    let sdk: Sdk = serde_json::from_slice(
        &std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/sdk/sdk-input.json")).unwrap(),
    )
    .unwrap();
    let result = analyze(request.clone(), sdk.clone()).unwrap();
    assert_eq!(
        result["raw_extraction"]["symbols"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let subject = result["subjects"]
        .as_array()
        .unwrap()
        .iter()
        .find(|subject| subject["path"] == "disabled.ts")
        .unwrap();
    assert_eq!(subject["outcome"], "not_applicable");
    assert_eq!(subject["selection"], "excluded");
    assert!(
        !result["assembly"]["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|node| node["filePath"] == "disabled.ts")
    );
    let mut language_off = request;
    language_off.disabled.insert("live.ts".into());
    let off = analyze(language_off, sdk).unwrap();
    let disabled = off["subjects"]
        .as_array()
        .unwrap()
        .iter()
        .find(|subject| subject["path"] == "live.ts")
        .unwrap();
    assert_eq!(disabled["outcome"], "disabled");
    assert_eq!(disabled["selection"], "selected");
    assert!(
        off["raw_extraction"]["symbols"]
            .as_array()
            .unwrap()
            .is_empty()
    );
}

#[test]
fn development_review_boundary_rejects_qualified_without_retained_capture() {
    let request:Request=serde_json::from_value(serde_json::json!({"id":"t00DevelopmentRetainedL","cwd":"/repo","sdk_directory":"/sdk/lib","case_sensitive":ts_goport::frontend::vfs::osvfs_fs().use_case_sensitive_file_names(),"roots":["/repo/retained.ts"],"files":{"/repo/retained.ts":"export function t00DevelopmentRetainedL(){return 197;}"},"qualified":true,"retained":false,"options":{"target":"ES2022","module":"ESNext","moduleResolution":"Bundler","allowJs":true,"jsx":"Preserve","skipLibCheck":true,"noEmit":true,"strict":false}})).unwrap();
    let sdk: Sdk = serde_json::from_slice(
        &std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/sdk/sdk-input.json")).unwrap(),
    )
    .unwrap();
    assert!(matches!(analyze(request,sdk),Err(error) if error=="SOURCE_SNAPSHOT_REQUIRED"));
}

#[test]
fn development_review_boundary_refuses_late_javascript_configuration_reason() {
    let request:Request=serde_json::from_value(serde_json::json!({"id":"t00DevelopmentNamedM","cwd":"/repo","sdk_directory":"/sdk/lib","case_sensitive":ts_goport::frontend::vfs::osvfs_fs().use_case_sensitive_file_names(),"roots":["/repo/named.js"],"files":{"/repo/named.js":"export function t00DevelopmentNamedM(){return 199;}","/repo/tsconfig.build.json":"{}"},"options":{"target":"ES2022","module":"ESNext","moduleResolution":"Bundler","allowJs":true,"jsx":"Preserve","skipLibCheck":true,"noEmit":true,"strict":false}})).unwrap();
    let sdk: Sdk = serde_json::from_slice(
        &std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/sdk/sdk-input.json")).unwrap(),
    )
    .unwrap();
    let observed = analyze(request.clone(), sdk.clone()).unwrap();
    assert!(
        observed["subjects"][0]["reasons"]
            .as_array()
            .unwrap()
            .iter()
            .any(|reason| reason == "SOURCE_NAMED_CONFIGURATION_UNSUPPORTED")
    );
    assert_eq!(observed["subjects"][0]["outcome"], "unsupported");
    assert_eq!(
        batch::build(&request, &sdk, &observed).unwrap().terminal,
        wire::Terminal::Refused
    );
}

#[test]
fn development_review_boundary_normalizes_windows_capture_directory_spelling() {
    let fs = CaptureFs::new(
        BTreeMap::from([(
            "C:\\repo\\Nested\\leaf.ts".into(),
            "export const t00DevelopmentWindowsN=211;".into(),
        )]),
        false,
    );
    assert!(fs.file_exists("c:/REPO/nested/leaf.ts"));
    assert!(fs.directory_exists("C:\\repo\\Nested"));
    assert_eq!(
        fs.get_accessible_entries("C:\\repo\\Nested").files,
        vec!["leaf.ts"]
    );
    assert_eq!(
        fs.realpath("c:/repo/nested/leaf.ts"),
        "C:/repo/Nested/leaf.ts"
    );
}

#[test]
fn development_input_read_observations_bind_returned_source_and_sdk_text() {
    let source = "export function t00DevelopmentReadK(){return 193;}";
    let request:Request=serde_json::from_value(serde_json::json!({"id":"t00DevelopmentReadK","cwd":"/repo","sdk_directory":"/sdk/lib","case_sensitive":ts_goport::frontend::vfs::osvfs_fs().use_case_sensitive_file_names(),"roots":["/repo/read.ts"],"files":{"/repo/read.ts":source},"options":{"target":"ES2022","module":"ESNext","moduleResolution":"Bundler","allowJs":true,"jsx":"Preserve","skipLibCheck":true,"noEmit":true,"strict":false}})).unwrap();
    let sdk: Sdk = serde_json::from_slice(
        &std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/sdk/sdk-input.json")).unwrap(),
    )
    .unwrap();
    let observed = analyze(request.clone(), sdk.clone()).unwrap();
    let batch = batch::build(&request, &sdk, &observed).unwrap();
    let source_read = batch
        .input_observations
        .iter()
        .find(|probe| {
            probe.operation == "read_file" && probe.path == "/repo/read.ts" && probe.found
        })
        .unwrap();
    assert_eq!(
        source_read.content_id,
        Some(identity::digest_bytes(source.as_bytes()))
    );
    let sdk_path = "/sdk/lib/lib.es2022.full.d.ts";
    let library_read = batch
        .input_observations
        .iter()
        .find(|probe| probe.operation == "read_file" && probe.path == sdk_path && probe.found)
        .unwrap();
    assert_eq!(
        library_read.content_id,
        Some(identity::digest_bytes(sdk.files[sdk_path].as_bytes()))
    );
}

#[test]
fn development_default_program_observes_automatic_type_directives() {
    let request:Request=serde_json::from_value(serde_json::json!({"id":"t00DevelopmentAutomaticJ","cwd":"/repo","sdk_directory":"/sdk/lib","case_sensitive":ts_goport::frontend::vfs::osvfs_fs().use_case_sensitive_file_names(),"roots":["/repo/automatic.ts"],"files":{"/repo/automatic.ts":"export function t00DevelopmentAutomaticJ(){return t00AmbientAutomaticJ();}","/repo/node_modules/@types/t00-development-automatic-j/index.d.ts":"declare function t00AmbientAutomaticJ():number;"},"options":{"target":"ES2022","module":"ESNext","moduleResolution":"Bundler","allowJs":true,"jsx":"Preserve","skipLibCheck":true,"noEmit":true,"strict":false}})).unwrap();
    let sdk: Sdk = serde_json::from_slice(
        &std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/sdk/sdk-input.json")).unwrap(),
    )
    .unwrap();
    let observed = analyze(request, sdk).unwrap();
    assert_eq!(observed["calls"][0]["symbol_name"], "t00AmbientAutomaticJ");
    assert_eq!(
        observed["calls"][0]["declarations"][0]["file"],
        "/repo/node_modules/@types/t00-development-automatic-j/index.d.ts"
    );
}

#[test]
fn development_graph_preserves_javascript_metadata_and_source_line_evidence() {
    let request:Request=serde_json::from_value(serde_json::json!({"id":"t00DevelopmentGraphMetadataI","cwd":"/repo","sdk_directory":"/sdk/lib","case_sensitive":ts_goport::frontend::vfs::osvfs_fs().use_case_sensitive_file_names(),"roots":["/repo/metadata.js"],"files":{"/repo/metadata.js":"import {join} from 'node:path';\nexport function t00DevelopmentMetadataI(){return join('a','b');}"},"options":{"target":"ES2022","module":"ESNext","moduleResolution":"Bundler","allowJs":true,"jsx":"Preserve","skipLibCheck":true,"noEmit":true,"strict":false}})).unwrap();
    let sdk: Sdk = serde_json::from_slice(
        &std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/sdk/sdk-input.json")).unwrap(),
    )
    .unwrap();
    let observed = analyze(request, sdk).unwrap();
    let nodes = observed["assembly"]["nodes"].as_array().unwrap();
    let module = nodes.iter().find(|node| node["kind"] == "module").unwrap();
    assert_eq!(
        module["metadata"]["staticExports"],
        "[{\"name\":\"t00DevelopmentMetadataI\",\"declarationKind\":\"function\"}]"
    );
    assert_eq!(
        module["metadata"]["staticModuleLinks"],
        "[{\"specifier\":\"node:path\",\"resolution\":\"external\"}]"
    );
    let symbol = nodes
        .iter()
        .find(|node| node["kind"] == "function")
        .unwrap();
    assert_eq!(
        symbol["evidence"],
        serde_json::json!([{"filePath":"metadata.js","startLine":2,"endLine":2,"sourceKind":"code"}])
    );
}

#[test]
fn development_wire_batch_binds_input_scope_and_exact_native_fact_ranges() {
    let request:Request=serde_json::from_value(serde_json::json!({"id":"t00DevelopmentWireG","cwd":"/repo","sdk_directory":"/sdk/lib","case_sensitive":ts_goport::frontend::vfs::osvfs_fs().use_case_sensitive_file_names(),"roots":["/repo/wire.ts"],"files":{"/repo/wire.ts":"// 🦀\nexport function t00DevelopmentWireG(){ return 181; }"},"qualified":true,"options":{"target":"ES2022","module":"ESNext","moduleResolution":"Bundler","allowJs":true,"jsx":"Preserve","skipLibCheck":true,"noEmit":true,"strict":false}})).unwrap();
    let sdk: Sdk = serde_json::from_slice(
        &std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/sdk/sdk-input.json")).unwrap(),
    )
    .unwrap();
    let observation = analyze(request.clone(), sdk.clone()).unwrap();
    let batch = batch::build(&request, &sdk, &observation).unwrap();
    let value = serde_json::to_value(&batch).unwrap();
    assert_eq!(batch.request_id, "t00DevelopmentWireG");
    assert_eq!(batch.profile, "modelo-suite-static-v1");
    assert_eq!(batch.subjects.len(), 1);
    assert_eq!(
        batch.subjects[0].outcome,
        Some(wire::AnalysisOutcome::Analyzed)
    );
    let fact = value["facts"]
        .as_array()
        .unwrap()
        .iter()
        .find(|fact| fact["id"] == "sym:function:wire.ts:t00DevelopmentWireG")
        .unwrap();
    assert_eq!(fact["range"]["start_utf16"], 6);
    assert_eq!(fact["range"]["start_line"], 2);
    assert_eq!(batch.facts_id, identity::digest(&value["facts"]));
    assert_ne!(batch.snapshot_id, batch.scope_id);
    assert_ne!(batch.capture_id, batch.producer_artifact_id);
    assert!(batch.complete);
    assert!(batch.producer_claimed_ownership.is_none());
    let mut incomplete = observation;
    incomplete["subjects"][0]["outcome"] = serde_json::json!("unknown");
    let unknown = batch::build(&request, &sdk, &incomplete).unwrap();
    assert_eq!(
        unknown.subjects[0].outcome,
        Some(wire::AnalysisOutcome::Unknown)
    );
    assert!(
        unknown.subjects[0]
            .coverage
            .iter()
            .all(|coverage| !coverage.complete && !coverage.negative_evidence_eligible)
    );
}

#[test]
fn development_request_preserves_utf16_sources_and_rejects_conflicting_capture_keys() {
    let base = serde_json::json!({"id":"t00DevelopmentBoundaryB","cwd":"/repo","sdk_directory":"/sdk/lib","case_sensitive":ts_goport::frontend::vfs::osvfs_fs().use_case_sensitive_file_names(),"roots":["/repo/units.ts"],"files":{},"utf16_files":{"/repo/units.ts":[47,47,32,55296,13,10,101,120,112,111,114,116,32,102,117,110,99,116,105,111,110,32,116,48,48,68,101,118,101,108,111,112,109,101,110,116,85,110,105,116,115,40,41,32,123,125]},"options":{"target":"ES2022","module":"ESNext","moduleResolution":"Bundler","allowJs":true,"jsx":"Preserve","skipLibCheck":true,"noEmit":true,"strict":false}});
    let sdk = || {
        serde_json::from_slice::<Sdk>(
            &std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/sdk/sdk-input.json")).unwrap(),
        )
        .unwrap()
    };
    let result = analyze(serde_json::from_value(base.clone()).unwrap(), sdk()).unwrap();
    assert_eq!(
        result["raw_extraction"]["symbols"][0]["name"],
        "t00DevelopmentUnits"
    );
    assert_eq!(result["raw_extraction"]["symbols"][0]["startLine"], 2);
    assert_eq!(result["raw_extraction"]["symbols"][0]["startUtf16"], 6);
    assert_eq!(result["raw_extraction"]["symbols"][0]["endUtf16"], 46);
    let mut conflict = base.clone();
    conflict["files"] = serde_json::json!({"/repo/./units.ts":"export const another = 2;"});
    assert!(
        analyze(serde_json::from_value(conflict).unwrap(), sdk())
            .unwrap_err()
            .starts_with("conflicting captured key:")
    );
    let mut malformed = base;
    malformed["raw_files"] =
        serde_json::json!({"/repo/bad.ts":{"bytes":[256],"profile":"compiler_system"}});
    assert!(serde_json::from_value::<Request>(malformed).is_err());
}

#[test]
fn development_driver_reports_ambiguous_exports_without_arbitrary_call_edge() {
    let request:Request=serde_json::from_value(serde_json::json!({"id":"t00DevelopmentDriverAmbiguity","cwd":"/repo","sdk_directory":"/sdk/lib","case_sensitive":ts_goport::frontend::vfs::osvfs_fs().use_case_sensitive_file_names(),"roots":["/repo/first.ts","/repo/second.ts","/repo/public.ts","/repo/use.ts"],"files":{"/repo/first.ts":"export function t00DevelopmentDriverShared(){ return 61; }","/repo/second.ts":"export function t00DevelopmentDriverShared(){ return 67; }","/repo/public.ts":"export * from './first.js'; export * from './second.js';","/repo/use.ts":"import {t00DevelopmentDriverShared} from './public.js'; export function t00DevelopmentDriverUse(){ return t00DevelopmentDriverShared(); }"},"qualified":true,"options":{"target":"ES2022","module":"ESNext","moduleResolution":"Bundler","allowJs":true,"jsx":"Preserve","skipLibCheck":true,"noEmit":true,"strict":false}})).unwrap();
    let sdk: Sdk = serde_json::from_slice(
        &std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/sdk/sdk-input.json")).unwrap(),
    )
    .unwrap();
    let result = analyze(request, sdk).unwrap();
    let public = result["subjects"]
        .as_array()
        .unwrap()
        .iter()
        .find(|subject| subject["path"] == "public.ts")
        .unwrap();
    assert!(public["reasons"].as_array().unwrap().iter().any(|reason| {
        reason
            .as_str()
            .unwrap_or_default()
            .starts_with("SOURCE_EXPORT_AMBIGUOUS")
    }));
    assert_eq!(public["outcome"], "unsupported");
    assert!(
        !result["assembly"]["edges"]
            .as_array()
            .unwrap()
            .iter()
            .any(|edge| edge["kind"] == "calls")
    );
}

#[test]
fn captured_sdk_missing_extra_and_changed_libraries_are_refused_before_analysis() {
    let request = component_request(
        "sdkInventoryDev",
        "/repo/source.ts",
        "export const sdkInventoryDev = 419;",
    );
    for (mutation, expected) in [
        ("missing", "SDK_LIBRARY_MISSING:lib.es5.d.ts"),
        ("extra", "SDK_LIBRARY_UNEXPECTED:lib.foreign.d.ts"),
        ("bytes", "SDK_LIBRARY_CONTENT_MISMATCH:lib.es5.d.ts"),
        ("same-size", "SDK_LIBRARY_CONTENT_MISMATCH:lib.es5.d.ts"),
        ("version", "foreign SDK descriptor"),
        ("revision", "foreign SDK descriptor"),
        ("manifest", "foreign SDK descriptor"),
    ] {
        let mut sdk = component_sdk();
        match mutation {
            "version" => sdk.version = "foreign-version".into(),
            "revision" => sdk.source_revision = Some("foreign-revision".into()),
            "manifest" => sdk.library_manifest_sha256 = Some("foreign-manifest".into()),
            "missing" => {
                sdk.files.remove("/sdk/lib/lib.es5.d.ts");
            }
            "extra" => {
                sdk.files.insert(
                    "/sdk/lib/lib.foreign.d.ts".into(),
                    "declare const foreign: number;".into(),
                );
            }
            "same-size" => {
                sdk.files
                    .get_mut("/sdk/lib/lib.es5.d.ts")
                    .unwrap()
                    .replace_range(0..1, " ");
            }
            _ => {
                sdk.files.insert(
                    "/sdk/lib/lib.es5.d.ts".into(),
                    "declare const replacement: number;".into(),
                );
            }
        }
        assert_eq!(analyze(request.clone(), sdk).unwrap_err(), expected);
    }
}

#[test]
fn analyzed_capability_distinguishes_compiler_and_sdk_content_identity() {
    let observed = analyze(
        component_request(
            "sdkCapabilityDev",
            "/repo/source.ts",
            "export const sdkCapabilityDev = 421;",
        ),
        component_sdk(),
    )
    .unwrap();
    let scope = &observed["subjects"][0]["capabilityScope"];
    assert_eq!(scope["compilerIdentity"]["version"], "7.1.0-dev");
    assert_eq!(
        scope["compilerIdentity"]["sourceRevision"],
        "780dc512d64f40afebffa6a7028207649fb7ed1c"
    );
    assert_eq!(scope["sdkIdentity"]["version"], "7.1.0-dev");
    assert_eq!(
        scope["sdkIdentity"]["libraryManifestSha256"],
        "b1fa7b60aa83d187453b26c0b56a096875a47e61977954aba7deba16161fd7ad"
    );
    assert_eq!(scope["sdkIdentity"]["inventoryValidated"], true);
    assert_eq!(scope["sdkIdentity"]["allLibrariesConsumptionProven"], false);
}
