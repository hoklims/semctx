use semctx_gates::process;
use semctx_r0_probe::identity;
use serde_json::{Value, json};
use std::{
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

fn discover(evidence: &Path, files: &[(&str, &str)], javascript: &str) -> Value {
    let root = evidence.join("repository");
    fs::create_dir_all(&root).unwrap();
    for (path, text) in files {
        let physical = root.join(path);
        fs::create_dir_all(physical.parent().unwrap()).unwrap();
        fs::write(physical, text).unwrap();
    }
    let observed = observe_root(evidence, &root, javascript);
    assert_eq!(observed["executed"], true);
    observed
}

fn observe_root(evidence: &Path, root: &Path, javascript: &str) -> Value {
    let request = json!({"repositoryRoot":root.canonicalize().unwrap(),"config":{"version":2,"include":["**/*"],"exclude":[],"languages":{"typescript":"on","javascript":javascript},"migrationsDirs":["migrations"]}});
    observe_descriptor(evidence, root, &request, "--discover-repository")
}

fn observe_descriptor(evidence: &Path, root: &Path, request: &Value, mode: &str) -> Value {
    let request_path = evidence.join("request.json");
    fs::write(&request_path, serde_json::to_vec_pretty(&request).unwrap()).unwrap();
    let producer = Path::new(env!("CARGO_BIN_EXE_semctx-r0-probe"));
    let helper = PathBuf::from(
        std::env::var_os("SEMCTX_PROCESS_HELPER").expect("compiled process helper required"),
    );
    let before = identity::digest_bytes(&fs::read(producer).unwrap());
    let helper_before = identity::digest_bytes(&fs::read(&helper).unwrap());
    let argv = vec![
        producer.to_string_lossy().into_owned(),
        mode.into(),
        request_path.to_string_lossy().into_owned(),
    ];
    let outcome = process::run_with_helper(&argv, root, 20_000, 8_388_608, &helper).unwrap();
    let after = identity::digest_bytes(&fs::read(producer).unwrap());
    let helper_after = identity::digest_bytes(&fs::read(&helper).unwrap());
    fs::write(
        evidence.join("process.json"),
        serde_json::to_vec_pretty(&json!({"argv":argv,"cwd":root,"producer_before":before,"producer_after":after,"helper_before":helper_before,"helper_after":helper_after,"outcome":outcome})).unwrap(),
    ).unwrap();
    assert_eq!(before, after);
    assert_eq!(helper_before, helper_after);
    assert_eq!(outcome.kind, "success", "{outcome:?}");
    assert_eq!(outcome.exit_code, Some(0));
    let observed: Value = serde_json::from_str(&outcome.stdout).unwrap();
    assert_eq!(observed["request_descriptor_id"], identity::digest(request));
    assert_eq!(observed["producer_artifact_id"], before);
    assert_eq!(observed["global_admission_inferred"], false);
    observed
}

#[test]
fn native_qualified_eligibility_uses_git_and_keeps_causal_output_metadata() {
    let evidence = std::env::temp_dir().join(format!(
        "semctx-eligibility-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let root = evidence.join("repository");
    fs::create_dir_all(&root).unwrap();
    for (path, text) in [
        (".gitignore", "dist/\n"),
        ("src/main.ts", "export const main=1;"),
        ("dist/tsconfig.json", "{\"extends\":\"./base\"}"),
        ("dist/base.json", "{}"),
        ("dist/noise.ts", "export const noise=1;"),
        ("dist/.gitignore", "noise.ts\n"),
    ] {
        let path = root.join(path);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }
    let helper = PathBuf::from(std::env::var_os("SEMCTX_PROCESS_HELPER").unwrap());
    let initialized = process::run_with_helper(
        &["git".into(), "init".into(), "--quiet".into()],
        &root,
        5_000,
        1_048_576,
        &helper,
    )
    .unwrap();
    assert_eq!(initialized.kind, "success", "{initialized:?}");
    let request = json!({"repositoryRoot":root.canonicalize().unwrap(),"processHelper":helper,"include":["src/**/*.ts"],"exclude":["node_modules","dist",".semctx",".git","coverage"],"queries":["src/main.ts","dist/tsconfig.json","dist/base.json","dist/noise.ts","dist/.gitignore","node_modules/pkg/x.ts"]});
    let observed = observe_descriptor(&evidence, &root, &request, "--observe-path-eligibility");
    assert_eq!(observed["executed"], true);
    assert_eq!(observed["eligibility_established"], true);
    assert_eq!(
        observed["eligible_results"],
        json!([true, true, true, false, true, false])
    );
    fs::write(
        root.join("dist/tsconfig.json"),
        "{\"extends\":\"./base\", \"compilerOptions\":",
    )
    .unwrap();
    let partial = evidence.join("partial-config");
    fs::create_dir(&partial).unwrap();
    let retained = observe_descriptor(&partial, &root, &request, "--observe-path-eligibility");
    assert_eq!(retained["eligible_results"][2], true);
    fs::write(root.join("dist/tsconfig.json"), "{\"extends\":\"./base\"}").unwrap();
    let nested = root.join("dist/nested");
    fs::create_dir_all(nested.join(".git")).unwrap();
    fs::write(nested.join("tsconfig.json"), "{\"extends\":\"./base\"}").unwrap();
    fs::write(nested.join("base.json"), "{}").unwrap();
    let nested_evidence = evidence.join("nested-repository");
    fs::create_dir(&nested_evidence).unwrap();
    let mut nested_request = request.clone();
    nested_request["queries"] = json!(["dist/nested/base.json"]);
    let retained = observe_descriptor(
        &nested_evidence,
        &root,
        &nested_request,
        "--observe-path-eligibility",
    );
    assert_eq!(retained["eligible_results"], json!([true]));
    fs::remove_dir_all(&nested).unwrap();
    fs::write(root.join(".gitignore"), "").unwrap();
    fs::write(root.join("dist/.gitignore"), "").unwrap();
    fs::write(root.join(".git/info/exclude"), "dist/noise.ts\n").unwrap();
    let shared_excludes = evidence.join("shared-excludes");
    fs::create_dir(&shared_excludes).unwrap();
    let retained = observe_descriptor(
        &shared_excludes,
        &root,
        &request,
        "--observe-path-eligibility",
    );
    assert_eq!(
        retained["eligible_results"],
        json!([true, true, true, true, true, false])
    );
    let nonrepo = evidence.join("not-a-repository");
    fs::create_dir(&nonrepo).unwrap();
    let mut bad = request;
    bad["repositoryRoot"] = json!(nonrepo.canonicalize().unwrap());
    let failed = observe_descriptor(&nonrepo, &nonrepo, &bad, "--observe-path-eligibility");
    assert_eq!(failed["eligibility_established"], false);
    assert_eq!(failed["eligible_results"], Value::Null);
    assert_eq!(
        failed["error"],
        json!({"code":"IO_ERROR","message":"qualified discovery could not establish Git source eligibility"})
    );
    assert_eq!(failed["git_outcome"]["kind"], "nonzero");
    eprintln!("native eligibility evidence: {}", evidence.display());
}

#[test]
fn native_qualified_eligibility_refuses_oversized_and_unreadable_configuration() {
    let evidence = std::env::temp_dir().join(format!(
        "semctx-eligibility-read-errors-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let root = evidence.join("repository");
    fs::create_dir_all(root.join("dist")).unwrap();
    fs::write(root.join(".gitignore"), "dist/\n").unwrap();
    let config = root.join("dist/tsconfig.json");
    fs::File::create(&config)
        .unwrap()
        .set_len(33_554_433)
        .unwrap();
    let helper = PathBuf::from(std::env::var_os("SEMCTX_PROCESS_HELPER").unwrap());
    let initialized = process::run_with_helper(
        &["git".into(), "init".into(), "--quiet".into()],
        &root,
        5_000,
        1_048_576,
        &helper,
    )
    .unwrap();
    assert_eq!(initialized.kind, "success", "{initialized:?}");
    let request = json!({"repositoryRoot":root.canonicalize().unwrap(),"processHelper":helper,"include":[],"exclude":[],"queries":["dist/tsconfig.json"]});
    let oversized = evidence.join("oversized");
    fs::create_dir(&oversized).unwrap();
    let refused = observe_descriptor(&oversized, &root, &request, "--observe-path-eligibility");
    assert_eq!(refused["executed"], false);
    assert_eq!(refused["eligible_results"], Value::Null);
    assert_eq!(
        refused["unsupported"],
        json!(["ELIGIBILITY_CONFIGURATION_SIZE_LIMIT"])
    );
    fs::write(&config, "{}").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let original = fs::metadata(&config).unwrap().permissions();
        fs::set_permissions(&config, fs::Permissions::from_mode(0o0)).unwrap();
        let unreadable = evidence.join("unreadable");
        fs::create_dir(&unreadable).unwrap();
        let refused =
            observe_descriptor(&unreadable, &root, &request, "--observe-path-eligibility");
        fs::set_permissions(&config, original).unwrap();
        assert_eq!(refused["executed"], false);
        assert_eq!(refused["eligible_results"], Value::Null);
        assert!(
            refused["unsupported"][0]
                .as_str()
                .unwrap()
                .starts_with("ELIGIBILITY_CONFIGURATION_READ_FAILED:")
        );
    }
    let restored = evidence.join("restored");
    fs::create_dir(&restored).unwrap();
    let observed = observe_descriptor(&restored, &root, &request, "--observe-path-eligibility");
    assert_eq!(observed["executed"], true);
    assert_eq!(observed["eligible_results"], json!([true]));
}

#[test]
fn native_repository_discovery_selects_roles_disables_languages_and_refuses_escape() {
    let base = std::env::var_os("SEMCTX_NATIVE_EVIDENCE")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("development-evidence/discovery")
        });
    let run = base.join(format!(
        "discovery-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let selected = discover(
        &run.join("selected"),
        &[
            ("src/river.ts", "export function river(){return 13;}"),
            (
                "src/river.spec.ts",
                "export function riverSpec(){return 17;}",
            ),
            ("src/panel.jsx", "export function panel(){return <span/>;}"),
        ],
        "on",
    );
    let files = selected["files"]
        .as_array()
        .unwrap()
        .iter()
        .map(|file| json!({"path":file["relPath"],"role":file["role"],"language":file["language"]}))
        .collect::<Vec<_>>();
    assert_eq!(
        files,
        json!([
            {"path":"src/panel.jsx","role":"source","language":"javascript"},
            {"path":"src/river.spec.ts","role":"test","language":"typescript"},
            {"path":"src/river.ts","role":"source","language":"typescript"},
        ])
        .as_array()
        .unwrap()
        .clone()
    );
    for candidate in selected["candidates"].as_array().unwrap() {
        assert_eq!(candidate["reason"], "SELECTED");
        assert!(candidate.get("analysisOutcome").is_none());
    }
    let disabled = discover(
        &run.join("disabled"),
        &[("boot.mjs", "export const boot=19;")],
        "off",
    );
    assert_eq!(disabled["files"], json!([]));
    assert_eq!(
        disabled["candidates"],
        json!([{"relPath":"boot.mjs","language":"javascript","selectionDecision":"selected","analysisOutcome":"disabled","reason":"LANGUAGE_DISABLED"}])
    );
    let escape = run.join("escape");
    fs::create_dir_all(&escape).unwrap();
    fs::write(escape.join("outside.ts"), "export const outside=23;").unwrap();
    let refused = discover(
        &escape,
        &[(
            "src/main.ts",
            "import {outside} from '../../outside'; export const local=outside;",
        )],
        "on",
    );
    assert_eq!(refused["files"], json!([]));
    assert_eq!(
        refused["candidates"],
        json!([{"relPath":"src/main.ts","language":"typescript","selectionDecision":"selected","analysisOutcome":"failed","reason":"IMPORT_OUTSIDE_REPOSITORY"}])
    );
    assert!(
        refused["reads"]
            .as_array()
            .unwrap()
            .iter()
            .all(|read| read["path"].as_str().unwrap().ends_with("src/main.ts"))
    );
    eprintln!("native discovery DEV evidence: {}", run.display());
}

#[cfg(unix)]
#[test]
fn native_discovery_refuses_a_relative_import_resolved_through_an_external_file_link() {
    let base = std::env::var_os("SEMCTX_NATIVE_EVIDENCE")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("development-evidence/discovery")
        });
    let evidence = base.join(format!(
        "discovery-link-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let root = evidence.join("repository");
    fs::create_dir_all(&root).unwrap();
    let outside = evidence.join("outside.ts");
    fs::write(&outside, "export const foreignValue=31;").unwrap();
    std::os::unix::fs::symlink(&outside, root.join("external-link.ts")).unwrap();
    let observed = discover(
        &evidence,
        &[(
            "main.ts",
            "import {foreignValue} from './external-link'; export const local=foreignValue;",
        )],
        "on",
    );
    let main = observed["candidates"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["relPath"] == "main.ts")
        .unwrap();
    assert_eq!(main["reason"], "IMPORT_OUTSIDE_REPOSITORY");
    assert_eq!(main["analysisOutcome"], "failed");
    assert_eq!(observed["files"], json!([]));
}

#[test]
fn native_discovery_refuses_a_package_main_redirect_to_an_external_source() {
    let base = std::env::var_os("SEMCTX_NATIVE_EVIDENCE")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("development-evidence/discovery")
        });
    let evidence = base.join(format!(
        "discovery-package-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir_all(&evidence).unwrap();
    fs::write(evidence.join("outside.ts"), "export const outside=37;").unwrap();
    let observed = discover(
        &evidence,
        &[
            (
                "main.ts",
                "import {outside} from './pkg'; export const local=outside;",
            ),
            ("pkg/package.json", "{\"main\":\"../../outside.ts\"}"),
        ],
        "on",
    );
    let main = observed["candidates"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["relPath"] == "main.ts")
        .unwrap();
    assert_eq!(main["reason"], "IMPORT_OUTSIDE_REPOSITORY");
    assert_eq!(main["analysisOutcome"], "failed");
    assert!(
        observed["files"]
            .as_array()
            .unwrap()
            .iter()
            .all(|file| file["relPath"] != "main.ts")
    );
}

fn failure_repository(label: &str) -> (PathBuf, PathBuf) {
    let base = std::env::var_os("SEMCTX_NATIVE_EVIDENCE")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("development-evidence/discovery")
        });
    let evidence = base.join(format!(
        "{label}-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let root = evidence.join("repository");
    fs::create_dir_all(&root).unwrap();
    (evidence, root)
}

#[test]
fn native_discovery_refuses_source_capture_over_the_limit() {
    let (evidence, root) = failure_repository("source-limit");
    fs::write(root.join("large.ts"), vec![b' '; 33_554_433]).unwrap();
    let observed = observe_root(&evidence, &root, "on");
    assert_eq!(observed["executed"], false);
    assert_eq!(observed["unsupported"], json!(["DISCOVERY_CAPTURE_LIMIT"]));
    assert!(observed.get("files").is_none());
}

#[test]
fn native_discovery_refuses_resolution_capture_over_the_limit() {
    let (evidence, root) = failure_repository("resolution-limit");
    fs::create_dir(root.join("pkg")).unwrap();
    fs::write(
        root.join("main.ts"),
        "import {leaf} from './pkg'; export const value=leaf;",
    )
    .unwrap();
    fs::write(root.join("pkg/index.ts"), "export const leaf=41;").unwrap();
    fs::write(root.join("pkg/package.json"), vec![b' '; 33_554_433]).unwrap();
    let observed = observe_root(&evidence, &root, "on");
    assert_eq!(observed["executed"], false);
    assert_eq!(
        observed["unsupported"],
        json!(["DISCOVERY_RESOLUTION_CAPTURE_LIMIT"])
    );
    assert!(observed.get("files").is_none());
}

#[cfg(unix)]
fn unreadable(path: &Path, observe: impl FnOnce() -> Value) -> Value {
    use std::os::unix::fs::PermissionsExt;
    let permissions = fs::metadata(path).unwrap().permissions();
    fs::set_permissions(path, fs::Permissions::from_mode(0o0)).unwrap();
    let observed = observe();
    fs::set_permissions(path, permissions).unwrap();
    observed
}

#[cfg(unix)]
#[test]
fn native_discovery_retains_a_selected_source_read_failure() {
    let (evidence, root) = failure_repository("source-read-failure");
    let source = root.join("main.ts");
    fs::write(&source, "export const value=43;").unwrap();
    let observed = unreadable(&source, || observe_root(&evidence, &root, "on"));
    assert_eq!(observed["executed"], true);
    assert_eq!(observed["files"], json!([]));
    assert_eq!(
        observed["candidates"],
        json!([{"relPath":"main.ts","language":"typescript","selectionDecision":"selected","analysisOutcome":"failed","reason":"READ_FAILED"}])
    );
    assert!(
        observed["reads"][0]["error"]
            .as_str()
            .is_some_and(|s| !s.is_empty())
    );
    assert!(observed["reads"][0].get("raw_bytes_sha256").is_none());
}

#[cfg(unix)]
#[test]
fn native_discovery_refuses_resolution_read_failure_without_falling_back() {
    let (evidence, root) = failure_repository("resolution-read-failure");
    fs::create_dir(root.join("pkg")).unwrap();
    fs::write(
        root.join("main.ts"),
        "import {leaf} from './pkg'; export const value=leaf;",
    )
    .unwrap();
    fs::write(root.join("pkg/index.ts"), "export const leaf=47;").unwrap();
    let metadata = root.join("pkg/package.json");
    fs::write(&metadata, "{\"main\":\"index.ts\"}").unwrap();
    let observed = unreadable(&metadata, || observe_root(&evidence, &root, "on"));
    assert_eq!(observed["executed"], false);
    assert!(
        observed["unsupported"][0]
            .as_str()
            .unwrap()
            .starts_with("DISCOVERY_RESOLUTION_READ_FAILED:")
    );
    assert!(observed.get("files").is_none());
}
