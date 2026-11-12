use serde_json::Value;
use std::{fs, path::Path, path::PathBuf};

// Preserve the unchanged pinned public declaration snapshot and its metadata.
const PUBLIC_SDK: &[u8] = include_bytes!("../../../rust-ts-r0-ts7-experimental/sdk/sdk-input.json");

pub fn prepare_test_sdk(directory: &Path, declaration_directory: bool) -> PathBuf {
    let public: Value = serde_json::from_slice(PUBLIC_SDK).expect("public SDK fixture JSON");
    let bytes = match std::env::var_os("T00_ORACLE_TEST_SDK") {
        Some(path) => fs::read(path).expect("explicit T00_ORACLE_TEST_SDK JSON input"),
        None => PUBLIC_SDK.to_vec(),
    };
    let sdk: Value = serde_json::from_slice(&bytes).expect("SDK fixture JSON");
    assert_eq!(sdk["version"], "7.1.0-dev", "SDK fixture version metadata");
    assert_eq!(
        sdk["source_revision"], "780dc512d64f40afebffa6a7028207649fb7ed1c",
        "SDK fixture source revision"
    );
    assert_eq!(
        sdk["library_manifest_sha256"],
        "b1fa7b60aa83d187453b26c0b56a096875a47e61977954aba7deba16161fd7ad",
        "SDK fixture library manifest"
    );
    let files = sdk["files"].as_object().expect("SDK declaration map");
    let public_files = public["files"].as_object().unwrap();
    assert_eq!(files.len(), 115, "all SDK declarations are required");
    assert!(
        files.keys().eq(public_files.keys()),
        "SDK declaration paths must match the pinned public inventory"
    );
    for (path, content) in files {
        let name = path.strip_prefix("/sdk/lib/").expect("SDK library path");
        assert!(
            name.starts_with("lib") && name.ends_with(".d.ts") && !name.contains(['/', '\\']),
            "SDK declaration must be a direct library child"
        );
        assert!(
            content.as_str().is_some_and(|text| !text.is_empty()),
            "SDK declaration content must be a nonempty string"
        );
    }
    if declaration_directory {
        let root = directory.join("sdk");
        fs::create_dir_all(&root).unwrap();
        for (path, content) in files {
            let name = path.strip_prefix("/sdk/lib/").unwrap();
            fs::write(root.join(name), content.as_str().unwrap().as_bytes()).unwrap();
        }
        root
    } else {
        let path = directory.join("sdk-input.json");
        fs::write(&path, bytes).unwrap();
        path
    }
}
