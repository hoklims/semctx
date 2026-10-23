use semctx_gates::process;
use semctx_r0_probe::identity;
use serde_json::{Value, json};
use std::{
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

fn directory(label: &str) -> PathBuf {
    let base = std::env::var_os("SEMCTX_NATIVE_EVIDENCE")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("development-evidence/legacy-identity")
        });
    let path = base.join(format!(
        "legacy-identity-{label}-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir_all(&path).unwrap();
    path
}
fn fixture(evidence: &Path) -> (PathBuf, PathBuf) {
    let root = evidence.join("implementation");
    for (path, bytes) in [
        ("bun.lock", "{}\n"),
        ("tsconfig.json", "{}\n"),
        ("tsconfig.base.json", "{}\n"),
        ("scripts/analyzer-identity.ts", "export {};\n"),
        ("scripts/build-plugin-runtime.ts", "export {};\n"),
        ("scripts/build-cli-package.ts", "export {};\n"),
        ("packages/sample/package.json", "{\"name\":\"sample\"}\n"),
        ("packages/sample/src/value.ts", "export const value=53;\n"),
        ("packages/app-services/package.json", "{}\n"),
        (
            "packages/app-services/src/analyzer-identity-generated.ts",
            "export const generated=67;\r\n",
        ),
        ("apps/cli/package.json", "{}\n"),
    ] {
        let target = root.join(path);
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        fs::write(target, bytes).unwrap();
    }
    fs::create_dir_all(root.join("apps/cli/src")).unwrap();
    let sdk = evidence.join("compiler-package");
    fs::create_dir_all(sdk.join("lib")).unwrap();
    fs::write(
        sdk.join("package.json"),
        "{\"name\":\"typescript\",\"version\":\"5.9.3\"}\n",
    )
    .unwrap();
    fs::write(
        sdk.join("lib/typescript.js"),
        "module.exports={version:'5.9.3'};\n",
    )
    .unwrap();
    fs::write(sdk.join("lib/lib.d.ts"), "declare const value: number;\n").unwrap();
    (root, sdk)
}
fn observe(evidence: &Path, root: &Path, sdk: &Path, label: &str) -> Value {
    let request = json!({"operation":"baseline_analyzer_identity","repository_root":root,"compiler_package_root":sdk});
    let outcome = run_observation(evidence, &request, label, &[]);
    assert_eq!(outcome.kind, "success", "{outcome:?}");
    assert_eq!(outcome.exit_code, Some(0));
    let value: Value = serde_json::from_str(&outcome.stdout).unwrap();
    assert_eq!(value["request_descriptor_id"], identity::digest(&request));
    assert_eq!(
        value["producer_artifact_id"],
        identity::digest_bytes(&fs::read(env!("CARGO_BIN_EXE_semctx-r0-probe")).unwrap())
    );
    assert_eq!(value["executed"], true);
    assert_eq!(value["unsupported"], json!([]));
    assert_eq!(
        value["identity_scope"],
        "baseline_3e94997f_implementation_and_compiler_bytes"
    );
    assert_eq!(value["compiler_executed"], false);
    assert_eq!(value["global_admission_inferred"], false);
    value
}
fn run_observation(
    evidence: &Path,
    request: &Value,
    label: &str,
    command_prefix: &[String],
) -> process::Outcome {
    let path = evidence.join(format!("{label}-request.json"));
    fs::write(&path, serde_json::to_vec_pretty(request).unwrap()).unwrap();
    let producer = Path::new(env!("CARGO_BIN_EXE_semctx-r0-probe"));
    let helper = PathBuf::from(
        std::env::var_os("SEMCTX_PROCESS_HELPER").expect("compiled process helper required"),
    );
    let before = identity::digest_bytes(&fs::read(producer).unwrap());
    let helper_before = identity::digest_bytes(&fs::read(&helper).unwrap());
    let mut argv = command_prefix.to_vec();
    argv.extend([
        producer.to_string_lossy().into_owned(),
        "--observe-primitives".into(),
        path.to_string_lossy().into_owned(),
    ]);
    let outcome = process::run_with_helper(&argv, evidence, 20_000, 8_388_608, &helper).unwrap();
    let after = identity::digest_bytes(&fs::read(producer).unwrap());
    let helper_after = identity::digest_bytes(&fs::read(&helper).unwrap());
    fs::write(evidence.join(format!("{label}-process.json")),serde_json::to_vec_pretty(&json!({"argv":argv,"cwd":evidence,"producer_before":before,"producer_after":after,"helper_before":helper_before,"helper_after":helper_after,"request":request,"outcome":outcome})).unwrap()).unwrap();
    assert_eq!(before, after);
    assert_eq!(helper_before, helper_after);
    outcome
}

#[test]
fn native_legacy_identity_accepts_exact_aggregate_capture_limit_and_refuses_one_more_byte() {
    let evidence = directory("aggregate-capture-limit");
    let (root, sdk) = fixture(&evidence);
    fs::write(
        root.join("packages/app-services/src/analyzer-identity-generated.ts"),
        b"",
    )
    .unwrap();
    let fixed_bytes: u64 = [
        "bun.lock",
        "tsconfig.json",
        "tsconfig.base.json",
        "scripts/analyzer-identity.ts",
        "scripts/build-plugin-runtime.ts",
        "scripts/build-cli-package.ts",
        "packages/sample/package.json",
        "packages/app-services/package.json",
        "apps/cli/package.json",
    ]
    .iter()
    .map(|path| fs::metadata(root.join(path)).unwrap().len())
    .chain(
        ["package.json", "lib/typescript.js", "lib/lib.d.ts"]
            .iter()
            .map(|path| fs::metadata(sdk.join(path)).unwrap().len()),
    )
    .sum();
    let source = fs::File::create(root.join("packages/sample/src/value.ts")).unwrap();
    source.set_len(67_108_864 - fixed_bytes).unwrap();
    let accepted = observe(&evidence, &root, &sdk, "exact-limit");
    assert_eq!(accepted["identity_success"], true, "{accepted}");
    assert!(accepted.get("identity").is_some());
    source.set_len(67_108_865 - fixed_bytes).unwrap();
    let rejected = observe(&evidence, &root, &sdk, "one-byte-over-limit");
    assert_eq!(rejected["identity_success"], false, "{rejected}");
    assert_eq!(rejected["error"], "LEGACY_IDENTITY_CAPTURE_LIMIT");
    assert!(rejected.get("identity").is_none());
}

#[test]
fn native_legacy_identity_requires_explicit_sdk_without_fallback_to_valid_installed_sdk() {
    let evidence = directory("no-sdk-fallback");
    let (root, sdk) = fixture(&evidence);
    let installed = root.join("node_modules/typescript");
    fs::create_dir_all(installed.join("lib")).unwrap();
    for path in ["package.json", "lib/typescript.js", "lib/lib.d.ts"] {
        fs::copy(sdk.join(path), installed.join(path)).unwrap();
    }
    let control = observe(&evidence, &root, &installed, "valid-installed-sdk");
    assert_eq!(control["identity_success"], true, "{control}");
    #[cfg(unix)]
    {
        let empty_path = evidence.join("empty-path");
        fs::create_dir(&empty_path).unwrap();
        let request = json!({"operation":"baseline_analyzer_identity","repository_root":root,"compiler_package_root":installed});
        let isolated = run_observation(
            &evidence,
            &request,
            "sdk-without-bun-on-path",
            &[
                "/usr/bin/env".into(),
                "-i".into(),
                format!("PATH={}", empty_path.display()),
            ],
        );
        assert_eq!(isolated.kind, "success", "{isolated:?}");
        assert_eq!(isolated.exit_code, Some(0));
        let observed: Value = serde_json::from_str(&isolated.stdout).unwrap();
        assert_eq!(observed["identity_success"], true, "{observed}");
        assert_eq!(observed["identity"], control["identity"]);
        assert_eq!(observed["compiler_executed"], false);
    }
    let request = json!({"operation":"baseline_analyzer_identity","repository_root":root});
    let omitted = run_observation(&evidence, &request, "omitted-sdk", &[]);
    assert_eq!(omitted.kind, "nonzero", "{omitted:?}");
    assert_eq!(omitted.exit_code, Some(1));
    assert_eq!(omitted.stdout, "");
    let error: Value = serde_json::from_str(&omitted.stderr).unwrap();
    assert_eq!(
        error["error"],
        "PRIMITIVE_INVALID_REQUEST:missing field `compiler_package_root`"
    );
    let missing = observe(
        &evidence,
        &root,
        &evidence.join("missing-sdk"),
        "missing-sdk-no-fallback",
    );
    assert_eq!(missing["identity_success"], false, "{missing}");
    assert!(
        missing["error"]
            .as_str()
            .unwrap()
            .starts_with("LEGACY_IDENTITY_SDK_UNAVAILABLE:")
    );
    assert!(missing.get("identity").is_none());
    fs::write(sdk.join("package.json"), b"{").unwrap();
    let invalid = observe(&evidence, &root, &sdk, "invalid-sdk-no-fallback");
    assert_eq!(invalid["identity_success"], false, "{invalid}");
    assert!(
        invalid["error"]
            .as_str()
            .unwrap()
            .starts_with("LEGACY_IDENTITY_SDK_INVALID:")
    );
    assert!(invalid.get("identity").is_none());
}
#[test]
fn native_legacy_identity_preserves_relocation_and_detects_source_and_sdk_byte_changes() {
    let a = directory("original");
    let (root, sdk) = fixture(&a);
    let original = observe(&a, &root, &sdk, "original");
    assert_eq!(original["identity_success"], true);
    let ignored = root.join("plugins/shared/hooks/process-budget.mjs");
    fs::create_dir_all(ignored.parent().unwrap()).unwrap();
    fs::write(ignored, "export const laterPolicyOnly=61;\r\n").unwrap();
    let later = observe(&a, &root, &sdk, "later-policy-input");
    assert_eq!(later["identity"], original["identity"]);
    let b = directory("relocated");
    let (other, other_sdk) = fixture(&b);
    let relocated = observe(&b, &other, &other_sdk, "relocated");
    assert_eq!(original["identity"], relocated["identity"]);
    fs::write(
        other.join("packages/sample/src/value.ts"),
        "export const value=59;\n",
    )
    .unwrap();
    let source = observe(&b, &other, &other_sdk, "source-change");
    assert_ne!(source["identity"]["digest"], original["identity"]["digest"]);
    assert_eq!(
        source["identity"]["compiler"],
        original["identity"]["compiler"]
    );
    fs::write(
        other.join("packages/sample/src/value.ts"),
        "export const value=53;\n",
    )
    .unwrap();
    fs::write(
        other_sdk.join("lib/lib.d.ts"),
        "declare const value: string;\n",
    )
    .unwrap();
    let compiler = observe(&b, &other, &other_sdk, "compiler-change");
    assert_eq!(compiler["identity"]["files"], original["identity"]["files"]);
    assert_ne!(
        compiler["identity"]["compiler"]["digest"],
        original["identity"]["compiler"]["digest"]
    );
    assert_eq!(compiler["identity"]["compiler"]["version"], "5.9.3");
    assert_ne!(
        compiler["identity"]["digest"],
        original["identity"]["digest"]
    );
}
#[test]
fn native_legacy_identity_refuses_crlf_missing_inputs_invalid_sdk_and_capture_overflow() {
    for (label, expected) in [
        (
            "crlf",
            "Noncanonical CRLF analyzer input: packages/sample/src/value.ts",
        ),
        (
            "missing-source",
            "LEGACY_IDENTITY_READ_FAILED:tsconfig.json",
        ),
        (
            "missing-directory",
            "LEGACY_IDENTITY_DIRECTORY_READ_FAILED:",
        ),
        ("invalid-sdk", "LEGACY_IDENTITY_SDK_INVALID:"),
        ("sdk-version", "LEGACY_IDENTITY_SDK_VERSION_MISMATCH"),
        (
            "missing-entry",
            "LEGACY_IDENTITY_READ_FAILED:lib/typescript.js",
        ),
        ("capture-limit", "LEGACY_IDENTITY_CAPTURE_LIMIT"),
        ("missing-root", "LEGACY_IDENTITY_ROOT_UNAVAILABLE:"),
        ("missing-sdk", "LEGACY_IDENTITY_SDK_UNAVAILABLE:"),
        (
            "missing-sdk-directory",
            "LEGACY_IDENTITY_DIRECTORY_READ_FAILED:lib:",
        ),
    ] {
        let evidence = directory(label);
        let (mut root, mut sdk) = fixture(&evidence);
        match label {
            "crlf" => fs::write(
                root.join("packages/sample/src/value.ts"),
                "export const value=53;\r\n",
            )
            .unwrap(),
            "missing-source" => fs::remove_file(root.join("tsconfig.json")).unwrap(),
            "missing-directory" => fs::remove_dir(root.join("apps/cli/src")).unwrap(),
            "invalid-sdk" => fs::write(sdk.join("package.json"), "{").unwrap(),
            "sdk-version" => fs::write(
                sdk.join("package.json"),
                "{\"name\":\"typescript\",\"version\":\"7.1.0-dev\"}",
            )
            .unwrap(),
            "missing-entry" => fs::remove_file(sdk.join("lib/typescript.js")).unwrap(),
            "capture-limit" => fs::File::create(root.join("packages/sample/src/value.ts"))
                .unwrap()
                .set_len(67_108_865)
                .unwrap(),
            "missing-root" => root = evidence.join("absent"),
            "missing-sdk" => sdk = evidence.join("absent-compiler"),
            "missing-sdk-directory" => fs::remove_dir_all(sdk.join("lib")).unwrap(),
            _ => unreachable!(),
        }
        let value = observe(&evidence, &root, &sdk, label);
        assert_eq!(value["identity_success"], false, "{value}");
        assert!(
            value["error"].as_str().unwrap().starts_with(expected),
            "{value}"
        );
        assert!(value.get("identity").is_none());
        if label == "crlf" {
            assert_eq!(
                fs::read(root.join("packages/sample/src/value.ts")).unwrap(),
                b"export const value=53;\r\n"
            );
        }
    }
}
#[cfg(unix)]
#[test]
fn native_legacy_identity_refuses_read_errors_and_external_implementation_links() {
    use std::os::unix::fs::PermissionsExt;
    let evidence = directory("read-failure");
    let (root, sdk) = fixture(&evidence);
    let source = root.join("packages/sample/src/value.ts");
    for (label, path) in [
        ("source-read", source.clone()),
        ("sdk-read", sdk.join("package.json")),
        ("sdk-entry-read", sdk.join("lib/typescript.js")),
        ("sdk-library-read", sdk.join("lib/lib.d.ts")),
    ] {
        let permissions = fs::metadata(&path).unwrap().permissions();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o0)).unwrap();
        let observed = observe(&evidence, &root, &sdk, label);
        fs::set_permissions(&path, permissions).unwrap();
        assert_eq!(observed["identity_success"], false);
        assert!(
            observed["error"]
                .as_str()
                .unwrap()
                .starts_with("LEGACY_IDENTITY_READ_FAILED:")
        );
        assert!(observed.get("identity").is_none());
    }
    let outside = evidence.join("outside.ts");
    fs::write(&outside, "export {};\n").unwrap();
    let fixed = root.join("scripts/analyzer-identity.ts");
    fs::remove_file(&fixed).unwrap();
    std::os::unix::fs::symlink(&outside, &fixed).unwrap();
    let observed = observe(&evidence, &root, &sdk, "outside-link");
    assert_eq!(observed["identity_success"], false);
    assert!(
        observed["error"]
            .as_str()
            .unwrap()
            .starts_with("LEGACY_IDENTITY_OUTSIDE_ROOT:")
    );
    fs::remove_file(&fixed).unwrap();
    fs::write(&fixed, "export {};\n").unwrap();
    let entry = sdk.join("lib/typescript.js");
    fs::remove_file(&entry).unwrap();
    std::os::unix::fs::symlink(&outside, &entry).unwrap();
    let observed = observe(&evidence, &root, &sdk, "outside-sdk-link");
    assert_eq!(observed["identity_success"], false);
    assert!(
        observed["error"]
            .as_str()
            .unwrap()
            .starts_with("LEGACY_IDENTITY_OUTSIDE_ROOT:")
    );
}

#[cfg(target_os = "linux")]
#[test]
fn native_legacy_identity_refuses_non_utf8_filesystem_names() {
    use std::os::unix::ffi::OsStringExt;
    let evidence = directory("non-utf8-name");
    let (root, sdk) = fixture(&evidence);
    let strange = root
        .join("packages/sample/src")
        .join(std::ffi::OsString::from_vec(vec![0xff, b'.', b't', b's']));
    fs::write(strange, b"export {};\n").unwrap();
    let observed = observe(&evidence, &root, &sdk, "non-utf8-name");
    assert_eq!(observed["identity_success"], false);
    assert_eq!(observed["error"], "LEGACY_IDENTITY_PATH_NOT_UTF8");
}
