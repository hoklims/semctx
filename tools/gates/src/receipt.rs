use crate::{
    Result, digest,
    plan::{Lane, Plan, Subject},
    process::{self, Outcome},
};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeSet, path::Path};

pub const STEP_BUDGET_MS: u64 = 45 * 60 * 1000;
pub const OUTPUT_CAP: usize = 1024 * 1024;
const TEST_OUTPUT_CAP: usize = 16 * 1024 * 1024;
const ROUTING: &[&str] = &[
    "scripts/test/ci-plan.test.ts",
    "scripts/test/ci-gate.test.ts",
    "scripts/test/governance-files.test.ts",
    "scripts/test/rust-gates-wiring.test.ts",
    "scripts/test/index-routing-inventory.test.ts",
    "scripts/test/rust-prerequisites.test.ts",
];
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Action {
    pub label: String,
    pub argv: Vec<String>,
    pub timeout_ms: u64,
    pub output_cap: usize,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Step {
    pub action: Action,
    pub outcome: Outcome,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Receipt {
    pub schema: u32,
    pub receipt_id: String,
    pub plan_id: String,
    pub subject: Subject,
    pub lane: Lane,
    pub host_os: String,
    pub host_arch: String,
    pub status: String,
    pub error: Option<String>,
    pub steps: Vec<Step>,
}
fn action(label: &str, args: &[&str]) -> Action {
    Action {
        label: label.into(),
        argv: args.iter().map(|x| (*x).to_owned()).collect(),
        timeout_ms: STEP_BUDGET_MS,
        output_cap: OUTPUT_CAP,
    }
}
/// Local full verification also owns the native checks that CI runs in its native OS jobs.
pub fn local_verification(
    base: &str,
    skip_diff: bool,
    shard: &str,
    gate: &str,
    root: &str,
) -> Vec<Action> {
    let mut actions = verification(base, skip_diff, shard);
    for manifest in ["tools/gates/Cargo.toml", "tools/qualification/Cargo.toml"] {
        actions.extend([
            action(
                "Rust formatting",
                &["cargo", "fmt", "--manifest-path", manifest, "--check"],
            ),
            action(
                "Rust lints",
                &[
                    "cargo",
                    "clippy",
                    "--manifest-path",
                    manifest,
                    "--locked",
                    "--all-targets",
                    "--",
                    "-D",
                    "warnings",
                ],
            ),
            action(
                "Rust tests",
                &["cargo", "test", "--manifest-path", manifest, "--locked"],
            ),
        ]);
    }
    actions.push(action(
        "native product tests",
        &[gate, "rust-test", "--root", root],
    ));
    actions
}
pub fn verification(base: &str, skip_diff: bool, shard: &str) -> Vec<Action> {
    let mut actions = vec![];
    if !skip_diff {
        actions.push(action(
            "diff hygiene",
            &["git", "diff", "--check", &format!("{base}...HEAD")],
        ));
        actions.push(action(
            "staged hygiene",
            &["git", "diff", "--cached", "--check"],
        ));
        actions.push(action("unstaged hygiene", &["git", "diff", "--check"]));
    }
    actions.extend([
        action("compatibility", &["bun", "scripts/compatibility.ts"]),
        action(
            "documentation",
            &["bun", "scripts/documentation-integrity.ts"],
        ),
        action("quality", &["bun", "run", "quality"]),
        action(
            "Python compileall",
            &[
                "python",
                "-m",
                "compileall",
                "-q",
                "benchmarks/change-impact-eval/scripts",
            ],
        ),
        action(
            "Python smoke",
            &[
                "python",
                "benchmarks/change-impact-eval/scripts/smoke_test.py",
            ],
        ),
        action(
            "index routing regressions",
            &["python", "scripts/verify-index-routing.py"],
        ),
        action("plugin parity", &["bun", "run", "plugin:check"]),
    ]);
    let mut tests = action("tests", &["bun", "run", "test"]);
    tests.output_cap = TEST_OUTPUT_CAP;
    if !shard.is_empty() {
        tests.argv.extend([
            format!("--shard={shard}"),
            "--timings=scripts/ci-test-timings.json".into(),
        ]);
    }
    actions.push(tests);
    actions
}
fn valid_shard(lane: &Lane) -> bool {
    if lane.shard.is_empty() {
        return true;
    }
    let Some((index, count)) = lane.shard.split_once('/') else {
        return false;
    };
    let (Ok(index), Ok(count)) = (index.parse::<usize>(), count.parse::<usize>()) else {
        return false;
    };
    index > 0 && index <= count && count == if lane.os == "windows-latest" { 4 } else { 2 }
}
pub fn commands(lane: &Lane, base: &str) -> Result<Vec<Action>> {
    if !["ubuntu-latest", "windows-latest", "macos-15"].contains(&lane.os.as_str())
        || !["true", "false"].contains(&lane.smoke.as_str())
        || !valid_shard(lane)
    {
        return Err("invalid lane".into());
    }
    let first_shard = lane.shard.is_empty() || lane.shard.starts_with("1/");
    let mut actions = match lane.profile.as_str() {
        "contract" => {
            if lane.os != "ubuntu-latest"
                || !lane.targets.is_empty()
                || lane.smoke != "false"
                || !lane.shard.is_empty()
            {
                return Err("invalid contract lane".into());
            }
            let mut a = vec![
                action(
                    "diff hygiene",
                    &["git", "diff", "--check", &format!("{base}...HEAD")],
                ),
                action("compatibility", &["bun", "scripts/compatibility.ts"]),
                action(
                    "documentation",
                    &["bun", "scripts/documentation-integrity.ts"],
                ),
                action("quality", &["bun", "run", "quality"]),
            ];
            let mut routing = action(
                "routing regressions",
                &["bun", "test", "--timeout", "60000"],
            );
            routing.argv.extend(ROUTING.iter().map(|s| (*s).to_owned()));
            a.push(routing);
            a
        }
        "full" => {
            if !lane.targets.is_empty() {
                return Err("full lane has targets".into());
            }
            // The contract lane owns quality/documentation/hygiene once. Runtime integration
            // checks run once per OS; the union of shards preserves the complete test suite.
            verification(base, true, &lane.shard)
                .into_iter()
                .filter(|a| {
                    a.label == "tests"
                        || (first_shard
                            && !["compatibility", "documentation", "quality"]
                                .contains(&a.label.as_str()))
                })
                .collect()
        }
        "focused" => {
            if lane.os == "ubuntu-latest" {
                return Err("focused lane must be cross-platform".into());
            }
            let targets = lane.targets.split(',').collect::<Vec<_>>();
            if targets.is_empty()
                || targets.iter().any(|s| {
                    s.is_empty()
                        || s.starts_with('-')
                        || s.contains(['\\', '\n', '\r'])
                        || s.split('/').any(|p| p == "..")
                })
            {
                return Err("invalid focused targets".into());
            }
            let mut a = action(
                "affected cross-platform tests",
                &["bun", "test", "--timeout", "60000"],
            );
            a.output_cap = TEST_OUTPUT_CAP;
            if !lane.shard.is_empty() {
                a.argv.extend([
                    format!("--shard={}", lane.shard),
                    "--timings=scripts/ci-test-timings.json".into(),
                ]);
            }
            a.argv.extend(targets.iter().map(|s| (*s).to_owned()));
            let mut actions = vec![a];
            if targets.contains(&"plugins") && first_shard {
                actions.extend([
                    action("plugin parity", &["bun", "run", "plugin:check"]),
                    action(
                        "index routing regressions",
                        &["python", "scripts/verify-index-routing.py"],
                    ),
                ]);
            }
            actions
        }
        _ => return Err("unknown lane profile".into()),
    };
    if lane.smoke == "true" && first_shard {
        actions.push(action(
            "worker equivalence smoke",
            &["bun", "run", "bench:index-workers", "4", "2"],
        ));
    }
    Ok(actions)
}
pub fn expected_os(lane: &Lane) -> &str {
    match lane.os.as_str() {
        "ubuntu-latest" => "linux",
        "windows-latest" => "windows",
        "macos-15" => "macos",
        _ => "unknown",
    }
}
fn seal(receipt: &mut Receipt) -> Result<()> {
    receipt.receipt_id.clear();
    receipt.receipt_id = digest(serde_json::to_vec(receipt).map_err(|error| error.to_string())?);
    Ok(())
}
pub fn execute(root: &Path, plan: &Plan, index: usize) -> Receipt {
    let lane = plan
        .matrix
        .include
        .get(index)
        .cloned()
        .unwrap_or_else(|| Lane {
            index,
            id: "invalid".into(),
            os: "unknown".into(),
            profile: String::new(),
            targets: String::new(),
            smoke: "false".into(),
            shard: String::new(),
        });
    let mut receipt = Receipt {
        schema: 1,
        receipt_id: String::new(),
        plan_id: plan.plan_id.clone(),
        subject: plan.subject.clone(),
        lane,
        host_os: std::env::consts::OS.into(),
        host_arch: std::env::consts::ARCH.into(),
        status: "failed".into(),
        error: None,
        steps: vec![],
    };
    let result = (|| {
        crate::plan::validate(root, plan)?;
        if index >= plan.matrix.include.len() {
            return Err("lane index out of bounds".into());
        }
        if receipt.host_os != expected_os(&receipt.lane) {
            return Err("runner OS does not match planned lane".into());
        }
        for action in commands(&receipt.lane, &plan.subject.base)? {
            if process::interactive_progress() {
                eprintln!("[semctx-gates] START {}", action.label);
            }
            let outcome =
                process::run_logged(&action.argv, root, action.timeout_ms, action.output_cap)
                    .unwrap_or_else(|error| Outcome {
                        kind: "infrastructure_error".into(),
                        exit_code: None,
                        duration_ms: 0,
                        stdout: String::new(),
                        stderr: error.to_string(),
                        stdout_bytes: 0,
                        stderr_bytes: error.to_string().len() as u64,
                        stdout_hash: digest(""),
                        stderr_hash: digest(error.to_string()),
                    });
            let passed = outcome.kind == "success" && outcome.exit_code == Some(0);
            receipt.steps.push(Step { action, outcome });
            if !passed {
                return Err("step did not succeed".into());
            }
        }
        crate::plan::validate(root, plan)?;
        Ok(())
    })();
    match result {
        Ok(()) => receipt.status = "passed".into(),
        Err(e) => receipt.error = Some(e),
    }
    if let Err(error) = seal(&mut receipt) {
        receipt.status = "failed".into();
        receipt.error = Some(error);
    }
    receipt
}
pub fn admit(plan: &Plan, receipts: &[Receipt]) -> Result<()> {
    if plan.schema != 1 || receipts.len() != plan.matrix.include.len() {
        return Err("missing or extra lane receipts".into());
    }
    let mut seen = BTreeSet::new();
    for receipt in receipts {
        let lane = plan
            .matrix
            .include
            .iter()
            .find(|l| l.id == receipt.lane.id)
            .ok_or("foreign receipt lane")?;
        let mut expected = receipt.clone();
        seal(&mut expected)?;
        if &expected != receipt || !seen.insert(lane.id.clone()) {
            return Err("tampered or duplicate receipt".into());
        }
        if receipt.schema != 1
            || receipt.plan_id != plan.plan_id
            || receipt.subject != plan.subject
            || &receipt.lane != lane
            || receipt.host_os != expected_os(lane)
            || receipt.host_arch.is_empty()
            || receipt.status != "passed"
            || receipt.error.is_some()
        {
            return Err("foreign identity or failed lane".into());
        }
        let actions = commands(lane, &plan.subject.base)?;
        if receipt.steps.len() != actions.len() {
            return Err("missing or skipped steps".into());
        }
        for (step, action) in receipt.steps.iter().zip(actions) {
            let outcome = &step.outcome;
            if step.action != action
                || outcome.kind != "success"
                || outcome.exit_code != Some(0)
                || outcome.duration_ms > action.timeout_ms
                || outcome.stdout_bytes != outcome.stdout.len() as u64
                || outcome.stderr_bytes != outcome.stderr.len() as u64
                || outcome.stdout.len() > action.output_cap
                || outcome.stderr.len() > action.output_cap
                || outcome.stdout_hash != digest(&outcome.stdout)
                || outcome.stderr_hash != digest(&outcome.stderr)
            {
                return Err("invalid step result or trace digest".into());
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (Plan, Vec<Receipt>) {
        let lane = Lane {
            index: 0,
            id: "contract".into(),
            os: "ubuntu-latest".into(),
            profile: "contract".into(),
            targets: String::new(),
            smoke: "false".into(),
            shard: String::new(),
        };
        let subject = Subject {
            base: "base".into(),
            head: "head".into(),
            tree: "tree".into(),
            policy_hash: "policy".into(),
        };
        let plan = Plan {
            schema: 1,
            plan_id: "plan".into(),
            subject: subject.clone(),
            mode: "docs".into(),
            reason: "test".into(),
            paths: vec![],
            matrix: crate::plan::Matrix {
                include: vec![lane.clone()],
            },
        };
        let steps = commands(&lane, "base")
            .unwrap()
            .into_iter()
            .map(|action| Step {
                action,
                outcome: Outcome {
                    kind: "success".into(),
                    exit_code: Some(0),
                    duration_ms: 1,
                    stdout: "ok".into(),
                    stderr: String::new(),
                    stdout_bytes: 2,
                    stderr_bytes: 0,
                    stdout_hash: digest("ok"),
                    stderr_hash: digest(""),
                },
            })
            .collect();
        let mut receipt = Receipt {
            schema: 1,
            receipt_id: String::new(),
            plan_id: "plan".into(),
            subject,
            lane,
            host_os: "linux".into(),
            host_arch: "x86_64".into(),
            status: "passed".into(),
            error: None,
            steps,
        };
        seal(&mut receipt).unwrap();
        (plan, vec![receipt])
    }
    #[test]
    fn admits_complete_receipts() {
        let (p, r) = fixture();
        assert!(admit(&p, &r).is_ok());
    }
    #[test]
    fn rejects_missing() {
        let (p, _) = fixture();
        assert!(admit(&p, &[]).unwrap_err().contains("missing"));
    }
    #[test]
    fn rejects_duplicate() {
        let (mut p, mut r) = fixture();
        p.matrix.include.push(p.matrix.include[0].clone());
        r.push(r[0].clone());
        assert!(admit(&p, &r).unwrap_err().contains("duplicate"));
    }
    #[test]
    fn rejects_foreign_subject_even_resealed() {
        let (p, mut r) = fixture();
        r[0].subject.head = "other".into();
        seal(&mut r[0]).unwrap();
        assert!(admit(&p, &r).unwrap_err().contains("identity"));
    }
    #[test]
    fn rejects_failed_even_resealed() {
        let (p, mut r) = fixture();
        r[0].status = "failed".into();
        seal(&mut r[0]).unwrap();
        assert!(admit(&p, &r).is_err());
    }
    #[test]
    fn rejects_truncated_steps_even_resealed() {
        let (p, mut r) = fixture();
        r[0].steps.pop();
        seal(&mut r[0]).unwrap();
        assert!(admit(&p, &r).unwrap_err().contains("skipped"));
    }
    #[test]
    fn rejects_tamper() {
        let (p, mut r) = fixture();
        r[0].steps[0].outcome.stdout = "modified".into();
        assert!(admit(&p, &r).unwrap_err().contains("tampered"));
    }
    #[test]
    fn rejects_bad_trace_hash_even_resealed() {
        let (p, mut r) = fixture();
        r[0].steps[0].outcome.stdout = "no".into();
        seal(&mut r[0]).unwrap();
        assert!(admit(&p, &r).unwrap_err().contains("digest"));
    }
    #[test]
    fn rejects_timeout_masquerading_as_success() {
        let (p, mut r) = fixture();
        r[0].steps[0].outcome.kind = "timeout".into();
        seal(&mut r[0]).unwrap();
        assert!(admit(&p, &r).is_err());
    }
    #[test]
    fn local_full_verification_executes_native_tooling_and_product_discovery() {
        let actions = local_verification("base", false, "", "gate-binary", "source-root");
        for operation in ["fmt", "clippy", "test"] {
            for manifest in ["tools/gates/Cargo.toml", "tools/qualification/Cargo.toml"] {
                assert_eq!(
                    actions
                        .iter()
                        .filter(|a| a.argv.first().is_some_and(|v| v == "cargo")
                            && a.argv.get(1).is_some_and(|v| v == operation)
                            && a.argv.iter().any(|v| v == manifest))
                        .count(),
                    1,
                    "{operation} {manifest}"
                );
            }
        }
        assert_eq!(
            actions.last().unwrap().argv,
            ["gate-binary", "rust-test", "--root", "source-root"]
        );
    }
    #[test]
    fn contract_lane_invokes_each_required_routing_oracle() {
        let lane = fixture().0.matrix.include[0].clone();
        let actions = commands(&lane, "base").unwrap();
        let routing = actions
            .iter()
            .find(|a| a.label == "routing regressions")
            .unwrap();
        assert_eq!(&routing.argv[..4], ["bun", "test", "--timeout", "60000"]);
        for path in [
            "scripts/test/ci-plan.test.ts",
            "scripts/test/ci-gate.test.ts",
            "scripts/test/governance-files.test.ts",
            "scripts/test/rust-gates-wiring.test.ts",
            "scripts/test/index-routing-inventory.test.ts",
            "scripts/test/rust-prerequisites.test.ts",
        ] {
            assert!(
                routing.argv.iter().any(|arg| arg == path),
                "required routing oracle not invoked: {path}"
            );
        }
    }
    #[test]
    fn factoring_preserves_runtime_checks_once_per_os_and_tests_every_shard() {
        for (os, count) in [("ubuntu-latest", 2), ("windows-latest", 4), ("macos-15", 2)] {
            let mut all = vec![];
            for index in 1..=count {
                let mut lane = fixture().0.matrix.include[0].clone();
                lane.os = os.into();
                lane.profile = "full".into();
                lane.smoke = "true".into();
                lane.shard = format!("{index}/{count}");
                all.extend(commands(&lane, "base").unwrap());
            }
            assert_eq!(all.iter().filter(|a| a.label == "tests").count(), count);
            for label in [
                "Python compileall",
                "Python smoke",
                "index routing regressions",
                "plugin parity",
                "worker equivalence smoke",
            ] {
                assert_eq!(
                    all.iter().filter(|a| a.label == label).count(),
                    1,
                    "{os} {label}"
                );
            }
            assert!(!all.iter().any(|a| a.label == "quality"));
        }
    }
}
