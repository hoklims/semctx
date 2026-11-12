use super::*;
use serde_json::json;
use ts_goport::frontend::module::ResolverOptions;

fn request(operation: &str, path: &str, faults: serde_json::Value) -> serde_json::Value {
    json!({
        "root":"/repo","files":{"/repo/value.json":"physical text","/outside/value.json":"outside text"},
        "queries":[{"operation":operation,"path":path}],"faults":faults
    })
}

fn step(system: &str, operation: &str, path: &str, value: serde_json::Value) -> serde_json::Value {
    json!({"system":system,"operation":operation,"path":path,"value":value})
}

#[test]
fn resolution_host_file_exists_executes_the_short_circuit_matrix() {
    let path = "/repo/value.json";
    for (faults, expected, expected_trace) in [
        (
            json!([]),
            true,
            json!([
                step("admission", "admitted", path, json!(true)),
                step("physical", "file_exists", path, json!(true)),
                step("configuration", "file_exists", path, json!(true))
            ]),
        ),
        (
            json!([{"system":"physical","operation":"file_exists","path":path,"outcome":"false"}]),
            false,
            json!([
                step("admission", "admitted", path, json!(true)),
                step("physical", "file_exists", path, json!(false))
            ]),
        ),
        (
            json!([{"system":"configuration","operation":"file_exists","path":path,"outcome":"false"}]),
            false,
            json!([
                step("admission", "admitted", path, json!(true)),
                step("physical", "file_exists", path, json!(true)),
                step("configuration", "file_exists", path, json!(false))
            ]),
        ),
    ] {
        let observed = run(request("file_exists", path, faults.clone()));
        assert_eq!(observed["executed"], true, "{observed}");
        assert_eq!(observed["results"][0]["value"], expected, "{faults}");
        assert_eq!(observed["trace"], expected_trace, "{faults}");
        assert_eq!(observed["faultsActivated"], faults);
    }
    let outside = "/outside/value.json";
    let observed = run(request("file_exists", outside, json!([])));
    assert_eq!(observed["results"][0]["value"], false);
    assert_eq!(
        observed["trace"],
        json!([step("admission", "admitted", outside, json!(false))])
    );
}

#[test]
fn resolution_host_read_file_executes_the_guard_and_undefined_matrix() {
    let path = "/repo/value.json";
    for (faults, expected, expected_trace) in [
        (
            json!([]),
            json!("physical text"),
            json!([
                step("admission", "admitted", path, json!(true)),
                step("physical", "file_exists", path, json!(true)),
                step("configuration", "read_file", path, json!("physical text"))
            ]),
        ),
        (
            json!([{"system":"physical","operation":"file_exists","path":path,"outcome":"false"}]),
            json!(null),
            json!([
                step("admission", "admitted", path, json!(true)),
                step("physical", "file_exists", path, json!(false))
            ]),
        ),
        (
            json!([{"system":"configuration","operation":"read_file","path":path,"outcome":"undefined"}]),
            json!(null),
            json!([
                step("admission", "admitted", path, json!(true)),
                step("physical", "file_exists", path, json!(true)),
                step("configuration", "read_file", path, json!(null))
            ]),
        ),
    ] {
        let observed = run(request("read_file", path, faults.clone()));
        assert_eq!(observed["executed"], true, "{observed}");
        assert_eq!(observed["results"][0]["value"], expected, "{faults}");
        assert_eq!(observed["trace"], expected_trace, "{faults}");
        assert_eq!(observed["faultsActivated"], faults);
    }
    let outside = "/outside/value.json";
    let observed = run(request("read_file", outside, json!([])));
    assert_eq!(observed["results"][0]["value"], serde_json::Value::Null);
    assert_eq!(
        observed["trace"],
        json!([step("admission", "admitted", outside, json!(false))])
    );
}

#[test]
fn resolution_host_injected_read_failure_is_consumed_and_identified() {
    let faults = json!([{"system":"configuration","operation":"read_file","path":"/repo/value.json","outcome":"read_failure"}]);
    let observed = run(request("read_file", "/repo/value.json", faults.clone()));
    assert_eq!(observed["results"][0]["value"], serde_json::Value::Null);
    assert_eq!(observed["faultsActivated"], faults);
    assert_eq!(
        observed["nativeFailures"],
        json!([{"path":"/repo/value.json","reason":"TEST_INJECTED_READ_FAILURE"}])
    );
}

#[test]
fn resolution_host_refuses_unknown_or_unbounded_inputs() {
    for value in [
        request("write_file", "/repo/value.json", json!([])),
        request(
            "read_file",
            "/repo/value.json",
            json!([{"system":"unknown","operation":"read_file","path":"/repo/value.json","outcome":"undefined"}]),
        ),
        request(
            "read_file",
            "/repo/value.json",
            json!([{"system":"configuration","operation":"read_file","path":"/repo/value.json","outcome":"unknown"}]),
        ),
        json!({"root":"/repo","files":{},"queries":[]}),
    ] {
        assert_eq!(run(value)["executed"], false);
    }
}

#[test]
fn resolution_host_captured_windows_paths_execute_without_native_disk_access() {
    let observed = run(json!({
        "root":"C:/repo", "system":"captured",
        "files":{"C:/repo/value.json":"captured"},
        "queries":[{"operation":"read_file","path":"C:/repo/value.json"}],
        "faults":[{"system":"configuration","operation":"read_file","path":"C:/repo/value.json","outcome":"read_failure"}]
    }));
    assert_eq!(observed["executed"], true, "{observed}");
    assert_eq!(observed["results"][0]["value"], serde_json::Value::Null);
    assert_eq!(observed["faultsActivated"].as_array().unwrap().len(), 1);
    assert_eq!(observed["global_admission_inferred"], false);
}

#[test]
fn resolution_host_refuses_relative_virtual_roots_queries_and_faults() {
    for path in [
        "relative/value.json",
        "C:relative",
        "https://example.test/value",
    ] {
        for field in ["root", "query", "fault"] {
            let mut value = request("read_file", "/repo/value.json", json!([]));
            match field {
                "root" => value["root"] = json!(path),
                "query" => value["queries"][0]["path"] = json!(path),
                _ => {
                    value["faults"] = json!([{"system":"configuration","operation":"read_file","path":path,"outcome":"undefined"}])
                }
            }
            let observed = run(value);
            assert_eq!(observed["executed"], false, "{field}: {path}: {observed}");
        }
    }
}

#[test]
fn configured_omitted_mode_is_owned_by_native_source_metadata() {
    for (file, package_type, expected, module, resolution) in [
        (
            "entry.mts",
            "commonjs",
            "import.d.mts",
            "nodenext",
            "nodenext",
        ),
        (
            "entry.cts",
            "module",
            "require.d.cts",
            "nodenext",
            "nodenext",
        ),
        ("entry.ts", "module", "import.d.mts", "nodenext", "nodenext"),
        (
            "entry.ts",
            "commonjs",
            "require.d.cts",
            "nodenext",
            "nodenext",
        ),
        ("entry.ts", "commonjs", "import.d.mts", "esnext", "bundler"),
    ] {
        let files = BTreeMap::from([
            (format!("/repo/{file}"), "export const entry = 1;".into()),
            ("/repo/package.json".into(), format!(r#"{{"type":"{package_type}"}}"#)),
            ("/repo/tsconfig.json".into(), format!(r#"{{"compilerOptions":{{"module":"{module}","moduleResolution":"{resolution}"}}}}"#)),
            ("/repo/node_modules/dual/package.json".into(), r#"{"name":"dual","exports":{"import":"./import.d.mts","require":"./require.d.cts"}}"#.into()),
            ("/repo/node_modules/dual/import.d.mts".into(), "export declare const value: 1;".into()),
            ("/repo/node_modules/dual/require.d.cts".into(), "export declare const value: 2;".into()),
        ]);
        let fs = Rc::new(CaptureFs::with_workspace_root(files, true, "/repo", None));
        let (resolver, _) = configured_resolver::configured(
            fs.clone(),
            "/repo".into(),
            "/sdk/lib".into(),
            ResolverOptions {
                host: Some(Rc::new(tsoptions::ResolverHost {
                    fs,
                    current_directory: "/repo".into(),
                })),
                compiler_options: Some(Rc::new(compiler_options())),
                ..Default::default()
            },
        );
        let (found, diagnostics, error) =
            resolver.resolve_configured_module("dual", &format!("/repo/{file}"), None);
        assert!(error.is_none(), "{error:?}");
        assert!(diagnostics.is_empty());
        assert_eq!(
            found.unwrap().resolved_file_name,
            format!("/repo/node_modules/dual/{expected}"),
            "{file}:{package_type}:{resolution}"
        );
        for (mode, expected) in [
            (ModuleKind::ES_NEXT, "import.d.mts"),
            (ModuleKind::COMMON_JS, "require.d.cts"),
        ] {
            let (found, _, error) =
                resolver.resolve_configured_module("dual", &format!("/repo/{file}"), Some(mode));
            assert!(error.is_none());
            assert_eq!(
                found.unwrap().resolved_file_name,
                format!("/repo/node_modules/dual/{expected}")
            );
        }
    }
}

#[test]
fn configured_explicit_captured_system_is_consumed_without_live_root_wrapping() {
    let observed = run(json!({
        "root":"/repo", "system":"captured",
        "files":{"/repo/entry.ts":"export {};","/outside/value.ts":"export const value = 1;"},
        "queries":[],"resolution":{"containing_file":"/repo/entry.ts","specifier":"../outside/value","mode":"import"}
    }));
    assert_eq!(observed["executed"], true, "{observed}");
    assert_eq!(observed["resolved_file_name"], "/outside/value.ts");
    assert_eq!(observed["systemSelection"], "captured");
    assert_eq!(observed["native_error"], serde_json::Value::Null);
}

#[test]
fn configured_factory_is_lazy_until_configuration_callbacks_are_consumed() {
    let fs = Rc::new(CaptureFs::new(
        BTreeMap::from([
            ("/repo/entry.ts".into(), "export {};".into()),
            ("/repo/target.ts".into(), "export const value = 1;".into()),
            (
                "/repo/tsconfig.json".into(),
                r#"{"compilerOptions":{"moduleResolution":"bundler","module":"esnext"}}"#.into(),
            ),
        ]),
        true,
    ));
    let (resolver, _) = configured_resolver::configured(
        fs.clone(),
        "/repo".into(),
        "/sdk/lib".into(),
        ResolverOptions {
            host: Some(Rc::new(tsoptions::ResolverHost {
                fs: fs.clone(),
                current_directory: "/repo".into(),
            })),
            compiler_options: Some(Rc::new(compiler_options())),
            ..Default::default()
        },
    );
    assert!(
        fs.log
            .borrow()
            .iter()
            .all(|probe| probe.operation == "case_sensitive")
    );
    let (found, _, error) =
        resolver.resolve_configured_module("./target", "/repo/entry.ts", Some(ModuleKind::ES_NEXT));
    assert!(error.is_none());
    assert_eq!(found.unwrap().resolved_file_name, "/repo/target.ts");
    let log = fs.log.borrow();
    assert!(log.iter().any(
        |probe| probe.operation == "configuration_discovery_file_exists"
            && probe.path == "/repo/tsconfig.json"
            && probe.found
    ));
    assert!(log.iter().any(|probe| probe.operation == "read_file"
        && probe.path == "/repo/tsconfig.json"
        && probe.found));
}

#[test]
fn resolution_host_directory_exists_consumes_both_delegate_results() {
    for (faults, expected, trace) in [
        (
            json!([{"system":"physical","operation":"directory_exists","path":"/repo","outcome":"false"}]),
            false,
            json!([
                step("admission", "admitted", "/repo", json!(true)),
                step("physical", "directory_exists", "/repo", json!(false))
            ]),
        ),
        (
            json!([{"system":"configuration","operation":"directory_exists","path":"/repo","outcome":"false"}]),
            false,
            json!([
                step("admission", "admitted", "/repo", json!(true)),
                step("physical", "directory_exists", "/repo", json!(true)),
                step("configuration", "directory_exists", "/repo", json!(false))
            ]),
        ),
        (
            json!([]),
            true,
            json!([
                step("admission", "admitted", "/repo", json!(true)),
                step("physical", "directory_exists", "/repo", json!(true)),
                step("configuration", "directory_exists", "/repo", json!(true))
            ]),
        ),
    ] {
        let observed = run(request("directory_exists", "/repo", faults.clone()));
        assert_eq!(observed["executed"], true, "{observed}");
        assert_eq!(observed["results"][0]["value"], expected);
        assert_eq!(observed["trace"], trace);
        assert_eq!(observed["faultsActivated"], faults);
    }
    let observed = run(request("directory_exists", "/outside", json!([])));
    assert_eq!(observed["results"][0]["value"], false);
    assert_eq!(
        observed["trace"],
        json!([step("admission", "admitted", "/outside", json!(false))])
    );
}

#[test]
fn resolution_host_realpath_consumes_physical_alternatives_and_lexical_fallback() {
    let observed = run(request("realpath", "/repo", json!([])));
    assert_eq!(observed["results"][0]["value"], "/repo");
    assert_eq!(
        observed["trace"],
        json!([
            step("admission", "admitted", "/repo", json!(true)),
            step("physical", "file_exists", "/repo", json!(false)),
            step("physical", "directory_exists", "/repo", json!(true)),
            step("configuration", "realpath", "/repo", json!("/repo"))
        ])
    );
    let path = "/repo/value.json";
    let faults = json!([{"system":"configuration","operation":"realpath","path":path,"outcome":"lexical_fallback"}]);
    let observed = run(request("realpath", path, faults.clone()));
    assert_eq!(observed["results"][0]["value"], path);
    assert_eq!(
        observed["trace"],
        json!([
            step("admission", "admitted", path, json!(true)),
            step("physical", "file_exists", path, json!(true)),
            step("configuration", "realpath", path, json!(path))
        ])
    );
    assert_eq!(observed["faultsActivated"], faults);
}

#[cfg(unix)]
#[test]
fn configured_absent_repository_root_uses_the_physical_system_inside_its_sandbox() {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let directory = std::env::temp_dir().join(format!(
        "semctx-resolution-root-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::create_dir_all(directory.join("Repository")).unwrap();
    std::fs::create_dir_all(directory.join("Sibling")).unwrap();
    let directory = directory.canonicalize().unwrap();
    let root = directory.to_string_lossy().into_owned();
    let repository = directory.join("Repository").to_string_lossy().into_owned();
    let source = directory
        .join("Repository/entry.ts")
        .to_string_lossy()
        .into_owned();
    let target = directory
        .join("Sibling/value.ts")
        .to_string_lossy()
        .into_owned();
    std::fs::write(&source, "export {};").unwrap();
    std::fs::write(&target, "export const value = 1;").unwrap();
    for (boundary, expected) in [
        (Some(repository.as_str()), None),
        (None, Some(target.as_str())),
    ] {
        let fs = Rc::new(
            live_system_observations::build_with_repository_root(
                &root,
                &[source.clone(), target.clone()],
                None,
                boundary,
            )
            .unwrap(),
        );
        let (resolver, _) = configured_resolver::configured(
            fs.clone(),
            root.clone(),
            "/sdk/lib".into(),
            ResolverOptions {
                host: Some(Rc::new(tsoptions::ResolverHost {
                    fs,
                    current_directory: root.clone(),
                })),
                compiler_options: Some(Rc::new(compiler_options())),
                ..Default::default()
            },
        );
        let (found, _, error) = resolver.resolve_configured_module(
            "../Sibling/value",
            &source,
            Some(ModuleKind::ES_NEXT),
        );
        assert!(error.is_none(), "{error:?}");
        let found = found.filter(|found| !found.resolved_file_name.is_empty());
        assert_eq!(
            found
                .as_ref()
                .map(|found| found.resolved_file_name.as_str()),
            expected,
            "{boundary:?}"
        );
    }
    std::fs::remove_dir_all(directory).unwrap();
}

#[cfg(unix)]
#[test]
fn configured_omitted_mode_ingests_a_live_source_without_inventory_or_causal_ledger_pollution() {
    let root = std::env::temp_dir().join(format!(
        "semctx-resolution-ingestion-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&root).unwrap();
    let root = root.canonicalize().unwrap();
    let source = root.join("entry.mts").to_string_lossy().into_owned();
    let target = root.join("target.ts").to_string_lossy().into_owned();
    std::fs::write(&source, "export const entry = 1;").unwrap();
    std::fs::write(&target, "export const value = 2;").unwrap();
    let root_text = root.to_string_lossy().into_owned();
    let fs = Rc::new(live_system_observations::build(&root_text, &[], None).unwrap());
    let (resolver, observations) = configured_resolver::configured(
        fs.clone(),
        root_text.clone(),
        "/sdk/lib".into(),
        ResolverOptions {
            host: Some(Rc::new(tsoptions::ResolverHost {
                fs: fs.clone(),
                current_directory: root_text,
            })),
            compiler_options: Some(Rc::new(compiler_options())),
            ..Default::default()
        },
    );
    let (found, _, error) = resolver.resolve_configured_module("./target", &source, None);
    assert!(error.is_none(), "{error:?}");
    assert_eq!(found.unwrap().resolved_file_name, target);
    assert!(
        !fs.live
            .as_ref()
            .unwrap()
            .inputs_ledger()
            .borrow()
            .contains_key(&source)
    );
    let observed = serde_json::to_value(&*observations.borrow()).unwrap();
    assert_eq!(observed["implied_modes"][&source], "import");
    assert_eq!(
        observed["source_acquisition"][&source],
        identity::digest_bytes(b"export const entry = 1;")
    );
    std::fs::remove_dir_all(root).unwrap();
}

#[cfg(unix)]
#[test]
fn resolution_host_contract_root_rejects_changed_case_before_any_delegate() {
    let parent =
        std::env::temp_dir().join(format!("semctx-resolution-case-{}", std::process::id()));
    let root = parent.join("CaseScope");
    std::fs::create_dir_all(&root).unwrap();
    let root = root.canonicalize().unwrap();
    let source = root.join("value.json").to_string_lossy().into_owned();
    std::fs::write(&source, "native bytes").unwrap();
    let alias = root
        .parent()
        .unwrap()
        .join("CASESCOPE/value.json")
        .to_string_lossy()
        .into_owned();
    let operations = ["file_exists", "read_file", "directory_exists", "realpath"];
    let observed = run(
        json!({"root":root.to_string_lossy(),"inventory":[source],"queries":operations.map(|operation|json!({"operation":operation,"path":alias}))}),
    );
    assert_eq!(observed["executed"], true, "{observed}");
    assert_eq!(
        observed["trace"],
        json!(operations.map(|_| step("admission", "admitted", &alias, json!(false))))
    );
    assert_eq!(
        observed["results"],
        json!([
            {"operation":"file_exists","path":alias,"value":false},
            {"operation":"read_file","path":alias,"value":null},
            {"operation":"directory_exists","path":alias,"value":false},
            {"operation":"realpath","path":alias,"value":alias}
        ])
    );
    std::fs::remove_dir_all(parent).unwrap();
}
