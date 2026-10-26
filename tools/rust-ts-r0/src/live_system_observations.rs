use super::*;
use std::path::Path;
use ts_goport::frontend::module::ResolverOptions;

pub(super) struct LiveBoundary {
    root: String,
    repository_root: Option<String>,
    workspace_root: RefCell<Option<String>>,
    inputs: Rc<RefCell<BTreeMap<String, Option<String>>>>,
    acquisition: BTreeMap<String, String>,
    errors: RefCell<Vec<serde_json::Value>>,
}
impl LiveBoundary {
    pub(super) fn inputs_ledger(&self) -> Rc<RefCell<BTreeMap<String, Option<String>>>> {
        self.inputs.clone()
    }
    pub(super) fn resolution_root(&self) -> Option<&str> {
        self.repository_root.as_deref()
    }
    pub(super) fn sandbox_root(&self) -> &str {
        &self.root
    }
    pub(super) fn workspace_boundary(&self) -> &str {
        self.repository_root.as_deref().unwrap_or(&self.root)
    }
    pub(super) fn observe_workspace_root(&self, root: &str) {
        if self.workspace_root.borrow().is_none() {
            *self.workspace_root.borrow_mut() = Some(root.into());
        }
    }
    fn contains(root: &str, path: &str) -> bool {
        let (root, path) = if native_case() {
            (root.to_string(), path.to_string())
        } else {
            (root.to_lowercase(), path.to_lowercase())
        };
        root == "/" || path == root || path.starts_with(&format!("{root}/"))
    }
    fn lexical_contains(root: &str, path: &str) -> bool {
        root == "/" || path == root || path.starts_with(&format!("{root}/"))
    }
    fn within(&self, path: &str) -> bool {
        Self::contains(&self.root, path)
    }
    fn lexical(path: &str) -> String {
        CaptureFs::new(BTreeMap::new(), true).key(path)
    }
    fn failure(&self, path: &str, reason: &str) {
        self.errors
            .borrow_mut()
            .push(serde_json::json!({"path":path,"reason":reason}));
    }
    fn refused(&self, path: &str, reason: &str) {
        self.inputs.borrow_mut().insert(path.into(), None);
        self.failure(path, reason);
    }
    fn sandbox_admits(&self, path: &str) -> bool {
        Path::new(path).is_absolute()
            && self.within(&Self::lexical(path))
            && captured_confinement::physical(path)
                .is_ok_and(|actual| self.within(&actual.to_string_lossy()))
    }
    pub(super) fn entry_exists(&self, path: &str) -> bool {
        self.within(&Self::lexical(path)) && std::fs::symlink_metadata(path).is_ok()
    }
    pub(super) fn nested_directory(&self, root: &str, path: &str) -> bool {
        let mut directory = Some(Path::new(path));
        while let Some(current) = directory {
            let text = current.to_string_lossy();
            if !Self::contains(root, &text) || Self::contains(&text, root) {
                return false;
            }
            if self.entry_exists(&format!("{text}/.git")) {
                return true;
            }
            directory = current.parent();
        }
        false
    }
    fn allowed_direct(&self, path: &str) -> bool {
        let key = Self::lexical(path);
        if !Path::new(path).is_absolute() || !self.within(&key) {
            self.refused(&key, "LIVE_SANDBOX_ESCAPE_OR_UNAVAILABLE");
            return false;
        }
        match captured_confinement::physical(path) {
            Ok(actual) if self.within(&actual.to_string_lossy()) => {}
            Ok(_) => {
                self.refused(&key, "LIVE_SANDBOX_ESCAPE_OR_UNAVAILABLE");
                return false;
            }
            Err(error) => {
                self.refused(&key, &format!("LIVE_CANONICAL_FAILED:{error}"));
                return false;
            }
        }
        let inferred = self.workspace_root.borrow();
        let Some(root) = self.repository_root.as_deref().or(inferred.as_deref()) else {
            return true;
        };
        if !Self::lexical_contains(root, &key) {
            self.refused(&key, "LIVE_PATH_OUTSIDE_OR_NESTED");
            return false;
        }
        let metadata = std::fs::metadata(path);
        if Path::new(&key).strip_prefix(root).is_ok_and(|relative| {
            relative
                .components()
                .any(|part| part.as_os_str() == "node_modules")
        }) && !metadata
            .as_ref()
            .is_ok_and(|value| value.is_file() || value.is_dir())
        {
            return true;
        }
        let admitted = std::fs::canonicalize(path).and_then(|actual| {
            let actual_root = std::fs::canonicalize(root)?;
            let parent = Path::new(&key)
                .parent()
                .unwrap_or(Path::new(root))
                .to_string_lossy();
            let actual_parent = actual.parent().unwrap_or(&actual).to_string_lossy();
            Ok(
                Self::contains(&actual_root.to_string_lossy(), &actual.to_string_lossy())
                    && !self.nested_directory(root, &parent)
                    && !self.nested_directory(&actual_root.to_string_lossy(), &actual_parent),
            )
        });
        match admitted {
            Ok(true) => true,
            Ok(false) => {
                self.refused(&key, "LIVE_CANONICAL_ESCAPE_OR_NESTED");
                false
            }
            Err(error) => {
                self.refused(&key, &format!("LIVE_CANONICAL_FAILED:{error}"));
                false
            }
        }
    }
    pub(super) fn direct(&self, _fs: &CaptureFs, path: &str) -> Option<String> {
        (self.allowed_direct(path) && std::fs::metadata(path).is_ok()).then(|| Self::lexical(path))
    }
    fn confined_synthetic(&self, member: &str, target: &str) -> bool {
        let target = Self::lexical(target);
        if !Self::lexical_contains(member, &target)
            || !self.sandbox_admits(&target)
            || self
                .repository_root
                .as_deref()
                .is_some_and(|root| !Self::lexical_contains(root, &target))
        {
            return false;
        }
        let mut current = Some(Path::new(&target));
        while let Some(path) = current {
            let Ok(metadata) = std::fs::symlink_metadata(path) else {
                return false;
            };
            if metadata.file_type().is_symlink() {
                return false;
            }
            let text = path.to_string_lossy();
            if metadata.is_dir()
                && text != member
                && Self::contains(member, &text)
                && self.entry_exists(&format!("{text}/.git"))
            {
                return false;
            }
            if Self::contains(&text, &self.root) {
                break;
            }
            current = path.parent();
        }
        true
    }
    fn linked(&self, fs: &CaptureFs, path: &str) -> Option<String> {
        let (member, target) = fs.workspace.as_ref()?.live_target(fs, path)?;
        if self.confined_synthetic(&member, &target) {
            return Some(target);
        }
        self.refused(&target, "LIVE_SYNTHETIC_TARGET_REFUSED");
        None
    }
    fn record_read(&self, fs: &CaptureFs, path: &str, content: Option<String>) -> (String, bool) {
        self.inputs
            .borrow_mut()
            .insert(path.into(), content.clone());
        fs.record("read_file", path, content.is_some());
        fs.log.borrow_mut().last_mut().unwrap().content_id = content
            .as_ref()
            .map(|text| identity::digest_bytes(text.as_bytes()));
        (content.clone().unwrap_or_default(), content.is_some())
    }
    fn read_native(&self, path: &str) -> Option<String> {
        match bounded_read(path, 8_388_608) {
            Ok(text) => Some(ts_goport::scanner_util::go_string_from_utf8(text)),
            Err(error) => {
                self.failure(path, &format!("LIVE_READ_FAILED:{error}"));
                None
            }
        }
    }
    pub(super) fn metadata_read(&self, fs: &CaptureFs, path: &str) -> (String, bool) {
        let key = Self::lexical(path);
        let parent = Path::new(&key)
            .parent()
            .unwrap_or(Path::new(&self.root))
            .to_string_lossy();
        let content = self
            .confined_synthetic(&parent, &key)
            .then(|| self.read_native(&key))
            .flatten();
        self.record_read(fs, &key, content)
    }
    pub(super) fn package_manifests(&self, root: &str) -> Result<Vec<String>, String> {
        let mut pending = vec![root.to_string()];
        let mut files = vec![];
        let mut visited = 0;
        while let Some(directory) = pending.pop() {
            if !self.sandbox_admits(&directory) {
                return Err("LIVE_METADATA_DIRECTORY_REFUSED".into());
            }
            let entries = std::fs::read_dir(&directory)
                .map_err(|error| format!("LIVE_METADATA_DIRECTORY_FAILED:{error}"))?;
            for entry in entries {
                visited += 1;
                if visited > 20_000 {
                    return Err("LIVE_METADATA_ENTRY_LIMIT".into());
                }
                let entry = entry.map_err(|error| format!("LIVE_METADATA_ENTRY_FAILED:{error}"))?;
                let path = entry.path();
                let metadata = entry
                    .file_type()
                    .map_err(|error| format!("LIVE_METADATA_TYPE_FAILED:{error}"))?;
                if metadata.is_symlink() {
                    continue;
                }
                if metadata.is_dir()
                    && (entry.file_name() == "node_modules"
                        || entry.file_name() == ".git"
                        || self.entry_exists(&path.join(".git").to_string_lossy()))
                {
                    continue;
                }
                if metadata.is_dir() {
                    pending.push(path.to_string_lossy().into_owned());
                    continue;
                }
                if metadata.is_file() && entry.file_name() == "package.json" {
                    files.push(path.to_string_lossy().into_owned());
                }
            }
        }
        files.sort();
        Ok(files)
    }
    pub(super) fn directory_present(&self, path: &str) -> Option<bool> {
        if !Path::new(path).is_absolute() || !self.within(&Self::lexical(path)) {
            return None;
        }
        match std::fs::metadata(path) {
            Ok(metadata) => Some(metadata.is_dir()),
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
                ) =>
            {
                Some(false)
            }
            Err(error) => {
                self.failure(path, &format!("LIVE_INSTALLED_STAT_FAILED:{error}"));
                None
            }
        }
    }
    pub(super) fn file_exists(&self, fs: &CaptureFs, path: &str) -> bool {
        let key = Self::lexical(path);
        let closest = self
            .repository_root
            .as_deref()
            .is_some_and(|root| Self::lexical_contains(root, &key))
            && self.within(&key)
            && path.ends_with("/tsconfig.json")
            && std::fs::metadata(path).is_ok_and(|metadata| metadata.is_file());
        let found = closest
            || (self.allowed_direct(path)
                && (std::fs::metadata(path).is_ok_and(|metadata| metadata.is_file())
                    || self.linked(fs, path).is_some_and(|target| {
                        std::fs::metadata(target).is_ok_and(|metadata| metadata.is_file())
                    })));
        fs.record("file_exists", &key, found);
        found
    }
    pub(super) fn read_file(&self, fs: &CaptureFs, path: &str) -> (String, bool) {
        let key = Self::lexical(path);
        let target = if !self.allowed_direct(path) {
            None
        } else if std::fs::metadata(path).is_ok_and(|metadata| metadata.is_file()) {
            Some(key.clone())
        } else {
            self.linked(fs, path)
        };
        let content = target.as_ref().and_then(|path| self.read_native(path));
        self.record_read(fs, target.as_deref().unwrap_or(&key), content)
    }
    pub(super) fn directory_exists(&self, fs: &CaptureFs, path: &str) -> bool {
        let found = self.allowed_direct(path)
            && (std::fs::metadata(path).is_ok_and(|metadata| metadata.is_dir())
                || if path.ends_with("/node_modules") {
                    fs.workspace
                        .as_ref()
                        .is_some_and(|workspace| workspace.live_node_modules(fs, path))
                } else {
                    self.linked(fs, path).is_some_and(|target| {
                        std::fs::metadata(target).is_ok_and(|metadata| metadata.is_dir())
                    })
                });
        fs.record("directory_exists", path, found);
        found
    }
    pub(super) fn realpath(&self, fs: &CaptureFs, path: &str) -> String {
        if !self.allowed_direct(path) {
            fs.record("realpath", path, false);
            return path.into();
        }
        let installed =
            std::fs::metadata(path).is_ok_and(|metadata| metadata.is_file() || metadata.is_dir());
        let target = if installed {
            None
        } else {
            self.linked(fs, path)
        };
        let resolved = target.as_deref().unwrap_or(path);
        let actual = std::fs::canonicalize(resolved)
            .ok()
            .map(|path| path.to_string_lossy().into_owned());
        fs.record("realpath", resolved, actual.is_some());
        actual.unwrap_or_else(|| resolved.into())
    }
}

pub(super) fn bounded_read(path: &str, limit: usize) -> Result<String, String> {
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

pub(super) fn build(
    root: &str,
    inventory: &[String],
    sdk: Option<&Sdk>,
) -> Result<CaptureFs, String> {
    build_with_repository_root(root, inventory, sdk, Some(root))
}

pub(super) fn build_with_repository_root(
    root: &str,
    inventory: &[String],
    sdk: Option<&Sdk>,
    repository_root: Option<&str>,
) -> Result<CaptureFs, String> {
    if !Path::new(root).is_absolute() || inventory.len() > 4096 {
        return Err("LIVE_INVENTORY_INVALID".into());
    }
    let root =
        std::fs::canonicalize(root).map_err(|error| format!("LIVE_ROOT_UNAVAILABLE:{error}"))?;
    if !root.is_dir() {
        return Err("LIVE_ROOT_NOT_DIRECTORY".into());
    }
    let root = root.to_string_lossy().into_owned();
    let repository_root = repository_root.map(LiveBoundary::lexical);
    if repository_root
        .as_ref()
        .is_some_and(|boundary| !LiveBoundary::contains(&root, boundary))
    {
        return Err("LIVE_REPOSITORY_BOUNDARY_OUTSIDE_SANDBOX".into());
    }
    let mut live = LiveBoundary {
        root,
        repository_root,
        workspace_root: RefCell::default(),
        inputs: Rc::default(),
        acquisition: BTreeMap::new(),
        errors: RefCell::default(),
    };
    let mut files = BTreeMap::new();
    let mut bytes = 0_usize;
    for path in inventory {
        let admitted = live
            .sandbox_admits(path)
            .then(|| LiveBoundary::lexical(path))
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
        live.acquisition
            .insert(admitted, identity::digest_bytes(text.as_bytes()));
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
    #[serde(default)]
    inventory: Vec<String>,
    #[serde(default)]
    repository_root: RepositoryBoundary,
    queries: Vec<Query>,
    resolution: Option<Resolution>,
}
#[derive(Default)]
enum RepositoryBoundary {
    #[default]
    Sandbox,
    Explicit(Option<String>),
}
impl<'de> Deserialize<'de> for RepositoryBoundary {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Option::<String>::deserialize(deserializer).map(Self::Explicit)
    }
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
    fn native(self) -> Option<ModuleKind> {
        match self {
            Self::Omitted => None,
            Self::Import => Some(ModuleKind::ES_NEXT),
            Self::Require => Some(ModuleKind::COMMON_JS),
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
    let boundary = match &request.repository_root {
        RepositoryBoundary::Sandbox => Some(request.root.as_str()),
        RepositoryBoundary::Explicit(root) => root.as_deref(),
    };
    let fs = Rc::new(build_with_repository_root(
        &request.root,
        &request.inventory,
        sdk,
        boundary,
    )?);
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
    let mut resolution_observations = serde_json::Value::Null;
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
        let (resolver, observations) = configured_resolver::configured(
            fs.clone(),
            request.root.clone(),
            "/sdk/lib".into(),
            ResolverOptions {
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
        native_diagnostics = diagnostics.iter().map(|diagnostic| serde_json::json!({"code":diagnostic.message.code(),"args":diagnostic.args})).collect();
        native_error = error.map(|error| error.to_string());
        if native_error.is_some()
            || !native_diagnostics.is_empty()
            || !observations.borrow().errors.is_empty()
        {
            unsupported.insert("LIVE_NATIVE_RESOLUTION_ERROR".into());
        }
        resolution_observations =
            serde_json::to_value(&*observations.borrow()).map_err(|error| error.to_string())?;
    }
    if let Some(workspace) = &fs.workspace {
        unsupported.extend(workspace.unsupported.borrow().iter().cloned());
    }
    let live = fs.live.as_ref().unwrap();
    Ok(
        serde_json::json!({"executed":true,"unsupported":unsupported,"results":results,"inputs":live.inputs.borrow().clone(),"acquisition_reads":live.acquisition,"nativeFsFailures":live.errors.borrow().clone(),"resolved_file_name":resolved,"native_error":native_error,"native_diagnostics":native_diagnostics,"resolutionObservations":resolution_observations,"probes":fs.log.borrow().clone(),"status":"test_only_live_observation_not_qualification","global_admission_inferred":false}),
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

#[cfg(all(test, unix))]
#[path = "../tests/unit/live_system_inputs.rs"]
mod inputs_tests;
