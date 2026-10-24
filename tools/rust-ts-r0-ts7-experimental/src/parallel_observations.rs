use super::*;
use semctx_gates::process;
use serde_json::{Value, json};
use std::{path::Path, time::Instant};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ParallelRequest {
    repo_root: String,
    root_abs_paths: Vec<String>,
    workers: usize,
}

struct Preflight {
    components: Vec<Vec<String>>,
    emit_order: Vec<String>,
    observation: Value,
    unsafe_reason: Option<String>,
}

fn augmentation(node: core::Node) -> bool {
    if !node.is_nil()
        && node.kind() == SyntaxKind::ModuleDeclaration
        && (ast::is_global_scope_augmentation(node)
            || (!node.name().is_nil() && node.name().kind() == SyntaxKind::StringLiteral))
    {
        return true;
    }
    node.for_each_child(augmentation)
}

fn preflight(root: &str, roots: &[String]) -> Result<Preflight, String> {
    let (files, reads) = worker_observations::read_repository(Path::new(root))?;
    let sensitive = ts_goport::frontend::vfs::osvfs_fs().use_case_sensitive_file_names();
    let fs = Rc::new(CaptureFs::with_workspace_root(
        files
            .into_iter()
            .map(|(p, t)| (p, ts_goport::scanner_util::go_string_from_utf8(t)))
            .collect(),
        sensitive,
        root,
        Some("/sdk/lib"),
    ));
    let mut options = compiler_options();
    options.no_lib = Tristate::True;
    options.types = Some(vec![]);
    let config = Rc::new(tsoptions::new_parsed_command_line(
        Rc::new(options),
        roots.to_vec(),
        None,
        ComparePathsOptions {
            use_case_sensitive_file_names: sensitive,
            current_directory: root.into(),
        },
    ));
    let _empty = core::enter_program(None);
    let frontend = native_program::frontend(
        compiler::ProgramOptions {
            host: compiler::new_compiler_host(root, fs.clone(), "/sdk/lib", None, None, None),
            config,
            use_source_of_project_reference: false,
            single_threaded: Tristate::True,
            typings_location: String::new(),
            project_name: String::new(),
            create_module_resolver: None,
            skip_module_resolution: false,
        },
        &fs,
    );
    let _current = native_program::NativeProgram::enter(&frontend);
    program::bind_all();
    let component = partition_observations::observe(&frontend, &fs, root, roots);
    if component["executed"] != true || component["unsupported"] != json!([]) {
        return Err(format!(
            "parallel native module graph unavailable: {component}"
        ));
    }
    let root_keys = roots.iter().map(|p| fs.key(p)).collect::<BTreeSet<_>>();
    if root_keys.len() != roots.len() {
        return Err("parallel duplicate root".into());
    }
    let mut emit_order = vec![];
    let mut observed_keys = BTreeSet::new();
    let mut unsafe_reason = None;
    for source in frontend.get_source_files() {
        let path = ast::source_file_file_name(source.root);
        if !root_keys.contains(&fs.key(path)) {
            continue;
        }
        observed_keys.insert(fs.key(path));
        relative_source_path(root, path, sensitive)?;
        let info = ast::source_file_info(source.root);
        let reason = if !ast::source_file_diagnostics(source.root).is_empty() {
            Some(format!("parse diagnostics: {path}"))
        } else if !info.referenced_files.is_empty()
            || !info.type_reference_directives.is_empty()
            || !info.lib_reference_directives.is_empty()
        {
            Some(format!("triple-slash directive: {path}"))
        } else if !info.is_declaration_file && !ast::is_external_module(source.root) {
            Some(format!("global script: {path}"))
        } else if augmentation(source.root) {
            Some(format!("global or module augmentation: {path}"))
        } else {
            None
        };
        if unsafe_reason.is_none() {
            unsafe_reason = reason;
        }
        if !info.is_declaration_file {
            emit_order.push(path.to_owned());
        }
    }
    if observed_keys != root_keys {
        return Err("parallel program omitted an extraction root".into());
    }
    let components: Vec<Vec<String>> =
        serde_json::from_value(component["dependencyComponents"].clone())
            .map_err(|e| e.to_string())?;
    let components = components
        .into_iter()
        .map(|paths| {
            paths
                .into_iter()
                .map(|p| format!("{}/{p}", root.trim_end_matches('/')))
                .collect()
        })
        .collect();
    let observation = json!({"moduleComponents":component,"noLib":true,"types":[],"read_observations":reads,"compiler_probes":fs.log.borrow().clone(),"safe":unsafe_reason.is_none(),"unsafeReason":unsafe_reason});
    Ok(Preflight {
        components,
        emit_order,
        observation,
        unsafe_reason,
    })
}

fn compare_paths(left: &[String], right: &[String]) -> std::cmp::Ordering {
    left.first()
        .map(|p| p.encode_utf16().collect::<Vec<_>>())
        .cmp(&right.first().map(|p| p.encode_utf16().collect::<Vec<_>>()))
}

fn chunks(components: Vec<Vec<String>>, count: usize) -> Result<Vec<Vec<String>>, String> {
    let mut weighted = components
        .into_iter()
        .map(|mut paths| {
            paths.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
            let weight = paths.iter().try_fold(0u64, |total, p| {
                std::fs::metadata(p)
                    .map_err(|e| e.to_string())
                    .and_then(|m| {
                        total
                            .checked_add(m.len())
                            .ok_or("parallel source weight overflow".into())
                    })
            })?;
            Ok((weight, paths))
        })
        .collect::<Result<Vec<_>, String>>()?;
    let mut bins = vec![(0u64, vec![]); count.min(weighted.len())];
    weighted.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| compare_paths(&a.1, &b.1)));
    for (weight, paths) in weighted {
        bins.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| compare_paths(&a.1, &b.1)));
        bins[0].0 = bins[0]
            .0
            .checked_add(weight)
            .ok_or("parallel chunk weight overflow")?;
        bins[0].1.extend(paths);
    }
    Ok(bins
        .into_iter()
        .filter_map(|(_, mut paths)| {
            paths.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
            (!paths.is_empty()).then_some(paths)
        })
        .collect())
}

fn merge(responses: &[Value], order: &[String], root: &str) -> Result<Value, String> {
    let sensitive = ts_goport::frontend::vfs::osvfs_fs().use_case_sensitive_file_names();
    let expected = order
        .iter()
        .map(|p| relative_source_path(root, p, sensitive))
        .collect::<Result<Vec<_>, _>>()?;
    let ranks = expected
        .iter()
        .enumerate()
        .map(|(i, p)| (p.clone(), i))
        .collect::<BTreeMap<_, _>>();
    let mut merged = json!({"modules":[],"symbols":[],"imports":[],"calls":[]});
    for (field, owner, line) in [
        ("modules", "", ""),
        ("symbols", "relPath", "startLine"),
        ("imports", "fromRelPath", "line"),
        ("calls", "callerRelPath", "line"),
    ] {
        let mut items = vec![];
        for response in responses {
            items.extend(
                response["extraction"][field]
                    .as_array()
                    .ok_or("parallel extraction array absent")?
                    .iter()
                    .cloned(),
            );
        }
        let rank = |v: &Value| -> Result<usize, String> {
            let path = if field == "modules" {
                v.as_str()
            } else {
                v[owner].as_str()
            }
            .ok_or("parallel item owner missing")?;
            ranks
                .get(path)
                .copied()
                .ok_or_else(|| format!("parallel foreign owner: {path}"))
        };
        for item in &items {
            rank(item)?;
        }
        items.sort_by(|a, b| {
            rank(a)
                .unwrap()
                .cmp(&rank(b).unwrap())
                .then_with(|| a[line].as_u64().cmp(&b[line].as_u64()))
        });
        merged[field] = json!(items);
    }
    let actual: Vec<String> =
        serde_json::from_value(merged["modules"].clone()).map_err(|e| e.to_string())?;
    if actual != expected || actual.iter().collect::<BTreeSet<_>>().len() != actual.len() {
        return Err("parallel extraction did not cover every source exactly once".into());
    }
    Ok(merged)
}

fn serial(
    request: &ParallelRequest,
    sdk: &Sdk,
    reason: Option<(&str, &str)>,
) -> Result<Value, String> {
    let job = json!({"schemaVersion":1,"jobId":"parallel-single","repoRoot":request.repo_root,"rootAbsPaths":request.root_abs_paths,"emitAbsPaths":request.root_abs_paths});
    let observed = worker_observations::run(job.clone(), sdk);
    if observed["ok"] != true {
        return Err(format!(
            "parallel single extraction failed: {}",
            observed["error"]
        ));
    }
    let mut parallelism = json!({"requested":request.workers,"used":1,"mode":"single"});
    if let Some((mode, reason)) = reason {
        parallelism["mode"] = json!(mode);
        parallelism["reason"] = json!(reason);
    }
    Ok(
        json!({"executed":true,"unsupported":[],"parallelism":parallelism,"extraction":observed["extraction"],"singleRequest":job,"singleObservation":observed,"jobs":[],"globalAdmissionInferred":false}),
    )
}

fn execute(
    descriptor: &Value,
    sdk: &Sdk,
    sdk_path: &Path,
    helper: &Path,
    jobs: &mut Vec<Value>,
) -> Result<Value, String> {
    let mut request: ParallelRequest = serde_json::from_value(descriptor.clone())
        .map_err(|e| format!("malformed parallel request: {e}"))?;
    if !(1..=8).contains(&request.workers) {
        return Err("workers must be an integer from1 through8".into());
    }
    request.repo_root = worker_observations::absolute_worker_path(&request.repo_root)?;
    request.root_abs_paths = request
        .root_abs_paths
        .iter()
        .map(|p| worker_observations::absolute_worker_path(p))
        .collect::<Result<_, _>>()?;
    if request.workers == 1 || request.root_abs_paths.len() <= 1 {
        return serial(&request, sdk, None);
    }
    if request.root_abs_paths.iter().any(|p| {
        [".js", ".jsx", ".mjs", ".cjs"]
            .iter()
            .any(|ext| p.ends_with(ext))
    }) {
        return serial(
            &request,
            sdk,
            Some((
                "preflight-fallback",
                "mixed JavaScript/TypeScript extraction requires one semantic Program",
            )),
        );
    }
    let preflight = preflight(&request.repo_root, &request.root_abs_paths)?;
    if let Some(reason) = preflight.unsafe_reason.as_deref() {
        return serial(&request, sdk, Some(("preflight-fallback", reason)));
    }
    let groups = chunks(preflight.components, request.workers)?;
    if groups.len() <= 1 {
        return serial(
            &request,
            sdk,
            Some((
                "single",
                "TypeScript root module graph has one connected component",
            )),
        );
    }
    let executable = std::env::current_exe().map_err(|e| e.to_string())?;
    let artifact_id =
        identity::digest_bytes(&std::fs::read(&executable).map_err(|e| e.to_string())?);
    let helper_id = identity::digest_bytes(&std::fs::read(helper).map_err(|e| e.to_string())?);
    let sdk_id = identity::digest(&serde_json::to_value(sdk).map_err(|e| e.to_string())?);
    let sdk_path = sdk_path.canonicalize().map_err(|e| e.to_string())?;
    let helper = helper.canonicalize().map_err(|e| e.to_string())?;
    let token = SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_nanos();
    let scratch =
        std::env::temp_dir().join(format!("semctx-r0-parallel-{}-{token}", std::process::id()));
    std::fs::create_dir(&scratch).map_err(|e| e.to_string())?;
    let result = (|| {
        let clock = Instant::now();
        let mut prepared = vec![];
        for (index, group) in groups.iter().enumerate() {
            let declarations = request
                .root_abs_paths
                .iter()
                .filter(|p| p.ends_with(".d.ts"))
                .cloned();
            let roots = group
                .iter()
                .cloned()
                .chain(declarations)
                .collect::<Vec<_>>();
            let job = json!({"schemaVersion":1,"jobId":format!("typescript-chunk-{}-of-{}",index+1,groups.len()),"repoRoot":request.repo_root,"rootAbsPaths":roots,"emitAbsPaths":group});
            let path = scratch.join(format!("job-{index}.json"));
            std::fs::write(&path, serde_json::to_vec(&job).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
            let argv = vec![
                executable.to_string_lossy().into_owned(),
                "--extract-worker".into(),
                path.to_string_lossy().into_owned(),
                sdk_path.to_string_lossy().into_owned(),
            ];
            prepared.push((job, argv));
        }
        let mut handles = vec![];
        let mut dispatch_error = None;
        process::install_cancellation();
        for (job, argv) in prepared {
            let root = request.repo_root.clone();
            let helper = helper.clone();
            match std::thread::Builder::new().spawn(move || {
                let start=clock.elapsed().as_micros();
                let outcome=process::run_with_helper(&argv,Path::new(&root),15_000,8_388_608,&helper).map_err(|e|e.to_string());
                let response=outcome.as_ref().ok().filter(|o|o.kind=="success" && o.exit_code==Some(0)).and_then(|o|serde_json::from_str::<Value>(&o.stdout).ok());
                let accepted=response.as_ref().is_some_and(|response|worker_observations::consume_worker(&json!({"request":job,"response":response}))["accepted"]==true);
                if !accepted {process::request_cancellation();}
                json!({"request":job,"argv":argv,"startedOffsetMicros":start,"finishedOffsetMicros":clock.elapsed().as_micros(),"outcome":outcome.as_ref().ok(),"transportError":outcome.err(),"responseAccepted":accepted})
            }) {
                Ok(handle)=>handles.push(handle),
                Err(error)=>{process::request_cancellation();dispatch_error=Some(format!("parallel supervisor thread unavailable: {error}"));break;}
            }
        }
        for handle in handles {
            match handle.join() {
                Ok(job) => jobs.push(job),
                Err(_) => {
                    process::request_cancellation();
                    dispatch_error = Some("parallel supervisor thread panicked".into());
                }
            }
        }
        if let Some(error) = dispatch_error {
            return Err(error);
        }
        let mut responses = vec![];
        let mut pids = BTreeSet::new();
        for job in jobs.iter() {
            if job["responseAccepted"] != true {
                return Err("parallel worker failed after dispatch; no serial fallback".into());
            }
            let response: Value = serde_json::from_str(
                job["outcome"]["stdout"]
                    .as_str()
                    .ok_or("parallel worker stdout absent")?,
            )
            .map_err(|e| e.to_string())?;
            if response["request_descriptor_id"] != identity::digest(&job["request"])
                || response["producer_artifact_id"] != artifact_id
                || response["sdk_input_id"] != sdk_id
            {
                return Err("parallel worker input/artifact identity mismatch".into());
            }
            let pid = response["producer_process_id"]
                .as_u64()
                .ok_or("parallel worker process identity absent")?;
            if pid == 0 || pid == u64::from(std::process::id()) || !pids.insert(pid) {
                return Err("parallel worker process identity reused".into());
            }
            responses.push(response);
        }
        if identity::digest_bytes(&std::fs::read(&executable).map_err(|e| e.to_string())?)
            != artifact_id
            || identity::digest_bytes(&std::fs::read(&helper).map_err(|e| e.to_string())?)
                != helper_id
        {
            return Err("parallel producer/helper changed".into());
        }
        Ok(
            json!({"executed":true,"unsupported":[],"parallelism":{"requested":request.workers,"used":responses.len(),"mode":"parallel"},"extraction":merge(&responses,&preflight.emit_order,&request.repo_root)?,"preflight":preflight.observation,"jobs":jobs,"helperArtifactId":helper_id,"globalAdmissionInferred":false}),
        )
    })();
    let cleanup = std::fs::remove_dir_all(&scratch).map_err(|e| e.to_string());
    match (result, cleanup) {
        (Ok(value), Ok(())) => Ok(value),
        (Err(error), _) => Err(error),
        (_, Err(error)) => Err(format!("parallel scratch cleanup failed: {error}")),
    }
}

pub fn run(descriptor: &Value, sdk: &Sdk, sdk_path: &Path, helper: &Path) -> Value {
    let mut jobs = vec![];
    let mut value=execute(descriptor,sdk,sdk_path,helper,&mut jobs).unwrap_or_else(|error|json!({"executed":false,"unsupported":[error],"jobs":jobs,"workerCancellationRequested":process::cancellation_requested(),"globalAdmissionInferred":false}));
    value["observationScope"] = json!("native_type_script_parallel_extraction");
    value
}
