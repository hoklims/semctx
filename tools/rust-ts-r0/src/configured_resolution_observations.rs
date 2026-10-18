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
    if sdk.version != "5.9.3"
        || sdk.archive_sha256 != "10e108c9cf7d5f2879053dff18515fb405abf2ccef63eaaf017d9c571687a1d3"
        || sdk.files.is_empty()
    {
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
mod tests {
    use super::*;

    fn descriptor() -> serde_json::Value {
        serde_json::json!({
            "root":"/repo", "sdk_directory":"/sdk/lib",
            "case_sensitive":ts_goport::frontend::vfs::osvfs_fs().use_case_sensitive_file_names(),
            "files":{"/repo/source.ts":"export const sourceDev = 61;", "/repo/leaf.ts":"export const leafDev = 67;"},
            "directories":["/repo/.git"], "containing_file":"/repo/source.ts", "specifier":"./leaf"
        })
    }

    fn sdk() -> Sdk {
        serde_json::from_slice(
            &std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/sdk/sdk-input.json")).unwrap(),
        )
        .unwrap()
    }

    #[test]
    fn canonical_capture_aliases_do_not_create_phantom_parent_directories() {
        let mut value = descriptor();
        value["directories"] = serde_json::json!(["/repo/directory-phantom/../.git"]);
        value["files"]
            .as_object_mut()
            .unwrap()
            .remove("/repo/source.ts");
        value["files"]["/repo/source-phantom/../source.ts"] =
            serde_json::json!("export const sourceDev = 79;");
        let parsed: Request = serde_json::from_value(value.clone()).unwrap();
        let fs = capture(&parsed, &sdk()).unwrap();
        assert!(!fs.directory_exists("/repo/directory-phantom"));
        assert!(!fs.directory_exists("/repo/source-phantom"));
        assert!(fs.directory_exists("/repo/.git"));
        assert_eq!(run(value, &sdk())["resolved_relative_path"], "leaf.ts");
    }

    #[test]
    fn explicit_query_refuses_ambiguous_or_unconfined_capture_and_foreign_sdk() {
        let original = descriptor();
        let mut invalid = vec![];
        let mut value = original.clone();
        value["surprise"] = serde_json::json!(true);
        invalid.push(value);
        let mut value = original.clone();
        value["files"]["/repo/./source.ts"] = serde_json::json!("alias");
        invalid.push(value);
        let mut value = original.clone();
        value["files"]["/repo/../outside.ts"] = serde_json::json!("outside");
        invalid.push(value);
        let mut value = original.clone();
        value["files"]["relative.ts"] = serde_json::json!("relative");
        invalid.push(value);
        let mut value = original.clone();
        value["files"]["/repo/parent"] = serde_json::json!("file");
        value["files"]["/repo/parent/child.ts"] = serde_json::json!("child");
        invalid.push(value);
        for directories in [
            serde_json::json!(["/repo/.git", "/repo/./.git"]),
            serde_json::json!(["/repo/source.ts"]),
            serde_json::json!(["/repo/source.ts/nested"]),
            serde_json::json!(["/repo/../outside"]),
            serde_json::json!(["relative"]),
        ] {
            let mut value = original.clone();
            value["directories"] = directories;
            invalid.push(value);
        }
        for source in ["/repo/missing.ts", "/outside.ts", "source.ts"] {
            let mut value = original.clone();
            value["containing_file"] = serde_json::json!(source);
            invalid.push(value);
        }
        let mut value = original.clone();
        value["case_sensitive"] = serde_json::json!(!original["case_sensitive"].as_bool().unwrap());
        invalid.push(value);
        let mut value = original.clone();
        value["sdk_directory"] = serde_json::json!("/repo/sdk");
        invalid.push(value);
        let mut value = original.clone();
        value["specifier"] = serde_json::json!("");
        invalid.push(value);
        for value in invalid {
            let observed = run(value, &sdk());
            assert_eq!(observed["executed"], false, "{observed}");
            assert!(!observed["unsupported"].as_array().unwrap().is_empty());
            assert!(observed.get("resolved_relative_path").is_none());
        }
        let mut foreign = sdk();
        foreign.version = "7.1.0-dev".into();
        assert_eq!(run(original.clone(), &foreign)["executed"], false);
        let mut foreign = sdk();
        foreign.archive_sha256 = "wrong".into();
        assert_eq!(run(original.clone(), &foreign)["executed"], false);
        let mut foreign = sdk();
        foreign.files.clear();
        assert_eq!(run(original.clone(), &foreign)["executed"], false);
        let mut foreign = sdk();
        foreign
            .files
            .insert("/sdk/lib/../escape.d.ts".into(), "escape".into());
        assert_eq!(run(original.clone(), &foreign)["executed"], false);
        assert_eq!(run(original, &sdk())["resolved_relative_path"], "leaf.ts");
    }

    #[test]
    fn explicit_query_keeps_unresolved_distinct_from_native_resolution_failure_and_restoration() {
        let mut value = descriptor();
        value["specifier"] = serde_json::json!("missing-dev");
        let missing = run(value.clone(), &sdk());
        assert_eq!(missing["executed"], true);
        assert_eq!(missing["unsupported"], serde_json::json!([]));
        assert_eq!(missing["resolved_relative_path"], serde_json::Value::Null);
        assert_eq!(missing["native_error"], serde_json::Value::Null);
        value["specifier"] = serde_json::json!("failure-dev");
        value["files"]["/repo/node_modules/failure-dev/index.ts"] =
            serde_json::json!("export const failureDev = 71;");
        for mapping in [
            serde_json::json!("index.ts"),
            serde_json::json!([7]),
            serde_json::json!(["index.ts"]),
        ] {
            value["files"]["/repo/node_modules/failure-dev/package.json"] = serde_json::json!(
                serde_json::json!({"types":"index.ts","typesVersions":{"<6":{"*":mapping}}})
                    .to_string()
            );
            let observed = run(value.clone(), &sdk());
            assert_eq!(observed["executed"], true, "{observed}");
            if mapping == serde_json::json!(["index.ts"]) {
                assert_eq!(observed["unsupported"], serde_json::json!([]));
                assert_eq!(observed["native_error"], serde_json::Value::Null);
                assert_eq!(
                    observed["resolved_relative_path"],
                    "node_modules/failure-dev/index.ts"
                );
            } else {
                assert!(
                    observed["unsupported"]
                        .as_array()
                        .unwrap()
                        .contains(&serde_json::json!("NATIVE_MODULE_RESOLUTION_ERROR")),
                    "{observed}"
                );
                assert!(
                    observed["native_error"]
                        .as_str()
                        .is_some_and(|error| error.contains("VERSION_PATH")),
                    "{observed}"
                );
                assert!(
                    !observed["resolutionObservations"]["errors"]
                        .as_object()
                        .unwrap()
                        .is_empty()
                );
            }
        }
    }
}
