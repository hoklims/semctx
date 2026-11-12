//! Consumer rules ported from exact baseline 3e94997, not native producer policy.
//! Provenance and SHA-256s: baseline-contracts/manifest.json. No frozen expected
//! output is accepted by these functions. Inputs are admitted actual observations.
use super::*;

fn array<'a>(v: &'a Value, key: &str) -> Result<&'a Vec<Value>, String> {
    v[key]
        .as_array()
        .ok_or_else(|| format!("admission input array absent: {key}"))
}
fn strings(v: &Value, key: &str) -> Result<Vec<String>, String> {
    array(v, key)?
        .iter()
        .map(|v| {
            v.as_str()
                .map(str::to_owned)
                .ok_or_else(|| format!("non-string admission input: {key}"))
        })
        .collect()
}
fn text<'a>(v: &'a Value, key: &str) -> Result<&'a str, String> {
    v[key]
        .as_str()
        .ok_or_else(|| format!("admission input string absent: {key}"))
}
fn boolean(v: &Value, key: &str) -> Result<bool, String> {
    v[key]
        .as_bool()
        .ok_or_else(|| format!("admission input boolean absent: {key}"))
}
fn source(path: &str) -> bool {
    [
        "ts", "tsx", "mts", "mtsx", "cts", "ctsx", "js", "jsx", "mjs", "mjsx", "cjs", "cjsx",
    ]
    .contains(&path.rsplit('.').next().unwrap_or(""))
}
fn ordered_unique(values: Vec<String>) -> Vec<String> {
    let mut seen = BTreeSet::new();
    values
        .into_iter()
        .filter(|v| seen.insert(v.clone()))
        .collect()
}

// baseline packages/context-engine/src/analysis-admission.ts, exact branch order.
pub(super) fn evaluate_admission(input: &Value) -> Result<Value, String> {
    let changed = strings(input, "changedPaths")?;
    let mut expected: BTreeSet<String> = changed.iter().cloned().collect();
    loop {
        let before = expected.len();
        for pair in array(input, "links")? {
            let pair = pair
                .as_array()
                .filter(|p| p.len() == 2)
                .ok_or("invalid actual dependency link")?;
            let from = pair[0].as_str().ok_or("invalid importer")?;
            let to = pair[1].as_str().ok_or("invalid dependency")?;
            if expected.contains(from) || expected.contains(to) {
                expected.insert(from.into());
                expected.insert(to.into());
            }
        }
        if before == expected.len() {
            break;
        }
    }
    let candidates = array(input, "candidates")?;
    let current = array(input, "current")?;
    let file = |path: &str| -> Result<Value, String> {
        let candidate = candidates.iter().find(|v| v["path"] == path);
        let selected = current.iter().find(|v| v["path"] == path);
        if candidate.is_some_and(|v| v["selectionDecision"] == "excluded")
            || selected.is_some_and(|v| v["selectionDecision"] == "excluded")
        {
            let mut reasons = match candidate {
                Some(v) => strings(v, "selectionReasons")?,
                None => vec![],
            };
            if let Some(selected) = selected {
                reasons.push(text(selected, "reason")?.into());
            }
            return Ok(json!({"path":path,"status":"excluded","reasons":reasons}));
        }
        let (Some(candidate), Some(_)) = (candidate, selected) else {
            return Ok(
                json!({"path":path,"status":"missing","reasons":["NO_CURRENT_ANALYZED_SOURCE"]}),
            );
        };
        let analysis_reasons = strings(candidate, "analysisReasons")?;
        if candidate["analysisOutcome"] != "analyzed" {
            let outcome = text(candidate, "analysisOutcome")?;
            let mut reasons = analysis_reasons;
            reasons.extend(strings(candidate, "selectionReasons")?);
            reasons.push(format!("ANALYSIS_OUTCOME:{outcome}"));
            return Ok(
                json!({"path":path,"status":if outcome=="failed"{"failed"}else{"unsupported"},"reasons":reasons}),
            );
        }
        if !analysis_reasons.is_empty() {
            let unsupported = analysis_reasons.iter().any(|v| {
                ["UNSUPPORTED", "UNRESOLVED", "SOURCE_CONFIGURATION"]
                    .iter()
                    .any(|s| v.contains(s))
            });
            return Ok(
                json!({"path":path,"status":if unsupported{"unsupported"}else{"failed"},"reasons":analysis_reasons}),
            );
        }
        if !boolean(candidate, "admissible")? {
            return Ok(
                json!({"path":path,"status":"failed","reasons":["LOAD_BEARING_EVALUATION_NOT_ADMITTED"]}),
            );
        }
        if !source(path) {
            return Ok(
                json!({"path":path,"status":"unsupported","reasons":["OUTSIDE_BOUNDED_ESM_TYPESCRIPT_PROFILE"]}),
            );
        }
        Ok(json!({"path":path,"status":"analyzed","reasons":[]}))
    };
    let files = expected
        .iter()
        .map(|p| file(p))
        .collect::<Result<Vec<_>, _>>()?;
    let analyzed = files
        .iter()
        .filter(|v| v["status"] == "analyzed")
        .map(|v| v["path"].clone())
        .collect::<Vec<_>>();
    let mut reasons = strings(input, "bindingReasons")?;
    reasons.extend(strings(input, "scopeReasons")?);
    if !boolean(input, "buildComplete")? {
        reasons.push("INDEX_BUILD_INCOMPLETE".into());
    }
    if text(input, "bindingStatus")? != "valid" {
        reasons.push("INDEX_BINDING_INVALID".into());
    }
    if !boolean(input, "canRunHighRiskControl")? {
        reasons.extend(strings(input, "freshnessReasons")?);
        reasons.push("INDEX_NOT_FRESH".into());
    }
    if boolean(input, "checkChanged")? {
        reasons.push("CHECK_INPUT_CHANGED".into());
    }
    if files.is_empty() || analyzed.is_empty() {
        reasons.push("ZERO_ANALYZED_OBLIGATIONS".into());
    }
    for v in &files {
        if v["status"] != "analyzed" {
            reasons.push(format!(
                "ANALYSIS_SCOPE_INCOMPLETE:{}:{}",
                text(v, "path")?,
                text(v, "status")?
            ));
        }
    }
    for v in array(input, "unresolvedImports")? {
        let path = text(v, "path")?;
        if expected.contains(path) {
            reasons.push(format!(
                "UNRESOLVED_IMPORT:{path}:{}",
                text(v, "specifier")?
            ));
        }
    }
    for path in &changed {
        if !source(path) && !path.ends_with(".py") && !path.ends_with(".sql") {
            reasons.push(format!("UNSUPPORTED_CHANGED_OBLIGATION:{path}"));
        }
    }
    let repository = candidates
        .iter()
        .map(|v| file(text(v, "path")?))
        .collect::<Result<Vec<_>, String>>()?;
    Ok(
        json!({"status":if reasons.is_empty(){"admitted"}else{"rejected"},"changeCoverage":{"expected":expected,"analyzed":analyzed,"files":files},
        "repositoryCoverage":{"status":input["repositoryCoverageStatus"],"files":repository},"reasons":ordered_unique(reasons)}),
    )
}

// baseline packages/control-model/src/freshness.ts:43-83. Seal values come from
// index-store readback + current actual Git/capture/graph observations.
pub(super) fn classify_freshness(seal: &Value) -> Result<Value, String> {
    let keys = [
        "repositoryRoot",
        "indexedRepositoryRoot",
        "headAtCapture",
        "indexedHeadCommit",
        "repositoryGraphHash",
        "indexedRepositoryGraphHash",
        "semanticModelHash",
        "indexedSemanticModelHash",
        "analysisInputHash",
        "indexedAnalysisInputHash",
        "workingDiffHash",
        "indexedWorkingDiffHash",
        "storeSchemaVersion",
        "indexedStoreSchemaVersion",
        "toolVersion",
        "indexedToolVersion",
        "indexedAt",
    ];
    if keys.iter().any(|k| seal.get(k).is_none()) {
        return Err("freshness seal field absent (not explicit null)".into());
    }
    if [
        "indexedRepositoryRoot",
        "indexedRepositoryGraphHash",
        "indexedSemanticModelHash",
        "indexedAnalysisInputHash",
        "indexedAt",
        "indexedToolVersion",
    ]
    .iter()
    .any(|k| seal[*k].is_null())
    {
        return Ok(json!({"verdict":"UNSEALED","reasons":["INDEX_SNAPSHOT_MISSING"]}));
    }
    let mut reasons = vec![];
    if [
        "headAtCapture",
        "indexedHeadCommit",
        "workingDiffHash",
        "indexedWorkingDiffHash",
    ]
    .iter()
    .any(|k| seal[*k].is_null())
    {
        reasons.push("GIT_STATE_UNAVAILABLE");
    }
    if seal["storeSchemaVersion"].is_null() || seal["indexedStoreSchemaVersion"].is_null() {
        reasons.push("STORE_SCHEMA_UNAVAILABLE");
    }
    if !reasons.is_empty() {
        return Ok(json!({"verdict":"UNSEALED","reasons":reasons}));
    }
    for (current, indexed, reason) in [
        (
            "repositoryRoot",
            "indexedRepositoryRoot",
            "REPOSITORY_ROOT_MISMATCH",
        ),
        ("headAtCapture", "indexedHeadCommit", "HEAD_MISMATCH"),
        (
            "repositoryGraphHash",
            "indexedRepositoryGraphHash",
            "REPOSITORY_GRAPH_MISMATCH",
        ),
        (
            "semanticModelHash",
            "indexedSemanticModelHash",
            "SEMANTIC_MODEL_MISMATCH",
        ),
        (
            "analysisInputHash",
            "indexedAnalysisInputHash",
            "ANALYSIS_INPUT_MISMATCH",
        ),
        (
            "workingDiffHash",
            "indexedWorkingDiffHash",
            "WORKING_DIFF_MISMATCH",
        ),
        (
            "storeSchemaVersion",
            "indexedStoreSchemaVersion",
            "STORE_SCHEMA_MISMATCH",
        ),
        ("toolVersion", "indexedToolVersion", "TOOL_VERSION_MISMATCH"),
    ] {
        if seal[current] != seal[indexed] {
            reasons.push(reason);
        }
    }
    if !reasons.is_empty() {
        return Ok(json!({"verdict":"STALE","reasons":reasons}));
    }
    let clean = seal["workingDiffHash"]
        == "sha256:21dba70935f8f14f59199087ee440e16bec5dc567d8449b2cedf0c59c592abb1";
    Ok(if clean {
        json!({"verdict":"FRESH","reasons":[]})
    } else {
        json!({"verdict":"DIRTY_KNOWN","reasons":["WORKING_TREE_DIRTY"]})
    })
}

// baseline plane-a-runtime.ts TypeScript path: parse/config failures are persisted
// producer outcomes, not transport failures; negative evidence remains structural.
pub(super) fn candidate_rows(
    discovery: &Value,
    qualified: &Value,
    load_gates: &Value,
) -> Result<Vec<Value>, String> {
    let mut result = vec![];
    for candidate in array(discovery, "candidates")? {
        let path = text(candidate, "relPath")?;
        let selected = candidate["selectionDecision"] == "selected";
        let language = text(candidate, "language")?;
        let reason = text(candidate, "reason")?;
        let selection_reasons = if reason == "SELECTED" {
            vec![]
        } else {
            vec![reason.to_string()]
        };
        let mut outcome = candidate["analysisOutcome"]
            .as_str()
            .unwrap_or(if selected {
                "analyzed"
            } else {
                "not_applicable"
            })
            .to_string();
        let mut analysis_reasons = if outcome == "analyzed" {
            vec![]
        } else {
            selection_reasons.clone()
        };
        if selected && !["disabled", "unsupported", "failed"].contains(&outcome.as_str()) {
            if language != "typescript" {
                return Err(
                    "T00 consumer is bounded to actual TypeScript selected producers".into(),
                );
            }
            let subject = array(qualified, "subjects")?
                .iter()
                .find(|s| s["path"] == path)
                .ok_or("selected native subject absent")?;
            let parsing = &subject["sourceParsingObservation"];
            let configuration =
                &subject["moduleConfigurationObservations"]["retainedWithoutSource"];
            if parsing["executed"] != true
                || configuration["executed"] != true
                || parsing["unsupported"] != json!([])
                || configuration["unsupported"] != json!([])
            {
                return Err("selected actual parsing/config component incomplete".into());
            }
            let mut native_reasons = strings(parsing, "reasons")?;
            native_reasons.extend(strings(configuration, "reasons")?);
            if !native_reasons.is_empty() {
                outcome = "failed".into();
                analysis_reasons = vec!["PRODUCER_FAILED".into()];
                analysis_reasons.extend(native_reasons);
            } else {
                let integrity = &qualified["assembly"]["integrityReasons"][path];
                if integrity.is_array() {
                    analysis_reasons = strings(&qualified["assembly"]["integrityReasons"], path)?;
                }
            }
        }
        let gates = load_gates
            .get(path)
            .and_then(Value::as_bool)
            .ok_or("actual load-bearing gate receipt missing")?;
        result.push(json!({"candidateIdentity":format!("{language}:{path}"),"path":path,"selectionDecision":candidate["selectionDecision"],
            "analysisOutcome":outcome,"selectionReasons":selection_reasons,"analysisReasons":analysis_reasons,"admissible":gates,
            "negativeEvidenceEligible":false}));
    }
    result.sort_by(|a, b| {
        a["candidateIdentity"]
            .as_str()
            .cmp(&b["candidateIdentity"].as_str())
    });
    Ok(result)
}

pub(super) fn coverage_status(
    candidates: &[Value],
    binding_valid: bool,
    fresh: bool,
    workspace_unambiguous: bool,
) -> Result<&'static str, String> {
    if !binding_valid || !fresh || !workspace_unambiguous {
        return Ok("insufficient");
    }
    let selected = candidates
        .iter()
        .filter(|c| c["selectionDecision"] == "selected")
        .collect::<Vec<_>>();
    if selected
        .iter()
        .any(|c| c["analysisOutcome"] != "analyzed" || c["admissible"] != true)
    {
        return Ok("insufficient");
    }
    for c in selected {
        if c["negativeEvidenceEligible"] != true || !strings(c, "analysisReasons")?.is_empty() {
            return Ok("partial");
        }
    }
    Ok("complete")
}

// Baseline health preflight: negative completeness creates a warning, while an
// actual load-bearing/analysis failure creates a block. Admission is separate.
pub(super) fn health_preflight(
    changed: &[String],
    candidates: &[Value],
    current: &[Value],
    binding_valid: bool,
    fresh: bool,
) -> Result<Vec<Value>, String> {
    let mut blocking = vec![];
    let mut partial = vec![];
    for path in changed {
        let persisted = candidates.iter().find(|c| c["path"] == *path);
        let now = current.iter().find(|c| c["path"] == *path);
        if !persisted.is_some_and(|c| c["selectionDecision"] == "selected")
            && !now.is_some_and(|c| c["selectionDecision"] == "selected")
        {
            continue;
        }
        match persisted {
            Some(c)
                if binding_valid
                    && fresh
                    && c["analysisOutcome"] == "analyzed"
                    && c["admissible"] == true =>
            {
                if c["negativeEvidenceEligible"] != true
                    || !strings(c, "analysisReasons")?.is_empty()
                {
                    partial.push(path.clone());
                }
            }
            _ => blocking.push(path.clone()),
        }
    }
    let mut result = vec![];
    if !blocking.is_empty() {
        result
            .push(json!({"rule":"analysis_scope_incomplete","severity":"block","paths":blocking}));
    }
    if !partial.is_empty() {
        result.push(json!({"rule":"analysis_scope_incomplete","severity":"warn","paths":partial}));
    }
    Ok(result)
}

// All five default rule conditions use the baseline ruleFlags/isTested definitions.
// impacted nodes must be selected by real parsed Git hunks and actual native ranges.
pub(super) fn configured_findings(
    graph: &Value,
    impacted_ids: &BTreeSet<String>,
    rules: &[Value],
) -> Result<Vec<Value>, String> {
    let nodes = array(graph, "nodes")?;
    let edges = array(graph, "edges")?;
    let mut conditions: BTreeMap<&str, Vec<String>> = BTreeMap::new();
    for n in nodes
        .iter()
        .filter(|n| n["id"].as_str().is_some_and(|id| impacted_ids.contains(id)))
    {
        let id = text(n, "id")?;
        let kind = text(n, "kind")?;
        let tags = strings(n, "tags")?;
        let outgoing = edges.iter().filter(|e| e["from"] == id).collect::<Vec<_>>();
        let tested = outgoing.iter().any(|e| e["kind"] == "tested_by");
        let contract = ["interface", "type"].contains(&kind) && n["exported"] == true;
        let critical = contract
            && tags
                .iter()
                .any(|v| ["critical", "security"].contains(&v.as_str()));
        let security = tags.iter().any(|v| v == "security")
            || outgoing.iter().any(|e| {
                e["kind"] == "related_to"
                    && nodes
                        .iter()
                        .find(|n| n["id"] == e["to"])
                        .is_some_and(|target| {
                            target["tags"]
                                .as_array()
                                .is_some_and(|tags| tags.contains(&json!("security")))
                        })
            });
        for (condition, active) in [
            (
                "invariant_touched_without_test",
                outgoing.iter().any(|e| e["kind"] == "constrained_by") && !tested,
            ),
            (
                "critical_contract_changed_without_test",
                critical && !tested,
            ),
            (
                "contract_changed_without_test",
                contract && !critical && !tested,
            ),
            ("security_surface_without_verification", security && !tested),
        ] {
            if active {
                conditions.entry(condition).or_default().push(id.into());
            }
        }
    }
    // Public T00 inputs have no authored contradicted/deprecated claims. Reject
    // such a claim model instead of inferring claim provenance from graph names.
    if nodes.iter().any(|n| {
        n["verificationStatus"] == "deprecated"
            || n["verificationStatus"] == "contradicted"
            || ["document", "invariant", "contract", "decision", "risk"]
                .contains(&n["kind"].as_str().unwrap_or(""))
    }) {
        return Err(
            "T00 contradicted claim provenance requires a separate actual claim receipt".into(),
        );
    }
    let mut result = vec![];
    for rule in rules {
        let condition = text(rule, "when")?;
        if ![
            "invariant_touched_without_test",
            "critical_contract_changed_without_test",
            "contract_changed_without_test",
            "security_surface_without_verification",
            "contradiction_unresolved",
        ]
        .contains(&condition)
        {
            return Err("rule condition outside baseline T00 configured surfaces".into());
        }
        if !["warn", "block"].contains(&text(rule, "severity")?) {
            return Err("unknown configured rule severity".into());
        }
        if let Some(ids) = conditions.get(condition)
            && !ids.is_empty()
        {
            result.push(json!({"rule":condition,"severity":rule["severity"],"nodeIds":ids}));
        }
    }
    Ok(result)
}

pub(super) fn verdict(findings: &[Value], admission: &Value) -> Result<&'static str, String> {
    if admission["status"] == "rejected" || findings.iter().any(|f| f["severity"] == "block") {
        return Ok("BLOCK");
    }
    if admission["status"] != "admitted" {
        return Err("unknown admission status cannot produce a verdict".into());
    }
    Ok(if findings.iter().any(|f| f["severity"] == "warn") {
        "WARN"
    } else {
        "PASS"
    })
}

pub(super) fn impacted_nodes(
    graph: &Value,
    diff: &str,
) -> Result<(BTreeSet<String>, bool), String> {
    let mut path = None::<String>;
    let mut hunks: BTreeMap<String, Vec<(u64, u64)>> = BTreeMap::new();
    let mut removes = false;
    for line in diff.lines() {
        if line.starts_with("diff --git ") {
            path = None;
        }
        if let Some(name) = line.strip_prefix("+++ b/") {
            if name.contains(['\t', '"', '\\']) || !safe_relative(name) {
                return Err("T00 diff path requires the general quoted-path decoder".into());
            }
            path = Some(name.to_string());
            hunks.entry(name.to_string()).or_default();
        } else if line == "+++ /dev/null" {
            return Err(
                "deleted post-image requires the separately qualified base-image path".into(),
            );
        } else if line.starts_with("@@ ") {
            let tokens = line.split_whitespace().collect::<Vec<_>>();
            let old = tokens
                .get(1)
                .and_then(|s| s.strip_prefix('-'))
                .ok_or("invalid old-side Git hunk")?;
            let new = tokens
                .get(2)
                .and_then(|s| s.strip_prefix('+'))
                .ok_or("invalid new-side Git hunk")?;
            let parse = |value: &str| -> Result<(u64, u64), String> {
                let mut parts = value.split(',');
                let start = parts
                    .next()
                    .ok_or("missing hunk start")?
                    .parse()
                    .map_err(|_| "invalid hunk start")?;
                let count = parts
                    .next()
                    .map(str::parse::<u64>)
                    .transpose()
                    .map_err(|_| "invalid hunk length")?
                    .unwrap_or(1);
                if parts.next().is_some() {
                    return Err("invalid hunk arity".into());
                }
                Ok((start, count))
            };
            let (_, old_count) = parse(old)?;
            let new = parse(new)?;
            removes |= old_count > 0;
            hunks
                .get_mut(
                    path.as_ref()
                        .ok_or("Git hunk without actual post-image path")?,
                )
                .ok_or("untracked Git hunk path")?
                .push(new);
        } else if line.starts_with("Binary files ") || line.starts_with("GIT binary patch") {
            return Err("binary diff has no bounded source range evidence".into());
        }
    }
    let mut impacted = BTreeSet::new();
    for node in array(graph, "nodes")? {
        let Some(file) = node["filePath"].as_str() else {
            continue;
        };
        let Some(changes) = hunks.get(file) else {
            continue;
        };
        let mut start = None::<u64>;
        let mut end = None::<u64>;
        for reference in array(node, "evidence")? {
            if let Some(value) = reference["startLine"].as_u64() {
                start = Some(start.map_or(value, |s| s.min(value)));
            }
            if let Some(value) = reference["endLine"]
                .as_u64()
                .or_else(|| reference["startLine"].as_u64())
            {
                end = Some(end.map_or(value, |e| e.max(value)));
            }
        }
        let touched = match start {
            None => true,
            Some(begin) => {
                let end = end.unwrap_or(begin);
                changes.is_empty()
                    || changes.iter().any(|(at, count)| {
                        if *count == 0 {
                            *at >= begin && *at < end
                        } else {
                            *at <= end && at + count > begin
                        }
                    })
            }
        };
        if touched {
            impacted.insert(text(node, "id")?.into());
        }
    }
    Ok((impacted, removes))
}

pub(super) fn vacuous_graph_guard_receipt(base: &Value, head: &Value) -> Result<Value, String> {
    // Exact bounded no-guard branch of analyzeLostGuards. A richer model is not
    // replaced with an empty set: it needs the corresponding actual claim receipt.
    for graph in [base, head] {
        let node_guard = array(graph, "nodes")?.iter().any(|n| {
            [
                "test",
                "invariant",
                "contract",
                "document",
                "decision",
                "risk",
            ]
            .contains(&n["kind"].as_str().unwrap_or(""))
                || (["interface", "type"].contains(&n["kind"].as_str().unwrap_or(""))
                    && n["exported"] == true)
                || n["tags"].as_array().is_some_and(|tags| {
                    tags.iter()
                        .any(|t| ["critical", "security"].contains(&t.as_str().unwrap_or("")))
                })
        });
        let edge_guard = array(graph, "edges")?.iter().any(|e| {
            ["constrained_by", "tested_by", "covers", "related_to"]
                .contains(&e["kind"].as_str().unwrap_or(""))
        });
        if node_guard || edge_guard {
            return Err(
                "non-vacuous base guards require the complete claim/test comparison counterpart"
                    .into(),
            );
        }
    }
    Ok(
        json!({"complete":true,"basis":"actual-paired-native-graphs-no-authored-guard-nodes-or-edges","base_graph_id":identity::digest(base),"head_graph_id":identity::digest(head),"findings":[]}),
    )
}

/// Typed consumer entrypoint over actual admitted observations. The supervisor
/// supplies independently bound index/qualified receipts, actual Git paths/hunks,
/// actual current discovery, and a read-back/current seal pair. This function
/// has no expected-output parameter and never invokes a JS policy implementation.
pub(super) fn working_tree_projection(evidence: &Value) -> Result<Value, String> {
    let sdk = &evidence["sdk_descriptor"];
    let artifact = text(evidence, "probe_artifact_sha256")?;
    let contexts = [
        ("ordinary_index_request", "ordinary_index"),
        ("qualified_selected_request", "qualified_selected"),
        ("qualified_broad_request", "qualified_broad"),
    ];
    let mut receipts = vec![];
    for (request, report) in contexts {
        let binding =
            observation_bound_to_request(&evidence[report], &evidence[request], sdk, artifact)?;
        let reads = join_successful_reads(&evidence[report], &evidence[request], sdk)?;
        receipts.push(json!({"profile":if evidence[request]["qualified"]==true{"modelo-suite-static-v1"}else{"ordinary"},
            "request_descriptor_id":binding["request_id"],"input_manifest_id":binding["input_manifest_id"],"producer_artifact_id":evidence[report]["producer_artifact_id"],
            "sdk_input_id":identity::digest(sdk),"read_receipt":reads}));
    }
    let ordinary = &receipts[0];
    let selected = &receipts[1];
    let broad = &receipts[2];
    if ordinary["profile"] != "ordinary"
        || selected["profile"] != "modelo-suite-static-v1"
        || broad["profile"] != "modelo-suite-static-v1"
    {
        return Err("distinct ordinary/qualified actual receipts are required; profiles cannot be relabelled".into());
    }
    if ordinary["input_manifest_id"] != selected["input_manifest_id"] {
        return Err("structural index and its qualified selected snapshot differ".into());
    }
    for field in ["producer_artifact_id", "sdk_input_id"] {
        if !ordinary[field].is_string()
            || ordinary[field] != selected[field]
            || ordinary[field] != broad[field]
        {
            return Err(format!("ordinary/qualified {field} context differs"));
        }
    }
    if ordinary["request_descriptor_id"] == selected["request_descriptor_id"] {
        return Err(
            "ordinary and qualified request receipts cannot share a descriptor identity".into(),
        );
    }
    let freshness = classify_freshness(&evidence["freshness_seal"])?;
    let fresh = ["FRESH", "DIRTY_KNOWN"].contains(&text(&freshness, "verdict")?);
    let binding_valid = boolean(evidence, "index_binding_valid")?;
    let workspace_unambiguous = boolean(evidence, "workspace_unambiguous")?;
    let index_receipt = super::batch_binding::validate_batch(
        &evidence["ordinary_batch"],
        &evidence["ordinary_index_request"],
        sdk,
        artifact,
    )?;
    if index_receipt["state"] != "BOUND_COMPLETE_INDEX_BATCH"
        || index_receipt["admissible_index_store"] != true
    {
        return Err("actual ordinary batch did not admit a complete structural store".into());
    }
    if evidence["ordinary_batch"]["input_manifest_id"] != ordinary["input_manifest_id"] {
        return Err("ordinary raw/batch input capture differs".into());
    }
    let mut gates = serde_json::Map::new();
    for candidate in array(&evidence["selected_discovery"], "candidates")? {
        let path = text(candidate, "relPath")?;
        let actual = array(&evidence["ordinary_batch"], "subjects")?
            .iter()
            .find(|s| s["subject_id"] == path);
        gates.insert(path.into(),json!(binding_valid&&fresh&&workspace_unambiguous&&actual.is_some_and(|s|s["selection"]=="selected"&&s["outcome"]=="analyzed")));
    }
    let candidates = candidate_rows(
        &evidence["selected_discovery"],
        &evidence["qualified_selected"],
        &Value::Object(gates),
    )?;
    let coverage = coverage_status(&candidates, binding_valid, fresh, workspace_unambiguous)?;
    let current = array(evidence, "current_candidates")?.clone();
    let changed = strings(evidence, "changed_paths")?;
    let captured = strings(evidence, "current_capture_paths")?;
    let tracked = strings(evidence, "git_cached_paths")?
        .into_iter()
        .collect::<BTreeSet<_>>();
    let mut binding_reasons = strings(evidence, "index_binding_reasons")?;
    // Exact baseline verify.ts working-tree rule, including genuinely untracked
    // retained inputs. Ignored .semctx runtime files are outside the capture.
    let mut untracked = captured
        .into_iter()
        .filter(|p| !tracked.contains(p))
        .collect::<Vec<_>>();
    untracked.sort();
    for path in untracked {
        binding_reasons.push(format!("QUALIFIED_WORKING_TREE_UNTRACKED_INPUT:{path}"));
    }
    let scope = &evidence["rust_scope_projection"];
    let check_changed = boolean(evidence, "check_changed")?;
    let mut input = json!({"changedPaths":changed,"links":scope["links"],"candidates":candidates,"current":current,
        "unresolvedImports":scope["unresolvedImports"],"scopeReasons":scope["reasons"],"bindingReasons":binding_reasons,
        "bindingStatus":if binding_valid{"valid"}else{"invalid"},"canRunHighRiskControl":fresh,"freshnessReasons":freshness["reasons"],
        "buildComplete":evidence["index_store_receipt"]["build_complete"],"checkChanged":check_changed,"repositoryCoverageStatus":coverage});
    // A complete transport alone is insufficient: the structural store receipt
    // must already have passed request/SDK/capture/scope/snapshot/terminal checks.
    if evidence["index_store_written_batch"] != evidence["ordinary_batch"]
        || evidence["index_store_readback_batch"] != evidence["ordinary_batch"]
    {
        return Err("working-tree consumer has no complete bound ordinary index".into());
    }
    input["buildComplete"] = json!(true);
    let mut admission = evaluate_admission(&input)?;
    admission["schemaVersion"] = json!(1);
    admission["profile"] = json!("modelo-suite-static-v1");
    admission["binding"] = json!({"status":if strings(&input,"bindingReasons")?.is_empty()&&binding_valid{"valid"}else{"invalid"},"reasons":input["bindingReasons"]});
    admission["indexFreshness"] = freshness.clone();
    admission["controlFreshness"] = freshness;
    admission["checkFreshness"] = if check_changed {
        json!({"status":"changed","reasons":["CHECK_INPUT_CHANGED"]})
    } else {
        json!({"status":"current","reasons":[]})
    };
    let external = strings(scope, "externalModuleSpecifiers")?;
    // Static public-contract prose is sourced from frozen qualified-analysis.ts,
    // not from the per-case expected projection. Dynamic names are actual facts.
    admission["limitations"] = json!([
        "Bounded static ESM/TypeScript analysis; no runtime dependency completeness or pipeline guarantee.",
        "Deleted source post-images and unknown configurations require separate qualification.",
        "PASS does not observe tests, Turbo cache behavior, failure propagation, or pipeline execution.",
        format!(
            "Opaque external static module boundaries (built-ins or manifest-declared non-workspace packages): {}. Their runtime behavior and APIs are not qualified.",
            if external.is_empty() {
                "none".into()
            } else {
                external.join(", ")
            }
        )
    ]);
    admission["proofObligations"] = json!([
        {"id":"tests-execution","status":"not_observed","observation":"Run required tests and retain exact candidate exit status."},
        {"id":"turbo-cache","status":"not_observed","observation":"Observe cache miss/hit and invalidation with representative tasks."},
        {"id":"failure-propagation","status":"not_observed","observation":"Inject a failing task and observe nonzero pipeline exit."},
        {"id":"pipeline-execution","status":"not_observed","observation":"Execute the actual required pipeline on the exact candidate."}]);
    let (impacted, removes_base_lines) = impacted_nodes(
        &evidence["ordinary_graph"],
        text(evidence, "actual_git_diff")?,
    )?;
    let mut findings = configured_findings(
        &evidence["ordinary_graph"],
        &impacted,
        array(evidence, "configured_rules")?,
    )?;
    findings.extend(health_preflight(
        &changed,
        &candidates,
        &current,
        binding_valid,
        fresh,
    )?);
    // Paired base/head lost-guard comparison is an actual separate receipt. The
    // consumer never treats absent baseline data as proof that no guard was lost.
    if admission["status"] == "admitted" && removes_base_lines {
        let base_request = &evidence["base_request"];
        let base = &evidence["base_native"];
        if !base_request.is_object() || !base.is_object() {
            return Err("ACTUAL_IMMUTABLE_BASE_GUARD_RECEIPT_REQUIRED".into());
        }
        observation_bound_to_request(base, base_request, sdk, artifact)?;
        join_successful_reads(base, base_request, sdk)?;
        let guard = vacuous_graph_guard_receipt(&base["assembly"], &evidence["ordinary_graph"])?;
        findings.extend(array(&guard, "findings")?.iter().cloned());
    }
    let verdict = verdict(&findings, &admission)?;
    Ok(
        json!({"verdict":verdict,"admission":admission,"projectionExcludes":["analysisAdmission.identity: Git timestamps/commit IDs and repository-path-bound digests; full values retained in raw baseline output"]}),
    )
}

#[cfg(test)]
mod comparator_tests {
    use super::*;
    fn admission() -> Value {
        json!({"changedPaths":["a.ts"],"links":[],"candidates":[{"path":"a.ts","selectionDecision":"selected","analysisOutcome":"analyzed","analysisReasons":[],"selectionReasons":[],"admissible":true}],
        "current":[{"path":"a.ts","selectionDecision":"selected","reason":"SELECTED"}],"unresolvedImports":[],"scopeReasons":[],"bindingReasons":[],"bindingStatus":"valid","canRunHighRiskControl":true,"freshnessReasons":[],"buildComplete":true,"checkChanged":false,"repositoryCoverageStatus":"partial"})
    }
    #[test]
    fn admission_controls() {
        let base = admission();
        assert_eq!(evaluate_admission(&base).unwrap()["status"], "admitted");
        for (key, value) in [
            ("buildComplete", json!(false)),
            ("checkChanged", json!(true)),
            ("bindingStatus", json!("invalid")),
            ("canRunHighRiskControl", json!(false)),
            (
                "bindingReasons",
                json!(["QUALIFIED_WORKING_TREE_UNTRACKED_INPUT:hidden.ts"]),
            ),
        ] {
            let mut red = base.clone();
            red[key] = value;
            assert_eq!(evaluate_admission(&red).unwrap()["status"], "rejected");
        }
    }
    #[test]
    fn missing_before_extension_is_baseline_order() {
        let mut input = admission();
        input["changedPaths"] = json!(["missing.bin"]);
        let result = evaluate_admission(&input).unwrap();
        assert_eq!(result["changeCoverage"]["files"][0]["status"], "missing");
    }
    #[test]
    fn coverage_warning_does_not_reject_admission() {
        let input = admission();
        let mut c = input["candidates"].as_array().unwrap().clone();
        c[0]["negativeEvidenceEligible"] = json!(false);
        let findings = health_preflight(
            &["a.ts".into()],
            &c,
            input["current"].as_array().unwrap(),
            true,
            true,
        )
        .unwrap();
        let admission = evaluate_admission(&input).unwrap();
        assert_eq!(admission["status"], "admitted");
        assert_eq!(verdict(&findings, &admission).unwrap(), "WARN");
        let mut blocked = findings;
        blocked.push(json!({"severity":"block"}));
        assert_eq!(verdict(&blocked, &admission).unwrap(), "BLOCK");
    }
    #[test]
    fn closure_preserves_untracked_reason() {
        let mut input = admission();
        input["links"] = json!([["hidden.ts", "a.ts"]]);
        input["bindingReasons"] = json!(["QUALIFIED_WORKING_TREE_UNTRACKED_INPUT:hidden.ts"]);
        let result = evaluate_admission(&input).unwrap();
        assert_eq!(result["status"], "rejected");
        assert!(
            result["changeCoverage"]["expected"]
                .as_array()
                .unwrap()
                .contains(&json!("hidden.ts"))
        );
    }
    fn seal() -> Value {
        json!({"repositoryRoot":"/w","indexedRepositoryRoot":"/w","headAtCapture":"head","indexedHeadCommit":"head",
            "repositoryGraphHash":"graph","indexedRepositoryGraphHash":"graph","semanticModelHash":"model","indexedSemanticModelHash":"model",
            "analysisInputHash":"input","indexedAnalysisInputHash":"input","workingDiffHash":"dirty","indexedWorkingDiffHash":"dirty",
            "storeSchemaVersion":1,"indexedStoreSchemaVersion":1,"toolVersion":"tool","indexedToolVersion":"tool","indexedAt":"2026-10-01T00:00:00.000Z"})
    }
    #[test]
    fn freshness_separates_missing_dirty_clean_and_source_drift() {
        let mut value = seal();
        assert_eq!(
            classify_freshness(&value).unwrap()["verdict"],
            "DIRTY_KNOWN"
        );
        value["workingDiffHash"] =
            json!("sha256:21dba70935f8f14f59199087ee440e16bec5dc567d8449b2cedf0c59c592abb1");
        value["indexedWorkingDiffHash"] = value["workingDiffHash"].clone();
        assert_eq!(classify_freshness(&value).unwrap()["verdict"], "FRESH");
        value["analysisInputHash"] = json!("changed");
        assert_eq!(
            classify_freshness(&value).unwrap()["reasons"],
            json!(["ANALYSIS_INPUT_MISMATCH"])
        );
        value["indexedAt"] = Value::Null;
        assert_eq!(classify_freshness(&value).unwrap()["verdict"], "UNSEALED");
    }
    #[test]
    fn freshness_cannot_invent_a_missing_actual_git_observation() {
        let mut value = seal();
        value["headAtCapture"] = Value::Null;
        assert_eq!(
            classify_freshness(&value).unwrap()["reasons"],
            json!(["GIT_STATE_UNAVAILABLE"])
        );
        value.as_object_mut().unwrap().remove("headAtCapture");
        assert!(classify_freshness(&value).is_err());
    }
    #[test]
    fn configured_critical_rule_reads_actual_tag_and_test_edges() {
        let mut graph = json!({"nodes":[{"id":"type","kind":"interface","exported":true,"tags":["security"]},{"id":"test","kind":"test","tags":[]}],"edges":[]});
        let impacted = ["type".to_string()].into_iter().collect();
        let rules =
            vec![json!({"when":"critical_contract_changed_without_test","severity":"block"})];
        assert_eq!(
            configured_findings(&graph, &impacted, &rules)
                .unwrap()
                .len(),
            1
        );
        graph["edges"] = json!([{"kind":"tested_by","from":"type","to":"test"}]);
        assert!(
            configured_findings(&graph, &impacted, &rules)
                .unwrap()
                .is_empty()
        );
    }
    #[test]
    fn graph_guard_receipt_requires_two_actual_guard_free_graphs() {
        let graph = json!({"nodes":[{"id":"fn","kind":"function","tags":[]}],"edges":[]});
        assert_eq!(
            vacuous_graph_guard_receipt(&graph, &graph).unwrap()["complete"],
            true
        );
        let mut guarded = graph.clone();
        guarded["nodes"][0]["tags"] = json!(["security"]);
        assert!(vacuous_graph_guard_receipt(&guarded, &graph).is_err());
    }
    #[test]
    fn actual_hunks_select_new_side_native_ranges() {
        let graph = json!({"nodes":[{"id":"fn","kind":"function","filePath":"a.ts","evidence":[{"startLine":2,"endLine":4}]}],"edges":[]});
        let (hit, removes) = impacted_nodes(
            &graph,
            "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -3,1 +3,1 @@\n-old\n+new\n",
        )
        .unwrap();
        assert!(hit.contains("fn"));
        assert!(removes);
        let (miss, _) = impacted_nodes(
            &graph,
            "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -8,1 +8,1 @@\n-old\n+new\n",
        )
        .unwrap();
        assert!(miss.is_empty());
    }
    #[test]
    fn missing_native_receipts_cannot_be_replaced_with_admitted_plan_flags() {
        let fake = json!({"ordinary_index_receipt":{"admitted":true},"qualified_selected_receipt":{"admitted":true},"qualified_broad_receipt":{"admitted":true}});
        assert!(working_tree_projection(&fake).is_err());
    }
}
