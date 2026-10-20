
use super::*;
fn config() -> Config {
    serde_json::from_value(serde_json::json!({"version":2,"include":["**/*"],"exclude":[],"languages":{"typescript":"on","javascript":"on"},"migrationsDirs":["migrations"]})).unwrap()
}
#[test]
fn native_discovery_test_import_role_preserves_whitespace_rule() {
    assert_eq!(
        role(
            "src/guard.ts",
            "import {test} from\n\t\"vitest\";",
            &config()
        ),
        "test"
    );
    assert_eq!(
        role(
            "src/guard.ts",
            "import {test} from   'node:test';",
            &config()
        ),
        "test"
    );
    assert_eq!(
        role(
            "src/guard.ts",
            "import {factory} from './vitest';",
            &config()
        ),
        "source"
    );
}
#[test]
fn native_discovery_refuses_invalid_descriptors_and_unavailable_roots() {
    let descriptor = serde_json::json!({"repositoryRoot":"/t00-never-created-root-f18","config":{"version":2,"include":["**/*"],"exclude":[],"languages":{"typescript":"on"},"migrationsDirs":["migrations"]}});
    for (pointer, value, expected) in [
        (
            "/config/version",
            serde_json::json!(99),
            "DISCOVERY_CONFIG_VERSION_UNSUPPORTED",
        ),
        (
            "/config/languages",
            serde_json::json!({"foreign":"on"}),
            "DISCOVERY_LANGUAGE_UNKNOWN",
        ),
        (
            "/config/include",
            serde_json::json!(["[abc"]),
            "DISCOVERY_INVALID_GLOB_CLASS",
        ),
        (
            "/config/include",
            serde_json::json!(["{abc"]),
            "DISCOVERY_INVALID_GLOB_BRACES",
        ),
        (
            "/config/include",
            serde_json::json!(["@(src)/*"]),
            "DISCOVERY_UNSUPPORTED_GLOB_EXTGROUP",
        ),
        (
            "/repositoryRoot",
            serde_json::json!("/t00-never-created-root-f18"),
            "DISCOVERY_REPOSITORY_UNAVAILABLE:",
        ),
    ] {
        let mut input = descriptor.clone();
        *input.pointer_mut(pointer).unwrap() = value;
        let result = run(input);
        assert_eq!(result["executed"], false);
        assert!(
            result["unsupported"][0]
                .as_str()
                .unwrap()
                .starts_with(expected),
            "{pointer}:{result}"
        );
    }
    for value in [
        serde_json::Value::Null,
        serde_json::json!({}),
        serde_json::json!({"repositoryRoot":false,"config":{}}),
        serde_json::json!({"repositoryRoot":".","config":{},"foreign":true}),
    ] {
        let result = run(value);
        assert_eq!(result["executed"], false);
        assert!(
            result["unsupported"][0]
                .as_str()
                .unwrap()
                .starts_with("DISCOVERY_REQUEST_INVALID:")
        );
    }
}
