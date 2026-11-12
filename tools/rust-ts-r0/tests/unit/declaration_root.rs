//! Pure request-boundary tests. These do not execute a Program or qualification case.
use super::*;

fn declaration_request(path: &str) -> Request {
    serde_json::from_value(serde_json::json!({
        "id":"declaration-boundary-test","cwd":"/repo","sdk_directory":"/sdk/lib",
        "case_sensitive":true,"roots":[path],"files":{path:"export {};"},"options":{}
    }))
    .unwrap()
}

#[test]
fn declaration_mode_accepts_only_captured_declaration_root_kinds() {
    for path in ["/repo/a.d.ts", "/repo/a.d.mts", "/repo/a.d.cts"] {
        assert!(validate_declaration_roots(&declaration_request(path)).is_ok());
    }
    for path in ["/repo/a.ts", "/repo/a.js", "/repo/a.d.ts.ts"] {
        assert!(
            validate_declaration_roots(&declaration_request(path))
                .unwrap_err()
                .starts_with("DECLARATION_ROOT_OBSERVATION_WRONG_ROOT_KIND:")
        );
    }
}

#[test]
fn declaration_mode_refuses_missing_duplicate_empty_and_outside_roots() {
    let base = declaration_request("/repo/a.d.ts");
    let mut missing = base.clone();
    missing.files.clear();
    assert!(
        validate_declaration_roots(&missing)
            .unwrap_err()
            .starts_with("DECLARATION_ROOT_OBSERVATION_MISSING_CAPTURED_ROOT:")
    );
    let mut duplicate = base.clone();
    duplicate.roots.push(duplicate.roots[0].clone());
    assert_eq!(
        validate_declaration_roots(&duplicate).unwrap_err(),
        "DECLARATION_ROOT_OBSERVATION_DUPLICATE_ROOT"
    );
    let mut empty = base;
    empty.roots.clear();
    assert_eq!(
        validate_declaration_roots(&empty).unwrap_err(),
        "DECLARATION_ROOT_OBSERVATION_REQUIRES_ROOTS"
    );
    assert!(validate_declaration_roots(&declaration_request("/outside/a.d.ts")).is_err());
}

#[test]
fn declaration_mode_cannot_request_graph_admission_or_regular_subject_controls() {
    let base = declaration_request("/repo/a.d.ts");
    let mut variants = vec![base.clone(); 5];
    variants[0].qualified = true;
    variants[1].retained = false;
    variants[2].roles.insert("a.d.ts".into(), "source".into());
    variants[3]
        .selection
        .insert("a.d.ts".into(), wire::Selection::Excluded);
    variants[4].disabled.insert("a.d.ts".into());
    for request in variants {
        assert_eq!(
            validate_declaration_roots(&request).unwrap_err(),
            "DECLARATION_ROOT_OBSERVATION_REQUIRES_UNQUALIFIED_RETAINED_COMPONENT_INPUTS"
        );
    }
}
