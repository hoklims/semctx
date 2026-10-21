//! Five bounded working-tree consumers. No expected-output input, producer changes,
//! JavaScript policy execution, synthetic admission or substitution of native facts.
//! Parent calls run after setup of the latest index epoch. Registered current
//! epoch bytes must equal that index epoch before any observation begins.
use super::*;

fn domain_hash(domain: &str, bytes: &[u8]) -> String {
    let mut raw = format!("semctx:{domain}:v1\0").into_bytes();
    raw.extend_from_slice(bytes);
    identity::digest_bytes(&raw)
}

fn domain_value(domain: &str, value: &Value) -> String {
    domain_hash(domain, identity::canonical_json(value).as_bytes())
}

fn nul_paths(stdout: &str) -> Result<Vec<String>, String> {
    if !stdout.is_empty() && !stdout.ends_with('\0') {
        return Err("NUL Git path capture is truncated".into());
    }
    stdout
        .split('\0')
        .filter(|v| !v.is_empty())
        .map(|v| {
            if safe_relative(v) && !v.contains('\\') && !v.split('/').any(|p| p == ".git") {
                Ok(v.to_owned())
            } else {
                Err("Git path outside bounded isolated root".into())
            }
        })
        .collect()
}

/// Exact baseline freshness record shape for ordinary tracked and untracked
/// files. Renames, submodules and conflict records remain explicit UNKNOWNs.
fn status_entries(root: &Path, stdout: &str) -> Result<(String, Vec<Value>), String> {
    if !stdout.ends_with('\0') {
        return Err("Git porcelain-v2 capture truncated".into());
    }
    let mut head = None;
    let mut entries = vec![];
    for record in stdout.split('\0').filter(|s| !s.is_empty()) {
        if let Some(oid) = record.strip_prefix("# branch.oid ") {
            if oid.is_empty() || !oid.bytes().all(|c| c.is_ascii_hexdigit()) {
                return Err("bounded working-tree collector requires actual Git HEAD".into());
            }
            head = Some(oid.to_owned());
            continue;
        }
        if record.starts_with("# ") {
            continue;
        }
        let (path, working, untracked) = if let Some(path) = record.strip_prefix("? ") {
            (path, true, true)
        } else if record.starts_with("1 ") {
            let fields = record.splitn(9, ' ').collect::<Vec<_>>();
            if fields.len() != 9 || fields[1].len() != 2 || fields[2] != "N..." {
                return Err("unsupported ordinary Git status record".into());
            }
            (fields[8], fields[1].as_bytes()[1] != b'.', false)
        } else {
            return Err("UNKNOWN_GIT_RENAME_CONFLICT_OR_SUBMODULE_RECORD".into());
        };
        if !safe_relative(path) || path.contains('\\') {
            return Err("Git status path escapes isolated root".into());
        }
        if [
            ".semctx/semctx.db",
            ".semctx/semctx.db-shm",
            ".semctx/semctx.db-wal",
            ".semctx/semctx.db-journal",
        ]
        .contains(&path)
        {
            continue;
        }
        let working_file = if working {
            let physical = root.join(path);
            match fs::symlink_metadata(&physical) {
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    json!({"path":path,"kind":"missing"})
                }
                Err(e) => return Err(e.to_string()),
                Ok(metadata) if metadata.file_type().is_symlink() => {
                    if untracked {
                        return Err("untracked symlink unsupported by actual freshness seal".into());
                    }
                    json!({"path":path,"kind":"symlink","target":fs::read_link(&physical).map_err(|e|e.to_string())?.to_string_lossy()})
                }
                Ok(metadata) => {
                    if !metadata.is_file() {
                        return Err("non-file Git working state".into());
                    }
                    #[cfg(unix)]
                    let mode = {
                        use std::os::unix::fs::PermissionsExt;
                        if metadata.permissions().mode() & 0o111 == 0 {
                            "100644"
                        } else {
                            "100755"
                        }
                    };
                    #[cfg(not(unix))]
                    let mode = "100644";
                    let bytes = fs::read(&physical).map_err(|e| e.to_string())?;
                    json!({"path":path,"kind":"file","mode":mode,"contentHash":domain_hash("working-file-content",&bytes)})
                }
            }
        } else {
            Value::Null
        };
        entries.push(json!({"record":record,"workingFile":working_file}));
    }
    entries.sort_by(|a, b| a["record"].as_str().cmp(&b["record"].as_str()));
    Ok((head.ok_or("actual Git branch.oid absent")?, entries))
}

fn capture_tree(root: &Path) -> Result<Value, String> {
    fn visit(
        root: &Path,
        dir: &Path,
        output: &mut serde_json::Map<String, Value>,
    ) -> Result<(), String> {
        let mut children = fs::read_dir(dir)
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        children.sort_by_key(|a| a.file_name());
        for child in children {
            let path = child.path();
            let relative = path
                .strip_prefix(root)
                .map_err(|e| e.to_string())?
                .to_string_lossy()
                .replace('\\', "/");
            if relative
                .split('/')
                .any(|p| [".git", ".semctx", "node_modules"].contains(&p))
            {
                continue;
            }
            let metadata = fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
            if metadata.file_type().is_symlink() {
                return Err("bounded capture refuses symlinks".into());
            }
            if metadata.is_dir() {
                visit(root, &path, output)?;
            } else if metadata.is_file() {
                output.insert(
                    relative,
                    Value::String(fs::read_to_string(&path).map_err(|e| e.to_string())?),
                );
            } else {
                return Err("bounded capture requires regular files".into());
            }
        }
        Ok(())
    }
    let mut output = serde_json::Map::new();
    visit(root, root, &mut output)?;
    Ok(Value::Object(output))
}

fn request_from_capture(
    template: &Value,
    capture: &Value,
    root: &Path,
    sensitive: bool,
    id: &str,
) -> Result<Value, String> {
    let cwd = root
        .canonicalize()
        .map_err(|e| e.to_string())?
        .to_string_lossy()
        .replace('\\', "/");
    let mut request = template.clone();
    let mut files = serde_json::Map::new();
    for path in template["files"]
        .as_object()
        .ok_or("retained selector map absent")?
        .keys()
    {
        let text = capture
            .get(path)
            .ok_or("retained selector absent from physical epoch")?;
        if !safe_relative(path) || !text.is_string() {
            return Err("invalid actual capture map".into());
        }
        files.insert(format!("{cwd}/{path}"), text.clone());
    }
    let roots = template["roots"]
        .as_array()
        .ok_or("bounded selected root template absent")?
        .iter()
        .map(|path| {
            let path = path
                .as_str()
                .filter(|p| safe_relative(p))
                .ok_or("selected root escapes capture")?;
            if capture.get(path).is_none() {
                return Err("selected root absent from actual capture");
            }
            Ok(json!(format!("{cwd}/{path}")))
        })
        .collect::<Result<Vec<_>, _>>()?;
    request["id"] = json!(id);
    request["files"] = Value::Object(files);
    request["roots"] = json!(roots);
    request["cwd"] = json!(cwd);
    request["case_sensitive"] = json!(sensitive);
    if request["retained"] != true {
        return Err("working-tree capture must remain retained".into());
    }
    Ok(request)
}

struct Collector<'a> {
    root: &'a Path,
    dir: &'a Path,
    fixture: &'a Value,
    artifact: &'a Path,
    helper: &'a Path,
    sdk_path: &'a Path,
    pins: Vec<(&'a Path, &'a str)>,
}

fn evidence_capture_paths(request: &Value) -> Result<Vec<String>, String> {
    let prefix = format!("{}/", value_text(request, "cwd")?);
    request["files"]
        .as_object()
        .ok_or("retained source capture absent")?
        .keys()
        .map(|path| {
            path.strip_prefix(&prefix)
                .filter(|p| safe_relative(p))
                .map(str::to_owned)
                .ok_or_else(|| "retained source outside root".into())
        })
        .collect()
}

fn bounded_workspace(root: &Path, capture: &Value) -> Result<bool, String> {
    if root.join(".semctx/semantic").exists() {
        return Err("UNKNOWN_EXISTING_AUTHORED_SEMANTIC_TREE".into());
    }
    for (path, text) in capture
        .as_object()
        .ok_or("actual workspace capture absent")?
    {
        if path.ends_with(".sem") || path.ends_with(".sem.json") || path.contains("/package.json") {
            return Err("UNKNOWN_AUTHORED_SEMANTIC_OR_WORKSPACE_MODEL".into());
        }
        if path == "package.json" {
            let manifest: Value =
                serde_json::from_str(text.as_str().ok_or("manifest text absent")?)
                    .map_err(|e| e.to_string())?;
            if manifest.get("workspaces").is_some() {
                return Err("UNKNOWN_WORKSPACE_LAYOUT".into());
            }
        }
    }
    Ok(true)
}

impl Collector<'_> {
    fn invoke(&self, name: &str, argv: &[String]) -> Result<process::Outcome, String> {
        let outcome = super::invoke(
            argv,
            self.root,
            &self.dir.join(format!("{name}-process.json")),
            self.helper,
            &self.pins,
        )?;
        if outcome.kind != "success" || outcome.exit_code != Some(0) || !outcome.stderr.is_empty() {
            return Err(format!("working-tree actual process refused: {name}"));
        }
        Ok(outcome)
    }
    fn git(&self, name: &str, args: &[&str]) -> Result<String, String> {
        let mut argv = vec!["git".to_string()];
        argv.extend(args.iter().map(|v| v.to_string()));
        Ok(self.invoke(name, &argv)?.stdout)
    }
    fn query(
        &self,
        name: &str,
        mode: Option<&str>,
        request: &Value,
        sdk: bool,
    ) -> Result<Value, String> {
        let path = self.dir.join(format!("{name}-request.json"));
        save(&path, request)?;
        let request_sha = sha(&fs::read(&path).map_err(|e| e.to_string())?);
        let mut argv = vec![self.artifact.to_string_lossy().into_owned()];
        if let Some(mode) = mode {
            argv.push(mode.to_owned());
        }
        argv.push(path.to_string_lossy().into_owned());
        if sdk {
            argv.push(self.sdk_path.to_string_lossy().into_owned());
        }
        let outcome = self.invoke(name, &argv)?;
        exact_hash(&path, &request_sha)?;
        let observed = json_success(&outcome)?;
        save(&self.dir.join(format!("{name}-observed.json")), &observed)?;
        Ok(observed)
    }
    fn git_state(&self, name: &str) -> Result<Value, String> {
        if self.root.join(".gitmodules").exists() {
            return Err("UNKNOWN_GIT_SUBMODULE_STATE".into());
        }
        let status = self.git(
            name,
            &[
                "--no-optional-locks",
                "status",
                "--porcelain=v2",
                "--branch",
                "-z",
                "--untracked-files=all",
                "--ignore-submodules=none",
                "--",
                ".",
            ],
        )?;
        let (head, entries) = status_entries(self.root, &status)?;
        Ok(
            json!({"head":head,"entries":entries,"working_hash":domain_value("working-diff",&json!({"entries":entries}))}),
        )
    }
    fn discovery(
        &self,
        name: &str,
        config: &Value,
        capture: &Value,
        sensitive: bool,
    ) -> Result<Value, String> {
        let cwd = self
            .root
            .canonicalize()
            .map_err(|e| e.to_string())?
            .to_string_lossy()
            .replace('\\', "/");
        let query = json!({"repositoryRoot":cwd,"config":config});
        let ordinary = self.query(
            &format!("{name}-discovery"),
            Some("--discover-repository"),
            &query,
            false,
        )?;
        let artifact = value_text(self.fixture, "artifact_sha256")?;
        if ordinary["request_descriptor_id"] != identity::digest(&query)
            || ordinary["producer_artifact_id"] != format!("sha256:{artifact}")
            || ordinary["executed"] != true
            || ordinary["unsupported"] != json!([])
        {
            return Err("actual working-tree discovery incomplete or foreign".into());
        }
        let paths = ordinary["candidates"]
            .as_array()
            .ok_or("native candidates absent")?
            .iter()
            .map(|c| value_text(c, "relPath").map(str::to_owned))
            .collect::<Result<Vec<_>, _>>()?;
        let eligibility_query = json!({"repositoryRoot":cwd,"processHelper":self.helper,
            "include":config["include"],"exclude":config["exclude"],"queries":paths});
        let eligibility = self.query(
            &format!("{name}-eligibility"),
            Some("--observe-path-eligibility"),
            &eligibility_query,
            false,
        )?;
        if eligibility["request_descriptor_id"] != identity::digest(&eligibility_query)
            || eligibility["producer_artifact_id"] != format!("sha256:{artifact}")
            || eligibility["eligibility_established"] != true
            || eligibility["queries"] != json!(paths)
        {
            return Err("actual working-tree Git eligibility incomplete or foreign".into());
        }
        let eligible = eligibility["eligible_results"]
            .as_array()
            .ok_or("eligible results absent")?;
        if eligible.len() != paths.len() {
            return Err("eligibility denominator differs".into());
        }
        let queries = paths
            .iter()
            .map(|p| json!({"operation":"read_file","path":format!("{cwd}/{p}")}))
            .collect::<Vec<_>>();
        let system_query = json!({"profile":"workspace","root":cwd,"case_sensitive":sensitive,"files":{},"sdk_directory":null,"queries":queries});
        let system = self.query(
            &format!("{name}-system"),
            Some("--observe-system"),
            &system_query,
            false,
        )?;
        if system["request_descriptor_id"] != identity::digest(&system_query)
            || system["producer_artifact_id"] != format!("sha256:{artifact}")
        {
            return Err("actual working-tree physical reads foreign".into());
        }
        let reads = system["results"]
            .as_array()
            .ok_or("physical read results absent")?;
        if reads.len() != paths.len() {
            return Err("physical read denominator differs".into());
        }
        let mut candidates = vec![];
        let mut selected = vec![];
        for (index, path) in paths.iter().enumerate() {
            let absolute = format!("{cwd}/{path}");
            let read = reads
                .iter()
                .find(|r| r["path"] == absolute)
                .ok_or("native physical read missing")?;
            if read["found"] != true
                || read["unsupported"] != json!([])
                || read["refusals"] != json!([])
                || read["value"] != capture[path]
                || !capture[path].is_string()
            {
                return Err("native physical bytes differ from actual retained capture".into());
            }
            let mut candidate = ordinary["candidates"].as_array().unwrap()[index].clone();
            let value = eligible[index]
                .as_bool()
                .ok_or("eligibility result nonboolean")?;
            if !value {
                candidate["selectionDecision"] = json!("excluded");
                candidate["analysisOutcome"] = json!("not_applicable");
                candidate["reason"] = json!("IGNORED_GENERATED_OUTPUT");
            } else if let Some(file) = ordinary["files"]
                .as_array()
                .ok_or("discovered files absent")?
                .iter()
                .find(|f| f["relPath"] == *path)
            {
                if file["content"] != capture[path] {
                    return Err("discovery byte join differs".into());
                }
                selected.push(file.clone());
            }
            if !candidate["language"].is_string() {
                return Err("native language classification absent".into());
            }
            candidates.push(candidate);
        }
        let result = json!({"executed":true,"unsupported":[],"candidates":candidates,"files":selected,
            "ordinary_request_id":ordinary["request_descriptor_id"],"eligibility_request_id":eligibility["request_descriptor_id"],
            "physical_read_request_id":system["request_descriptor_id"]});
        save(
            &self.dir.join(format!("{name}-composed-discovery.json")),
            &result,
        )?;
        Ok(result)
    }
}

/// All five registered fixtures use the latest index snapshot, whose physical
/// bytes equal the verification epoch. An unsupported temporal difference is
/// refused before a native query instead of being resealed from invented data.
pub(super) fn run(
    recipe: &Value,
    dir: &Path,
    root: &Path,
    fixture: &Value,
    setup_observations: &Value,
) -> Result<Value, String> {
    if fixture["public_lifecycle_execution_enabled"] != true {
        return Ok(
            json!({"state":"NOT_EXECUTED_PUBLIC_LIFECYCLE_DISABLED","native_queries":0,"pass":false}),
        );
    }
    if recipe["public_flow_kind"] != "public-verify"
        || recipe["native_verification"]["mode"] != json!(["verify", "working-tree"])
    {
        return Err("collector supports only registered working-tree inputs".into());
    }
    let artifact = Path::new(value_text(fixture, "artifact_path")?);
    let helper = Path::new(value_text(fixture, "helper_path")?);
    let sdk_path = Path::new(value_text(fixture, "sdk_path")?);
    let consumer = std::env::current_exe().map_err(|e| e.to_string())?;
    let artifact_sha = value_text(fixture, "artifact_sha256")?;
    let consumer_sha = value_text(fixture, "public_consumer_artifact_sha256")?;
    exact_hash(&consumer, consumer_sha)?;
    let collector = Collector {
        root,
        dir,
        fixture,
        artifact,
        helper,
        sdk_path,
        pins: vec![
            (artifact, artifact_sha),
            (helper, value_text(fixture, "helper_sha256")?),
            (sdk_path, value_text(fixture, "sdk_sha256")?),
            (&consumer, consumer_sha),
        ],
    };
    let sdk = read_json(sdk_path)?;
    let sensitive = setup_observations["native_case_sensitive"]
        .as_bool()
        .ok_or("measured native case absent")?;
    let index_capture = capture_tree(root)?;
    if index_capture != recipe["index_epoch_files"]
        || recipe["index_epoch_files"] != recipe["current_epoch_files"]
    {
        return Err("UNKNOWN_UNREGISTERED_INDEX_TO_VERIFY_PHYSICAL_EPOCH".into());
    }
    if recipe["git_after_index"]
        .as_array()
        .is_none_or(|v| !v.is_empty())
    {
        return Err("UNKNOWN_UNREGISTERED_INDEX_TO_VERIFY_GIT_EPOCH".into());
    }
    bounded_workspace(root, &index_capture)?;
    let ordinary_request = request_from_capture(
        &recipe["index_snapshot_template"],
        &index_capture,
        root,
        sensitive,
        "public-verify:ordinary-index",
    )?;
    if ordinary_request["qualified"] != false {
        return Err("ordinary structural request relabelled".into());
    }
    let selected_request = request_from_capture(
        &recipe["qualified_selected_template"],
        &index_capture,
        root,
        sensitive,
        "public-verify:qualified-selected",
    )?;
    if selected_request["qualified"] != true {
        return Err("qualified selected request relabelled".into());
    }
    let index_git = collector.git_state("index-status")?;
    let selected_discovery = collector.discovery(
        "selected",
        &recipe["selected_discovery_config"],
        &index_capture,
        sensitive,
    )?;
    let ordinary = collector.query("ordinary-index", None, &ordinary_request, true)?;
    observation_bound_to_request(&ordinary, &ordinary_request, &sdk, artifact_sha)?;
    join_successful_reads(&ordinary, &ordinary_request, &sdk)?;
    let batch = collector.query("ordinary-batch", Some("--batch"), &ordinary_request, true)?;
    let batch_receipt =
        super::batch_binding::validate_batch(&batch, &ordinary_request, &sdk, artifact_sha)?;
    save(&dir.join("ordinary-batch-binding.json"), &batch_receipt)?;
    if batch_receipt["admissible_index_store"] != true {
        return Err(
            "actual ordinary structural batch refused; full public projection unavailable".into(),
        );
    }
    let batch_path = dir.join("actual-transient-index.json");
    save(&batch_path, &batch)?;
    let batch_read = read_json(&batch_path)?;
    if batch_read != batch {
        return Err("actual transient index readback differs".into());
    }
    let qualified_selected =
        collector.query("qualified-selected", None, &selected_request, true)?;
    observation_bound_to_request(&qualified_selected, &selected_request, &sdk, artifact_sha)?;
    join_successful_reads(&qualified_selected, &selected_request, &sdk)?;
    let graph_path = dir.join("actual-transient-graph.json");
    save(&graph_path, &ordinary["assembly"])?;
    let graph = read_json(&graph_path)?;
    if graph != ordinary["assembly"] {
        return Err("actual structural graph readback differs".into());
    }
    let model = json!({"nodes":[],"changes":[],"refinementRelations":[]});
    let model_path = dir.join("actual-transient-semantic-model.json");
    save(&model_path, &model)?;
    let model_read = read_json(&model_path)?;
    if model_read != model {
        return Err("actual default semantic model readback differs".into());
    }
    let metadata = json!({"storeSchemaVersion":1,"toolVersion":"@semantic-context/app-services@0.4.5", "captured_at_unix_ms":std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|e|e.to_string())?.as_millis().to_string()});
    let meta_path = dir.join("actual-transient-store-metadata.json");
    save(&meta_path, &metadata)?;
    let meta_read = read_json(&meta_path)?;
    if meta_read != metadata {
        return Err("actual store metadata readback differs".into());
    }
    // Recapture live bytes and Git state after index, independently of retained
    // Request JSON. No new source content is derived from baseline expectations.
    let current_capture = capture_tree(root)?;
    let current_git = collector.git_state("current-status")?;
    let broad_request = request_from_capture(
        &recipe["qualified_broad_template"],
        &current_capture,
        root,
        sensitive,
        "public-verify:qualified-broad",
    )?;
    if broad_request["qualified"] != true {
        return Err("qualified broad request relabelled".into());
    }
    let qualified_broad = collector.query("qualified-broad", None, &broad_request, true)?;
    observation_bound_to_request(&qualified_broad, &broad_request, &sdk, artifact_sha)?;
    join_successful_reads(&qualified_broad, &broad_request, &sdk)?;
    let broad_discovery = collector.discovery(
        "broad",
        &recipe["broad_discovery_config"],
        &current_capture,
        sensitive,
    )?;
    let current_selected = collector.discovery(
        "current-selected",
        &recipe["selected_discovery_config"],
        &current_capture,
        sensitive,
    )?;
    let ast = super::scope_ast::observe(
        &broad_request,
        &sdk,
        &qualified_broad,
        artifact_sha,
        consumer_sha,
    )?;
    let current_capture_id = identity::digest(&current_capture);
    let scope = super::scope_ast::project(
        &qualified_broad,
        &ast,
        &graph,
        &broad_discovery,
        &current_capture_id,
        &current_capture_id,
    )?;
    let diff = collector.git(
        "tracked-diff",
        &[
            "--no-optional-locks",
            "diff",
            "--binary",
            "--full-index",
            "--no-ext-diff",
            "--no-textconv",
            "--no-renames",
            "HEAD",
            "--",
            ".",
        ],
    )?;
    let changed = nul_paths(&collector.git(
        "tracked-paths",
        &[
            "--no-optional-locks",
            "diff",
            "--name-only",
            "-z",
            "--no-ext-diff",
            "--no-textconv",
            "--no-renames",
            "HEAD",
            "--",
            ".",
        ],
    )?)?;
    let cached = nul_paths(&collector.git("cached-paths", &["ls-files", "--cached", "-z"])?)?;
    let current_rows=current_selected["candidates"].as_array().ok_or("current discovery candidates absent")?.iter()
        .map(|c|json!({"path":c["relPath"],"selectionDecision":c["selectionDecision"],"reason":c["reason"]})).collect::<Vec<_>>();
    let cwd = root
        .canonicalize()
        .map_err(|e| e.to_string())?
        .to_string_lossy()
        .replace('\\', "/");
    // These comparison identities intentionally retain C1's independently bound
    // capture/graph schema. They are not advertised as TypeScript digest values.
    // For the registered equal-byte epochs, equality is the frozen consumer fact.
    let seal = json!({"repositoryRoot":cwd,"indexedRepositoryRoot":cwd,"headAtCapture":current_git["head"],"indexedHeadCommit":index_git["head"],
        "repositoryGraphHash":identity::digest(&graph),"indexedRepositoryGraphHash":identity::digest(&ordinary["assembly"]),
        "semanticModelHash":domain_value("semantic-model",&model_read),"indexedSemanticModelHash":domain_value("semantic-model",&model),
        "analysisInputHash":identity::digest(&current_capture),"indexedAnalysisInputHash":identity::digest(&index_capture),
        "workingDiffHash":current_git["working_hash"],"indexedWorkingDiffHash":index_git["working_hash"],
        "storeSchemaVersion":meta_read["storeSchemaVersion"],"indexedStoreSchemaVersion":metadata["storeSchemaVersion"],
        "toolVersion":meta_read["toolVersion"],"indexedToolVersion":metadata["toolVersion"],"indexedAt":meta_read["captured_at_unix_ms"]});
    let mut binding_reasons = vec![];
    if ordinary["input_manifest_id"] != batch["input_manifest_id"] {
        binding_reasons.push("NATIVE_RAW_BATCH_CAPTURE_MISMATCH");
    }
    if ordinary["input_manifest_id"] != qualified_selected["input_manifest_id"] {
        binding_reasons.push("NATIVE_INDEX_QUALIFIED_CAPTURE_MISMATCH");
    }
    let capture_paths = evidence_capture_paths(&broad_request)?;
    let workspace_unambiguous =
        bounded_workspace(root, &index_capture)? && bounded_workspace(root, &current_capture)?;
    let after = capture_tree(root)?;
    let mut evidence = json!({"sdk_descriptor":sdk,"probe_artifact_sha256":artifact_sha,
        "ordinary_index_request":ordinary_request,"ordinary_index":ordinary,"ordinary_batch":batch,
        "index_store_written_batch":read_json(&batch_path)?,"index_store_readback_batch":batch_read,
        "qualified_selected_request":selected_request,"qualified_selected":qualified_selected,
        "qualified_broad_request":broad_request,"qualified_broad":qualified_broad,
        "selected_discovery":selected_discovery,"current_candidates":current_rows,"ordinary_graph":graph,
        "rust_scope_projection":scope,"scope_ast_receipt":ast,"changed_paths":changed,"actual_git_diff":diff,
        "git_cached_paths":cached,"current_capture_paths":capture_paths,
        "index_binding_valid":binding_reasons.is_empty(),"index_binding_reasons":binding_reasons,
        "workspace_unambiguous":workspace_unambiguous,"freshness_seal":seal,"check_changed":after!=current_capture,
        "configured_rules":recipe["configured_rules"],"index_store_receipt":batch_receipt,
        "collector_provenance":{"native_graph_schema":true,"seal_digest_parity_claimed":false,
            "initial_setup":setup_observations,"index_git":index_git,"current_git":current_git,
            "current_capture_id":current_capture_id,"consumer_artifact_sha256":consumer_sha}});
    // The actual kernel alone decides whether the admitted hunk removes base
    // lines. A rejected/untracked input never triggers an unnecessary base query.
    save(&dir.join("working-tree-pre-base-evidence.json"), &evidence)?;
    let first_projection = super::t00_admission_consumer::working_tree_projection(&evidence);
    let projected = match first_projection {
        Ok(projected) => projected,
        Err(error) if error == "ACTUAL_IMMUTABLE_BASE_GUARD_RECEIPT_REQUIRED" => {
            let listing =
                collector.git("base-tree", &["ls-tree", "-r", "--name-only", "-z", "HEAD"])?;
            let mut base = serde_json::Map::new();
            for path in nul_paths(&listing)? {
                if path
                    .split('/')
                    .any(|p| [".git", ".semctx", "node_modules"].contains(&p))
                {
                    continue;
                }
                let object = format!("HEAD:{path}");
                let bytes =
                    collector.git(&format!("base-file-{}", base.len()), &["show", &object])?;
                base.insert(path, json!(bytes));
            }
            let base = Value::Object(base);
            let mut template = recipe["qualified_broad_template"].clone();
            template["qualified"] = json!(false);
            template["files"] = base.clone();
            template["roots"] = json!(
                template["roots"]
                    .as_array()
                    .ok_or("base roots absent")?
                    .iter()
                    .filter(|p| p.as_str().is_some_and(|p| base.get(p).is_some()))
                    .cloned()
                    .collect::<Vec<_>>()
            );
            let request = request_from_capture(
                &template,
                &base,
                root,
                sensitive,
                "public-verify:actual-head-base",
            )?;
            let observed = collector.query("base-native", None, &request, true)?;
            observation_bound_to_request(
                &observed,
                &request,
                &evidence["sdk_descriptor"],
                artifact_sha,
            )?;
            join_successful_reads(&observed, &request, &evidence["sdk_descriptor"])?;
            evidence["base_request"] = request;
            evidence["base_native"] = observed;
            super::t00_admission_consumer::working_tree_projection(&evidence)?
        }
        Err(error) => return Err(error),
    };
    save(&dir.join("working-tree-actual-evidence.json"), &evidence)?;
    save(&dir.join("working-tree-rust-projection.json"), &projected)?;
    for (path, hash) in &collector.pins {
        exact_hash(path, hash)?;
    }
    Ok(
        json!({"state":"BOUND_WORKING_TREE_CONSUMER_OBSERVED","observed":{"consumer_kind":"t00-public-working-tree-admission-v1",
        "source_baseline":"3e94997fcbefa72ad4d49b2cad180ee79b7c0a9b","portable_projection":projected,"repository_root":root,
        "actual_evidence_path":dir.join("working-tree-actual-evidence.json"),"consumer_artifact_sha256":consumer_sha},
        "pass":false,"qualified":false,"global_admission_inferred":false,"R0":null}),
    )
}

#[cfg(test)]
mod collector_tests {
    use super::*;
    #[test]
    fn comparator_working_tree_git_scope_requires_complete_nul_capture() {
        assert_eq!(nul_paths("a.ts\0b.ts\0").unwrap(), vec!["a.ts", "b.ts"]);
        assert!(nul_paths("a.ts").is_err());
        assert!(nul_paths("../a.ts\0").is_err());
    }
    #[test]
    fn comparator_working_tree_clean_hash_uses_baseline_domain() {
        assert_eq!(
            domain_value("working-diff", &json!({"entries":[]})),
            "sha256:21dba70935f8f14f59199087ee440e16bec5dc567d8449b2cedf0c59c592abb1"
        );
        assert_ne!(
            domain_value("working-diff", &json!({"entries":[]})),
            identity::digest(&json!({"entries":[]}))
        );
    }
    #[test]
    fn comparator_working_tree_status_refuses_unsupported_records() {
        let root = Path::new(".");
        assert!(
            status_entries(root, "# branch.oid abcd\0u conflict\0")
                .unwrap_err()
                .contains("UNKNOWN_GIT")
        );
        assert!(status_entries(root, "# branch.oid (initial)\0").is_err());
        assert!(status_entries(root, "# branch.oid abcd").is_err());
    }
    #[test]
    fn comparator_working_tree_physical_generated_file_is_not_promoted_to_retained_capture() {
        let root = std::env::temp_dir().join(format!(
            "semctx-public-capture-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&root).unwrap();
        let capture =
            json!({"main.ts":"export const x=1;","build/generated.ts":"export const y=2;"});
        let template = json!({"files":{"main.ts":"export const x=1;"},"roots":["main.ts"],"retained":true,"qualified":true});
        let request =
            request_from_capture(&template, &capture, &root, true, "capture-control").unwrap();
        assert_eq!(request["files"].as_object().unwrap().len(), 1);
        assert_eq!(evidence_capture_paths(&request).unwrap(), vec!["main.ts"]);
        let missing = json!({"build/generated.ts":"export const y=2;"});
        assert!(request_from_capture(&template, &missing, &root, true, "missing").is_err());
        fs::remove_dir(&root).unwrap();
    }
}
