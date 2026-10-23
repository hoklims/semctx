use super::*;

#[test]
#[cfg(unix)]
fn direct_root_links_keep_internal_sources_and_refuse_external_sources_with_relative_path() {
    let base = std::env::temp_dir().join(format!(
        "t00-confinement-root-links-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let root = base.join("repository");
    std::fs::create_dir_all(&root).unwrap();
    let outside = base.join("outside.ts");
    let inside = root.join("inside.ts");
    let source = "export const value = 1;\n";
    std::fs::write(&outside, source).unwrap();
    std::fs::write(&inside, source).unwrap();
    for (alias, target, expected) in [
        ("internal.ts", &inside, Ok(())),
        (
            "alias.ts",
            &outside,
            Err("SOURCE_LINK_OUTSIDE_REPOSITORY: alias.ts".to_string()),
        ),
    ] {
        let path = root.join(alias);
        std::os::unix::fs::symlink(target, &path).unwrap();
        let root = root.to_str().unwrap();
        let path = path.to_str().unwrap().to_string();
        let files = BTreeMap::from([(path.clone(), source.into())]);
        let observed = check(
            Rc::new(CaptureFs::new(files, true)),
            Inputs {
                root,
                sdk_root: "/sdk/lib",
                roots: &[path],
                configured_resolution: false,
                ordinary_system_resolution: false,
            },
        );
        assert_eq!(observed, expected);
    }
    std::fs::remove_dir_all(base).unwrap();
}
