use super::*;
use semctx_gates::process;
use semctx_r0_probe::receiver::*;
use serde_json::{Value, json};
use std::{
    fs,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Descriptor {
    repository_root: PathBuf,
    process_helper: PathBuf,
    include: Vec<String>,
    exclude: Vec<String>,
    index: Index,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Index {
    analysis: Request,
    outcome: process::Outcome,
    base_commit: String,
}

enum Admission {
    Admitted,
    Rejected,
}

pub(super) struct Verification {
    pub(super) report: Value,
    admission: Admission,
}

impl Verification {
    pub(super) fn exit_code(&self) -> i32 {
        match self.admission {
            Admission::Admitted => 0,
            Admission::Rejected => 3,
        }
    }
}

fn git(root: &Path, helper: &Path, args: &[&str]) -> Result<process::Outcome, String> {
    let mut argv = vec!["git".into()];
    argv.extend(args.iter().map(|s| s.to_string()));
    let outcome = process::run_with_helper(&argv, root, 5_000, 8_388_608, helper)
        .map_err(|e| e.to_string())?;
    if outcome.kind != "success"
        || outcome.exit_code != Some(0)
        || outcome.stdout_bytes != outcome.stdout.len() as u64
        || outcome.stderr_bytes != outcome.stderr.len() as u64
        || outcome.stdout_hash
            != identity::digest_bytes(outcome.stdout.as_bytes()).trim_start_matches("sha256:")
        || outcome.stderr_hash
            != identity::digest_bytes(outcome.stderr.as_bytes()).trim_start_matches("sha256:")
    {
        return Err(format!(
            "qualified Git command did not complete: {outcome:?}"
        ));
    }
    Ok(outcome)
}

fn discovery(
    root: &str,
    include: &[String],
    exclude: &[String],
    paths: &[PathBuf],
) -> Result<Value, String> {
    let observed = repository_discovery::qualified(
        json!({"repositoryRoot":root,"config":{"version":2,"include":include,"exclude":exclude,"languages":{"typescript":"on","javascript":"on","python":"on","markdown":"on","sql":"on"},"migrationsDirs":[]}}),
        paths,
    );
    if observed["executed"] != true || observed["unsupported"] != json!([]) {
        return Err(format!("qualified discovery failed: {observed}"));
    }
    Ok(observed)
}

fn receive_index(
    request: &Request,
    sdk: &Sdk,
    indexed: &process::Outcome,
    current: &wire::Batch,
    artifact: &[u8],
) -> Result<Receipt, String> {
    let input = batch::input_manifest(request, sdk)?;
    let capture = batch::capture_manifest(request)?;
    let graph = batch::graph_from_facts(&current.facts);
    let snapshot = batch::snapshot_manifest(request, sdk)?;
    let scope = batch::scope_manifest(request)?;
    let facts =
        FactsId::observed_json(&serde_json::to_value(&current.facts).map_err(|e| e.to_string())?);
    let input_id = InputId::observed_json(&input);
    let indexed_batch: wire::Batch =
        serde_json::from_str(&indexed.stdout).map_err(|e| e.to_string())?;
    let indexed_facts = FactsId::observed_json(
        &serde_json::to_value(&indexed_batch.facts).map_err(|e| e.to_string())?,
    );
    let same_input = indexed_batch.input_manifest_id == input_id.as_str();
    let freshness = Freshness {
        verdict: if facts == indexed_facts && same_input {
            FreshnessVerdict::Fresh
        } else {
            FreshnessVerdict::Stale
        },
        reasons: vec![],
        seal: Some(FreshnessSeal {
            repository_facts: facts.clone(),
            indexed_facts,
            analysis_input: input_id.clone(),
            indexed_input: input_id,
        }),
    };
    let observed = ObservedState {
        artifact_bytes: artifact,
        input_manifest: &input,
        capture: &capture,
        facts: &current.facts,
        graph: &graph,
        snapshot: &snapshot,
        scope: &scope,
        profile: batch::profile(request),
        freshness: &freshness,
        binding_valid: true,
        build_complete: current.complete,
        check_changed: false,
        request_current: true,
    };
    let subjects = request
        .roots
        .iter()
        .map(|path| {
            let relative = relative_source_path(&request.cwd, path, request.case_sensitive)?;
            let source = request
                .files
                .get(path)
                .ok_or("indexed root is absent from retained capture")?;
            Ok(ExpectedSubject {
                id: SubjectId::new(&relative).map_err(|e| format!("{e:?}"))?,
                selection: wire::Selection::Selected,
                source: Some(SourceExtent {
                    path: relative,
                    utf16_length: source.encode_utf16().count() as u64,
                    line_count: u32::try_from(source.bytes().filter(|b| *b == b'\n').count() + 1)
                        .map_err(|e| e.to_string())?,
                }),
                fact_kinds: batch::FACT_KINDS.iter().map(|s| s.to_string()).collect(),
                ranged_fact_kinds: [
                    "node:function",
                    "node:class",
                    "node:interface",
                    "node:type",
                    "node:enum",
                ]
                .into_iter()
                .map(str::to_string)
                .collect(),
                pathless_fact_kinds: BTreeSet::from(["node:repository".into()]),
                absence_allowed_kinds: BTreeSet::new(),
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    let receiver = Receiver::new(Expected {
        case_id: request.id.clone(),
        request: RequestId::new(&request.id).map_err(|e| format!("{e:?}"))?,
        bindings: observed.bindings().map_err(|e| format!("{e:?}"))?,
        profile: batch::profile(request).into(),
        subjects,
        terminal: ExpectedTerminal::Analyzed,
        deadline: Instant::now() + Duration::from_secs(20),
        max_duration_ms: 20_000,
        output_cap: 8_388_608,
    })
    .map_err(|e| format!("{e:?}"))?;
    let receipt = receiver
        .receive(indexed, &observed)
        .map_err(|e| format!("indexed extraction rejected: {e:?}"))?;
    if receipt.disposition() != EvidenceDisposition::Analyzed {
        return Err("indexed extraction was not analyzed".into());
    }
    Ok(receipt)
}

fn verify(descriptor: Value, sdk: Sdk) -> Result<Verification, String> {
    let spec: Descriptor = serde_json::from_value(descriptor.clone()).map_err(|e| e.to_string())?;
    let root = spec
        .repository_root
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let request = &spec.index.analysis;
    if Path::new(&request.cwd)
        .canonicalize()
        .map_err(|e| e.to_string())?
        != root
        || !request.qualified
        || !request.retained
        || !request.selection.is_empty()
        || !request.disabled.is_empty()
        || !request.roles.is_empty()
        || !request.utf16_files.is_empty()
        || !request.raw_files.is_empty()
        || request.roots.is_empty()
        || spec.include.is_empty()
    {
        return Err("unsupported qualified verification context".into());
    }
    let artifact =
        fs::read(std::env::current_exe().map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    let helper_before =
        identity::digest_bytes(&fs::read(&spec.process_helper).map_err(|e| e.to_string())?);
    let head = git(
        &root,
        &spec.process_helper,
        &["rev-parse", "--verify", "HEAD"],
    )?;
    if head.stdout.trim() != spec.index.base_commit
        || spec.index.base_commit.len() != 40
        || !spec
            .index
            .base_commit
            .bytes()
            .all(|b| b.is_ascii_hexdigit())
    {
        return Err("qualified index no longer refers to the current Git commit".into());
    }
    let diff = git(
        &root,
        &spec.process_helper,
        &["diff", "--name-only", "-z", "HEAD", "--"],
    )?;
    let status = git(
        &root,
        &spec.process_helper,
        &["ls-files", "--others", "--exclude-standard", "-z"],
    )?;
    if !status.stdout.is_empty() {
        return Err("untracked input outside the bounded indexed capture".into());
    }
    let authored = git(
        &root,
        &spec.process_helper,
        &["ls-files", "--cached", "-z", "--"],
    )?;
    let mut required_paths = authored
        .stdout
        .split('\0')
        .filter(|p| !p.is_empty())
        .map(str::to_string)
        .collect::<BTreeSet<_>>();
    let (metadata, _) = qualified_path_eligibility::metadata(&root)?;
    required_paths.extend(metadata);
    let path_key = |path: String| {
        if request.case_sensitive {
            path
        } else {
            path.to_lowercase()
        }
    };
    let required_paths = required_paths
        .into_iter()
        .map(path_key)
        .collect::<BTreeSet<_>>();
    let captured_paths = request
        .files
        .keys()
        .map(|path| {
            relative_source_path(&request.cwd, path, request.case_sensitive)
                .map(|relative| (path_key(relative), path))
        })
        .collect::<Result<BTreeMap<_, _>, _>>()?;
    if captured_paths.len() != request.files.len()
        || captured_paths.keys().cloned().collect::<BTreeSet<_>>() != required_paths
    {
        return Err(
            "qualified capture does not cover authored Git and configuration inputs".into(),
        );
    }
    let mut paths = Vec::with_capacity(request.files.len());
    for (path, text) in &request.files {
        let physical = Path::new(path).canonicalize().map_err(|e| e.to_string())?;
        if !physical.starts_with(&root)
            || fs::read(&physical).map_err(|e| e.to_string())? != text.as_bytes()
        {
            return Err("retained indexed bytes differ from current input".into());
        }
        paths.push(physical);
    }
    let selected = discovery(&request.cwd, &spec.include, &spec.exclude, &paths)?;
    let broad = discovery(&request.cwd, &["**/*".into()], &[], &paths)?;
    let selected_files = selected["files"]
        .as_array()
        .ok_or("selected discovery files missing")?;
    let selected_roots = selected_files
        .iter()
        .map(|f| {
            f["relPath"]
                .as_str()
                .map(|path| path_key(path.to_string()))
                .ok_or("selected path absent")
        })
        .collect::<Result<BTreeSet<_>, _>>()?;
    if request
        .roots
        .iter()
        .map(|path| relative_source_path(&request.cwd, path, request.case_sensitive).map(path_key))
        .collect::<Result<BTreeSet<_>, _>>()?
        != selected_roots
    {
        return Err("indexed extraction does not cover current selection".into());
    }
    let current_observation = analyze(request.clone(), sdk.clone())?;
    let current = batch::build(request, &sdk, &current_observation)?;
    let _receipt = receive_index(request, &sdk, &spec.index.outcome, &current, &artifact)?;
    let mut broad_request = request.clone();
    broad_request.roots = broad["files"]
        .as_array()
        .ok_or("broad sources missing")?
        .iter()
        .filter(|f| matches!(f["language"].as_str(), Some("typescript" | "javascript")))
        .map(|f| {
            let relative = f["relPath"].as_str().ok_or("broad source path absent")?;
            let path = *captured_paths
                .get(&path_key(relative.to_string()))
                .ok_or("broad source absent from the indexed retained capture")?;
            if request.files.get(path).map(String::as_str) != f["content"].as_str() {
                return Err("broad source absent from the indexed retained capture".into());
            }
            Ok(path.to_string())
        })
        .collect::<Result<Vec<_>, String>>()?;
    let broad_observation = analyze(broad_request.clone(), sdk.clone())?;
    if batch::input_manifest(request, &sdk)? != batch::input_manifest(&broad_request, &sdk)? {
        return Err("broad and selected analysis consumed different inputs".into());
    }
    let imports: Vec<ordinary::Import> =
        serde_json::from_value(broad_observation["raw_extraction"]["imports"].clone())
            .map_err(|error| format!("native broad imports invalid: {error}"))?;
    let import_scope = component_observations::retained_import_scope(
        &imports,
        &broad_request.files,
        &request.cwd,
        request.case_sensitive,
    )?;
    let mut links = BTreeSet::new();
    for import in &imports {
        if let Some(to) = &import.resolved_rel_path {
            links.insert((import.from_rel_path.clone(), to.clone()));
        }
    }
    let mut expected = diff
        .stdout
        .split('\0')
        .filter(|p| !p.is_empty())
        .map(str::to_string)
        .collect::<BTreeSet<_>>();
    loop {
        let previous = expected.len();
        for (from, to) in &links {
            if expected.contains(from) || expected.contains(to) {
                expected.extend([from.clone(), to.clone()]);
            }
        }
        if expected.len() == previous {
            break;
        }
    }
    let candidates = selected["candidates"]
        .as_array()
        .ok_or("selection candidate inventory missing")?;
    let subjects = current_observation["subjects"]
        .as_array()
        .ok_or("native selected subjects missing")?;
    let mut reasons = vec![];
    let mut coverage = vec![];
    for path in &expected {
        let candidate = candidates.iter().find(|c| c["relPath"] == *path);
        let subject = subjects.iter().find(|s| s["path"] == *path);
        let status = match (candidate, subject) {
            (Some(c), _) if c["selectionDecision"] == "excluded" => "excluded",
            (Some(_), Some(s))
                if s["outcome"] == "analyzed"
                    && s["reasons"] == json!([])
                    && s["unimplemented"] == json!([]) =>
            {
                "analyzed"
            }
            (Some(_), Some(_)) => "unsupported",
            _ => "missing",
        };
        if status != "analyzed" {
            reasons.push(format!("ANALYSIS_SCOPE_INCOMPLETE:{path}:{status}"));
        }
        coverage.push(json!({"path":path,"status":status}));
    }
    if !coverage.iter().any(|c| c["status"] == "analyzed") {
        reasons.push("ZERO_ANALYZED_OBLIGATIONS".into());
    }
    for (from, diagnostics) in &import_scope.unresolved_import_reasons {
        if expected.contains(from) {
            for diagnostic in diagnostics {
                reasons.push(String::from_utf16_lossy(diagnostic).replacen(
                    "DEPENDENCY_SCOPE_",
                    "",
                    1,
                ));
            }
        }
    }
    for subject in broad_observation["subjects"]
        .as_array()
        .ok_or("broad subject inventory missing")?
    {
        if subject["outcome"] != "analyzed"
            || subject["unimplemented"] != json!([])
            || subject["reasons"] != json!([])
        {
            reasons.push(format!("DEPENDENCY_SCOPE_UNSUPPORTED:{}", subject["path"]));
        }
    }
    if identity::digest_bytes(&fs::read(&spec.process_helper).map_err(|e| e.to_string())?)
        != helper_before
    {
        return Err("qualified process helper changed".into());
    }
    for (path, text) in &request.files {
        if fs::read(path).map_err(|e| e.to_string())? != text.as_bytes() {
            return Err("qualified input changed during verification".into());
        }
    }
    let admission = if reasons.is_empty() {
        Admission::Admitted
    } else {
        Admission::Rejected
    };
    let admitted = matches!(admission, Admission::Admitted);
    let configuration = current_observation["subjects"]
        .as_array()
        .and_then(|v| v.first())
        .ok_or("selected native configuration absent")?;
    let external = &import_scope.external_module_specifiers;
    let opaque_limitation = format!(
        "Opaque external static module boundaries (built-ins or manifest-declared non-workspace packages): {}. Their runtime behavior and APIs are not qualified.",
        if external.is_empty() {
            "none".into()
        } else {
            external.join(", ")
        }
    );
    Ok(Verification {
        report: json!({"analysisAdmission":{"status":if admitted{"admitted"}else{"rejected"},"changeCoverage":{"expected":expected,"files":coverage},"reasons":reasons,"externalModuleSpecifiers":external,"limitations":[opaque_limitation]},"verdict":if admitted{"NOT_ASSERTED"}else{"BLOCK"},"indexed_extraction_received":true,"inherited_configuration":{"executed":configuration["moduleConfigurationObservations"]["retainedWithSource"]["executed"],"consumed":configuration["configurationConsumed"]},"links":links,"changed_git_outcome":diff,"head_git_outcome":head,"selected_discovery":selected,"broad_discovery":broad,"selected_analysis":current_observation,"broad_analysis":broad_observation,"request_descriptor_id":identity::digest(&descriptor),"producer_artifact_id":identity::digest_bytes(&artifact),"sdk_input_id":identity::digest(&serde_json::to_value(&sdk).map_err(|e|e.to_string())?),"global_admission_inferred":false}),
        admission,
    })
}

pub(super) fn command(args: &[String]) -> Result<Verification, String> {
    if args.len() != 7 || args[2] != "working-tree" || args[5] != "--fail-on" || args[6] != "none" {
        return Err("expected verify working-tree REQUEST.json SDK.json --fail-on none".into());
    }
    let descriptor: Value = serde_json::from_slice(&fs::read(&args[3]).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    let sdk: Sdk = serde_json::from_slice(&fs::read(&args[4]).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    verify(descriptor, sdk)
}
