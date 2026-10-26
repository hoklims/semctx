use super::*;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    root: String,
    repository_root: Option<String>,
    containing_file: String,
    configured: bool,
    retained: bool,
    files: BTreeMap<String, String>,
    #[serde(default)]
    canonical_failures: BTreeMap<String, String>,
}

fn observe(value: serde_json::Value, sdk: &Sdk) -> Result<serde_json::Value, String> {
    let request: Request = serde_json::from_value(value)
        .map_err(|error| format!("RUNTIME_MODULE_REQUEST_INVALID:{error}"))?;
    if !std::path::Path::new(&request.root).is_absolute()
        || !request.files.contains_key(&request.containing_file)
        || request.files.is_empty()
        || request.files.len() > 4096
    {
        return Err("RUNTIME_MODULE_INPUT_INVALID".into());
    }
    sdk.validate_libraries("/sdk/lib")?;
    let fs = if request.retained {
        let mut files = request.files.clone();
        for (path, source) in &sdk.files {
            if files.insert(path.clone(), source.clone()).is_some() {
                return Err("RUNTIME_MODULE_SDK_OVERLAP".into());
            }
        }
        CaptureFs::new(
            files,
            ts_goport::frontend::vfs::osvfs_fs().use_case_sensitive_file_names(),
        )
        .with_sdk_keys(sdk.files.keys().map(String::as_str))?
    } else {
        live_system_observations::build(
            &request.root,
            &request.files.keys().cloned().collect::<Vec<_>>(),
            Some(sdk),
        )?
    };
    let fs = Rc::new(fs);
    let frontend = native_frontend(
        fs.clone(),
        &request.root,
        "/sdk/lib",
        vec![request.containing_file.clone()],
        request.configured,
    );
    let _current = native_program::NativeProgram::enter(&frontend.program);
    program::bind_all();
    let source = program::get_source_file(&request.containing_file);
    if source.is_nil() {
        return Err("RUNTIME_MODULE_SOURCE_NOT_LOADED".into());
    }
    let relative = relative_source_path(&request.root, &request.containing_file, fs.sensitive)?;
    let captured_files = fs.files.clone();
    let inputs_ledger = fs
        .live
        .as_ref()
        .map(|live| live.inputs_ledger())
        .unwrap_or_default();
    let initial_inputs = inputs_ledger.borrow().clone();
    let sensitive = fs.sensitive;
    let root = request.root.clone();
    let repository_root = request.repository_root.clone();
    let configured = request.configured;
    let retained = request.retained;
    let canonical_failures = request.canonical_failures;
    let (extraction, recorded_inputs, runtime_resolution) =
        program::with_type_checker_for_file(source, move |checker| {
            let inputs = Rc::new(RefCell::new(initial_inputs));
            let trace = Rc::new(RefCell::new(Vec::new()));
            let actual_fs: Rc<dyn Fs> = if retained {
                Rc::new(CaptureFs::new(captured_files.clone(), sensitive))
            } else {
                ts_goport::frontend::vfs::osvfs_fs()
            };
            let mut runtime_module = ordinary::RuntimeModuleResolver::new(
                move |path| actual_fs.file_exists(path),
                configured,
                retained,
                repository_root,
                inputs.clone(),
                trace.clone(),
            );
            for (path, error) in canonical_failures {
                runtime_module.fail_canonical_for_testing(path, error);
            }
            let extraction = ordinary::extract(
                source,
                checker,
                &relative,
                &ordinary::ExtractionContext {
                    repository_root: &root,
                    static_module_links: true,
                    retained,
                    javascript_enabled: true,
                    captured_files: Some(&captured_files),
                    runtime_module: Some(&runtime_module),
                    case_sensitive: sensitive,
                },
            )?;
            let recorded_inputs = inputs.borrow().clone();
            let recorded_trace = trace.borrow().clone();
            Ok::<_, String>((extraction, recorded_inputs, recorded_trace))
        })?;
    inputs_ledger.borrow_mut().extend(recorded_inputs);
    let native_error = frontend
        .program
        .module_resolution_error
        .as_ref()
        .map(ToString::to_string);
    let unsupported = native_error
        .iter()
        .map(|error| format!("RUNTIME_MODULE_NATIVE_ERROR:{error}"))
        .collect::<Vec<_>>();
    Ok(serde_json::json!({
        "executed":true,"unsupported":unsupported,"extraction":extraction,
        "configured":request.configured,"retained":request.retained,"repository_root":request.repository_root,
        "runtime_resolution":runtime_resolution,"inputs":*inputs_ledger.borrow(),"probes":fs.log.borrow().clone(),
        "global_admission_inferred":false,"status":"test_only_owning_runtime_module_observation"
    }))
}

pub(super) fn run(value: serde_json::Value, sdk: &Sdk) -> serde_json::Value {
    match observe(value, sdk) {
        Ok(observation) => observation,
        Err(error) => {
            serde_json::json!({"executed":false,"unsupported":[error],"runtime_resolution":[],"global_admission_inferred":false})
        }
    }
}

#[cfg(test)]
#[path = "../tests/unit/runtime_module.rs"]
mod tests;
