//! Fresh physical fixtures outside a retained Map, distinct from mutations.
use super::*;

fn captured_key(path: &str, sensitive: bool) -> Result<String, String> {
    let path = path.replace('\\', "/");
    // Windows canonicalize returns verbatim drive paths. This is a spelling of
    // the measured local drive, not permission to admit UNC/network identities.
    let ordinary = path.strip_prefix("//?/").filter(|rest| {
        rest.as_bytes().get(1) == Some(&b':') && rest.as_bytes().get(2) == Some(&b'/')
    });
    verifier_absolute_key(ordinary.unwrap_or(&path), sensitive)
}

pub(super) fn apply(
    request: &Value,
    additions: &Value,
    root: &Path,
    request_path: &Path,
) -> Result<Value, String> {
    if additions.is_null() {
        return Ok(json!([]));
    }
    let before = fs::read(request_path).map_err(|e| e.to_string())?;
    if serde_json::from_slice::<Value>(&before).map_err(|e| e.to_string())? != *request {
        return Err("request identity differs before physical addition".into());
    }
    if fs::symlink_metadata(root)
        .map_err(|e| e.to_string())?
        .file_type()
        .is_symlink()
    {
        return Err("physical addition root is a link".into());
    }
    let canonical_root = root.canonicalize().map_err(|e| e.to_string())?;
    let mut proof = vec![];
    for (name, text) in additions
        .as_object()
        .ok_or("physical addition map absent")?
    {
        if !safe_relative(name)
            || name.contains('\\')
            || name
                .split(['/', '\\'])
                .any(|p| p.is_empty() || p == "." || [".git", ".semctx"].contains(&p))
        {
            return Err("physical addition escapes isolated source root".into());
        }
        let target = root.join(name);
        // Parent must already exist. Never traverse/create a symlink ancestor.
        let mut parent = root.to_path_buf();
        for part in Path::new(name)
            .parent()
            .ok_or("addition parent absent")?
            .components()
        {
            parent.push(part);
            let meta = fs::symlink_metadata(&parent).map_err(|e| e.to_string())?;
            if meta.file_type().is_symlink() || !meta.is_dir() {
                return Err("physical addition parent is a link/non-directory".into());
            }
        }
        let resolved_parent = target
            .parent()
            .ok_or("addition parent absent")?
            .canonicalize()
            .map_err(|e| e.to_string())?;
        if !resolved_parent.starts_with(&canonical_root) || target == request_path {
            return Err("physical addition outside root/request collision".into());
        }
        let key = resolved_parent
            .join(target.file_name().ok_or("addition filename absent")?)
            .to_string_lossy()
            .replace('\\', "/");
        let sensitive = request["case_sensitive"]
            .as_bool()
            .ok_or("case binding absent")?;
        let normalized = captured_key(&key, sensitive)?;
        for map in ["files", "raw_files", "utf16_files"] {
            for path in request[map]
                .as_object()
                .ok_or("captured map absent")?
                .keys()
            {
                if captured_key(path, sensitive)? == normalized {
                    return Err("physical addition collides with captured Map key".into());
                }
            }
        }
        let bytes = text
            .as_str()
            .ok_or("physical addition text absent")?
            .as_bytes();
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target)
            .map_err(|e| e.to_string())?;
        file.write_all(bytes).map_err(|e| e.to_string())?;
        drop(file);
        let meta = fs::symlink_metadata(&target).map_err(|e| e.to_string())?;
        if !meta.is_file()
            || meta.file_type().is_symlink()
            || fs::read(&target).map_err(|e| e.to_string())? != bytes
        {
            return Err("physical addition differs from authored bytes".into());
        }
        proof.push(json!({"path":name,"physical_sha256":sha(bytes),"bytes":bytes.len(),"present_in_retained_map":false}));
    }
    if fs::read(request_path).map_err(|e| e.to_string())? != before {
        return Err("request bytes changed during physical addition".into());
    }
    Ok(
        json!({"files":proof,"request_sha256_before":sha(&before),"request_sha256_after":sha(&before)}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn comparator_physical_uncaptured_addition_does_not_relax_mutation_or_map_contract() {
        let root = std::env::temp_dir().join(format!(
            "semctx-uncaptured-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&root).unwrap();
        let root = root.canonicalize().unwrap();
        let key = root.join("main.d.ts").to_string_lossy().replace('\\', "/");
        let mut files = serde_json::Map::new();
        files.insert(key, json!("export {};"));
        let request = json!({"files":files,"raw_files":{},"utf16_files":{},"case_sensitive":true});
        let path = root.join("request.json");
        save(&path, &request).unwrap();
        let before = fs::read(&path).unwrap();
        assert_eq!(
            captured_key("//?/C:/repo/owned.ts", true).unwrap(),
            "C:/repo/owned.ts"
        );
        assert!(captured_key("//?/UNC/server/repo/owned.ts", true).is_err());
        assert!(captured_key("//server/repo/owned.ts", true).is_err());
        assert!(apply(&request, &json!({"../outside.ts":"x"}), &root, &path).is_err());
        let collision = apply(&request, &json!({"main.d.ts":"x"}), &root, &path).unwrap_err();
        assert!(collision.contains("captured Map"), "{collision}");
        let proof = apply(&request, &json!({"main.ts":"physical only"}), &root, &path).unwrap();
        assert_eq!(proof["files"][0]["present_in_retained_map"], false);
        assert_eq!(fs::read(&path).unwrap(), before);
        assert_eq!(request["files"].as_object().unwrap().len(), 1);
        assert!(apply(&request, &json!({"main.ts":"again"}), &root, &path).is_err());
        assert!(apply(&request, &json!({"request.json":"overwrite"}), &root, &path).is_err());
        fs::remove_file(root.join("main.ts")).unwrap();
        fs::remove_file(path).unwrap();
        fs::remove_dir(root).unwrap();
    }
}
