use semctx_qualification::{
    CASES, ExpectedOutcome, Report, Runtime, SupportStatus, artifact, digest,
    journeys::{Runner, run},
    observed_lane, validate_raw_case, validate_report,
};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
    process::Command,
};

fn options() -> Result<(bool, BTreeMap<String, PathBuf>), String> {
    let mut args = std::env::args().skip(1).peekable();
    let verify = args.peek().is_some_and(|a| a == "verify");
    if verify {
        args.next();
    }
    let mut options = BTreeMap::new();
    while let Some(key) = args.next() {
        if ![
            "--cli",
            "--mcp",
            "--runtime",
            "--out",
            "--plan",
            "--os",
            "--reports",
            "--native-artifacts",
        ]
        .contains(&key.as_str())
        {
            return Err(format!("unknown argument {key}"));
        }
        let value = args.next().ok_or(format!("missing value for {key}"))?;
        if value.starts_with("--") || options.insert(key.clone(), PathBuf::from(value)).is_some() {
            return Err(format!("invalid/duplicate argument {key}"));
        }
    }
    Ok((verify, options))
}
fn required(options: &BTreeMap<String, PathBuf>, key: &str) -> Result<PathBuf, String> {
    options
        .get(key)
        .cloned()
        .ok_or(format!("required argument {key}"))
}
fn plan_id(path: &Path) -> Result<String, String> {
    let value: Value = serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    let id = value["plan_id"].as_str().ok_or("plan missing plan_id")?;
    if id.len() != 64 || !id.bytes().all(|c| c.is_ascii_hexdigit()) {
        return Err("invalid plan_id".into());
    }
    Ok(id.into())
}
fn reserve(path: &Path) -> Result<PathBuf, String> {
    if !path.is_absolute() {
        return Err("--out must be absolute".into());
    }
    let parent = path.parent().ok_or("missing output parent")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    // Resolve the caller's parent, including system aliases such as macOS /var.
    // Atomic create_dir still refuses any existing destination, including a symlink.
    let output = parent
        .canonicalize()
        .map_err(|e| e.to_string())?
        .join(path.file_name().ok_or("missing output directory name")?);
    fs::create_dir(&output).map_err(|e| format!("output must be NEW: {e}"))?;
    fs::create_dir(output.join("raw")).map_err(|e| e.to_string())?;
    Ok(output)
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct NativeArtifactManifest {
    schema_version: u32,
    plan_id: String,
    cli: PathBuf,
    mcp: PathBuf,
}

fn unlinked(path: &Path) -> Result<(), String> {
    for ancestor in path.ancestors() {
        if fs::symlink_metadata(ancestor)
            .map_err(|e| e.to_string())?
            .file_type()
            .is_symlink()
        {
            return Err("symlink in native expected artifact path".into());
        }
    }
    Ok(())
}
fn native_entry(base: &Path, relative: &Path) -> Result<PathBuf, String> {
    let text = relative.to_string_lossy();
    if text.is_empty()
        || text.contains('\\')
        || text.contains(':')
        || relative
            .components()
            .any(|c| !matches!(c, std::path::Component::Normal(_)))
    {
        return Err("native manifest entrypoint escapes its OS cell".into());
    }
    let path = base.join(relative);
    unlinked(&path)?;
    if !path.is_file() {
        return Err("native entrypoint is not a file".into());
    }
    Ok(path)
}
fn native_expected(
    options: &BTreeMap<String, PathBuf>,
    os: &str,
    plan: &str,
) -> Result<(PathBuf, PathBuf), String> {
    let root = required(options, "--native-artifacts")?;
    if !root.is_absolute() {
        return Err("--native-artifacts must be absolute".into());
    }
    // The caller chooses the trusted distribution root. Resolve aliases above it
    // (for example macOS /var -> /private/var), then refuse links inside each OS cell.
    let root = root.canonicalize().map_err(|e| e.to_string())?;
    let base = root.join(os);
    unlinked(&base)?;
    let manifest_path = base.join("artifact-manifest.json");
    unlinked(&manifest_path)?;
    let manifest: NativeArtifactManifest =
        serde_json::from_slice(&fs::read(manifest_path).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    if manifest.schema_version != 1 || manifest.plan_id != plan {
        return Err("native expected artifact manifest plan/version mismatch".into());
    }
    let cli = native_entry(&base, &manifest.cli)?;
    let mcp = native_entry(&base, &manifest.mcp)?;
    Runtime::select(Path::new("native"), &cli, &mcp)?;
    Ok((cli, mcp))
}
fn verify_candidate_artifacts(
    report: &Report,
    expected_entries: (PathBuf, PathBuf),
    native_root: Option<&Path>,
    os: &str,
) -> Result<(), String> {
    // Candidate checkout is the authority for shipped bundle bytes, not hashes asserted by reports.
    for (role, selected) in [expected_entries.0, expected_entries.1]
        .into_iter()
        .enumerate()
    {
        let expected_entry = artifact(&selected)?;
        let reported_entry = &report.artifacts[role];
        let reported_path = reported_entry.path.to_string_lossy().replace('\\', "/");
        let (reported_parent, reported_name) = reported_path
            .rsplit_once('/')
            .ok_or("artifact entrypoint has no parent")?;
        if reported_entry.sha256 != expected_entry.sha256
            || Some(reported_name) != expected_entry.path.file_name().and_then(|p| p.to_str())
        {
            return Err("candidate entrypoint identity mismatch".into());
        }
        let base = selected.parent().ok_or("artifact missing parent")?;
        let mut pending = vec![base.to_path_buf()];
        while let Some(dir) = pending.pop() {
            for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
                let entry = entry.map_err(|e| e.to_string())?;
                if entry.file_type().map_err(|e| e.to_string())?.is_symlink() {
                    return Err("symlink expected artifact dependency".into());
                }
                if entry.file_type().map_err(|e| e.to_string())?.is_dir() {
                    pending.push(entry.path());
                    continue;
                }
                let expected_artifact = artifact(&entry.path())?;
                if report.runtime.kind() == "native"
                    && entry.path()
                        == native_root
                            .ok_or("required argument --native-artifacts")?
                            .join(os)
                            .join("artifact-manifest.json")
                {
                    continue;
                }
                let relative = entry
                    .path()
                    .strip_prefix(base)
                    .map_err(|e| e.to_string())?
                    .to_string_lossy()
                    .replace('\\', "/");
                let reported_dependency = format!("{reported_parent}/{relative}");
                let found: Vec<_> = report
                    .artifacts
                    .iter()
                    .filter(|a| a.path.to_string_lossy().replace('\\', "/") == reported_dependency)
                    .collect();
                if found.len() != 1 || found[0].sha256 != expected_artifact.sha256 {
                    return Err(format!(
                        "candidate bundle mismatch {relative} (role {role}, observed matches {})",
                        found.len()
                    ));
                }
            }
        }
    }
    Ok(())
}
fn verify_raw_artifacts(report: &Report, value: &Value, dir: &Path) -> Result<(), String> {
    let raw = value["raw_artifacts"]
        .as_object()
        .ok_or("missing raw inventory")?;
    if raw.is_empty() {
        return Err("empty raw inventory".into());
    }
    let runtime_observation = if report.runtime.kind() == "bun" {
        "raw/001-runtime-version.json"
    } else {
        "raw/001-runtime-identity.json"
    };
    if !raw.contains_key(runtime_observation) {
        return Err("runtime version observation missing".into());
    }
    for (relative, expected_hash) in raw {
        let relative_path = Path::new(relative);
        if !relative.starts_with("raw/")
            || relative_path
                .components()
                .any(|c| !matches!(c, std::path::Component::Normal(_)))
        {
            return Err("unsafe raw reference".into());
        }
        let bytes = fs::read(dir.join(relative)).map_err(|e| e.to_string())?;
        if expected_hash.as_str() != Some(digest(&bytes).as_str()) {
            return Err(format!("raw evidence modified: {relative}"));
        }
        let _: Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
        if relative == "raw/001-runtime-version.json" {
            if report.runtime.kind() != "bun" {
                return Err("Bun version observation in native report".into());
            }
            let observed: semctx_qualification::process::Observation =
                serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
            if observed.code != Some(0)
                || observed.timed_out
                || observed.output_exceeded
                || observed.stdout.trim() != "1.4.3"
            {
                return Err("unqualified Bun adapter runtime".into());
            }
        }
        if relative == "raw/001-runtime-identity.json"
            && serde_json::from_slice::<Value>(&bytes).map_err(|e| e.to_string())?
                != serde_json::to_value(&report.runtime).map_err(|e| e.to_string())?
        {
            return Err("native runtime identity observation mismatch".into());
        }
    }
    for case in &report.cases {
        for reference in &case.observations {
            let (path, hash) = reference
                .split_once("#sha256=")
                .ok_or("invalid observation reference")?;
            if raw.get(path).and_then(Value::as_str) != Some(hash) {
                return Err("observation not bound to raw artifact".into());
            }
            let observation: Value =
                serde_json::from_slice(&fs::read(dir.join(path)).map_err(|e| e.to_string())?)
                    .map_err(|e| e.to_string())?;
            validate_raw_case(&case.id, &observation)?;
        }
    }
    Ok(())
}
fn verify_reports(options: &BTreeMap<String, PathBuf>) -> Result<Value, String> {
    let expected = plan_id(&required(options, "--plan")?)?;
    let root = required(options, "--reports")?;
    let mut seen = BTreeSet::new();
    let mut runtime_kinds = BTreeSet::new();
    // Check the declared execution family before evaluating any OS-specific artifacts.
    // A mixed matrix cannot silently promote Bun evidence into native qualification.
    for entry in fs::read_dir(&root).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let value: Value = serde_json::from_slice(
            &fs::read(entry.path().join("report.json")).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        runtime_kinds.insert(
            value["runtime"]["kind"]
                .as_str()
                .ok_or("missing runtime kind")?
                .to_owned(),
        );
    }
    if runtime_kinds.len() != 1 {
        return Err("mixed native and Bun qualification runtimes".into());
    }
    let native_root = if runtime_kinds.contains("native") {
        options
            .get("--native-artifacts")
            .map(|root| root.canonicalize().map_err(|e| e.to_string()))
            .transpose()?
    } else {
        None
    };
    // Discover one report in each downloaded native-OS artifact, never recursively accept extras.
    for entry in fs::read_dir(&root).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if !entry.file_type().map_err(|e| e.to_string())?.is_dir() {
            return Err("foreign report artifact".into());
        }
        let dir = entry.path();
        let value: Value =
            serde_json::from_slice(&fs::read(dir.join("report.json")).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
        if value["plan_id"] != expected {
            return Err("qualification plan identity mismatch".into());
        }
        let os = value["os"].as_str().ok_or("missing OS")?;
        if !["ubuntu-latest", "windows-latest", "macos-15"].contains(&os)
            || !seen.insert(os.to_owned())
        {
            return Err("unknown or duplicate qualification OS".into());
        }
        let mut typed = value.clone();
        typed
            .as_object_mut()
            .ok_or("invalid report")?
            .remove("plan_id");
        typed
            .as_object_mut()
            .ok_or("invalid report")?
            .remove("raw_artifacts");
        let report: Report = serde_json::from_value(typed).map_err(|e| e.to_string())?;
        validate_report(&report)?;
        if let Some(requested) = options.get("--runtime")
            && (requested == Path::new("native")) != (report.runtime.kind() == "native")
        {
            return Err("qualification runtime kind does not match admission mode".into());
        }
        if report.status != "qualified" {
            return Err(format!("qualification failed on {os}"));
        }
        let expected_entries = if let Runtime::Native { cli, mcp } = &report.runtime {
            let (expected_cli, expected_mcp) = native_expected(options, os, &expected)?;
            let expected = Runtime::select(Path::new("native"), &expected_cli, &expected_mcp)?;
            if let Runtime::Native {
                cli: expected_cli,
                mcp: expected_mcp,
            } = expected
                && (cli.sha256 != expected_cli.sha256 || mcp.sha256 != expected_mcp.sha256)
            {
                return Err("native runtime entrypoint identity mismatch".into());
            }
            (expected_cli, expected_mcp)
        } else {
            (
                options
                    .get("--cli")
                    .cloned()
                    .unwrap_or_else(|| PathBuf::from("plugins/semctx-control/dist/semctx.js")),
                options
                    .get("--mcp")
                    .cloned()
                    .unwrap_or_else(|| PathBuf::from("plugins/semctx-control/dist/semctx-mcp.js")),
            )
        };
        verify_candidate_artifacts(&report, expected_entries, native_root.as_deref(), os)?;
        verify_raw_artifacts(&report, &value, &dir)?;
    }
    if seen.len() != 3 {
        return Err("required three OS qualification reports missing".into());
    }
    Ok(json!({"schema_version":1,"status":"qualified","plan_id":expected,"os":seen,"cases":CASES}))
}
fn artifact_identities(
    cli: &Path,
    mcp: &Path,
    runtime: &Runtime,
) -> Result<Vec<semctx_qualification::Artifact>, String> {
    for path in [cli, mcp] {
        if !path.is_absolute() {
            return Err("artifact paths must be absolute".into());
        }
    }
    let mut identities = vec![artifact(cli)?, artifact(mcp)?];
    if let Runtime::Bun { identity, .. } = runtime {
        identities.push(identity.clone());
    }
    // Bind portable chunks, workers and compiler libraries as well as entrypoints.
    let mut pending = vec![
        cli.parent().ok_or("CLI has no parent")?.to_path_buf(),
        mcp.parent().ok_or("MCP has no parent")?.to_path_buf(),
    ];
    let mut seen = BTreeSet::new();
    while let Some(dir) = pending.pop() {
        for item in fs::read_dir(dir).map_err(|e| e.to_string())? {
            let item = item.map_err(|e| e.to_string())?;
            let path = item.path();
            if !seen.insert(path.clone()) {
                continue;
            }
            let kind = item.file_type().map_err(|e| e.to_string())?;
            if kind.is_symlink() {
                return Err("symlink artifact refused".into());
            }
            if kind.is_dir() {
                pending.push(path);
            } else if kind.is_file() {
                let identified = artifact(&path)?;
                if !identities.iter().any(|a| a.path == identified.path) {
                    identities.push(identified);
                }
            }
        }
    }
    Ok(identities)
}
fn record_runtime(runner: &mut Runner, root: &Path) -> Result<(), String> {
    match runner.runtime.clone() {
        Runtime::Bun { identity, .. } => {
            let runtime_ob = semctx_qualification::process::run(
                Command::new(&identity.path).arg("--version"),
                root,
                semctx_qualification::process::BUDGET,
            )
            .map_err(|e| e.to_string())?;
            runner.record("runtime-version", &runtime_ob)?;
            if runtime_ob.code == Some(0)
                && !runtime_ob.timed_out
                && !runtime_ob.output_exceeded
                && runtime_ob.stdout.trim() == "1.4.3"
            {
                Ok(())
            } else {
                Err("legacy adapter requires exact Bun 1.4.3 qualification runtime".to_owned())
            }
        }
        native @ Runtime::Native { .. } => {
            runner.record("runtime-identity", &native)?;
            Ok(())
        }
    }
}
fn main_run() -> Result<Value, String> {
    let (verifying, options) = options()?;
    if verifying {
        return verify_reports(&options);
    }
    // Observe the producer, not the host later aggregating downloaded reports.
    // Reject a mislabeled lane before reading artifacts or running a product process.
    let os = observed_lane(
        options
            .get("--os")
            .map(|value| value.to_str().ok_or("non UTF-8 OS lane"))
            .transpose()?,
    )?;
    let cli = required(&options, "--cli")?;
    let mcp = required(&options, "--mcp")?;
    let runtime = Runtime::select(&required(&options, "--runtime")?, &cli, &mcp)?;
    let identities = artifact_identities(&cli, &mcp, &runtime)?;
    let out = reserve(&required(&options, "--out")?)?;
    let root = tempfile::Builder::new()
        .prefix("semctx-rust-qualification-")
        .tempdir()
        .map_err(|e| e.to_string())?;
    let mut runner = Runner {
        cli,
        mcp,
        runtime,
        out: out.clone(),
        cases: vec![],
        next: 0,
    };
    let runtime_ready = record_runtime(&mut runner, root.path());
    let result = runtime_ready.and_then(|_| run(&mut runner, root.path()));
    let final_error = identities
        .iter()
        .try_for_each(|before| {
            if artifact(&before.path)?.sha256 == before.sha256 {
                Ok(())
            } else {
                Err("artifact drift during qualification".to_string())
            }
        })
        .err()
        .or_else(|| result.err());
    if let Some(error) = final_error {
        let raw = runner.record("runner-failure", &json!({"error":error}))?;
        for id in CASES {
            if !runner.cases.iter().any(|c| c.id == *id) {
                runner.case(
                    id,
                    SupportStatus::NotQualified,
                    raw.clone(),
                    Err(error.clone()),
                    ExpectedOutcome::UsefulSuccess,
                );
            }
        }
        if runner.cases.iter().all(|c| c.outcome != "failure") {
            runner.cases[0].outcome = "failure".into();
            runner.cases[0].detail = error;
        }
    }
    let status = if runner.cases.iter().all(|case| case.outcome != "failure") {
        "qualified"
    } else {
        "failed"
    };
    let report = Report {
        schema_version: 1,
        status: status.into(),
        os: os.as_str().into(),
        arch: std::env::consts::ARCH.into(),
        host_os: std::env::consts::OS.into(),
        host_arch: std::env::consts::ARCH.into(),
        adapter: runner.runtime.adapter().into(),
        runtime: runner.runtime,
        artifacts: identities,
        cases: runner.cases,
        host_activation: "not_observed".into(),
        limitations: vec!["CLI and direct MCP only; installed host activation, background hooks and semantic precision are not qualified by this report".into()],
    };
    validate_report(&report)?;
    let mut value = serde_json::to_value(report).map_err(|e| e.to_string())?;
    if let Some(plan) = options.get("--plan") {
        value["plan_id"] = json!(plan_id(plan)?);
    }
    let mut raws = BTreeMap::new();
    for file in fs::read_dir(out.join("raw")).map_err(|e| e.to_string())? {
        let file = file.map_err(|e| e.to_string())?;
        raws.insert(
            format!("raw/{}", file.file_name().to_string_lossy()),
            digest(&fs::read(file.path()).map_err(|e| e.to_string())?),
        );
    }
    value["raw_artifacts"] = json!(raws);
    fs::write(
        out.join("report.json"),
        serde_json::to_vec_pretty(&value).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    Ok(value)
}
fn main() {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    if matches!(
        args.first().map(String::as_str),
        Some("__exec" | "__exec-stream")
    ) {
        use std::io::Write;
        let result = if args[0] == "__exec-stream" {
            semctx_gates::process::helper_stream(&args[1..])
        } else {
            semctx_gates::process::helper(&args[1..])
        };
        let code = match result {
            Ok(code) => code,
            Err(error) => {
                eprintln!("supervisor child error: {error}");
                125
            }
        };
        let _ = std::io::stdout().flush();
        let _ = std::io::stderr().flush();
        #[cfg(windows)]
        // SAFETY: Windows ExitProcess terminates this helper and its stdin forwarding thread.
        unsafe {
            windows_sys::Win32::System::Threading::ExitProcess(code as u32);
        }
        #[cfg(not(windows))]
        std::process::exit(code);
    }
    semctx_gates::process::install_cancellation();
    let value = main_run()
        .unwrap_or_else(|error| json!({"schema_version":1,"status":"failed","error":error}));
    if let Err(error) = serde_json::to_writer_pretty(std::io::stdout().lock(), &value) {
        eprintln!("qualification output: {error}");
        std::process::exit(1);
    }
    println!();
    if value["status"] != "qualified" {
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use semctx_qualification::{Artifact, Case};

    fn raw_case(id: &str) -> Value {
        let verify = |path: &str, risk: bool| json!({"head":"HEAD","base":null,"range":null,"mergeBase":null,"changedFiles":[path],"verdict":if risk{"WARN"}else{"PASS"},"findings":if risk{json!([{"rule":"contract_changed_without_test","severity":"warn"}])}else{json!([])},"summary":{"blockCount":0,"warnCount":usize::from(risk)}});
        let (code,stdout,stderr)=match id {
            "cli.setup" => (0,json!({"setupReady":true}).to_string(),String::new()),
            "cli.partial-coverage" => (0,json!({"setupReady":true,"selection":{"selectedByLanguage":{"python":1}},"indexHealth":{"coverage":{"status":"partial"},"reasonSummary":["NEGATIVE_COMPLETENESS_MISSING"]}}).to_string(),String::new()),
            "cli.benign" => (0,verify("src/symbol.ts",false).to_string(),String::new()),
            "cli.contract-risk" => (0,verify("src/cart.ts",true).to_string(),String::new()),
            "cli.missing-index" => (1,String::new(),"[REPO_NOT_INDEXED] missing".into()),
            "cli.invalid-config" => (1,String::new(),"[CONFIG_INVALID] invalid".into()),
            "cli.stale" => (3,json!({"verdict":"UNSEALED","canRunHighRiskControl":false,"explanation":[{"code":"EVIDENCE_BASELINE_STALE","remedy":"semctx index --record"}]}).to_string(),String::new()),
            "cli.repaired" => (0,json!({"verdict":"FRESH"}).to_string(),String::new()),
            "mcp.initialize" => return json!({"protocolVersion":"2025-03-26","serverInfo":{"name":"semctx"}}),
            "mcp.tools" => return json!({"tools":[{"name":"semctx_inspect"},{"name":"semctx_control_status"},{"name":"semctx_index_health"}]}),
            "mcp.control-status" => return json!({"verdict":"FRESH","canRunHighRiskControl":true}),
            "mcp.inspect" => return json!({"inspect":{"matchedNodes":[{"name":"oldSymbol"}]},"health":{"binding":{"status":"valid"}}}),
            "mcp.refresh" => return json!({"pid":42,"old":{"kind":"symbol","query":"oldSymbol","matchedNodes":[]},"new":{"matchedNodes":[{"name":"newSymbol"}]},"health":{"binding":{"status":"valid"}}}),
            _=>panic!("unknown case")
        };
        json!({"observation":{"code":code,"stdout":stdout,"stderr":stderr,"duration_ms":1,"timed_out":false,"output_exceeded":false}})
    }

    fn sample(root: &Path) -> BTreeMap<String, PathBuf> {
        let reports = root.join("reports");
        fs::create_dir(&reports).unwrap();
        let dist = root.join("dist");
        fs::create_dir(&dist).unwrap();
        fs::write(dist.join("semctx.js"), "fixture-cli").unwrap();
        fs::write(dist.join("semctx-mcp.js"), "fixture-mcp").unwrap();
        fs::write(dist.join("shared.js"), "fixture-shared").unwrap();
        let artifacts = vec![
            artifact(&dist.join("semctx.js")).unwrap(),
            artifact(&dist.join("semctx-mcp.js")).unwrap(),
            Artifact {
                path: PathBuf::from("/runtime/bun"),
                sha256: "a".repeat(64),
            },
            artifact(&dist.join("shared.js")).unwrap(),
        ];
        let plan = root.join("plan.json");
        fs::write(&plan, json!({"plan_id":"b".repeat(64)}).to_string()).unwrap();
        for os in ["ubuntu-latest", "windows-latest", "macos-15"] {
            let dir = reports.join(format!("native-{os}"));
            fs::create_dir(&dir).unwrap();
            fs::create_dir(dir.join("raw")).unwrap();
            let mut raws = BTreeMap::new();
            let version=json!({"code":0,"stdout":"1.4.3\n","stderr":"","timed_out":false,"output_exceeded":false,"duration_ms":1}).to_string();
            fs::write(dir.join("raw/001-runtime-version.json"), &version).unwrap();
            raws.insert(
                "raw/001-runtime-version.json".to_owned(),
                digest(version.as_bytes()),
            );
            let mut cases = Vec::new();
            for id in CASES {
                let bytes = serde_json::to_vec(&raw_case(id)).unwrap();
                let path = format!("raw/{id}.json");
                let hash = digest(&bytes);
                fs::write(dir.join(&path), bytes).unwrap();
                raws.insert(path.clone(), hash.clone());
                cases.push(Case {
                    id: id.to_string(),
                    support_status: match *id {
                        "cli.partial-coverage" => "partial",
                        "cli.missing-index" | "cli.invalid-config" => "unsupported",
                        _ => "supported",
                    }
                    .into(),
                    outcome: if ["cli.missing-index", "cli.invalid-config", "cli.stale"]
                        .contains(id)
                    {
                        "controlled_refusal"
                    } else {
                        "useful_success"
                    }
                    .into(),
                    obligations: vec![id.to_string()],
                    observations: vec![format!("{path}#sha256={hash}")],
                    detail: "synthetic oracle fixture; never production qualification".into(),
                });
            }
            let report = Report {
                schema_version: 1,
                status: "qualified".into(),
                os: os.into(),
                arch: "test".into(),
                host_os: semctx_qualification::lane_host_os(os).unwrap().into(),
                host_arch: "test".into(),
                adapter: "bun-legacy-explicit-1.4.3".into(),
                runtime: Runtime::Bun {
                    identity: artifacts[2].clone(),
                    version: "1.4.3".into(),
                },
                artifacts: artifacts.clone(),
                cases,
                host_activation: "not_observed".into(),
                limitations: vec![],
            };
            let mut report = serde_json::to_value(report).unwrap();
            report["plan_id"] = json!("b".repeat(64));
            report["raw_artifacts"] = json!(raws);
            fs::write(dir.join("report.json"), report.to_string()).unwrap();
        }
        BTreeMap::from([
            ("--reports".into(), reports),
            ("--plan".into(), plan),
            ("--cli".into(), dist.join("semctx.js")),
            ("--mcp".into(), dist.join("semctx-mcp.js")),
        ])
    }
    #[test]
    fn separate_cli_and_mcp_distributions_disambiguate_shared_dependency_names() {
        let root = tempfile::tempdir().unwrap();
        let mut options = sample(root.path());
        let old_cli = options["--cli"].clone();
        let mcp_dir = options["--mcp"].parent().unwrap().to_path_buf();
        let cli_dir = root.path().join("cli-distribution");
        fs::create_dir(&cli_dir).unwrap();
        let cli = cli_dir.join("index.js");
        fs::copy(&old_cli, &cli).unwrap();
        fs::write(cli_dir.join("shared.js"), "CLI dependency").unwrap();
        fs::write(mcp_dir.join("shared.js"), "MCP dependency").unwrap();
        for entry in fs::read_dir(&options["--reports"]).unwrap() {
            let path = entry.unwrap().path().join("report.json");
            let mut value: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
            let artifacts = value["artifacts"].as_array_mut().unwrap();
            artifacts.push(artifacts[0].clone());
            artifacts[0] = serde_json::to_value(artifact(&cli).unwrap()).unwrap();
            for dependency in [cli_dir.join("shared.js"), mcp_dir.join("shared.js")] {
                let identified = serde_json::to_value(artifact(&dependency).unwrap()).unwrap();
                if let Some(existing) = artifacts
                    .iter_mut()
                    .find(|entry| entry["path"] == identified["path"])
                {
                    *existing = identified;
                } else {
                    artifacts.push(identified);
                }
            }
            fs::write(path, value.to_string()).unwrap();
        }
        options.insert("--cli".into(), cli);
        let admitted = verify_reports(&options);
        assert!(
            admitted.is_ok(),
            "same-name dependencies have distinct distribution identities: {admitted:?}"
        );
        fs::write(cli_dir.join("shared.js"), "substituted CLI dependency").unwrap();
        assert!(verify_reports(&options).is_err());
    }
    #[test]
    fn aggregate_accepts_complete_obligations() {
        let root = tempfile::tempdir().unwrap();
        let options = sample(root.path());
        assert!(verify_reports(&options).is_ok());
    }
    #[test]
    fn aggregate_rejects_missing_os() {
        let root = tempfile::tempdir().unwrap();
        let options = sample(root.path());
        fs::remove_dir_all(options["--reports"].join("native-macos-15")).unwrap();
        assert!(verify_reports(&options).is_err());
    }
    #[test]
    fn aggregate_rejects_modified_raw() {
        let root = tempfile::tempdir().unwrap();
        let options = sample(root.path());
        fs::write(
            options["--reports"].join("native-windows-latest/raw/cli.benign.json"),
            "{}",
        )
        .unwrap();
        assert!(verify_reports(&options).is_err());
    }
    #[test]
    fn aggregate_rejects_wrong_plan() {
        let root = tempfile::tempdir().unwrap();
        let options = sample(root.path());
        fs::write(
            &options["--plan"],
            json!({"plan_id":"c".repeat(64)}).to_string(),
        )
        .unwrap();
        assert!(verify_reports(&options).is_err());
    }
    #[test]
    fn aggregate_rejects_candidate_shared_chunk_drift() {
        let root = tempfile::tempdir().unwrap();
        let options = sample(root.path());
        fs::write(
            options["--cli"].parent().unwrap().join("shared.js"),
            "wrong candidate",
        )
        .unwrap();
        assert!(verify_reports(&options).is_err());
    }
    #[test]
    fn aggregate_rejects_duplicate_os_and_missing_cases() {
        for duplicate in [true, false] {
            let root = tempfile::tempdir().unwrap();
            let options = sample(root.path());
            let path = options["--reports"].join("native-macos-15/report.json");
            let mut report: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
            if duplicate {
                report["os"] = json!("windows-latest");
            } else {
                report["cases"].as_array_mut().unwrap().pop();
            }
            fs::write(path, report.to_string()).unwrap();
            assert!(verify_reports(&options).is_err());
        }
    }
    #[test]
    fn aggregate_rejects_forged_green_despite_rehashed_wrong_refusal() {
        let root = tempfile::tempdir().unwrap();
        let options = sample(root.path());
        let dir = options["--reports"].join("native-macos-15");
        let path = dir.join("report.json");
        let mut report: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        let relative = "raw/cli.missing-index.json";
        let mut raw = raw_case("cli.missing-index");
        raw["observation"]["stderr"] = json!("[CONFIG_INVALID] wrong reason");
        let bytes = raw.to_string();
        let hash = digest(bytes.as_bytes());
        fs::write(dir.join(relative), bytes).unwrap();
        report["raw_artifacts"][relative] = json!(hash);
        for case in report["cases"].as_array_mut().unwrap() {
            if case["id"] == "cli.missing-index" {
                case["observations"] = json!([format!("{relative}#sha256={hash}")]);
            }
        }
        fs::write(path, report.to_string()).unwrap();
        assert!(verify_reports(&options).is_err());
    }
    #[test]
    fn native_report_kind_is_explicit_not_product_qualification() {
        let root = tempfile::tempdir().unwrap();
        let options = sample(root.path());
        let bytes = fs::read(options["--reports"].join("native-macos-15/report.json")).unwrap();
        let mut value: Value = serde_json::from_slice(&bytes).unwrap();
        value.as_object_mut().unwrap().remove("plan_id");
        value.as_object_mut().unwrap().remove("raw_artifacts");
        let mut report: Report = serde_json::from_value(value).unwrap();
        report.runtime = Runtime::Native {
            cli: report.artifacts[0].clone(),
            mcp: report.artifacts[1].clone(),
        };
        report.adapter = "native-explicit-v1".into();
        assert!(validate_report(&report).is_ok());
        report.adapter = "bun-legacy-explicit-1.4.3".into();
        assert!(validate_report(&report).is_err());
    }
    #[test]
    fn aggregate_rejects_mixed_runtime_kinds_and_incompatible_explicit_mode() {
        let root = tempfile::tempdir().unwrap();
        let mut options = sample(root.path());
        options.insert("--runtime".into(), PathBuf::from("native"));
        assert!(
            verify_reports(&options)
                .unwrap_err()
                .contains("does not match")
        );
        options.remove("--runtime");
        let path = options["--reports"].join("native-macos-15/report.json");
        let mut report: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        report["runtime"] =
            json!({"kind":"native","cli":report["artifacts"][0],"mcp":report["artifacts"][1]});
        report["adapter"] = json!("native-explicit-v1");
        fs::write(path, report.to_string()).unwrap();
        assert!(
            verify_reports(&options)
                .unwrap_err()
                .contains("mixed native and Bun")
        );
    }
    #[test]
    fn aggregate_rejects_false_bun_runtime_version() {
        let root = tempfile::tempdir().unwrap();
        let options = sample(root.path());
        let path = options["--reports"].join("native-macos-15/report.json");
        let mut report: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        report["runtime"]["version"] = json!("1.4.2");
        fs::write(path, report.to_string()).unwrap();
        assert!(verify_reports(&options).is_err());
    }
    #[test]
    fn aggregate_rejects_os_lane_and_observed_host_inconsistency() {
        // Data-only negative admission fixtures; no OS executions are represented by this test.
        for wrong_arch in [false, true] {
            let root = tempfile::tempdir().unwrap();
            let options = sample(root.path());
            let path = options["--reports"].join("native-macos-15/report.json");
            let mut report: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
            if wrong_arch {
                report["host_arch"] = json!("different-from-arch");
            } else {
                report["host_os"] = json!("windows");
            }
            fs::write(path, report.to_string()).unwrap();
            assert!(verify_reports(&options).is_err());
        }
    }
    fn native_sample(root: &Path) -> BTreeMap<String, PathBuf> {
        native_sample_layout(root, Path::new("bin"))
    }
    fn native_sample_layout(root: &Path, directory: &Path) -> BTreeMap<String, PathBuf> {
        let mut options = sample(root);
        let expected_root = root.join("expected-native");
        fs::create_dir(&expected_root).unwrap();
        for os in ["ubuntu-latest", "windows-latest", "macos-15"] {
            let base = expected_root.join(os);
            let bin = base.join(directory);
            fs::create_dir_all(&bin).unwrap();
            let suffix = if os == "windows-latest" { ".exe" } else { "" };
            let cli_relative = directory
                .join(format!("semctx{suffix}"))
                .to_string_lossy()
                .replace('\\', "/");
            let mcp_relative = directory
                .join(format!("semctx-mcp{suffix}"))
                .to_string_lossy()
                .replace('\\', "/");
            fs::write(
                base.join(&cli_relative),
                format!("MZsynthetic cli artifact for {os}"),
            )
            .unwrap();
            fs::write(
                base.join(&mcp_relative),
                format!("MZsynthetic mcp artifact for {os}"),
            )
            .unwrap();
            fs::write(
                bin.join("runtime-support.bin"),
                format!("independent native dependency for {os}"),
            )
            .unwrap();
            fs::write(base.join("artifact-manifest.json"),json!({"schema_version":1,"plan_id":"b".repeat(64),"cli":cli_relative,"mcp":mcp_relative}).to_string()).unwrap();
            let cli = artifact(&base.join(&cli_relative)).unwrap();
            let mcp = artifact(&base.join(&mcp_relative)).unwrap();
            let runtime = Runtime::Native {
                cli: cli.clone(),
                mcp: mcp.clone(),
            };
            let report_dir = options["--reports"].join(format!("native-{os}"));
            let path = report_dir.join("report.json");
            let mut report: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
            report["runtime"] = serde_json::to_value(&runtime).unwrap();
            report["adapter"] = json!("native-explicit-v1");
            report["artifacts"] = json!([
                cli,
                mcp,
                artifact(&bin.join("runtime-support.bin")).unwrap()
            ]);
            report["raw_artifacts"]
                .as_object_mut()
                .unwrap()
                .remove("raw/001-runtime-version.json");
            fs::remove_file(report_dir.join("raw/001-runtime-version.json")).unwrap();
            let bytes = serde_json::to_vec(&runtime).unwrap();
            fs::write(report_dir.join("raw/001-runtime-identity.json"), &bytes).unwrap();
            report["raw_artifacts"]["raw/001-runtime-identity.json"] = json!(digest(&bytes));
            fs::write(path, report.to_string()).unwrap();
        }
        options.insert("--runtime".into(), PathBuf::from("native"));
        options.insert("--native-artifacts".into(), expected_root);
        options
    }
    #[test]
    fn output_reservation_never_reuses_an_existing_directory() {
        let root = tempfile::tempdir().unwrap();
        let output = reserve(&root.path().join("observations")).unwrap();
        fs::write(output.join("existing.txt"), "preserve this evidence").unwrap();
        assert!(reserve(&output).unwrap_err().contains("NEW"));
        assert_eq!(
            fs::read_to_string(output.join("existing.txt")).unwrap(),
            "preserve this evidence"
        );
    }
    #[test]
    #[cfg(unix)]
    fn output_reservation_resolves_a_system_parent_alias_but_refuses_an_existing_link() {
        let root = tempfile::tempdir().unwrap();
        let outer = tempfile::tempdir().unwrap();
        let alias = outer.path().join("parent-alias");
        std::os::unix::fs::symlink(root.path(), &alias).unwrap();
        let output = reserve(&alias.join("observations")).unwrap();
        assert_eq!(
            output,
            root.path().canonicalize().unwrap().join("observations")
        );
        std::os::unix::fs::symlink(&output, alias.join("existing-link")).unwrap();
        assert!(
            reserve(&alias.join("existing-link"))
                .unwrap_err()
                .contains("NEW")
        );
    }
    #[test]
    fn synthetic_three_os_native_records_require_independent_target_artifacts() {
        let root = tempfile::tempdir().unwrap();
        let mut options = native_sample(root.path());
        let admitted = verify_reports(&options);
        assert!(admitted.is_ok(), "{admitted:?}");
        options.remove("--native-artifacts");
        assert!(
            verify_reports(&options)
                .unwrap_err()
                .contains("--native-artifacts")
        );
    }
    #[test]
    #[cfg(unix)]
    fn native_admission_accepts_an_alias_above_the_trusted_distribution_root() {
        let root = tempfile::tempdir().unwrap();
        let mut options = native_sample(root.path());
        let outer = tempfile::tempdir().unwrap();
        let alias = outer.path().join("root-alias");
        std::os::unix::fs::symlink(root.path(), &alias).unwrap();
        options.insert("--native-artifacts".into(), alias.join("expected-native"));
        assert!(verify_reports(&options).is_ok());
    }
    #[test]
    #[cfg(unix)]
    fn native_admission_resolves_aliases_for_direct_and_nested_entrypoints() {
        for directory in [Path::new(""), Path::new("bin")] {
            let root = tempfile::tempdir().unwrap();
            let mut options = native_sample_layout(root.path(), directory);
            let outer = tempfile::tempdir().unwrap();
            let alias = outer.path().join("root-alias");
            std::os::unix::fs::symlink(root.path(), &alias).unwrap();
            options.insert("--native-artifacts".into(), alias.join("expected-native"));
            let admitted = verify_reports(&options);
            assert!(admitted.is_ok(), "layout {directory:?}: {admitted:?}");
            fs::write(
                options["--native-artifacts"]
                    .join("macos-15")
                    .join(directory)
                    .join("runtime-support.bin"),
                "substituted dependency",
            )
            .unwrap();
            assert!(verify_reports(&options).is_err());
        }
    }
    #[test]
    fn native_admission_rejects_missing_or_wrong_plan_manifest() {
        for missing in [true, false] {
            let root = tempfile::tempdir().unwrap();
            let options = native_sample(root.path());
            let path = options["--native-artifacts"].join("macos-15/artifact-manifest.json");
            if missing {
                fs::remove_file(path).unwrap();
            } else {
                let mut manifest: Value =
                    serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
                manifest["plan_id"] = json!("c".repeat(64));
                fs::write(path, manifest.to_string()).unwrap();
            }
            assert!(verify_reports(&options).is_err());
        }
    }
    #[test]
    fn native_admission_rejects_os_swaps_and_dependency_substitution() {
        for swap in [true, false] {
            let root = tempfile::tempdir().unwrap();
            let options = native_sample(root.path());
            let expected = &options["--native-artifacts"];
            if swap {
                fs::copy(
                    expected.join("windows-latest/bin/semctx.exe"),
                    expected.join("ubuntu-latest/bin/semctx"),
                )
                .unwrap();
            } else {
                fs::write(
                    expected.join("ubuntu-latest/bin/runtime-support.bin"),
                    "substituted dependency",
                )
                .unwrap();
            }
            assert!(verify_reports(&options).is_err());
        }
    }
    #[test]
    fn native_admission_rejects_manifest_path_escape_and_report_digest_substitution() {
        let root = tempfile::tempdir().unwrap();
        let options = native_sample(root.path());
        let path = options["--native-artifacts"].join("macos-15/artifact-manifest.json");
        let mut manifest: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        manifest["cli"] = json!("../ubuntu-latest/bin/semctx");
        fs::write(path, manifest.to_string()).unwrap();
        assert!(verify_reports(&options).is_err());
        let root = tempfile::tempdir().unwrap();
        let options = native_sample(root.path());
        let path = options["--reports"].join("native-macos-15/report.json");
        let mut report: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        report["artifacts"][0]["sha256"] = json!("d".repeat(64));
        report["runtime"]["cli"]["sha256"] = json!("d".repeat(64));
        fs::write(path, report.to_string()).unwrap();
        assert!(verify_reports(&options).is_err());
    }
    #[cfg(unix)]
    #[test]
    fn native_admission_rejects_symlink_expected_dependency() {
        let root = tempfile::tempdir().unwrap();
        let options = native_sample(root.path());
        let base = options["--native-artifacts"].join("ubuntu-latest/bin");
        fs::rename(
            base.join("runtime-support.bin"),
            base.join("real-support.bin"),
        )
        .unwrap();
        std::os::unix::fs::symlink("real-support.bin", base.join("runtime-support.bin")).unwrap();
        assert!(verify_reports(&options).is_err());
    }
}
