use super::*;
use crate::configuration::merge_configured_options;
use ts_goport::frontend::module::{self, Resolver, ResolverOptions};

#[path = "legacy_resolution.rs"]
mod legacy_resolution;

#[derive(Default, Serialize)]
pub struct ResolutionObservations {
    pub reasons: BTreeMap<String, Vec<String>>,
    pub consumed: BTreeSet<String>,
    pub errors: BTreeMap<String, String>,
    #[cfg(any(test, feature = "qualification-observer"))]
    pub implied_modes: BTreeMap<String, String>,
    #[cfg(any(test, feature = "qualification-observer"))]
    pub source_acquisition: BTreeMap<String, String>,
}

pub fn factory(
    fs: Rc<CaptureFs>,
    root: String,
    sdk_root: String,
) -> (
    compiler::CreateModuleResolver,
    Rc<RefCell<ResolutionObservations>>,
) {
    let observations = Rc::new(RefCell::new(ResolutionObservations::default()));
    let recorded = observations.clone();
    let create = Rc::new(move |options: ResolverOptions| {
        create_configured(
            fs.clone(),
            root.clone(),
            sdk_root.clone(),
            options,
            recorded.clone(),
        ) as Rc<dyn Resolver>
    });
    (create, observations)
}

fn create_configured(
    fs: Rc<CaptureFs>,
    root: String,
    sdk_root: String,
    mut options: ResolverOptions,
    observations: Rc<RefCell<ResolutionObservations>>,
) -> Rc<ConfiguredResolver> {
    if fs.workspace.is_some()
        && let Some(host) = options.host.take()
    {
        options.host = Some(Rc::new(SourceResolutionHost {
            base: host,
            fs: PhysicalCaptureFs::new(fs.clone()),
        }));
    }
    let base: Rc<dyn Resolver> = Rc::new(module::new_resolver(options.clone()));
    options.package_json_cache = Some(base.get_resolution_data().package_json_info_cache.clone());
    Rc::new(ConfiguredResolver {
        fs,
        root,
        sdk_root,
        template: options,
        base,
        configured: RefCell::new(BTreeMap::new()),
        observations,
    })
}

#[cfg(any(test, feature = "qualification-observer"))]
pub(super) fn configured(
    fs: Rc<CaptureFs>,
    root: String,
    sdk_root: String,
    options: ResolverOptions,
) -> (Rc<ConfiguredResolver>, Rc<RefCell<ResolutionObservations>>) {
    let observations = Rc::new(RefCell::new(ResolutionObservations::default()));
    let resolver = create_configured(fs, root, sdk_root, options, observations.clone());
    (resolver, observations)
}

struct SourceResolutionHost {
    base: Rc<dyn module::ResolutionHost>,
    fs: PhysicalCaptureFs,
}
impl module::ResolutionHost for SourceResolutionHost {
    fn fs(&self) -> &dyn Fs {
        &self.fs
    }
    fn get_current_directory(&self) -> &str {
        self.base.get_current_directory()
    }
}
#[cfg(any(test, feature = "qualification-observer"))]
type AdmissionObserver = Rc<dyn Fn(&str, bool)>;

pub(super) struct PhysicalCaptureFs {
    capture: Rc<CaptureFs>,
    physical: Rc<dyn Fs>,
    configuration: Rc<dyn Fs>,
    #[cfg(any(test, feature = "qualification-observer"))]
    admission_observer: Option<AdmissionObserver>,
}
impl PhysicalCaptureFs {
    fn new(fs: Rc<CaptureFs>) -> Self {
        let file_fs = fs.clone();
        let directory_fs = fs.clone();
        let physical = ts_goport::frontend::vfs::wrapvfs_wrap(
            fs.clone(),
            ts_goport::frontend::vfs::Replacements {
                file_exists: Some(Box::new(move |path| {
                    file_fs.files.contains_key(&file_fs.key(path))
                })),
                directory_exists: Some(Box::new(move |path| {
                    directory_fs.dirs.contains(&directory_fs.key(path))
                })),
                ..Default::default()
            },
        );
        #[cfg(any(test, feature = "qualification-observer"))]
        let physical = if fs.live.is_some() {
            native_physical_fs(fs.clone())
        } else {
            physical
        };
        Self {
            capture: fs.clone(),
            physical,
            configuration: fs,
            #[cfg(any(test, feature = "qualification-observer"))]
            admission_observer: None,
        }
    }
    #[cfg(any(test, feature = "qualification-observer"))]
    pub(super) fn observed(
        fs: Rc<CaptureFs>,
        wrap: impl Fn(&str, Rc<dyn Fs>) -> Rc<dyn Fs>,
        admission_observer: AdmissionObserver,
    ) -> Self {
        let mut host = Self::new(fs);
        host.physical = wrap("physical", host.physical);
        host.configuration = wrap("configuration", host.configuration);
        host.admission_observer = Some(admission_observer);
        host
    }
    fn admitted(&self, path: &str) -> bool {
        #[cfg(any(test, feature = "qualification-observer"))]
        if let Some(live) = self.capture.live_for(path) {
            let contract_paths = CaptureFs::new(BTreeMap::new(), true);
            let admitted = live
                .resolution_root()
                .is_none_or(|root| live_admitted(&contract_paths, root, path));
            if !admitted {
                live.inputs_ledger()
                    .borrow_mut()
                    .insert(contract_paths.key(path), None);
            }
            if let Some(observe) = &self.admission_observer {
                observe(path, admitted);
            }
            return admitted;
        }
        let admitted = self.physical(path).is_some();
        #[cfg(any(test, feature = "qualification-observer"))]
        if let Some(observe) = &self.admission_observer {
            observe(path, admitted);
        }
        admitted
    }
    fn physical_only(&self, _path: &str) -> bool {
        #[cfg(any(test, feature = "qualification-observer"))]
        if let Some(live) = self.capture.live_for(_path) {
            return live.resolution_root().is_none();
        }
        false
    }
    fn physical(&self, path: &str) -> Option<String> {
        #[cfg(any(test, feature = "qualification-observer"))]
        if let Some(live) = self.capture.live_for(path) {
            return live.direct(&self.capture, path);
        }
        let key = self.capture.key(path);
        self.capture.workspace.as_ref().map_or_else(
            || {
                (self.capture.files.contains_key(&key) || self.capture.dirs.contains(&key))
                    .then_some(key.clone())
            },
            |workspace| workspace.physical_path(&self.capture, path),
        )
    }
    fn file(&self, path: &str) -> bool {
        self.admitted(path) && self.physical.file_exists(path)
    }
    fn directory(&self, path: &str) -> bool {
        self.admitted(path) && self.physical.directory_exists(path)
    }
}
impl Fs for PhysicalCaptureFs {
    fn use_case_sensitive_file_names(&self) -> bool {
        self.capture.use_case_sensitive_file_names()
    }
    fn file_exists(&self, path: &str) -> bool {
        if self.physical_only(path) {
            return self.physical.file_exists(path);
        }
        if self.file(path) {
            self.configuration.file_exists(path)
        } else {
            self.capture.record("file_exists", path, false);
            false
        }
    }
    fn read_file(&self, path: &str) -> (String, bool) {
        if self.physical_only(path) {
            return self.physical.read_file(path);
        }
        if self.file(path) {
            self.configuration.read_file(path)
        } else {
            self.capture.record("read_file", path, false);
            (String::new(), false)
        }
    }
    fn directory_exists(&self, path: &str) -> bool {
        if self.physical_only(path) {
            return self.physical.directory_exists(path);
        }
        if self.directory(path) {
            self.configuration.directory_exists(path)
        } else {
            self.capture.record("directory_exists", path, false);
            false
        }
    }
    fn get_accessible_entries(&self, path: &str) -> Entries {
        if self.physical_only(path) {
            return self.physical.get_accessible_entries(path);
        }
        if self.directory(path) {
            self.configuration.get_accessible_entries(path)
        } else {
            self.capture.record("directory_entries", path, false);
            Entries {
                symlinks: Some(Default::default()),
                ..Default::default()
            }
        }
    }
    fn stat(&self, path: &str) -> Option<FileInfo> {
        if self.physical_only(path) {
            return self.physical.stat(path);
        }
        if self.physical(path).is_some() {
            self.configuration.stat(path)
        } else {
            self.capture.record("stat", path, false);
            None
        }
    }
    fn realpath(&self, path: &str) -> String {
        if self.physical_only(path) {
            return self.physical.realpath(path);
        }
        if self.admitted(path)
            && (self.physical.file_exists(path) || self.physical.directory_exists(path))
        {
            self.configuration.realpath(path)
        } else {
            self.capture.record("realpath", path, false);
            path.into()
        }
    }
    fn write_file(&self, path: &str, data: &str) -> Result<(), FsError> {
        self.capture.write_file(path, data)
    }
    fn append_file(&self, path: &str, data: &str) -> Result<(), FsError> {
        self.capture.append_file(path, data)
    }
    fn remove(&self, path: &str) -> Result<(), FsError> {
        self.capture.remove(path)
    }
    fn chtimes(
        &self,
        path: &str,
        access: Option<SystemTime>,
        modified: Option<SystemTime>,
    ) -> Result<(), FsError> {
        self.capture.chtimes(path, access, modified)
    }
}

#[cfg(any(test, feature = "qualification-observer"))]
fn live_admitted(fs: &CaptureFs, root: &str, path: &str) -> bool {
    if !std::path::Path::new(path).is_absolute() {
        return false;
    }
    let within = |root: &str, path: &str| {
        let root = fs.key(&native_paths::compiler_path(root));
        let path = fs.key(&native_paths::compiler_path(path));
        path == root || relative_source_path(&root, &path, fs.sensitive).is_ok()
    };
    within(root, path)
        && captured_confinement::physical(root)
            .and_then(|root| captured_confinement::physical(path).map(|path| (root, path)))
            .is_ok_and(|(root, path)| within(&root.to_string_lossy(), &path.to_string_lossy()))
}

#[cfg(any(test, feature = "qualification-observer"))]
fn native_physical_fs(fs: Rc<CaptureFs>) -> Rc<dyn Fs> {
    use ts_goport::frontend::vfs::{Replacements, osvfs_fs, wrapvfs_wrap};
    let allowed = |fs: &CaptureFs, path: &str| {
        fs.live_for(path)
            .is_some_and(|live| live_admitted(fs, live.sandbox_root(), path))
    };
    let file_fs = fs.clone();
    let directory_fs = fs.clone();
    let read_fs = fs.clone();
    let entries_fs = fs.clone();
    let stat_fs = fs.clone();
    let realpath_fs = fs.clone();
    wrapvfs_wrap(
        fs,
        Replacements {
            file_exists: Some(Box::new(move |path| {
                if file_fs.live_for(path).is_none() {
                    return file_fs.files.contains_key(&file_fs.key(path));
                }
                allowed(&file_fs, path) && osvfs_fs().file_exists(path)
            })),
            directory_exists: Some(Box::new(move |path| {
                if directory_fs.live_for(path).is_none() {
                    return directory_fs.dirs.contains(&directory_fs.key(path));
                }
                allowed(&directory_fs, path) && osvfs_fs().directory_exists(path)
            })),
            read_file: Some(Box::new(move |path| {
                if read_fs.live_for(path).is_none() {
                    return read_fs.read_file(path);
                }
                if !allowed(&read_fs, path) {
                    return (String::new(), false);
                }
                match live_system_observations::bounded_read(path, 8_388_608) {
                    Ok(text) => (ts_goport::scanner_util::go_string_from_utf8(text), true),
                    Err(_) => (String::new(), false),
                }
            })),
            get_accessible_entries: Some(Box::new(move |path| {
                if entries_fs.live_for(path).is_none() {
                    return entries_fs.get_accessible_entries(path);
                }
                if allowed(&entries_fs, path) {
                    osvfs_fs().get_accessible_entries(path)
                } else {
                    Entries::default()
                }
            })),
            stat: Some(Box::new(move |path| {
                if stat_fs.live_for(path).is_none() {
                    return stat_fs.stat(path);
                }
                allowed(&stat_fs, path)
                    .then(|| osvfs_fs().stat(path))
                    .flatten()
            })),
            realpath: Some(Box::new(move |path| {
                if realpath_fs.live_for(path).is_none() {
                    return realpath_fs.realpath(path);
                }
                if allowed(&realpath_fs, path) {
                    osvfs_fs().realpath(path)
                } else {
                    path.into()
                }
            })),
            ..Default::default()
        },
    )
}

#[derive(Clone)]
struct SelectedResolver {
    resolver: Rc<dyn Resolver>,
    reasons: Vec<String>,
    legacy: Option<legacy_resolution::LegacyMode>,
    base_url: Option<String>,
}

impl SelectedResolver {
    #[cfg(any(test, feature = "qualification-observer"))]
    fn native_mode(
        &self,
        fs: &CaptureFs,
        file: &str,
        text: String,
    ) -> Result<ts_goport::options::ResolutionMode, String> {
        let resolver = self
            .resolver
            .as_default_resolver()
            .ok_or("NATIVE_SOURCE_MODE_RESOLVER_UNAVAILABLE")?;
        let ingestion = Rc::new(CaptureFs::new(
            BTreeMap::from([(file.into(), text)]),
            fs.sensitive,
        ));
        let mut options = (*resolver.compiler_options).clone();
        options.no_lib = Tristate::True;
        options.no_resolve = Tristate::True;
        options.types = Some(Vec::new());
        let directory = resolver.host.get_current_directory();
        let config = Rc::new(tsoptions::new_parsed_command_line(
            Rc::new(options),
            vec![file.into()],
            None,
            ComparePathsOptions {
                use_case_sensitive_file_names: fs.sensitive,
                current_directory: directory.into(),
            },
        ));
        let selected = self.resolver.clone();
        let _outside = core::enter_program(None);
        let frontend = native_program::frontend(
            compiler::ProgramOptions {
                host: compiler::new_compiler_host(
                    directory,
                    ingestion.clone(),
                    "/sdk/lib",
                    None,
                    None,
                    None,
                ),
                config,
                use_source_of_project_reference: false,
                single_threaded: Tristate::True,
                typings_location: String::new(),
                project_name: String::new(),
                create_module_resolver: Some(Rc::new(move |_| selected.clone())),
                skip_module_resolution: false,
            },
            &ingestion,
        );
        let _scope = native_program::NativeProgram::enter(&frontend);
        let source = program::get_source_file(file);
        if source.is_nil() {
            return Err("NATIVE_SOURCE_MODE_SOURCE_MISSING".into());
        }
        Ok(program::get_default_resolution_mode_for_file(source))
    }

    fn resolve(
        &self,
        name: &str,
        file: Option<&str>,
        directory: &str,
        mode: ts_goport::options::ResolutionMode,
        redirected: Option<&dyn module::ModuleResolvedProjectReference>,
    ) -> (
        Option<std::sync::Arc<program::ResolvedModule>>,
        Vec<module::DiagAndArgs>,
        Option<ts_goport::gostd::GoError>,
    ) {
        if let Some(legacy) = self.legacy {
            let Some(resolver) = self.resolver.as_default_resolver() else {
                return (
                    None,
                    Vec::new(),
                    Some(ts_goport::gostd::errors::new(
                        "NATIVE_LEGACY_RESOLVER_API_UNAVAILABLE",
                    )),
                );
            };
            return match legacy_resolution::resolve(
                resolver,
                legacy,
                name,
                directory,
                mode,
                redirected,
                self.base_url.as_deref(),
            ) {
                Ok(found) => (Some(std::sync::Arc::new(found)), Vec::new(), None),
                Err(error) => (None, Vec::new(), Some(ts_goport::gostd::errors::new(error))),
            };
        }
        if let Some(resolver) = self.resolver.as_default_resolver() {
            return match legacy_resolution::resolve_modern(
                resolver,
                name,
                directory,
                mode,
                redirected,
                self.base_url.as_deref(),
            ) {
                Ok(found) => (Some(std::sync::Arc::new(found)), Vec::new(), None),
                Err(error) => (None, Vec::new(), Some(ts_goport::gostd::errors::new(error))),
            };
        }
        match file {
            Some(file) => self
                .resolver
                .resolve_module_name(name, file, mode, redirected),
            None => self
                .resolver
                .resolve_module_name_from_directory(name, directory, mode),
        }
    }
}

pub(super) struct ConfiguredResolver {
    fs: Rc<CaptureFs>,
    root: String,
    sdk_root: String,
    template: ResolverOptions,
    base: Rc<dyn Resolver>,
    configured: RefCell<BTreeMap<String, Result<SelectedResolver, String>>>,
    observations: Rc<RefCell<ResolutionObservations>>,
}

fn sdk59_resolution_kind(
    options: &CompilerOptions,
    configuration: &crate::configuration::Configuration,
) -> ModuleResolutionKind {
    if options.module_resolution != ModuleResolutionKind::UNKNOWN {
        return options.module_resolution;
    }
    let explicit_none = configuration.raw_chain.iter().filter_map(|(_, raw)| {
        let tsoptions::CompilerOptionsValue::Map(raw) = raw else { return None; };
        let Some(tsoptions::CompilerOptionsValue::Map(values)) = raw.get("compilerOptions") else { return None; };
        values.get("module")
    }).next_back().is_some_and(|value| matches!(value, tsoptions::CompilerOptionsValue::String(value) if value.eq_ignore_ascii_case("none")));
    let module = if options.module != ModuleKind::NONE || explicit_none {
        options.module
    } else if options.target.0 >= ScriptTarget::ES2015.0 {
        ModuleKind::ES2015
    } else {
        ModuleKind::COMMON_JS
    };
    match module {
        ModuleKind::COMMON_JS => ModuleResolutionKind::NODE10,
        ModuleKind::NODE16 | ModuleKind::NODE18 | ModuleKind::NODE20 => {
            ModuleResolutionKind::NODE16
        }
        ModuleKind::NODE_NEXT => ModuleResolutionKind::NODE_NEXT,
        ModuleKind::PRESERVE => ModuleResolutionKind::BUNDLER,
        _ => ModuleResolutionKind::CLASSIC,
    }
}

impl ConfiguredResolver {
    #[cfg(any(test, feature = "qualification-observer"))]
    fn ingest_mode_source(&self, file: &str) -> Result<String, String> {
        let Some(live) = self.fs.live_for(file) else {
            return self
                .fs
                .files
                .get(&self.fs.key(file))
                .cloned()
                .ok_or("SOURCE_SNAPSHOT_MISSING".into());
        };
        if !live_admitted(&self.fs, live.sandbox_root(), file) {
            return Err("LIVE_SOURCE_INGESTION_OUTSIDE_SANDBOX".into());
        }
        let text = live_system_observations::bounded_read(file, 8_388_608)
            .map_err(|error| format!("LIVE_SOURCE_INGESTION_FAILED:{error}"))?;
        Ok(ts_goport::scanner_util::go_string_from_utf8(text))
    }

    #[cfg(any(test, feature = "qualification-observer"))]
    pub(super) fn resolve_configured_module(
        &self,
        name: &str,
        file: &str,
        mode: Option<ts_goport::options::ResolutionMode>,
    ) -> (
        Option<std::sync::Arc<program::ResolvedModule>>,
        Vec<module::DiagAndArgs>,
        Option<ts_goport::gostd::GoError>,
    ) {
        let Some(mode) = mode else {
            let mode = self.for_file(file).and_then(|selected| {
                let text = self.ingest_mode_source(file)?;
                self.observations
                    .borrow_mut()
                    .source_acquisition
                    .insert(file.into(), identity::digest_bytes(text.as_bytes()));
                selected.native_mode(&self.fs, file, text)
            });
            return match mode {
                Ok(mode) => {
                    let label = match mode {
                        ModuleKind::ES_NEXT => "import",
                        ModuleKind::COMMON_JS => "require",
                        _ => "omitted",
                    };
                    self.observations
                        .borrow_mut()
                        .implied_modes
                        .insert(file.into(), label.into());
                    self.resolve_module_name(name, file, mode, None)
                }
                Err(error) => {
                    self.observations
                        .borrow_mut()
                        .errors
                        .insert(file.into(), error.clone());
                    (None, Vec::new(), Some(ts_goport::gostd::errors::new(error)))
                }
            };
        };
        self.resolve_module_name(name, file, mode, None)
    }

    fn contained(&self, root: &str, path: &str) -> bool {
        let root = self.fs.key(root);
        let path = self.fs.key(path);
        path == root || path.starts_with(&format!("{root}/"))
    }

    fn for_file(&self, path: &str) -> Result<SelectedResolver, String> {
        let directory = ts_goport::frontend::tspath::get_directory_path(path);
        self.for_directory(&directory, path)
    }

    fn for_directory(&self, directory: &str, subject: &str) -> Result<SelectedResolver, String> {
        if !self.contained(&self.root, directory) && self.contained(&self.sdk_root, directory) {
            return Ok(SelectedResolver {
                resolver: self.base.clone(),
                reasons: Vec::new(),
                legacy: None,
                base_url: None,
            });
        }
        let key = self.fs.key(directory);
        let cached = self.configured.borrow().get(&key).cloned();
        let selected = cached.unwrap_or_else(|| {
            let configuration = crate::configuration::inspect(
                self.fs.clone(),
                &format!("{directory}/__semctx_configuration_context__.ts"),
                &self.root,
            );
            #[cfg(any(test, feature = "qualification-observer"))]
            let configuration = configuration.or_else(|error| {
                if self.fs.live_for(directory).is_some()
                    && error == "configuration disappeared from capture"
                {
                    Ok(crate::configuration::Configuration {
                        options: Rc::new(CompilerOptions::default()),
                        raw: None,
                        raw_chain: vec![],
                        reasons: vec![],
                        consumed: BTreeSet::new(),
                    })
                } else {
                    Err(error)
                }
            });
            let inspected = configuration.map(|configuration| {
                self.observations
                    .borrow_mut()
                    .consumed
                    .extend(configuration.consumed.iter().cloned());
                let (mut merged, additional_reasons) = merge_configured_options(
                    self.template.compiler_options.as_ref().unwrap(),
                    &configuration,
                );
                let requested_resolution = sdk59_resolution_kind(&merged, &configuration);
                let base_url = legacy_resolution::base_url(&configuration);
                if let Some(base_url) = &base_url {
                    merged.paths_base_path = base_url.clone();
                }
                let mut options = self.template.clone();
                options.compiler_options = Some(Rc::new(merged));
                let legacy = match requested_resolution {
                    ModuleResolutionKind::CLASSIC => Some(legacy_resolution::LegacyMode::Classic),
                    ModuleResolutionKind::NODE10 => Some(legacy_resolution::LegacyMode::Node10),
                    _ => None,
                };
                let mut reasons: BTreeSet<String> = configuration.reasons.into_iter().collect();
                reasons.extend(additional_reasons);
                SelectedResolver {
                    resolver: Rc::new(module::new_resolver(options)),
                    reasons: reasons.into_iter().collect(),
                    legacy,
                    base_url,
                }
            });
            self.configured.borrow_mut().insert(key, inspected.clone());
            inspected
        });
        match selected {
            Ok(selected) => {
                self.observations
                    .borrow_mut()
                    .reasons
                    .insert(subject.into(), selected.reasons.clone());
                Ok(selected)
            }
            Err(error) => {
                self.observations
                    .borrow_mut()
                    .errors
                    .insert(subject.into(), error.clone());
                Err(error)
            }
        }
    }
}

impl Resolver for ConfiguredResolver {
    fn resolve_module_name(
        &self,
        module_name: &str,
        containing_file: &str,
        resolution_mode: ts_goport::options::ResolutionMode,
        redirected_reference: Option<&dyn module::ModuleResolvedProjectReference>,
    ) -> (
        Option<std::sync::Arc<program::ResolvedModule>>,
        Vec<module::DiagAndArgs>,
        Option<ts_goport::gostd::GoError>,
    ) {
        match self.for_file(containing_file) {
            Ok(resolver) => {
                let result = resolver.resolve(
                    module_name,
                    Some(containing_file),
                    &ts_goport::frontend::tspath::get_directory_path(containing_file),
                    resolution_mode,
                    redirected_reference,
                );
                if let Some(error) = &result.2 {
                    self.observations
                        .borrow_mut()
                        .errors
                        .insert(containing_file.into(), error.to_string());
                }
                result
            }
            Err(error) => (None, Vec::new(), Some(ts_goport::gostd::errors::new(error))),
        }
    }

    fn resolve_module_name_from_directory(
        &self,
        module_name: &str,
        containing_directory: &str,
        resolution_mode: ts_goport::options::ResolutionMode,
    ) -> (
        Option<std::sync::Arc<program::ResolvedModule>>,
        Vec<module::DiagAndArgs>,
        Option<ts_goport::gostd::GoError>,
    ) {
        match self.for_directory(containing_directory, containing_directory) {
            Ok(resolver) => {
                let result = resolver.resolve(
                    module_name,
                    None,
                    containing_directory,
                    resolution_mode,
                    None,
                );
                if let Some(error) = &result.2 {
                    self.observations
                        .borrow_mut()
                        .errors
                        .insert(containing_directory.into(), error.to_string());
                }
                result
            }
            Err(error) => (None, Vec::new(), Some(ts_goport::gostd::errors::new(error))),
        }
    }

    fn resolve_type_reference_directive(
        &self,
        name: &str,
        containing_file: &str,
        resolution_mode: ts_goport::options::ResolutionMode,
        redirected_reference: Option<&dyn module::ModuleResolvedProjectReference>,
    ) -> (
        Rc<module::ResolvedTypeReferenceDirective>,
        Vec<module::DiagAndArgs>,
    ) {
        if let Some(resolver) = self.base.as_default_resolver() {
            return match legacy_resolution::type_reference(
                resolver,
                name,
                containing_file,
                resolution_mode,
                redirected_reference,
            ) {
                Ok(found) => (Rc::new(found), Vec::new()),
                Err(error) => {
                    self.observations
                        .borrow_mut()
                        .errors
                        .insert(containing_file.into(), error);
                    (
                        Rc::new(module::ResolvedTypeReferenceDirective::default()),
                        Vec::new(),
                    )
                }
            };
        }
        self.base.resolve_type_reference_directive(
            name,
            containing_file,
            resolution_mode,
            redirected_reference,
        )
    }

    fn get_resolution_data(&self) -> Rc<module::ResolutionData> {
        self.base.get_resolution_data()
    }

    fn get_package_scope_for_path(
        &self,
        directory: &str,
    ) -> Option<Rc<ts_goport::frontend::packagejson::InfoCacheEntry>> {
        self.base.get_package_scope_for_path(directory)
    }

    fn package_json_cache_entries(
        &self,
        f: &mut dyn FnMut(
            &ts_goport::frontend::tspath::Path,
            module::PackageJsonCacheEntry<'_>,
        ) -> bool,
    ) {
        self.base.package_json_cache_entries(f);
    }

    fn resolve_package_directory(
        &self,
        module_name: &str,
        containing_file: &str,
        resolution_mode: ts_goport::options::ResolutionMode,
        redirected_reference: Option<&dyn module::ModuleResolvedProjectReference>,
    ) -> Option<program::ResolvedModule> {
        self.for_file(containing_file)
            .ok()?
            .resolver
            .resolve_package_directory(
                module_name,
                containing_file,
                resolution_mode,
                redirected_reference,
            )
    }

    fn release_caches(&self) {
        for selected in self
            .configured
            .borrow()
            .values()
            .filter_map(|result| result.as_ref().ok())
        {
            selected.resolver.release_caches();
        }
        self.base.release_caches();
    }
}

#[cfg(test)]
#[path = "../tests/unit/configured_resolver.rs"]
mod tests;
