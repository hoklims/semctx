use semctx_gates::process;
use serde_json::{Value, json};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};

struct RuntimeFixture {
    directory: PathBuf,
    root: PathBuf,
    request: Value,
    request_path: PathBuf,
    helper: PathBuf,
    argv: Vec<String>,
}

fn isolated_git(root: &Path, directory: &Path) -> Command {
    let mut command = Command::new("git");
    for (name, _) in std::env::vars_os() {
        if name.to_string_lossy().starts_with("GIT_") {
            command.env_remove(name);
        }
    }
    command
        .current_dir(root)
        .env("HOME", directory.join("home"))
        .env("XDG_CONFIG_HOME", directory.join("xdg"))
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_AUTHOR_DATE", "2026-10-23T00:00:00Z")
        .env("GIT_COMMITTER_DATE", "2026-10-23T00:00:00Z");
    command
}

impl RuntimeFixture {
    fn new() -> Self {
        let crate_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let script = crate_root
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .join("scripts/t00-ts7-application-runtime.ts");
        let helper = PathBuf::from(
            std::env::var_os("SEMCTX_PROCESS_HELPER").expect("native process helper"),
        );
        let directory = std::env::var_os("SEMCTX_NATIVE_EVIDENCE")
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir)
            .join(format!(
                "application-runtime-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
        fs::create_dir_all(directory.join("workspace/src")).unwrap();
        let directory = directory.canonicalize().unwrap();
        fs::create_dir_all(directory.join("home")).unwrap();
        fs::create_dir_all(directory.join("xdg")).unwrap();
        let root = directory.join("workspace");
        let first = root.join("src/first.ts");
        let second = root.join("src/second.ts");
        let sources = [
            (&first, "export function chosenFirst() { return 7; }\n"),
            (&second, "export function chosenSecond() { return 11; }\n"),
        ];
        for (path, text) in sources {
            fs::write(path, text).unwrap();
        }
        fs::write(root.join("CaseProbe"), "case").unwrap();
        let case_sensitive = !root.join("caseprobe").exists();
        fs::remove_file(root.join("CaseProbe")).unwrap();
        for arguments in [
            vec!["init", "-q"],
            vec!["add", "--", "src"],
            vec![
                "-c",
                "user.name=Fixture",
                "-c",
                "user.email=fixture@example.test",
                "-c",
                "commit.gpgSign=false",
                "-c",
                "core.hooksPath=/dev/null",
                "commit",
                "-qm",
                "application runtime fixture",
            ],
        ] {
            let outcome = isolated_git(&root, &directory)
                .args(arguments)
                .output()
                .unwrap();
            assert!(outcome.status.success(), "{outcome:?}");
        }
        let request = json!({
            "id":"native-application-runtime","cwd":root,"sdk_directory":"/sdk/lib",
            "case_sensitive":case_sensitive,"roots":[first,second],
            "files":{(first.to_string_lossy()):sources[0].1,(second.to_string_lossy()):sources[1].1},
            "options":{"target":"ES2022","module":"ESNext","moduleResolution":"Bundler","allowJs":true,"jsx":"Preserve","skipLibCheck":true,"noEmit":true,"strict":false},
            "retained":true,"qualified":true
        });
        let request_path = directory.join("request.json");
        fs::write(&request_path, serde_json::to_vec(&request).unwrap()).unwrap();
        let argv = vec![
            "bun".into(),
            script.to_string_lossy().into_owned(),
            request_path.to_string_lossy().into_owned(),
            crate_root
                .join("sdk/sdk-input.json")
                .to_string_lossy()
                .into_owned(),
            env!("CARGO_BIN_EXE_semctx-r0-probe").into(),
            helper.to_string_lossy().into_owned(),
            "2".into(),
        ];
        Self {
            directory,
            root,
            request,
            request_path,
            helper,
            argv,
        }
    }

    fn invoke(&self, label: &str, request: &Value) -> process::Outcome {
        fs::write(&self.request_path, serde_json::to_vec(request).unwrap()).unwrap();
        let outcome =
            process::run_with_helper(&self.argv, &self.root, 20_000, 16_777_216, &self.helper)
                .unwrap();
        fs::write(
            self.directory.join(format!("{label}-outcome.json")),
            serde_json::to_vec_pretty(
                &json!({"argv":self.argv,"request":request,"outcome":outcome}),
            )
            .unwrap(),
        )
        .unwrap();
        outcome
    }
}

#[test]
fn experimental_application_service_retains_one_native_program_sidecar_and_final_receipt() {
    let fixture = RuntimeFixture::new();
    let outcome = fixture.invoke("positive", &fixture.request);
    assert_eq!(outcome.kind, "success", "{outcome:?}");
    assert_eq!(outcome.exit_code, Some(0), "{outcome:?}");
    let report: Value = serde_json::from_str(&outcome.stdout).unwrap();
    assert_eq!(report["executed"], true);
    assert_eq!(report["finalReceiptRevalidated"], true);
    assert_eq!(
        report["parallelism"],
        json!({
            "requested": 2,
            "used": 1,
            "mode": "preflight-fallback",
            "reason": "retained compiler input snapshot requires one semantic Program"
        })
    );
    assert_eq!(
        report["nativeObservation"]["native_compiler_version"],
        "7.1.0-dev"
    );
    assert_eq!(report["ownershipObservation"]["accepted"], true);
    assert_eq!(
        report["ownershipObservation"]["subjects"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    let graph = &report["analysis"]["graph"];
    let native = &report["nativeObservation"]["assembly"];
    assert_eq!(
        *graph,
        json!({"nodes":native["nodes"],"edges":native["edges"]})
    );
    let nodes = graph["nodes"].as_array().unwrap();
    for (path, name) in [
        ("src/first.ts", "chosenFirst"),
        ("src/second.ts", "chosenSecond"),
    ] {
        assert!(
            nodes
                .iter()
                .any(|node| node["kind"] == "module" && node["filePath"] == path)
        );
        assert!(nodes.iter().any(|node| node["kind"] == "function"
            && node["filePath"] == path
            && node["name"] == name));
    }
    let sidecar = &report["sidecar"];
    assert_eq!(report["discoveryLedger"], sidecar["discoveryLedger"]);
    assert_eq!(report["discoveryLedger"].as_array().unwrap().len(), 2);
    for entry in report["discoveryLedger"].as_array().unwrap() {
        assert_eq!(entry["selectionDecision"], "selected");
        assert_eq!(entry["analysisOutcome"], "analyzed");
    }
    let mut typescript_scope_seen = false;
    let mut repository_scope_seen = false;
    for collection in ["capabilityProfiles", "factBatches", "producerResults"] {
        let entries = sidecar[collection].as_array().unwrap();
        assert!(!entries.is_empty());
        for entry in entries {
            if entry["scope"]["language"] == "typescript" {
                typescript_scope_seen = true;
                assert_eq!(entry["scope"]["dialectVersion"], "7.1.0-dev");
            }
            repository_scope_seen |= entry["scope"]["language"] == "repository";
            assert_eq!(
                entry["producer"]["identity"],
                "@semantic-context/ts-analyzer/experimental-native-ts7"
            );
            assert!(
                entry["producer"]["version"]
                    .as_str()
                    .unwrap()
                    .starts_with("7.1.0-dev")
            );
        }
    }
    assert!(typescript_scope_seen);
    assert!(repository_scope_seen);
}

#[test]
fn experimental_application_service_checks_snapshot_before_native_open_and_supports_ordinary() {
    let fixture = RuntimeFixture::new();
    let first = fixture.request["roots"][0].as_str().unwrap();
    let mut failures = Vec::new();
    for variant in [
        "snapshotless-qualified",
        "missing-root",
        "changed-capture",
        "ordinary",
    ] {
        let mut request = fixture.request.clone();
        match variant {
            "snapshotless-qualified" => request["retained"] = json!(false),
            "missing-root" => {
                request["files"].as_object_mut().unwrap().remove(first);
            }
            "changed-capture" => request["files"][first] = json!("export const altered = 1;"),
            "ordinary" => {
                request["retained"] = json!(false);
                request["qualified"] = json!(false);
            }
            _ => unreachable!(),
        }
        let outcome = fixture.invoke(variant, &request);
        if variant != "ordinary" {
            let expected = if variant == "snapshotless-qualified" {
                "SOURCE_SNAPSHOT_REQUIRED: qualified analysis requires retained source and configuration inputs"
            } else {
                "SOURCE_SNAPSHOT_MISMATCH: src/first.ts"
            };
            let error = serde_json::from_str::<Value>(&outcome.stderr).unwrap_or(Value::Null);
            if outcome.kind != "nonzero"
                || outcome.exit_code != Some(1)
                || !outcome.stdout.is_empty()
                || error != json!({"error":expected})
            {
                failures.push(json!({"variant":variant,"expected":expected,"actual":outcome}));
            }
            continue;
        }
        if outcome.kind != "success" || outcome.exit_code != Some(0) {
            failures.push(
                json!({"variant":variant,"expected":"ordinary service success","actual":outcome}),
            );
            continue;
        }
        let report: Value = serde_json::from_str(&outcome.stdout).unwrap();
        assert_eq!(report["executed"], true);
        assert_eq!(report["parallelism"]["requested"], 2);
        assert_eq!(report["parallelism"]["used"], 2);
        assert_eq!(report["parallelism"]["mode"], "parallel");
        assert_eq!(
            report["nativeObservation"]["native_compiler_version"],
            "7.1.0-dev"
        );
        assert_eq!(report["finalReceiptRevalidated"], false);
        assert!(report.get("ownershipObservation").is_none());
        assert!(
            report["analysis"]["graph"]["nodes"]
                .as_array()
                .unwrap()
                .iter()
                .any(|node| node["name"] == "chosenFirst")
        );
        let profiles = report["sidecar"]["capabilityProfiles"].as_array().unwrap();
        assert!(
            profiles
                .iter()
                .any(|profile| profile["scope"]["language"] == "typescript")
        );
        for profile in profiles {
            if profile["scope"]["language"] == "typescript" {
                assert_eq!(profile["scope"]["dialectVersion"], "7.1.0-dev");
            }
            assert_eq!(
                profile["producer"]["identity"],
                "@semantic-context/ts-analyzer/experimental-native-ts7"
            );
        }
    }
    assert!(
        failures.is_empty(),
        "service snapshot/ordinary failures: {}",
        json!(failures)
    );
}

#[test]
fn experimental_application_preserves_literal_test_assembly_diagnostic_when_receipt_refuses() {
    let fixture = RuntimeFixture::new();
    let mut request = fixture.request.clone();
    let original = request["roots"][0].as_str().unwrap().to_string();
    let first = fixture.root.join("src/first.test.ts");
    let renamed = isolated_git(&fixture.root, &fixture.directory)
        .args(["mv", "--"])
        .arg(&original)
        .arg(&first)
        .output()
        .unwrap();
    assert!(renamed.status.success(), "{renamed:?}");
    let source = "export async function spec() { return import('./second'); }\n";
    fs::write(&first, source).unwrap();
    request["roots"][0] = json!(first);
    request["files"].as_object_mut().unwrap().remove(&original);
    request["files"][first.to_string_lossy().as_ref()] = json!(source);
    request["roles"] = json!({"src/first.test.ts":"test"});
    let outcome = fixture.invoke("literal-test-refusal", &request);
    assert_eq!(outcome.kind, "nonzero", "{outcome:?}");
    assert_eq!(outcome.exit_code, Some(1), "{outcome:?}");
    assert!(outcome.stdout.is_empty());
    let refusal: Value = serde_json::from_str(&outcome.stderr).unwrap();
    assert!(
        refusal["error"]
            .as_str()
            .unwrap()
            .contains("RefusalHasNoOwnership"),
        "{refusal}"
    );
    assert_eq!(refusal["finalReceiptRevalidated"], false);
    assert!(refusal.get("ownershipObservation").is_none());
    let diagnostic = &refusal["diagnosticAssembly"];
    assert_eq!(diagnostic["stage"], "application-composition-refused");
    let expected = json!({"src/first.test.ts":["QUALIFIED_TEST_DYNAMIC_IMPORT_BINDING_UNPROVEN:src/second.ts"]});
    assert_eq!(diagnostic["integrityReasons"], expected);
    let graph = &diagnostic["analysis"]["graph"];
    assert!(
        graph["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|node| { node["kind"] == "test" && node["filePath"] == "src/first.test.ts" })
    );
    let native = &diagnostic["nativeObservation"]["assembly"];
    assert_eq!(
        *graph,
        json!({"nodes":native["nodes"],"edges":native["edges"]})
    );
    let ledger = diagnostic["sidecar"]["discoveryLedger"].as_array().unwrap();
    let first = ledger
        .iter()
        .find(|entry| {
            entry["scope"]["language"] == "typescript"
                && entry["scope"]["selectedPaths"] == json!(["src/first.test.ts"])
        })
        .unwrap();
    assert_eq!(first["selectionDecision"], "selected");
    assert_eq!(first["analysisOutcome"], "analyzed");
    assert_eq!(first["analysisReasons"], expected["src/first.test.ts"]);
    let profiles = diagnostic["sidecar"]["capabilityProfiles"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|profile| profile["scope"]["selectedPaths"] == json!(["src/first.test.ts"]))
        .collect::<Vec<_>>();
    assert!(!profiles.is_empty());
    for profile in profiles {
        assert_eq!(profile["label"], "partial");
        assert_eq!(profile["completenessClaim"], "partial");
        assert_eq!(profile["negativeEvidenceEligible"], false);
    }
}
