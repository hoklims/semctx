use serde_json::Value;
use std::{fs, path::PathBuf, sync::OnceLock};

pub fn canonical_sdk() -> &'static str {
    static SDK: OnceLock<String> = OnceLock::new();
    SDK.get_or_init(|| {
        let descriptor =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../rust-ts-r0/sdk/sdk-input.json");
        let sdk: Value = serde_json::from_slice(&fs::read(&descriptor).unwrap()).unwrap();
        let executable = PathBuf::from(env!("CARGO_BIN_EXE_t00-ts7-oracle-sem-c"));
        let directory = executable.parent().unwrap();
        for (name, text) in sdk["files"].as_object().unwrap() {
            let name = name.strip_prefix("/sdk/lib/").expect("SDK library root");
            let path = directory.join(name);
            let text = text.as_str().unwrap();
            if path.exists() {
                assert_eq!(fs::read_to_string(&path).unwrap(), text);
            } else {
                fs::write(&path, text).expect("materialize canonical SDK library");
            }
        }
        descriptor.to_str().unwrap().to_owned()
    })
}
