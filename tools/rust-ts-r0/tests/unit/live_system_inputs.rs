use super::*;

struct InputsFixture(std::path::PathBuf);
impl InputsFixture {
    fn new() -> Self {
        use std::sync::atomic::{AtomicU64, Ordering};
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let root = std::env::temp_dir().join(format!(
            "Semctx-T00-LiveInputs-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&root).unwrap();
        Self(std::fs::canonicalize(root).unwrap())
    }
    fn path(&self, path: &str) -> String {
        self.0.join(path).to_string_lossy().into_owned()
    }
    fn write(&self, path: &str, text: &str) {
        let path = self.0.join(path);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }
    fn capture(&self, paths: &[&str]) -> CaptureFs {
        build(
            &self.path(""),
            &paths.iter().map(|path| self.path(path)).collect::<Vec<_>>(),
            None,
        )
        .unwrap()
    }
    fn inputs(&self, fs: &CaptureFs) -> BTreeMap<String, Option<String>> {
        fs.live.as_ref().unwrap().inputs.borrow().clone()
    }
    fn expected(&self, entries: &[(&str, Option<&str>)]) -> BTreeMap<String, Option<String>> {
        entries
            .iter()
            .map(|(path, text)| (self.path(path), text.map(str::to_owned)))
            .collect()
    }
    fn workspace(&self) {
        self.write("package.json", ROOT_MANIFEST);
        self.write("Packages/Member/package.json", MEMBER_MANIFEST);
        self.write("Packages/Member/Base.json", "workspace bytes\n");
        self.write("Unused.ts", "export {};\n");
    }
    fn workspace_capture(&self) -> CaptureFs {
        self.capture(&[
            "package.json",
            "Packages/Member/package.json",
            "Packages/Member/Base.json",
            "Unused.ts",
        ])
    }
}
impl Drop for InputsFixture {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).unwrap();
    }
}

const ROOT_MANIFEST: &str = r#"{"workspaces":["Packages/*"],"dependencies":{"Pkg":"workspace:*"}}"#;
const MEMBER_MANIFEST: &str = r#"{"name":"Pkg","version":"1.0.0"}"#;

#[test]
fn acquisition_and_successful_metadata_probes_do_not_populate_causal_inputs() {
    let fixture = InputsFixture::new();
    fixture.write("Unused.ts", "export {};\n");
    fixture.write("Read.json", "read bytes\n");
    let fs = fixture.capture(&["Unused.ts", "Read.json"]);
    assert_eq!(fixture.inputs(&fs), BTreeMap::new());
    assert!(fs.file_exists(&fixture.path("Read.json")));
    assert!(fs.directory_exists(&fixture.path("")));
    assert_eq!(
        fs.realpath(&fixture.path("Read.json")),
        fixture.path("Read.json")
    );
    assert_eq!(fixture.inputs(&fs), BTreeMap::new());
    assert_eq!(
        fs.read_file(&fixture.path("Read.json")),
        ("read bytes\n".into(), true)
    );
    assert_eq!(
        fixture.inputs(&fs),
        fixture.expected(&[("Read.json", Some("read bytes\n"))])
    );
}

#[test]
fn mixed_case_synthetic_reads_record_all_and_only_causal_manifest_and_target_inputs() {
    let fixture = InputsFixture::new();
    fixture.workspace();
    let fs = fixture.workspace_capture();
    let query = fixture.path("node_modules/Pkg/Base.json");
    let expected = fixture.expected(&[
        ("package.json", Some(ROOT_MANIFEST)),
        ("pnpm-workspace.yaml", None),
        ("Packages/Member/package.json", Some(MEMBER_MANIFEST)),
        ("Packages/Member/Base.json", Some("workspace bytes\n")),
    ]);
    assert_eq!(fs.read_file(&query), ("workspace bytes\n".into(), true));
    assert_eq!(fixture.inputs(&fs), expected);
    assert_eq!(fs.read_file(&query), ("workspace bytes\n".into(), true));
    assert_eq!(fixture.inputs(&fs), expected);
}

#[test]
fn installed_read_does_not_claim_unread_workspace_metadata_or_acquired_sources() {
    let fixture = InputsFixture::new();
    fixture.workspace();
    fixture.write("node_modules/Pkg/Base.json", "installed bytes\n");
    let fs = fixture.workspace_capture();
    assert_eq!(
        fs.read_file(&fixture.path("node_modules/Pkg/Base.json")),
        ("installed bytes\n".into(), true)
    );
    assert_eq!(
        fixture.inputs(&fs),
        fixture.expected(&[("node_modules/Pkg/Base.json", Some("installed bytes\n"))])
    );
}

#[test]
fn missing_synthetic_target_metadata_and_read_have_distinct_complete_input_maps() {
    let fixture = InputsFixture::new();
    fixture.workspace();
    let fs = fixture.workspace_capture();
    let query = fixture.path("node_modules/Pkg/Missing.json");
    let mut expected = fixture.expected(&[
        ("package.json", Some(ROOT_MANIFEST)),
        ("pnpm-workspace.yaml", None),
        ("Packages/Member/package.json", Some(MEMBER_MANIFEST)),
        ("Packages/Member/Missing.json", None),
    ]);
    assert!(!fs.file_exists(&query));
    assert_eq!(fixture.inputs(&fs), expected);
    assert!(!fs.directory_exists(&query));
    assert_eq!(fixture.inputs(&fs), expected);
    assert_eq!(fs.realpath(&query), query);
    assert_eq!(fixture.inputs(&fs), expected);
    assert_eq!(fs.read_file(&query), (String::new(), false));
    expected.insert(query, None);
    assert_eq!(fixture.inputs(&fs), expected);
}

#[test]
fn physical_internal_alias_keeps_lexical_spelling_while_synthetic_alias_is_refused() {
    let fixture = InputsFixture::new();
    fixture.workspace();
    std::os::unix::fs::symlink(
        fixture.path("Packages/Member/Base.json"),
        fixture.path("Alias.json"),
    )
    .unwrap();
    std::os::unix::fs::symlink(
        fixture.path("Packages/Member/Base.json"),
        fixture.path("Packages/Member/Alias.json"),
    )
    .unwrap();
    let fs = fixture.workspace_capture();
    assert_eq!(
        fs.read_file(&fixture.path("Alias.json")),
        ("workspace bytes\n".into(), true)
    );
    assert_eq!(
        fixture.inputs(&fs),
        fixture.expected(&[("Alias.json", Some("workspace bytes\n"))])
    );
    assert_eq!(
        fs.read_file(&fixture.path("node_modules/Pkg/Alias.json")),
        (String::new(), false)
    );
    assert_eq!(
        fixture.inputs(&fs),
        fixture.expected(&[
            ("Alias.json", Some("workspace bytes\n")),
            ("package.json", Some(ROOT_MANIFEST)),
            ("pnpm-workspace.yaml", None),
            ("Packages/Member/package.json", Some(MEMBER_MANIFEST)),
            ("Packages/Member/Alias.json", None),
            ("node_modules/Pkg/Alias.json", None),
        ])
    );
}

#[test]
fn failed_native_reads_and_refused_paths_keep_exact_undefined_entries() {
    let fixture = InputsFixture::new();
    fixture.write("Unused.ts", "export {};\n");
    fixture.write("Directory/keep", "");
    fixture.write("Unreadable.json", "unreadable bytes");
    std::os::unix::fs::symlink(fixture.path("Cycle.json"), fixture.path("Cycle.json")).unwrap();
    let fs = fixture.capture(&["Unused.ts"]);
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(
        fixture.path("Unreadable.json"),
        std::fs::Permissions::from_mode(0o0),
    )
    .unwrap();
    let unreadable = fs.read_file(&fixture.path("Unreadable.json"));
    std::fs::set_permissions(
        fixture.path("Unreadable.json"),
        std::fs::Permissions::from_mode(0o600),
    )
    .unwrap();
    assert_eq!(unreadable, (String::new(), false));
    for path in ["Directory", "Missing.json", "Cycle.json"] {
        assert_eq!(fs.read_file(&fixture.path(path)), (String::new(), false));
    }
    assert_eq!(
        fixture.inputs(&fs),
        fixture.expected(&[
            ("Directory", None),
            ("Missing.json", None),
            ("Cycle.json", None),
            ("Unreadable.json", None)
        ])
    );
    let failures = fs.live.as_ref().unwrap().errors.borrow();
    assert!(failures.iter().any(|failure| {
        failure["path"] == fixture.path("Unreadable.json")
            && failure["reason"]
                .as_str()
                .unwrap()
                .starts_with("LIVE_READ_FAILED:")
    }));
    assert!(failures.iter().any(|failure| {
        failure["path"] == fixture.path("Cycle.json")
            && failure["reason"]
                .as_str()
                .unwrap()
                .starts_with("LIVE_CANONICAL_FAILED:")
    }));
}

#[test]
fn omitted_inventory_can_discover_workspace_metadata_by_actual_live_reads() {
    let fixture = InputsFixture::new();
    fixture.workspace();
    let observed = run(
        serde_json::json!({"root":fixture.path(""),"queries":[{"operation":"read_file","path":fixture.path("node_modules/Pkg/Base.json")}]}),
        None,
    );
    assert_eq!(observed["executed"], true);
    assert_eq!(observed["unsupported"], serde_json::json!([]));
    assert_eq!(observed["results"][0]["value"], "workspace bytes\n");
    assert_eq!(
        observed["inputs"],
        serde_json::to_value(fixture.expected(&[
            ("package.json", Some(ROOT_MANIFEST)),
            ("pnpm-workspace.yaml", None),
            ("Packages/Member/package.json", Some(MEMBER_MANIFEST)),
            ("Packages/Member/Base.json", Some("workspace bytes\n")),
        ]))
        .unwrap()
    );
}

#[test]
fn repository_boundary_is_optional_and_distinct_from_the_execution_sandbox() {
    let fixture = InputsFixture::new();
    fixture.write("Repository/Unused.ts", "export {};\n");
    fixture.write("Sibling.json", "sibling bytes\n");
    let request = serde_json::json!({
        "root": fixture.path(""),
        "inventory": [fixture.path("Repository/Unused.ts")],
        "queries": [{"operation":"read_file","path":fixture.path("Sibling.json")}]
    });
    for (boundary, expected) in [
        (Some(serde_json::json!(fixture.path("Repository"))), None),
        (Some(serde_json::Value::Null), Some("sibling bytes\n")),
        (None, Some("sibling bytes\n")),
    ] {
        let mut descriptor = request.clone();
        if let Some(boundary) = boundary {
            descriptor["repository_root"] = boundary;
        }
        let observed = run(descriptor, None);
        assert_eq!(observed["executed"], true, "{observed}");
        assert_eq!(observed["unsupported"], serde_json::json!([]));
        assert_eq!(observed["results"][0]["value"], serde_json::json!(expected));
        assert_eq!(
            observed["inputs"],
            serde_json::to_value(fixture.expected(&[("Sibling.json", expected)])).unwrap()
        );
    }
}

#[test]
fn rootless_missing_native_metadata_bypasses_the_repository_admission_layer() {
    let fixture = InputsFixture::new();
    fixture.write("Unused.ts", "export {};\n");
    let path = fixture.path("Missing.json");
    let queries = serde_json::json!([
        {"operation":"file_exists","path":path},
        {"operation":"directory_exists","path":path},
        {"operation":"realpath","path":path}
    ]);
    for (boundary, expected) in [
        (serde_json::Value::Null, BTreeMap::new()),
        (
            serde_json::json!(fixture.path("")),
            fixture.expected(&[("Missing.json", None)]),
        ),
    ] {
        let observed = run(
            serde_json::json!({"root":fixture.path(""),"repository_root":boundary,"queries":queries}),
            None,
        );
        assert_eq!(observed["executed"], true);
        assert_eq!(observed["unsupported"], serde_json::json!([]));
        assert_eq!(observed["results"][0]["value"], false);
        assert_eq!(observed["results"][1]["value"], false);
        assert_eq!(observed["results"][2]["value"], path);
        assert_eq!(observed["inputs"], serde_json::to_value(expected).unwrap());
    }
}

#[test]
fn native_and_synthetic_directories_exercise_installed_precedence_without_file_reads() {
    let fixture = InputsFixture::new();
    fixture.workspace();
    let fs = fixture.workspace_capture();
    assert!(fs.directory_exists(&fixture.path("node_modules")));
    assert!(fs.directory_exists(&fixture.path("node_modules/Pkg")));
    assert!(!fs.file_exists(&fixture.path("node_modules/Pkg")));
    assert_eq!(
        fs.realpath(&fixture.path("node_modules/Pkg")),
        fixture.path("Packages/Member")
    );
    assert_eq!(
        fixture.inputs(&fs),
        fixture.expected(&[
            ("package.json", Some(ROOT_MANIFEST)),
            ("pnpm-workspace.yaml", None),
            ("Packages/Member/package.json", Some(MEMBER_MANIFEST)),
        ])
    );
    std::fs::create_dir_all(fixture.path("node_modules/Pkg")).unwrap();
    assert!(fs.directory_exists(&fixture.path("node_modules/Pkg")));
    assert_eq!(
        fs.realpath(&fixture.path("node_modules/Pkg")),
        fixture.path("node_modules/Pkg")
    );
    assert_eq!(
        fixture.inputs(&fs),
        fixture.expected(&[
            ("package.json", Some(ROOT_MANIFEST)),
            ("pnpm-workspace.yaml", None),
            ("Packages/Member/package.json", Some(MEMBER_MANIFEST)),
        ])
    );
}

#[test]
fn above_repository_installation_suppresses_workspace_fallback_without_reading_external_bytes() {
    let fixture = InputsFixture::new();
    fixture.write("Repository/package.json", ROOT_MANIFEST);
    fixture.write("Repository/Packages/Member/package.json", MEMBER_MANIFEST);
    fixture.write("Repository/Packages/Member/Base.json", "workspace bytes\n");
    fixture.write("node_modules/Pkg/Base.json", "above repository bytes\n");
    let repository = fixture.path("Repository");
    let fs = build_with_repository_root(&fixture.path(""), &[], None, Some(&repository)).unwrap();
    let virtual_path = fixture.path("Repository/node_modules/Pkg/Base.json");
    assert_eq!(fs.read_file(&virtual_path), (String::new(), false));
    assert_eq!(
        fs.read_file(&fixture.path("node_modules/Pkg/Base.json")),
        (String::new(), false)
    );
    assert_eq!(
        fixture.inputs(&fs),
        fixture.expected(&[
            ("Repository/package.json", Some(ROOT_MANIFEST)),
            ("Repository/pnpm-workspace.yaml", None),
            (
                "Repository/Packages/Member/package.json",
                Some(MEMBER_MANIFEST)
            ),
            ("Repository/node_modules/Pkg/Base.json", None),
            ("node_modules/Pkg/Base.json", None),
        ])
    );
}

#[test]
fn nested_member_and_canonical_escape_are_refused_at_their_distinct_native_seams() {
    let fixture = InputsFixture::new();
    fixture.workspace();
    fixture.write("Packages/Member/.git", "gitdir: private\n");
    let fs = build(&fixture.path(""), &[], None).unwrap();
    let query = fixture.path("node_modules/Pkg/Base.json");
    assert_eq!(fs.read_file(&query), (String::new(), false));
    assert_eq!(
        fixture.inputs(&fs),
        fixture.expected(&[
            ("package.json", Some(ROOT_MANIFEST)),
            ("pnpm-workspace.yaml", None),
            ("node_modules/Pkg/Base.json", None),
        ])
    );
    fixture.write("Repository/Unused.ts", "export {};\n");
    fixture.write("Sibling.json", "private sibling\n");
    std::os::unix::fs::symlink(
        fixture.path("Sibling.json"),
        fixture.path("Repository/Escaped.json"),
    )
    .unwrap();
    let repository = fixture.path("Repository");
    let confined =
        build_with_repository_root(&fixture.path(""), &[], None, Some(&repository)).unwrap();
    assert!(!confined.file_exists(&fixture.path("Repository/Escaped.json")));
    assert_eq!(
        confined.realpath(&fixture.path("Repository/Escaped.json")),
        fixture.path("Repository/Escaped.json")
    );
    assert_eq!(
        fixture.inputs(&confined),
        fixture.expected(&[("Repository/Escaped.json", None)])
    );
}

#[test]
fn repository_boundary_comparison_preserves_lexical_case_even_on_a_case_insensitive_volume() {
    let fixture = InputsFixture::new();
    fixture.write("Boundary/Owned.json", "owned bytes\n");
    let boundary = fixture.path("Boundary");
    let original = fixture.path("Boundary/Owned.json");
    let changed_case = fixture.path("boundary/Owned.json");
    assert!(std::fs::metadata(&original).unwrap().is_file());
    let observed = run(
        serde_json::json!({
            "root":fixture.path(""),
            "repository_root":boundary,
            "queries":[
                {"operation":"read_file","path":original},
                {"operation":"file_exists","path":changed_case},
                {"operation":"read_file","path":changed_case},
                {"operation":"realpath","path":changed_case}
            ]
        }),
        None,
    );
    assert_eq!(observed["executed"], true);
    assert_eq!(observed["unsupported"], serde_json::json!([]));
    assert_eq!(observed["results"][0]["value"], "owned bytes\n");
    assert_eq!(observed["results"][1]["value"], false);
    assert_eq!(observed["results"][2]["value"], serde_json::Value::Null);
    assert_eq!(observed["results"][3]["value"], changed_case);
    assert_eq!(
        observed["inputs"],
        serde_json::to_value(fixture.expected(&[
            ("Boundary/Owned.json", Some("owned bytes\n")),
            ("boundary/Owned.json", None),
        ]))
        .unwrap()
    );
}

#[test]
fn unknown_installed_presence_above_repository_suppresses_synthetic_fallback() {
    use std::os::unix::fs::PermissionsExt;
    let fixture = InputsFixture::new();
    fixture.write("Repository/package.json", ROOT_MANIFEST);
    fixture.write("Repository/Packages/Member/package.json", MEMBER_MANIFEST);
    fixture.write("Repository/Packages/Member/Base.json", "workspace bytes\n");
    let repository = fixture.path("Repository");
    let query = fixture.path("Repository/node_modules/Pkg/Base.json");
    let absent =
        build_with_repository_root(&fixture.path(""), &[], None, Some(&repository)).unwrap();
    assert_eq!(absent.read_file(&query), ("workspace bytes\n".into(), true));
    assert_eq!(
        fixture.inputs(&absent),
        fixture.expected(&[
            ("Repository/package.json", Some(ROOT_MANIFEST)),
            ("Repository/pnpm-workspace.yaml", None),
            (
                "Repository/Packages/Member/package.json",
                Some(MEMBER_MANIFEST)
            ),
            (
                "Repository/Packages/Member/Base.json",
                Some("workspace bytes\n")
            ),
        ])
    );
    let installed_parent = fixture.path("node_modules");
    std::fs::create_dir(&installed_parent).unwrap();
    let original_permissions = std::fs::metadata(&installed_parent).unwrap().permissions();
    std::fs::set_permissions(&installed_parent, std::fs::Permissions::from_mode(0o0)).unwrap();
    let metadata_error = std::fs::metadata(fixture.path("node_modules/Pkg")).unwrap_err();
    let unknown =
        build_with_repository_root(&fixture.path(""), &[], None, Some(&repository)).unwrap();
    let observed = unknown.read_file(&query);
    let inputs = fixture.inputs(&unknown);
    std::fs::set_permissions(&installed_parent, original_permissions).unwrap();
    assert_eq!(metadata_error.kind(), std::io::ErrorKind::PermissionDenied);
    assert_eq!(observed, (String::new(), false));
    assert_eq!(
        inputs,
        fixture.expected(&[
            ("Repository/package.json", Some(ROOT_MANIFEST)),
            ("Repository/pnpm-workspace.yaml", None),
            (
                "Repository/Packages/Member/package.json",
                Some(MEMBER_MANIFEST)
            ),
            ("Repository/node_modules/Pkg/Base.json", None),
        ])
    );
}
