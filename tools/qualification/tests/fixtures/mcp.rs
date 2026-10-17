//! Test-only native wire peer. It deliberately exercises channel limits, not Semctx behavior.
#![expect(
    clippy::unwrap_used,
    reason = "Standalone test fixture setup must fail immediately"
)]
use std::{
    io::{BufRead, Write},
    path::Path,
    process::Command,
    thread,
    time::Duration,
};
fn main() {
    let arguments = std::env::args().collect::<Vec<_>>();
    match arguments.get(1).map(String::as_str) {
        #[cfg(unix)]
        Some("--escaped-holder") => {
            detach_and_hold(&arguments[2]);
            return;
        }
        #[cfg(unix)]
        Some("--escaped-cli") => {
            escaped_holder(&arguments[2]);
            return;
        }
        #[cfg(unix)]
        Some("--probe-escaped-cli" | "--probe-escaped-mcp") => {
            probe_escaped(&arguments);
            return;
        }
        Some("__exec-stream") => {
            let code = semctx_gates::process::helper_stream(&arguments[2..]).unwrap();
            std::process::exit(code);
        }
        Some("__exec") => {
            let code = semctx_gates::process::helper(&arguments[2..]).unwrap();
            std::process::exit(code);
        }
        Some("--heartbeat") => {
            let mut marker = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&arguments[2])
                .unwrap();
            loop {
                marker.write_all(b".").unwrap();
                marker.flush().unwrap();
                thread::sleep(Duration::from_millis(10));
            }
        }
        Some("--hang" | "setup") => {
            let marker = arguments
                .get(2)
                .filter(|arg| !arg.starts_with("--"))
                .map(std::path::PathBuf::from)
                .unwrap_or_else(|| {
                    std::env::current_exe()
                        .unwrap()
                        .parent()
                        .unwrap()
                        .parent()
                        .unwrap()
                        .join("heartbeat")
                });
            let mut child = Command::new(std::env::current_exe().unwrap())
                .arg("--heartbeat")
                .arg(marker)
                .spawn()
                .unwrap();
            child.wait().unwrap();
            return;
        }
        Some("--cancel-cli" | "--cancel-mcp") => {
            cancel_probe(&arguments);
            return;
        }
        _ => {}
    }
    serve_mcp(&arguments);
}

fn serve_mcp(arguments: &[String]) {
    #[cfg(target_os = "linux")]
    if arguments.iter().any(|arg| arg.ends_with("-small-pipe")) {
        shrink_stdout_pipe();
    }
    let mut input = std::io::BufReader::new(std::io::stdin().lock());
    let delayed = arguments.iter().any(|arg| arg == "--delayed-request");
    if delayed {
        println!(
            "{}",
            serde_json::json!({"jsonrpc":"2.0","method":"notifications/ready"})
        );
        std::io::stdout().flush().unwrap();
        input.fill_buf().unwrap();
        thread::sleep(Duration::from_millis(600));
    }
    let crash = arguments.iter().any(|arg| arg == "--crash");
    let persistent = arguments.iter().any(|arg| arg == "--persist");
    let pipe_holder = arguments.iter().any(|arg| arg == "--pipe-holder");
    let crash_on_eof = arguments.iter().any(|arg| arg == "--crash-on-eof");
    let overflowing = std::env::args().any(|arg| arg == "--overflow");
    for line in input.lines() {
        let Ok(line) = line else { break };
        #[expect(
            clippy::expect_used,
            reason = "The fixture requires a valid JSON request"
        )]
        let request: serde_json::Value = serde_json::from_str(&line).expect("fixture request JSON");
        if request.get("id").is_none() {
            continue;
        }
        let bytes = if overflowing {
            vec![b'x'; semctx_qualification::process::LIMIT as usize + 1024]
        } else {
            b"fixture diagnostic\n".to_vec()
        };
        let _ = std::io::stderr().write_all(&bytes);
        if delayed {
            thread::sleep(Duration::from_millis(600));
        }
        if arguments
            .iter()
            .any(|arg| arg == "--wire-overflow-before-reply")
        {
            write_wire_overflow();
        }
        println!(
            "{}",
            serde_json::json!({"jsonrpc":"2.0","id":request["id"],"result":{"protocolVersion":"2025-03-26","serverInfo":{"name":"native-wire-fixture"}}})
        );
        std::io::stdout().flush().unwrap();
        #[cfg(unix)]
        if arguments.iter().any(|arg| arg == "--escaped-mcp") {
            escaped_holder(&arguments[2]);
            return;
        }
        if arguments.iter().any(|arg| arg.starts_with("--backlog-")) {
            for sequence in 0..50 {
                println!(
                    "{}",
                    serde_json::json!({"jsonrpc":"2.0","method":"notifications/message","params":{"sequence":sequence}})
                );
            }
            if arguments.iter().any(|arg| arg == "--backlog-malformed") {
                println!("NOT JSON");
            }
            if arguments
                .iter()
                .any(|arg| arg.starts_with("--backlog-overflow"))
            {
                write_wire_overflow();
            }
            let _ = std::io::stdout().flush();
            return;
        }
        if trailing_wire(arguments) {
            return;
        }
        if crash {
            std::process::exit(42);
        }
    }
    if persistent {
        thread::sleep(Duration::from_secs(30));
    }
    if pipe_holder {
        let mut child = Command::new(std::env::current_exe().unwrap())
            .arg("--persist")
            .spawn()
            .unwrap();
        child.wait().unwrap();
    }
    if crash_on_eof {
        std::process::exit(42);
    }
}

fn write_wire_overflow() {
    let notification = serde_json::json!({
        "jsonrpc": "2.0",
        "method": "notifications/message",
        "params": {"padding": "x".repeat(semctx_qualification::process::LIMIT as usize)}
    });
    let bytes = serde_json::to_vec(&notification).unwrap();
    let _ = std::io::stdout().write_all(&bytes);
    let _ = std::io::stdout().write_all(b"\n");
}

#[cfg(target_os = "linux")]
fn shrink_stdout_pipe() {
    use std::os::fd::AsRawFd;
    unsafe extern "C" {
        fn fcntl(fd: std::ffi::c_int, command: std::ffi::c_int, ...) -> std::ffi::c_int;
    }
    // Linux UAPI linux/fcntl.h: F_SETPIPE_SZ = F_LINUX_SPECIFIC_BASE (1024) + 7.
    const F_SETPIPE_SZ: std::ffi::c_int = 1031;
    // SAFETY: stdout is this fixture's live pipe; this only shrinks its kernel buffer.
    let size = unsafe { fcntl(std::io::stdout().as_raw_fd(), F_SETPIPE_SZ, 4096) };
    assert_eq!(size, 4096);
}

fn trailing_wire(arguments: &[String]) -> bool {
    if !arguments.iter().any(|arg| arg.starts_with("--trailing-")) {
        return false;
    }
    if arguments.iter().any(|arg| arg.ends_with("-backlog")) {
        for sequence in 0..50 {
            println!(
                "{}",
                serde_json::json!({"jsonrpc":"2.0","method":"notifications/message","params":{"sequence":sequence}})
            );
        }
    }
    let value = if arguments.iter().any(|arg| arg.contains("wrong-id")) {
        serde_json::json!({"jsonrpc":"2.0","id":999,"result":{}})
    } else {
        serde_json::json!({"jsonrpc":"1.0","method":"notifications/message"})
    };
    println!("{value}");
    std::io::stdout().flush().unwrap();
    true
}

fn cancel_probe(arguments: &[String]) {
    semctx_gates::process::install_cancellation();
    let marker = std::path::PathBuf::from(&arguments[2]);
    let awaited = marker.clone();
    thread::spawn(move || {
        for _ in 0..300 {
            if awaited.exists() {
                break;
            }
            thread::sleep(Duration::from_millis(10));
        }
        semctx_gates::process::request_cancellation();
    });
    let mut command = Command::new(std::env::current_exe().unwrap());
    command.arg("--hang").arg(&marker);
    let result = if arguments[1] == "--cancel-cli" {
        semctx_qualification::process::run(&mut command, Path::new("."), Duration::from_secs(3))
            .map(|_| ())
            .map_err(|error| error.to_string())
    } else {
        semctx_qualification::mcp::probe_initialize(&mut command, Path::new(".")).map(|_| ())
    };
    match result {
        Err(error) if error.contains("cancelled") => println!("{error}"),
        other => panic!("cancellation was not refused: {other:?}"),
    }
}

#[cfg(unix)]
fn detach_and_hold(marker: &str) {
    unsafe extern "C" {
        fn setsid() -> std::ffi::c_int;
    }
    // SAFETY: this standalone child intentionally leaves its inherited session/group.
    assert!(unsafe { setsid() } > 0);
    std::fs::write(marker, std::process::id().to_string()).unwrap();
    thread::sleep(Duration::from_secs(30));
}

#[cfg(unix)]
fn probe_escaped(arguments: &[String]) {
    let mut command = Command::new(std::env::current_exe().unwrap());
    command
        .arg(if arguments[1] == "--probe-escaped-cli" {
            "--escaped-cli"
        } else {
            "--escaped-mcp"
        })
        .arg(&arguments[2]);
    #[cfg(target_os = "linux")]
    let before = resource_counts();
    let result = if arguments[1] == "--probe-escaped-cli" {
        semctx_qualification::process::run(&mut command, Path::new("."), Duration::from_secs(2))
            .map(|_| ())
            .map_err(|error| error.to_string())
    } else {
        semctx_qualification::mcp::probe_initialize(&mut command, Path::new(".")).map(|_| ())
    };
    assert!(
        result
            .as_ref()
            .is_err_and(|error| error.contains("capture finalization deadline")),
        "ESCAPED_CAPTURE_ACCEPTED {result:?}"
    );
    #[cfg(target_os = "linux")]
    assert_eq!(
        resource_counts(),
        before,
        "ESCAPED_CAPTURE_LEAKED_READERS_OR_FDS"
    );
    println!("ESCAPED_CAPTURE_REFUSED_AND_READERS_CLOSED");
}

#[cfg(unix)]
#[expect(
    clippy::zombie_processes,
    reason = "The escaped fixture is owned and reaped by the test's external cleanup"
)]
fn escaped_holder(marker: &str) {
    let _child = Command::new(std::env::current_exe().unwrap())
        .arg("--escaped-holder")
        .arg(marker)
        .spawn()
        .unwrap();
    for _ in 0..200 {
        if Path::new(marker).exists() {
            return;
        }
        thread::sleep(Duration::from_millis(5));
    }
    panic!("escaped holder did not start");
}
#[cfg(target_os = "linux")]
fn resource_counts() -> (usize, usize) {
    (
        std::fs::read_dir("/proc/self/task").unwrap().count(),
        std::fs::read_dir("/proc/self/fd").unwrap().count(),
    )
}
