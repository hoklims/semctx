use super::*;

#[test]
fn live_windows_and_unc_keys_recover_only_the_known_sandbox_prefix() {
    for root in ["C:/repo", "//server/share/repo"] {
        let live = LiveBoundary {
            root: root.into(),
            repository_root: Some(root.into()),
            workspace_root: RefCell::default(),
            inputs: Rc::default(),
            acquisition: BTreeMap::new(),
            errors: RefCell::default(),
        };
        let key = CaptureFs::new(BTreeMap::new(), true).key(&format!("{root}/member/value.ts"));
        assert_eq!(live.lexical(&key), format!("{root}/member/value.ts"));
        assert!(live.within(&live.lexical(&key)));
        assert!(!live.within(&format!("{root}-outside/value.ts")));
        assert!(!live.within(&live.lexical(&format!("{key}/../../../../outside"))));
        assert_eq!(live.lexical("C:"), "C:");
        assert_eq!(live.lexical("C:relative"), "C:relative");
    }
}

#[test]
fn live_native_paths_preserve_reads_and_refuse_outside_and_nested_repositories() {
    let root = std::env::temp_dir().join(format!("semctx-live-paths-{}", std::process::id()));
    std::fs::create_dir_all(root.join("repo/nested")).unwrap();
    std::fs::write(root.join("outside.json"), "outside").unwrap();
    std::fs::write(root.join("repo/nested/value.json"), "initial").unwrap();
    let root = root.canonicalize().unwrap();
    let repository = root.join("repo");
    let input = repository.join("nested/value.json");
    let root_text = format!("{}/", repository.to_string_lossy());
    let input_text = input.to_string_lossy().into_owned();
    let outside = root.join("outside.json").to_string_lossy().into_owned();
    assert!(build(&root_text, std::slice::from_ref(&outside), None).is_err());
    assert!(build_with_repository_root(&root_text, &[], None, Some(&outside)).is_err());
    assert!(build_with_repository_root(&root_text, &[], None, Some("relative")).is_err());
    assert!(build_with_repository_root(&root_text, &[], None, Some("C:")).is_err());
    let fs = build(&root_text, std::slice::from_ref(&input_text), None).unwrap();
    std::fs::write(&input, "changed").unwrap();
    assert_eq!(fs.read_file(&input_text), ("changed".into(), true));
    let compiler_input = native_paths::compiler_path(&input_text);
    assert_eq!(fs.read_file(&compiler_input), ("changed".into(), true));
    assert_eq!(fs.read_file(&outside), (String::new(), false));
    assert_eq!(fs.read_file("C:"), (String::new(), false));
    let changed_case = compiler_input.to_uppercase();
    assert_eq!(fs.read_file(&changed_case), (String::new(), false));
    std::fs::write(repository.join("nested/.git"), "gitdir: outside").unwrap();
    assert_eq!(fs.read_file(&compiler_input), (String::new(), false));
    assert!(!fs.file_exists(&compiler_input));
    std::fs::remove_dir_all(root).unwrap();
}
