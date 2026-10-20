
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

#[test]
fn development_legacy_relative_missing_and_canonical_keys_use_native_metadata() {
    let files = BTreeMap::from([(
        "/repo/t00DevelopmentLegacyApiU/T00DevelopmentTargetU.ts".into(),
        "export function t00DevelopmentLegacyTargetU() { return 109; }".into(),
    )]);
    eprintln!(
        "configured_resolver_dev_input={}",
        serde_json::to_string(&files).unwrap()
    );
    let fs = Rc::new(CaptureFs::new(files, false));
    let resolver = module::new_resolver(ResolverOptions {
        host: Some(Rc::new(DevelopmentHost(fs.clone()))),
        compiler_options: Some(Rc::new(CompilerOptions {
            target: ScriptTarget::ES2022,
            module: ModuleKind::NONE,
            module_resolution: ModuleResolutionKind::NODE10,
            ..Default::default()
        })),
        ..Default::default()
    });
    for mode in [LegacyMode::Node10, LegacyMode::Classic] {
        let found = resolve(
            &resolver,
            mode,
            "./discard/../T00DevelopmentTargetU",
            "/repo/t00DevelopmentLegacyApiU",
            ModuleKind::NONE,
            None,
            None,
        )
        .unwrap();
        assert_eq!(
            found.resolved_file_name,
            "/repo/t00DevelopmentLegacyApiU/T00DevelopmentTargetU.ts"
        );
        assert_eq!(
            found.resolved_path.0,
            "/repo/t00developmentlegacyapiu/t00developmenttargetu.ts"
        );
        assert_eq!(found.extension, ".ts");
        assert!(!found.is_external_library_import);
        let missing = resolve(
            &resolver,
            mode,
            "./t00DevelopmentMissingU",
            "/repo/t00DevelopmentLegacyApiU",
            ModuleKind::NONE,
            None,
            None,
        )
        .unwrap();
        assert!(missing.resolved_file_name.is_empty());
    }
    assert!(
        fs.log
            .borrow()
            .iter()
            .any(|probe| probe.operation == "file_exists" && probe.found)
    );
}

#[test]
fn development_legacy_settings_keep_extension_priority_and_declaring_base() {
    let files = BTreeMap::from([
            ("/repo/t00DevelopmentLegacySettingsV/base/tsconfig.base.json".into(), "{\"compilerOptions\":{\"baseUrl\":\"../lookups\",\"paths\":{\"@t00development/priority-v\":[\"./t00DevelopmentAliasV.js\"],\"@t00DevelopmentLocalV\":[\"./t00DevelopmentPathsV\"],\"@t00development/extensionless-v\":[\"./t00DevelopmentExtensionlessV\"]}}}".into()),
            ("/repo/t00DevelopmentLegacySettingsV/leaf/tsconfig.json".into(), "{\"extends\":\"../base/tsconfig.base.json\",\"compilerOptions\":{\"moduleResolution\":\"node10\",\"rootDirs\":[\"./source\",\"./generated\"]}}".into()),
            ("/repo/t00DevelopmentLegacySettingsV/lookups/t00DevelopmentAliasV.js".into(), "export function t00DevelopmentAliasV() { return 113; }".into()),
            ("/repo/t00DevelopmentLegacySettingsV/lookups/t00DevelopmentExtensionlessV.js".into(), "export function t00DevelopmentExtensionlessV() { return 151; }".into()),
            ("/repo/node_modules/@t00development/extensionless-v/index.d.ts".into(), "export declare function t00DevelopmentExtensionlessTypesV(): number;".into()),
            ("/repo/t00DevelopmentLegacySettingsV/lookups/t00DevelopmentBaseV.ts".into(), "export function t00DevelopmentBaseV() { return 127; }".into()),
            ("/repo/t00DevelopmentLegacySettingsV/lookups/t00DevelopmentPathsV.ts".into(), "export function t00DevelopmentPathsV() { return 131; }".into()),
            ("/repo/t00DevelopmentLegacySettingsV/base/t00DevelopmentPathsV.ts".into(), "export function t00DevelopmentWrongPathsV() { return 137; }".into()),
            ("/repo/t00DevelopmentLegacySettingsV/leaf/generated/t00DevelopmentGeneratedV.ts".into(), "export function t00DevelopmentGeneratedV() { return 139; }".into()),
            ("/repo/node_modules/@t00development/priority-v/index.d.ts".into(), "export declare function t00DevelopmentPreferredTypesV(): number;".into()),
            ("/repo/package.json".into(), "{\"name\":\"t00-development-self-v\",\"exports\":{\"./feature\":\"./t00DevelopmentSelfV.ts\"}}".into()),
            ("/repo/t00DevelopmentSelfV.ts".into(), "export function t00DevelopmentSelfV() { return 149; }".into()),
        ]);
    eprintln!(
        "configured_resolver_dev_input={}",
        serde_json::to_string(&files).unwrap()
    );
    let fs = Rc::new(CaptureFs::new(files, true));
    let configuration = crate::configuration::inspect(
        fs.clone(),
        "/repo/t00DevelopmentLegacySettingsV/leaf/source/t00DevelopmentEntryV.ts",
        "/repo",
    )
    .unwrap();
    let base_url = base_url(&configuration);
    assert_eq!(
        base_url.as_deref(),
        Some("/repo/t00DevelopmentLegacySettingsV/lookups")
    );
    let (options, _) = merge_configured_options(
        &CompilerOptions {
            module: ModuleKind::NONE,
            module_resolution: ModuleResolutionKind::NODE10,
            target: ScriptTarget::ES2022,
            ..Default::default()
        },
        &configuration,
    );
    let resolver = module::new_resolver(ResolverOptions {
        host: Some(Rc::new(DevelopmentHost(fs))),
        compiler_options: Some(Rc::new(options)),
        ..Default::default()
    });
    let directory = "/repo/t00DevelopmentLegacySettingsV/leaf/source";
    for mode in [LegacyMode::Node10, LegacyMode::Classic] {
        for (name, expected) in [
            (
                "t00DevelopmentBaseV",
                "/repo/t00DevelopmentLegacySettingsV/lookups/t00DevelopmentBaseV.ts",
            ),
            (
                "@t00DevelopmentLocalV",
                "/repo/t00DevelopmentLegacySettingsV/lookups/t00DevelopmentPathsV.ts",
            ),
            (
                "./t00DevelopmentGeneratedV",
                "/repo/t00DevelopmentLegacySettingsV/leaf/generated/t00DevelopmentGeneratedV.ts",
            ),
        ] {
            let found = resolve(
                &resolver,
                mode,
                name,
                directory,
                ModuleKind::NONE,
                None,
                base_url.as_deref(),
            )
            .unwrap();
            assert_eq!(found.resolved_file_name, expected);
        }
    }
    let preferred = resolve(
        &resolver,
        LegacyMode::Node10,
        "@t00development/priority-v",
        directory,
        ModuleKind::NONE,
        None,
        base_url.as_deref(),
    )
    .unwrap();
    assert_eq!(
        preferred.resolved_file_name,
        "/repo/t00DevelopmentLegacySettingsV/lookups/t00DevelopmentAliasV.js"
    );
    let extensionless = resolve(
        &resolver,
        LegacyMode::Node10,
        "@t00development/extensionless-v",
        directory,
        ModuleKind::NONE,
        None,
        base_url.as_deref(),
    )
    .unwrap();
    assert_eq!(
        extensionless.resolved_file_name,
        "/repo/node_modules/@t00development/extensionless-v/index.d.ts"
    );
    let self_name = resolve(
        &resolver,
        LegacyMode::Node10,
        "t00-development-self-v/feature",
        directory,
        ModuleKind::NONE,
        None,
        base_url.as_deref(),
    )
    .unwrap();
    assert!(self_name.resolved_file_name.is_empty());
}

#[test]
fn development_legacy_typesversions_uses_sdk59_without_rewriting_metadata() {
    let files = BTreeMap::from([
            ("/repo/node_modules/t00-development-version-w/package.json".into(), "{\"name\":\"t00-development-version-w\",\"version\":\"1.3.0\",\"types\":\"index.d.ts\",\"typesVersions\":{\"not a range\":{},\"<6\":{\"*\":[\"ts59/*\"]},\"*\":{\"*\":[\"ts7/*\"]}}}".into()),
            ("/repo/node_modules/t00-development-version-w/index.d.ts".into(), "export declare function t00DevelopmentFallbackW(): number;".into()),
            ("/repo/node_modules/t00-development-version-w/ts59/index.d.ts".into(), "export declare function t00DevelopmentSdk59W(): number;".into()),
            ("/repo/node_modules/t00-development-version-w/ts59/feature.d.ts".into(), "export declare function t00DevelopmentSubpath59W(): number;".into()),
            ("/repo/node_modules/t00-development-version-w/ts7/index.d.ts".into(), "export declare function t00DevelopmentWrongSdk7W(): number;".into()),
            ("/repo/node_modules/t00-development-invalid-w/package.json".into(), "{\"types\":\"index.d.ts\",\"typesVersions\":{\"<6\":true,\"*\":{\"*\":[\"wrong/*\"]}}}".into()),
            ("/repo/node_modules/t00-development-invalid-w/index.d.ts".into(), "export declare function t00DevelopmentInvalidFallbackW(): number;".into()),
            ("/repo/node_modules/t00-development-nomatch-w/package.json".into(), "{\"types\":\"index.d.ts\",\"typesVersions\":{\">=6\":{\"*\":[\"wrong/*\"]}}}".into()),
            ("/repo/node_modules/t00-development-nomatch-w/index.d.ts".into(), "export declare function t00DevelopmentNoVersionFallbackW(): number;".into()),
            ("/repo/node_modules/t00-development-blocked-w/package.json".into(), "{\"types\":\"index.d.ts\",\"typesVersions\":{\"<6\":{\"*\":[\"absent/*\"]}}}".into()),
            ("/repo/node_modules/t00-development-blocked-w/index.d.ts".into(), "export declare function t00DevelopmentMustNotFallbackW(): number;".into()),
        ]);
    eprintln!(
        "configured_resolver_dev_input={}",
        serde_json::to_string(&files).unwrap()
    );
    let fs = Rc::new(CaptureFs::new(files.clone(), true));
    let resolver = module::new_resolver(ResolverOptions {
        host: Some(Rc::new(DevelopmentHost(fs.clone()))),
        compiler_options: Some(Rc::new(CompilerOptions {
            target: ScriptTarget::ES2022,
            module: ModuleKind::NONE,
            module_resolution: ModuleResolutionKind::NODE10,
            ..Default::default()
        })),
        ..Default::default()
    });
    for (name, expected) in [
        (
            "t00-development-version-w",
            "/repo/node_modules/t00-development-version-w/ts59/index.d.ts",
        ),
        (
            "t00-development-version-w/feature",
            "/repo/node_modules/t00-development-version-w/ts59/feature.d.ts",
        ),
        (
            "t00-development-invalid-w",
            "/repo/node_modules/t00-development-invalid-w/index.d.ts",
        ),
        (
            "t00-development-nomatch-w",
            "/repo/node_modules/t00-development-nomatch-w/index.d.ts",
        ),
    ] {
        let result = resolve(
            &resolver,
            LegacyMode::Node10,
            name,
            "/repo/t00DevelopmentVersionW",
            ModuleKind::NONE,
            None,
            None,
        )
        .unwrap();
        assert_eq!(result.resolved_file_name, expected);
        assert!(result.is_external_library_import);
        if name.starts_with("t00-development-version-w") {
            assert_eq!(result.package_id.name, "t00-development-version-w");
            assert_eq!(result.package_id.version, "1.3.0");
        }
    }
    let blocked = resolve(
        &resolver,
        LegacyMode::Node10,
        "t00-development-blocked-w",
        "/repo/t00DevelopmentVersionW",
        ModuleKind::NONE,
        None,
        None,
    )
    .unwrap();
    assert!(blocked.resolved_file_name.is_empty());
    assert_eq!(fs.files, files);
}

#[test]
fn development_classic_ancestor_files_types_scope_and_type_roots_are_distinct() {
    let files = BTreeMap::from([
            ("/repo/t00DevelopmentClassicX/t00DevelopmentAncestorX.ts".into(), "export function t00DevelopmentAncestorX() { return 157; }".into()),
            ("/repo/t00DevelopmentClassicX/leaf/t00DevelopmentDirectoryX/index.ts".into(), "export function t00DevelopmentDirectoryX() { return 163; }".into()),
            ("/repo/node_modules/t00-development-package-only-x/index.d.ts".into(), "export declare function t00DevelopmentPackageOnlyX(): number;".into()),
            ("/repo/node_modules/@types/t00-development-ambient-x/package.json".into(), "{\"types\":\"index.d.ts\",\"typesVersions\":{\"<6\":{\"*\":[\"ts59/*\"]},\"*\":{\"*\":[\"ts7/*\"]}}}".into()),
            ("/repo/node_modules/@types/t00-development-ambient-x/ts59/index.d.ts".into(), "export declare function t00DevelopmentAmbient59X(): number;".into()),
            ("/repo/node_modules/@types/t00-development-ambient-x/ts7/index.d.ts".into(), "export declare function t00DevelopmentAmbientWrong7X(): number;".into()),
            ("/repo/t00DevelopmentTypeRootsX/t00-development-root-x/index.d.ts".into(), "export declare function t00DevelopmentTypeRootX(): number;".into()),
            ("/repo/t00DevelopmentTypeRootsX/t00-development-ambient-x/package.json".into(), "{\"typesVersions\":{\"<6\":{\"*\":\"unused\"}}}".into()),
        ]);
    eprintln!(
        "configured_resolver_dev_input={}",
        serde_json::to_string(&files).unwrap()
    );
    let resolver = module::new_resolver(ResolverOptions {
        host: Some(Rc::new(DevelopmentHost(Rc::new(CaptureFs::new(
            files, true,
        ))))),
        compiler_options: Some(Rc::new(CompilerOptions {
            target: ScriptTarget::ES2022,
            module: ModuleKind::NONE,
            module_resolution: ModuleResolutionKind::CLASSIC,
            type_roots: Some(vec!["/repo/t00DevelopmentTypeRootsX".into()]),
            ..Default::default()
        })),
        ..Default::default()
    });
    let directory = "/repo/t00DevelopmentClassicX/leaf";
    for mode in [LegacyMode::Classic, LegacyMode::Node10] {
        for (name, expected) in [
            (
                "t00-development-ambient-x",
                "/repo/node_modules/@types/t00-development-ambient-x/ts59/index.d.ts",
            ),
            (
                "t00-development-root-x",
                "/repo/t00DevelopmentTypeRootsX/t00-development-root-x/index.d.ts",
            ),
        ] {
            let found = resolve(
                &resolver,
                mode,
                name,
                directory,
                ModuleKind::NONE,
                None,
                None,
            )
            .unwrap();
            assert_eq!(found.resolved_file_name, expected);
        }
    }
    for (mode, name, expected) in [
        (
            LegacyMode::Classic,
            "t00DevelopmentAncestorX",
            "/repo/t00DevelopmentClassicX/t00DevelopmentAncestorX.ts",
        ),
        (LegacyMode::Node10, "t00DevelopmentAncestorX", ""),
        (LegacyMode::Classic, "t00-development-package-only-x", ""),
        (
            LegacyMode::Node10,
            "t00-development-package-only-x",
            "/repo/node_modules/t00-development-package-only-x/index.d.ts",
        ),
        (LegacyMode::Classic, "./t00DevelopmentDirectoryX", ""),
        (
            LegacyMode::Node10,
            "./t00DevelopmentDirectoryX",
            "/repo/t00DevelopmentClassicX/leaf/t00DevelopmentDirectoryX/index.ts",
        ),
    ] {
        let found = resolve(
            &resolver,
            mode,
            name,
            directory,
            ModuleKind::NONE,
            None,
            None,
        )
        .unwrap();
        assert_eq!(found.resolved_file_name, expected);
    }
}

#[test]
fn development_modern_directory_intent_and_package_root_obey_resolution_mode() {
    let files = BTreeMap::from([
        (
            "/repo/t00DevelopmentIntentFF.ts".into(),
            "export function t00DevelopmentWrongParentFileFF() { return 191; }".into(),
        ),
        (
            "/repo/t00DevelopmentIntentFF/index.ts".into(),
            "export function t00DevelopmentParentDirectoryFF() { return 193; }".into(),
        ),
        (
            "/repo/node_modules/t00-development-explicit-ff.d.ts".into(),
            "export declare function t00DevelopmentExplicitSiblingFF(): number;".into(),
        ),
        (
            "/repo/node_modules/t00-development-explicit-ff.js/package.json".into(),
            "{\"types\":\"inside.d.ts\"}".into(),
        ),
        (
            "/repo/node_modules/t00-development-explicit-ff.js/inside.d.ts".into(),
            "export declare function t00DevelopmentExplicitInsideFF(): number;".into(),
        ),
        (
            "/repo/node_modules/t00-development-esm-ff.d.ts".into(),
            "export declare function t00DevelopmentSiblingFileFF(): number;".into(),
        ),
        (
            "/repo/node_modules/t00-development-esm-ff/package.json".into(),
            "{\"types\":\"inside.d.ts\"}".into(),
        ),
        (
            "/repo/node_modules/t00-development-esm-ff/inside.d.ts".into(),
            "export declare function t00DevelopmentInsidePackageFF(): number;".into(),
        ),
    ]);
    eprintln!(
        "configured_resolver_dev_input={}",
        serde_json::to_string(&files).unwrap()
    );
    let resolver = module::new_resolver(ResolverOptions {
        host: Some(Rc::new(DevelopmentHost(Rc::new(CaptureFs::new(
            files, true,
        ))))),
        compiler_options: Some(Rc::new(CompilerOptions {
            target: ScriptTarget::ES2022,
            module: ModuleKind::NODE_NEXT,
            module_resolution: ModuleResolutionKind::NODE_NEXT,
            ..Default::default()
        })),
        ..Default::default()
    });
    for (mode, name, expected) in [
        (
            ModuleKind::COMMON_JS,
            "..",
            "/repo/t00DevelopmentIntentFF/index.ts",
        ),
        (ModuleKind::ES_NEXT, "..", ""),
        (
            ModuleKind::COMMON_JS,
            "t00-development-explicit-ff.js",
            "/repo/node_modules/t00-development-explicit-ff.d.ts",
        ),
        (
            ModuleKind::ES_NEXT,
            "t00-development-explicit-ff.js",
            "/repo/node_modules/t00-development-explicit-ff.js/inside.d.ts",
        ),
        (
            ModuleKind::COMMON_JS,
            "t00-development-esm-ff",
            "/repo/node_modules/t00-development-esm-ff.d.ts",
        ),
        (
            ModuleKind::ES_NEXT,
            "t00-development-esm-ff",
            "/repo/node_modules/t00-development-esm-ff/inside.d.ts",
        ),
    ] {
        let found = resolve_modern(
            &resolver,
            name,
            "/repo/t00DevelopmentIntentFF/leaf",
            mode,
            None,
            None,
        )
        .unwrap();
        assert_eq!(found.resolved_file_name, expected);
    }
}
