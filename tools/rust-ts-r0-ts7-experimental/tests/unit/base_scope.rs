#[cfg(windows)]
use super::*;

#[cfg(windows)]
#[test]
fn discovery_slashes_bind_to_native_verbatim_capture_without_aliasing_other_paths() {
    let files = BTreeMap::from([(
        capture_path(r"\\?\C:\repo\outside.ts"),
        "export const value = 1;".into(),
    )]);
    assert_eq!(
        files.get("//?/C:/repo/outside.ts").map(String::as_str),
        Some("export const value = 1;")
    );
    assert_eq!(files.get("//?/C:/other/outside.ts"), None);
    assert_eq!(files.get("//?/D:/repo/outside.ts"), None);
    assert_eq!(files.get("//?/C:/repo/../outside.ts"), None);
}
