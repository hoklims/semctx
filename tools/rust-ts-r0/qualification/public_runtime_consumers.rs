//! Two finite baseline3e consumers over admitted C1 facts. RAW C1 is unchanged.
use super::*;

fn byte_join(path: &Path, prepared: &Value) -> Result<Vec<u8>, String> {
    let canonical = path.canonicalize().map_err(|e| e.to_string())?;
    let envelope = Path::new(value_text(prepared, "case_root")?)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    if !canonical.starts_with(&envelope) || !canonical.is_file() {
        return Err("consumer physical path outside frozen case".into());
    }
    let bytes = fs::read(&canonical).map_err(|e| e.to_string())?;
    let mut bound = false;
    for item in prepared["physical_setup"]
        .as_array()
        .ok_or("physical bindings absent")?
    {
        let item_path = Path::new(value_text(item, "path")?);
        if item["blob_ref"]["sha256"].is_string()
            && item_path.canonicalize().ok().as_ref() == Some(&canonical)
        {
            exact_hash(&canonical, value_text(&item["blob_ref"], "sha256")?)?;
            if item["size"].as_u64() != Some(bytes.len() as u64) {
                return Err("physical byte length differs".into());
            }
            bound = true;
        }
    }
    if !bound {
        return Err("consumer physical file has no frozen byte join".into());
    }
    Ok(bytes)
}

fn path_cmp(a: &[String], b: &[String]) -> std::cmp::Ordering {
    a.first()
        .map(|p| p.encode_utf16().collect::<Vec<_>>())
        .cmp(&b.first().map(|p| p.encode_utf16().collect::<Vec<_>>()))
}

fn partition(prepared: &Value, native: &Value) -> Result<Value, String> {
    // Existing C1 parallel surface performs the actual baseline safety preflight
    // (noLib/types, root syntax, directives and augmentations). A raw component's
    // parallelSafetyEvaluated:false never establishes this prerequisite.
    let preflight = &native["preflight"];
    let component = &preflight["moduleComponents"];
    let count = prepared["partition_count"]
        .as_u64()
        .filter(|n| *n > 0 && *n <= 8)
        .ok_or("invalid partition count")? as usize;
    if prepared["surface"] != "parallel_cli"
        || prepared["request"]["workers"] != json!(count)
        || preflight["safe"] != true
        || preflight["unsafeReason"] != Value::Null
        || preflight["noLib"] != true
        || preflight["types"] != json!([])
        || component["executed"] != true
        || component["unsupported"] != json!([])
        || native["executed"] != true
        || native["unsupported"] != json!([])
        || native["parallelism"]["mode"] != "parallel"
    {
        return Err("actual safe parallel partition observation required".into());
    }
    let root = value_text(prepared, "repository_root")?.trim_end_matches('/');
    let mut seen = BTreeSet::new();
    let mut weighted = vec![];
    for group in component["dependencyComponents"]
        .as_array()
        .ok_or("native dependency components absent")?
    {
        let mut paths = vec![];
        let mut weight = 0u64;
        for relative in group.as_array().ok_or("native component paths absent")? {
            let relative = relative
                .as_str()
                .filter(|p| safe_relative(p))
                .ok_or("native component outside repository")?;
            let path = format!("{root}/{relative}");
            if !seen.insert(path.clone()) {
                return Err("duplicate native partition root".into());
            }
            let bytes = byte_join(Path::new(&path), prepared)?;
            weight = weight
                .checked_add(bytes.len() as u64)
                .ok_or("partition weight overflow")?;
            paths.push(path);
        }
        if paths.is_empty() {
            return Err("native empty dependency component".into());
        }
        paths.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
        weighted.push((weight, paths));
    }
    let requested = prepared["request"]["rootAbsPaths"]
        .as_array()
        .ok_or("partition roots absent")?
        .iter()
        .map(|p| {
            p.as_str()
                .map(str::to_owned)
                .ok_or("partition root non-text".to_string())
        })
        .collect::<Result<BTreeSet<_>, _>>()?;
    if requested != seen {
        return Err("partition components do not cover exact selected roots".into());
    }
    weighted.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| path_cmp(&a.1, &b.1)));
    let mut bins = vec![(0u64, Vec::<String>::new()); count.min(weighted.len())];
    if bins.is_empty() {
        return Err("native partition empty".into());
    }
    for (weight, paths) in weighted {
        bins.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| path_cmp(&a.1, &b.1)));
        bins[0].0 = bins[0]
            .0
            .checked_add(weight)
            .ok_or("partition bucket overflow")?;
        bins[0].1.extend(paths);
    }
    let expected = bins
        .into_iter()
        .filter_map(|(_, mut paths)| {
            paths.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
            (!paths.is_empty()).then_some(paths)
        })
        .collect::<Vec<_>>();
    let actual = native["jobs"]
        .as_array()
        .ok_or("actual native chunks absent")?
        .iter()
        .map(|job| {
            serde_json::from_value::<Vec<String>>(job["request"]["emitAbsPaths"].clone())
                .map_err(|e| e.to_string())
        })
        .collect::<Result<Vec<_>, _>>()?;
    if actual != expected {
        return Err("actual native chunks differ from baseline weighted components".into());
    }
    Ok(json!(actual))
}

fn runtime_companion(prepared: &Value, native: &Value) -> Result<Value, String> {
    if prepared["surface"] != "configured_resolution_cli" {
        return Err("configured resolver surface absent".into());
    }
    let Some(path) = native["resolved_file_name"].as_str() else {
        if native["resolved_file_name"].is_null() {
            return Ok(json!({"$undefined":true}));
        }
        return Err("native resolution target malformed".into());
    };
    let candidate = [(".d.mts", ".mjs"), (".d.cts", ".cjs"), (".d.ts", ".js")]
        .iter()
        .find_map(|(suffix, extension)| {
            path.strip_suffix(suffix)
                .map(|base| format!("{base}{extension}"))
        });
    let Some(candidate) = candidate else {
        return Ok(json!(path));
    };
    let runtime = Path::new(&candidate);
    // The public snapshot system's fileExists is its captured map. Ordinary
    // operation additionally uses actual physical fileExists and confinement.
    if prepared["retained"] == true && prepared["request"]["files"].get(&candidate).is_none() {
        return Ok(json!(path));
    }
    match fs::metadata(runtime) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(json!(path)),
        Err(error) => return Err(error.to_string()),
        Ok(metadata) if !metadata.is_file() => return Ok(json!(path)),
        Ok(_) => {}
    }
    let repository = Path::new(value_text(prepared, "repository_root")?)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let actual = runtime.canonicalize().map_err(|e| e.to_string())?;
    let confined = prepared["runtime_repository_confinement_required"]
        .as_bool()
        .ok_or("runtime confinement parameter absent")?;
    if confined && !actual.starts_with(&repository) {
        return Ok(json!({"$undefined":true}));
    }
    let bytes = byte_join(runtime, prepared)?;
    if let Some(captured) = prepared["request"]["files"].get(&candidate) {
        if captured.as_str().map(str::as_bytes) != Some(bytes.as_slice()) {
            return Err("runtime companion differs from retained/native bytes".into());
        }
    } else {
        return Err("runtime companion lacks exact request byte binding".into());
    }
    Ok(json!(candidate))
}

pub(super) fn observe(
    prepared: &Value,
    native: &Value,
    sdk: &Value,
    binding: &Value,
    fixture: &Value,
) -> Result<Option<Value>, String> {
    let kind = match prepared["baseline_function"].as_str() {
        Some("__partitionTypeScriptRootsForTesting") if prepared["surface"] == "parallel_cli" => {
            "partition-native-chunks-v1"
        }
        Some("resolveTypeScriptModule") if prepared["surface"] == "configured_resolution_cli" => {
            "configured-runtime-companion-v1"
        }
        _ => return Ok(None),
    };
    let consumer = std::env::current_exe().map_err(|e| e.to_string())?;
    let consumer_sha = value_text(fixture, "public_consumer_artifact_sha256")?;
    exact_hash(&consumer, consumer_sha)?;
    if binding["request_descriptor_id"] != identity::digest(&prepared["request"])
        || binding["sdk_input_id"] != identity::digest(sdk)
        || binding["producer_artifact_id"]
            != format!("sha256:{}", value_text(fixture, "artifact_sha256")?)
    {
        return Err("consumer actual native context binding differs".into());
    }
    let value = if kind == "partition-native-chunks-v1" {
        partition(prepared, native)?
    } else {
        runtime_companion(prepared, native)?
    };
    let mut receipt = json!({"kind":kind,"baseline_function":prepared["baseline_function"],"prepared_id":identity::digest(prepared),
        "request_descriptor_id":binding["request_descriptor_id"],"sdk_input_id":binding["sdk_input_id"],"producer_artifact_id":binding["producer_artifact_id"],
        "consumer_artifact_id":format!("sha256:{consumer_sha}"),"native_fact_id":identity::digest(native),"value":value});
    receipt["receipt_id"] = json!(identity::digest(&receipt));
    exact_hash(&consumer, consumer_sha)?;
    Ok(Some(receipt))
}

#[cfg(test)]
mod consumer_tests {
    use super::*;
    #[test]
    fn comparator_partition_direct_control_does_not_claim_the_public_partition_receipt() {
        let main = json!({"baseline_function":"__partitionTypeScriptRootsForTesting", "surface":"parallel_cli",
            "request":{"workers":2},"direct_control_request":{"id":"direct"}});
        let mut control = main.clone();
        control["surface"] = json!("raw_cli");
        control["mode"] = Value::Null;
        control["request"] = main["direct_control_request"].clone();
        // The real direct-control dispatch must require only its own native binding,
        // without entering a consumer that requires parallel job observations.
        assert!(
            observe(
                &control,
                &Value::Null,
                &Value::Null,
                &Value::Null,
                &Value::Null
            )
            .unwrap()
            .is_none()
        );
        // The public invocation still enters the consumer and refuses missing pins.
        assert!(
            observe(
                &main,
                &Value::Null,
                &Value::Null,
                &Value::Null,
                &Value::Null
            )
            .is_err()
        );
    }
    fn physical_case(names: &[(&str, &str)]) -> (std::path::PathBuf, Value) {
        let root = std::env::temp_dir().join(format!(
            "semctx-runtime-consumer-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&root).unwrap();
        let root = root.canonicalize().unwrap();
        let physical = names
            .iter()
            .map(|(name, text)| {
                let path = root.join(name);
                fs::write(&path, text.as_bytes()).unwrap();
                json!({"path":path,"size":text.len(),"blob_ref":{"sha256":sha(text.as_bytes())}})
            })
            .collect::<Vec<_>>();
        let prepared = json!({"case_root":root,"repository_root":root.to_string_lossy().replace('\\',"/"),"physical_setup":physical});
        (root, prepared)
    }
    fn remove_case(root: &Path, names: &[&str]) {
        for name in names {
            fs::remove_file(root.join(name)).unwrap();
        }
        fs::remove_dir(root).unwrap();
    }
    #[test]
    fn comparator_partition_refuses_raw_or_unsafe_native_component() {
        let prepared = json!({"surface":"raw_cli","partition_count":2,"request":{"workers":2}});
        let native = json!({"partitionObservation":{"executed":true,"unsupported":[],"dependencyComponents":[["a.ts"]],"parallelSafetyEvaluated":false}});
        assert!(partition(&prepared, &native).is_err());
        let mut prepared = prepared;
        prepared["surface"] = json!("parallel_cli");
        assert!(partition(&prepared, &native).is_err());
    }
    #[test]
    fn comparator_partition_uses_actual_chunks_and_rejects_wrong_native_chunks() {
        let (root, mut prepared) =
            physical_case(&[("a.ts", "export {};\n"), ("b.ts", "export {};\n")]);
        let prefix = prepared["repository_root"].as_str().unwrap().to_owned();
        let a = format!("{prefix}/a.ts");
        let b = format!("{prefix}/b.ts");
        prepared["surface"] = json!("parallel_cli");
        prepared["partition_count"] = json!(2);
        prepared["request"] = json!({"workers":2,"rootAbsPaths":[a,b]});
        let native = json!({"executed":true,"unsupported":[],"parallelism":{"mode":"parallel"},
            "preflight":{"safe":true,"unsafeReason":null,"noLib":true,"types":[],"moduleComponents":{"executed":true,"unsupported":[],"dependencyComponents":[["a.ts"],["b.ts"]]}},
            "jobs":[{"request":{"emitAbsPaths":[b]}},{"request":{"emitAbsPaths":[a]}}]});
        assert_eq!(partition(&prepared, &native).unwrap(), json!([[b], [a]]));
        let mut wrong = native.clone();
        wrong["jobs"].as_array_mut().unwrap().reverse();
        assert!(
            partition(&prepared, &wrong)
                .unwrap_err()
                .contains("actual native chunks differ")
        );
        wrong = native.clone();
        wrong["preflight"]["safe"] = json!(false);
        assert!(partition(&prepared, &wrong).is_err());
        fs::write(root.join("a.ts"), b"different").unwrap();
        assert!(partition(&prepared, &native).is_err());
        remove_case(&root, &["a.ts", "b.ts"]);
    }
    #[test]
    fn comparator_runtime_companion_requires_actual_confined_byte_join() {
        let (root, mut prepared) = physical_case(&[
            ("dep.d.ts", "export declare const x:number;"),
            ("dep.js", "export const x=1;"),
        ]);
        let prefix = prepared["repository_root"].as_str().unwrap().to_owned();
        let declaration = format!("{prefix}/dep.d.ts");
        let runtime = format!("{prefix}/dep.js");
        prepared["surface"] = json!("configured_resolution_cli");
        prepared["retained"] = json!(false);
        prepared["runtime_repository_confinement_required"] = json!(true);
        let mut files = serde_json::Map::new();
        files.insert(runtime.clone(), json!("export const x=1;"));
        prepared["request"] = json!({"files":files});
        let native = json!({"resolved_file_name":declaration});
        assert_eq!(
            runtime_companion(&prepared, &native).unwrap(),
            json!(runtime)
        );
        prepared["request"]["files"] = json!({});
        assert!(runtime_companion(&prepared, &native).is_err());
        fs::remove_file(root.join("dep.js")).unwrap();
        assert_eq!(
            runtime_companion(&prepared, &native).unwrap(),
            json!(declaration)
        );
        remove_case(&root, &["dep.d.ts"]);
    }
}
