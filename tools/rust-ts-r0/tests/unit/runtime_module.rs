use super::*;
use serde_json::json;
use std::collections::BTreeMap;

struct Fixture {
    root: std::path::PathBuf,
    files: BTreeMap<String, String>,
}
impl Fixture {
    fn new() -> Self {
        use std::sync::atomic::{AtomicU64, Ordering};
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let root = std::env::temp_dir().join(format!(
            "semctx-t00-runtime-module-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&root).unwrap();
        Self {
            root: std::fs::canonicalize(root).unwrap(),
            files: BTreeMap::new(),
        }
    }
    fn path(&self, path: &str) -> String {
        self.root.join(path).to_string_lossy().into_owned()
    }
    fn disk(&self, path: &str, source: &str) {
        let path = self.root.join(path);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, source).unwrap();
    }
    fn input(&mut self, path: &str, source: &str) {
        self.disk(path, source);
        self.files.insert(self.path(path), source.into());
    }
    fn request(&self, configured: bool, retained: bool) -> serde_json::Value {
        json!({"root":self.path(""),"repository_root":self.path(""),"containing_file":self.path("main.mjs"),"configured":configured,"retained":retained,"files":self.files,"canonical_failures":{}})
    }
    fn observe(&self, request: serde_json::Value) -> serde_json::Value {
        let sdk: Sdk = serde_json::from_str(include_str!("../../sdk/sdk-input.json")).unwrap();
        let observed = run(request, &sdk);
        assert_eq!(observed["executed"], true, "{observed}");
        assert_eq!(observed["unsupported"], json!([]), "{observed}");
        observed
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.root).unwrap();
    }
}

fn source(specifier: &str) -> String {
    format!("import {{ value }} from {specifier:?}; export {{ value }};")
}

#[test]
fn configured_companions_use_the_actual_live_or_snapshot_system_for_each_extension() {
    for retained in [false, true] {
        for (declaration, runtime) in [
            ("target.d.ts", "target.js"),
            ("target.d.mts", "target.mjs"),
            ("target.d.cts", "target.cjs"),
        ] {
            let mut fixture = Fixture::new();
            fixture.input("main.mjs", &source(&format!("./{runtime}")));
            fixture.input(declaration, "export declare const value: number;");
            if retained {
                fixture.input(runtime, "export const value = 1;");
            } else {
                fixture.disk(runtime, "export const value = 1;");
            }
            let observed = fixture.observe(fixture.request(true, retained));
            assert_eq!(
                observed["extraction"]["imports"][0]["resolvedRelPath"],
                runtime
            );
            assert_eq!(observed["runtime_resolution"][0]["runtime_exists"], true);
            assert_eq!(
                observed["runtime_resolution"][0]["canonical_attempted"],
                !retained
            );
        }
    }
}

#[test]
fn unconfigured_resolution_keeps_the_declaration_without_testing_the_runtime() {
    let mut fixture = Fixture::new();
    fixture.input("main.mjs", &source("./target.mjs"));
    fixture.input("target.d.mts", "export declare const value: number;");
    fixture.input("target.mjs", "export const value = 1;");
    let observed = fixture.observe(fixture.request(false, true));
    assert_eq!(
        observed["extraction"]["imports"][0]["resolvedRelPath"],
        "target.d.mts"
    );
    assert_eq!(
        observed["runtime_resolution"][0]["runtime_exists"],
        serde_json::Value::Null
    );
    assert_eq!(
        observed["runtime_resolution"][0]["canonical_attempted"],
        false
    );
}

#[test]
fn absent_runtime_keeps_declaration_and_unresolved_import_stays_unresolved() {
    for missing_declaration in [false, true] {
        let mut fixture = Fixture::new();
        fixture.input("main.mjs", &source("./target.mjs"));
        if !missing_declaration {
            fixture.input("target.d.mts", "export declare const value: number;");
        }
        let observed = fixture.observe(fixture.request(true, false));
        assert_eq!(
            observed["extraction"]["imports"][0]["resolvedRelPath"],
            if missing_declaration {
                serde_json::Value::Null
            } else {
                json!("target.d.mts")
            }
        );
        assert_eq!(
            observed["runtime_resolution"][0]["canonical_attempted"],
            false
        );
    }
}

#[test]
fn canonical_faults_are_consumed_after_runtime_existence_at_the_owning_module_link() {
    for target in ["", "target.mjs"] {
        let mut fixture = Fixture::new();
        fixture.input("main.mjs", &source("./target.mjs"));
        fixture.input("target.d.mts", "export declare const value: number;");
        fixture.disk("target.mjs", "export const value = 1;");
        let mut request = fixture.request(true, false);
        request["canonical_failures"] =
            json!({ (fixture.path(target)): "runtime_module_canonical_fault" });
        let observed = fixture.observe(request);
        assert_eq!(
            observed["extraction"]["imports"][0]["resolvedRelPath"],
            serde_json::Value::Null
        );
        assert_eq!(observed["runtime_resolution"][0]["runtime_exists"], true);
        assert_eq!(
            observed["runtime_resolution"][0]["canonical_attempted"],
            true
        );
        assert_eq!(
            observed["runtime_resolution"][0]["canonical_errors"][0]["path"],
            fixture.path(target)
        );
        assert!(
            observed["inputs"]
                .as_object()
                .unwrap()
                .contains_key(&fixture.path("target.mjs"))
        );
        assert_eq!(
            observed["inputs"][fixture.path("target.mjs")],
            serde_json::Value::Null
        );
    }
}

#[cfg(unix)]
#[test]
fn escaped_runtime_is_refused_only_for_rooted_live_resolution_and_records_undefined() {
    let outside = Fixture::new();
    outside.disk("outside.mjs", "export const value = 1;");
    for rooted in [false, true] {
        let mut fixture = Fixture::new();
        fixture.input("main.mjs", &source("./target.mjs"));
        fixture.input("target.d.mts", "export declare const value: number;");
        std::os::unix::fs::symlink(outside.path("outside.mjs"), fixture.path("target.mjs"))
            .unwrap();
        let mut request = fixture.request(true, false);
        if !rooted {
            request.as_object_mut().unwrap().remove("repository_root");
        }
        let observed = fixture.observe(request);
        assert_eq!(
            observed["extraction"]["imports"][0]["resolvedRelPath"],
            if rooted {
                serde_json::Value::Null
            } else {
                json!("target.mjs")
            }
        );
        assert_eq!(observed["runtime_resolution"][0]["runtime_exists"], true);
        assert_eq!(
            observed["runtime_resolution"][0]["canonical_attempted"],
            rooted
        );
        if rooted {
            assert!(
                observed["inputs"]
                    .as_object()
                    .unwrap()
                    .contains_key(&fixture.path("target.mjs"))
            );
            assert_eq!(
                observed["inputs"][fixture.path("target.mjs")],
                serde_json::Value::Null
            );
        }
    }
}

#[test]
fn retained_and_rootless_controls_do_not_consume_injected_canonical_faults() {
    for retained in [false, true] {
        let mut fixture = Fixture::new();
        fixture.input("main.mjs", &source("./target.mjs"));
        fixture.input("target.d.mts", "export declare const value: number;");
        fixture.input("target.mjs", "export const value = 1;");
        let mut request = fixture.request(true, retained);
        if !retained {
            request.as_object_mut().unwrap().remove("repository_root");
        }
        request["canonical_failures"] = json!({ (fixture.path("")): "must_not_be_called", (fixture.path("target.mjs")): "must_not_be_called" });
        let observed = fixture.observe(request);
        assert_eq!(
            observed["extraction"]["imports"][0]["resolvedRelPath"],
            "target.mjs"
        );
        assert_eq!(
            observed["runtime_resolution"][0]["canonical_attempted"],
            false
        );
        assert_eq!(
            observed["runtime_resolution"][0]["canonical_errors"],
            json!([])
        );
    }
}

#[test]
fn actual_analyze_uses_configured_wrapper_for_a_retained_typescript_only_root() {
    let mut fixture = Fixture::new();
    fixture.input(
        "main.ts",
        "import { value } from './target.js'; export const observed = value;",
    );
    fixture.input("target.d.ts", "export declare const value: number;");
    fixture.input("target.js", "export const value = 1;");
    std::fs::remove_file(fixture.path("target.js")).unwrap();
    let request: crate::Request = serde_json::from_value(json!({
        "id":"runtime-wrapper-retained-typescript","cwd":fixture.path(""),"sdk_directory":"/sdk/lib",
        "case_sensitive":ts_goport::frontend::vfs::osvfs_fs().use_case_sensitive_file_names(),
        "roots":[fixture.path("main.ts")],"files":fixture.files,"retained":true,"qualified":false,
        "options":{"target":"ES2022","module":"ESNext","moduleResolution":"Bundler","allowJs":true,"jsx":"Preserve","skipLibCheck":true,"noEmit":true,"strict":false}
    })).unwrap();
    let sdk: Sdk = serde_json::from_str(include_str!("../../sdk/sdk-input.json")).unwrap();
    let observed = crate::analyze(request, sdk).unwrap();
    assert_eq!(
        observed["raw_extraction"]["imports"][0]["fromRelPath"],
        "main.ts"
    );
    assert_eq!(
        observed["raw_extraction"]["imports"][0]["resolvedRelPath"],
        "target.js"
    );
    assert_eq!(
        observed["runtimeModuleObservation"]["trace"][0]["configured"],
        true
    );
    assert_eq!(
        observed["runtimeModuleObservation"]["trace"][0]["retained"],
        true
    );
    assert_eq!(
        observed["runtimeModuleObservation"]["trace"][0]["runtime_exists"],
        true
    );
}

#[test]
fn actual_worker_uses_the_mixed_program_wrapper_for_a_typescript_importer() {
    let mut fixture = Fixture::new();
    fixture.input(
        "main.ts",
        "import { value } from './target.js'; export const observed = value;",
    );
    fixture.input("javascript.mjs", "export const enabled = true;");
    fixture.input("target.d.ts", "export declare const value: number;");
    fixture.input("target.js", "export const value = 1;");
    let sdk: Sdk = serde_json::from_str(include_str!("../../sdk/sdk-input.json")).unwrap();
    let roots = vec![fixture.path("main.ts"), fixture.path("javascript.mjs")];
    let observed = crate::worker_observations::run(
        json!({
            "schemaVersion":1,"jobId":"runtime-wrapper-mixed-worker","repoRoot":fixture.path(""),
            "rootAbsPaths":roots,"emitAbsPaths":roots
        }),
        &sdk,
    );
    assert_eq!(observed["ok"], true, "{observed}");
    assert_eq!(observed["extraction_started"], true);
    assert_eq!(
        observed["extraction"]["imports"][0]["fromRelPath"],
        "main.ts"
    );
    assert_eq!(
        observed["extraction"]["imports"][0]["resolvedRelPath"],
        "target.js"
    );
    assert_eq!(
        observed["runtimeModuleObservation"]["trace"][0]["configured"],
        true
    );
    assert_eq!(
        observed["runtimeModuleObservation"]["trace"][0]["retained"],
        false
    );
    assert_eq!(
        observed["runtimeModuleObservation"]["trace"][0]["runtime_exists"],
        true
    );
}
