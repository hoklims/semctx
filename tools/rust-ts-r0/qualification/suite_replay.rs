use super::*;

fn validate_manifest(manifest: &Value) -> Result<(), String> {
    if manifest["schema_version"] != 1
        || manifest["oracle"]["typescript_version"] != "5.9.3"
        || manifest["oracle"]["baseline"] != "3e94997fcbefa72ad4d49b2cad180ee79b7c0a9b"
    {
        return Err("supplement requires the independent baseline TypeScript 5.9.3 oracle".into());
    }
    let units = manifest["units"]
        .as_array()
        .filter(|units| !units.is_empty())
        .ok_or("missing supplemental units")?;
    let mut ids = BTreeSet::new();
    for unit in units {
        let id = value_text(unit, "unit_id")?;
        if id.is_empty()
            || !ids.insert(id)
            || !matches!(unit["surface"].as_str(), Some("raw_cli" | "primitive_cli"))
        {
            return Err("duplicate supplemental unit or unsupported native surface".into());
        }
        let checks = unit["checks"]
            .as_array()
            .filter(|checks| !checks.is_empty())
            .ok_or("missing supplemental comparisons")?;
        for check in checks {
            if check.as_object().is_none_or(|object| {
                object.keys().any(|key| {
                    !matches!(
                        key.as_str(),
                        "observation"
                            | "target"
                            | "mode"
                            | "expected"
                            | "expected_origin"
                            | "actual_transform"
                            | "operation_binding"
                    )
                })
            }) || !matches!(
                check["actual_transform"].as_str(),
                None | Some("none" | "outline_without_digest_bytes" | "baseline_raw_extraction")
            ) || check["mode"] != "eq"
                || check["target"]
                    .as_array()
                    .is_none_or(|target| target.is_empty())
                || check.get("expected").is_none()
                || check["expected_origin"] != "typescript-5.9.3"
            {
                return Err("supplement requires explicit exact oracle comparisons".into());
            }
        }
        validate_component_checks(checks)?;
    }
    Ok(())
}

#[test]
fn suite_phase_a_replay_requires_frozen_manifest() {
    let manifest_path =
        PathBuf::from(std::env::var_os("SEMCTX_SUITE_MANIFEST").expect("suite manifest"));
    exact_hash(
        &manifest_path,
        &std::env::var("SEMCTX_SUITE_SHA256").expect("suite hash"),
    )
    .unwrap();
    let manifest = read_json(&manifest_path).unwrap();
    validate_manifest(&manifest).unwrap();
    let fixture_path = PathBuf::from(
        std::env::var_os("SEMCTX_QUALIFICATION_FREEZE_MANIFEST").expect("frozen fixture"),
    );
    let fixture = read_json(&fixture_path).unwrap();
    let artifact = Path::new(fixture["artifact_path"].as_str().unwrap());
    let helper = Path::new(fixture["helper_path"].as_str().unwrap());
    let sdk_path = Path::new(fixture["sdk_path"].as_str().unwrap());
    let artifact_sha = fixture["artifact_sha256"].as_str().unwrap();
    let helper_sha = fixture["helper_sha256"].as_str().unwrap();
    exact_hash(artifact, artifact_sha).unwrap();
    exact_hash(helper, helper_sha).unwrap();
    exact_hash(sdk_path, fixture["sdk_sha256"].as_str().unwrap()).unwrap();
    let sdk = read_json(sdk_path).unwrap();
    assert_eq!(sdk["version"], "5.9.3");
    let out =
        PathBuf::from(std::env::var_os("SEMCTX_SUITE_EVIDENCE").expect("fresh suite evidence"));
    assert!(!out.exists(), "supplement evidence cannot be overwritten");
    fs::create_dir_all(&out).unwrap();
    let mut results = vec![];
    for (index, unit) in manifest["units"].as_array().unwrap().iter().enumerate() {
        let dir = out.join(format!("unit-{index:03}"));
        let result = match unit["surface"].as_str().unwrap() {
            "raw_cli" => run_raw_recipe(
                unit,
                &dir,
                artifact,
                helper,
                (sdk_path, &sdk),
                artifact_sha,
                helper_sha,
            ),
            "primitive_cli" => {
                run_primitive_recipe(unit, &dir, artifact, helper, artifact_sha, helper_sha)
            }
            _ => unreachable!(),
        }
        .unwrap_or_else(
            |error| json!({"pass":false,"state":"SUPPLEMENT_EXECUTION_ERROR","error":error}),
        );
        results.push(json!({"unit_id":unit["unit_id"],"result":result}));
    }
    save(&out.join("report.json"), &json!({"schema_version":1,"platform":std::env::consts::OS,"architecture":std::env::consts::ARCH,"artifact_sha256":artifact_sha,"helper_sha256":helper_sha,"manifest_sha256":sha(&fs::read(manifest_path).unwrap()),"units":results,"formalR0ObligationQualified":false})).unwrap();
    assert!(
        results.iter().all(|row| row["result"]["pass"] == true),
        "inspect the retained supplemental report; no NONPASS receives arbitration credit"
    );
}

#[test]
fn comparator_suite_requires_independent_pinned_oracle_and_nonempty_exact_checks() {
    let good = json!({"schema_version":1,"oracle":{"typescript_version":"5.9.3","baseline":"3e94997fcbefa72ad4d49b2cad180ee79b7c0a9b"},"units":[{"unit_id":"synthetic","surface":"raw_cli","checks":[{"target":["answer"],"mode":"eq","expected":17,"expected_origin":"typescript-5.9.3"}],"requests":[{"id":"synthetic"}],"gaps":[]}]});
    assert!(validate_manifest(&good).is_ok());
    for field in ["oracle", "units"] {
        let mut wrong = good.clone();
        wrong.as_object_mut().unwrap().remove(field);
        assert!(validate_manifest(&wrong).is_err());
    }
    let mut filtered = good.clone();
    filtered["units"][0]["checks"][0]["actual_filter"] = json!({"absent":true});
    assert!(validate_manifest(&filtered).is_err());
    for key in [
        "actual_filter_prefix",
        "candidate_expected",
        "version_arbitration",
    ] {
        let mut wrong = good.clone();
        wrong["units"][0]["checks"][0][key] = json!(true);
        assert!(validate_manifest(&wrong).is_err());
    }
    let mut wrong = good.clone();
    wrong["units"][0]["checks"][0]["actual_transform"] = json!("symbol_aliases");
    assert!(validate_manifest(&wrong).is_err());
    let mut wrong = good.clone();
    wrong["oracle"]["typescript_version"] = json!("7.1.0-dev");
    assert!(validate_manifest(&wrong).is_err());
    wrong = good.clone();
    wrong["units"][0]["checks"] = json!([]);
    assert!(validate_manifest(&wrong).is_err());
    wrong = good.clone();
    wrong["units"]
        .as_array_mut()
        .unwrap()
        .push(good["units"][0].clone());
    assert!(validate_manifest(&wrong).is_err());
}

#[test]
fn comparator_suite_outline_projection_keeps_every_semantic_field_and_requires_digest() {
    let original = json!({"statements":[{"digest":"opaque-native-digest","startLine":3,"kind":"import"}],"hasSyntaxErrors":false});
    let projected = transform(&original, "outline_without_digest_bytes");
    assert!(projected.is_ok());
    assert_eq!(
        projected.unwrap(),
        json!({"statements":[{"startLine":3,"kind":"import"}],"hasSyntaxErrors":false})
    );
    let missing = json!({"statements":[{"startLine":3}],"hasSyntaxErrors":false});
    assert!(transform(&missing, "outline_without_digest_bytes").is_err());
    let mut changed = original.clone();
    changed["statements"][0]["startLine"] = json!(4);
    assert_ne!(
        transform(&original, "outline_without_digest_bytes").unwrap(),
        transform(&changed, "outline_without_digest_bytes").unwrap()
    );
}

#[test]
fn comparator_suite_baseline_extraction_preserves_facts_but_ignores_native_only_coordinates() {
    let raw = json!({"modules":["b.ts","a.ts"],"symbols":[{"name":"leaf","startUtf16":0,"endUtf16":9,"scope":[]}],"imports":[],"calls":[]});
    let expected = json!({"modules":["a.ts","b.ts"],"symbols":[{"name":"leaf","scope":[]}],"imports":[],"calls":[]});
    assert_eq!(
        transform(&raw, "baseline_raw_extraction").unwrap(),
        expected
    );
    let mut extra = raw.clone();
    extra["symbols"][0]["extra"] = json!(true);
    assert_ne!(
        transform(&extra, "baseline_raw_extraction").unwrap(),
        expected
    );
    assert!(transform(&json!({"symbols":[]}), "baseline_raw_extraction").is_err());
}

// SOURCE_ONLY compatibility V2: synthetic validator inputs, no native execution.
// This checks accepted metadata shapes, never executed-source provenance.
fn compat_v2_five_source_metadata() -> Value {
    json!([
        {"path":"packages/ts-analyzer/src/top-level-outline.ts","sha256":"2d75f2a99e91aec60ef7baea52e2a62b53c492eed7976c39570dbd6a396b8647"},
        {"path":"packages/ts-analyzer/src/javascript-diagnostics.ts","sha256":"24df500bd622310e0522f7d2ea13082d484e58ece753b102027853622d4ed097"},
        {"path":"packages/ts-analyzer/src/semantic-dependency-diagnostics.ts","sha256":"a13d3a244e75495592075379f2aa7c524f4c0157755459a8640240ea960ab782"},
        {"path":"packages/ts-analyzer/src/ts-symbols.ts","sha256":"259b92fde8c66d72adb5dce767248bd8426f017c7885007f6ec6107a3b54716e"},
        {"path":"scripts/pilot/baselines.ts","sha256":"c0f8b36efeda070078416261282fed97e70d635c142f55c7a30df6150b73adb9"}
    ])
}

#[test]
fn comparator_compat_v2_optional_opaque_source_metadata() {
    let mut manifest = json!({
        "schema_version":1,
        "oracle":{
            "typescript_version":"5.9.3",
            "baseline":"3e94997fcbefa72ad4d49b2cad180ee79b7c0a9b",
            "sourceIdentities":compat_v2_five_source_metadata()
        },
        "units":[{
            "unit_id":"compat-v2-synthetic-primitive",
            "surface":"primitive_cli",
            "primitive_requests":[{"operation":"canonical_json","value":{"synthetic":17}}],
            "checks":[{
                "observation":0,"target":["canonical_json"],"mode":"eq",
                "expected":"{\"synthetic\":17}",
                "expected_origin":"typescript-5.9.3","actual_transform":"none"
            }],
            "gaps":[]
        }]
    });
    assert!(
        validate_manifest(&manifest).is_ok(),
        "INCONCLUSIVE_SETUP: existing five-source metadata control must pass"
    );
    manifest["oracle"]
        .as_object_mut()
        .unwrap()
        .remove("sourceIdentities");
    let absent = validate_manifest(&manifest);
    manifest["oracle"]["sourceIdentities"] = json!([{
        "path":"packages/ts-analyzer/src/javascript-diagnostics.ts",
        "sha256":"24df500bd622310e0522f7d2ea13082d484e58ece753b102027853622d4ed097"
    }]);
    let subset = validate_manifest(&manifest);
    assert!(
        absent.is_ok() && subset.is_ok(),
        "TARGET_RED: optional opaque metadata rejected: absent={absent:?}; one_source={subset:?}"
    );
}

#[test]
fn comparator_compat_v2_diagnostics_envelope_without_suite_metadata() {
    // Same envelope/check construction as diagnostics-oracle.mjs.
    // Unit content and input/instrumentation hashes below are synthetic.
    let mut manifest = json!({
        "schema_version":1,
        "oracle":{
            "baseline":"3e94997fcbefa72ad4d49b2cad180ee79b7c0a9b",
            "typescript_version":"5.9.3",
            "source_sha256":"24df500bd622310e0522f7d2ea13082d484e58ece753b102027853622d4ed097",
            "input_sha256":"1".repeat(64),
            "instrumented_sha256":"2".repeat(64),
            "case_sensitive":true
        },
        "units":[{
            "unit_id":"compat-v2-diagnostics-parsing",
            "surface":"raw_cli",
            "requests":[{
                "id":"compat-v2-diagnostics-parsing",
                "files":{"main.ts":"export const stable = 3;"},
                "roots":["main.ts"],
                "options":{
                    "target":"ES2022","module":"ESNext","moduleResolution":"Bundler",
                    "allowJs":true,"jsx":"Preserve","skipLibCheck":true,
                    "noEmit":true,"strict":false
                },
                "retained":true,"qualified":false,"sdk_directory":"/sdk/lib",
                "roles":{},"selection":{},"disabled":[],"utf16_files":{},"raw_files":{}
            }],
            "checks":[],"gaps":[],"physical_live_after_capture":{},
            "independent_input_origin":"independent synthetic compatibility V2",
            "obligation_indices":[]
        }]
    });
    let checks = [
        ("reasons", json!([])),
        ("executed", json!(true)),
        ("unsupported", json!([]))
    ].into_iter().map(|(field, expected)| {
        let target = json!(["subjects",{"path":"main.ts"},"sourceParsingObservation",field]);
        json!({
            "observation":0,"target":target,"mode":"eq","expected":expected,
            "expected_origin":"typescript-5.9.3","actual_transform":"none",
            "operation_binding":{
                "status":"VERIFIED_SOURCE_OPERATION","target":target,
                "baseline_operation":"inspectSourceParsing",
                "authority":{
                    "baseline":"3e94997fcbefa72ad4d49b2cad180ee79b7c0a9b",
                    "typescript":"5.9.3",
                    "sourceSha256":"24df500bd622310e0522f7d2ea13082d484e58ece753b102027853622d4ed097",
                    "inputSha256":"1".repeat(64)
                }
            }
        })
    }).collect::<Vec<_>>();
    validate_component_checks(&checks)
        .expect("INCONCLUSIVE_SETUP: parsing binding and completeness checks must pass");
    manifest["units"][0]["checks"] = json!(checks);
    let mut with_five = manifest.clone();
    with_five["oracle"]["sourceIdentities"] = compat_v2_five_source_metadata();
    assert!(
        validate_manifest(&with_five).is_ok(),
        "INCONCLUSIVE_SETUP: diagnostics envelope with five-source metadata must pass"
    );
    assert!(manifest["oracle"].get("sourceIdentities").is_none());
    assert!(
        validate_manifest(&manifest).is_ok(),
        "TARGET_RED: actual diagnostics envelope shape rejected without optional suite metadata"
    );
}
