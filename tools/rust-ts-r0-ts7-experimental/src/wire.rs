use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Selection {
    Selected,
    Excluded,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AnalysisOutcome {
    Analyzed,
    Disabled,
    Unsupported,
    Failed,
    Unknown,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Terminal {
    Complete,
    Refused,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SourceRange {
    pub start_utf16: u64,
    pub end_utf16: u64,
    pub start_line: u32,
    pub end_line: u32,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "record", rename_all = "snake_case", deny_unknown_fields)]
pub enum Fact {
    Node {
        id: String,
        subject_id: String,
        fact_kind: String,
        path: Option<String>,
        range: Option<SourceRange>,
        payload: Value,
    },
    Edge {
        id: String,
        subject_id: String,
        fact_kind: String,
        from: String,
        to: String,
        path: Option<String>,
        range: Option<SourceRange>,
        payload: Value,
    },
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Coverage {
    pub fact_kind: String,
    pub complete: bool,
    pub negative_evidence_eligible: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SubjectReport {
    pub subject_id: String,
    pub selection: Selection,
    pub outcome: Option<AnalysisOutcome>,
    pub coverage: Vec<Coverage>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Diagnostic {
    pub subject_id: String,
    pub code: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code_utf16: Option<Vec<u16>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message_utf16: Option<Vec<u16>>,
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct ReasonCode(Vec<u16>);

impl From<&str> for ReasonCode {
    fn from(value: &str) -> Self {
        Self(value.encode_utf16().collect())
    }
}
impl From<String> for ReasonCode {
    fn from(value: String) -> Self {
        Self::from(value.as_str())
    }
}
impl From<Vec<u16>> for ReasonCode {
    fn from(value: Vec<u16>) -> Self {
        Self(value)
    }
}

impl Diagnostic {
    pub fn canonical_code(&self) -> ReasonCode {
        self.code_utf16
            .clone()
            .map_or_else(|| ReasonCode::from(self.code.as_str()), ReasonCode::from)
    }

    pub fn text_is_consistent(&self) -> bool {
        match (&self.code_utf16, &self.message_utf16) {
            (Some(code), Some(message)) => {
                !code.is_empty()
                    && String::from_utf16_lossy(code) == self.code
                    && String::from_utf16_lossy(message) == self.message
            }
            (None, None) => !self.code.starts_with("DEPENDENCY_SCOPE_UNRESOLVED_IMPORT:"),
            _ => false,
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InputObservation {
    pub context: String,
    pub operation: String,
    pub path: String,
    pub found: bool,
    pub content_id: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Batch {
    pub schema_version: u32,
    pub case_id: String,
    pub request_id: String,
    pub snapshot_id: String,
    pub scope_id: String,
    pub profile: String,
    pub producer_artifact_id: String,
    pub input_manifest_id: String,
    pub capture_id: String,
    pub facts_id: String,
    pub graph_id: String,
    pub complete: bool,
    pub terminal: Terminal,
    pub subjects: Vec<SubjectReport>,
    pub facts: Vec<Fact>,
    pub diagnostics: Vec<Diagnostic>,
    pub input_observations: Vec<InputObservation>,
    #[serde(default)]
    pub producer_claimed_ownership: Option<bool>,
}
