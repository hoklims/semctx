#[path = "../src/qualified_verification/base_capture.rs"]
mod base_capture;

use semctx_gates::process;
use std::{
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

fn git(root: &Path, helper: &Path, args: &[&str]) -> String {
    let mut argv = vec!["git".to_string()];
    argv.extend(args.iter().map(|arg| arg.to_string()));
    let outcome = process::run_with_helper(&argv, root, 5_000, 8_388_608, helper).unwrap();
    assert_eq!(outcome.kind, "success", "{outcome:?}");
    assert_eq!(outcome.exit_code, Some(0), "{outcome:?}");
    outcome.stdout
}

fn fixture() -> (PathBuf, PathBuf, String) {
    let helper = PathBuf::from(std::env::var_os("SEMCTX_PROCESS_HELPER").unwrap());
    let root = std::env::var_os("SEMCTX_NATIVE_EVIDENCE")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
        .join(format!(
            "base-capture-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
    fs::create_dir_all(root.join("dist")).unwrap();
    fs::create_dir_all(root.join(".semctx")).unwrap();
    fs::write(root.join(".gitignore"), "dist/\n").unwrap();
    fs::write(root.join("dist/main.ts"), "export const before = 7;\r\n").unwrap();
    fs::write(root.join("asset.bin"), [0, 255, 128, 10]).unwrap();
    fs::write(root.join(".semctx/config.json"), "{\"old\":true}\n").unwrap();
    git(&root, &helper, &["init", "-q"]);
    git(&root, &helper, &["config", "core.autocrlf", "false"]);
    git(&root, &helper, &["add", "-f", "."]);
    git(
        &root,
        &helper,
        &[
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.test",
            "commit",
            "-qm",
            "base",
        ],
    );
    let head = git(&root, &helper, &["rev-parse", "HEAD"])
        .trim()
        .to_string();
    (root, helper, head)
}

#[test]
fn immutable_base_preserves_raw_bytes_ignored_tracking_and_current_policy() {
    let (root, helper, head) = fixture();
    fs::write(root.join("dist/main.ts"), "export const after = 9;\n").unwrap();
    let policy = b"{\"current\":true}\r\n";
    let capture = base_capture::capture(&root, &head, &helper, Some(policy)).unwrap();
    let scratch = capture.root().to_path_buf();
    assert_ne!(scratch, root);
    assert_eq!(
        fs::read(scratch.join("dist/main.ts")).unwrap(),
        b"export const before = 7;\r\n"
    );
    assert_eq!(
        fs::read(scratch.join("asset.bin")).unwrap(),
        [0, 255, 128, 10]
    );
    assert_eq!(
        fs::read(scratch.join(".semctx/config.json")).unwrap(),
        policy
    );
    assert!(capture.inventory().contains("dist/main.ts"));
    assert_eq!(
        capture.raw_files()[scratch.join("asset.bin").to_str().unwrap()],
        [0, 255, 128, 10]
    );
    assert!(
        git(&scratch, &helper, &["ls-files", "--cached"])
            .lines()
            .any(|path| path == "dist/main.ts")
    );
    capture.revalidate().unwrap();
    drop(capture);
    assert!(!scratch.exists());
    assert_eq!(
        fs::read(root.join("dist/main.ts")).unwrap(),
        b"export const after = 9;\n"
    );
}

#[test]
fn immutable_base_revalidation_refuses_new_empty_workspace_roots() {
    let (root, helper, head) = fixture();
    let capture = base_capture::capture(&root, &head, &helper, None).unwrap();
    fs::create_dir(capture.root().join("new-workspace")).unwrap();
    assert!(capture.revalidate().is_err());
}

#[test]
fn immutable_base_revalidation_refuses_materialized_input_and_authority_changes() {
    let (root, helper, head) = fixture();
    for mutation in [
        "content", "deletion", "addition", "policy", "index", "config",
    ] {
        let capture = base_capture::capture(&root, &head, &helper, None).unwrap();
        assert!(!capture.root().join(".semctx/config.json").exists());
        capture.revalidate().unwrap();
        match mutation {
            "content" => fs::write(capture.root().join("asset.bin"), [0, 254, 128, 10]).unwrap(),
            "deletion" => fs::remove_file(capture.root().join("dist/main.ts")).unwrap(),
            "addition" => fs::write(capture.root().join("new.ts"), "export {};").unwrap(),
            "policy" => fs::write(capture.root().join(".semctx/config.json"), "{}").unwrap(),
            "index" => fs::write(capture.root().join(".git/index"), []).unwrap(),
            "config" => fs::write(capture.root().join(".git/config"), []).unwrap(),
            _ => unreachable!(),
        }
        assert!(capture.revalidate().is_err(), "{mutation}");
    }
}

#[cfg(unix)]
#[test]
fn immutable_base_refuses_committed_links_and_revalidation_symlink_escape() {
    let (root, helper, head) = fixture();
    let capture = base_capture::capture(&root, &head, &helper, None).unwrap();
    let target = capture.root().join("asset.bin");
    fs::remove_file(&target).unwrap();
    std::os::unix::fs::symlink(root.join("asset.bin"), &target).unwrap();
    assert!(capture.revalidate().is_err());
    std::os::unix::fs::symlink("dist/main.ts", root.join("link.ts")).unwrap();
    git(&root, &helper, &["add", "link.ts"]);
    git(
        &root,
        &helper,
        &[
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.test",
            "commit",
            "-qm",
            "link",
        ],
    );
    let linked = git(&root, &helper, &["rev-parse", "HEAD"]);
    assert!(base_capture::capture(&root, linked.trim(), &helper, None).is_err());
}

#[cfg(unix)]
fn wrapper(root: &Path, helper: &Path, intervention: &str) -> PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let path = root.join("capture-helper");
    let escaped = helper.to_string_lossy().replace('\'', "'\"'\"'");
    fs::write(&path, format!("#!/bin/sh\nfor arg in \"$@\"; do\n  if [ \"$arg\" = cat-file ]; then\n    {intervention}\n    exit $?\n  fi\ndone\nexec '{escaped}' \"$@\"\n")).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
    path
}

#[cfg(unix)]
#[test]
fn immutable_base_refuses_corrupted_blob_bytes_despite_matching_batch_header() {
    let (root, helper, head) = fixture();
    let escaped = helper.to_string_lossy().replace('\'', "'\"'\"'");
    let changed = wrapper(
        &root,
        &helper,
        &format!(
            "'{escaped}' \"$@\" | LC_ALL=C sed 's/export const before = 7/export const before = 8/'"
        ),
    );
    let error = base_capture::capture(&root, &head, &changed, None)
        .err()
        .unwrap();
    assert!(
        error.contains("do not match Git object identities"),
        "{error}"
    );
}

#[cfg(unix)]
#[test]
fn immutable_base_refuses_truncated_blobs_timeout_and_unbounded_error_output() {
    let (root, helper, head) = fixture();
    for (intervention, expected) in [
        ("cat > /dev/null; printf broken", "blob header absent"),
        ("cat > /dev/null; sleep 20", "timed out"),
        (
            "cat > /dev/null; head -c 65537 /dev/zero >&2",
            "exceeds capture limit",
        ),
        (
            "cat > /dev/null; head -c 67108865 /dev/zero",
            "exceeds capture limit",
        ),
    ] {
        let changed = wrapper(&root, &helper, intervention);
        let error = base_capture::capture(&root, &head, &changed, None)
            .err()
            .unwrap();
        assert!(error.contains(expected), "{expected}: {error}");
    }
}

#[test]
fn immutable_base_refuses_unsafe_paths_gitlinks_and_unresolved_revisions() {
    let (root, helper, head) = fixture();
    assert!(base_capture::capture(&root, "HEAD", &helper, None).is_err());
    fs::write(root.join("unsafe:name.ts"), "export {};").unwrap();
    git(&root, &helper, &["add", "unsafe:name.ts"]);
    git(
        &root,
        &helper,
        &[
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.test",
            "commit",
            "-qm",
            "unsafe",
        ],
    );
    let unsafe_head = git(&root, &helper, &["rev-parse", "HEAD"]);
    assert!(base_capture::capture(&root, unsafe_head.trim(), &helper, None).is_err());
    git(&root, &helper, &["reset", "--hard", &head]);
    let gitlink = format!("160000,{head},submodule");
    git(
        &root,
        &helper,
        &["update-index", "--add", "--cacheinfo", &gitlink],
    );
    git(
        &root,
        &helper,
        &[
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.test",
            "commit",
            "-qm",
            "gitlink",
        ],
    );
    let linked_head = git(&root, &helper, &["rev-parse", "HEAD"]);
    assert!(base_capture::capture(&root, linked_head.trim(), &helper, None).is_err());
}

#[cfg(unix)]
#[test]
fn immutable_base_refuses_workspace_mutation_after_object_verification() {
    use std::os::unix::fs::PermissionsExt;
    let (root, helper, head) = fixture();
    let escaped_helper = helper.to_string_lossy().replace('\'', "'\"'\"'");
    let marker = root.join("update-index-mutation.txt");
    let escaped_marker = marker.to_string_lossy().replace('\'', "'\"'\"'");
    for (label, intervention) in [
        ("unchanged", ":"),
        (
            "content",
            "printf '%s' 'export const injected = 23;' > dist/main.ts",
        ),
        ("deletion", "rm -- dist/main.ts"),
        ("addition", "printf '%s' 'export {};' > injected.ts"),
        ("directory", "mkdir injected-workspace"),
    ] {
        let wrapper = root.join("after-update-index-helper");
        fs::write(&wrapper, format!("#!/bin/sh\nfor arg in \"$@\"; do\n  if [ \"$arg\" = update-index ]; then\n    '{escaped_helper}' \"$@\" || exit $?\n    {intervention}\n    printf '%s' '{label}' > '{escaped_marker}'\n    exit 0\n  fi\ndone\nexec '{escaped_helper}' \"$@\"\n")).unwrap();
        fs::set_permissions(&wrapper, fs::Permissions::from_mode(0o755)).unwrap();
        let captured = base_capture::capture(&root, &head, &wrapper, Some(b"{\"current\":true}"));
        assert_eq!(fs::read_to_string(&marker).unwrap(), label);
        if label == "unchanged" {
            let captured = captured.unwrap();
            assert_eq!(
                fs::read(captured.root().join("dist/main.ts")).unwrap(),
                b"export const before = 7;\r\n"
            );
            captured.revalidate().unwrap();
        } else {
            assert_eq!(
                captured.err().unwrap(),
                "immutable base materialization differs from captured Git blobs",
                "{label}"
            );
        }
    }
}
