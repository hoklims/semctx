#![cfg(unix)]

use semctx_gates::process;
use serde_json::{Value, json};
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

fn invoke(argv: Vec<String>, root: &Path, helper: &Path) -> process::Outcome {
    process::run_with_helper(&argv, root, 20_000, 8_388_608, helper).unwrap()
}

fn git(args: &[&str], root: &Path, helper: &Path) -> String {
    let mut argv = vec!["git".into()];
    argv.extend(args.iter().map(|value| value.to_string()));
    let outcome = invoke(argv, root, helper);
    assert_eq!(outcome.exit_code, Some(0), "{outcome:?}");
    outcome.stdout
}

fn quoted(path: &Path) -> String {
    format!("'{}'", path.to_string_lossy().replace('\'', "'\"'\"'"))
}

#[test]
fn public_verification_refuses_changes_after_receipt_issuance() {
    let helper =
        PathBuf::from(std::env::var_os("SEMCTX_PROCESS_HELPER").expect("native process helper"));
    let producer = env!("CARGO_BIN_EXE_semctx-r0-probe");
    let sdk = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("sdk/sdk-input.json");
    let evidence = std::env::var_os("SEMCTX_NATIVE_EVIDENCE")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
        .join(format!(
            "receipt-revalidation-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
    let root = evidence.join("workspace");
    fs::create_dir_all(root.join("src")).unwrap();
    let source = root.join("src/main.ts");
    let original = "export function chosen() { return 7; }\n";
    fs::write(&source, original).unwrap();
    git(&["init", "-q"], &root, &helper);
    git(&["add", "."], &root, &helper);
    git(
        &[
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.test",
            "commit",
            "-qm",
            "initial",
        ],
        &root,
        &helper,
    );
    let head = git(&["rev-parse", "HEAD"], &root, &helper);
    let current = "export function chosen() { return 11; }\n";
    fs::write(&source, current).unwrap();
    let probe = root.join("CaseProbe");
    fs::write(&probe, b"case").unwrap();
    let case_sensitive = !root.join("caseprobe").exists();
    fs::remove_file(probe).unwrap();
    let cwd = root.to_string_lossy();
    let request = json!({"id":"receipt-revalidation","cwd":cwd,"sdk_directory":"/sdk/lib","case_sensitive":case_sensitive,"roots":[source],"files":{(source.to_string_lossy()):current},"options":{"target":"ES2022","module":"ESNext","moduleResolution":"Bundler","allowJs":true,"jsx":"Preserve","skipLibCheck":true,"noEmit":true,"strict":false},"retained":true,"qualified":true});
    let request_path = evidence.join("request.json");
    fs::write(&request_path, serde_json::to_vec(&request).unwrap()).unwrap();
    let indexed = invoke(
        vec![
            producer.into(),
            "--batch".into(),
            request_path.to_string_lossy().into_owned(),
            sdk.to_string_lossy().into_owned(),
        ],
        &root,
        &helper,
    );
    assert_eq!(indexed.exit_code, Some(0), "{indexed:?}");
    fs::write(root.join(".git/info/exclude"), "tsconfig.json\n").unwrap();
    let outside = evidence.join("outside.ts");
    fs::write(&outside, "export function outside() { return 23; }").unwrap();
    let cases = [
        ("unchanged", ":".to_string(), None),
        ("input", format!("printf '%s' 'export function chosen() {{ return 19; }}' > {}", quoted(&source)), Some("indexed ownership rejected: IdentityMismatch")),
        ("head", "git -c user.name=Fixture -c user.email=fixture@example.test commit --allow-empty -qm advanced".to_string(), Some("qualified Git commit changed during verification")),
        ("late-head", "git -c user.name=Fixture -c user.email=fixture@example.test commit --allow-empty -qm advanced".to_string(), Some("qualified Git commit changed during verification")),
        ("tracked", "printf '%s' 'export const added = 1;' > src/added.ts\ngit add -- src/added.ts".to_string(), Some("qualified Git scope changed during verification")),
        ("configuration", "printf '%s' '{}' > tsconfig.json".to_string(), Some("qualified configuration inventory changed during verification")),
        ("missing", format!("rm -- {}", quoted(&source)), Some("")),
        ("invalid-utf8", format!("printf '\\377' > {}", quoted(&source)), Some("stream did not contain valid UTF-8")),
        ("outside-symlink", format!("rm -- {}\nln -s {} {}", quoted(&source), quoted(&outside), quoted(&source)), Some("qualified input escaped repository during verification")),
    ];
    for (label, effect, rejection) in cases {
        git(&["reset", "--hard", head.trim()], &root, &helper);
        git(&["clean", "-fdx"], &root, &helper);
        fs::write(&source, current).unwrap();
        let counter = evidence.join("command-seen");
        if counter.exists() {
            fs::remove_file(&counter).unwrap();
        }
        let wrapper = evidence.join("process-helper");
        let trigger = if label == "late-head" {
            "diff"
        } else {
            "rev-parse"
        };
        fs::write(&wrapper, format!("#!/bin/sh\nif [ \"$2\" = git ] && [ \"$3\" = {trigger} ]; then\n  if [ -f {} ]; then\n    {}\n  else\n    touch {}\n  fi\nfi\nexec {} \"$@\"\n", quoted(&counter), effect, quoted(&counter), quoted(&helper))).unwrap();
        fs::set_permissions(&wrapper, fs::Permissions::from_mode(0o755)).unwrap();
        let descriptor = json!({"repositoryRoot":root,"processHelper":wrapper,"include":["src/**/*.ts"],"exclude":["node_modules",".git"],"index":{"analysis":request,"outcome":indexed,"baseCommit":head.trim()}});
        let descriptor_path = evidence.join("verify.json");
        fs::write(&descriptor_path, serde_json::to_vec(&descriptor).unwrap()).unwrap();
        let outcome = invoke(
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
            evidence.join(format!("{label}.json")),
            serde_json::to_vec_pretty(&outcome).unwrap(),
        )
        .unwrap();
        if matches!(label, "head" | "late-head") {
            let current_head = git(&["rev-parse", "HEAD"], &root, &helper);
            assert_ne!(current_head.trim(), head.trim());
            fs::write(evidence.join(format!("{label}-commit.txt")), current_head).unwrap();
        }
        let consumed_source = fs::read(&source);
        match &consumed_source {
            Ok(bytes) => fs::write(evidence.join(format!("{label}-source.bin")), bytes).unwrap(),
            Err(error) => {
                assert_eq!(label, "missing");
                assert_eq!(error.kind(), std::io::ErrorKind::NotFound);
                fs::write(evidence.join("missing-source.txt"), "NotFound").unwrap();
            }
        }
        match label {
            "input" => assert_eq!(
                consumed_source.unwrap(),
                b"export function chosen() { return 19; }"
            ),
            "invalid-utf8" => assert_eq!(consumed_source.unwrap(), [255]),
            "outside-symlink" => assert_eq!(fs::read_link(&source).unwrap(), outside),
            "unchanged" => assert_eq!(consumed_source.unwrap(), current.as_bytes()),
            _ => {}
        }
        if let Some(rejection) = rejection {
            assert_eq!(outcome.exit_code, Some(1), "{outcome:?}");
            assert!(outcome.stdout.is_empty());
            let error: Value = serde_json::from_str(&outcome.stderr).unwrap();
            assert!(error["error"].as_str().is_some_and(|text| !text.is_empty()));
            if label != "missing" {
                assert!(outcome.stderr.contains(rejection), "{outcome:?}");
            }
        } else {
            assert_eq!(outcome.exit_code, Some(0), "{outcome:?}");
            let report: Value = serde_json::from_str(&outcome.stdout).unwrap();
            assert_eq!(report["analysisAdmission"]["status"], "admitted");
        }
    }
}
