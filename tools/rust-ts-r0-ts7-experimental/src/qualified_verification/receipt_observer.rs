use super::*;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Probe {
    analysis: Request,
    indexed_outcome: process::Outcome,
    variant: String,
}

pub(crate) fn run(descriptor: Value, sdk: &Sdk) -> Result<Value, String> {
    let probe: Probe = serde_json::from_value(descriptor).map_err(|error| error.to_string())?;
    let request = &probe.analysis;
    let artifact = fs::read(std::env::current_exe().map_err(|error| error.to_string())?)
        .map_err(|error| error.to_string())?;
    let observation = analyze(request.clone(), sdk.clone())?;
    let current = batch::build(request, sdk, &observation)?;
    let original = Observation::capture(request, sdk, &probe.indexed_outcome, &current)?;
    let receive = receive_index(request, sdk, &probe.indexed_outcome, &current, &artifact);
    let received = match receive {
        Ok(received) => received,
        Err(reason) => {
            return Ok(
                json!({"received":false,"contextAvailable":false,"reason":reason,"phase":"receive","globalAdmissionInferred":false}),
            );
        }
    };
    let before = original.state(request, &current, &artifact);
    let control = received.receiver.context(Some(&received.receipt), &before);
    let control_paths = control.as_ref().ok().map(owned_paths).transpose()?;
    let control_subjects = control
        .as_ref()
        .ok()
        .map(|context| scope_received::inspect(request, sdk, context))
        .transpose()?;
    let mut freshness = original.freshness.clone();
    let mut graph = original.graph.clone();
    let mut capture = original.capture.clone();
    let mut input = original.input.clone();
    let mut scope = original.scope.clone();
    let mut changed_request = request.clone();
    let changed_path = request
        .roots
        .first()
        .ok_or("receipt witness has no source")?;
    changed_request
        .files
        .get_mut(changed_path)
        .ok_or("receipt source absent")?
        .push_str("\nexport const changedAfterReceipt = 1;\n");
    let foreign_facts = FactsId::observed_json(&json!(["foreign facts"]));
    let foreign_input = InputId::observed_json(&json!({"foreign":"input"}));
    match probe.variant.as_str() {
        "fresh-valid"
        | "invalid-binding"
        | "incomplete-build"
        | "check-changed"
        | "profile-mismatch"
        | "forged-receipt-provenance"
        | "missing-receipt"
        | "request-mismatch"
        | "artifact-mismatch" => {}
        "dirty-known-only-working-tree" => {
            freshness.verdict = FreshnessVerdict::DirtyKnown;
            freshness.reasons = vec!["WORKING_TREE_DIRTY".into()];
        }
        "dirty-other-reason" => {
            freshness.verdict = FreshnessVerdict::DirtyKnown;
            freshness.reasons = vec!["WORKING_TREE_DIRTY".into(), "OTHER".into()];
        }
        "stale" => freshness.verdict = FreshnessVerdict::Stale,
        "missing-freshness-seal" => freshness.seal = None,
        "sealed-facts-mismatch" => {
            freshness
                .seal
                .as_mut()
                .ok_or("seal missing")?
                .repository_facts = foreign_facts
        }
        "indexed-facts-mismatch" => {
            freshness.seal.as_mut().ok_or("seal missing")?.indexed_facts = foreign_facts
        }
        "sealed-input-mismatch" => {
            freshness
                .seal
                .as_mut()
                .ok_or("seal missing")?
                .analysis_input = foreign_input
        }
        "indexed-input-mismatch" => {
            freshness.seal.as_mut().ok_or("seal missing")?.indexed_input = foreign_input
        }
        "expected-input-mismatch" => input = batch::input_manifest(&changed_request, sdk)?,
        "root-mismatch" => scope["repository_root"] = json!("/foreign-root"),
        "post-receipt-graph-mutation" => graph["edges"] = json!([]),
        "post-receipt-capture-mutation" => capture = batch::capture_manifest(&changed_request)?,
        _ => return Err("unknown receipt observation variant".into()),
    }
    let mut state = original.state(request, &current, &artifact);
    state.freshness = &freshness;
    state.graph = &graph;
    state.capture = &capture;
    state.scope = &scope;
    state.input_manifest = &input;
    state.binding_valid = probe.variant != "invalid-binding";
    state.build_complete = probe.variant != "incomplete-build";
    state.check_changed = probe.variant == "check-changed";
    state.request_current = probe.variant != "request-mismatch";
    if probe.variant == "artifact-mismatch" {
        state.artifact_bytes = b"foreign executable bytes";
    }
    if probe.variant == "profile-mismatch" {
        state.profile = "foreign-profile";
    }
    let other_receiver = receive_index(request, sdk, &probe.indexed_outcome, &current, &artifact)?;
    let receiver = if probe.variant == "forged-receipt-provenance" {
        &other_receiver.receiver
    } else {
        &received.receiver
    };
    let receipt = if probe.variant == "missing-receipt" {
        None
    } else {
        Some(&received.receipt)
    };
    let result = receiver.context(receipt, &state);
    let available = result.is_ok();
    let paths = result.as_ref().ok().map(owned_paths).transpose()?;
    let subjects = result
        .as_ref()
        .ok()
        .map(|context| scope_received::inspect(request, sdk, context))
        .transpose()?;
    let reason = result.err().map(|error| format!("{error:?}"));
    let restored = received.receiver.context(Some(&received.receipt), &before);
    let restored_subjects = restored
        .as_ref()
        .ok()
        .map(|context| scope_received::inspect(request, sdk, context))
        .transpose()?;
    Ok(
        json!({"controlRoot":before.scope["repository_root"],"observedRoot":state.scope["repository_root"],"restoredRoot":restored.as_ref().ok().map(|context| context.scope_manifest()["repository_root"].clone()),"received":true,"contextAvailable":available,"controlContextAvailable":control.is_ok(),"controlOwnedPaths":control_paths,"controlSubjects":control_subjects,"subjects":subjects,"ownedPaths":paths,"restoredContextAvailable":restored.is_ok(),"restoredSubjects":restored_subjects,"reason":reason,"phase":"revalidate_after_receipt","globalAdmissionInferred":false}),
    )
}
