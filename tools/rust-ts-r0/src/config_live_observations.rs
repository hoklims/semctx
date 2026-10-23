use super::*;

use crate::configuration::System;

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
enum ReadFailure {
    Undefined,
    Error,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct LiveRequest {
    root: String,
    source: String,
    #[serde(default)]
    read_failures: BTreeMap<String, ReadFailure>,
}

struct LiveFs {
    root: String,
    canonical_root: String,
    native: Rc<dyn Fs>,
    normalizer: CaptureFs,
    failures: BTreeMap<String, ReadFailure>,
    inputs: RefCell<BTreeMap<String, Option<String>>>,
    errors: RefCell<BTreeMap<String, String>>,
}

impl LiveFs {
    fn record(&self, operation: &str, path: &str, text: Option<&str>, found: bool) {
        self.normalizer.log.borrow_mut().push(Probe {
            operation: operation.into(),
            path: self.key(path),
            found,
            content_id: text.map(|text| identity::digest_bytes(text.as_bytes())),
        });
    }
    fn physical(&self, path: &str) -> String {
        ts_goport::frontend::tspath::normalize_path(path)
    }
}

impl System for LiveFs {
    fn key(&self, path: &str) -> String {
        self.normalizer.key(path)
    }
    fn sensitive(&self) -> bool {
        self.normalizer.sensitive
    }
    fn probes(&self) -> Rc<RefCell<Vec<Probe>>> {
        self.normalizer.log.clone()
    }
    fn configuration_exists(&self, path: &str) -> bool {
        let found = self.native.file_exists(&self.physical(path));
        self.record("configuration_discovery_file_exists", path, None, found);
        found
    }
    fn contained(&self, repository: &str, path: &str) -> bool {
        let root = self.key(repository);
        let candidate = self.key(path);
        if root != "/" && candidate != root && !candidate.starts_with(&format!("{root}/")) {
            return false;
        }
        std::fs::canonicalize(self.physical(path)).map_or(true, |canonical| {
            let canonical = self.key(&canonical.to_string_lossy());
            let canonical_root = self.key(&self.canonical_root);
            canonical_root == "/"
                || canonical == canonical_root
                || canonical.starts_with(&format!("{canonical_root}/"))
        })
    }
}

impl Fs for LiveFs {
    fn use_case_sensitive_file_names(&self) -> bool {
        self.normalizer.sensitive
    }
    fn file_exists(&self, path: &str) -> bool {
        let found = self.native.file_exists(&self.physical(path));
        self.record("file_exists", path, None, found);
        found
    }
    fn read_file(&self, path: &str) -> (String, bool) {
        let key = self.key(path);
        let attribution = self.physical(path);
        let result = if !self.contained(&self.root, path) {
            Err("outside_repository".to_owned())
        } else if std::fs::canonicalize(self.physical(path)).is_err() {
            Err("canonical_read_failed".to_owned())
        } else {
            match self.failures.get(&key) {
                Some(ReadFailure::Undefined) => Err("undefined".to_owned()),
                Some(ReadFailure::Error) => Err("injected_read_error".to_owned()),
                None => {
                    let (text, found) = self.native.read_file(&self.physical(path));
                    if found {
                        Ok(text)
                    } else {
                        Err("native_read_failed".into())
                    }
                }
            }
        };
        let text = match result {
            Ok(text) => Some(text),
            Err(error) => {
                self.errors.borrow_mut().insert(attribution.clone(), error);
                None
            }
        };
        self.inputs.borrow_mut().insert(attribution, text.clone());
        self.record("read_file", path, text.as_deref(), text.is_some());
        (text.clone().unwrap_or_default(), text.is_some())
    }
    fn directory_exists(&self, path: &str) -> bool {
        let found =
            self.contained(&self.root, path) && self.native.directory_exists(&self.physical(path));
        self.record("directory_exists", path, None, found);
        found
    }
    fn get_accessible_entries(&self, _: &str) -> Entries {
        Entries {
            files: vec![],
            directories: vec![],
            symlinks: Some(Default::default()),
        }
    }
    fn stat(&self, path: &str) -> Option<FileInfo> {
        if !self.contained(&self.root, path) {
            return None;
        }
        self.native.stat(&self.physical(path))
    }
    fn realpath(&self, path: &str) -> String {
        if !self.contained(&self.root, path) {
            return path.into();
        }
        self.native.realpath(&self.physical(path))
    }
    fn write_file(&self, _: &str, _: &str) -> Result<(), FsError> {
        Err(FsError::Permission)
    }
    fn append_file(&self, _: &str, _: &str) -> Result<(), FsError> {
        Err(FsError::Permission)
    }
    fn remove(&self, _: &str) -> Result<(), FsError> {
        Err(FsError::Permission)
    }
    fn chtimes(
        &self,
        _: &str,
        _: Option<SystemTime>,
        _: Option<SystemTime>,
    ) -> Result<(), FsError> {
        Err(FsError::Permission)
    }
}

pub(super) fn run(descriptor: serde_json::Value) -> serde_json::Value {
    match observe(descriptor) {
        Ok(observation) => observation,
        Err(error) => serde_json::json!({"executed":false,"error":error}),
    }
}

fn observe(descriptor: serde_json::Value) -> Result<serde_json::Value, String> {
    let request: LiveRequest = serde_json::from_value(descriptor)
        .map_err(|error| format!("CONFIGURATION_LIVE_REQUEST_INVALID:{error}"))?;
    let absolute = captured_system_observations::absolute;
    if !absolute(&request.root)
        || !absolute(&request.source)
        || request.root.contains('\0')
        || request.source.contains('\0')
        || request
            .read_failures
            .keys()
            .any(|path| !absolute(path) || path.contains('\0'))
    {
        return Err("CONFIGURATION_LIVE_ABSOLUTE_PATH_REQUIRED".into());
    }
    let canonical_root = std::fs::canonicalize(&request.root)
        .map_err(|error| format!("CONFIGURATION_LIVE_ROOT_UNAVAILABLE:{error}"))?
        .to_string_lossy()
        .into_owned();
    let native = ts_goport::frontend::vfs::osvfs_fs();
    let normalizer = CaptureFs::new(BTreeMap::new(), native.use_case_sensitive_file_names());
    let root = ts_goport::frontend::tspath::normalize_path(&request.root);
    let source = ts_goport::frontend::tspath::normalize_path(&request.source);
    let mut failures = BTreeMap::new();
    for (path, failure) in request.read_failures {
        if failures.insert(normalizer.key(&path), failure).is_some() {
            return Err("CONFIGURATION_LIVE_CONFLICTING_FAILURE_KEY".into());
        }
    }
    let fs = Rc::new(LiveFs {
        root: root.clone(),
        canonical_root,
        native,
        normalizer,
        failures,
        inputs: RefCell::new(BTreeMap::new()),
        errors: RefCell::new(BTreeMap::new()),
    });
    let outcome = configuration::inspect_system(fs.clone(), &source, &root);
    let (reasons, consumed, error) = match outcome {
        Ok(configuration) => {
            let component = component_observations::ordinary_module_configuration(
                &configuration,
                BTreeSet::new(),
            );
            (component.reasons, configuration.consumed, None)
        }
        Err(error) => (vec![], BTreeSet::new(), Some(error)),
    };
    Ok(serde_json::json!({
        "executed":true,"profile":"live_configuration","reasons":reasons,"consumed":consumed,"error":error,
        "inputs":fs.inputs.borrow().clone(),"read_errors":fs.errors.borrow().clone(),"probes":fs.normalizer.log.borrow().clone(),
        "global_admission_inferred":false,"status":"development_observation_not_qualification"
    }))
}

#[cfg(test)]
#[path = "../tests/unit/config_live_observations.rs"]
mod tests;
