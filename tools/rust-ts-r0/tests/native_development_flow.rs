#[path = "support/legacy_identity_flow.rs"]
mod legacy_identity_flow;
#[path = "support/receiver_context.rs"]
mod receiver_context;
#[path = "support/retained_scope_flow.rs"]
mod retained_scope_flow;
use receiver_context::*;
use semctx_gates::process::{self, Outcome};
use semctx_r0_probe::{
    identity,
    receiver::*,
    wire::{self, Fact},
};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

fn write_json(path: &Path, value: &impl serde::Serialize) {
    fs::write(path, serde_json::to_vec_pretty(value).unwrap()).unwrap();
}

fn semantic_id(payload: &Value) -> String {
    format!(
        "{}|{}|{}",
        text(payload, "kind"),
        text(payload, "filePath"),
        text(payload, "name")
    )
}

fn assert_semantics(case: &Value, batch: &wire::Batch) {
    let graph = graph_from_received_facts(&batch.facts);
    let mut graph_ids = BTreeSet::new();
    let mut edge_ids = BTreeSet::new();
    for node in graph["nodes"].as_array().unwrap() {
        assert!(
            graph_ids.insert(text(node, "id").to_string()),
            "duplicate graph node id"
        );
    }
    for edge in graph["edges"].as_array().unwrap() {
        assert!(
            edge_ids.insert(text(edge, "id").to_string()),
            "duplicate graph edge id"
        );
        assert!(
            graph_ids.contains(text(edge, "from")) && graph_ids.contains(text(edge, "to")),
            "dangling actual graph endpoint"
        );
    }
    for fact in &batch.facts {
        match fact {
            Fact::Node {
                id,
                fact_kind,
                payload,
                ..
            } => {
                assert_eq!(text(payload, "id"), id);
                assert_eq!(*fact_kind, format!("node:{}", text(payload, "kind")));
            }
            Fact::Edge {
                fact_kind,
                from,
                to,
                payload,
                ..
            } => {
                assert_eq!(*fact_kind, format!("edge:{}", text(payload, "kind")));
                assert_eq!(text(payload, "from"), from);
                assert_eq!(text(payload, "to"), to);
            }
        }
    }
    let mut semantic_by_graph_id = BTreeMap::new();
    let mut functions = BTreeSet::new();
    for payload in graph["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|node| node["kind"] == "function")
    {
        let semantic = semantic_id(payload);
        assert!(
            functions.insert(semantic.clone()),
            "duplicate semantic function"
        );
        semantic_by_graph_id.insert(text(payload, "id").to_string(), semantic.clone());
        let expected = case["expected_function_projection"]
            .as_array()
            .unwrap()
            .iter()
            .find(|expected| expected["semantic_id"] == semantic)
            .unwrap_or_else(|| panic!("unexpected graph function {semantic}"));
        assert_eq!(
            payload["evidence"],
            json!([{"filePath":expected["path"],"startLine":expected["start_line"],"endLine":expected["end_line"],"sourceKind":"code"}]),
            "actual graph evidence must use exact source lines; private UTF16 fields are separate"
        );
        let private = batch
            .facts
            .iter()
            .find(|fact| matches!(fact,Fact::Node{id,..} if id==text(payload,"id")))
            .unwrap();
        if let Fact::Node { path, range, .. } = private {
            assert_eq!(path.as_deref(), expected["path"].as_str());
            let range = range.as_ref().expect("private function range required");
            assert_eq!(range.start_utf16, expected["start_utf16"].as_u64().unwrap());
            assert_eq!(range.end_utf16, expected["end_utf16"].as_u64().unwrap());
            assert_eq!(
                u64::from(range.start_line),
                expected["start_line"].as_u64().unwrap()
            );
            assert_eq!(
                u64::from(range.end_line),
                expected["end_line"].as_u64().unwrap()
            );
        }
    }
    let expected_functions = case["expected_function_projection"]
        .as_array()
        .unwrap()
        .iter()
        .map(|value| text(value, "semantic_id").to_string())
        .collect::<BTreeSet<_>>();
    assert_eq!(
        functions, expected_functions,
        "missing or extra graph functions"
    );
    let mut calls = BTreeSet::new();
    for edge in graph["edges"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|edge| edge["kind"] == "calls")
    {
        let caller = semantic_by_graph_id
            .get(text(edge, "from"))
            .expect("graph caller has no frozen semantic identity");
        let callee = semantic_by_graph_id
            .get(text(edge, "to"))
            .expect("graph target has no frozen semantic identity");
        let owner = case["expected_function_projection"]
            .as_array()
            .unwrap()
            .iter()
            .find(|value| value["semantic_id"] == *caller)
            .unwrap();
        assert_eq!(
            edge["evidence"],
            json!([{"filePath":owner["path"],"startLine":owner["start_line"],"sourceKind":"code"}]),
            "the frozen one-line caller invokes its alias on line2"
        );
        assert!(
            calls.insert((caller.clone(), callee.clone())),
            "duplicate graph call"
        );
    }
    let expected_calls = case["expected_call_projection"]
        .as_array()
        .unwrap()
        .iter()
        .map(|value| {
            (
                value[0].as_str().unwrap().to_string(),
                value[1].as_str().unwrap().to_string(),
            )
        })
        .collect::<BTreeSet<_>>();
    assert_eq!(
        calls, expected_calls,
        "actual graph must carry the alias call, without homonym invention"
    );
    let outcomes = batch
        .subjects
        .iter()
        .map(|subject| {
            (
                subject.subject_id.clone(),
                serde_json::to_value(subject.outcome)
                    .unwrap()
                    .as_str()
                    .unwrap()
                    .to_string(),
            )
        })
        .collect::<BTreeMap<_, _>>();
    let expected_outcomes = serde_json::from_value::<BTreeMap<String, String>>(
        case["expected_subject_outcomes"].clone(),
    )
    .unwrap();
    assert_eq!(
        outcomes, expected_outcomes,
        "subjects and outcomes come from frozen fixture, never producer denominator"
    );
    let reasons = batch
        .diagnostics
        .iter()
        .map(|reason| reason.code.clone())
        .collect::<BTreeSet<_>>();
    let expected_reasons = case["expected_reason_codes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|reason| reason.as_str().unwrap().to_string())
        .collect::<BTreeSet<_>>();
    assert_eq!(reasons, expected_reasons);
    assert_eq!(
        serde_json::to_value(batch.terminal).unwrap(),
        case["expected_terminal"]
    );
}

fn poisoned(original: &Outcome, mutate: impl FnOnce(&mut Value)) -> Outcome {
    let mut value: Value = serde_json::from_str(&original.stdout).unwrap();
    mutate(&mut value);
    let mut result = original.clone();
    result.stdout = serde_json::to_string(&value).unwrap();
    result.stdout_bytes = result.stdout.len() as u64;
    result.stdout_hash = identity::digest_bytes(result.stdout.as_bytes())
        .trim_start_matches("sha256:")
        .into();
    result
}

fn rejected<T>(result: Result<T, Rejection>, expected: Rejection) {
    match result {
        Err(actual) => assert_eq!(actual, expected),
        Ok(_) => panic!("forged evidence was accepted; expected {expected:?}"),
    }
}

fn adversarial_actual_batch(
    case: &Value,
    request: &Value,
    sdk: &Value,
    outcome: &Outcome,
    observed: &Observed,
    root: &Path,
) {
    let receiver = || ready_receiver(case, observed, Duration::from_secs(30));
    let current = observed.current();
    let endpoint = poisoned(outcome, |batch| {
        let edge = batch["facts"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|fact| fact["fact_kind"] == "edge:calls")
            .unwrap();
        edge["to"] = json!("not-an-observed-node");
        edge["payload"]["to"] = json!("not-an-observed-node");
    });
    rejected(
        receiver().receive(&endpoint, &current),
        Rejection::InvalidFact,
    );
    let range = poisoned(outcome, |batch| {
        let function = batch["facts"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|fact| fact["fact_kind"] == "node:function")
            .unwrap();
        function["range"]["end_utf16"] = json!(9_999_999);
    });
    rejected(
        receiver().receive(&range, &current),
        Rejection::InvalidRange,
    );
    rejected(
        receiver().receive(
            &poisoned(outcome, |b| b["request_id"] = json!("foreign-request")),
            &current,
        ),
        Rejection::IdentityMismatch,
    );
    rejected(
        receiver().receive(
            &poisoned(outcome, |b| {
                b["subjects"].as_array_mut().unwrap().pop();
            }),
            &current,
        ),
        Rejection::SubjectMismatch,
    );
    rejected(
        receiver().receive(
            &poisoned(outcome, |b| b["qualified_admitted"] = json!(true)),
            &current,
        ),
        Rejection::MalformedOutput,
    );
    rejected(
        receiver().receive(
            &poisoned(outcome, |b| b["complete"] = json!(false)),
            &current,
        ),
        Rejection::IncompleteCoverage,
    );
    let late = Receiver::new(expected(
        case,
        observed,
        Instant::now() - Duration::from_millis(1),
    ))
    .unwrap();
    rejected(late.receive(outcome, &current), Rejection::LateResult);
    let logical = text(&case["source_bytes"][0], "path");
    let live_path = root.join(logical);
    let original_bytes = fs::read(&live_path).unwrap();
    fs::write(
        &live_path,
        b"export function changedAfterCapture() { return 19; }\n",
    )
    .unwrap();
    let actual_changed_text = fs::read_to_string(&live_path).unwrap();
    let mut changed_request = request.clone();
    let captured_path = format!("{}/{}", text(request, "cwd"), logical);
    changed_request["files"][&captured_path] = json!(actual_changed_text);
    let actual_batch: wire::Batch = serde_json::from_str(&outcome.stdout).unwrap();
    let changed = bindings_and_observation(
        &changed_request,
        sdk,
        &actual_batch,
        observed.artifact.clone(),
    );
    assert_ne!(changed.input, observed.input);
    assert_ne!(changed.capture, observed.capture);
    assert_ne!(changed.snapshot, observed.snapshot);
    assert_eq!(changed.scope, observed.scope);
    let changed_result = receiver().receive(outcome, &changed.current());
    let current_binding_receiver = ready_receiver(case, &changed, Duration::from_secs(30));
    let stale_batch_result = current_binding_receiver.receive(outcome, &changed.current());
    fs::write(&live_path, &original_bytes).unwrap();
    rejected(changed_result, Rejection::IdentityMismatch);
    rejected(stale_batch_result, Rejection::IdentityMismatch);
    let receipt_receiver = receiver();
    let receipt = receipt_receiver.receive(outcome, &current).unwrap();
    let mut changed_graph = observed.graph.clone();
    changed_graph["nodes"]
        .as_array_mut()
        .unwrap()
        .push(json!({"id":"unreceived-node"}));
    let mut graph_current = observed.current();
    graph_current.graph = &changed_graph;
    rejected(
        receipt_receiver.revalidate(&receipt, &graph_current),
        Rejection::IdentityMismatch,
    );
    let claimed = poisoned(outcome, |b| b["producer_claimed_ownership"] = json!(true));
    let mut missing_seal = observed.freshness.clone();
    missing_seal.seal = None;
    let mut claimed_current = observed.current();
    claimed_current.freshness = &missing_seal;
    rejected(
        receiver().receive(&claimed, &claimed_current),
        Rejection::MissingSeal,
    );
    let mut inactive = observed.current();
    inactive.request_current = false;
    rejected(
        receiver().receive(outcome, &inactive),
        Rejection::InactiveRequest,
    );
}

fn assert_input_provenance(request: &Value, sdk: &Value, batch: &wire::Batch) -> Value {
    let key = |path: &str| {
        let path = path.replace('\\', "/");
        if request["case_sensitive"] == true {
            path
        } else {
            path.to_lowercase()
        }
    };
    let mut supplied = BTreeMap::new();
    for origin in [&request["files"], &sdk["files"]] {
        for (path, content) in origin.as_object().unwrap() {
            assert!(
                supplied
                    .insert(key(path), content.as_str().unwrap())
                    .is_none(),
                "conflicting supplied file identities"
            );
        }
    }
    let mut consumed = BTreeSet::new();
    let mut unique = BTreeSet::new();
    for observation in &batch.input_observations {
        assert!(!observation.context.is_empty() && !observation.operation.is_empty());
        if observation.operation == "case_sensitive" {
            assert_eq!(
                observation.found,
                request["case_sensitive"].as_bool().unwrap()
            );
            assert!(observation.path.is_empty());
        }
        if observation.operation == "captured_cwd" {
            assert_eq!(observation.path, text(request, "cwd"));
            assert!(observation.found);
        }
        assert!(
            unique.insert((
                observation.context.clone(),
                observation.operation.clone(),
                observation.path.clone(),
                observation.found,
                observation.content_id.clone()
            )),
            "duplicate merged observation"
        );
        if observation.operation == "read_file" && observation.found {
            let path = key(&observation.path);
            let bytes = supplied.get(&path).unwrap_or_else(|| {
                panic!(
                    "successful read outside captured source/SDK bytes: {}",
                    observation.path
                )
            });
            assert_eq!(
                observation.content_id.as_deref(),
                Some(identity::digest_bytes(bytes.as_bytes()).as_str()),
                "read hash differs from independently joined input bytes"
            );
            consumed.insert(path);
        } else {
            assert!(
                observation.content_id.is_none(),
                "non-read or absent probe cannot claim consumed bytes"
            );
        }
    }
    for source in request["files"].as_object().unwrap().keys() {
        assert!(
            consumed.contains(&key(source)),
            "root source not observed read"
        );
    }
    for library in ["lib.es2022.full.d.ts", "lib.es2022.d.ts"] {
        let library = format!("{}/{}", text(request, "sdk_directory"), library);
        assert!(
            consumed.contains(&key(&library)),
            "required ES2022 default-library read absent: {library}"
        );
    }
    let sdk_reads = consumed
        .iter()
        .filter(|path| {
            sdk["files"]
                .as_object()
                .unwrap()
                .keys()
                .any(|source| key(source) == **path)
        })
        .cloned()
        .collect::<Vec<_>>();
    json!({"successful_read_paths":consumed,"sdk_read_paths":sdk_reads,"supplied_sdk_files":sdk["files"].as_object().unwrap().len(),"observations":batch.input_observations.len(),"claim":"Native reported captured-Fs observations joined to supplied bytes; no all100-consumed, OS sandbox or coherent acquisition claim."})
}

fn coherent_payload_poisons(
    case: &Value,
    request: &Value,
    sdk: &Value,
    outcome: &Outcome,
    observed: &Observed,
    evidence: &Path,
) {
    let mut results = vec![];
    for mutation in [
        "edge-kind",
        "node-id-changed",
        "node-id-missing",
        "function-evidence-lines",
        "call-evidence-in-range",
    ] {
        let forged = poisoned(outcome, |value| {
            let facts = value["facts"].as_array_mut().unwrap();
            if mutation == "edge-kind" || mutation == "call-evidence-in-range" {
                let edge = facts
                    .iter_mut()
                    .find(|fact| fact["fact_kind"] == "edge:calls")
                    .unwrap();
                if mutation == "edge-kind" {
                    edge["payload"]["kind"] = json!("related_to");
                } else {
                    edge["payload"]["evidence"][0]["startLine"] = json!(3);
                }
            } else {
                let node = facts
                    .iter_mut()
                    .find(|fact| fact["fact_kind"] == "node:function")
                    .unwrap();
                match mutation {
                    "node-id-changed" => node["payload"]["id"] = json!("forged-graph-node"),
                    "node-id-missing" => {
                        node["payload"].as_object_mut().unwrap().remove("id");
                    }
                    _ => {
                        node["payload"]["evidence"][0]["startLine"] = json!(2);
                        node["payload"]["evidence"][0]["endLine"] = json!(2);
                    }
                }
            }
            let facts: Vec<Fact> = serde_json::from_value(value["facts"].clone()).unwrap();
            value["facts_id"] = json!(identity::digest(&serde_json::to_value(&facts).unwrap()));
            value["graph_id"] = json!(identity::digest(&graph_from_received_facts(&facts)));
        });
        let batch: wire::Batch = serde_json::from_str(&forged.stdout).unwrap();
        assert!(
            std::panic::catch_unwind(|| assert_semantics(case, &batch)).is_err(),
            "coherent payload poison escaped semantic oracle: {mutation}"
        );
        let mut current = observed.clone();
        current.facts = batch.facts.clone();
        current.graph = graph_from_received_facts(&current.facts);
        let facts = FactsId::observed_json(&serde_json::to_value(&current.facts).unwrap());
        let seal = current.freshness.seal.as_mut().unwrap();
        seal.repository_facts = facts.clone();
        seal.indexed_facts = facts;
        let receiver = Receiver::new(expected(
            case,
            &current,
            Instant::now() + Duration::from_secs(120),
        ))
        .unwrap();
        let result = receiver.receive(&forged, &current.current());
        let disposition = if mutation == "call-evidence-in-range" {
            assert!(
                result.is_ok(),
                "in-range source line is a semantic oracle property, not a receiver-range proof"
            );
            "structurally-valid-semantic-oracle-rejected"
        } else {
            rejected(
                result,
                if mutation == "function-evidence-lines" {
                    Rejection::InvalidRange
                } else {
                    Rejection::InvalidFact
                },
            );
            "receiver-and-semantic-oracle-rejected"
        };
        results.push(json!({"mutation":mutation,"facts_hash_refreshed":batch.facts_id,"graph_hash_refreshed":batch.graph_id,"freshness_seal_refreshed":true,"disposition":disposition}));
    }
    let actual: wire::Batch = serde_json::from_str(&outcome.stdout).unwrap();
    for mutation in ["read-hash", "read-foreign-path", "nonread-content"] {
        let mut altered = actual.clone();
        if mutation == "nonread-content" {
            let probe = altered
                .input_observations
                .iter_mut()
                .find(|probe| probe.operation != "read_file")
                .expect("expected actual non-read probe");
            probe.content_id = Some("sha256:forged".into());
        } else {
            let probe = altered
                .input_observations
                .iter_mut()
                .find(|probe| probe.operation == "read_file" && probe.found)
                .unwrap();
            if mutation == "read-hash" {
                probe.content_id = Some("sha256:forged".into());
            } else {
                probe.path = "/outside/unidentified-source.ts".into();
            }
        }
        assert!(
            std::panic::catch_unwind(|| assert_input_provenance(request, sdk, &altered)).is_err(),
            "input provenance poison accepted"
        );
        results.push(json!({"mutation":mutation,"disposition":"independent-byte-join-rejected"}));
    }
    write_json(
        &evidence.join("coherent-payload-and-input-poisons.json"),
        &json!({"results":results,"frozen_expectations_unchanged":true,"source_stdout_hash":outcome.stdout_hash}),
    );
}

fn actual_relocation_keeps_content_bindings_and_refuses_old_physical_scope(
    case: &Value,
    request: &Value,
    sdk: &Value,
    outcome: &Outcome,
    observed: &Observed,
    evidence: &Path,
    helper: &Path,
) {
    let relocated_root = evidence.join("relocated-workspace");
    fs::create_dir_all(&relocated_root).unwrap();
    let relocated_cwd = relocated_root
        .canonicalize()
        .unwrap()
        .to_string_lossy()
        .replace('\\', "/");
    let original_cwd = text(request, "cwd");
    let mut relocated_request = request.clone();
    relocated_request["cwd"] = json!(relocated_cwd);
    relocated_request["sdk_directory"] = json!("/sdk-relocated/lib");
    let mut files = BTreeMap::new();
    for relative in case["files"].as_object().unwrap().keys() {
        let source = request["files"][format!("{original_cwd}/{relative}")]
            .as_str()
            .unwrap();
        let physical = relocated_root.join(relative);
        fs::create_dir_all(physical.parent().unwrap()).unwrap();
        fs::write(physical, source).unwrap();
        files.insert(format!("{relocated_cwd}/{relative}"), json!(source));
    }
    relocated_request["files"] = json!(files);
    relocated_request["roots"] = json!(
        case["roots"]
            .as_array()
            .unwrap()
            .iter()
            .map(|relative| format!("{relocated_cwd}/{}", relative.as_str().unwrap()))
            .collect::<Vec<_>>()
    );
    let sdk_prefix = format!("{}/", text(request, "sdk_directory"));
    let mut relocated_sdk = sdk.clone();
    relocated_sdk["files"] = json!(
        sdk["files"]
            .as_object()
            .unwrap()
            .iter()
            .map(|(physical, source)| {
                let relative = physical.strip_prefix(&sdk_prefix).unwrap();
                (format!("/sdk-relocated/lib/{relative}"), source.clone())
            })
            .collect::<BTreeMap<_, _>>()
    );
    let request_path = evidence.join("relocated-request.json");
    let sdk_path = evidence.join("relocated-sdk.json");
    write_json(&request_path, &relocated_request);
    write_json(&sdk_path, &relocated_sdk);
    let argv = vec![
        env!("CARGO_BIN_EXE_semctx-r0-probe").into(),
        "--batch".into(),
        request_path.to_string_lossy().into_owned(),
        sdk_path.to_string_lossy().into_owned(),
    ];
    let relocated_outcome = supervise(
        &argv,
        &relocated_root,
        helper,
        20_000,
        8_388_608,
        evidence,
        "native-relocated",
    );
    assert_eq!(relocated_outcome.kind, "success");
    assert_eq!(relocated_outcome.exit_code, Some(0));
    let relocated_batch: wire::Batch = serde_json::from_str(&relocated_outcome.stdout).unwrap();
    let original_batch: wire::Batch = serde_json::from_str(&outcome.stdout).unwrap();
    assert_semantics(case, &relocated_batch);
    let provenance = assert_input_provenance(&relocated_request, &relocated_sdk, &relocated_batch);
    let relocated = bindings_and_observation(
        &relocated_request,
        &relocated_sdk,
        &relocated_batch,
        observed.artifact.clone(),
    );
    assert_eq!(relocated.input, observed.input);
    assert_eq!(relocated.capture, observed.capture);
    assert_eq!(relocated.snapshot, observed.snapshot);
    assert_ne!(relocated.scope, observed.scope);
    assert_eq!(
        relocated_batch.input_manifest_id,
        original_batch.input_manifest_id
    );
    assert_eq!(relocated_batch.capture_id, original_batch.capture_id);
    assert_eq!(relocated_batch.snapshot_id, original_batch.snapshot_id);
    assert_eq!(
        relocated_batch.producer_artifact_id,
        original_batch.producer_artifact_id
    );
    assert_ne!(relocated_batch.scope_id, original_batch.scope_id);
    let relocated_receiver = ready_receiver(case, &relocated, Duration::from_secs(20));
    let receipt = relocated_receiver
        .receive(&relocated_outcome, &relocated.current())
        .unwrap();
    assert_eq!(receipt.disposition(), EvidenceDisposition::Analyzed);
    let original_receiver = ready_receiver(case, observed, Duration::from_secs(30));
    let original_receipt = original_receiver
        .receive(outcome, &observed.current())
        .unwrap();
    let mut scope_only = observed.current();
    scope_only.scope = &relocated.scope;
    rejected(
        original_receiver.revalidate(&original_receipt, &scope_only),
        Rejection::IdentityMismatch,
    );
    rejected(
        ready_receiver(case, observed, Duration::from_secs(30)).receive(outcome, &scope_only),
        Rejection::IdentityMismatch,
    );
    rejected(
        ready_receiver(case, observed, Duration::from_secs(30))
            .receive(&relocated_outcome, &relocated.current()),
        Rejection::IdentityMismatch,
    );
    write_json(
        &evidence.join("real-relocation.json"),
        &json!({"source_stdout_hash":outcome.stdout_hash,"relocated_stdout_hash":relocated_outcome.stdout_hash,"input_manifest_id":relocated_batch.input_manifest_id,"capture_id":relocated_batch.capture_id,"snapshot_id":relocated_batch.snapshot_id,"original_scope_id":original_batch.scope_id,"relocated_scope_id":relocated_batch.scope_id,"native_byte_join":provenance,"old_expected_rejected":true,"scope_only_current_rejected":true,"old_receipt_scope_revalidation_rejected":true,"claim":"Actual DEV producer executions under distinct physical repository and SDK roots preserve logical content bindings; physical scope remains independently bound. Graph content may retain physical repository metadata; no graph relocation invariance or T02 acquisition claim."}),
    );
}

fn helper_path() -> PathBuf {
    if let Some(path) = std::env::var_os("SEMCTX_PROCESS_HELPER") {
        return PathBuf::from(path);
    }
    panic!(
        "SEMCTX_PROCESS_HELPER must name the already compiled #383 helper; missing supervision never skips this test"
    )
}

fn supervise(
    argv: &[String],
    root: &Path,
    helper: &Path,
    timeout: u64,
    cap: usize,
    evidence: &Path,
    label: &str,
) -> Outcome {
    let producer = Path::new(env!("CARGO_BIN_EXE_semctx-r0-probe"));
    let producer_before = identity::digest_bytes(&fs::read(producer).unwrap());
    let helper_before = identity::digest_bytes(&fs::read(helper).unwrap());
    let started = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis();
    let result = process::run_with_helper(argv, root, timeout, cap, helper).unwrap();
    let producer_after = identity::digest_bytes(&fs::read(producer).unwrap());
    let helper_after = identity::digest_bytes(&fs::read(helper).unwrap());
    write_json(
        &evidence.join(format!("{label}.json")),
        &json!({"argv":argv,"cwd":root,"timeout_ms":timeout,"output_cap":cap,
        "producer_path":producer,"producer_before":producer_before,"producer_after":producer_after,
        "helper_path":helper,"helper_before":helper_before,"helper_after":helper_after,"started_unix_ms":started,"outcome":result,
        "evidence_boundary":"Real #383 supervision of the native binary; no fixture process controller. Host dependencies outside PATH are not excluded."}),
    );
    assert_eq!(
        producer_before, producer_after,
        "producer changed during run"
    );
    assert_eq!(helper_before, helper_after, "supervisor changed during run");
    result
}

#[test]
fn native_alias_homonym_flow_has_independent_semantics_and_refuses_forged_evidence() {
    run_native_fixture(0);
}

#[test]
fn native_default_expression_is_a_controlled_refusal_without_ownership() {
    run_native_fixture(1);
}

#[test]
fn private_supplied_import_bindings_use_the_native_consumer_without_public_reachability_credit() {
    let crate_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let base = std::env::var_os("SEMCTX_NATIVE_EVIDENCE")
        .map(PathBuf::from)
        .unwrap_or_else(|| crate_root.join("development-evidence/native-verifier"));
    let evidence = base.join(format!(
        "controlled-import-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let root = evidence.join("workspace");
    fs::create_dir_all(&root).unwrap();
    let sentinel = root.join("ControlledNativeCaseProbe");
    fs::write(&sentinel, b"case").unwrap();
    let sensitive = !root.join("controllednativecaseprobe").exists();
    fs::remove_file(sentinel).unwrap();
    let cwd = root
        .canonicalize()
        .unwrap()
        .to_string_lossy()
        .replace('\\', "/");
    let mut files = BTreeMap::new();
    for (path, source) in [
        (
            "factory.ts",
            "export function nativeIntegrationFactory(){return 79;}",
        ),
        (
            "probe.test.ts",
            "export async function nativeIntegrationCheck(){const dep=await import('./factory');return dep.nativeIntegrationFactory();}",
        ),
        ("package.json", "{\"type\":\"module\"}"),
    ] {
        fs::write(root.join(path), source).unwrap();
        files.insert(format!("{cwd}/{path}"), source);
    }
    let analysis = json!({"id":"nativeControlledImportDevelopment","cwd":cwd,"sdk_directory":"/sdk/lib","case_sensitive":sensitive,"roots":[format!("{cwd}/factory.ts"),format!("{cwd}/probe.test.ts")],"files":files,"options":{"target":"ES2022","module":"ESNext","moduleResolution":"Bundler","allowJs":true,"jsx":"Preserve","skipLibCheck":true,"noEmit":true,"strict":false},"roles":{"factory.ts":"source","probe.test.ts":"test"},"selection":{},"disabled":[],"retained":true,"qualified":true,"utf16_files":{},"raw_files":{}});
    let sdk_path = std::env::var_os("SEMCTX_NATIVE_SDK")
        .map(PathBuf::from)
        .unwrap_or_else(|| crate_root.join("sdk/sdk-input.json"));
    let sdk: Value = serde_json::from_slice(&fs::read(&sdk_path).unwrap()).unwrap();
    let helper = helper_path();
    let producer = Path::new(env!("CARGO_BIN_EXE_semctx-r0-probe"));
    for (label, bindings, count) in [
        (
            "defined",
            json!([{"relPath":"factory.ts","symbolPath":"nativeIntegrationFactory"}]),
            2,
        ),
        ("empty", json!([]), 0),
    ] {
        let descriptor = json!({"analysis":analysis,"control":{"fromRelPath":"probe.test.ts","moduleSpecifier":"./factory","line":1,"bindingTargets":bindings}});
        let path = evidence.join(format!("{label}-descriptor.json"));
        write_json(&path, &descriptor);
        let argv = vec![
            producer.to_string_lossy().into_owned(),
            "--observe-controlled-assembly".into(),
            path.to_string_lossy().into_owned(),
            sdk_path.to_string_lossy().into_owned(),
        ];
        let outcome = supervise(&argv, &root, &helper, 20_000, 8_388_608, &evidence, label);
        assert_eq!(outcome.kind, "success", "{outcome:?}");
        assert_eq!(outcome.exit_code, Some(0));
        let observed: Value = serde_json::from_str(&outcome.stdout).unwrap();
        assert_eq!(observed["state"], "CONTROLLED_ASSEMBLY_OBSERVED");
        assert_eq!(observed["executed"], true);
        assert_eq!(observed["unsupported"], json!([]));
        assert_eq!(
            observed["control_scope"],
            "PRIVATE_SUPPLIED_EXTRACTION_ONLY"
        );
        assert_eq!(
            observed["request_descriptor_id"],
            identity::digest(&descriptor)
        );
        assert_eq!(observed["sdk_input_id"], identity::digest(&sdk));
        assert_eq!(
            observed["producer_artifact_id"],
            identity::digest_bytes(&fs::read(producer).unwrap())
        );
        assert_eq!(
            observed["native_analysis"]["request_id"],
            identity::digest(&analysis)
        );
        assert_eq!(observed["public_extractor_reachability_claimed"], false);
        assert_eq!(observed["global_admission_inferred"], false);
        assert!(
            observed["native_original_import"]
                .get("bindingTargets")
                .is_none()
        );
        assert_eq!(observed["controlled_import"]["bindingTargets"], bindings);
        assert_eq!(
            observed["native_extraction_id"],
            identity::digest(&observed["native_analysis"]["raw_extraction"])
        );
        assert_eq!(
            observed["controlled_extraction_id"],
            identity::digest(&observed["controlled_extraction"])
        );
        assert!(
            observed["assembly"]["integrityReasons"]
                .as_object()
                .unwrap()
                .is_empty()
        );
        let edges = observed["assembly"]["edges"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|edge| edge["kind"] == "covers" || edge["kind"] == "tested_by")
            .collect::<Vec<_>>();
        assert_eq!(edges.len(), count);
        for edge in edges {
            let nodes = observed["assembly"]["nodes"].as_array().unwrap();
            let node = |end: &str| nodes.iter().find(|node| node["id"] == edge[end]).unwrap();
            let (test, symbol) = if edge["kind"] == "covers" {
                (node("from"), node("to"))
            } else {
                (node("to"), node("from"))
            };
            assert_eq!(test["kind"], "test");
            assert_eq!(test["filePath"], "probe.test.ts");
            assert_eq!(symbol["kind"], "function");
            assert_eq!(symbol["filePath"], "factory.ts");
            assert_eq!(symbol["name"], "nativeIntegrationFactory");
        }
    }
    let path = evidence.join("defined-descriptor.json");
    let argv = vec![
        producer.to_string_lossy().into_owned(),
        "--observe-controlled-assembly".into(),
        path.to_string_lossy().into_owned(),
    ];
    let missing_sdk = supervise(
        &argv,
        &root,
        &helper,
        20_000,
        8_388_608,
        &evidence,
        "missing-sdk",
    );
    assert_eq!(missing_sdk.kind, "nonzero");
    assert_eq!(missing_sdk.exit_code, Some(1));
    assert!(
        serde_json::from_str::<Value>(&missing_sdk.stderr).unwrap()["error"]
            .as_str()
            .unwrap()
            .contains("SDK.json")
    );
    eprintln!(
        "native private consumer DEV evidence: {}",
        evidence.display()
    );
}

fn run_native_fixture(target_index: usize) {
    let fixtures: Value = serde_json::from_str(FROZEN_CASES).unwrap();
    assert_eq!(
        identity::digest_bytes(FROZEN_CASES.as_bytes()),
        "sha256:9e7646eeb7938ee4831cd2314af2140b73100b4a059e51f3c8de6c59e9682c7a"
    );
    let crate_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let evidence_base = std::env::var_os("SEMCTX_NATIVE_EVIDENCE")
        .map(PathBuf::from)
        .unwrap_or_else(|| crate_root.join("development-evidence/native-verifier"));
    let run_id = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let evidence = evidence_base.join(format!("run-{}-{run_id}", std::process::id()));
    fs::create_dir_all(&evidence).unwrap();
    let helper = helper_path();
    assert!(
        helper.is_file(),
        "compiled helper missing: {}",
        helper.display()
    );
    let sdk_path = std::env::var_os("SEMCTX_NATIVE_SDK")
        .map(PathBuf::from)
        .unwrap_or_else(|| crate_root.join("sdk/sdk-input.json"));
    let sdk: Value = serde_json::from_slice(&fs::read(&sdk_path).unwrap()).unwrap();
    assert_eq!(sdk["version"], "5.9.3");
    assert_eq!(
        sdk["archive_sha256"],
        "10e108c9cf7d5f2879053dff18515fb405abf2ccef63eaaf017d9c571687a1d3"
    );
    let options = json!({"target":"ES2022","module":"ESNext","moduleResolution":"Bundler","allowJs":true,"jsx":"Preserve","skipLibCheck":true,"noEmit":true,"strict":false});
    for (index, case) in fixtures["cases"].as_array().unwrap().iter().enumerate() {
        if index != target_index {
            continue;
        }
        let root = evidence.join(format!("workspace-{index}"));
        fs::create_dir_all(&root).unwrap();
        let sentinel = root.join("T00NativeCaseSentinel");
        fs::write(&sentinel, b"observed native case semantics").unwrap();
        let case_sensitive = !root.join("t00nativecasesentinel").exists();
        fs::remove_file(sentinel).unwrap();
        let cwd = root
            .canonicalize()
            .unwrap()
            .to_string_lossy()
            .replace('\\', "/");
        let files = case["files"]
            .as_object()
            .unwrap()
            .iter()
            .map(|(p, t)| {
                let actual = root.join(p);
                fs::create_dir_all(actual.parent().unwrap()).unwrap();
                fs::write(&actual, t.as_str().unwrap()).unwrap();
                (format!("{cwd}/{p}"), t.clone())
            })
            .collect::<BTreeMap<_, _>>();
        let roots = case["roots"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| format!("{cwd}/{}", p.as_str().unwrap()))
            .collect::<Vec<_>>();
        let request = json!({"id":case["id"],"cwd":cwd,"sdk_directory":"/sdk/lib","case_sensitive":case_sensitive,
            "roots":roots,"files":files,"options":options,"retained":true,"qualified":case["qualified"],"roles":{},"selection":{},"utf16_files":{},"raw_files":{}});
        let request_path = evidence.join(format!("request-{index}.json"));
        write_json(&request_path, &request);
        let argv = vec![
            env!("CARGO_BIN_EXE_semctx-r0-probe").into(),
            "--batch".into(),
            request_path.to_string_lossy().into_owned(),
            sdk_path.to_string_lossy().into_owned(),
        ];
        let outcome = supervise(
            &argv,
            &root,
            &helper,
            20_000,
            8_388_608,
            &evidence,
            &format!("native-{index}"),
        );
        assert_eq!(
            outcome.kind, "success",
            "actual native command failed: {outcome:?}"
        );
        assert_eq!(outcome.exit_code, Some(0));
        let batch: wire::Batch = serde_json::from_str(&outcome.stdout)
            .expect("actual stdout must be a strict batch DTO");
        assert_semantics(case, &batch);
        let provenance = assert_input_provenance(&request, &sdk, &batch);
        write_json(
            &evidence.join(format!("input-provenance-{index}.json")),
            &provenance,
        );
        let observed = bindings_and_observation(
            &request,
            &sdk,
            &batch,
            fs::read(env!("CARGO_BIN_EXE_semctx-r0-probe")).unwrap(),
        );
        let receiver = ready_receiver(case, &observed, Duration::from_secs(20));
        let current = observed.current();
        let receipt = receiver
            .receive(&outcome, &current)
            .expect("receiver must accept actual independently checked native batch");
        if index == 0 {
            assert_eq!(receipt.disposition(), EvidenceDisposition::Analyzed);
            let ownership = receiver.revalidate(&receipt, &current).unwrap();
            assert_eq!(ownership.graph(), &observed.graph);
            assert!(!ownership.absence_evidence_eligible(
                &SubjectId::new("src/orbit-use.ts").unwrap(),
                "edge:calls"
            ));
            adversarial_actual_batch(case, &request, &sdk, &outcome, &observed, &root);
            coherent_payload_poisons(case, &request, &sdk, &outcome, &observed, &evidence);
            actual_relocation_keeps_content_bindings_and_refuses_old_physical_scope(
                case, &request, &sdk, &outcome, &observed, &evidence, &helper,
            );
            write_json(
                &evidence.join("receiver-poisons.json"),
                &json!({
                    "case_id":case["id"],"source_stdout_hash":outcome.stdout_hash,
                    "actual_receiver_rejections_completed":["InvalidFact:forged-endpoint-payload","InvalidRange","IdentityMismatch:foreign-request","SubjectMismatch:cardinality","MalformedOutput:forged-admission","IncompleteCoverage","LateResult","IdentityMismatch:postcapture-real-file-observation","IdentityMismatch:graph-mutation","MissingSeal:producer-ownership-claim","InactiveRequest"],
                    "boundary":"Mutated copies of actual native stdout; transformed capture metadata is an in-memory transport adversary, not an observed subprocess Outcome. Frozen semantic expectations unchanged."
                }),
            );
            let mut missing_alias_call = batch.clone();
            missing_alias_call.facts.retain(
                |fact| !matches!(fact, Fact::Edge { fact_kind, .. } if fact_kind == "edge:calls"),
            );
            assert!(
                std::panic::catch_unwind(|| assert_semantics(case, &missing_alias_call)).is_err(),
                "independent semantic oracle must reject removal of an actual alias edge against unchanged frozen expectations"
            );
            let malformed = evidence.join("malformed-request.json");
            fs::write(&malformed, b"{").unwrap();
            let mut failure_argv = argv.clone();
            failure_argv[2] = malformed.to_string_lossy().into_owned();
            let failure = supervise(
                &failure_argv,
                &root,
                &helper,
                20_000,
                8_388_608,
                &evidence,
                "real-native-failure",
            );
            assert_eq!(failure.kind, "nonzero");
            rejected(
                receiver.receive(&failure, &current),
                Rejection::ProcessFailure,
            );
            let timeout = supervise(
                &argv,
                &root,
                &helper,
                1,
                8_388_608,
                &evidence,
                "real-native-timeout",
            );
            assert_eq!(timeout.kind, "timeout");
            rejected(
                receiver.receive(&timeout, &current),
                Rejection::ProcessFailure,
            );
            let capped = supervise(
                &argv,
                &root,
                &helper,
                20_000,
                1,
                &evidence,
                "real-native-output-cap",
            );
            assert_eq!(capped.kind, "output_limit");
            rejected(
                receiver.receive(&capped, &current),
                Rejection::ProcessFailure,
            );
            #[cfg(unix)]
            {
                let empty_path = root.join("empty-path");
                fs::create_dir(&empty_path).unwrap();
                let mut isolated = vec![
                    "/usr/bin/env".into(),
                    "-i".into(),
                    format!("PATH={}", empty_path.display()),
                    "GOPORT_LIB_PARSE_SNAPSHOT=0".into(),
                    "GOPORT_LIB_SNAPSHOT=0".into(),
                ];
                isolated.extend(argv.clone());
                let no_tools = supervise(
                    &isolated,
                    &root,
                    &helper,
                    20_000,
                    8_388_608,
                    &evidence,
                    "real-native-empty-path",
                );
                assert_eq!(no_tools.kind, "success");
                let isolated_batch: wire::Batch = serde_json::from_str(&no_tools.stdout).unwrap();
                assert_semantics(case, &isolated_batch);
                assert_input_provenance(&request, &sdk, &isolated_batch);
                let isolated_receiver = ready_receiver(case, &observed, Duration::from_secs(20));
                let isolated_receipt = isolated_receiver.receive(&no_tools, &current).unwrap();
                assert_eq!(
                    isolated_receipt.disposition(),
                    EvidenceDisposition::Analyzed
                );
            }
        } else {
            assert_eq!(
                receipt.disposition(),
                EvidenceDisposition::ControlledRefusal
            );
            rejected(
                receiver.revalidate(&receipt, &current),
                Rejection::RefusalHasNoOwnership,
            );
        }
        write_json(
            &evidence.join(format!("semantic-{index}.json")),
            &json!({"case_id":case["id"],"fixture_sha256":identity::digest_bytes(FROZEN_CASES.as_bytes()),"function_projection":case["expected_function_projection"],"call_projection":case["expected_call_projection"],"receiver_accepted":true,"semantic_projection_matched":true,"global_qualified_admission_proven":false,"scope":"Two newly authored DEV cases only; qualification and reserved unexecuted."}),
        );
    }
    eprintln!("native DEV evidence: {}", evidence.display());
}

#[test]
fn retained_discovery_checks_captured_text_before_native_analysis() {
    let crate_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let base = std::env::var_os("SEMCTX_NATIVE_EVIDENCE")
        .map(PathBuf::from)
        .unwrap_or_else(|| crate_root.join("development-evidence/native-verifier"));
    let evidence = base.join(format!(
        "retained-discovery-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let root = evidence.join("workspace");
    fs::create_dir_all(&root).unwrap();
    let sentinel = root.join("DiscoveryNativeCaseProbe");
    fs::write(&sentinel, b"case").unwrap();
    let sensitive = !root.join("discoverynativecaseprobe").exists();
    fs::remove_file(sentinel).unwrap();
    let cwd = root
        .canonicalize()
        .unwrap()
        .to_string_lossy()
        .replace('\\', "/");
    let retained = "export function capturedDiscoveryFactory(){return 83;}";
    let transient = "export function liveDiscoveryFactory(){return 89;}";
    fs::write(root.join("factory.ts"), transient).unwrap();
    let analysis = json!({"id":"retainedDiscoveryDevelopment","cwd":cwd,"sdk_directory":"/sdk/lib","case_sensitive":sensitive,"roots":[format!("{cwd}/factory.ts")],"files":{format!("{cwd}/factory.ts"):retained},"options":{"target":"ES2022","module":"ESNext","moduleResolution":"Bundler","allowJs":true,"jsx":"Preserve","skipLibCheck":true,"noEmit":true,"strict":false},"retained":true,"qualified":false,"roles":{},"selection":{},"disabled":[],"utf16_files":{},"raw_files":{}});
    let sdk_path = std::env::var_os("SEMCTX_NATIVE_SDK")
        .map(PathBuf::from)
        .unwrap_or_else(|| crate_root.join("sdk/sdk-input.json"));
    let sdk: Value = serde_json::from_slice(&fs::read(&sdk_path).unwrap()).unwrap();
    let helper = helper_path();
    let producer = Path::new(env!("CARGO_BIN_EXE_semctx-r0-probe"));
    for (label, content, success) in [
        ("consistent", retained, true),
        ("mismatch", transient, false),
    ] {
        let descriptor = json!({"analysis":analysis,"discovered_sources":[{"relPath":"factory.ts","content":content}]});
        let request_path = evidence.join(format!("{label}-request.json"));
        write_json(&request_path, &descriptor);
        let argv = vec![
            producer.to_string_lossy().into_owned(),
            "--analyze-retained-discovery".into(),
            request_path.to_string_lossy().into_owned(),
            sdk_path.to_string_lossy().into_owned(),
        ];
        let outcome = supervise(&argv, &root, &helper, 20_000, 8_388_608, &evidence, label);
        assert_eq!(outcome.kind, "success", "{outcome:?}");
        assert_eq!(outcome.exit_code, Some(0));
        let observed: Value = serde_json::from_str(&outcome.stdout).unwrap();
        assert_eq!(
            observed["request_descriptor_id"],
            identity::digest(&descriptor)
        );
        assert_eq!(observed["sdk_input_id"], identity::digest(&sdk));
        assert_eq!(
            observed["producer_artifact_id"],
            identity::digest_bytes(&fs::read(producer).unwrap())
        );
        assert_eq!(observed["executed"], success, "{observed}");
        assert_eq!(observed["global_admission_inferred"], false);
        if success {
            assert_eq!(observed["snapshot_guard_passed"], true);
            assert_eq!(observed["unsupported"], json!([]));
            assert_eq!(
                observed["native_analysis"]["raw_extraction"]["modules"],
                json!(["factory.ts"])
            );
            let names = observed["native_analysis"]["raw_extraction"]["symbols"]
                .as_array()
                .unwrap()
                .iter()
                .map(|symbol| symbol["name"].as_str().unwrap())
                .collect::<Vec<_>>();
            assert_eq!(names, vec!["capturedDiscoveryFactory"]);
            assert_eq!(
                observed["native_analysis"]["request_id"],
                identity::digest(&analysis)
            );
        } else {
            assert_eq!(
                observed["unsupported"],
                json!(["SOURCE_SNAPSHOT_MISMATCH: factory.ts"])
            );
            assert!(observed.get("native_analysis").is_none());
        }
        assert_eq!(
            fs::read_to_string(root.join("factory.ts")).unwrap(),
            transient
        );
    }
}
