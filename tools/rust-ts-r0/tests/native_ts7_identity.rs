use semctx_r0_probe::primitive_observations::handle_observation;
use serde_json::{Value, json};
use std::{
    fs,
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};

struct Fixture {
    base: PathBuf,
    root: PathBuf,
    sdk: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let base = std::env::temp_dir().join(format!(
            "native-ts7-identity-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let root = base.join("repository");
        let sdk = base.join("sdk");
        for (path, text) in [
            ("bun.lock", "{}"),
            ("tsconfig.json", "{}"),
            ("tsconfig.base.json", "{}"),
            ("scripts/analyzer-identity.ts", "export {};"),
            ("scripts/build-plugin-runtime.ts", "export {};"),
            ("scripts/build-cli-package.ts", "export {};"),
            ("packages/sample/package.json", "{}"),
            ("packages/sample/src/value.ts", "export const value=1;"),
            ("packages/sample/src/value.js", "export const value=2;"),
            ("packages/sample/src/value.mjs", "export const value=3;"),
            ("apps/cli/package.json", "{}"),
            ("apps/cli/src/value.ts", "export {};"),
        ] {
            let path = root.join(path);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, text).unwrap();
        }
        fs::create_dir_all(sdk.join("lib")).unwrap();
        fs::write(sdk.join("package.json"), r#"{"name":"ts_goport","version":"7.1.0-dev","sourceRevision":"780dc512d64f40afebffa6a7028207649fb7ed1c"}"#).unwrap();
        fs::write(sdk.join("lib/tsgo"), b"native compiler byte fixture").unwrap();
        let input: Value = serde_json::from_str(include_str!("../sdk/sdk-input.json")).unwrap();
        for (path, bytes) in input["files"].as_object().unwrap() {
            fs::write(
                sdk.join(path.strip_prefix("/sdk/").unwrap()),
                bytes.as_str().unwrap(),
            )
            .unwrap();
        }
        Self { base, root, sdk }
    }

    fn observe(&self) -> Value {
        handle_observation(json!({"operation":"native_analyzer_identity","repository_root":self.root,"compiler_package_root":self.sdk})).expect("TS7 native identity operation must be supported")
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.base).unwrap();
    }
}

#[test]
fn explicit_ts7_identity_acquires_native_entry_and_complete_sdk_separately_from_ts5() {
    let fixture = Fixture::new();
    let observed = fixture.observe();
    assert_eq!(observed["identity_success"], true, "{observed}");
    assert_eq!(observed["identity"]["compiler"]["version"], "7.1.0-dev");
    assert_eq!(
        observed["identity"]["compiler"]["sourceRevision"],
        "780dc512d64f40afebffa6a7028207649fb7ed1c"
    );
    assert_eq!(observed["identity"]["schemaVersion"], 2);
    for path in [
        "packages/sample/src/value.js",
        "packages/sample/src/value.mjs",
    ] {
        assert!(
            observed["identity"]["files"]
                .as_array()
                .unwrap()
                .iter()
                .any(|file| file["path"] == path)
        );
    }
    assert_eq!(
        observed["compiler_inputs"]["libraries"]
            .as_array()
            .unwrap()
            .len(),
        116
    );
    assert!(
        observed["reads"]
            .as_array()
            .unwrap()
            .iter()
            .any(|read| read["path"] == "lib/tsgo")
    );
    assert_eq!(observed["compiler_executed"], false);
    assert_eq!(observed["sdk_payload_authenticated"], false);
    assert_eq!(observed["global_admission_inferred"], false);
    let historical = handle_observation(json!({"operation":"baseline_analyzer_identity","repository_root":fixture.root,"compiler_package_root":fixture.sdk})).unwrap();
    assert_eq!(historical["error"], "LEGACY_IDENTITY_SDK_VERSION_MISMATCH");
}

#[test]
fn native_identity_rejects_malformed_descriptors_before_acquisition() {
    for request in [
        json!({"operation":"native_analyzer_identity","repository_root":null,"compiler_package_root":"/unused"}),
        json!({"operation":"native_analyzer_identity","repository_root":"/unused","compiler_package_root":[]}),
        json!({"operation":"native_analyzer_identity","compiler_package_root":"/unused"}),
        json!({"operation":"native_analyzer_identity","repository_root":"/unused","compiler_package_root":"/unused","fallback":true}),
    ] {
        let error = handle_observation(request).unwrap_err();
        assert!(error.starts_with("PRIMITIVE_INVALID_REQUEST:"), "{error}");
    }
}

#[test]
fn native_identity_is_relocation_stable_and_binds_source_entry_package_and_library_bytes() {
    let original = Fixture::new();
    let expected = original.observe();
    for relative in [
        "packages/sample/src/value.ts",
        "lib/tsgo",
        "lib/lib.d.ts",
        "package.json",
    ] {
        let relocated = Fixture::new();
        assert_eq!(relocated.observe()["identity"], expected["identity"]);
        let source = relative.starts_with("packages/");
        let path = if source {
            &relocated.root
        } else {
            &relocated.sdk
        }
        .join(relative);
        let mut bytes = fs::read(&path).unwrap();
        bytes.push(b' ');
        fs::write(path, bytes).unwrap();
        let changed = relocated.observe();
        assert_eq!(changed["identity_success"], true, "{relative}: {changed}");
        assert_ne!(
            changed["identity"]["digest"],
            expected["identity"]["digest"]
        );
        if source {
            assert_eq!(
                changed["identity"]["compiler"],
                expected["identity"]["compiler"]
            );
        } else {
            assert_eq!(changed["identity"]["files"], expected["identity"]["files"]);
            assert_ne!(
                changed["identity"]["compiler"]["digest"],
                expected["identity"]["compiler"]["digest"]
            );
        }
    }
}

#[test]
fn native_identity_refuses_incomplete_foreign_and_unreadable_inputs_without_fallback() {
    for (relative, replacement, error) in [
        ("package.json", Some("{"), "NATIVE_IDENTITY_SDK_INVALID:"),
        (
            "package.json",
            Some(
                r#"{"name":"typescript","version":"5.9.3","sourceRevision":"780dc512d64f40afebffa6a7028207649fb7ed1c"}"#,
            ),
            "NATIVE_IDENTITY_SDK_VERSION_MISMATCH",
        ),
        (
            "package.json",
            Some(r#"{"name":"ts_goport","version":"7.1.0-dev","sourceRevision":"foreign"}"#),
            "NATIVE_IDENTITY_SDK_VERSION_MISMATCH",
        ),
        (
            "package.json",
            None,
            "NATIVE_IDENTITY_READ_FAILED:package.json:",
        ),
        ("lib/tsgo", None, "NATIVE_IDENTITY_READ_FAILED:lib/tsgo:"),
        (
            "lib/lib.d.ts",
            None,
            "NATIVE_IDENTITY_SDK_INVENTORY_MISMATCH:",
        ),
        (
            "lib/lib.foreign.d.ts",
            Some(""),
            "NATIVE_IDENTITY_SDK_INVENTORY_MISMATCH:",
        ),
    ] {
        let fixture = Fixture::new();
        let path = fixture.sdk.join(relative);
        if let Some(bytes) = replacement {
            fs::write(path, bytes).unwrap();
        } else {
            fs::remove_file(path).unwrap();
        }
        let observed = fixture.observe();
        assert_eq!(observed["identity_success"], false, "{observed}");
        assert!(
            observed["error"].as_str().unwrap().starts_with(error),
            "{observed}"
        );
        assert!(observed.get("identity").is_none());
    }
    let fixture = Fixture::new();
    let missing = handle_observation(
        json!({"operation":"native_analyzer_identity","repository_root":fixture.root}),
    )
    .unwrap_err();
    assert_eq!(
        missing,
        "PRIMITIVE_INVALID_REQUEST:missing field `compiler_package_root`"
    );
}

#[test]
fn native_identity_accepts_exact_64_mib_aggregate_and_refuses_the_next_byte() {
    fn bytes(directory: &std::path::Path) -> u64 {
        fs::read_dir(directory)
            .unwrap()
            .map(|entry| {
                let entry = entry.unwrap();
                if entry.file_type().unwrap().is_dir() {
                    bytes(&entry.path())
                } else {
                    entry.metadata().unwrap().len()
                }
            })
            .sum()
    }
    let fixture = Fixture::new();
    let source = fixture.root.join("packages/sample/src/value.ts");
    let other_bytes =
        bytes(&fixture.root) + bytes(&fixture.sdk) - fs::metadata(&source).unwrap().len();
    let file = fs::File::create(source).unwrap();
    file.set_len(67_108_864 - other_bytes).unwrap();
    let accepted = fixture.observe();
    assert_eq!(accepted["identity_success"], true, "{accepted}");
    assert_eq!(
        accepted["reads"]
            .as_array()
            .unwrap()
            .iter()
            .map(|read| read["bytes"].as_u64().unwrap())
            .sum::<u64>(),
        67_108_864
    );
    file.set_len(67_108_865 - other_bytes).unwrap();
    let rejected = fixture.observe();
    assert_eq!(rejected["identity_success"], false);
    assert_eq!(rejected["error"], "NATIVE_IDENTITY_CAPTURE_LIMIT");
    assert!(rejected.get("identity").is_none());
}

#[cfg(unix)]
#[test]
fn native_identity_confines_explicit_and_discovered_paths_before_reading() {
    use std::os::unix::fs::symlink;
    for (relative, compiler, directory) in [
        ("packages/sample/src/external.ts", false, false),
        ("packages/sample/src/external.json", false, false),
        ("packages/sample/src/external", false, true),
        ("tsconfig.json", false, false),
        ("packages/sample/package.json", false, false),
        ("packages/linked", false, true),
        ("packages/sample/src", false, true),
        ("apps/cli/src", false, true),
        ("package.json", true, false),
        ("lib/tsgo", true, false),
        ("lib/lib.d.ts", true, false),
        ("lib/ignored.json", true, false),
        ("lib", true, true),
    ] {
        let fixture = Fixture::new();
        let outside = fixture.base.join("outside");
        if directory {
            fs::create_dir(&outside).unwrap();
        } else {
            fs::write(&outside, "outside bytes").unwrap();
        }
        let path = if compiler {
            &fixture.sdk
        } else {
            &fixture.root
        }
        .join(relative);
        if path.is_dir() {
            fs::remove_dir_all(&path).unwrap();
        } else if path.exists() {
            fs::remove_file(&path).unwrap();
        }
        symlink(outside, path).unwrap();
        let observed = fixture.observe();
        assert_eq!(
            observed["identity_success"], false,
            "{relative}: {observed}"
        );
        assert_eq!(
            observed["error"],
            format!("NATIVE_IDENTITY_OUTSIDE_ROOT:{relative}")
        );
        assert!(observed.get("identity").is_none());
        assert!(
            !observed["reads"]
                .as_array()
                .unwrap()
                .iter()
                .any(|read| read["path"] == relative)
        );
    }
}

#[cfg(unix)]
#[test]
fn native_identity_accepts_internal_aliases_and_refuses_unresolvable_links() {
    use std::os::unix::fs::symlink;
    let fixture = Fixture::new();
    let original = fixture.observe();
    fs::rename(fixture.sdk.join("lib/tsgo"), fixture.sdk.join("compiler")).unwrap();
    symlink("../compiler", fixture.sdk.join("lib/tsgo")).unwrap();
    symlink(
        "value.ts",
        fixture.root.join("packages/sample/src/alias.ts"),
    )
    .unwrap();
    symlink("..", fixture.root.join("packages/sample/src/cycle")).unwrap();
    assert_eq!(fixture.observe()["identity"], original["identity"]);
    for target in ["missing", "broken"] {
        let path = fixture.root.join("packages/sample/src/broken");
        symlink(target, &path).unwrap();
        let refused = fixture.observe();
        assert_eq!(refused["identity_success"], false);
        assert!(
            refused["error"]
                .as_str()
                .unwrap()
                .starts_with("NATIVE_IDENTITY_READ_FAILED:packages/sample/src/broken:")
        );
        fs::remove_file(path).unwrap();
    }
}

#[test]
fn native_identity_refuses_missing_roots_directories_and_noncanonical_sources() {
    for (relative, directory, error) in [
        (
            "tsconfig.json",
            false,
            "NATIVE_IDENTITY_READ_FAILED:tsconfig.json:",
        ),
        (
            "apps/cli/src",
            true,
            "NATIVE_IDENTITY_DIRECTORY_READ_FAILED:apps/cli/src:",
        ),
        (
            "packages",
            true,
            "NATIVE_IDENTITY_DIRECTORY_READ_FAILED:packages:",
        ),
    ] {
        let fixture = Fixture::new();
        let path = fixture.root.join(relative);
        if directory {
            fs::remove_dir_all(path).unwrap();
        } else {
            fs::remove_file(path).unwrap();
        }
        let observed = fixture.observe();
        assert_eq!(observed["identity_success"], false);
        assert!(
            observed["error"].as_str().unwrap().starts_with(error),
            "{observed}"
        );
    }
    let mut fixture = Fixture::new();
    let source = fixture.root.join("packages/sample/src/value.ts");
    fs::write(&source, "export {};\r\n").unwrap();
    let noncanonical = fixture.observe();
    assert_eq!(noncanonical["identity_success"], false);
    assert!(
        noncanonical["error"]
            .as_str()
            .unwrap()
            .starts_with("Noncanonical CRLF analyzer input:")
    );
    fs::write(source, "export {};\n").unwrap();
    fixture.sdk = fixture.base.join("missing-sdk");
    assert!(
        fixture.observe()["error"]
            .as_str()
            .unwrap()
            .starts_with("NATIVE_IDENTITY_SDK_UNAVAILABLE:")
    );
    fixture.root = fixture.base.join("missing-root");
    assert!(
        fixture.observe()["error"]
            .as_str()
            .unwrap()
            .starts_with("NATIVE_IDENTITY_ROOT_UNAVAILABLE:")
    );
}

#[cfg(unix)]
#[test]
fn native_identity_refuses_unreadable_source_package_entry_and_library() {
    use std::os::unix::fs::PermissionsExt;
    for (relative, compiler) in [
        ("packages/sample/src/value.ts", false),
        ("package.json", true),
        ("lib/tsgo", true),
        ("lib/lib.d.ts", true),
    ] {
        let fixture = Fixture::new();
        let path = if compiler {
            &fixture.sdk
        } else {
            &fixture.root
        }
        .join(relative);
        let permissions = fs::metadata(&path).unwrap().permissions();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o0)).unwrap();
        let observed = fixture.observe();
        fs::set_permissions(path, permissions).unwrap();
        assert_eq!(
            observed["identity_success"], false,
            "{relative}: {observed}"
        );
        assert!(
            observed["error"]
                .as_str()
                .unwrap()
                .starts_with(&format!("NATIVE_IDENTITY_READ_FAILED:{relative}:")),
            "{observed}"
        );
        assert!(observed.get("identity").is_none());
    }
}

#[cfg(target_os = "linux")]
#[test]
fn native_identity_refuses_non_utf8_discovered_names() {
    use std::os::unix::ffi::OsStringExt;
    let fixture = Fixture::new();
    let name = std::ffi::OsString::from_vec(vec![0xff, b'.', b't', b's']);
    fs::write(fixture.root.join("packages/sample/src").join(name), b"").unwrap();
    let observed = fixture.observe();
    assert_eq!(observed["identity_success"], false);
    assert_eq!(observed["error"], "NATIVE_IDENTITY_PATH_NOT_UTF8");
    assert!(observed.get("identity").is_none());
}
