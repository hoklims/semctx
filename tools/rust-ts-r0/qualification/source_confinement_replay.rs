use super::*;

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct NativeRefusal {
    error: String,
}

fn refusal(outcome: &process::Outcome) -> Result<Value, String> {
    if outcome.kind != "nonzero"
        || outcome.exit_code != Some(1)
        || !outcome.stdout.is_empty()
        || outcome.stdout_bytes != 0
        || outcome.stdout_hash != sha(b"")
        || outcome.stderr_bytes != outcome.stderr.len() as u64
        || outcome.stderr_hash != sha(outcome.stderr.as_bytes())
    {
        return Err("native import refusal process or capture differs".into());
    }
    let shape: Value = serde_json::from_str(&outcome.stderr)
        .map_err(|error| format!("native import refusal is not JSON: {error}"))?;
    if !shape.is_object() {
        return Err("native import refusal must be a JSON object".into());
    }
    let stderr: NativeRefusal = serde_json::from_str(&outcome.stderr)
        .map_err(|error| format!("native import refusal is not JSON: {error}"))?;
    let error = stderr.error;
    if error
        .strip_prefix("IMPORT_OUTSIDE_REPOSITORY: ")
        .is_none_or(|name| name.is_empty())
    {
        return Err("native refusal has an unexpected reason or fields".into());
    }
    Ok(json!({"error":error,"analysis_success":false,"outside_content_imported":false}))
}

pub(super) fn run(
    recipe: &Value,
    dir: &Path,
    artifact: &Path,
    helper: &Path,
    sdk_path: &Path,
    artifact_sha: &str,
    helper_sha: &str,
) -> Result<Value, String> {
    let (timeout_ms, output_cap) = raw_execution_limits(recipe)?;
    let requests = recipe["requests"]
        .as_array()
        .ok_or("confinement requests missing")?;
    if requests.len() != 1
        || !recipe["gaps"]
            .as_array()
            .ok_or("confinement gaps missing")?
            .is_empty()
    {
        return Err("confinement requires one fully mapped request".into());
    }
    fs::create_dir(dir).map_err(|error| error.to_string())?;
    let root = dir.join("workspace");
    fs::create_dir(&root).map_err(|error| error.to_string())?;
    let sentinel = root.join("T00NativeCaseSentinel");
    fs::write(&sentinel, b"native case probe").map_err(|error| error.to_string())?;
    let sensitive = !root.join("t00nativecasesentinel").exists();
    fs::remove_file(sentinel).map_err(|error| error.to_string())?;
    let request = materialize(&requests[0], &root, sensitive)?;
    let mut setup = Vec::new();
    for (path, text) in recipe["outside_files"]
        .as_object()
        .ok_or("confinement physical setup missing")?
    {
        let name = path
            .strip_prefix("../")
            .filter(|name| {
                safe_relative(name) && !name.contains('/') && !name.contains('\\') && *name != "."
            })
            .ok_or("confinement setup requires direct sibling files")?;
        let target = dir.join(name);
        let bytes = text
            .as_str()
            .ok_or("confinement outside source is not text")?
            .as_bytes();
        fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target)
            .and_then(|mut file| file.write_all(bytes))
            .map_err(|error| error.to_string())?;
        setup.push(json!({"authored_path":path,"physical_path":target,"sha256":sha(&fs::read(&target).map_err(|error|error.to_string())?),"included_in_retained_map":false}));
    }
    let request_path = dir.join("request.json");
    save(&request_path, &request)?;
    save(&dir.join("physical-outside-setup.json"), &json!(setup))?;
    let before = json!({"producer":exact_hash(artifact,artifact_sha)?,"helper":exact_hash(helper,helper_sha)?,"sdk_sha256":sha(&fs::read(sdk_path).map_err(|error|error.to_string())?),"request_sha256":sha(&fs::read(&request_path).map_err(|error|error.to_string())?)});
    let argv = vec![
        artifact.to_string_lossy().into_owned(),
        request_path.to_string_lossy().into_owned(),
        sdk_path.to_string_lossy().into_owned(),
    ];
    let outcome = process::run_with_helper(&argv, &root, timeout_ms, output_cap, helper)
        .map_err(|error| error.to_string())?;
    let after = json!({"producer":exact_hash(artifact,artifact_sha)?,"helper":exact_hash(helper,helper_sha)?,"sdk_sha256":sha(&fs::read(sdk_path).map_err(|error|error.to_string())?),"request_sha256":sha(&fs::read(&request_path).map_err(|error|error.to_string())?)});
    save(
        &dir.join("process-outcome.json"),
        &serde_json::to_value(&outcome).map_err(|error| error.to_string())?,
    )?;
    save(
        &dir.join("process-invocation.json"),
        &json!({"argv":argv,"cwd":root,"timeout_ms":timeout_ms,"output_cap":output_cap,"before":before,"after":after}),
    )?;
    if before != after {
        return Err("confinement invocation inputs changed".into());
    }
    let observed = match refusal(&outcome) {
        Ok(observed) => observed,
        Err(error) => {
            return Ok(
                json!({"state":"NATIVE_IMPORT_REFUSAL_NOT_ESTABLISHED","pass":false,"error":error}),
            );
        }
    };
    let checks = recipe["checks"]
        .as_array()
        .filter(|checks| !checks.is_empty())
        .ok_or("confinement checks missing")?;
    let checked = checks.iter().map(|check| json!({"expected_origin":check["expected_origin"],"target":check["target"],"result":evaluate(&observed,check)})).collect::<Vec<_>>();
    save(&dir.join("projected-refusal.json"), &observed)?;
    Ok(
        json!({"state":"EXECUTED_NEGATIVE_NATIVE_PROCESS","pass":checked.iter().all(|check|check["result"]["state"]=="PASS_PROJECTED_PROPERTY"),"checks":checked,"proof_scope":recipe["proof_scope"],"native_processes":1,"global_admission_inferred":false}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rejected() -> process::Outcome {
        let stderr = "{\"error\":\"IMPORT_OUTSIDE_REPOSITORY: ../../outside\"}\n".to_owned();
        process::Outcome {
            kind: "nonzero".into(),
            exit_code: Some(1),
            duration_ms: 1,
            stdout: String::new(),
            stdout_bytes: 0,
            stdout_hash: sha(b""),
            stderr_bytes: stderr.len() as u64,
            stderr_hash: sha(stderr.as_bytes()),
            stderr,
        }
    }

    #[test]
    fn comparator_requires_a_complete_native_import_refusal_without_returned_facts() {
        let observed = refusal(&rejected()).unwrap();
        assert_eq!(observed["analysis_success"], false);
        assert_eq!(observed["outside_content_imported"], false);
        assert_eq!(
            observed["error"],
            "IMPORT_OUTSIDE_REPOSITORY: ../../outside"
        );
    }

    #[test]
    fn comparator_rejects_other_failures_truncation_malformed_output_and_returned_facts() {
        for kind in [
            "success",
            "timeout",
            "cancelled",
            "capture_error",
            "output_limit",
            "malformed_output",
        ] {
            let mut outcome = rejected();
            outcome.kind = kind.into();
            assert!(refusal(&outcome).is_err(), "{kind}");
        }
        for code in [None, Some(0), Some(2), Some(-1)] {
            let mut outcome = rejected();
            outcome.exit_code = code;
            assert!(refusal(&outcome).is_err(), "{code:?}");
        }
        for stderr in [
            "",
            "not JSON",
            "[]",
            "[\"IMPORT_OUTSIDE_REPOSITORY: ../../outside\"]",
            "{}",
            "{\"error\":false}",
            "{\"error\":\"IMPORT_OUTSIDE_REPOSITORY: \"}",
            "{\"error\":\"SOURCE_SNAPSHOT_MISSING: main.ts\"}",
            "{\"error\":\"IMPORT_OUTSIDE_REPOSITORY: ../out\",\"analysis\":{}}",
            "{\"error\":\"IMPORT_OUTSIDE_REPOSITORY: ../out\"}{}",
            "{\"error\":\"SOURCE_SNAPSHOT_MISSING: main.ts\",\"error\":\"IMPORT_OUTSIDE_REPOSITORY: ../out\"}",
        ] {
            let mut outcome = rejected();
            outcome.stderr = stderr.into();
            outcome.stderr_bytes = stderr.len() as u64;
            outcome.stderr_hash = sha(stderr.as_bytes());
            assert!(refusal(&outcome).is_err(), "{stderr}");
        }
        for field in [
            "stdout",
            "stdout_bytes",
            "stdout_hash",
            "stderr_bytes",
            "stderr_hash",
        ] {
            let mut outcome = rejected();
            match field {
                "stdout" => outcome.stdout = "{}".into(),
                "stdout_bytes" => outcome.stdout_bytes = 1,
                "stdout_hash" => outcome.stdout_hash = sha(b"{}"),
                "stderr_bytes" => outcome.stderr_bytes += 1,
                "stderr_hash" => outcome.stderr_hash = sha(b"different"),
                _ => unreachable!(),
            }
            assert!(refusal(&outcome).is_err(), "{field}");
        }
    }
}
