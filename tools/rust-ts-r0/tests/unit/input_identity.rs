use super::*;
fn fixture(root: &str, sdk_root: &str) -> (Request, Sdk) {
    let request = serde_json::from_value(json!({"id":"logicalIdentityDev","cwd":root,"sdk_directory":sdk_root,"case_sensitive":true,"roots":[format!("{root}/source.ts")],"files":{format!("{root}/source.ts"):"export const identityDev = 383;"},"options":{}})).unwrap();
    let sdk = Sdk {
        version: "5.9.3".into(),
        source_revision: Some("780dc512d64f40afebffa6a7028207649fb7ed1c".into()),
        library_manifest_sha256: Some("archive-dev".into()),
        archive_sha256: None,
        files: BTreeMap::from([(
            format!("{sdk_root}/lib.dev.d.ts"),
            "declare const sdkDev: number;".into(),
        )]),
    };
    (request, sdk)
}
#[test]
fn physical_relocation_preserves_real_content_bindings_and_keeps_scope_distinct() {
    let (a, sa) = fixture("/alpha/repository", "/alpha/sdk");
    let (b, sb) = fixture("/beta/repository", "/beta/sdk");
    assert_eq!(
        batch::input_manifest(&a, &sa).unwrap(),
        batch::input_manifest(&b, &sb).unwrap()
    );
    assert_eq!(
        batch::capture_manifest(&a).unwrap(),
        batch::capture_manifest(&b).unwrap()
    );
    assert_eq!(
        batch::snapshot_manifest(&a, &sa).unwrap(),
        batch::snapshot_manifest(&b, &sb).unwrap()
    );
    assert_ne!(
        batch::scope_manifest(&a).unwrap(),
        batch::scope_manifest(&b).unwrap()
    );
    assert_ne!(
        identity::digest(&serde_json::to_value(a).unwrap()),
        identity::digest(&serde_json::to_value(b).unwrap())
    );
}
#[test]
fn content_and_sdk_mutations_change_consumed_bindings() {
    let (a, sa) = fixture("/repository", "/sdk");
    let mut b = a.clone();
    b.files.insert(
        "/repository/source.ts".into(),
        "export const identityDev = 389;".into(),
    );
    assert_ne!(
        batch::input_manifest(&a, &sa).unwrap(),
        batch::input_manifest(&b, &sa).unwrap()
    );
    assert_ne!(
        batch::capture_manifest(&a).unwrap(),
        batch::capture_manifest(&b).unwrap()
    );
    assert_ne!(
        batch::snapshot_manifest(&a, &sa).unwrap(),
        batch::snapshot_manifest(&b, &sa).unwrap()
    );
    for mutation in ["bytes", "version", "source", "manifest"] {
        let mut sb = sa.clone();
        match mutation {
            "bytes" => {
                sb.files.insert(
                    "/sdk/lib.dev.d.ts".into(),
                    "declare const sdkDev: string;".into(),
                );
            }
            "version" => sb.version = "foreign-version".into(),
            "source" => sb.source_revision = Some("foreign-source".into()),
            _ => sb.library_manifest_sha256 = Some("foreign-manifest".into()),
        }
        assert_ne!(
            batch::input_manifest(&a, &sa).unwrap(),
            batch::input_manifest(&a, &sb).unwrap()
        );
        assert_ne!(
            batch::snapshot_manifest(&a, &sa).unwrap(),
            batch::snapshot_manifest(&a, &sb).unwrap()
        );
    }
}
#[test]
fn canonical_capture_aliases_and_source_sdk_collisions_are_refused() {
    let (mut a, sa) = fixture("/repository", "/sdk");
    a.utf16_files
        .insert("/repository/dir/../source.ts".into(), vec![1]);
    assert!(batch::input_manifest(&a, &sa).is_err());
    let (mut a, sa) = fixture("/repository", "/sdk");
    a.case_sensitive = false;
    a.raw_files.insert(
        "/REPOSITORY/source.ts".into(),
        RawFile {
            bytes: vec![1],
            profile: source_text::ReadProfile::CompilerSystem,
        },
    );
    assert!(batch::input_manifest(&a, &sa).is_err());
    let (mut a, sa) = fixture("/repository", "/sdk");
    a.files
        .insert("/sdk/lib.dev.d.ts".into(), "conflict".into());
    assert!(batch::input_manifest(&a, &sa).is_err());
}
#[test]
fn outside_paths_remain_bound_to_a_disjoint_physical_namespace() {
    let (mut a, sa) = fixture("/repository", "/sdk");
    a.files.insert("/elsewhere/config.json".into(), "{}".into());
    let mut b = a.clone();
    b.files.remove("/elsewhere/config.json");
    b.files
        .insert("/repository/elsewhere/config.json".into(), "{}".into());
    assert_ne!(
        batch::input_manifest(&a, &sa).unwrap(),
        batch::input_manifest(&b, &sa).unwrap()
    );
}

#[test]
fn ts5_archive_and_package_bytes_are_bound_to_the_logical_input() {
    let (request, _) = fixture("/repository", "/sdk/lib");
    let descriptor = json!({
        "version":"5.9.3",
        "archive_sha256":"10e108c9cf7d5f2879053dff18515fb405abf2ccef63eaaf017d9c571687a1d3",
        "files":{
            "/sdk/lib/lib.dev.d.ts":"declare const sdkDev: number;",
            "/sdk/package.json":"{\"name\":\"typescript\",\"version\":\"5.9.3\",\"description\":\"one\"}"
        }
    });
    let original: Sdk = serde_json::from_value(descriptor.clone()).unwrap();
    for archive in [false, true] {
        let mut changed = descriptor.clone();
        if archive {
            changed["archive_sha256"] = json!("0".repeat(64));
        } else {
            changed["files"]["/sdk/package.json"] =
                json!("{\"name\":\"typescript\",\"version\":\"5.9.3\",\"description\":\"two\"}");
        }
        let changed: Sdk = serde_json::from_value(changed).unwrap();
        assert_ne!(
            batch::input_manifest(&request, &original).unwrap(),
            batch::input_manifest(&request, &changed).unwrap()
        );
        assert_ne!(
            batch::snapshot_manifest(&request, &original).unwrap(),
            batch::snapshot_manifest(&request, &changed).unwrap()
        );
    }
}
