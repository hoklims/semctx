use super::*;

fn workspace_files() -> BTreeMap<String, String> {
    BTreeMap::from([
        (
            "/repo/package.json".into(),
            r#"{"name":"t00-captured-system-root-dev","workspaces":["apps/*","settings/*"]}"#
                .into(),
        ),
        (
            "/repo/apps/client/package.json".into(),
            r#"{"name":"t00-client-dev","dependencies":{"@t00/config-dev":"workspace:*"}}"#.into(),
        ),
        (
            "/repo/settings/shared/package.json".into(),
            r#"{"name":"@t00/config-dev","version":"2.4.1"}"#.into(),
        ),
        (
            "/repo/settings/shared/tsconfig/base.json".into(),
            r#"{"compilerOptions":{"strict":true}}"#.into(),
        ),
    ])
}

#[test]
fn captured_system_native_configuration_uses_the_physical_workspace_base() {
    let mut files = workspace_files();
    files.insert(
        "/repo/apps/client/entry.ts".into(),
        "export const t00PhysicalConfigurationDev = 349;".into(),
    );
    files.insert(
        "/repo/apps/client/tsconfig.json".into(),
        r#"{"extends":"@t00/config-dev/tsconfig/base.json"}"#.into(),
    );
    files.insert(
        "/repo/settings/shared/tsconfig/base.json".into(),
        r#"{"extends":"../../t00-global-base.json","compilerOptions":{"strict":true}}"#.into(),
    );
    files.insert(
        "/repo/settings/t00-global-base.json".into(),
        r#"{"compilerOptions":{"module":"CommonJS"}}"#.into(),
    );
    let fs = Rc::new(CaptureFs::with_workspace_root(files, true, "/repo", None));
    let configuration =
        configuration::inspect(fs.clone(), "/repo/apps/client/entry.ts", "/repo").unwrap();
    assert!(configuration.options.strict.is_true());
    assert_eq!(configuration.options.module, ModuleKind::COMMON_JS);
    assert!(
        configuration
            .consumed
            .contains("/repo/settings/t00-global-base.json")
    );
    assert!(
        fs.log
            .borrow()
            .iter()
            .any(|probe| probe.operation == "read_file"
                && probe.path == "/repo/settings/shared/tsconfig/base.json"
                && probe.found)
    );
}

#[test]
fn captured_system_installed_member_blocks_the_synthetic_fallback() {
    for installed_configuration in [false, true] {
        let mut files = workspace_files();
        files.insert(
            "/repo/node_modules/@t00/config-dev/package.json".into(),
            r#"{"name":"@t00/config-dev"}"#.into(),
        );
        if installed_configuration {
            files.insert(
                "/repo/node_modules/@t00/config-dev/tsconfig/base.json".into(),
                "installed t00 configuration".into(),
            );
        }
        let fs = CaptureFs::with_workspace_root(files, true, "/repo", None);
        let virtual_path = "/repo/apps/client/node_modules/@t00/config-dev/tsconfig/base.json";
        assert!(!fs.file_exists(virtual_path));
        assert!(!fs.read_file(virtual_path).1);
        assert!(fs.workspace.as_ref().unwrap().aliases.borrow().is_empty());
        assert_eq!(
            fs.read_file("/repo/node_modules/@t00/config-dev/tsconfig/base.json"),
            (
                if installed_configuration {
                    "installed t00 configuration".into()
                } else {
                    String::new()
                },
                installed_configuration
            )
        );
    }
}

#[test]
fn captured_system_ambiguous_members_and_escaped_targets_are_refused() {
    let mut files = workspace_files();
    files.insert(
        "/repo/settings/duplicate/package.json".into(),
        r#"{"name":"@t00/config-dev"}"#.into(),
    );
    files.insert("/outside/t00-secret.json".into(), "outside t00".into());
    let fs = CaptureFs::with_workspace_root(files, true, "/repo", None);
    assert!(fs.workspace.as_ref().unwrap().refusals.borrow().is_empty());
    assert!(!fs.file_exists("/repo/apps/client/node_modules/@t00/config-dev/tsconfig/base.json"));
    assert!(
        fs.workspace
            .as_ref()
            .unwrap()
            .refusals
            .borrow()
            .contains("WORKSPACE_MEMBER_AMBIGUOUS:@t00/config-dev")
    );
    assert_eq!(
        fs.read_file("/outside/t00-secret.json"),
        (String::new(), false)
    );
    assert_eq!(fs.read_file("/repo/apps/client/node_modules/@t00/config-dev/../../../../../../outside/t00-secret.json"),(String::new(),false));
}

#[test]
fn captured_system_nested_repository_cannot_supply_a_workspace_member() {
    let mut files = workspace_files();
    files.insert(
        "/repo/settings/shared/.git".into(),
        "gitdir: /development-only".into(),
    );
    let fs = CaptureFs::with_workspace_root(files, true, "/repo", None);
    assert!(!fs.file_exists("/repo/apps/client/node_modules/@t00/config-dev/tsconfig/base.json"));
    assert!(!fs.read_file("/repo/settings/shared/tsconfig/base.json").1);
}

#[test]
fn captured_system_workspace_issues_only_follow_attempted_virtual_queries() {
    let mut files = workspace_files();
    files.insert(
        "/repo/pnpm-workspace.yaml".into(),
        "packages: [apps/*, settings/*]".into(),
    );
    files.insert(
        "/repo/apps/client/ordinary.ts".into(),
        "export const t00OrdinaryCaptureDev = 347;".into(),
    );
    let fs = CaptureFs::with_workspace_root(files, true, "/repo", None);
    assert!(fs.log.borrow().is_empty());
    assert!(fs.read_file("/repo/apps/client/ordinary.ts").1);
    assert!(
        fs.workspace
            .as_ref()
            .unwrap()
            .unsupported
            .borrow()
            .is_empty()
    );
    let path = "/repo/apps/client/node_modules/@t00/config-dev/tsconfig/base.json";
    assert!(!fs.read_file(path).1);
    let workspace = fs.workspace.as_ref().unwrap();
    assert!(
        workspace
            .unsupported
            .borrow()
            .contains("WORKSPACE_PNPM_DECLARATION_UNSUPPORTED")
    );
    assert!(
        workspace
            .issues
            .borrow()
            .iter()
            .any(|issue| issue.path == path && issue.kind == "unsupported")
    );
}

#[test]
fn captured_system_another_dependency_range_does_not_taint_a_known_alias() {
    let mut files = workspace_files();
    files.insert("/repo/apps/client/package.json".into(),r#"{"name":"t00-client-dev","dependencies":{"@t00/config-dev":"workspace:*","@t00/other-dev":"workspace:^1.0.0-beta"}}"#.into());
    files.insert(
        "/repo/settings/other/package.json".into(),
        r#"{"name":"@t00/other-dev","version":"1.0.0"}"#.into(),
    );
    files.insert(
        "/repo/settings/other/config.json".into(),
        "other configuration".into(),
    );
    let fs = CaptureFs::with_workspace_root(files, true, "/repo", None);
    assert!(fs.directory_exists("/repo/apps/client/node_modules"));
    assert!(
        fs.read_file("/repo/apps/client/node_modules/@t00/config-dev/tsconfig/base.json")
            .1
    );
    assert!(
        fs.workspace
            .as_ref()
            .unwrap()
            .unsupported
            .borrow()
            .is_empty()
    );
    let other = "/repo/apps/client/node_modules/@t00/other-dev/config.json";
    assert!(!fs.read_file(other).1);
    assert!(
        fs.workspace
            .as_ref()
            .unwrap()
            .issues
            .borrow()
            .iter()
            .any(|issue| issue.path == other && issue.kind == "unsupported")
    );
}

#[test]
fn captured_system_virtual_package_name_matching_stays_literal_in_folded_capture() {
    let fs = CaptureFs::with_workspace_root(workspace_files(), false, "/repo", None);
    assert!(!fs.file_exists("/repo/apps/client/node_modules/@T00/config-dev/tsconfig/base.json"));
    assert!(fs.file_exists("/repo/apps/client/node_modules/@t00/config-dev/tsconfig/base.json"));
}

#[test]
fn captured_system_range_grammar_does_not_accept_split_operators() {
    let mut files = workspace_files();
    files.insert(
        "/repo/apps/client/package.json".into(),
        r#"{"name":"t00-client-dev","dependencies":{"@t00/config-dev":"workspace:> =2.0.0"}}"#
            .into(),
    );
    let fs = CaptureFs::with_workspace_root(files, true, "/repo", None);
    assert!(!fs.file_exists("/repo/apps/client/node_modules/@t00/config-dev/tsconfig/base.json"));
}

#[test]
fn captured_system_numeric_ranges_require_complete_member_versions() {
    for version in ["2", "2.4", "v2.4.1"] {
        let mut files = workspace_files();
        files.insert(
            "/repo/apps/client/package.json".into(),
            r#"{"name":"t00-client-dev","dependencies":{"@t00/config-dev":"workspace:^2.0.0"}}"#
                .into(),
        );
        files.insert(
            "/repo/settings/shared/package.json".into(),
            serde_json::json!({"name":"@t00/config-dev","version":version}).to_string(),
        );
        let fs = CaptureFs::with_workspace_root(files, true, "/repo", None);
        assert!(
            !fs.file_exists("/repo/apps/client/node_modules/@t00/config-dev/tsconfig/base.json"),
            "{version}"
        );
    }
}

#[test]
fn captured_system_workspace_ranges_and_exclusions_control_alias_eligibility() {
    for (range, expected) in [
        ("*", true),
        ("^2.4.0", true),
        (">= 2.4.0 < 3", true),
        ("^3.0.0", false),
        ("2.4.1", true),
        ("2.4.2", false),
    ] {
        let mut files = workspace_files();
        files.insert("/repo/apps/client/package.json".into(),serde_json::json!({"name":"t00-client-dev","dependencies":{"@t00/config-dev":format!("workspace:{range}")}}).to_string());
        let fs = CaptureFs::with_workspace_root(files, true, "/repo", None);
        assert_eq!(
            fs.file_exists("/repo/apps/client/node_modules/@t00/config-dev/tsconfig/base.json"),
            expected,
            "{range}"
        );
        assert!(
            fs.workspace
                .as_ref()
                .unwrap()
                .unsupported
                .borrow()
                .is_empty()
        );
    }
    let mut files = workspace_files();
    files.insert("/repo/package.json".into(),r#"{"name":"t00-captured-system-root-dev","workspaces":{"packages":["apps/*","settings/*","!settings/shared"]}}"#.into());
    let fs = CaptureFs::with_workspace_root(files, true, "/repo", None);
    assert!(!fs.file_exists("/repo/apps/client/node_modules/@t00/config-dev/tsconfig/base.json"));
}

#[test]
fn captured_system_observer_refuses_unknown_shapes_and_incomplete_sdk_fallback() {
    let valid = serde_json::json!({"profile":"retained","root":"/repo","case_sensitive":true,"files":{},"queries":[{"operation":"file_exists","path":"/repo/missing.ts"}]});
    let mut cases = vec![];
    let mut request = valid.clone();
    request["profile"] = serde_json::json!("unknown");
    cases.push(request);
    let mut request = valid.clone();
    request["queries"][0]["operation"] = serde_json::json!("unknown");
    cases.push(request);
    let mut request = valid.clone();
    request["queries"][0]["unexpected"] = serde_json::json!(true);
    cases.push(request);
    let mut request = valid.clone();
    request["sdk_directory"] = serde_json::json!("/sdk/lib");
    cases.push(request);
    let mut request = valid.clone();
    request["case_sensitive"] = serde_json::json!(false);
    request["files"] = serde_json::json!({"/repo/One.ts":"first","/repo/one.ts":"second"});
    cases.push(request);
    for request in cases {
        let observed = run(request, None);
        assert_eq!(observed["executed"], false);
        assert!(!observed["unsupported"].as_array().unwrap().is_empty());
    }
    let sdk = Sdk {
        version: "7.1.0-dev".into(),
        source_revision: Some("780dc512d64f40afebffa6a7028207649fb7ed1c".into()),
        library_manifest_sha256: Some(
            "b1fa7b60aa83d187453b26c0b56a096875a47e61977954aba7deba16161fd7ad".into(),
        ),
        archive_sha256: None,
        files: BTreeMap::from([(
            "/sdk/lib/t00-dev.d.ts".into(),
            "declare const t00SdkCaptureDev: number;".into(),
        )]),
    };
    assert_eq!(run(valid.clone(), Some(&sdk))["executed"], false);
    let mut request = valid;
    request["sdk_directory"] = serde_json::json!("/sdk/lib");
    request["queries"][0]["path"] = serde_json::json!("/sdk/lib/t00-dev.d.ts");
    assert_eq!(run(request, Some(&sdk))["results"][0]["value"], true);
}

#[test]
fn captured_system_profile_clone_preserves_exact_sdk_roles_and_read_evidence() {
    let mut files = workspace_files();
    files.insert(
        "/sdk/lib/t00-clone-dev.d.ts".into(),
        "declare const t00CloneDev: number;".into(),
    );
    files.insert(
        "/sdk/lib/t00-unclassified-dev.json".into(),
        "not classified SDK".into(),
    );
    let original = CaptureFs::new(files, true)
        .with_sdk_keys(["/sdk/lib/t00-clone-dev.d.ts"])
        .unwrap();
    let virtual_path = "/repo/apps/client/node_modules/@t00/config-dev/tsconfig/base.json";
    assert!(!original.read_file(virtual_path).1);
    let profile = original
        .workspace_profile("/repo", Some("/sdk/lib"))
        .unwrap();
    assert!(profile.read_file(virtual_path).1);
    assert!(profile.read_file("/sdk/lib/t00-clone-dev.d.ts").1);
    assert!(!profile.read_file("/sdk/lib/t00-unclassified-dev.json").1);
    assert!(!original.read_file(virtual_path).1);
    assert!(
        original
            .log
            .borrow()
            .iter()
            .any(|probe| probe.operation == "read_file"
                && probe.path == "/repo/settings/shared/tsconfig/base.json"
                && probe.found)
    );
}

#[test]
fn captured_system_sdk_exemption_uses_only_descriptor_file_keys() {
    let sdk = Sdk {
        version: "7.1.0-dev".into(),
        source_revision: Some("780dc512d64f40afebffa6a7028207649fb7ed1c".into()),
        library_manifest_sha256: Some(
            "b1fa7b60aa83d187453b26c0b56a096875a47e61977954aba7deba16161fd7ad".into(),
        ),
        archive_sha256: None,
        files: BTreeMap::from([(
            "/sdk/lib/t00-exact-sdk-dev.d.ts".into(),
            "declare const t00ExactSdkDev: number;".into(),
        )]),
    };
    let observed = run(
        serde_json::json!({"profile":"workspace","root":"/repo","sdk_directory":"/sdk","files":{"/sdk/t00-sdk-unrelated-dev.json":"not part of SDK"},"queries":[{"operation":"file_exists","path":"/sdk/t00-sdk-unrelated-dev.json"},{"operation":"file_exists","path":"/sdk/lib/t00-exact-sdk-dev.d.ts"}]}),
        Some(&sdk),
    );
    assert_eq!(observed["executed"], true);
    assert_eq!(observed["results"][0]["value"], false);
    assert_eq!(observed["results"][1]["value"], true);
}

#[test]
fn captured_system_observer_preserves_unpaired_utf16_and_refuses_ambient_reads() {
    let path = std::env::temp_dir().join(format!(
        "semctx-t00-captured-system-ambient-dev-{}.txt",
        std::process::id()
    ));
    std::fs::write(&path, b"development-only ambient bytes").unwrap();
    let observed = run(
        serde_json::json!({"profile":"retained","root":"/repo","files":{},"utf16_files":{"/repo/unpaired.txt":[65,55348,66]},"queries":[{"operation":"read_file","path":"/repo/unpaired.txt"},{"operation":"file_exists","path":path.to_string_lossy().replace('\\',"/")}]}),
        None,
    );
    std::fs::remove_file(path).unwrap();
    assert_eq!(observed["executed"], true);
    assert_eq!(
        observed["results"][0]["utf16Units"],
        serde_json::json!([65, 55348, 66])
    );
    assert_eq!(observed["results"][1]["value"], false);
}

#[test]
fn captured_system_root_boundary_contains_captured_descendants() {
    let observed = run(
        serde_json::json!({"profile":"workspace","root":"/","files":{"/repo/t00-root-dev.json":"captured descendant"},"queries":[{"operation":"file_exists","path":"/repo/t00-root-dev.json"}]}),
        None,
    );
    assert_eq!(observed["executed"], true);
    assert_eq!(observed["results"][0]["value"], true);
}

#[test]
fn captured_system_workspace_read_directory_is_an_explicit_gap() {
    let observed = run(
        serde_json::json!({"profile":"workspace","root":"/repo","files":workspace_files(),"queries":[{"operation":"read_directory","path":"/repo/apps"}]}),
        None,
    );
    assert_eq!(observed["executed"], true);
    assert_eq!(observed["results"][0]["executed"], false);
    assert_eq!(
        observed["unsupported"],
        serde_json::json!(["WORKSPACE_READ_DIRECTORY_UNSUPPORTED"])
    );
}

#[test]
fn captured_system_retained_observer_keeps_directory_profile_distinct() {
    let request = serde_json::json!({"profile":"retained","root":"/repo","case_sensitive":true,"files":{"/repo/fixtures/leaf.ts":"export const t00CapturedLeafDev = 337;"},"queries":[{"operation":"read_file","path":"/repo/fixtures/leaf.ts"},{"operation":"read_directory","path":"/repo/fixtures"},{"operation":"native_get_accessible_entries","path":"/repo/fixtures"},{"operation":"read_file","path":"/etc/passwd"}]});
    let observed = run(request, None);
    assert_eq!(observed["executed"], true);
    assert_eq!(observed["unsupported"], serde_json::json!([]));
    assert_eq!(
        observed["results"][0]["value"],
        "export const t00CapturedLeafDev = 337;"
    );
    assert_eq!(observed["results"][1]["value"], serde_json::json!([]));
    assert_eq!(
        observed["results"][2]["value"]["files"],
        serde_json::json!(["leaf.ts"])
    );
    assert_eq!(observed["results"][3]["found"], false);
}

#[test]
fn workspace_segment_depth_and_recursive_exclusions_select_actual_members() {
    for (pattern, consumer, excluded, expected) in [
        ("apps/**/client", "/apps/client", false, true),
        ("apps/**/client", "/apps/team/client", false, true),
        ("apps/*/client", "/apps/client", false, false),
        ("apps/*/client", "/apps/team/client", false, true),
        ("apps/*/client", "/apps/team/sub/client", false, false),
        ("apps/**", "/apps/team/client", true, false),
    ] {
        let mut files = workspace_files()
            .into_iter()
            .map(|(path, text)| (path.replace("/apps/client", consumer), text))
            .collect::<BTreeMap<_, _>>();
        let mut patterns = vec!["settings/**", pattern];
        if excluded {
            patterns.push("!apps/**/client");
        }
        files.insert(
            "/repo/package.json".into(),
            serde_json::json!({"workspaces":{"packages":patterns}}).to_string(),
        );
        let fs = CaptureFs::with_workspace_root(files, true, "/repo", None);
        assert_eq!(
            fs.file_exists(&format!(
                "/repo{consumer}/node_modules/@t00/config-dev/tsconfig/base.json"
            )),
            expected,
            "{pattern} {consumer} excluded={excluded}"
        );
    }
}

#[test]
fn workspace_members_with_multiple_wildcard_segments_keep_the_configuration_alias() {
    for sensitive in [true, false] {
        let files = workspace_files()
            .into_iter()
            .map(|(path, text)| (path.replace("/apps/client", "/apps/team/client"), text))
            .collect::<BTreeMap<_, _>>();
        let mut files = files;
        files.insert(
            "/repo/package.json".into(),
            r#"{"workspaces":{"packages":["settings/*","apps/*/*"]}}"#.into(),
        );
        let fs = CaptureFs::with_workspace_root(files, sensitive, "/repo", None);
        let path = "/repo/apps/team/client/node_modules/@t00/config-dev/tsconfig/base.json";
        assert!(
            fs.file_exists(path),
            "wildcard configuration alias must exist with case mode {sensitive}"
        );
        assert_eq!(
            fs.realpath(path),
            "/repo/settings/shared/tsconfig/base.json"
        );
    }
}

#[test]
fn captured_system_workspace_alias_reads_the_physical_configuration() {
    let fs = CaptureFs::with_workspace_root(workspace_files(), true, "/repo", None);
    let path = "/repo/apps/client/node_modules/@t00/config-dev/tsconfig/base.json";
    assert!(fs.file_exists(path));
    assert_eq!(
        fs.read_file(path),
        (r#"{"compilerOptions":{"strict":true}}"#.into(), true)
    );
    assert!(fs.directory_exists("/repo/apps/client/node_modules/@t00/config-dev/tsconfig"));
    assert_eq!(
        fs.realpath(path),
        "/repo/settings/shared/tsconfig/base.json"
    );
    let probes = fs.log.borrow();
    assert!(probes.iter().any(|probe| probe.operation == "read_file"
        && probe.path == "/repo/settings/shared/tsconfig/base.json"
        && probe.content_id
            == Some(identity::digest_bytes(
                br#"{"compilerOptions":{"strict":true}}"#
            ))));
}
