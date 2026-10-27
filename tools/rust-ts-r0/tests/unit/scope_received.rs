use super::*;
use semctx_gates::process::Outcome;
use semctx_r0_probe::receiver::*;
use serde_json::json;
use std::time::{Duration, Instant};

fn with_context(request: &Request, sdk: &Sdk, run: impl FnOnce(&OwnershipContext<'_>)) {
    let input = batch::input_manifest(request, sdk).unwrap();
    let capture = batch::capture_manifest(request).unwrap();
    let snapshot = batch::snapshot_manifest(request, sdk).unwrap();
    let scope = batch::scope_manifest(request).unwrap();
    let graph = json!({"nodes":[],"edges":[]});
    let fact_id = FactsId::observed_json(&json!([]));
    let input_id = InputId::observed_json(&input);
    let freshness = Freshness {
        verdict: FreshnessVerdict::Fresh,
        reasons: vec![],
        seal: Some(FreshnessSeal {
            repository_facts: fact_id.clone(),
            indexed_facts: fact_id,
            analysis_input: input_id.clone(),
            indexed_input: input_id,
        }),
    };
    let state = ObservedState {
        artifact_bytes: b"received-scope-test-producer",
        input_manifest: &input,
        capture: &capture,
        facts: &[],
        graph: &graph,
        snapshot: &snapshot,
        scope: &scope,
        profile: batch::profile(request),
        freshness: &freshness,
        binding_valid: true,
        build_complete: true,
        check_changed: false,
        request_current: true,
    };
    let bindings = state.bindings().unwrap();
    let receiver = Receiver::new(Expected {
        case_id: request.id.clone(),
        request: RequestId::new(&request.id).unwrap(),
        bindings: bindings.clone(),
        profile: batch::profile(request).into(),
        subjects: vec![],
        terminal: ExpectedTerminal::Analyzed,
        deadline: Instant::now() + Duration::from_secs(30),
        max_duration_ms: 30_000,
        output_cap: 8_388_608,
    })
    .unwrap();
    let batch = wire::Batch {
        schema_version: 1,
        case_id: request.id.clone(),
        request_id: request.id.clone(),
        snapshot_id: bindings.snapshot.as_str().into(),
        scope_id: bindings.scope.as_str().into(),
        profile: batch::profile(request).into(),
        producer_artifact_id: bindings.artifact.as_str().into(),
        input_manifest_id: bindings.input.as_str().into(),
        capture_id: bindings.capture.as_str().into(),
        facts_id: bindings.facts.as_str().into(),
        graph_id: bindings.graph.as_str().into(),
        complete: true,
        terminal: wire::Terminal::Complete,
        subjects: vec![],
        facts: vec![],
        diagnostics: vec![],
        input_observations: vec![],
        producer_claimed_ownership: None,
    };
    let stdout = serde_json::to_string(&batch).unwrap();
    let outcome = Outcome {
        kind: "success".into(),
        exit_code: Some(0),
        duration_ms: 0,
        stdout_bytes: stdout.len() as u64,
        stdout_hash: identity::digest_bytes(stdout.as_bytes())
            .trim_start_matches("sha256:")
            .into(),
        stdout,
        stderr: String::new(),
        stderr_bytes: 0,
        stderr_hash: identity::digest_bytes(b"")
            .trim_start_matches("sha256:")
            .into(),
    };
    let receipt = receiver.receive(&outcome, &state).unwrap();
    let context = receiver.context(Some(&receipt), &state).unwrap();
    run(&context);
}

#[test]
fn received_scope_refuses_transplanted_or_changed_compiler_inputs() {
    let request: Request = serde_json::from_value(json!({
        "id":"received-scope-binding","cwd":"/repo","sdk_directory":"/sdk/lib",
        "case_sensitive":true,"roots":[],"files":{"/repo/source.ts":"export const value = 1;"},
        "options":{"target":"ES2022"},"retained":true,"qualified":true
    }))
    .unwrap();
    let sdk = Sdk {
        version: "fixture".into(),
        source_revision: None,
        library_manifest_sha256: None,
        archive_sha256: Some("fixture".into()),
        files: BTreeMap::from([(
            "/sdk/lib/lib.d.ts".into(),
            "declare const sdk: number;".into(),
        )]),
    };
    with_context(&request, &sdk, |context| {
        assert_eq!(
            inspect(&request, &sdk, context).unwrap(),
            Vec::<Value>::new()
        );
        for mutation in [
            "source", "sdk", "case", "root", "sdk-root", "options", "retained", "profile",
        ] {
            let mut changed = request.clone();
            let mut changed_sdk = sdk.clone();
            let expected = match mutation {
                "source" => {
                    changed
                        .files
                        .insert("/repo/source.ts".into(), "export const value = 2;".into());
                    "received ownership inputs differ from validated capture"
                }
                "sdk" => {
                    changed_sdk.files.insert(
                        "/sdk/lib/lib.d.ts".into(),
                        "declare const sdk: string;".into(),
                    );
                    "received ownership inputs differ from validated capture"
                }
                "case" => {
                    changed.case_sensitive = false;
                    assert_eq!(
                        batch::input_manifest(&changed, &changed_sdk).unwrap(),
                        *context.input_manifest()
                    );
                    "received ownership inputs differ from validated capture"
                }
                "root" => {
                    changed.cwd = "/other".into();
                    changed.files = BTreeMap::from([(
                        "/other/source.ts".into(),
                        request.files["/repo/source.ts"].clone(),
                    )]);
                    assert_eq!(
                        batch::input_manifest(&changed, &changed_sdk).unwrap(),
                        *context.input_manifest()
                    );
                    "received ownership scope differs from validated capture"
                }
                "sdk-root" => {
                    changed.sdk_directory = "/other-sdk/lib".into();
                    changed_sdk.files = BTreeMap::from([(
                        "/other-sdk/lib/lib.d.ts".into(),
                        sdk.files["/sdk/lib/lib.d.ts"].clone(),
                    )]);
                    assert_eq!(
                        batch::input_manifest(&changed, &changed_sdk).unwrap(),
                        *context.input_manifest()
                    );
                    "received ownership scope differs from validated capture"
                }
                "options" => {
                    changed.options["target"] = json!("ES5");
                    "received ownership scope differs from validated capture"
                }
                "retained" => {
                    changed.retained = false;
                    "received ownership requires retained qualified inputs"
                }
                _ => {
                    changed.qualified = false;
                    "received ownership requires retained qualified inputs"
                }
            };
            assert_eq!(
                inspect(&changed, &changed_sdk, context).unwrap_err(),
                expected,
                "{mutation}"
            );
        }
    });
}
