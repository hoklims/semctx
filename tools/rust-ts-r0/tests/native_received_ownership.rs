use semctx_gates::process;
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

fn invoke(argv: Vec<String>, root: &Path, helper: &Path) -> process::Outcome {
    process::run_with_helper(&argv, root, 30_000, 8_388_608, helper).unwrap()
}

fn git(args: &[&str], root: &Path, helper: &Path) -> String {
    let mut argv = vec!["git".into()];
    argv.extend(args.iter().map(|value| value.to_string()));
    let outcome = invoke(argv, root, helper);
    assert_eq!(outcome.exit_code, Some(0), "{outcome:?}");
    outcome.stdout
}

#[test]
fn broad_opaque_callbacks_consume_only_received_graph_ownership() {
    let helper =
        PathBuf::from(std::env::var_os("SEMCTX_PROCESS_HELPER").expect("native process helper"));
    let producer = env!("CARGO_BIN_EXE_semctx-r0-probe");
    let sdk = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("sdk/sdk-input.json");
    let evidence = std::env::var_os("SEMCTX_NATIVE_EVIDENCE")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
        .join(format!(
            "received-ownership-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
    for (label, include_outside, opaque) in [
        ("all-received", true, true),
        ("unowned-outside", false, true),
        ("independent-outside", false, false),
    ] {
        let dir = evidence.join(label);
        let root = dir.join("workspace");
        fs::create_dir_all(root.join("src")).unwrap();
        let mut files = BTreeMap::from([
            ("src/main.ts", "export function selected() { return 7; }"),
            (
                "outside.ts",
                if opaque {
                    "import { register } from 'opaque'; function helper() { return 1; } export function outside() { return register(() => helper()); }"
                } else {
                    "export function outside() { return 1; }"
                },
            ),
            (
                "package.json",
                r#"{"name":"owned-fixture","dependencies":{"opaque":"1.0.0"}}"#,
            ),
        ]);
        for (path, text) in &files {
            fs::write(root.join(path), text).unwrap();
        }
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
        files.insert("src/main.ts", "export function selected() { return 11; }");
        fs::write(root.join("src/main.ts"), files["src/main.ts"]).unwrap();
        let probe = root.join("CaseProbe");
        fs::write(&probe, b"case").unwrap();
        let sensitive = !root.join("caseprobe").exists();
        fs::remove_file(probe).unwrap();
        let mut roots = vec![root.join("src/main.ts")];
        if include_outside {
            roots.push(root.join("outside.ts"));
        }
        let captured = files
            .iter()
            .map(|(path, text)| (root.join(path).to_string_lossy().into_owned(), *text))
            .collect::<BTreeMap<_, _>>();
        let request = json!({"id":format!("received-ownership-{label}"),"cwd":root,"sdk_directory":"/sdk/lib","case_sensitive":sensitive,"roots":roots,"files":captured,"options":{"target":"ES2022","module":"ESNext","moduleResolution":"Bundler","allowJs":true,"jsx":"Preserve","skipLibCheck":true,"noEmit":true,"strict":false},"retained":true,"qualified":true});
        let request_path = dir.join("request.json");
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
        assert_eq!(indexed.exit_code, Some(0), "{label}: {indexed:?}");
        let batch: Value = serde_json::from_str(&indexed.stdout).unwrap();
        assert_eq!(batch["terminal"], "complete", "{label}: {batch}");
        let descriptor = json!({"repositoryRoot":root,"processHelper":helper,"include":[if include_outside {"**/*.ts"} else {"src/**/*.ts"}],"exclude":[".git","node_modules"],"index":{"analysis":request,"outcome":indexed,"baseCommit":head.trim()}});
        let descriptor_path = dir.join("verify.json");
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
            dir.join("outcome.json"),
            serde_json::to_vec_pretty(&outcome).unwrap(),
        )
        .unwrap();
        assert!(outcome.stderr.is_empty(), "{label}: {outcome:?}");
        let report: Value = serde_json::from_str(&outcome.stdout).unwrap();
        if label == "unowned-outside" {
            assert_eq!(outcome.exit_code, Some(3), "{label}: {report}");
            assert_eq!(report["analysisAdmission"]["status"], "rejected");
            let received = report["broad_analysis"]["received_subjects"]
                .as_array()
                .unwrap();
            let outside = received
                .iter()
                .find(|subject| subject["path"] == "outside.ts")
                .unwrap();
            assert!(
                outside["reasons"]
                    .as_array()
                    .unwrap()
                    .contains(&json!("SOURCE_OPAQUE_CALLBACK_UNSUPPORTED")),
                "{outside}"
            );
        } else {
            assert_eq!(outcome.exit_code, Some(0), "{label}: {report}");
            assert_eq!(report["analysisAdmission"]["status"], "admitted");
        }
    }
}
