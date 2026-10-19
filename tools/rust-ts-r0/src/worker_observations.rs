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
) -> Result<serde_json::Value, String> {
    if sdk.version != "5.9.3"
        || sdk.archive_sha256 != "10e108c9cf7d5f2879053dff18515fb405abf2ccef63eaaf017d9c571687a1d3"
    {
        return Err("foreign SDK descriptor".into());
    }
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
    let mut extracted_roots = BTreeSet::new();
    for path in &roots {
        if !extracted_roots.insert(fs.key(path)) {
            continue;
        }
        let source = program::get_source_file(path);
        if source.is_nil() {
            continue;
        }
        let relative = relative_source_path(&root, path, sensitive)?;
        let repository = root.clone();
        let current = program::with_type_checker_for_file(source, move |checker| {
            ordinary::extract(
                source,
                checker,
                &relative,
                &ordinary::ExtractionContext {
                    repository_root: &repository,
                    static_module_links: javascript_enabled,
                    retained: false,
                    javascript_enabled,
                    captured_files: None,
                    case_sensitive: sensitive,
                },
            )
        })
        .map_err(|error| format!("worker native checker unavailable: {error}"))?;
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
        serde_json::json!({"extraction":extraction,"frontendCapabilityObservation":capability,"read_observations":reads,"compiler_probes":fs.log.borrow().clone(),"extraction_started":true,"captured_repository_input_id":capture_id,"sdk_input_id":identity::digest(&serde_json::to_value(sdk).map_err(|error|error.to_string())?),"capture_claim":"single sequential materialization; no atomic live acquisition guarantee"}),
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
    let Some(parsed) = parse_request(&request) else {
        return failure("unbound", "malformed extraction request");
    };
    let mut started = false;
    match extract(&parsed, sdk, &mut started) {
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
mod tests {
    use super::*;
    fn empty_sdk() -> Sdk {
        Sdk {
            version: "5.9.3".into(),
            archive_sha256: "10e108c9cf7d5f2879053dff18515fb405abf2ccef63eaaf017d9c571687a1d3"
                .into(),
            files: BTreeMap::new(),
        }
    }
    #[test]
    fn malformed_worker_protocol_refuses_before_repository_or_compiler_access() {
        let valid = serde_json::json!({"schemaVersion":1,"jobId":"dev-worker-guard","repoRoot":"/absent/dev-worker-never-read","rootAbsPaths":[],"emitAbsPaths":[]});
        for (key, value) in [
            ("schemaVersion", serde_json::json!(2)),
            ("jobId", serde_json::json!(3)),
            ("repoRoot", serde_json::json!([])),
            ("rootAbsPaths", serde_json::json!([false])),
            ("emitAbsPaths", serde_json::Value::Null),
        ] {
            let mut request = valid.clone();
            request[key] = value;
            let result = run(request, &empty_sdk());
            assert_eq!(result["ok"], false, "{key}");
            assert_eq!(result["jobId"], "unbound");
            assert_eq!(result["error"], "malformed extraction request");
            assert_eq!(result["extraction_started"], false);
        }
    }
    #[test]
    fn missing_worker_repository_is_an_explicit_bound_failure() {
        let result = run(
            serde_json::json!({"schemaVersion":1,"jobId":"dev-worker-missing","repoRoot":"/absent/dev-worker-never-read","rootAbsPaths":[],"emitAbsPaths":[]}),
            &empty_sdk(),
        );
        assert_eq!(result["ok"], false);
        assert_eq!(result["jobId"], "dev-worker-missing");
        assert_eq!(result["extraction_started"], false);
        assert!(
            result["error"]
                .as_str()
                .unwrap()
                .starts_with("worker repository unavailable:")
        );
    }

    #[test]
    fn native_worker_refuses_a_relative_import_escape_before_extraction() {
        let root = std::env::temp_dir().join(format!(
            "semctx-worker-confinement-dev-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let source = root.join("guardConsumer.ts");
        std::fs::write(
            &source,
            "import { guardedValue } from '../guardOutside'; export const observed = guardedValue;",
        )
        .unwrap();
        let sdk: Sdk = serde_json::from_slice(
            &std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/sdk/sdk-input.json")).unwrap(),
        )
        .unwrap();
        let observed = run(
            serde_json::json!({"schemaVersion":1,"jobId":"guard-worker-dev","repoRoot":root,"rootAbsPaths":[source],"emitAbsPaths":[source]}),
            &sdk,
        );
        std::fs::remove_dir_all(root).unwrap();
        assert_eq!(observed["ok"], false);
        assert_eq!(observed["extraction_started"], false);
        assert_eq!(
            observed["error"],
            "IMPORT_OUTSIDE_REPOSITORY: ../guardOutside"
        );
    }

    #[test]
    #[cfg(unix)]
    fn native_worker_refuses_external_symlink_imports_and_references_before_extraction() {
        let directory = std::env::temp_dir().join(format!(
            "semctx-worker-symlink-dev-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let root = directory.join("repo");
        std::fs::create_dir_all(&root).unwrap();
        let outside = directory.join("outside.ts");
        std::fs::write(&outside, "export const leaf = 1;").unwrap();
        std::os::unix::fs::symlink(&outside, root.join("external-link.ts")).unwrap();
        let source = root.join("consumer.ts");
        let sdk: Sdk = serde_json::from_slice(
            &std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/sdk/sdk-input.json")).unwrap(),
        )
        .unwrap();
        let results = [
            ("import {leaf} from './external-link.ts'; export const value = leaf;", "IMPORT_OUTSIDE_REPOSITORY: ./external-link.ts"),
            ("import {leaf} from './external-link'; export const value = leaf;", "IMPORT_OUTSIDE_REPOSITORY: ./external-link"),
            ("/// <reference path=\"./external-link.ts\" />\nexport const value = 1;", "REFERENCE_OUTSIDE_REPOSITORY: ./external-link.ts"),
        ].map(|(text, expected)| {
            std::fs::write(&source, text).unwrap();
            (run(serde_json::json!({"schemaVersion":1,"jobId":"guard-symlink-dev","repoRoot":root,"rootAbsPaths":[source],"emitAbsPaths":[source]}), &sdk), expected)
        });
        std::fs::remove_dir_all(directory).unwrap();
        for (observed, expected) in results {
            assert_eq!(observed["ok"], false, "{expected}: {observed}");
            assert_eq!(observed["extraction_started"], false);
            assert_eq!(observed["error"], expected);
            assert!(observed.get("extraction").is_none());
        }
    }

    #[test]
    fn captured_worker_reads_are_sorted_and_oversized_files_are_refused_before_reading() {
        let root = std::env::temp_dir().join(format!(
            "semctx-worker-capture-dev-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(root.join("child")).unwrap();
        std::fs::write(root.join("z.ts"), "z").unwrap();
        std::fs::write(root.join("a.ts"), "a").unwrap();
        std::fs::write(root.join("child/b.ts"), "b").unwrap();
        let (_, reads) = read_repository(&root).unwrap();
        assert!(
            reads
                .windows(2)
                .all(|pair| pair[0]["path"].as_str() < pair[1]["path"].as_str())
        );
        std::fs::File::create(root.join("oversized.ts"))
            .unwrap()
            .set_len(33_554_433)
            .unwrap();
        assert_eq!(
            read_repository(&root).unwrap_err(),
            "worker capture limit exceeded"
        );
        std::fs::remove_dir_all(root).unwrap();
    }
    #[cfg(target_os = "linux")]
    #[test]
    fn native_worker_refuses_lossy_utf8_capture_paths_before_extraction() {
        use std::os::unix::{ffi::OsStringExt, fs::symlink};
        for canonical_alias in [false, true] {
            let root = std::env::temp_dir().join(format!(
                "semctx-worker-utf8-dev-{}-{}-{canonical_alias}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            std::fs::create_dir_all(&root).unwrap();
            let invalid = root.join(std::ffi::OsString::from_vec(b"z-invalid-\xff.ts".to_vec()));
            std::fs::write(&invalid, "nonrepresentable bytes").unwrap();
            std::fs::write(
                root.join("z-invalid-\u{fffd}.ts"),
                "different replacement-name bytes",
            )
            .unwrap();
            if canonical_alias {
                symlink(&invalid, root.join("a-valid-alias.ts")).unwrap();
            }
            let result = run(
                serde_json::json!({"schemaVersion":1,"jobId":"worker-utf8-development","repoRoot":root,"rootAbsPaths":[],"emitAbsPaths":[]}),
                &empty_sdk(),
            );
            std::fs::remove_dir_all(&root).unwrap();
            assert_eq!(result["ok"], false, "{result}");
            assert_eq!(result["extraction_started"], false);
            assert_eq!(result["jobId"], "worker-utf8-development");
            assert_eq!(result["error"], "worker capture path is not UTF-8");
        }
    }
    #[cfg(unix)]
    #[test]
    fn native_worker_refuses_literal_backslash_capture_aliases_before_extraction() {
        let root = std::env::temp_dir().join(format!(
            "semctx-worker-separator-dev-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(root.join("part")).unwrap();
        let replacement = root.join("valid-\u{fffd}.ts");
        std::fs::write(&replacement, "valid replacement-character spelling").unwrap();
        let valid = run(
            serde_json::json!({"schemaVersion":1,"jobId":"worker-unicode-development","repoRoot":root,"rootAbsPaths":[],"emitAbsPaths":[]}),
            &empty_sdk(),
        );
        assert_eq!(valid["ok"], true, "{valid}");
        assert_eq!(
            valid["read_observations"][0]["path"],
            serde_json::json!(replacement)
        );
        std::fs::remove_file(replacement).unwrap();
        std::fs::write(root.join("part/leaf.ts"), "directory-entry bytes").unwrap();
        std::fs::write(root.join("part\\leaf.ts"), "literal-backslash bytes").unwrap();
        let result = run(
            serde_json::json!({"schemaVersion":1,"jobId":"worker-separator-development","repoRoot":root,"rootAbsPaths":[],"emitAbsPaths":[]}),
            &empty_sdk(),
        );
        std::fs::remove_dir_all(&root).unwrap();
        assert_eq!(result["ok"], false, "{result}");
        assert_eq!(result["extraction_started"], false);
        assert_eq!(
            result["error"],
            "worker capture path contains a nonportable separator"
        );
    }
    #[test]
    fn relative_worker_roots_and_emit_paths_resolve_from_the_callers_directory() {
        assert_eq!(
            absolute_worker_path("").unwrap(),
            ts_goport::frontend::tspath::normalize_path(
                &std::env::current_dir().unwrap().to_string_lossy()
            )
        );
        let relative = format!(
            "target/semctx-worker-relative-dev-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let root = std::env::current_dir().unwrap().join(&relative);
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(
            root.join("owner.ts"),
            "export const relativeWorkerDev = 401;\n",
        )
        .unwrap();
        let sdk: Sdk = serde_json::from_slice(
            &std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/sdk/sdk-input.json")).unwrap(),
        )
        .unwrap();
        let request = serde_json::json!({"schemaVersion":1,"jobId":"relative-worker-dev","repoRoot":root,"rootAbsPaths":[format!("{relative}/./owner.ts")],"emitAbsPaths":[format!("{relative}/owner.ts")]});
        let result = run(request, &sdk);
        assert_eq!(result["ok"], true, "{result}");
        assert_eq!(
            result["extraction"]["modules"],
            serde_json::json!(["owner.ts"])
        );
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn native_worker_emits_only_requested_roots_and_keeps_cross_file_call_target() {
        let root = std::env::temp_dir().join(format!(
            "semctx-r0-worker-dev-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let owner = root.join("worker-development-owner.ts");
        let caller = root.join("worker-development-caller.ts");
        std::fs::write(
            &owner,
            "export function workerDevelopmentOwner(){return 4;}\n",
        )
        .unwrap();
        std::fs::write(&caller, "import {workerDevelopmentOwner as invokeDevelopmentOwner} from './worker-development-owner';\nexport function workerDevelopmentCaller(){return invokeDevelopmentOwner();}\n").unwrap();
        let sdk: Sdk = serde_json::from_slice(
            &std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/sdk/sdk-input.json")).unwrap(),
        )
        .unwrap();
        let request = serde_json::json!({"schemaVersion":1,"jobId":"worker-dev-subset","repoRoot":root,"rootAbsPaths":[owner,caller],"emitAbsPaths":[caller]});
        let result = run(request.clone(), &sdk);
        assert_eq!(result["ok"], true, "{result}");
        assert_eq!(result["frontendCapabilityObservation"]["executed"], true);
        assert_eq!(
            result["frontendCapabilityObservation"]["unsupported"],
            serde_json::json!([])
        );
        assert!(
            result["frontendCapabilityObservation"]["roots"]
                .as_array()
                .unwrap()
                .iter()
                .all(|source| source["loaded"] == true
                    && source["parseDiagnosticCodes"] == serde_json::json!([]))
        );
        assert_eq!(
            result["captured_repository_input_id"],
            serde_json::json!(identity::digest(
                &serde_json::json!({owner.to_string_lossy().replace('\\',"/"):"export function workerDevelopmentOwner(){return 4;}\n",caller.to_string_lossy().replace('\\',"/"):"import {workerDevelopmentOwner as invokeDevelopmentOwner} from './worker-development-owner';\nexport function workerDevelopmentCaller(){return invokeDevelopmentOwner();}\n"})
            ))
        );
        assert_eq!(
            result["extraction"]["modules"],
            serde_json::json!(["worker-development-caller.ts"])
        );
        assert_eq!(result["extraction"]["symbols"].as_array().unwrap().len(), 1);
        assert_eq!(
            result["extraction"]["symbols"][0]["name"],
            "workerDevelopmentCaller"
        );
        assert_eq!(
            result["extraction"]["imports"][0]["names"],
            serde_json::json!(["invokeDevelopmentOwner"])
        );
        assert!(
            result["extraction"]["imports"][0]
                .get("bindingTargets")
                .is_none()
        );
        assert_eq!(
            result["extraction"]["calls"][0]["calleeRelPath"],
            "worker-development-owner.ts"
        );
        assert_eq!(
            result["extraction"]["calls"][0]["calleeSymbolPath"],
            "workerDevelopmentOwner"
        );
        assert_eq!(result["read_observations"].as_array().unwrap().len(), 2);
        let mut duplicate = request.clone();
        duplicate["rootAbsPaths"] = serde_json::json!([owner, caller, caller]);
        let duplicated = run(duplicate, &sdk);
        assert_eq!(duplicated["extraction"], result["extraction"]);
        let mut empty = request.clone();
        empty["emitAbsPaths"] = serde_json::json!([]);
        let result = run(empty, &sdk);
        for key in ["modules", "symbols", "imports", "calls"] {
            assert_eq!(result["extraction"][key], serde_json::json!([]));
        }
        let missing = root.join("worker-development-absent.ts");
        let mut absent = request;
        absent["rootAbsPaths"] = serde_json::json!([missing]);
        absent["emitAbsPaths"] = serde_json::json!([missing]);
        let result = run(absent, &sdk);
        assert_eq!(result["ok"], false);
        assert_eq!(result["extraction_started"], false);
        assert_eq!(
            result["error"],
            "SOURCE_SNAPSHOT_MISSING: worker-development-absent.ts"
        );
        assert!(result.get("frontendCapabilityObservation").is_none());
        assert!(result.get("extraction").is_none());
        std::fs::remove_dir_all(&root).unwrap();
    }
}
