use super::*;
use ts_goport::frontend::module::ResolverOptions;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    root: String,
    sdk_directory: String,
    case_sensitive: bool,
    files: BTreeMap<String, String>,
    directories: Vec<String>,
    containing_file: String,
    specifier: String,
}

fn within(root: &str, path: &str) -> bool {
    root == "/" || path == root || path.starts_with(&format!("{root}/"))
}

fn capture(request: &Request, sdk: &Sdk) -> Result<Rc<CaptureFs>, String> {
    let absolute = captured_system_observations::absolute;
    if !absolute(&request.root) || !absolute(&request.sdk_directory) {
        return Err("CONFIGURED_QUERY_ABSOLUTE_ROOTS_REQUIRED".into());
    }
    validate_case_mode(
        request.case_sensitive,
        ts_goport::frontend::vfs::osvfs_fs().use_case_sensitive_file_names(),
    )?;
    for variable in ["GOPORT_LIB_PARSE_SNAPSHOT", "GOPORT_LIB_SNAPSHOT"] {
        if std::env::var(variable).as_deref() != Ok("0") {
            return Err(format!("captured SDK requires {variable}=0"));
        }
    }
    if !sdk.matches_reference() || sdk.files.is_empty() {
        return Err("CONFIGURED_QUERY_FOREIGN_OR_EMPTY_SDK".into());
    }
    if request.files.is_empty()
        || request.files.len() + sdk.files.len() > 20_000
        || request.directories.len() > 4096
        || request.specifier.is_empty()
        || request.specifier.contains('\0')
    {
        return Err("CONFIGURED_QUERY_INPUT_INVALID".into());
    }
    let normalizer = CaptureFs::new(BTreeMap::new(), request.case_sensitive);
    let root = normalizer.key(&request.root);
    let sdk_root = normalizer.key(&request.sdk_directory);
    if within(&root, &sdk_root) || within(&sdk_root, &root) {
        return Err("CONFIGURED_QUERY_OVERLAPPING_ROOTS".into());
    }
    let mut keys = BTreeSet::new();
    let mut bytes = 0_usize;
    let mut files = BTreeMap::new();
    for (input, boundary) in [(&request.files, &root), (&sdk.files, &sdk_root)] {
        for (path, text) in input {
            let key = normalizer.key(path);
            if !absolute(path) || path.contains('\0') || !within(boundary, &key) {
                return Err("CONFIGURED_QUERY_FILE_OUTSIDE_CAPTURE".into());
            }
            if !keys.insert(key) {
                return Err("CONFIGURED_QUERY_CONFLICTING_FILE_KEY".into());
            }
            bytes = bytes
                .checked_add(text.len())
                .ok_or("CONFIGURED_QUERY_INPUT_TOO_LARGE")?;
            files.insert(
                ts_goport::frontend::tspath::normalize_path(path),
                ts_goport::scanner_util::go_string_from_utf8(text.clone()),
            );
        }
    }
    if bytes > 33_554_432 {
        return Err("CONFIGURED_QUERY_INPUT_TOO_LARGE".into());
    }
    if !absolute(&request.containing_file)
        || !within(&root, &normalizer.key(&request.containing_file))
        || !request
            .files
            .keys()
            .any(|path| normalizer.key(path) == normalizer.key(&request.containing_file))
    {
        return Err("CONFIGURED_QUERY_SOURCE_NOT_CAPTURED".into());
    }
    let mut fs = CaptureFs::new(files, request.case_sensitive);
    let mut directories = BTreeSet::new();
    for path in &request.directories {
        let key = fs.key(path);
        if !absolute(path)
            || path.contains('\0')
            || !within(&root, &key)
            || !directories.insert(key)
        {
            return Err("CONFIGURED_QUERY_DIRECTORY_INVALID".into());
        }
        let mut directory = ts_goport::frontend::tspath::normalize_path(path);
        loop {
            let key = fs.key(&directory);
            fs.dirs.insert(key.clone());
            fs.spelling.entry(key).or_insert_with(|| directory.clone());
            let Some((parent, _)) = directory.rsplit_once('/') else {
                break;
            };
            if parent.is_empty() {
                break;
            }
            directory = parent.into();
        }
    }
    if !fs.dirs.contains(&root)
        || !fs.dirs.contains(&sdk_root)
        || fs.files.keys().any(|path| fs.dirs.contains(path))
    {
        return Err("CONFIGURED_QUERY_FILE_DIRECTORY_COLLISION".into());
    }
    let fs = fs.with_sdk_keys(sdk.files.keys().map(String::as_str))?;
    Ok(Rc::new(fs.workspace_profile(
        &request.root,
        Some(&request.sdk_directory),
    )?))
}

fn observe(value: serde_json::Value, sdk: &Sdk) -> Result<serde_json::Value, String> {
    let request: Request = serde_json::from_value(value)
        .map_err(|error| format!("CONFIGURED_QUERY_REQUEST_INVALID:{error}"))?;
    let fs = capture(&request, sdk)?;
    let configuration =
        configuration::inspect(fs.clone(), &request.containing_file, &request.root)?;
    let workspace = fs
        .workspace
        .as_ref()
        .ok_or("CONFIGURED_QUERY_WORKSPACE_MISSING")?;
    let configuration_unsupported = workspace
        .issues
        .borrow()
        .iter()
        .filter(|issue| issue.kind == "unsupported")
        .map(|issue| issue.detail.clone())
        .collect();
    let configuration = component_observations::ordinary_module_configuration(
        &configuration,
        configuration_unsupported,
    );
    let (create, resolution) = configured_resolver::factory(
        fs.clone(),
        request.root.clone(),
        request.sdk_directory.clone(),
    );
    let resolver = create(ResolverOptions {
        host: Some(Rc::new(tsoptions::ResolverHost {
            fs: fs.clone(),
            current_directory: request.root.clone(),
        })),
        compiler_options: Some(Rc::new(compiler_options())),
        ..Default::default()
    });
    let (found, diagnostics, error) = resolver.resolve_module_name(
        &request.specifier,
        &request.containing_file,
        ModuleKind::NONE,
        None,
    );
    let mut unsupported = workspace.unsupported.borrow().clone();
    if error.is_some() || !resolution.borrow().errors.is_empty() {
        unsupported.insert("NATIVE_MODULE_RESOLUTION_ERROR".into());
    }
    if !diagnostics.is_empty() {
        unsupported.insert("NATIVE_MODULE_RESOLUTION_DIAGNOSTICS".into());
    }
    let resolved = found
        .as_ref()
        .filter(|found| !found.resolved_file_name.is_empty())
        .map(|found| found.resolved_file_name.clone());
    let relative = resolved
        .as_deref()
        .map(|path| relative_source_path(&request.root, path, request.case_sensitive))
        .transpose()?;
    let directories = request
        .directories
        .iter()
        .map(|path| serde_json::json!({"path":path,"found":fs.directory_exists(path)}))
        .collect::<Vec<_>>();
    Ok(serde_json::json!({
        "executed":true,"unsupported":unsupported,"containing_file":request.containing_file,"specifier":request.specifier,
        "resolutionMode":"omitted","resolved_file_name":resolved,"resolved_relative_path":relative,
        "native_error":error.map(|error| error.to_string()),
        "native_diagnostics":diagnostics.iter().map(|diagnostic| serde_json::json!({"code":diagnostic.message.code(),"args":diagnostic.args})).collect::<Vec<_>>(),
        "configuration":configuration,"resolutionObservations":*resolution.borrow(),
        "capturedDirectories":directories,"probes":*fs.log.borrow(),"workspaceMappings":*workspace.aliases.borrow(),"workspaceIssues":*workspace.issues.borrow(),
        "status":"development_observation_not_qualification","global_admission_inferred":false
    }))
}

pub fn run(request: serde_json::Value, sdk: &Sdk) -> serde_json::Value {
    match observe(request, sdk) {
        Ok(observed) => observed,
        Err(error) => {
            serde_json::json!({"executed":false,"unsupported":[error],"status":"development_observation_not_qualification","global_admission_inferred":false})
        }
    }
}

#[cfg(test)]
#[path = "../tests/unit/configured_resolution_observations.rs"]
mod tests;
