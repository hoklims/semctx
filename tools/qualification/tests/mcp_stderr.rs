#![cfg(test)]
use std::process::Command;
#[test]
fn valid_mcp_peer_with_bounded_stderr_is_accepted() {
    let root = tempfile::tempdir().unwrap();
    let mut command = Command::new(env!("CARGO_BIN_EXE_qualification-mcp-fixture"));
    let result = semctx_qualification::mcp::probe_initialize(&mut command, root.path()).unwrap();
    assert_eq!(result["serverInfo"]["name"], "native-wire-fixture");
}
#[test]
fn valid_mcp_reply_cannot_hide_stderr_overflow() {
    let root = tempfile::tempdir().unwrap();
    let mut command = Command::new(env!("CARGO_BIN_EXE_qualification-mcp-fixture"));
    command.arg("--overflow");
    let error = semctx_qualification::mcp::probe_initialize(&mut command, root.path()).unwrap_err();
    assert!(error.contains("MCP stderr output exceeded"), "{error}");
}

#[test]
fn valid_last_reply_cannot_hide_a_nonzero_mcp_exit() {
    let root = tempfile::tempdir().unwrap();
    let mut command = Command::new(env!("CARGO_BIN_EXE_qualification-mcp-fixture"));
    command.arg("--crash");
    let error = semctx_qualification::mcp::probe_initialize(&mut command, root.path()).unwrap_err();
    assert!(error.contains("42"), "{error}");
}
#[test]
fn mcp_shutdown_observes_the_status_after_stdin_eof() {
    let root = tempfile::tempdir().unwrap();
    let mut command = Command::new(env!("CARGO_BIN_EXE_qualification-mcp-fixture"));
    command.arg("--crash-on-eof");
    let error = semctx_qualification::mcp::probe_initialize(&mut command, root.path()).unwrap_err();
    assert!(error.contains("42"), "{error}");
}

#[test]
fn persistent_mcp_and_inherited_pipe_holders_are_stopped_within_a_bounded_shutdown() {
    for mode in ["--persist", "--pipe-holder"] {
        let root = tempfile::tempdir().unwrap();
        let mut command = Command::new(env!("CARGO_BIN_EXE_qualification-mcp-fixture"));
        command.arg(mode);
        let started = std::time::Instant::now();
        let value = semctx_qualification::mcp::probe_initialize(&mut command, root.path()).unwrap();
        assert_eq!(value["serverInfo"]["name"], "native-wire-fixture");
        assert!(
            started.elapsed() < std::time::Duration::from_secs(5),
            "{mode}"
        );
    }
}

#[test]
fn valid_notifications_beyond_the_channel_capacity_are_drained_at_shutdown() {
    let root = tempfile::tempdir().unwrap();
    let mut command = Command::new(env!("CARGO_BIN_EXE_qualification-mcp-fixture"));
    command.arg("--backlog-valid");
    let result = semctx_qualification::mcp::probe_initialize(&mut command, root.path()).unwrap();
    assert_eq!(result["serverInfo"]["name"], "native-wire-fixture");
}

#[test]
fn a_full_notification_channel_cannot_hide_trailing_invalid_json() {
    let root = tempfile::tempdir().unwrap();
    let mut command = Command::new(env!("CARGO_BIN_EXE_qualification-mcp-fixture"));
    command.arg("--backlog-malformed");
    let error = semctx_qualification::mcp::probe_initialize(&mut command, root.path()).unwrap_err();
    assert!(error.contains("MCP invalid JSON"), "{error}");
}

#[test]
fn wire_overflow_is_refused_while_an_mcp_request_is_pending() {
    let root = tempfile::tempdir().unwrap();
    let mut command = Command::new(env!("CARGO_BIN_EXE_qualification-mcp-fixture"));
    command.arg("--wire-overflow-before-reply");
    let error = semctx_qualification::mcp::probe_initialize(&mut command, root.path()).unwrap_err();
    assert!(error.contains("MCP wire output exceeded"), "{error}");
}

#[test]
fn trailing_unsolicited_responses_are_refused_even_after_a_valid_reply() {
    for mode in ["--trailing-wrong-id", "--trailing-wrong-id-backlog"] {
        let root = tempfile::tempdir().unwrap();
        let mut command = Command::new(env!("CARGO_BIN_EXE_qualification-mcp-fixture"));
        command.arg(mode);
        let result = semctx_qualification::mcp::probe_initialize(&mut command, root.path());
        assert!(
            result
                .as_ref()
                .is_err_and(|error| error.contains("unexpected MCP response identity")),
            "TRAILING_RESPONSE_ACCEPTED {mode}: {result:?}"
        );
    }
}
#[test]
fn trailing_invalid_envelopes_are_refused_even_behind_notifications() {
    for mode in ["--trailing-invalid", "--trailing-invalid-backlog"] {
        let root = tempfile::tempdir().unwrap();
        let mut command = Command::new(env!("CARGO_BIN_EXE_qualification-mcp-fixture"));
        command.arg(mode);
        let result = semctx_qualification::mcp::probe_initialize(&mut command, root.path());
        assert!(
            result
                .as_ref()
                .is_err_and(|error| error.contains("MCP protocol envelope")),
            "TRAILING_ENVELOPE_ACCEPTED {mode}: {result:?}"
        );
    }
}

#[cfg(target_os = "linux")]
#[test]
fn small_pipe_overflow_is_observed_before_shutdown_without_throughput_throttling() {
    let root = tempfile::tempdir().unwrap();
    let mut command = Command::new(env!("CARGO_BIN_EXE_qualification-mcp-fixture"));
    command.arg("--backlog-overflow-small-pipe");
    let error = semctx_qualification::mcp::probe_initialize(&mut command, root.path()).unwrap_err();
    assert_eq!(
        error, "MCP wire output exceeded",
        "SMALL_PIPE_OVERFLOW_TRUNCATED_BY_SHUTDOWN"
    );
}

#[cfg(target_os = "linux")]
#[test]
fn small_pipe_valid_notification_backlog_remains_accepted() {
    let root = tempfile::tempdir().unwrap();
    let mut command = Command::new(env!("CARGO_BIN_EXE_qualification-mcp-fixture"));
    command.arg("--backlog-valid-small-pipe");
    let result = semctx_qualification::mcp::probe_initialize(&mut command, root.path()).unwrap();
    assert_eq!(result["serverInfo"]["name"], "native-wire-fixture");
}
