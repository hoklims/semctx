use super::*;
#[path = "worker_response.rs"]
mod response;
pub fn consume_worker(descriptor: &serde_json::Value) -> serde_json::Value {
    response::consume(descriptor)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkerRequest {
    schema_version: f64,
    job_id: String,
    repo_root: String,
    root_abs_paths: Vec<String>,
    emit_abs_paths: Vec<String>,
}

fn failure(job: &str, error: &str) -> serde_json::Value {
    serde_json::json!({"schemaVersion":1,"jobId":job,"ok":false,"error":error,"extraction_started":false})
}

pub(super) fn read_repository(
    root: &std::path::Path,
) -> Result<(BTreeMap<String, String>, Vec<serde_json::Value>), String> {
    let native_path = |path: &std::path::Path| -> Result<String, String> {
        let text = path.to_str().ok_or("worker capture path is not UTF-8")?;
        if cfg!(unix) && text.contains('\\') {
            return Err("worker capture path contains a nonportable separator".into());
        }
        Ok(text.replace('\\', "/"))
    };
    let canonical = root
        .canonicalize()
        .map_err(|error| format!("worker repository unavailable: {error}"))?;
    native_path(root)?;
    native_path(&canonical)?;
    if !canonical.is_dir() {
        return Err("worker repository unavailable: not a directory".into());
    }
    let mut pending = vec![root.to_path_buf()];
    let mut visited = BTreeSet::new();
    let mut files = BTreeMap::new();
    let mut reads = Vec::new();
    let mut total = 0usize;
    while let Some(directory) = pending.pop() {
        let actual = directory
            .canonicalize()
            .map_err(|error| error.to_string())?;
        if !actual.starts_with(&canonical) || !visited.insert(actual) {
            continue;
        }
        let mut entries = std::fs::read_dir(&directory)
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        entries.sort_by_key(std::fs::DirEntry::file_name);
        for entry in entries {
            if entry.file_name() == ".git" {
                continue;
            }
            let path = entry.path();
            let actual = path.canonicalize().map_err(|error| error.to_string())?;
            if !actual.starts_with(&canonical) {
                continue;
            }
            let metadata = std::fs::metadata(&path).map_err(|error| error.to_string())?;
            if metadata.is_dir() {
                pending.push(path);
                continue;
            }
            if !metadata.is_file() {
                continue;
            }
            if files.len() >= 20_000 || metadata.len() > 33_554_432 {
                return Err("worker capture limit exceeded".into());
            }
            let bytes = std::fs::read(&path).map_err(|error| error.to_string())?;
            total = total
                .checked_add(bytes.len())
                .ok_or("worker capture size overflow")?;
            if total > 33_554_432 {
                return Err("worker capture limit exceeded".into());
            }
            let logical = native_path(&path)?;
            let physical = native_path(&actual)?;
            let text = source_text::decode(&bytes, source_text::ReadProfile::CompilerSystem);
            let decoded_id = identity::digest_bytes(text.as_bytes());
            if files.insert(logical.clone(), text).is_some() {
                return Err("worker capture contains a duplicate logical path".into());
            }
            reads.push(serde_json::json!({"path":logical,"canonical_path":physical,"raw_bytes_sha256":identity::digest_bytes(&bytes),"decoded_port_text_sha256":decoded_id}));
        }
    }
    reads.sort_by(|left, right| left["path"].as_str().cmp(&right["path"].as_str()));
    Ok((files, reads))
}

pub(super) fn absolute_worker_path(path: &str) -> Result<String, String> {
    let path = std::path::absolute(if path.is_empty() { "." } else { path })
        .map_err(|error| error.to_string())?;
    Ok(ts_goport::frontend::tspath::normalize_path(
        &path.to_string_lossy(),
    ))
}

fn extract(
    request: &WorkerRequest,
    sdk: &Sdk,
    started: &mut bool,
    source_identity: &source_identity::SourceIdentity,
) -> Result<serde_json::Value, String> {
    if !sdk.matches_reference() {
        return Err("foreign SDK descriptor".into());
    }
    sdk.validate_libraries("/sdk/lib")?;
    for variable in ["GOPORT_LIB_PARSE_SNAPSHOT", "GOPORT_LIB_SNAPSHOT"] {
        if std::env::var(variable).as_deref() != Ok("0") {
            return Err(format!("captured SDK requires {variable}=0"));
        }
    }
    let roots = request
        .root_abs_paths
        .iter()
        .map(|path| absolute_worker_path(path))
        .collect::<Result<Vec<_>, _>>()?;
    let emit = request
        .emit_abs_paths
        .iter()
        .map(|path| absolute_worker_path(path))
        .collect::<Result<Vec<_>, _>>()?;
    let root = absolute_worker_path(&request.repo_root)?;
    let (mut files, reads) = read_repository(std::path::Path::new(&root))?;
    let sensitive = ts_goport::frontend::vfs::osvfs_fs().use_case_sensitive_file_names();
    for path in &roots {
        relative_source_path(&root, path, sensitive)?;
    }
    let capture_id =
        identity::digest(&serde_json::to_value(&files).map_err(|error| error.to_string())?);
    for (path, text) in &sdk.files {
        if files
            .insert(
                path.clone(),
                ts_goport::scanner_util::go_string_from_utf8(text.clone()),
            )
            .is_some()
        {
            return Err("duplicate captured SDK path".into());
        }
    }
    let fs = Rc::new(
        CaptureFs::with_workspace_root(files, sensitive, &root, Some("/sdk/lib"))
            .with_sdk_keys(sdk.files.keys().map(String::as_str))?,
    );
    let javascript_enabled = roots.iter().any(|path| {
        [".js", ".jsx", ".mjs", ".cjs"]
            .iter()
            .any(|extension| path.ends_with(extension))
    });
    captured_confinement::check(
        fs.clone(),
        captured_confinement::Inputs {
            root: &root,
            sdk_root: "/sdk/lib",
            roots: &roots,
            configured_resolution: javascript_enabled,
            ordinary_system_resolution: !javascript_enabled,
        },
    )?;
    *started = true;
    let frontend = native_frontend(
        fs.clone(),
        &root,
        "/sdk/lib",
        roots.clone(),
        javascript_enabled,
    );
    let _current = native_program::NativeProgram::enter(&frontend.program);
    program::bind_all();
    let mut extraction = ordinary::Extraction::default();
    let mut runtime_module_trace = Vec::new();
    let mut runtime_module_inputs = BTreeMap::<String, Option<String>>::new();
    let emitted_roots = emit
        .iter()
        .map(|path| fs.key(path))
        .collect::<BTreeSet<_>>();
    let mut extracted_roots = BTreeSet::new();
    let root_keys = roots
        .iter()
        .map(|path| fs.key(path))
        .collect::<BTreeSet<_>>();
    for source in program::source_files() {
        let path = ast::source_file_file_name(source);
        if !root_keys.contains(&fs.key(path)) || !emitted_roots.contains(&fs.key(path)) {
            continue;
        }
        if !extracted_roots.insert(source_identity.key(path)) {
            continue;
        }
        let relative = relative_source_path(&root, path, sensitive)?;
        let repository = root.clone();
        let configured = javascript_enabled;
        let (current, runtime_inputs, runtime_trace) =
            program::with_type_checker_for_file(source, move |checker| {
                let inputs = Rc::new(RefCell::new(BTreeMap::new()));
                let trace = Rc::new(RefCell::new(Vec::new()));
                let runtime_module = ordinary::RuntimeModuleResolver::new(
                    |path| ts_goport::frontend::vfs::osvfs_fs().file_exists(path),
                    configured,
                    false,
                    Some(repository.clone()),
                    inputs.clone(),
                    trace.clone(),
                );
                let extracted = ordinary::extract(
                    source,
                    checker,
                    &relative,
                    &ordinary::ExtractionContext {
                        runtime_module: Some(&runtime_module),
                        repository_root: &repository,
                        static_module_links: javascript_enabled,
                        retained: false,
                        javascript_enabled,
                        captured_files: None,
                        case_sensitive: sensitive,
                    },
                )?;
                let recorded_inputs = inputs.borrow().clone();
                let recorded_trace = trace.borrow().clone();
                Ok::<_, String>((extracted, recorded_inputs, recorded_trace))
            })
            .map_err(|error| format!("worker native checker unavailable: {error}"))?;
        runtime_module_inputs.extend(runtime_inputs);
        runtime_module_trace.extend(runtime_trace);
        extraction.modules.extend(current.modules);
        extraction.symbols.extend(current.symbols);
        extraction.imports.extend(current.imports);
        extraction.calls.extend(current.calls);
    }
    let mut unsupported = BTreeSet::new();
    let root_observations = roots
        .iter()
        .map(|path| {
            let source = program::get_source_file(path);
            let loaded = !source.is_nil();
            if !loaded {
                unsupported.insert(format!("WORKER_SOURCE_NOT_LOADED:{path}"));
            }
            let codes = if loaded {
                ast::source_file_diagnostics(source)
                    .iter()
                    .map(|diagnostic| diagnostic.code())
                    .collect::<Vec<_>>()
            } else {
                vec![]
            };
            serde_json::json!({"path":path,"loaded":loaded,"parseDiagnosticCodes":codes})
        })
        .collect::<Vec<_>>();
    let workspace_issues = fs
        .workspace
        .as_ref()
        .map(|workspace| workspace.issues.borrow().clone())
        .unwrap_or_default();
    unsupported.extend(
        workspace_issues
            .iter()
            .filter(|issue| issue.kind == "unsupported")
            .map(|issue| issue.detail.clone()),
    );
    let resolution_errors = frontend
        .resolution
        .as_ref()
        .map(|observations| observations.borrow().errors.clone())
        .unwrap_or_default();
    unsupported.extend(resolution_errors.values().cloned());
    let capability = serde_json::json!({"executed":true,"roots":root_observations,"unsupported":unsupported,"workspaceIssues":workspace_issues,"resolutionErrors":resolution_errors});
    let extraction = restrict(extraction, &emit, &root, sensitive)?;
    Ok(
        serde_json::json!({"extraction":extraction,"runtimeModuleObservation":{"inputs":runtime_module_inputs,"trace":runtime_module_trace},"sourceIdentityObservation":source_identity.observation(),"frontendCapabilityObservation":capability,"read_observations":reads,"compiler_probes":fs.log.borrow().clone(),"extraction_started":true,"captured_repository_input_id":capture_id,"sdk_input_id":identity::digest(&serde_json::to_value(sdk).map_err(|error|error.to_string())?),"capture_claim":"single sequential materialization; no atomic live acquisition guarantee"}),
    )
}

fn restrict(
    extraction: ordinary::Extraction,
    emit: &[String],
    root: &str,
    sensitive: bool,
) -> Result<serde_json::Value, String> {
    let emit = emit
        .iter()
        .filter_map(|path| relative_source_path(root, path, sensitive).ok())
        .collect::<BTreeSet<_>>();
    let mut value = serde_json::to_value(extraction).map_err(|error| error.to_string())?;
    for (key, owner) in [
        ("modules", ""),
        ("symbols", "relPath"),
        ("imports", "fromRelPath"),
        ("calls", "callerRelPath"),
    ] {
        let items = value[key]
            .as_array_mut()
            .ok_or("worker extraction array missing")?;
        items.retain(|item| {
            item.get(owner)
                .unwrap_or(item)
                .as_str()
                .is_some_and(|path| emit.contains(path))
        });
        for item in items {
            if key == "imports" {
                item.as_object_mut().unwrap().remove("bindingTargets");
            }
            for field in ["resolvedRelPath", "calleeRelPath"] {
                if item
                    .get(field)
                    .and_then(serde_json::Value::as_str)
                    .is_some_and(|path| path.starts_with("../") || path.starts_with('/'))
                {
                    item.as_object_mut().unwrap().remove(field);
                }
            }
            if key == "calls" {
                item.as_object_mut()
                    .unwrap()
                    .remove("callerUnmodeledReason");
                item.as_object_mut()
                    .unwrap()
                    .remove("calleeUnmodeledReason");
            }
        }
    }
    Ok(value)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EmissionRequest {
    extraction: ordinary::Extraction,
    emit_abs_paths: Vec<String>,
    repo_root: String,
}

pub fn observe_emission(descriptor: serde_json::Value) -> serde_json::Value {
    let result = (|| {
        let request: EmissionRequest = serde_json::from_value(descriptor)
            .map_err(|error| format!("malformed emission request: {error}"))?;
        let sensitive = ts_goport::frontend::vfs::osvfs_fs().use_case_sensitive_file_names();
        restrict(
            request.extraction,
            &request.emit_abs_paths,
            &request.repo_root,
            sensitive,
        )
    })();
    match result {
        Ok(extraction) => {
            serde_json::json!({"executed":true,"unsupported":[],"extraction":extraction,"observationScope":"worker_emit_root_projection"})
        }
        Err(error) => {
            serde_json::json!({"executed":false,"unsupported":[error],"observationScope":"worker_emit_root_projection"})
        }
    }
}

fn parse_request(request: &serde_json::Value) -> Option<WorkerRequest> {
    let parsed = serde_json::from_value::<WorkerRequest>(request.clone()).ok()?;
    if parsed.schema_version != 1.0 {
        return None;
    }
    Some(parsed)
}

pub fn malformed_request(request: &serde_json::Value) -> Option<serde_json::Value> {
    parse_request(request)
        .is_none()
        .then(|| failure("unbound", "malformed extraction request"))
}

pub fn run(request: serde_json::Value, sdk: &Sdk) -> serde_json::Value {
    run_with_identity(
        request,
        sdk,
        source_identity::SourceIdentity::new(
            ts_goport::frontend::vfs::osvfs_fs().use_case_sensitive_file_names(),
            true,
        ),
    )
}

pub(super) fn run_with_identity(
    request: serde_json::Value,
    sdk: &Sdk,
    source_identity: source_identity::SourceIdentity,
) -> serde_json::Value {
    let Some(parsed) = parse_request(&request) else {
        return failure("unbound", "malformed extraction request");
    };
    let mut started = false;
    match extract(&parsed, sdk, &mut started, &source_identity) {
        Ok(mut observed) => {
            observed["schemaVersion"] = serde_json::json!(1);
            observed["jobId"] = serde_json::json!(parsed.job_id);
            observed["ok"] = serde_json::json!(true);
            observed
        }
        Err(error) => {
            let mut observed = failure(&parsed.job_id, &error);
            observed["extraction_started"] = serde_json::json!(started);
            observed
        }
    }
}

#[cfg(test)]
#[path = "../tests/unit/worker_observations.rs"]
mod tests;
