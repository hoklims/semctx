
use super::*;
#[test]
fn native_discovery_resolver_paths_preserve_drive_roots_across_verbatim_spelling() {
    for (path, expected) in [
        (r"\\?\D:\repo\src\main.ts", "D:/repo/src/main.ts"),
        ("//?/D:/repo/./src/../main.ts", "D:/repo/./src/../main.ts"),
        ("D:/repo/main.ts", "D:/repo/main.ts"),
        ("/repo/main.ts", "/repo/main.ts"),
        (r"\\server\share\main.ts", "//server/share/main.ts"),
    ] {
        assert_eq!(resolver_path(path), expected);
    }
}
