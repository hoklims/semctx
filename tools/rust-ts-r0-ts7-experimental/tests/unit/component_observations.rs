use super::*;

#[test]
fn retained_reference_uses_capture_path_identity_for_drive_and_verbatim_roots() {
    for root in ["C:/repo", "//?/C:/repo", "/repo"] {
        for sensitive in [false, true] {
            let file_name = format!("{root}/src/selected.ts");
            crate::development::with_project(
                BTreeMap::from([(
                    file_name.clone(),
                    "/// <reference path=\"../reference.ts\" />\nexport const value = 1;".into(),
                )]),
                vec![file_name.clone()],
                || {
                    let source = program::get_source_file(&file_name);
                    let fs = CaptureFs::new(BTreeMap::new(), sensitive);
                    for (retained, files) in [
                        (false, BTreeMap::new()),
                        (
                            true,
                            BTreeMap::from([(
                                fs.key(&format!("{root}/reference.ts")),
                                "export {};".into(),
                            )]),
                        ),
                    ] {
                        let observed =
                            retained_scope_syntax(source, "src/selected.ts", true, &files, &fs);
                        assert_eq!(
                            observed.reasons.is_empty(),
                            retained,
                            "{root}: sensitive={sensitive}, reasons={:?}",
                            observed.reasons
                        );
                    }
                },
            );
        }
    }
}
