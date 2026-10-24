use super::*;

fn sdk() -> Sdk {
    serde_json::from_slice(include_bytes!("../../sdk/sdk-input.json")).unwrap()
}

#[test]
fn absent_optional_source_does_not_invent_source_or_named_configuration_reasons() {
    let observed = run(
        json!({"root":"/repo","source":"/repo/absent.ts","files":{"/repo/tsconfig.extra.json":"{}"}}),
        &sdk(),
    );
    assert_eq!(observed["executed"], true, "{observed}");
    assert_eq!(observed["source_available"], false);
    assert_eq!(observed["component"]["executed"], true);
    assert_eq!(observed["component"]["unsupported"], json!([]));
    assert_eq!(observed["component"]["reasons"], json!([]));
}

#[test]
fn absent_optional_source_keeps_parsed_configuration_policy() {
    let observed = run(
        json!({"root":"/repo","source":"/repo/absent.ts","files":{"/repo/tsconfig.json":"{\"compilerOptions\":{\"target\":\"ES2022\",\"module\":\"ES2015\",\"moduleResolution\":\"Bundler\"}}"}}),
        &sdk(),
    );
    assert_eq!(observed["executed"], true, "{observed}");
    assert_eq!(
        observed["component"]["reasons"],
        json!(["SOURCE_CONFIGURATION_MODULE_UNSUPPORTED:ES2015"])
    );
}

#[test]
fn optional_source_observation_refuses_unavailable_explicit_source_and_invalid_capture() {
    for (request, expected) in [
        (
            json!({"root":"/repo","source":"/repo/absent.ts","parsed_source":true,"files":{}}),
            "CONFIGURATION_SOURCE_ARGUMENT_TEXT_UNAVAILABLE",
        ),
        (
            json!({"root":"repo","source":"/repo/absent.ts","files":{}}),
            "CONFIGURATION_SOURCE_ABSOLUTE_PATHS_REQUIRED",
        ),
        (
            json!({"root":"/repo","source":"/repo/absent.ts","files":{"relative.ts":"export {};"}}),
            "CONFIGURATION_SOURCE_ABSOLUTE_FILES_REQUIRED",
        ),
    ] {
        let observed = run(request, &sdk());
        assert_eq!(observed["executed"], false, "{observed}");
        assert!(
            observed["unsupported"]
                .as_array()
                .unwrap()
                .iter()
                .any(|reason| {
                    reason
                        .as_str()
                        .is_some_and(|reason| reason.starts_with(expected))
                }),
            "{observed}"
        );
    }
}

#[test]
fn ordinary_explicit_source_keeps_default_expression_without_retained_policies() {
    let observed = run(
        json!({"root":"/repo","source":"/repo/main.ts","files":{"/repo/main.ts":"export default 1;","/repo/tsconfig.extra.json":"{}"},"parsed_source":true,"retained":false}),
        &sdk(),
    );
    assert_eq!(observed["executed"], true, "{observed}");
    assert_eq!(observed["component"]["executed"], true);
    assert_eq!(
        observed["component"]["reasons"],
        json!(["SOURCE_DEFAULT_EXPRESSION_UNSUPPORTED"])
    );
}

#[test]
fn available_optional_source_returns_the_actual_analysis_read_probes() {
    let observed = run(
        json!({"root":"/repo","source":"/repo/main.ts","files":{"/repo/main.ts":"export const value=1;"}}),
        &sdk(),
    );
    assert_eq!(observed["executed"], true, "{observed}");
    assert!(
        observed["probes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|probe| probe["operation"] == "read_file"
                && probe["path"] == "/repo/main.ts"
                && probe["found"] == true)
    );
}
