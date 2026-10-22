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

#[test]
fn native_qualified_verification_consumes_closure_and_rejection_before_fail_on_none() {
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
        (
            "retained-declaration",
            Some("declare const ambientFlag: boolean;\n"),
            true,
        ),
        (
            "retained-declaration-indexed-ts",
            Some("declare const ambientFlag: boolean;\n"),
            true,
        ),
        (
            "retained-declaration-indexed-mts",
            Some("declare const ambientFlag: boolean;\n"),
            true,
        ),
        (
            "retained-declaration-indexed-cts",
            Some("declare const ambientFlag: boolean;\n"),
            true,
        ),
        (
            "retained-reached-body",
            Some(
                "export { selectedFactory } from './src/selected';\nexport function monitor(name:string) { return import(name); }\n",
            ),
            true,
        ),
        (
            "retained-declaration-outside",
            Some(
                "/// <reference path=\"../outside.d.ts\" />\ndeclare const ambientFlag: boolean;\n",
            ),
            true,
        ),
        (
            "retained-mixed-outside",
            Some("/// <reference path=\"../outside.ts\" />\nexport const monitor=1;\n"),
            true,
        ),
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
        let dir = evidence.join(label);
        let root = dir.join("workspace");
        fs::create_dir_all(root.join("src")).unwrap();
        let mut files = json!({"src/selected.ts":"export function selectedFactory() { return 179; }\n","base.json":"{\"compilerOptions\":{\"module\":\"ESNext\",\"moduleResolution\":\"Bundler\"}}","tsconfig.json":"{\"extends\":\"./base.json\"}",".gitignore":".semctx/\n"});
        let outside_path = if label == "retained-declaration-indexed-mts" {
            "ambient.d.mts"
        } else if label == "retained-declaration-indexed-cts" {
            "ambient.d.cts"
        } else if label.starts_with("retained-declaration") {
            "ambient.d.ts"
        } else if label == "retained-reached-body" || label == "retained-mixed-outside" {
            "monitor.ts"
        } else if label.starts_with("output-") {
            fs::create_dir_all(root.join("dist")).unwrap();
            "dist/outside.ts"
        } else {
            "outside.ts"
        };
        if let Some(outside) = outside {
            files[outside_path] = json!(outside);
        }
        if label == "retained-mixed-outside" {
            files["util.js"] = json!("export const okay=1;\n");
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
        let mut roots = vec![format!("{cwd}/src/selected.ts")];
        let mut include = vec!["src/**/*.ts".to_string()];
        if label.starts_with("retained-declaration-indexed-") {
            roots.push(format!("{cwd}/{outside_path}"));
            include.push(outside_path.to_string());
        }
        let request = json!({"id":format!("development-qualified-{label}"),"cwd":cwd,"sdk_directory":"/sdk/lib","case_sensitive":sensitive,"files":captured,"roots":roots,"options":{"target":"ES2022","module":"ESNext","moduleResolution":"Bundler","allowJs":true,"jsx":"Preserve","skipLibCheck":true,"noEmit":true,"strict":false},"retained":true,"qualified":true,"roles":{},"selection":{},"disabled":[],"utf16_files":{},"raw_files":{}});
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
        assert_eq!(index.kind, "success", "{index:?}");
        if label.starts_with("retained-declaration-indexed-") {
            let batch: Value = serde_json::from_str(&index.stdout).unwrap();
            assert_eq!(batch["subjects"].as_array().unwrap().len(), 1);
            assert_eq!(batch["subjects"][0]["subject_id"], "src/selected.ts");
        }
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
        let descriptor = json!({"repositoryRoot":cwd,"processHelper":helper,"include":include,"exclude":["node_modules","dist",".semctx",".git","coverage"],"index":{"analysis":request,"outcome":index,"baseCommit":head.stdout.trim()}});
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
        let scope = &report["retained_scope"];
        for field in [
            "links",
            "reasons",
            "externalModuleSpecifiers",
            "unresolvedImports",
        ] {
            assert!(
                scope["projection"][field].is_array(),
                "missing producer scope {field}"
            );
        }
        if label.starts_with("retained-") {
            let reason = if label.starts_with("retained-declaration") {
                format!("DEPENDENCY_SCOPE_DECLARATION_UNSUPPORTED:{outside_path}")
            } else if label == "retained-mixed-outside" {
                "DEPENDENCY_SCOPE_UNRETAINED_REFERENCE:monitor.ts:../outside.ts".into()
            } else {
                "DEPENDENCY_SCOPE_COMPUTED_IMPORT:monitor.ts".into()
            };
            assert!(
                scope["projection"]["reasons"]
                    .as_array()
                    .unwrap()
                    .contains(&json!(reason))
            );
            assert!(
                report["analysisAdmission"]["reasons"]
                    .as_array()
                    .unwrap()
                    .contains(&json!(reason))
            );
            if label == "retained-declaration" || label.starts_with("retained-declaration-indexed-")
            {
                assert_eq!(
                    scope["declaration_analysis"]["observation_mode"],
                    "declaration_roots"
                );
                assert_eq!(
                    scope["input_manifest_id"],
                    scope["declaration_analysis"]["input_manifest_id"]
                );
            } else if label == "retained-reached-body" {
                assert!(
                    scope["projection"]["links"]
                        .as_array()
                        .unwrap()
                        .contains(&json!(["monitor.ts", "src/selected.ts"]))
                );
            }
            if label.ends_with("-outside") {
                let analysis = if label.starts_with("retained-declaration") {
                    &scope["declaration_analysis"]
                } else {
                    &scope["full_analysis"]
                };
                assert_eq!(analysis["confinementObservation"]["state"], "refused");
                assert_eq!(analysis["extraction_executed"], false);
                assert!(
                    scope["projection"]["reasons"]
                        .as_array()
                        .unwrap()
                        .contains(&json!("DEPENDENCY_SCOPE_OUTSIDE_REPOSITORY"))
                );
            }
        }
        assert_eq!(
            report["analysisAdmission"]["status"],
            if rejected { "rejected" } else { "admitted" }
        );
        assert_eq!(report["indexed_extraction_received"], true);
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
        if label == "retained-declaration-indexed-ts" {
            for name in ["missing-selected-subject", "foreign-selected-subject"] {
                let mut changed = descriptor.clone();
                let mut batch: Value = serde_json::from_str(&index.stdout).unwrap();
                if name == "missing-selected-subject" {
                    batch["subjects"] = json!([]);
                } else {
                    let mut foreign = batch["subjects"][0].clone();
                    foreign["subject_id"] = json!("foreign.ts");
                    batch["subjects"].as_array_mut().unwrap().push(foreign);
                }
                let stdout = serde_json::to_string(&batch).unwrap();
                changed["index"]["outcome"]["stdout_bytes"] = json!(stdout.len());
                changed["index"]["outcome"]["stdout_hash"] =
                    json!(identity::digest_bytes(stdout.as_bytes()).trim_start_matches("sha256:"));
                changed["index"]["outcome"]["stdout"] = json!(stdout);
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
                assert_eq!(rejected.exit_code, Some(1), "{name}: {rejected:?}");
                assert!(rejected.stdout.is_empty());
                assert!(rejected.stderr.contains("SubjectMismatch"));
            }
        }
        if rejected && !label.starts_with("retained-") {
            assert_eq!(report["verdict"], "BLOCK");
            assert!(
                report["analysisAdmission"]["changeCoverage"]["files"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|r| r["path"] == outside_path && r["status"] == "excluded")
            );
        }
        if label == "inherited-positive" {
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
                assert!(
                    rejected.stdout.is_empty(),
                    "invalid verification emitted a report: {name}"
                );
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
