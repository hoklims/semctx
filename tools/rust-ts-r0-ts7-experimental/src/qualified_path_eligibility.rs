use super::*;
use semctx_gates::process;
use std::{
    fs,
    io::Read,
    path::{Component, Path, PathBuf},
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Descriptor {
    repository_root: PathBuf,
    process_helper: PathBuf,
    include: Vec<String>,
    exclude: Vec<String>,
    queries: Vec<String>,
}

fn relative_path(path: &Path) -> Option<String> {
    let mut parts = Vec::new();
    for part in path.components() {
        match part {
            Component::Normal(part) => parts.push(part.to_str()?),
            Component::CurDir => {}
            Component::ParentDir => {
                parts.pop()?;
            }
            _ => return None,
        }
    }
    Some(parts.join("/"))
}

fn named_metadata(path: &str) -> bool {
    let name = path.rsplit('/').next().unwrap_or("").to_ascii_lowercase();
    name.starts_with("tsconfig") && name.ends_with(".json")
        || [
            "package.json",
            "pyproject.toml",
            "bun.lock",
            "bun.lockb",
            "package-lock.json",
            "yarn.lock",
            "pnpm-lock.yaml",
        ]
        .contains(&name.as_str())
}

pub(super) fn metadata(root: &Path) -> Result<(BTreeSet<String>, Vec<serde_json::Value>), String> {
    let root = root
        .canonicalize()
        .map_err(|e| format!("ELIGIBILITY_REPOSITORY_UNAVAILABLE:{e}"))?;
    let files = repository_discovery::qualified_metadata_paths(&root)?;
    let mut available = files
        .iter()
        .map(|path| {
            let name = path
                .strip_prefix(&root)
                .map_err(|_| "ELIGIBILITY_METADATA_OUTSIDE_ROOT")?;
            Ok((
                relative_path(name).ok_or("ELIGIBILITY_METADATA_PATH_INVALID")?,
                path.clone(),
            ))
        })
        .collect::<Result<BTreeMap<_, _>, String>>()?;
    let mut retained = available
        .keys()
        .filter(|name| named_metadata(name))
        .cloned()
        .collect::<BTreeSet<_>>();
    let mut pending = retained
        .iter()
        .filter(|path| {
            let name = path.rsplit('/').next().unwrap_or("").to_ascii_lowercase();
            name.starts_with("tsconfig") && name.ends_with(".json")
        })
        .cloned()
        .collect::<Vec<_>>();
    let mut reads = vec![];
    while let Some(name) = pending.pop() {
        let path = available[&name]
            .canonicalize()
            .map_err(|e| format!("ELIGIBILITY_CONFIGURATION_PATH_FAILED:{e}"))?;
        if !path.starts_with(&root) {
            return Err("ELIGIBILITY_CONFIGURATION_OUTSIDE_ROOT".into());
        }
        let mut bytes = Vec::new();
        fs::File::open(&path)
            .and_then(|file| file.take(33_554_433).read_to_end(&mut bytes))
            .map_err(|e| format!("ELIGIBILITY_CONFIGURATION_READ_FAILED:{e}"))?;
        if bytes.len() > 33_554_432 {
            return Err("ELIGIBILITY_CONFIGURATION_SIZE_LIMIT".into());
        }
        reads.push(serde_json::json!({"path":path,"content_id":identity::digest_bytes(&bytes)}));
        let text = String::from_utf8_lossy(&bytes);
        for reference in retained_manifest::extended_configs(&name, &text) {
            let reference = String::from_utf16_lossy(&source_text::to_units(&reference));
            if !reference.starts_with('.') {
                continue;
            }
            let target = Path::new(&name)
                .parent()
                .unwrap_or(Path::new(""))
                .join(reference);
            let Some(mut target) = relative_path(&target) else {
                continue;
            };
            if !target.to_ascii_lowercase().ends_with(".json") {
                target.push_str(".json");
            }
            if !available.contains_key(&target) {
                let path = root.join(&target);
                match path.canonicalize() {
                    Ok(actual) if !actual.starts_with(&root) => {
                        return Err("ELIGIBILITY_CONFIGURATION_OUTSIDE_ROOT".into());
                    }
                    Ok(actual) if actual.is_file() => {
                        available.insert(target.clone(), path);
                    }
                    Ok(_) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    Err(error) => {
                        return Err(format!("ELIGIBILITY_CONFIGURATION_PATH_FAILED:{error}"));
                    }
                }
            }
            if available.contains_key(&target) && retained.insert(target.clone()) {
                pending.push(target);
            }
        }
    }
    Ok((retained, reads))
}

fn observe(value: serde_json::Value) -> Result<serde_json::Value, String> {
    let request: Descriptor =
        serde_json::from_value(value).map_err(|e| format!("ELIGIBILITY_REQUEST_INVALID:{e}"))?;
    if request.queries.is_empty() || request.queries.len() > 4096 {
        return Err("ELIGIBILITY_QUERY_COUNT_INVALID".into());
    }
    if request.queries.iter().any(|path| {
        path.is_empty()
            || path.contains(['\\', '\0', ':'])
            || path
                .split('/')
                .any(|p| p.is_empty() || p == "." || p == "..")
    }) {
        return Err("ELIGIBILITY_QUERY_PATH_INVALID".into());
    }
    let root = request
        .repository_root
        .canonicalize()
        .map_err(|e| format!("ELIGIBILITY_REPOSITORY_UNAVAILABLE:{e}"))?;
    if !root.is_dir() {
        return Err("ELIGIBILITY_REPOSITORY_NOT_DIRECTORY".into());
    }
    let helper_before = fs::read(&request.process_helper)
        .map(|b| identity::digest_bytes(&b))
        .map_err(|e| format!("ELIGIBILITY_HELPER_UNAVAILABLE:{e}"))?;
    let argv = vec![
        "git".into(),
        "ls-files".into(),
        "-z".into(),
        "--cached".into(),
        "--others".into(),
        "--exclude-per-directory=.gitignore".into(),
    ];
    let git = process::run_with_helper(&argv, &root, 5_000, 8_388_608, &request.process_helper)
        .map_err(|e| format!("ELIGIBILITY_GIT_CAPTURE_FAILED:{e}"))?;
    let helper_after = fs::read(&request.process_helper)
        .map(|b| identity::digest_bytes(&b))
        .map_err(|e| e.to_string())?;
    if helper_before != helper_after {
        return Err("ELIGIBILITY_HELPER_CHANGED".into());
    }
    if git.kind != "success" || git.exit_code != Some(0) {
        let error = if git.kind == "nonzero" {
            serde_json::json!({"code":"IO_ERROR","message":"qualified discovery could not establish Git source eligibility"})
        } else {
            serde_json::json!({"code":"GIT_ERROR","message":"Git eligibility capture did not complete","kind":git.kind})
        };
        return Ok(
            serde_json::json!({"executed":true,"unsupported":[],"observation_scope":"native_qualified_path_eligibility","repositoryRoot":root,"eligibility_established":false,"eligible_results":null,"error":error,"git_argv":argv,"git_outcome":git,"helper_sha256":helper_before,"reads":[],"global_admission_inferred":false}),
        );
    }
    let authored = git
        .stdout
        .split('\0')
        .filter(|path| !path.is_empty())
        .map(str::to_owned)
        .collect::<BTreeSet<_>>();
    let (metadata, reads) = metadata(&root)?;
    let matches = |patterns: &[String], path: &str| {
        patterns
            .iter()
            .any(|pattern| retained_aliases::matches(&pattern.replace('\\', "/"), path))
    };
    let results = request
        .queries
        .iter()
        .map(|path| {
            let parts = path.split('/').collect::<Vec<_>>();
            if parts
                .iter()
                .any(|part| repository_discovery::HARD_IGNORED.contains(part))
            {
                return false;
            }
            if !parts
                .iter()
                .any(|part| repository_discovery::OUTPUT_DIRECTORIES.contains(part))
            {
                return true;
            }
            let ignore = parts
                .last()
                .is_some_and(|name| [".gitignore", ".gitattributes"].contains(name));
            ignore
                || named_metadata(path)
                || metadata.contains(path)
                || authored.contains(path)
                || matches(&request.include, path) && !matches(&request.exclude, path)
        })
        .collect::<Vec<_>>();
    Ok(
        serde_json::json!({"executed":true,"unsupported":[],"observation_scope":"native_qualified_path_eligibility","repositoryRoot":root,"eligibility_established":true,"eligible_results":results,"error":null,"queries":request.queries,"retained_metadata":metadata,"git_argv":argv,"git_outcome":git,"helper_sha256":helper_before,"reads":reads,"global_admission_inferred":false}),
    )
}

pub(super) fn run(value: serde_json::Value) -> serde_json::Value {
    observe(value).unwrap_or_else(|error|serde_json::json!({"executed":false,"eligibility_established":false,"eligible_results":null,"unsupported":[error],"global_admission_inferred":false}))
}

#[cfg(test)]
#[path = "../tests/unit/qualified_path_eligibility.rs"]
mod tests;
