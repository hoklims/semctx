#![cfg(unix)]

use semctx_r0_probe::primitive_observations::handle_observation;
use serde_json::{Value, json};
use std::{
    fs,
    os::unix::fs::symlink,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

fn fixture(label: &str) -> (PathBuf, PathBuf, PathBuf) {
    let base = std::env::var_os("SEMCTX_NATIVE_EVIDENCE")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
        .join(format!(
            "identity-confinement-{label}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
    let root = base.join("repository");
    let sdk = base.join("sdk");
    for (path, bytes) in [
        ("bun.lock", "{}"),
        ("tsconfig.json", "{}"),
        ("tsconfig.base.json", "{}"),
        ("scripts/analyzer-identity.ts", "export {};"),
        ("scripts/build-plugin-runtime.ts", "export {};"),
        ("scripts/build-cli-package.ts", "export {};"),
        ("packages/sample/package.json", "{}"),
        ("packages/sample/src/nested/value.ts", "export {};"),
        ("apps/cli/package.json", "{}"),
        ("apps/cli/src/value.ts", "export {};"),
    ] {
        let path = root.join(path);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, bytes).unwrap();
    }
    fs::create_dir_all(sdk.join("lib")).unwrap();
    fs::write(
        sdk.join("package.json"),
        r#"{"name":"typescript","version":"5.9.3"}"#,
    )
    .unwrap();
    fs::write(sdk.join("lib/typescript.js"), "module.exports={};").unwrap();
    let manifest: Value = serde_json::from_str(include_str!(
        "../../../docs/research/rust-ts-r0/cases/upstream/typescript/sdk-manifest.json"
    ))
    .unwrap();
    for library in manifest["libraries"].as_array().unwrap() {
        fs::write(
            sdk.join(library["path"].as_str().unwrap()),
            "declare const value: number;",
        )
        .unwrap();
    }
    (base, root, sdk)
}

fn observe(root: &Path, sdk: &Path) -> Value {
    handle_observation(json!({
        "operation":"baseline_analyzer_identity",
        "repository_root":root,
        "compiler_package_root":sdk
    }))
    .unwrap()
}

#[test]
fn acquisition_refuses_discovered_and_explicit_external_symlinks() {
    for (relative, compiler, directory) in [
        ("packages/sample/src/nested/external.ts", false, false),
        ("packages/sample/src/nested/external.json", false, false),
        ("packages/sample/src/nested/external", false, true),
        ("apps/cli/src/external.js", false, false),
        ("tsconfig.json", false, false),
        ("packages/sample/package.json", false, false),
        ("packages/linked", false, true),
        ("packages/sample/src", false, true),
        ("apps/cli/src", false, true),
        ("package.json", true, false),
        ("lib/typescript.js", true, false),
        ("lib/lib.d.ts", true, false),
        ("lib/ignored.json", true, false),
        ("lib", true, true),
    ] {
        let (base, root, sdk) = fixture("external");
        let outside = base.join("outside");
        if directory {
            fs::create_dir(&outside).unwrap();
        } else {
            fs::write(&outside, "external bytes").unwrap();
        }
        let path = if compiler { &sdk } else { &root }.join(relative);
        if path.is_dir() {
            fs::remove_dir_all(&path).unwrap();
        } else if path.exists() {
            fs::remove_file(&path).unwrap();
        }
        symlink(&outside, &path).unwrap();
        let observed = observe(&root, &sdk);
        assert_eq!(
            observed["identity_success"], false,
            "{relative}: {observed}"
        );
        assert_eq!(
            observed["error"],
            format!("LEGACY_IDENTITY_OUTSIDE_ROOT:{relative}")
        );
        assert!(observed.get("identity").is_none());
        assert!(
            observed["reads"]
                .as_array()
                .unwrap()
                .iter()
                .all(|read| { read["path"] != relative })
        );
        fs::remove_dir_all(base).unwrap();
    }
}

#[test]
fn acquisition_preserves_internal_aliases_and_ignores_recursive_alias_bytes() {
    let (base, root, sdk) = fixture("internal");
    let original = observe(&root, &sdk);
    assert_eq!(original["identity_success"], true);
    let config = root.join("tsconfig.json");
    fs::rename(&config, root.join("internal-config.json")).unwrap();
    symlink("internal-config.json", &config).unwrap();
    symlink("value.ts", root.join("packages/sample/src/nested/alias.ts")).unwrap();
    symlink("..", root.join("packages/sample/src/nested/parent")).unwrap();
    symlink("sample", root.join("packages/sample-alias")).unwrap();
    fs::rename(root.join("apps/cli/src"), root.join("cli-sources")).unwrap();
    symlink("../../cli-sources", root.join("apps/cli/src")).unwrap();
    fs::rename(sdk.join("lib"), sdk.join("content")).unwrap();
    symlink("content", sdk.join("lib")).unwrap();
    let library = sdk.join("lib/lib.d.ts");
    fs::rename(&library, sdk.join("library-target")).unwrap();
    symlink("../library-target", library).unwrap();
    let observed = observe(&root, &sdk);
    assert_eq!(observed["identity_success"], true, "{observed}");
    assert_eq!(observed["identity"], original["identity"]);
    fs::remove_dir_all(base).unwrap();
}

#[test]
fn acquisition_refuses_unresolvable_discovered_symlinks() {
    for target in ["missing.ts", "alias.ts"] {
        let (base, root, sdk) = fixture("unresolvable");
        symlink(target, root.join("packages/sample/src/nested/alias.ts")).unwrap();
        let observed = observe(&root, &sdk);
        assert_eq!(observed["identity_success"], false, "{observed}");
        assert!(
            observed["error"]
                .as_str()
                .unwrap()
                .starts_with("LEGACY_IDENTITY_READ_FAILED:packages/sample/src/nested/alias.ts:")
        );
        assert!(observed.get("identity").is_none());
        fs::remove_dir_all(base).unwrap();
    }
}
