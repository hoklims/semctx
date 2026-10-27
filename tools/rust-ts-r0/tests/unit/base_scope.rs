use super::*;

#[test]
fn immutable_base_windows_paths_bind_exact_captured_bytes() {
    let template: Request = serde_json::from_value(json!({
        "id":"windows-base", "cwd":"C:/current", "sdk_directory":"/sdk/lib",
        "case_sensitive":false, "roots":[], "files":{}, "options":{}
    }))
    .unwrap();
    let source = "export const selected = 1;";
    let discovered = json!({"files":[{
        "absPath":"C:/base/src/selected.ts", "relPath":"src/selected.ts",
        "language":"typescript", "role":"source", "content":source
    }]});
    for native_path in [r"C:\base\src\selected.ts", "C:/base/src/selected.ts"] {
        let files = BTreeMap::from([(native_path.into(), source.as_bytes().to_vec())]);
        let request =
            capture_request(&template, "C:/base", &files, &discovered, &discovered).unwrap();
        assert_eq!(
            request
                .files
                .get("C:/base/src/selected.ts")
                .map(String::as_str),
            Some(source)
        );
        assert_eq!(request.roots, ["C:/base/src/selected.ts"]);
        for invalid in [
            BTreeMap::new(),
            BTreeMap::from([(native_path.into(), b"changed".to_vec())]),
            BTreeMap::from([(native_path.into(), vec![0xff])]),
            BTreeMap::from([(
                "C:/base-other/src/selected.ts".into(),
                source.as_bytes().to_vec(),
            )]),
        ] {
            assert!(
                capture_request(&template, "C:/base", &invalid, &discovered, &discovered)
                    .err()
                    .unwrap()
                    .contains("not bound to UTF-8 bytes")
            );
        }
    }
}
