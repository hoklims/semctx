use semctx_r0_probe::{
    identity,
    receiver::*,
    wire::{self, Fact},
};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    time::{Duration, Instant},
};

pub(super) const FROZEN_CASES: &str =
    include_str!("../fixtures/native-development-flow/cases.json");
pub(super) const KINDS: &[&str] = &[
    "node:repository",
    "node:module",
    "node:test",
    "node:function",
    "node:class",
    "node:interface",
    "node:type",
    "node:enum",
    "node:capability",
    "node:invariant",
    "node:contract",
    "node:risk",
    "node:bounded_context",
    "edge:belongs_to",
    "edge:declares",
    "edge:imports",
    "edge:calls",
    "edge:tested_by",
    "edge:covers",
    "edge:implements_capability",
    "edge:constrained_by",
    "edge:related_to",
];

pub(super) fn strings(values: &[&str]) -> BTreeSet<String> {
    values.iter().map(|value| (*value).into()).collect()
}

pub(super) fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key]
        .as_str()
        .unwrap_or_else(|| panic!("missing {key} in {value}"))
}

pub(super) fn graph_from_received_facts(facts: &[Fact]) -> Value {
    let mut nodes = vec![];
    let mut edges = vec![];
    for fact in facts {
        match fact {
            Fact::Node { payload, .. } => nodes.push(payload.clone()),
            Fact::Edge { payload, .. } => edges.push(payload.clone()),
        }
    }
    json!({"nodes":nodes,"edges":edges})
}

#[derive(Clone)]
pub(super) struct Observed {
    pub(super) artifact: Vec<u8>,
    pub(super) input: Value,
    pub(super) capture: Value,
    pub(super) snapshot: Value,
    pub(super) scope: Value,
    pub(super) facts: Vec<Fact>,
    pub(super) graph: Value,
    pub(super) freshness: Freshness,
    pub(super) profile: String,
}
impl Observed {
    pub(super) fn current(&self) -> ObservedState<'_> {
        ObservedState {
            artifact_bytes: &self.artifact,
            input_manifest: &self.input,
            capture: &self.capture,
            facts: &self.facts,
            graph: &self.graph,
            snapshot: &self.snapshot,
            scope: &self.scope,
            profile: &self.profile,
            freshness: &self.freshness,
            binding_valid: true,
            build_complete: true,
            check_changed: false,
            request_current: true,
        }
    }
}

pub(super) fn bindings_and_observation(
    request: &Value,
    sdk: &Value,
    batch: &wire::Batch,
    artifact: Vec<u8>,
) -> Observed {
    let fixture: Value = serde_json::from_str(FROZEN_CASES).unwrap();
    let case = fixture["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|case| case["id"] == request["id"])
        .unwrap();
    bindings_and_observation_for_case(case, request, sdk, batch, artifact)
}

pub(super) fn bindings_and_observation_for_case(
    case: &Value,
    request: &Value,
    sdk: &Value,
    batch: &wire::Batch,
    artifact: Vec<u8>,
) -> Observed {
    let profile = if request["qualified"] == true {
        "modelo-suite-static-v1"
    } else {
        "ordinary"
    }
    .to_string();
    assert_eq!(request["utf16_files"], json!({}));
    assert_eq!(request["raw_files"], json!({}));
    let fixture_files = case["files"].as_object().unwrap();
    assert_eq!(
        request["files"].as_object().unwrap().len(),
        fixture_files.len()
    );
    let sensitive = request["case_sensitive"].as_bool().unwrap();
    let mut project = fixture_files.keys().map(|relative| {
        assert!(!relative.split('/').any(|part| part.is_empty() || part == "." || part == ".."));
        let physical = format!("{}/{}", text(request,"cwd"),relative);
        let source = request["files"][&physical].as_str().expect("known DEV source path absent");
        let logical = if sensitive { relative.clone() } else { relative.to_lowercase() };
        json!({"location":{"domain":"repository","path":logical},"representation":"text","text":source})
    }).collect::<Vec<_>>();
    project.sort_by_key(identity::canonical_json);
    let sdk_prefix = format!("{}/", text(request, "sdk_directory"));
    let mut libraries = sdk["files"]
        .as_object()
        .unwrap()
        .iter()
        .map(|(physical, content)| {
            let basename = physical
                .strip_prefix(&sdk_prefix)
                .expect("DEV SDK file outside selected SDK directory");
            assert!(!basename.contains('/') && !basename.contains('\\'));
            let logical = if sensitive {
                basename.to_string()
            } else {
                basename.to_lowercase()
            };
            json!({"location":{"domain":"sdk","path":logical},"text":content})
        })
        .collect::<Vec<_>>();
    libraries.sort_by_key(identity::canonical_json);
    let input = json!({"domain":"T00-logical-input-v3","project":project,
        "sdk":{"domain":"T00-logical-sdk-v3","version":sdk["version"],"source_revision":sdk["source_revision"],"library_manifest_sha256":sdk["library_manifest_sha256"],"files":libraries}});
    let capture = json!({"domain":"T00-logical-capture-v2","repository_root":"T00_REPOSITORY_ROOT","case_sensitive":sensitive,"project":project});
    let subjects = case["expected_subject_ids"]
        .as_array()
        .unwrap()
        .iter()
        .map(|subject| {
            (
                subject.as_str().unwrap().to_string(),
                json!({"role":"source","selection":"selected"}),
            )
        })
        .collect::<BTreeMap<_, _>>();
    let scope = json!({"profile":profile,"repository_root":request["cwd"],"subjects":subjects,
        "effective_options":request["options"],"retained":request["retained"],"sdk_directory":request["sdk_directory"]});
    let snapshot = json!({"domain":"T00-captured-snapshot-v2","input_manifest_id":identity::digest(&input),"capture_id":identity::digest(&capture)});
    let facts = batch.facts.clone();
    let graph = graph_from_received_facts(&facts);
    let fact_id = FactsId::observed_json(&serde_json::to_value(&facts).unwrap());
    let input_id = InputId::observed_json(&input);
    Observed {
        artifact,
        input,
        capture,
        snapshot,
        scope,
        facts,
        graph,
        profile,
        freshness: Freshness {
            verdict: FreshnessVerdict::Fresh,
            reasons: vec![],
            seal: Some(FreshnessSeal {
                repository_facts: fact_id.clone(),
                indexed_facts: fact_id,
                analysis_input: input_id.clone(),
                indexed_input: input_id,
            }),
        },
    }
}

pub(super) fn expected(case: &Value, observed: &Observed, deadline: Instant) -> Expected {
    let subjects = case["source_bytes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|source| ExpectedSubject {
            id: SubjectId::new(text(source, "path")).unwrap(),
            selection: wire::Selection::Selected,
            source: Some(SourceExtent {
                path: text(source, "path").into(),
                utf16_length: source["utf16_length"].as_u64().unwrap(),
                line_count: u32::try_from(source["line_count"].as_u64().unwrap()).unwrap(),
            }),
            fact_kinds: strings(KINDS),
            ranged_fact_kinds: strings(&[
                "node:function",
                "node:class",
                "node:interface",
                "node:type",
                "node:enum",
            ]),
            pathless_fact_kinds: strings(&["node:repository"]),
            absence_allowed_kinds: BTreeSet::new(),
        })
        .collect();
    let reason_codes = case["expected_reason_codes"].as_array().unwrap();
    let terminal = if !reason_codes.is_empty() {
        ExpectedTerminal::ControlledRefusal {
            exit_code: 0,
            reason_codes: reason_codes
                .iter()
                .map(|s| wire::ReasonCode::from(s.as_str().unwrap()))
                .collect(),
        }
    } else {
        ExpectedTerminal::Analyzed
    };
    Expected {
        case_id: text(case, "id").into(),
        request: RequestId::new(text(case, "id")).unwrap(),
        bindings: observed.current().bindings().unwrap(),
        profile: observed.profile.clone(),
        subjects,
        terminal,
        deadline,
        max_duration_ms: 20_000,
        output_cap: 8_388_608,
    }
}

pub(super) fn ready_receiver(case: &Value, observed: &Observed, budget: Duration) -> Receiver {
    let mut policy = expected(case, observed, Instant::now());
    policy.deadline = Instant::now() + budget;
    Receiver::new(policy).unwrap()
}
