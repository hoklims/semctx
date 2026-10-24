#![cfg(unix)]

use semctx_gates::process;
use serde_json::{Value, json};
use std::{
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

fn invoke(argv: Vec<String>, root: &Path, helper: &Path) -> process::Outcome {
    process::run_with_helper(&argv, root, 20_000, 8_388_608, helper).unwrap()
}

fn git(args: &[&str], root: &Path, helper: &Path) -> String {
    let mut argv = vec!["git".into()];
    argv.extend(args.iter().map(|arg| arg.to_string()));
    let outcome = invoke(argv, root, helper);
    assert_eq!(outcome.exit_code, Some(0), "{}", outcome.stderr);
    outcome.stdout
}

fn quoted(path: &Path) -> String {
    format!("'{}'", path.to_string_lossy().replace('\'', "'\"'\"'"))
}

fn verification_helper(label: &str, dir: &Path, root: &Path, helper: &Path) -> PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let effect = match label {
        "malformed-statistics" => format!(
            "if [ \"$2\" = git ] && [ \"$4\" = diff ] && [ \"$5\" = --numstat ]; then exec {} \"$1\" printf '%s' 'invalid'; fi",
            quoted(helper)
        ),
        "malformed-base-batch" => format!(
            "if [ \"$3\" = --batch ]; then exec {} \"$1\" printf '%s' '{{}}'; fi",
            quoted(helper)
        ),
        "mutated-base" => format!(
            "if [ \"$3\" = --batch ]; then {} \"$@\"; result=$?; printf '%s' 'export const selectedValue = 19;' > src/selected.ts; exit \"$result\"; fi",
            quoted(helper)
        ),
        "current-during-base" => format!(
            "if [ \"$3\" = --batch ]; then {} \"$@\"; result=$?; printf '%s' 'export const selectedValue = 19;' > {}; exit \"$result\"; fi",
            quoted(helper),
            quoted(&root.join("src/selected.ts"))
        ),
        _ => return helper.to_path_buf(),
    };
    let wrapper = dir.join("process-helper");
    fs::write(
        &wrapper,
        format!("#!/bin/sh\n{effect}\nexec {} \"$@\"\n", quoted(helper)),
    )
    .unwrap();
    fs::set_permissions(&wrapper, fs::Permissions::from_mode(0o755)).unwrap();
    wrapper
}

#[test]
fn malformed_output_helpers_require_supervisor_acknowledgement() {
    let helper = PathBuf::from(std::env::var_os("SEMCTX_PROCESS_HELPER").unwrap());
    let root = std::env::temp_dir().join(format!(
        "malformed-helper-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    for (label, argv, expected) in [
        (
            "malformed-statistics",
            vec!["git", "--no-replace-objects", "diff", "--numstat"],
            "invalid",
        ),
        ("malformed-base-batch", vec!["producer", "--batch"], "{}"),
    ] {
        let dir = root.join(label);
        fs::create_dir_all(&dir).unwrap();
        let wrapper = verification_helper(label, &dir, &root, &helper);
        let without_ack = std::process::Command::new(&wrapper)
            .arg("__exec")
            .args(&argv)
            .stdin(std::process::Stdio::null())
            .output()
            .unwrap();
        assert!(without_ack.stdout.is_empty(), "{label}: {without_ack:?}");
        assert!(!without_ack.status.success(), "{label}: {without_ack:?}");
        assert!(
            String::from_utf8_lossy(&without_ack.stderr)
                .contains("read supervisor acknowledgement"),
            "{label}: {without_ack:?}"
        );
        let acknowledged = invoke(
            argv.into_iter().map(String::from).collect(),
            &root,
            &wrapper,
        );
        assert_eq!(acknowledged.exit_code, Some(0), "{label}: {acknowledged:?}");
        assert_eq!(acknowledged.stdout, expected, "{label}");
        assert!(acknowledged.stderr.is_empty(), "{label}: {acknowledged:?}");
    }
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn public_verification_consumes_immutable_old_scope_before_admission() {
    let helper = PathBuf::from(std::env::var_os("SEMCTX_PROCESS_HELPER").unwrap());
    let producer = env!("CARGO_BIN_EXE_semctx-r0-probe");
    let sdk = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("sdk/sdk-input.json");
    let evidence = std::env::var_os("SEMCTX_NATIVE_EVIDENCE")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
        .join(format!(
            "base-scope-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
    for (label, old, current, expected_exit) in [
        (
            "old-excluded-dependency",
            "export { outsideValue as selectedValue } from '../outside';\n",
            "export const selectedValue = 11;\n",
            3,
        ),
        (
            "old-independent",
            "export const selectedValue = 7;\n",
            "export const selectedValue = 11;\n",
            0,
        ),
        (
            "old-unsupported",
            "export async function selectedValue(path: string) { return import(path); }\n",
            "export const selectedValue = 11;\n",
            3,
        ),
        (
            "replaced-base",
            "export async function selectedValue(path: string) { return import(path); }\n",
            "export const selectedValue = 11;\n",
            3,
        ),
        (
            "renamed-base-excluded",
            "export const selectedValue = 7;\n",
            "export const selectedValue = 7;\n",
            3,
        ),
        (
            "renamed-base-covered",
            "export const selectedValue = 7;\n",
            "export const selectedValue = 7;\n",
            0,
        ),
        (
            "pure-addition",
            "export const selectedValue = 7;\n",
            "export const selectedValue = 7;\nexport const addedValue = 11;\n",
            0,
        ),
        (
            "malformed-statistics",
            "export const selectedValue = 7;\n",
            "export const selectedValue = 11;\n",
            3,
        ),
        (
            "malformed-base-batch",
            "export const selectedValue = 7;\n",
            "export const selectedValue = 11;\n",
            3,
        ),
        (
            "mutated-base",
            "export const selectedValue = 7;\n",
            "export const selectedValue = 11;\n",
            3,
        ),
        (
            "current-during-base",
            "export const selectedValue = 7;\n",
            "export const selectedValue = 11;\n",
            1,
        ),
        (
            "old-symlink",
            "export const selectedValue = 7;\n",
            "export const selectedValue = 11;\n",
            3,
        ),
    ] {
        let dir = evidence.join(label);
        let root = dir.join("workspace");
        fs::create_dir_all(root.join("src")).unwrap();
        let source = root.join("src/selected.ts");
        let outside = root.join("outside.ts");
        let outside_text = "export const outsideValue = 3;\n";
        let old_path = match label {
            "renamed-base-excluded" => "old.ts",
            "renamed-base-covered" => "src/old.ts",
            _ => "src/selected.ts",
        };
        let stable = root.join("src/stable.ts");
        let stable_text = "export const stableValue = 5;\n";
        if old_path != "src/selected.ts" {
            fs::write(&stable, stable_text).unwrap();
        }
        fs::write(root.join(old_path), old).unwrap();
        fs::write(&outside, outside_text).unwrap();
        if label == "old-symlink" {
            fs::remove_file(&source).unwrap();
            std::os::unix::fs::symlink("../outside.ts", &source).unwrap();
        }
        git(&["init", "-q"], &root, &helper);
        git(&["config", "diff.renames", "true"], &root, &helper);
        git(&["add", "."], &root, &helper);
        git(
            &[
                "-c",
                "user.name=Fixture",
                "-c",
                "user.email=fixture@example.test",
                "commit",
                "-qm",
                "immutable base",
            ],
            &root,
            &helper,
        );
        let head = git(&["rev-parse", "HEAD"], &root, &helper);
        if label == "old-symlink" {
            fs::remove_file(&source).unwrap();
        }
        if label == "replaced-base" {
            fs::write(&source, "").unwrap();
            git(&["add", "."], &root, &helper);
            git(
                &[
                    "-c",
                    "user.name=Fixture",
                    "-c",
                    "user.email=fixture@example.test",
                    "commit",
                    "-qm",
                    "replacement base",
                ],
                &root,
                &helper,
            );
            let replacement = git(&["rev-parse", "HEAD"], &root, &helper);
            git(&["reset", "--hard", head.trim()], &root, &helper);
            git(
                &["replace", head.trim(), replacement.trim()],
                &root,
                &helper,
            );
        }
        if old_path != "src/selected.ts" {
            git(&["mv", old_path, "src/selected.ts"], &root, &helper);
        }
        fs::write(&source, current).unwrap();
        fs::write(root.join("CaseProbe"), "case").unwrap();
        let sensitive = !root.join("caseprobe").exists();
        fs::remove_file(root.join("CaseProbe")).unwrap();
        let mut request = json!({"id":label,"cwd":root,"sdk_directory":"/sdk/lib","case_sensitive":sensitive,"roots":[source],"files":{(source.to_string_lossy()):current,(outside.to_string_lossy()):outside_text},"options":{"target":"ES2022","module":"ESNext","moduleResolution":"Bundler","allowJs":true,"jsx":"Preserve","skipLibCheck":true,"noEmit":true,"strict":false},"retained":true,"qualified":true});
        if old_path != "src/selected.ts" {
            request["files"][stable.to_str().unwrap()] = json!(stable_text);
            request["roots"].as_array_mut().unwrap().push(json!(stable));
        }
        let request_path = dir.join("request.json");
        fs::write(&request_path, serde_json::to_vec(&request).unwrap()).unwrap();
        let index = invoke(
            vec![
                producer.into(),
                "--batch".into(),
                request_path.to_string_lossy().into_owned(),
                sdk.to_string_lossy().into_owned(),
            ],
            &root,
            &helper,
        );
        assert_eq!(index.exit_code, Some(0), "{}", index.stderr);
        let verifier_helper = verification_helper(label, &dir, &root, &helper);
        let descriptor = json!({"repositoryRoot":root,"processHelper":verifier_helper,"include":["src/**/*.ts"],"exclude":["node_modules",".git"],"index":{"analysis":request,"outcome":index,"baseCommit":head.trim()}});
        let descriptor_path = dir.join("verify.json");
        fs::write(&descriptor_path, serde_json::to_vec(&descriptor).unwrap()).unwrap();
        let result = invoke(
            vec![
                producer.into(),
                "verify".into(),
                "working-tree".into(),
                descriptor_path.to_string_lossy().into_owned(),
                sdk.to_string_lossy().into_owned(),
                "--fail-on".into(),
                "none".into(),
            ],
            &root,
            &helper,
        );
        fs::write(
            dir.join("outcome.json"),
            serde_json::to_vec_pretty(&result).unwrap(),
        )
        .unwrap();
        assert_eq!(
            result.exit_code,
            Some(expected_exit),
            "{label}: {}",
            result.stderr
        );
        if expected_exit == 1 {
            assert!(result.stdout.is_empty());
            assert!(
                result
                    .stderr
                    .contains("qualified input changed during verification")
            );
            assert_eq!(
                fs::read_to_string(&source).unwrap(),
                "export const selectedValue = 19;"
            );
            continue;
        }
        let report: Value = serde_json::from_str(&result.stdout).unwrap();
        if expected_exit == 3 {
            assert_eq!(report["analysisAdmission"]["status"], "rejected");
            assert_eq!(report["verdict"], "BLOCK");
            assert!(
                report["analysisAdmission"]["reasons"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|r| r.as_str().is_some_and(
                        |s| s.starts_with("QUALIFIED_WORKING_TREE_BASE_CAPTURE_UNSUPPORTED:")
                    )),
                "{label}: {}",
                report["analysisAdmission"]
            );
            if label == "mutated-base" {
                assert!(
                    report["base_capture"]["reason"]
                        .as_str()
                        .unwrap()
                        .contains("immutable base capture changed during analysis")
                );
            }
            if label == "malformed-statistics" {
                assert!(
                    report["base_capture"]["reason"]
                        .as_str()
                        .unwrap()
                        .contains("invalid immutable base diff statistics")
                );
            }
            if label == "renamed-base-excluded" {
                assert!(
                    report["base_capture"]["reason"]
                        .as_str()
                        .unwrap()
                        .contains("old.ts")
                );
            }
            if label == "old-excluded-dependency" {
                assert!(
                    report["base_capture"]["reason"]
                        .as_str()
                        .unwrap()
                        .contains("outside.ts")
                );
            }
        } else {
            assert_eq!(report["analysisAdmission"]["status"], "admitted");
            assert_eq!(report["verdict"], "NOT_ASSERTED");
            if label == "renamed-base-covered" {
                assert!(
                    report["base_capture"]["expected"]
                        .as_array()
                        .unwrap()
                        .contains(&json!("src/old.ts"))
                );
            }
            assert_eq!(
                report["base_capture"]["status"],
                if label == "pure-addition" {
                    "not_required"
                } else {
                    "analyzed"
                }
            );
        }
        assert_eq!(fs::read_to_string(&source).unwrap(), current);
        assert_eq!(git(&["rev-parse", "HEAD"], &root, &helper), head);
    }
}
