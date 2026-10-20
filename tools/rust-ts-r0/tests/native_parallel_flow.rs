use semctx_gates::process;
use semctx_r0_probe::identity;
use serde_json::{Value, json};
use std::{
    fs,
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};

fn write(path: &std::path::Path, value: &Value) {
    fs::write(path, serde_json::to_vec_pretty(value).unwrap()).unwrap();
}

#[test]
fn native_parallel_workers_preserve_shared_declarations_and_exact_direct_extraction() {
    let crate_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let base = std::env::var_os("SEMCTX_NATIVE_EVIDENCE")
        .map(PathBuf::from)
        .unwrap_or_else(|| crate_root.join("development-evidence/native-parallel"));
    let evidence = base.join(format!(
        "parallel-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let root = evidence.join("workspace");
    fs::create_dir_all(&root).unwrap();
    let root = root.canonicalize().unwrap();
    let files = json!({
        "globals.d.ts":"declare interface DevelopmentSharedShape { value: string }\n",
        "packages/a/index.ts":"export function developmentA(input: DevelopmentSharedShape) { return input.value }\n",
        "packages/b/index.ts":"export function developmentB(input: DevelopmentSharedShape) { return input.value.length }\n"
    });
    for (path, text) in files.as_object().unwrap() {
        let target = root.join(path);
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        fs::write(target, text.as_str().unwrap()).unwrap();
    }
    let producer = PathBuf::from(env!("CARGO_BIN_EXE_semctx-r0-probe"));
    let helper = PathBuf::from(
        std::env::var_os("SEMCTX_PROCESS_HELPER").expect("compiled #383 helper required"),
    );
    let sdk = crate_root.join("sdk/sdk-input.json");
    let root_text = root.to_str().unwrap().replace('\\', "/");
    let roots = files
        .as_object()
        .unwrap()
        .keys()
        .map(|path| format!("{root_text}/{path}"))
        .collect::<Vec<_>>();
    let mut outputs = vec![];
    for workers in [1, 2] {
        let request = json!({"repoRoot":root_text,"rootAbsPaths":roots,"workers":workers});
        let request_path = evidence.join(format!("request-{workers}.json"));
        write(&request_path, &request);
        let argv = vec![
            producer.to_str().unwrap().to_owned(),
            "--extract-parallel".into(),
            request_path.to_str().unwrap().into(),
            sdk.to_str().unwrap().into(),
            helper.to_str().unwrap().into(),
        ];
        let before = identity::digest_bytes(&fs::read(&producer).unwrap());
        let outcome = process::run_with_helper(&argv, &root, 20_000, 8_388_608, &helper).unwrap();
        write(
            &evidence.join(format!("outcome-{workers}.json")),
            &serde_json::to_value(&outcome).unwrap(),
        );
        assert_eq!(
            identity::digest_bytes(&fs::read(&producer).unwrap()),
            before
        );
        assert_eq!(outcome.kind, "success", "{}", outcome.stderr);
        let observed: Value = serde_json::from_str(&outcome.stdout).unwrap();
        assert_eq!(observed["executed"], true, "{observed}");
        assert_eq!(observed["parallelism"]["used"], workers);
        assert_eq!(
            observed["parallelism"]["mode"],
            if workers == 1 { "single" } else { "parallel" }
        );
        assert_eq!(
            observed["extraction"]["modules"],
            json!(["packages/a/index.ts", "packages/b/index.ts"])
        );
        assert_eq!(observed["globalAdmissionInferred"], false);
        if workers == 2 {
            let jobs = observed["jobs"].as_array().unwrap();
            assert_eq!(jobs.len(), 2);
            let mut pids = std::collections::BTreeSet::new();
            for job in jobs {
                assert_eq!(job["outcome"]["kind"], "success");
                let response: Value =
                    serde_json::from_str(job["outcome"]["stdout"].as_str().unwrap()).unwrap();
                assert!(pids.insert(response["producer_process_id"].as_u64().unwrap()));
                assert!(
                    job["request"]["rootAbsPaths"]
                        .as_array()
                        .unwrap()
                        .contains(&json!(format!("{root_text}/globals.d.ts")))
                );
                assert!(
                    response["compiler_probes"].as_array().unwrap().iter().any(
                        |probe| probe["path"] == format!("{root_text}/globals.d.ts")
                            && probe["operation"] == "read_file"
                            && probe["found"] == true
                    )
                );
            }
        }
        outputs.push(observed);
    }
    assert_eq!(
        serde_json::to_vec(&outputs[0]["extraction"]).unwrap(),
        serde_json::to_vec(&outputs[1]["extraction"]).unwrap()
    );
    let direct = json!({"id":"parallel-development-direct","cwd":root_text,"sdk_directory":"/sdk/lib","case_sensitive":ts_goport::frontend::vfs::osvfs_fs().use_case_sensitive_file_names(),"roots":roots,"files":files.as_object().unwrap().iter().map(|(path,text)|(format!("{root_text}/{path}"),text.clone())).collect::<serde_json::Map<_,_>>(),"options":{"target":"ES2022","module":"ESNext","moduleResolution":"Bundler","allowJs":true,"jsx":"Preserve","skipLibCheck":true,"noEmit":true,"strict":false},"retained":false,"qualified":false});
    let path = evidence.join("direct.json");
    write(&path, &direct);
    let argv = vec![
        producer.to_str().unwrap().to_owned(),
        path.to_str().unwrap().into(),
        sdk.to_str().unwrap().into(),
    ];
    let outcome = process::run_with_helper(&argv, &root, 20_000, 8_388_608, &helper).unwrap();
    write(
        &evidence.join("direct-outcome.json"),
        &serde_json::to_value(&outcome).unwrap(),
    );
    assert_eq!(outcome.kind, "success", "{}", outcome.stderr);
    let observed: Value = serde_json::from_str(&outcome.stdout).unwrap();
    assert_eq!(
        serde_json::to_vec(&outputs[0]["extraction"]).unwrap(),
        serde_json::to_vec(&observed["raw_extraction"]).unwrap()
    );
}

fn parallel_probe(files: Value, workers: Value, sdk_override: Option<Value>) -> Value {
    let crate_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let base = std::env::var_os("SEMCTX_NATIVE_EVIDENCE")
        .map(PathBuf::from)
        .unwrap_or_else(|| crate_root.join("development-evidence/native-parallel"));
    let evidence = base.join(format!(
        "parallel-control-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let root = evidence.join("workspace");
    fs::create_dir_all(&root).unwrap();
    let root = root.canonicalize().unwrap();
    for (path, text) in files.as_object().unwrap() {
        let target = root.join(path);
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        fs::write(target, text.as_str().unwrap()).unwrap();
    }
    let repo = root.to_str().unwrap().replace('\\', "/");
    let roots = files
        .as_object()
        .unwrap()
        .keys()
        .map(|p| format!("{repo}/{p}"))
        .collect::<Vec<_>>();
    let request = json!({"repoRoot":repo,"rootAbsPaths":roots,"workers":workers});
    let path = evidence.join("request.json");
    write(&path, &request);
    let sdk = if let Some(sdk) = sdk_override {
        let p = evidence.join("foreign-sdk.json");
        write(&p, &sdk);
        p
    } else {
        crate_root.join("sdk/sdk-input.json")
    };
    let helper = PathBuf::from(
        std::env::var_os("SEMCTX_PROCESS_HELPER").expect("compiled #383 helper required"),
    );
    let argv = vec![
        env!("CARGO_BIN_EXE_semctx-r0-probe").into(),
        "--extract-parallel".into(),
        path.to_str().unwrap().into(),
        sdk.to_str().unwrap().into(),
        helper.to_str().unwrap().into(),
    ];
    let outcome = process::run_with_helper(&argv, &root, 20_000, 8_388_608, &helper).unwrap();
    write(
        &evidence.join("outcome.json"),
        &serde_json::to_value(&outcome).unwrap(),
    );
    assert_eq!(outcome.kind, "success", "{}", outcome.stderr);
    serde_json::from_str(&outcome.stdout).unwrap()
}

#[test]
fn native_parallel_preflight_keeps_unsafe_or_connected_roots_single() {
    let connected = parallel_probe(
        json!({"a.ts":"import { b } from './b'; export const a = b + 1\n","b.ts":"export const b = 3\n"}),
        json!(2),
        None,
    );
    assert_eq!(connected["executed"], true);
    assert_eq!(connected["parallelism"]["mode"], "single");
    assert_eq!(
        connected["parallelism"]["reason"],
        "TypeScript root module graph has one connected component"
    );
    assert_eq!(connected["jobs"], json!([]));
    for files in [
        json!({"a.ts":"var developmentGlobal = 5\n","b.ts":"export const developmentModule = 7\n"}),
        json!({"a.ts":"/// <reference path='./b.ts' />\nexport const developmentReference = 11\n","b.ts":"export const developmentTarget = 13\n"}),
        json!({"a.ts":"export const developmentParse = ;\n","b.ts":"export const developmentValid = 17\n"}),
        json!({"a.ts":"export {}; declare global { interface DevelopmentAugmentation { x: number } }\n","b.ts":"export const developmentOther = 19\n"}),
    ] {
        let value = parallel_probe(files, json!(2), None);
        assert_eq!(value["executed"], true, "{value}");
        assert_eq!(value["parallelism"]["used"], 1);
        assert_eq!(value["parallelism"]["mode"], "preflight-fallback");
        assert!(
            value["parallelism"]["reason"]
                .as_str()
                .is_some_and(|s| !s.is_empty())
        );
        assert_eq!(value["jobs"], json!([]));
    }
}

#[test]
fn native_parallel_worker_failure_requests_cancellation_and_never_returns_serial_facts() {
    let sdk_path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("sdk/sdk-input.json");
    let mut sdk: Value = serde_json::from_slice(&fs::read(sdk_path).unwrap()).unwrap();
    sdk["version"] = json!("development-foreign-sdk");
    let value = parallel_probe(
        json!({"a.ts":"export const developmentWorkerA = 23\n","b.ts":"export const developmentWorkerB = 29\n"}),
        json!(2),
        Some(sdk),
    );
    assert_eq!(value["executed"], false, "{value}");
    assert!(value.get("extraction").is_none());
    assert!(value.get("parallelism").is_none());
    assert_eq!(value["workerCancellationRequested"], true);
    assert_eq!(value["jobs"].as_array().unwrap().len(), 2);
    assert!(value["jobs"].as_array().unwrap().iter().any(|job| {
        job["outcome"]["stdout"]
            .as_str()
            .and_then(|s| serde_json::from_str::<Value>(s).ok())
            .is_some_and(|v| v["ok"] == false && v["error"] == "foreign SDK descriptor")
    }));
}

#[test]
fn native_parallel_malformed_worker_counts_refuse_without_dispatch() {
    for workers in [json!(0), json!(9), json!(1.5), json!("auto")] {
        let value = parallel_probe(
            json!({"development.ts":"export const developmentInvalidCount = 31\n"}),
            workers,
            None,
        );
        assert_eq!(value["executed"], false, "{value}");
        assert_eq!(value["jobs"], json!([]));
        assert!(value.get("extraction").is_none());
        assert!(!value["unsupported"].as_array().unwrap().is_empty());
    }
}
