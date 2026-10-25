use std::{fs, path::Path, path::PathBuf, sync::OnceLock};

pub fn install_sdk(executable: &Path) -> PathBuf {
    static DIRECTORY: OnceLock<PathBuf> = OnceLock::new();
    let path = DIRECTORY.get_or_init(|| {
        let sdk: serde_json::Value =
            serde_json::from_str(include_str!("../../../rust-ts-r0/sdk/sdk-input.json"))
                .expect("canonical SDK JSON");
        let directory = executable.parent().expect("executable directory");
        for (name, text) in sdk["files"].as_object().expect("SDK libraries") {
            let name = name.strip_prefix("/sdk/lib/").expect("SDK library root");
            let target = directory.join(name);
            let text = text.as_str().expect("SDK library text");
            if target.exists() {
                assert_eq!(fs::read_to_string(&target).unwrap(), text);
            } else {
                fs::write(&target, text).expect("materialize canonical SDK library");
            }
        }
        directory.to_path_buf()
    });
    assert_eq!(path, executable.parent().expect("executable directory"));
    path.clone()
}
