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
            if label == "included-nearest-config" {
                let observed = invoke(
                    vec![
                        producer.to_string_lossy().into_owned(),
                        "--observe-retained-scope".into(),
                        request_path.to_string_lossy().into_owned(),
                        sdk.to_string_lossy().into_owned(),
                    ],
                    &root,
                    &helper,
                    &dir.join("retained-scope-invocation.json"),
                );
                assert_eq!(observed.exit_code, Some(0), "{observed:?}");
                assert!(observed.stderr.is_empty(), "{observed:?}");
                let component: Value = serde_json::from_str(&observed.stdout).unwrap();
                assert_eq!(
                    component["status"],
                    "retained_scope_component_observation_not_qualification"
                );
                assert_eq!(
                    component["observation_scope"],
                    "retained_capture_components"
                );
                for field in [
                    "negative_evidence_eligible",
                    "ownership_authorized",
                    "index_receipt_consumed",
                    "global_admission_inferred",
                ] {
                    assert_eq!(component[field], false, "{field}");
                }
                assert_eq!(component["qualification_credit"], 0);
                for field in ["analysisAdmission", "verdict", "receipt"] {
                    assert!(component.get(field).is_none(), "{field}");
                }
                assert_eq!(component["request_id"], identity::digest(&request));
                for field in ["input_manifest_id", "producer_artifact_id"] {
                    assert_eq!(component[field], indexed[field], "{field}");
                    assert_eq!(
                        component["current_analysis"][field], indexed[field],
                        "{field}"
                    );
                }
                let sdk_value: Value = serde_json::from_slice(&fs::read(&sdk).unwrap()).unwrap();
                assert_eq!(component["sdk_input_id"], identity::digest(&sdk_value));
                assert!(
                    component["current_analysis"]["subjects"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|subject| subject["outcome"] == "unsupported")
                );
                assert_eq!(
                    component["scope"],
                    json!({
                        "captured_paths":[".gitignore","base.json","src/selected.ts","src/tsconfig.json","tsconfig.json"],
                        "selected_roots":["src/selected.ts"],
                        "source_roots":["src/selected.ts"],
                        "declaration_roots":[]
                    })
                );
                assert_eq!(
                    component["retained_scope"]["projection"],
                    json!({
                        "links":[],
                        "reasons":[
                            "DEPENDENCY_SCOPE_CONFIGURATION:src/selected.ts:SOURCE_CONFIGURATION_MODULE_UNSUPPORTED:NodeNext",
                            "DEPENDENCY_SCOPE_CONFIGURATION:src/selected.ts:SOURCE_CONFIGURATION_RESOLUTION_UNSUPPORTED:NodeNext"
                        ],
                        "externalModuleSpecifiers":[],
                        "unresolvedImports":[]
                    })
                );
                assert_eq!(
                    component["retained_scope"]["input_manifest_id"],
                    component["input_manifest_id"]
                );
                assert_eq!(
                    component["retained_scope"]["full_analysis"]["input_manifest_id"],
                    component["input_manifest_id"]
                );
                for (field, value) in [
                    ("retained", json!(false)),
                    ("roles", json!({"src/selected.ts":"source"})),
                    ("selection", json!({"src/selected.ts":"excluded"})),
                    ("disabled", json!(["src/selected.ts"])),
                    (
                        "utf16_files",
                        json!({format!("{cwd}/src/selected.ts"):[65]}),
                    ),
                    (
                        "raw_files",
                        json!({format!("{cwd}/src/selected.ts"):{"bytes":[65],"profile":"retained_utf8"}}),
                    ),
                    ("roots", json!([])),
                    ("files", {
                        let mut captured = request["files"].clone();
                        captured[format!("{cwd}/src/selected.ts")] =
                            json!("export const altered=1;");
                        captured
                    }),
                ] {
                    let mut invalid = request.clone();
                    invalid[field] = value;
                    let path = dir.join(format!("invalid-scope-{field}.json"));
                    fs::write(&path, serde_json::to_vec_pretty(&invalid).unwrap()).unwrap();
                    let refused = invoke(
                        vec![
                            producer.to_string_lossy().into_owned(),
                            "--observe-retained-scope".into(),
                            path.to_string_lossy().into_owned(),
                            sdk.to_string_lossy().into_owned(),
                        ],
                        &root,
                        &helper,
                        &dir.join(format!("invalid-scope-{field}-invocation.json")),
                    );
                    assert_eq!(refused.exit_code, Some(1), "{field}: {refused:?}");
                    assert!(refused.stdout.is_empty(), "{field}: {refused:?}");
                }
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
        if label == "retained-declaration-outside" {
            let observed = invoke(
                vec![
                    producer.to_string_lossy().into_owned(),
                    "--observe-retained-scope".into(),
                    request_path.to_string_lossy().into_owned(),
                    sdk.to_string_lossy().into_owned(),
                ],
                &root,
                &helper,
                &dir.join("refused-declaration-scope-invocation.json"),
            );
            assert_eq!(observed.exit_code, Some(0), "{observed:?}");
            let component: Value = serde_json::from_str(&observed.stdout).unwrap();
            assert_eq!(component["negative_evidence_eligible"], false);
            assert_eq!(component["ownership_authorized"], false);
            assert_eq!(component["global_admission_inferred"], false);
            assert_eq!(component["qualification_credit"], 0);
            let declaration = &component["retained_scope"]["declaration_analysis"];
            assert_eq!(declaration["observation_mode"], "retained_scope_components");
            assert_eq!(declaration["extraction_executed"], false);
            assert_eq!(declaration["confinementObservation"]["state"], "refused");
            assert_eq!(declaration["raw_extraction"]["imports"], json!([]));
        }
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
        if label == "inherited-positive" {
            assert_eq!(actual.exit_code, Some(0), "SETUP: positive control failed");
            assert_eq!(
                report["analysisAdmission"]["status"], "admitted",
                "SETUP: positive control was not admitted"
            );

            let dev = dir.join("final-git-identity-dev");
            let state = dev.join("state");
            fs::create_dir_all(&state).unwrap();

            let git_ok = |name: &str, tail: Vec<String>| {
                let mut command = vec!["git".to_string()];
                command.extend(tail);
                let result = invoke(command, &root, &helper, &dev.join(format!("{name}.json")));
                assert_eq!(result.kind, "success", "SETUP: git {name}: {result:?}");
                assert_eq!(result.exit_code, Some(0), "SETUP: git {name}");
                result
            };

            let a = descriptor["index"]["baseCommit"]
                .as_str()
                .unwrap()
                .to_string();

            let tree_a = git_ok("tree-a", vec!["rev-parse".into(), format!("{a}^{{tree}}")])
                .stdout
                .trim()
                .to_string();

            // Create an unattached commit: no working-file or index modification.
            let b = git_ok(
                "create-b",
                vec![
                    "-c".into(),
                    "user.name=NativeFixture".into(),
                    "-c".into(),
                    "user.email=native@example.test".into(),
                    "commit-tree".into(),
                    tree_a.clone(),
                    "-p".into(),
                    a.clone(),
                    "-m".into(),
                    "DEV final Git identity drift; identical tree".into(),
                ],
            )
            .stdout
            .trim()
            .to_string();

            assert_ne!(a, b, "SETUP: commits must differ");
            let tree_b = git_ok("tree-b", vec!["rev-parse".into(), format!("{b}^{{tree}}")]);
            assert_eq!(tree_b.stdout.trim(), tree_a, "SETUP: trees differ");

            let diff_before = git_ok(
                "diff-before",
                vec![
                    "diff".into(),
                    "--name-only".into(),
                    "-z".into(),
                    "HEAD".into(),
                    "--".into(),
                ],
            )
            .stdout;

            let config_path = dev.join("git-drift-config.rs");
            let source_path = dev.join("git-drift-proxy.rs");
            let proxy = dev.join(format!("git-drift-proxy{}", std::env::consts::EXE_SUFFIX));

            // Debug string formatting produces escaped Rust string literals.
            let config = format!(
                "const HELPER: &str = {:?};\n\
                 const ROOT: &str = {:?};\n\
                 const FROM: &str = {:?};\n\
                 const TO: &str = {:?};\n\
                 const STATE: &str = {:?};\n",
                helper.to_str().expect("SETUP: helper path must be UTF-8"),
                root.to_str().expect("SETUP: root path must be UTF-8"),
                a,
                b,
                state.to_str().expect("SETUP: state path must be UTF-8"),
            );
            fs::write(&config_path, config).unwrap();
            fs::write(&source_path, FINAL_GIT_IDENTITY_PROXY).unwrap();

            let compiler = std::env::var_os("RUSTC")
                .unwrap_or_else(|| "rustc".into())
                .into_string()
                .expect("SETUP: rustc path must be UTF-8");

            let compiled = invoke(
                vec![
                    compiler,
                    "--edition=2024".into(),
                    "--crate-name".into(),
                    "semctx_git_drift_proxy".into(),
                    source_path.to_string_lossy().into_owned(),
                    "-o".into(),
                    proxy.to_string_lossy().into_owned(),
                ],
                &dev,
                &helper,
                &dev.join("compile.json"),
            );
            assert_eq!(
                compiled.kind, "success",
                "SETUP: proxy compilation failed: {compiled:?}"
            );
            assert_eq!(compiled.exit_code, Some(0), "SETUP: rustc failed");
            assert!(proxy.is_file(), "SETUP: proxy executable absent");

            let immutable = [&helper, &proxy, &config_path, &source_path]
                .into_iter()
                .map(|path| (path.clone(), fs::read(path).unwrap()))
                .collect::<Vec<_>>();

            let captured = descriptor["index"]["analysis"]["files"]
                .as_object()
                .unwrap()
                .iter()
                .map(|(path, text)| {
                    let expected = text.as_str().unwrap().as_bytes().to_vec();
                    assert_eq!(
                        fs::read(path).unwrap(),
                        expected,
                        "SETUP: capture already differs"
                    );
                    (path.clone(), expected)
                })
                .collect::<Vec<_>>();

            let mut drift_descriptor = descriptor.clone();
            drift_descriptor["processHelper"] =
                json!(proxy.to_str().expect("SETUP: proxy path must be UTF-8"));
            let drift_path = dev.join("descriptor.json");
            fs::write(
                &drift_path,
                serde_json::to_vec_pretty(&drift_descriptor).unwrap(),
            )
            .unwrap();

            let mut drift_argv = argv.clone();
            drift_argv[3] = drift_path.to_string_lossy().into_owned();
            let drift = invoke(drift_argv, &root, &helper, &dev.join("verify-drift.json"));

            // Premises first: none of these failures is a valid RED.
            assert!(
                !state.join("failure").exists(),
                "SETUP: proxy/delegate/injection failed"
            );
            assert!(
                !drift.stderr.contains("DEV_GIT_DRIFT_SETUP"),
                "SETUP: proxy failed: {}",
                drift.stderr
            );
            assert!(
                matches!(drift.kind.as_str(), "success" | "nonzero"),
                "SETUP: incomplete process outcome: {drift:?}"
            );
            assert_eq!(
                fs::read_to_string(state.join("injected")).unwrap(),
                format!("{a}\n{b}\n"),
                "SETUP: designated injection did not complete"
            );

            let after_head = git_ok(
                "head-after",
                vec!["rev-parse".into(), "--verify".into(), "HEAD".into()],
            );
            assert_eq!(after_head.stdout.trim(), b, "SETUP: HEAD did not move");

            let diff_after = git_ok(
                "diff-after",
                vec![
                    "diff".into(),
                    "--name-only".into(),
                    "-z".into(),
                    "HEAD".into(),
                    "--".into(),
                ],
            );
            assert_eq!(
                diff_after.stdout, diff_before,
                "SETUP: this witness must isolate HEAD identity"
            );

            for (path, bytes) in &immutable {
                assert_eq!(
                    fs::read(path).unwrap(),
                    *bytes,
                    "SETUP: tool/config changed"
                );
            }
            for (path, bytes) in &captured {
                assert_eq!(fs::read(path).unwrap(), *bytes, "SETUP: capture changed");
            }

            // Restore A before the original stale-file control below.
            git_ok(
                "restore-a",
                vec!["update-ref".into(), "HEAD".into(), a.clone(), b.clone()],
            );

            // Designated assertion: current uncorrected code is expected to fail here.
            assert_eq!(
                drift.exit_code,
                Some(1),
                "VERIFY_FINAL_GIT_IDENTITY_ADMITTED: verification did not refuse HEAD drift"
            );
            assert!(
                drift.stdout.is_empty(),
                "VERIFY_FINAL_GIT_IDENTITY_ADMITTED: drift emitted an admission report"
            );
            let refusal: Value = serde_json::from_str(drift.stderr.trim())
                .expect("VERIFY_FINAL_GIT_IDENTITY_REFUSAL: expected structured refusal");
            assert_eq!(
                refusal,
                json!({
                    "error":
                        "qualified index no longer refers to the current Git commit"
                }),
                "VERIFY_FINAL_GIT_IDENTITY_REFUSAL: unrelated failure is not detection"
            );
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

const FINAL_GIT_IDENTITY_PROXY: &str = r#"
use std::{
    env,
    ffi::OsStr,
    fs::{self, OpenOptions},
    io,
    path::Path,
    process::{self, Command, Stdio},
};

include!("git-drift-config.rs");

fn setup_error(message: &str) -> ! {
    let _ = fs::write(Path::new(STATE).join("failure"), message);
    eprintln!("DEV_GIT_DRIFT_SETUP: {message}");
    process::exit(125);
}

fn main() {
    let args = env::args_os().skip(1).collect::<Vec<_>>();

    // Do not consume the supervisor ACK: the real helper receives it unchanged.
    let status = Command::new(HELPER)
        .args(&args)
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .status()
        .unwrap_or_else(|e| setup_error(&format!("delegate spawn: {e}")));

    let code = status
        .code()
        .unwrap_or_else(|| setup_error("delegate terminated without an exit code"));

    if code != 0 {
        fs::write(
            Path::new(STATE).join("failure"),
            format!("delegate exit: {code}"),
        )
        .unwrap_or_else(|e| setup_error(&format!("record delegate failure: {e}")));
        process::exit(code);
    }

    let trigger = ["__exec", "git", "ls-files", "--cached", "-z", "--"];
    if args.len() == trigger.len()
        && args
            .iter()
            .zip(trigger)
            .all(|(actual, expected)| actual.as_os_str() == OsStr::new(expected))
    {
        let claim = match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(Path::new(STATE).join("claimed"))
        {
            Ok(file) => file,
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {
                process::exit(code);
            }
            Err(e) => setup_error(&format!("claim injection: {e}")),
        };
        drop(claim);

        // This occurs after the real inventory command has completed successfully.
        // Capture update-ref output separately; never contaminate inventory output.
        let changed = Command::new("git")
            .args(["-C", ROOT, "update-ref", "HEAD", TO, FROM])
            .stdin(Stdio::null())
            .output()
            .unwrap_or_else(|e| setup_error(&format!("update-ref spawn: {e}")));

        if !changed.status.success() {
            setup_error(&format!(
                "update-ref failed: {:?}; {}",
                changed.status.code(),
                String::from_utf8_lossy(&changed.stderr),
            ));
        }

        fs::write(
            Path::new(STATE).join("injected"),
            format!("{FROM}\n{TO}\n"),
        )
        .unwrap_or_else(|e| setup_error(&format!("record injection: {e}")));
    }

    process::exit(code);
}
"#;
