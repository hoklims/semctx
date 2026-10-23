use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};

struct Fixture(std::path::PathBuf);
impl Fixture {
    fn new() -> Self {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let path = std::env::temp_dir().join(format!(
            "semctx-configuration-live-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&path).unwrap();
        Self(path.canonicalize().unwrap())
    }
    fn path(&self, path: &str) -> String {
        self.0.join(path).to_string_lossy().into_owned()
    }
    fn write(&self, path: &str, text: &str) {
        let path = self.0.join(path);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }
    fn observe(&self, failures: serde_json::Value) -> serde_json::Value {
        run(
            serde_json::json!({"root":self.path(""),"source":self.path("src/main.ts"),"read_failures":failures}),
        )
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).unwrap();
    }
}

#[test]
fn live_reads_bind_initial_and_inherited_configuration_without_reading_source() {
    let fixture = Fixture::new();
    fixture.write("tsconfig.json", "{\"extends\":\"./base.json\"}");
    fixture.write("base.json", "{}");
    let result = fixture.observe(serde_json::json!({}));
    assert_eq!(result["executed"], true);
    assert_eq!(result["reasons"], serde_json::json!([]));
    assert_eq!(result["error"], serde_json::Value::Null);
    assert_eq!(
        result["inputs"][fixture.path("tsconfig.json")],
        "{\"extends\":\"./base.json\"}"
    );
    assert_eq!(result["inputs"][fixture.path("base.json")], "{}");
    assert!(result["inputs"].get(fixture.path("src/main.ts")).is_none());
}

#[test]
fn failed_initial_live_reads_keep_undefined_attribution_and_native_diagnostic() {
    let fixture = Fixture::new();
    fixture.write("tsconfig.json", "{}");
    for failure in ["undefined", "error"] {
        let path = fixture.path("tsconfig.json");
        let result = fixture.observe(serde_json::json!({path.clone():failure}));
        assert_eq!(result["error"], serde_json::Value::Null);
        assert_eq!(
            result["reasons"],
            serde_json::json!([format!(
                "SOURCE_CONFIGURATION_INVALID:5083:Cannot read file '{path}'."
            )])
        );
        assert!(
            result["inputs"]
                .as_object()
                .unwrap()
                .contains_key(&fixture.path("tsconfig.json"))
        );
        assert_eq!(
            result["inputs"][fixture.path("tsconfig.json")],
            serde_json::Value::Null
        );
        assert!(result["read_errors"][fixture.path("tsconfig.json")].is_string());
    }
}

#[test]
fn inherited_live_read_failure_remains_attributed() {
    let fixture = Fixture::new();
    fixture.write("tsconfig.json", "{\"extends\":\"./base.json\"}");
    fixture.write("base.json", "{}");
    let path = fixture.path("base.json");
    let result = fixture.observe(serde_json::json!({path.clone():"undefined"}));
    assert_eq!(
        result["inputs"][fixture.path("base.json")],
        serde_json::Value::Null
    );
    assert!(
        result["inputs"]
            .as_object()
            .unwrap()
            .contains_key(&fixture.path("base.json"))
    );
    assert!(result["reasons"].as_array().unwrap().iter().any(|reason| {
        reason
            .as_str()
            .unwrap()
            .contains("SOURCE_CONFIGURATION_INVALID:5083:")
    }));
}

#[test]
fn outside_inherited_configuration_is_refused_before_live_delegation() {
    let fixture = Fixture::new();
    fixture.write("repo/tsconfig.json", "{\"extends\":\"../base.json\"}");
    fixture.write("base.json", "{}");
    let result =
        run(serde_json::json!({"root":fixture.path("repo"),"source":fixture.path("repo/main.ts")}));
    assert_eq!(
        result["reasons"],
        serde_json::json!(["SOURCE_CONFIGURATION_OUTSIDE_REPOSITORY"])
    );
    assert!(result["inputs"].get(fixture.path("base.json")).is_none());
}

#[cfg(unix)]
#[test]
fn canonical_inherited_escape_is_refused_before_live_delegation() {
    let fixture = Fixture::new();
    fixture.write("repo/tsconfig.json", "{\"extends\":\"./base.json\"}");
    fixture.write("base.json", "{}");
    std::os::unix::fs::symlink(fixture.path("base.json"), fixture.path("repo/base.json")).unwrap();
    let result =
        run(serde_json::json!({"root":fixture.path("repo"),"source":fixture.path("repo/main.ts")}));
    assert_eq!(
        result["reasons"],
        serde_json::json!(["SOURCE_CONFIGURATION_OUTSIDE_REPOSITORY"])
    );
    assert!(
        result["inputs"]
            .get(fixture.path("repo/base.json"))
            .is_none()
    );
}

#[test]
fn normalized_failure_paths_match_the_live_read_key() {
    let fixture = Fixture::new();
    fixture.write("tsconfig.json", "{}");
    let alias = format!(
        "{}\\nested\\..\\tsconfig.json",
        fixture.path("").replace('/', "\\")
    );
    let result = fixture.observe(serde_json::json!({alias:"undefined"}));
    assert_eq!(
        result["inputs"][fixture.path("tsconfig.json")],
        serde_json::Value::Null
    );
    assert!(result["read_errors"][fixture.path("tsconfig.json")].is_string());
}

#[cfg(unix)]
#[test]
fn root_alias_preserves_configuration_discovery_without_a_source_file() {
    let fixture = Fixture::new();
    fixture.write("repo/tsconfig.json", "{}");
    std::os::unix::fs::symlink(fixture.path("repo"), fixture.path("alias")).unwrap();
    let result = run(
        serde_json::json!({"root":fixture.path("alias"),"source":fixture.path("alias/main.ts")}),
    );
    assert_eq!(result["error"], serde_json::Value::Null);
    assert_eq!(result["reasons"], serde_json::json!([]));
    assert_eq!(result["inputs"][fixture.path("alias/tsconfig.json")], "{}");
}

#[test]
fn malformed_or_relative_observation_inputs_do_not_execute_configuration_reads() {
    for request in [
        serde_json::json!({"root":"relative","source":"/repo/main.ts"}),
        serde_json::json!({"root":"/repo","source":"relative.ts"}),
        serde_json::json!({"root":"/repo","source":"/repo/\0/main.ts"}),
        serde_json::json!({"root":"/repo","source":"/repo/main.ts","read_failures":{"relative":"error"}}),
        serde_json::json!({"root":"/repo","source":"/repo/main.ts","unknown":true}),
    ] {
        let result = run(request);
        assert_eq!(result["executed"], false);
        assert!(result["error"].is_string());
        assert!(result.get("inputs").is_none());
    }
}

#[test]
fn live_without_snapshot_uses_the_ordinary_owning_component() {
    let fixture = Fixture::new();
    fixture.write(
        "tsconfig.json",
        "{\"compilerOptions\":{\"module\":\"NodeNext\",\"moduleResolution\":\"NodeNext\"}}",
    );
    let result = fixture.observe(serde_json::json!({}));
    assert_eq!(result["error"], serde_json::Value::Null);
    assert_eq!(result["reasons"], serde_json::json!([]));
    assert_eq!(
        result["inputs"][fixture.path("tsconfig.json")],
        "{\"compilerOptions\":{\"module\":\"NodeNext\",\"moduleResolution\":\"NodeNext\"}}"
    );
}

#[cfg(unix)]
#[test]
fn internal_inherited_symlink_delegates_to_the_native_system() {
    let fixture = Fixture::new();
    fixture.write("repo/tsconfig.json", "{\"extends\":\"./base.json\"}");
    fixture.write("repo/target.json", "{}");
    std::os::unix::fs::symlink(
        fixture.path("repo/target.json"),
        fixture.path("repo/base.json"),
    )
    .unwrap();
    let result =
        run(serde_json::json!({"root":fixture.path("repo"),"source":fixture.path("repo/main.ts")}));
    assert_eq!(result["error"], serde_json::Value::Null);
    assert_eq!(result["reasons"], serde_json::json!([]));
    assert_eq!(result["inputs"][fixture.path("repo/base.json")], "{}");
}
