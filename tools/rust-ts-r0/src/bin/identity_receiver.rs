use semctx_gates::process::Outcome;
use semctx_r0_probe::{
    receiver::*,
    wire::{Fact, Selection},
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::BTreeSet,
    fs,
    path::PathBuf,
    time::{Duration, Instant},
};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct State {
    artifact_path: PathBuf,
    input: Value,
    capture: Value,
    snapshot: Value,
    scope: Value,
    facts: Vec<Fact>,
    graph: Value,
    profile: String,
}

impl State {
    fn freshness(&self) -> Result<Freshness, String> {
        let facts = serde_json::to_value(&self.facts).map_err(|error| error.to_string())?;
        let facts = FactsId::observed_json(&facts);
        let input = InputId::observed_json(&self.input);
        Ok(Freshness {
            verdict: FreshnessVerdict::Fresh,
            reasons: vec![],
            seal: Some(FreshnessSeal {
                repository_facts: facts.clone(),
                indexed_facts: facts,
                analysis_input: input.clone(),
                indexed_input: input,
            }),
        })
    }

    fn observed<'a>(&'a self, artifact: &'a [u8], freshness: &'a Freshness) -> ObservedState<'a> {
        ObservedState {
            artifact_bytes: artifact,
            input_manifest: &self.input,
            capture: &self.capture,
            snapshot: &self.snapshot,
            scope: &self.scope,
            facts: &self.facts,
            graph: &self.graph,
            profile: &self.profile,
            freshness,
            binding_valid: true,
            build_complete: true,
            check_changed: false,
            request_current: true,
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Subject {
    id: String,
    path: String,
    utf16_length: u64,
    line_count: u32,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    original: State,
    current: State,
    outcome: Outcome,
    request_id: String,
    subjects: Vec<Subject>,
}

fn kinds(values: &[&str]) -> BTreeSet<String> {
    values.iter().map(|value| (*value).to_owned()).collect()
}

fn observe(input: Value) -> Result<Value, String> {
    let request: Request = serde_json::from_value(input).map_err(|error| error.to_string())?;
    let original_artifact =
        fs::read(&request.original.artifact_path).map_err(|error| error.to_string())?;
    let current_artifact =
        fs::read(&request.current.artifact_path).map_err(|error| error.to_string())?;
    let original_freshness = request.original.freshness()?;
    let current_freshness = request.current.freshness()?;
    let original = request
        .original
        .observed(&original_artifact, &original_freshness);
    let current = request
        .current
        .observed(&current_artifact, &current_freshness);
    let subjects = request
        .subjects
        .into_iter()
        .map(|subject| {
            Ok(ExpectedSubject {
                id: SubjectId::new(subject.id).map_err(|error| format!("{error:?}"))?,
                selection: Selection::Selected,
                source: Some(SourceExtent {
                    path: subject.path,
                    utf16_length: subject.utf16_length,
                    line_count: subject.line_count,
                }),
                fact_kinds: kinds(&[
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
                ]),
                ranged_fact_kinds: kinds(&[
                    "node:function",
                    "node:class",
                    "node:interface",
                    "node:type",
                    "node:enum",
                ]),
                pathless_fact_kinds: kinds(&["node:repository"]),
                absence_allowed_kinds: BTreeSet::new(),
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    let expected = Expected {
        case_id: request.request_id.clone(),
        request: RequestId::new(request.request_id).map_err(|error| format!("{error:?}"))?,
        bindings: original.bindings().map_err(|error| format!("{error:?}"))?,
        profile: request.original.profile.clone(),
        subjects,
        terminal: ExpectedTerminal::Analyzed,
        deadline: Instant::now() + Duration::from_secs(60),
        max_duration_ms: 60_000,
        output_cap: 8_388_608,
    };
    let receiver = Receiver::new(expected).map_err(|error| format!("{error:?}"))?;
    Ok(match receiver.receive(&request.outcome, &current) {
        Ok(receipt) => {
            json!({"accepted":true,"disposition":format!("{:?}",receipt.disposition()),"rejection":null})
        }
        Err(error) => json!({"accepted":false,"disposition":null,"rejection":format!("{error:?}")}),
    })
}

fn main() {
    let result = (|| {
        let path = std::env::args().nth(1).ok_or("missing descriptor")?;
        let bytes = std::fs::read(path).map_err(|error| error.to_string())?;
        let input = serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
        observe(input)
    })();
    match result {
        Ok(value) => println!("{value}"),
        Err(error) => {
            eprintln!("{}", json!({"error":error}));
            std::process::exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_receiver_inputs_cannot_report_acceptance() {
        assert!(observe(json!({})).is_err());
    }

    #[test]
    fn receiver_bridge_accepts_control_and_rejects_changed_current_capture() {
        use semctx_r0_probe::identity::{digest, digest_bytes};
        let artifact = std::env::current_exe().unwrap();
        let bytes = fs::read(&artifact).unwrap();
        let state = json!({"artifact_path":artifact,"input":{},"capture":{},"snapshot":{},"scope":{},
            "facts":[],"graph":{"nodes":[],"edges":[]},"profile":"identity-bridge-control"});
        let stdout = json!({"schema_version":1,"case_id":"bridge","request_id":"bridge",
            "snapshot_id":digest(&json!({})),"scope_id":digest(&json!({})),
            "profile":"identity-bridge-control","producer_artifact_id":digest_bytes(&bytes),
            "input_manifest_id":digest(&json!({})),"capture_id":digest(&json!({})),
            "facts_id":digest(&json!([])),"graph_id":digest(&json!({"nodes":[],"edges":[]})),
            "complete":true,"terminal":"complete","subjects":[],"facts":[],"diagnostics":[],
            "input_observations":[]})
        .to_string();
        let input = json!({"original":state,"current":state,"request_id":"bridge","subjects":[],
            "outcome":{"kind":"success","exit_code":0,"duration_ms":1,"stdout":stdout,"stderr":"",
                "stdout_bytes":stdout.len(),"stderr_bytes":0,"stdout_hash":digest_bytes(stdout.as_bytes()).trim_start_matches("sha256:"),
                "stderr_hash":digest_bytes(b"").trim_start_matches("sha256:")}});
        assert_eq!(
            observe(input.clone()).unwrap(),
            json!({"accepted":true,"disposition":"Analyzed","rejection":null})
        );
        let mut changed = input.clone();
        changed["current"]["capture"] = json!({"changed":true});
        assert_eq!(observe(changed).unwrap()["rejection"], "IdentityMismatch");
        let mut absent = input;
        absent["current"]["artifact_path"] = json!(artifact.join("not-a-file"));
        assert!(observe(absent).is_err());
    }
}
