//! Pure boundary controls. No Program or qualification witness is executed.
use super::*;

fn request() -> Request {
    serde_json::from_value(
        serde_json::json!({"id":"source-component-boundary-control", "cwd":"/repo",
        "sdk_directory":"/sdk/lib","case_sensitive":true,"roots":["/repo/main.ts"],
        "files":{"/repo/main.ts":"export {};"},"options":{}}),
    )
    .unwrap()
}

#[test]
fn source_component_roots_require_captured_typescript_and_preserve_declaration_mode() {
    assert!(validate_source_component_roots(&request()).is_ok());
    for path in ["/repo/main.d.ts", "/repo/main.js", "/outside/main.ts"] {
        let mut changed = request();
        changed.roots = vec![path.into()];
        changed.files = BTreeMap::from([(path.into(), "export {};".into())]);
        assert!(validate_source_component_roots(&changed).is_err());
    }
    assert!(validate_declaration_roots(&request()).is_err());
}

#[test]
fn source_component_mode_rejects_foreign_capture_missing_root_and_subject_controls() {
    let mut changed = request();
    changed
        .files
        .insert("/outside/escape.ts".into(), "export {};".into());
    assert!(validate_source_component_roots(&changed).is_err());
    changed = request();
    changed.files.clear();
    assert!(validate_source_component_roots(&changed).is_err());
    changed = request();
    changed.roots.push(changed.roots[0].clone());
    assert!(validate_source_component_roots(&changed).is_err());
    let mut changes = vec![request(); 5];
    changes[0].qualified = true;
    changes[1].retained = false;
    changes[2].roles.insert("main.ts".into(), "source".into());
    changes[3]
        .selection
        .insert("main.ts".into(), wire::Selection::Excluded);
    changes[4].disabled.insert("main.ts".into());
    for changed in changes {
        assert!(validate_source_component_roots(&changed).is_err());
    }
}
