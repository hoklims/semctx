use semctx_gates::process;
use semctx_r0_probe::identity;
use serde_json::{Value, json};
use std::{
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

fn invoke(argv: Vec<String>, root: &Path, helper: &Path, evidence: &Path) -> process::Outcome {
    let outcome = process::run_with_helper(&argv, root, 20_000, 8_388_608, helper).unwrap();
    fs::write(
        evidence,
        serde_json::to_vec_pretty(&json!({"argv":argv,"outcome":outcome})).unwrap(),
    )
    .unwrap();
    outcome
}

fn assert_refusal_tampering_rejected(
    descriptor: &Value,
    indexed_stdout: &str,
    argv: &[String],
    root: &Path,
    helper: &Path,
    dir: &Path,
) {
    for variant in [
        "reason",
        "terminal",
        "facts",
        "identity",
        "incomplete",
        "transport",
        "truncated",
    ] {
        let mut changed = descriptor.clone();
        let mut batch: Value = serde_json::from_str(indexed_stdout).unwrap();
        match variant {
            "reason" => {
                batch["diagnostics"][0]["code"] = json!("FORGED_REASON");
                batch["diagnostics"][0]["message"] = json!("FORGED_REASON");
                batch["diagnostics"][0]["code_utf16"] = Value::Null;
                batch["diagnostics"][0]["message_utf16"] = Value::Null;
            }
            "terminal" => batch["terminal"] = json!("complete"),
            "facts" => {
                batch["facts"].as_array_mut().unwrap().remove(0);
            }
            "identity" => batch["request_id"] = json!("foreign-request"),
            "incomplete" => batch["complete"] = json!(false),
            _ => {}
        }
        let stdout = serde_json::to_string(&batch).unwrap();
        changed["index"]["outcome"]["stdout_bytes"] = json!(stdout.len());
        changed["index"]["outcome"]["stdout_hash"] =
            json!(identity::digest_bytes(stdout.as_bytes()).trim_start_matches("sha256:"));
        changed["index"]["outcome"]["stdout"] = json!(stdout);
        if variant == "transport" {
            changed["index"]["outcome"]["exit_code"] = json!(1);
        }
        if variant == "truncated" {
            changed["index"]["outcome"]["stdout_bytes"] = json!(1);
        }
        let path = dir.join(format!("refused-{variant}-descriptor.json"));
        fs::write(&path, serde_json::to_vec_pretty(&changed).unwrap()).unwrap();
        let mut bad_argv = argv.to_vec();
        bad_argv[3] = path.to_string_lossy().into_owned();
        let failed = invoke(
            bad_argv,
            root,
            helper,
            &dir.join(format!("refused-{variant}-invocation.json")),
        );
        assert_eq!(failed.exit_code, Some(3), "{variant}: {failed:?}");
        let report: Value = serde_json::from_str(&failed.stdout).unwrap();
        assert_eq!(report["analysisAdmission"]["status"], "rejected");
        assert_eq!(report["verdict"], "BLOCK");
        assert_eq!(report["indexed_extraction_received"], false);
        assert!(
            report["analysisAdmission"]["changeCoverage"]["files"]
                .as_array()
                .unwrap()
                .iter()
                .all(|file| file["status"] != "analyzed")
        );
    }
}

#[test]
fn native_qualified_verification_consumes_closure_and_rejection_before_fail_on_none() {
    verify_contexts(&[]);
}

#[test]
fn native_qualified_parse_failure_returns_structured_rejection_without_receipt() {
    verify_contexts(&["parse-failure"]);
}

#[test]
fn native_qualified_rejection_preserves_excluded_subject_diagnostics() {
    verify_contexts(&["excluded-test-role"]);
}

#[test]
fn native_qualified_references_distinguish_absent_and_retained_inputs() {
    verify_contexts(&["unretained-reference", "retained-reference"]);
}

fn verify_contexts(only: &[&str]) {
    let crate_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let helper =
        PathBuf::from(std::env::var_os("SEMCTX_PROCESS_HELPER").expect("native process helper"));
    let producer = PathBuf::from(env!("CARGO_BIN_EXE_semctx-r0-probe"));
    let sdk = crate_root.join("sdk/sdk-input.json");
    let evidence = std::env::var_os("SEMCTX_NATIVE_EVIDENCE")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
        .join(format!(
            "qualified-consumer-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
    fs::create_dir_all(&evidence).unwrap();
    let contexts = vec![
        ("inherited-positive", None, false),
        ("parse-failure", None, true),
        ("unretained-reference", None, true),
        ("retained-reference", None, true),
        ("literal-test", None, true),
        ("static-test", None, false),
        ("excluded-test-role", None, true),
        ("missing-test-role", None, false),
        ("forged-source-role", None, false),
        ("forged-test-role", None, false),
        ("extra-role-key", None, false),
        ("external-dependencies", None, false),
        ("external-devDependencies", None, false),
        ("external-peerDependencies", None, false),
        ("external-optionalDependencies", None, false),
        ("external-builtin", None, false),
        ("undeclared-external-control", None, true),
        (
            "excluded-dependent",
            Some("export { selectedFactory } from './src/selected';\n"),
            true,
        ),
        (
            "excluded-independent",
            Some("export const outsideValue = 181;\n"),
            false,
        ),
        (
            "output-dependent",
            Some("export { selectedFactory } from '../src/selected';\n"),
            true,
        ),
        (
            "output-independent",
            Some("export const outputValue = 181;\n"),
            false,
        ),
        ("omitted-nearest-config", None, false),
        ("included-nearest-config", None, false),
        ("omitted-ignored-nearest-config", None, false),
        ("included-ignored-nearest-config", None, false),
        ("omitted-uppercase-nearest-config", None, false),
        ("included-uppercase-nearest-config", None, false),
    ];
    #[cfg(unix)]
    let contexts = {
        let mut contexts = contexts;
        contexts.extend([
            ("inherited-positive-aliased-root", None, false),
            ("omitted-symlink-nearest-config", None, false),
            ("included-symlink-nearest-config", None, false),
        ]);
        contexts
    };
    for (label, outside, rejected) in contexts {
        if (only.is_empty()
            && matches!(
                label,
                "parse-failure"
                    | "excluded-test-role"
                    | "unretained-reference"
                    | "retained-reference"
            ))
            || (!only.is_empty() && !only.contains(&label))
        {
            continue;
        }
        let dir = evidence.join(label);
        let root = dir.join("workspace");
        fs::create_dir_all(root.join("src")).unwrap();
        let mut files = json!({"src/selected.ts":"export function selectedFactory() { return 179; }\n","base.json":"{\"compilerOptions\":{\"module\":\"ESNext\",\"moduleResolution\":\"Bundler\"}}","tsconfig.json":"{\"extends\":\"./base.json\"}",".gitignore":".semctx/\n"});
        if label == "retained-reference" {
            files["reference.ts"] = json!("export const reference = 1;\n");
        }
        if matches!(
            label,
            "literal-test" | "static-test" | "missing-test-role" | "forged-source-role"
        ) {
            files["src/main.test.ts"] = json!(if label == "static-test" {
                "import { selectedFactory } from './selected'; export function check() { return selectedFactory(); }\n"
            } else {
                "export async function check() { return import('./selected'); }\n"
            });
        }
        if label == "excluded-test-role" {
            files["outside.test.ts"] =
                json!("export async function check() { return import('./src/selected'); }\n");
        }
        if label == "static-test" {
            files["test_helper.py"] = json!("def test_value(): return 1\n");
        }
        let outside_path = if label == "excluded-test-role" {
            "outside.test.ts"
        } else if label.starts_with("output-") {
            fs::create_dir_all(root.join("dist")).unwrap();
            "dist/outside.ts"
        } else {
            "outside.ts"
        };
        if let Some(outside) = outside {
            files[outside_path] = json!(outside);
        }
        if label.contains("symlink-nearest-config") {
            files["config-target.json"] = json!(
                "{\"compilerOptions\":{\"module\":\"NodeNext\",\"moduleResolution\":\"NodeNext\"}}"
            );
        }
        let config_path = if label.contains("uppercase-nearest-config") {
            "src/TSCONFIG.JSON"
        } else {
            "src/tsconfig.json"
        };
        if label.contains("ignored-nearest-config")
            || label.contains("symlink-nearest-config")
            || label.contains("uppercase-nearest-config")
        {
            files[".gitignore"] = json!(format!(".semctx/\n{config_path}\n"));
        }
        if label.starts_with("included-") {
            files[config_path] = json!(
                "{\"compilerOptions\":{\"module\":\"NodeNext\",\"moduleResolution\":\"NodeNext\"}}"
            );
        }
        if let Some(field) = label
            .strip_prefix("external-")
            .filter(|field| *field != "builtin")
        {
            files["package.json"] =
                json!(json!({"name":"qualified-fixture",(field):{"optional":"1.0.0"}}).to_string());
        }
        for (path, text) in files.as_object().unwrap() {
            fs::write(root.join(path), text.as_str().unwrap()).unwrap();
        }
        if label.starts_with("omitted-") {
            fs::write(
                root.join(config_path),
                "{\"compilerOptions\":{\"module\":\"NodeNext\",\"moduleResolution\":\"NodeNext\"}}",
            )
            .unwrap();
        }
        #[cfg(unix)]
        if label.contains("symlink-nearest-config") {
            fs::remove_file(root.join("src/tsconfig.json")).unwrap();
            std::os::unix::fs::symlink("../config-target.json", root.join("src/tsconfig.json"))
                .unwrap();
        }
        for (index, args) in [
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
        ]
        .into_iter()
        .enumerate()
        {
            let mut argv = vec!["git".into()];
            argv.extend(args.into_iter().map(str::to_string));
            assert_eq!(
                invoke(argv, &root, &helper, &dir.join(format!("git-{index}.json"))).kind,
                "success"
            );
        }
        files["src/selected.ts"] = json!("export function selectedFactory() { return 191; }\n");
        if label.ends_with("-reference") {
            files["src/selected.ts"] = json!(
                "/// <reference path=\"../reference.ts\" />\nexport function selectedFactory() { return 191; }\n"
            );
        }
        if label == "parse-failure" {
            files["src/selected.ts"] = json!("export function selectedFactory( {\n");
        }
        if label.starts_with("external-") || label == "undeclared-external-control" {
            let specifier = if label == "external-builtin" {
                "node:path"
            } else {
                "optional"
            };
            files["src/selected.ts"] = json!(format!(
                "import {{ value }} from '{specifier}'; export function selectedFactory() {{ return value(); }}\n"
            ));
        }
        fs::write(
            root.join("src/selected.ts"),
            files["src/selected.ts"].as_str().unwrap(),
        )
        .unwrap();
        fs::write(root.join("QualifiedCaseProbe"), b"case").unwrap();
        let sensitive = !root.join("qualifiedcaseprobe").exists();
        fs::remove_file(root.join("QualifiedCaseProbe")).unwrap();
        let request_root = dir.join("workspace-alias");
        #[cfg(unix)]
        if label == "inherited-positive-aliased-root" {
            std::os::unix::fs::symlink(&root, &request_root).unwrap();
        }
        let request_root = if label == "inherited-positive-aliased-root" {
            &request_root
        } else {
            &root
        };
        let cwd = std::path::absolute(request_root)
            .unwrap()
            .to_string_lossy()
            .replace('\\', "/");
        let captured = files
            .as_object()
            .unwrap()
            .iter()
            .map(|(p, t)| (format!("{cwd}/{p}"), t.clone()))
            .collect::<serde_json::Map<_, _>>();
        let mut request = json!({"id":format!("development-qualified-{label}"),"cwd":cwd,"sdk_directory":"/sdk/lib","case_sensitive":sensitive,"files":captured,"roots":[format!("{cwd}/src/selected.ts")],"options":{"target":"ES2022","module":"ESNext","moduleResolution":"Bundler","allowJs":true,"jsx":"Preserve","skipLibCheck":true,"noEmit":true,"strict":false},"retained":true,"qualified":true,"roles":{},"selection":{},"disabled":[],"utf16_files":{},"raw_files":{}});
        if files.get("src/main.test.ts").is_some() {
            request["roots"]
                .as_array_mut()
                .unwrap()
                .push(json!(format!("{cwd}/src/main.test.ts")));
            if label != "missing-test-role" {
                request["roles"]["src/main.test.ts"] = json!(if label == "forged-source-role" {
                    "source"
                } else {
                    "test"
                });
            }
        }
        if label == "forged-test-role" {
            request["roles"]["src/selected.ts"] = json!("test");
        }
        if label == "extra-role-key" {
            request["roles"]["src/absent.ts"] = json!("test");
        }
        let request_path = dir.join("index-request.json");
        fs::write(&request_path, serde_json::to_vec_pretty(&request).unwrap()).unwrap();
        let index = invoke(
            vec![
                producer.to_string_lossy().into_owned(),
                "--batch".into(),
                request_path.to_string_lossy().into_owned(),
                sdk.to_string_lossy().into_owned(),
            ],
            &root,
            &helper,
            &dir.join("index-invocation.json"),
        );
        if label == "extra-role-key" {
            assert_ne!(index.exit_code, Some(0));
            assert!(index.stdout.is_empty());
            continue;
        }
        assert_eq!(index.kind, "success", "{index:?}");
        let head = invoke(
            vec![
                "git".into(),
                "rev-parse".into(),
                "--verify".into(),
                "HEAD".into(),
            ],
            &root,
            &helper,
            &dir.join("indexed-head.json"),
        );
        assert_eq!(head.kind, "success");
        let descriptor = json!({"repositoryRoot":cwd,"processHelper":helper,"include":["src/**/*.ts"],"exclude":["node_modules","dist",".semctx",".git","coverage"],"index":{"analysis":request,"outcome":index,"baseCommit":head.stdout.trim()}});
        let descriptor_path = dir.join("verify-request.json");
        fs::write(
            &descriptor_path,
            serde_json::to_vec_pretty(&descriptor).unwrap(),
        )
        .unwrap();
        let argv = vec![
            producer.to_string_lossy().into_owned(),
            "verify".into(),
            "working-tree".into(),
            descriptor_path.to_string_lossy().into_owned(),
            sdk.to_string_lossy().into_owned(),
            "--fail-on".into(),
            "none".into(),
        ];
        let actual = invoke(
            argv.clone(),
            &root,
            &helper,
            &dir.join("verify-invocation.json"),
        );
        if label == "literal-test" {
            assert_ne!(actual.exit_code, Some(0), "{label}: {actual:?}");
            let indexed: Value = serde_json::from_str(&index.stdout).unwrap();
            assert!(
                indexed["diagnostics"].as_array().unwrap().iter().any(
                    |diagnostic| diagnostic["subject_id"] == "src/main.test.ts"
                        && diagnostic["code"]
                            == "QUALIFIED_TEST_DYNAMIC_IMPORT_BINDING_UNPROVEN:src/selected.ts"
                ),
                "{indexed}"
            );
        }
        if matches!(
            label,
            "missing-test-role" | "forged-source-role" | "forged-test-role"
        ) {
            assert_eq!(actual.exit_code, Some(1), "{label}: {actual:?}");
            assert!(actual.stdout.is_empty());
            assert!(
                actual
                    .stderr
                    .contains("roles disagree with current discovery"),
                "{actual:?}"
            );
            continue;
        }
        if matches!(
            label,
            "literal-test"
                | "undeclared-external-control"
                | "parse-failure"
                | "unretained-reference"
                | "retained-reference"
        ) {
            assert_eq!(actual.exit_code, Some(3), "{label}: {actual:?}");
            assert!(actual.stderr.is_empty(), "{actual:?}");
            let report: Value = serde_json::from_str(&actual.stdout).unwrap();
            assert_eq!(report["analysisAdmission"]["status"], "rejected");
            assert_eq!(report["verdict"], "BLOCK");
            assert_eq!(
                report["indexed_extraction_received"],
                label != "parse-failure"
            );
            let reason = if label == "literal-test" {
                "QUALIFIED_TEST_DYNAMIC_IMPORT_BINDING_UNPROVEN:src/selected.ts"
            } else if label.ends_with("-reference") {
                "SOURCE_REFERENCE_PATH_UNSUPPORTED"
            } else if label == "parse-failure" {
                "ANALYSIS_SCOPE_INCOMPLETE:src/selected.ts:unsupported"
            } else {
                "DEPENDENCY_SCOPE_UNRESOLVED_IMPORT:src/selected.ts:optional"
            };
            assert!(
                report["analysisAdmission"]["reasons"]
                    .as_array()
                    .unwrap()
                    .contains(&json!(reason)),
                "{report}"
            );
            if label.ends_with("-reference") {
                assert_eq!(
                    report["analysisAdmission"]["reasons"]
                        .as_array()
                        .unwrap()
                        .contains(&json!(
                            "DEPENDENCY_SCOPE_UNRETAINED_REFERENCE:src/selected.ts:../reference.ts"
                        )),
                    label == "unretained-reference",
                    "{report}"
                );
            }
            if label == "undeclared-external-control" {
                assert!(
                    !report["analysisAdmission"]["reasons"]
                        .as_array()
                        .unwrap()
                        .contains(&json!("UNRESOLVED_IMPORT:src/selected.ts:optional")),
                    "{report}"
                );
                assert_refusal_tampering_rejected(
                    &descriptor,
                    &index.stdout,
                    &argv,
                    &root,
                    &helper,
                    &dir,
                );
            }
            continue;
        }
        if label.ends_with("nearest-config") {
            let indexed: Value =
                serde_json::from_str(descriptor["index"]["outcome"]["stdout"].as_str().unwrap())
                    .unwrap();
            assert_eq!(
                indexed["terminal"],
                if label.starts_with("included")
                    && !(label.contains("uppercase-nearest-config") && sensitive)
                {
                    "refused"
                } else {
                    "complete"
                }
            );
            assert_eq!(
                actual.exit_code,
                Some(
                    if label.starts_with("included")
                        && label.contains("uppercase-nearest-config")
                        && sensitive
                    {
                        0
                    } else if label.starts_with("included") {
                        3
                    } else {
                        1
                    }
                ),
                "unexpected config capture disposition for {label}: exit={:?}, stderr={}",
                actual.exit_code,
                actual.stderr
            );
            if actual.exit_code == Some(0) {
                let report: Value = serde_json::from_str(&actual.stdout).unwrap();
                assert_eq!(report["analysisAdmission"]["status"], "admitted");
            } else if actual.exit_code == Some(3) {
                let report: Value = serde_json::from_str(&actual.stdout).unwrap();
                assert_eq!(report["analysisAdmission"]["status"], "rejected");
                assert_eq!(report["verdict"], "BLOCK");
                assert!(actual.stderr.is_empty());
            } else {
                assert!(actual.stdout.is_empty());
            }
            continue;
        }
        assert_eq!(
            actual.exit_code,
            Some(if rejected { 3 } else { 0 }),
            "{label}: {actual:?}"
        );
        assert!(actual.stderr.is_empty(), "{actual:?}");
        let report: Value = serde_json::from_str(&actual.stdout).unwrap();
        assert_eq!(
            report["analysisAdmission"]["status"],
            if rejected { "rejected" } else { "admitted" }
        );
        assert_eq!(report["indexed_extraction_received"], true);
        if label.starts_with("external-") {
            let specifier = if label == "external-builtin" {
                "node:path"
            } else {
                "optional"
            };
            assert_eq!(
                report["analysisAdmission"]["externalModuleSpecifiers"],
                json!([specifier])
            );
            assert!(report["analysisAdmission"]["limitations"].as_array().unwrap().iter().any(|limitation| limitation.as_str() == Some(&format!("Opaque external static module boundaries (built-ins or manifest-declared non-workspace packages): {specifier}. Their runtime behavior and APIs are not qualified."))));
        }
        assert_eq!(
            report["request_descriptor_id"],
            identity::digest(&descriptor)
        );
        assert_eq!(
            report["producer_artifact_id"],
            identity::digest_bytes(&fs::read(&producer).unwrap())
        );
        assert_eq!(report["inherited_configuration"]["executed"], true);
        assert!(
            report["inherited_configuration"]["consumed"]
                .as_array()
                .unwrap()
                .iter()
                .any(|p| p.as_str().is_some_and(|p| p.ends_with("/base.json")))
        );
        if rejected {
            assert_eq!(report["verdict"], "BLOCK");
            assert!(
                report["analysisAdmission"]["changeCoverage"]["files"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|r| r["path"] == outside_path && r["status"] == "excluded")
            );
        }
        if label == "excluded-test-role" {
            assert!(
                report["analysisAdmission"]["reasons"]
                    .as_array()
                    .unwrap()
                    .contains(&json!(
                        "QUALIFIED_TEST_DYNAMIC_IMPORT_BINDING_UNPROVEN:src/selected.ts"
                    )),
                "{report}"
            );
            assert_eq!(
                report["broad_analysis"]["assembly"]["integrityReasons"]["outside.test.ts"],
                json!(["QUALIFIED_TEST_DYNAMIC_IMPORT_BINDING_UNPROVEN:src/selected.ts"])
            );
        }
        if label == "static-test" {
            let edges = report["broad_analysis"]["assembly"]["edges"]
                .as_array()
                .unwrap();
            for kind in ["tested_by", "covers"] {
                assert!(edges.iter().any(|edge| edge["kind"] == kind
                    && (edge["from"] == "test:src/main.test.ts"
                        || edge["to"] == "test:src/main.test.ts")));
            }
        }
        if label == "inherited-positive" {
            for (label, field, value, rejection) in [
                ("cancelled", "kind", json!("cancelled"), "ProcessFailure"),
                ("late", "duration_ms", json!(20_001), "LateResult"),
            ] {
                let mut changed = descriptor.clone();
                changed["index"]["outcome"][field] = value;
                let path = dir.join(format!("{label}-descriptor.json"));
                fs::write(&path, serde_json::to_vec_pretty(&changed).unwrap()).unwrap();
                let mut changed_argv = argv.clone();
                changed_argv[3] = path.to_string_lossy().into_owned();
                let rejected = invoke(
                    changed_argv,
                    &root,
                    &helper,
                    &dir.join(format!("{label}-invocation.json")),
                );
                assert_eq!(rejected.exit_code, Some(3), "{label}: {rejected:?}");
                let report: Value = serde_json::from_str(&rejected.stdout).unwrap();
                assert_eq!(report["analysisAdmission"]["status"], "rejected");
                assert_eq!(report["verdict"], "BLOCK");
                assert_eq!(report["indexed_extraction_received"], false);
                assert_eq!(
                    report["analysisAdmission"]["reasons"],
                    json!([
                        "ANALYSIS_SCOPE_INCOMPLETE:src/selected.ts:unsupported",
                        format!("INDEXED_EXTRACTION_REJECTED:{rejection}"),
                        "ZERO_ANALYZED_OBLIGATIONS"
                    ])
                );
                assert_eq!(
                    report["analysisAdmission"]["changeCoverage"]["files"],
                    json!([{"path":"src/selected.ts","status":"unsupported"}])
                );
            }
            let mut variants = vec![];
            for (field, value) in [
                ("kind", json!("timeout")),
                ("stdout", json!("")),
                ("exit_code", json!(7)),
            ] {
                let mut changed = descriptor.clone();
                changed["index"]["outcome"][field] = value;
                variants.push((format!("bad-outcome-{field}"), changed));
            }
            for (field, value) in [
                (
                    "baseCommit",
                    json!("0000000000000000000000000000000000000000"),
                ),
                ("outcome", json!({})),
            ] {
                let mut changed = descriptor.clone();
                changed["index"][field] = value;
                variants.push((format!("bad-index-{field}"), changed));
            }
            let mut missing_helper = descriptor.clone();
            missing_helper["processHelper"] = json!(dir.join("no-such-helper"));
            variants.push(("missing-helper".into(), missing_helper));
            let mut wrong_scope = descriptor.clone();
            wrong_scope["include"] = json!(["missing/**/*.ts"]);
            variants.push(("wrong-selection".into(), wrong_scope));
            let mut duplicate_capture = descriptor.clone();
            duplicate_capture["index"]["analysis"]["files"][format!("{cwd}/src/./selected.ts")] =
                files["src/selected.ts"].clone();
            variants.push(("duplicate-logical-capture".into(), duplicate_capture));
            let mut omitted_capture = descriptor.clone();
            omitted_capture["index"]["analysis"]["files"]
                .as_object_mut()
                .unwrap()
                .remove(&format!("{cwd}/base.json"));
            variants.push(("omitted-authored-capture".into(), omitted_capture));
            let mut wrong_options = descriptor.clone();
            wrong_options["index"]["analysis"]["options"]["module"] = json!("NodeNext");
            variants.push(("unsupported-options".into(), wrong_options));
            let mut wrong_facts = descriptor.clone();
            let mut batch: Value =
                serde_json::from_str(wrong_facts["index"]["outcome"]["stdout"].as_str().unwrap())
                    .unwrap();
            batch["facts"].as_array_mut().unwrap().remove(0);
            let stdout = serde_json::to_string(&batch).unwrap();
            wrong_facts["index"]["outcome"]["stdout_bytes"] = json!(stdout.len());
            wrong_facts["index"]["outcome"]["stdout_hash"] =
                json!(identity::digest_bytes(stdout.as_bytes()).trim_start_matches("sha256:"));
            wrong_facts["index"]["outcome"]["stdout"] = json!(stdout);
            variants.push(("substituted-facts".into(), wrong_facts));
            let mut forged_refusal = descriptor.clone();
            let mut batch: Value = serde_json::from_str(&index.stdout).unwrap();
            batch["terminal"] = json!("refused");
            batch["subjects"][0]["outcome"] = json!("unsupported");
            batch["subjects"][0]["coverage"] = json!([]);
            batch["diagnostics"] = json!([{"subject_id":"src/selected.ts","code":"FORGED_REASON","message":"FORGED_REASON"}]);
            let stdout = serde_json::to_string(&batch).unwrap();
            forged_refusal["index"]["outcome"]["stdout_bytes"] = json!(stdout.len());
            forged_refusal["index"]["outcome"]["stdout_hash"] =
                json!(identity::digest_bytes(stdout.as_bytes()).trim_start_matches("sha256:"));
            forged_refusal["index"]["outcome"]["stdout"] = json!(stdout);
            variants.push(("forged-refusal".into(), forged_refusal));
            for (name, changed) in variants {
                let path = dir.join(format!("{name}-descriptor.json"));
                fs::write(&path, serde_json::to_vec_pretty(&changed).unwrap()).unwrap();
                let mut bad_argv = argv.clone();
                bad_argv[3] = path.to_string_lossy().into_owned();
                let rejected = invoke(
                    bad_argv,
                    &root,
                    &helper,
                    &dir.join(format!("{name}-invocation.json")),
                );
                assert_ne!(rejected.exit_code, Some(0), "{name}: {rejected:?}");
                if name.starts_with("bad-outcome-")
                    || matches!(name.as_str(), "substituted-facts" | "forged-refusal")
                {
                    assert_eq!(rejected.exit_code, Some(3), "{name}: {rejected:?}");
                    let report: Value = serde_json::from_str(&rejected.stdout).unwrap();
                    assert_eq!(report["analysisAdmission"]["status"], "rejected");
                    assert_eq!(report["indexed_extraction_received"], false);
                    assert!(
                        report["analysisAdmission"]["changeCoverage"]["files"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .all(|file| file["status"] != "analyzed")
                    );
                } else {
                    assert!(
                        rejected.stdout.is_empty(),
                        "invalid verification emitted a report: {name}"
                    );
                }
            }
            for (name, argument, bytes) in [
                ("malformed-descriptor", 3, b"{bad".as_slice()),
                ("malformed-sdk", 4, b"{bad".as_slice()),
            ] {
                let invalid = dir.join(format!("{name}.json"));
                fs::write(&invalid, bytes).unwrap();
                let mut bad_argv = argv.clone();
                bad_argv[argument] = invalid.to_string_lossy().into_owned();
                let failed = invoke(
                    bad_argv,
                    &root,
                    &helper,
                    &dir.join(format!("{name}-invocation.json")),
                );
                assert_eq!(failed.exit_code, Some(1));
                assert!(failed.stdout.is_empty());
            }
            let mut incomplete_argv = argv.clone();
            incomplete_argv.pop();
            let failed = invoke(
                incomplete_argv,
                &root,
                &helper,
                &dir.join("bad-arity-invocation.json"),
            );
            assert_eq!(failed.exit_code, Some(1));
            assert!(failed.stdout.is_empty());
        }
        fs::write(
            root.join("src/selected.ts"),
            "export function staleFactory(){return 193;}\n",
        )
        .unwrap();
        let stale = invoke(argv, &root, &helper, &dir.join("stale-invocation.json"));
        assert_ne!(
            stale.exit_code,
            Some(0),
            "stale retained index became admitted"
        );
    }
}
