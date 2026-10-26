use super::*;
use std::path::Path;
use ts_goport::frontend::module::ResolverOptions;

pub(super) struct LiveBoundary {
    root: String,
    inputs: RefCell<BTreeMap<String, Option<String>>>,
    errors: RefCell<Vec<serde_json::Value>>,
}
impl LiveBoundary {
    fn within(&self, path: &str) -> bool {
        let (root, path) = if native_case() {
            (self.root.clone(), path.into())
        } else {
            (self.root.to_lowercase(), path.to_lowercase())
        };
        path == root || path.starts_with(&format!("{root}/"))
    }
    fn refused(&self, path: &str, reason: &str) {
        self.inputs.borrow_mut().insert(path.into(), None);
        self.errors
            .borrow_mut()
            .push(serde_json::json!({"path":path,"reason":reason}));
    }
    fn nested(&self, path: &str) -> bool {
        if path == self.root || (!native_case() && path.eq_ignore_ascii_case(&self.root)) {
            return false;
        }
        let mut directory = Path::new(path).parent();
        while let Some(current) = directory {
            if current.to_string_lossy().eq_ignore_ascii_case(&self.root) {
                return false;
            }
            if current.join(".git").symlink_metadata().is_ok() {
                return true;
            }
            directory = current.parent();
        }
        false
    }
    pub(super) fn direct(&self, _fs: &CaptureFs, path: &str) -> Option<String> {
        let key = CaptureFs::new(BTreeMap::new(), true).key(path);
        if !Path::new(path).is_absolute() || !self.within(&key) || self.nested(&key) {
            self.refused(&key, "LIVE_PATH_OUTSIDE_OR_NESTED");
            return None;
        }
        match std::fs::canonicalize(&key) {
            Ok(actual) => {
                let actual = actual.to_string_lossy().into_owned();
                if self.within(&actual) && !self.nested(&actual) {
                    Some(key)
                } else {
                    self.refused(&key, "LIVE_CANONICAL_ESCAPE_OR_NESTED");
                    None
                }
            }
            Err(error) => {
                self.refused(&key, &format!("LIVE_CANONICAL_FAILED:{error}"));
                None
            }
        }
    }
    fn target(&self, fs: &CaptureFs, path: &str) -> Option<String> {
        if let Some(path) = self.direct(fs, path) {
            return Some(path);
        }
        if !std::fs::symlink_metadata(path)
            .is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound)
        {
            return None;
        }
        let key = fs.key(path);
        if !self.within(&key) || self.nested(&key) {
            return None;
        }
        let physical = fs.workspace.as_ref()?.resolve(fs, path)?;
        self.direct(
            fs,
            fs.spelling
                .get(&physical)
                .map_or(physical.as_str(), String::as_str),
        )
    }
    pub(super) fn file_exists(&self, fs: &CaptureFs, path: &str) -> bool {
        let lexical = CaptureFs::new(BTreeMap::new(), true).key(path);
        if Path::new(path).is_absolute()
            && self.within(&lexical)
            && path.ends_with("/tsconfig.json")
            && std::fs::metadata(path).is_ok_and(|metadata| metadata.is_file())
        {
            fs.record("file_exists", &lexical, true);
            return true;
        }
        let target = self.target(fs, path);
        let found = target
            .as_ref()
            .is_some_and(|path| std::fs::metadata(path).is_ok_and(|metadata| metadata.is_file()));
        fs.record("file_exists", target.as_deref().unwrap_or(path), found);
        found
    }
    pub(super) fn read_file(&self, fs: &CaptureFs, path: &str) -> (String, bool) {
        let target = self.target(fs, path);
        let content = target
            .as_ref()
            .and_then(|target| match bounded_read(target, 8_388_608) {
                Ok(text) => Some(ts_goport::scanner_util::go_string_from_utf8(text)),
                Err(error) => {
                    self.refused(target, &format!("LIVE_READ_FAILED:{error}"));
                    None
                }
            });
        let physical = target.as_deref().unwrap_or(path);
        self.inputs
            .borrow_mut()
            .insert(physical.into(), content.clone());
        fs.record("read_file", physical, content.is_some());
        fs.log.borrow_mut().last_mut().unwrap().content_id = content
            .as_ref()
            .map(|text| identity::digest_bytes(text.as_bytes()));
        (content.clone().unwrap_or_default(), content.is_some())
    }
    pub(super) fn directory_exists(&self, fs: &CaptureFs, path: &str) -> bool {
        let target = self.target(fs, path);
        let found = target
            .as_ref()
            .is_some_and(|path| std::fs::metadata(path).is_ok_and(|metadata| metadata.is_dir()))
            || (std::fs::symlink_metadata(path)
                .is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound)
                && self.within(&fs.key(path))
                && !self.nested(path)
                && fs
                    .workspace
                    .as_ref()
                    .is_some_and(|workspace| workspace.virtual_node_modules(fs, path)));
        fs.record("directory_exists", target.as_deref().unwrap_or(path), found);
        found
    }
    pub(super) fn realpath(&self, fs: &CaptureFs, path: &str) -> String {
        let target = self.target(fs, path);
        let actual = target
            .as_ref()
            .and_then(|path| std::fs::canonicalize(path).ok())
            .map(|path| path.to_string_lossy().into_owned());
        fs.record(
            "realpath",
            target.as_deref().unwrap_or(path),
            actual.is_some(),
        );
        actual.unwrap_or_else(|| path.into())
    }
}

fn bounded_read(path: &str, limit: usize) -> Result<String, String> {
    use std::io::Read;
    if !std::fs::metadata(path)
        .map_err(|error| error.to_string())?
        .is_file()
    {
        return Err("LIVE_READ_NOT_REGULAR".into());
    }
    let file = std::fs::File::open(path).map_err(|error| error.to_string())?;
    let mut text = String::new();
    file.take((limit + 1) as u64)
        .read_to_string(&mut text)
        .map_err(|error| error.to_string())?;
    if text.len() > limit {
        return Err("LIVE_READ_LIMIT".into());
    }
    Ok(text)
}

fn native_case() -> bool {
    ts_goport::frontend::vfs::osvfs_fs().use_case_sensitive_file_names()
}

fn build(root: &str, inventory: &[String], sdk: Option<&Sdk>) -> Result<CaptureFs, String> {
    if !Path::new(root).is_absolute() || inventory.is_empty() || inventory.len() > 4096 {
        return Err("LIVE_INVENTORY_INVALID".into());
    }
    let root =
        std::fs::canonicalize(root).map_err(|error| format!("LIVE_ROOT_UNAVAILABLE:{error}"))?;
    if !root.is_dir() {
        return Err("LIVE_ROOT_NOT_DIRECTORY".into());
    }
    let live = LiveBoundary {
        root: root.to_string_lossy().into_owned(),
        inputs: RefCell::default(),
        errors: RefCell::default(),
    };
    let normalizer = CaptureFs::new(BTreeMap::new(), native_case());
    let mut files = BTreeMap::new();
    let mut bytes = 0_usize;
    for path in inventory {
        let admitted = live
            .direct(&normalizer, path)
            .ok_or("LIVE_INVENTORY_PATH_REFUSED")?;
        let metadata = std::fs::metadata(&admitted).map_err(|error| error.to_string())?;
        if !metadata.is_file() || metadata.len() > 8_388_608 {
            return Err("LIVE_INVENTORY_FILE_INVALID".into());
        }
        let text = bounded_read(&admitted, 8_388_608 - bytes)
            .map_err(|error| format!("LIVE_INVENTORY_READ_FAILED:{error}"))?;
        bytes += text.len();
        if bytes > 8_388_608 {
            return Err("LIVE_INVENTORY_LIMIT".into());
        }
        if files
            .insert(
                admitted.clone(),
                ts_goport::scanner_util::go_string_from_utf8(text.clone()),
            )
            .is_some()
        {
            return Err("LIVE_INVENTORY_DUPLICATE".into());
        }
        live.inputs.borrow_mut().insert(admitted, Some(text));
    }
    let sdk_directory = sdk.map(|_| "/sdk/lib");
    if let Some(sdk) = sdk {
        if !sdk.matches_reference() {
            return Err("LIVE_SDK_IDENTITY_INVALID".into());
        }
        sdk.validate_libraries("/sdk/lib")?;
        files.extend(sdk.files.iter().map(|(path, text)| {
            (
                path.clone(),
                ts_goport::scanner_util::go_string_from_utf8(text.clone()),
            )
        }));
    }
    let mut fs = CaptureFs::with_workspace_root(files, native_case(), &live.root, sdk_directory)
        .with_sdk_keys(
            sdk.into_iter()
                .flat_map(|sdk| sdk.files.keys().map(String::as_str)),
        )?;
    fs.live = Some(live);
    Ok(fs)
}

#[cfg(all(test, unix))]
fn capture(root: &str, inventory: &[String]) -> Result<CaptureFs, String> {
    build(root, inventory, None)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    root: String,
    inventory: Vec<String>,
    queries: Vec<Query>,
    resolution: Option<Resolution>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Query {
    operation: Operation,
    path: String,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum Operation {
    FileExists,
    ReadFile,
    DirectoryExists,
    Realpath,
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
    fn native(self) -> ModuleKind {
        match self {
            Self::Omitted => ModuleKind::NONE,
            Self::Import => ModuleKind::ES_NEXT,
            Self::Require => ModuleKind::COMMON_JS,
        }
    }
}

fn observe(value: serde_json::Value, sdk: Option<&Sdk>) -> Result<serde_json::Value, String> {
    let request: Request =
        serde_json::from_value(value).map_err(|error| format!("LIVE_REQUEST_INVALID:{error}"))?;
    if request.queries.len() > 4096 || (request.queries.is_empty() && request.resolution.is_none())
    {
        return Err("LIVE_QUERY_COUNT_INVALID".into());
    }
    let fs = Rc::new(build(&request.root, &request.inventory, sdk)?);
    let mut unsupported = BTreeSet::<String>::new();
    let results = request
        .queries
        .iter()
        .map(|query| {
            let value = match query.operation {
                Operation::FileExists => serde_json::json!(fs.file_exists(&query.path)),
                Operation::ReadFile => {
                    let (text, found) = fs.read_file(&query.path);
                    serde_json::json!(found.then_some(text))
                }
                Operation::DirectoryExists => serde_json::json!(fs.directory_exists(&query.path)),
                Operation::Realpath => serde_json::json!(fs.realpath(&query.path)),
            };
            serde_json::json!({"operation":query.operation,"path":query.path,"value":value})
        })
        .collect::<Vec<_>>();
    let mut resolved = None;
    let mut native_diagnostics = vec![];
    let mut native_error = None;
    if let Some(query) = &request.resolution {
        if sdk.is_none()
            || !fs
                .live
                .as_ref()
                .unwrap()
                .within(&fs.key(&query.containing_file))
            || query.specifier.is_empty()
        {
            return Err("LIVE_RESOLUTION_INPUT_INVALID".into());
        }
        let (create, observations) =
            configured_resolver::factory(fs.clone(), request.root.clone(), "/sdk/lib".into());
        let resolver = create(ResolverOptions {
            host: Some(Rc::new(tsoptions::ResolverHost {
                fs: fs.clone(),
                current_directory: request.root.clone(),
            })),
            compiler_options: Some(Rc::new(compiler_options())),
            ..Default::default()
        });
        let (found, diagnostics, error) = resolver.resolve_module_name(
            &query.specifier,
            &query.containing_file,
            query.mode.native(),
            None,
        );
        resolved = found
            .filter(|found| !found.resolved_file_name.is_empty())
            .map(|found| found.resolved_file_name.clone());
        native_diagnostics = diagnostics.iter().map(|diagnostic| serde_json::json!({"code":diagnostic.message.code(),"args":diagnostic.args})).collect();
        native_error = error.map(|error| error.to_string());
        if native_error.is_some()
            || !native_diagnostics.is_empty()
            || !observations.borrow().errors.is_empty()
        {
            unsupported.insert("LIVE_NATIVE_RESOLUTION_ERROR".into());
        }
    }
    if let Some(workspace) = &fs.workspace {
        unsupported.extend(workspace.unsupported.borrow().iter().cloned());
    }
    let live = fs.live.as_ref().unwrap();
    Ok(
        serde_json::json!({"executed":true,"unsupported":unsupported,"results":results,"inputs":live.inputs.borrow().clone(),"nativeFsFailures":live.errors.borrow().clone(),"resolved_file_name":resolved,"native_error":native_error,"native_diagnostics":native_diagnostics,"probes":fs.log.borrow().clone(),"status":"test_only_live_observation_not_qualification","global_admission_inferred":false}),
    )
}

pub(super) fn run(value: serde_json::Value, sdk: Option<&Sdk>) -> serde_json::Value {
    match observe(value, sdk) {
        Ok(value) => value,
        Err(error) => {
            serde_json::json!({"executed":false,"unsupported":[error],"results":[],"status":"test_only_live_observation_not_qualification","global_admission_inferred":false})
        }
    }
}

#[cfg(all(test, unix))]
#[path = "../tests/unit/live_system_observations.rs"]
mod tests;
