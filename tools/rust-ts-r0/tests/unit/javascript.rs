
use super::*;
use std::collections::BTreeMap;
use ts_goport::program;

fn run(text: &'static str, path: &'static str, retained: bool) -> JavascriptScan {
    crate::development::with_project(
        BTreeMap::from([(path.into(), text.into())]),
        vec![path.into()],
        move || {
            let source = program::get_source_file(path);
            program::with_type_checker_for_file(source, move |checker| {
                inspect(source, checker, path, retained)
            })
        },
    )
}

#[test]
fn javascript_source_observation_preserves_unavailable_dependency_as_unsupported() {
    for executed in [false, true] {
        let observed = crate::development::with_project(
            BTreeMap::from([(
                "/repo/t00JavascriptUnknownDev.js".into(),
                "export const t00JavascriptUnknownDev = 331;".into(),
            )]),
            vec!["/repo/t00JavascriptUnknownDev.js".into()],
            || {
                let source = program::get_source_file("/repo/t00JavascriptUnknownDev.js");
                let configuration = crate::component_observations::Observation {
                    executed,
                    reasons: vec![],
                    unsupported: if executed {
                        BTreeSet::from(["NATIVE_DEVELOPMENT_CONFIGURATION_UNAVAILABLE".into()])
                    } else {
                        BTreeSet::new()
                    },
                };
                inspect_javascript_source(JavaScriptSourceInputs {
                    source,
                    path: "/repo/t00JavascriptUnknownDev.js",
                    native: &NativeBindings::default(),
                    semantic: &crate::qualified::QualifiedScan::default(),
                    configuration: &configuration,
                    static_module_links: &serde_json::json!([]),
                    unsupported: &BTreeSet::new(),
                })
            },
        );
        assert!(observed.executed);
        assert_eq!(observed.parse_failed, Some(false));
        assert!(observed.reasons.is_empty());
        assert_eq!(
            observed.unsupported,
            BTreeSet::from([if executed {
                "NATIVE_DEVELOPMENT_CONFIGURATION_UNAVAILABLE".into()
            } else {
                "NATIVE_JAVASCRIPT_CONFIGURATION_NOT_EXECUTED".into()
            }])
        );
    }
}

#[test]
fn ambient_loader_alias_is_refused_while_a_local_homonym_is_owned() {
    let ambient = run(
        "const loader = require; export function invoke(){return loader('node:fs');}",
        "/repo/native-dev.mjs",
        true,
    );
    assert!(ambient.native.common_js_unsupported);
    let local = run(
        "function require(name){return name;} export function invoke(){return require('owned');}",
        "/repo/native-dev.mjs",
        true,
    );
    assert!(!local.native.common_js_unsupported);
}
#[test]
fn unused_or_type_only_module_bindings_are_not_loader_uses() {
    let unused = run(
        "import {createRequire as build} from 'node:module'; export const value=1;",
        "/repo/native-dev.mjs",
        true,
    );
    assert!(!unused.native.common_js_unsupported);
    let type_only = run(
        "import type {createRequire as Build} from 'node:module'; export type Shape=Build;",
        "/repo/native-dev.ts",
        true,
    );
    assert!(!type_only.native.common_js_unsupported);
    let used = run(
        "import {createRequire as build} from 'node:module'; const loader=build(import.meta.url); export {loader};",
        "/repo/native-dev.mjs",
        true,
    );
    assert!(used.native.common_js_unsupported);
}

#[test]
fn namespace_origins_distinguish_ordinary_members_from_escaping_objects() {
    let ordinary = run(
        "const native = await import('node:module'); export const check=native.isBuiltin('node:fs');",
        "/repo/native-dev.mjs",
        true,
    );
    assert!(!ordinary.native.common_js_unsupported);
    assert!(ordinary.native.unmodeled_members.is_empty());
    let escaped = run(
        "const native = await import('node:module'); export const box={native};",
        "/repo/native-dev.mjs",
        true,
    );
    assert!(escaped.native.common_js_unsupported);
    let exported = run(
        "import * as native from 'node:module'; export {native};",
        "/repo/native-dev.mjs",
        true,
    );
    assert!(exported.native.common_js_unsupported);
}

#[test]
fn process_getter_is_unmodeled_without_claiming_commonjs_and_local_shadow_is_owned() {
    let getter = run(
        "export const getter=process.getBuiltinModule;",
        "/repo/native-dev.mjs",
        true,
    );
    assert_eq!(
        getter.native.unmodeled_members,
        vec!["process.getBuiltinModule"]
    );
    assert!(!getter.native.common_js_unsupported);
    let ordinary = run(
        "export const version=process.versions;",
        "/repo/native-dev.mjs",
        true,
    );
    assert!(ordinary.native.unmodeled_members.is_empty());
    let shadow = run(
        "const process={getBuiltinModule(){return 1;}}; export const getter=process.getBuiltinModule;",
        "/repo/native-dev.mjs",
        true,
    );
    assert!(shadow.native.unmodeled_members.is_empty());
}

#[test]
fn browser_and_global_evaluator_aliases_preserve_shadowing() {
    let evaluator = run(
        "const evaluate=globalThis.eval; export const value=evaluate('1');",
        "/repo/native-dev.mjs",
        true,
    );
    assert_eq!(evaluator.native.runtime_evaluation_unsupported, Some(true));
    let browser = run(
        "export const value=window[key];",
        "/repo/native-dev.mjs",
        true,
    );
    assert_eq!(browser.native.runtime_evaluation_unsupported, Some(true));
    let shadow = run(
        "export function owned(globalThis){return globalThis.eval('owned');}",
        "/repo/native-dev.mjs",
        true,
    );
    assert_eq!(shadow.native.runtime_evaluation_unsupported, None);
    let ambient = run(
        "export const value=globalThis[key];",
        "/repo/native-dev.mjs",
        true,
    );
    assert_eq!(ambient.native.unmodeled_members, vec!["ambient-global"]);
}

#[test]
fn destructured_and_reexported_native_members_keep_closed_origins() {
    let factory = run(
        "import * as native from 'node:module'; const {createRequire:build}=native; export const loader=build(import.meta.url);",
        "/repo/native-dev.mjs",
        true,
    );
    assert!(factory.native.common_js_unsupported);
    let process = run(
        "export * from 'node:process';",
        "/repo/native-dev.mjs",
        true,
    );
    assert_eq!(
        process.native.unmodeled_members,
        vec!["process.getBuiltinModule"]
    );
    let ordinary = run(
        "export {isBuiltin} from 'node:module';",
        "/repo/native-dev.mjs",
        true,
    );
    assert!(!ordinary.native.common_js_unsupported);
    assert!(ordinary.native.unmodeled_members.is_empty());
}

#[test]
fn semantic_jsdoc_imports_are_ast_nodes_not_prose_substrings() {
    let typed = run(
        "/** @type {import('opaque').Shape} */ export let value;",
        "/repo/native-dev.js",
        true,
    );
    assert!(
        typed
            .reasons
            .contains(&"JAVASCRIPT_JSDOC_IMPORT_UNSUPPORTED".into())
    );
    assert!(
        typed
            .reasons
            .contains(&"SOURCE_JSDOC_IMPORT_UNSUPPORTED".into())
    );
    let prose = run(
        "/** prose mentions import('opaque') without a type tag */ export let value;",
        "/repo/native-dev.js",
        true,
    );
    assert!(
        !prose
            .reasons
            .contains(&"JAVASCRIPT_JSDOC_IMPORT_UNSUPPORTED".into())
    );
    let typescript = run(
        "/** @type {import('opaque').Shape} */ export let value;",
        "/repo/native-dev.ts",
        true,
    );
    assert!(
        !typescript
            .reasons
            .contains(&"SOURCE_JSDOC_IMPORT_UNSUPPORTED".into())
    );
}

#[test]
fn javascript_static_exports_and_literal_links_leave_resolution_to_capture_owner() {
    let scan = run(
        "const local=1; export {local as exposed}; export {dep as forwarded} from 'opaque'; export * as names from 'opaque2'; export * from 'opaque3'; export const {nested}=object; export default function named(){}; import('./literal'); import(target); require('not-a-static-esm-link');",
        "/repo/native-dev.mjs",
        true,
    );
    assert_eq!(
        scan.static_exports
            .iter()
            .map(|e| e.name.as_str())
            .collect::<Vec<_>>(),
        vec!["*", "default", "exposed", "forwarded", "names"]
    );
    assert_eq!(
        scan.static_module_links
            .iter()
            .map(|e| e.specifier.as_str())
            .collect::<Vec<_>>(),
        vec!["opaque", "opaque2", "opaque3", "./literal"]
    );
    assert!(
        scan.reasons
            .contains(&"JAVASCRIPT_EXPORTED_DESTRUCTURING_UNSUPPORTED".into())
    );
    assert!(
        scan.reasons
            .contains(&"JAVASCRIPT_DYNAMIC_IMPORT_UNSUPPORTED".into())
    );
    assert!(
        !scan
            .reasons
            .iter()
            .any(|r| r.starts_with("JAVASCRIPT_IMPORT_UNRESOLVED"))
    );
}

#[test]
fn retained_source_and_javascript_diagnostics_keep_their_distinct_projections() {
    let ts = run(
        "export const value=(factory())(); tag`raw`;",
        "/repo/native-dev.ts",
        true,
    );
    assert!(
        ts.reasons
            .contains(&"SOURCE_DYNAMIC_CALL_UNSUPPORTED".into())
    );
    assert!(
        ts.reasons
            .contains(&"SOURCE_TAGGED_TEMPLATE_UNSUPPORTED".into())
    );
    let js = run(
        "export default (factory())(); tag`raw`;",
        "/repo/native-dev.mjs",
        true,
    );
    assert!(
        js.reasons
            .contains(&"JAVASCRIPT_DYNAMIC_CALL_UNSUPPORTED".into())
    );
    assert!(
        js.reasons
            .contains(&"JAVASCRIPT_TAGGED_TEMPLATE_UNSUPPORTED".into())
    );
    assert!(
        js.reasons
            .contains(&"SOURCE_TAGGED_TEMPLATE_UNSUPPORTED".into())
    );
    assert!(
        !js.reasons
            .contains(&"SOURCE_DYNAMIC_CALL_UNSUPPORTED".into())
    );
    assert!(
        js.reasons
            .contains(&"JAVASCRIPT_DEFAULT_EXPRESSION_UNSUPPORTED".into())
    );
    assert!(
        js.reasons
            .contains(&"SOURCE_DEFAULT_EXPRESSION_UNSUPPORTED".into())
    );
}

#[test]
fn qualified_module_scope_is_explicit_and_extension_modes_do_not_invent_exports() {
    let global = run("const value=1;", "/repo/native-dev.ts", true);
    assert_eq!(
        global.qualified_scope_reasons,
        vec!["SOURCE_GLOBAL_SCRIPT_UNSUPPORTED"]
    );
    assert!(
        !global
            .reasons
            .contains(&"SOURCE_GLOBAL_SCRIPT_UNSUPPORTED".into())
    );
    let cts = run(
        "export const value=1; declare global { interface Added {} } declare module 'augmented' {}",
        "/repo/native-dev.cts",
        true,
    );
    assert_eq!(
        cts.qualified_scope_reasons,
        vec![
            "SOURCE_COMMONJS_EXTENSION_UNSUPPORTED",
            "SOURCE_GLOBAL_AUGMENTATION_UNSUPPORTED",
            "SOURCE_MODULE_AUGMENTATION_UNSUPPORTED"
        ]
    );
    let module = run("const value=1;", "/repo/native-dev.mts", true);
    assert!(module.qualified_scope_reasons.is_empty());
}
#[test]
fn sdk_declarations_do_not_turn_ambient_evaluators_into_lexical_shadows() {
    fn sdk(text: &'static str) -> NativeBindings {
        crate::development::with_sdk_project(
            BTreeMap::from([("/repo/native-sdk-dev.mjs".into(), text.into())]),
            vec!["/repo/native-sdk-dev.mjs".into()],
            move || {
                let source = program::get_source_file("/repo/native-sdk-dev.mjs");
                program::with_type_checker_for_file(source, move |checker| {
                    inspect_native_module_bindings(source, checker)
                })
            },
        )
    }
    assert_eq!(
        sdk("export const evaluator=Function;").runtime_evaluation_unsupported,
        Some(true)
    );
    assert_eq!(
        sdk("const Function=value=>value; export const evaluator=Function;")
            .runtime_evaluation_unsupported,
        None
    );
}
#[test]
fn live_javascript_keeps_js_reasons_without_retained_source_diagnostics() {
    let scan = run(
        "export default value; tag`template`;",
        "/repo/native-dev.cjs",
        false,
    );
    assert!(
        scan.reasons
            .contains(&"JAVASCRIPT_DEFAULT_EXPRESSION_UNSUPPORTED".into())
    );
    assert!(
        scan.reasons
            .contains(&"JAVASCRIPT_TAGGED_TEMPLATE_UNSUPPORTED".into())
    );
    assert!(
        scan.reasons
            .contains(&"JAVASCRIPT_COMMONJS_UNSUPPORTED".into())
    );
    assert!(
        !scan
            .reasons
            .iter()
            .any(|reason| reason.starts_with("SOURCE_"))
    );
    assert_eq!(
        scan.qualified_scope_reasons,
        vec!["SOURCE_COMMONJS_EXTENSION_UNSUPPORTED"]
    );
}
