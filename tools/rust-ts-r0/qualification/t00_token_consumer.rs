//! Application-private token controls over admitted actual native observations.
//! Controlled seal variants are test parameters, not index-store attestations.
use super::*;
use std::sync::Arc;

struct Token {
    graph: String,
    input: String,
}
type RetainedMap = Arc<BTreeMap<String, String>>;
#[derive(Default)]
struct Owner {
    issued: Vec<Arc<Token>>,
    owned_maps: Vec<RetainedMap>,
}
#[derive(Clone)]
struct Seal {
    repository_graph: String,
    indexed_graph: String,
    analysis_input: String,
    indexed_input: String,
}
#[derive(Clone)]
struct State {
    graph: Value,
    facts: String,
    consumed: String,
    expected: String,
    seal: Option<Seal>,
    verdict: &'static str,
    freshness_reasons: Vec<String>,
    binding_valid: bool,
    build_complete: bool,
    check_changed: bool,
}

impl Owner {
    fn issue(&mut self, state: &State) -> Option<Arc<Token>> {
        let seal = state.seal.as_ref()?;
        let fresh = state.verdict == "FRESH"
            || (state.verdict == "DIRTY_KNOWN"
                && state
                    .freshness_reasons
                    .iter()
                    .all(|r| r == "WORKING_TREE_DIRTY"));
        if !state.binding_valid
            || !state.build_complete
            || state.check_changed
            || !fresh
            || seal.repository_graph != state.facts
            || seal.indexed_graph != state.facts
            || seal.analysis_input != state.consumed
            || seal.indexed_input != state.consumed
            || state.expected != state.consumed
        {
            return None;
        }
        let token = Arc::new(Token {
            graph: identity::digest(&state.graph),
            input: state.consumed.clone(),
        });
        self.issued.push(Arc::clone(&token));
        Some(token)
    }

    fn register(&mut self, token: &Arc<Token>, state: &State, map: &RetainedMap) -> bool {
        if !self.issued.iter().any(|issued| Arc::ptr_eq(issued, token))
            || token.graph != identity::digest(&state.graph)
            || token.input != state.consumed
            || token.input != state.expected
            || state.check_changed
        {
            return false;
        }
        self.owned_maps.push(Arc::clone(map));
        true
    }

    fn owns_map(&self, map: &RetainedMap) -> bool {
        self.owned_maps.iter().any(|owned| Arc::ptr_eq(owned, map))
    }
}

struct NativeContext {
    state: State,
    retained: RetainedMap,
    before: Value,
    after: Value,
    provenance: Value,
}

fn require_native_reads(raw: &Value, request: &Value, reads: &Value) -> Result<(), String> {
    let source = request["roots"][0]
        .as_str()
        .ok_or("token source root missing")?;
    let prefix = format!("{}/", value_text(request, "cwd")?.trim_end_matches('/'));
    let relative = source
        .strip_prefix(&prefix)
        .ok_or("token source outside capture root")?;
    if raw["subjects"][0]["path"] != relative || !request["files"][source].is_string() {
        return Err("token subject is not the captured source root".into());
    }
    let paths = reads["read_paths"]
        .as_array()
        .ok_or("token successful read inventory missing")?;
    let sdk_prefix = format!(
        "{}/",
        value_text(request, "sdk_directory")?.trim_end_matches('/')
    );
    if !paths.iter().any(|p| p.as_str() == Some(source))
        || !paths
            .iter()
            .any(|p| p.as_str().is_some_and(|p| p.starts_with(&sdk_prefix)))
    {
        return Err("token context lacks actual joined source and SDK reads".into());
    }
    Ok(())
}

fn phase(ownership: &Value, key: &str) -> Result<Value, String> {
    let value = &ownership[key];
    if value["executed"] != true
        || value["unsupported"] != json!([])
        || value["reasons"]
            .as_array()
            .is_none_or(|r| r.iter().any(|r| !r.is_string()))
    {
        return Err("token consumer native configuration phase incomplete".into());
    }
    Ok(value.clone())
}

fn opaque_refusal(phase: &Value) -> Result<bool, String> {
    Ok(phase["reasons"]
        .as_array()
        .ok_or("token phase reasons missing")?
        .iter()
        .any(|r| {
            r.as_str()
                .is_some_and(|r| r.contains("SOURCE_OPAQUE_CALLBACK_UNSUPPORTED"))
        }))
}

fn context(
    raw: &Value,
    request: &Value,
    binding: Value,
    reads: Value,
) -> Result<NativeContext, String> {
    if request["retained"] != true
        || request["qualified"] != false
        || request["roots"].as_array().is_none_or(|r| r.len() != 1)
    {
        return Err("token consumer requires one retained ordinary root".into());
    }
    require_native_reads(raw, request, &reads)?;
    let subjects = raw["subjects"]
        .as_array()
        .filter(|s| s.len() == 1)
        .ok_or("token consumer requires one actual native subject")?;
    let ownership = &subjects[0]["opaqueCallbackOwnership"];
    if ownership["executed"] != true
        || ownership["unsupported"] != json!([])
        || ownership["observationScope"] != "native_module_configuration_graph_ownership"
        || ownership["globalAdmissionInferred"] != false
    {
        return Err("token consumer native ownership context incomplete".into());
    }
    let graph = &ownership["graphBeforeEdgeRemoval"];
    let removed = &ownership["graphAfterEdgeRemoval"];
    if graph["nodes"].as_array().is_none_or(Vec::is_empty)
        || graph["edges"].as_array().is_none_or(Vec::is_empty)
        || ownership["graphBeforeEdgeRemovalId"] != identity::digest(graph)
        || ownership["graphAfterEdgeRemovalId"] != identity::digest(removed)
    {
        return Err("token consumer actual native graph hashes or edges absent".into());
    }
    let mut edge_free = graph.clone();
    edge_free["edges"] = json!([]);
    if edge_free != *removed {
        return Err("token consumer native removed graph differs".into());
    }
    let before = phase(ownership, "beforeAnalysis")?;
    let after = phase(ownership, "afterAnalysis")?;
    if !opaque_refusal(&before)?
        || opaque_refusal(&after)?
        || !opaque_refusal(&phase(ownership, "afterGraphEdgesRemoved")?)?
    {
        return Err(
            "token consumer requires actual before/after/removed ownership contrast".into(),
        );
    }
    let retained: BTreeMap<String, String> =
        serde_json::from_value(request["files"].clone()).map_err(|e| e.to_string())?;
    let consumed = value_text(raw, "input_manifest_id")?.to_owned();
    let facts = identity::digest(raw);
    let state = State {
        graph: graph.clone(),
        facts: facts.clone(),
        consumed: consumed.clone(),
        expected: consumed.clone(),
        seal: Some(Seal {
            repository_graph: facts.clone(),
            indexed_graph: facts,
            analysis_input: consumed.clone(),
            indexed_input: consumed,
        }),
        verdict: "FRESH",
        freshness_reasons: vec![],
        binding_valid: true,
        build_complete: true,
        check_changed: false,
    };
    Ok(NativeContext {
        state,
        retained: Arc::new(retained),
        before,
        after,
        provenance: json!({"native_binding":binding,"native_read_join":reads,
            "raw_facts_id":identity::digest(raw),"native_graph_id":identity::digest(graph),
            "request_id":identity::digest(request),"capture_root":request["cwd"],
            "input_manifest_id":raw["input_manifest_id"],
            "controlled_seal_over_actual_native_observation_not_index_store_attestation":true}),
    })
}

fn issuance_variant(base: &State, name: &str) -> State {
    let mut state = base.clone();
    match name {
        "fresh-valid" => (),
        "dirty-known-only" => {
            state.verdict = "DIRTY_KNOWN";
            state.freshness_reasons = vec!["WORKING_TREE_DIRTY".into()];
        }
        "missing-seal" => state.seal = None,
        "stale" => state.verdict = "STALE",
        "dirty-other-reason" => {
            state.verdict = "DIRTY_KNOWN";
            state.freshness_reasons = vec!["OTHER".into()];
        }
        "invalid-binding" => state.binding_valid = false,
        "incomplete-build" => state.build_complete = false,
        "check-changed" => state.check_changed = true,
        "expected-input-mismatch" => state.expected.push_str("-changed"),
        field => {
            if let Some(seal) = state.seal.as_mut() {
                match field {
                    "seal-repositoryGraphHash" => seal.repository_graph.push_str("-changed"),
                    "seal-indexedRepositoryGraphHash" => seal.indexed_graph.push_str("-changed"),
                    "seal-analysisInputHash" => seal.analysis_input.push_str("-changed"),
                    "seal-indexedAnalysisInputHash" => seal.indexed_input.push_str("-changed"),
                    _ => unreachable!("internal variant enumeration"),
                }
            }
        }
    }
    state
}

fn inspect_map(owner: &Owner, native: &NativeContext, map: &RetainedMap) -> Value {
    if owner.owns_map(map) {
        native.after.clone()
    } else {
        native.before.clone()
    }
}

fn controls(native: &NativeContext) -> Result<Value, String> {
    let mut issuance = vec![];
    for name in [
        "fresh-valid",
        "dirty-known-only",
        "missing-seal",
        "stale",
        "dirty-other-reason",
        "invalid-binding",
        "incomplete-build",
        "check-changed",
        "expected-input-mismatch",
        "seal-repositoryGraphHash",
        "seal-indexedRepositoryGraphHash",
        "seal-analysisInputHash",
        "seal-indexedAnalysisInputHash",
    ] {
        let issued = Owner::default()
            .issue(&issuance_variant(&native.state, name))
            .is_some();
        issuance.push(json!({"name":name,"issued":issued}));
    }
    let mut revalidation = vec![];
    let mut map_identity = Value::Null;
    for name in [
        "issued-token",
        "cloned-token",
        "forged-token",
        "graph-digest-mismatch",
        "consumed-digest-mismatch",
        "expected-input-mismatch",
        "check-changed",
    ] {
        let mut owner = Owner::default();
        let issued = owner
            .issue(&native.state)
            .ok_or("actual native base context refused token")?;
        let token = match name {
            "cloned-token" => Arc::new(Token {
                graph: issued.graph.clone(),
                input: issued.input.clone(),
            }),
            "forged-token" => Arc::new(Token {
                graph: "invented".into(),
                input: native.state.consumed.clone(),
            }),
            _ => issued,
        };
        let mut state = native.state.clone();
        match name {
            "graph-digest-mismatch" => {
                let mut additional = state.graph["nodes"][0].clone();
                additional["id"] = json!("additional-node");
                state.graph["nodes"]
                    .as_array_mut()
                    .ok_or("native graph nodes absent")?
                    .push(additional);
            }
            "consumed-digest-mismatch" => state.consumed.push_str("-changed"),
            "expected-input-mismatch" => state.expected.push_str("-changed"),
            "check-changed" => state.check_changed = true,
            _ => (),
        }
        let map = Arc::new((*native.retained).clone());
        let registered = owner.register(&token, &state, &map);
        let observed = inspect_map(&owner, native, &map);
        revalidation.push(json!({"name":name,"refusal":opaque_refusal(&observed)?,
            "registered":registered,"actual_native_phase":if registered {"afterAnalysis"} else {"beforeAnalysis"},
            "configuration_observation":observed}));
        if name == "issued-token" {
            let copied_map = Arc::new((*map).clone());
            map_identity = json!({"issuedTokenSameMapRefusal":opaque_refusal(&inspect_map(&owner,native,&map))?,
                "issuedTokenClonedMapRefusal":opaque_refusal(&inspect_map(&owner,native,&copied_map))?,
                "identical_map_content":*map == *copied_map,"same_map_identity":Arc::ptr_eq(&map,&copied_map)});
        }
    }
    Ok(
        json!({"kind":"native-bound-application-token-controls-v1","counts":{"issuance":13,"revalidation":7,"mapIdentity":1},
        "issuance":issuance,"revalidation":revalidation,"mapIdentity":map_identity,
        "provenance":native.provenance,"qualification_credit":0,"global_admission_inferred":false}),
    )
}

/// Called only after the harness has pinned artifact/helper/SDK bytes around its
/// actual process. This still independently rejects truncated or failed capture.
pub(super) fn observe(
    outcome: &process::Outcome,
    request: &Value,
    sdk: &Value,
    artifact_sha: &str,
) -> Result<Value, String> {
    if outcome.kind != "success"
        || outcome.exit_code != Some(0)
        || !outcome.stderr.is_empty()
        || outcome.stdout_bytes != outcome.stdout.len() as u64
        || outcome.stdout_bytes > 8_388_608
        || outcome.stderr_bytes != 0
        || outcome.stdout_hash != sha(outcome.stdout.as_bytes())
        || outcome.stderr_hash != sha(b"")
    {
        return Err("token consumer requires complete successful actual native process".into());
    }
    let raw: Value = serde_json::from_str(&outcome.stdout).map_err(|e| e.to_string())?;
    let binding = observation_bound_to_request(&raw, request, sdk, artifact_sha)?;
    let reads = join_successful_reads(&raw, request, sdk)?;
    let mut output = controls(&context(&raw, request, binding, reads)?)?;
    output["provenance"]["process_stdout_sha256"] = json!(outcome.stdout_hash);
    Ok(output)
}

#[cfg(test)]
mod comparator_tests {
    use super::*;
    fn dev() -> NativeContext {
        let graph = json!({"nodes":[{"id":"dev-main"},{"id":"dev-helper"}],"edges":[{"from":"dev-main","to":"dev-helper","kind":"calls"}]});
        let consumed = identity::digest(&json!({"dev.ts":"DEVELOPMENT ONLY"}));
        let facts = identity::digest(&graph);
        NativeContext {
            state: State {
                graph,
                facts: facts.clone(),
                consumed: consumed.clone(),
                expected: consumed.clone(),
                seal: Some(Seal {
                    repository_graph: facts.clone(),
                    indexed_graph: facts,
                    analysis_input: consumed.clone(),
                    indexed_input: consumed,
                }),
                verdict: "FRESH",
                freshness_reasons: vec![],
                binding_valid: true,
                build_complete: true,
                check_changed: false,
            },
            retained: Arc::new(BTreeMap::from([(
                "dev.ts".into(),
                "DEVELOPMENT ONLY".into(),
            )])),
            before: json!({"executed":true,"unsupported":[],"reasons":["SOURCE_OPAQUE_CALLBACK_UNSUPPORTED"]}),
            after: json!({"executed":true,"unsupported":[],"reasons":[]}),
            provenance: json!({"DEV_ONLY":true}),
        }
    }
    #[test]
    fn comparator_token_private_identity_and_seal_guards_are_observed() {
        let observed = controls(&dev()).unwrap();
        for value in observed["issuance"].as_array().unwrap() {
            assert_eq!(
                value["issued"],
                matches!(
                    value["name"].as_str(),
                    Some("fresh-valid" | "dirty-known-only")
                ),
                "{}",
                value["name"]
            );
        }
        for value in observed["revalidation"].as_array().unwrap() {
            assert_eq!(
                value["refusal"],
                value["name"] != "issued-token",
                "{}",
                value["name"]
            );
        }
        assert_eq!(observed["mapIdentity"]["issuedTokenSameMapRefusal"], false);
        assert_eq!(observed["mapIdentity"]["issuedTokenClonedMapRefusal"], true);
        assert_eq!(observed["mapIdentity"]["identical_map_content"], true);
        assert_eq!(observed["mapIdentity"]["same_map_identity"], false);
    }
    #[test]
    fn comparator_token_foreign_owner_cannot_adopt_equal_private_token_or_map() {
        let native = dev();
        let mut first = Owner::default();
        let token = first.issue(&native.state).unwrap();
        let mut foreign = Owner::default();
        assert!(!foreign.register(&token, &native.state, &native.retained));
        assert!(!foreign.owns_map(&native.retained));
        assert!(first.register(&token, &native.state, &native.retained));
        assert!(first.owns_map(&native.retained));
        let copy = Arc::new((*native.retained).clone());
        assert!(!first.owns_map(&copy));
    }

    fn carrier(raw: &Value) -> process::Outcome {
        let stdout = serde_json::to_string(raw).unwrap();
        process::Outcome {
            kind: "success".into(),
            exit_code: Some(0),
            duration_ms: 1,
            stdout_bytes: stdout.len() as u64,
            stdout_hash: sha(stdout.as_bytes()),
            stdout,
            stderr: String::new(),
            stderr_bytes: 0,
            stderr_hash: sha(b""),
        }
    }

    #[test]
    fn comparator_token_constructor_binds_actual_validators_before_any_control() {
        // Structure-valid DEV carrier, not a claim that a native process ran.
        let native = dev();
        let request = json!({"id":"token-dev-constructor","cwd":"/dev","sdk_directory":"/sdk",
            "case_sensitive":true,"roots":["/dev/dev.ts"],"files":{"/dev/dev.ts":"DEVELOPMENT ONLY"},
            "utf16_files":{},"raw_files":{},"retained":true,"qualified":false});
        let sdk = json!({"version":"DEV-ONLY","archive_sha256":"DEV-ARCHIVE","files":{"/sdk/lib.d.ts":"DEV SDK ONLY"}});
        let graph = &native.state.graph;
        let mut removed = graph.clone();
        removed["edges"] = json!([]);
        let mut raw = json!({"request":request["id"],"request_id":identity::digest(&request),
            "input_manifest_id":identity::digest(&verifier_logical_input(&request,&sdk).unwrap()),
            "producer_artifact_id":"sha256:dev-artifact","complete":true,"global_admission_inferred":false,
            "capture_probes":[{"operation":"read_file","found":true,"path":"/dev/dev.ts","content_id":identity::digest_bytes(b"DEVELOPMENT ONLY")},
            {"operation":"read_file","found":true,"path":"/sdk/lib.d.ts","content_id":identity::digest_bytes(b"DEV SDK ONLY")}],
            "subjects":[{"path":"dev.ts","opaqueCallbackOwnership":{"executed":true,"unsupported":[],
                "observationScope":"native_module_configuration_graph_ownership","globalAdmissionInferred":false,
                "beforeAnalysis":native.before,"afterAnalysis":native.after,"afterGraphEdgesRemoved":native.before,
                "graphBeforeEdgeRemoval":graph,"graphAfterEdgeRemoval":removed,
                "graphBeforeEdgeRemovalId":identity::digest(graph),"graphAfterEdgeRemovalId":identity::digest(&removed)}}]});
        let healthy = carrier(&raw);
        assert!(observe(&healthy, &request, &sdk, "dev-artifact").is_ok());
        assert!(observe(&healthy, &request, &sdk, "foreign-artifact").is_err());
        let mut other = request.clone();
        other["cwd"] = json!("/other");
        assert!(observe(&healthy, &other, &sdk, "dev-artifact").is_err());
        let mut truncated = healthy.clone();
        truncated.stdout_bytes += 1;
        assert!(observe(&truncated, &request, &sdk, "dev-artifact").is_err());
        raw["capture_probes"][0]["content_id"] = json!("sha256:unrelated-bytes");
        assert!(observe(&carrier(&raw), &request, &sdk, "dev-artifact").is_err());
        raw["capture_probes"][0]["content_id"] = json!(identity::digest_bytes(b"DEVELOPMENT ONLY"));
        raw["subjects"][0]["opaqueCallbackOwnership"]["graphBeforeEdgeRemovalId"] =
            json!("sha256:foreign-graph");
        assert!(observe(&carrier(&raw), &request, &sdk, "dev-artifact").is_err());
        raw["subjects"][0]["opaqueCallbackOwnership"]["graphBeforeEdgeRemovalId"] =
            json!(identity::digest(graph));
        assert!(observe(&carrier(&raw), &request, &sdk, "dev-artifact").is_ok());
    }
}
