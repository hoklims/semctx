
use super::*;

fn observe(text: &str, retained: bool, configuration: Option<&str>) -> serde_json::Value {
    observe_files(text, retained, configuration, BTreeMap::new())
}
fn observe_files(
    text: &str,
    retained: bool,
    configuration: Option<&str>,
    additional: BTreeMap<String, String>,
) -> serde_json::Value {
    let mut files: BTreeMap<String, String> =
        BTreeMap::from([("/repo/t00JavascriptFullDev.js".into(), text.into())]);
    files.extend(additional);
    if let Some(configuration) = configuration {
        files.insert("/repo/tsconfig.json".into(), configuration.into());
    }
    let request: Request = serde_json::from_value(serde_json::json!({
            "id":"t00JavascriptFullDev", "cwd":"/repo", "sdk_directory":"/sdk/lib",
            "case_sensitive":ts_goport::frontend::vfs::osvfs_fs().use_case_sensitive_file_names(),
            "roots":["/repo/t00JavascriptFullDev.js"], "files":files, "retained":retained,
            "options":{"target":"ES2022","module":"ESNext","moduleResolution":"Bundler","allowJs":true,"jsx":"Preserve","skipLibCheck":true,"noEmit":true,"strict":false}
        })).unwrap();
    let sdk: Sdk = serde_json::from_slice(
        &std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/sdk/sdk-input.json")).unwrap(),
    )
    .unwrap();
    analyze(request, sdk).unwrap()["subjects"][0].clone()
}

#[test]
fn ordinary_javascript_links_use_captured_dependencies_and_declared_external_packages() {
    for (specifier, files, resolution) in [
        (
            "./t00DependencyDev.js",
            BTreeMap::from([(
                "/repo/t00DependencyDev.js".into(),
                "export const dependencyDev = 409;".into(),
            )]),
            "resolved",
        ),
        (
            "t00-external-dev",
            BTreeMap::from([(
                "/repo/package.json".into(),
                r#"{"dependencies":{"t00-external-dev":"1.0.0"}}"#.into(),
            )]),
            "external",
        ),
    ] {
        let source = format!("import '{specifier}'; export const t00LinkDev = 419;");
        let observed = observe_files(&source, false, None, files);
        let operation = &observed["javascriptObservation"];
        assert_eq!(operation["executed"], true);
        assert_eq!(operation["unsupported"], serde_json::json!([]));
        assert_eq!(
            operation["staticModuleLinks"],
            serde_json::json!([{"specifier":specifier,"resolution":resolution}])
        );
        assert!(
            !operation["reasons"]
                .as_array()
                .unwrap()
                .contains(&serde_json::json!(format!(
                    "JAVASCRIPT_IMPORT_UNRESOLVED:{specifier}"
                )))
        );
    }
}

#[test]
fn javascript_operation_preserves_retained_and_ordinary_configuration_boundaries() {
    for retained in [false, true] {
        let subject = observe(
            "export default 293;",
            retained,
            Some(r#"{"compilerOptions":{"module":"CommonJS","moduleResolution":"Node10"}}"#),
        );
        let observation = &subject["javascriptObservation"];
        assert_eq!(observation["executed"], true);
        assert_eq!(observation["parseFailed"], false);
        assert_eq!(observation["unsupported"], serde_json::json!([]));
        let expected = if retained {
            serde_json::json!([
                "JAVASCRIPT_DEFAULT_EXPRESSION_UNSUPPORTED",
                "SOURCE_CONFIGURATION_MODULE_UNSUPPORTED:CommonJS",
                "SOURCE_CONFIGURATION_RESOLUTION_UNSUPPORTED:Node10",
                "SOURCE_DEFAULT_EXPRESSION_UNSUPPORTED"
            ])
        } else {
            serde_json::json!(["JAVASCRIPT_DEFAULT_EXPRESSION_UNSUPPORTED"])
        };
        assert_eq!(observation["reasons"], expected);
        assert_eq!(
            observation["staticExports"],
            serde_json::json!([{"name":"default","declarationKind":"expression"}])
        );
    }
}

#[test]
fn javascript_operation_uses_transpilation_diagnostics_for_js_type_syntax() {
    let subject = observe(
        "export const t00JavascriptTypedDev: number = 307;",
        true,
        None,
    );
    let observation = &subject["javascriptObservation"];
    assert_eq!(observation["executed"], true);
    assert_eq!(observation["parseFailed"], true);
    assert_eq!(subject["outcome"], "failed");
    assert_eq!(observation["unsupported"], serde_json::json!([]));
    assert_eq!(
        observation["reasons"],
        serde_json::json!([
            "JAVASCRIPT_PARSE_ERROR:8010:Type annotations can only be used in TypeScript files."
        ])
    );
}

#[test]
fn javascript_operation_composes_semantic_native_and_resolution_reasons() {
    for retained in [false, true] {
        let generator = observe(
            "export function* t00JavascriptGeneratorDev(){ yield 317; }",
            retained,
            None,
        );
        let expected = if retained {
            serde_json::json!([
                "JAVASCRIPT_ITERATION_UNSUPPORTED",
                "SOURCE_ITERATION_UNSUPPORTED"
            ])
        } else {
            serde_json::json!(["JAVASCRIPT_ITERATION_UNSUPPORTED"])
        };
        assert_eq!(generator["javascriptObservation"]["reasons"], expected);
        assert_eq!(
            generator["javascriptObservation"]["unsupported"],
            serde_json::json!([])
        );
        let loader = observe("const t00JavascriptLoaderDev = require;", retained, None);
        let expected = if retained {
            serde_json::json!([
                "JAVASCRIPT_COMMONJS_UNSUPPORTED",
                "SOURCE_COMMONJS_UNSUPPORTED"
            ])
        } else {
            serde_json::json!(["JAVASCRIPT_COMMONJS_UNSUPPORTED"])
        };
        assert_eq!(loader["javascriptObservation"]["reasons"], expected);
        assert_eq!(
            loader["javascriptObservation"]["unsupported"],
            serde_json::json!([])
        );
        assert_eq!(loader["javascript"]["native"]["commonJsUnsupported"], true);
        let missing = observe(
            "import { t00MissingDev } from './t00JavascriptAbsentDev.js'; export { t00MissingDev };",
            retained,
            None,
        );
        assert_eq!(
            missing["javascriptObservation"]["reasons"],
            serde_json::json!(["JAVASCRIPT_IMPORT_UNRESOLVED:./t00JavascriptAbsentDev.js"])
        );
        assert_eq!(
            missing["javascriptObservation"]["unsupported"],
            serde_json::json!([])
        );
        assert_eq!(
            missing["javascriptObservation"]["staticModuleLinks"],
            serde_json::json!([{"specifier":"./t00JavascriptAbsentDev.js","resolution":"unresolved"}])
        );
    }
}

#[test]
fn javascript_operation_does_not_add_explicit_source_scope_refusal() {
    let subject = observe("const t00JavascriptScriptDev = 311;", true, None);
    let observation = &subject["javascriptObservation"];
    assert_eq!(observation["executed"], true);
    assert_eq!(observation["parseFailed"], false);
    assert_eq!(observation["reasons"], serde_json::json!([]));
    assert_eq!(observation["unsupported"], serde_json::json!([]));
    assert_eq!(
        subject["moduleConfigurationObservations"]["retainedWithSource"]["reasons"],
        serde_json::json!(["SOURCE_GLOBAL_SCRIPT_UNSUPPORTED"])
    );
}
