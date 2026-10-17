#![cfg(test)]
use semctx_gates::process::{spawn_owned, spawn_owned_with_env};
use std::{
    collections::BTreeMap,
    io::{Read, Write},
    path::Path,
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};
const HELPER: &str = env!("CARGO_BIN_EXE_semctx-gates");
const FIXTURE: &str = env!("CARGO_BIN_EXE_semctx-gates-fixture");
fn argv(mode: &str) -> Vec<String> {
    vec![FIXTURE.into(), mode.into()]
}
#[test]
fn streaming_stdin_keeps_json_bytes_after_ack() {
    let mut owned = spawn_owned(
        &argv("stdin-roundtrip"),
        &std::env::current_dir().unwrap(),
        None,
        Path::new(HELPER),
    )
    .unwrap();
    let input = "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\"}\n{\"id\":2}\n";
    owned
        .take_stdin()
        .unwrap()
        .write_all(input.as_bytes())
        .unwrap();
    let mut output = String::new();
    owned
        .take_stdout()
        .unwrap()
        .read_to_string(&mut output)
        .unwrap();
    assert!(owned.wait().unwrap().success());
    owned.cleanup().unwrap();
    assert_eq!(output, input);
}
#[test]
fn exact_environment_does_not_import_user_configuration() {
    let env = BTreeMap::from([
        ("SEMCTX_TEST_EXACT_VALUE".into(), "owned".into()),
        (
            "GIT_CONFIG_GLOBAL".into(),
            "explicit-isolated-config".into(),
        ),
    ]);
    let mut owned = spawn_owned_with_env(
        &argv("env-probe"),
        &std::env::current_dir().unwrap(),
        &env,
        Path::new(HELPER),
    )
    .unwrap();
    drop(owned.take_stdin());
    let mut out = String::new();
    owned
        .take_stdout()
        .unwrap()
        .read_to_string(&mut out)
        .unwrap();
    assert!(owned.wait().unwrap().success());
    assert_eq!(out, "owned\ngit=explicit-isolated-config\nhome=\n");
}
#[test]
fn timeout_cleanup_kills_streaming_grandchild_before_joining_pipe_readers() {
    let mut argv = argv("grandchild");
    argv.push("wait".into());
    let mut owned = spawn_owned(
        &argv,
        &std::env::current_dir().unwrap(),
        None,
        Path::new(HELPER),
    )
    .unwrap();
    let mut stdout = owned.take_stdout().unwrap();
    let reader = thread::spawn(move || {
        let mut text = String::new();
        stdout.read_to_string(&mut text).unwrap();
        text
    });
    let start = Instant::now();
    thread::sleep(Duration::from_secs(1));
    owned.cleanup().unwrap();
    let text = reader.join().unwrap();
    assert!(text.contains("grandchild"));
    assert!(start.elapsed().as_secs() < 5);
}
#[test]
fn invalid_helper_cannot_launch_the_real_command() {
    let argv = argv("success");
    let result = spawn_owned(
        &argv,
        &std::env::current_dir().unwrap(),
        None,
        Path::new("missing-semctx-helper-97c950.exe"),
    );
    match result {
        Err(semctx_gates::process::ProcessError::Io { operation, source }) => {
            assert_eq!(operation, "spawn supervisor");
            assert_eq!(source.kind(), std::io::ErrorKind::NotFound);
        }
        _ => panic!("missing helper must retain its native spawn error"),
    }
}
#[test]
fn helper_without_valid_ack_never_launches_the_target() {
    let directory = std::env::temp_dir().join(format!("semctx-no-ack-{}", std::process::id()));
    std::fs::create_dir_all(&directory).unwrap();
    let marker = directory.join("marker");
    let mut helper = Command::new(HELPER)
        .args(["__exec-stream", FIXTURE, "write-marker"])
        .arg(&marker)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    thread::sleep(Duration::from_millis(100));
    assert!(!marker.exists());
    helper.stdin.take().unwrap().write_all(b"?").unwrap();
    assert!(!helper.wait().unwrap().success());
    assert!(!marker.exists());
    std::fs::remove_dir_all(directory).unwrap();
}
