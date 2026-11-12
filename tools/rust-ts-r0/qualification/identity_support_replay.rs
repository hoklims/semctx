use super::*;
use semctx_r0_probe::{receiver::*, wire};
use std::time::Duration;

fn unit<'a>(recipes: &'a Value, id: &str) -> Result<&'a Value, String> {
    recipes["recipes"]
        .as_array()
        .ok_or("identity unit recipes absent")?
        .iter()
        .find(|r| r["unit_id"] == id)
        .filter(|r| r["gaps"] == json!([]))
        .ok_or_else(|| format!("identity prerequisite unmapped: {id}"))
}

fn invoke(
    request: &Value,
    sdk: &Value,
    dir: &Path,
    fixture: &Value,
) -> Result<process::Outcome, String> {
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let request_path = dir.join("request.json");
    let sdk_path = dir.join("sdk.json");
    save(&request_path, request)?;
    save(&sdk_path, sdk)?;
    let artifact = Path::new(value_text(fixture, "artifact_path")?);
    let helper = Path::new(value_text(fixture, "helper_path")?);
    for (path, key) in [(artifact, "artifact_sha256"), (helper, "helper_sha256")] {
        exact_hash(path, value_text(fixture, key)?)?;
    }
    let argv = vec![
        artifact.to_string_lossy().into_owned(),
        "--batch".into(),
        request_path.to_string_lossy().into_owned(),
        sdk_path.to_string_lossy().into_owned(),
    ];
    let outcome = process::run_with_helper(
        &argv,
        Path::new(value_text(request, "cwd")?),
        20_000,
        8_388_608,
        helper,
    )
    .map_err(|e| e.to_string())?;
    save(
        &dir.join("invocation.json"),
        &json!({"argv":argv,"outcome":outcome}),
    )?;
    for (path, key) in [(artifact, "artifact_sha256"), (helper, "helper_sha256")] {
        exact_hash(path, value_text(fixture, key)?)?;
    }
    if outcome.kind != "success"
        || outcome.exit_code != Some(0)
        || !outcome.stderr.is_empty()
        || outcome.stdout_bytes != outcome.stdout.len() as u64
        || outcome.stderr_bytes != outcome.stderr.len() as u64
        || outcome.stdout_hash != sha(outcome.stdout.as_bytes())
        || outcome.stderr_hash != sha(outcome.stderr.as_bytes())
    {
        return Err("native identity batch process or complete capture failed".into());
    }
    Ok(outcome)
}

fn context(template: &Value) -> Result<Value, String> {
    let files = template["files"]
        .as_object()
        .ok_or("identity files absent")?;
    let roots = template["roots"]
        .as_array()
        .ok_or("identity roots absent")?;
    let sources = roots.iter().map(|path| {
        let path = path.as_str().ok_or("identity root not text")?;
        let text = files.get(path).and_then(Value::as_str).ok_or("identity root not captured")?;
        Ok(json!({"path":path,"utf16_length":text.encode_utf16().count(),"line_count":text.bytes().filter(|b|*b==b'\n').count()+1}))
    }).collect::<Result<Vec<_>, String>>()?;
    Ok(
        json!({"id":template["id"],"files":files,"expected_subject_ids":roots,"source_bytes":sources,"expected_reason_codes":[]}),
    )
}

fn paired_batches(
    recipe: &Value,
    recipes: &Value,
    dir: &Path,
    fixture: &Value,
) -> Result<Value, String> {
    let template = &unit(recipes, "P01-retained-source::base")?["requests"][0];
    let case = context(template)?;
    let artifact = fs::read(value_text(fixture, "artifact_path")?).map_err(|e| e.to_string())?;
    let sdk_path = Path::new(value_text(fixture, "sdk_path")?);
    exact_hash(sdk_path, value_text(fixture, "sdk_sha256")?)?;
    let sdk = read_json(sdk_path)?;
    let root = dir.join("original");
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    fs::write(root.join("CaseModeProbe"), b"case").map_err(|e| e.to_string())?;
    let sensitive = !root.join("casemodeprobe").exists();
    fs::remove_file(root.join("CaseModeProbe")).map_err(|e| e.to_string())?;
    let request = materialize(template, &root, sensitive)?;
    let original = invoke(&request, &sdk, &dir.join("before"), fixture)?;
    let batch: wire::Batch = serde_json::from_str(&original.stdout).map_err(|e| e.to_string())?;
    let observed = receiver_context::bindings_and_observation_for_case(
        &case,
        &request,
        &sdk,
        &batch,
        artifact.clone(),
    );
    let receiver = receiver_context::ready_receiver(&case, &observed, Duration::from_secs(20));
    let receipt = receiver
        .receive(&original, &observed.current())
        .map_err(|e| format!("original identity batch rejected: {e:?}"))?;
    if receipt.disposition() != EvidenceDisposition::Analyzed {
        return Err("original identity batch was not analyzed".into());
    }
    let relocation = recipe["support_id"] == "IDENTITY::I-relocation";
    let mut other_case = case.clone();
    let mut other_sdk = sdk.clone();
    let other = if relocation {
        let other_root = dir.join("relocated");
        fs::create_dir_all(&other_root).map_err(|e| e.to_string())?;
        let mut other = materialize(template, &other_root, sensitive)?;
        let prefix = format!("{}/", value_text(&request, "sdk_directory")?);
        let relocated = "/relocated-sdk/lib";
        other["sdk_directory"] = json!(relocated);
        other_sdk["files"] = json!(
            sdk["files"]
                .as_object()
                .ok_or("SDK file map absent")?
                .iter()
                .map(|(p, t)| {
                    let relative = p
                        .strip_prefix(&prefix)
                        .ok_or("SDK file outside original root")?;
                    Ok((format!("{relocated}/{relative}"), t.clone()))
                })
                .collect::<Result<BTreeMap<_, _>, String>>()?
        );
        other
    } else {
        let mut other = request.clone();
        other["id"] = json!(format!("{}-different-request", value_text(&request, "id")?));
        other_case["id"] = other["id"].clone();
        other
    };
    let second = invoke(&other, &other_sdk, &dir.join("subject"), fixture)?;
    let second_batch: wire::Batch =
        serde_json::from_str(&second.stdout).map_err(|e| e.to_string())?;
    let second_observed = receiver_context::bindings_and_observation_for_case(
        &other_case,
        &other,
        &other_sdk,
        &second_batch,
        artifact,
    );
    let second_receipt =
        receiver_context::ready_receiver(&other_case, &second_observed, Duration::from_secs(20))
            .receive(&second, &second_observed.current())
            .map_err(|e| format!("second identity batch rejected: {e:?}"))?;
    let reused = receiver_context::ready_receiver(&case, &observed, Duration::from_secs(20))
        .receive(&second, &second_observed.current());
    let stable = observed.input == second_observed.input
        && observed.capture == second_observed.capture
        && observed.snapshot == second_observed.snapshot
        && batch.input_manifest_id == second_batch.input_manifest_id
        && batch.capture_id == second_batch.capture_id
        && batch.snapshot_id == second_batch.snapshot_id
        && batch.producer_artifact_id == second_batch.producer_artifact_id;
    let relation = if relocation {
        observed.scope != second_observed.scope && batch.scope_id != second_batch.scope_id
    } else {
        observed.scope == second_observed.scope
            && batch.request_id != second_batch.request_id
            && identity::digest(&request) != identity::digest(&other)
    };
    let restored = invoke(&request, &sdk, &dir.join("after"), fixture)?;
    let after_receipt = receiver_context::ready_receiver(&case, &observed, Duration::from_secs(20))
        .receive(&restored, &observed.current())
        .map_err(|e| format!("restored identity batch rejected: {e:?}"))?;
    let pass = stable
        && relation
        && matches!(reused, Err(Rejection::IdentityMismatch))
        && second_receipt.disposition() == EvidenceDisposition::Analyzed
        && after_receipt.disposition() == EvidenceDisposition::Analyzed;
    Ok(
        json!({"pass":pass,"stable_content_bindings":stable,"relation_satisfied":relation,"old_receiver_rejected":reused.is_err(),"old_receiver_rejection":format!("{:?}",reused.as_ref().err()),"before_batch_hash":original.stdout_hash,"subject_batch_hash":second.stdout_hash,"after_batch_hash":restored.stdout_hash,"original_request_descriptor_id":identity::digest(&request),"other_request_descriptor_id":identity::digest(&other),"input_manifest_id":batch.input_manifest_id,"capture_id":batch.capture_id,"snapshot_id":batch.snapshot_id,"sdk_logical_id":identity::digest(&observed.input["sdk"]),"producer_artifact_id":batch.producer_artifact_id,"original_scope_id":batch.scope_id,"other_scope_id":second_batch.scope_id,"native_contexts":3,"global_admission_inferred":false}),
    )
}

fn default_library_read(result: &Value) -> bool {
    result["bound_observations"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|row| row["read_provenance"]["state"] == "JOINED_REPORTED_SUCCESSFUL_READS_ONLY")
        .filter_map(|row| row["read_provenance"]["read_paths"].as_array())
        .flatten()
        .filter_map(Value::as_str)
        .any(|path| path.ends_with("/lib.es2022.full.d.ts"))
}

pub(super) fn run(
    recipe: &Value,
    dir: &Path,
    fixture: &Value,
    recipes: &Value,
) -> Result<Value, String> {
    if recipe["surface"] != "identity_support_cli" || recipe["gaps"] != json!([]) {
        return Err("identity support recipe is incomplete".into());
    }
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let id = value_text(recipe, "support_id")?;
    let result = match id {
        "IDENTITY::I-relocation" | "IDENTITY::I-request-separation" => {
            paired_batches(recipe, recipes, dir, fixture)?
        }
        "IDENTITY::complete-baseline-specimen" => {
            let baseline = unit(
                recipes,
                "P25-byte-identity-relocation::identity-relation-01",
            )?;
            for key in ["schemaVersion", "files", "compiler", "digest"] {
                if recipe["frozen_identity_projection"][key]
                    != baseline["baseline_expected_identity"][key]
                {
                    return Err("support baseline and frozen unit specimens differ".into());
                }
            }
            legacy_identity_replay::run(baseline, &dir.join("baseline"), fixture)?
        }
        "IDENTITY::I-capture-mismatch" | "IDENTITY::I-sdk-supplied-vs-consumed" => {
            let positive = retained_runtime_replay::run(
                unit(recipes, "P01-retained-source::plane-a-runtime-consistent")?,
                &dir.join("retained"),
                fixture,
            )?;
            let negative = retained_runtime_replay::run(
                unit(
                    recipes,
                    "N01-snapshot-metadata-mismatch::plane-a-runtime-mismatch",
                )?,
                &dir.join("mismatch"),
                fixture,
            )?;
            let mut pass = positive["pass"] == true && negative["pass"] == true;
            let mut reads = Value::Null;
            if id == "IDENTITY::I-sdk-supplied-vs-consumed" {
                let artifact = Path::new(value_text(fixture, "artifact_path")?);
                let helper = Path::new(value_text(fixture, "helper_path")?);
                let sdk_path = Path::new(value_text(fixture, "sdk_path")?);
                exact_hash(sdk_path, value_text(fixture, "sdk_sha256")?)?;
                let sdk = read_json(sdk_path)?;
                reads = run_raw_recipe(
                    unit(recipes, "P01-retained-source::base")?,
                    &dir.join("native-reads"),
                    artifact,
                    helper,
                    (sdk_path, &sdk),
                    value_text(fixture, "artifact_sha256")?,
                    value_text(fixture, "helper_sha256")?,
                )?;
                pass &= reads["pass"] == true && default_library_read(&reads);
            }
            json!({"pass":pass,"retained_control":positive,"capture_mismatch":negative,"native_reads":reads,"atomic_live_acquisition_claimed":false,"all_supplied_sdk_consumed_claimed":false,"global_admission_inferred":false})
        }
        _ => return Err("unknown frozen identity support".into()),
    };
    save(&dir.join("identity-support-result.json"), &result)?;
    Ok(result)
}

#[test]
fn comparator_identity_support_default_library_requires_successful_joined_read() {
    let good = json!({"bound_observations":[{"read_provenance":{"state":"JOINED_REPORTED_SUCCESSFUL_READS_ONLY","read_paths":["/sdk/lib/lib.es2022.full.d.ts"]}}]});
    assert!(default_library_read(&good));
    for bad in [
        Value::Null,
        json!({"bound_observations":[]}),
        json!({"bound_observations":[{"read_provenance":{"state":"READ_PROVENANCE_REJECTED","read_paths":["/sdk/lib/lib.es2022.full.d.ts"]}}]}),
        json!({"bound_observations":[{"read_provenance":{"state":"JOINED_REPORTED_SUCCESSFUL_READS_ONLY","read_paths":["/sdk/lib/lib.es2022.d.ts"]}}]}),
        json!({"bound_observations":[{"read_provenance":{"state":"JOINED_REPORTED_SUCCESSFUL_READS_ONLY","read_paths":null}}]}),
    ] {
        assert!(!default_library_read(&bad));
    }
}
