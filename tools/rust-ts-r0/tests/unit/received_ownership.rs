use super::*;
use std::process::Command;

fn fixture_git(root: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .output()
        .unwrap();
    assert!(output.status.success(), "public fixture Git setup failed");
    String::from_utf8(output.stdout).unwrap()
}

fn outcome(batch: &wire::Batch) -> process::Outcome {
    let stdout = serde_json::to_string(batch).unwrap();
    process::Outcome {
        kind: "success".into(),
        exit_code: Some(0),
        duration_ms: 0,
        stdout_bytes: stdout.len() as u64,
        stdout_hash: identity::digest_bytes(stdout.as_bytes())
            .trim_start_matches("sha256:")
            .into(),
        stdout,
        stderr: String::new(),
        stderr_bytes: 0,
        stderr_hash: identity::digest_bytes(b"")
            .trim_start_matches("sha256:")
            .into(),
    }
}

#[test]
fn broad_opaque_callbacks_require_received_ownership() {
    let helper =
        PathBuf::from(std::env::var_os("SEMCTX_PROCESS_HELPER").expect("explicit process helper"));
    let evidence = std::env::var_os("SEMCTX_RECEIVER_TEST_EVIDENCE")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
        .join("semctx-received-ownership")
        .join(format!(
            "{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
    // Minimal public unit fixture; the production SDK descriptor stays unchanged.
    let sdk = Sdk {
        version: "5.9.3".into(),
        archive_sha256: "10e108c9cf7d5f2879053dff18515fb405abf2ccef63eaaf017d9c571687a1d3".into(),
        files: BTreeMap::from([("/sdk/lib/lib.d.ts".into(), "interface Array<T> { length: number; } interface Boolean {} interface Function {} interface IArguments {} interface Number {} interface Object {} interface RegExp {} interface String {}".into())]),
    };
    for (label, include_outside, opaque) in [
        ("unowned-outside", false, true),
        ("all-received", true, true),
        ("independent-outside", false, false),
    ] {
        let root = evidence.join(label);
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
        fixture_git(&root, &["init", "-q"]);
        fixture_git(&root, &["add", "."]);
        fixture_git(
            &root,
            &[
                "-c",
                "user.name=Fixture",
                "-c",
                "user.email=fixture@example.test",
                "commit",
                "-qm",
                "initial",
            ],
        );
        let head = fixture_git(&root, &["rev-parse", "HEAD"]);
        files.insert("src/main.ts", "export function selected() { return 11; }");
        fs::write(root.join("src/main.ts"), files["src/main.ts"]).unwrap();
        let root = root.canonicalize().unwrap();
        let cwd = root.to_string_lossy().replace('\\', "/");
        let mut roots = vec![format!("{cwd}/src/main.ts")];
        if include_outside {
            roots.push(format!("{cwd}/outside.ts"));
        }
        let captured = files
            .iter()
            .map(|(path, text)| (format!("{cwd}/{path}"), *text))
            .collect::<BTreeMap<_, _>>();
        let request: Request = serde_json::from_value(json!({"id":format!("received-ownership-{label}"),"cwd":cwd,"sdk_directory":"/sdk/lib","case_sensitive":ts_goport::frontend::vfs::osvfs_fs().use_case_sensitive_file_names(),"roots":roots,"files":captured,"options":{"target":"ES2022","module":"ESNext","moduleResolution":"Bundler","allowJs":true,"jsx":"Preserve","skipLibCheck":true,"noEmit":true,"strict":false},"retained":true,"qualified":true})).unwrap();
        let observed = analyze(request.clone(), sdk.clone()).unwrap();
        let batch = batch::build(&request, &sdk, &observed).unwrap();
        assert!(batch.complete, "public index fixture incomplete");
        let indexed = outcome(&batch);
        let descriptor = json!({"repositoryRoot":root,"processHelper":helper,"include":[if include_outside {"**/*.ts"} else {"src/**/*.ts"}],"exclude":[".git","node_modules"],"index":{"analysis":request,"outcome":indexed,"baseCommit":head.trim()}});
        let result = verify(descriptor, sdk.clone()).unwrap();
        fs::write(
            root.join("../").join(format!("{label}-report.json")),
            serde_json::to_vec_pretty(&result.report).unwrap(),
        )
        .unwrap();
        assert_eq!(
            result.exit_code(),
            if label == "unowned-outside" { 3 } else { 0 },
            "public ownership admission: {label}"
        );
        if label == "unowned-outside" {
            let received = result.report["broad_analysis"]["received_subjects"]
                .as_array()
                .unwrap();
            let outside = received.iter().find(|s| s["path"] == "outside.ts").unwrap();
            assert!(
                outside["reasons"]
                    .as_array()
                    .unwrap()
                    .contains(&json!("SOURCE_OPAQUE_CALLBACK_UNSUPPORTED"))
            );
        }
    }
}
