use semctx_gates::process;
use semctx_r0_probe::identity;
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    fs,
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};

const DEVELOPMENT: &str =
    include_str!("../../../docs/research/rust-ts-r0/cases/sources/development-cases.json");

fn check_projection(variant: &Value, actual: &Value) {
    let expected = &variant["expected_projection"];
    let subject = &actual["subjects"].as_array().unwrap()[0];
    if let Some(reasons) = expected.get("reasons_exact") {
        assert_eq!(subject["sourceParsingObservation"]["executed"], true);
        assert_eq!(&subject["sourceParsingObservation"]["reasons"], reasons);
    }
    if expected["reasons_nonempty"] == true {
        assert_eq!(subject["sourceParsingObservation"]["executed"], true);
        let reasons = subject["sourceParsingObservation"]["reasons"]
            .as_array()
            .unwrap();
        assert!(!reasons.is_empty());
        let prefix = expected["every_reason_prefix"].as_str().unwrap();
        assert!(
            reasons
                .iter()
                .all(|reason| reason.as_str().unwrap().starts_with(prefix))
        );
    }
    if let Some(function) = expected.get("function_matching_name_projection") {
        let matches = actual["raw_extraction"]["symbols"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|symbol| symbol["name"] == function["name"] && symbol["kind"] == "function")
            .collect::<Vec<_>>();
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0]["startLine"], function["startLine"]);
        assert_eq!(matches[0]["endLine"], function["endLine"]);
    }
}

#[test]
fn common_ts_js_native_vectors_preserve_frozen_development_projections() {
    let suite: Value = serde_json::from_str(DEVELOPMENT).unwrap();
    let crate_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let root = std::env::var_os("SEMCTX_NATIVE_EVIDENCE")
        .map(PathBuf::from)
        .unwrap_or_else(|| crate_root.join("development-evidence/native-portability"));
    let run = root.join(format!(
        "common-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir_all(&run).unwrap();
    let helper = PathBuf::from(
        std::env::var_os("SEMCTX_PROCESS_HELPER").expect("existing #383 supervisor required"),
    );
    let binary = PathBuf::from(env!("CARGO_BIN_EXE_semctx-r0-probe"));
    let sdk = crate_root.join("sdk/sdk-input.json");
    let binary_before = identity::digest_bytes(&fs::read(&binary).unwrap());
    let helper_before = identity::digest_bytes(&fs::read(&helper).unwrap());
    let mut completed = vec![];
    for record in suite["records"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|record| {
            matches!(
                record["id"].as_str(),
                Some("t00Development07ParsingRefusal" | "t00Development08Coordinates")
            )
        })
    {
        for variant in record["variants"].as_array().unwrap() {
            let id = variant["id"].as_str().unwrap();
            let workspace = run.join(id);
            fs::create_dir(&workspace).unwrap();
            fs::write(
                workspace.join("T00CaseSentinel"),
                b"native case observation",
            )
            .unwrap();
            let sensitive = !workspace.join("t00casesentinel").exists();
            fs::remove_file(workspace.join("T00CaseSentinel")).unwrap();
            let cwd = workspace
                .canonicalize()
                .unwrap()
                .to_string_lossy()
                .replace('\\', "/");
            let files = variant["files"]
                .as_object()
                .unwrap()
                .iter()
                .map(|(path, text)| (format!("{cwd}/{path}"), text.clone()))
                .collect::<BTreeMap<_, _>>();
            let roots = variant["input_manifest"]["roots"]
                .as_array()
                .unwrap()
                .iter()
                .map(|path| format!("{cwd}/{}", path.as_str().unwrap()))
                .collect::<Vec<_>>();
            let request = json!({"id":id,"cwd":cwd,"sdk_directory":"/sdk/lib","case_sensitive":sensitive,"roots":roots,"files":files,"options":{"target":"ES2022","module":"ESNext","moduleResolution":"Bundler","allowJs":true,"jsx":"Preserve","skipLibCheck":true,"noEmit":true,"strict":false},"retained":variant["input_manifest"]["retained_snapshot"],"qualified":false});
            let input = run.join(format!("{id}-request.json"));
            fs::write(&input, serde_json::to_vec_pretty(&request).unwrap()).unwrap();
            let argv = vec![
                binary.to_string_lossy().into_owned(),
                input.to_string_lossy().into_owned(),
                sdk.to_string_lossy().into_owned(),
            ];
            let outcome =
                process::run_with_helper(&argv, &workspace, 20_000, 8_388_608, &helper).unwrap();
            fs::write(
                run.join(format!("{id}-outcome.json")),
                serde_json::to_vec_pretty(&json!({"argv":argv,"cwd":workspace,"outcome":outcome}))
                    .unwrap(),
            )
            .unwrap();
            assert_eq!(outcome.kind, "success", "{id}: {outcome:?}");
            assert_eq!(outcome.exit_code, Some(0));
            let actual: Value = serde_json::from_str(&outcome.stdout).unwrap();
            check_projection(variant, &actual);
            let mut poison = actual.clone();
            if variant["expected_projection"]["reasons_nonempty"] == true {
                poison["subjects"][0]["sourceParsingObservation"]["reasons"] = json!([]);
            } else if variant["expected_projection"]
                .get("reasons_exact")
                .is_some()
            {
                poison["subjects"][0]["sourceParsingObservation"]["reasons"] =
                    json!(["SOURCE_PARSE_ERROR:synthetic"]);
            } else {
                poison["raw_extraction"]["symbols"] = json!([]);
            }
            assert!(
                std::panic::catch_unwind(|| check_projection(variant, &poison)).is_err(),
                "oracle accepted the representative missing/extra projection fault"
            );
            completed.push(json!({"id":id,"record":record["id"],"source_file_manifest":variant["input_manifest"]["files"],"expected_projection":variant["expected_projection"],"native_projection_matched":true,"oracle_rejected_poison":true,"stdout_hash":outcome.stdout_hash}));
        }
    }
    assert_eq!(completed.len(), 4);
    assert_eq!(
        binary_before,
        identity::digest_bytes(&fs::read(&binary).unwrap())
    );
    assert_eq!(
        helper_before,
        identity::digest_bytes(&fs::read(&helper).unwrap())
    );
    fs::write(run.join("common-vectors.json"), serde_json::to_vec_pretty(&json!({"allocation":"DEVELOPMENT_NOT_QUALIFICATION","fixture_sha256":identity::digest_bytes(DEVELOPMENT.as_bytes()),"producer_sha256":binary_before,"supervisor_sha256":helper_before,"sdk_input_sha256":identity::digest_bytes(&fs::read(&sdk).unwrap()),"os":std::env::consts::OS,"arch":std::env::consts::ARCH,"optimized":!cfg!(debug_assertions),"vectors":completed,"global_admission_inferred":false})).unwrap()).unwrap();
    eprintln!("native common portability evidence: {}", run.display());
}
