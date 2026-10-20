
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
fn configured_source_resolution_does_not_create_workspace_source_package_links() {
    let files = BTreeMap::from([
        (
            "/repo/package.json".into(),
            r#"{"workspaces":["packages/*","app"]}"#.into(),
        ),
        (
            "/repo/packages/physical-source-dev/package.json".into(),
            r#"{"name":"physical-source-dev","version":"1.0.0","types":"index.ts"}"#.into(),
        ),
        (
            "/repo/packages/physical-source-dev/index.ts".into(),
            "export function physicalSourceDev() { return 29; }".into(),
        ),
        (
            "/repo/app/package.json".into(),
            r#"{"dependencies":{"physical-source-dev":"workspace:*","@dev/config":"workspace:*"}}"#
                .into(),
        ),
        (
            "/repo/app/source.ts".into(),
            "export const sourceDev = 31;".into(),
        ),
        (
            "/repo/app/node_modules/installed-source-dev/package.json".into(),
            r#"{"name":"installed-source-dev","types":"index.ts"}"#.into(),
        ),
        (
            "/repo/app/node_modules/installed-source-dev/index.ts".into(),
            "export const installedSourceDev = 37;".into(),
        ),
        (
            "/repo/packages/config-dev/package.json".into(),
            r#"{"name":"@dev/config","version":"1.0.0"}"#.into(),
        ),
        (
            "/repo/packages/config-dev/tsconfig.json".into(),
            r##"{"compilerOptions":{"baseUrl":".","paths":{"#dev":["leaf.ts"]}}}"##.into(),
        ),
        (
            "/repo/packages/config-dev/leaf.ts".into(),
            "export const inheritedDev = 41;".into(),
        ),
        (
            "/repo/app/tsconfig.json".into(),
            r#"{"extends":"@dev/config/tsconfig.json"}"#.into(),
        ),
        (
            "/repo/nested/.git/HEAD".into(),
            "ref: refs/heads/dev".into(),
        ),
        (
            "/repo/nested/hidden.ts".into(),
            "export const nestedDev = 43;".into(),
        ),
        (
            "/outside-dev.ts".into(),
            "export const outsideDev = 47;".into(),
        ),
    ]);
    let fs = Rc::new(CaptureFs::with_workspace_root(
        files,
        true,
        "/repo",
        Some("/sdk/lib"),
    ));
    assert!(fs.file_exists("/repo/app/node_modules/physical-source-dev/index.ts"));
    let (create, observations) = factory(fs.clone(), "/repo".into(), "/sdk/lib".into());
    let resolver = create(ResolverOptions {
        host: Some(Rc::new(DevelopmentHost(fs.clone()))),
        compiler_options: Some(Rc::new(compiler_options())),
        ..Default::default()
    });
    let (found, _, error) = resolver.resolve_module_name(
        "physical-source-dev",
        "/repo/app/source.ts",
        ModuleKind::NONE,
        None,
    );
    assert!(error.is_none(), "{error:?}");
    assert!(
        found
            .as_ref()
            .is_none_or(|value| value.resolved_file_name.is_empty()),
        "{:?}",
        found.as_ref().map(|value| &value.resolved_file_name)
    );
    assert!(observations.borrow().errors.is_empty());
    let (installed, _, error) = resolver.resolve_module_name(
        "installed-source-dev",
        "/repo/app/source.ts",
        ModuleKind::NONE,
        None,
    );
    assert!(error.is_none());
    assert_eq!(
        installed.unwrap().resolved_file_name,
        "/repo/app/node_modules/installed-source-dev/index.ts"
    );
    let (inherited, _, error) =
        resolver.resolve_module_name("#dev", "/repo/app/source.ts", ModuleKind::NONE, None);
    assert!(error.is_none(), "{error:?}");
    assert_eq!(
        inherited.unwrap().resolved_file_name,
        "/repo/packages/config-dev/leaf.ts"
    );
    assert!(observations.borrow().reasons["/repo/app/source.ts"].is_empty());
    for (specifier, refusal) in [
        ("../../outside-dev", "WORKSPACE_PATH_OUTSIDE_ROOT"),
        ("../nested/hidden", "WORKSPACE_NESTED_REPOSITORY"),
    ] {
        let (found, _, error) =
            resolver.resolve_module_name(specifier, "/repo/app/source.ts", ModuleKind::NONE, None);
        assert!(error.is_none(), "{error:?}");
        assert!(
            found
                .as_ref()
                .is_none_or(|value| value.resolved_file_name.is_empty())
        );
        assert!(
            fs.workspace
                .as_ref()
                .unwrap()
                .issues
                .borrow()
                .iter()
                .any(|issue| issue.detail == refusal)
        );
    }
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
        let path = format!("/repo/t00DevelopmentModernBB/{resolution}/t00DevelopmentEntryBB.ts");
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
        let (found, _, error) = resolver.resolve_module_name(name, path, ModuleKind::ES_NEXT, None);
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
        let (result, _, error) =
            resolver.resolve_module_name("./t00DevelopmentLeafS", path, ModuleKind::ES_NEXT, None);
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
