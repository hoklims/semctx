//! Owned fixture preparation only. This binary is called by the approved
//! controller; its environment is a trusted runner boundary, not OS isolation.
#[path = "../../rust-ts-r0/qualification/windows-lifecycle/owned_git.rs"]
mod owned_git;

use owned_git::{ArtifactPin, GitStep, NativeGit};
use serde::Deserialize;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Pin {
    path: PathBuf,
    sha256: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Runtime {
    git: Pin,
    helper: Pin,
    executor: Pin,
    system_root: PathBuf,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Fixture {
    key: String,
    files: BTreeMap<String, String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    schema: u8,
    product_sha: String,
    authority: BTreeMap<String, String>,
    runtime: Runtime,
    output: PathBuf,
    fixtures: Vec<Fixture>,
}

fn digest(raw: &[u8]) -> String {
    format!("{:x}", Sha256::digest(raw))
}
fn require(ok: bool, message: &str) -> Result<(), String> {
    if ok { Ok(()) } else { Err(message.into()) }
}
fn write(path: &Path, raw: &[u8]) -> Result<(), String> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|e| e.to_string())?;
    file.write_all(raw).map_err(|e| e.to_string())?;
    file.sync_all().map_err(|e| e.to_string())
}
fn seal_observation(
    output: &Path,
    label: &str,
    observed: &owned_git::GitObservation,
) -> Result<(), String> {
    let raw = &observed.capture;
    write(&output.join(format!("{label}.stdout")), &raw.stdout)?;
    write(&output.join(format!("{label}.stderr")), &raw.stderr)?;
    let accepted = observed.step_accepted && raw.complete_capture && raw.owned_tree_quiescent;
    let record = json!({"argv":observed.argv,"cwd":observed.cwd,"exit_code":raw.exit_code,
        "timed_out":raw.timed_out,"complete_capture":raw.complete_capture && raw.owned_tree_quiescent,
        "observation_reported_complete":raw.complete_capture,
        "owned_tree_quiescent":raw.owned_tree_quiescent,"output_exceeded":raw.output_exceeded,
        "elapsed_ms":raw.duration_ms,"stdout_sha256":digest(&raw.stdout),
        "stderr_sha256":digest(&raw.stderr),"pins_unchanged":observed.pins_unchanged,"step_accepted":accepted});
    write(
        &output.join(format!("{label}.json")),
        record.to_string().as_bytes(),
    )?;
    require(
        accepted,
        "Git fixture step refused; preserve raw evidence, no complete result or upload",
    )
}
fn collect(request: Request) -> Result<(), String> {
    require(cfg!(windows), "native collector requires Windows")?;
    require(
        std::env::var("GITHUB_ACTIONS").as_deref() == Ok("true"),
        "approved Actions runner required",
    )?;
    require(
        request.schema == 1 && request.product_sha == "04b83a5f394431e1dcca533889f6c02e32d02a0d",
        "product/schema differs",
    )?;
    for (key, variable) in [
        ("workflow_sha", "WINDOWS_APPROVED_WORKFLOW_SHA"),
        ("collector_sha", "WINDOWS_APPROVED_COLLECTOR_SHA"),
        (
            "prior_review_sha256",
            "WINDOWS_APPROVED_PRIOR_REVIEW_SHA256",
        ),
    ] {
        let approved = std::env::var(variable).map_err(|_| "protected approval absent")?;
        require(
            !approved.is_empty() && request.authority.get(key) == Some(&approved),
            "protected approval differs",
        )?;
    }
    require(
        request.fixtures.len() == 23
            && request
                .fixtures
                .iter()
                .map(|f| f.files.len())
                .sum::<usize>()
                == 70,
        "fixture denominator differs",
    )?;
    let root = Path::new(r"D:\r");
    require(
        request.output.is_absolute() && !request.output.starts_with(root),
        "output path differs",
    )?;
    require(
        digest(&fs::read(&request.runtime.executor.path).map_err(|e| e.to_string())?)
            == request.runtime.executor.sha256,
        "executor changed",
    )?;
    fs::create_dir(&request.output).map_err(|e| e.to_string())?;
    fs::create_dir(root).map_err(|e| e.to_string())?;
    let native = NativeGit {
        git: ArtifactPin {
            path: &request.runtime.git.path,
            sha256: &request.runtime.git.sha256,
        },
        supervisor: ArtifactPin {
            path: &request.runtime.helper.path,
            sha256: &request.runtime.helper.sha256,
        },
        system: &request.runtime.system_root,
    };
    let steps = [
        ("git-version", GitStep::Version),
        ("git-setup-0", GitStep::Init),
        ("git-fixture-autocrlf-set", GitStep::SetAutocrlf),
        ("git-fixture-autocrlf-read", GitStep::ReadAutocrlf),
        ("git-fixture-safecrlf-set", GitStep::SetSafecrlf),
        ("git-fixture-safecrlf-read", GitStep::ReadSafecrlf),
        ("git-setup-1", GitStep::Add),
        ("git-setup-2", GitStep::Commit),
    ];
    let mut commands = 0;
    for fixture in request.fixtures {
        let files = fixture
            .files
            .into_iter()
            .map(|(k, v)| (k, v.into_bytes()))
            .collect();
        let cwd = owned_git::stage_fixture(root, &fixture.key, &files)?;
        let output = request.output.join(&fixture.key);
        fs::create_dir(&output).map_err(|e| e.to_string())?;
        for (label, step) in steps {
            let observed = native.observe(&fixture.key, step)?;
            require(observed.cwd == cwd, "observed fixture cwd differs")?;
            seal_observation(&output, label, &observed)?;
            commands += usize::from(label != "git-version");
        }
    }
    require(commands == 161, "Git command denominator differs")?;
    write(
        &request.output.join("RESULT.json"),
        json!({"state":"WINDOWS_GIT_FIXTURES_CAPTURED",
        "fixture_groups":23,"initial_files":70,"git_commands":commands,"candidate_queries":0,
        "qualification_credit":0,"native_quiescence":"KERNEL_OWNED_TREE_EMPTY_EACH_STEP"})
        .to_string()
        .as_bytes(),
    )
}
fn run() -> Result<(), String> {
    let args: Vec<_> = std::env::args().collect();
    require(
        args.len() == 2,
        "expected one approved prepared request path",
    )?;
    let raw = fs::read(&args[1]).map_err(|e| e.to_string())?;
    require(
        std::env::var("WINDOWS_COLLECTOR_REQUEST_SHA256")
            .ok()
            .as_deref()
            == Some(digest(&raw).as_str()),
        "prepared request dispatch binding differs",
    )?;
    let request: Request = serde_json::from_slice(&raw).map_err(|e| e.to_string())?;
    collect(request)
}
fn main() {
    if let Err(error) = run() {
        eprintln!("{}", json!({"error":error}));
        std::process::exit(2);
    }
}

#[cfg(test)]
mod publication_tests {
    use super::*;
    #[test]
    fn unknown_quiescence_cannot_seal_complete_evidence() {
        let output =
            std::env::temp_dir().join(format!("windows-seal-negative-{}", std::process::id()));
        fs::create_dir(&output).unwrap();
        let observation = owned_git::GitObservation {
            argv: vec!["synthetic-git".into()],
            cwd: output.clone(),
            capture: owned_git::Observed {
                exit_code: Some(0),
                complete_capture: true,
                owned_tree_quiescent: false,
                ..Default::default()
            },
            pins_unchanged: true,
            step_accepted: true,
        };
        let result = seal_observation(&output, "step", &observation);
        assert!(result.is_err());
        let receipt: serde_json::Value =
            serde_json::from_slice(&fs::read(output.join("step.json")).unwrap()).unwrap();
        assert_eq!(receipt["step_accepted"], false);
        assert_eq!(receipt["complete_capture"], false);
        assert!(!output.join("RESULT.json").exists());
        fs::remove_dir_all(output).unwrap();
    }
}
