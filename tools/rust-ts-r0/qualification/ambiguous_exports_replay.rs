use super::*;
use semctx_r0_probe::{receiver::*, wire};
use std::time::{Duration, Instant};

fn expected_case(recipe: &Value) -> Result<Value, String> {
    let requests = recipe["requests"]
        .as_array()
        .ok_or("missing ambiguity requests")?;
    if requests.len() != 1 {
        return Err("ambiguity requires one captured request".into());
    }
    let request = &requests[0];
    value_text(request, "id")?;
    if request["qualified"] != true
        || request["retained"] != true
        || request["roles"] != json!({})
        || request["selection"] != json!({})
        || request["disabled"] != json!([])
        || request["utf16_files"] != json!({})
        || request["raw_files"] != json!({})
    {
        return Err("ambiguity requires the complete selected retained source context".into());
    }
    let files = request["files"]
        .as_object()
        .ok_or("missing ambiguity sources")?;
    let roots = request["roots"]
        .as_array()
        .ok_or("missing ambiguity roots")?;
    let paths = roots
        .iter()
        .map(|p| p.as_str().ok_or("invalid ambiguity root"))
        .collect::<Result<BTreeSet<_>, _>>()?;
    if paths.len() != roots.len() || paths != files.keys().map(String::as_str).collect() {
        return Err("ambiguity roots must cover every captured source exactly once".into());
    }
    let sources = files.iter().map(|(path, source)| {
        if !safe_relative(path) || !path.ends_with(".ts") || path.ends_with(".d.ts") {
            return Err("ambiguity requires confined TypeScript source roots".into());
        }
        let text = source.as_str().ok_or("ambiguity source is not text")?;
        Ok(json!({"path":path,"utf16_length":text.encode_utf16().count(),"line_count":text.bytes().filter(|b| *b == b'\n').count()+1}))
    }).collect::<Result<Vec<_>,String>>()?;
    let reasons = recipe["expected_ambiguity_reasons"]
        .as_array()
        .ok_or("missing frozen ambiguity reasons")?;
    let codes = reasons
        .iter()
        .map(|r| {
            r.as_str()
                .filter(|r| !r.is_empty())
                .ok_or("invalid ambiguity reason")
        })
        .collect::<Result<BTreeSet<_>, _>>()?;
    if codes.len() != reasons.len() {
        return Err("duplicate frozen ambiguity reason".into());
    }
    Ok(
        json!({"id":request["id"],"files":files,"expected_subject_ids":roots,"source_bytes":sources,"expected_reason_codes":reasons}),
    )
}

fn consume(
    case: &Value,
    request: &Value,
    sdk: &Value,
    outcome: &process::Outcome,
    artifact: Vec<u8>,
    raw: &Value,
    deadline: Instant,
) -> Result<Value, String> {
    let batch: wire::Batch = serde_json::from_str(&outcome.stdout).map_err(|e| e.to_string())?;
    let observed =
        receiver_context::bindings_and_observation_for_case(case, request, sdk, &batch, artifact);
    let expected_graph = json!({"nodes":raw["assembly"]["nodes"],"edges":raw["assembly"]["edges"]});
    if observed.graph != expected_graph {
        return Err("qualified batch graph differs from the independently bound raw graph".into());
    }
    let policy = receiver_context::expected(case, &observed, deadline);
    let receiver =
        Receiver::new(policy).map_err(|e| format!("invalid ambiguity consumer: {e:?}"))?;
    let receipt = receiver
        .receive(outcome, &observed.current())
        .map_err(|e| format!("ambiguity batch refused by receiver: {e:?}"))?;
    let refused = receipt.disposition() == EvidenceDisposition::ControlledRefusal;
    let ownership = match receiver.revalidate(&receipt, &observed.current()) {
        Err(Rejection::RefusalHasNoOwnership) if refused => false,
        Ok(_) if !refused => true,
        other => {
            return Err(format!(
                "unexpected ambiguity ownership result: {}",
                match other {
                    Ok(_) => "refusal acquired ownership".into(),
                    Err(error) => format!("{error:?}"),
                }
            ));
        }
    };
    Ok(
        json!({"qualified_admission_refused":refused,"consumer_disposition":if refused{"controlled_refusal"}else{"analyzed"},"private_graph_ownership":ownership,"global_admission_inferred":false,"batch_id":identity::digest(&serde_json::to_value(&batch).map_err(|e|e.to_string())?)}),
    )
}

pub(super) fn run(recipe: &Value, dir: &Path, fixture: &Value) -> Result<Value, String> {
    let case = expected_case(recipe)?;
    if !recipe["gaps"]
        .as_array()
        .ok_or("missing ambiguity gaps")?
        .is_empty()
    {
        return Err("ambiguity recipe still has explicit gaps".into());
    }
    let artifact = Path::new(value_text(fixture, "artifact_path")?);
    let helper = Path::new(value_text(fixture, "helper_path")?);
    let sdk_path = Path::new(value_text(fixture, "sdk_path")?);
    let sdk = read_json(sdk_path)?;
    for (path, field) in [
        (artifact, "artifact_sha256"),
        (helper, "helper_sha256"),
        (sdk_path, "sdk_sha256"),
    ] {
        exact_hash(path, value_text(fixture, field)?)?;
    }
    let raw_dir = dir.join("raw");
    let raw_result = run_raw_recipe(
        recipe,
        &raw_dir,
        artifact,
        helper,
        (sdk_path, &sdk),
        value_text(fixture, "artifact_sha256")?,
        value_text(fixture, "helper_sha256")?,
    )?;
    if raw_result["pass"] != true {
        return Ok(
            json!({"pass":false,"state":"AMBIGUITY_RAW_PROJECTION_NONPASS","raw":raw_result}),
        );
    }
    let request_path = raw_dir.join("request.json");
    let request = read_json(&request_path)?;
    let raw_outcome: process::Outcome =
        serde_json::from_value(read_json(&raw_dir.join("process-outcome.json"))?)
            .map_err(|e| e.to_string())?;
    let raw: Value = serde_json::from_str(&raw_outcome.stdout).map_err(|e| e.to_string())?;
    observation_bound_to_request(
        &raw,
        &request,
        &sdk,
        value_text(fixture, "artifact_sha256")?,
    )?;
    let paths = [artifact, helper, sdk_path, &request_path];
    let hashes = || {
        paths
            .iter()
            .map(|p| {
                fs::read(p)
                    .map(|bytes| sha(&bytes))
                    .map_err(|e| e.to_string())
            })
            .collect::<Result<Vec<_>, _>>()
    };
    let before = hashes()?;
    let argv = vec![
        artifact.to_string_lossy().into_owned(),
        "--batch".into(),
        request_path.to_string_lossy().into_owned(),
        sdk_path.to_string_lossy().into_owned(),
    ];
    let root = raw_dir.join("workspace");
    let deadline = Instant::now() + Duration::from_secs(20);
    let outcome = process::run_with_helper(&argv, &root, 20_000, 8_388_608, helper)
        .map_err(|e| e.to_string())?;
    let after = hashes()?;
    save(
        &dir.join("batch-process.json"),
        &json!({"argv":argv,"cwd":root,"paths":paths,"before":before,"after":after,"outcome":outcome}),
    )?;
    if before != after {
        return Err("ambiguity producer/input changed during batch consumption".into());
    }
    let consumed = consume(
        &case,
        &request,
        &sdk,
        &outcome,
        fs::read(artifact).map_err(|e| e.to_string())?,
        &raw,
        deadline,
    )?;
    let refused = !case["expected_reason_codes"]
        .as_array()
        .ok_or("missing ambiguity reasons")?
        .is_empty();
    let pass = consumed["qualified_admission_refused"] == refused
        && consumed["private_graph_ownership"] == !refused;
    let result = json!({"pass":pass,"state":if pass{"PASS_FROZEN_AMBIGUITY_AND_NATIVE_CONSUMER"}else{"NONPASS_AMBIGUITY_CONSUMER"},"raw":raw_result,"consumer":consumed,"global_admission_inferred":false});
    save(&dir.join("result.json"), &result)?;
    Ok(result)
}

#[test]
fn comparator_ambiguity_context_rejects_missing_or_partial_captured_sources() {
    let good = json!({"requests":[{"id":"dev-ambiguity-context","files":{"dev.ts":"export const probe = 19;"},"roots":["dev.ts"],"retained":true,"qualified":true,"roles":{},"selection":{},"disabled":[],"utf16_files":{},"raw_files":{}}],"expected_ambiguity_reasons":["DEV_AMBIGUITY"]});
    assert!(expected_case(&good).is_ok());
    for (field, value) in [
        ("id", Value::Null),
        ("qualified", json!(false)),
        ("retained", json!(false)),
        ("roles", json!({"dev.ts":"test"})),
        ("selection", json!({"dev.ts":"excluded"})),
        ("disabled", json!(["dev.ts"])),
        ("utf16_files", json!({"dev.ts":[1]})),
        ("raw_files", json!({"dev.ts":{}})),
        ("roots", json!([])),
        ("roots", json!(["dev.ts", "dev.ts"])),
        ("files", json!({"dev.ts":false})),
    ] {
        let mut bad = good.clone();
        bad["requests"][0][field] = value;
        assert!(expected_case(&bad).is_err(), "accepted invalid {field}");
    }
    for reasons in [Value::Null, json!([null]), json!([""]), json!(["A", "A"])] {
        let mut bad = good.clone();
        bad["expected_ambiguity_reasons"] = reasons;
        assert!(expected_case(&bad).is_err());
    }
}

#[test]
fn comparator_ambiguity_consumer_binds_refusal_to_input_graph_and_reason() {
    let recipe = json!({"requests":[{"id":"dev-ambiguity-consumer","files":{"dev.ts":"export const probe = 19;"},"roots":["dev.ts"],"retained":true,"qualified":true,"roles":{},"selection":{},"disabled":[],"utf16_files":{},"raw_files":{}}],"expected_ambiguity_reasons":["DEV_AMBIGUITY"]});
    let case = expected_case(&recipe).unwrap();
    let request = json!({"id":case["id"],"files":{"/dev/dev.ts":case["files"]["dev.ts"]},"roots":["/dev/dev.ts"],"cwd":"/dev","sdk_directory":"/sdk/lib","case_sensitive":true,"options":{},"retained":true,"qualified":true,"roles":{},"selection":{},"disabled":[],"utf16_files":{},"raw_files":{}});
    let sdk =
        json!({"files":{},"version":"development-sdk","archive_sha256":"development-archive"});
    let artifact = b"controlled-development-artifact".to_vec();
    let mut value = json!({"schema_version":1,"case_id":case["id"],"request_id":case["id"],"snapshot_id":"pending","scope_id":"pending","profile":"modelo-suite-static-v1","producer_artifact_id":"pending","input_manifest_id":"pending","capture_id":"pending","facts_id":"pending","graph_id":"pending","complete":true,"terminal":"refused","subjects":[{"subject_id":"dev.ts","selection":"selected","outcome":"unsupported","coverage":[]}],"facts":[],"diagnostics":[{"subject_id":"dev.ts","code":"DEV_AMBIGUITY","message":"DEV_AMBIGUITY"}],"input_observations":[]});
    let batch = serde_json::from_value(value.clone()).unwrap();
    let observed = receiver_context::bindings_and_observation_for_case(
        &case,
        &request,
        &sdk,
        &batch,
        artifact.clone(),
    );
    let bindings = observed.current().bindings().unwrap();
    for (key, id) in [
        ("snapshot_id", bindings.snapshot.as_str()),
        ("scope_id", bindings.scope.as_str()),
        ("producer_artifact_id", bindings.artifact.as_str()),
        ("input_manifest_id", bindings.input.as_str()),
        ("capture_id", bindings.capture.as_str()),
        ("facts_id", bindings.facts.as_str()),
        ("graph_id", bindings.graph.as_str()),
    ] {
        value[key] = json!(id);
    }
    let capture = |value: &Value| {
        let stdout = serde_json::to_string(value).unwrap();
        process::Outcome {
            kind: "success".into(),
            exit_code: Some(0),
            duration_ms: 1,
            stdout_bytes: stdout.len() as u64,
            stdout_hash: sha(stdout.as_bytes()),
            stdout,
            stderr: String::new(),
            stderr_bytes: 0,
            stderr_hash: sha(b""),
        }
    };
    let raw = json!({"assembly":{"nodes":[],"edges":[]}});
    let check = |case: &Value, request: &Value, outcome: &process::Outcome, raw: &Value| {
        consume(
            case,
            request,
            &sdk,
            outcome,
            artifact.clone(),
            raw,
            Instant::now() + Duration::from_secs(20),
        )
    };
    let outcome = capture(&value);
    let accepted = check(&case, &request, &outcome, &raw).unwrap();
    assert_eq!(accepted["qualified_admission_refused"], true);
    assert_eq!(accepted["private_graph_ownership"], false);
    let mut foreign_request = request.clone();
    foreign_request["files"]["/dev/dev.ts"] = json!("export const probe = 23;");
    assert!(check(&case, &foreign_request, &outcome, &raw).is_err());
    assert!(
        check(
            &case,
            &request,
            &outcome,
            &json!({"assembly":{"nodes":[],"edges":[{"kind":"calls"}]}})
        )
        .is_err()
    );
    for (key, changed) in [
        ("complete", json!(false)),
        ("terminal", json!("complete")),
        ("input_manifest_id", json!("foreign")),
        ("diagnostics", json!([])),
        ("subjects", json!([])),
    ] {
        let mut bad = value.clone();
        bad[key] = changed;
        assert!(
            check(&case, &request, &capture(&bad), &raw).is_err(),
            "accepted invalid {key}"
        );
    }
    let mut wrong = case.clone();
    wrong["expected_reason_codes"] = json!(["OTHER_AMBIGUITY"]);
    assert!(check(&wrong, &request, &outcome, &raw).is_err());
    let mut malformed = outcome.clone();
    malformed.stdout = "{".into();
    assert!(check(&case, &request, &malformed, &raw).is_err());
    let mut failed = outcome;
    failed.kind = "timeout".into();
    assert!(check(&case, &request, &failed, &raw).is_err());
}
