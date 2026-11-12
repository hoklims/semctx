use super::*;

fn projection(
    outcome: &process::Outcome,
    descriptor: &Value,
    sdk: &Value,
    artifact_sha: &str,
    leaf_checks: &[Value],
) -> Result<Value, String> {
    for (bytes, count, digest) in [
        (
            outcome.stdout.as_bytes(),
            outcome.stdout_bytes,
            &outcome.stdout_hash,
        ),
        (
            outcome.stderr.as_bytes(),
            outcome.stderr_bytes,
            &outcome.stderr_hash,
        ),
    ] {
        if count != bytes.len() as u64 || count > 8_388_608 || *digest != sha(bytes) {
            return Err("runtime capture is incomplete or unbound".into());
        }
    }
    if outcome.kind == "nonzero" && outcome.exit_code == Some(1) && outcome.stdout.is_empty() {
        let rejected: Value = serde_json::from_str(&outcome.stderr).map_err(|e| e.to_string())?;
        let error = rejected["error"]
            .as_str()
            .filter(|e| !e.is_empty())
            .ok_or("missing propagated runtime cause")?;
        if rejected.as_object().is_none_or(|fields| fields.len() != 1) {
            return Err("rejected runtime exposed unexpected result fields".into());
        }
        return Ok(
            json!({"runtime_state":"rejected","rejects":true,"error":error,"successful_runtime_result":false,"global_qualified_admission_inferred":false}),
        );
    }
    if outcome.kind != "success" || outcome.exit_code != Some(0) || !outcome.stderr.is_empty() {
        return Err("runtime process did not return a complete native result or rejection".into());
    }
    let observed: Value = serde_json::from_str(&outcome.stdout).map_err(|e| e.to_string())?;
    if observed["executed"] != true || leaf_checks.is_empty() {
        return Err("runtime success has no executed analysis or frozen leaf checks".into());
    }
    let binding = retained_discovery_complete_binding(&observed, descriptor, sdk, artifact_sha)?;
    let checked = leaf_checks
        .iter()
        .map(|check| evaluate(&observed, check))
        .collect::<Vec<_>>();
    let leaf_preserved = checked
        .iter()
        .all(|check| check["state"] == "PASS_PROJECTED_PROPERTY");
    let symbols = observed["native_analysis"]["raw_extraction"]["symbols"]
        .as_array()
        .ok_or("runtime native symbol list missing")?;
    let transient_absent = symbols.iter().all(|symbol| {
        symbol["name"]
            .as_str()
            .is_some_and(|name| name != "transient")
    });
    Ok(
        json!({"runtime_state":"analyzed","snapshot_mismatch_error":false,"retained_leaf_analysis_projection_preserved":leaf_preserved,"transient_symbol_forbidden":transient_absent,"global_qualified_admission_inferred":false,"native_analysis":observed["native_analysis"],"binding":binding,"leaf_checks":checked}),
    )
}

fn invoke(
    dir: &Path,
    root: &Path,
    descriptor: &Value,
    fixture: &Value,
    leaf_checks: &[Value],
) -> Result<Value, String> {
    fs::create_dir(dir).map_err(|e| e.to_string())?;
    let artifact = Path::new(value_text(fixture, "artifact_path")?);
    let helper = Path::new(value_text(fixture, "helper_path")?);
    let sdk_path = Path::new(value_text(fixture, "sdk_path")?);
    let artifact_sha = value_text(fixture, "artifact_sha256")?;
    let helper_sha = value_text(fixture, "helper_sha256")?;
    let sdk_sha = value_text(fixture, "sdk_sha256")?;
    exact_hash(artifact, artifact_sha)?;
    exact_hash(helper, helper_sha)?;
    exact_hash(sdk_path, sdk_sha)?;
    let request_path = dir.join("descriptor.json");
    save(&request_path, descriptor)?;
    let request_sha = sha(&fs::read(&request_path).map_err(|e| e.to_string())?);
    let argv = vec![
        artifact.to_string_lossy().into_owned(),
        "--analyze-retained-runtime".into(),
        request_path.to_string_lossy().into_owned(),
        sdk_path.to_string_lossy().into_owned(),
    ];
    let outcome = process::run_with_helper(&argv, root, 20_000, 8_388_608, helper)
        .map_err(|e| e.to_string())?;
    let captured = serde_json::to_value(&outcome).map_err(|e| e.to_string())?;
    save(&dir.join("process-outcome.json"), &captured)?;
    save(
        &dir.join("invocation.json"),
        &json!({"argv":argv,"cwd":root,"request_sha256":request_sha,"producer_sha256":artifact_sha,"helper_sha256":helper_sha,"sdk_sha256":sdk_sha,"outcome_id":identity::digest(&captured)}),
    )?;
    exact_hash(artifact, artifact_sha)?;
    exact_hash(helper, helper_sha)?;
    exact_hash(sdk_path, sdk_sha)?;
    exact_hash(&request_path, &request_sha)?;
    let observed = projection(
        &outcome,
        descriptor,
        &read_json(sdk_path)?,
        artifact_sha,
        leaf_checks,
    )?;
    save(&dir.join("consumed-result.json"), &observed)?;
    Ok(observed)
}

pub(super) fn run(recipe: &Value, dir: &Path, fixture: &Value) -> Result<Value, String> {
    if recipe["surface"] != "retained_runtime_cli"
        || recipe["gaps"]
            .as_array()
            .is_none_or(|gaps| !gaps.is_empty())
        || !matches!(
            recipe["runtime_expected_state"].as_str(),
            Some("analyzed" | "rejected")
        )
    {
        return Err("runtime recipe is incomplete or foreign".into());
    }
    let checks = recipe["checks"]
        .as_array()
        .filter(|c| !c.is_empty())
        .ok_or("missing runtime checks")?;
    let leaf_checks = recipe["leaf_checks"]
        .as_array()
        .filter(|c| !c.is_empty())
        .ok_or("missing frozen retained leaf projection")?;
    validate_component_checks(checks)?;
    validate_component_checks(leaf_checks)?;
    let root = dir.join("workspace");
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let sentinel = root.join("RetainedRuntimeCaseProbe");
    fs::write(&sentinel, b"case").map_err(|e| e.to_string())?;
    let sensitive = !root.join("retainedruntimecaseprobe").exists();
    fs::remove_file(sentinel).map_err(|e| e.to_string())?;
    let analysis = materialize(&recipe["capture_request"], &root, sensitive)?;
    let analysis_path = dir.join("captured-analysis.json");
    save(&analysis_path, &analysis)?;
    let analysis_sha = sha(&fs::read(&analysis_path).map_err(|e| e.to_string())?);
    let setup = apply_physical_post_capture(
        &analysis,
        &recipe["physical_live_after_capture"],
        &root,
        &analysis_path,
    )?;
    save(&dir.join("post-capture-setup.json"), &setup)?;
    let descriptor = json!({"analysis":analysis,"discovered_sources":recipe["discovered_sources"]});
    let control =
        json!({"analysis":analysis,"discovered_sources":recipe["consistent_discovered_sources"]});
    let before = invoke(
        &dir.join("healthy-before"),
        &root,
        &control,
        fixture,
        leaf_checks,
    )?;
    let observed = invoke(
        &dir.join("subject"),
        &root,
        &descriptor,
        fixture,
        leaf_checks,
    )?;
    let after = invoke(
        &dir.join("healthy-after"),
        &root,
        &control,
        fixture,
        leaf_checks,
    )?;
    exact_hash(&analysis_path, &analysis_sha)?;
    for (relative, text) in recipe["physical_live_after_capture"]
        .as_object()
        .ok_or("missing physical post-capture inventory")?
    {
        if fs::read(root.join(relative)).map_err(|e| e.to_string())?
            != text
                .as_str()
                .ok_or("invalid physical post-capture text")?
                .as_bytes()
        {
            return Err("physical post-capture bytes changed during native runtime calls".into());
        }
    }
    let healthy = |value: &Value| {
        value["runtime_state"] == "analyzed"
            && value["retained_leaf_analysis_projection_preserved"] == true
            && value["transient_symbol_forbidden"] == true
    };
    let checked = checks.iter().map(|check| json!({"expected_origin":check["expected_origin"],"target":check["target"],"result":evaluate(&observed,check)})).collect::<Vec<_>>();
    let pass = healthy(&before)
        && healthy(&after)
        && observed["runtime_state"] == recipe["runtime_expected_state"]
        && checked
            .iter()
            .all(|check| check["result"]["state"] == "PASS_PROJECTED_PROPERTY");
    let result = json!({"state":if pass{"PASS_FROZEN_RETAINED_RUNTIME_BOUNDARY"}else{"NONPASS_RETAINED_RUNTIME_BOUNDARY"},"pass":pass,"checks":checked,"observed":observed,"healthy_before":before,"healthy_after":after,"native_contexts":3,"global_admission_inferred":false});
    save(&dir.join("result.json"), &result)?;
    Ok(result)
}

#[test]
fn comparator_runtime_rejection_requires_real_failure_and_complete_cause() {
    let stderr = "{\"error\":\"SOURCE_SNAPSHOT_MISMATCH: controlled.ts\"}\n";
    let good = process::Outcome {
        kind: "nonzero".into(),
        exit_code: Some(1),
        duration_ms: 3,
        stdout: String::new(),
        stderr: stderr.into(),
        stdout_bytes: 0,
        stderr_bytes: stderr.len() as u64,
        stdout_hash: sha(b""),
        stderr_hash: sha(stderr.as_bytes()),
    };
    let projected = projection(&good, &json!({}), &json!({}), "controlled", &[]).unwrap();
    assert_eq!(projected["rejects"], true);
    assert_eq!(projected["successful_runtime_result"], false);
    assert!(projected.get("native_analysis").is_none());
    for (field, value) in [
        ("kind", json!("success")),
        ("kind", json!("timeout")),
        ("kind", json!("output_limit")),
        ("kind", json!("capture_error")),
        ("exit_code", json!(0)),
        ("exit_code", Value::Null),
        ("stdout", json!("{}")),
        ("stderr_bytes", json!(0)),
        ("stderr_hash", json!("0".repeat(64))),
    ] {
        let mut poisoned = serde_json::to_value(&good).unwrap();
        poisoned[field] = value;
        let poisoned: process::Outcome = serde_json::from_value(poisoned).unwrap();
        assert!(projection(&poisoned, &json!({}), &json!({}), "controlled", &[]).is_err());
    }
    for stderr in [
        "{}",
        "{\"error\":null}",
        "{\"error\":\"\"}",
        "{\"error\":\"x\",\"native_analysis\":{}}",
        "not JSON",
    ] {
        let mut poisoned = good.clone();
        poisoned.stderr = stderr.into();
        poisoned.stderr_bytes = stderr.len() as u64;
        poisoned.stderr_hash = sha(stderr.as_bytes());
        assert!(projection(&poisoned, &json!({}), &json!({}), "controlled", &[]).is_err());
    }
}
