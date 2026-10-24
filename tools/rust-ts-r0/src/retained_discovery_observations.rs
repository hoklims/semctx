use super::*;
use serde_json::{Value, json};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DiscoveredRequest {
    analysis: Request,
    discovered_sources: Vec<DiscoveredSource>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DiscoveredSource {
    rel_path: String,
    content: String,
}

pub(super) fn observe(descriptor: Value, sdk: &Sdk) -> Result<Value, String> {
    let request: DiscoveredRequest = serde_json::from_value(descriptor)
        .map_err(|error| format!("RETAINED_DISCOVERY_REQUEST_INVALID:{error}"))?;
    let analysis = &request.analysis;
    if !analysis.retained {
        return Err("SOURCE_SNAPSHOT_REQUIRED".into());
    }
    if !analysis.raw_files.is_empty() || !analysis.utf16_files.is_empty() {
        return Err("RETAINED_DISCOVERY_TEXT_CAPTURE_REQUIRED".into());
    }
    let normalizer = CaptureFs::new(BTreeMap::new(), analysis.case_sensitive);
    let mut captured = BTreeMap::new();
    for (path, content) in &analysis.files {
        if captured.insert(normalizer.key(path), content).is_some() {
            return Err(format!("conflicting captured key: {path}"));
        }
    }
    let mut roots = BTreeMap::new();
    for path in &analysis.roots {
        let relative = relative_source_path(&analysis.cwd, path, analysis.case_sensitive)?;
        if [".d.ts", ".d.mts", ".d.cts"]
            .iter()
            .any(|suffix| path.ends_with(suffix))
        {
            continue;
        }
        if ![".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]
            .iter()
            .any(|suffix| path.ends_with(suffix))
        {
            return Err(format!("RETAINED_DISCOVERY_UNSUPPORTED_SOURCE:{relative}"));
        }
        if roots.insert(normalizer.key(path), relative).is_some() {
            return Err("RETAINED_DISCOVERY_DUPLICATE_ROOT".into());
        }
    }
    if roots.is_empty() {
        return Err("RETAINED_DISCOVERY_SOURCE_ROOT_REQUIRED".into());
    }
    let mut discovered = BTreeMap::new();
    for source in request.discovered_sources {
        if source.rel_path.is_empty()
            || source.rel_path.contains(['\\', ':', '\0'])
            || source
                .rel_path
                .split('/')
                .any(|part| matches!(part, "" | "." | ".."))
        {
            return Err("RETAINED_DISCOVERY_RELATIVE_PATH_INVALID".into());
        }
        let key = normalizer.key(&format!("{}/{}", analysis.cwd, source.rel_path));
        if !roots.contains_key(&key) {
            return Err(format!(
                "RETAINED_DISCOVERY_FOREIGN_SOURCE:{}",
                source.rel_path
            ));
        }
        if discovered.insert(key, source.content).is_some() {
            return Err("RETAINED_DISCOVERY_DUPLICATE_SOURCE".into());
        }
    }
    for (key, relative) in &roots {
        let content = discovered
            .get(key)
            .ok_or_else(|| format!("RETAINED_DISCOVERY_SOURCE_MISSING:{relative}"))?;
        if captured.get(key).copied() != Some(content) {
            return Err(format!("SOURCE_SNAPSHOT_MISMATCH: {relative}"));
        }
    }
    let observed = analyze(request.analysis, sdk.clone())?;
    Ok(
        json!({"state":"RETAINED_DISCOVERY_OBSERVED","executed":true,"snapshot_guard_passed":true,"unsupported":[],"native_analysis":observed,"global_admission_inferred":false}),
    )
}

pub fn run(descriptor: Value, sdk: &Sdk) -> Value {
    observe(descriptor, sdk).unwrap_or_else(|error| json!({"state":"RETAINED_DISCOVERY_REFUSED","executed":false,"snapshot_guard_passed":false,"unsupported":[error],"global_admission_inferred":false}))
}

#[cfg(test)]
#[path = "../tests/unit/retained_discovery_observations.rs"]
mod tests;
