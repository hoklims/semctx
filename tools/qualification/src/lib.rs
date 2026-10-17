pub mod journeys;
pub mod mcp;
pub mod process;
use process::Observation;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    fs,
    path::{Path, PathBuf},
};

pub const CASES: &[&str] = &[
    "cli.setup",
    "cli.benign",
    "cli.contract-risk",
    "cli.partial-coverage",
    "cli.missing-index",
    "cli.invalid-config",
    "cli.stale",
    "cli.repaired",
    "mcp.initialize",
    "mcp.tools",
    "mcp.control-status",
    "mcp.inspect",
    "mcp.refresh",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostLane {
    Ubuntu,
    Windows,
    Macos,
}
impl HostLane {
    pub fn parse(value: &str) -> Result<Self, String> {
        match value {
            "ubuntu-latest" => Ok(Self::Ubuntu),
            "windows-latest" => Ok(Self::Windows),
            "macos-15" => Ok(Self::Macos),
            _ => Err(format!("unknown qualification OS {value}")),
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ubuntu => "ubuntu-latest",
            Self::Windows => "windows-latest",
            Self::Macos => "macos-15",
        }
    }
    pub fn host_os(self) -> &'static str {
        match self {
            Self::Ubuntu => "linux",
            Self::Windows => "windows",
            Self::Macos => "macos",
        }
    }
}
pub fn lane_host_os(lane: &str) -> Option<&'static str> {
    HostLane::parse(lane).ok().map(HostLane::host_os)
}
pub fn observed_lane(requested: Option<&str>) -> Result<HostLane, String> {
    let default = match std::env::consts::OS {
        "linux" => HostLane::Ubuntu,
        "windows" => HostLane::Windows,
        "macos" => HostLane::Macos,
        _ => return Err("host OS has no qualification lane".into()),
    };
    let lane = requested
        .map(HostLane::parse)
        .transpose()?
        .unwrap_or(default);
    if lane != default {
        return Err(format!(
            "qualification lane {} does not match observed host OS {}",
            lane.as_str(),
            std::env::consts::OS
        ));
    }
    Ok(lane)
}

#[derive(Debug, Clone, Copy)]
pub enum SupportStatus {
    Supported,
    Partial,
    Unsupported,
    NotQualified,
}
impl SupportStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Supported => "supported",
            Self::Partial => "partial",
            Self::Unsupported => "unsupported",
            Self::NotQualified => "not_qualified",
        }
    }
}
#[derive(Debug, Clone, Copy)]
pub enum ExpectedOutcome {
    UsefulSuccess,
    ControlledRefusal,
}
impl ExpectedOutcome {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::UsefulSuccess => "useful_success",
            Self::ControlledRefusal => "controlled_refusal",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Case {
    pub id: String,
    pub support_status: String,
    pub outcome: String,
    pub obligations: Vec<String>,
    pub observations: Vec<String>,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Artifact {
    pub path: PathBuf,
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Runtime {
    Bun { identity: Artifact, version: String },
    Native { cli: Artifact, mcp: Artifact },
}

impl Runtime {
    pub fn select(value: &Path, cli: &Path, mcp: &Path) -> Result<Self, String> {
        if value == Path::new("native") {
            for binary in [cli, mcp] {
                if !binary.is_absolute() {
                    return Err("native artifacts must be absolute".into());
                }
                let bytes = fs::read(binary).map_err(|e| e.to_string())?;
                let magic = bytes
                    .get(..4)
                    .ok_or("native artifact lacks executable header")?;
                if !bytes.starts_with(b"MZ")
                    && magic != b"\x7fELF"
                    && ![
                        b"\xfe\xed\xfa\xce",
                        b"\xce\xfa\xed\xfe",
                        b"\xfe\xed\xfa\xcf",
                        b"\xcf\xfa\xed\xfe",
                        b"\xca\xfe\xba\xbe",
                        b"\xbe\xba\xfe\xca",
                    ]
                    .iter()
                    .any(|header| header.as_slice() == magic)
                {
                    return Err(
                        "native mode requires native binaries, not interpreter entrypoints".into(),
                    );
                }
            }
            Ok(Self::Native {
                cli: artifact(cli)?,
                mcp: artifact(mcp)?,
            })
        } else {
            if !value.is_absolute() {
                return Err("runtime must be native or an absolute Bun binary".into());
            }
            Ok(Self::Bun {
                identity: artifact(value)?,
                version: "1.4.3".into(),
            })
        }
    }
    pub fn kind(&self) -> &'static str {
        match self {
            Self::Bun { .. } => "bun",
            Self::Native { .. } => "native",
        }
    }
    pub fn adapter(&self) -> &'static str {
        match self {
            Self::Bun { .. } => "bun-legacy-explicit-1.4.3",
            Self::Native { .. } => "native-explicit-v1",
        }
    }
    pub fn command(&self, entrypoint: &Path) -> std::process::Command {
        match self {
            Self::Bun { identity, .. } => {
                let mut command = std::process::Command::new(&identity.path);
                command.arg(entrypoint);
                command
            }
            Self::Native { .. } => std::process::Command::new(entrypoint),
        }
    }
    pub fn identities(&self) -> Vec<&Artifact> {
        match self {
            Self::Bun { identity, .. } => vec![identity],
            Self::Native { cli, mcp } => vec![cli, mcp],
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Report {
    pub schema_version: u32,
    pub status: String,
    pub os: String,
    pub arch: String,
    pub host_os: String,
    pub host_arch: String,
    pub adapter: String,
    pub runtime: Runtime,
    /// Positions 0 and 1 are the CLI and MCP entrypoints. Remaining artifacts bind dependencies.
    pub artifacts: Vec<Artifact>,
    pub cases: Vec<Case>,
    pub host_activation: String,
    pub limitations: Vec<String>,
}

pub fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
pub fn artifact(path: &Path) -> Result<Artifact, String> {
    let path = path
        .canonicalize()
        .map_err(|e| format!("artifact {}: {e}", path.display()))?;
    let bytes = fs::read(&path).map_err(|e| e.to_string())?;
    Ok(Artifact {
        path,
        sha256: digest(&bytes),
    })
}

pub fn json(observation: &Observation, exit: i32) -> Result<Value, String> {
    if observation.timed_out || observation.output_exceeded || observation.code != Some(exit) {
        return Err(format!(
            "unexpected child result: code {:?}, timeout {}, output exceeded {}",
            observation.code, observation.timed_out, observation.output_exceeded
        ));
    }
    serde_json::from_str(&observation.stdout).map_err(|e| format!("invalid complete JSON: {e}"))
}

/// A controlled operational refusal is accepted only for the exact exit and bracketed code.
/// Legacy CLI operational errors use stderr, unlike successful --json reports.
pub fn refusal(observation: &Observation, code: &str) -> Result<(), String> {
    if observation.code != Some(1)
        || observation.timed_out
        || observation.output_exceeded
        || !observation.stderr.contains(&format!("[{code}]"))
    {
        return Err(format!(
            "expected operational refusal {code}, observed {:?}: {}",
            observation.code, observation.stderr
        ));
    }
    Ok(())
}

pub fn verify(observation: &Observation, paths: &[&str], verdict: &str) -> Result<Value, String> {
    let value = json(observation, if verdict == "BLOCK" { 3 } else { 0 })?;
    let changed: BTreeSet<_> = value["changedFiles"]
        .as_array()
        .ok_or("missing changedFiles")?
        .iter()
        .map(|p| p.as_str().ok_or("invalid changed path"))
        .collect::<Result<_, _>>()?;
    if changed != paths.iter().copied().collect() {
        return Err("changed-file identity mismatch".into());
    }
    let findings = value["findings"].as_array().ok_or("missing findings")?;
    let blocks = findings.iter().filter(|f| f["severity"] == "block").count();
    let warns = findings.iter().filter(|f| f["severity"] == "warn").count();
    let computed = if blocks > 0 {
        "BLOCK"
    } else if warns > 0 {
        "WARN"
    } else {
        "PASS"
    };
    if value["verdict"] != verdict
        || computed != verdict
        || value["summary"]["blockCount"] != blocks
        || value["summary"]["warnCount"] != warns
        || value["head"] != "HEAD"
        || !value.get("base").is_some_and(Value::is_null)
        || !value.get("range").is_some_and(Value::is_null)
        || !value.get("mergeBase").is_some_and(Value::is_null)
    {
        return Err("incomplete or inconsistent verify report".into());
    }
    Ok(value)
}

pub fn validate_report(report: &Report) -> Result<(), String> {
    let actual: BTreeSet<_> = report.cases.iter().map(|c| c.id.as_str()).collect();
    if report.schema_version != 1
        || lane_host_os(&report.os) != Some(report.host_os.as_str())
        || report.host_arch != report.arch
        || report.host_arch.is_empty()
        || report.adapter != report.runtime.adapter()
        || actual != CASES.iter().copied().collect()
        || actual.len() != report.cases.len()
        || report.host_activation != "not_observed"
        || report.artifacts.len() < if report.runtime.kind() == "bun" { 3 } else { 2 }
        || report.artifacts.iter().any(|a| a.sha256.len() != 64)
        || report.cases.iter().any(|c| {
            c.obligations.is_empty()
                || c.observations.is_empty()
                || !["useful_success", "controlled_refusal", "failure"]
                    .contains(&c.outcome.as_str())
        })
    {
        return Err("report missing obligations, identities or required cases".into());
    }
    if let Runtime::Bun { version, .. } = &report.runtime
        && version != "1.4.3"
    {
        return Err("unqualified Bun runtime version".into());
    }
    for identity in report.runtime.identities() {
        if !report
            .artifacts
            .iter()
            .any(|a| a.path == identity.path && a.sha256 == identity.sha256)
        {
            return Err("runtime identity absent from artifact inventory".into());
        }
    }
    for case in &report.cases {
        if case.outcome == "failure" {
            continue;
        }
        let expected_support = match case.id.as_str() {
            "cli.partial-coverage" => "partial",
            "cli.missing-index" | "cli.invalid-config" => "unsupported",
            _ => "supported",
        };
        let expected_outcome = if ["cli.missing-index", "cli.invalid-config", "cli.stale"]
            .contains(&case.id.as_str())
        {
            "controlled_refusal"
        } else {
            "useful_success"
        };
        if case.support_status != expected_support
            || case.outcome != expected_outcome
            || case.obligations != vec![case.id.clone()]
        {
            return Err("case promotion or obligation mismatch".into());
        }
    }
    if report.status
        != if report.cases.iter().all(|c| c.outcome != "failure") {
            "qualified"
        } else {
            "failed"
        }
    {
        return Err("report status contradicts observations".into());
    }
    Ok(())
}

/// Absence needs a well-formed empty response to the exact symbol query.
pub fn symbol_absent(value: &Value, name: &str) -> bool {
    value["kind"] == "symbol"
        && value["query"] == name
        && value["matchedNodes"].as_array().is_some_and(Vec::is_empty)
}

fn raw_field(value: &Value, path: &str, expected: Value) -> Result<(), String> {
    if value.pointer(path) == Some(&expected) {
        Ok(())
    } else {
        Err(format!("raw oracle {path}: expected {expected}"))
    }
}
fn raw_symbol(value: &Value, name: &str) -> bool {
    value["matchedNodes"]
        .as_array()
        .is_some_and(|a| a.iter().any(|n| n["name"] == name))
}

fn validate_raw_cli_case(id: &str, raw: &Value) -> Result<(), String> {
    use serde_json::json as j;
    let ob: Observation =
        serde_json::from_value(raw["observation"].clone()).map_err(|e| e.to_string())?;
    match id {
        "cli.missing-index" => refusal(&ob, "REPO_NOT_INDEXED"),
        "cli.invalid-config" => refusal(&ob, "CONFIG_INVALID"),
        "cli.benign" => verify(&ob, &["src/symbol.ts"], "PASS").map(|_| ()),
        "cli.contract-risk" => {
            let value = verify(&ob, &["src/cart.ts"], "WARN")?;
            if value["findings"].as_array().is_some_and(|a| {
                a.iter().any(|f| {
                    f["rule"] == "contract_changed_without_test" && f["severity"] == "warn"
                })
            }) {
                Ok(())
            } else {
                Err("missing raw risk discriminant".into())
            }
        }
        "cli.setup" => raw_field(&json(&ob, 0)?, "/setupReady", j!(true)),
        "cli.repaired" => raw_field(&json(&ob, 0)?, "/verdict", j!("FRESH")),
        "cli.stale" => {
            let value = json(&ob, 3)?;
            raw_field(&value, "/verdict", j!("UNSEALED"))?;
            raw_field(&value, "/canRunHighRiskControl", j!(false))?;
            if value["explanation"].as_array().is_some_and(|a| {
                a.iter().any(|r| {
                    r["code"] == "EVIDENCE_BASELINE_STALE" && r["remedy"] == "semctx index --record"
                })
            }) {
                Ok(())
            } else {
                Err("missing exact stale evidence reason".into())
            }
        }
        "cli.partial-coverage" => {
            let value = json(&ob, 0)?;
            raw_field(&value, "/setupReady", j!(true))?;
            raw_field(&value, "/indexHealth/coverage/status", j!("partial"))?;
            raw_field(&value, "/selection/selectedByLanguage/python", j!(1))?;
            if value["indexHealth"]["reasonSummary"]
                .as_array()
                .is_some_and(|a| a.contains(&j!("NEGATIVE_COMPLETENESS_MISSING")))
            {
                Ok(())
            } else {
                Err("missing partial limitation".into())
            }
        }
        _ => Err("unknown CLI oracle".into()),
    }
}

fn validate_raw_mcp_case(id: &str, raw: &Value) -> Result<(), String> {
    use serde_json::json as j;
    match id {
        "mcp.initialize" => {
            if raw["protocolVersion"].is_string() && raw["serverInfo"]["name"].is_string() {
                Ok(())
            } else {
                Err("invalid MCP negotiation".into())
            }
        }
        "mcp.tools" => {
            if [
                "semctx_inspect",
                "semctx_control_status",
                "semctx_index_health",
            ]
            .iter()
            .all(|name| {
                raw["tools"]
                    .as_array()
                    .is_some_and(|a| a.iter().any(|t| t["name"] == *name))
            }) {
                Ok(())
            } else {
                Err("missing MCP tools".into())
            }
        }
        "mcp.control-status" => {
            raw_field(raw, "/verdict", j!("FRESH"))?;
            raw_field(raw, "/canRunHighRiskControl", j!(true))
        }
        "mcp.inspect" => {
            if raw_symbol(&raw["inspect"], "oldSymbol") {
                raw_field(raw, "/health/binding/status", j!("valid"))
            } else {
                Err("old symbol absent".into())
            }
        }
        "mcp.refresh" => {
            if symbol_absent(&raw["old"], "oldSymbol")
                && raw_symbol(&raw["new"], "newSymbol")
                && raw["pid"].as_u64().is_some()
            {
                raw_field(raw, "/health/binding/status", j!("valid"))
            } else {
                Err("MCP refresh absent".into())
            }
        }
        _ => Err("unknown MCP oracle".into()),
    }
}

/// Re-evaluate observations during aggregate admission: a producer's green label is insufficient.
pub fn validate_raw_case(id: &str, raw: &Value) -> Result<(), String> {
    if id.starts_with("cli.") {
        validate_raw_cli_case(id, raw)
    } else {
        validate_raw_mcp_case(id, raw)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn observed(code: i32, stdout: &str, stderr: &str) -> Observation {
        Observation {
            code: Some(code),
            timed_out: false,
            output_exceeded: false,
            duration_ms: 1,
            stdout: stdout.into(),
            stderr: stderr.into(),
        }
    }
    #[test]
    fn refresh_refuses_missing_or_malformed_old_symbol_evidence() {
        for old in [
            serde_json::Value::Null,
            serde_json::json!({}),
            serde_json::json!({"kind":"symbol","query":"oldSymbol","matchedNodes":null}),
            serde_json::json!({"kind":"symbol","query":"differentQuery","matchedNodes":[]}),
        ] {
            let raw = serde_json::json!({"old":old,"new":{"matchedNodes":[{"name":"newSymbol"}]},"pid":1,"health":{"binding":{"status":"valid"}}});
            assert!(
                validate_raw_case("mcp.refresh", &raw).is_err(),
                "malformed old-symbol observation admitted: {raw}"
            );
        }
    }
    #[test]
    fn refusal_requires_exact_reason_and_exit() {
        assert!(
            refusal(
                &observed(1, "", "[REPO_NOT_INDEXED] missing"),
                "REPO_NOT_INDEXED"
            )
            .is_ok()
        );
        assert!(
            refusal(
                &observed(1, "", "[CONFIG_INVALID] invalid"),
                "REPO_NOT_INDEXED"
            )
            .is_err()
        );
        assert!(
            refusal(
                &observed(0, "", "[REPO_NOT_INDEXED] missing"),
                "REPO_NOT_INDEXED"
            )
            .is_err()
        );
        assert!(
            refusal(
                &observed(139, "", "[REPO_NOT_INDEXED] crash"),
                "REPO_NOT_INDEXED"
            )
            .is_err()
        );
    }
    #[test]
    fn malformed_and_truncated_json_is_rejected() {
        for input in ["", "{", "{}\n{}", "{} trailing"] {
            assert!(json(&observed(0, input, ""), 0).is_err());
        }
    }
    #[test]
    fn missing_verify_fields_are_rejected() {
        assert!(verify(&observed(0, "{}", ""), &[], "PASS").is_err());
    }
    #[test]
    fn missing_case_report_is_rejected() {
        let report = Report {
            schema_version: 1,
            status: "qualified".into(),
            os: "test".into(),
            arch: "test".into(),
            host_os: "test".into(),
            host_arch: "test".into(),
            adapter: "test".into(),
            runtime: Runtime::Bun {
                identity: Artifact {
                    path: PathBuf::from("/bun"),
                    sha256: "a".repeat(64),
                },
                version: "1.4.3".into(),
            },
            artifacts: vec![],
            cases: vec![],
            host_activation: "not_observed".into(),
            limitations: vec![],
        };
        assert!(validate_report(&report).is_err());
        assert!(serde_json::from_str::<Report>("{\"schema_version\":1}").is_err());
    }
    #[test]
    #[ignore]
    fn helper_child() {
        std::thread::sleep(std::time::Duration::from_secs(5));
    }
    #[test]
    fn actual_child_timeout_is_not_a_refusal() {
        // Self-hosted Rust helper works on all CI targets without a shell or Bun.
        let mut cmd = std::process::Command::new(std::env::current_exe().unwrap());
        cmd.args(["--ignored", "--exact", "tests::helper_child", "--nocapture"]);
        let observation = process::run(
            &mut cmd,
            &std::env::current_dir().unwrap(),
            std::time::Duration::from_millis(100),
        )
        .unwrap();
        assert!(observation.timed_out);
        assert!(refusal(&observation, "REPO_NOT_INDEXED").is_err());
    }
    #[test]
    #[ignore]
    fn helper_flood() {
        use std::io::Write;
        let _ = std::io::stdout().write_all(&vec![b'x'; process::LIMIT as usize + 1024]);
    }
    #[test]
    #[ignore]
    #[allow(clippy::zombie_processes)]
    fn helper_orphan() {
        // Deliberately leave an inherited stdout pipe open after this direct child exits.
        // The supervisor's process tree ownership, rather than this fixture, must close it.
        std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--ignored", "--exact", "tests::helper_child", "--nocapture"])
            .spawn()
            .unwrap();
    }
    #[test]
    fn actual_child_output_is_bounded() {
        let mut command = std::process::Command::new(std::env::current_exe().unwrap());
        command.args(["--ignored", "--exact", "tests::helper_flood", "--nocapture"]);
        let observation = process::run(
            &mut command,
            &std::env::current_dir().unwrap(),
            process::BUDGET,
        )
        .unwrap();
        assert!(observation.output_exceeded);
        assert!(json(&observation, 0).is_err());
    }
    #[test]
    fn direct_child_exit_cannot_leave_inherited_pipes_hanging() {
        let mut command = std::process::Command::new(std::env::current_exe().unwrap());
        command.args([
            "--ignored",
            "--exact",
            "tests::helper_orphan",
            "--nocapture",
        ]);
        let start = std::time::Instant::now();
        let observation = process::run(
            &mut command,
            &std::env::current_dir().unwrap(),
            process::BUDGET,
        )
        .unwrap();
        assert_eq!(observation.code, Some(0));
        assert!(start.elapsed() < std::time::Duration::from_secs(4));
    }
    #[test]
    fn native_adapter_executes_rust_fixture_without_interpreter_prefix() {
        let fixture = std::env::current_exe().unwrap();
        let native = Runtime::select(Path::new("native"), &fixture, &fixture).unwrap();
        let mut command = native.command(&fixture);
        command.arg("--list");
        assert_eq!(command.get_program(), fixture.as_os_str());
        assert_eq!(
            command.get_args().collect::<Vec<_>>(),
            vec![std::ffi::OsStr::new("--list")]
        );
        let observed = process::run(
            &mut command,
            &std::env::current_dir().unwrap(),
            process::BUDGET,
        )
        .unwrap();
        assert_eq!(observed.code, Some(0));
        assert!(
            observed
                .stdout
                .contains("native_adapter_executes_rust_fixture")
        );
        let encoded = serde_json::to_value(&native).unwrap();
        assert_eq!(encoded["kind"], "native");
        assert!(encoded.get("version").is_none());
    }
    #[test]
    fn bun_adapter_preserves_explicit_interpreter_prefix() {
        let fixture = std::env::current_exe().unwrap();
        let bun = Runtime::select(&fixture, &fixture, &fixture).unwrap();
        let entry = Path::new("product-entry.js");
        let mut command = bun.command(entry);
        command.arg("--json");
        assert_eq!(
            command.get_args().collect::<Vec<_>>(),
            vec![entry.as_os_str(), std::ffi::OsStr::new("--json")]
        );
        let Runtime::Bun { identity, .. } = bun else {
            panic!("expected Bun")
        };
        assert_eq!(command.get_program(), identity.path.as_os_str());
    }
    #[test]
    fn native_adapter_rejects_script_and_relative_runtime_modes() {
        let root = tempfile::tempdir().unwrap();
        let script = root.path().join("entry.js");
        fs::write(&script, "// interpreter source").unwrap();
        assert!(Runtime::select(Path::new("native"), &script, &script).is_err());
        assert!(Runtime::select(Path::new("bun"), &script, &script).is_err());
        assert!(serde_json::from_value::<Runtime>(serde_json::json!({"kind":"node"})).is_err());
        assert!(
            serde_json::from_value::<Runtime>(
                serde_json::json!({"kind":"native","version":"1.4.3"})
            )
            .is_err()
        );
    }
}
