use super::*;

fn comparison_key(path: &str) -> Result<String, String> {
    let path = path.replace('\\', "/");
    let path = path
        .strip_prefix("//?/")
        .filter(|rest| {
            rest.as_bytes().first().is_some_and(u8::is_ascii_alphabetic)
                && rest.as_bytes().get(1) == Some(&b':')
                && rest.as_bytes().get(2) == Some(&b'/')
        })
        .unwrap_or(&path);
    verifier_absolute_key(path, true)
}

fn project(
    observed: &Value,
    request: &Value,
    artifact_sha: &str,
    sources: &serde_json::Map<String, Value>,
    expected_reads: &Value,
) -> Result<Value, String> {
    if observed["executed"] != true
        || observed["unsupported"] != json!([])
        || observed["request_descriptor_id"] != identity::digest(request)
        || observed["producer_artifact_id"] != format!("sha256:{artifact_sha}")
        || observed["repositoryRoot"] != request["repositoryRoot"]
        || observed["observation_scope"] != "native_ordinary_repository_discovery"
        || observed["global_admission_inferred"] != false
    {
        return Err("discovery observation incomplete or foreign".into());
    }
    let root = value_text(request, "repositoryRoot")?;
    let root_key = comparison_key(root)?;
    let root_prefix = format!("{}/", root_key.trim_end_matches('/'));
    let candidates = observed["candidates"]
        .as_array()
        .ok_or("native discovery candidate inventory missing")?;
    let mut paths = BTreeSet::new();
    for candidate in candidates {
        let path = value_text(candidate, "relPath")?;
        if !sources.contains_key(path) || !paths.insert(path.to_owned()) {
            return Err("native discovery candidate omitted, duplicated or foreign".into());
        }
    }
    if paths != sources.keys().cloned().collect() {
        return Err("native discovery candidate denominator differs".into());
    }
    let mut selected = BTreeSet::new();
    let mut projection = vec![];
    for file in observed["files"]
        .as_array()
        .ok_or("native discovery selected files absent")?
    {
        let path = value_text(file, "relPath")?;
        let candidate = candidates
            .iter()
            .find(|candidate| candidate["relPath"] == path)
            .ok_or("discovery selected file has no candidate")?;
        if !selected.insert(path.to_owned())
            || sources.get(path) != file.get("content")
            || file["absPath"] != format!("{root}/{path}")
            || candidate["selectionDecision"] != "selected"
            || candidate["reason"] != "SELECTED"
            || candidate.get("analysisOutcome").is_some()
            || file["language"] != candidate["language"]
        {
            return Err("discovery selected source or candidate binding differs".into());
        }
        projection.push(json!({"path":path,"role":file["role"],"language":file["language"]}));
    }
    let selected_candidates = candidates
        .iter()
        .filter(|candidate| {
            candidate["reason"] == "SELECTED"
                && candidate["selectionDecision"] == "selected"
                && candidate.get("analysisOutcome").is_none()
        })
        .map(|candidate| value_text(candidate, "relPath").map(str::to_owned))
        .collect::<Result<BTreeSet<_>, _>>()?;
    if selected != selected_candidates {
        return Err("discovery selected file inventory is incomplete".into());
    }
    let expected_reads = expected_reads
        .as_array()
        .ok_or("discovery expected read denominator absent")?
        .iter()
        .map(|path| {
            path.as_str()
                .map(str::to_owned)
                .ok_or("invalid discovery expected read path")
        })
        .collect::<Result<BTreeSet<_>, _>>()?;
    let mut reads = BTreeSet::new();
    for read in observed["reads"]
        .as_array()
        .ok_or("native discovery raw reads missing")?
    {
        let path = value_text(read, "path")?
            .strip_prefix(&format!("{root}/"))
            .ok_or("discovery reported a foreign read")?;
        let text = sources
            .get(path)
            .and_then(Value::as_str)
            .ok_or("discovery reported unknown source bytes")?;
        if !reads.insert(path.to_owned())
            || read["raw_bytes_sha256"] != identity::digest_bytes(text.as_bytes())
            || read.get("error").is_some()
        {
            return Err("discovery read bytes, identity or uniqueness differs".into());
        }
    }
    if reads != expected_reads {
        return Err("discovery reported read denominator differs".into());
    }
    for probe in observed["resolution_probes"]
        .as_array()
        .ok_or("native discovery resolution probes missing")?
    {
        let operation = value_text(probe, "operation")?;
        let path = value_text(probe, "path")?;
        let found = probe["found"]
            .as_bool()
            .ok_or("discovery native probe outcome absent")?;
        if ![
            "read_file",
            "file_exists",
            "directory_exists",
            "directory_entries",
            "stat",
            "realpath",
        ]
        .contains(&operation)
        {
            return Err("discovery native probe operation unknown".into());
        }
        let path_key = comparison_key(path)?;
        if found && path_key != root_key && !path_key.starts_with(&root_prefix) {
            return Err("discovery positive native probe outside root".into());
        }
        if operation == "read_file" && found {
            let relative = path_key
                .strip_prefix(&root_prefix)
                .ok_or("discovery metadata read outside root")?;
            let source = sources
                .get(relative)
                .and_then(Value::as_str)
                .ok_or("discovery native metadata read has no frozen bytes")?;
            if probe["raw_bytes_sha256"] != identity::digest_bytes(source.as_bytes()) {
                return Err("discovery native metadata read bytes differ".into());
            }
        } else if probe.get("raw_bytes_sha256").is_some() {
            return Err("discovery non-read probe invents source bytes".into());
        }
    }
    let outside = candidates.iter().any(|candidate| {
        matches!(
            candidate["reason"].as_str(),
            Some(
                "IMPORT_OUTSIDE_REPOSITORY"
                    | "REFERENCE_OUTSIDE_REPOSITORY"
                    | "SOURCE_LINK_OUTSIDE_REPOSITORY"
            )
        )
    });
    Ok(
        json!({"selected_files_projection":projection,"candidate_reasons":candidates.iter().map(|candidate|candidate["reason"].clone()).collect::<Vec<_>>(),"candidates":candidates,"selected_discovered_files_contains_main":selected.contains("src/main.ts"),"outside_repository_failure":outside,"raw_read_denominator_checked":true,"global_admission_inferred":false}),
    )
}

fn eligibility_projection(
    observed: &Value,
    request: &Value,
    artifact_sha: &str,
    helper_sha: &str,
    sources: &serde_json::Map<String, Value>,
    established: bool,
) -> Result<(), String> {
    if observed["executed"] != true
        || observed["unsupported"] != json!([])
        || observed["observation_scope"] != "native_qualified_path_eligibility"
        || observed["global_admission_inferred"] != false
        || observed["request_descriptor_id"] != identity::digest(request)
        || observed["producer_artifact_id"] != format!("sha256:{artifact_sha}")
        || observed["helper_sha256"] != format!("sha256:{helper_sha}")
        || comparison_key(value_text(observed, "repositoryRoot")?)?
            != comparison_key(value_text(request, "repositoryRoot")?)?
        || observed["eligibility_established"] != established
        || observed["git_argv"]
            != json!([
                "git",
                "ls-files",
                "-z",
                "--cached",
                "--others",
                "--exclude-per-directory=.gitignore"
            ])
    {
        return Err("eligibility observation is unbound or incomplete".into());
    }
    let git: process::Outcome =
        serde_json::from_value(observed["git_outcome"].clone()).map_err(|e| e.to_string())?;
    if git.duration_ms > 5_000
        || git.stdout.len() > 8_388_608
        || git.stderr.len() > 8_388_608
        || git.stdout_bytes != git.stdout.len() as u64
        || git.stderr_bytes != git.stderr.len() as u64
        || git.stdout_hash != sha(git.stdout.as_bytes())
        || git.stderr_hash != sha(git.stderr.as_bytes())
    {
        return Err("eligibility Git capture is incomplete".into());
    }
    let reads = observed["reads"]
        .as_array()
        .ok_or("eligibility reads missing")?;
    if !established {
        if git.kind != "nonzero"
            || git.exit_code.is_none_or(|code| code == 0)
            || observed["eligible_results"] != Value::Null
            || !reads.is_empty()
        {
            return Err("eligibility did not preserve the actual Git failure".into());
        }
        return Ok(());
    }
    if git.kind != "success"
        || git.exit_code != Some(0)
        || !observed["error"].is_null()
        || observed["queries"] != request["queries"]
    {
        return Err("eligibility did not complete the requested Git query".into());
    }
    let results = observed["eligible_results"]
        .as_array()
        .ok_or("eligibility results missing")?;
    if results.len()
        != request["queries"]
            .as_array()
            .ok_or("eligibility queries missing")?
            .len()
        || results.iter().any(|value| !value.is_boolean())
    {
        return Err("eligibility result denominator differs".into());
    }
    let root = comparison_key(value_text(request, "repositoryRoot")?)?;
    let prefix = format!("{}/", root.trim_end_matches('/'));
    let mut paths = BTreeSet::new();
    for read in reads {
        let key = comparison_key(value_text(read, "path")?)?;
        let relative = key
            .strip_prefix(&prefix)
            .ok_or("eligibility metadata read outside root")?;
        let text = sources
            .get(relative)
            .and_then(Value::as_str)
            .ok_or("eligibility metadata bytes unknown")?;
        if !paths.insert(relative.to_owned())
            || read["content_id"] != identity::digest_bytes(text.as_bytes())
        {
            return Err("eligibility metadata read identity differs".into());
        }
    }
    if paths != BTreeSet::from(["dist/tsconfig.json".into(), "dist/base.json".into()]) {
        return Err("eligibility causal metadata read denominator differs".into());
    }
    Ok(())
}

pub(super) fn run_eligibility(
    recipe: &Value,
    dir: &Path,
    artifact: &Path,
    helper: &Path,
    artifact_sha: &str,
    helper_sha: &str,
) -> Result<Value, String> {
    if !recipe["gaps"]
        .as_array()
        .ok_or("eligibility gaps missing")?
        .is_empty()
    {
        return Err("eligibility recipe still has gaps".into());
    }
    let sources = recipe["physical_files"]
        .as_object()
        .ok_or("eligibility sources missing")?;
    let mut results = Vec::new();
    for (index, git_present) in [true, false].into_iter().enumerate() {
        let evidence = dir.join(format!("context-{index}"));
        let root = evidence.join("workspace");
        fs::create_dir_all(&root).map_err(|e| e.to_string())?;
        for (path, text) in sources {
            if !safe_relative(path) {
                return Err("eligibility source escapes workspace".into());
            }
            let physical = root.join(path);
            fs::create_dir_all(
                physical
                    .parent()
                    .ok_or("eligibility source parent missing")?,
            )
            .map_err(|e| e.to_string())?;
            fs::write(
                physical,
                text.as_str().ok_or("eligibility source is not text")?,
            )
            .map_err(|e| e.to_string())?;
        }
        if git_present {
            let setup = process::run_with_helper(
                &["git".into(), "init".into(), "--quiet".into()],
                &root,
                5_000,
                8_388_608,
                helper,
            )
            .map_err(|e| e.to_string())?;
            save(
                &evidence.join("git-setup.json"),
                &serde_json::to_value(&setup).map_err(|e| e.to_string())?,
            )?;
            if setup.kind != "success" || setup.exit_code != Some(0) {
                return Err("eligibility Git setup failed".into());
            }
        }
        let cwd = root
            .canonicalize()
            .map_err(|e| e.to_string())?
            .to_string_lossy()
            .replace('\\', "/");
        let request = json!({"repositoryRoot":cwd,"processHelper":helper,"include":recipe["include"],"exclude":recipe["exclude"],"queries":recipe["eligibility_queries"]});
        let request_path = evidence.join("request.json");
        save(&request_path, &request)?;
        let before = json!({"artifact":exact_hash(artifact,artifact_sha)?,"helper":exact_hash(helper,helper_sha)?,"request":sha(&fs::read(&request_path).map_err(|e|e.to_string())?)});
        let argv = vec![
            artifact.to_string_lossy().into_owned(),
            "--observe-path-eligibility".into(),
            request_path.to_string_lossy().into_owned(),
        ];
        let outcome = process::run_with_helper(&argv, &root, 20_000, 8_388_608, helper)
            .map_err(|e| e.to_string())?;
        let after = json!({"artifact":exact_hash(artifact,artifact_sha)?,"helper":exact_hash(helper,helper_sha)?,"request":sha(&fs::read(&request_path).map_err(|e|e.to_string())?)});
        save(
            &evidence.join("process.json"),
            &json!({"argv":argv,"cwd":cwd,"before":before,"after":after,"outcome":outcome}),
        )?;
        if before != after || outcome.kind != "success" || outcome.exit_code != Some(0) {
            return Err("eligibility native process failed or inputs changed".into());
        }
        let observed: Value = serde_json::from_str(&outcome.stdout).map_err(|e| e.to_string())?;
        let binding = eligibility_projection(
            &observed,
            &request,
            artifact_sha,
            helper_sha,
            sources,
            git_present,
        );
        let checks = recipe["checks"]
            .as_array()
            .ok_or("eligibility checks missing")?
            .iter()
            .filter(|check| check["observation"] == index)
            .map(|check| json!({"target":check["target"],"result":evaluate(&observed,check)}))
            .collect::<Vec<_>>();
        let pass = binding.is_ok()
            && !checks.is_empty()
            && checks
                .iter()
                .all(|check| check["result"]["state"] == "PASS_PROJECTED_PROPERTY");
        results.push(json!({"pass":pass,"binding":match binding { Ok(())=>json!({"state":"BOUND_NATIVE_GIT_ELIGIBILITY"}),Err(error)=>json!({"error":error}) },"checks":checks}));
    }
    let pass = results.len() == 2 && results.iter().all(|result| result["pass"] == true);
    let result = json!({"pass":pass,"state":if pass{"PASS_FROZEN_GIT_ELIGIBILITY_COMPONENT"}else{"NONPASS_GIT_ELIGIBILITY_COMPONENT"},"contexts":results,"global_admission_inferred":false});
    save(&dir.join("result.json"), &result)?;
    Ok(result)
}

#[test]
fn comparator_eligibility_rejects_foreign_context_incomplete_capture_and_metadata() {
    let sources = serde_json::Map::from_iter([
        (
            "dist/tsconfig.json".into(),
            json!("{\"extends\":\"./base\"}"),
        ),
        ("dist/base.json".into(), json!("{}")),
    ]);
    let request = json!({"repositoryRoot":"/dev","queries":["src/probe.ts"]});
    let stdout = "src/probe.ts\0";
    let git = process::Outcome {
        kind: "success".into(),
        exit_code: Some(0),
        duration_ms: 1,
        stdout: stdout.into(),
        stdout_bytes: stdout.len() as u64,
        stdout_hash: sha(stdout.as_bytes()),
        stderr: String::new(),
        stderr_bytes: 0,
        stderr_hash: sha(b""),
    };
    let reads = sources.iter().map(|(path,text)|json!({"path":format!("/dev/{path}"),"content_id":identity::digest_bytes(text.as_str().unwrap().as_bytes())})).collect::<Vec<_>>();
    let good = json!({"executed":true,"unsupported":[],"observation_scope":"native_qualified_path_eligibility","global_admission_inferred":false,"request_descriptor_id":identity::digest(&request),"producer_artifact_id":"sha256:controlled-dev-producer","helper_sha256":"sha256:controlled-dev-helper","repositoryRoot":"/dev","eligibility_established":true,"git_argv":["git","ls-files","-z","--cached","--others","--exclude-per-directory=.gitignore"],"git_outcome":git,"reads":reads,"eligible_results":[true],"queries":request["queries"],"error":null});
    let check = |observed: &Value, established| {
        eligibility_projection(
            observed,
            &request,
            "controlled-dev-producer",
            "controlled-dev-helper",
            &sources,
            established,
        )
    };
    assert!(check(&good, true).is_ok());
    for (pointer, value) in [
        ("/executed", json!(false)),
        ("/unsupported", json!(["unknown"])),
        ("/request_descriptor_id", json!("foreign")),
        ("/producer_artifact_id", json!("foreign")),
        ("/helper_sha256", json!("foreign")),
        ("/repositoryRoot", json!("/outside")),
        ("/observation_scope", json!("foreign")),
        ("/global_admission_inferred", json!(true)),
        (
            "/git_argv",
            json!(["git", "ls-files", "--exclude-standard"]),
        ),
        ("/git_outcome/stdout_hash", json!("foreign")),
        ("/git_outcome/stdout_bytes", json!(0)),
        ("/git_outcome/kind", json!("timeout")),
        ("/queries", json!([])),
        ("/eligible_results", json!([])),
        ("/eligible_results/0", json!(null)),
        ("/reads", json!([])),
        ("/reads/0/path", json!("/outside/config.json")),
        ("/reads/0/content_id", json!("foreign")),
    ] {
        let mut bad = good.clone();
        *bad.pointer_mut(pointer).unwrap() = value;
        assert!(check(&bad, true).is_err(), "accepted {pointer}");
    }
    let mut failed = good;
    failed["eligibility_established"] = json!(false);
    failed["eligible_results"] = Value::Null;
    failed["reads"] = json!([]);
    failed["git_outcome"]["kind"] = json!("nonzero");
    failed["git_outcome"]["exit_code"] = json!(128);
    assert!(check(&failed, false).is_ok());
    failed["git_outcome"]["exit_code"] = json!(0);
    assert!(check(&failed, false).is_err());
}

pub(super) fn run(
    recipe: &Value,
    dir: &Path,
    artifact: &Path,
    helper: &Path,
    artifact_sha: &str,
    helper_sha: &str,
) -> Result<Value, String> {
    if !recipe["gaps"]
        .as_array()
        .ok_or("discovery gap registry missing")?
        .is_empty()
    {
        return Ok(json!({"pass":false,"state":"NOT_EXECUTABLE_EXPLICIT_GAPS"}));
    }
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let root = dir.join("workspace");
    fs::create_dir(&root).map_err(|e| e.to_string())?;
    let cwd = root
        .canonicalize()
        .map_err(|e| e.to_string())?
        .to_string_lossy()
        .replace('\\', "/");
    let sources = recipe["physical_files"]
        .as_object()
        .ok_or("discovery physical files missing")?;
    for (path, text) in sources {
        if !safe_relative(path) {
            return Err("discovery authored file escapes root".into());
        }
        let target = root.join(path);
        fs::create_dir_all(target.parent().unwrap()).map_err(|e| e.to_string())?;
        fs::write(
            target,
            text.as_str()
                .ok_or("discovery authored source is not text")?,
        )
        .map_err(|e| e.to_string())?;
    }
    for (path, text) in recipe["outside_files"]
        .as_object()
        .ok_or("discovery outside setup missing")?
    {
        let relative = path
            .strip_prefix("../")
            .filter(|p| safe_relative(p))
            .ok_or("discovery outside setup escapes isolated unit directory")?;
        let target = dir.join(relative);
        fs::create_dir_all(target.parent().unwrap()).map_err(|e| e.to_string())?;
        fs::write(
            target,
            text.as_str()
                .ok_or("discovery outside source is not text")?,
        )
        .map_err(|e| e.to_string())?;
    }
    let request = json!({"repositoryRoot":cwd,"config":recipe["discovery_config"]});
    let path = dir.join("request.json");
    save(&path, &request)?;
    let before = json!({"producer":exact_hash(artifact,artifact_sha)?,"helper":exact_hash(helper,helper_sha)?});
    let argv = vec![
        artifact.to_string_lossy().into_owned(),
        "--discover-repository".into(),
        path.to_string_lossy().into_owned(),
    ];
    let outcome = process::run_with_helper(&argv, &root, 20_000, 8_388_608, helper)
        .map_err(|e| e.to_string())?;
    let after = json!({"producer":exact_hash(artifact,artifact_sha)?,"helper":exact_hash(helper,helper_sha)?});
    save(
        &dir.join("process-outcome.json"),
        &serde_json::to_value(&outcome).map_err(|e| e.to_string())?,
    )?;
    save(
        &dir.join("artifact-observation.json"),
        &json!({"argv":argv,"cwd":cwd,"timeout_ms":20000,"output_cap":8388608,"before":before,"after":after,"sdk_required_or_consumed":false}),
    )?;
    let observation = (|| -> Result<Value, String> {
        if outcome.kind != "success"
            || outcome.exit_code != Some(0)
            || outcome.stdout_bytes != outcome.stdout.len() as u64
            || outcome.stderr_bytes != outcome.stderr.len() as u64
            || outcome.stdout_hash != sha(outcome.stdout.as_bytes())
            || outcome.stderr_hash != sha(outcome.stderr.as_bytes())
        {
            return Err("discovery native process or complete capture failed".into());
        }
        let observed = serde_json::from_str(&outcome.stdout).map_err(|e| e.to_string())?;
        save(&dir.join("native-observation.json"), &observed)?;
        project(
            &observed,
            &request,
            artifact_sha,
            sources,
            &recipe["expected_read_paths"],
        )
    })();
    let result = match observation {
        Ok(observed) => {
            let checks=recipe["checks"].as_array().ok_or("discovery checks absent")?.iter().map(|check|json!({"expected_origin":check["expected_origin"],"target":check["target"],"result":evaluate(&observed,check)})).collect::<Vec<_>>();
            let pass = !checks.is_empty()
                && checks
                    .iter()
                    .all(|check| check["result"]["state"] == "PASS_PROJECTED_PROPERTY");
            json!({"pass":pass,"state":if pass{"PASS_FROZEN_NATIVE_REPOSITORY_DISCOVERY_UNIT"}else{"NONPASS_NATIVE_REPOSITORY_DISCOVERY_UNIT"},"observation":observed,"checks":checks,"global_admission_inferred":false})
        }
        Err(error) => {
            json!({"pass":false,"state":"NATIVE_REPOSITORY_DISCOVERY_OBSERVATION_REJECTED","error":error,"global_admission_inferred":false})
        }
    };
    save(&dir.join("result.json"), &result)?;
    Ok(result)
}

#[test]
fn comparator_native_discovery_binds_every_candidate_selected_byte_and_reported_read() {
    let request = json!({"repositoryRoot":"/repo","config":{"version":2}});
    let text = "export function stream(){return 29;}";
    let sources = serde_json::Map::from_iter([("src/stream.ts".into(), json!(text))]);
    let expected_reads = json!(["src/stream.ts"]);
    let observed = json!({"executed":true,"unsupported":[],"request_descriptor_id":identity::digest(&request),"producer_artifact_id":"sha256:development-test-artifact","repositoryRoot":"/repo","observation_scope":"native_ordinary_repository_discovery","global_admission_inferred":false,"candidates":[{"relPath":"src/stream.ts","language":"typescript","selectionDecision":"selected","reason":"SELECTED"}],"files":[{"absPath":"/repo/src/stream.ts","relPath":"src/stream.ts","role":"source","language":"typescript","content":text}],"resolution_probes":[],"reads":[{"path":"/repo/src/stream.ts","raw_bytes_sha256":identity::digest_bytes(text.as_bytes())}]});
    assert!(
        project(
            &observed,
            &request,
            "development-test-artifact",
            &sources,
            &expected_reads
        )
        .is_ok()
    );
    for (pointer, value) in [
        ("/executed", json!(false)),
        ("/unsupported", json!(["missing context"])),
        ("/request_descriptor_id", json!("foreign")),
        ("/producer_artifact_id", json!("foreign")),
        ("/repositoryRoot", json!("/foreign")),
        ("/observation_scope", json!("foreign")),
        ("/global_admission_inferred", json!(true)),
        ("/candidates", json!([])),
        ("/files", json!([])),
        ("/reads", json!([])),
        ("/files/0/content", json!("changed source")),
        ("/files/0/absPath", json!("/outside/stream.ts")),
        ("/reads/0/path", json!("/outside/stream.ts")),
        ("/reads/0/raw_bytes_sha256", json!("forged")),
    ] {
        let mut changed = observed.clone();
        *changed.pointer_mut(pointer).unwrap() = value;
        assert!(
            project(
                &changed,
                &request,
                "development-test-artifact",
                &sources,
                &expected_reads
            )
            .is_err(),
            "{pointer}"
        );
    }
    for array in ["files", "reads", "candidates"] {
        let mut changed = observed.clone();
        let duplicate = changed[array][0].clone();
        changed[array].as_array_mut().unwrap().push(duplicate);
        assert!(
            project(
                &changed,
                &request,
                "development-test-artifact",
                &sources,
                &expected_reads
            )
            .is_err(),
            "duplicate {array}"
        );
    }
    let mut changed = observed.clone();
    changed["candidates"][0]["analysisOutcome"] = json!("success");
    assert!(
        project(
            &changed,
            &request,
            "development-test-artifact",
            &sources,
            &expected_reads
        )
        .is_err()
    );
}

#[test]
fn comparator_native_discovery_refuses_positive_parent_aliases() {
    let request = json!({"repositoryRoot":"/repo"});
    let sources = serde_json::Map::new();
    for path in [
        "/repo/../outside.ts",
        "/repo/src/../../outside.ts",
        "/repo/./../outside.ts",
    ] {
        let observed = json!({"executed":true,"unsupported":[],"request_descriptor_id":identity::digest(&request),"producer_artifact_id":"sha256:development-alias-artifact","repositoryRoot":"/repo","observation_scope":"native_ordinary_repository_discovery","global_admission_inferred":false,"candidates":[],"files":[],"reads":[],"resolution_probes":[{"operation":"file_exists","path":path,"found":true}]});
        assert!(
            project(
                &observed,
                &request,
                "development-alias-artifact",
                &sources,
                &json!([])
            )
            .is_err(),
            "positive parent traversal probe must refuse: {path}"
        );
    }
    for (actual, expected) in [
        ("/repo/./src/../main.ts", "/repo/main.ts"),
        ("C:/repo/src/../main.ts", "C:/repo/main.ts"),
        ("\\\\?\\C:\\repo\\.\\main.ts", "C:/repo/main.ts"),
    ] {
        assert_eq!(comparison_key(actual).unwrap(), expected);
    }
    let mut observed = json!({"executed":true,"unsupported":[],"request_descriptor_id":identity::digest(&request),"producer_artifact_id":"sha256:development-alias-artifact","repositoryRoot":"/repo","observation_scope":"native_ordinary_repository_discovery","global_admission_inferred":false,"candidates":[],"files":[],"reads":[],"resolution_probes":[{"operation":"file_exists","path":"/repo/./src/../main.ts","found":true}]});
    assert!(
        project(
            &observed,
            &request,
            "development-alias-artifact",
            &sources,
            &json!([])
        )
        .is_ok()
    );
    observed["resolution_probes"][0]["path"] = json!("/repo/../outside.ts");
    observed["resolution_probes"][0]["found"] = json!(false);
    assert!(
        project(
            &observed,
            &request,
            "development-alias-artifact",
            &sources,
            &json!([])
        )
        .is_ok()
    );
}
