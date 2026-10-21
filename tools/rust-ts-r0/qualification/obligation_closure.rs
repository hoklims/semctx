//! Bounded property oracle. Never consumes result.json or report pass flags.
use super::*;

const REGISTRY: &str =
    include_str!("../../../docs/research/rust-ts-r0/resumption/obligation-closure-registry.json");
const POSITIVE: &str = "P01-retained-source::analyze-snapshot-consistent";
const NEGATIVE: &str = "N01-snapshot-metadata-mismatch::base";

fn registry() -> Value {
    serde_json::from_str(REGISTRY).expect("embedded closure registry")
}

fn check_unit(
    recipe: &Value,
    descriptor: &Value,
    observed: &Value,
    sdk: &Value,
    artifact: &str,
) -> Result<(), String> {
    let registry = registry();
    let uid = value_text(recipe, "unit_id")?;
    let pinned = registry["units"]
        .as_array()
        .ok_or("missing registry pair")?
        .iter()
        .find(|unit| unit["unit_id"] == uid)
        .ok_or("unit outside closure pair")?;
    for field in [
        "capture_request",
        "discovered_sources",
        "physical_live_after_capture",
        "physical_uncaptured_files",
        "checks",
    ] {
        if recipe[field] != pinned[field] {
            return Err(format!("changed closure dependency: {uid}/{field}"));
        }
    }
    let analysis = &descriptor["analysis"];
    let cwd = value_text(analysis, "cwd")?;
    let prefix = format!("{cwd}/");
    let mut normalized = analysis.clone();
    let object = normalized
        .as_object_mut()
        .ok_or("missing analysis request")?;
    object.remove("cwd");
    object
        .remove("case_sensitive")
        .and_then(|v| v.as_bool())
        .ok_or("missing host case sensitivity")?;
    let mut files = serde_json::Map::new();
    for (path, text) in analysis["files"]
        .as_object()
        .ok_or("missing captured sources")?
    {
        let relative = path
            .strip_prefix(&prefix)
            .filter(|p| safe_relative(p))
            .ok_or("capture outside request cwd")?;
        files.insert(relative.into(), text.clone());
    }
    let roots = analysis["roots"]
        .as_array()
        .ok_or("missing captured roots")?
        .iter()
        .map(|path| {
            path.as_str()
                .and_then(|p| p.strip_prefix(&prefix))
                .map(|p| json!(p))
                .ok_or("root outside request cwd")
        })
        .collect::<Result<Vec<_>, _>>()?;
    normalized["files"] = Value::Object(files.clone());
    normalized["roots"] = json!(roots);
    if normalized != pinned["capture_request"]
        || descriptor["discovered_sources"] != pinned["discovered_sources"]
    {
        return Err("request differs from frozen pair capture/discovery/options".into());
    }
    let discovered = descriptor["discovered_sources"]
        .as_array()
        .ok_or("missing discovered sources")?;
    let equal = discovered.iter().all(|source| {
        source["relPath"].as_str().and_then(|p| files.get(p)) == Some(&source["content"])
    });
    if (uid == POSITIVE && !equal) || (uid == NEGATIVE && equal) {
        return Err("pair discriminator not exercised".into());
    }
    retained_discovery_complete_binding(observed, descriptor, sdk, artifact)?;
    if uid == POSITIVE {
        if observed["executed"] != true {
            return Err("positive analysis not executed".into());
        }
        let reads = join_successful_reads(&observed["native_analysis"], analysis, sdk)?;
        let paths = reads["read_paths"]
            .as_array()
            .ok_or("missing consumed read paths")?;
        if !paths.contains(&json!(format!("{cwd}/entry.ts")))
            || !paths
                .iter()
                .any(|path| path.as_str().is_some_and(|p| sdk["files"].get(p).is_some()))
        {
            return Err("positive analysis lacks reported captured source/SDK reads".into());
        }
    } else if uid == NEGATIVE {
        let errors = observed["unsupported"]
            .as_array()
            .ok_or("missing mismatch reason")?;
        if observed["executed"] != false
            || errors != &vec![json!("SOURCE_SNAPSHOT_MISMATCH: entry.ts")]
        {
            return Err("countercase is not the exact snapshot mismatch refusal".into());
        }
    }
    let checks = pinned["checks"].as_array().ok_or("missing pinned checks")?;
    validate_component_checks(checks)?;
    for check in checks {
        if evaluate(observed, check)["state"] != "PASS_PROJECTED_PROPERTY" {
            return Err(format!(
                "property check failed: {}",
                check["expected_origin"]
            ));
        }
    }
    Ok(())
}

fn current_head() -> Result<String, String> {
    current_head_at(&Path::new(env!("CARGO_MANIFEST_DIR")).join("../.."))
}

fn current_head_at(root: &Path) -> Result<String, String> {
    let status = std::process::Command::new("git")
        .args([
            "status",
            "--porcelain=v1",
            "--untracked-files=all",
            "--",
            ".",
        ])
        .current_dir(root)
        .output()
        .map_err(|e| e.to_string())?;
    // Conservative by design: a clean HEAD alone cannot identify changed build inputs.
    if !status.status.success() || !status.stdout.is_empty() {
        return Err("UNPROVEN_SOURCE_IDENTITY: tracked or untracked worktree changes".into());
    }
    repository_head(root)
}

fn repository_head(root: &Path) -> Result<String, String> {
    let output = std::process::Command::new("git")
        .args(["rev-parse", "HEAD"])
        .current_dir(root)
        .output()
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err("cannot establish current candidate HEAD".into());
    }
    String::from_utf8(output.stdout)
        .map(|s| s.trim().into())
        .map_err(|e| e.to_string())
}

fn candidate_binding(freeze: &Value, expected_head: &str) -> Result<(), String> {
    if expected_head.len() != 40
        || freeze["source_head"].as_str() != Some(expected_head)
        || freeze["optimized_frozen"] != true
    {
        return Err("freeze does not bind the current optimized candidate source_head".into());
    }
    Ok(())
}

fn check_pair_ids(units: &[Value]) -> Result<(), String> {
    if units.len() != 2 || units[0]["unit_id"] != POSITIVE || units[1]["unit_id"] != NEGATIVE {
        return Err("closure registry must retain the exact ordered adopted pair".into());
    }
    Ok(())
}

fn evidence_directory(evidence: &Path, uid: &str) -> Result<PathBuf, String> {
    let mut matches = Vec::new();
    for entry in fs::read_dir(evidence).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if !entry.file_type().map_err(|e| e.to_string())?.is_dir()
            || !entry.file_name().to_string_lossy().starts_with("unit-")
        {
            continue;
        }
        let request = entry.path().join("retained-discovery-request.json");
        if request.exists() && read_json(&request)?["analysis"]["id"] == uid {
            matches.push(entry.path());
        }
    }
    if matches.len() != 1 {
        return Err(format!("missing or duplicate raw evidence for {uid}"));
    }
    Ok(matches.remove(0))
}

#[cfg(test)]
fn evaluate_evidence(
    freeze: &Value,
    evidence: &Path,
    expected_head: &str,
) -> Result<Value, String> {
    let inventory = verified_inventory(freeze)?;
    evaluate_with_inventory(freeze, evidence, expected_head, &inventory)
}

fn evaluate_with_inventory(
    freeze: &Value,
    evidence: &Path,
    expected_head: &str,
    inventory: &Value,
) -> Result<Value, String> {
    candidate_binding(freeze, expected_head)?;
    let registry = registry();
    if registry["additional_support_ids"] != json!([]) {
        return Err("unexpected support requirement".into());
    }
    let pins = registry["units"]
        .as_array()
        .ok_or("missing closure units")?;
    check_pair_ids(pins)?;
    for (path_key, hash_key) in [
        ("artifact_path", "artifact_sha256"),
        ("helper_path", "helper_sha256"),
        ("sdk_path", "sdk_sha256"),
        ("recipes_path", "recipes_sha256"),
    ] {
        exact_hash(
            Path::new(value_text(freeze, path_key)?),
            value_text(freeze, hash_key)?,
        )?;
    }
    let base = Path::new(value_text(freeze, "cases_path")?);
    for source in registry["sources"]
        .as_array()
        .ok_or("missing frozen closure origins")?
    {
        exact_hash(
            &base.join(value_text(source, "path")?),
            value_text(source, "sha256")?,
        )?;
    }
    let recipes = read_json(Path::new(value_text(freeze, "recipes_path")?))?;
    exact_hash(
        &base.join("index.json"),
        value_text(&recipes, "source_index_sha256")?,
    )?;
    for name in ["scenarios", "obligation_map", "input_index"] {
        let reference = &recipes["immutable_sources"][name];
        let path = value_text(reference, "path")?;
        let pinned = registry["sources"]
            .as_array()
            .ok_or("missing registry origins")?
            .iter()
            .find(|source| source["path"] == path)
            .ok_or("recipe origin not pinned by closure registry")?;
        if reference["sha256"] != pinned["sha256"] {
            return Err("recipe frozen origin identity mismatch".into());
        }
        exact_hash(&base.join(path), value_text(reference, "sha256")?)?;
    }
    let all = recipes["recipes"].as_array().ok_or("missing recipes")?;
    let sdk = read_json(Path::new(value_text(freeze, "sdk_path")?))?;
    let artifact = value_text(freeze, "artifact_sha256")?;
    let obligation = inventory["obligations"]
        .as_array()
        .ok_or("missing obligation map")?
        .iter()
        .find(|o| o["obligation_id"] == registry["obligation_id"])
        .ok_or("missing owning obligation")?;
    if obligation["adopted_positive_qualification_unit_ids"] != json!([POSITIVE])
        || obligation["adopted_relevant_counter_qualification_unit_ids"] != json!([NEGATIVE])
        || obligation["adopted_support_unit_ids"] != json!([])
    {
        return Err("adopted pair/support drift".into());
    }
    let mut dependencies = Vec::new();
    for pin in pins {
        let matches = all
            .iter()
            .enumerate()
            .filter(|(_, r)| r["unit_id"] == pin["unit_id"])
            .collect::<Vec<_>>();
        if matches.len() != 1 {
            return Err("missing or duplicate pair recipe".into());
        }
        let (_, recipe) = matches[0];
        let dir = evidence_directory(evidence, value_text(pin, "unit_id")?)?;
        let descriptor_path = dir.join("retained-discovery-request.json");
        let descriptor = read_json(&descriptor_path)?;
        if read_json(&dir.join("analysis-request.json"))? != descriptor["analysis"] {
            return Err("analysis request/descriptor mismatch".into());
        }
        let outcome_value = read_json(&dir.join("process-outcome.json"))?;
        let outcome: process::Outcome =
            serde_json::from_value(outcome_value.clone()).map_err(|e| e.to_string())?;
        let observed = retained_discovery_observation(&outcome).map_err(|e| e.to_string())?;
        if observed != read_json(&dir.join("native-observation.json"))? {
            return Err("raw stdout/observation mismatch".into());
        }
        let invocation = read_json(&dir.join("process-invocation.json"))?;
        if invocation["process_outcome_id"] != identity::digest(&outcome_value)
            || invocation["argv"]
                != json!([
                    freeze["artifact_path"],
                    "--analyze-retained-discovery",
                    descriptor_path,
                    freeze["sdk_path"]
                ])
            || invocation["cwd"] != descriptor["analysis"]["cwd"]
        {
            return Err("process invocation not bound to consumed request/outcome".into());
        }
        let bytes = outcome.stdout.as_bytes();
        if outcome_value["stdout_hash"] != sha(bytes)
            || outcome_value["stdout_bytes"] != bytes.len()
        {
            return Err("raw stdout identity mismatch".into());
        }
        let artifacts = read_json(&dir.join("artifact-observation.json"))?;
        for moment in ["before", "after"] {
            if artifacts[moment]["artifact_sha256"] != freeze["artifact_sha256"]
                || artifacts[moment]["helper_sha256"] != freeze["helper_sha256"]
            {
                return Err("execution artifact changed".into());
            }
        }
        check_unit(recipe, &descriptor, &observed, &sdk, artifact)?;
        // Physical setup is independently recomputed from frozen inputs, never its pass flag.
        let setup = read_json(&dir.join("physical-post-capture-setup.json"))?;
        let mut expected_setup = Vec::new();
        for (path, text) in pin["physical_live_after_capture"]
            .as_object()
            .ok_or("missing physical setup")?
        {
            let retained = pin["capture_request"]["files"][path]
                .as_str()
                .ok_or("missing retained setup source")?;
            let live = text.as_str().ok_or("missing transient setup source")?;
            expected_setup.push(json!({"path":path,"physical_after_sha256":sha(live.as_bytes()),"physical_before_sha256":sha(retained.as_bytes()),"retained_sha256":sha(retained.as_bytes()),"physical_differs_from_retained":live != retained}));
        }
        if setup != json!(expected_setup) {
            return Err("physical mutation evidence differs from frozen setup".into());
        }
        dependencies.push(json!({"unit_id":pin["unit_id"],"request_id":identity::digest(&descriptor),"outcome_id":identity::digest(&outcome_value),"observation_id":identity::digest(&observed),"checks":pin["checks"]}));
    }
    Ok(
        json!({"state":"UNPROVEN_EXECUTION_BUILD_PROVENANCE","creditability":"NON_CREDITABLE_READ_ONLY_CAPTURE","evidence_modality":"READ_ONLY_CAPTURE_CONSISTENCY_ONLY","observation_consistency":"CONSISTENT_BOUNDED_PROPERTY_OBSERVATIONS","closure_credit":false,"gap":"Serialized requests/outcomes cannot establish fresh helper execution or that the executable was built from the current source. No native closure is admitted by this oracle.","candidate_source_head":expected_head,"artifact_sha256":artifact,"sdk_sha256":freeze["sdk_sha256"],"recipes_sha256":freeze["recipes_sha256"],"consumed_dependencies":dependencies,"additional_support_ids":[]}),
    )
}

fn verified_inventory(freeze: &Value) -> Result<Value, String> {
    let registry = registry();
    let reference = registry["sources"]
        .as_array()
        .ok_or("missing inventory origin")?
        .iter()
        .find(|source| source["path"] == "qualification/obligations.json")
        .ok_or("missing inventory pin")?;
    let path = Path::new(value_text(freeze, "cases_path")?).join("qualification/obligations.json");
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    if sha(&bytes) != value_text(reference, "sha256")? {
        return Err("inventory identity differs from frozen obligations".into());
    }
    let document: Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    inventory_summary(&document)?;
    Ok(document)
}

fn inventory_summary(document: &Value) -> Result<Value, String> {
    let registry = registry();
    let items = document["obligations"]
        .as_array()
        .ok_or("missing obligation inventory")?;
    let mut ids = BTreeSet::new();
    let mut coordinates = BTreeSet::new();
    let mut other_properties = Vec::new();
    let mut obligations = Vec::new();
    for item in items {
        let id = value_text(item, "obligation_id")?;
        if !ids.insert(id) {
            return Err("duplicate obligation identity".into());
        }
        obligations.push(json!({"obligation_id":item["obligation_id"],"qualified":false}));
        let properties = item["cumulative_properties"]
            .as_array()
            .ok_or("missing cumulative property inventory")?;
        for (index, _) in properties.iter().enumerate() {
            coordinates.insert((id, index));
            if item["obligation_id"] != registry["obligation_id"] || index != 0 {
                other_properties.push(json!({"obligation_id":item["obligation_id"],"property_index":index,"state":"NOT_EVALUATED_NOT_CLOSED"}));
            }
        }
    }
    let encoded_ids = ids.iter().map(|id| format!("{id}\n")).collect::<String>();
    let encoded_coordinates = coordinates
        .iter()
        .map(|(id, index)| format!("{id}#{index}\n"))
        .collect::<String>();
    if items.len() != 240
        || coordinates.len() != 395
        || other_properties.len() != 394
        || registry["inventory"]["obligation_ids_sha256"] != sha(encoded_ids.as_bytes())
        || registry["inventory"]["property_coordinates_sha256"]
            != sha(encoded_coordinates.as_bytes())
    {
        return Err(
            "frozen inventory IDs/property coordinates or 240/395 denominators differ".into(),
        );
    }
    Ok(
        json!({"state":"VERIFIED_FROZEN_INVENTORY","required_obligations":240,"required_properties":395,"required_other_properties":394,"obligations":obligations,"other_properties":other_properties}),
    )
}

/// File replay checks consistency only; it never admits native closure or qualification.
pub(super) fn sidecar(freeze: &Value, evidence: &Path) -> Value {
    let registry = registry();
    let (inventory, result) = match verified_inventory(freeze) {
        Ok(document) => {
            let summary = inventory_summary(&document).expect("validated frozen inventory");
            let result = current_head()
                .and_then(|head| evaluate_with_inventory(freeze, evidence, &head, &document));
            (summary, result)
        }
        Err(error) => (
            json!({"state":"UNVERIFIED_INVENTORY","required_obligations":240,"required_properties":395,"required_other_properties":394,"error":error}),
            Err(error),
        ),
    };
    let property = result
        .unwrap_or_else(|error| json!({"state":"NOT_CLOSED","closure_credit":false,"error":error}));
    json!({"schema_version":1,"scope":"ONE_EXISTING_PROPERTY_CONSISTENCY_ONLY","registry_id":identity::digest(&registry),"obligation_id":registry["obligation_id"],"property_index":0,"property":property,"inventory":inventory,"other_properties":inventory["other_properties"],"obligations":inventory["obligations"],"closure_credit":false,"qualified":false,"R0_decision":"NOT_MADE_BY_PROPERTY_ORACLE"})
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore = "requires caller-owned output for an isolated Git source-identity fixture"]
    fn property_closure_dirty_source_cannot_reuse_clean_head() {
        let out = PathBuf::from(std::env::var_os("SEMCTX_CLOSURE_TEST_OUTPUT").unwrap())
            .with_extension("source-identity");
        assert!(!out.exists());
        fs::create_dir_all(out.join("tools/rust-ts-r0/src")).unwrap();
        let git = |args: &[&str]| {
            let status = std::process::Command::new("git")
                .args(args)
                .current_dir(&out)
                .output()
                .unwrap();
            assert!(
                status.status.success(),
                "{}",
                String::from_utf8_lossy(&status.stderr)
            );
        };
        git(&["init", "--quiet"]);
        let source = out.join("tools/rust-ts-r0/src/lib.rs");
        fs::write(&source, "pub fn frozen() {}\n").unwrap();
        git(&["add", "."]);
        git(&[
            "-c",
            "user.name=Guillaume Fossier",
            "-c",
            "user.email=hoklims@gmail.com",
            "commit",
            "--quiet",
            "-m",
            "test: isolated source identity fixture",
        ]);
        assert!(current_head_at(&out).is_ok());
        fs::write(&source, "pub fn changed() {}\n").unwrap();
        assert!(
            current_head_at(&out).is_err(),
            "dirty tracked source must not reuse clean HEAD"
        );
        git(&["add", "."]);
        assert!(
            current_head_at(&out).is_err(),
            "staged source must not reuse clean HEAD"
        );
        fs::write(&source, "pub fn frozen() {}\n").unwrap();
        git(&["add", "."]);
        assert!(current_head_at(&out).is_ok());
        fs::write(
            out.join("tools/rust-ts-r0/src/untracked.rs"),
            "pub fn injected() {}\n",
        )
        .unwrap();
        assert!(
            current_head_at(&out).is_err(),
            "untracked source must not reuse clean HEAD"
        );
    }

    // The owning test uses existing public campaign captures, never a new qualification case.
    fn fixture() -> (Value, Value, Value, Value, Value, String) {
        let root = PathBuf::from(
            std::env::var_os("SEMCTX_CLOSURE_PUBLIC_FIXTURE")
                .expect("public campaign fixture path"),
        );
        let sdk = read_json(&root.join("t00-original-campaign/sdk-input.json")).unwrap();
        let evidence = root.join("t00-original-campaign/evidence");
        let positive =
            read_json(&evidence.join("unit-349/retained-discovery-request.json")).unwrap();
        let positive_observed =
            read_json(&evidence.join("unit-349/native-observation.json")).unwrap();
        let negative =
            read_json(&evidence.join("unit-000/retained-discovery-request.json")).unwrap();
        let negative_observed =
            read_json(&evidence.join("unit-000/native-observation.json")).unwrap();
        let freeze = read_json(&root.join("t00-original-campaign/freeze.json")).unwrap();
        (
            sdk,
            positive,
            positive_observed,
            negative,
            negative_observed,
            freeze["artifact_sha256"].as_str().unwrap().into(),
        )
    }

    #[test]
    #[ignore = "requires explicitly restored public P01/N01 captures; no native execution"]
    fn property_closure_existing_capture_negative_controls() {
        let (sdk, positive, observed, negative, refused, artifact) = fixture();
        let registry = registry();
        let recipes = registry["units"].as_array().unwrap();
        let p = &recipes[0];
        let n = &recipes[1];
        assert!(check_unit(p, &positive, &observed, &sdk, &artifact).is_ok());
        assert!(check_unit(n, &negative, &refused, &sdk, &artifact).is_ok());
        assert!(
            check_unit(n, &positive, &observed, &sdk, &artifact).is_err(),
            "positive cannot replace countercase"
        );
        for field in ["files", "options"] {
            let mut changed = positive.clone();
            changed["analysis"][field] = json!({"forged":true});
            assert!(check_unit(p, &changed, &observed, &sdk, &artifact).is_err());
        }
        let mut changed_sdk = sdk.clone();
        changed_sdk["version"] = json!("forged");
        assert!(check_unit(p, &positive, &observed, &changed_sdk, &artifact).is_err());
        assert!(check_unit(p, &positive, &observed, &sdk, "foreign-artifact").is_err());
        let mut changed = observed.clone();
        changed["native_analysis"]["raw_extraction"]["symbols"][0]["name"] = json!("transient");
        assert!(check_unit(p, &positive, &changed, &sdk, &artifact).is_err());
        changed = observed.clone();
        changed["native_analysis"]["capture_probes"] = json!([]);
        assert!(check_unit(p, &positive, &changed, &sdk, &artifact).is_err());
        let mut changed = refused.clone();
        changed["native_analysis"] = Value::Null;
        assert!(check_unit(n, &negative, &changed, &sdk, &artifact).is_err());
        changed = refused.clone();
        changed["unsupported"] = json!([]);
        assert!(check_unit(n, &negative, &changed, &sdk, &artifact).is_err());
        let mut changed = p.clone();
        changed["checks"] = json!([]);
        assert!(check_unit(&changed, &positive, &observed, &sdk, &artifact).is_err());
    }

    #[test]
    fn property_closure_inventory_cannot_fall_back_to_live_checkout() {
        let result = sidecar(
            &json!({"cases_path":"does-not-exist"}),
            Path::new("missing-evidence"),
        );
        assert_eq!(result["inventory"]["state"], "UNVERIFIED_INVENTORY");
        assert!(result["obligations"].is_null());
        assert_eq!(result["inventory"]["required_obligations"], 240);
        assert_eq!(result["inventory"]["required_properties"], 395);
    }

    #[test]
    fn property_closure_inventory_requires_all_frozen_ids_and_coordinates() {
        let freeze = json!({"cases_path":Path::new(env!("CARGO_MANIFEST_DIR")).join("../../docs/research/rust-ts-r0/cases")});
        let document = verified_inventory(&freeze).unwrap();
        assert!(inventory_summary(&document).is_ok());
        assert!(inventory_summary(&json!({"obligations":[]})).is_err());
        let mut altered = document.clone();
        altered["obligations"][0]["obligation_id"] = json!("substituted-but-same-count");
        assert!(inventory_summary(&altered).is_err());
        altered = document.clone();
        altered["obligations"][0]["obligation_id"] =
            altered["obligations"][1]["obligation_id"].clone();
        assert!(inventory_summary(&altered).is_err());
        altered = document;
        let property = altered["obligations"][0]["cumulative_properties"]
            .as_array_mut()
            .unwrap()
            .pop()
            .unwrap();
        altered["obligations"][1]["cumulative_properties"]
            .as_array_mut()
            .unwrap()
            .push(property);
        assert!(
            inventory_summary(&altered).is_err(),
            "same total count cannot substitute property coordinates"
        );
    }

    #[test]
    fn property_closure_missing_old_candidate_and_removed_pair_fail_closed() {
        let head = repository_head(&Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")).unwrap();
        assert!(candidate_binding(&json!({"optimized_frozen":true}), &head).is_err());
        assert!(candidate_binding(&json!({"optimized_frozen":true,"source_head":"37cdaed802d63132cb8b7d738d7b79344c0124f0"}), &head).is_err());
        assert!(
            candidate_binding(&json!({"optimized_frozen":true,"source_head":head}), &head).is_ok()
        );
        let registry = registry();
        assert!(check_pair_ids(&registry["units"].as_array().unwrap()[..1]).is_err());
        let result = sidecar(
            &json!({"optimized_frozen":true,"source_head":"old","cases_path":Path::new(env!("CARGO_MANIFEST_DIR")).join("../../docs/research/rust-ts-r0/cases")}),
            Path::new("missing-evidence"),
        );
        assert_eq!(result["property"]["state"], "NOT_CLOSED");
        assert_eq!(result["other_properties"].as_array().unwrap().len(), 394);
        assert_eq!(result["obligations"].as_array().unwrap().len(), 240);
        assert!(
            result["obligations"]
                .as_array()
                .unwrap()
                .iter()
                .all(|o| o["qualified"] == false)
        );
        assert_eq!(result["qualified"], false);
    }

    #[test]
    #[ignore = "requires restored public captures and caller-owned fixture output; no native execution"]
    fn property_closure_file_dependencies_and_forged_passes() {
        let public = PathBuf::from(std::env::var_os("SEMCTX_CLOSURE_PUBLIC_FIXTURE").unwrap());
        let out = PathBuf::from(
            std::env::var_os("SEMCTX_CLOSURE_TEST_OUTPUT").expect("fresh caller-owned output"),
        );
        assert!(!out.exists(), "fixture output must be fresh");
        fs::create_dir_all(&out).unwrap();
        let recipes_path = PathBuf::from(
            std::env::var_os("SEMCTX_CLOSURE_RECIPES").expect("current prepared recipes"),
        );
        let recipes = read_json(&recipes_path).unwrap();
        let sdk_path = public.join("t00-original-campaign/sdk-input.json");
        let artifact_path = out.join("oracle-test-artifact");
        let helper_path = out.join("oracle-test-helper");
        // These are oracle fixtures, deliberately never executed or native qualification evidence.
        fs::write(&artifact_path, b"oracle fixture artifact").unwrap();
        fs::write(&helper_path, b"oracle fixture helper").unwrap();
        let artifact = sha(b"oracle fixture artifact");
        let helper = sha(b"oracle fixture helper");
        let cases = out.join("cases");
        let real_cases =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../../docs/research/rust-ts-r0/cases");
        for source in registry()["sources"].as_array().unwrap() {
            let path = source["path"].as_str().unwrap();
            fs::create_dir_all(cases.join(path).parent().unwrap()).unwrap();
            fs::copy(real_cases.join(path), cases.join(path)).unwrap();
        }
        let local_sdk = out.join("sdk.json");
        let local_recipes = out.join("recipes.json");
        fs::copy(&sdk_path, &local_sdk).unwrap();
        fs::copy(&recipes_path, &local_recipes).unwrap();
        let mut freeze = json!({"optimized_frozen":true,"source_head":repository_head(&Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")).unwrap(),"cases_path":cases,"artifact_path":artifact_path,"artifact_sha256":artifact,"helper_path":helper_path,"helper_sha256":helper,"sdk_path":local_sdk,"sdk_sha256":sha(&fs::read(&local_sdk).unwrap()),"recipes_path":local_recipes,"recipes_sha256":sha(&fs::read(&local_recipes).unwrap())});
        let evidence = out.join("evidence");
        for (id, historical) in [(POSITIVE, "unit-349"), (NEGATIVE, "unit-000")] {
            let index = recipes["recipes"]
                .as_array()
                .unwrap()
                .iter()
                .position(|r| r["unit_id"] == id)
                .unwrap();
            let dir = evidence.join(format!("unit-{index:03}"));
            let origin = public
                .join("t00-original-campaign/evidence")
                .join(historical);
            fs::create_dir_all(&dir).unwrap();
            for name in [
                "retained-discovery-request.json",
                "analysis-request.json",
                "physical-post-capture-setup.json",
            ] {
                fs::copy(origin.join(name), dir.join(name)).unwrap();
            }
            let descriptor = read_json(&dir.join("retained-discovery-request.json")).unwrap();
            let mut observed = read_json(&origin.join("native-observation.json")).unwrap();
            observed["producer_artifact_id"] = json!(format!("sha256:{artifact}"));
            if id == POSITIVE {
                observed["native_analysis"]["producer_artifact_id"] =
                    observed["producer_artifact_id"].clone();
            }
            save(&dir.join("native-observation.json"), &observed).unwrap();
            let stdout = serde_json::to_string(&observed).unwrap();
            let mut outcome = read_json(&origin.join("process-outcome.json")).unwrap();
            outcome["stdout"] = json!(stdout);
            outcome["stdout_bytes"] = json!(stdout.len());
            outcome["stdout_hash"] = json!(sha(stdout.as_bytes()));
            save(&dir.join("process-outcome.json"), &outcome).unwrap();
            save(&dir.join("process-invocation.json"), &json!({"argv":[artifact_path,"--analyze-retained-discovery",dir.join("retained-discovery-request.json"),local_sdk],"cwd":descriptor["analysis"]["cwd"],"process_outcome_id":identity::digest(&outcome)})).unwrap();
            save(&dir.join("artifact-observation.json"), &json!({"before":{"artifact_sha256":artifact,"helper_sha256":helper},"after":{"artifact_sha256":artifact,"helper_sha256":helper}})).unwrap();
            save(
                &dir.join("result.json"),
                &json!({"pass":true,"checks":[{"pass":true}]}),
            )
            .unwrap();
        }
        let head = repository_head(&Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")).unwrap();
        let assessment = evaluate_evidence(&freeze, &evidence, &head).unwrap();
        assert_eq!(
            assessment["state"], "UNPROVEN_EXECUTION_BUILD_PROVENANCE",
            "relabelled captures with an unexecuted text artifact must never close a property"
        );
        assert_eq!(assessment["closure_credit"], false);
        save(&out.join("recomposed-capture-assessment.json"), &assessment).unwrap();
        save(
            &out.join("oracle-fixture-sidecar.json"),
            &sidecar(&freeze, &evidence),
        )
        .unwrap();
        let inventory_path = cases.join("qualification/obligations.json");
        let original_inventory = fs::read(&inventory_path).unwrap();
        for altered in [
            json!({"obligations":[]}),
            json!({"obligations":[{"obligation_id":"substituted","cumulative_properties":[]}]}),
        ] {
            save(&inventory_path, &altered).unwrap();
            let assessment = sidecar(&freeze, &evidence);
            assert_eq!(
                assessment["inventory"]["state"], "UNVERIFIED_INVENTORY",
                "sidecar cannot borrow the separate live inventory"
            );
            assert!(
                assessment["obligations"].is_null(),
                "invalid inventory cannot become an empty success inventory"
            );
            assert_eq!(assessment["closure_credit"], false);
        }
        fs::write(&inventory_path, original_inventory).unwrap();
        for target in [
            &artifact_path,
            &local_sdk,
            &local_recipes,
            &cases.join("allocation/input-index.json"),
        ] {
            let original = fs::read(target).unwrap();
            fs::write(target, b"modified dependency").unwrap();
            assert!(
                evaluate_evidence(&freeze, &evidence, &head).is_err(),
                "changed {}",
                target.display()
            );
            fs::write(target, original).unwrap();
        }
        for field in ["checks", "capture_request"] {
            let mut changed = recipes.clone();
            changed["recipes"][349]
                .as_object_mut()
                .unwrap()
                .remove(field);
            save(&local_recipes, &changed).unwrap();
            freeze["recipes_sha256"] = json!(sha(&fs::read(&local_recipes).unwrap()));
            assert!(
                evaluate_evidence(&freeze, &evidence, &head).is_err(),
                "missing {field}, forged result.json remains pass:true"
            );
        }
        let mut changed = recipes.clone();
        changed["recipes"].as_array_mut().unwrap().remove(349);
        save(&local_recipes, &changed).unwrap();
        freeze["recipes_sha256"] = json!(sha(&fs::read(&local_recipes).unwrap()));
        assert!(
            evaluate_evidence(&freeze, &evidence, &head).is_err(),
            "missing adopted unit"
        );
        fs::copy(&recipes_path, &local_recipes).unwrap();
        freeze["recipes_sha256"] = json!(sha(&fs::read(&local_recipes).unwrap()));
        assert!(evaluate_evidence(&freeze, &evidence, &head).is_ok());
        fs::rename(
            evidence.join("unit-000/process-outcome.json"),
            evidence.join("unit-000/withheld-outcome.json"),
        )
        .unwrap();
        assert!(
            evaluate_evidence(&freeze, &evidence, &head).is_err(),
            "missing raw outcome cannot use forged pass:true"
        );
        let historical = read_json(&public.join("t00-original-campaign/freeze.json")).unwrap();
        let rejected = sidecar(&historical, &public.join("t00-original-campaign/evidence"));
        assert_eq!(rejected["property"]["state"], "NOT_CLOSED");
        save(&out.join("historical-rejected-sidecar.json"), &rejected).unwrap();
    }
}
