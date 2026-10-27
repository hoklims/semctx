use semctx_gates::process;
use serde_json::{Value, json};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};

const WARNING: &str = "Projet TypeScript 5 analysé avec ts_goport 7.1.0-dev ; compatibilité TS5 non garantie et admission qualifiée indisponible";

struct Fixture {
    directory: PathBuf,
    request: Value,
    sdk: Value,
}

impl Fixture {
    fn new(label: &str) -> Self {
        let directory = std::env::temp_dir().join(format!(
            "semctx-ts5-{label}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&directory).unwrap();
        let sdk = synthetic_sdk(
            "5.9.3",
            "10e108c9cf7d5f2879053dff18515fb405abf2ccef63eaaf017d9c571687a1d3",
        );
        Self {
            directory,
            request: json!({
                "id":"development-ts5-degraded", "cwd":"/workspace",
                "sdk_directory":"/sdk/lib", "case_sensitive":ts_goport::frontend::vfs::osvfs_fs().use_case_sensitive_file_names(),
                "roots":["/workspace/main.ts"],
                "files":{"/workspace/main.ts":"export function selectedFactory() { return 179; }\n"},
                "options":{"target":"ES2022","module":"ESNext","moduleResolution":"Bundler","skipLibCheck":true,"noEmit":true,"allowJs":true,"jsx":"Preserve","strict":false},
                "retained":true,"qualified":false
            }),
            sdk,
        }
    }

    fn explicit_sdk(&mut self) {
        self.sdk["files"]["/sdk/package.json"] =
            json!(json!({"name":"typescript","version":self.sdk["version"]}).to_string());
    }

    fn write_inputs(&self) -> (PathBuf, PathBuf) {
        let request = self.directory.join("request.json");
        let sdk = self.directory.join("sdk.json");
        fs::write(&request, serde_json::to_vec(&self.request).unwrap()).unwrap();
        fs::write(&sdk, serde_json::to_vec(&self.sdk).unwrap()).unwrap();
        (request, sdk)
    }

    fn analyze(&self, batch: bool) -> std::process::Output {
        let (request, sdk) = self.write_inputs();
        let mut command = Command::new(env!("CARGO_BIN_EXE_semctx-r0-probe"));
        if batch {
            command.arg("--batch");
        }
        command.args([request, sdk]).output().unwrap()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.directory).unwrap();
    }
}

fn synthetic_sdk(version: &str, archive: &str) -> Value {
    json!({
        "version":version,
        "archive_sha256":archive,
        "files":{
            "/sdk/lib/lib.d.ts":"interface Array<T> { length: number; [n: number]: T; } interface Boolean {} interface CallableFunction {} interface Function {} interface IArguments {} interface NewableFunction {} interface Number {} interface Object {} interface RegExp {} interface String {}"
        }
    })
}

fn assert_warning(stderr: &[u8]) {
    let text = std::str::from_utf8(stderr).unwrap();
    let messages = text
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(
        messages,
        vec![json!({"code":"TS5_DEGRADED_ANALYSIS","severity":"warning","message":WARNING})],
        "{text}"
    );
}

#[test]
fn explicit_ts5_sdk_warns_and_preserves_ordinary_and_batch_analysis() {
    let mut fixture = Fixture::new("explicit");
    fixture.explicit_sdk();
    for batch in [false, true] {
        fixture.request["qualified"] = json!(batch);
        let output = fixture.analyze(batch);
        assert!(output.status.success(), "{output:?}");
        assert_warning(&output.stderr);
        let report: Value = serde_json::from_slice(&output.stdout).unwrap();
        if batch {
            assert_eq!(report["terminal"], "complete", "{report}");
            assert!(!report["facts"].as_array().unwrap().is_empty(), "{report}");
            assert_negative_evidence_eligibility(&report, false);
        } else {
            assert_eq!(report["subjects"][0]["outcome"], "analyzed", "{report}");
            let identity = &report["subjects"][0]["capabilityScope"]["sdkIdentity"];
            assert_eq!(identity["inventoryValidated"], false, "{identity}");
            assert_eq!(identity["archiveSha256"], fixture.sdk["archive_sha256"]);
            assert!(identity.get("sourceRevision").is_none());
            assert!(identity.get("libraryManifestSha256").is_none());
        }
    }
}

#[test]
fn explicit_ts5_sdk_still_reports_source_diagnostics() {
    let mut fixture = Fixture::new("syntax-diagnostic");
    fixture.explicit_sdk();
    fixture.request["files"]["/workspace/main.ts"] = json!("export const value = ;\n");
    let output = fixture.analyze(false);
    assert!(output.status.success(), "{output:?}");
    assert_warning(&output.stderr);
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert!(
        !report["subjects"][0]["parseDiagnostics"]
            .as_array()
            .unwrap()
            .is_empty(),
        "{report}"
    );
}

#[test]
fn noncanonical_ts5_requires_explicit_package_identity() {
    let mut fixture = Fixture::new("explicit-noncanonical-ts5");
    fixture.sdk = synthetic_sdk(
        "5.4.5",
        "0000000000000000000000000000000000000000000000000000000000000000",
    );
    fixture.explicit_sdk();
    let output = fixture.analyze(false);
    assert!(output.status.success(), "{output:?}");
    assert_warning(&output.stderr);
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["subjects"][0]["outcome"], "analyzed", "{report}");
    fixture.sdk["files"]
        .as_object_mut()
        .unwrap()
        .remove("/sdk/package.json");
    let output = fixture.analyze(false);
    assert_eq!(output.status.code(), Some(1), "{output:?}");
    assert!(output.stdout.is_empty());
    let stderr: Value = serde_json::from_slice(&output.stderr).unwrap();
    assert_eq!(stderr["error"], "SDK_IDENTITY_UNRECOGNIZED");
}

#[test]
fn declared_legacy_ts5_sdk_warns_without_source_version_heuristics() {
    let mut fixture = Fixture::new("legacy");
    fixture.request["files"]["/workspace/main.ts"] =
        json!("export function selectedFactory() { return 'TypeScript 7'; }\n");
    for uppercase in [false, true] {
        if uppercase {
            fixture.sdk["archive_sha256"] = json!(
                fixture.sdk["archive_sha256"]
                    .as_str()
                    .unwrap()
                    .to_ascii_uppercase()
            );
        }
        let output = fixture.analyze(false);
        assert!(output.status.success(), "{output:?}");
        assert_warning(&output.stderr);
        let report: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(report["subjects"][0]["outcome"], "analyzed");
    }
}

#[test]
fn inconsistent_or_unrecognized_sdk_identity_refuses_without_fallback() {
    for (label, version, package, error) in [
        ("unknown", "unknown", None, "SDK_IDENTITY_UNRECOGNIZED"),
        (
            "ts7-with-uppercase-ts5-archive",
            "7.1.0-dev",
            Some(json!({"name":"typescript","version":"7.1.0-dev"})),
            "SDK_IDENTITY_INCONSISTENT",
        ),
        (
            "ts7-with-ts5-archive",
            "7.1.0-dev",
            Some(json!({"name":"typescript","version":"7.1.0-dev"})),
            "SDK_IDENTITY_INCONSISTENT",
        ),
        (
            "contradictory",
            "5.9.3",
            Some(json!({"name":"typescript","version":"7.1.0-dev"})),
            "SDK_IDENTITY_INCONSISTENT",
        ),
        (
            "malformed-metadata",
            "5.9.3",
            Some(json!({"name":"typescript","version":"5.9.3"})),
            "SDK_IDENTITY_UNRECOGNIZED",
        ),
        (
            "duplicate-metadata",
            "5.9.3",
            Some(json!({"name":"typescript","version":"5.9.3"})),
            "SDK_IDENTITY_UNRECOGNIZED",
        ),
        (
            "wrong-location",
            "5.9.3",
            Some(json!({"name":"typescript","version":"5.9.3"})),
            "SDK_IDENTITY_UNRECOGNIZED",
        ),
        (
            "foreign-package",
            "5.9.3",
            Some(json!({"name":"foreign-compiler","version":"5.9.3"})),
            "SDK_IDENTITY_UNRECOGNIZED",
        ),
    ] {
        let mut fixture = Fixture::new(label);
        fixture.sdk["version"] = json!(version);
        if label == "unknown" {
            fixture.sdk["archive_sha256"] =
                json!("0000000000000000000000000000000000000000000000000000000000000000");
        }
        if let Some(package) = package {
            fixture.sdk["files"]["/sdk/package.json"] = json!(package.to_string());
        }
        match label {
            "ts7-with-uppercase-ts5-archive" => {
                fixture.sdk["archive_sha256"] = json!(
                    fixture.sdk["archive_sha256"]
                        .as_str()
                        .unwrap()
                        .to_ascii_uppercase()
                );
            }
            "malformed-metadata" => fixture.sdk["files"]["/sdk/package.json"] = json!("{"),
            "duplicate-metadata" => {
                fixture.sdk["files"]["/other/package.json"] =
                    fixture.sdk["files"]["/sdk/package.json"].clone();
            }
            "wrong-location" => {
                let package = fixture.sdk["files"]
                    .as_object_mut()
                    .unwrap()
                    .remove("/sdk/package.json")
                    .unwrap();
                fixture.sdk["files"]["/sdk/wrong/package.json"] = package;
            }
            _ => {}
        }
        for batch in [false, true] {
            fixture.request["qualified"] = json!(batch);
            let output = fixture.analyze(batch);
            assert_eq!(output.status.code(), Some(1), "{label}: {output:?}");
            assert!(output.stdout.is_empty(), "{label}: {output:?}");
            let stderr: Value = serde_json::from_slice(&output.stderr).unwrap();
            assert!(
                stderr["error"].as_str().unwrap().starts_with(error),
                "{label}: {stderr}"
            );
        }
    }
}

#[test]
fn malformed_or_unsupported_sdk_identity_refuses_before_warning() {
    for (label, version, archive) in [
        ("short-digest", "5.9.3", "00"),
        (
            "nonhex-digest",
            "5.9.3",
            "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz",
        ),
        (
            "unsupported-major",
            "6.0.0",
            "0000000000000000000000000000000000000000000000000000000000000000",
        ),
        (
            "malformed-version",
            "5.invalid.3",
            "0000000000000000000000000000000000000000000000000000000000000000",
        ),
        (
            "prerelease-version",
            "5.9.3-beta",
            "0000000000000000000000000000000000000000000000000000000000000000",
        ),
    ] {
        let mut fixture = Fixture::new(label);
        fixture.sdk = synthetic_sdk(version, archive);
        fixture.explicit_sdk();
        for batch in [false, true] {
            fixture.request["qualified"] = json!(batch);
            let output = fixture.analyze(batch);
            assert_eq!(output.status.code(), Some(1), "{label}: {output:?}");
            assert!(output.stdout.is_empty(), "{label}: {output:?}");
            let error: Value = serde_json::from_slice(&output.stderr).unwrap();
            assert_eq!(
                error,
                json!({"error":"SDK_IDENTITY_UNRECOGNIZED"}),
                "{label}"
            );
        }
    }
}

#[test]
fn explicit_ts5_sdk_rejects_qualified_working_tree_even_with_fail_on_none() {
    let mut fixture = Fixture::new("qualified-ts5");
    fixture.explicit_sdk();
    assert_qualified_admission(fixture, false);
}

#[test]
fn explicit_ts7_sdk_preserves_admission_without_ts5_warning() {
    let mut fixture = Fixture::new("qualified-ts7");
    fixture.sdk = serde_json::from_slice(
        &fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join("sdk/sdk-input.json")).unwrap(),
    )
    .unwrap();
    fixture.request["files"]["/workspace/main.ts"] =
        json!("export function selectedFactory() { return 'TypeScript 5'; }\n");
    for batch in [false, true] {
        fixture.request["qualified"] = json!(batch);
        let output = fixture.analyze(batch);
        assert!(output.status.success(), "{output:?}");
        assert!(output.stderr.is_empty(), "{output:?}");
        if batch {
            let report: Value = serde_json::from_slice(&output.stdout).unwrap();
            assert_negative_evidence_eligibility(&report, true);
        }
    }
    assert_qualified_admission(fixture, true);
}

#[test]
fn native_and_ts5_identity_metadata_cannot_be_combined() {
    let native: Value = serde_json::from_slice(
        &fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join("sdk/sdk-input.json")).unwrap(),
    )
    .unwrap();
    for native_version in [false, true] {
        let mut fixture = Fixture::new("mixed-sdk-identity");
        if native_version {
            let archive = fixture.sdk["archive_sha256"].clone();
            fixture.sdk = native.clone();
            fixture.sdk["archive_sha256"] = archive;
        } else {
            fixture.sdk["source_revision"] = native["source_revision"].clone();
            fixture.sdk["library_manifest_sha256"] = native["library_manifest_sha256"].clone();
        }
        let output = fixture.analyze(false);
        assert_eq!(output.status.code(), Some(1), "{output:?}");
        assert!(output.stdout.is_empty());
        let error: Value = serde_json::from_slice(&output.stderr).unwrap();
        assert_eq!(error["error"], "SDK_IDENTITY_INCONSISTENT");
    }
}

#[test]
fn ts5_warning_precedes_analysis_failure() {
    let mut fixture = Fixture::new("warning-order");
    fixture.explicit_sdk();
    fixture.request["options"]["target"] = json!("invalid-target");
    let output = fixture.analyze(false);
    assert_eq!(output.status.code(), Some(1), "{output:?}");
    assert!(output.stdout.is_empty());
    let stderr = std::str::from_utf8(&output.stderr).unwrap();
    let messages = stderr.lines().collect::<Vec<_>>();
    assert_eq!(messages.len(), 2, "{stderr}");
    assert_warning(messages[0].as_bytes());
    let error: Value = serde_json::from_str(messages[1]).unwrap();
    assert!(error["error"].is_string(), "{error}");
}

fn assert_negative_evidence_eligibility(report: &Value, eligible: bool) {
    let coverage = report["subjects"][0]["coverage"].as_array().unwrap();
    assert!(!coverage.is_empty(), "{report}");
    assert!(
        coverage
            .iter()
            .all(|item| item["negative_evidence_eligible"] == eligible),
        "{report}"
    );
}

fn assert_qualified_admission(mut fixture: Fixture, admitted: bool) {
    fixture.request["qualified"] = json!(true);
    let root = fixture.directory.join("workspace");
    fs::create_dir_all(&root).unwrap();
    let root = fs::canonicalize(root).unwrap();
    let cwd = root.to_string_lossy().replace('\\', "/");
    let source = "export function selectedFactory() { return 179; }\n";
    fs::write(root.join("main.ts"), source).unwrap();
    fs::write(root.join(".gitignore"), ".semctx/\n").unwrap();
    fs::write(
        root.join("tsconfig.json"),
        "{\"compilerOptions\":{\"module\":\"ESNext\",\"moduleResolution\":\"Bundler\"}}",
    )
    .unwrap();
    for args in [
        vec!["init", "-q"],
        vec!["add", "."],
        vec![
            "-c",
            "user.name=NativeFixture",
            "-c",
            "user.email=native@example.test",
            "commit",
            "-qm",
            "initial",
        ],
    ] {
        let output = Command::new("git")
            .args(args)
            .current_dir(&root)
            .output()
            .unwrap();
        assert!(output.status.success(), "{output:?}");
    }
    let head = Command::new("git")
        .args(["rev-parse", "HEAD"])
        .current_dir(&root)
        .output()
        .unwrap();
    assert!(head.status.success());
    let changed = "export function selectedFactory() { return 191; }\n";
    fs::write(root.join("main.ts"), changed).unwrap();
    fixture.request["cwd"] = json!(cwd);
    fixture.request["roots"] = json!([format!("{cwd}/main.ts")]);
    fixture.request["files"] = json!({
        format!("{cwd}/main.ts"):changed,
        format!("{cwd}/.gitignore"):".semctx/\n",
        format!("{cwd}/tsconfig.json"):fs::read_to_string(root.join("tsconfig.json")).unwrap()
    });
    fs::write(root.join("CaseProbe"), "case").unwrap();
    fixture.request["case_sensitive"] = json!(!root.join("caseprobe").exists());
    fs::remove_file(root.join("CaseProbe")).unwrap();
    let helper =
        PathBuf::from(std::env::var_os("SEMCTX_PROCESS_HELPER").expect("native process helper"));
    let producer = env!("CARGO_BIN_EXE_semctx-r0-probe");
    let (request, sdk) = fixture.write_inputs();
    let index = process::run_with_helper(
        &[
            producer.into(),
            "--batch".into(),
            request.to_string_lossy().into_owned(),
            sdk.to_string_lossy().into_owned(),
        ],
        &root,
        20_000,
        8_388_608,
        &helper,
    )
    .unwrap();
    assert_eq!(index.exit_code, Some(0), "{index:?}");
    let descriptor = json!({
        "repositoryRoot":cwd,"processHelper":helper,"include":["**/*.ts"],
        "exclude":["node_modules","dist",".semctx",".git","coverage"],
        "index":{"analysis":fixture.request,"outcome":index,"baseCommit":String::from_utf8(head.stdout).unwrap().trim()}
    });
    let descriptor_path = fixture.directory.join("verify.json");
    fs::write(&descriptor_path, serde_json::to_vec(&descriptor).unwrap()).unwrap();
    let output = Command::new(producer)
        .args(["verify", "working-tree"])
        .args([descriptor_path, sdk])
        .args(["--fail-on", "none"])
        .output()
        .unwrap();
    assert_eq!(
        output.status.code(),
        Some(if admitted { 0 } else { 3 }),
        "{output:?}"
    );
    if admitted {
        assert!(output.stderr.is_empty(), "{output:?}");
    } else {
        assert_warning(&output.stderr);
    }
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        report["analysisAdmission"]["status"],
        if admitted { "admitted" } else { "rejected" }
    );
    if admitted {
        assert_eq!(
            report["analysisAdmission"]["reasons"],
            json!([]),
            "{report}"
        );
    } else {
        assert_eq!(report["verdict"], "BLOCK");
        assert!(
            report["analysisAdmission"]["reasons"]
                .as_array()
                .unwrap()
                .contains(&json!("TS5_DEGRADED_ANALYSIS")),
            "{report}"
        );
    }
    assert_eq!(
        report["selected_analysis"]["subjects"][0]["outcome"], "analyzed",
        "{report}"
    );
}
