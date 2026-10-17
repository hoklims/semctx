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
mod tests {
    use super::*;

    struct DevelopmentHost(Rc<CaptureFs>);

    impl module::ResolutionHost for DevelopmentHost {
        fn fs(&self) -> &dyn Fs {
            self.0.as_ref()
        }
        fn get_current_directory(&self) -> &str {
            "/repo"
        }
    }

    fn development_resolver(
        files: BTreeMap<String, String>,
    ) -> (
        Rc<dyn Resolver>,
        Rc<RefCell<ResolutionObservations>>,
        Rc<CaptureFs>,
    ) {
        eprintln!(
            "configured_resolver_dev_input={}",
            serde_json::to_string(&files).unwrap()
        );
        let fs = Rc::new(CaptureFs::new(files, true));
        let (create, observations) = factory(fs.clone(), "/repo".into(), "/sdk/lib".into());
        let resolver = create(ResolverOptions {
            host: Some(Rc::new(DevelopmentHost(fs.clone()))),
            compiler_options: Some(Rc::new(CompilerOptions {
                target: ScriptTarget::ES2022,
                module: ModuleKind::ES_NEXT,
                module_resolution: ModuleResolutionKind::BUNDLER,
                allow_js: Tristate::True,
                jsx: JsxEmit::PRESERVE,
                skip_lib_check: Tristate::True,
                no_emit: Tristate::True,
                strict: Tristate::False,
                ..Default::default()
            })),
            ..Default::default()
        });
        (resolver, observations, fs)
    }

    #[test]
    fn development_factory_uses_sdk59_node10_classic_and_null_effective_modes() {
        let files = BTreeMap::from([
            ("/repo/t00DevelopmentLegacyFactoryY/node/tsconfig.json".into(), "{\"compilerOptions\":{\"module\":\"none\",\"moduleResolution\":\"node10\"}}".into()),
            ("/repo/t00DevelopmentLegacyFactoryY/classic/tsconfig.json".into(), "{\"compilerOptions\":{\"module\":\"none\",\"moduleResolution\":\"classic\"}}".into()),
            ("/repo/t00DevelopmentLegacyFactoryY/null/tsconfig.json".into(), "{\"compilerOptions\":{\"module\":\"none\",\"moduleResolution\":null}}".into()),
            ("/repo/t00DevelopmentLegacyFactoryY/common/tsconfig.json".into(), "{\"extends\":\"../t00DevelopmentNullFoundationY.json\",\"compilerOptions\":{\"module\":\"commonjs\",\"moduleResolution\":null}}".into()),
            ("/repo/t00DevelopmentLegacyFactoryY/t00DevelopmentNullFoundationY.json".into(), "{\"compilerOptions\":{\"moduleResolution\":\"bundler\"}}".into()),
            ("/repo/t00DevelopmentLegacyFactoryY/t00DevelopmentAncestorY.ts".into(), "export function t00DevelopmentAncestorY() { return 167; }".into()),
            ("/repo/node_modules/t00-development-package-y/index.d.ts".into(), "export declare function t00DevelopmentPackageY(): number;".into()),
        ]);
        let (resolver, observations, _) = development_resolver(files);
        for (directory, name, expected) in [
            (
                "node",
                "t00-development-package-y",
                "/repo/node_modules/t00-development-package-y/index.d.ts",
            ),
            (
                "classic",
                "t00DevelopmentAncestorY",
                "/repo/t00DevelopmentLegacyFactoryY/t00DevelopmentAncestorY.ts",
            ),
            (
                "null",
                "t00DevelopmentAncestorY",
                "/repo/t00DevelopmentLegacyFactoryY/t00DevelopmentAncestorY.ts",
            ),
            (
                "common",
                "t00-development-package-y",
                "/repo/node_modules/t00-development-package-y/index.d.ts",
            ),
        ] {
            let path =
                format!("/repo/t00DevelopmentLegacyFactoryY/{directory}/t00DevelopmentEntryY.ts");
            let (found, _, error) =
                resolver.resolve_module_name(name, &path, ModuleKind::ES_NEXT, None);
            assert!(error.is_none(), "{directory}");
            assert_eq!(found.unwrap().resolved_file_name, expected);
            let (control, _, error) = resolver.resolve_module_name(
                if name == "t00DevelopmentAncestorY" {
                    "t00-development-package-y"
                } else {
                    "t00DevelopmentAncestorY"
                },
                &path,
                ModuleKind::ES_NEXT,
                None,
            );
            assert!(error.is_none());
            assert!(control.is_none_or(|value| value.resolved_file_name.is_empty()));
        }
        assert!(observations.borrow().errors.is_empty());
    }

    #[test]
    fn development_modern_base_url_and_paths_use_inherited_sdk59_base() {
        for (resolution, module) in [
            ("bundler", "esnext"),
            ("node16", "node16"),
            ("nodenext", "nodenext"),
        ] {
            let (resolver, observations, _) = development_resolver(BTreeMap::from([
                ("/repo/t00DevelopmentModernAA/base/tsconfig.base.json".into(), "{\"compilerOptions\":{\"baseUrl\":\"../lookups\",\"paths\":{\"@t00DevelopmentModernAA\":[\"./t00DevelopmentTargetAA.ts\"]}}}".into()),
                ("/repo/t00DevelopmentModernAA/leaf/tsconfig.json".into(), format!("{{\"extends\":\"../base/tsconfig.base.json\",\"compilerOptions\":{{\"module\":\"{module}\",\"moduleResolution\":\"{resolution}\"}}}}")),
                ("/repo/t00DevelopmentModernAA/cleared/tsconfig.json".into(), "{\"extends\":\"../base/tsconfig.base.json\",\"compilerOptions\":{\"baseUrl\":null}}".into()),
                ("/repo/t00DevelopmentModernAA/lookups/t00DevelopmentTargetAA.ts".into(), "export function t00DevelopmentModernTargetAA() { return 173; }".into()),
                ("/repo/t00DevelopmentModernAA/lookups/t00DevelopmentBaseAA.ts".into(), "export function t00DevelopmentModernBaseAA() { return 179; }".into()),
                ("/repo/t00DevelopmentModernAA/base/t00DevelopmentTargetAA.ts".into(), "export function t00DevelopmentModernClearedAA() { return 181; }".into()),
            ]));
            let path = "/repo/t00DevelopmentModernAA/leaf/t00DevelopmentEntryAA.ts";
            for (name, expected) in [
                (
                    "@t00DevelopmentModernAA",
                    "/repo/t00DevelopmentModernAA/lookups/t00DevelopmentTargetAA.ts",
                ),
                (
                    "t00DevelopmentBaseAA",
                    "/repo/t00DevelopmentModernAA/lookups/t00DevelopmentBaseAA.ts",
                ),
            ] {
                let (found, _, error) =
                    resolver.resolve_module_name(name, path, ModuleKind::COMMON_JS, None);
                assert!(error.is_none());
                assert_eq!(found.unwrap().resolved_file_name, expected, "{resolution}");
            }
            assert!(
                !observations.borrow().reasons[path]
                    .iter()
                    .any(|reason| reason.starts_with("SOURCE_CONFIGURATION_INVALID:"))
            );
            let cleared = "/repo/t00DevelopmentModernAA/cleared/t00DevelopmentEntryAA.ts";
            let (found, _, error) = resolver.resolve_module_name(
                "@t00DevelopmentModernAA",
                cleared,
                ModuleKind::COMMON_JS,
                None,
            );
            assert!(error.is_none());
            assert_eq!(
                found.unwrap().resolved_file_name,
                "/repo/t00DevelopmentModernAA/base/t00DevelopmentTargetAA.ts"
            );
            let (missing, _, error) = resolver.resolve_module_name(
                "t00DevelopmentBaseAA",
                cleared,
                ModuleKind::COMMON_JS,
                None,
            );
            assert!(error.is_none());
            assert!(missing.is_none_or(|value| value.resolved_file_name.is_empty()));
            assert!(observations.borrow().errors.is_empty());
        }
    }

    #[test]
    fn development_modern_metadata_selects_sdk59_conditions_and_versions() {
        for (resolution, module) in [
            ("bundler", "esnext"),
            ("node16", "node16"),
            ("nodenext", "nodenext"),
        ] {
            let (resolver, observations, _) = development_resolver(BTreeMap::from([
                (format!("/repo/t00DevelopmentModernBB/{resolution}/tsconfig.json"), format!("{{\"compilerOptions\":{{\"module\":\"{module}\",\"moduleResolution\":\"{resolution}\"}}}}")),
                ("/repo/node_modules/t00-development-export-bb/package.json".into(), "{\"name\":\"t00-development-export-bb\",\"version\":\"2.1.0\",\"exports\":{\".\":{\"types@<6\":\"./t00DevelopmentSdk59BB.d.ts\",\"types@>=6\":\"./t00DevelopmentSdk7BB.d.ts\",\"types\":\"./t00DevelopmentAnyBB.d.ts\"},\"./feature/*\":{\"types@<6\":\"./ts59/*.d.ts\",\"default\":\"./ts7/*.d.ts\"},\"./blocked\":{\"types@<6\":null,\"default\":\"./t00DevelopmentSdk7BB.d.ts\"},\"./denied\":null}}".into()),
                ("/repo/node_modules/t00-development-export-bb/t00DevelopmentSdk59BB.d.ts".into(), "export declare function t00DevelopmentSdk59BB(): number;".into()),
                ("/repo/node_modules/t00-development-export-bb/t00DevelopmentSdk7BB.d.ts".into(), "export declare function t00DevelopmentWrongSdk7BB(): number;".into()),
                ("/repo/node_modules/t00-development-export-bb/t00DevelopmentAnyBB.d.ts".into(), "export declare function t00DevelopmentFallbackBB(): number;".into()),
                ("/repo/node_modules/t00-development-export-bb/ts59/t00DevelopmentFeatureBB.d.ts".into(), "export declare function t00DevelopmentFeature59BB(): number;".into()),
                ("/repo/node_modules/t00-development-export-bb/ts7/t00DevelopmentFeatureBB.d.ts".into(), "export declare function t00DevelopmentWrongFeature7BB(): number;".into()),
                ("/repo/node_modules/t00-development-export-bb/denied.d.ts".into(), "export declare function t00DevelopmentDeniedFallbackBB(): number;".into()),
                ("/repo/node_modules/t00-development-types-bb/package.json".into(), "{\"types\":\"index.d.ts\",\"typesVersions\":{\"<6\":{\"*\":[\"ts59/*\"]},\"*\":{\"*\":[\"ts7/*\"]}}}".into()),
                ("/repo/node_modules/t00-development-types-bb/ts59/index.d.ts".into(), "export declare function t00DevelopmentTypes59BB(): number;".into()),
                ("/repo/node_modules/t00-development-types-bb/ts7/index.d.ts".into(), "export declare function t00DevelopmentWrongTypes7BB(): number;".into()),
                ("/repo/t00DevelopmentModernBB/package.json".into(), "{\"name\":\"t00-development-self-bb\",\"exports\":{\"./self\":{\"types@<6\":\"./t00DevelopmentSelf59BB.d.ts\",\"types@>=6\":\"./t00DevelopmentSelf7BB.d.ts\"}},\"imports\":{\"#t00DevelopmentBB\":{\"types@<6\":\"./t00DevelopmentSelf59BB.d.ts\",\"types@>=6\":\"./t00DevelopmentSelf7BB.d.ts\"},\"#t00DevelopmentExternalBB\":{\"types@<6\":\"t00-development-export-bb\",\"default\":\"./t00DevelopmentSelf7BB.d.ts\"}}}".into()),
                ("/repo/t00DevelopmentModernBB/t00DevelopmentSelf59BB.d.ts".into(), "export declare function t00DevelopmentSelf59BB(): number;".into()),
                ("/repo/t00DevelopmentModernBB/t00DevelopmentSelf7BB.d.ts".into(), "export declare function t00DevelopmentWrongSelf7BB(): number;".into()),
            ]));
            let path =
                format!("/repo/t00DevelopmentModernBB/{resolution}/t00DevelopmentEntryBB.ts");
            for (name, expected) in [
                (
                    "t00-development-export-bb",
                    "/repo/node_modules/t00-development-export-bb/t00DevelopmentSdk59BB.d.ts",
                ),
                (
                    "t00-development-export-bb/feature/t00DevelopmentFeatureBB",
                    "/repo/node_modules/t00-development-export-bb/ts59/t00DevelopmentFeatureBB.d.ts",
                ),
                (
                    "t00-development-types-bb",
                    "/repo/node_modules/t00-development-types-bb/ts59/index.d.ts",
                ),
                (
                    "t00-development-self-bb/self",
                    "/repo/t00DevelopmentModernBB/t00DevelopmentSelf59BB.d.ts",
                ),
                (
                    "#t00DevelopmentBB",
                    "/repo/t00DevelopmentModernBB/t00DevelopmentSelf59BB.d.ts",
                ),
                (
                    "#t00DevelopmentExternalBB",
                    "/repo/node_modules/t00-development-export-bb/t00DevelopmentSdk59BB.d.ts",
                ),
                (
                    "t00-development-export-bb/blocked",
                    "/repo/node_modules/t00-development-export-bb/t00DevelopmentSdk7BB.d.ts",
                ),
            ] {
                let (found, _, error) =
                    resolver.resolve_module_name(name, &path, ModuleKind::ES_NEXT, None);
                assert!(error.is_none());
                let found = found.unwrap();
                assert_eq!(found.resolved_file_name, expected, "{resolution}: {name}");
                assert_eq!(
                    found.is_external_library_import,
                    !(name.starts_with('#') || name.starts_with("t00-development-self-bb/"))
                );
            }
            let (blocked, _, error) = resolver.resolve_module_name(
                "t00-development-export-bb/denied",
                &path,
                ModuleKind::ES_NEXT,
                None,
            );
            assert!(error.is_none());
            assert!(blocked.is_none_or(|value| value.resolved_file_name.is_empty()));
            assert!(observations.borrow().errors.is_empty());
        }
    }

    #[test]
    fn development_type_references_keep_global_options_and_sdk59_metadata() {
        let (resolver, observations, _) = development_resolver(BTreeMap::from([
            ("/repo/t00DevelopmentReferencesCC/tsconfig.json".into(), "{\"compilerOptions\":{\"typeRoots\":[\"./absent\"]}}".into()),
            ("/repo/node_modules/@types/t00-development-reference-cc/package.json".into(), "{\"name\":\"@types/t00-development-reference-cc\",\"version\":\"3.2.0\",\"types\":\"index.d.ts\",\"typesVersions\":{\"<6\":{\"*\":[\"ts59/*\"]},\"*\":{\"*\":[\"ts7/*\"]}}}".into()),
            ("/repo/node_modules/@types/t00-development-reference-cc/ts59/index.d.ts".into(), "declare function t00DevelopmentReference59CC(): number;".into()),
            ("/repo/node_modules/@types/t00-development-reference-cc/ts7/index.d.ts".into(), "declare function t00DevelopmentWrongReference7CC(): number;".into()),
            ("/repo/node_modules/t00-development-reference-export-cc/package.json".into(), "{\"exports\":{\".\":{\"types@<6\":\"./t00DevelopmentExport59CC.d.ts\",\"types@>=6\":\"./t00DevelopmentExport7CC.d.ts\"}}}".into()),
            ("/repo/node_modules/t00-development-reference-export-cc/t00DevelopmentExport59CC.d.ts".into(), "declare function t00DevelopmentExport59CC(): number;".into()),
            ("/repo/node_modules/t00-development-reference-export-cc/t00DevelopmentExport7CC.d.ts".into(), "declare function t00DevelopmentWrongExport7CC(): number;".into()),
        ]));
        let path = "/repo/t00DevelopmentReferencesCC/t00DevelopmentEntryCC.ts";
        for (name, expected, primary) in [
            (
                "t00-development-reference-cc",
                "/repo/node_modules/@types/t00-development-reference-cc/ts59/index.d.ts",
                true,
            ),
            (
                "t00-development-reference-export-cc",
                "/repo/node_modules/t00-development-reference-export-cc/t00DevelopmentExport59CC.d.ts",
                false,
            ),
        ] {
            let (found, _) =
                resolver.resolve_type_reference_directive(name, path, ModuleKind::NONE, None);
            assert_eq!(found.resolved_file_name, expected);
            assert_eq!(found.primary, primary);
            assert!(found.is_external_library_import);
            if primary {
                assert_eq!(found.package_id.name, "@types/t00-development-reference-cc");
                assert_eq!(found.package_id.version, "3.2.0");
            }
        }
        let (missing, _) = resolver.resolve_type_reference_directive(
            "t00-development-missing-reference-cc",
            path,
            ModuleKind::NONE,
            None,
        );
        assert!(missing.resolved_file_name.is_empty());
        assert!(observations.borrow().errors.is_empty());
    }

    #[test]
    fn development_native_metadata_incapacities_stay_observable_without_endpoints() {
        for (manifest, name, expected) in [
            (
                "{\"imports\":{\"#t00DevelopmentCycleDD\":\"#t00DevelopmentCycleDD\"}}",
                "#t00DevelopmentCycleDD",
                "NATIVE_SDK59_IMPORT_RECURSION_UNAVAILABLE",
            ),
            (
                "{\"types\":\"index.d.ts\",\"typesVersions\":{\"<6\":{\"*\":\"scalar\"}}}",
                "t00-development-failure-dd",
                "NATIVE_SDK59_SCALAR_VERSION_PATH_UNAVAILABLE",
            ),
            (
                "{\"types\":\"index.d.ts\",\"typesVersions\":{\"<6\":{\"*\":[7]}}}",
                "t00-development-failure-dd",
                "NATIVE_SDK59_VERSION_PATH_ELEMENT_UNAVAILABLE",
            ),
        ] {
            let (resolver, observations, _) = development_resolver(BTreeMap::from([
                (
                    "/repo/t00DevelopmentFailureDD/package.json".into(),
                    manifest.into(),
                ),
                (
                    "/repo/node_modules/t00-development-failure-dd/package.json".into(),
                    manifest.into(),
                ),
                (
                    "/repo/node_modules/t00-development-failure-dd/index.d.ts".into(),
                    "export declare function t00DevelopmentFailureFallbackDD(): number;".into(),
                ),
            ]));
            let path = "/repo/t00DevelopmentFailureDD/t00DevelopmentEntryDD.ts";
            let (found, _, error) =
                resolver.resolve_module_name(name, path, ModuleKind::ES_NEXT, None);
            assert!(found.is_none());
            assert_eq!(error.unwrap().error(), expected);
            assert_eq!(observations.borrow().errors[path], expected);
            assert!(observations.borrow().reasons[path].is_empty());
        }
    }

    #[test]
    fn development_containing_file_configuration_selects_alias_and_never_leaks_to_sibling() {
        let (resolver, observations, fs) = development_resolver(BTreeMap::from([
            ("/repo/t00DevelopmentResolverLeftL/tsconfig.json".into(), "{\"extends\":\"../t00DevelopmentFoundationL.json\",\"compilerOptions\":{\"baseUrl\":\".\",\"paths\":{\"@t00DevelopmentAliasL\":[\"./t00DevelopmentLeftL.ts\"]}}}".into()),
            ("/repo/t00DevelopmentResolverRightL/tsconfig.json".into(), "{\"compilerOptions\":{\"baseUrl\":\".\",\"paths\":{\"@t00DevelopmentAliasL\":[\"./t00DevelopmentRightL.ts\"]}}}".into()),
            ("/repo/t00DevelopmentFoundationL.json".into(), "{\"compilerOptions\":{\"moduleResolution\":\"bundler\"}}".into()),
            ("/repo/t00DevelopmentResolverLeftL/t00DevelopmentLeftL.ts".into(), "export function t00DevelopmentLeftL() { return 83; }".into()),
            ("/repo/t00DevelopmentResolverRightL/t00DevelopmentRightL.ts".into(), "export function t00DevelopmentRightL() { return 89; }".into()),
        ]));
        for (directory, target) in [
            ("t00DevelopmentResolverLeftL", "t00DevelopmentLeftL.ts"),
            ("t00DevelopmentResolverRightL", "t00DevelopmentRightL.ts"),
            ("t00DevelopmentResolverLeftL", "t00DevelopmentLeftL.ts"),
        ] {
            let containing = format!("/repo/{directory}/t00DevelopmentEntryL.ts");
            let (result, _, error) = resolver.resolve_module_name(
                "@t00DevelopmentAliasL",
                &containing,
                ModuleKind::ES_NEXT,
                None,
            );
            assert!(error.is_none());
            assert_eq!(
                result.unwrap().resolved_file_name,
                format!("/repo/{directory}/{target}")
            );
        }
        let (missing, _, error) = resolver.resolve_module_name(
            "@t00DevelopmentAliasL",
            "/repo/t00DevelopmentNoConfigL/t00DevelopmentEntryL.ts",
            ModuleKind::ES_NEXT,
            None,
        );
        assert!(error.is_none());
        assert!(missing.is_none_or(|result| result.resolved_file_name.is_empty()));
        assert!(observations.borrow().errors.is_empty());
        assert!(
            observations
                .borrow()
                .consumed
                .contains("/repo/t00DevelopmentFoundationL.json")
        );
        assert!(
            fs.log
                .borrow()
                .iter()
                .any(|probe| probe.operation == "read_file"
                    && probe.path.ends_with("t00DevelopmentFoundationL.json")
                    && probe.found)
        );
    }

    #[test]
    fn development_explicit_zero_option_overrides_base_and_inherited_value() {
        for inherited in [false, true] {
            let mut files = BTreeMap::from([("/repo/t00DevelopmentZeroM/tsconfig.json".into(), if inherited { "{\"extends\":\"../t00DevelopmentZeroFoundationM.json\",\"compilerOptions\":{\"module\":\"none\"}}" } else { "{\"compilerOptions\":{\"module\":\"none\"}}" }.into())]);
            if inherited {
                files.insert(
                    "/repo/t00DevelopmentZeroFoundationM.json".into(),
                    "{\"compilerOptions\":{\"module\":\"esnext\"}}".into(),
                );
            }
            eprintln!(
                "configured_resolver_dev_input={}",
                serde_json::to_string(&files).unwrap()
            );
            let fs = Rc::new(CaptureFs::new(files, true));
            let configuration = crate::configuration::inspect(
                fs,
                "/repo/t00DevelopmentZeroM/t00DevelopmentEntryM.ts",
                "/repo",
            )
            .unwrap();
            let (merged, _) = merge_configured_options(
                &CompilerOptions {
                    module: ModuleKind::ES_NEXT,
                    target: ScriptTarget::ES2022,
                    ..Default::default()
                },
                &configuration,
            );
            assert_eq!(merged.module, ModuleKind::NONE);
        }
    }

    #[test]
    fn development_foreign_container_refuses_and_sdk_prefix_is_exact() {
        let (resolver, observations, _) = development_resolver(BTreeMap::from([
            (
                "/sdk/lib/t00DevelopmentSdkN.d.ts".into(),
                "export declare function t00DevelopmentSdkN(): number;".into(),
            ),
            (
                "/sdk/lib-adjacent/t00DevelopmentForeignN.ts".into(),
                "export function t00DevelopmentForeignN() {}".into(),
            ),
        ]));
        let (sdk, _, error) = resolver.resolve_module_name(
            "./t00DevelopmentSdkN",
            "/sdk/lib/t00DevelopmentSdkEntryN.d.ts",
            ModuleKind::ES_NEXT,
            None,
        );
        assert!(error.is_none());
        assert_eq!(
            sdk.unwrap().resolved_file_name,
            "/sdk/lib/t00DevelopmentSdkN.d.ts"
        );
        for path in [
            "/sdk/lib-adjacent/t00DevelopmentEntryN.ts",
            "/sdk/lib/../lib-adjacent/t00DevelopmentOtherN.ts",
            "/repo-adjacent/t00DevelopmentEntryN.ts",
        ] {
            let (result, _, error) = resolver.resolve_module_name(
                "./t00DevelopmentForeignN",
                path,
                ModuleKind::ES_NEXT,
                None,
            );
            assert!(result.is_none());
            assert!(error.is_some());
            assert!(observations.borrow().errors.contains_key(path));
        }
    }

    #[test]
    fn development_invalid_configuration_remains_observable_with_base_resolution() {
        let (resolver, observations, _) = development_resolver(BTreeMap::from([
            (
                "/repo/t00DevelopmentInvalidO/tsconfig.json".into(),
                "{ invalid".into(),
            ),
            (
                "/repo/t00DevelopmentInvalidO/t00DevelopmentLeafO.ts".into(),
                "export function t00DevelopmentLeafO() {}".into(),
            ),
        ]));
        let path = "/repo/t00DevelopmentInvalidO/t00DevelopmentEntryO.ts";
        let (result, _, error) =
            resolver.resolve_module_name("./t00DevelopmentLeafO", path, ModuleKind::ES_NEXT, None);
        assert!(error.is_none());
        assert_eq!(
            result.unwrap().resolved_file_name,
            "/repo/t00DevelopmentInvalidO/t00DevelopmentLeafO.ts"
        );
        assert!(
            observations.borrow().reasons[path]
                .iter()
                .any(|reason| reason.starts_with("SOURCE_CONFIGURATION_INVALID:"))
        );
    }

    #[test]
    fn development_explicit_classic_resolves_ordinary_and_keeps_qualified_refusal() {
        let (resolver, observations, _) = development_resolver(BTreeMap::from([
            (
                "/repo/t00DevelopmentClassicP/tsconfig.json".into(),
                "{\"compilerOptions\":{\"moduleResolution\":\"classic\"}}".into(),
            ),
            (
                "/repo/t00DevelopmentClassicP/t00DevelopmentLeafP.ts".into(),
                "export function t00DevelopmentLeafP() {}".into(),
            ),
        ]));
        let path = "/repo/t00DevelopmentClassicP/t00DevelopmentEntryP.ts";
        let (result, _, error) =
            resolver.resolve_module_name("./t00DevelopmentLeafP", path, ModuleKind::ES_NEXT, None);
        assert_eq!(
            result.unwrap().resolved_file_name,
            "/repo/t00DevelopmentClassicP/t00DevelopmentLeafP.ts"
        );
        assert!(error.is_none());
        assert!(
            observations.borrow().reasons[path]
                .iter()
                .any(|reason| reason == "SOURCE_CONFIGURATION_RESOLUTION_UNSUPPORTED:Classic")
        );
        assert!(!observations.borrow().errors.contains_key(path));
    }

    #[test]
    fn development_custom_conditions_are_selected_per_config_and_share_package_metadata() {
        let (resolver, observations, _) = development_resolver(BTreeMap::from([
            ("/repo/t00DevelopmentConditionLeftQ/tsconfig.json".into(), "{\"compilerOptions\":{\"customConditions\":[\"t00DevelopmentLeftQ\"]}}".into()),
            ("/repo/t00DevelopmentConditionRightQ/tsconfig.json".into(), "{\"compilerOptions\":{\"customConditions\":[\"t00DevelopmentRightQ\"]}}".into()),
            ("/repo/node_modules/@t00development/condition-q/package.json".into(), "{\"name\":\"@t00development/condition-q\",\"version\":\"1.0.0\",\"exports\":{\".\":{\"t00DevelopmentLeftQ\":\"./t00DevelopmentLeftQ.ts\",\"t00DevelopmentRightQ\":\"./t00DevelopmentRightQ.ts\",\"default\":\"./t00DevelopmentDefaultQ.ts\"}}}".into()),
            ("/repo/node_modules/@t00development/condition-q/t00DevelopmentLeftQ.ts".into(), "export function t00DevelopmentLeftQ() { return 97; }".into()),
            ("/repo/node_modules/@t00development/condition-q/t00DevelopmentRightQ.ts".into(), "export function t00DevelopmentRightQ() { return 101; }".into()),
            ("/repo/node_modules/@t00development/condition-q/t00DevelopmentDefaultQ.ts".into(), "export function t00DevelopmentDefaultQ() { return 103; }".into()),
        ]));
        for (directory, target) in [
            ("t00DevelopmentConditionLeftQ", "t00DevelopmentLeftQ.ts"),
            ("t00DevelopmentConditionRightQ", "t00DevelopmentRightQ.ts"),
            ("t00DevelopmentNoConditionQ", "t00DevelopmentDefaultQ.ts"),
        ] {
            let containing = format!("/repo/{directory}/t00DevelopmentEntryQ.ts");
            let (result, _, error) = resolver.resolve_module_name(
                "@t00development/condition-q",
                &containing,
                ModuleKind::ES_NEXT,
                None,
            );
            assert!(error.is_none());
            assert_eq!(
                result.unwrap().resolved_file_name,
                format!("/repo/node_modules/@t00development/condition-q/{target}")
            );
        }
        let mut entries = Vec::new();
        resolver.package_json_cache_entries(&mut |path, _| {
            entries.push(path.0.clone());
            true
        });
        assert!(
            entries
                .iter()
                .any(|path| path.ends_with("@t00development/condition-q/package.json"))
        );
        assert!(observations.borrow().errors.is_empty());
    }

    #[test]
    fn development_raw_chain_order_preserves_inherited_zero_and_null_then_later_override() {
        for later in [false, true] {
            let files = BTreeMap::from([
                ("/repo/t00DevelopmentLineageR/tsconfig.json".into(), if later { "{\"extends\":\"../t00DevelopmentMiddleR.json\",\"compilerOptions\":{\"module\":\"esnext\",\"allowJs\":false}}" } else { "{\"extends\":\"../t00DevelopmentMiddleR.json\"}" }.into()),
                ("/repo/t00DevelopmentMiddleR.json".into(), "{\"extends\":\"./t00DevelopmentFoundationR.json\",\"compilerOptions\":{\"module\":\"none\",\"allowJs\":null}}".into()),
                ("/repo/t00DevelopmentFoundationR.json".into(), "{\"compilerOptions\":{\"module\":\"esnext\",\"allowJs\":false}}".into()),
            ]);
            eprintln!(
                "configured_resolver_dev_input={}",
                serde_json::to_string(&files).unwrap()
            );
            let configuration = crate::configuration::inspect(
                Rc::new(CaptureFs::new(files, true)),
                "/repo/t00DevelopmentLineageR/t00DevelopmentEntryR.ts",
                "/repo",
            )
            .unwrap();
            let (merged, reasons) = merge_configured_options(
                &CompilerOptions {
                    module: ModuleKind::ES_NEXT,
                    allow_js: Tristate::True,
                    ..Default::default()
                },
                &configuration,
            );
            assert_eq!(
                merged.module,
                if later {
                    ModuleKind::ES_NEXT
                } else {
                    ModuleKind::NONE
                }
            );
            assert_eq!(
                merged.allow_js,
                if later {
                    Tristate::False
                } else {
                    Tristate::Unknown
                }
            );
            assert_eq!(
                reasons
                    .iter()
                    .any(|reason| reason == "SOURCE_CONFIGURATION_MODULE_UNSUPPORTED:None"),
                !later
            );
        }
    }

    #[test]
    fn development_null_resolution_reset_uses_classic_without_spurious_refusal() {
        for inherited in [false, true] {
            let mut files = BTreeMap::from([
                (
                    "/repo/t00DevelopmentNullS/tsconfig.json".into(),
                    if inherited {
                        "{\"extends\":\"../t00DevelopmentNullMiddleS.json\"}"
                    } else {
                        "{\"compilerOptions\":{\"moduleResolution\":null}}"
                    }
                    .into(),
                ),
                (
                    "/repo/t00DevelopmentNullS/t00DevelopmentLeafS.ts".into(),
                    "export function t00DevelopmentLeafS() { return 107; }".into(),
                ),
            ]);
            if inherited {
                files.insert("/repo/t00DevelopmentNullMiddleS.json".into(), "{\"extends\":\"./t00DevelopmentNullFoundationS.json\",\"compilerOptions\":{\"moduleResolution\":null}}".into());
                files.insert(
                    "/repo/t00DevelopmentNullFoundationS.json".into(),
                    "{\"compilerOptions\":{\"moduleResolution\":\"bundler\"}}".into(),
                );
            }
            let (resolver, observations, _) = development_resolver(files);
            let path = "/repo/t00DevelopmentNullS/t00DevelopmentEntryS.ts";
            let (result, _, error) = resolver.resolve_module_name(
                "./t00DevelopmentLeafS",
                path,
                ModuleKind::ES_NEXT,
                None,
            );
            assert_eq!(
                result.unwrap().resolved_file_name,
                "/repo/t00DevelopmentNullS/t00DevelopmentLeafS.ts"
            );
            assert!(error.is_none());
            assert!(!observations.borrow().errors.contains_key(path));
            assert!(
                !observations.borrow().reasons[path]
                    .iter()
                    .any(|reason| reason == "SOURCE_CONFIGURATION_RESOLUTION_UNSUPPORTED:Classic")
            );
        }
    }
}
