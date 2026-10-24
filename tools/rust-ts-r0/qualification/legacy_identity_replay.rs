use super::*;

fn raw_bytes(value: &Value) -> Result<Vec<u8>, String> {
    let object = value
        .as_object()
        .ok_or("legacy input byte descriptor absent")?;
    if object.len() != 1 {
        return Err("legacy input byte descriptor ambiguous".into());
    }
    if let Some(text) = object.get("text").and_then(Value::as_str) {
        return Ok(text.as_bytes().to_vec());
    }
    object
        .get("bytes")
        .and_then(Value::as_array)
        .ok_or("legacy raw bytes absent")?
        .iter()
        .map(|n| {
            n.as_u64()
                .and_then(|n| u8::try_from(n).ok())
                .ok_or("legacy byte outside u8".into())
        })
        .collect()
}
fn portable_file(path: &str) -> bool {
    safe_relative(path)
        && !path.contains(['\\', '\0'])
        && !path.split('/').any(|part| part.is_empty() || part == ".")
}
fn write_files(root: &Path, files: &serde_json::Map<String, Value>) -> Result<(), String> {
    fs::create_dir(root).map_err(|e| e.to_string())?;
    for (path, content) in files {
        if !portable_file(path) {
            return Err("legacy input path escapes isolated specimen".into());
        }
        let target = root.join(path);
        fs::create_dir_all(target.parent().unwrap()).map_err(|e| e.to_string())?;
        fs::write(target, raw_bytes(content)?).map_err(|e| e.to_string())?;
    }
    Ok(())
}
fn changed_bytes(mut bytes: Vec<u8>, plan: &Value) -> Result<Vec<u8>, String> {
    let offset = plan["offset"]
        .as_u64()
        .and_then(|n| usize::try_from(n).ok())
        .ok_or("legacy mutation offset absent")?;
    let before = plan["before"]
        .as_u64()
        .and_then(|n| u8::try_from(n).ok())
        .ok_or("legacy mutation before byte absent")?;
    let after = plan["after"]
        .as_u64()
        .and_then(|n| u8::try_from(n).ok())
        .ok_or("legacy mutation after byte absent")?;
    if bytes.get(offset) != Some(&before) || before == after {
        return Err("legacy mutation is not the declared single byte".into());
    }
    bytes[offset] = after;
    Ok(bytes)
}
fn mutate(root: &Path, plan: &Value) -> Result<Value, String> {
    let path = value_text(plan, "path")?;
    if !portable_file(path) {
        return Err("legacy mutation escapes specimen".into());
    }
    let target = root.join(path);
    let before = fs::read(&target).map_err(|e| e.to_string())?;
    let after = changed_bytes(before.clone(), plan)?;
    fs::write(target, &after).map_err(|e| e.to_string())?;
    Ok(
        json!({"plan":plan,"before_sha256":sha(&before),"after_sha256":sha(&after),"bytes":after.len(),"changed_bytes":before.iter().zip(&after).filter(|(a,b)|a!=b).count()}),
    )
}
fn expected_reads(
    inputs: &Value,
    recipe: &Value,
    variant: &str,
) -> Result<BTreeMap<(String, String), Value>, String> {
    let negative = variant == "crlf-refusal";
    let mut paths = recipe["baseline_expected_identity"]["files"]
        .as_array()
        .ok_or("legacy frozen file inventory absent")?
        .iter()
        .map(|f| value_text(f, "path").map(str::to_owned))
        .collect::<Result<Vec<_>, _>>()?;
    let extras = recipe["identity_additional_files"]
        .as_object()
        .ok_or("legacy additional file inventory absent")?;
    paths.extend(extras.keys().cloned());
    paths.sort_by_key(|p| p.encode_utf16().collect::<Vec<_>>());
    paths.dedup();
    let mut reads = BTreeMap::new();
    for path in paths {
        let mut bytes = if let Some(text) = extras.get(&path) {
            text.as_str()
                .ok_or("legacy additional input not text")?
                .as_bytes()
                .to_vec()
        } else {
            raw_bytes(&inputs["implementation_files"][&path])?
        };
        if variant == "source_changed" && inputs["source_mutation"]["path"] == path {
            bytes = changed_bytes(bytes, &inputs["source_mutation"])?;
        }
        reads.insert(("implementation".into(),path.clone()),json!({"domain":"implementation","path":path,"digest":identity::digest_bytes(&bytes),"bytes":bytes.len()}));
        if negative && bytes.windows(2).any(|w| w == b"\r\n") {
            return Ok(reads);
        }
    }
    if negative {
        return Err("legacy CRLF fixture contains no rejected implementation input".into());
    }
    let compiler_inputs = &inputs["compiler_inputs"][variant];
    let paths = std::iter::once("lib/typescript.js".to_owned()).chain(
        compiler_inputs["libraries"]
            .as_array()
            .ok_or("legacy compiler library inventory absent")?
            .iter()
            .map(|file| {
                value_text(file, "path").map(|p| {
                    if p == "../package.json" {
                        "package.json".into()
                    } else {
                        format!("lib/{p}")
                    }
                })
            })
            .collect::<Result<Vec<_>, _>>()?,
    );
    for path in paths {
        let mut bytes = raw_bytes(&inputs["compiler_files"][&path])?;
        if variant == "sdk_changed" && inputs["sdk_mutation"]["path"] == path {
            bytes = changed_bytes(bytes, &inputs["sdk_mutation"])?;
        }
        reads.insert(("compiler".into(),path.clone()),json!({"domain":"compiler","path":path,"digest":identity::digest_bytes(&bytes),"bytes":bytes.len()}));
    }
    Ok(reads)
}
fn project(
    observed: &Value,
    request: &Value,
    artifact_sha: &str,
    expected: Option<(&Value, &Value)>,
    reads: &BTreeMap<(String, String), Value>,
) -> Result<Value, String> {
    if observed["executed"] != true
        || observed["unsupported"] != json!([])
        || observed["operation"] != "baseline_analyzer_identity"
        || observed["request_descriptor_id"] != identity::digest(request)
        || observed["producer_artifact_id"] != format!("sha256:{artifact_sha}")
        || observed["identity_scope"] != "baseline_3e94997f_implementation_and_compiler_bytes"
        || observed["compiler_executed"] != false
        || observed["global_admission_inferred"] != false
    {
        return Err("legacy observation incomplete or foreign".into());
    }
    let mut actual = BTreeMap::new();
    for read in observed["reads"]
        .as_array()
        .ok_or("legacy reported reads absent")?
    {
        let key = (
            value_text(read, "domain")?.to_owned(),
            value_text(read, "path")?.to_owned(),
        );
        if actual.insert(key, read.clone()).is_some() {
            return Err("legacy read repeated".into());
        }
    }
    if actual != *reads {
        return Err("legacy source/compiler read bytes or denominator differ".into());
    }
    match expected {
        Some((manifest, compiler_inputs)) => {
            if observed["identity_success"] != true
                || observed.get("error").is_some()
                || observed["identity"] != *manifest
                || observed["compiler_inputs"] != *compiler_inputs
            {
                return Err("legacy manifest or compiler bytes differ".into());
            }
        }
        None => {
            if observed["identity_success"] != false
                || observed.get("identity").is_some()
                || observed.get("compiler_inputs").is_some()
            {
                return Err("legacy refused identity became success".into());
            }
        }
    }
    Ok(observed.clone())
}
struct Producer<'a> {
    path: &'a Path,
    helper: &'a Path,
    sha: &'a str,
    helper_sha: &'a str,
}
fn invoke(
    tools: &Producer<'_>,
    root: &Path,
    sdk: &Path,
    dir: &Path,
    label: &str,
) -> Result<(Value, Value), String> {
    let request = json!({"operation":"baseline_analyzer_identity","repository_root":root,"compiler_package_root":sdk});
    let path = dir.join(format!("{label}-request.json"));
    save(&path, &request)?;
    let before = json!({"producer":exact_hash(tools.path,tools.sha)?,"helper":exact_hash(tools.helper,tools.helper_sha)?});
    let argv = vec![
        tools.path.to_string_lossy().into_owned(),
        "--observe-primitives".into(),
        path.to_string_lossy().into_owned(),
    ];
    let outcome = process::run_with_helper(&argv, dir, 20_000, 8_388_608, tools.helper)
        .map_err(|e| e.to_string())?;
    let after = json!({"producer":exact_hash(tools.path,tools.sha)?,"helper":exact_hash(tools.helper,tools.helper_sha)?});
    save(
        &dir.join(format!("{label}-process.json")),
        &json!({"argv":argv,"cwd":dir,"before":before,"after":after,"outcome":outcome}),
    )?;
    if outcome.kind != "success"
        || outcome.exit_code != Some(0)
        || outcome.stdout_bytes != outcome.stdout.len() as u64
        || outcome.stderr_bytes != outcome.stderr.len() as u64
        || outcome.stdout_hash != sha(outcome.stdout.as_bytes())
        || outcome.stderr_hash != sha(outcome.stderr.as_bytes())
    {
        return Err("legacy native process or full capture failed".into());
    }
    let observed = serde_json::from_str(&outcome.stdout).map_err(|e| e.to_string())?;
    save(&dir.join(format!("{label}-native.json")), &observed)?;
    Ok((observed, request))
}
fn source_relation(a: &Value, b: &Value, path: &str) -> Result<bool, String> {
    let left = a["identity"]["files"]
        .as_array()
        .ok_or("legacy source relation left absent")?;
    let right = b["identity"]["files"]
        .as_array()
        .ok_or("legacy source relation right absent")?;
    if left.len() != right.len() {
        return Ok(false);
    }
    let differences = left
        .iter()
        .zip(right)
        .filter(|(a, b)| a != b)
        .collect::<Vec<_>>();
    Ok(differences.len() == 1
        && differences[0].0["path"] == path
        && differences[0].1["path"] == path
        && a["identity"]["digest"] != b["identity"]["digest"]
        && a["identity"]["compiler"] == b["identity"]["compiler"])
}
pub(super) fn run(recipe: &Value, dir: &Path, fixture: &Value) -> Result<Value, String> {
    if !recipe["gaps"]
        .as_array()
        .ok_or("legacy gaps absent")?
        .is_empty()
    {
        return Ok(json!({"pass":false,"state":"NOT_EXECUTABLE_EXPLICIT_GAPS"}));
    }
    let input_path = Path::new(value_text(fixture, "legacy_identity_inputs_path")?);
    let input_sha = value_text(fixture, "legacy_identity_inputs_sha256")?;
    exact_hash(input_path, input_sha)?;
    let inputs = read_json(input_path)?;
    if inputs["baseline_revision"] != recipe["baseline_revision"]
        || inputs["expected"]["baseline"] != recipe["baseline_expected_identity"]
        || inputs["prequery"] != true
        || inputs["producer_invoked"] != false
    {
        return Err("legacy prequery specimen or frozen baseline differs".into());
    }
    let tools = Producer {
        path: Path::new(value_text(fixture, "artifact_path")?),
        helper: Path::new(value_text(fixture, "helper_path")?),
        sha: value_text(fixture, "artifact_sha256")?,
        helper_sha: value_text(fixture, "helper_sha256")?,
    };
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    save(
        &dir.join("input-binding.json"),
        &json!({"path":input_path,"sha256":input_sha,"baseline_revision":inputs["baseline_revision"],"baseline_tree":inputs["baseline_tree"],"complete_baseline_files":inputs["baseline_files"],"complete_sdk_files":inputs["sdk_files"],"sdk_archive_sha256":inputs["sdk_archive_sha256"],"source_mutation":inputs["source_mutation"],"sdk_mutation":inputs["sdk_mutation"]}),
    )?;
    let mode = value_text(recipe, "legacy_identity_mode")?;
    let variants = match mode {
        "crlf-refusal" => vec!["crlf-refusal"],
        "relocation" => vec!["baseline", "baseline"],
        "source-byte" => vec!["baseline", "source_changed"],
        "sdk-byte" => vec!["baseline", "sdk_changed"],
        _ => return Err("unknown legacy identity mode".into()),
    };
    let observation = (|| -> Result<Value, String> {
        let mut observations = vec![];
        for (index, variant) in variants.into_iter().enumerate() {
            let root = dir.join(format!("implementation-{index}"));
            let sdk = dir.join(format!("compiler-{index}"));
            write_files(
                &root,
                inputs["implementation_files"]
                    .as_object()
                    .ok_or("legacy complete baseline absent")?,
            )?;
            write_files(
                &sdk,
                inputs["compiler_files"]
                    .as_object()
                    .ok_or("legacy complete SDK absent")?,
            )?;
            for (path, text) in recipe["identity_additional_files"]
                .as_object()
                .ok_or("legacy additional files absent")?
            {
                if !portable_file(path) {
                    return Err("legacy additional input escapes specimen".into());
                }
                let target = root.join(path);
                fs::create_dir_all(target.parent().unwrap()).map_err(|e| e.to_string())?;
                fs::write(
                    target,
                    text.as_str().ok_or("legacy additional input not text")?,
                )
                .map_err(|e| e.to_string())?;
            }
            if variant == "source_changed" {
                let plan = &inputs["source_mutation"];
                if !recipe["baseline_expected_identity"]["files"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|f| f["path"] == plan["path"])
                {
                    return Err("legacy source mutation not in frozen identity inputs".into());
                }
                save(&dir.join("source-mutation.json"), &mutate(&root, plan)?)?;
            }
            if variant == "sdk_changed" {
                let plan = &inputs["sdk_mutation"];
                let path = value_text(plan, "path")?;
                if !path.starts_with("lib/lib") || !path.ends_with(".d.ts") {
                    return Err("legacy mutation is not an SDK library byte".into());
                }
                save(&dir.join("sdk-mutation.json"), &mutate(&sdk, plan)?)?;
            }
            let (actual, request) =
                invoke(&tools, &root, &sdk, dir, &format!("observation-{index}"))?;
            let expected = if variant == "crlf-refusal" {
                None
            } else {
                Some((
                    &inputs["expected"][variant],
                    &inputs["compiler_inputs"][variant],
                ))
            };
            observations.push(project(
                &actual,
                &request,
                tools.sha,
                expected,
                &expected_reads(&inputs, recipe, variant)?,
            )?);
        }
        let a = &observations[0];
        let result = match mode {
            "crlf-refusal" => json!({"identity_success":a["identity_success"],"error":a["error"]}),
            "relocation" => {
                json!({"relation_satisfied":a["identity"]==observations[1]["identity"]})
            }
            "source-byte" => {
                json!({"relation_satisfied":source_relation(a,&observations[1],value_text(&inputs["source_mutation"],"path")?)?})
            }
            "sdk-byte" => {
                let b = &observations[1];
                json!({"relation_satisfied":a["identity"]["files"]==b["identity"]["files"] && a["identity"]["compiler"]["version"]==b["identity"]["compiler"]["version"] && a["identity"]["compiler"]["digest"]!=b["identity"]["compiler"]["digest"] && a["identity"]["digest"]!=b["identity"]["digest"]})
            }
            _ => unreachable!(),
        };
        save(
            &dir.join("validated-observations.json"),
            &json!(observations),
        )?;
        Ok(result)
    })();
    exact_hash(input_path, input_sha)?;
    let result = match observation {
        Ok(observed) => {
            let checks=recipe["checks"].as_array().ok_or("legacy checks absent")?.iter().map(|c|json!({"expected_origin":c["expected_origin"],"target":c["target"],"result":evaluate(&observed,c)})).collect::<Vec<_>>();
            let pass = !checks.is_empty()
                && checks
                    .iter()
                    .all(|c| c["result"]["state"] == "PASS_PROJECTED_PROPERTY");
            json!({"pass":pass,"state":if pass {"PASS_FROZEN_LEGACY_IDENTITY_UNIT"} else {"NONPASS_LEGACY_IDENTITY_UNIT"},"observation":observed,"checks":checks,"global_admission_inferred":false})
        }
        Err(error) => {
            json!({"pass":false,"state":"LEGACY_IDENTITY_OBSERVATION_REJECTED","error":error,"global_admission_inferred":false})
        }
    };
    save(&dir.join("result.json"), &result)?;
    Ok(result)
}

#[test]
fn comparator_legacy_identity_rejects_foreign_manifest_bytes_and_read_omissions() {
    let request = json!({"operation":"baseline_analyzer_identity","repository_root":"/dev/implementation","compiler_package_root":"/dev/compiler"});
    let manifest = json!({"schemaVersion":1,"files":[{"path":"src/stream.ts","digest":"sha256:source-byte-digest"}],"compiler":{"version":"5.9.3","digest":"sha256:compiler-byte-digest"},"digest":"sha256:aggregate-byte-digest"});
    let compiler_inputs = json!({"entry":"sha256:entry-byte-digest","libraries":[]});
    let read = json!({"domain":"implementation","path":"src/stream.ts","bytes":27,"digest":"sha256:source-byte-digest"});
    let reads = BTreeMap::from([(
        ("implementation".into(), "src/stream.ts".into()),
        read.clone(),
    )]);
    let observed = json!({"executed":true,"unsupported":[],"operation":"baseline_analyzer_identity","request_descriptor_id":identity::digest(&request),"producer_artifact_id":"sha256:development-test-artifact","identity_scope":"baseline_3e94997f_implementation_and_compiler_bytes","compiler_executed":false,"global_admission_inferred":false,"identity_success":true,"identity":manifest,"compiler_inputs":compiler_inputs,"reads":[read]});
    let accepts = |actual: &Value| {
        project(
            actual,
            &request,
            "development-test-artifact",
            Some((&manifest, &compiler_inputs)),
            &reads,
        )
        .is_ok()
    };
    assert!(accepts(&observed));
    for (pointer, value) in [
        ("/executed", json!(false)),
        ("/unsupported", json!(["missing"])),
        ("/operation", json!("foreign")),
        ("/request_descriptor_id", json!("foreign")),
        ("/producer_artifact_id", json!("foreign")),
        ("/identity_scope", json!("foreign")),
        ("/compiler_executed", json!(true)),
        ("/global_admission_inferred", json!(true)),
        ("/identity_success", json!(false)),
        ("/identity/digest", json!("forged")),
        ("/identity/files", json!([])),
        ("/identity/compiler/version", json!("7.1.0-dev")),
        ("/compiler_inputs/entry", json!("forged")),
        ("/reads", json!([])),
        ("/reads/0/bytes", json!(26)),
        ("/reads/0/digest", json!("forged")),
        ("/reads/0/domain", json!("compiler")),
        ("/reads/0/path", json!("src/foreign.ts")),
    ] {
        let mut changed = observed.clone();
        *changed.pointer_mut(pointer).unwrap() = value;
        assert!(!accepts(&changed), "{pointer}");
    }
    let mut changed = observed.clone();
    changed["error"] = json!("unexpected error");
    assert!(!accepts(&changed));
    let duplicate = changed["reads"][0].clone();
    changed.as_object_mut().unwrap().remove("error");
    changed["reads"].as_array_mut().unwrap().push(duplicate);
    assert!(!accepts(&changed));
    let mut refused = observed.clone();
    refused["identity_success"] = json!(false);
    refused.as_object_mut().unwrap().remove("identity");
    refused.as_object_mut().unwrap().remove("compiler_inputs");
    refused["error"] = json!("Noncanonical CRLF analyzer input: src/stream.ts");
    assert!(
        project(
            &refused,
            &request,
            "development-test-artifact",
            None,
            &reads
        )
        .is_ok()
    );
    refused["identity"] = manifest;
    assert!(
        project(
            &refused,
            &request,
            "development-test-artifact",
            None,
            &reads
        )
        .is_err()
    );
}
#[test]
fn comparator_legacy_identity_checks_input_bytes_mutation_and_isolated_paths() {
    for value in [
        json!({}),
        json!({"text":"abc","bytes":[97]}),
        json!({"bytes":[256]}),
        json!({"bytes":[-1]}),
        json!({"bytes":["97"]}),
    ] {
        assert!(raw_bytes(&value).is_err(), "{value}");
    }
    assert_eq!(raw_bytes(&json!({"text":"a\r\n"})).unwrap(), b"a\r\n");
    assert_eq!(raw_bytes(&json!({"bytes":[0,255]})).unwrap(), vec![0, 255]);
    for path in [
        "../escape.ts",
        "/absolute.ts",
        "C:/drive.ts",
        "./dot.ts",
        "value/../escape.ts",
        "double//part.ts",
        "back\\slash.ts",
        "null\0.ts",
    ] {
        assert!(!portable_file(path), "{path}");
    }
    assert!(portable_file("packages/sample/src/value.ts"));
    let plan = json!({"path":"src/stream.ts","offset":1,"before":98,"after":120});
    assert_eq!(changed_bytes(b"abc".to_vec(), &plan).unwrap(), b"axc");
    for (field, value) in [
        ("offset", json!(3)),
        ("offset", json!(-1)),
        ("before", json!(99)),
        ("after", json!(98)),
        ("after", json!(256)),
    ] {
        let mut changed = plan.clone();
        changed[field] = value;
        assert!(changed_bytes(b"abc".to_vec(), &changed).is_err(), "{field}");
    }
    let a = json!({"identity":{"files":[{"path":"src/stream.ts","digest":"before"}],"compiler":{"version":"5.9.3","digest":"stable"},"digest":"aggregate-before"}});
    let mut b = a.clone();
    b["identity"]["files"][0]["digest"] = json!("after");
    b["identity"]["digest"] = json!("aggregate-after");
    assert!(source_relation(&a, &b, "src/stream.ts").unwrap());
    assert!(!source_relation(&a, &a, "src/stream.ts").unwrap());
    b["identity"]["compiler"]["digest"] = json!("unexpected");
    assert!(!source_relation(&a, &b, "src/stream.ts").unwrap());
}
