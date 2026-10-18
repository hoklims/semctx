#![expect(
    clippy::unwrap_used,
    reason = "Standalone test fixture setup must fail immediately"
)]
use std::{io::Write, process::Command, thread, time::Duration};
#[allow(clippy::zombie_processes)] // The orphan is intentional: the supervisor must reap/kill its tree.
fn main() {
    if verification_tool_stub() {
        return;
    }
    match std::env::args().nth(1).as_deref() {
        Some("success") => {
            println!("fixture stdout");
            eprintln!("fixture stderr");
        }
        Some("nonzero") => std::process::exit(7),
        Some("batch-proxy") => batch_proxy(),
        #[cfg(windows)]
        Some("native-crash-code") => {
            // SAFETY: Win32 ExitProcess accepts the intentional fixture NTSTATUS and never returns.
            unsafe {
                windows_sys::Win32::System::Threading::ExitProcess(0xC0000005);
            }
        }
        Some("overflow") => {
            let bytes = vec![b'x'; 1024 * 1024];
            let _ = std::io::stdout().write_all(&bytes);
        }
        Some("suite-output") => {
            let size: usize = std::env::args().nth(2).unwrap().parse().unwrap();
            let bytes = vec![b'x'; size];
            let _ = std::io::stdout().write_all(&bytes);
            let _ = std::io::stderr().write_all(&bytes);
        }
        Some("progress") => {
            println!("progress ready");
            std::io::stdout().flush().unwrap();
            let marker = std::env::args().nth(2).unwrap();
            while !std::path::Path::new(&marker).exists() {
                thread::sleep(Duration::from_millis(5));
            }
            eprintln!("progress finished");
        }
        Some("live-supervisor") => live_supervisor(),
        Some("blocked-log-supervisor") | Some("detached-supervisor") => bounded_supervisor(),
        #[cfg(unix)]
        Some("detached-parent") => detached_parent(),
        #[cfg(unix)]
        Some("detached-holder") => {
            // SAFETY: this standalone fixture intentionally leaves its inherited process group.
            assert!(unsafe { libc::setsid() } > 0);
            std::fs::write(
                std::env::args().nth(2).unwrap(),
                std::process::id().to_string(),
            )
            .unwrap();
            thread::sleep(Duration::from_secs(30));
        }
        Some("malformed") => {
            let _ = std::io::stdout().write_all(&[255]);
        }
        Some("stdin-roundtrip") => {
            use std::io::{BufRead, Write};
            for line in std::io::stdin().lock().lines() {
                println!("{}", line.unwrap());
                std::io::stdout().flush().unwrap();
            }
        }
        Some("write-marker") => {
            std::fs::write(std::env::args().nth(2).unwrap(), "launched").unwrap();
        }
        Some("env-probe") => {
            println!(
                "{}",
                std::env::var("SEMCTX_TEST_EXACT_VALUE").unwrap_or_default()
            );
            println!(
                "git={}",
                std::env::var("GIT_CONFIG_GLOBAL").unwrap_or_default()
            );
            println!("home={}", std::env::var("USERPROFILE").unwrap_or_default());
        }
        Some("sleep") => thread::sleep(Duration::from_secs(30)),
        Some("cancel-supervisor") => cancel_supervisor(),
        Some("cancel-outcome-supervisor") => cancel_outcome_supervisor(),
        Some("owned-tree-ready") => owned_tree_ready(),
        Some("grandchild") => {
            let mut child = Command::new(std::env::current_exe().unwrap())
                .arg("sleep")
                .spawn()
                .unwrap();
            println!("grandchild {}", child.id());
            std::io::stdout().flush().unwrap();
            if std::env::args().nth(2).as_deref() == Some("wait") {
                let _ = child.wait();
            }
        }
        _ => panic!("unknown fixture mode"),
    }
}

fn bounded_supervisor() {
    let helper = std::env::args().nth(2).unwrap();
    let logged = std::env::args().nth(1).unwrap() == "blocked-log-supervisor";
    let mut argv = vec![
        std::env::current_exe()
            .unwrap()
            .to_string_lossy()
            .into_owned(),
    ];
    if logged {
        argv.extend(["suite-output".into(), "2097152".into()]);
    } else {
        argv.extend(["detached-parent".into(), std::env::args().nth(3).unwrap()]);
    }
    let root = std::env::current_dir().unwrap();
    let result = if logged {
        semctx_gates::process::run_with_helper_logged(
            &argv,
            &root,
            1500,
            4 * 1024 * 1024,
            std::path::Path::new(&helper),
        )
    } else {
        semctx_gates::process::run_with_helper(
            &argv,
            &root,
            2000,
            1024,
            std::path::Path::new(&helper),
        )
    }
    .unwrap();
    println!(
        "{}",
        serde_json::json!({"kind":result.kind,"stdout_bytes":result.stdout_bytes,"stderr_bytes":result.stderr_bytes})
    );
}

#[cfg(unix)]
#[expect(
    clippy::zombie_processes,
    reason = "The external test owns the intentionally detached fixture"
)]
fn detached_parent() {
    let marker = std::env::args().nth(2).unwrap();
    let _child = Command::new(std::env::current_exe().unwrap())
        .arg("detached-holder")
        .arg(&marker)
        .spawn()
        .unwrap();
    for _ in 0..200 {
        if std::path::Path::new(&marker).exists() {
            return;
        }
        thread::sleep(Duration::from_millis(5));
    }
    panic!("detached holder did not start");
}

fn live_supervisor() {
    let helper = std::env::args().nth(2).unwrap();
    let marker = std::env::args().nth(3).unwrap();
    let argv = vec![
        std::env::current_exe()
            .unwrap()
            .to_string_lossy()
            .into_owned(),
        "progress".into(),
        marker,
    ];
    let result = semctx_gates::process::run_with_helper_logged(
        &argv,
        &std::env::current_dir().unwrap(),
        5000,
        1024,
        std::path::Path::new(&helper),
    )
    .unwrap();
    println!("{}", serde_json::to_string(&result).unwrap());
}

fn cancel_supervisor() {
    semctx_gates::process::install_cancellation();
    let helper = std::env::args().nth(2).unwrap();
    thread::spawn(|| {
        thread::sleep(Duration::from_millis(250));
        #[cfg(unix)]
        // SAFETY: POSIX raise accepts SIGINT, handled by the installed cancellation callback.
        unsafe {
            libc::raise(libc::SIGINT);
        }
        #[cfg(windows)]
        semctx_gates::process::request_cancellation();
    });
    let argv = vec![
        std::env::current_exe()
            .unwrap()
            .to_string_lossy()
            .into_owned(),
        "sleep".into(),
    ];
    let result = semctx_gates::process::run_with_helper(
        &argv,
        &std::env::current_dir().unwrap(),
        5000,
        1024,
        std::path::Path::new(&helper),
    )
    .unwrap();
    println!("{}", result.kind);
}

fn cancel_outcome_supervisor() {
    semctx_gates::process::install_cancellation();
    let helper = std::env::args().nth(2).unwrap();
    let token = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let scratch = std::env::temp_dir().join(format!(
        "semctx-owned-cancel-{}-{token}",
        std::process::id()
    ));
    std::fs::create_dir(&scratch).unwrap();
    let marker = scratch.join("ready");
    let readiness = marker.clone();
    let trigger = thread::spawn(move || {
        let start = std::time::Instant::now();
        let observation = loop {
            match std::fs::read_to_string(&readiness) {
                Ok(pid) => break pid
                    .parse::<u32>()
                    .ok()
                    .filter(|pid| *pid > 0)
                    .map(|pid| serde_json::json!({"ready":true,"descendant_pid":pid}))
                    .unwrap_or(
                        serde_json::json!({"ready":false,"error":"invalid owned descendant PID"}),
                    ),
                Err(error)
                    if error.kind() == std::io::ErrorKind::NotFound
                        && start.elapsed() < Duration::from_secs(3) =>
                {
                    thread::sleep(Duration::from_millis(5))
                }
                Err(error) => break serde_json::json!({"ready":false,"error":error.to_string()}),
            }
        };
        semctx_gates::process::request_cancellation();
        observation
    });
    let argv = vec![
        std::env::current_exe()
            .unwrap()
            .to_string_lossy()
            .into_owned(),
        "owned-tree-ready".into(),
        marker.to_string_lossy().into_owned(),
    ];
    let outcome = semctx_gates::process::run_with_helper(
        &argv,
        &scratch,
        5000,
        1024,
        std::path::Path::new(&helper),
    )
    .unwrap();
    let trigger = trigger.join().unwrap();
    std::fs::remove_dir_all(&scratch).unwrap();
    println!(
        "{}",
        serde_json::json!({"outcome":outcome,"trigger":trigger})
    );
}

fn verification_tool_stub() -> bool {
    let executable = std::env::current_exe().unwrap();
    let name = executable.file_stem().unwrap().to_str().unwrap();
    if !["bun", "python", "cargo"].contains(&name) {
        return false;
    }
    let mut log = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(std::env::var_os("SEMCTX_TEST_TOOL_LOG").unwrap())
        .unwrap();
    writeln!(log, "{name}").unwrap();
    let marker = std::path::PathBuf::from(std::env::var_os("SEMCTX_TEST_TOOL_LOG").unwrap())
        .with_extension("fail-tool7");
    if marker.exists() {
        eprintln!("fixture tool failure");
        std::process::exit(7);
    }
    true
}

fn batch_proxy() {
    let args = std::env::args().collect::<Vec<_>>();
    assert_eq!(args.len(), 8);
    let helper = std::path::Path::new(&args[2]);
    let producer = std::path::Path::new(&args[3]);
    let request = std::path::Path::new(&args[4]);
    let sdk = std::path::Path::new(&args[5]);
    let paths = [producer, helper, request, sdk];
    let hashes = || {
        paths
            .iter()
            .map(|p| semctx_gates::digest(std::fs::read(p).unwrap()))
            .collect::<Vec<_>>()
    };
    let before = hashes();
    let argv = vec![
        args[3].clone(),
        "--batch".into(),
        args[4].clone(),
        args[5].clone(),
    ];
    let cwd = std::env::current_dir().unwrap();
    let outcome =
        semctx_gates::process::run_with_helper(&argv, &cwd, 20_000, 8_388_608, helper).unwrap();
    let after = hashes();
    std::fs::write(&args[6], serde_json::to_vec_pretty(&serde_json::json!({"argv":argv,"cwd":cwd,"paths":paths,"before":before,"after":after,"outcome":outcome})).unwrap()).unwrap();
    assert_eq!(before, after);
    assert_eq!(outcome.kind, "success");
    assert_eq!(outcome.exit_code, Some(0));
    let batch: serde_json::Value = serde_json::from_str(&outcome.stdout).unwrap();
    assert_eq!(batch["terminal"], "refused");
    let (forwarded, exit) = match args[7].as_str() {
        "complete-3" => (outcome.stdout.as_str(), 3),
        "truncated-0" => (outcome.stdout.trim_end().strip_suffix('}').unwrap(), 0),
        "truncated-3" => (outcome.stdout.trim_end().strip_suffix('}').unwrap(), 3),
        "empty-3" => ("", 3),
        _ => panic!("unknown batch proxy mode"),
    };
    std::io::stdout().write_all(forwarded.as_bytes()).unwrap();
    std::io::stdout().flush().unwrap();
    std::process::exit(exit);
}

fn owned_tree_ready() {
    let mut child = Command::new(std::env::current_exe().unwrap())
        .arg("sleep")
        .spawn()
        .unwrap();
    assert!(child.try_wait().unwrap().is_none());
    println!(
        "{}",
        serde_json::json!({"parent_pid":std::process::id(),"descendant_pid":child.id()})
    );
    std::io::stdout().flush().unwrap();
    let marker = std::path::PathBuf::from(std::env::args().nth(2).unwrap());
    let pending = marker.with_extension("pending");
    std::fs::write(&pending, child.id().to_string()).unwrap();
    std::fs::rename(pending, marker).unwrap();
    let _ = child.wait();
}
