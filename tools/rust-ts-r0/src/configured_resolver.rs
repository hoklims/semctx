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
    let create = Rc::new(move |mut options: ResolverOptions| {
        if fs.workspace.is_some()
            && let Some(host) = options.host.take()
        {
            options.host = Some(Rc::new(SourceResolutionHost {
                base: host,
                fs: PhysicalCaptureFs(fs.clone()),
            }));
        }
        let base: Rc<dyn Resolver> = Rc::new(module::new_resolver(options.clone()));
        options.package_json_cache =
            Some(base.get_resolution_data().package_json_info_cache.clone());
        Rc::new(ConfiguredResolver {
            fs: fs.clone(),
            root: root.clone(),
            sdk_root: sdk_root.clone(),
            template: options,
            base,
            configured: RefCell::new(BTreeMap::new()),
            observations: recorded.clone(),
        }) as Rc<dyn Resolver>
    });
    (create, observations)
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
struct PhysicalCaptureFs(Rc<CaptureFs>);
impl PhysicalCaptureFs {
    fn physical(&self, path: &str) -> Option<String> {
        let key = self.0.key(path);
        self.0.workspace.as_ref().map_or_else(
            || {
                (self.0.files.contains_key(&key) || self.0.dirs.contains(&key))
                    .then_some(key.clone())
            },
            |workspace| workspace.physical_path(&self.0, path),
        )
    }
    fn file(&self, path: &str) -> bool {
        self.physical(path)
            .is_some_and(|key| self.0.files.contains_key(&key))
    }
    fn directory(&self, path: &str) -> bool {
        self.physical(path)
            .is_some_and(|key| self.0.dirs.contains(&key))
    }
}
impl Fs for PhysicalCaptureFs {
    fn use_case_sensitive_file_names(&self) -> bool {
        self.0.use_case_sensitive_file_names()
    }
    fn file_exists(&self, path: &str) -> bool {
        if self.file(path) {
            self.0.file_exists(path)
        } else {
            self.0.record("file_exists", path, false);
            false
        }
    }
    fn read_file(&self, path: &str) -> (String, bool) {
        if self.file(path) {
            self.0.read_file(path)
        } else {
            self.0.record("read_file", path, false);
            (String::new(), false)
        }
    }
    fn directory_exists(&self, path: &str) -> bool {
        if self.directory(path) {
            self.0.directory_exists(path)
        } else {
            self.0.record("directory_exists", path, false);
            false
        }
    }
    fn get_accessible_entries(&self, path: &str) -> Entries {
        if self.directory(path) {
            self.0.get_accessible_entries(path)
        } else {
            self.0.record("directory_entries", path, false);
            Entries {
                symlinks: Some(Default::default()),
                ..Default::default()
            }
        }
    }
    fn stat(&self, path: &str) -> Option<FileInfo> {
        if self.physical(path).is_some() {
            self.0.stat(path)
        } else {
            self.0.record("stat", path, false);
            None
        }
    }
    fn realpath(&self, path: &str) -> String {
        if self.physical(path).is_some() {
            self.0.realpath(path)
        } else {
            self.0.record("realpath", path, false);
            path.into()
        }
    }
    fn write_file(&self, path: &str, data: &str) -> Result<(), FsError> {
        self.0.write_file(path, data)
    }
    fn append_file(&self, path: &str, data: &str) -> Result<(), FsError> {
        self.0.append_file(path, data)
    }
    fn remove(&self, path: &str) -> Result<(), FsError> {
        self.0.remove(path)
    }
    fn chtimes(
        &self,
        path: &str,
        access: Option<SystemTime>,
        modified: Option<SystemTime>,
    ) -> Result<(), FsError> {
        self.0.chtimes(path, access, modified)
    }
}

#[derive(Clone)]
struct SelectedResolver {
    resolver: Rc<dyn Resolver>,
    reasons: Vec<String>,
    legacy: Option<legacy_resolution::LegacyMode>,
    base_url: Option<String>,
}

impl SelectedResolver {
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

struct ConfiguredResolver {
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
            let inspected = crate::configuration::inspect(
                self.fs.clone(),
                &format!("{directory}/__semctx_configuration_context__.ts"),
                &self.root,
            )
            .map(|configuration| {
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
