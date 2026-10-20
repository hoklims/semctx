use super::*;
use std::collections::BTreeMap;
use ts_goport::program;

fn development_extract(files: BTreeMap<String, String>, relative: &str) -> Extraction {
    eprintln!(
        "ordinary_dev_input={}",
        serde_json::to_string(&files).unwrap()
    );
    let roots = files.keys().cloned().collect();
    let captured = files.clone();
    let javascript_enabled = files.keys().any(|path| {
        [".js", ".jsx", ".mjs", ".cjs"]
            .iter()
            .any(|suffix| path.ends_with(suffix))
    });
    let relative = relative.to_owned();
    let path = format!("/repo/{relative}");
    crate::development::with_project(files, roots, move || {
        let source = program::get_source_file(&path);
        program::with_type_checker_for_file(source, move |checker| {
            extract(
                source,
                checker,
                &relative,
                &ExtractionContext {
                    repository_root: "/repo",
                    static_module_links: true,
                    retained: true,
                    javascript_enabled,
                    captured_files: Some(&captured),
                    case_sensitive: true,
                },
            )
        })
        .unwrap()
    })
}

#[test]
fn review_development_malformed_import_cannot_replace_previous_record() {
    let controls: serde_json::Value =
        serde_json::from_str(include_str!("../../development/review-controls.json")).unwrap();
    let files: BTreeMap<String, String> =
        serde_json::from_value(controls["cases"][0]["files"].clone()).unwrap();
    let result = development_extract(files, "reviewDevelopmentImportConsumerA.ts");
    assert_eq!(result.imports.len(), 1);
    assert_eq!(
        result.imports[0].module_specifier,
        "./reviewDevelopmentImportOwnerA"
    );
    assert_eq!(result.imports[0].names, vec!["reviewDevelopmentFirstA"]);
}

#[test]
fn review_development_named_relay_preserves_ambiguous_origins_and_concrete_override() {
    let controls: serde_json::Value =
        serde_json::from_str(include_str!("../../development/review-controls.json")).unwrap();
    for concrete in [false, true] {
        let mut files: BTreeMap<String, String> =
            serde_json::from_value(controls["cases"][1]["files"].clone()).unwrap();
        if concrete {
            files.insert(
                "/repo/reviewDevelopmentRelayB.ts".into(),
                controls["cases"][1]["variants"][0]["source"]
                    .as_str()
                    .unwrap()
                    .into(),
            );
        }
        let result = development_extract(files, "reviewDevelopmentConsumerB.ts");
        assert_eq!(
            result.calls[0].callee_rel_path.as_deref(),
            concrete.then_some("reviewDevelopmentFirstB.ts")
        );
        assert_eq!(
            result.calls[0].callee_symbol_path.as_deref(),
            concrete.then_some("reviewDevelopmentClashB")
        );
        assert_eq!(
            result.imports[0].binding_targets.as_ref().unwrap().len(),
            usize::from(concrete)
        );
    }
}

#[test]
fn development_ambiguous_stars_have_no_endpoint_and_explicit_export_resolves() {
    for (explicit, reversed) in [(false, false), (false, true), (true, false), (true, true)] {
        let mut barrel = if reversed {
            "export * from './t00DevelopmentSecondC'; export * from './t00DevelopmentFirstC';"
        } else {
            "export * from './t00DevelopmentFirstC'; export * from './t00DevelopmentSecondC';"
        }
        .to_string();
        if explicit {
            barrel.push_str(" export { t00DevelopmentStarC } from './t00DevelopmentFirstC';");
        }
        let result = development_extract(BTreeMap::from([
                ("/repo/t00DevelopmentFirstC.ts".into(), "export function t00DevelopmentStarC() { return 53; }".into()),
                ("/repo/t00DevelopmentSecondC.ts".into(), "export function t00DevelopmentStarC() { return 59; }".into()),
                ("/repo/t00DevelopmentBarrelC.ts".into(), barrel),
                ("/repo/t00DevelopmentCallerC.ts".into(), "import { t00DevelopmentStarC } from './t00DevelopmentBarrelC'; export function t00DevelopmentCallerC() { return t00DevelopmentStarC(); }".into()),
            ]), "t00DevelopmentCallerC.ts");
        assert_eq!(result.calls.len(), 1);
        assert_eq!(
            result.calls[0].callee_rel_path.as_deref(),
            explicit.then_some("t00DevelopmentFirstC.ts")
        );
        assert_eq!(
            result.calls[0].callee_symbol_path.as_deref(),
            explicit.then_some("t00DevelopmentStarC")
        );
        assert_eq!(
            result.imports[0].binding_targets.as_ref().unwrap().len(),
            usize::from(explicit)
        );
    }
}

#[test]
fn development_alias_uses_remote_declaration_not_local_homonym() {
    let result = development_extract(BTreeMap::from([
            ("/repo/t00DevelopmentRemoteB.ts".into(), "export function t00DevelopmentLeafB() { return 47; }".into()),
            ("/repo/t00DevelopmentCallerB.ts".into(), "import { t00DevelopmentLeafB as t00DevelopmentAliasB } from './t00DevelopmentRemoteB'; function t00DevelopmentLeafB() { return 99; } export function t00DevelopmentCallerB() { return t00DevelopmentAliasB(); }".into()),
        ]), "t00DevelopmentCallerB.ts");
    assert_eq!(result.calls.len(), 1);
    assert_eq!(
        result.calls[0].callee_rel_path.as_deref(),
        Some("t00DevelopmentRemoteB.ts")
    );
    assert_eq!(
        result.calls[0].callee_symbol_path.as_deref(),
        Some("t00DevelopmentLeafB")
    );
    assert_eq!(
        result.calls[0].caller_symbol_path.as_deref(),
        Some("t00DevelopmentCallerB")
    );
    assert_eq!(result.imports.len(), 1);
    assert_eq!(
        result.imports[0].resolved_rel_path.as_deref(),
        Some("t00DevelopmentRemoteB.ts")
    );
    assert_eq!(result.imports[0].names, vec!["t00DevelopmentLeafB"]);
}

#[test]
fn observed_unresolved_modules_do_not_fall_back_to_checker_symbols() {
    let path = "/repo/nativeResolutionConsumerDev.ts";
    let files = BTreeMap::from([
            (path.to_string(), "import { nativeResolutionValueDev } from './nativeResolutionOwnerDev'; export const observed=nativeResolutionValueDev;".into()),
            ("/repo/nativeResolutionOwnerDev.ts".into(), "export const nativeResolutionValueDev=251;".into()),
        ]);
    let captured = files.clone();
    crate::development::with_project(files, vec![path.into()], move || {
        let source = program::get_source_file(path);
        program::with_type_checker_for_file(source, move |checker| {
            let context = ExtractionContext {
                repository_root: "/repo",
                static_module_links: true,
                retained: false,
                javascript_enabled: true,
                captured_files: Some(&captured),
                case_sensitive: true,
            };
            let control =
                extract(source, checker, "nativeResolutionConsumerDev.ts", &context).unwrap();
            assert_eq!(
                control.imports[0].resolved_rel_path.as_deref(),
                Some("nativeResolutionOwnerDev.ts")
            );
            let unresolved = BTreeMap::new();
            let observed = extract_with_module_resolutions(
                source,
                checker,
                "nativeResolutionConsumerDev.ts",
                &context,
                Some(&unresolved),
            )
            .unwrap();
            assert_eq!(observed.imports[0].resolved_rel_path, None);
        });
    });
}

#[test]
fn development_callable_coordinate_requires_semantic_callable_and_owner_body() {
    let path = "/repo/t00DevelopmentCoordinatesD.ts";
    let text = "function t00DevelopmentCallableD() {} function t00DevelopmentSignatureD(): void; const t00DevelopmentArrowD = () => {}; const t00DevelopmentDataD = 61; t00DevelopmentCallableD(); t00DevelopmentArrowD(); t00DevelopmentDataD();";
    let files = BTreeMap::from([(path.to_string(), text.to_string())]);
    eprintln!(
        "ordinary_dev_input={}",
        serde_json::to_string(&files).unwrap()
    );
    crate::development::with_project(files, vec![path.to_string()], move || {
        let source = program::get_source_file(path);
        program::with_type_checker_for_file(source, move |checker| {
            let context = ExtractionContext {
                repository_root: "/repo",
                static_module_links: true,
                retained: true,
                javascript_enabled: false,
                captured_files: None,
                case_sensitive: true,
            };
            let statements = source.statements();
            assert_eq!(
                retained_function_owner_coordinate(statements.get(0), "/repo"),
                Some((
                    "t00DevelopmentCoordinatesD.ts".into(),
                    "t00DevelopmentCallableD".into()
                ))
            );
            assert_eq!(
                retained_function_owner_coordinate(statements.get(1), "/repo"),
                None
            );
            let mut endpoints = Vec::new();
            for statement in statements.iter().skip(4) {
                endpoints.push(retained_callable_coordinate(
                    statement.expression().expression(),
                    checker,
                    &context,
                ));
            }
            assert_eq!(
                endpoints,
                vec![
                    Some((
                        "t00DevelopmentCoordinatesD.ts".into(),
                        "t00DevelopmentCallableD".into()
                    )),
                    Some((
                        "t00DevelopmentCoordinatesD.ts".into(),
                        "t00DevelopmentArrowD".into()
                    )),
                    None
                ]
            );
        });
    });
}

#[test]
fn development_namespace_uses_real_receiver_and_static_members_only() {
    let result = development_extract(BTreeMap::from([
            ("/repo/t00DevelopmentNamespaceLeafE.ts".into(), "export function t00DevelopmentUsedE() {} export function t00DevelopmentUnusedE() {} export const t00DevelopmentValueE = 67;".into()),
            ("/repo/t00DevelopmentNamespaceCallerE.ts".into(), "import * as t00DevelopmentNamespaceE from './t00DevelopmentNamespaceLeafE'; import type * as t00DevelopmentTypesE from './t00DevelopmentNamespaceLeafE'; type t00DevelopmentTypeE = typeof t00DevelopmentTypesE.t00DevelopmentUnusedE; export function t00DevelopmentCallerE() { t00DevelopmentNamespaceE.t00DevelopmentUsedE(); const { t00DevelopmentUsedE: t00DevelopmentAliasE } = t00DevelopmentNamespaceE; t00DevelopmentNamespaceE['t00DevelopmentValueE']; t00DevelopmentNamespaceE.t00DevelopmentValueE; } function t00DevelopmentShadowE(t00DevelopmentNamespaceE: { t00DevelopmentUnusedE(): void }) { t00DevelopmentNamespaceE.t00DevelopmentUnusedE(); }".into()),
        ]), "t00DevelopmentNamespaceCallerE.ts");
    let targets = result.imports[0].binding_targets.as_ref().unwrap();
    assert_eq!(
        targets
            .iter()
            .map(|target| target.symbol_path.as_str())
            .collect::<Vec<_>>(),
        vec![
            "t00DevelopmentUsedE",
            "t00DevelopmentUsedE",
            "t00DevelopmentValueE"
        ]
    );
    assert!(targets.iter().all(|target| target.runtime_used.is_none()));
    assert_eq!(
        targets[2].unmodeled_reason.as_deref(),
        Some("VALUE_DECLARATION")
    );
    assert_eq!(result.imports[1].binding_targets, Some(Vec::new()));
    assert!(result.imports[1].names.is_empty());
}

#[test]
fn development_ambiguous_namespace_does_not_create_binding_targets() {
    let result = development_extract(BTreeMap::from([
            ("/repo/t00DevelopmentFirstF.ts".into(), "export function t00DevelopmentStarF() { return 71; }".into()),
            ("/repo/t00DevelopmentSecondF.ts".into(), "export function t00DevelopmentStarF() { return 73; }".into()),
            ("/repo/t00DevelopmentBarrelF.ts".into(), "export * from './t00DevelopmentFirstF'; export * from './t00DevelopmentSecondF';".into()),
            ("/repo/t00DevelopmentCallerF.ts".into(), "import * as t00DevelopmentNamespaceF from './t00DevelopmentBarrelF'; const { t00DevelopmentStarF: t00DevelopmentAliasF } = t00DevelopmentNamespaceF; t00DevelopmentNamespaceF.t00DevelopmentStarF();".into()),
        ]), "t00DevelopmentCallerF.ts");
    assert_eq!(result.imports[0].binding_targets, Some(Vec::new()));
    assert_eq!(result.calls.len(), 1);
    assert!(result.calls[0].callee_rel_path.is_none());
}

#[test]
fn development_exported_nested_array_holes_preserve_explicit_names() {
    let files = BTreeMap::from([
            ("/repo/t00HoleLeftDev.ts".into(), "export const t00HoleKeepDev = 241; export const t00HoleNestedDev = 251; export const t00HoleRestDev = 257;".into()),
            ("/repo/t00HoleRightDev.ts".into(), "export const t00HoleKeepDev = 263; export const t00HoleNestedDev = 269; export const t00HoleRestDev = 271;".into()),
            ("/repo/t00HoleEntryDev.ts".into(), "export * from './t00HoleLeftDev'; export * from './t00HoleRightDev'; export const [, { branch: [, t00HoleNestedDev] }, ...t00HoleRestDev] = [0, { branch: [0, 277] }, 281];".into()),
        ]);
    let roots = files.keys().cloned().collect();
    let reasons = crate::development::with_project(files, roots, || {
        let source = program::get_source_file("/repo/t00HoleEntryDev.ts");
        program::with_type_checker_for_file(source, move |checker| {
            export_ambiguities(source, checker)
        })
    });
    assert_eq!(reasons, vec!["t00HoleKeepDev"]);
}

#[test]
fn development_overloads_scopes_ranges_and_explicit_markers() {
    let result = development_extract(BTreeMap::from([("/repo/t00DevelopmentMetadataG.ts".into(), "\u{feff}const t00DevelopmentAstralG = '🦀';\r\n/** @capability t00Development-G: exact author text */\r\nexport function t00DevelopmentOverloadG(value: string): string;\r\nexport function t00DevelopmentOverloadG(value: unknown) { return String(value); }\r\nclass t00DevelopmentClassG { t00DevelopmentMethodG() { function t00DevelopmentInnerG() {} t00DevelopmentInnerG(); } }\r\n".into())]), "t00DevelopmentMetadataG.ts");
    assert_eq!(
        result
            .symbols
            .iter()
            .map(|symbol| symbol.name.as_str())
            .collect::<Vec<_>>(),
        vec![
            "t00DevelopmentOverloadG",
            "t00DevelopmentOverloadG",
            "t00DevelopmentClassG",
            "t00DevelopmentInnerG"
        ]
    );
    assert_eq!(result.symbols[0].signature_only, Some(true));
    assert_eq!(result.symbols[1].signature_only, None);
    assert_eq!(
        (result.symbols[0].start_line, result.symbols[0].end_line),
        (3, 3)
    );
    assert_eq!(
        result.symbols[3].scope,
        vec!["t00DevelopmentClassG", "t00DevelopmentMethodG"]
    );
    assert_eq!(
        result.calls.last().unwrap().callee_symbol_path.as_deref(),
        Some("t00DevelopmentClassG.t00DevelopmentMethodG.t00DevelopmentInnerG")
    );
    assert_eq!(
        result.calls.last().unwrap().caller_symbol_path.as_deref(),
        Some("t00DevelopmentClassG")
    );
    assert_eq!(
        result.symbols[0].markers,
        vec![Marker {
            tag: "capability".into(),
            slug: "t00Development-G".into(),
            statement: Some("exact author text".into())
        }]
    );
    assert!(result.symbols[1].markers.is_empty());
}

#[test]
fn development_class_extends_is_runtime_read_and_type_reference_is_not() {
    let result = development_extract(BTreeMap::from([
            ("/repo/t00DevelopmentBaseH.ts".into(), "export class t00DevelopmentBaseH {}".into()),
            ("/repo/t00DevelopmentDerivedH.ts".into(), "import { t00DevelopmentBaseH } from './t00DevelopmentBaseH'; import { t00DevelopmentBaseH as t00DevelopmentTypeAliasH } from './t00DevelopmentBaseH'; class t00DevelopmentDerivedH extends t00DevelopmentBaseH {} type t00DevelopmentTypeH = t00DevelopmentTypeAliasH;".into()),
        ]), "t00DevelopmentDerivedH.ts");
    assert_eq!(
        result.imports[0].binding_targets.as_ref().unwrap()[0].runtime_used,
        None
    );
    assert_eq!(
        result.imports[1].binding_targets.as_ref().unwrap()[0].runtime_used,
        Some(false)
    );
}

#[test]
fn development_declaration_companion_requires_captured_runtime_file() {
    for present in [true, false] {
        let mut files = BTreeMap::from([
                ("/repo/t00DevelopmentRuntimeI.d.mts".into(), "export declare function t00DevelopmentRuntimeI(): number;".into()),
                ("/repo/t00DevelopmentCallerI.mjs".into(), "import { t00DevelopmentRuntimeI } from './t00DevelopmentRuntimeI.mjs'; export function t00DevelopmentCallerI() { return t00DevelopmentRuntimeI(); }".into()),
            ]);
        if present {
            files.insert(
                "/repo/t00DevelopmentRuntimeI.mjs".into(),
                "export function t00DevelopmentRuntimeI() { return 79; }".into(),
            );
        }
        let result = development_extract(files, "t00DevelopmentCallerI.mjs");
        assert_eq!(
            result.imports[0].resolved_rel_path.as_deref(),
            Some(if present {
                "t00DevelopmentRuntimeI.mjs"
            } else {
                "t00DevelopmentRuntimeI.d.mts"
            })
        );
        assert_eq!(
            result.calls[0].callee_rel_path.as_deref(),
            present.then_some("t00DevelopmentRuntimeI.mjs")
        );
        assert_eq!(
            result.calls[0].callee_symbol_path.as_deref(),
            Some("t00DevelopmentRuntimeI")
        );
    }
}

#[test]
fn development_declaration_only_endpoint_keeps_symbol_without_value_reason() {
    let result = development_extract(BTreeMap::from([
            ("/repo/t00DevelopmentDeclarationJ.d.ts".into(), "export declare const t00DevelopmentDeclaredJ: () => number;".into()),
            ("/repo/t00DevelopmentCallerJ.ts".into(), "import { t00DevelopmentDeclaredJ } from './t00DevelopmentDeclarationJ'; t00DevelopmentDeclaredJ();".into()),
        ]), "t00DevelopmentCallerJ.ts");
    assert_eq!(result.calls.len(), 1);
    assert_eq!(
        result.calls[0].callee_symbol_path.as_deref(),
        Some("t00DevelopmentDeclaredJ")
    );
    assert_eq!(result.calls[0].callee_rel_path, None);
    assert_eq!(result.calls[0].callee_unmodeled_reason, None);
}

#[test]
fn development_arrow_has_own_scope_and_data_has_no_callable_symbol() {
    let path = "/repo/t00DevelopmentOrdinaryA.ts";
    let text = "export const t00DevelopmentArrowA = () => { function t00DevelopmentInnerA() {} return t00DevelopmentInnerA(); }; export const t00DevelopmentDataA = 43;";
    eprintln!(
        "ordinary_dev_input={}",
        serde_json::to_string(&BTreeMap::from([(path.to_owned(), text.to_owned())])).unwrap()
    );
    crate::development::with_project(
        BTreeMap::from([(path.to_owned(), text.to_owned())]),
        vec![path.to_owned()],
        || {
            let source = program::get_source_file(path);
            let result = program::with_type_checker_for_file(source, move |checker| {
                extract(
                    source,
                    checker,
                    "t00DevelopmentOrdinaryA.ts",
                    &ExtractionContext {
                        repository_root: "/repo",
                        static_module_links: true,
                        retained: true,
                        javascript_enabled: false,
                        captured_files: None,
                        case_sensitive: true,
                    },
                )
            })
            .unwrap();
            assert_eq!(result.symbols.len(), 2);
            assert_eq!(result.symbols[0].name, "t00DevelopmentArrowA");
            assert_eq!(result.symbols[0].scope, Vec::<String>::new());
            assert_eq!(result.symbols[1].name, "t00DevelopmentInnerA");
            assert_eq!(result.symbols[1].scope, vec!["t00DevelopmentArrowA"]);
            assert!(
                !result
                    .symbols
                    .iter()
                    .any(|symbol| symbol.name == "t00DevelopmentDataA")
            );
        },
    );
}
