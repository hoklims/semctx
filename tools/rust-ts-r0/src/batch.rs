use super::*;
use serde_json::{Value, json};

pub fn profile(request: &Request) -> &'static str {
    if request.qualified {
        "modelo-suite-static-v1"
    } else {
        "ordinary"
    }
}

pub fn input_manifest(request: &Request, sdk: &Sdk) -> Result<Value, String> {
    input_identity::input(request, sdk)
}

pub fn capture_manifest(request: &Request) -> Result<Value, String> {
    input_identity::capture(request)
}

pub fn scope_manifest(request: &Request) -> Result<Value, String> {
    let mut subjects = BTreeMap::new();
    for path in &request.roots {
        if [".d.ts", ".d.mts", ".d.cts"]
            .iter()
            .any(|suffix| path.ends_with(suffix))
        {
            continue;
        }
        let relative = relative_source_path(&request.cwd, path, request.case_sensitive)?;
        subjects.insert(relative.clone(),json!({"role":request.roles.get(&relative).map(String::as_str).unwrap_or("source"),"selection":request.selection.get(&relative).copied().unwrap_or(wire::Selection::Selected)}));
    }
    let mut scope = json!({"profile":profile(request),"repository_root":request.cwd,"sdk_directory":request.sdk_directory,"retained":request.retained,"effective_options":request.options,"subjects":subjects});
    if !request.disabled.is_empty() {
        scope["disabled"] = json!(request.disabled);
    }
    Ok(scope)
}

pub fn snapshot_manifest(request: &Request, sdk: &Sdk) -> Result<Value, String> {
    Ok(
        json!({"domain":"T00-captured-snapshot-v2","input_manifest_id":identity::digest(&input_manifest(request,sdk)?),"capture_id":identity::digest(&capture_manifest(request)?)}),
    )
}

pub fn graph_from_facts(facts: &[wire::Fact]) -> Value {
    let nodes = facts
        .iter()
        .filter_map(|fact| {
            if let wire::Fact::Node { payload, .. } = fact {
                Some(payload.clone())
            } else {
                None
            }
        })
        .collect::<Vec<_>>();
    let edges = facts
        .iter()
        .filter_map(|fact| {
            if let wire::Fact::Edge { payload, .. } = fact {
                Some(payload.clone())
            } else {
                None
            }
        })
        .collect::<Vec<_>>();
    json!({"nodes":nodes,"edges":edges})
}

fn text<'a>(value: &'a Value, key: &str) -> Result<&'a str, String> {
    value[key]
        .as_str()
        .ok_or_else(|| format!("missing observation string:{key}"))
}

fn node_range(symbol: &Value) -> Result<Option<wire::SourceRange>, String> {
    let Some(declarations) = symbol["declarations"].as_array() else {
        return Ok(None);
    };
    if declarations.is_empty() {
        return Err("empty native declaration ranges".into());
    }
    let number = |key: &str, minimum: bool| -> Result<u64, String> {
        let values = declarations
            .iter()
            .map(|declaration| {
                declaration[key]
                    .as_u64()
                    .ok_or_else(|| format!("missing native range:{key}"))
            })
            .collect::<Result<Vec<_>, _>>()?;
        Ok(if minimum {
            *values.iter().min().unwrap()
        } else {
            *values.iter().max().unwrap()
        })
    };
    Ok(Some(wire::SourceRange {
        start_utf16: number("startUtf16", true)?,
        end_utf16: number("endUtf16", false)?,
        start_line: u32::try_from(number("startLine", true)?).map_err(|_| "line overflow")?,
        end_line: u32::try_from(number("endLine", false)?).map_err(|_| "line overflow")?,
    }))
}

pub fn build(request: &Request, sdk: &Sdk, observed: &Value) -> Result<wire::Batch, String> {
    let reports = observed["subjects"]
        .as_array()
        .ok_or("missing subject observations")?;
    let mut subjects = vec![];
    let mut diagnostics = vec![];
    let mut outcomes = BTreeMap::new();
    let kinds = [
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
    for report in reports {
        let subject_id = text(report, "path")?.to_string();
        let selection: wire::Selection = serde_json::from_value(report["selection"].clone())
            .map_err(|error| error.to_string())?;
        let outcome = if selection == wire::Selection::Excluded {
            None
        } else {
            Some(
                serde_json::from_value::<wire::AnalysisOutcome>(report["outcome"].clone())
                    .map_err(|error| error.to_string())?,
            )
        };
        let analyzed = outcome == Some(wire::AnalysisOutcome::Analyzed);
        let coverage = if analyzed {
            kinds
                .iter()
                .map(|kind| wire::Coverage {
                    fact_kind: (*kind).into(),
                    complete: true,
                    negative_evidence_eligible: request.qualified && request.retained,
                })
                .collect()
        } else {
            vec![]
        };
        for key in ["reasons", "unimplemented"] {
            for reason in report[key].as_array().ok_or("missing reason inventory")? {
                let code = reason
                    .as_str()
                    .ok_or("invalid reason observation")?
                    .to_string();
                diagnostics.push(wire::Diagnostic {
                    subject_id: subject_id.clone(),
                    message: code.clone(),
                    code,
                });
            }
        }
        outcomes.insert(subject_id.clone(), outcome);
        subjects.push(wire::SubjectReport {
            subject_id,
            selection,
            outcome,
            coverage,
        });
    }
    diagnostics.sort_by(|a, b| {
        a.subject_id
            .encode_utf16()
            .cmp(b.subject_id.encode_utf16())
            .then_with(|| a.code.encode_utf16().cmp(b.code.encode_utf16()))
    });
    diagnostics.dedup_by(|a, b| a.subject_id == b.subject_id && a.code == b.code);
    let primary = subjects
        .iter()
        .find(|subject| {
            subject.selection == wire::Selection::Selected
                && subject.outcome != Some(wire::AnalysisOutcome::Disabled)
        })
        .map(|subject| subject.subject_id.clone());
    let symbols = observed["assembly"]["symbols"]
        .as_array()
        .ok_or("missing logical symbols")?;
    let mut facts = vec![];
    for node in observed["assembly"]["nodes"]
        .as_array()
        .ok_or("missing graph nodes")?
    {
        let id = text(node, "id")?.to_string();
        let kind = text(node, "kind")?;
        let owner = node["filePath"]
            .as_str()
            .or_else(|| {
                node["evidence"]
                    .as_array()
                    .and_then(|evidence| evidence.first())
                    .and_then(|evidence| evidence["filePath"].as_str())
            })
            .map(str::to_string)
            .or_else(|| primary.clone());
        let Some(subject_id) = owner else {
            continue;
        };
        if !outcomes.contains_key(&subject_id) {
            return Err("graph owner missing from request scope".into());
        }
        if outcomes[&subject_id].is_none()
            || outcomes[&subject_id] == Some(wire::AnalysisOutcome::Disabled)
        {
            continue;
        }
        let range = if let Some(symbol) = symbols.iter().find(|symbol| symbol["id"] == id) {
            node_range(symbol)?
        } else {
            None
        };
        let path = if kind == "repository" {
            None
        } else {
            Some(subject_id.clone())
        };
        facts.push(wire::Fact::Node {
            id,
            subject_id,
            fact_kind: format!("node:{kind}"),
            path,
            range,
            payload: node.clone(),
        });
    }
    for edge in observed["assembly"]["edges"]
        .as_array()
        .ok_or("missing graph edges")?
    {
        let from = text(edge, "from")?.to_string();
        let to = text(edge, "to")?.to_string();
        let kind = text(edge, "kind")?;
        let owner = edge["evidence"]
            .as_array()
            .and_then(|refs| refs.first())
            .and_then(|evidence| evidence["filePath"].as_str())
            .map(str::to_string)
            .or_else(|| primary.clone());
        let Some(subject_id) = owner else {
            continue;
        };
        if !outcomes.contains_key(&subject_id) {
            return Err("edge owner missing from request scope".into());
        }
        if outcomes[&subject_id].is_none()
            || outcomes[&subject_id] == Some(wire::AnalysisOutcome::Disabled)
        {
            continue;
        }
        let id = format!(
            "edge:{}",
            identity::digest(&json!([kind, from, to])).trim_start_matches("sha256:")
        );
        facts.push(wire::Fact::Edge {
            id,
            subject_id: subject_id.clone(),
            fact_kind: format!("edge:{kind}"),
            from,
            to,
            path: Some(subject_id),
            range: None,
            payload: edge.clone(),
        });
    }
    let facts_id =
        identity::digest(&serde_json::to_value(&facts).map_err(|error| error.to_string())?);
    let graph_id = identity::digest(&graph_from_facts(&facts));
    let mut probes = BTreeMap::new();
    let mut inventories = vec![
        observed["capture_probes"]
            .as_array()
            .ok_or("missing input observations")?,
    ];
    for report in reports {
        if let Some(probes) = report["semanticContextProbes"].as_array() {
            inventories.push(probes);
        }
    }
    for inventory in inventories {
        for probe in inventory {
            let operation = text(probe, "operation")?.to_string();
            let path = text(probe, "path")?.to_string();
            let found = probe["found"]
                .as_bool()
                .ok_or("invalid input observation")?;
            let content_id = probe["content_id"].as_str().map(str::to_string);
            if operation == "read_file" && found != content_id.is_some() {
                return Err("unbound input read".into());
            }
            let key = (operation.clone(), path.clone(), found, content_id.clone());
            probes.insert(
                key,
                wire::InputObservation {
                    context: "captured-filesystem".into(),
                    operation,
                    path,
                    found,
                    content_id,
                },
            );
        }
    }
    let input_observations = probes.into_values().collect();
    let terminal = if subjects.iter().any(|subject| {
        subject.selection == wire::Selection::Selected
            && subject.outcome != Some(wire::AnalysisOutcome::Analyzed)
    }) {
        wire::Terminal::Refused
    } else {
        wire::Terminal::Complete
    };
    Ok(wire::Batch {
        schema_version: 1,
        case_id: request.id.clone(),
        request_id: request.id.clone(),
        snapshot_id: identity::digest(&snapshot_manifest(request, sdk)?),
        scope_id: identity::digest(&scope_manifest(request)?),
        profile: profile(request).into(),
        producer_artifact_id: text(observed, "producer_artifact_id")?.into(),
        input_manifest_id: identity::digest(&input_manifest(request, sdk)?),
        capture_id: identity::digest(&capture_manifest(request)?),
        facts_id,
        graph_id,
        complete: observed["complete"] == true,
        terminal,
        subjects,
        facts,
        diagnostics,
        input_observations,
        producer_claimed_ownership: None,
    })
}
