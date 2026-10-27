use super::*;

fn merged_workers(jobs: &[Value], expected_modules: &Value) -> Result<Value, String> {
    let modules = expected_modules
        .as_array()
        .ok_or("parallel direct module order absent")?;
    let ranks = modules
        .iter()
        .enumerate()
        .map(|(i, p)| {
            p.as_str()
                .map(|p| (p.to_owned(), i))
                .ok_or("parallel direct module path absent")
        })
        .collect::<Result<BTreeMap<_, _>, _>>()?;
    if ranks.len() != modules.len() {
        return Err("parallel direct duplicate modules".into());
    }
    let responses = jobs
        .iter()
        .map(|job| {
            serde_json::from_str::<Value>(value_text(&job["outcome"], "stdout")?)
                .map_err(|e| e.to_string())
        })
        .collect::<Result<Vec<_>, _>>()?;
    let mut merged = json!({});
    for (field, owner, line) in [
        ("modules", "", ""),
        ("symbols", "relPath", "startLine"),
        ("imports", "fromRelPath", "line"),
        ("calls", "callerRelPath", "line"),
    ] {
        let mut items = vec![];
        for response in &responses {
            items.extend(
                response["extraction"][field]
                    .as_array()
                    .ok_or("parallel worker extraction array absent")?
                    .iter()
                    .cloned(),
            );
        }
        let mut keyed = items
            .into_iter()
            .map(|item| {
                let path = if field == "modules" {
                    item.as_str()
                } else {
                    item[owner].as_str()
                }
                .ok_or("parallel worker item owner absent")?;
                let rank = *ranks
                    .get(path)
                    .ok_or("parallel worker emitted foreign owner")?;
                let line = if field == "modules" {
                    0
                } else {
                    item[line]
                        .as_u64()
                        .ok_or("parallel worker item line absent")?
                };
                Ok((rank, line, item))
            })
            .collect::<Result<Vec<_>, String>>()?;
        keyed.sort_by_key(|(rank, line, _)| (*rank, *line));
        merged[field] = json!(
            keyed
                .into_iter()
                .map(|(_, _, item)| item)
                .collect::<Vec<_>>()
        );
    }
    if merged["modules"] != *expected_modules {
        return Err("parallel workers do not cover direct modules exactly once".into());
    }
    Ok(merged)
}

fn verify_controller_header(
    observed: &Value,
    descriptor: &Value,
    sdk: &Value,
    artifact_sha: &str,
) -> Result<(), String> {
    if observed["request_descriptor_id"] != identity::digest(descriptor)
        || observed["producer_artifact_id"] != format!("sha256:{artifact_sha}")
        || observed["sdk_input_id"] != identity::digest(sdk)
        || observed["executed"] != true
        || observed["unsupported"] != json!([])
        || observed["globalAdmissionInferred"] != false
        || observed["observationScope"] != "native_type_script_parallel_extraction"
    {
        return Err("parallel observation incomplete or foreign".into());
    }
    Ok(())
}

fn verify_parallel(
    observed: &Value,
    descriptor: &Value,
    capture: &Value,
    direct: &Value,
    sdk: &Value,
    artifact_sha: &str,
    helper_sha: &str,
) -> Result<Value, String> {
    verify_controller_header(observed, descriptor, sdk, artifact_sha)?;
    let roots = descriptor["rootAbsPaths"]
        .as_array()
        .ok_or("parallel exact roots absent")?;
    let sources = capture["files"]
        .as_object()
        .ok_or("parallel capture inventory absent")?;
    let sensitive = capture["case_sensitive"]
        .as_bool()
        .ok_or("parallel native case context absent")?;
    let count = descriptor["workers"]
        .as_u64()
        .ok_or("parallel worker count absent")?;
    let jobs = observed["jobs"].as_array().ok_or("parallel jobs absent")?;
    if count == 1 {
        if !jobs.is_empty()
            || observed["parallelism"] != json!({"requested":1,"used":1,"mode":"single"})
        {
            return Err("parallel single observation not a native single Program".into());
        }
        let request = json!({"schemaVersion":1,"jobId":"parallel-single","repoRoot":capture["cwd"],"rootAbsPaths":roots,"emitAbsPaths":roots});
        if observed["singleRequest"] != request
            || observed["singleObservation"]["ok"] != true
            || observed["singleObservation"]["extraction"] != observed["extraction"]
        {
            return Err("parallel single extraction not bound to actual request".into());
        }
        return worker_read_provenance(
            &observed["singleObservation"],
            &request,
            sources,
            sdk,
            sensitive,
        );
    }
    if count != 2
        || jobs.len() != 2
        || observed["parallelism"] != json!({"requested":2,"used":2,"mode":"parallel"})
        || observed["helperArtifactId"] != format!("sha256:{helper_sha}")
    {
        return Err("parallel two-worker execution absent or foreign helper".into());
    }
    let preflight = &observed["preflight"];
    if preflight["noLib"] != true
        || preflight["types"] != json!([])
        || preflight["safe"] != true
        || preflight["unsafeReason"] != Value::Null
        || preflight["moduleComponents"]["executed"] != true
        || preflight["moduleComponents"]["unsupported"] != json!([])
    {
        return Err("parallel actual preflight incomplete or unsafe".into());
    }
    let preflight_reads = join_successful_reads(
        &json!({"capture_probes":preflight["compiler_probes"]}),
        capture,
        sdk,
    )?;
    if !roots.iter().all(|p| {
        preflight_reads["read_paths"]
            .as_array()
            .is_some_and(|paths| paths.contains(p))
    }) {
        return Err("parallel preflight omitted actual root read".into());
    }
    let declarations = roots
        .iter()
        .filter(|p| p.as_str().is_some_and(|p| p.ends_with(".d.ts")))
        .cloned()
        .collect::<Vec<_>>();
    let expected = roots
        .iter()
        .filter(|p| !declarations.contains(p))
        .cloned()
        .collect::<Vec<_>>();
    let mut emitted = vec![];
    let mut pids = BTreeSet::new();
    let mut provenance = vec![];
    let parent = observed["producer_process_id"]
        .as_u64()
        .filter(|p| *p > 0)
        .ok_or("parallel controller process absent")?;
    for (index, job) in jobs.iter().enumerate() {
        let emit = job["request"]["emitAbsPaths"]
            .as_array()
            .filter(|a| !a.is_empty())
            .ok_or("parallel empty emitted chunk")?;
        if !emit.iter().all(|p| expected.contains(p)) {
            return Err("parallel foreign emitted root".into());
        }
        let job_roots = emit
            .iter()
            .chain(&declarations)
            .cloned()
            .collect::<Vec<_>>();
        let request = json!({"schemaVersion":1,"jobId":format!("typescript-chunk-{}-of-{}",index+1,jobs.len()),"repoRoot":capture["cwd"],"rootAbsPaths":job_roots,"emitAbsPaths":emit});
        if job["request"] != request
            || job["responseAccepted"] != true
            || job["transportError"] != Value::Null
        {
            return Err("parallel child request or transport rejected".into());
        }
        let outcome: process::Outcome =
            serde_json::from_value(job["outcome"].clone()).map_err(|e| e.to_string())?;
        if outcome.kind != "success"
            || outcome.exit_code != Some(0)
            || outcome.stdout_bytes != outcome.stdout.len() as u64
            || outcome.stderr_bytes != outcome.stderr.len() as u64
            || outcome.stdout_hash != sha(outcome.stdout.as_bytes())
            || outcome.stderr_hash != sha(outcome.stderr.as_bytes())
        {
            return Err("parallel child outcome incomplete or nonpass".into());
        }
        let response: Value = serde_json::from_str(&outcome.stdout).map_err(|e| e.to_string())?;
        worker_bound_to_request(&response, &request, sdk, artifact_sha, false)?;
        let pid = response["producer_process_id"]
            .as_u64()
            .filter(|p| *p > 0)
            .ok_or("parallel child process absent")?;
        if pid == parent || !pids.insert(pid) {
            return Err("parallel child process reused".into());
        }
        provenance.push(worker_read_provenance(
            &response, &request, sources, sdk, sensitive,
        )?);
        emitted.extend(emit.iter().cloned());
    }
    let key = |v: &Value| {
        v.as_str()
            .map(str::to_owned)
            .ok_or("parallel root not string")
    };
    let mut actual = emitted.iter().map(key).collect::<Result<Vec<_>, _>>()?;
    actual.sort();
    let mut expected = expected.iter().map(key).collect::<Result<Vec<_>, _>>()?;
    expected.sort();
    if actual != expected {
        return Err("parallel emitted chunks do not partition exact roots".into());
    }
    if merged_workers(jobs, &direct["raw_extraction"]["modules"])? != observed["extraction"] {
        return Err("parallel controller merge differs from actual worker outputs".into());
    }
    Ok(
        json!({"state":"BOUND_NATIVE_PARALLEL_WORKERS_AND_REPORTED_READS","worker_provenance":provenance,"preflight_reads":preflight_reads,"global_admission_inferred":false,"capture_atomicity_claimed":false,"os_sandbox_claimed":false}),
    )
}

fn extraction_relation(actual: &Value, expected: &Value) -> Result<Value, String> {
    for value in [actual, expected] {
        for field in ["modules", "symbols", "imports", "calls"] {
            value[field]
                .as_array()
                .ok_or("parallel extraction relation requires all four actual arrays")?;
        }
    }
    let bytes = serde_json::to_vec(actual).map_err(|e| e.to_string())?;
    let expected = serde_json::to_vec(expected).map_err(|e| e.to_string())?;
    Ok(json!({"pass":bytes==expected,"serialized_sha256":sha(&bytes),"bytes":bytes.len()}))
}

pub(super) fn run(
    recipe: &Value,
    dir: &Path,
    artifact: &Path,
    helper: &Path,
    sdk_input: (&Path, &Value),
    artifact_sha: &str,
    helper_sha: &str,
) -> Result<Value, String> {
    let (sdk_path, sdk) = sdk_input;
    let direct_dir = dir.join("direct");
    let direct_result = run_raw_recipe(
        &recipe["direct_recipe"],
        &direct_dir,
        artifact,
        helper,
        (sdk_path, sdk),
        artifact_sha,
        helper_sha,
    )?;
    if direct_result["pass"] != true {
        return Ok(
            json!({"state":"PARALLEL_DIRECT_CONTROL_NONPASS","direct":direct_result,"pass":false}),
        );
    }
    let capture = read_json(&direct_dir.join("request.json"))?;
    let direct_outcome = read_json(&direct_dir.join("process-outcome.json"))?;
    let direct: Value =
        serde_json::from_str(value_text(&direct_outcome, "stdout")?).map_err(|e| e.to_string())?;
    let mut observations = vec![];
    let mut bindings = vec![];
    for (index, workers) in recipe["parallel_worker_counts"]
        .as_array()
        .ok_or("parallel invocation counts absent")?
        .iter()
        .enumerate()
    {
        let subdir = dir.join(format!("controller-{index}"));
        fs::create_dir_all(&subdir).map_err(|e| e.to_string())?;
        let descriptor =
            json!({"repoRoot":capture["cwd"],"rootAbsPaths":capture["roots"],"workers":workers});
        let request = subdir.join("request.json");
        save(&request, &descriptor)?;
        let before = json!({"artifact_sha256":exact_hash(artifact,artifact_sha)?,"helper_sha256":exact_hash(helper,helper_sha)?});
        let argv = vec![
            artifact.to_string_lossy().into_owned(),
            "--extract-parallel".into(),
            request.to_string_lossy().into_owned(),
            sdk_path.to_string_lossy().into_owned(),
            helper.to_string_lossy().into_owned(),
        ];
        let outcome = process::run_with_helper(
            &argv,
            Path::new(value_text(&capture, "cwd")?),
            20_000,
            8_388_608,
            helper,
        )
        .map_err(|e| e.to_string())?;
        save(
            &subdir.join("process-outcome.json"),
            &serde_json::to_value(&outcome).map_err(|e| e.to_string())?,
        )?;
        save(
            &subdir.join("process-invocation.json"),
            &json!({"argv":argv,"cwd":capture["cwd"],"timeout_ms":20_000,"output_cap":8_388_608,"process_outcome_id":identity::digest(&serde_json::to_value(&outcome).map_err(|e|e.to_string())?)}),
        )?;
        save(
            &subdir.join("artifact-observation.json"),
            &json!({"before":before,"after":{"artifact_sha256":exact_hash(artifact,artifact_sha)?,"helper_sha256":exact_hash(helper,helper_sha)?}}),
        )?;
        if outcome.kind != "success" || outcome.exit_code != Some(0) {
            return Ok(json!({"state":"PARALLEL_CONTROLLER_PROCESS_NONPASS","pass":false}));
        }
        let observed: Value = serde_json::from_str(&outcome.stdout).map_err(|e| e.to_string())?;
        let binding = verify_parallel(
            &observed,
            &descriptor,
            &capture,
            &direct,
            sdk,
            artifact_sha,
            helper_sha,
        )?;
        save(&subdir.join("verified-input-binding.json"), &binding)?;
        if let Some(jobs) = observed["jobs"].as_array() {
            for (i, job) in jobs.iter().enumerate() {
                let path = subdir.join(format!("worker-{i}"));
                fs::create_dir_all(&path).map_err(|e| e.to_string())?;
                save(&path.join("process-outcome.json"), &job["outcome"])?;
                save(&path.join("request.json"), &job["request"])?;
            }
        }
        observations.push(observed);
        bindings.push(binding);
    }
    let checks=recipe["checks"].as_array().ok_or("parallel checks absent")?.iter().map(|c| {
        let index=c["observation"].as_u64().unwrap_or(0) as usize;
        json!({"expected_origin":c["expected_origin"],"target":c["target"],"result":observations.get(index).map(|v|evaluate(v,c)).unwrap_or(json!({"state":"MISSING_NATIVE_OBSERVATION"}))})
    }).collect::<Vec<_>>();
    let direct_bytes = serde_json::to_vec(&direct["raw_extraction"]).map_err(|e| e.to_string())?;
    let relations = observations
        .iter()
        .map(|o| extraction_relation(&o["extraction"], &direct["raw_extraction"]))
        .collect::<Result<Vec<_>, _>>()?;
    let pass = observations.len() == 2
        && !checks.is_empty()
        && checks
            .iter()
            .all(|c| c["result"]["state"] == "PASS_PROJECTED_PROPERTY")
        && relations.iter().all(|r| r["pass"] == true);
    let result = json!({"state":if pass{"PASS_FROZEN_NATIVE_PARALLEL_PROJECTED_UNIT"}else{"NONPASS_NATIVE_PARALLEL_PROJECTED_UNIT"},"pass":pass,"checks":checks,"relations":relations,"direct_serialized_sha256":sha(&direct_bytes),"bindings":bindings,"global_admission_inferred":false});
    save(&dir.join("result.json"), &result)?;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn comparator_parallel_header_requires_exact_execution_and_native_bindings() {
        let descriptor =
            json!({"repoRoot":"/development","rootAbsPaths":["/development/owned.ts"],"workers":2});
        let sdk = json!({"version":"development-pinned-sdk"});
        let good = json!({"request_descriptor_id":identity::digest(&descriptor),"producer_artifact_id":"sha256:development-native-artifact","sdk_input_id":identity::digest(&sdk),"executed":true,"unsupported":[],"globalAdmissionInferred":false,"observationScope":"native_type_script_parallel_extraction"});
        assert!(
            verify_controller_header(&good, &descriptor, &sdk, "development-native-artifact")
                .is_ok()
        );
        for field in [
            "request_descriptor_id",
            "producer_artifact_id",
            "sdk_input_id",
            "executed",
            "unsupported",
            "globalAdmissionInferred",
            "observationScope",
        ] {
            let mut missing = good.clone();
            missing.as_object_mut().unwrap().remove(field);
            assert!(
                verify_controller_header(
                    &missing,
                    &descriptor,
                    &sdk,
                    "development-native-artifact"
                )
                .is_err(),
                "{field}"
            );
            let mut null = good.clone();
            null[field] = Value::Null;
            assert!(
                verify_controller_header(&null, &descriptor, &sdk, "development-native-artifact")
                    .is_err(),
                "{field}"
            );
        }
        for (field, value) in [
            ("executed", json!(false)),
            ("unsupported", json!(["unavailable"])),
            ("globalAdmissionInferred", json!(true)),
            ("observationScope", json!("foreign-component")),
            ("request_descriptor_id", json!("foreign-input")),
            ("producer_artifact_id", json!("foreign-artifact")),
            ("sdk_input_id", json!("foreign-sdk")),
        ] {
            let mut poisoned = good.clone();
            poisoned[field] = value;
            assert!(
                verify_controller_header(
                    &poisoned,
                    &descriptor,
                    &sdk,
                    "development-native-artifact"
                )
                .is_err(),
                "{field}"
            );
        }
    }

    #[test]
    fn comparator_parallel_byte_relation_preserves_order_and_every_field() {
        let expected = json!({"modules":["first.ts","second.ts"],"symbols":[{"name":"first"},{"name":"second"}],"imports":[],"calls":[]});
        assert_eq!(
            extraction_relation(&expected, &expected).unwrap()["pass"],
            true
        );
        let mut reordered = expected.clone();
        reordered["symbols"].as_array_mut().unwrap().reverse();
        assert_eq!(
            extraction_relation(&reordered, &expected).unwrap()["pass"],
            false
        );
        let mut extra = expected.clone();
        extra["extra"] = json!("observed-extra");
        assert_eq!(
            extraction_relation(&extra, &expected).unwrap()["pass"],
            false
        );
        for field in ["modules", "symbols", "imports", "calls"] {
            let mut missing = expected.clone();
            missing.as_object_mut().unwrap().remove(field);
            assert!(extraction_relation(&missing, &expected).is_err());
            assert!(extraction_relation(&expected, &missing).is_err());
        }
        assert!(extraction_relation(&Value::Null, &Value::Null).is_err());
    }
}
