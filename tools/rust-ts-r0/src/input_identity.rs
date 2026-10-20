use super::*;
use serde_json::{Value, json};

fn location(root: &str, path: &str, sensitive: bool, domain: &str) -> Value {
    match relative_source_path(root, path, sensitive) {
        Ok(path) => json!({"domain":domain,"path":if sensitive {path} else {path.to_lowercase()}}),
        Err(_) => {
            json!({"domain":"external","path":CaptureFs::new(BTreeMap::new(),sensitive).key(path)})
        }
    }
}
fn project(request: &Request, seen: &mut BTreeSet<String>) -> Result<Value, String> {
    let normalizer = CaptureFs::new(BTreeMap::new(), request.case_sensitive);
    let mut entries = Vec::new();
    for (path, text) in &request.files {
        if !seen.insert(normalizer.key(path)) {
            return Err(format!("conflicting captured key: {path}"));
        }
        entries.push(json!({"location":location(&request.cwd,path,request.case_sensitive,"repository"),"representation":"text","text":text}));
    }
    for (path, units) in &request.utf16_files {
        if !seen.insert(normalizer.key(path)) {
            return Err(format!("conflicting captured key: {path}"));
        }
        entries.push(json!({"location":location(&request.cwd,path,request.case_sensitive,"repository"),"representation":"utf16","units":units}));
    }
    for (path, raw) in &request.raw_files {
        if !seen.insert(normalizer.key(path)) {
            return Err(format!("conflicting captured key: {path}"));
        }
        entries.push(json!({"location":location(&request.cwd,path,request.case_sensitive,"repository"),"representation":"raw","bytes":raw.bytes,"profile":raw.profile}));
    }
    entries.sort_by_key(identity::canonical_json);
    Ok(json!(entries))
}
pub fn input(request: &Request, sdk: &Sdk) -> Result<Value, String> {
    let mut seen = BTreeSet::new();
    let project = project(request, &mut seen)?;
    let normalizer = CaptureFs::new(BTreeMap::new(), request.case_sensitive);
    let mut files = Vec::new();
    for (path, text) in &sdk.files {
        if !seen.insert(normalizer.key(path)) {
            return Err(format!("conflicting captured SDK key: {path}"));
        }
        files.push(json!({"location":location(&request.sdk_directory,path,request.case_sensitive,"sdk"),"text":text}));
    }
    files.sort_by_key(identity::canonical_json);
    Ok(
        json!({"domain":"T00-logical-input-v2","project":project,"sdk":{"domain":"T00-logical-sdk-v2","version":sdk.version,"archive_sha256":sdk.archive_sha256,"files":files}}),
    )
}
pub fn capture(request: &Request) -> Result<Value, String> {
    Ok(
        json!({"domain":"T00-logical-capture-v2","repository_root":"T00_REPOSITORY_ROOT","case_sensitive":request.case_sensitive,"project":project(request,&mut BTreeSet::new())?}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture(root: &str, sdk_root: &str) -> (Request, Sdk) {
        let request = serde_json::from_value(json!({"id":"logicalIdentityDev","cwd":root,"sdk_directory":sdk_root,"case_sensitive":true,"roots":[format!("{root}/source.ts")],"files":{format!("{root}/source.ts"):"export const identityDev = 383;"},"options":{}})).unwrap();
        let sdk = Sdk {
            version: "5.9.3".into(),
            archive_sha256: "archive-dev".into(),
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
        for mutation in ["bytes", "version", "archive"] {
            let mut sb = sa.clone();
            match mutation {
                "bytes" => {
                    sb.files.insert(
                        "/sdk/lib.dev.d.ts".into(),
                        "declare const sdkDev: string;".into(),
                    );
                }
                "version" => sb.version = "foreign-version".into(),
                _ => sb.archive_sha256 = "foreign-archive".into(),
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
}
