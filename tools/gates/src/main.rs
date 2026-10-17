use semctx_gates::{Result, plan, process, receipt, rust_workspace};
use std::{
    collections::BTreeMap,
    io::Write,
    path::{Path, PathBuf},
    process::ExitCode,
};

fn options(args: &[String]) -> Result<BTreeMap<String, String>> {
    if !args.len().is_multiple_of(2) {
        return Err("options require --name value pairs".into());
    }
    let mut result = BTreeMap::new();
    for pair in args.chunks(2) {
        if !pair[0].starts_with("--") || result.insert(pair[0].clone(), pair[1].clone()).is_some() {
            return Err("invalid/duplicate option".into());
        }
    }
    Ok(result)
}
fn take(options: &mut BTreeMap<String, String>, key: &str) -> Result<String> {
    options.remove(key).ok_or(format!("missing {key}"))
}
fn write_json(path: &Path, value: &impl serde::Serialize) -> Result<()> {
    let bytes = serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(path, bytes).map_err(|e| e.to_string())
}
fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> Result<T> {
    let metadata = std::fs::metadata(path).map_err(|e| e.to_string())?;
    if metadata.len() > 256 * 1024 * 1024 {
        return Err("JSON artifact exceeds 256 MiB".into());
    }
    serde_json::from_slice(&std::fs::read(path).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}
fn main_result(args: &[String]) -> Result<u8> {
    let (operation, args) = args
        .split_first()
        .ok_or("expected ci-plan, ci-run, aggregate")?;
    process::install_cancellation();
    if operation == "verify-pr" {
        return verify_pr(args);
    }
    let mut opts = options(args)?;
    let root = PathBuf::from(take(&mut opts, "--root")?)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let (value, code) = match operation.as_str() {
        "rust-test" => {
            if !opts.is_empty() {
                return Err("unknown option".into());
            }
            let report = rust_workspace::test(&root)?;
            let code = if report.status == "failed" { 1 } else { 0 };
            (
                serde_json::to_value(report).map_err(|e| e.to_string())?,
                code,
            )
        }
        "ci-plan" => {
            let base = take(&mut opts, "--base")?;
            let head = take(&mut opts, "--head")?;
            let output = PathBuf::from(take(&mut opts, "--output")?);
            if !opts.is_empty() {
                return Err("unknown option".into());
            }
            let plan = plan::create(&root, &base, &head)?;
            write_json(&output, &plan)?;
            (serde_json::to_value(plan).map_err(|e| e.to_string())?, 0)
        }
        "ci-run" => {
            let plan_path = PathBuf::from(take(&mut opts, "--plan")?);
            let lane: usize = take(&mut opts, "--lane")?
                .parse()
                .map_err(|_| "invalid lane index")?;
            let output = PathBuf::from(take(&mut opts, "--receipt")?);
            if !opts.is_empty() {
                return Err("unknown option".into());
            }
            let plan: plan::Plan = read_json(&plan_path)?;
            let receipt = receipt::execute(&root, &plan, lane);
            write_json(&output, &receipt)?;
            let code = if receipt.status == "passed" { 0 } else { 1 };
            (
                serde_json::to_value(receipt).map_err(|e| e.to_string())?,
                code,
            )
        }
        "aggregate" => {
            let plan_path = PathBuf::from(take(&mut opts, "--plan")?);
            let dir = PathBuf::from(take(&mut opts, "--receipts")?);
            if !opts.is_empty() {
                return Err("unknown option".into());
            }
            let plan: plan::Plan = read_json(&plan_path)?;
            plan::validate(&root, &plan)?;
            let mut receipts = vec![];
            for entry in std::fs::read_dir(dir).map_err(|e| e.to_string())? {
                let entry = entry.map_err(|e| e.to_string())?;
                if !entry.file_type().map_err(|e| e.to_string())?.is_file()
                    || entry.path().extension().and_then(|x| x.to_str()) != Some("json")
                {
                    return Err("unexpected receipt directory entry".into());
                }
                receipts.push(read_json(&entry.path())?);
            }
            receipt::admit(&plan, &receipts)?;
            (
                serde_json::json!({"schema":1,"status":"passed","plan_id":plan.plan_id,"lanes":receipts.len()}),
                0,
            )
        }
        _ => return Err("unknown operation".into()),
    };
    let stdout = std::io::stdout();
    let mut lock = stdout.lock();
    serde_json::to_writer(&mut lock, &value).map_err(|e| e.to_string())?;
    writeln!(lock).map_err(|e| e.to_string())?;
    lock.flush().map_err(|e| e.to_string())?;
    Ok(code)
}
fn verify_pr(args: &[String]) -> Result<u8> {
    let mut root = std::env::current_dir().map_err(|e| e.to_string())?;
    let mut base = std::env::var("SEMCTX_VERIFY_BASE").unwrap_or_else(|_| "origin/main".into());
    let mut skip = false;
    let mut shard = String::new();
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--skip-diff" => skip = true,
            "--root" | "--base" | "--test-shard" => {
                let value = args.get(index + 1).ok_or("missing option value")?;
                match args[index].as_str() {
                    "--root" => root = value.into(),
                    "--base" => base = value.clone(),
                    _ => shard = value.clone(),
                }
                index += 1;
            }
            _ => return Err("unknown verify-pr option".into()),
        }
        index += 1;
    }
    if base.is_empty() || base.starts_with('-') {
        return Err("invalid base".into());
    }
    if !shard.is_empty() {
        let valid = shard.split_once('/').is_some_and(|(i, n)| matches!((i.parse::<u32>(), n.parse::<u32>()), (Ok(i), Ok(n)) if i > 0 && i <= n));
        if !valid {
            return Err("invalid test shard".into());
        }
    }
    let root = root.canonicalize().map_err(|error| error.to_string())?;
    if !skip && !plan::git(&root, &["ls-files", "--others", "--exclude-standard", "-z"])?.is_empty()
    {
        return Err("untracked source files must be staged".into());
    }
    let executable = std::env::current_exe().map_err(|e| e.to_string())?;
    let actions = receipt::local_verification(
        &base,
        skip,
        &shard,
        executable.to_str().ok_or("non-UTF8 gate executable path")?,
        root.to_str().ok_or("non-UTF8 source root")?,
    );
    for action in actions {
        if process::interactive_progress() {
            eprintln!("[verify:pr] START {}", action.label);
        }
        let outcome =
            process::run_logged(&action.argv, &root, action.timeout_ms, action.output_cap)?;
        if outcome.kind != "success" {
            let _ = writeln!(
                std::io::stderr(),
                "[verify:pr] FAIL {} ({}, exit={})",
                action.label,
                outcome.kind,
                outcome
                    .exit_code
                    .map_or_else(|| "none".into(), |code| code.to_string())
            );
            return Ok(outcome
                .exit_code
                .filter(|c| *c > 0 && *c < 256)
                .unwrap_or(1) as u8);
        }
    }
    println!("[verify:pr] PASS  all checks");
    Ok(0)
}
fn main() -> ExitCode {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    if matches!(
        args.first().map(String::as_str),
        Some("__exec" | "__exec-stream")
    ) {
        let result = if args[0] == "__exec-stream" {
            process::helper_stream(&args[1..])
        } else {
            process::helper(&args[1..])
        };
        match result {
            Ok(code) => {
                let _ = std::io::stdout().flush();
                let _ = std::io::stderr().flush();
                // ExitCode accepts only u8. Preserve Windows NTSTATUS/32-bit failure values
                // through the internal helper; clamping them can turn a crash into exit 0.
                #[cfg(windows)]
                // SAFETY: Win32 ExitProcess accepts the complete child status and never returns.
                unsafe {
                    windows_sys::Win32::System::Threading::ExitProcess(code as u32);
                }
                #[cfg(not(windows))]
                return ExitCode::from(code as u8);
            }
            Err(error) => {
                let _ = writeln!(std::io::stderr(), "supervisor child error: {error}");
                return ExitCode::from(125);
            }
        }
    }
    match main_result(&args) {
        Ok(code) => ExitCode::from(code),
        Err(error) => {
            let _ = writeln!(
                std::io::stderr(),
                "{}",
                serde_json::json!({"schema":1,"status":"refused","error":error})
            );
            ExitCode::from(2)
        }
    }
}
