#![cfg(test)]
use std::{
    fs,
    path::Path,
    process::{Child, Command, Output, Stdio},
    thread,
    time::{Duration, Instant},
};

fn wait_for_output(mut child: Child) -> Output {
    let started = Instant::now();
    while child.try_wait().unwrap().is_none() {
        if started.elapsed() > Duration::from_secs(10) {
            child.kill().unwrap();
            let output = child.wait_with_output().unwrap();
            panic!("supervisor did not finish: {output:?}");
        }
        thread::sleep(Duration::from_millis(10));
    }
    child.wait_with_output().unwrap()
}

fn assert_heartbeat_stopped(marker: &Path) {
    assert!(marker.exists(), "descendant did not start");
    let before = fs::metadata(marker).unwrap().len();
    thread::sleep(Duration::from_millis(100));
    assert_eq!(
        fs::metadata(marker).unwrap().len(),
        before,
        "descendant remains active"
    );
}

#[test]
fn cancellation_refuses_cli_and_blocked_mcp_and_stops_their_descendants() {
    for mode in ["--cancel-cli", "--cancel-mcp"] {
        let root = tempfile::tempdir().unwrap();
        let marker = root.path().join("heartbeat");
        let child = Command::new(env!("CARGO_BIN_EXE_qualification-mcp-fixture"))
            .arg(mode)
            .arg(&marker)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let output = wait_for_output(child);
        assert!(output.status.success(), "{mode}: {output:?}");
        assert!(
            String::from_utf8(output.stdout)
                .unwrap()
                .contains("qualification cancelled")
        );
        assert_heartbeat_stopped(&marker);
    }
}

#[cfg(unix)]
#[test]
fn sigterm_on_the_qualification_entrypoint_cleans_up_its_process_tree() {
    let root = tempfile::tempdir().unwrap();
    let distribution = root.path().join("distribution");
    fs::create_dir(&distribution).unwrap();
    let binary = distribution.join("subject");
    fs::copy(env!("CARGO_BIN_EXE_qualification-mcp-fixture"), &binary).unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_semctx-qualification"))
        .args(["--runtime", "native", "--cli"])
        .arg(&binary)
        .arg("--mcp")
        .arg(&binary)
        .arg("--out")
        .arg(root.path().join("report"))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let marker = root.path().join("heartbeat");
    let started = Instant::now();
    while !marker.exists() {
        if child.try_wait().unwrap().is_some() || started.elapsed() > Duration::from_secs(10) {
            let _ = child.kill();
            let output = child.wait_with_output().unwrap();
            panic!("qualification did not launch subject: {output:?}");
        }
        thread::sleep(Duration::from_millis(10));
    }
    let signalled = Command::new("/bin/kill")
        .args(["-TERM", &child.id().to_string()])
        .status()
        .unwrap();
    assert!(signalled.success());
    let output = wait_for_output(child);
    assert!(!output.status.success());
    let value: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(value["status"], "failed");
    assert!(
        value.to_string().contains("qualification cancelled"),
        "{value}"
    );
    assert_heartbeat_stopped(&marker);
}

#[cfg(unix)]
#[test]
fn escaped_pipe_holders_refuse_cli_and_mcp_without_leaking_capture_resources() {
    for mode in ["--probe-escaped-cli", "--probe-escaped-mcp"] {
        let root = tempfile::tempdir().unwrap();
        let marker = root.path().join("escaped-pid");
        let mut child = Command::new(env!("CARGO_BIN_EXE_qualification-mcp-fixture"))
            .arg(mode)
            .arg(&marker)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let started = Instant::now();
        let completed = loop {
            if child.try_wait().unwrap().is_some() {
                break true;
            }
            if started.elapsed() > Duration::from_secs(5) {
                child.kill().unwrap();
                child.wait().unwrap();
                break false;
            }
            thread::sleep(Duration::from_millis(10));
        };
        // Release only the escaped PID recorded by this test's own fixture, before any assertion.
        if let Ok(pid) = fs::read_to_string(&marker) {
            assert!(
                Command::new("/bin/kill")
                    .args(["-KILL", pid.trim()])
                    .status()
                    .unwrap()
                    .success()
            );
        }
        let output = child.wait_with_output().unwrap();
        assert!(
            completed,
            "ESCAPED_QUALIFICATION_PIPE_DISABLED_FINALIZATION {mode}"
        );
        assert!(output.status.success(), "{mode}: {output:?}");
        assert!(
            String::from_utf8(output.stdout)
                .unwrap()
                .contains("ESCAPED_CAPTURE_REFUSED_AND_READERS_CLOSED")
        );
    }
}
