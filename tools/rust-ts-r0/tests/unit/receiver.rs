use super::*;
use serde_json::json;
use std::time::Duration;

struct Fixture {
    artifact: Vec<u8>,
    input: Value,
    capture: Value,
    graph: Value,
    snapshot: Value,
    scope: Value,
    facts: Vec<Fact>,
    freshness: Freshness,
}
impl Fixture {
    fn new() -> Self {
        let mut value = Self {
            artifact: b"development-native-artifact-one".to_vec(),
            input: json!({"source":"function leaf() {}\n"}),
            capture: json!({"source_bytes":"function leaf() {}\n","absent":["missing.ts"]}),
            graph: json!({"nodes":[{"id":"leaf-node","name":"leaf"}],"edges":[]}),
            snapshot: json!({"revision":"development-snapshot-one"}),
            scope: json!({"paths":["a.ts"]}),
            facts: vec![Fact::Node {
                id: "leaf-node".into(),
                subject_id: "subject-a".into(),
                fact_kind: "node:function".into(),
                path: Some("a.ts".into()),
                range: Some(SourceRange {
                    start_utf16: 0,
                    end_utf16: 18,
                    start_line: 1,
                    end_line: 1,
                }),
                payload: json!({"id":"leaf-node","kind":"function","name":"leaf","filePath":"a.ts","evidence":[{"filePath":"a.ts","startLine":1,"endLine":1,"sourceKind":"code"}],"tags":[],"metadata":{}}),
            }],
            freshness: Freshness {
                verdict: FreshnessVerdict::Fresh,
                reasons: vec![],
                seal: None,
            },
        };
        value.rebind_graph();
        let b = value.state().bindings().unwrap();
        value.freshness.seal = Some(FreshnessSeal {
            repository_facts: b.facts.clone(),
            indexed_facts: b.facts,
            analysis_input: b.input.clone(),
            indexed_input: b.input,
        });
        value
    }
    fn rebind_graph(&mut self) {
        self.graph = json!({"nodes":self.facts.iter().filter_map(|f|if let Fact::Node{payload,..}=f {Some(payload.clone())}else{None}).collect::<Vec<_>>(),
                "edges":self.facts.iter().filter_map(|f|if let Fact::Edge{payload,..}=f {Some(payload.clone())}else{None}).collect::<Vec<_>>()});
        self.reseal();
    }
    fn reseal(&mut self) {
        let b = self.state().bindings().unwrap();
        self.freshness.seal = Some(FreshnessSeal {
            repository_facts: b.facts.clone(),
            indexed_facts: b.facts,
            analysis_input: b.input.clone(),
            indexed_input: b.input,
        });
    }
    fn state(&self) -> ObservedState<'_> {
        ObservedState {
            artifact_bytes: &self.artifact,
            input_manifest: &self.input,
            capture: &self.capture,
            facts: &self.facts,
            graph: &self.graph,
            snapshot: &self.snapshot,
            scope: &self.scope,
            profile: "modelo-suite-static-v1",
            freshness: &self.freshness,
            binding_valid: true,
            build_complete: true,
            check_changed: false,
            request_current: true,
        }
    }
    fn expected(&self) -> Expected {
        Expected {
            case_id: "development-receiver-case".into(),
            request: RequestId::new("development-request-one").unwrap(),
            bindings: self.state().bindings().unwrap(),
            profile: "modelo-suite-static-v1".into(),
            subjects: vec![ExpectedSubject {
                id: SubjectId::new("subject-a").unwrap(),
                selection: Selection::Selected,
                source: Some(SourceExtent {
                    path: "a.ts".into(),
                    utf16_length: 19,
                    line_count: 2,
                }),
                fact_kinds: BTreeSet::from(["node:function".into(), "edge:calls".into()]),
                ranged_fact_kinds: BTreeSet::from(["node:function".into()]),
                pathless_fact_kinds: BTreeSet::new(),
                absence_allowed_kinds: BTreeSet::from(["edge:calls".into()]),
            }],
            terminal: ExpectedTerminal::Analyzed,
            deadline: Instant::now() + Duration::from_secs(60),
            max_duration_ms: 30000,
            output_cap: 1024 * 1024,
        }
    }
    fn batch(&self) -> Batch {
        let b = self.state().bindings().unwrap();
        Batch {
            schema_version: 1,
            case_id: "development-receiver-case".into(),
            request_id: "development-request-one".into(),
            snapshot_id: b.snapshot.as_str().into(),
            scope_id: b.scope.as_str().into(),
            profile: "modelo-suite-static-v1".into(),
            producer_artifact_id: b.artifact.as_str().into(),
            input_manifest_id: b.input.as_str().into(),
            capture_id: b.capture.as_str().into(),
            facts_id: b.facts.as_str().into(),
            graph_id: b.graph.as_str().into(),
            complete: true,
            terminal: Terminal::Complete,
            subjects: vec![SubjectReport {
                subject_id: "subject-a".into(),
                selection: Selection::Selected,
                outcome: Some(AnalysisOutcome::Analyzed),
                coverage: vec![
                    Coverage {
                        fact_kind: "node:function".into(),
                        complete: true,
                        negative_evidence_eligible: true,
                    },
                    Coverage {
                        fact_kind: "edge:calls".into(),
                        complete: true,
                        negative_evidence_eligible: true,
                    },
                ],
            }],
            facts: self.facts.clone(),
            diagnostics: vec![],
            producer_claimed_ownership: Some(true),
            input_observations: vec![],
        }
    }
}
fn outcome(batch: &Batch) -> Outcome {
    let stdout = serde_json::to_string(batch).unwrap();
    Outcome {
        kind: "success".into(),
        exit_code: Some(0),
        duration_ms: 1,
        stdout_bytes: stdout.len() as u64,
        stderr_bytes: 0,
        stdout_hash: crate::identity::digest_bytes(stdout.as_bytes())
            .trim_start_matches("sha256:")
            .into(),
        stderr_hash: crate::identity::digest_bytes(b"")
            .trim_start_matches("sha256:")
            .into(),
        stdout,
        stderr: String::new(),
    }
}
#[test]
fn complete_observed_batch_opens_only_owned_negative_evidence_scope() {
    let fixture = Fixture::new();
    let receiver = Receiver::new(fixture.expected()).unwrap();
    let state = fixture.state();
    let receipt = receiver
        .receive(&outcome(&fixture.batch()), &state)
        .unwrap();
    let context = receiver.revalidate(&receipt, &state).unwrap();
    assert_eq!(context.graph(), &fixture.graph);
    assert!(context.absence_evidence_eligible(&SubjectId::new("subject-a").unwrap(), "edge:calls"));
    assert!(
        !context.absence_evidence_eligible(&SubjectId::new("subject-a").unwrap(), "node:function")
    );
}
fn text_outcome(text: String) -> Outcome {
    let mut result = outcome(&Fixture::new().batch());
    result.stdout_bytes = text.len() as u64;
    result.stdout_hash = crate::identity::digest_bytes(text.as_bytes())
        .trim_start_matches("sha256:")
        .into();
    result.stdout = text;
    result
}
fn rejects_batch(fixture: &Fixture, batch: &Batch, reason: Rejection) {
    let receiver = Receiver::new(fixture.expected()).unwrap();
    assert_eq!(
        receiver.receive(&outcome(batch), &fixture.state()).err(),
        Some(reason)
    );
}
#[test]
fn every_unsuccessful_process_kind_and_missing_or_wrong_exit_refuses() {
    let f = Fixture::new();
    let receiver = Receiver::new(f.expected()).unwrap();
    for kind in [
        "cancelled",
        "timeout",
        "output_limit",
        "nonzero",
        "wait_error",
        "capture_error",
        "malformed_output",
        "unknown",
    ] {
        let mut observed = outcome(&f.batch());
        observed.kind = kind.into();
        assert_eq!(
            receiver.receive(&observed, &f.state()).err(),
            Some(Rejection::ProcessFailure),
            "{kind}"
        );
    }
    for code in [None, Some(3), Some(-1)] {
        let mut observed = outcome(&f.batch());
        observed.exit_code = code;
        assert_eq!(
            receiver.receive(&observed, &f.state()).err(),
            Some(Rejection::ProcessFailure)
        );
    }
}
#[test]
fn bounded_captures_require_exact_lengths_hashes_and_duration() {
    let f = Fixture::new();
    let receiver = Receiver::new(f.expected()).unwrap();
    for change in 0..6 {
        let mut observed = outcome(&f.batch());
        match change {
            0 => observed.stdout_bytes += 1,
            1 => observed.stderr_bytes = 1,
            2 => observed.stdout_hash = "0".repeat(64),
            3 => observed.stderr_hash = "0".repeat(64),
            4 => observed.stdout_bytes = 2 * 1024 * 1024,
            _ => observed.duration_ms = 30001,
        }
        let reason = if change == 5 {
            Rejection::LateResult
        } else {
            Rejection::OutputIncomplete
        };
        assert_eq!(receiver.receive(&observed, &f.state()).err(), Some(reason));
    }
}
#[test]
fn absent_malformed_trailing_unknown_and_duplicate_json_refuses() {
    let f = Fixture::new();
    let receiver = Receiver::new(f.expected()).unwrap();
    let valid = serde_json::to_string(&f.batch()).unwrap();
    let unknown = valid.replacen('{', "{\"foreign\":1,", 1);
    let duplicate = valid.replacen('{', "{\"schema_version\":1,", 1);
    let duplicate_payload =
        valid.replace("\"name\":\"leaf\"", "\"name\":\"leaf\",\"name\":\"other\"");
    assert_ne!(duplicate_payload, valid);
    for text in [
        String::new(),
        "null".into(),
        "{}".into(),
        "[".into(),
        format!("{valid} {{}}"),
        unknown,
        duplicate,
        duplicate_payload,
    ] {
        assert_eq!(
            receiver.receive(&text_outcome(text), &f.state()).err(),
            Some(Rejection::MalformedOutput)
        );
    }
}
#[test]
fn every_claimed_identity_is_compared_with_receiver_observation() {
    let f = Fixture::new();
    let receiver = Receiver::new(f.expected()).unwrap();
    let valid = serde_json::to_value(f.batch()).unwrap();
    for key in [
        "case_id",
        "request_id",
        "snapshot_id",
        "scope_id",
        "profile",
        "producer_artifact_id",
        "input_manifest_id",
        "capture_id",
        "facts_id",
        "graph_id",
    ] {
        let mut changed = valid.clone();
        changed[key] = json!("foreign");
        assert_eq!(
            receiver
                .receive(&text_outcome(changed.to_string()), &f.state())
                .err(),
            Some(Rejection::IdentityMismatch),
            "{key}"
        );
    }
}
#[test]
fn own_subject_denominator_cannot_be_omitted_widened_or_replaced() {
    let f = Fixture::new();
    let mut b = f.batch();
    b.subjects.clear();
    rejects_batch(&f, &b, Rejection::SubjectMismatch);
    let mut b = f.batch();
    b.subjects.push(b.subjects[0].clone());
    rejects_batch(&f, &b, Rejection::SubjectMismatch);
    let mut b = f.batch();
    b.subjects[0].subject_id = "foreign".into();
    rejects_batch(&f, &b, Rejection::SubjectMismatch);
    let mut b = f.batch();
    b.subjects[0].selection = Selection::Excluded;
    rejects_batch(&f, &b, Rejection::SubjectMismatch);
    let mut expected = f.expected();
    let mut second = expected.subjects[0].clone();
    second.id = SubjectId::new("subject-b").unwrap();
    expected.subjects.push(second);
    let receiver = Receiver::new(expected).unwrap();
    let mut b = f.batch();
    b.subjects.push(b.subjects[0].clone());
    assert_eq!(
        receiver.receive(&outcome(&b), &f.state()).err(),
        Some(Rejection::DuplicateIdentity)
    );
}
#[test]
fn analysis_requires_complete_terminal_and_each_owned_fact_kind() {
    let f = Fixture::new();
    for status in [
        None,
        Some(AnalysisOutcome::Disabled),
        Some(AnalysisOutcome::Unsupported),
        Some(AnalysisOutcome::Failed),
        Some(AnalysisOutcome::Unknown),
    ] {
        let mut b = f.batch();
        b.subjects[0].outcome = status;
        rejects_batch(&f, &b, Rejection::UnexpectedOutcome);
    }
    let mut b = f.batch();
    b.complete = false;
    rejects_batch(&f, &b, Rejection::IncompleteCoverage);
    let mut b = f.batch();
    b.terminal = Terminal::Refused;
    rejects_batch(&f, &b, Rejection::UnexpectedOutcome);
    let mut b = f.batch();
    b.subjects[0].coverage.pop();
    rejects_batch(&f, &b, Rejection::IncompleteCoverage);
    let mut b = f.batch();
    b.subjects[0].coverage[0].complete = false;
    rejects_batch(&f, &b, Rejection::IncompleteCoverage);
    let mut b = f.batch();
    b.subjects[0].coverage[0].fact_kind = "foreign".into();
    rejects_batch(&f, &b, Rejection::IncompleteCoverage);
    let mut b = f.batch();
    let duplicate = b.subjects[0].coverage[0].clone();
    b.subjects[0].coverage.push(duplicate);
    rejects_batch(&f, &b, Rejection::DuplicateIdentity);
}
#[test]
fn excluded_subjects_remain_present_and_cannot_emit_analysis() {
    let f = Fixture::new();
    let mut expected = f.expected();
    expected.subjects.push(ExpectedSubject {
        id: SubjectId::new("excluded-b").unwrap(),
        selection: Selection::Excluded,
        source: None,
        fact_kinds: BTreeSet::new(),
        ranged_fact_kinds: BTreeSet::new(),
        pathless_fact_kinds: BTreeSet::new(),
        absence_allowed_kinds: BTreeSet::new(),
    });
    let receiver = Receiver::new(expected).unwrap();
    let mut b = f.batch();
    b.subjects.push(SubjectReport {
        subject_id: "excluded-b".into(),
        selection: Selection::Excluded,
        outcome: None,
        coverage: vec![],
    });
    assert!(receiver.receive(&outcome(&b), &f.state()).is_ok());
    b.subjects[1].outcome = Some(AnalysisOutcome::Analyzed);
    assert_eq!(
        receiver.receive(&outcome(&b), &f.state()).err(),
        Some(Rejection::UnexpectedOutcome)
    );
}
#[test]
fn malformed_facts_ranges_and_endpoints_are_refused_on_their_own_guard() {
    for change in 0..12 {
        let mut f = Fixture::new();
        match change {
                0 => f.facts.push(f.facts[0].clone()),
                1 => {
                    if let Fact::Node { id, .. } = &mut f.facts[0] {
                        *id = String::new()
                    }
                }
                2 => {
                    if let Fact::Node { subject_id, .. } = &mut f.facts[0] {
                        *subject_id = "foreign".into()
                    }
                }
                3 => {
                    if let Fact::Node { fact_kind, .. } = &mut f.facts[0] {
                        *fact_kind = "foreign".into()
                    }
                }
                4 => {
                    if let Fact::Node { path, .. } = &mut f.facts[0] {
                        *path = Some("foreign.ts".into())
                    }
                }
                5 => {
                    if let Fact::Node { range, .. } = &mut f.facts[0] {
                        *range = None
                    }
                }
                6 => {
                    if let Fact::Node {
                        range: Some(range), ..
                    } = &mut f.facts[0]
                    {
                        range.start_utf16 = 19
                    }
                }
                7 => {
                    if let Fact::Node {
                        range: Some(range), ..
                    } = &mut f.facts[0]
                    {
                        range.end_utf16 = 20
                    }
                }
                8 => {
                    if let Fact::Node {
                        range: Some(range), ..
                    } = &mut f.facts[0]
                    {
                        range.start_line = 0
                    }
                }
                9 => {
                    if let Fact::Node {
                        range: Some(range), ..
                    } = &mut f.facts[0]
                    {
                        range.start_line = 2
                    }
                }
                10 => {
                    if let Fact::Node {
                        range: Some(range), ..
                    } = &mut f.facts[0]
                    {
                        range.end_line = 3
                    }
                }
                _ => f.facts.push(Fact::Edge {
                    id: "edge-one".into(),
                    subject_id: "subject-a".into(),
                    fact_kind: "edge:calls".into(),
                    from: "leaf-node".into(),
                    to: "foreign".into(),
                    path: Some("a.ts".into()),
                    range: None,
                    payload: json!({"id":"edge:calls:7e3752bd","kind":"calls","from":"leaf-node","to":"foreign","evidence":[{"filePath":"a.ts","startLine":1,"sourceKind":"code"}],"metadata":{}}),
                }),
            }
        f.rebind_graph();
        let reason = match change {
            0 | 1 => Rejection::DuplicateIdentity,
            2 => Rejection::SubjectMismatch,
            3 | 4 => Rejection::InvalidFact,
            11 => Rejection::InvalidEndpoint,
            _ => Rejection::InvalidRange,
        };
        rejects_batch(&f, &f.batch(), reason);
    }
}
#[test]
fn facts_cannot_claim_expected_hash_while_returning_different_values() {
    let f = Fixture::new();
    let mut b = f.batch();
    if let Fact::Node { payload, .. } = &mut b.facts[0] {
        payload["name"] = json!("other")
    }
    rejects_batch(&f, &b, Rejection::IdentityMismatch);
}
#[test]
fn explicit_complete_zero_facts_is_distinct_from_missing_or_partial_result() {
    let mut f = Fixture::new();
    f.facts.clear();
    f.rebind_graph();
    let receiver = Receiver::new(f.expected()).unwrap();
    let b = f.batch();
    assert!(receiver.receive(&outcome(&b), &f.state()).is_ok());
    let mut b = b;
    b.subjects[0].coverage.clear();
    assert_eq!(
        receiver.receive(&outcome(&b), &f.state()).err(),
        Some(Rejection::IncompleteCoverage)
    );
    let mut value = serde_json::to_value(f.batch()).unwrap();
    value.as_object_mut().unwrap().remove("facts");
    assert_eq!(
        receiver
            .receive(&text_outcome(value.to_string()), &f.state())
            .err(),
        Some(Rejection::MalformedOutput)
    );
}
#[test]
fn producer_ownership_bit_cannot_rescue_invalid_binding_or_missing_receipt() {
    let f = Fixture::new();
    let receiver = Receiver::new(f.expected()).unwrap();
    for bit in [None, Some(false), Some(true)] {
        let mut b = f.batch();
        b.producer_claimed_ownership = bit;
        let mut state = f.state();
        state.binding_valid = false;
        assert_eq!(
            receiver.receive(&outcome(&b), &state).err(),
            Some(Rejection::InvalidBinding)
        );
    }
    assert_eq!(
        receiver.context(None, &f.state()).err(),
        Some(Rejection::MissingReceipt)
    );
}
#[test]
fn no_receiver_can_adopt_another_receivers_receipt() {
    let f = Fixture::new();
    let first = Receiver::new(f.expected()).unwrap();
    let second = Receiver::new(f.expected()).unwrap();
    let receipt = first.receive(&outcome(&f.batch()), &f.state()).unwrap();
    assert_eq!(
        second.revalidate(&receipt, &f.state()).err(),
        Some(Rejection::ForeignReceipt)
    );
}
#[test]
fn freshness_revalidates_all_four_seal_values_and_exact_allowed_reasons() {
    for change in 0..7 {
        let mut f = Fixture::new();
        match change {
            0 => f.freshness.seal = None,
            1 => {
                f.freshness.seal.as_mut().unwrap().repository_facts =
                    FactsId::observed_bytes(b"other")
            }
            2 => {
                f.freshness.seal.as_mut().unwrap().indexed_facts = FactsId::observed_bytes(b"other")
            }
            3 => {
                f.freshness.seal.as_mut().unwrap().analysis_input =
                    InputId::observed_bytes(b"other")
            }
            4 => {
                f.freshness.seal.as_mut().unwrap().indexed_input = InputId::observed_bytes(b"other")
            }
            5 => f.freshness.verdict = FreshnessVerdict::Stale,
            _ => f.freshness.verdict = FreshnessVerdict::Unknown,
        }
        let reason = match change {
            0 => Rejection::MissingSeal,
            5 | 6 => Rejection::UnacceptableFreshness,
            _ => Rejection::SealMismatch,
        };
        rejects_batch(&f, &f.batch(), reason);
    }
    for reasons in [
        vec![],
        vec!["WORKING_TREE_DIRTY".into()],
        vec!["FOREIGN_REASON".into()],
    ] {
        let mut f = Fixture::new();
        f.freshness.verdict = FreshnessVerdict::DirtyKnown;
        f.freshness.reasons = reasons;
        let receiver = Receiver::new(f.expected()).unwrap();
        let result = receiver.receive(&outcome(&f.batch()), &f.state());
        if f.freshness
            .reasons
            .iter()
            .all(|v| v == "WORKING_TREE_DIRTY")
        {
            assert!(result.is_ok())
        } else {
            assert_eq!(result.err(), Some(Rejection::UnacceptableFreshness))
        }
    }
}
#[test]
fn active_request_binding_build_and_changed_input_remain_required_at_use() {
    let f = Fixture::new();
    let receiver = Receiver::new(f.expected()).unwrap();
    let receipt = receiver.receive(&outcome(&f.batch()), &f.state()).unwrap();
    for change in 0..4 {
        let mut state = f.state();
        let reason = match change {
            0 => {
                state.request_current = false;
                Rejection::InactiveRequest
            }
            1 => {
                state.binding_valid = false;
                Rejection::InvalidBinding
            }
            2 => {
                state.build_complete = false;
                Rejection::IncompleteBuild
            }
            _ => {
                state.check_changed = true;
                Rejection::CheckChanged
            }
        };
        assert_eq!(receiver.revalidate(&receipt, &state).err(), Some(reason));
    }
    let mut expected = f.expected();
    expected.deadline = Instant::now() - Duration::from_secs(1);
    let receiver = Receiver::new(expected).unwrap();
    assert_eq!(
        receiver.receive(&outcome(&f.batch()), &f.state()).err(),
        Some(Rejection::LateResult)
    );
}
#[test]
fn receipt_does_not_survive_actual_subject_data_mutation() {
    for change in 0..7 {
        let mut f = Fixture::new();
        let receiver = Receiver::new(f.expected()).unwrap();
        let receipt = receiver.receive(&outcome(&f.batch()), &f.state()).unwrap();
        match change {
            0 => f.artifact.push(b'!'),
            1 => f.input["source"] = json!("changed"),
            2 => f.capture["source_bytes"] = json!("changed"),
            3 => {
                if let Fact::Node { payload, .. } = &mut f.facts[0] {
                    *payload = json!({"name":"changed"})
                }
            }
            4 => f.graph["nodes"][0]["name"] = json!("changed"),
            5 => f.snapshot["revision"] = json!("changed"),
            _ => f.scope["paths"] = json!(["other.ts"]),
        }
        if change == 4 {
            f.reseal()
        } else {
            f.rebind_graph()
        }
        assert_eq!(
            receiver.revalidate(&receipt, &f.state()).err(),
            Some(Rejection::IdentityMismatch),
            "mutation {change}"
        );
    }
}
#[test]
fn controlled_nonzero_refusal_is_evidence_without_ownership_or_graph_seal() {
    let mut f = Fixture::new();
    f.facts.clear();
    f.rebind_graph();
    f.freshness.seal = None;
    let mut expected = f.expected();
    expected.terminal = ExpectedTerminal::ControlledRefusal {
        exit_code: 3,
        reason_codes: BTreeSet::from(["UNSUPPORTED_SOURCE".into()]),
    };
    let receiver = Receiver::new(expected).unwrap();
    let mut b = f.batch();
    b.terminal = Terminal::Refused;
    b.subjects[0].outcome = Some(AnalysisOutcome::Unsupported);
    b.subjects[0].coverage.clear();
    b.diagnostics.push(Diagnostic {
        subject_id: "subject-a".into(),
        code: "UNSUPPORTED_SOURCE".into(),
        message: "unsupported source".into(),
        code_utf16: None,
        message_utf16: None,
    });
    let mut observed = outcome(&b);
    observed.kind = "nonzero".into();
    observed.exit_code = Some(3);
    let mut state = f.state();
    state.build_complete = false;
    let receipt = receiver.receive(&observed, &state).unwrap();
    assert_eq!(
        receipt.disposition(),
        EvidenceDisposition::ControlledRefusal
    );
    assert_eq!(
        receiver.revalidate(&receipt, &state).err(),
        Some(Rejection::RefusalHasNoOwnership)
    );
    b.diagnostics[0].code = "OTHER".into();
    let mut wrong = outcome(&b);
    wrong.kind = "nonzero".into();
    wrong.exit_code = Some(3);
    assert_eq!(
        receiver.receive(&wrong, &state).err(),
        Some(Rejection::RefusalMismatch)
    );
    observed.exit_code = Some(1);
    assert_eq!(
        receiver.receive(&observed, &state).err(),
        Some(Rejection::ProcessFailure)
    );
}
#[test]
fn diagnostic_utf16_values_are_consumed_without_display_loss() {
    let mut fixture = Fixture::new();
    fixture.facts.clear();
    fixture.rebind_graph();
    fixture.freshness.seal = None;
    let code = "DEPENDENCY_SCOPE_UNRESOLVED_IMPORT:subject-a:\u{fdd0}";
    let mut expected = fixture.expected();
    expected.terminal = ExpectedTerminal::ControlledRefusal {
        exit_code: 0,
        reason_codes: BTreeSet::from([code.into()]),
    };
    let receiver = Receiver::new(expected).unwrap();
    let mut batch = fixture.batch();
    batch.terminal = Terminal::Refused;
    batch.subjects[0].outcome = Some(AnalysisOutcome::Unsupported);
    batch.subjects[0].coverage.clear();
    let mut batch = serde_json::to_value(batch).unwrap();
    let units = code.encode_utf16().collect::<Vec<_>>();
    batch["diagnostics"] = serde_json::json!([{
        "subject_id":"subject-a", "code":code, "message":code,
        "code_utf16":units, "message_utf16":units,
    }]);
    assert_eq!(
        receiver
            .receive(&text_outcome(batch.to_string()), &fixture.state())
            .unwrap()
            .disposition(),
        EvidenceDisposition::ControlledRefusal
    );
    for field in ["code_utf16", "message_utf16"] {
        for malformed in [
            serde_json::Value::Null,
            serde_json::json!([65536]),
            serde_json::json!([]),
            serde_json::json!([65]),
        ] {
            let mut altered = batch.clone();
            altered["diagnostics"][0][field] = malformed;
            assert_eq!(
                receiver
                    .receive(&text_outcome(altered.to_string()), &fixture.state())
                    .err(),
                Some(Rejection::MalformedOutput),
                "{field}"
            );
        }
        let mut altered = batch.clone();
        altered["diagnostics"][0]
            .as_object_mut()
            .unwrap()
            .remove(field);
        assert_eq!(
            receiver
                .receive(&text_outcome(altered.to_string()), &fixture.state())
                .err(),
            Some(Rejection::MalformedOutput)
        );
    }
}

#[test]
fn refusal_expectations_distinguish_utf16_codes_with_the_same_display() {
    let mut fixture = Fixture::new();
    fixture.facts.clear();
    fixture.rebind_graph();
    fixture.freshness.seal = None;
    let mut first = "DEPENDENCY_SCOPE_UNRESOLVED_IMPORT:subject-a:"
        .encode_utf16()
        .collect::<Vec<_>>();
    first.push(0xd800);
    let mut second = first.clone();
    *second.last_mut().unwrap() = 0xd801;
    assert_eq!(
        String::from_utf16_lossy(&first),
        String::from_utf16_lossy(&second)
    );
    let mut expected = fixture.expected();
    expected.terminal = ExpectedTerminal::ControlledRefusal {
        exit_code: 0,
        reason_codes: BTreeSet::from([
            ReasonCode::from(first.clone()),
            ReasonCode::from(second.clone()),
        ]),
    };
    let receiver = Receiver::new(expected).unwrap();
    let mut batch = fixture.batch();
    batch.terminal = Terminal::Refused;
    batch.subjects[0].outcome = Some(AnalysisOutcome::Unsupported);
    batch.subjects[0].coverage.clear();
    let mut batch = serde_json::to_value(batch).unwrap();
    batch["diagnostics"] = serde_json::json!([first.clone(),second.clone()].into_iter().map(|units| {
            let display = String::from_utf16_lossy(&units);
            serde_json::json!({"subject_id":"subject-a", "code":display, "message":display, "code_utf16":units, "message_utf16":units})
        }).collect::<Vec<_>>());
    assert_eq!(
        receiver
            .receive(&text_outcome(batch.to_string()), &fixture.state())
            .unwrap()
            .disposition(),
        EvidenceDisposition::ControlledRefusal
    );
    let mut altered = batch.clone();
    *second.last_mut().unwrap() = 0xd802;
    altered["diagnostics"][1]["code_utf16"] = serde_json::json!(second);
    altered["diagnostics"][1]["message_utf16"] = serde_json::json!(second);
    assert_eq!(
        receiver
            .receive(&text_outcome(altered.to_string()), &fixture.state())
            .err(),
        Some(Rejection::RefusalMismatch)
    );
    let mut duplicate = batch;
    duplicate["diagnostics"][1] = duplicate["diagnostics"][0].clone();
    assert_eq!(
        receiver
            .receive(&text_outcome(duplicate.to_string()), &fixture.state())
            .err(),
        Some(Rejection::DuplicateIdentity)
    );
}

#[test]
fn complete_closed_edge_endpoints_and_reordered_subject_reports_are_accepted() {
    let mut f = Fixture::new();
    f.facts.push(Fact::Node {
            id: "other-node".into(),
            subject_id: "subject-b".into(),
            fact_kind: "node:function".into(),
            path: Some("b.ts".into()),
            range: Some(SourceRange {
                start_utf16: 0,
                end_utf16: 1,
                start_line: 1,
                end_line: 1,
            }),
            payload: json!({"id":"other-node","kind":"function","name":"other","filePath":"b.ts","evidence":[{"filePath":"b.ts","startLine":1,"endLine":1,"sourceKind":"code"}],"tags":[],"metadata":{}}),
        });
    f.facts.push(Fact::Edge {
            id: "cross-subject-call".into(),
            subject_id: "subject-a".into(),
            fact_kind: "edge:calls".into(),
            from: "leaf-node".into(),
            to: "other-node".into(),
            path: Some("a.ts".into()),
            range: None,
            payload: json!({"id":"edge:calls:ded75f3e","kind":"calls","from":"leaf-node","to":"other-node","evidence":[{"filePath":"a.ts","startLine":1,"sourceKind":"code"}],"metadata":{}}),
        });
    f.rebind_graph();
    let mut expected = f.expected();
    expected.subjects.push(ExpectedSubject {
        id: SubjectId::new("subject-b").unwrap(),
        selection: Selection::Selected,
        source: Some(SourceExtent {
            path: "b.ts".into(),
            utf16_length: 1,
            line_count: 1,
        }),
        fact_kinds: BTreeSet::from(["node:function".into()]),
        ranged_fact_kinds: BTreeSet::from(["node:function".into()]),
        pathless_fact_kinds: BTreeSet::new(),
        absence_allowed_kinds: BTreeSet::new(),
    });
    let receiver = Receiver::new(expected).unwrap();
    let mut b = f.batch();
    b.subjects.insert(
        0,
        SubjectReport {
            subject_id: "subject-b".into(),
            selection: Selection::Selected,
            outcome: Some(AnalysisOutcome::Analyzed),
            coverage: vec![Coverage {
                fact_kind: "node:function".into(),
                complete: true,
                negative_evidence_eligible: false,
            }],
        },
    );
    let receipt = receiver.receive(&outcome(&b), &f.state()).unwrap();
    assert_eq!(receipt.batch().facts.len(), 3);
    assert_eq!(
        receiver
            .revalidate(&receipt, &f.state())
            .unwrap()
            .scope()
            .as_str(),
        f.state().bindings().unwrap().scope.as_str()
    );
}
#[test]
fn invalid_owned_expectations_fail_before_any_output_is_considered() {
    let f = Fixture::new();
    assert_eq!(
        RequestId::new("").err(),
        Some(Rejection::InvalidExpectation)
    );
    assert_eq!(
        SubjectId::new("").err(),
        Some(Rejection::InvalidExpectation)
    );
    for change in 0..12 {
        let mut e = f.expected();
        match change {
            0 => e.case_id.clear(),
            1 => e.profile.clear(),
            2 => e.max_duration_ms = 0,
            3 => e.output_cap = 0,
            4 => e.subjects.push(e.subjects[0].clone()),
            5 => {
                e.subjects[0].fact_kinds.insert(String::new());
            }
            6 => {
                e.subjects[0].absence_allowed_kinds.insert("foreign".into());
            }
            7 => {
                e.subjects[0].ranged_fact_kinds.insert("foreign".into());
            }
            8 => e.subjects[0].source = None,
            9 => e.subjects[0].source.as_mut().unwrap().line_count = 0,
            10 => e.subjects[0].selection = Selection::Excluded,
            _ => {
                e.terminal = ExpectedTerminal::ControlledRefusal {
                    exit_code: 3,
                    reason_codes: BTreeSet::new(),
                }
            }
        }
        assert_eq!(
            Receiver::new(e).err(),
            Some(Rejection::InvalidExpectation),
            "expectation {change}"
        );
    }
}
#[test]
fn unknown_failed_or_missing_outcomes_never_become_controlled_refusal() {
    let mut f = Fixture::new();
    f.facts.clear();
    f.rebind_graph();
    let mut e = f.expected();
    e.terminal = ExpectedTerminal::ControlledRefusal {
        exit_code: 3,
        reason_codes: BTreeSet::from(["UNSUPPORTED_SOURCE".into()]),
    };
    let receiver = Receiver::new(e).unwrap();
    for invalid in [
        None,
        Some(AnalysisOutcome::Analyzed),
        Some(AnalysisOutcome::Failed),
        Some(AnalysisOutcome::Unknown),
    ] {
        let mut b = f.batch();
        b.terminal = Terminal::Refused;
        b.subjects[0].outcome = invalid;
        b.subjects[0].coverage.clear();
        b.diagnostics.push(Diagnostic {
            subject_id: "subject-a".into(),
            code: "UNSUPPORTED_SOURCE".into(),
            message: "unsupported source".into(),
            code_utf16: None,
            message_utf16: None,
        });
        let mut observed = outcome(&b);
        observed.kind = "nonzero".into();
        observed.exit_code = Some(3);
        assert_eq!(
            receiver.receive(&observed, &f.state()).err(),
            Some(Rejection::UnexpectedOutcome)
        );
    }
}
#[test]
fn complete_mixed_refusal_retains_observations_without_opening_ownership() {
    let mut f = Fixture::new();
    f.facts.push(Fact::Node{id:"unsupported-observation".into(),subject_id:"subject-b".into(),fact_kind:"node:function".into(),path:Some("b.ts".into()),range:None,payload:json!({"id":"unsupported-observation","kind":"function","name":"observed-only","filePath":"b.ts","evidence":[{"filePath":"b.ts","startLine":1,"endLine":1,"sourceKind":"code"}],"tags":[],"metadata":{}})});
    f.rebind_graph();
    let mut expected = f.expected();
    expected.subjects.push(ExpectedSubject {
        id: SubjectId::new("subject-b").unwrap(),
        selection: Selection::Selected,
        source: Some(SourceExtent {
            path: "b.ts".into(),
            utf16_length: 12,
            line_count: 1,
        }),
        fact_kinds: BTreeSet::from(["node:function".into()]),
        ranged_fact_kinds: BTreeSet::new(),
        pathless_fact_kinds: BTreeSet::new(),
        absence_allowed_kinds: BTreeSet::new(),
    });
    expected.terminal = ExpectedTerminal::ControlledRefusal {
        exit_code: 0,
        reason_codes: BTreeSet::from(["SOURCE_DEFAULT_EXPRESSION_UNSUPPORTED".into()]),
    };
    let receiver = Receiver::new(expected).unwrap();
    let mut batch = f.batch();
    batch.terminal = Terminal::Refused;
    batch.subjects.push(SubjectReport {
        subject_id: "subject-b".into(),
        selection: Selection::Selected,
        outcome: Some(AnalysisOutcome::Unsupported),
        coverage: vec![],
    });
    batch.diagnostics.push(Diagnostic {
        subject_id: "subject-b".into(),
        code: "SOURCE_DEFAULT_EXPRESSION_UNSUPPORTED".into(),
        message: "declared unsupported source".into(),
        code_utf16: None,
        message_utf16: None,
    });
    let state = f.state();
    let receipt = receiver.receive(&outcome(&batch), &state).unwrap();
    assert_eq!(
        receiver.revalidate(&receipt, &state).err(),
        Some(Rejection::RefusalHasNoOwnership)
    );
    batch.subjects[1].outcome = Some(AnalysisOutcome::Unknown);
    assert_eq!(
        receiver.receive(&outcome(&batch), &state).err(),
        Some(Rejection::UnexpectedOutcome)
    );
}

#[test]
fn pathless_scope_facts_require_an_explicit_owned_kind_and_never_accept_a_range() {
    let mut f = Fixture::new();
    f.facts.push(Fact::Node{id:"repository-fact".into(),subject_id:"subject-a".into(),fact_kind:"node:repository".into(),path:None,range:None,payload:json!({"id":"repository-fact","kind":"repository","name":"development-repository","evidence":[],"tags":[],"metadata":{}})});
    f.rebind_graph();
    let bindings = f.state().bindings().unwrap();
    f.freshness.seal = Some(FreshnessSeal {
        repository_facts: bindings.facts.clone(),
        indexed_facts: bindings.facts,
        analysis_input: bindings.input.clone(),
        indexed_input: bindings.input,
    });
    let mut expected = f.expected();
    expected.subjects[0]
        .fact_kinds
        .insert("node:repository".into());
    expected.subjects[0]
        .pathless_fact_kinds
        .insert("node:repository".into());
    let receiver = Receiver::new(expected).unwrap();
    let mut batch = f.batch();
    batch.subjects[0].coverage.push(Coverage {
        fact_kind: "node:repository".into(),
        complete: true,
        negative_evidence_eligible: false,
    });
    let state = f.state();
    assert!(receiver.receive(&outcome(&batch), &state).is_ok());
    if let Fact::Node { range, .. } = &mut batch.facts[1] {
        *range = Some(SourceRange {
            start_utf16: 0,
            end_utf16: 1,
            start_line: 1,
            end_line: 1,
        });
    }
    assert_eq!(
        receiver.receive(&outcome(&batch), &state).err(),
        Some(Rejection::InvalidRange)
    );
}
fn projected_fixture() -> Fixture {
    let mut f = Fixture::new();
    f.facts.push(Fact::Edge {id:"edge:transport-sha-distinct".into(),subject_id:"subject-a".into(),fact_kind:"edge:calls".into(),
            from:"leaf-node".into(),to:"leaf-node".into(),path:Some("a.ts".into()),range:None,
            payload:json!({"id":"edge:calls:8ff4a2de","kind":"calls","from":"leaf-node","to":"leaf-node",
                "evidence":[{"filePath":"a.ts","startLine":1,"sourceKind":"code"}],"metadata":{}})});
    f.rebind_graph();
    f
}
#[test]
fn coherent_hashes_cannot_authorize_node_payload_identity_kind_or_path_disagreement() {
    for mutation in 0..6 {
        let mut f = Fixture::new();
        if let Fact::Node { payload, .. } = &mut f.facts[0] {
            match mutation {
                0 => {
                    payload.as_object_mut().unwrap().remove("id");
                }
                1 => payload["id"] = json!("different-node"),
                2 => payload["kind"] = json!("class"),
                3 => {
                    payload.as_object_mut().unwrap().remove("kind");
                }
                4 => payload["filePath"] = json!("other.ts"),
                _ => {
                    payload.as_object_mut().unwrap().remove("filePath");
                }
            }
        }
        f.rebind_graph();
        rejects_batch(&f, &f.batch(), Rejection::InvalidFact);
    }
}
#[test]
fn coherent_hashes_cannot_relabel_edge_payload_relation_or_endpoints_or_legacy_id() {
    for mutation in 0..6 {
        let mut f = projected_fixture();
        if let Fact::Edge { payload, .. } = &mut f.facts[1] {
            match mutation {
                0 => payload["kind"] = json!("related_to"),
                1 => payload["from"] = json!("foreign"),
                2 => payload["to"] = json!("foreign"),
                3 => {
                    payload.as_object_mut().unwrap().remove("id");
                }
                4 => payload["id"] = json!("edge:calls:00000000"),
                _ => {
                    payload.as_object_mut().unwrap().remove("kind");
                }
            }
        }
        f.rebind_graph();
        rejects_batch(&f, &f.batch(), Rejection::InvalidFact);
    }
}
#[test]
fn graph_evidence_lines_are_valid_source_pointers_bound_to_the_envelope() {
    for mutation in 0..14 {
        let mut f = Fixture::new();
        if let Fact::Node { payload, .. } = &mut f.facts[0] {
            match mutation {
                0 => payload["evidence"] = json!([]),
                1 => payload["evidence"][0]["startLine"] = json!(0),
                2 => payload["evidence"][0]["endLine"] = json!(3),
                3 => payload["evidence"][0]["startLine"] = json!("1"),
                4 => {
                    payload["evidence"][0]
                        .as_object_mut()
                        .unwrap()
                        .remove("startLine");
                }
                5 => {
                    payload["evidence"][0]
                        .as_object_mut()
                        .unwrap()
                        .remove("endLine");
                }
                6 => payload["evidence"][0]["filePath"] = json!("foreign.ts"),
                7 => payload["evidence"][0]["sourceKind"] = json!("unknown"),
                8 => {
                    payload["evidence"][0] =
                        json!({"filePath":"a.ts","sourceKind":"code","startLine":2,"endLine":2})
                }
                9 => payload["evidence"] = json!({}),
                10 => payload["evidence"][0]["endLine"] = Value::Null,
                11 => payload["evidence"][0]["startUtf16"] = json!(0),
                12 => payload["evidence"][0]["endUtf16"] = json!(19),
                _ => payload["evidence"][0]["line"] = json!(1),
            }
        }
        f.rebind_graph();
        rejects_batch(&f, &f.batch(), Rejection::InvalidRange);
    }
}
#[test]
fn consumer_graph_is_exactly_the_validated_payload_projection() {
    let mut f = Fixture::new();
    f.graph["nodes"][0]["name"] = json!("different-consumer-graph");
    f.reseal();
    rejects_batch(&f, &f.batch(), Rejection::IdentityMismatch);
}
#[test]
fn canonical_graph_members_are_required_and_legacy_edge_id_differs_from_transport_id() {
    let f = projected_fixture();
    let receiver = Receiver::new(f.expected()).unwrap();
    assert!(receiver.receive(&outcome(&f.batch()), &f.state()).is_ok());
    for (key, value) in [
        ("name", Value::Null),
        ("tags", json!([1])),
        ("metadata", json!({"nested":{}})),
        ("exported", json!("yes")),
    ] {
        let mut f = Fixture::new();
        if let Fact::Node { payload, .. } = &mut f.facts[0] {
            payload[key] = value;
        }
        f.rebind_graph();
        rejects_batch(&f, &f.batch(), Rejection::InvalidFact);
    }
}
