use super::*;

struct NativeDirectory(std::path::PathBuf);
impl NativeDirectory {
    fn new() -> Self {
        use std::sync::atomic::{AtomicU64, Ordering};
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "semctx-source-identity-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&path).unwrap();
        Self(path.canonicalize().unwrap())
    }
}
impl Drop for NativeDirectory {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).unwrap();
    }
}

#[test]
fn native_canonical_control_and_missing_file_fallback_match_pinned_os_fs() {
    let directory = NativeDirectory::new();
    let root = directory.0.clone();
    let real = root.join("real.ts");
    std::fs::write(&real, "export {};\n").unwrap();
    let alias = root.join("alias.ts");
    std::os::unix::fs::symlink(&real, &alias).unwrap();
    let identity = SourceIdentity::new(true, true);
    for path in [alias, root.join("missing.ts")] {
        let path = path.to_str().unwrap();
        assert_eq!(
            identity.key(path),
            ts_goport::frontend::vfs::osvfs::os_fs_realpath(path)
        );
    }
}

#[test]
fn native_failures_are_consumed_by_direct_and_worker_source_owners() {
    let directory = NativeDirectory::new();
    let root = directory.0.to_string_lossy().into_owned();
    let path = format!("{root}/entry.ts");
    let source = "export function entry() { return 7; }\n";
    std::fs::write(&path, source).unwrap();
    let sdk: Sdk = serde_json::from_str(include_str!("../../sdk/sdk-input.json")).unwrap();
    let direct = serde_json::json!({"id":"source-identity-direct","cwd":root,"sdk_directory":"/sdk/lib","case_sensitive":ts_goport::frontend::vfs::osvfs_fs().use_case_sensitive_file_names(),"roots":[path],"files":{path.clone():source},"options":{"target":"ES2022","module":"ESNext","moduleResolution":"Bundler","allowJs":true,"jsx":"Preserve","skipLibCheck":true,"noEmit":true,"strict":false},"retained":false});
    let worker = serde_json::json!({"schemaVersion":1,"jobId":"source-identity-worker","repoRoot":root,"rootAbsPaths":[path],"emitAbsPaths":[path]});
    let expected_key = if ts_goport::frontend::vfs::osvfs_fs().use_case_sensitive_file_names() {
        path.clone()
    } else {
        path.to_lowercase()
    };
    for stage in ["native_realpath", "absolute"] {
        for (kind, request) in [("direct", &direct), ("worker", &worker)] {
            let observed = run(
                serde_json::json!({"kind":kind,"request":request,"failures":{path.clone():stage}}),
                &sdk,
            );
            assert_eq!(
                observed["sourceIdentityObservation"]["enabled"], true,
                "{observed}"
            );
            assert!(
                observed["sourceIdentityObservation"]["trace"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|row| row["path"] == path
                        && row["failedStage"] == stage
                        && row["key"] == expected_key
                        && row["injected"] == true),
                "{kind}: {stage}: {observed}"
            );
            let modules = if kind == "direct" {
                &observed["raw_extraction"]["modules"]
            } else {
                &observed["extraction"]["modules"]
            };
            assert_eq!(modules, &serde_json::json!(["entry.ts"]));
        }
    }
}

fn alias_files(directory: &NativeDirectory) -> (String, String, BTreeMap<String, String>) {
    let target = directory.0.join("target.ts").to_string_lossy().into_owned();
    let alias = directory.0.join("alias.ts").to_string_lossy().into_owned();
    let source = "export function target() { return 7; }\n";
    std::fs::write(&target, source).unwrap();
    std::os::unix::fs::symlink(&target, &alias).unwrap();
    (
        alias.clone(),
        target.clone(),
        BTreeMap::from([(alias, source.into()), (target, source.into())]),
    )
}

fn analysis_request(root: &str, roots: &[String], files: &BTreeMap<String, String>) -> Request {
    serde_json::from_value(serde_json::json!({"id":"canonical-selection","cwd":root,"sdk_directory":"/sdk/lib","case_sensitive":ts_goport::frontend::vfs::osvfs_fs().use_case_sensitive_file_names(),"roots":roots,"files":files,"options":{"target":"ES2022","module":"ESNext","moduleResolution":"Bundler","allowJs":true,"jsx":"Preserve","skipLibCheck":true,"noEmit":true,"strict":false},"retained":false})).unwrap()
}

#[test]
fn canonical_alias_and_target_coalesce_in_the_native_partition_without_colliding_with_a_distinct_source()
 {
    let directory = NativeDirectory::new();
    let (alias, target, mut files) = alias_files(&directory);
    let distinct = directory
        .0
        .join("distinct.ts")
        .to_string_lossy()
        .into_owned();
    std::fs::write(&distinct, "export {};\n").unwrap();
    files.insert(distinct.clone(), "export {};\n".into());
    let roots = vec![alias, target, distinct];
    let root = directory.0.to_str().unwrap();
    let sensitive = ts_goport::frontend::vfs::osvfs_fs().use_case_sensitive_file_names();
    let fs = Rc::new(CaptureFs::new(files, sensitive));
    let mut options = compiler_options();
    options.no_lib = Tristate::True;
    let frontend =
        native_frontend_with_options(fs.clone(), root, "/sdk/lib", roots.clone(), false, options);
    let _current = native_program::NativeProgram::enter(&frontend.program);
    program::bind_all();
    let observed = partition_observations::observe(&frontend.program, &fs, root, &roots);
    assert_eq!(observed["executed"], true, "{observed}");
    assert_eq!(
        observed["loadedRepositorySources"],
        serde_json::json!(["distinct.ts", "target.ts"])
    );
    assert_eq!(
        observed["selectedRoots"],
        serde_json::json!(["distinct.ts", "target.ts"])
    );
    assert_eq!(
        observed["dependencyComponents"],
        serde_json::json!([["distinct.ts"], ["target.ts"]])
    );
}

#[test]
fn excluded_or_disabled_alias_does_not_consume_an_admissible_canonical_source() {
    let directory = NativeDirectory::new();
    let (alias, target, files) = alias_files(&directory);
    let sdk: Sdk = serde_json::from_str(include_str!("../../sdk/sdk-input.json")).unwrap();
    for disabled in [false, true] {
        let mut request = analysis_request(
            directory.0.to_str().unwrap(),
            &[alias.clone(), target.clone()],
            &files,
        );
        if disabled {
            request.disabled.insert("alias.ts".into());
        } else {
            request
                .selection
                .insert("alias.ts".into(), wire::Selection::Excluded);
        }
        let observed = analyze(request, sdk.clone()).unwrap();
        assert_eq!(
            observed["raw_extraction"]["modules"],
            serde_json::json!(["target.ts"]),
            "{observed}"
        );
    }
}

#[test]
fn non_emitted_alias_does_not_consume_the_requested_worker_target() {
    let directory = NativeDirectory::new();
    let (alias, target, _) = alias_files(&directory);
    let sdk: Sdk = serde_json::from_str(include_str!("../../sdk/sdk-input.json")).unwrap();
    let observed = worker_observations::run(
        serde_json::json!({"schemaVersion":1,"jobId":"canonical-emit","repoRoot":directory.0,"rootAbsPaths":[alias,target],"emitAbsPaths":[target]}),
        &sdk,
    );
    assert_eq!(observed["ok"], true, "{observed}");
    assert_eq!(
        observed["extraction"]["modules"],
        serde_json::json!(["target.ts"])
    );
}
