
use super::*;
#[test]
fn captured_bytes_are_read_and_missing_live_paths_stay_absent() {
    let capture = Captured::new(BTreeMap::from([(
        "/repo/a.ts".into(),
        "export const a = 1;".into(),
    )]));
    assert_eq!(capture.read("/repo/a.ts"), Some("export const a = 1;"));
    assert_eq!(capture.read("/etc/passwd"), None);
}
