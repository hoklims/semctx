use crate::wire::*;
use semctx_gates::process::Outcome;
use serde::Deserialize;
use serde_json::Value;
use std::{
    collections::{BTreeMap, BTreeSet},
    marker::PhantomData,
    sync::Arc,
    time::Instant,
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Identity<Domain> {
    wire: String,
    domain: PhantomData<Domain>,
}
impl<Domain> Identity<Domain> {
    pub fn observed_bytes(bytes: &[u8]) -> Self {
        Self {
            wire: crate::identity::digest_bytes(bytes),
            domain: PhantomData,
        }
    }
    pub fn observed_json(value: &Value) -> Self {
        Self {
            wire: crate::identity::digest(value),
            domain: PhantomData,
        }
    }
    pub fn as_str(&self) -> &str {
        &self.wire
    }
}
macro_rules! domains {
    ($($name:ident => $domain:ident),* $(,)?) => { $(
        #[derive(Clone, Debug, PartialEq, Eq)] pub enum $domain {}
        pub type $name = Identity<$domain>;
    )* };
}
domains!(ArtifactId=>ArtifactDomain, InputId=>InputDomain, CaptureId=>CaptureDomain,
    FactsId=>FactsDomain, GraphId=>GraphDomain, SnapshotId=>SnapshotDomain, ScopeId=>ScopeDomain);

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct RequestId(String);
impl RequestId {
    pub fn new(value: impl Into<String>) -> Result<Self, Rejection> {
        let value = value.into();
        if value.is_empty() {
            Err(Rejection::InvalidExpectation)
        } else {
            Ok(Self(value))
        }
    }
    pub fn as_str(&self) -> &str {
        &self.0
    }
}
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct SubjectId(String);
impl SubjectId {
    pub fn new(value: impl Into<String>) -> Result<Self, Rejection> {
        let value = value.into();
        if value.is_empty() {
            Err(Rejection::InvalidExpectation)
        } else {
            Ok(Self(value))
        }
    }
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Bindings {
    pub artifact: ArtifactId,
    pub input: InputId,
    pub capture: CaptureId,
    pub facts: FactsId,
    pub graph: GraphId,
    pub snapshot: SnapshotId,
    pub scope: ScopeId,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SourceExtent {
    pub path: String,
    pub utf16_length: u64,
    pub line_count: u32,
}
#[derive(Clone, Debug)]
pub struct ExpectedSubject {
    pub id: SubjectId,
    pub selection: Selection,
    pub source: Option<SourceExtent>,
    pub fact_kinds: BTreeSet<String>,
    pub ranged_fact_kinds: BTreeSet<String>,
    pub pathless_fact_kinds: BTreeSet<String>,
    pub absence_allowed_kinds: BTreeSet<String>,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ExpectedTerminal {
    Analyzed,
    ControlledRefusal {
        exit_code: i32,
        reason_codes: BTreeSet<ReasonCode>,
    },
}
#[derive(Clone, Debug)]
pub struct Expected {
    pub case_id: String,
    pub request: RequestId,
    pub bindings: Bindings,
    pub profile: String,
    pub subjects: Vec<ExpectedSubject>,
    pub terminal: ExpectedTerminal,
    pub deadline: Instant,
    pub max_duration_ms: u64,
    pub output_cap: u64,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FreshnessVerdict {
    Fresh,
    DirtyKnown,
    Stale,
    Unknown,
}
#[derive(Clone, Debug)]
pub struct FreshnessSeal {
    pub repository_facts: FactsId,
    pub indexed_facts: FactsId,
    pub analysis_input: InputId,
    pub indexed_input: InputId,
}
#[derive(Clone, Debug)]
pub struct Freshness {
    pub verdict: FreshnessVerdict,
    pub reasons: Vec<String>,
    pub seal: Option<FreshnessSeal>,
}

pub struct ObservedState<'a> {
    pub artifact_bytes: &'a [u8],
    pub input_manifest: &'a Value,
    pub capture: &'a Value,
    pub facts: &'a [Fact],
    pub graph: &'a Value,
    pub snapshot: &'a Value,
    pub scope: &'a Value,
    pub profile: &'a str,
    pub freshness: &'a Freshness,
    pub binding_valid: bool,
    pub build_complete: bool,
    pub check_changed: bool,
    pub request_current: bool,
}
impl ObservedState<'_> {
    pub fn bindings(&self) -> Result<Bindings, Rejection> {
        let facts = serde_json::to_value(self.facts).map_err(|_| Rejection::MalformedOutput)?;
        Ok(Bindings {
            artifact: ArtifactId::observed_bytes(self.artifact_bytes),
            input: InputId::observed_json(self.input_manifest),
            capture: CaptureId::observed_json(self.capture),
            facts: FactsId::observed_json(&facts),
            graph: GraphId::observed_json(self.graph),
            snapshot: SnapshotId::observed_json(self.snapshot),
            scope: ScopeId::observed_json(self.scope),
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Rejection {
    InvalidExpectation,
    ProcessFailure,
    OutputIncomplete,
    MalformedOutput,
    IdentityMismatch,
    SubjectMismatch,
    DuplicateIdentity,
    InvalidFact,
    InvalidRange,
    InvalidEndpoint,
    IncompleteCoverage,
    UnexpectedOutcome,
    RefusalMismatch,
    InactiveRequest,
    LateResult,
    MissingSeal,
    InvalidBinding,
    IncompleteBuild,
    CheckChanged,
    UnacceptableFreshness,
    SealMismatch,
    ForeignReceipt,
    RefusalHasNoOwnership,
    MissingReceipt,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EvidenceDisposition {
    Analyzed,
    ControlledRefusal,
}

fn legacy_edge_id(kind: &str, from: &str, to: &str) -> String {
    let mut hash = 0x811c9dc5u32;
    for unit in format!("{from}->{to}").encode_utf16() {
        hash = (hash ^ u32::from(unit)).wrapping_mul(0x01000193);
    }
    format!("edge:{kind}:{hash:08x}")
}
fn graph_projection(facts: &[Fact]) -> Value {
    json_graph(
        facts
            .iter()
            .filter_map(|fact| {
                if let Fact::Node { payload, .. } = fact {
                    Some(payload.clone())
                } else {
                    None
                }
            })
            .collect(),
        facts
            .iter()
            .filter_map(|fact| {
                if let Fact::Edge { payload, .. } = fact {
                    Some(payload.clone())
                } else {
                    None
                }
            })
            .collect(),
    )
}
fn json_graph(nodes: Vec<Value>, edges: Vec<Value>) -> Value {
    serde_json::json!({"nodes":nodes,"edges":edges})
}
fn validate_graph_payload(
    fact: &Fact,
    expected: &BTreeMap<&str, &ExpectedSubject>,
) -> Result<(), Rejection> {
    let (payload, path, range) = match fact {
        Fact::Node {
            payload,
            path,
            range,
            ..
        }
        | Fact::Edge {
            payload,
            path,
            range,
            ..
        } => (payload, path, range),
    };
    let object = payload.as_object().ok_or(Rejection::InvalidFact)?;
    let text = |key: &str| {
        object
            .get(key)
            .and_then(Value::as_str)
            .ok_or(Rejection::InvalidFact)
    };
    let kind = text("kind")?;
    let payload_id = text("id")?;
    if payload_id.is_empty() {
        return Err(Rejection::InvalidFact);
    }
    if !object
        .get("metadata")
        .and_then(Value::as_object)
        .is_some_and(|metadata| {
            metadata
                .values()
                .all(|value| value.is_string() || value.is_boolean() || value.is_number())
        })
    {
        return Err(Rejection::InvalidFact);
    }
    let file_path = match fact {
        Fact::Node { id, fact_kind, .. } => {
            if payload_id != id
                || *fact_kind != format!("node:{kind}")
                || ![
                    "repository",
                    "package",
                    "module",
                    "symbol",
                    "type",
                    "function",
                    "class",
                    "interface",
                    "enum",
                    "test",
                    "migration",
                    "document",
                    "contract",
                    "invariant",
                    "capability",
                    "bounded_context",
                    "decision",
                    "risk",
                    "external_integration",
                ]
                .contains(&kind)
                || !object.get("name").is_some_and(Value::is_string)
                || !object
                    .get("tags")
                    .and_then(Value::as_array)
                    .is_some_and(|tags| tags.iter().all(Value::is_string))
                || object
                    .get("boundedContext")
                    .is_some_and(|value| !value.is_string())
                || object
                    .get("exported")
                    .is_some_and(|value| !value.is_boolean())
            {
                return Err(Rejection::InvalidFact);
            }
            let file_path = match object.get("filePath") {
                Some(value) => Some(value.as_str().ok_or(Rejection::InvalidFact)?),
                None => None,
            };
            if file_path.is_some() && file_path != path.as_deref()
                || file_path.is_none()
                    && [
                        "module",
                        "test",
                        "symbol",
                        "function",
                        "class",
                        "interface",
                        "type",
                        "enum",
                    ]
                    .contains(&kind)
            {
                return Err(Rejection::InvalidFact);
            }
            file_path
        }
        Fact::Edge {
            fact_kind,
            from,
            to,
            ..
        } => {
            if *fact_kind != format!("edge:{kind}")
                || ![
                    "imports",
                    "exports",
                    "calls",
                    "references",
                    "extends",
                    "implements",
                    "declares",
                    "tested_by",
                    "covers",
                    "depends_on",
                    "belongs_to",
                    "implements_capability",
                    "constrained_by",
                    "verifies",
                    "documents",
                    "decides",
                    "changes",
                    "contradicts",
                    "related_to",
                ]
                .contains(&kind)
                || text("from")? != from
                || text("to")? != to
                || payload_id != legacy_edge_id(kind, from, to)
            {
                return Err(Rejection::InvalidFact);
            }
            None
        }
    };
    let evidence = object
        .get("evidence")
        .and_then(Value::as_array)
        .ok_or(Rejection::InvalidRange)?;
    let mut starts = Vec::new();
    let mut ends = Vec::new();
    for reference in evidence {
        let reference = reference.as_object().ok_or(Rejection::InvalidRange)?;
        if reference.keys().any(|key| {
            !["filePath", "startLine", "endLine", "sourceKind", "excerpt"].contains(&key.as_str())
        }) {
            return Err(Rejection::InvalidRange);
        }
        let file = reference
            .get("filePath")
            .and_then(Value::as_str)
            .ok_or(Rejection::InvalidRange)?;
        let source = expected
            .values()
            .filter(|subject| subject.selection == Selection::Selected)
            .filter_map(|subject| subject.source.as_ref())
            .find(|source| source.path == file)
            .ok_or(Rejection::InvalidRange)?;
        let source_kind = reference
            .get("sourceKind")
            .and_then(Value::as_str)
            .ok_or(Rejection::InvalidRange)?;
        if !["code", "test", "document", "git", "runtime", "manual"].contains(&source_kind)
            || reference
                .get("excerpt")
                .is_some_and(|value| !value.is_string())
            || file_path.is_some_and(|path| path != file)
        {
            return Err(Rejection::InvalidRange);
        }
        let line = |key: &str| -> Result<Option<u64>, Rejection> {
            reference
                .get(key)
                .map(|value| {
                    value
                        .as_u64()
                        .filter(|line| *line > 0 && *line <= u64::from(source.line_count))
                        .ok_or(Rejection::InvalidRange)
                })
                .transpose()
        };
        let start = line("startLine")?;
        let end = line("endLine")?;
        if end.is_some() && start.is_none()
            || start.zip(end).is_some_and(|(start, end)| start > end)
        {
            return Err(Rejection::InvalidRange);
        }
        if let Some(range) = range {
            if Some(file) != path.as_deref() {
                return Err(Rejection::InvalidRange);
            }
            starts.push(start.ok_or(Rejection::InvalidRange)?);
            ends.push(end.ok_or(Rejection::InvalidRange)?);
            if start.is_some_and(|line| line < u64::from(range.start_line))
                || end.is_some_and(|line| line > u64::from(range.end_line))
            {
                return Err(Rejection::InvalidRange);
            }
        }
    }
    if let Some(range) = range
        && (starts.iter().min() != Some(&u64::from(range.start_line))
            || ends.iter().max() != Some(&u64::from(range.end_line)))
    {
        return Err(Rejection::InvalidRange);
    }
    if path.is_some()
        && (file_path.is_none() || matches!(fact, Fact::Edge { .. }))
        && evidence
            .first()
            .and_then(|reference| reference["filePath"].as_str())
            != path.as_deref()
    {
        return Err(Rejection::InvalidRange);
    }
    Ok(())
}

pub struct Receiver {
    expected: Expected,
    issuer: Arc<()>,
}
pub struct Receipt {
    issuer: Arc<()>,
    bindings: Bindings,
    disposition: EvidenceDisposition,
    absence: BTreeSet<(SubjectId, String)>,
    batch: Batch,
}
pub struct OwnershipContext<'a> {
    receiver: &'a Receiver,
    receipt: &'a Receipt,
    current: &'a ObservedState<'a>,
}
impl Receipt {
    pub fn disposition(&self) -> EvidenceDisposition {
        self.disposition
    }
    pub fn batch(&self) -> &Batch {
        &self.batch
    }
}
impl OwnershipContext<'_> {
    pub fn graph(&self) -> &Value {
        self.current.graph
    }
    pub fn input_manifest(&self) -> &Value {
        self.current.input_manifest
    }
    pub fn capture_manifest(&self) -> &Value {
        self.current.capture
    }
    pub fn scope_manifest(&self) -> &Value {
        self.current.scope
    }
    pub fn absence_evidence_eligible(&self, subject: &SubjectId, kind: &str) -> bool {
        self.receipt
            .absence
            .contains(&(subject.clone(), kind.into()))
    }
    pub fn scope(&self) -> &ScopeId {
        &self.receiver.expected.bindings.scope
    }
}

impl Receiver {
    pub fn new(expected: Expected) -> Result<Self, Rejection> {
        if expected.case_id.is_empty()
            || expected.profile.is_empty()
            || expected.max_duration_ms == 0
            || expected.output_cap == 0
        {
            return Err(Rejection::InvalidExpectation);
        }
        if let ExpectedTerminal::ControlledRefusal { reason_codes, .. } = &expected.terminal
            && reason_codes.is_empty()
        {
            return Err(Rejection::InvalidExpectation);
        }
        let mut ids = BTreeSet::new();
        for subject in &expected.subjects {
            if !ids.insert(subject.id.clone())
                || subject.fact_kinds.iter().any(String::is_empty)
                || !subject.ranged_fact_kinds.is_subset(&subject.fact_kinds)
                || !subject.pathless_fact_kinds.is_subset(&subject.fact_kinds)
                || !subject
                    .pathless_fact_kinds
                    .is_disjoint(&subject.ranged_fact_kinds)
                || !subject.absence_allowed_kinds.is_subset(&subject.fact_kinds)
                || (subject.selection == Selection::Excluded
                    && (!subject.fact_kinds.is_empty()
                        || !subject.absence_allowed_kinds.is_empty()))
                || (subject.source.is_none() && !subject.ranged_fact_kinds.is_empty())
                || subject
                    .source
                    .as_ref()
                    .is_some_and(|s| s.path.is_empty() || s.line_count == 0)
            {
                return Err(Rejection::InvalidExpectation);
            }
        }
        Ok(Self {
            expected,
            issuer: Arc::new(()),
        })
    }
    fn bound_current(&self, current: &ObservedState<'_>) -> Result<Bindings, Rejection> {
        if !current.request_current {
            return Err(Rejection::InactiveRequest);
        }
        if Instant::now() > self.expected.deadline {
            return Err(Rejection::LateResult);
        }
        let bindings = current.bindings()?;
        if bindings != self.expected.bindings || current.profile != self.expected.profile {
            return Err(Rejection::IdentityMismatch);
        }
        if current.check_changed {
            return Err(Rejection::CheckChanged);
        }
        Ok(bindings)
    }
    fn current(&self, current: &ObservedState<'_>) -> Result<Bindings, Rejection> {
        let bindings = self.bound_current(current)?;
        if !current.binding_valid {
            return Err(Rejection::InvalidBinding);
        }
        if !current.build_complete {
            return Err(Rejection::IncompleteBuild);
        }
        let seal = current
            .freshness
            .seal
            .as_ref()
            .ok_or(Rejection::MissingSeal)?;
        if !(current.freshness.verdict == FreshnessVerdict::Fresh
            || (current.freshness.verdict == FreshnessVerdict::DirtyKnown
                && current
                    .freshness
                    .reasons
                    .iter()
                    .all(|r| r == "WORKING_TREE_DIRTY")))
        {
            return Err(Rejection::UnacceptableFreshness);
        }
        if seal.repository_facts != bindings.facts
            || seal.indexed_facts != bindings.facts
            || seal.analysis_input != bindings.input
            || seal.indexed_input != bindings.input
        {
            return Err(Rejection::SealMismatch);
        }
        Ok(bindings)
    }
    fn process(&self, outcome: &Outcome) -> Result<EvidenceDisposition, Rejection> {
        let (code, kind, disposition) = match &self.expected.terminal {
            ExpectedTerminal::Analyzed => (0, "success", EvidenceDisposition::Analyzed),
            ExpectedTerminal::ControlledRefusal { exit_code, .. } => (
                *exit_code,
                if *exit_code == 0 {
                    "success"
                } else {
                    "nonzero"
                },
                EvidenceDisposition::ControlledRefusal,
            ),
        };
        if outcome.kind != kind || outcome.exit_code != Some(code) {
            return Err(Rejection::ProcessFailure);
        }
        if outcome.duration_ms > self.expected.max_duration_ms {
            return Err(Rejection::LateResult);
        }
        if outcome.stdout_bytes > self.expected.output_cap
            || outcome.stderr_bytes > self.expected.output_cap
            || outcome.stdout_bytes != outcome.stdout.len() as u64
            || outcome.stderr_bytes != outcome.stderr.len() as u64
            || outcome.stdout_hash
                != crate::identity::digest_bytes(outcome.stdout.as_bytes())
                    .trim_start_matches("sha256:")
            || outcome.stderr_hash
                != crate::identity::digest_bytes(outcome.stderr.as_bytes())
                    .trim_start_matches("sha256:")
        {
            return Err(Rejection::OutputIncomplete);
        }
        Ok(disposition)
    }
    pub fn receive(
        &self,
        outcome: &Outcome,
        current: &ObservedState<'_>,
    ) -> Result<Receipt, Rejection> {
        let disposition = self.process(outcome)?;
        let bindings = match disposition {
            EvidenceDisposition::Analyzed => self.current(current)?,
            EvidenceDisposition::ControlledRefusal => self.bound_current(current)?,
        };
        let strict: StrictValue =
            serde_json::from_str(&outcome.stdout).map_err(|_| Rejection::MalformedOutput)?;
        let batch: Batch =
            serde_json::from_value(strict.0).map_err(|_| Rejection::MalformedOutput)?;
        if batch.schema_version != 1 {
            return Err(Rejection::MalformedOutput);
        }
        if batch.case_id != self.expected.case_id
            || batch.request_id != self.expected.request.as_str()
            || batch.profile != self.expected.profile
            || batch.snapshot_id != bindings.snapshot.as_str()
            || batch.scope_id != bindings.scope.as_str()
            || batch.producer_artifact_id != bindings.artifact.as_str()
            || batch.input_manifest_id != bindings.input.as_str()
            || batch.capture_id != bindings.capture.as_str()
            || batch.facts_id != bindings.facts.as_str()
            || batch.graph_id != bindings.graph.as_str()
        {
            return Err(Rejection::IdentityMismatch);
        }
        if !batch.complete {
            return Err(Rejection::IncompleteCoverage);
        }
        let terminal = if disposition == EvidenceDisposition::Analyzed {
            Terminal::Complete
        } else {
            Terminal::Refused
        };
        if batch.terminal != terminal {
            return Err(Rejection::UnexpectedOutcome);
        }
        if batch.subjects.len() != self.expected.subjects.len() {
            return Err(Rejection::SubjectMismatch);
        }
        let expected = self
            .expected
            .subjects
            .iter()
            .map(|s| (s.id.as_str(), s))
            .collect::<BTreeMap<_, _>>();
        if disposition == EvidenceDisposition::ControlledRefusal
            && !batch.subjects.iter().any(|report| {
                report.selection == Selection::Selected
                    && matches!(
                        report.outcome,
                        Some(AnalysisOutcome::Disabled | AnalysisOutcome::Unsupported)
                    )
            })
        {
            return Err(Rejection::UnexpectedOutcome);
        }
        let mut reports = BTreeMap::new();
        let mut absence = BTreeSet::new();
        for report in &batch.subjects {
            let subject = expected
                .get(report.subject_id.as_str())
                .ok_or(Rejection::SubjectMismatch)?;
            if reports.insert(report.subject_id.as_str(), report).is_some() {
                return Err(Rejection::DuplicateIdentity);
            }
            if report.selection != subject.selection {
                return Err(Rejection::SubjectMismatch);
            }
            if report.selection == Selection::Excluded {
                if report.outcome.is_some() || !report.coverage.is_empty() {
                    return Err(Rejection::UnexpectedOutcome);
                }
                continue;
            }
            if disposition == EvidenceDisposition::ControlledRefusal
                && matches!(
                    report.outcome,
                    Some(AnalysisOutcome::Disabled | AnalysisOutcome::Unsupported)
                )
            {
                if !report.coverage.is_empty() {
                    return Err(Rejection::UnexpectedOutcome);
                }
                continue;
            }
            if report.outcome != Some(AnalysisOutcome::Analyzed) {
                return Err(Rejection::UnexpectedOutcome);
            }
            let mut kinds = BTreeSet::new();
            for coverage in &report.coverage {
                if !kinds.insert(coverage.fact_kind.clone()) {
                    return Err(Rejection::DuplicateIdentity);
                }
                if !coverage.complete {
                    return Err(Rejection::IncompleteCoverage);
                }
                if coverage.negative_evidence_eligible
                    && subject.absence_allowed_kinds.contains(&coverage.fact_kind)
                {
                    absence.insert((subject.id.clone(), coverage.fact_kind.clone()));
                }
            }
            if kinds != subject.fact_kinds {
                return Err(Rejection::IncompleteCoverage);
            }
        }
        let mut diagnostic_ids = BTreeSet::new();
        for diagnostic in &batch.diagnostics {
            if !expected.contains_key(diagnostic.subject_id.as_str()) {
                return Err(Rejection::SubjectMismatch);
            }
            if diagnostic.code.is_empty() || !diagnostic.text_is_consistent() {
                return Err(Rejection::MalformedOutput);
            }
            if !diagnostic_ids.insert((&diagnostic.subject_id, diagnostic.canonical_code())) {
                return Err(Rejection::DuplicateIdentity);
            }
        }
        if let ExpectedTerminal::ControlledRefusal { reason_codes, .. } = &self.expected.terminal {
            let codes = batch
                .diagnostics
                .iter()
                .map(Diagnostic::canonical_code)
                .collect::<BTreeSet<_>>();
            if &codes != reason_codes {
                return Err(Rejection::RefusalMismatch);
            }
        }
        let mut ids = BTreeSet::new();
        let mut nodes = BTreeSet::new();
        let mut endpoints = vec![];
        let mut graph_edge_ids = BTreeSet::new();
        for fact in &batch.facts {
            let (id, subject_id, kind, path, range) = match fact {
                Fact::Node {
                    id,
                    subject_id,
                    fact_kind,
                    path,
                    range,
                    ..
                } => {
                    nodes.insert(id.as_str());
                    (id, subject_id, fact_kind, path, range)
                }
                Fact::Edge {
                    id,
                    subject_id,
                    fact_kind,
                    path,
                    range,
                    from,
                    to,
                    ..
                } => {
                    endpoints.push((from.as_str(), to.as_str()));
                    (id, subject_id, fact_kind, path, range)
                }
            };
            if id.is_empty() || !ids.insert(id.as_str()) {
                return Err(Rejection::DuplicateIdentity);
            }
            let subject = expected
                .get(subject_id.as_str())
                .ok_or(Rejection::SubjectMismatch)?;
            let report = reports
                .get(subject_id.as_str())
                .ok_or(Rejection::SubjectMismatch)?;
            if report.selection != Selection::Selected
                || !(report.outcome == Some(AnalysisOutcome::Analyzed)
                    || (disposition == EvidenceDisposition::ControlledRefusal
                        && report.outcome == Some(AnalysisOutcome::Unsupported)))
                || !subject.fact_kinds.contains(kind)
            {
                return Err(Rejection::InvalidFact);
            }
            if subject.ranged_fact_kinds.contains(kind) && range.is_none() {
                return Err(Rejection::InvalidRange);
            }
            match (&subject.source, subject.pathless_fact_kinds.contains(kind)) {
                (Some(source), false) => {
                    if path.as_deref() != Some(source.path.as_str()) {
                        return Err(Rejection::InvalidFact);
                    }
                    if let Some(range) = range
                        && (range.start_utf16 > range.end_utf16
                            || range.end_utf16 > source.utf16_length
                            || range.start_line == 0
                            || range.start_line > range.end_line
                            || range.end_line > source.line_count)
                    {
                        return Err(Rejection::InvalidRange);
                    }
                }
                _ if path.is_some() || range.is_some() => return Err(Rejection::InvalidRange),
                _ => {}
            }
            validate_graph_payload(fact, &expected)?;
            if let Fact::Edge { payload, .. } = fact
                && !graph_edge_ids.insert(payload["id"].as_str().ok_or(Rejection::InvalidFact)?)
            {
                return Err(Rejection::DuplicateIdentity);
            }
        }
        if endpoints
            .iter()
            .any(|(from, to)| !nodes.contains(from) || !nodes.contains(to))
        {
            return Err(Rejection::InvalidEndpoint);
        }
        let received = FactsId::observed_json(
            &serde_json::to_value(&batch.facts).map_err(|_| Rejection::MalformedOutput)?,
        );
        if received != bindings.facts
            || GraphId::observed_json(&graph_projection(&batch.facts)) != bindings.graph
        {
            return Err(Rejection::IdentityMismatch);
        }
        Ok(Receipt {
            issuer: Arc::clone(&self.issuer),
            bindings,
            disposition,
            absence,
            batch,
        })
    }
    pub fn revalidate<'a>(
        &'a self,
        receipt: &'a Receipt,
        current: &'a ObservedState<'a>,
    ) -> Result<OwnershipContext<'a>, Rejection> {
        if !Arc::ptr_eq(&self.issuer, &receipt.issuer) {
            return Err(Rejection::ForeignReceipt);
        }
        if receipt.disposition != EvidenceDisposition::Analyzed {
            return Err(Rejection::RefusalHasNoOwnership);
        }
        let bindings = self.current(current)?;
        if bindings != receipt.bindings {
            return Err(Rejection::IdentityMismatch);
        }
        Ok(OwnershipContext {
            receiver: self,
            receipt,
            current,
        })
    }
    pub fn context<'a>(
        &'a self,
        receipt: Option<&'a Receipt>,
        current: &'a ObservedState<'a>,
    ) -> Result<OwnershipContext<'a>, Rejection> {
        self.revalidate(receipt.ok_or(Rejection::MissingReceipt)?, current)
    }
}

struct StrictValue(Value);
impl<'de> Deserialize<'de> for StrictValue {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Visitor;
        impl<'de> serde::de::Visitor<'de> for Visitor {
            type Value = StrictValue;
            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("a complete JSON value with unique object keys")
            }
            fn visit_bool<E: serde::de::Error>(self, v: bool) -> Result<Self::Value, E> {
                Ok(StrictValue(Value::Bool(v)))
            }
            fn visit_i64<E: serde::de::Error>(self, v: i64) -> Result<Self::Value, E> {
                Ok(StrictValue(Value::Number(v.into())))
            }
            fn visit_u64<E: serde::de::Error>(self, v: u64) -> Result<Self::Value, E> {
                Ok(StrictValue(Value::Number(v.into())))
            }
            fn visit_f64<E: serde::de::Error>(self, v: f64) -> Result<Self::Value, E> {
                serde_json::Number::from_f64(v)
                    .map(|v| StrictValue(Value::Number(v)))
                    .ok_or_else(|| E::custom("non-finite number"))
            }
            fn visit_str<E: serde::de::Error>(self, v: &str) -> Result<Self::Value, E> {
                Ok(StrictValue(Value::String(v.into())))
            }
            fn visit_string<E: serde::de::Error>(self, v: String) -> Result<Self::Value, E> {
                Ok(StrictValue(Value::String(v)))
            }
            fn visit_unit<E: serde::de::Error>(self) -> Result<Self::Value, E> {
                Ok(StrictValue(Value::Null))
            }
            fn visit_none<E: serde::de::Error>(self) -> Result<Self::Value, E> {
                Ok(StrictValue(Value::Null))
            }
            fn visit_seq<A: serde::de::SeqAccess<'de>>(
                self,
                mut seq: A,
            ) -> Result<Self::Value, A::Error> {
                let mut values = vec![];
                while let Some(value) = seq.next_element::<StrictValue>()? {
                    values.push(value.0);
                }
                Ok(StrictValue(Value::Array(values)))
            }
            #[expect(
                clippy::excessive_nesting,
                reason = "The local recursive serde visitor preserves duplicate-key rejection."
            )]
            fn visit_map<A: serde::de::MapAccess<'de>>(
                self,
                mut map: A,
            ) -> Result<Self::Value, A::Error> {
                let mut values = serde_json::Map::new();
                while let Some((key, value)) = map.next_entry::<String, StrictValue>()? {
                    if values.insert(key, value.0).is_some() {
                        return Err(serde::de::Error::custom("duplicate object key"));
                    }
                }
                Ok(StrictValue(Value::Object(values)))
            }
        }
        deserializer.deserialize_any(Visitor)
    }
}

#[cfg(test)]
#[path = "../tests/unit/receiver.rs"]
mod tests;
