use super::*;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    root: String,
    #[serde(default)]
    files: Option<BTreeMap<String, String>>,
    #[serde(default)]
    inventory: Option<Vec<String>>,
    queries: Vec<Query>,
    #[serde(default)]
    system: SystemSelection,
    #[serde(default)]
    resolution: Option<Resolution>,
    #[serde(default)]
    faults: Vec<Fault>,
}

#[derive(Clone, Copy, Default, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum SystemSelection {
    #[default]
    NativeDefault,
    Captured,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Resolution {
    containing_file: String,
    specifier: String,
    #[serde(default)]
    mode: ResolutionMode,
}

#[derive(Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "snake_case")]
enum ResolutionMode {
    #[default]
    Omitted,
    Import,
    Require,
}
impl ResolutionMode {
    fn native(self) -> Option<ModuleKind> {
        match self {
            Self::Omitted => None,
            Self::Import => Some(ModuleKind::ES_NEXT),
            Self::Require => Some(ModuleKind::COMMON_JS),
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Query {
    operation: Operation,
    path: String,
}

#[derive(Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum Operation {
    FileExists,
    ReadFile,
    DirectoryExists,
    Realpath,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Fault {
    system: System,
    operation: Operation,
    path: String,
    outcome: Outcome,
}

#[derive(Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum System {
    Physical,
    Configuration,
}

#[derive(Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum Outcome {
    False,
    Undefined,
    ReadFailure,
    LexicalFallback,
}

struct Effects {
    faults: Vec<Fault>,
    trace: RefCell<Vec<serde_json::Value>>,
    activated: RefCell<Vec<Fault>>,
    failures: RefCell<Vec<serde_json::Value>>,
}
impl Effects {
    fn record(&self, system: &str, operation: &str, path: &str, value: serde_json::Value) {
        self.trace.borrow_mut().push(
            serde_json::json!({"system":system,"operation":operation,"path":path,"value":value}),
        );
    }
    fn fault(&self, system: System, operation: Operation, path: &str) -> Option<Outcome> {
        let fault = self.faults.iter().find(|fault| {
            fault.system == system && fault.operation == operation && fault.path == path
        })?;
        self.activated.borrow_mut().push(fault.clone());
        if fault.outcome == Outcome::ReadFailure {
            self.failures
                .borrow_mut()
                .push(serde_json::json!({"path":path,"reason":"TEST_INJECTED_READ_FAILURE"}));
        }
        Some(fault.outcome)
    }
    fn wrap(self: &Rc<Self>, system: &str, fs: Rc<dyn Fs>) -> Rc<dyn Fs> {
        let kind = if system == "physical" {
            System::Physical
        } else {
            System::Configuration
        };
        let file_base = fs.clone();
        let read_base = fs.clone();
        let directory_base = fs.clone();
        let realpath_base = fs.clone();
        let file_effects = self.clone();
        let read_effects = self.clone();
        let directory_effects = self.clone();
        let realpath_effects = self.clone();
        let file_system = system.to_string();
        let read_system = system.to_string();
        let directory_system = system.to_string();
        let realpath_system = system.to_string();
        ts_goport::frontend::vfs::wrapvfs_wrap(
            fs,
            ts_goport::frontend::vfs::Replacements {
                file_exists: Some(Box::new(move |path| {
                    let found = if file_effects
                        .fault(kind, Operation::FileExists, path)
                        .is_some()
                    {
                        false
                    } else {
                        file_base.file_exists(path)
                    };
                    file_effects.record(
                        &file_system,
                        "file_exists",
                        path,
                        serde_json::json!(found),
                    );
                    found
                })),
                read_file: Some(Box::new(move |path| {
                    let (text, found) = if read_effects
                        .fault(kind, Operation::ReadFile, path)
                        .is_some()
                    {
                        (String::new(), false)
                    } else {
                        read_base.read_file(path)
                    };
                    read_effects.record(
                        &read_system,
                        "read_file",
                        path,
                        serde_json::json!(found.then_some(&text)),
                    );
                    (text, found)
                })),
                directory_exists: Some(Box::new(move |path| {
                    let found = if directory_effects
                        .fault(kind, Operation::DirectoryExists, path)
                        .is_some()
                    {
                        false
                    } else {
                        directory_base.directory_exists(path)
                    };
                    directory_effects.record(
                        &directory_system,
                        "directory_exists",
                        path,
                        serde_json::json!(found),
                    );
                    found
                })),
                realpath: Some(Box::new(move |path| {
                    let actual = if realpath_effects
                        .fault(kind, Operation::Realpath, path)
                        .is_some()
                    {
                        path.into()
                    } else {
                        realpath_base.realpath(path)
                    };
                    realpath_effects.record(
                        &realpath_system,
                        "realpath",
                        path,
                        serde_json::json!(actual),
                    );
                    actual
                })),
                ..Default::default()
            },
        )
    }
}

fn observe(value: serde_json::Value) -> Result<serde_json::Value, String> {
    let request: Request = serde_json::from_value(value)
        .map_err(|error| format!("RESOLUTION_HOST_REQUEST_INVALID:{error}"))?;
    let absolute = |path: &str| {
        if request.files.is_some() {
            ts_goport::frontend::tspath::is_rooted_disk_path(path)
        } else {
            std::path::Path::new(path).is_absolute()
        }
    };
    if !absolute(&request.root)
        || (request.queries.is_empty() && request.resolution.is_none())
        || request.queries.len() > 4096
        || request.faults.len() > 4096
        || request.queries.iter().any(|query| !absolute(&query.path))
    {
        return Err("RESOLUTION_HOST_REQUEST_UNBOUNDED".into());
    }
    let mut unique_faults = BTreeSet::new();
    for fault in &request.faults {
        if !absolute(&fault.path)
            || !matches!(
                (fault.system, fault.operation, fault.outcome),
                (
                    _,
                    Operation::FileExists | Operation::DirectoryExists,
                    Outcome::False
                ) | (
                    System::Configuration,
                    Operation::ReadFile,
                    Outcome::Undefined | Outcome::ReadFailure
                ) | (
                    System::Configuration,
                    Operation::Realpath,
                    Outcome::LexicalFallback
                )
            )
            || !unique_faults.insert(
                serde_json::to_string(&(fault.system, fault.operation, &fault.path))
                    .map_err(|error| error.to_string())?,
            )
        {
            return Err("RESOLUTION_HOST_FAULT_INVALID".into());
        }
    }
    let (fs, source) = match (request.files, request.inventory) {
        (None, Some(inventory)) if matches!(request.system, SystemSelection::NativeDefault) => (
            live_system_observations::build(&request.root, &inventory, None)?,
            "native",
        ),
        (Some(files), None)
            if !files.is_empty()
                && files.len() <= 4096
                && files.values().map(String::len).sum::<usize>() <= 8_388_608 =>
        {
            if matches!(request.system, SystemSelection::Captured) {
                (CaptureFs::new(files, true), "captured_explicit")
            } else {
                (
                    CaptureFs::with_workspace_root(files, true, &request.root, None),
                    "captured_unit_control",
                )
            }
        }
        _ => return Err("RESOLUTION_HOST_CAPTURE_INVALID".into()),
    };
    let fs = Rc::new(fs);
    let effects = Rc::new(Effects {
        faults: request.faults,
        trace: RefCell::default(),
        activated: RefCell::default(),
        failures: RefCell::default(),
    });
    let admission_effects = effects.clone();
    let host = configured_resolver::PhysicalCaptureFs::observed(
        fs.clone(),
        |system, fs| effects.wrap(system, fs),
        Rc::new(move |path, admitted| {
            admission_effects.record("admission", "admitted", path, serde_json::json!(admitted))
        }),
    );
    let results = request
        .queries
        .iter()
        .map(|query| {
            let value = match query.operation {
                Operation::FileExists => serde_json::json!(host.file_exists(&query.path)),
                Operation::ReadFile => {
                    let (text, found) = host.read_file(&query.path);
                    serde_json::json!(found.then_some(text))
                }
                Operation::DirectoryExists => serde_json::json!(host.directory_exists(&query.path)),
                Operation::Realpath => serde_json::json!(host.realpath(&query.path)),
            };
            serde_json::json!({"operation":query.operation,"path":query.path,"value":value})
        })
        .collect::<Vec<_>>();
    let mut resolved = None;
    let mut native_error = None;
    let mut native_diagnostics = Vec::new();
    let mut observations = serde_json::Value::Null;
    if let Some(query) = request.resolution {
        let (resolver, recorded) = configured_resolver::configured(
            fs.clone(),
            request.root.clone(),
            "/sdk/lib".into(),
            ts_goport::frontend::module::ResolverOptions {
                host: Some(Rc::new(tsoptions::ResolverHost {
                    fs: fs.clone(),
                    current_directory: request.root.clone(),
                })),
                compiler_options: Some(Rc::new(compiler_options())),
                ..Default::default()
            },
        );
        let (found, diagnostics, error) = resolver.resolve_configured_module(
            &query.specifier,
            &query.containing_file,
            query.mode.native(),
        );
        resolved = found
            .filter(|found| !found.resolved_file_name.is_empty())
            .map(|found| found.resolved_file_name.clone());
        native_error = error.map(|error| error.to_string());
        native_diagnostics = diagnostics.iter().map(|diagnostic| serde_json::json!({"code":diagnostic.message.code(),"args":diagnostic.args})).collect();
        observations =
            serde_json::to_value(&*recorded.borrow()).map_err(|error| error.to_string())?;
    }
    Ok(serde_json::json!({
        "executed":true,"unsupported":[],"source":source,"results":results,"trace":*effects.trace.borrow(),
        "faultsRequested":effects.faults,"faultsActivated":*effects.activated.borrow(),"nativeFailures":*effects.failures.borrow(),
        "systemSelection":request.system,"resolved_file_name":resolved,
        "native_error":native_error,"native_diagnostics":native_diagnostics,"resolutionObservations":observations,
        "probes":*fs.log.borrow(),"status":"development_observation_not_qualification",
        "global_admission_inferred":false
    }))
}

pub(super) fn run(value: serde_json::Value) -> serde_json::Value {
    match observe(value) {
        Ok(value) => value,
        Err(error) => serde_json::json!({
            "executed":false,"unsupported":[error],
            "status":"development_observation_not_qualification","global_admission_inferred":false
        }),
    }
}

#[cfg(test)]
#[path = "../tests/unit/resolution_host.rs"]
mod tests;
