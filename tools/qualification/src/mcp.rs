use crate::{
    ExpectedOutcome, SupportStatus,
    journeys::{self, Runner},
    json, process,
};
use serde_json::{Value, json as j};
use std::{
    fs,
    io::{BufRead, BufReader, Read},
    path::Path,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc::{self, Receiver},
    },
    thread,
    time::{Duration, Instant},
};

fn deliver_wire_message(
    sender: &mpsc::SyncSender<Result<Value, String>>,
    mut message: Result<Value, String>,
    delivery_stopped: &AtomicBool,
) -> bool {
    loop {
        match sender.try_send(message) {
            Ok(()) => return true,
            Err(mpsc::TrySendError::Disconnected(_)) => return false,
            Err(mpsc::TrySendError::Full(value)) => {
                if delivery_stopped.load(Ordering::SeqCst) {
                    return true;
                }
                message = value;
                thread::sleep(Duration::from_millis(5));
            }
        }
    }
}

struct Session {
    child: process::OwnedChild,
    input: Option<mpsc::Sender<Value>>,
    write_result: Receiver<Result<(), process::Error>>,
    input_writer: Option<thread::JoinHandle<()>>,
    output: Receiver<Result<Value, String>>,
    wire_reader: Option<thread::JoinHandle<Result<(), String>>>,
    stop_delivery: Arc<AtomicBool>,
    pending_response: Arc<AtomicU64>,
    stop_readers: Arc<AtomicBool>,
    stderr: Option<process::Capture>,
    id: u64,
    finished: bool,
}
impl Drop for Session {
    fn drop(&mut self) {
        if !self.finished {
            drop(self.input.take());
            let _ = self.cleanup_readers();
        }
    }
}
impl Session {
    fn start(runner: &Runner, root: &Path) -> Result<Self, String> {
        let mut command = runner.runtime.command(&runner.mcp);
        Self::start_command(&mut command, root)
    }
    fn start_command(command: &mut std::process::Command, root: &Path) -> Result<Self, String> {
        let mut child = process::spawn(command, root).map_err(|error| error.to_string())?;
        let mut input = child.take_stdin().ok_or("missing MCP stdin")?;
        let stop_readers = Arc::new(AtomicBool::new(false));
        let stdout = semctx_gates::process::pipe_reader(
            child.take_stdout().ok_or("missing MCP stdout")?,
            &stop_readers,
        )
        .map_err(|error| error.to_string())?;
        let stderr = semctx_gates::process::pipe_reader(
            child.take_stderr().ok_or("missing MCP stderr")?,
            &stop_readers,
        )
        .map_err(|error| error.to_string())?;
        let (input_sender, input_receiver) = mpsc::channel();
        let (written, write_result) = mpsc::channel();
        let input_writer = thread::spawn(move || {
            while let Ok(value) = input_receiver.recv() {
                let result = process::write_json(&mut input, &value);
                let failed = result.is_err();
                if written.send(result).is_err() || failed {
                    break;
                }
            }
        });
        let (tx, output) = mpsc::sync_channel(32);
        let stop_delivery = Arc::new(AtomicBool::new(false));
        let delivery_stopped = stop_delivery.clone();
        let pending_response = Arc::new(AtomicU64::new(0));
        let wire_pending = pending_response.clone();
        let wire_reader = thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            let mut total = 0u64;
            loop {
                let mut bytes = Vec::new();
                let read = reader
                    .by_ref()
                    .take(process::LIMIT + 1)
                    .read_until(b'\n', &mut bytes);
                total += bytes.len() as u64;
                let message = match read {
                    Ok(0) => return Ok(()),
                    Ok(_) if total > process::LIMIT => Err("MCP wire output exceeded".into()),
                    Ok(_) => serde_json::from_slice(&bytes)
                        .map_err(|error| format!("MCP invalid JSON: {error}"))
                        .and_then(|value| validate_envelope(value, &wire_pending)),
                    Err(error) => Err(format!("MCP stdout read: {error}")),
                };
                let failure = message.as_ref().err().cloned();
                if !deliver_wire_message(&tx, message, &delivery_stopped) {
                    return Ok(());
                }
                if let Some(error) = failure {
                    return Err(error);
                }
            }
        });
        Ok(Self {
            child,
            input: Some(input_sender),
            write_result,
            input_writer: Some(input_writer),
            output,
            wire_reader: Some(wire_reader),
            stop_delivery,
            pending_response,
            stop_readers: stop_readers.clone(),
            stderr: Some(process::drain(stderr, "MCP stderr", &stop_readers)),
            id: 0,
            finished: false,
        })
    }
    fn check_capture(&self) -> Result<(), String> {
        if process::cancellation_requested() {
            return Err(process::Error::Cancelled.to_string());
        }
        if let Some(stderr) = &self.stderr {
            stderr.check().map_err(|error| error.to_string())?;
        }
        Ok(())
    }
    fn cleanup_readers(&mut self) -> Result<(), String> {
        let cleanup = self.child.cleanup();
        self.stop_delivery.store(true, Ordering::SeqCst);
        let writer = self
            .input_writer
            .take()
            .map(|writer| {
                semctx_gates::process::finish_reader(writer, &self.stop_readers)
                    .map_err(|error| error.to_string())
            })
            .unwrap_or(Ok(()));
        let wire = self
            .wire_reader
            .take()
            .map(|reader| {
                semctx_gates::process::finish_reader(reader, &self.stop_readers)
                    .map_err(|error| error.to_string())?
            })
            .unwrap_or(Ok(()));
        let stderr = self
            .stderr
            .take()
            .map(|reader| {
                reader
                    .finish_checked()
                    .map(|_| ())
                    .map_err(|error| error.to_string())
            })
            .unwrap_or(Ok(()));
        self.finished = true;
        cleanup.map_err(|error| error.to_string())?;
        writer?;
        wire?;
        stderr
    }
    fn finish(&mut self) -> Result<(), String> {
        if self.finished {
            return Ok(());
        }
        drop(self.input.take());
        self.stop_delivery.store(true, Ordering::SeqCst);
        let started = Instant::now();
        let status = loop {
            if let Err(error) = self.check_capture() {
                break Err(error);
            }
            match self.child.try_wait() {
                Ok(Some(status)) if status.success() => break Ok(()),
                Ok(Some(status)) => {
                    break Err(format!("MCP server exited unsuccessfully: {status}"));
                }
                Ok(None) => {}
                Err(error) => break Err(format!("MCP wait: {error}")),
            }
            if started.elapsed() >= Duration::from_millis(500) {
                break Ok(());
            }
            thread::sleep(Duration::from_millis(10));
        };
        let cleanup = self.cleanup_readers();
        status?;
        cleanup
    }
    fn write(&mut self, value: &Value, budget: Duration) -> Result<(), String> {
        let started = Instant::now();
        self.check_capture()?;
        self.input
            .as_ref()
            .ok_or("MCP stdin closed")?
            .send(value.clone())
            .map_err(|error| format!("MCP stdin writer: {error}"))?;
        loop {
            self.check_capture()?;
            let remaining = budget
                .checked_sub(started.elapsed())
                .ok_or("MCP write deadline exceeded")?;
            match self
                .write_result
                .recv_timeout(remaining.min(Duration::from_millis(50)))
            {
                Ok(result) => return result.map_err(|error| error.to_string()),
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(error) => return Err(format!("MCP stdin writer: {error}")),
            }
        }
    }
    fn request(&mut self, method: &str, params: Value) -> Result<Value, String> {
        self.request_with_budget(method, params, process::BUDGET)
    }
    fn request_with_budget(
        &mut self,
        method: &str,
        params: Value,
        budget: Duration,
    ) -> Result<Value, String> {
        let started = Instant::now();
        self.check_capture()?;
        self.id += 1;
        let id = self.id;
        self.pending_response.store(id, Ordering::SeqCst);
        self.write(
            &j!({"jsonrpc":"2.0","id":id,"method":method,"params":params}),
            budget
                .checked_sub(started.elapsed())
                .ok_or("MCP deadline exceeded")?,
        )?;
        loop {
            self.check_capture()?;
            let remaining = budget
                .checked_sub(started.elapsed())
                .ok_or("MCP deadline exceeded")?;
            let value = match self
                .output
                .recv_timeout(remaining.min(std::time::Duration::from_millis(50)))
            {
                Ok(value) => value?,
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(error) => {
                    self.check_capture()?;
                    return Err(format!("MCP wire: {error}"));
                }
            };
            self.check_capture()?;
            if value["id"] != id {
                if value.get("id").is_some() {
                    return Err("unexpected MCP response identity".into());
                }
                continue;
            }
            if value["jsonrpc"] != "2.0" || value.get("error").is_some() {
                return Err(format!("MCP protocol error {value}"));
            }
            return value
                .get("result")
                .cloned()
                .ok_or("MCP response lacks result".into());
        }
    }
    fn tool(&mut self, name: &str, args: Value) -> Result<Value, String> {
        let value = self.request("tools/call", j!({"name":name,"arguments":args}))?;
        if value["isError"] == true {
            return Err(format!("MCP tool refused {value}"));
        }
        if let Some(structured) = value.get("structuredContent") {
            return Ok(structured.clone());
        }
        let text = value["content"]
            .as_array()
            .ok_or("MCP missing content")?
            .iter()
            .find(|c| c["type"] == "text")
            .and_then(|c| c["text"].as_str())
            .ok_or("MCP missing JSON text")?;
        serde_json::from_str(text).map_err(|e| e.to_string())
    }
}

// Validate every message in wire order, including messages drained after the last useful reply.
// The transport has one outstanding request; server requests are not negotiated by this client.
fn validate_envelope(value: Value, pending: &AtomicU64) -> Result<Value, String> {
    if !value.is_object() || value["jsonrpc"] != "2.0" {
        return Err("MCP protocol envelope requires JSON-RPC 2.0".into());
    }
    if value.get("id").is_none() {
        if !value["method"].is_string()
            || value.get("result").is_some()
            || value.get("error").is_some()
            || value
                .get("params")
                .is_some_and(|params| !params.is_object() && !params.is_array())
        {
            return Err("MCP protocol envelope is not a notification".into());
        }
    } else {
        let id = value["id"]
            .as_u64()
            .filter(|id| *id != 0)
            .ok_or("unexpected MCP response identity")?;
        if value.get("method").is_some()
            || value.get("result").is_some() == value.get("error").is_some()
            || value
                .get("error")
                .is_some_and(|error| !error["code"].is_i64() || !error["message"].is_string())
        {
            return Err("MCP protocol envelope is not a response".into());
        }
        pending
            .compare_exchange(id, 0, Ordering::SeqCst, Ordering::SeqCst)
            .map_err(|_| "unexpected MCP response identity")?;
    }
    Ok(value)
}

/// Probe the same supervised stdio initialization path used by product qualification.
pub fn probe_initialize(command: &mut std::process::Command, root: &Path) -> Result<Value, String> {
    let mut session = Session::start_command(command, root)?;
    let result=session.request("initialize",j!({"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"qualification-probe","version":"1"}}))?;
    session.finish()?;
    Ok(result)
}

fn symbol(value: &Value, name: &str) -> bool {
    value["matchedNodes"]
        .as_array()
        .is_some_and(|nodes| nodes.iter().any(|n| n["name"] == name))
}

fn qualify_initial_mcp_state(
    runner: &mut Runner,
    session: &mut Session,
    root: &Path,
) -> Result<(), String> {
    let initialized = session.request("initialize",j!({"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"semctx-rust-qualification","version":"1.0.0"}}))?;
    let raw = runner.record("mcp-initialize", &initialized)?;
    runner.case(
        "mcp.initialize",
        SupportStatus::Supported,
        raw,
        if initialized["protocolVersion"].is_string()
            && initialized["serverInfo"]["name"].is_string()
        {
            Ok(())
        } else {
            Err("missing MCP negotiation".into())
        },
        ExpectedOutcome::UsefulSuccess,
    );
    session.write(
        &j!({"jsonrpc":"2.0","method":"notifications/initialized"}),
        process::BUDGET,
    )?;
    let tools = session.request("tools/list", j!({}))?;
    let raw = runner.record("mcp-tools", &tools)?;
    let names = tools["tools"].as_array().ok_or("missing tool inventory")?;
    runner.case(
        "mcp.tools",
        SupportStatus::Supported,
        raw,
        if [
            "semctx_inspect",
            "semctx_control_status",
            "semctx_index_health",
        ]
        .iter()
        .all(|name| names.iter().any(|n| n["name"] == *name))
        {
            Ok(())
        } else {
            Err("required functional tools absent".into())
        },
        ExpectedOutcome::UsefulSuccess,
    );
    let status = session.tool("semctx_control_status", j!({"repositoryRoot":root}))?;
    let raw = runner.record("mcp-control-status", &status)?;
    runner.case(
        "mcp.control-status",
        SupportStatus::Supported,
        raw,
        if status["verdict"] == "FRESH" && status["canRunHighRiskControl"] == true {
            Ok(())
        } else {
            Err(format!("MCP control not fresh: {status}"))
        },
        ExpectedOutcome::UsefulSuccess,
    );
    let old = session.tool(
        "semctx_inspect",
        j!({"repositoryRoot":root,"query":"oldSymbol","kind":"symbol"}),
    )?;
    let health = session.tool("semctx_index_health", j!({"repositoryRoot":root}))?;
    let raw = runner.record("mcp-inspect", &j!({"inspect":old,"health":health}))?;
    runner.case(
        "mcp.inspect",
        SupportStatus::Supported,
        raw,
        if symbol(&old, "oldSymbol") && health["binding"]["status"] == "valid" {
            Ok(())
        } else {
            Err("MCP did not inspect frozen indexed symbol".into())
        },
        ExpectedOutcome::UsefulSuccess,
    );

    Ok(())
}

pub fn run(runner: &mut Runner, root: &Path) -> Result<(), String> {
    let mut session = Session::start(runner, root)?;
    qualify_initial_mcp_state(runner, &mut session, root)?;
    // Keep the same child and connection alive while a separate CLI rebuild replaces facts.
    fs::remove_file(root.join("src/symbol.ts")).map_err(|e| e.to_string())?;
    journeys::write(
        root,
        "src/new.ts",
        "export function newSymbol(): number {\n  return 2;\n}\n",
    )?;
    journeys::commit(root)?;
    runner.index(root)?;
    let new_old = session.tool(
        "semctx_inspect",
        j!({"repositoryRoot":root,"query":"oldSymbol","kind":"symbol"}),
    )?;
    let new = session.tool(
        "semctx_inspect",
        j!({"repositoryRoot":root,"query":"newSymbol","kind":"symbol"}),
    )?;
    let new_health = session.tool("semctx_index_health", j!({"repositoryRoot":root}))?;
    let raw = runner.record(
        "mcp-refresh",
        &j!({"pid":session.child.id(),"old":new_old,"new":new,"health":new_health}),
    )?;
    runner.case(
        "mcp.refresh",
        SupportStatus::Supported,
        raw,
        if crate::symbol_absent(&new_old, "oldSymbol")
            && symbol(&new, "newSymbol")
            && new_health["binding"]["status"] == "valid"
        {
            Ok(())
        } else {
            Err("same MCP process retained stale facts".into())
        },
        ExpectedOutcome::UsefulSuccess,
    );
    session.finish()?;
    // Verify a useful CLI query after the same external rebuild as a final transport cross-check.
    let (ob, _) = runner.cli(root, &["inspect", "symbol", "newSymbol", "--json"])?;
    let result = json(&ob, 0)?;
    if !symbol(&result, "newSymbol") {
        return Err("CLI refresh result lost the new symbol".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[ignore]
    fn fixture_no_stdin_read() {
        thread::sleep(Duration::from_secs(2));
    }
    #[test]
    fn request_deadline_includes_the_time_spent_writing_stdin() {
        let params = j!({"padding":"x".repeat(2 * 1024 * 1024)});
        let root = tempfile::tempdir().unwrap();
        let executable = std::env::current_exe().unwrap();
        let fixture = executable.parent().unwrap().parent().unwrap().join(format!(
            "qualification-mcp-fixture{}",
            std::env::consts::EXE_SUFFIX
        ));
        let mut command = std::process::Command::new(fixture);
        command.arg("--delayed-request");
        let mut session = Session::start_command(&mut command, root.path()).unwrap();
        let ready = session
            .output
            .recv_timeout(Duration::from_secs(10))
            .unwrap()
            .unwrap();
        assert_eq!(ready["method"], "notifications/ready");
        let error = session
            .request_with_budget("initialize", params, Duration::from_secs(1))
            .unwrap_err();
        assert_eq!(error, "MCP deadline exceeded");
    }
    struct FailedCaptureRead;
    impl Read for FailedCaptureRead {
        fn read(&mut self, _: &mut [u8]) -> std::io::Result<usize> {
            Err(std::io::Error::other("injected MCP read failure"))
        }
    }
    #[test]
    fn request_preserves_the_capture_read_failure_in_its_rendered_error() {
        let root = tempfile::tempdir().unwrap();
        let executable = std::env::current_exe().unwrap();
        let fixture = executable.parent().unwrap().parent().unwrap().join(format!(
            "qualification-mcp-fixture{}",
            std::env::consts::EXE_SUFFIX
        ));
        let mut command = std::process::Command::new(fixture);
        command.arg("--delayed-request");
        let mut session = Session::start_command(&mut command, root.path()).unwrap();
        let capture = process::drain(FailedCaptureRead, "MCP stderr", &session.stop_readers);
        let started = Instant::now();
        while capture.check().is_ok() {
            assert!(started.elapsed() < Duration::from_secs(2));
            thread::yield_now();
        }
        let original = session.stderr.replace(capture).unwrap();
        let error = session.request("initialize", j!({})).unwrap_err();
        drop(session);
        original.finish().unwrap();
        assert_eq!(error, "MCP stderr: injected MCP read failure");
    }
    #[test]
    fn blocked_stdin_write_obeys_the_mcp_deadline() {
        let root = tempfile::tempdir().unwrap();
        let mut command = std::process::Command::new(std::env::current_exe().unwrap());
        command.args(["--ignored", "--exact", "mcp::tests::fixture_no_stdin_read"]);
        let mut session = Session::start_command(&mut command, root.path()).unwrap();
        let error = session
            .write(
                &j!({"padding":"x".repeat(1024 * 1024)}),
                Duration::from_millis(50),
            )
            .unwrap_err();
        assert!(error.contains("MCP write deadline exceeded"), "{error}");
    }
}
