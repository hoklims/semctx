use super::*;

#[test]
fn confines_fixture_paths_before_writes() {
    assert!(safe_relative(".gitignore"));
    assert!(safe_relative("src/consumer.ts"));
    for bad in [
        "../a",
        "src/../a",
        "/a",
        "D:/a",
        "a\\b",
        ".git/config",
        "a/.GIT/config",
        ".semctx/state",
        "NUL.ts",
        "a//b",
        "space /a",
        "a\0b",
        "COM2",
    ] {
        assert!(!safe_relative(bad), "accepted {bad:?}");
    }
}

#[test]
fn keeps_exact_git_settings_and_ignores_caller_git_configuration() {
    let env = isolated_environment("C:\\Windows", "C:\\Git\\cmd", "D:\\r\\control");
    assert_eq!(
        env.get("GIT_CONFIG_GLOBAL").map(String::as_str),
        Some("NUL")
    );
    assert_eq!(env["GIT_CONFIG_NOSYSTEM"], "1");
    assert_eq!(env["GIT_TEMPLATE_DIR"], "D:\\r\\control\\template");
    assert_eq!(env["HOME"], "D:\\r\\control\\home");
    assert!(!env.contains_key("GIT_CONFIG_COUNT"));
    assert!(!env.contains_key("GCM_INTERACTIVE"));
}

#[test]
fn checks_fixture_local_readback_and_complete_streams() {
    let mut capture = Observed {
        exit_code: Some(0),
        complete_capture: true,
        stdout: b"false\r\n".to_vec(),
        ..Observed::default()
    };
    assert!(acceptable_config(Some(b"false"), &capture));
    capture.stdout = b"false\r\ntrue\r\n".to_vec();
    assert!(!acceptable_config(Some(b"false"), &capture));
    capture.stdout = b"false\n".to_vec();
    capture.complete_capture = false;
    assert!(!acceptable_config(Some(b"false"), &capture));
}

#[cfg(unix)]
fn helper() -> std::path::PathBuf {
    std::env::var_os("SEMCTX_DEV_HELPER")
        .expect("pinned first-party test helper")
        .into()
}

#[cfg(unix)]
fn temporary_workspace() -> PathBuf {
    use std::sync::atomic::AtomicU64;
    static SEQUENCE: AtomicU64 = AtomicU64::new(0);
    let path = std::env::temp_dir().join(format!(
        "semctx-windows-stage-{}-{}",
        std::process::id(),
        SEQUENCE.fetch_add(1, Ordering::Relaxed),
    ));
    fs::create_dir(&path).unwrap();
    path
}

#[cfg(unix)]
#[test]
fn staging_refuses_file_directory_alias_before_any_writes() {
    let root = temporary_workspace();
    let key = format!("lifecycle-{}", "b".repeat(64));
    let files = BTreeMap::from([
        ("src/item".to_owned(), b"root".to_vec()),
        ("src/item/main.ts".to_owned(), b"nested".to_vec()),
    ]);
    let result = stage_fixture(&root, &key, &files);
    let writes = fs::read_dir(&root).unwrap().count();
    fs::remove_dir_all(&root).unwrap();
    assert!(result.is_err());
    assert_eq!(writes, 0);
}

#[cfg(unix)]
#[test]
fn stage_creates_exact_bytes_once_and_refuses_symlinked_parent() {
    let root = temporary_workspace();
    let outside = temporary_workspace();
    let key = format!("lifecycle-{}", "a".repeat(64));
    let files = BTreeMap::from([("src/main.ts".to_owned(), b"hello\r\n".to_vec())]);
    std::os::unix::fs::symlink(&outside, root.join("supplement-evidence")).unwrap();
    assert!(stage_fixture(&root, &key, &files).is_err());
    assert_eq!(fs::read_dir(&outside).unwrap().count(), 0);
    fs::remove_file(root.join("supplement-evidence")).unwrap();
    let cwd = stage_fixture(&root, &key, &files).unwrap();
    assert_eq!(fs::read(cwd.join("src/main.ts")).unwrap(), b"hello\r\n");
    assert!(stage_fixture(&root, &key, &files).is_err());
    assert!(!cwd.join(".git").exists());
    fs::remove_dir_all(root).unwrap();
    fs::remove_dir_all(outside).unwrap();
}

#[cfg(unix)]
#[test]
fn binds_all_current04_lifecycle_stage_bytes_and_command_order() {
    let read = |name: &str, expected: &str| {
        let path = std::env::var_os(name).expect("exact current04 fixture document");
        let bytes = fs::read(path).unwrap();
        assert_eq!(format!("{:x}", Sha256::digest(&bytes)), expected);
        serde_json::from_slice::<serde_json::Value>(&bytes).unwrap()
    };
    let preflight = read(
        "SEMCTX_DEV_LIFECYCLE_PREFLIGHT",
        "9e3c2579c36494d27ff9d459214e17dc1e421e64d738aec3c98548142b5bf6c2",
    );
    let public_plan = read(
        "SEMCTX_DEV_LIFECYCLE_PLAN",
        "96ce9443c651ec2360d0112c4ff8c52502287787326fb82279706698e7a7a6fb",
    );
    let groups = preflight["groups"].as_array().unwrap();
    assert_eq!(groups.len(), 23);
    let invocations = public_plan["invocations"].as_array().unwrap();
    let root = temporary_workspace();
    let mut total = 0;
    for group in groups {
        let key = group["invocation_key"].as_str().unwrap();
        let source = invocations.iter().find(|row| row["key"] == key).unwrap();
        let mut files = BTreeMap::new();
        for item in group["files"].as_array().unwrap() {
            let relative = item["input_json_key"].as_str().unwrap();
            let bytes = source["prepared"]["physical_files"][relative]
                .as_str()
                .unwrap()
                .as_bytes()
                .to_vec();
            assert_eq!(item["sha256"], format!("{:x}", Sha256::digest(&bytes)));
            assert_eq!(item["bytes"], bytes.len());
            files.insert(relative.to_owned(), bytes);
        }
        let cwd = stage_fixture(&root, key, &files).unwrap();
        for (relative, bytes) in &files {
            assert_eq!(fs::read(cwd.join(relative)).unwrap(), *bytes);
        }
        assert!(!cwd.join(".git").exists());
        let metadata = format!(
            r"{}\{}\.git",
            WINDOWS_FIXTURE_ROOT,
            group["workspace"].as_str().unwrap().replace('/', r"\")
        );
        let steps = [
            GitStep::Init,
            GitStep::SetAutocrlf,
            GitStep::ReadAutocrlf,
            GitStep::SetSafecrlf,
            GitStep::ReadSafecrlf,
            GitStep::Add,
            GitStep::Commit,
        ];
        let planned = &group["steps"].as_array().unwrap()[1..];
        assert_eq!(planned.len(), steps.len());
        for (plan_step, step) in planned.iter().zip(steps) {
            let mut argv = vec!["git".to_string()];
            argv.extend(step.arguments(&metadata));
            assert_eq!(serde_json::json!(argv), plan_step["argv"]);
        }
        total += files.len();
    }
    assert_eq!(total, 70);
    fs::remove_dir_all(root).unwrap();
}

#[cfg(unix)]
#[test]
fn owned_process_preserves_non_utf8_and_nonzero_status() {
    let cmd = [
        "/bin/sh",
        "-c",
        "printf '\\377\r\n'; printf '\\376' >&2; exit 7",
    ]
    .map(str::to_owned);
    let result = run_owned(
        &cmd,
        &std::env::current_dir().unwrap(),
        &BTreeMap::new(),
        &helper(),
        Duration::from_secs(2),
        CAPACITY,
    )
    .unwrap();
    assert_eq!(result.exit_code, Some(7));
    assert!(result.complete_capture);
    assert_eq!(result.stdout, b"\xff\r\n");
    assert_eq!(result.stderr, b"\xfe");
}

#[cfg(unix)]
#[test]
fn over_cap_retains_exact_available_prefix_and_refuses_completeness() {
    let cmd = ["/bin/sh", "-c", "printf 'ABCDE'"].map(str::to_owned);
    let result = run_owned(
        &cmd,
        &std::env::current_dir().unwrap(),
        &BTreeMap::new(),
        &helper(),
        Duration::from_secs(2),
        3,
    )
    .unwrap();
    assert_eq!(result.stdout, b"ABC");
    assert!(!result.complete_capture);
}

#[cfg(unix)]
#[test]
fn timeout_terminates_owned_shell_and_returns_partial_observation() {
    let cmd = ["/bin/sh", "-c", "/bin/sleep 5"].map(str::to_owned);
    let started = std::time::Instant::now();
    let result = run_owned(
        &cmd,
        &std::env::current_dir().unwrap(),
        &BTreeMap::new(),
        &helper(),
        Duration::from_millis(60),
        CAPACITY,
    )
    .unwrap();
    assert!(result.timed_out);
    assert!(!result.complete_capture);
    // UNKNOWN tree state is allowed only on an incomplete/refused observation.
    // A timeout never becomes a complete capture, regardless of cleanup query.
    assert!(!result.complete_capture);
    assert!(started.elapsed() < Duration::from_secs(3));
}

#[cfg(unix)]
#[test]
fn live_owned_tree_is_not_quiescent_before_cleanup() {
    let cmd = ["/bin/sh", "-c", "/bin/sleep 10"].map(str::to_owned);
    let mut child = process::spawn_owned_with_env_bounded(
        &cmd,
        &std::env::current_dir().unwrap(),
        &BTreeMap::new(),
        &helper(),
        Duration::from_secs(2),
    )
    .unwrap();
    assert!(!child.tree_quiescent().unwrap());
    let id = child.id();
    child.cleanup_and_release_handle().unwrap();
    child.cleanup_and_release_handle().unwrap();
    assert!(child.wait().is_err(), "released Child must reject wait");
    assert!(
        child.try_wait().is_err(),
        "released Child must reject try_wait"
    );
    assert_eq!(child.id(), id);
    assert!(child.take_stdin().is_none());
    assert!(child.take_stdout().is_none());
    assert!(child.take_stderr().is_none());
    let deadline = Instant::now() + Duration::from_secs(2);
    while !child.tree_quiescent().unwrap() && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(5));
    }
    assert!(child.tree_quiescent().unwrap());
}

#[test]
fn expired_quiescence_never_calls_query() {
    assert!(quiescence_before(true, Instant::now(), || panic!("expired query called")).is_err());
    assert!(!await_quiescence(true, Instant::now(), || panic!(
        "expired polling called"
    )));
}

#[test]
fn late_true_quiescence_is_refused_before_and_after_drain() {
    let deadline = Instant::now() + Duration::from_millis(5);
    assert!(!await_quiescence(true, deadline, || {
        thread::sleep(Duration::from_millis(10));
        Ok(true)
    }));
    let deadline = Instant::now() + Duration::from_millis(5);
    assert!(
        quiescence_before(true, deadline, || {
            thread::sleep(Duration::from_millis(10));
            Ok(true)
        })
        .is_err()
    );
}

#[cfg(unix)]
#[test]
fn command_status_after_deadline_is_a_timeout_not_success() {
    use std::os::unix::process::ExitStatusExt;
    let deadline = Instant::now() + Duration::from_millis(5);
    let result = command_status_before(deadline, || {
        thread::sleep(Duration::from_millis(10));
        Ok(Some(std::process::ExitStatus::from_raw(0)))
    });
    assert_eq!(result.unwrap_err().kind(), io::ErrorKind::TimedOut);
    assert!(command_status_before(Instant::now(), || panic!("expired command polled")).is_err());
}

#[test]
fn failed_cleanup_prevents_both_job_queries() {
    let deadline = Instant::now() + Duration::from_secs(1);
    assert!(!await_quiescence(false, deadline, || panic!(
        "unreleased first query"
    )));
    assert!(quiescence_before(false, deadline, || panic!("unreleased postdrain query")).is_err());
}

#[test]
fn reader_that_finishes_only_after_cutoff_is_not_complete() {
    let stop = Arc::new(AtomicBool::new(false));
    let reader_stop = Arc::clone(&stop);
    let reader = thread::spawn(move || {
        while !reader_stop.load(Ordering::SeqCst) {
            thread::yield_now();
        }
        Ok::<(), io::Error>(())
    });
    let joined = matches!(process::finish_reader(reader, &stop), Ok(Ok(())));
    assert!(joined, "cutoff reader should return a successful join");
    assert!(stop.load(Ordering::SeqCst));
    assert!(
        !drain_complete(joined, true, &stop),
        "cutoff joined reader falsely counted complete"
    );
}

#[cfg(unix)]
#[test]
fn native_git_accepts_only_the_payload_layout_not_a_launcher() {
    let root = fs::canonicalize(temporary_workspace()).unwrap();
    for layout in ["mingw64/bin", "ucrt64/bin", "cmd", "bin", "unknown/bin"] {
        let path = root.join(layout).join("git.exe");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, b"fixture only").unwrap();
        assert_eq!(
            is_git_payload(&path),
            layout == "mingw64/bin" || layout == "ucrt64/bin"
        );
    }
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn near_exhausted_quiescence_deadline_also_bounds_pipe_drain() {
    let stop = Arc::new(AtomicBool::new(false));
    let reader_stop = Arc::clone(&stop);
    let stdout = thread::spawn(move || {
        while !reader_stop.load(Ordering::SeqCst) {
            thread::sleep(Duration::from_millis(1));
        }
        Ok(())
    });
    let stderr = thread::spawn(|| Ok(()));
    let started = Instant::now();
    let deadline = started + Duration::from_millis(30);
    let (quiet, complete) = finish_capture_before(true, deadline, stdout, stderr, &stop, || {
        thread::sleep(Duration::from_millis(25));
        Ok(true)
    });
    assert!(
        started.elapsed() < Duration::from_millis(150),
        "pipe drain restarted its grace period after quiescence consumed D2"
    );
    assert!(!quiet);
    assert!(!complete, "late EOF supplied a false complete capture");
    assert!(stop.load(Ordering::SeqCst));
}

#[test]
fn expired_pipe_deadline_refuses_already_completed_readers() {
    let stdout = thread::spawn(|| Ok(()));
    let stderr = thread::spawn(|| Ok(()));
    while !stdout.is_finished() || !stderr.is_finished() {
        thread::yield_now();
    }
    let stop = AtomicBool::new(false);
    let (quiet, complete) =
        finish_capture_before(true, Instant::now(), stdout, stderr, &stop, || {
            panic!("expired capture queried tree")
        });
    assert!(!quiet);
    assert!(!complete, "expired D2 accepted already completed readers");
    assert!(stop.load(Ordering::SeqCst));
}

#[test]
fn cancelled_capture_never_accepts_later_eof() {
    let stop = Arc::new(AtomicBool::new(false));
    let reader_stop = Arc::clone(&stop);
    let (done_tx, done_rx) = std::sync::mpsc::channel();
    let reader = thread::spawn(move || {
        while !reader_stop.load(Ordering::SeqCst) {
            thread::yield_now();
        }
        done_tx.send(()).unwrap();
        Ok::<(), io::Error>(())
    });
    let deadline = Instant::now() + Duration::from_millis(10);
    let result = process::finish_reader_before(reader, &stop, deadline);
    assert!(result.is_err(), "EOF after cutoff was accepted");
    assert!(stop.load(Ordering::SeqCst));
    done_rx.recv_timeout(Duration::from_secs(1)).unwrap();
    let completed = thread::spawn(|| Ok::<(), io::Error>(()));
    while !completed.is_finished() {
        thread::yield_now();
    }
    assert!(
        process::finish_reader_before(completed, &stop, Instant::now() + Duration::from_secs(1),)
            .is_err(),
        "prior cancellation was forgotten by the next pipe"
    );
}

#[test]
fn deadline_drain_preserves_completed_reader_result() {
    let reader = thread::spawn(|| Ok::<_, io::Error>(b"exact bytes"));
    let stop = AtomicBool::new(false);
    assert_eq!(
        process::finish_reader_before(reader, &stop, Instant::now() + Duration::from_secs(1))
            .unwrap()
            .unwrap(),
        b"exact bytes",
    );
    assert!(!stop.load(Ordering::SeqCst));
}

#[test]
fn second_pipe_reuses_the_remaining_quiescence_deadline() {
    let stop = Arc::new(AtomicBool::new(false));
    let reader_stop = Arc::clone(&stop);
    let stdout = thread::spawn(|| Ok(()));
    let ready_deadline = Instant::now() + Duration::from_secs(2);
    while !stdout.is_finished() && Instant::now() < ready_deadline {
        thread::yield_now();
    }
    assert!(
        stdout.is_finished(),
        "stdout fixture was not ready before D2"
    );
    let stderr = thread::spawn(move || {
        while !reader_stop.load(Ordering::SeqCst) {
            thread::sleep(Duration::from_millis(1));
        }
        Ok(())
    });
    let started = Instant::now();
    let (_, complete) = finish_capture_before(
        true,
        started + Duration::from_millis(100),
        stdout,
        stderr,
        &stop,
        || Ok(true),
    );
    assert!(
        started.elapsed() < Duration::from_millis(300),
        "second pipe restarted its grace period after quiescence consumed D2"
    );
    assert!(!complete);
    assert!(stop.load(Ordering::SeqCst));
}

#[test]
fn held_capture_mutex_is_refused_without_waiting() {
    let bytes = Arc::new(Mutex::new(vec![0xff, 0, b'\n']));
    let held = Arc::clone(&bytes);
    let (ready_tx, ready_rx) = std::sync::mpsc::channel();
    let holder = thread::spawn(move || {
        let _guard = held.lock().unwrap();
        ready_tx.send(()).unwrap();
        thread::sleep(Duration::from_millis(500));
    });
    ready_rx.recv_timeout(Duration::from_secs(1)).unwrap();
    let started = Instant::now();
    let result = snapshot_before(&bytes, started + Duration::from_secs(1));
    let elapsed = started.elapsed();
    holder.join().unwrap();
    assert!(
        elapsed < Duration::from_millis(150),
        "capture snapshot waited for an unfinished reader mutex"
    );
    assert!(result.is_err(), "unavailable capture was accepted");
}

#[test]
fn expired_capture_snapshot_is_refused() {
    let bytes = Mutex::new(vec![0xff, 0, b'\n']);
    assert!(
        snapshot_before(&bytes, Instant::now()).is_err(),
        "expired capture snapshot was accepted"
    );
}

#[test]
fn healthy_capture_snapshot_preserves_exact_bytes() {
    let expected = vec![0xff, 0, b'\r', b'\n', 0xfe];
    let bytes = Mutex::new(expected.clone());
    assert_eq!(
        snapshot_before(&bytes, Instant::now() + Duration::from_secs(1)).unwrap(),
        expected
    );
}
