use super::*;

fn complete_capture(outcome: &process::Outcome) -> Result<(), String> {
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
        if bytes.len() as u64 != count || count > 8_388_608 || sha(bytes) != *digest {
            return Err("qualified flow capture is incomplete or substituted".into());
        }
    }
    Ok(())
}

fn captured_cli_report(outcome: &process::Outcome) -> Result<Value, String> {
    complete_capture(outcome)?;
    if !outcome.stderr.is_empty()
        || !matches!(
            (outcome.kind.as_str(), outcome.exit_code),
            ("success", Some(0)) | ("nonzero", Some(3))
        )
    {
        return Err("qualified CLI returned no supported complete verification result".into());
    }
    let report: Value = serde_json::from_str(&outcome.stdout).map_err(|e| e.to_string())?;
    let admission = value_text(&report["analysisAdmission"], "status")?;
    if !matches!(
        (admission, outcome.exit_code),
        ("admitted", Some(0)) | ("rejected", Some(3))
    ) || (admission == "rejected" && report["verdict"] != "BLOCK")
    {
        return Err("qualified CLI ignored the consumed admission under fail-on none".into());
    }
    Ok(report)
}

fn projection(
    outcome: &process::Outcome,
    descriptor: &Value,
    sdk: &Value,
    artifact_sha: &str,
) -> Result<Value, String> {
    let report = captured_cli_report(outcome)?;
    if report["request_descriptor_id"] != identity::digest(descriptor)
        || report["producer_artifact_id"] != format!("sha256:{artifact_sha}")
        || report["sdk_input_id"] != identity::digest(sdk)
        || report["indexed_extraction_received"] != true
        || report["global_admission_inferred"] != false
    {
        return Err("qualified verification result is incomplete or foreign".into());
    }
    let admission = value_text(&report["analysisAdmission"], "status")?;
    let selected = &descriptor["index"]["analysis"];
    observation_bound_to_request(&report["selected_analysis"], selected, sdk, artifact_sha)?;
    let mut broad = selected.clone();
    broad["roots"] = json!(
        selected["files"]
            .as_object()
            .ok_or("indexed files absent")?
            .keys()
            .filter(
                |p| [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]
                    .iter()
                    .any(|s| p.ends_with(s))
            )
            .collect::<Vec<_>>()
    );
    observation_bound_to_request(&report["broad_analysis"], &broad, sdk, artifact_sha)?;
    let subject = report["selected_analysis"]["subjects"]
        .as_array()
        .and_then(|v| v.first())
        .ok_or("selected native subject missing")?;
    let configuration = &subject["moduleConfigurationObservations"]["retainedWithSource"];
    if configuration["executed"] != true
        || configuration["unsupported"] != json!([])
        || configuration["reasons"] != json!([])
        || report["inherited_configuration"]["executed"] != true
        || report["inherited_configuration"]["consumed"] != subject["configurationConsumed"]
    {
        return Err("qualified inherited configuration was not consumed".into());
    }
    let consumed = subject["configurationConsumed"]
        .as_array()
        .ok_or("configuration read inventory missing")?;
    for name in ["tsconfig.json", "base.json"] {
        if !consumed.contains(&json!(format!("{}/{name}", value_text(selected, "cwd")?))) {
            return Err(format!(
                "inherited configuration input was not read: {name}"
            ));
        }
    }
    for field in ["head_git_outcome", "changed_git_outcome"] {
        let git: process::Outcome =
            serde_json::from_value(report[field].clone()).map_err(|e| e.to_string())?;
        complete_capture(&git)?;
        if git.kind != "success" || git.exit_code != Some(0) {
            return Err("qualified Git observation did not complete".into());
        }
    }
    Ok(
        json!({"analysisAdmission_status":admission,"verdict":report["verdict"],"public_cli_exit":outcome.exit_code,"coverage":report["analysisAdmission"]["changeCoverage"]["files"],"native_report_id":identity::digest(&report)}),
    )
}

pub(super) fn run(recipe: &Value, dir: &Path, fixture: &Value) -> Result<Value, String> {
    if recipe["surface"] != "qualified_flow_cli"
        || recipe["gaps"].as_array().is_none_or(|g| !g.is_empty())
    {
        return Err("qualified flow recipe is incomplete".into());
    }
    let checks = recipe["checks"]
        .as_array()
        .filter(|c| !c.is_empty())
        .ok_or("qualified flow checks missing")?;
    validate_component_checks(checks)?;
    let artifact = Path::new(value_text(fixture, "artifact_path")?);
    let helper = Path::new(value_text(fixture, "helper_path")?);
    let sdk_path = Path::new(value_text(fixture, "sdk_path")?);
    let artifact_sha = value_text(fixture, "artifact_sha256")?;
    for (path, key) in [
        (artifact, "artifact_sha256"),
        (helper, "helper_sha256"),
        (sdk_path, "sdk_sha256"),
    ] {
        exact_hash(path, value_text(fixture, key)?)?;
    }
    let root = dir.join("workspace");
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    for (relative, text) in recipe["physical_files"]
        .as_object()
        .ok_or("initial Git files absent")?
    {
        if !safe_relative(relative) {
            return Err("unsafe qualified fixture path".into());
        }
        let path = root.join(relative);
        fs::create_dir_all(path.parent().ok_or("fixture parent missing")?)
            .map_err(|e| e.to_string())?;
        fs::write(path, text.as_str().ok_or("fixture text absent")?).map_err(|e| e.to_string())?;
    }
    for (index, args) in [
        vec!["init", "-q"],
        vec!["add", "."],
        vec![
            "-c",
            "user.name=T00Fixture",
            "-c",
            "user.email=t00@example.test",
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
        let outcome = process::run_with_helper(&argv, &root, 5_000, 8_388_608, helper)
            .map_err(|e| e.to_string())?;
        save(
            &dir.join(format!("git-setup-{index}.json")),
            &json!({"argv":argv,"outcome":outcome}),
        )?;
        complete_capture(&outcome)?;
        if outcome.kind != "success" || outcome.exit_code != Some(0) {
            return Err("qualified Git initialization failed".into());
        }
    }
    let sentinel = root.join("QualifiedFlowCaseProbe");
    fs::write(&sentinel, b"case").map_err(|e| e.to_string())?;
    let sensitive = !root.join("qualifiedflowcaseprobe").exists();
    fs::remove_file(sentinel).map_err(|e| e.to_string())?;
    let request = materialize(&recipe["requests"][0], &root, sensitive)?;
    let request_path = dir.join("index-request.json");
    save(&request_path, &request)?;
    let request_sha = sha(&fs::read(&request_path).map_err(|e| e.to_string())?);
    let head_argv = vec![
        "git".into(),
        "rev-parse".into(),
        "--verify".into(),
        "HEAD".into(),
    ];
    let head = process::run_with_helper(&head_argv, &root, 5_000, 8_388_608, helper)
        .map_err(|e| e.to_string())?;
    complete_capture(&head)?;
    if head.kind != "success" || head.exit_code != Some(0) {
        return Err("qualified indexed Git head unavailable".into());
    }
    save(
        &dir.join("index-head.json"),
        &json!({"argv":head_argv,"outcome":head}),
    )?;
    let index_argv = vec![
        artifact.to_string_lossy().into_owned(),
        "--batch".into(),
        request_path.to_string_lossy().into_owned(),
        sdk_path.to_string_lossy().into_owned(),
    ];
    let index = process::run_with_helper(&index_argv, &root, 20_000, 8_388_608, helper)
        .map_err(|e| e.to_string())?;
    save(
        &dir.join("index-invocation.json"),
        &json!({"argv":index_argv,"outcome":index}),
    )?;
    complete_capture(&index)?;
    if index.kind != "success" || index.exit_code != Some(0) {
        return Err("qualified retained index failed".into());
    }
    let descriptor = json!({"repositoryRoot":request["cwd"],"processHelper":helper,"include":recipe["include"],"exclude":recipe["exclude"],"index":{"analysis":request,"outcome":index,"baseCommit":head.stdout.trim()}});
    let descriptor_path = dir.join("verify-descriptor.json");
    save(&descriptor_path, &descriptor)?;
    let descriptor_sha = sha(&fs::read(&descriptor_path).map_err(|e| e.to_string())?);
    let argv = vec![
        artifact.to_string_lossy().into_owned(),
        "verify".into(),
        "working-tree".into(),
        descriptor_path.to_string_lossy().into_owned(),
        sdk_path.to_string_lossy().into_owned(),
        "--fail-on".into(),
        "none".into(),
    ];
    let outcome = process::run_with_helper(&argv, &root, 20_000, 8_388_608, helper)
        .map_err(|e| e.to_string())?;
    save(
        &dir.join("verify-invocation.json"),
        &json!({"argv":argv,"cwd":root,"outcome":outcome,"descriptor_sha256":descriptor_sha,"producer_sha256":artifact_sha}),
    )?;
    let observed = projection(&outcome, &descriptor, &read_json(sdk_path)?, artifact_sha)?;
    for (path, key) in [
        (artifact, "artifact_sha256"),
        (helper, "helper_sha256"),
        (sdk_path, "sdk_sha256"),
    ] {
        exact_hash(path, value_text(fixture, key)?)?;
    }
    exact_hash(&request_path, &request_sha)?;
    exact_hash(&descriptor_path, &descriptor_sha)?;
    let checked = checks
        .iter()
        .map(|c| json!({"expected_origin":c["expected_origin"],"result":evaluate(&observed,c)}))
        .collect::<Vec<_>>();
    let pass = checked
        .iter()
        .all(|c| c["result"]["state"] == "PASS_PROJECTED_PROPERTY");
    let result = json!({"pass":pass,"state":if pass{"PASS_FROZEN_QUALIFIED_FLOW_BOUNDARY"}else{"NONPASS_QUALIFIED_FLOW_BOUNDARY"},"checks":checked,"observed":observed,"global_admission_inferred":false,"proof_scope":"Bounded native counterpart of the frozen qualified working-tree admission/CLI rule, not the assembled Bun/SQLite product or universal admission."});
    save(&dir.join("result.json"), &result)?;
    Ok(result)
}

#[test]
fn comparator_qualified_capture_requires_rejected_exit3_and_complete_capture() {
    let capture = |value: &Value, code: i32| {
        let stdout = serde_json::to_string(value).unwrap();
        process::Outcome {
            kind: if code == 0 { "success" } else { "nonzero" }.into(),
            exit_code: Some(code),
            duration_ms: 1,
            stdout_bytes: stdout.len() as u64,
            stderr_bytes: 0,
            stdout_hash: sha(stdout.as_bytes()),
            stderr_hash: sha(b""),
            stdout,
            stderr: String::new(),
        }
    };
    let admitted = json!({"analysisAdmission":{"status":"admitted"},"verdict":"NOT_ASSERTED"});
    let rejected = json!({"analysisAdmission":{"status":"rejected"},"verdict":"BLOCK"});
    assert!(captured_cli_report(&capture(&admitted, 0)).is_ok());
    let good = capture(&rejected, 3);
    assert!(captured_cli_report(&good).is_ok());
    for (value, code) in [
        (&rejected, 0),
        (&admitted, 3),
        (&rejected, 7),
        (&json!({}), 3),
        (
            &json!({"analysisAdmission":{"status":"unknown"},"verdict":"BLOCK"}),
            3,
        ),
        (
            &json!({"analysisAdmission":{"status":"rejected"},"verdict":"PASS"}),
            3,
        ),
    ] {
        assert!(captured_cli_report(&capture(value, code)).is_err());
    }
    for (field, value) in [
        ("kind", json!("timeout")),
        ("exit_code", Value::Null),
        ("stdout_bytes", json!(0)),
        ("stderr_bytes", json!(1)),
        ("stdout_hash", json!("foreign")),
        ("stderr_hash", json!("foreign")),
        ("stdout", json!("truncated")),
        ("stderr", json!("unexpected")),
    ] {
        let mut changed = serde_json::to_value(&good).unwrap();
        changed[field] = value;
        assert!(captured_cli_report(&serde_json::from_value(changed).unwrap()).is_err());
    }
}
