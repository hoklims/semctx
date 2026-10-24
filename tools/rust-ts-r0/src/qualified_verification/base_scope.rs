use super::*;
use std::sync::atomic::{AtomicU64, Ordering};

struct InvocationFiles(PathBuf);

impl InvocationFiles {
    fn new() -> Result<Self, String> {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        for _ in 0..100 {
            let path = std::env::temp_dir().join(format!(
                "semctx-base-invocation-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            let builder = fs::DirBuilder::new();
            #[cfg(unix)]
            let builder = {
                use std::os::unix::fs::DirBuilderExt;
                let mut builder = builder;
                builder.mode(0o700);
                builder
            };
            match builder.create(&path) {
                Ok(()) => return Ok(Self(path)),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(error) => return Err(error.to_string()),
            }
        }
        Err("immutable base invocation directory unavailable".into())
    }
}

impl Drop for InvocationFiles {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn roots(discovered: &Value) -> Result<Vec<String>, String> {
    discovered["files"]
        .as_array()
        .ok_or("immutable base discovery files missing")?
        .iter()
        .filter(|file| matches!(file["language"].as_str(), Some("typescript" | "javascript")))
        .map(|file| {
            file["absPath"]
                .as_str()
                .map(str::to_string)
                .ok_or("immutable base source path missing".into())
        })
        .collect()
}

fn roles(discovered: &Value) -> BTreeMap<String, String> {
    discovered["files"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|file| {
            file["role"] == "test"
                && matches!(file["language"].as_str(), Some("typescript" | "javascript"))
        })
        .filter_map(|file| file["relPath"].as_str())
        .filter(|path| {
            ![".d.ts", ".d.mts", ".d.cts"]
                .iter()
                .any(|suffix| path.ends_with(suffix))
        })
        .map(|path| (path.to_string(), "test".into()))
        .collect()
}

fn capture_request(
    template: &Request,
    capture: &base_capture::BaseCapture,
    selected: &Value,
    broad: &Value,
) -> Result<Request, String> {
    let mut request = template.clone();
    request.id = format!("{}:immutable-base", template.id);
    request.cwd = capture
        .root()
        .to_str()
        .ok_or("immutable base root is not UTF-8")?
        .into();
    request.roots = roots(selected)?;
    request.roles = roles(selected);
    request.files.clear();
    request.raw_files.clear();
    request.utf16_files.clear();
    for (path, bytes) in capture.raw_files() {
        match std::str::from_utf8(bytes) {
            Ok(text) => {
                request.files.insert(path.clone(), text.into());
            }
            Err(_) => {
                request.raw_files.insert(
                    path.clone(),
                    RawFile {
                        bytes: bytes.clone(),
                        profile: source_text::ReadProfile::RetainedUtf8,
                    },
                );
            }
        }
    }
    for file in broad["files"]
        .as_array()
        .ok_or("immutable broad sources missing")?
    {
        let path = file["absPath"]
            .as_str()
            .ok_or("immutable source path missing")?;
        if request.files.get(path).map(String::as_str) != file["content"].as_str() {
            return Err(format!(
                "immutable base discovered source is not bound to UTF-8 bytes: {}",
                file["relPath"]
            ));
        }
    }
    if request.roots.is_empty() {
        return Err("immutable base has no selected native sources".into());
    }
    Ok(request)
}

fn receive_base(
    request: &Request,
    sdk: &Sdk,
    helper: &Path,
    artifact: &[u8],
) -> Result<(ReceivedIndex, wire::Batch, Value, process::Outcome), String> {
    let invocation = InvocationFiles::new()?;
    let request_path = invocation.0.join("request.json");
    let sdk_path = invocation.0.join("sdk.json");
    fs::write(
        &request_path,
        serde_json::to_vec(request).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    fs::write(
        &sdk_path,
        serde_json::to_vec(sdk).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    let argv = vec![
        std::env::current_exe()
            .map_err(|e| e.to_string())?
            .to_string_lossy()
            .into_owned(),
        "--batch".into(),
        request_path.to_string_lossy().into_owned(),
        sdk_path.to_string_lossy().into_owned(),
    ];
    let outcome =
        process::run_with_helper(&argv, Path::new(&request.cwd), 20_000, 8_388_608, helper)
            .map_err(|e| e.to_string())?;
    let observation = analyze(request.clone(), sdk.clone())?;
    let batch = batch::build(request, sdk, &observation)?;
    let received = receive_index(request, sdk, &outcome, &batch, artifact)?;
    Ok((received, batch, observation, outcome))
}

fn scope_links(graph: &Value, imports: &[ordinary::Import]) -> BTreeSet<(String, String)> {
    let mut links = imports
        .iter()
        .filter_map(|import| {
            import
                .resolved_rel_path
                .as_ref()
                .map(|to| (import.from_rel_path.clone(), to.clone()))
        })
        .collect::<BTreeSet<_>>();
    let nodes = graph["nodes"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|node| node["id"].as_str().map(|id| (id, node)))
        .collect::<BTreeMap<_, _>>();
    for edge in graph["edges"].as_array().into_iter().flatten() {
        if !matches!(
            edge["kind"].as_str(),
            Some(
                "constrained_by"
                    | "tested_by"
                    | "covers"
                    | "verifies"
                    | "documents"
                    | "declares"
                    | "related_to"
            )
        ) {
            continue;
        }
        let mut paths = BTreeSet::new();
        for end in ["from", "to"] {
            if let Some(node) = edge[end].as_str().and_then(|id| nodes.get(id)) {
                if let Some(path) = node["filePath"].as_str() {
                    paths.insert(path.to_string());
                }
                paths.extend(
                    node["evidence"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(|evidence| evidence["filePath"].as_str().map(str::to_string)),
                );
            }
        }
        for evidence in edge["evidence"].as_array().into_iter().flatten() {
            if let Some(path) = evidence["filePath"].as_str() {
                paths.insert(path.to_string());
            }
        }
        for from in &paths {
            for to in &paths {
                if from != to {
                    links.insert((from.clone(), to.clone()));
                }
            }
        }
    }
    links
}

pub(super) fn evaluate(
    spec: &Descriptor,
    root: &Path,
    sdk: &Sdk,
    artifact: &[u8],
    base_obligations: &BTreeSet<String>,
) -> Result<Value, String> {
    let policy = spec.index.analysis.files.iter().find_map(|(path, text)| {
        (relative_source_path(
            &spec.index.analysis.cwd,
            path,
            spec.index.analysis.case_sensitive,
        )
        .ok()
        .as_deref()
            == Some(".semctx/config.json"))
        .then_some(text.as_bytes())
    });
    let capture =
        base_capture::capture(root, &spec.index.base_commit, &spec.process_helper, policy)?;
    let paths = capture
        .raw_files()
        .keys()
        .map(PathBuf::from)
        .collect::<Vec<_>>();
    let cwd = capture
        .root()
        .to_str()
        .ok_or("immutable base root is not UTF-8")?;
    let selected = discovery(cwd, &spec.include, &spec.exclude, &paths)?;
    let broad = discovery(cwd, &["**/*".into()], &[], &paths)?;
    let request = capture_request(&spec.index.analysis, &capture, &selected, &broad)?;
    capture.revalidate()?;
    let (received, batch, selected_observation, outcome) =
        receive_base(&request, sdk, &spec.process_helper, artifact)?;
    capture.revalidate()?;
    if received.receipt.disposition() != EvidenceDisposition::Analyzed {
        return Err(format!(
            "immutable base selected extraction refused: {}",
            serde_json::to_string(&batch.diagnostics).map_err(|e| e.to_string())?
        ));
    }
    let mut broad_request = request.clone();
    broad_request.roots = roots(&broad)?;
    broad_request.roles = roles(&broad);
    let broad_observation = analyze(broad_request.clone(), sdk.clone())?;
    let imports: Vec<ordinary::Import> =
        serde_json::from_value(broad_observation["raw_extraction"]["imports"].clone())
            .map_err(|e| format!("immutable base imports invalid: {e}"))?;
    let import_scope = component_observations::retained_import_scope(
        &imports,
        &broad_request.files,
        &request.cwd,
        request.case_sensitive,
    )?;
    let observation = Observation::capture(&request, sdk, &outcome, &batch)?;
    let state = observation.state(&request, &batch, artifact);
    capture.revalidate()?;
    let context = received
        .receiver
        .context(Some(&received.receipt), &state)
        .map_err(|e| format!("immutable base ownership rejected: {e:?}"))?;
    let received_subjects = scope_received::inspect(&broad_request, sdk, &context)?;
    let links = scope_links(context.graph(), &imports);
    let inventory = capture.inventory();
    let mut expected = base_obligations
        .intersection(&inventory)
        .cloned()
        .collect::<BTreeSet<_>>();
    loop {
        let before = expected.len();
        for (from, to) in &links {
            if expected.contains(from) || expected.contains(to) {
                expected.extend([from.clone(), to.clone()]);
            }
        }
        if before == expected.len() {
            break;
        }
    }
    for subject in broad_observation["subjects"]
        .as_array()
        .ok_or("immutable base broad subjects missing")?
        .iter()
        .chain(&received_subjects)
    {
        if subject["outcome"] != "analyzed"
            || subject["reasons"] != json!([])
            || subject["unimplemented"] != json!([])
        {
            return Err(format!(
                "immutable base broad source unsupported: {}: {}",
                subject["path"], subject["reasons"]
            ));
        }
    }
    if !import_scope.unresolved_import_reasons.is_empty() {
        return Err(format!(
            "immutable base unresolved imports: {:?}",
            import_scope.unresolved_import_reasons
        ));
    }
    let candidates = selected["candidates"]
        .as_array()
        .ok_or("immutable base candidates missing")?;
    let subjects = selected_observation["subjects"]
        .as_array()
        .ok_or("immutable base subjects missing")?;
    let owned = context.graph()["nodes"]
        .as_array()
        .ok_or("immutable base graph missing")?
        .iter()
        .filter_map(|n| n["filePath"].as_str())
        .collect::<BTreeSet<_>>();
    for path in &expected {
        let candidate = candidates.iter().find(|row| row["relPath"] == *path);
        let subject = subjects.iter().find(|row| row["path"] == *path);
        if !candidate.is_some_and(|row| row["selectionDecision"] == "selected")
            || !subject.is_some_and(|row| {
                row["outcome"] == "analyzed"
                    && row["reasons"] == json!([])
                    && row["unimplemented"] == json!([])
            })
            || !owned.contains(path.as_str())
        {
            return Err(format!("immutable base obligation is not analyzed: {path}"));
        }
    }
    capture.revalidate()?;
    received
        .receiver
        .context(Some(&received.receipt), &state)
        .map_err(|e| format!("immutable base ownership expired: {e:?}"))?;
    Ok(
        json!({"status":"analyzed","commit":spec.index.base_commit,"inventory":inventory,"expected":expected,"links":links,"input_manifest_id":identity::digest(context.input_manifest()),"externalModuleSpecifiers":import_scope.external_module_specifiers}),
    )
}
