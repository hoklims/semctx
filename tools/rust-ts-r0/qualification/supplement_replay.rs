//! Draft supplement consumer only. No native execution without a separately bound permit.
use super::*;
#[path = "supplement_public_bridge.rs"]
mod public_bridge;

const MANIFEST: &str = "923a03767cd5f675c66f4a35b458dcd6f38554fe3c41f90f5a83eebc7292ddc6";

fn enabled_addenda_rows(document: &Value) -> Result<&Vec<Value>, String> {
    if document["execution_enabled"] != true
        || document["candidate_execution_authorized"] != true
        || document["counts"]["addenda"] != 8
        || document["manifest_sha256_by_family"]
            != json!({
                "sdk-assignment":"a302eb10889e2c14f38f5736894a44d817b7fc14362fa569100a8fb3c820db1d",
                "coercion":"e77a81336bc225645f4a89c41ab47abda6d87c1b6ca5bf8750e9641428d0e0e6"
            })
    {
        return Err("addenda authority, denominator or independent seals differ".into());
    }
    let rows = document["rows"].as_array().ok_or("addenda rows absent")?;
    let mut ids = BTreeSet::new();
    let mut families = [0, 0];
    for row in rows {
        let id = value_text(row, "id")?;
        if !safe_id(id)
            || !ids.insert(id)
            || row["kind"] != "addendum"
            || row["execution_enabled"] != true
            || !row["gaps"].as_array().is_some_and(Vec::is_empty)
            || row["recipes"].as_array().is_none_or(|r| r.len() != 1)
        {
            return Err("addenda row is disabled, duplicated or incomplete".into());
        }
        let recipe = &row["recipes"][0];
        if recipe["unit_id"] != id
            || recipe["case_id"] != id
            || recipe["surface"] != "raw_cli"
            || recipe["requests"].as_array().is_none_or(|r| r.len() != 1)
            || recipe["requests"][0]["id"] != id
        {
            return Err("addenda recipe or native request identity differs".into());
        }
        if id.starts_with("addendum::sdk-assignment-") {
            families[0] += 1;
        } else if id.starts_with("addendum::coercion-") {
            families[1] += 1;
        } else {
            return Err("unregistered addenda family".into());
        }
    }
    if rows.len() != 8 || families != [6, 2] {
        return Err("addenda family denominator differs".into());
    }
    Ok(rows)
}

#[test]
fn comparator_addenda_require_explicit_authority_seals_and_eight_distinct_bound_requests() {
    let rows = ["sdk-assignment", "coercion"]
        .iter()
        .enumerate()
        .flat_map(|(family, name)| {
            (0..if family == 0 { 6 } else { 2 }).map(move |index| {
                let id = format!("addendum::{name}-dev-{index}");
                json!({"id":id,"kind":"addendum","execution_enabled":true,"gaps":[],
                "recipes":[{"unit_id":id,"case_id":id,"surface":"raw_cli","requests":[{"id":id}]}]})
            })
        })
        .collect::<Vec<_>>();
    let valid = json!({"execution_enabled":true,"candidate_execution_authorized":true,
        "counts":{"addenda":8},"manifest_sha256_by_family":{
            "sdk-assignment":"a302eb10889e2c14f38f5736894a44d817b7fc14362fa569100a8fb3c820db1d",
            "coercion":"e77a81336bc225645f4a89c41ab47abda6d87c1b6ca5bf8750e9641428d0e0e6"},"rows":rows});
    assert_eq!(enabled_addenda_rows(&valid).unwrap().len(), 8);
    for (pointer, value) in [
        ("/execution_enabled", json!(false)),
        ("/candidate_execution_authorized", json!(false)),
        ("/counts/addenda", json!(7)),
        (
            "/manifest_sha256_by_family/coercion",
            json!("sha256:substituted"),
        ),
        ("/rows/0/execution_enabled", json!(false)),
        (
            "/rows/0/recipes/0/requests/0/id",
            json!("different-request"),
        ),
    ] {
        let mut rejected = valid.clone();
        *rejected.pointer_mut(pointer).unwrap() = value;
        assert!(
            enabled_addenda_rows(&rejected).is_err(),
            "accepted {pointer}"
        );
    }
    let mut duplicate = valid.clone();
    duplicate["rows"][1] = valid["rows"][0].clone();
    assert!(enabled_addenda_rows(&duplicate).is_err());
    let mut omitted = valid.clone();
    omitted["rows"].as_array_mut().unwrap().pop();
    assert!(enabled_addenda_rows(&omitted).is_err());
}

fn row_state(results: &[Value], gaps: &[Value]) -> &'static str {
    if !gaps.is_empty()
        || results.is_empty()
        || results.iter().any(|result| {
            result["state"].as_str().is_some_and(|state| {
                ["UNKNOWN", "NOT_EXECUTABLE", "BINDING", "MALFORMED"]
                    .iter()
                    .any(|word| state.contains(word))
            })
        })
    {
        "UNKNOWN_ABI_OR_OBSERVABILITY_GAP"
    } else if results.iter().any(|result| result["pass"] != true) {
        "RAW_NONPASS_PRESERVED"
    } else {
        "MAPPED_OBSERVATIONS_MATCH_NO_QUALIFICATION_CREDIT"
    }
}

fn safe_id(value: &str) -> bool {
    !value.is_empty()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b':'))
}

fn bound_statement_digests(dir: &Path, fixture: &Value) -> Result<String, String> {
    let request = read_json(&dir.join("request.json"))?;
    let outcome = read_json(&dir.join("process-outcome.json"))?;
    public_bridge::complete_success_capture(&outcome)?;
    let observed: Value =
        serde_json::from_str(value_text(&outcome, "stdout")?).map_err(|error| error.to_string())?;
    let sdk = read_json(Path::new(value_text(fixture, "sdk_path")?))?;
    observation_bound_to_request(
        &observed,
        &request,
        &sdk,
        value_text(fixture, "artifact_sha256")?,
    )?;
    join_successful_reads(&observed, &request, &sdk)?;
    let statements = observed["outlines"]["main.ts"]["outline"]["statements"]
        .as_array()
        .filter(|values| !values.is_empty())
        .ok_or("missing bound actual outline statements")?;
    statements
        .iter()
        .map(|statement| value_text(statement, "digest").map(str::to_owned))
        .collect::<Result<Vec<_>, _>>()
        .map(|values| values.join(","))
}

pub(super) fn dispatch(recipe: &Value, dir: &Path, fixture: &Value) -> Result<Value, String> {
    let artifact = Path::new(value_text(fixture, "artifact_path")?);
    let helper = Path::new(value_text(fixture, "helper_path")?);
    let sdk_path = Path::new(value_text(fixture, "sdk_path")?);
    let artifact_sha = value_text(fixture, "artifact_sha256")?;
    let helper_sha = value_text(fixture, "helper_sha256")?;
    let sdk = read_json(sdk_path)?;
    match value_text(recipe, "surface")? {
        "source_scope_cli" => source_scope_replay::run(recipe, dir, fixture),
        "raw_cli" | "declaration_root_cli" => run_raw_recipe(
            recipe,
            dir,
            artifact,
            helper,
            (sdk_path, &sdk),
            artifact_sha,
            helper_sha,
        ),
        "snapshot_boundary_cli" => public_bridge::snapshot_boundary(recipe, dir, fixture),
        "primitive_cli" => {
            run_primitive_recipe(recipe, dir, artifact, helper, artifact_sha, helper_sha)
        }
        "repository_discovery_cli" => {
            repository_replay::run(recipe, dir, artifact, helper, artifact_sha, helper_sha)
        }
        "qualified_flow_cli" => qualified_flow_replay::run(recipe, dir, fixture),
        "workspace_system_cli" => workspace_system_replay::run(recipe, dir, fixture),
        "retained_runtime_cli" => retained_runtime_replay::run(recipe, dir, fixture),
        "legacy_identity_cli" => legacy_identity_replay::run(recipe, dir, fixture),
        "parallel_cli" => parallel_replay::run(
            recipe,
            dir,
            artifact,
            helper,
            (sdk_path, &sdk),
            artifact_sha,
            helper_sha,
        ),
        other => Err(format!("UNKNOWN_SUPPLEMENT_ENTRYPOINT:{other}")),
    }
}

/// A new root-authorized permit and enabled registry are required after reviewing this draft.
/// It does not affect the original354/51 replay or accept unit pass flags as qualification.
#[test]
#[ignore = "disabled draft ABI; root must first freeze a candidate and authorize a new permit"]
fn supplement_replay_requires_bound_root_authority() {
    let registry_path =
        PathBuf::from(std::env::var_os("SEMCTX_SUPPLEMENT_REGISTRY").expect("registry"));
    let fixture_path =
        PathBuf::from(std::env::var_os("SEMCTX_SUPPLEMENT_FIXTURE").expect("fixture"));
    let permit_path =
        PathBuf::from(std::env::var_os("SEMCTX_SUPPLEMENT_PERMIT").expect("root permit"));
    let out = PathBuf::from(std::env::var_os("SEMCTX_SUPPLEMENT_EVIDENCE").expect("fresh output"));
    let permit = read_json(&permit_path).unwrap();
    let registry = read_json(&registry_path).unwrap();
    let fixture = read_json(&fixture_path).unwrap();
    let addenda_path = PathBuf::from(value_text(&fixture, "supplement_addenda_path").unwrap());
    exact_hash(
        &addenda_path,
        value_text(&fixture, "supplement_addenda_sha256").unwrap(),
    )
    .unwrap();
    assert_eq!(
        permit["addenda_sha256"],
        fixture["supplement_addenda_sha256"]
    );
    let addenda = read_json(&addenda_path).unwrap();
    let addenda_rows = enabled_addenda_rows(&addenda).unwrap();
    assert_eq!(registry["manifest_sha256"], MANIFEST);
    assert_eq!(registry["counts"]["sources"], 67);
    assert_eq!(
        registry["counts"]["public_vectors"], 25,
        "public mapping must be composed before any native query"
    );
    assert_eq!(registry["rows"].as_array().unwrap().len(), 92);
    assert_eq!(
        registry["execution_enabled"], true,
        "draft ABI remains disabled"
    );
    assert_eq!(permit["candidate_execution_authorized"], true);
    assert_eq!(permit["platform"], std::env::consts::OS);
    exact_hash(
        &registry_path,
        value_text(&permit, "registry_sha256").unwrap(),
    )
    .unwrap();
    exact_hash(
        &fixture_path,
        value_text(&permit, "fixture_sha256").unwrap(),
    )
    .unwrap();
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let head = std::process::Command::new("git")
        .args(["rev-parse", "HEAD"])
        .current_dir(&root)
        .output()
        .unwrap();
    let status = std::process::Command::new("git")
        .args(["status", "--porcelain=v1", "--untracked-files=all"])
        .current_dir(&root)
        .output()
        .unwrap();
    assert!(head.status.success() && status.status.success() && status.stdout.is_empty());
    assert_eq!(
        fixture["source_head"],
        String::from_utf8(head.stdout).unwrap().trim()
    );
    assert_eq!(fixture["source_head"], permit["source_head"]);
    assert_eq!(fixture["optimized_frozen"], true);
    exact_hash(
        &std::env::current_exe().unwrap(),
        value_text(&fixture, "qualification_observer_sha256").unwrap(),
    )
    .unwrap();
    for name in [
        "artifact",
        "helper",
        "sdk",
        "qualification_observer",
        "recipes",
    ] {
        exact_hash(
            Path::new(value_text(&fixture, &format!("{name}_path")).unwrap()),
            value_text(&fixture, &format!("{name}_sha256")).unwrap(),
        )
        .unwrap();
    }
    public_bridge::validate_plan(&fixture, &out.join("public")).unwrap();
    assert!(!out.exists(), "single fresh supplement run only");
    fs::create_dir_all(&out).unwrap();
    let mut rows = Vec::new();
    let mut ids = BTreeSet::new();
    let mut output_names = BTreeSet::new();
    for row in registry["rows"].as_array().unwrap() {
        if row["kind"] != "source" {
            continue;
        }
        let id = value_text(row, "id").unwrap();
        assert!(safe_id(id) && ids.insert(id));
        let dir = out.join(id.replace(':', "_"));
        assert!(
            output_names.insert(dir.clone()),
            "colliding output identities"
        );
        fs::create_dir_all(&dir).unwrap();
        let mut gaps = row["gaps"].as_array().unwrap().clone();
        if let Some(expected_case) = row["parameters"]["case_sensitive"].as_bool() {
            fs::write(dir.join("SupplementCaseProbe"), b"host case probe").unwrap();
            let actual_case = !dir.join("supplementcaseprobe").exists();
            fs::remove_file(dir.join("SupplementCaseProbe")).unwrap();
            if actual_case != expected_case {
                gaps.push(json!("UNKNOWN_CAPTURED_NATIVE_CASE_MODE_MISMATCH"));
                rows.push(json!({"id":id,"state":row_state(&[],&gaps),"gaps":gaps,"mapped_results":[],"qualification_credit":0}));
                continue;
            }
        }
        let mut results = Vec::new();
        for (index, recipe) in row["recipes"].as_array().unwrap().iter().enumerate() {
            // Unknown declaration-only roots are not replaced with a different synthetic root.
            if gaps.contains(&json!("UNKNOWN_NATIVE_DECLARATION_ONLY_ROOT_SUBJECT")) {
                break;
            }
            results.push(dispatch(recipe, &dir.join(format!("observation-{index:03}")), &fixture).unwrap_or_else(|error| json!({"pass":false,"state":"UNKNOWN_SUPPLEMENT_EXECUTION_OR_BINDING","error":error})));
        }
        let state = row_state(&results, &gaps);
        rows.push(json!({"id":id,"state":state,"gaps":gaps,"mapped_results":results,"qualification_credit":0}));
    }
    assert_eq!(rows.len(), 67);
    let mut digest_pairs = Vec::new();
    for pair in registry["digest_pairs"].as_array().unwrap() {
        let values = (|| -> Result<(String, String), String> {
            let left = value_text(pair, "before_id")?;
            let right = value_text(pair, "after_id")?;
            if !safe_id(left) || !safe_id(right) {
                return Err("unsafe digest pair identity".into());
            }
            Ok((
                bound_statement_digests(
                    &out.join(left.replace(':', "_")).join("observation-000"),
                    &fixture,
                )?,
                bound_statement_digests(
                    &out.join(right.replace(':', "_")).join("observation-000"),
                    &fixture,
                )?,
            ))
        })();
        let result = match values {
            Ok((left, right)) => {
                let relation = if left == right { "equal" } else { "different" };
                json!({"id":pair["id"],"actual_relation":relation,"expected_ref":pair["expected_ref"],"pass":pair["expected_relation"]==relation,"actual_before":left,"actual_after":right,"qualification_credit":0})
            }
            Err(error) => {
                json!({"id":pair["id"],"state":"UNKNOWN_BOUND_NATIVE_DIGEST_PAIR","error":error,"qualification_credit":0})
            }
        };
        digest_pairs.push(result);
    }
    // Preserve completed observations even if a later public consumer cannot run.
    save(
        &out.join("source-results.json"),
        &json!({"rows":rows,"digest_pairs":digest_pairs,"qualified":false}),
    )
    .unwrap();
    let mut addenda_results = Vec::new();
    let mut addenda_paths = BTreeSet::new();
    for row in addenda_rows {
        let id = value_text(row, "id").unwrap();
        let dir = out.join("addenda").join(id.replace(':', "_"));
        assert!(
            addenda_paths.insert(dir.clone()),
            "colliding addendum output identities"
        );
        fs::create_dir_all(&dir).unwrap();
        let result = dispatch(&row["recipes"][0], &dir, &fixture).unwrap_or_else(|error|
            json!({"pass":false,"state":"UNKNOWN_SUPPLEMENT_EXECUTION_OR_BINDING","error":error}));
        addenda_results.push(json!({"id":id,"result":result,"qualification_credit":0}));
        save(
            &out.join("addenda-results.json"),
            &json!({"rows":addenda_results,"qualified":false}),
        )
        .unwrap();
    }
    let public = public_bridge::run(&fixture, &out.join("public")).unwrap();
    save(&out.join("supplement-report.json"), &json!({"rows":rows,"digest_pairs":digest_pairs,"addenda":addenda_results,"public":public,"original_units":354,"original_supports":51,"qualified":false,"qualification_credit":0,"R0_decision":null})).unwrap();
}

#[test]
fn comparator_supplement_gaps_never_become_positive_from_pass_flags() {
    assert_eq!(
        row_state(&[json!({"pass":true})], &[]),
        "MAPPED_OBSERVATIONS_MATCH_NO_QUALIFICATION_CREDIT"
    );
    assert_eq!(
        row_state(&[json!({"pass":false})], &[]),
        "RAW_NONPASS_PRESERVED"
    );
    assert_eq!(
        row_state(&[json!({"pass":true})], &[json!("missing observable")]),
        "UNKNOWN_ABI_OR_OBSERVABILITY_GAP"
    );
    assert_eq!(row_state(&[], &[]), "UNKNOWN_ABI_OR_OBSERVABILITY_GAP");
    assert!(!safe_id("../foreign") && !safe_id("/absolute") && safe_id("source::public-dev"));
}

#[test]
fn comparator_supplement_pair_process_guard_is_wired_before_native_facts() {
    // Synthetic verifier carrier only: never a candidate run or qualification evidence.
    let dir = std::env::temp_dir().join(format!(
        "semctx-pair-guard-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir(&dir).unwrap();
    let request = json!({"id":"comparator-carrier","cwd":"/dev","sdk_directory":"/sdk/lib","case_sensitive":true,"roots":["/dev/main.ts"],"files":{"/dev/main.ts":"export const carrier=1;"},"options":{},"roles":{},"selection":{},"disabled":[],"retained":true,"qualified":false,"utf16_files":{},"raw_files":{}});
    let sdk = json!({"version":"5.9.3","archive_sha256":"10e108c9cf7d5f2879053dff18515fb405abf2ccef63eaaf017d9c571687a1d3","files":{"/sdk/lib/lib.d.ts":"declare const carrierLib:number;"}});
    let artifact = sha(b"synthetic comparator artifact, never executed");
    let observed = json!({"request":request["id"],"request_id":identity::digest(&request),"input_manifest_id":semctx_r0_probe::receiver::InputId::observed_json(&verifier_logical_input(&request,&sdk).unwrap()).as_str(),"producer_artifact_id":format!("sha256:{artifact}"),"complete":true,"global_admission_inferred":false,"outlines":{"main.ts":{"outline":{"statements":[{"digest":"valid-carrier-digest"}]}}},"capture_probes":[{"operation":"read_file","path":"/dev/main.ts","found":true,"content_id":identity::digest_bytes(b"export const carrier=1;")},{"operation":"read_file","path":"/sdk/lib/lib.d.ts","found":true,"content_id":identity::digest_bytes(b"declare const carrierLib:number;")}]});
    save(&dir.join("request.json"), &request).unwrap();
    save(&dir.join("sdk.json"), &sdk).unwrap();
    let stdout = serde_json::to_string(&observed).unwrap();
    let mut outcome = json!({"kind":"success","exit_code":0,"stdout":stdout,"stderr":"","stdout_bytes":stdout.len(),"stderr_bytes":0,"stdout_hash":sha(stdout.as_bytes()),"stderr_hash":sha(b"")});
    let fixture = json!({"sdk_path":dir.join("sdk.json"),"artifact_sha256":artifact});
    save(&dir.join("process-outcome.json"), &outcome).unwrap();
    assert_eq!(
        bound_statement_digests(&dir, &fixture).unwrap(),
        "valid-carrier-digest",
        "carrier setup must pass before poisoning process state"
    );
    outcome["kind"] = json!("nonzero");
    outcome["exit_code"] = json!(1);
    save(&dir.join("process-outcome.json"), &outcome).unwrap();
    assert_eq!(
        bound_statement_digests(&dir, &fixture),
        Err("NATIVE_PROCESS_NOT_SUCCESS".into())
    );
    assert!(dir.starts_with(std::env::temp_dir()));
    fs::remove_dir_all(dir).unwrap();
}
