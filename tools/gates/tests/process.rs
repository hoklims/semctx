#![cfg(test)]
use semctx_gates::process::run_with_helper;
use std::{path::Path, sync::Mutex, time::Instant};

// Process-tree timing witnesses share the host's startup/console resources. Preserve their
// deadlines while keeping fixture launches from competing with one another.
static PROCESS_WITNESS: Mutex<()> = Mutex::new(());
fn run(mode: &str, timeout: u64, cap: usize, extra: &[&str]) -> semctx_gates::process::Outcome {
    let mut argv = vec![
        env!("CARGO_BIN_EXE_semctx-gates-fixture").to_owned(),
        mode.into(),
    ];
    argv.extend(extra.iter().map(|s| (*s).to_owned()));
    run_with_helper(
        &argv,
        &std::env::current_dir().unwrap(),
        timeout,
        cap,
        Path::new(env!("CARGO_BIN_EXE_semctx-gates")),
    )
    .unwrap()
}
#[test]
fn captures_success_and_both_streams() {
    let _serial = PROCESS_WITNESS
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let r = run("success", 5000, 1024, &[]);
    assert_eq!(r.kind, "success");
    assert_eq!(r.exit_code, Some(0));
    assert!(r.stdout.contains("fixture stdout"));
    assert!(r.stderr.contains("fixture stderr"));
}
#[test]
fn preserves_nonzero() {
    let _serial = PROCESS_WITNESS
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let r = run("nonzero", 5000, 1024, &[]);
    assert_eq!(r.kind, "nonzero");
    assert_eq!(r.exit_code, Some(7));
}
#[test]
fn bounds_and_drains_output() {
    let _serial = PROCESS_WITNESS
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let r = run("overflow", 5000, 1024, &[]);
    assert_eq!(r.kind, "output_limit");
    assert_eq!(r.stdout.len(), 1024);
    assert!(r.stdout_bytes > 1024);
}
#[test]
fn full_suite_accepts_legitimate_output_and_refuses_excess() {
    let _serial = PROCESS_WITNESS
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let action = semctx_gates::receipt::local_verification("base", true, "", "gate", ".")
        .into_iter()
        .find(|action| action.label == "tests")
        .unwrap();
    let accepted = run("suite-output", 5000, action.output_cap, &["2097152"]);
    assert_eq!(accepted.kind, "success");
    assert_eq!(accepted.stdout_bytes, 2 * 1024 * 1024);
    assert_eq!(accepted.stderr_bytes, 2 * 1024 * 1024);
    assert_eq!(accepted.stdout_hash, semctx_gates::digest(&accepted.stdout));
    assert_eq!(accepted.stderr_hash, semctx_gates::digest(&accepted.stderr));
    let excess = (action.output_cap + 65536).to_string();
    let refused = run("suite-output", 5000, action.output_cap, &[&excess]);
    assert_eq!(refused.kind, "output_limit");
    assert_eq!(refused.stdout.len(), action.output_cap);
}

#[test]
fn piped_progress_uses_capture_and_stdout_remains_json() {
    use std::process::{Command, Stdio};
    use std::time::Duration;
    let _serial = PROCESS_WITNESS
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let marker = std::env::temp_dir().join(format!("semctx-live-progress-{}", std::process::id()));
    let _ = std::fs::remove_file(&marker);
    let supervisor = Command::new(env!("CARGO_BIN_EXE_semctx-gates-fixture"))
        .args(["live-supervisor", env!("CARGO_BIN_EXE_semctx-gates")])
        .arg(&marker)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    std::thread::sleep(Duration::from_millis(100));
    std::fs::write(&marker, "complete").unwrap();
    let output = supervisor.wait_with_output().unwrap();
    std::fs::remove_file(marker).unwrap();
    assert!(output.stderr.is_empty());
    assert!(output.status.success());
    let outcome: semctx_gates::process::Outcome = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(outcome.kind, "success");
    assert_eq!(outcome.stdout, "progress ready\n");
    assert_eq!(outcome.stderr, "progress finished\n");
    assert_eq!(outcome.stdout_hash, semctx_gates::digest(&outcome.stdout));
    assert_eq!(outcome.stderr_hash, semctx_gates::digest(&outcome.stderr));
}
#[test]
fn rejects_invalid_utf8() {
    let _serial = PROCESS_WITNESS
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    assert_eq!(run("malformed", 5000, 1024, &[]).kind, "malformed_output");
}
#[test]
fn enforces_timeout() {
    let _serial = PROCESS_WITNESS
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let start = Instant::now();
    assert_eq!(run("sleep", 150, 1024, &[]).kind, "timeout");
    assert!(start.elapsed().as_secs() < 5);
}
#[test]
fn timeout_kills_grandchild_holding_pipe() {
    let _serial = PROCESS_WITNESS
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let start = Instant::now();
    let r = run("grandchild", 1000, 1024, &["wait"]);
    assert_eq!(r.kind, "timeout");
    assert!(r.stdout.contains("grandchild"));
    assert!(start.elapsed().as_secs() < 5);
}
#[test]
fn exiting_parent_does_not_leave_pipe_reader_blocked() {
    let _serial = PROCESS_WITNESS
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let start = Instant::now();
    let r = run("grandchild", 5000, 1024, &[]);
    assert_eq!(r.kind, "success");
    assert!(r.stdout.contains("grandchild"));
    assert!(start.elapsed().as_secs() < 5);
}
#[test]
fn cancellation_terminates_an_active_tree() {
    let _serial = PROCESS_WITNESS
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_semctx-gates-fixture"))
        .args(["cancel-supervisor", env!("CARGO_BIN_EXE_semctx-gates")])
        .output()
        .unwrap();
    assert!(output.status.success());
    assert_eq!(
        String::from_utf8(output.stdout).unwrap().trim(),
        "cancelled"
    );
}
#[cfg(windows)]
#[test]
fn preserves_windows_native_crash_code_as_failure() {
    let _serial = PROCESS_WITNESS
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let r = run("native-crash-code", 5000, 1024, &[]);
    assert_eq!(r.kind, "nonzero");
    assert_eq!(r.exit_code, Some(0xC0000005u32 as i32));
}

// This watchdog is independent of the supervisor under test. stderr remains deliberately unread.
fn guarded_supervisor(mode: &str, marker: Option<&Path>) -> (bool, std::process::Output) {
    use std::{
        process::{Command, Stdio},
        time::Duration,
    };
    let mut command = Command::new(env!("CARGO_BIN_EXE_semctx-gates-fixture"));
    command.args([mode, env!("CARGO_BIN_EXE_semctx-gates")]);
    if let Some(marker) = marker {
        command.arg(marker);
    }
    let mut child = command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let started = Instant::now();
    let completed = loop {
        if child.try_wait().unwrap().is_some() {
            break true;
        }
        if started.elapsed() > Duration::from_secs(4) {
            child.kill().unwrap();
            child.wait().unwrap();
            break false;
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    #[cfg(unix)]
    if let Some(marker) = marker
        && let Ok(pid) = std::fs::read_to_string(marker)
    {
        // SAFETY: only the PID written by this test's dedicated fixture is signalled.
        unsafe {
            libc::kill(pid.parse().unwrap(), libc::SIGKILL);
        }
    }
    (completed, child.wait_with_output().unwrap())
}
#[test]
fn blocked_external_stderr_cannot_disable_the_process_deadline() {
    let _serial = PROCESS_WITNESS.lock().unwrap_or_else(|e| e.into_inner());
    let (completed, output) = guarded_supervisor("blocked-log-supervisor", None);
    assert!(completed, "BLOCKED_STDERR_DISABLED_DEADLINE");
    let outcome: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        outcome["kind"], "success",
        "piped stderr uses exclusive capture"
    );
    assert_eq!(outcome["stdout_bytes"], 2097152);
    assert_eq!(outcome["stderr_bytes"], 2097152);
}
#[cfg(unix)]
#[test]
fn detached_pipe_holder_cannot_block_finalization_or_claim_complete_capture() {
    let _serial = PROCESS_WITNESS.lock().unwrap_or_else(|e| e.into_inner());
    let marker = std::env::temp_dir().join(format!("semctx-detached-{}", std::process::id()));
    let _ = std::fs::remove_file(&marker);
    let (completed, output) = guarded_supervisor("detached-supervisor", Some(&marker));
    let _ = std::fs::remove_file(marker);
    assert!(completed, "DETACHED_PIPE_HOLDER_DISABLED_FINALIZATION");
    let outcome: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        outcome["kind"], "capture_error",
        "escaped pipe holder prevents complete capture"
    );
}
