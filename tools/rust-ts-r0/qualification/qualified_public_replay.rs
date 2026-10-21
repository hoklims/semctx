// Consumer-only addition beside qualification_replay.rs. Never modifies the C1 producer.
// Integration: qualified_flow_replay::run branches on public_flow_kind into this run.
use super::*;
#[path = "public_batch_binding.rs"]
mod batch_binding;
#[path = "ordinary_physical_capture.rs"]
mod ordinary_physical_capture;
#[path = "public_working_tree_replay.rs"]
mod public_working_tree_replay;
#[path = "public_scope_ast.rs"]
mod scope_ast;
#[path = "t00_admission_consumer.rs"]
mod t00_admission_consumer;

fn complete(outcome: &process::Outcome) -> Result<(), String> {
    for (value, count, hash) in [
        (&outcome.stdout, outcome.stdout_bytes, &outcome.stdout_hash),
        (&outcome.stderr, outcome.stderr_bytes, &outcome.stderr_hash),
    ] {
        if value.len() as u64 != count || count > 8_388_608 || sha(value.as_bytes()) != *hash {
            return Err("public lifecycle capture incomplete".into());
        }
    }
    Ok(())
}

fn files(root: &Path, value: &Value) -> Result<(), String> {
    for (name, text) in value
        .as_object()
        .ok_or("public lifecycle file map absent")?
    {
        if !safe_relative(name) || name.split('/').any(|p| [".git", ".semctx"].contains(&p)) {
            return Err("public lifecycle physical file outside authored closure".into());
        }
        let path = root.join(name);
        fs::create_dir_all(path.parent().ok_or("missing fixture parent")?)
            .map_err(|e| e.to_string())?;
        fs::write(
            path,
            text.as_str()
                .ok_or("public physical bytes not UTF8 text")?
                .as_bytes(),
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn invoke(
    argv: &[String],
    root: &Path,
    evidence: &Path,
    helper: &Path,
    pins: &[(&Path, &str)],
) -> Result<process::Outcome, String> {
    for (path, hash) in pins {
        exact_hash(path, hash)?;
    }
    let outcome = process::run_with_helper(argv, root, 20_000, 8_388_608, helper)
        .map_err(|e| e.to_string())?;
    save(evidence, &json!({"argv":argv,"cwd":root,"outcome":outcome}))?;
    complete(&outcome)?;
    for (path, hash) in pins {
        exact_hash(path, hash)?;
    }
    Ok(outcome)
}

fn json_success(outcome: &process::Outcome) -> Result<Value, String> {
    if outcome.kind != "success" || outcome.exit_code != Some(0) || !outcome.stderr.is_empty() {
        return Err("public native observation not successful".into());
    }
    serde_json::from_str(&outcome.stdout).map_err(|e| e.to_string())
}

pub(super) fn run(recipe: &Value, dir: &Path, fixture: &Value) -> Result<Value, String> {
    if fixture["public_lifecycle_execution_enabled"] != true {
        return Ok(
            json!({"state":"NOT_EXECUTED_PUBLIC_LIFECYCLE_DISABLED","native_queries":0,"pass":false}),
        );
    }
    if recipe["surface"] != "qualified_flow_cli"
        || !recipe["gaps"].as_array().is_some_and(|v| v.is_empty())
    {
        return Err("public lifecycle recipe incomplete".into());
    }
    let artifact = Path::new(value_text(fixture, "artifact_path")?);
    let helper = Path::new(value_text(fixture, "helper_path")?);
    let sdk_path = Path::new(value_text(fixture, "sdk_path")?);
    let artifact_sha = value_text(fixture, "artifact_sha256")?;
    let pins = [
        (artifact, artifact_sha),
        (helper, value_text(fixture, "helper_sha256")?),
        (sdk_path, value_text(fixture, "sdk_sha256")?),
    ];
    let root = dir.join("workspace");
    if root.exists() {
        return Err("public lifecycle requires a fresh isolated workspace".into());
    }
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    files(&root, &recipe["physical_files"])?;
    for (index, command) in recipe["git_setup"]
        .as_array()
        .ok_or("Git setup absent")?
        .iter()
        .enumerate()
    {
        let argv: Vec<String> =
            serde_json::from_value(command.clone()).map_err(|e| e.to_string())?;
        let outcome = invoke(
            &argv,
            &root,
            &dir.join(format!("git-setup-{index}.json")),
            helper,
            &pins,
        )?;
        if outcome.kind != "success" || outcome.exit_code != Some(0) {
            return Err("actual Git setup failed".into());
        }
    }
    files(&root, &recipe["physical_current_files"])?;
    for (index, command) in recipe["git_after_current"]
        .as_array()
        .ok_or("Git temporal setup absent")?
        .iter()
        .enumerate()
    {
        let argv: Vec<String> =
            serde_json::from_value(command.clone()).map_err(|e| e.to_string())?;
        let outcome = invoke(
            &argv,
            &root,
            &dir.join(format!("git-current-{index}.json")),
            helper,
            &pins,
        )?;
        if outcome.kind != "success" || outcome.exit_code != Some(0) {
            return Err("actual Git temporal setup failed".into());
        }
    }
    let sentinel = root.join("PublicLifecycleCaseProbe");
    fs::write(&sentinel, b"case").map_err(|e| e.to_string())?;
    let case_sensitive = !root.join("publiclifecyclecaseprobe").exists();
    fs::remove_file(&sentinel).map_err(|e| e.to_string())?;
    let cwd = root
        .canonicalize()
        .map_err(|e| e.to_string())?
        .to_string_lossy()
        .replace('\\', "/");
    let head = invoke(
        &[
            "git".into(),
            "rev-parse".into(),
            "--verify".into(),
            "--quiet".into(),
            "HEAD".into(),
        ],
        &root,
        &dir.join("git-head.json"),
        helper,
        &pins,
    )?;
    let unborn = source_scope_replay::allows_unborn_head(recipe)
        && head.kind == "nonzero"
        && head.exit_code == Some(1)
        && head.stdout.is_empty()
        && head.stderr.is_empty();
    if (head.kind != "success" || head.exit_code != Some(0)) && !unborn {
        return Err("actual Git HEAD absent".into());
    }
    let mut observations = json!({"git_head":head.stdout.trim(),"native_case_sensitive":case_sensitive,"repository_root":cwd,
        "global_admission_inferred":false,"actual_native_invocation_refs":[]});
    let kind = value_text(recipe, "public_flow_kind")?;
    if kind == "public-verify" && recipe["adapter"] == "full_admission_adapter" {
        return public_working_tree_replay::run(recipe, dir, &root, fixture, &observations);
    }
    if kind == "qualified-discovery" {
        let mut query = recipe["ordinary_discovery_request"].clone();
        query["repositoryRoot"] = json!(cwd);
        let query_path = dir.join("ordinary-discovery.json");
        save(&query_path, &query)?;
        let ordinary = invoke(
            &[
                artifact.to_string_lossy().into_owned(),
                "--discover-repository".into(),
                query_path.to_string_lossy().into_owned(),
            ],
            &root,
            &dir.join("ordinary-discovery-process.json"),
            helper,
            &pins,
        )?;
        let ordinary = json_success(&ordinary)?;
        if ordinary["request_descriptor_id"] != identity::digest(&query)
            || ordinary["producer_artifact_id"] != format!("sha256:{artifact_sha}")
        {
            return Err("ordinary public discovery binding mismatch".into());
        }
        let eligibility = json!({"repositoryRoot":cwd,"processHelper":helper,
            "include":recipe["eligibility_include"],"exclude":recipe["eligibility_exclude"],"queries":recipe["eligibility_queries"]});
        let path = dir.join("eligibility.json");
        save(&path, &eligibility)?;
        let outcome = invoke(
            &[
                artifact.to_string_lossy().into_owned(),
                "--observe-path-eligibility".into(),
                path.to_string_lossy().into_owned(),
            ],
            &root,
            &dir.join("eligibility-process.json"),
            helper,
            &pins,
        )?;
        let eligible = json_success(&outcome)?;
        if eligible["request_descriptor_id"] != identity::digest(&eligibility)
            || eligible["producer_artifact_id"] != format!("sha256:{artifact_sha}")
        {
            return Err("actual eligibility binding mismatch".into());
        }
        let queries = recipe["native_system_queries"].as_array().ok_or("System queries absent")?.iter().map(|q|
            json!({"operation":q["operation"],"path":format!("{cwd}/{}",q["path"].as_str().unwrap_or(""))})).collect::<Vec<_>>();
        // Ordinary physical System input: source bytes are acquired from the actual
        // isolated workspace, never copied from recipe/expected output. Retained
        // scope and SDK capture contexts keep their existing independent paths.
        let physical_names = recipe["native_system_queries"]
            .as_array()
            .ok_or("System queries absent")?
            .iter()
            .map(|q| {
                if q["operation"] != "read_file" {
                    return Err("ordinary physical collector supports read_file only".to_string());
                }
                Ok(value_text(q, "path")?.to_string())
            })
            .collect::<Result<Vec<_>, String>>()?;
        let physical = ordinary_physical_capture::capture(&root, &physical_names)?;
        let physical_pins = |pins: &[ordinary_physical_capture::PhysicalPin]| {
            pins.iter().map(|p|
            json!({"path":p.absolute,"relative":p.relative,"present":p.bytes.is_some(),
                "bytes":p.bytes.as_ref().map(|b|b.len()),"content_sha256":p.bytes.as_ref().map(|b|identity::digest_bytes(b))})
        ).collect::<Vec<_>>()
        };
        let physical_before = physical_pins(&physical.pins);
        let system = json!({"root":cwd,"profile":"workspace","case_sensitive":case_sensitive,
            "files":physical.files,"utf16_files":{},"raw_files":{},"sdk_directory":null,"queries":queries});
        save(
            &dir.join("system-physical-capture-before.json"),
            &json!({"kind":"ordinary-physical-system-input-v1", "context":"ordinary_workspace_only",
            "request_descriptor_id":identity::digest(&system),"pins":physical_before,"retained_map_modified":false,
            "claim":"bounded sequential physical acquisition, not atomic OS sandboxing"}),
        )?;
        let path = dir.join("system.json");
        save(&path, &system)?;
        let outcome = invoke(
            &[
                artifact.to_string_lossy().into_owned(),
                "--observe-system".into(),
                path.to_string_lossy().into_owned(),
            ],
            &root,
            &dir.join("system-process.json"),
            helper,
            &pins,
        )?;
        let physical_after = physical.observe_unchanged()?;
        save(
            &dir.join("system-physical-capture-after.json"),
            &json!({"kind":"ordinary-physical-system-input-v1", "context":"ordinary_workspace_only",
            "request_descriptor_id":identity::digest(&system),"pins":physical_pins(&physical_after),"matched_before":true,"retained_map_modified":false}),
        )?;
        let system_observed = json_success(&outcome)?;
        if system_observed["request_descriptor_id"] != identity::digest(&system)
            || system_observed["producer_artifact_id"] != format!("sha256:{artifact_sha}")
        {
            return Err("actual System read binding mismatch".into());
        }
        observations["ordinary_discovery"] = ordinary;
        observations["eligibility"] = eligible;
        observations["system"] = system_observed;
        observations["actual_native_invocation_refs"] = json!([
            "ordinary-discovery-process.json",
            "eligibility-process.json",
            "system-process.json"
        ]);
    } else {
        let request = materialize(&recipe["requests"][0], &root, case_sensitive)?;
        if kind == "retained-scope" {
            // materialize writes captured bytes; restore the independently captured
            // live post-image before the retained native query, preserving old maps.
            files(&root, &recipe["physical_current_files"])?;
        }
        let request_path = dir.join("analysis-request.json");
        save(&request_path, &request)?;
        observations["request_descriptor"] = request.clone();
        let source_component_mode = kind == "retained-scope"
            && recipe["source_component_observation"] == true
            && recipe["unit_id"] == "source::reference-outside"
            && source_scope_replay::allows_unborn_head(recipe);
        let mode = if source_component_mode {
            Some("--observe-source-components")
        } else if kind == "retained-scope" {
            None
        } else {
            Some("--batch")
        };
        let mut argv = vec![artifact.to_string_lossy().into_owned()];
        if let Some(mode) = mode {
            argv.push(mode.into());
        }
        argv.extend([
            request_path.to_string_lossy().into_owned(),
            sdk_path.to_string_lossy().into_owned(),
        ]);
        let outcome = invoke(&argv, &root, &dir.join("index-process.json"), helper, &pins)?;
        let observed = json_success(&outcome)?;
        if kind == "retained-scope" {
            if source_component_mode {
                source_component_observation_binding(&observed, &request)?;
            }
            observation_bound_to_request(&observed, &request, &read_json(sdk_path)?, artifact_sha)?;
            let sdk = read_json(sdk_path)?;
            let ast = scope_ast::observe(
                &request,
                &sdk,
                &observed,
                artifact_sha,
                value_text(fixture, "public_consumer_artifact_sha256")?,
            )?;
            let mut broad_query = recipe["broad_discovery_request"].clone();
            broad_query["repositoryRoot"] = json!(cwd);
            let broad_path = dir.join("scope-broad-discovery.json");
            save(&broad_path, &broad_query)?;
            let outcome = invoke(
                &[
                    artifact.to_string_lossy().into_owned(),
                    "--discover-repository".into(),
                    broad_path.to_string_lossy().into_owned(),
                ],
                &root,
                &dir.join("scope-broad-process.json"),
                helper,
                &pins,
            )?;
            let broad = json_success(&outcome)?;
            if broad["request_descriptor_id"] != identity::digest(&broad_query)
                || broad["producer_artifact_id"] != format!("sha256:{artifact_sha}")
            {
                return Err("scope broad native binding mismatch".into());
            }
            observations["rust_scope_projection"] = scope_ast::project(
                &observed,
                &ast,
                &recipe["scope_input"]["graph"],
                &broad,
                value_text(&recipe["scope_input"], "expectedInputHash")?,
                value_text(&recipe["scope_input"], "consumed_digest")?,
            )?;
            observations["scope_ast_receipt"] = ast;
            observations["raw_scope"] = observed;
            observations["scope_broad_discovery"] = broad;
        } else {
            let receipt = batch_binding::validate_batch(
                &observed,
                &request,
                &read_json(sdk_path)?,
                artifact_sha,
            )?;
            save(&dir.join("native-index-batch-observed.json"), &observed)?;
            save(&dir.join("native-index-binding-receipt.json"), &receipt)?;
            observations["batch_binding_receipt"] = receipt.clone();
            if receipt["admissible_index_store"] != true {
                observations["index_controlled_refusal"] = json!(true);
                observations["index_store_written"] = json!(false);
                observations["index_batch"] = observed;
                save(
                    &dir.join("public-lifecycle-observations.json"),
                    &observations,
                )?;
                return Ok(
                    json!({"state":"BOUND_CONTROLLED_INDEX_REFUSAL", "observed": observations, "pass":false, "global_admission_inferred":false}),
                );
            }
            let store_path = dir.join("transient-index.json");
            save(&store_path, &observed)?;
            let readback = read_json(&store_path)?;
            if readback != observed {
                return Err("transient native index readback differs".into());
            }
            observations["index_store_written"] = json!(true);
            observations["index_store_readback_equal"] = json!(true);
            observations["index_batch_id"] = json!(identity::digest(&observed));
            observations["index_batch"] = observed;
            if kind == "public-verify" {
                let descriptor = json!({"repositoryRoot":cwd,"processHelper":helper,"include":recipe["include"],"exclude":recipe["exclude"],
                    "index":{"analysis":request,"outcome":outcome,"baseCommit":head.stdout.trim()}});
                let path = dir.join("verify-descriptor.json");
                save(&path, &descriptor)?;
                let outcome = invoke(
                    &[
                        artifact.to_string_lossy().into_owned(),
                        "verify".into(),
                        "working-tree".into(),
                        path.to_string_lossy().into_owned(),
                        sdk_path.to_string_lossy().into_owned(),
                        "--fail-on".into(),
                        "none".into(),
                    ],
                    &root,
                    &dir.join("verify-process.json"),
                    helper,
                    &pins,
                )?;
                observations["verify_process"] =
                    serde_json::to_value(outcome).map_err(|e| e.to_string())?;
                observations["projection_gap"] = recipe["projection_gap"].clone();
            }
        }
        observations["actual_native_invocation_refs"] = json!(["index-process.json"]);
    }
    save(
        &dir.join("public-lifecycle-observations.json"),
        &observations,
    )?;
    Ok(
        json!({"state":"OBSERVED_PUBLIC_LIFECYCLE_REQUIRES_FROZEN_PURE_PROJECTOR","observed":observations,
        "pass":false,"global_admission_inferred":false,"invocation_group_id":recipe["invocation_group_id"]}),
    )
}
