use super::*;

#[test]
fn eligibility_refuses_invalid_queries_and_missing_execution_dependencies() {
    let good = serde_json::json!({"repositoryRoot":std::env::temp_dir(),"processHelper":std::env::temp_dir().join("semctx-eligibility-helper-that-does-not-exist"),"include":["src/**/*.ts"],"exclude":[],"queries":["src/main.ts"]});
    assert!(
        observe(good.clone())
            .unwrap_err()
            .starts_with("ELIGIBILITY_HELPER_UNAVAILABLE:")
    );
    for queries in [
        serde_json::json!([]),
        serde_json::json!(["../outside.ts"]),
        serde_json::json!(["/absolute.ts"]),
        serde_json::json!(["C:/outside.ts"]),
        serde_json::json!(["a\\b.ts"]),
        serde_json::json!(["a/./b.ts"]),
        serde_json::json!(["a//b.ts"]),
        serde_json::json!(["a\u{0}b.ts"]),
    ] {
        let mut bad = good.clone();
        bad["queries"] = queries;
        let error = observe(bad).unwrap_err();
        assert!(error.starts_with("ELIGIBILITY_QUERY_"), "{error}");
    }
    let mut missing = good;
    missing.as_object_mut().unwrap().remove("include");
    assert!(
        observe(missing)
            .unwrap_err()
            .starts_with("ELIGIBILITY_REQUEST_INVALID:")
    );
}

#[test]
fn eligibility_metadata_closes_relative_jsonc_extends_and_terminates_cycles() {
    let root = std::env::temp_dir().join(format!(
        "semctx-eligibility-metadata-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir_all(root.join("dist")).unwrap();
    for (path, text) in [
        (
            "dist/tsconfig.json",
            "{\"extends\":[\"./base\",\"../../outside\",3],}",
        ),
        ("dist/base.json", "{\"extends\":\"./leaf\"}"),
        ("dist/leaf.json", "{\"extends\":\"./base\"}"),
        ("dist/noise.ts", "export const noise=1;"),
    ] {
        fs::write(root.join(path), text).unwrap();
    }
    let (paths, reads) = metadata(&root).unwrap();
    assert_eq!(
        paths,
        BTreeSet::from([
            "dist/tsconfig.json".into(),
            "dist/base.json".into(),
            "dist/leaf.json".into()
        ])
    );
    assert_eq!(reads.len(), 3);
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink("tsconfig.json", root.join("dist/tsconfig.alias.json")).unwrap();
        std::os::unix::fs::symlink("dist", root.join("config-alias")).unwrap();
        fs::write(
            root.join("tsconfig.extended.json"),
            "{\"extends\":\"./config-alias/base\"}",
        )
        .unwrap();
        let (aliases, _) = metadata(&root).unwrap();
        for name in [
            "dist/tsconfig.alias.json",
            "tsconfig.extended.json",
            "config-alias/base.json",
            "config-alias/leaf.json",
        ] {
            assert!(aliases.contains(name), "{name}");
        }
        std::os::unix::fs::symlink("missing.json", root.join("tsconfig.dangling.json")).unwrap();
        assert!(
            metadata(&root)
                .unwrap_err()
                .starts_with("ELIGIBILITY_CONFIGURATION_PATH_FAILED:")
        );
        fs::remove_file(root.join("tsconfig.dangling.json")).unwrap();
        let external = root.with_extension("outside.json");
        fs::write(&external, "{}").unwrap();
        std::os::unix::fs::symlink(&external, root.join("tsconfig.external.json")).unwrap();
        assert_eq!(
            metadata(&root).unwrap_err(),
            "ELIGIBILITY_CONFIGURATION_OUTSIDE_ROOT"
        );
        fs::remove_file(external).unwrap();
    }
    fs::remove_dir_all(root).unwrap();
}
