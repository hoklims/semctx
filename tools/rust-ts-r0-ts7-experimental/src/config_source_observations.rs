use super::*;
use serde_json::{Value, json};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SourceRequest {
    root: String,
    source: String,
    files: BTreeMap<String, String>,
    #[serde(default)]
    parsed_source: bool,
    #[serde(default = "retained_default")]
    retained: bool,
}

fn observe(value: Value, sdk: &Sdk) -> Result<Value, String> {
    let request: SourceRequest = serde_json::from_value(value)
        .map_err(|error| format!("CONFIGURATION_SOURCE_REQUEST_INVALID:{error}"))?;
    if !captured_system_observations::absolute(&request.root)
        || !captured_system_observations::absolute(&request.source)
    {
        return Err("CONFIGURATION_SOURCE_ABSOLUTE_PATHS_REQUIRED".into());
    }
    let sensitive = ts_goport::frontend::vfs::osvfs_fs().use_case_sensitive_file_names();
    let relative = relative_source_path(&request.root, &request.source, sensitive)?;
    if !sdk.matches_reference() {
        return Err("CONFIGURATION_SOURCE_TS7_SDK_REQUIRED".into());
    }
    sdk.validate_libraries("/sdk/lib")?;
    let normalizer = CaptureFs::new(BTreeMap::new(), sensitive);
    let mut keys = BTreeSet::new();
    for path in request.files.keys() {
        if !captured_system_observations::absolute(path) {
            return Err("CONFIGURATION_SOURCE_ABSOLUTE_FILES_REQUIRED".into());
        }
        relative_source_path(&request.root, path, sensitive)?;
        if !keys.insert(normalizer.key(path)) {
            return Err(format!("CONFIGURATION_SOURCE_CONFLICTING_KEY:{path}"));
        }
    }
    let fs = Rc::new(CaptureFs::new(request.files.clone(), sensitive));
    let available = fs.files.contains_key(&fs.key(&request.source));
    let (component, probes) = if available {
        let analysis = analyze(
            Request {
                id: "configuration-source-boundary".into(),
                cwd: request.root.clone(),
                sdk_directory: "/sdk/lib".into(),
                case_sensitive: sensitive,
                roots: vec![request.source.clone()],
                files: request.files,
                options: json!({"target":"ES2022","module":"ESNext","moduleResolution":"Bundler","allowJs":true,"jsx":"Preserve","skipLibCheck":true,"noEmit":true,"strict":false}),
                roles: BTreeMap::new(),
                selection: BTreeMap::new(),
                disabled: BTreeSet::new(),
                retained: request.retained,
                qualified: false,
                utf16_files: BTreeMap::new(),
                raw_files: BTreeMap::new(),
            },
            sdk.clone(),
        )?;
        let subject = analysis["subjects"]
            .as_array()
            .and_then(|subjects| subjects.iter().find(|subject| subject["path"] == relative))
            .ok_or("CONFIGURATION_SOURCE_SUBJECT_MISSING")?;
        let component = subject["moduleConfigurationObservations"][if request.retained {
            if request.parsed_source {
                "retainedWithSource"
            } else {
                "retainedWithoutSource"
            }
        } else if request.parsed_source {
            "ordinaryWithSource"
        } else {
            "ordinaryWithoutSnapshot"
        }]
        .clone();
        (component, analysis["capture_probes"].clone())
    } else {
        if request.parsed_source {
            return Err("CONFIGURATION_SOURCE_ARGUMENT_TEXT_UNAVAILABLE".into());
        }
        let configuration = configuration::inspect(fs.clone(), &request.source, &request.root)?;
        let ordinary_fs = Rc::new(fs.workspace_profile(&request.root, None)?);
        let ordinary = configuration::inspect(ordinary_fs, &request.source, &request.root)?;
        let named_reasons = configuration::unconsumed_named(
            fs.clone(),
            &request.root,
            &request.files.keys().cloned().collect::<Vec<_>>(),
        )?;
        let observation = component_observations::module_configuration(
            component_observations::ModuleConfigurationInputs {
                source: core::Node::NIL,
                path: &request.source,
                retained: request.retained,
                named_reasons: &named_reasons,
                configuration: &configuration,
                ordinary_configuration: &ordinary,
                ordinary_unsupported: &BTreeSet::new(),
                semantic: &qualified::QualifiedScan::default(),
                javascript: &javascript::JavascriptScan::default(),
                runtime: &runtime_configuration::RuntimeConfiguration::default(),
            },
        );
        let component = serde_json::to_value(if request.retained {
            observation.retained_without_source
        } else {
            observation.ordinary_without_snapshot
        })
        .map_err(|error| error.to_string())?;
        (component, json!(*fs.log.borrow()))
    };
    Ok(
        json!({"executed":true,"profile":"optional_configuration_source","source_available":available,"parsed_source_argument":request.parsed_source,"retained_source_profile":request.retained,"component":component,"probes":probes,"unsupported":[],"global_admission_inferred":false}),
    )
}

pub fn run(value: Value, sdk: &Sdk) -> Value {
    observe(value, sdk).unwrap_or_else(|error| json!({"executed":false,"profile":"optional_configuration_source","unsupported":[error],"global_admission_inferred":false}))
}

#[cfg(test)]
#[path = "../tests/unit/config_source_observations.rs"]
mod tests;
