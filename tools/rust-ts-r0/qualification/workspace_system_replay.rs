use super::*;

struct Paths {
    root: String,
    virtual_file: String,
    canonical_file: String,
    outside_file: String,
    outside_directory: String,
}

fn canonical(path: &Path) -> Result<String, String> {
    let path = path.canonicalize().map_err(|e| e.to_string())?;
    repository_replay::comparison_key(path.to_str().ok_or("non-UTF8 workspace System path")?)
}

fn queries(paths: &Paths) -> Value {
    json!([
        {"operation":"file_exists","path":paths.virtual_file},
        {"operation":"read_file","path":paths.virtual_file},
        {"operation":"directory_exists","path":paths.virtual_file.rsplit_once('/').unwrap().0},
        {"operation":"realpath","path":paths.virtual_file},
        {"operation":"file_exists","path":paths.outside_file},
        {"operation":"read_file","path":paths.outside_file},
        {"operation":"directory_exists","path":paths.outside_file},
        {"operation":"realpath","path":paths.outside_file},
        {"operation":"directory_exists","path":paths.outside_directory}
    ])
}

fn project(
    observed: &Value,
    request: &Value,
    artifact_sha: &str,
    paths: &Paths,
) -> Result<Value, String> {
    if observed["executed"] != true
        || observed["unsupported"] != json!([])
        || observed["request_descriptor_id"] != identity::digest(request)
        || observed["requestDescriptorId"] != identity::digest(request)
        || observed["producer_artifact_id"] != format!("sha256:{artifact_sha}")
        || observed
            .get("global_admission_inferred")
            .is_some_and(|value| *value != false)
        || observed["status"] != "development_observation_not_qualification"
        || request["profile"] != "workspace"
        || request["root"] != paths.root
        || request["queries"] != queries(paths)
    {
        return Err("workspace System observation or context is incomplete or foreign".into());
    }
    let root_prefix = format!("{}/", paths.root.trim_end_matches('/'));
    if paths.outside_file == paths.root
        || paths.outside_file.starts_with(&root_prefix)
        || paths.outside_directory == paths.root
        || paths.outside_directory.starts_with(&root_prefix)
    {
        return Err("workspace boundary control is not outside its repository".into());
    }
    let requested = request["queries"]
        .as_array()
        .ok_or("missing System queries")?;
    let results = observed["results"]
        .as_array()
        .ok_or("missing System results")?;
    if results.len() != requested.len() {
        return Err("workspace System query denominator differs".into());
    }
    let mut expected_issues = vec![];
    for (index, (query, result)) in requested.iter().zip(results).enumerate() {
        let refusals = if index < 4 {
            json!([])
        } else {
            json!(["WORKSPACE_PATH_OUTSIDE_ROOT"])
        };
        if result["operation"] != query["operation"]
            || result["path"] != query["path"]
            || result["executed"] != true
            || result["unsupported"] != json!([])
            || result["refusals"] != refusals
        {
            return Err("workspace System query binding or refusal role differs".into());
        }
        if index >= 4 {
            expected_issues.push(json!({"path":query["path"],"kind":"refusal","detail":"WORKSPACE_PATH_OUTSIDE_ROOT"}));
            let expected = match query["operation"].as_str() {
                Some("read_file") => Value::Null,
                Some("realpath") => query["path"].clone(),
                Some("file_exists" | "directory_exists") => json!(false),
                _ => return Err("unexpected boundary control operation".into()),
            };
            if result.get("value") != Some(&expected) {
                return Err("outside System query returned a positive or absent value".into());
            }
        }
    }
    if observed["workspaceIssues"] != json!(expected_issues) {
        return Err("workspace System issue inventory differs".into());
    }
    let joined = join_successful_reads(
        &json!({"capture_probes":observed["probes"]}),
        &json!({"files":request["files"]}),
        &json!({"files":{}}),
    )?;
    let read = &results[1];
    let text = request["files"]
        .get(&paths.canonical_file)
        .and_then(Value::as_str)
        .ok_or("workspace System physical source missing")?;
    let content = identity::digest_bytes(text.as_bytes());
    if read["found"] != true
        || read["value"] != text
        || read["physicalPath"] != paths.canonical_file
        || read["contentId"] != content
        || read["contentIdEncoding"] != "ts_goport_go_string_utf8"
        || read["utf16Units"] != json!(text.encode_utf16().collect::<Vec<_>>())
        || !joined["read_paths"]
            .as_array()
            .unwrap()
            .contains(&json!(paths.canonical_file))
    {
        return Err("workspace System read does not bind its physical source bytes".into());
    }
    let outside = &results[5];
    if outside["found"] != false
        || outside.get("physicalPath") != Some(&Value::Null)
        || outside.get("contentId") != Some(&Value::Null)
        || outside.get("utf16Units") != Some(&Value::Null)
        || observed["probes"]
            .as_array()
            .ok_or("missing workspace probes")?
            .iter()
            .filter(|probe| {
                probe["operation"] == "read_file"
                    && probe["path"] == paths.outside_file
                    && probe["found"] == false
                    && probe.get("content_id") == Some(&Value::Null)
            })
            .count()
            != 1
    {
        return Err("outside System read lacks an explicit negative causal probe".into());
    }
    Ok(
        json!({"fileExists_virtual":results[0]["value"],"readFile_virtual":read["value"],"directoryExists_virtual_parent":results[2]["value"],"realpath_virtual":results[3]["value"],"resolver_inputs_physical":text,"boundary_control":{"fileExists_outside":results[4]["value"],"readFile_outside":{"state":"undefined"},"directoryExists_outside":results[6]["value"],"realpath_outside":results[7]["value"],"resolver_inputs_outside":{"state":"undefined"}},"binding":{"reads":joined,"outside_directory_control":results[8],"global_admission_inferred":false}}),
    )
}

fn context(
    recipe: &Value,
    dir: &Path,
    name: &str,
    fixture: &Value,
) -> Result<(Value, Paths), String> {
    let installed = match name {
        "uninstalled" => false,
        "installed" => true,
        _ => return Err("unknown workspace System context".into()),
    };
    let root = dir.join("workspace");
    fs::create_dir_all(root.join(".git")).map_err(|e| e.to_string())?;
    let root_key = canonical(&root)?;
    let virtual_relative = value_text(recipe, "virtual_path")?;
    let physical_relative = value_text(recipe, "physical_path")?;
    if !safe_relative(virtual_relative) || !safe_relative(physical_relative) {
        return Err("workspace System role path escapes its root".into());
    }
    let mut captured = recipe["system_files"]
        .as_object()
        .ok_or("missing frozen workspace files")?
        .clone();
    if !captured.contains_key(physical_relative) || captured.contains_key(virtual_relative) {
        return Err("frozen workspace System physical/virtual source roles conflict".into());
    }
    if installed {
        captured.insert(
            virtual_relative.into(),
            json!(value_text(recipe, "installed_text")?),
        );
    }
    let mut files = serde_json::Map::new();
    for (path, text) in &captured {
        if !safe_relative(path) {
            return Err("workspace System source escapes its root".into());
        }
        let target = root.join(path);
        fs::create_dir_all(target.parent().ok_or("workspace source parent missing")?)
            .map_err(|e| e.to_string())?;
        let text = text.as_str().ok_or("non-string workspace source")?;
        fs::write(&target, text.as_bytes()).map_err(|e| e.to_string())?;
        if fs::read(&target).map_err(|e| e.to_string())? != text.as_bytes() {
            return Err("physical workspace bytes differ".into());
        }
        files.insert(canonical(&target)?, json!(text));
    }
    let sentinel = root.join("WorkspaceSystemCaseProbe");
    fs::write(&sentinel, b"case").map_err(|e| e.to_string())?;
    let sensitive = !root.join("workspacesystemcaseprobe").exists();
    fs::remove_file(sentinel).map_err(|e| e.to_string())?;
    let outside = dir.join("outside.json");
    fs::write(&outside, b"T00 outside boundary control\n").map_err(|e| e.to_string())?;
    let paths = Paths {
        root: root_key.clone(),
        virtual_file: format!("{root_key}/{virtual_relative}"),
        canonical_file: canonical(&root.join(if installed {
            virtual_relative
        } else {
            physical_relative
        }))?,
        outside_file: canonical(&outside)?,
        outside_directory: canonical(dir)?,
    };
    let request = json!({"root":root_key,"profile":"workspace","case_sensitive":sensitive,"files":files,"utf16_files":{},"raw_files":{},"sdk_directory":null,"queries":queries(&paths)});
    let descriptor = dir.join("request.json");
    save(&descriptor, &request)?;
    save(
        &dir.join("physical-setup.json"),
        &json!({"outside_file":paths.outside_file,"outside_sha256":identity::digest_bytes(&fs::read(&outside).map_err(|e|e.to_string())?),"capture_excludes_outside":!request["files"].as_object().unwrap().contains_key(&paths.outside_file),"canonical_expected_read":paths.canonical_file}),
    )?;
    let artifact = Path::new(value_text(fixture, "artifact_path")?);
    let helper = Path::new(value_text(fixture, "helper_path")?);
    let artifact_sha = value_text(fixture, "artifact_sha256")?;
    let helper_sha = value_text(fixture, "helper_sha256")?;
    let before = json!({"artifact":exact_hash(artifact,artifact_sha)?,"helper":exact_hash(helper,helper_sha)?});
    let argv = vec![
        artifact.to_string_lossy().into_owned(),
        "--observe-system".into(),
        descriptor.to_string_lossy().into_owned(),
    ];
    let outcome = process::run_with_helper(&argv, &root, 20_000, 8_388_608, helper)
        .map_err(|e| e.to_string())?;
    let after = json!({"artifact":exact_hash(artifact,artifact_sha)?,"helper":exact_hash(helper,helper_sha)?});
    save(
        &dir.join("process.json"),
        &json!({"argv":argv,"cwd":root,"before":before,"after":after,"outcome":outcome}),
    )?;
    if outcome.kind != "success"
        || outcome.exit_code != Some(0)
        || [&outcome.stdout, &outcome.stderr]
            .iter()
            .zip([outcome.stdout_bytes, outcome.stderr_bytes])
            .any(|(s, n)| s.len() as u64 != n)
        || sha(outcome.stdout.as_bytes()) != outcome.stdout_hash
        || sha(outcome.stderr.as_bytes()) != outcome.stderr_hash
    {
        return Err("workspace System process did not return a complete successful capture".into());
    }
    let observed = system_observation_json(&outcome.stdout).map_err(|e| e.to_string())?;
    save(&dir.join("native-observation.json"), &observed)?;
    Ok((project(&observed, &request, artifact_sha, &paths)?, paths))
}

pub(super) fn run(recipe: &Value, dir: &Path, fixture: &Value) -> Result<Value, String> {
    if !recipe["gaps"]
        .as_array()
        .ok_or("missing workspace System gap registry")?
        .is_empty()
    {
        return Ok(json!({"pass":false,"state":"NOT_EXECUTABLE_EXPLICIT_GAPS"}));
    }
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let names = recipe["system_contexts"]
        .as_array()
        .ok_or("missing workspace System contexts")?;
    if names.len() != 2
        || !names.contains(&json!("installed"))
        || !names.contains(&json!("uninstalled"))
    {
        return Err("workspace System context denominator differs".into());
    }
    let mut observations = vec![];
    let mut paths = vec![];
    for name in names {
        let (observation, frame) = context(
            recipe,
            &dir.join(name.as_str().ok_or("non-string System context")?),
            name.as_str().unwrap(),
            fixture,
        )?;
        observations.push(observation);
        paths.push(frame);
    }
    let mut checks = vec![];
    for check in recipe["checks"]
        .as_array()
        .ok_or("missing workspace System checks")?
    {
        let index = usize::try_from(
            check["observation"]
                .as_u64()
                .ok_or("missing workspace observation index")?,
        )
        .map_err(|_| "workspace index overflow")?;
        let frame = paths
            .get(index)
            .ok_or("workspace check outside context denominator")?;
        let mut check = check.clone();
        match check["expected"].as_str() {
            Some("NATIVE_CANONICAL_WORKSPACE_SOURCE") => {
                check["expected"] = json!(frame.canonical_file)
            }
            Some("NATIVE_OUTSIDE_INPUT") => check["expected"] = json!(frame.outside_file),
            _ => {}
        }
        checks.push(json!({"expected_origin":check["expected_origin"],"observation":index,"target":check["target"],"result":evaluate(&observations[index],&check)}));
    }
    let pass = !checks.is_empty()
        && checks
            .iter()
            .all(|c| c["result"]["state"] == "PASS_PROJECTED_PROPERTY");
    let result = json!({"state":if pass {"PASS_FROZEN_WORKSPACE_SYSTEM_COMPONENT"} else {"NONPASS_WORKSPACE_SYSTEM_COMPONENT"},"pass":pass,"observations":observations,"checks":checks,"global_admission_inferred":false,"all_os_reads_observed_claimed":false});
    save(&dir.join("result.json"), &result)?;
    Ok(result)
}

#[test]
fn comparator_workspace_system_rejects_foreign_reads_and_uncontrolled_refusals() {
    let paths = Paths {
        root: "/dev/workspace".into(),
        virtual_file: "/dev/workspace/node_modules/@dev/config/node.json".into(),
        canonical_file: "/dev/workspace/tooling/node.json".into(),
        outside_file: "/dev/outside.json".into(),
        outside_directory: "/dev".into(),
    };
    let text = "owned development read";
    let content = identity::digest_bytes(text.as_bytes());
    let request = json!({"root":paths.root,"profile":"workspace","case_sensitive":true,"files":{paths.canonical_file.clone():text},"queries":queries(&paths)});
    let query_values = request["queries"].as_array().unwrap();
    let results = query_values.iter().enumerate().map(|(index, query)| {
        let value = match index { 0|2=>json!(true),1=>json!(text),3=>json!(paths.canonical_file),7=>json!(paths.outside_file),5=>Value::Null,_=>json!(false) };
        let mut result = json!({"operation":query["operation"],"path":query["path"],"executed":true,"unsupported":[],"refusals":if index<4 {json!([])} else {json!(["WORKSPACE_PATH_OUTSIDE_ROOT"])},"value":value});
        if index==1 || index==5 {
            result["found"]=json!(index==1);
            result["physicalPath"]=if index==1 {json!(paths.canonical_file)} else {Value::Null};
            result["contentId"]=if index==1 {json!(content)} else {Value::Null};
            result["utf16Units"]=if index==1 {json!(text.encode_utf16().collect::<Vec<_>>())} else {Value::Null};
            result["contentIdEncoding"]=json!("ts_goport_go_string_utf8");
        }
        result
    }).collect::<Vec<_>>();
    let good = json!({"executed":true,"unsupported":[],"request_descriptor_id":identity::digest(&request),"requestDescriptorId":identity::digest(&request),"producer_artifact_id":"sha256:development","global_admission_inferred":false,"status":"development_observation_not_qualification","results":results,"probes":[{"path":paths.canonical_file,"operation":"read_file","found":true,"content_id":content},{"path":paths.outside_file,"operation":"read_file","found":false,"content_id":null}],"workspaceIssues":query_values[4..].iter().map(|query|json!({"path":query["path"],"kind":"refusal","detail":"WORKSPACE_PATH_OUTSIDE_ROOT"})).collect::<Vec<_>>()});
    assert!(project(&good, &request, "development", &paths).is_ok());
    let mut without_global_claim = good.clone();
    without_global_claim
        .as_object_mut()
        .unwrap()
        .remove("global_admission_inferred");
    assert!(project(&without_global_claim, &request, "development", &paths).is_ok());
    for (pointer, value) in [
        ("/executed", json!(false)),
        ("/unsupported", json!(["missing"])),
        ("/request_descriptor_id", json!("foreign")),
        ("/requestDescriptorId", json!("foreign")),
        ("/producer_artifact_id", json!("sha256:foreign")),
        ("/global_admission_inferred", json!(true)),
        ("/status", json!("qualified")),
        ("/results", json!([])),
        (
            "/results/0/refusals",
            json!(["WORKSPACE_PATH_OUTSIDE_ROOT"]),
        ),
        ("/results/1/value", json!("foreign")),
        ("/results/1/physicalPath", json!(paths.virtual_file)),
        ("/results/1/contentId", json!("foreign")),
        ("/results/1/utf16Units", json!([])),
        ("/results/1/contentIdEncoding", json!("foreign")),
        ("/results/2/operation", json!("file_exists")),
        ("/results/4/value", json!(true)),
        ("/results/5/found", json!(true)),
        ("/results/7/value", json!("changed")),
        ("/results/8/value", json!(true)),
        ("/workspaceIssues", json!([])),
        ("/workspaceIssues/0/detail", json!("foreign")),
        ("/probes", json!([])),
        ("/probes/0/content_id", json!("foreign")),
        ("/probes/1/found", json!(true)),
    ] {
        let mut bad = good.clone();
        *bad.pointer_mut(pointer).unwrap() = value;
        assert!(
            project(&bad, &request, "development", &paths).is_err(),
            "accepted {pointer}"
        );
    }
}

#[test]
fn comparator_workspace_system_refuses_missing_contexts_and_escaping_setup() {
    let root = std::env::temp_dir().join(format!(
        "semctx-workspace-system-setup-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    assert!(run(&json!({}), &root, &json!({})).is_err());
    assert_eq!(
        run(&json!({"gaps":["missing"]}), &root, &json!({})).unwrap()["pass"],
        false
    );
    for names in [
        json!([]),
        json!(["installed", "installed"]),
        json!(["foreign", "uninstalled"]),
    ] {
        assert!(
            run(
                &json!({"gaps":[],"system_contexts":names}),
                &root,
                &json!({})
            )
            .is_err()
        );
    }
    for (index,recipe) in [
        json!({"virtual_path":"../escape","physical_path":"main.json","system_files":{"main.json":"{}"}}),
        json!({"virtual_path":"virtual.json","physical_path":"main.json","system_files":{"main.json":3}}),
        json!({"virtual_path":"virtual.json","physical_path":"main.json","system_files":{"main.json":"{}","../escape":"outside"}}),
        json!({"virtual_path":"virtual.json","physical_path":"main.json","system_files":{"other.json":"{}"}}),
    ].iter().enumerate() {
        assert!(context(recipe,&root.join(format!("case-{index}")),"uninstalled",&json!({})).is_err());
    }
    assert!(!root.join("case-2/escape").exists());
    fs::remove_dir_all(root).unwrap();
}
