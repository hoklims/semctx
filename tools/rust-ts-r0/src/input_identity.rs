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
        json!({"domain":"T00-logical-input-v3","project":project,"sdk":{"domain":"T00-logical-sdk-v3","version":sdk.version,"source_revision":sdk.source_revision,"library_manifest_sha256":sdk.library_manifest_sha256,"files":files}}),
    )
}
pub fn capture(request: &Request) -> Result<Value, String> {
    Ok(
        json!({"domain":"T00-logical-capture-v2","repository_root":"T00_REPOSITORY_ROOT","case_sensitive":request.case_sensitive,"project":project(request,&mut BTreeSet::new())?}),
    )
}

#[cfg(test)]
#[path = "../tests/unit/input_identity.rs"]
mod tests;
