//! Real C1 subprocesses are owned by the existing Rust supervisor; Python only plans/projects.
use super::*;
#[path = "public_runtime_consumers.rs"]
mod public_runtime_consumers;

fn capture_integrity(outcome: &Value) -> Result<(), String> {
    for stream in ["stdout", "stderr"] {
        let text = value_text(outcome, stream)?;
        if outcome[format!("{stream}_bytes")].as_u64() != Some(text.len() as u64) {
            return Err("INCOMPLETE_RAW_CAPTURE_BYTES".into());
        }
        let hash = value_text(outcome, &format!("{stream}_hash"))?;
        if hash != sha(text.as_bytes()) && hash != identity::digest_bytes(text.as_bytes()) {
            return Err("INCOMPLETE_RAW_CAPTURE_HASH".into());
        }
    }
    Ok(())
}

pub(super) fn complete_success_capture(outcome: &Value) -> Result<(), String> {
    if outcome["kind"] != "success" || outcome["exit_code"] != 0 {
        return Err("NATIVE_PROCESS_NOT_SUCCESS".into());
    }
    capture_integrity(outcome)?;
    if outcome["stderr"] != "" {
        return Err("NATIVE_STDERR_NONEMPTY".into());
    }
    Ok(())
}

fn supervised(argv: &[String], cwd: &Path, helper: &Path, dir: &Path) -> Result<Value, String> {
    fs::create_dir_all(dir).map_err(|error| error.to_string())?;
    let outcome = process::run_with_helper(argv, cwd, 120_000, 16_777_216, helper)
        .map_err(|error| error.to_string())?;
    let value = serde_json::to_value(outcome).map_err(|error| error.to_string())?;
    save(&dir.join("process-outcome.json"), &value)?;
    save(
        &dir.join("process-invocation.json"),
        &json!({"argv":argv,"cwd":cwd,"process_outcome_id":identity::digest(&value)}),
    )?;
    Ok(value)
}

fn verifier_stage(fixture: &Value, args: &[String], cwd: &Path, dir: &Path) -> Result<(), String> {
    for code in fixture["supplement_verifier_files"]
        .as_array()
        .ok_or("verifier code pins absent")?
    {
        if args.first().is_none_or(|action| action != "project")
            && code["path"] == fixture["supplement_node_path"]
        {
            continue;
        }
        exact_hash(
            Path::new(value_text(code, "path")?),
            value_text(code, "sha256")?,
        )?;
    }
    let mut argv = vec![
        value_text(fixture, "supplement_python_path")?.into(),
        value_text(fixture, "supplement_bridge_cli_path")?.into(),
    ];
    argv.extend_from_slice(args);
    let outcome = supervised(
        &argv,
        cwd,
        Path::new(value_text(fixture, "helper_path")?),
        dir,
    )?;
    complete_success_capture(&outcome)
        .map_err(|error| format!("verifier subprocess refused at {}: {error}", dir.display()))?;
    for code in fixture["supplement_verifier_files"]
        .as_array()
        .ok_or("verifier code pins absent")?
    {
        if args.first().is_none_or(|action| action != "project")
            && code["path"] == fixture["supplement_node_path"]
        {
            continue;
        }
        exact_hash(
            Path::new(value_text(code, "path")?),
            value_text(code, "sha256")?,
        )?;
    }
    Ok(())
}

fn repository_reads(observed: &Value, prepared: &Value) -> Result<(), String> {
    let mut known = BTreeMap::new();
    for item in prepared["physical_setup"]
        .as_array()
        .ok_or("physical setup absent")?
    {
        if let Some(hash) = item["blob_ref"]["sha256"].as_str() {
            let canonical = Path::new(value_text(item, "path")?)
                .canonicalize()
                .map_err(|error| error.to_string())?;
            known.insert(canonical, format!("sha256:{hash}"));
        }
    }
    let root = Path::new(value_text(prepared, "repository_root")?)
        .canonicalize()
        .map_err(|error| error.to_string())?;
    for read in observed["reads"]
        .as_array()
        .ok_or("discovery read inventory absent")?
    {
        let path = Path::new(value_text(read, "path")?)
            .canonicalize()
            .map_err(|error| error.to_string())?;
        if !path.starts_with(&root)
            || known.get(&path).map(String::as_str) != read["raw_bytes_sha256"].as_str()
        {
            return Err("discovery read not joined to frozen physical bytes/root".into());
        }
    }
    if !observed["resolution_probes"].is_array() {
        return Err("discovery resolution probes absent".into());
    }
    Ok(())
}

fn discovery_binding(observed: &Value, prepared: &Value, artifact: &str) -> Result<Value, String> {
    let request = &prepared["request"];
    if observed["request_descriptor_id"] != identity::digest(request)
        || observed["producer_artifact_id"] != format!("sha256:{artifact}")
        || observed["executed"] != true
        || observed["unsupported"] != json!([])
        || observed["global_admission_inferred"] != false
    {
        return Err("discovery header incomplete or foreign".into());
    }
    // Discovery canonicalizes a directory alias before observing files.
    // Its descriptor still binds the original request spelling.
    let requested_root = Path::new(value_text(request, "repositoryRoot")?)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let observed_root = Path::new(value_text(observed, "repositoryRoot")?)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let envelope = Path::new(value_text(prepared, "case_root")?)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    if requested_root != observed_root
        || !observed_root.starts_with(&envelope)
        || observed["observation_scope"] != "native_ordinary_repository_discovery"
    {
        return Err("discovery canonical root is foreign or outside frozen case".into());
    }
    repository_reads(observed, prepared)?;
    Ok(json!({"physical_reads_byte_joined":true}))
}

fn bind_native(
    observed: &Value,
    prepared: &Value,
    sdk: &Value,
    artifact: &str,
) -> Result<Value, String> {
    let request = &prepared["request"];
    let surface = value_text(prepared, "surface")?;
    let binding = match surface {
        "raw_cli" => {
            let binding = observation_bound_to_request(observed, request, sdk, artifact)?;
            let reads = join_successful_reads(observed, request, sdk)?;
            let mut capability = Value::Null;
            if prepared["adapter"] != "ownership_adapter"
                && matches!(
                    prepared["baseline_function"].as_str(),
                    Some(
                        "extractTypeScript"
                            | "analyzeRepository"
                            | "analyzeRepositoryAsync"
                            | "extractTypeScriptParallel"
                    )
                )
            {
                capability = native_product_capability(
                    observed,
                    request,
                    &json!({"checks":[{"target":["raw_extraction"]}]}),
                )?;
            }
            for subject in observed["subjects"]
                .as_array()
                .ok_or("actual native subject inventory absent")?
            {
                if subject["sourceFileObservation"]["executed"] != true
                    || subject["sourceFileObservation"]["unsupported"] != json!([])
                {
                    return Err("actual source-file component incomplete".into());
                }
            }
            Ok(
                json!({"native_binding":binding,"read_provenance":reads,"native_product_capability":capability}),
            )
        }
        "primitive_cli" => primitive_bound_to_request(observed, request, artifact),
        "configured_resolution_cli" => {
            configured_query_complete_binding(observed, request, sdk, artifact)
        }
        "repository_discovery_cli" => discovery_binding(observed, prepared, artifact),
        _ => Err(format!("native binding surface not exposed: {surface}")),
    }?;
    Ok(
        json!({"request_descriptor_id":identity::digest(request),"sdk_input_id":identity::digest(sdk),"producer_artifact_id":format!("sha256:{artifact}"),"capture_stream_sha256":prepared["source_capture_stream_sha256"],"validated":binding}),
    )
}

fn native_invocation(prepared: &Value, fixture: &Value, dir: &Path) -> Result<Value, String> {
    if prepared["surface"] == "qualified_flow_cli" {
        return lifecycle_invocation(prepared, fixture, dir);
    }
    let artifact = Path::new(value_text(fixture, "artifact_path")?);
    let helper = Path::new(value_text(fixture, "helper_path")?);
    let sdk_path = Path::new(value_text(fixture, "sdk_path")?);
    let sdk = read_json(sdk_path)?;
    let artifact_sha = value_text(fixture, "artifact_sha256")?;
    let helper_sha = value_text(fixture, "helper_sha256")?;
    fs::create_dir_all(dir).map_err(|error| error.to_string())?;
    let request_path = dir.join("request.json");
    save(&request_path, &prepared["request"])?;
    let before = json!({"artifact":exact_hash(artifact,artifact_sha)?,"helper":exact_hash(helper,helper_sha)?,"sdk":exact_hash(sdk_path,value_text(fixture,"sdk_sha256")?)?});
    let mut argv = vec![artifact.to_string_lossy().into_owned()];
    if let Some(mode) = prepared["mode"].as_str() {
        argv.push(mode.into());
    }
    argv.push(request_path.to_string_lossy().into_owned());
    if matches!(
        value_text(prepared, "surface")?,
        "raw_cli" | "configured_resolution_cli" | "parallel_cli"
    ) {
        argv.push(sdk_path.to_string_lossy().into_owned());
    }
    if prepared["surface"] == "parallel_cli" {
        argv.push(helper.to_string_lossy().into_owned());
    }
    let cwd = Path::new(
        prepared["repository_root"]
            .as_str()
            .unwrap_or(value_text(prepared, "case_root")?),
    );
    let outcome = supervised(&argv, cwd, helper, dir)?;
    let after = json!({"artifact":exact_hash(artifact,artifact_sha)?,"helper":exact_hash(helper,helper_sha)?,"sdk":exact_hash(sdk_path,value_text(fixture,"sdk_sha256")?)?});
    save(
        &dir.join("artifact-observation.json"),
        &json!({"before":before,"after":after}),
    )?;
    let checked = (|| -> Result<Value, String> {
        complete_success_capture(&outcome)?;
        let observed: Value = serde_json::from_str(value_text(&outcome, "stdout")?)
            .map_err(|error| error.to_string())?;
        if prepared["surface"] == "parallel_cli" {
            let mut control = prepared.clone();
            control["surface"] = json!("raw_cli");
            control["mode"] = Value::Null;
            control["request"] = prepared["direct_control_request"].clone();
            let direct = native_invocation(&control, fixture, &dir.join("direct-control"))?;
            if direct["binding_verified"] != true {
                return Err("parallel direct control unbound".into());
            }
            let direct_observed: Value =
                serde_json::from_str(value_text(&direct["outcome"], "stdout")?)
                    .map_err(|error| error.to_string())?;
            let binding = parallel_replay::verify_parallel(
                &observed,
                &prepared["request"],
                &prepared["direct_control_request"],
                &direct_observed,
                &sdk,
                artifact_sha,
                helper_sha,
            )?;
            Ok(
                json!({"request_descriptor_id":identity::digest(&prepared["request"]),"sdk_input_id":identity::digest(&sdk),"producer_artifact_id":format!("sha256:{artifact_sha}"),"capture_stream_sha256":prepared["source_capture_stream_sha256"],"validated":binding}),
            )
        } else {
            bind_native(&observed, prepared, &sdk, artifact_sha)
        }
    })();
    let checked = checked.and_then(|mut binding| {
        let native: Value = serde_json::from_str(value_text(&outcome, "stdout")?)
            .map_err(|error| error.to_string())?;
        if let Some(receipt) =
            public_runtime_consumers::observe(prepared, &native, &sdk, &binding, fixture)?
        {
            save(&dir.join("rust-public-consumer-receipt.json"), &receipt)?;
            binding["consumer_artifact_id"] = receipt["consumer_artifact_id"].clone();
            binding["rust_public_consumer_receipt"] = receipt;
        }
        Ok(binding)
    });
    let evidence = match checked {
        Ok(binding) => {
            json!({"binding_verified":true,"binding":binding,"outcome":outcome,"native_invocation_id":identity::digest(&json!({"argv":argv,"cwd":cwd,"outcome":outcome,"before":before,"after":after}))})
        }
        Err(error) => {
            json!({"binding_verified":false,"error":error,"outcome":outcome,"native_invocation_id":identity::digest(&outcome)})
        }
    };
    save(&dir.join("bridge-evidence.json"), &evidence)?;
    Ok(evidence)
}

fn lifecycle_invocation(prepared: &Value, fixture: &Value, dir: &Path) -> Result<Value, String> {
    fs::create_dir_all(dir).map_err(|error| error.to_string())?;
    let consumer_dir = Path::new(value_text(prepared, "case_root")?);
    let result = qualified_flow_replay::run(prepared, consumer_dir, fixture)?;
    save(&dir.join("consumer-result.json"), &result)?;
    if !result["observed"].is_object() {
        let evidence = json!({"binding_verified":false,"error":result["state"],"native_attempted":false,"consumer_result":result});
        save(&dir.join("bridge-evidence.json"), &evidence)?;
        return Ok(evidence);
    }
    let observed = &result["observed"];
    let sdk = read_json(Path::new(value_text(fixture, "sdk_path")?))?;
    if observed.get("raw_scope").is_some() {
        observation_bound_to_request(
            &observed["raw_scope"],
            &observed["request_descriptor"],
            &sdk,
            value_text(fixture, "artifact_sha256")?,
        )?;
        join_successful_reads(
            &observed["raw_scope"],
            &observed["request_descriptor"],
            &sdk,
        )?;
    }
    let mut receipts = Vec::new();
    for entry in fs::read_dir(consumer_dir).map_err(|error| error.to_string())? {
        let path = entry.map_err(|error| error.to_string())?.path();
        if path.is_file()
            && path
                .extension()
                .is_some_and(|extension| extension == "json")
        {
            let value = read_json(&path)?;
            if value["argv"].is_array() && value["outcome"]["kind"].is_string() {
                complete_success_capture(&value["outcome"])?;
                receipts.push(json!({"path":path,"process_outcome_id":identity::digest(&value["outcome"]),"frame_id":identity::digest(&value),"native_c1":value["argv"].as_array().and_then(|args|args.first())==fixture.get("artifact_path")}));
            }
        }
    }
    let binding = json!({"source_recipe_id":identity::digest(prepared),"producer_artifact_id":format!("sha256:{}",value_text(fixture,"artifact_sha256")?),"sdk_input_id":identity::digest(&sdk),"capture_stream_sha256":prepared["source_capture_stream_sha256"],"actual_process_receipts":receipts});
    let evidence = json!({"binding_verified":true,"binding":binding,"lifecycle_observed":observed,"native_invocation_id":identity::digest(&json!({"consumer":result,"receipts":receipts}))});
    save(&dir.join("bridge-evidence.json"), &evidence)?;
    Ok(evidence)
}

fn snapshot_refusal_matches(outcome: &Value, code: &str) -> bool {
    capture_integrity(outcome).is_ok()
        && outcome["kind"] == "nonzero"
        && outcome["exit_code"] == 1
        && outcome["stdout"] == ""
        && outcome["stderr"]
            .as_str()
            .and_then(|text| serde_json::from_str::<Value>(text).ok())
            == Some(json!({"error":code}))
}

pub(super) fn snapshot_boundary(
    recipe: &Value,
    dir: &Path,
    fixture: &Value,
) -> Result<Value, String> {
    fs::create_dir_all(dir).map_err(|error| error.to_string())?;
    let name = value_text(recipe, "workspace_name")?;
    if !safe_id(name) {
        return Err("unsafe snapshot fixture name".into());
    }
    let root = dir.join(name);
    fs::create_dir(&root).map_err(|error| error.to_string())?;
    fs::write(root.join("SnapshotCaseProbe"), b"case probe").map_err(|error| error.to_string())?;
    let sensitive = !root.join("snapshotcaseprobe").exists();
    fs::remove_file(root.join("SnapshotCaseProbe")).map_err(|error| error.to_string())?;
    let mut request = materialize(&recipe["template"], &root, sensitive)?;
    request["qualified"] = json!(true);
    request["retained"] = json!(true);
    let mut prepared = json!({"surface":"raw_cli","mode":null,"request":request,"repository_root":request["cwd"],"case_root":root,"baseline_function":"analyzeRepository","source_capture_stream_sha256":recipe["source_capture_stream_sha256"]});
    let captured = native_invocation(&prepared, fixture, &dir.join("valid-capture"))?;
    let graph = if captured["binding_verified"] == true {
        let native: Value = serde_json::from_str(value_text(&captured["outcome"], "stdout")?)
            .map_err(|error| error.to_string())?;
        compare(
            &native["assembly"]["nodes"],
            &recipe["expected_nodes"],
            "ordered_projected_eq",
        )?
    } else {
        false
    };
    prepared["request"]["retained"] = json!(false);
    let refused = native_invocation(&prepared, fixture, &dir.join("absent-capture"))?;
    let refusal = snapshot_refusal_matches(
        &refused["outcome"],
        value_text(recipe, "expected_error_code")?,
    );
    let result = json!({"state":if graph&&refusal{"SNAPSHOT_CONSUMER_BOUNDARY_OBSERVATIONS_MATCH"}else{"RAW_SNAPSHOT_BOUNDARY_NONPASS"},"pass":graph&&refusal,"captured_graph_match":graph,"controlled_refusal_match":refusal,"expected_error_ref":recipe["expected_error_ref"],"expected_nodes_ref":recipe["expected_nodes_ref"],"valid_capture_invocation":captured["native_invocation_id"],"absent_capture_invocation":refused["native_invocation_id"],"refusal_binding_kind":"EXTERNAL_EXACT_INVOCATION_AND_BYTE_CAPTURE_ONLY_NO_USEFUL_NATIVE_FACTS","qualification_credit":0});
    save(&dir.join("result.json"), &result)?;
    Ok(result)
}

#[test]
fn comparator_snapshot_refusal_cannot_pass_from_useful_stdout_or_other_error() {
    let good = comparator_capture(
        "nonzero",
        1,
        "",
        "{\"error\":\"SOURCE_SNAPSHOT_REQUIRED\"}\n",
    );
    assert!(snapshot_refusal_matches(&good, "SOURCE_SNAPSHOT_REQUIRED"));
    let useful = comparator_capture(
        "nonzero",
        1,
        "{\"assembly\":{}}",
        "{\"error\":\"SOURCE_SNAPSHOT_REQUIRED\"}\n",
    );
    assert!(!snapshot_refusal_matches(
        &useful,
        "SOURCE_SNAPSHOT_REQUIRED"
    ));
    let wrong = comparator_capture("nonzero", 1, "", "{\"error\":\"OTHER\"}");
    assert!(!snapshot_refusal_matches(
        &wrong,
        "SOURCE_SNAPSHOT_REQUIRED"
    ));
    let mut failed = good;
    failed["kind"] = json!("timeout");
    assert!(!snapshot_refusal_matches(
        &failed,
        "SOURCE_SNAPSHOT_REQUIRED"
    ));
}

#[cfg(test)]
fn comparator_capture(kind: &str, code: i32, stdout: &str, stderr: &str) -> Value {
    json!({"kind":kind,"exit_code":code,"stdout":stdout,"stderr":stderr,
        "stdout_bytes":stdout.len(),"stderr_bytes":stderr.len(),"stdout_hash":sha(stdout.as_bytes()),"stderr_hash":sha(stderr.as_bytes())})
}

#[test]
fn comparator_native_capture_rejects_coherent_stderr_and_nonzero_digests() {
    let text = "{\"outlines\":{\"main.ts\":{\"outline\":{\"statements\":[{\"digest\":\"valid-digest\"}]}}}}";
    assert!(complete_success_capture(&comparator_capture("success", 0, text, "")).is_ok());
    assert_eq!(
        complete_success_capture(&comparator_capture(
            "success",
            0,
            text,
            "unexpected diagnostic\n"
        )),
        Err("NATIVE_STDERR_NONEMPTY".into())
    );
    assert_eq!(
        complete_success_capture(&comparator_capture("nonzero", 1, text, "")),
        Err("NATIVE_PROCESS_NOT_SUCCESS".into())
    );
    let mut corrupt = comparator_capture("success", 0, text, "");
    corrupt["stdout_hash"] = json!("foreign");
    assert!(complete_success_capture(&corrupt).is_err());
}

pub(super) fn validate_plan(fixture: &Value, out: &Path) -> Result<Value, String> {
    let code = fixture["supplement_verifier_files"]
        .as_array()
        .ok_or("frozen verifier code inventory absent")?;
    let mut required = vec![
        PathBuf::from(value_text(fixture, "supplement_python_path")?),
        PathBuf::from(value_text(fixture, "supplement_node_path")?),
        PathBuf::from(value_text(fixture, "supplement_bridge_cli_path")?),
        PathBuf::from(value_text(fixture, "supplement_graph_module_path")?),
    ];
    let module = Path::new(value_text(fixture, "supplement_public_module_dir")?);
    required.extend([
        module.join("public_runtime.py"),
        module.join("public_adapter.py"),
    ]);
    required.push(
        Path::new(value_text(fixture, "supplement_bridge_cli_path")?)
            .parent()
            .ok_or("bridge parent absent")?
            .join("source_adapter.py"),
    );
    for path in required {
        let entry = code
            .iter()
            .find(|entry| {
                entry["path"]
                    .as_str()
                    .is_some_and(|value| Path::new(value) == path)
            })
            .ok_or_else(|| format!("verifier executable/code not frozen: {}", path.display()))?;
        exact_hash(&path, value_text(entry, "sha256")?)?;
    }
    let path = Path::new(value_text(fixture, "supplement_public_plan_path")?);
    exact_hash(path, value_text(fixture, "supplement_public_plan_sha256")?)?;
    let plan = read_json(path)?;
    if plan["manifest_sha256"] != MANIFEST
        || plan["rows"].as_array().is_none_or(|rows| rows.len() != 25)
        || plan["native_queries_performed"] != 0
    {
        return Err("pre-frozen public plan denominator/manifest differs".into());
    }
    let count = plan["rows"]
        .as_array()
        .ok_or("public rows absent")?
        .iter()
        .map(|row| row["operations"].as_array().map(Vec::len).unwrap_or(0))
        .sum::<usize>();
    if count != 677 {
        return Err("pre-frozen baseline operation denominator differs".into());
    }
    for invocation in plan["invocations"]
        .as_array()
        .ok_or("invocation plan absent")?
    {
        if !safe_id(value_text(invocation, "key")?)
            || !Path::new(value_text(&invocation["prepared"], "case_root")?).starts_with(out)
        {
            return Err("pre-frozen physical plan escapes fresh public evidence root".into());
        }
        if let Some(module) = invocation["prepared"]["ownership_module_dir"].as_str() {
            let path = Path::new(module).join("ownership_adapter.py");
            let entry = code
                .iter()
                .find(|entry| {
                    entry["path"]
                        .as_str()
                        .is_some_and(|value| Path::new(value) == path)
                })
                .ok_or("ownership verifier code not frozen")?;
            exact_hash(&path, value_text(entry, "sha256")?)?;
        }
        if let Some(module) = invocation["prepared"]["lifecycle_module_dir"].as_str() {
            let path = Path::new(module).join("lifecycle_adapter_29_frozen.py");
            let entry = code
                .iter()
                .find(|entry| {
                    entry["path"]
                        .as_str()
                        .is_some_and(|value| Path::new(value) == path)
                })
                .ok_or("lifecycle verifier code not frozen")?;
            exact_hash(&path, value_text(entry, "sha256")?)?;
        }
    }
    Ok(plan)
}

pub(super) fn run(fixture: &Value, out: &Path) -> Result<Value, String> {
    fs::create_dir_all(out).map_err(|error| error.to_string())?;
    for code in fixture["supplement_verifier_files"]
        .as_array()
        .ok_or("verifier code freeze absent")?
    {
        exact_hash(
            Path::new(value_text(code, "path")?),
            value_text(code, "sha256")?,
        )?;
    }
    let common = vec![
        "--module-dir".into(),
        value_text(fixture, "supplement_public_module_dir")?.into(),
    ];
    let plan = PathBuf::from(value_text(fixture, "supplement_public_plan_path")?);
    let document = validate_plan(fixture, out)?;
    let outcomes = out.join("outcomes");
    for invocation in document["invocations"]
        .as_array()
        .ok_or("invocations absent")?
    {
        let key = value_text(invocation, "key")?;
        if !safe_id(key) {
            return Err("unsafe invocation key".into());
        }
        let mut args = vec![
            "materialize".into(),
            "--plan".into(),
            plan.to_string_lossy().into_owned(),
            "--key".into(),
            key.into(),
            "--output".into(),
            out.join(format!("stages/{key}/materialized.json"))
                .to_string_lossy()
                .into_owned(),
        ];
        args.extend(common.clone());
        if let Err(error) = verifier_stage(
            fixture,
            &args,
            out,
            &out.join(format!("stages/{key}/materialize")),
        ) {
            fs::create_dir_all(outcomes.join(key)).map_err(|error| error.to_string())?;
            save(
                &outcomes.join(key).join("bridge-evidence.json"),
                &json!({"binding_verified":false,"error":error,"native_attempted":false}),
            )?;
            continue;
        }
        if let Err(error) = native_invocation(&invocation["prepared"], fixture, &outcomes.join(key))
        {
            save(
                &outcomes.join(key).join("bridge-evidence.json"),
                &json!({"binding_verified":false,"error":error,"native_attempted":true}),
            )?;
        }
        for auxiliary in invocation["auxiliaries"]
            .as_array()
            .ok_or("auxiliary inventory absent")?
        {
            if let Err(error) = native_invocation(
                &auxiliary["prepared"],
                fixture,
                &outcomes.join(value_text(auxiliary, "key")?),
            ) {
                fs::create_dir_all(outcomes.join(value_text(auxiliary, "key")?))
                    .map_err(|error| error.to_string())?;
                save(
                    &outcomes
                        .join(value_text(auxiliary, "key")?)
                        .join("bridge-evidence.json"),
                    &json!({"binding_verified":false,"error":error,"native_attempted":true}),
                )?;
            }
        }
    }
    let report = out.join("public-report.json");
    let mut args = vec![
        "project".into(),
        "--plan".into(),
        plan.to_string_lossy().into_owned(),
        "--outcome-root".into(),
        outcomes.to_string_lossy().into_owned(),
        "--output".into(),
        report.to_string_lossy().into_owned(),
        "--node".into(),
        value_text(fixture, "supplement_node_path")?.into(),
        "--graph-module".into(),
        value_text(fixture, "supplement_graph_module_path")?.into(),
    ];
    args.extend(common);
    verifier_stage(fixture, &args, out, &out.join("stages/project"))?;
    for code in fixture["supplement_verifier_files"]
        .as_array()
        .ok_or("verifier code freeze absent")?
    {
        exact_hash(
            Path::new(value_text(code, "path")?),
            value_text(code, "sha256")?,
        )?;
    }
    read_json(&report)
}

#[cfg(test)]
mod discovery_binding_tests {
    use super::*;
    #[test]
    fn comparator_discovery_canonical_root_and_raw_byte_read_are_bound() {
        let root = std::env::temp_dir().join(format!(
            "public-discovery-binding-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(root.join("nested")).unwrap();
        fs::write(root.join("source.ts"), b"export {};").unwrap();
        let root = root.canonicalize().unwrap();
        let requested = root.join("nested/..");
        let request = json!({"repositoryRoot":requested});
        let prepared = json!({"request":request,"surface":"repository_discovery_cli","repository_root":requested,"case_root":root,
            "physical_setup":[{"path":root.join("source.ts"),"blob_ref":{"sha256":sha(b"export {};")}}]});
        let observed = json!({"request_descriptor_id":identity::digest(&request),"producer_artifact_id":"sha256:actual-comparator-artifact",
            "repositoryRoot":root,"executed":true,"unsupported":[],"global_admission_inferred":false,"observation_scope":"native_ordinary_repository_discovery",
            "reads":[{"path":root.join("source.ts"),"raw_bytes_sha256":identity::digest_bytes(b"export {};")}],"resolution_probes":[]});
        assert!(discovery_binding(&observed, &prepared, "actual-comparator-artifact").is_ok());
        for pointer in [
            "/reads/0/raw_bytes_sha256",
            "/request_descriptor_id",
            "/producer_artifact_id",
        ] {
            let mut poison = observed.clone();
            *poison.pointer_mut(pointer).unwrap() = json!("foreign");
            assert!(
                discovery_binding(&poison, &prepared, "actual-comparator-artifact").is_err(),
                "{pointer}"
            );
        }
        let mut poison = observed.clone();
        poison["repositoryRoot"] = json!(root.parent().unwrap());
        assert!(discovery_binding(&poison, &prepared, "actual-comparator-artifact").is_err());
        let mut poison = observed.clone();
        poison["reads"][0]["path"] = json!(root.join("nested"));
        assert!(discovery_binding(&poison, &prepared, "actual-comparator-artifact").is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
