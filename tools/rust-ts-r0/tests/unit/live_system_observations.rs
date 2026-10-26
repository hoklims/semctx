use super::*;

struct Fixture(std::path::PathBuf);
impl Fixture {
    fn new() -> Self {
        use std::sync::atomic::{AtomicU64, Ordering};
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let root = std::env::temp_dir().join(format!(
            "semctx-t00-live-system-{}-{}",
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
    fn capture(&self, inventory: &[&str]) -> CaptureFs {
        capture(
            &self.path(""),
            &inventory
                .iter()
                .map(|path| self.path(path))
                .collect::<Vec<_>>(),
        )
        .unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).unwrap();
    }
}

#[test]
fn live_system_reads_current_file_and_observes_deletion_after_construction() {
    let fixture = Fixture::new();
    fixture.write("entry.json", "initial");
    let fs = fixture.capture(&["entry.json"]);
    fixture.write("entry.json", "changed");
    assert_eq!(
        fs.read_file(&fixture.path("entry.json")),
        ("changed".into(), true)
    );
    std::fs::remove_file(fixture.path("entry.json")).unwrap();
    assert!(!fs.file_exists(&fixture.path("entry.json")));
    assert_eq!(
        fs.read_file(&fixture.path("entry.json")),
        (String::new(), false)
    );
}

#[test]
fn live_system_symlink_escape_is_refused_but_internal_target_is_read() {
    let fixture = Fixture::new();
    let outside = Fixture::new();
    fixture.write("entry.json", "inside");
    outside.write("secret.json", "outside");
    std::os::unix::fs::symlink(fixture.path("entry.json"), fixture.path("internal.json")).unwrap();
    std::os::unix::fs::symlink(outside.path("secret.json"), fixture.path("escape.json")).unwrap();
    let fs = fixture.capture(&["entry.json"]);
    assert_eq!(
        fs.read_file(&fixture.path("internal.json")),
        ("inside".into(), true)
    );
    assert!(!fs.file_exists(&fixture.path("escape.json")));
    assert_eq!(
        fs.read_file(&fixture.path("escape.json")),
        (String::new(), false)
    );
    assert_eq!(
        fs.realpath(&fixture.path("escape.json")),
        fixture.path("escape.json")
    );
}

#[test]
fn live_system_inventory_cannot_read_outside_or_escaped_inputs() {
    let fixture = Fixture::new();
    let outside = Fixture::new();
    outside.write("secret.json", "outside");
    std::os::unix::fs::symlink(outside.path("secret.json"), fixture.path("escape.json")).unwrap();
    assert!(capture(&fixture.path(""), &[outside.path("secret.json")]).is_err());
    assert!(capture(&fixture.path(""), &[fixture.path("escape.json")]).is_err());
}

#[test]
fn live_system_nested_repository_created_after_construction_is_refused() {
    let fixture = Fixture::new();
    fixture.write("nested/value.json", "nested");
    let fs = fixture.capture(&["nested/value.json"]);
    fixture.write("nested/.git", "gitdir: elsewhere");
    assert!(!fs.file_exists(&fixture.path("nested/value.json")));
    assert_eq!(
        fs.read_file(&fixture.path("nested/value.json")),
        (String::new(), false)
    );
}

#[test]
fn live_system_installed_precedence_and_workspace_fallback_are_physical_reads() {
    let fixture = Fixture::new();
    fixture.write(
        "package.json",
        r#"{"workspaces":["packages/*"],"dependencies":{"pkg":"workspace:*"}}"#,
    );
    fixture.write(
        "packages/pkg/package.json",
        r#"{"name":"pkg","version":"1.0.0"}"#,
    );
    fixture.write("packages/pkg/base.json", "workspace");
    let fs = fixture.capture(&[
        "package.json",
        "packages/pkg/package.json",
        "packages/pkg/base.json",
    ]);
    assert_eq!(
        fs.read_file(&fixture.path("node_modules/pkg/base.json")),
        ("workspace".into(), true)
    );
    fixture.write("node_modules/pkg/base.json", "installed");
    assert_eq!(
        fs.read_file(&fixture.path("node_modules/pkg/base.json")),
        ("installed".into(), true)
    );
    assert!(fs.directory_exists(&fixture.path("node_modules/pkg")));
    assert_eq!(
        fs.realpath(&fixture.path("node_modules/pkg")),
        fixture.path("node_modules/pkg")
    );
}

#[test]
fn live_system_runtime_read_limit_and_cyclic_native_failure_are_explicit() {
    let fixture = Fixture::new();
    fixture.write("entry.json", "small");
    let fs = fixture.capture(&["entry.json"]);
    fixture.write("large.json", &"x".repeat(8_388_609));
    std::os::unix::fs::symlink(fixture.path("cycle.json"), fixture.path("cycle.json")).unwrap();
    assert_eq!(
        fs.read_file(&fixture.path("large.json")),
        (String::new(), false)
    );
    assert_eq!(
        fs.read_file(&fixture.path("cycle.json")),
        (String::new(), false)
    );
    let errors = fs.live.as_ref().unwrap().errors.borrow();
    assert!(errors.iter().any(|error| {
        error["reason"]
            .as_str()
            .unwrap()
            .contains("LIVE_READ_LIMIT")
    }));
    assert!(errors.iter().any(|error| {
        error["path"] == fixture.path("cycle.json")
            && error["reason"]
                .as_str()
                .unwrap()
                .starts_with("LIVE_CANONICAL_FAILED:")
    }));
}

#[test]
fn live_system_invalid_or_unbounded_requests_are_not_executed() {
    let fixture = Fixture::new();
    assert!(capture(&fixture.path(""), &[]).is_err());
    assert!(capture(&fixture.path(""), &vec![fixture.path("missing"); 4097]).is_err());
    for request in [
        serde_json::json!({"root":fixture.path(""),"inventory":[],"queries":[]}),
        serde_json::json!({"root":fixture.path(""),"inventory":[],"queries":[{"operation":"write_file","path":fixture.path("anything")}]}),
    ] {
        let result = run(request, None);
        assert_eq!(result["executed"], false);
        assert!(!result["unsupported"].as_array().unwrap().is_empty());
    }
}

#[test]
fn live_system_closest_escaped_tsconfig_remains_visible_but_its_read_is_refused() {
    let fixture = Fixture::new();
    let outside = Fixture::new();
    fixture.write("main.ts", "export const value = 1;");
    outside.write("tsconfig.json", r#"{"compilerOptions":{"strict":true}}"#);
    std::os::unix::fs::symlink(outside.path("tsconfig.json"), fixture.path("tsconfig.json"))
        .unwrap();
    let fs = fixture.capture(&["main.ts"]);
    assert!(fs.file_exists(&fixture.path("tsconfig.json")));
    assert_eq!(
        fs.read_file(&fixture.path("tsconfig.json")),
        (String::new(), false)
    );
    assert_eq!(
        fs.live
            .as_ref()
            .unwrap()
            .inputs
            .borrow()
            .get(&fixture.path("tsconfig.json")),
        Some(&None)
    );
}

#[test]
fn live_system_configuration_discovery_reads_an_omitted_inventory_config_and_preserves_native_failure()
 {
    use std::os::unix::fs::PermissionsExt;
    let fixture = Fixture::new();
    fixture.write("main.ts", "export const value = 1;");
    fixture.write("tsconfig.json", r#"{"compilerOptions":{"strict":true}}"#);
    let fs = Rc::new(fixture.capture(&["main.ts"]));
    std::fs::set_permissions(
        fixture.path("tsconfig.json"),
        std::fs::Permissions::from_mode(0o0),
    )
    .unwrap();
    let inspected = configuration::inspect(fs.clone(), &fixture.path("main.ts"), &fixture.path(""));
    std::fs::set_permissions(
        fixture.path("tsconfig.json"),
        std::fs::Permissions::from_mode(0o600),
    )
    .unwrap();
    assert!(inspected.is_err());
    assert!(
        fs.log
            .borrow()
            .iter()
            .any(|probe| probe.operation == "file_exists"
                && probe.path == fixture.path("tsconfig.json")
                && probe.found)
    );
    assert!(
        fs.live
            .as_ref()
            .unwrap()
            .errors
            .borrow()
            .iter()
            .any(|error| error["path"] == fixture.path("tsconfig.json")
                && error["reason"]
                    .as_str()
                    .unwrap()
                    .starts_with("LIVE_READ_FAILED:"))
    );
    assert_eq!(
        fs.live
            .as_ref()
            .unwrap()
            .inputs
            .borrow()
            .get(&fixture.path("tsconfig.json")),
        Some(&None)
    );
}

#[test]
fn live_system_configured_resolution_falls_back_to_defaults_when_nearest_configuration_cannot_be_read()
 {
    use std::os::unix::fs::PermissionsExt;
    let fixture = Fixture::new();
    fixture.write(
        "main.ts",
        "import { value } from './target'; export { value };",
    );
    fixture.write("target.ts", "export const value = 1;");
    fixture.write(
        "tsconfig.json",
        r#"{"compilerOptions":{"paths":{"alias":["./missing.ts"]}}}"#,
    );
    let fs = Rc::new(fixture.capture(&["main.ts", "target.ts", "tsconfig.json"]));
    let (create, observations) =
        configured_resolver::factory(fs.clone(), fixture.path(""), "/sdk/lib".into());
    let resolver = create(ResolverOptions {
        host: Some(Rc::new(tsoptions::ResolverHost {
            fs: fs.clone(),
            current_directory: fixture.path(""),
        })),
        compiler_options: Some(Rc::new(compiler_options())),
        ..Default::default()
    });
    std::fs::set_permissions(
        fixture.path("tsconfig.json"),
        std::fs::Permissions::from_mode(0o0),
    )
    .unwrap();
    let (found, diagnostics, error) =
        resolver.resolve_module_name("./target", &fixture.path("main.ts"), ModuleKind::NONE, None);
    std::fs::set_permissions(
        fixture.path("tsconfig.json"),
        std::fs::Permissions::from_mode(0o600),
    )
    .unwrap();
    assert!(error.is_none());
    assert!(diagnostics.is_empty());
    assert_eq!(
        found
            .as_ref()
            .map(|found| found.resolved_file_name.as_str()),
        Some(fixture.path("target.ts").as_str())
    );
    assert!(observations.borrow().errors.is_empty());
    assert!(
        fs.live
            .as_ref()
            .unwrap()
            .errors
            .borrow()
            .iter()
            .any(|error| error["path"] == fixture.path("tsconfig.json")
                && error["reason"]
                    .as_str()
                    .unwrap()
                    .starts_with("LIVE_READ_FAILED:"))
    );
}

#[test]
fn live_system_explicit_import_and_require_modes_resolve_distinct_export_conditions() {
    let fixture = Fixture::new();
    let files = [
        ("main.ts", "import { value } from 'dual'; export { value };"),
        (
            "tsconfig.json",
            r#"{"compilerOptions":{"module":"nodenext","moduleResolution":"nodenext"}}"#,
        ),
        (
            "node_modules/dual/package.json",
            r#"{"name":"dual","exports":{"import":"./import.d.mts","require":"./require.d.cts"}}"#,
        ),
        (
            "node_modules/dual/import.d.mts",
            "export declare const value: number;",
        ),
        (
            "node_modules/dual/require.d.cts",
            "export declare const value: number;",
        ),
    ];
    for (path, text) in files {
        fixture.write(path, text);
    }
    let sdk: Sdk = serde_json::from_slice(
        &std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/sdk/sdk-input.json")).unwrap(),
    )
    .unwrap();
    let inventory = files
        .iter()
        .map(|(path, _)| fixture.path(path))
        .collect::<Vec<_>>();
    for (mode, expected) in [("import", "import.d.mts"), ("require", "require.d.cts")] {
        let observed = run(
            serde_json::json!({"root":fixture.path(""),"inventory":inventory,"queries":[],"resolution":{"containing_file":fixture.path("main.ts"),"specifier":"dual","mode":mode}}),
            Some(&sdk),
        );
        assert_eq!(observed["executed"], true);
        assert_eq!(observed["unsupported"], serde_json::json!([]));
        assert_eq!(
            observed["resolved_file_name"],
            fixture.path(&format!("node_modules/dual/{expected}"))
        );
    }
}

#[test]
fn live_system_unknown_explicit_resolution_mode_is_refused() {
    let fixture = Fixture::new();
    fixture.write("main.ts", "export const value = 1;");
    let sdk: Sdk = serde_json::from_slice(
        &std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/sdk/sdk-input.json")).unwrap(),
    )
    .unwrap();
    let observed = run(
        serde_json::json!({"root":fixture.path(""),"inventory":[fixture.path("main.ts")],"queries":[],"resolution":{"containing_file":fixture.path("main.ts"),"specifier":"./target","mode":"unknown"}}),
        Some(&sdk),
    );
    assert_eq!(observed["executed"], false);
    assert!(!observed["unsupported"].as_array().unwrap().is_empty());
}
