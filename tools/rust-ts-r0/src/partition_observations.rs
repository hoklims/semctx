use super::*;

fn components(
    frontend: &compiler::NewProgram,
    fs: &CaptureFs,
    repository: &str,
    roots: &[String],
) -> Result<serde_json::Value, String> {
    if let Some(error) = &frontend.module_resolution_error {
        return Err(format!("PARTITION_MODULE_RESOLUTION_ERROR:{error}"));
    }
    let prefix = format!("{}/", fs.key(repository).trim_end_matches('/'));
    let mut loaded = BTreeMap::new();
    for source in frontend.get_source_files() {
        if source.root.is_nil() {
            return Err("PARTITION_LOADED_SOURCE_UNAVAILABLE".into());
        }
        let filename = ast::source_file_file_name(source.root);
        let key = fs.key(filename);
        let Some(relative) = key.strip_prefix(&prefix) else {
            continue;
        };
        if relative.split('/').any(|part| part == "node_modules") {
            continue;
        }
        let relative = relative_source_path(repository, filename, fs.sensitive)?;
        if loaded.insert(key, (relative, source)).is_some() {
            return Err("PARTITION_DUPLICATE_LOADED_SOURCE".into());
        }
    }
    let mut selected = BTreeMap::new();
    for path in roots {
        let source = frontend
            .get_source_file(path)
            .ok_or("PARTITION_SELECTED_SOURCE_UNAVAILABLE")?;
        if ast::source_file_info(source.root).is_declaration_file {
            continue;
        }
        let key = fs.key(ast::source_file_file_name(source.root));
        let (relative, _) = loaded
            .get(&key)
            .ok_or("PARTITION_SELECTED_SOURCE_OUTSIDE_GRAPH")?;
        if selected.insert(key, relative.clone()).is_some() {
            return Err("PARTITION_DUPLICATE_SELECTED_SOURCE".into());
        }
    }
    let mut adjacent = loaded
        .keys()
        .map(|key| (key.clone(), BTreeSet::new()))
        .collect::<BTreeMap<_, BTreeSet<String>>>();
    let mut edges = BTreeSet::new();
    for (from, (relative, source)) in &loaded {
        for literal in &source.imports {
            if literal.is_nil() || !ast::is_string_literal_like(*literal) {
                return Err("PARTITION_NATIVE_MODULE_SPECIFIER_UNAVAILABLE".into());
            }
            let Some(resolved) = frontend
                .get_resolved_module_from_module_specifier(source.as_ref(), *literal)
                .filter(|resolved| !resolved.resolved_file_name.is_empty())
            else {
                continue;
            };
            let target = fs.key(&resolved.resolved_file_name);
            let Some((target_relative, _)) = loaded.get(&target) else {
                continue;
            };
            adjacent.get_mut(from).unwrap().insert(target.clone());
            adjacent.get_mut(&target).unwrap().insert(from.clone());
            edges.insert((
                relative.clone(),
                literal.text().to_owned(),
                target_relative.clone(),
            ));
        }
    }
    let mut visited = BTreeSet::new();
    let mut groups = vec![];
    for start in selected.keys() {
        if visited.contains(start) {
            continue;
        }
        let mut pending = vec![start.clone()];
        let mut group = vec![];
        while let Some(key) = pending.pop() {
            if !visited.insert(key.clone()) {
                continue;
            }
            if let Some(relative) = selected.get(&key) {
                group.push(relative.clone());
            }
            pending.extend(adjacent[&key].iter().cloned());
        }
        group.sort_by(|left, right| left.encode_utf16().cmp(right.encode_utf16()));
        groups.push(group);
    }
    groups.sort_by_key(|group| {
        group
            .iter()
            .map(|path| path.encode_utf16().collect::<Vec<_>>())
            .collect::<Vec<_>>()
    });
    let mut loaded_paths = loaded
        .values()
        .map(|(relative, _)| relative.clone())
        .collect::<Vec<_>>();
    loaded_paths.sort_by(|left, right| left.encode_utf16().cmp(right.encode_utf16()));
    let mut selected_paths = selected.into_values().collect::<Vec<_>>();
    selected_paths.sort_by(|left, right| left.encode_utf16().cmp(right.encode_utf16()));
    let edges = edges
        .into_iter()
        .map(|(from, specifier, to)| serde_json::json!({"from":from,"specifier":specifier,"to":to}))
        .collect::<Vec<_>>();
    Ok(serde_json::json!({
        "executed":true,"unsupported":[],
        "loadedRepositorySources":loaded_paths,
        "selectedRoots":selected_paths,
        "dependencyComponents":groups,
        "resolvedEdges":edges,
        "observationScope":"native_loaded_repository_module_components",
        "parallelSafetyEvaluated":false,
        "globalAdmissionInferred":false
    }))
}

pub fn observe(
    frontend: &compiler::NewProgram,
    fs: &CaptureFs,
    repository: &str,
    roots: &[String],
) -> serde_json::Value {
    components(frontend, fs, repository, roots).unwrap_or_else(|error| {
        serde_json::json!({"executed":false,"unsupported":[error],"observationScope":"native_loaded_repository_module_components","parallelSafetyEvaluated":false,"globalAdmissionInferred":false})
    })
}
