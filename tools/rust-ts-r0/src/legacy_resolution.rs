use super::*;
use ts_goport::frontend::module::{
    DefaultResolver, Extensions, ModuleResolvedProjectReference, ResolutionState, Resolved,
};
use ts_goport::frontend::{
    packagejson::{ExportsOrImports, InfoCacheEntry, JSONValueType},
    semver, tspath,
};

#[derive(Clone, Copy, Debug)]
pub(super) enum LegacyMode {
    Node10,
    Classic,
}

#[expect(
    clippy::excessive_nesting,
    reason = "The native SDK resolution branches retain their explicit precedence in this feasibility port."
)]
pub(super) fn resolve(
    resolver: &DefaultResolver,
    mode: LegacyMode,
    module_name: &str,
    containing_directory: &str,
    resolution_mode: ts_goport::options::ResolutionMode,
    redirected_reference: Option<&dyn ModuleResolvedProjectReference>,
    base_url: Option<&str>,
) -> Result<program::ResolvedModule, String> {
    let mut state = module::new_resolution_state(
        module_name,
        containing_directory,
        false,
        resolution_mode,
        &resolver.compiler_options,
        redirected_reference,
        resolver,
        resolver.new_trace_builder(),
    );
    state.features = module::NodeResolutionFeatures::NONE;
    state.esm_mode = false;
    state.conditions.clear();
    let typed = Extensions::TYPE_SCRIPT | Extensions::DECLARATION;
    let remaining = state.extensions & !typed;
    for extensions in [state.extensions & typed, remaining] {
        if extensions.0 == 0 {
            continue;
        }
        state.extensions = extensions;
        let found = optional_settings(&mut state, mode, extensions, base_url)?;
        if found.is_some() {
            return Ok(state.create_resolved_module_handling_symlink(found));
        }
        let found = if tspath::is_external_module_name_relative(module_name) {
            let candidate =
                module::normalize_path_for_cjs_resolution(containing_directory, module_name);
            load_candidate(&mut state, mode, extensions, &candidate)?
        } else if module_name.contains(':') {
            None
        } else if matches!(mode, LegacyMode::Node10) {
            match nearest_packages(&mut state, extensions, false, 0)? {
                Some(found) => Some(found),
                None => type_roots(&mut state, extensions)?,
            }
        } else {
            classic_search(&mut state, extensions)?
        };
        if found.is_some() {
            if matches!(mode, LegacyMode::Node10)
                && !tspath::is_external_module_name_relative(module_name)
            {
                let mut found = found;
                if state.compiler_options.preserve_symlinks != Tristate::True {
                    let target = found.as_ref().unwrap();
                    if target.original_path.is_empty() {
                        let (original, resolved) =
                            state.get_original_and_resolved_file_name(&target.path);
                        if !original.is_empty() {
                            found.as_mut().unwrap().original_path = original;
                            found.as_mut().unwrap().path = resolved;
                        }
                    }
                }
                return Ok(state.create_resolved_module(found, true));
            }
            return Ok(state.create_resolved_module_handling_symlink(found));
        }
    }
    Ok(state.create_resolved_module_handling_symlink(None))
}

pub(super) fn base_url(configuration: &crate::configuration::Configuration) -> Option<String> {
    let mut effective = None;
    for (config_path, raw) in &configuration.raw_chain {
        let tsoptions::CompilerOptionsValue::Map(raw) = raw else {
            continue;
        };
        let Some(tsoptions::CompilerOptionsValue::Map(values)) = raw.get("compilerOptions") else {
            continue;
        };
        match values.get("baseUrl") {
            Some(tsoptions::CompilerOptionsValue::String(value)) => {
                effective = Some(tspath::get_normalized_absolute_path(
                    value,
                    &tspath::get_directory_path(config_path),
                ))
            }
            Some(tsoptions::CompilerOptionsValue::Nil) => effective = None,
            _ => {}
        }
    }
    effective
}

fn load_candidate(
    state: &mut ResolutionState<'_>,
    mode: LegacyMode,
    extensions: Extensions,
    candidate: &str,
) -> Result<Option<Resolved>, String> {
    if matches!(mode, LegacyMode::Classic) {
        return Ok(state.load_module_from_file(extensions, candidate));
    }
    load_node_candidate(state, extensions, candidate, true)
}

fn optional_settings(
    state: &mut ResolutionState<'_>,
    mode: LegacyMode,
    extensions: Extensions,
    base_url: Option<&str>,
) -> Result<Option<Resolved>, String> {
    let options = state.compiler_options.clone();
    let name = state.name.clone();
    let directory = state.containing_directory.clone();
    if !tspath::path_is_relative(&name) && options.paths.is_some() {
        let base = base_url.map(str::to_owned).unwrap_or_else(|| {
            options.get_paths_base_path(state.resolver.host.get_current_directory())
        });
        let patterns = state.get_parsed_patterns_for_paths();
        let mut error = None;
        let found = state.try_load_module_using_paths(
            extensions,
            &name,
            &base,
            options.paths.as_ref(),
            &patterns,
            &mut |state, ext, path| match load_candidate(state, mode, ext, path) {
                Ok(value) => value,
                Err(value) => {
                    error = Some(value);
                    None
                }
            },
        );
        if let Some(error) = error {
            return Err(error);
        }
        if found.is_some() {
            return Ok(found);
        }
    }
    if !tspath::is_external_module_name_relative(&name) {
        return match base_url {
            Some(base) => load_candidate(
                state,
                mode,
                extensions,
                &tspath::get_normalized_absolute_path(&name, base),
            ),
            None => Ok(None),
        };
    }
    let Some(roots) = &options.root_dirs else {
        return Ok(None);
    };
    let candidate = tspath::get_normalized_absolute_path(&name, &directory);
    let matching = roots
        .iter()
        .map(|root| tspath::ensure_trailing_directory_separator(&tspath::normalize_path(root)))
        .filter(|root| candidate.starts_with(root))
        .max_by_key(String::len);
    let Some(matching) = matching else {
        return Ok(None);
    };
    if let Some(found) = load_candidate(state, mode, extensions, &candidate)? {
        return Ok(Some(found));
    }
    let suffix = &candidate[matching.len()..];
    for root in roots {
        if tspath::ensure_trailing_directory_separator(&tspath::normalize_path(root)) == matching {
            continue;
        }
        if let Some(found) = load_candidate(
            state,
            mode,
            extensions,
            &tspath::get_normalized_absolute_path(suffix, root),
        )? {
            return Ok(Some(found));
        }
    }
    Ok(None)
}

type VersionMappings = Vec<(String, Option<Vec<String>>)>;

#[expect(
    clippy::excessive_nesting,
    reason = "The native SDK resolution branches retain their explicit precedence in this feasibility port."
)]
fn version_mappings(info: &Option<Rc<InfoCacheEntry>>) -> Result<Option<VersionMappings>, String> {
    let Some(contents) = info.as_ref().and_then(|entry| entry.contents.as_ref()) else {
        return Ok(None);
    };
    let value = &contents.fields.path_fields.types_versions;
    if value.type_ != JSONValueType::OBJECT {
        return Ok(None);
    }
    let mut entries: Vec<_> = value.as_object().iter().enumerate().collect();
    entries.sort_by_key(|(index, (key, _))| {
        match key
            .parse::<u32>()
            .ok()
            .filter(|n| *n != u32::MAX && n.to_string() == **key)
        {
            Some(value) => (0, value as usize),
            None => (1, *index),
        }
    });
    let version = semver::try_parse_version("5.9.3").unwrap();
    for (_, (key, value)) in entries {
        let (range, valid) = semver::try_parse_version_range(key);
        if !valid || !range.test(&version) {
            continue;
        }
        if value.type_ != JSONValueType::OBJECT {
            return Ok(None);
        }
        let mut mappings = vec![];
        for (pattern, value) in value.as_object() {
            let substitutions = match value.type_ {
                JSONValueType::ARRAY => {
                    let mut result = vec![];
                    for value in value.as_array() {
                        if value.type_ != JSONValueType::STRING {
                            return Err("NATIVE_SDK59_VERSION_PATH_ELEMENT_UNAVAILABLE".into());
                        }
                        result.push(value.as_string().to_owned());
                    }
                    Some(result)
                }
                JSONValueType::STRING => {
                    return Err("NATIVE_SDK59_SCALAR_VERSION_PATH_UNAVAILABLE".into());
                }
                _ => None,
            };
            mappings.push((pattern.clone(), substitutions));
        }
        return Ok(Some(mappings));
    }
    Ok(None)
}

type ModuleLoader<'a> =
    dyn FnMut(&mut ResolutionState<'_>, Extensions, &str) -> Result<Option<Resolved>, String> + 'a;

fn version_paths(
    state: &mut ResolutionState<'_>,
    extensions: Extensions,
    name: &str,
    base: &str,
    mappings: &VersionMappings,
    loader: &mut ModuleLoader<'_>,
) -> Result<Option<Option<Resolved>>, String> {
    let paths = mappings.iter().cloned().collect();
    let patterns = module::try_parse_patterns(Some(&paths));
    if !module::match_pattern_or_exact(&patterns, name).is_valid() {
        return Ok(None);
    }
    let mut error = None;
    let found = state.try_load_module_using_paths(
        extensions,
        name,
        base,
        Some(&paths),
        &patterns,
        &mut |state, ext, path| match loader(state, ext, path) {
            Ok(value) => value,
            Err(value) => {
                error = Some(value);
                None
            }
        },
    );
    if let Some(error) = error {
        return Err(error);
    }
    Ok(Some(found))
}

fn load_node_candidate(
    state: &mut ResolutionState<'_>,
    extensions: Extensions,
    candidate: &str,
    consider_package_json: bool,
) -> Result<Option<Resolved>, String> {
    if !tspath::has_trailing_directory_separator(candidate)
        && let Some(mut found) = state.load_module_from_file(extensions, candidate)
    {
        if consider_package_json {
            let package = module::node_module_package_root_for_file(&found.path);
            if !package.is_empty() {
                let info = state.get_package_json_info(&package);
                found.package_id = state.get_package_id(&found.path, &info);
            }
        }
        return Ok(Some(found));
    }
    let candidate = tspath::remove_trailing_directory_separator(candidate);
    if state.esm_mode {
        return Ok(None);
    }
    if !state.resolver.host.fs().directory_exists(candidate) {
        return Ok(None);
    }
    let info = if consider_package_json {
        state.get_package_json_info(candidate)
    } else {
        None
    };
    let found = load_directory(state, extensions, candidate, &info)?;
    Ok(with_package_id(state, found, &info))
}

fn load_directory(
    state: &mut ResolutionState<'_>,
    extensions: Extensions,
    candidate: &str,
    info: &Option<Rc<InfoCacheEntry>>,
) -> Result<Option<Resolved>, String> {
    let mappings = version_mappings(info)?;
    let mut package_file = String::new();
    if info.as_ref().is_some_and(|info| {
        tspath::compare_paths(
            candidate,
            &info.package_directory,
            &tspath::ComparePathsOptions {
                use_case_sensitive_file_names: state
                    .resolver
                    .host
                    .fs()
                    .use_case_sensitive_file_names(),
                ..Default::default()
            },
        ) == 0
    }) {
        package_file = state.get_package_file(extensions, info).0;
    }
    let mut loader = |state: &mut ResolutionState<'_>, ext, path: &str| {
        if let Some(found) = state.load_file_name_from_package_json_field(ext, path, "") {
            return Ok(Some(found));
        }
        let ext = if ext == Extensions::DECLARATION {
            Extensions::TYPE_SCRIPT | Extensions::DECLARATION
        } else {
            ext
        };
        let saved = state.candidate_ending_is_from_config;
        let saved_esm = state.esm_mode;
        state.candidate_ending_is_from_config = true;
        if info
            .as_ref()
            .and_then(|info| info.contents.as_ref())
            .is_none_or(|contents| contents.fields.header_fields.type_.value != "module")
        {
            state.esm_mode = false;
        }
        let found = load_node_candidate(state, ext, path, false);
        state.candidate_ending_is_from_config = saved;
        state.esm_mode = saved_esm;
        found
    };
    let index = tspath::combine_paths(candidate, &["index"]);
    if let Some(mappings) = mappings.filter(|_| {
        package_file.is_empty()
            || tspath::contains_path(candidate, &package_file, &Default::default())
    }) {
        let name = tspath::get_relative_path_from_directory(
            candidate,
            if package_file.is_empty() {
                &index
            } else {
                &package_file
            },
            &Default::default(),
        );
        if let Some(found) =
            version_paths(state, extensions, &name, candidate, &mappings, &mut loader)?
        {
            return Ok(found);
        }
    }
    if !package_file.is_empty()
        && let Some(found) = loader(state, extensions, &package_file)?
    {
        return Ok(Some(found));
    }
    Ok(if state.esm_mode {
        None
    } else {
        state.load_module_from_file(extensions, &index)
    })
}

fn with_package_id(
    state: &mut ResolutionState<'_>,
    found: Option<Resolved>,
    info: &Option<Rc<InfoCacheEntry>>,
) -> Option<Resolved> {
    found.map(|mut found| {
        found.package_id = state.get_package_id(&found.path, info);
        found
    })
}

fn specific_package(
    state: &mut ResolutionState<'_>,
    extensions: Extensions,
    name: &str,
    node_modules: &str,
    depth: u32,
) -> Result<Option<Resolved>, String> {
    let candidate = tspath::get_normalized_absolute_path(name, node_modules);
    let (package, rest) = module::parse_package_name(name);
    let package_directory = tspath::get_normalized_absolute_path(&package, node_modules);
    let mut info = state.get_package_json_info(&candidate);
    let mut root_info = None;
    if !rest.is_empty()
        && state
            .features
            .intersects(module::NodeResolutionFeatures::EXPORTS)
    {
        root_info = state.get_package_json_info(&package_directory);
    }
    let root_exports_present = root_info
        .as_ref()
        .and_then(|entry| entry.contents.as_ref())
        .is_some_and(|contents| {
            contents.fields.path_fields.exports.json_value.type_ != JSONValueType::NOT_PRESENT
        });
    if !rest.is_empty()
        && info.as_ref().is_some_and(|entry| entry.exists())
        && !root_exports_present
    {
        if let Some(found) = state.load_module_from_file(extensions, &candidate) {
            return Ok(Some(found));
        }
        let found = load_directory(state, extensions, &candidate, &info)?;
        return Ok(with_package_id(state, found, &info));
    }
    if !rest.is_empty() {
        info = root_info.or_else(|| state.get_package_json_info(&package_directory));
    }
    if info.as_ref().is_some_and(|entry| entry.exists()) {
        state.resolved_package_directory = true;
    }
    if state
        .features
        .intersects(module::NodeResolutionFeatures::EXPORTS)
        && info
            .as_ref()
            .and_then(|entry| entry.contents.as_ref())
            .is_some_and(|contents| sdk_truthy(&contents.fields.path_fields.exports))
    {
        return modern_exports(
            state,
            extensions,
            &info,
            &if rest.is_empty() {
                ".".into()
            } else {
                format!("./{rest}")
            },
            depth,
        );
    }
    let mut loader = |state: &mut ResolutionState<'_>, ext, path: &str| {
        let file = if !rest.is_empty() || !state.esm_mode {
            state.load_module_from_file(ext, path)
        } else {
            None
        };
        let found = match file {
            Some(found) => Some(found),
            None => load_directory(state, ext, path, &info)?,
        };
        let found = if found.is_none()
            && rest.is_empty()
            && state.esm_mode
            && info
                .as_ref()
                .and_then(|entry| entry.contents.as_ref())
                .is_some_and(|contents| {
                    matches!(
                        contents.fields.path_fields.exports.json_value.type_,
                        JSONValueType::NOT_PRESENT | JSONValueType::NULL
                    )
                }) {
            state.load_module_from_file(ext, &tspath::combine_paths(path, &["index.js"]))
        } else {
            found
        };
        Ok(with_package_id(state, found, &info))
    };
    if !rest.is_empty()
        && let Some(mappings) = version_mappings(&info)?
        && let Some(found) = version_paths(
            state,
            extensions,
            &rest,
            &package_directory,
            &mappings,
            &mut loader,
        )?
    {
        return Ok(found);
    }
    loader(state, extensions, &candidate)
}

#[expect(
    clippy::excessive_nesting,
    reason = "The native SDK resolution branches retain their explicit precedence in this feasibility port."
)]
fn nearest_packages(
    state: &mut ResolutionState<'_>,
    extensions: Extensions,
    types_only: bool,
    depth: u32,
) -> Result<Option<Resolved>, String> {
    let name = state.name.clone();
    let mut directory = state.containing_directory.clone();
    loop {
        if tspath::get_base_file_name(&directory) != "node_modules" {
            let node_modules = tspath::combine_paths(&directory, &["node_modules"]);
            if state.resolver.host.fs().directory_exists(&node_modules) {
                if !types_only
                    && let Some(found) =
                        specific_package(state, extensions, &name, &node_modules, depth)?
                {
                    return Ok(Some(found));
                }
                if extensions.intersects(Extensions::DECLARATION) {
                    let types = tspath::combine_paths(&node_modules, &["@types"]);
                    if state.resolver.host.fs().directory_exists(&types) {
                        let mangled = module::mangle_scoped_package_name(&name);
                        if let Some(found) = specific_package(
                            state,
                            Extensions::DECLARATION,
                            &mangled,
                            &types,
                            depth,
                        )? {
                            return Ok(Some(found));
                        }
                    }
                }
            }
        }
        let parent = tspath::get_directory_path(&directory);
        if parent == directory || parent.is_empty() {
            break;
        }
        directory = parent;
    }
    Ok(None)
}

fn classic_search(
    state: &mut ResolutionState<'_>,
    extensions: Extensions,
) -> Result<Option<Resolved>, String> {
    let name = state.name.clone();
    let mut directory = state.containing_directory.clone();
    loop {
        let candidate = tspath::get_normalized_absolute_path(&name, &directory);
        if let Some(found) = state.load_module_from_file(extensions, &candidate) {
            return Ok(Some(found));
        }
        let parent = tspath::get_directory_path(&directory);
        if parent == directory || parent.is_empty() {
            break;
        }
        directory = parent;
    }
    if extensions.intersects(Extensions::TYPE_SCRIPT | Extensions::DECLARATION) {
        if let Some(found) = nearest_packages(state, extensions, true, 0)? {
            return Ok(Some(found));
        }
        return type_roots(state, extensions);
    }
    Ok(None)
}

fn type_roots(
    state: &mut ResolutionState<'_>,
    extensions: Extensions,
) -> Result<Option<Resolved>, String> {
    if !extensions.intersects(Extensions::DECLARATION) {
        return Ok(None);
    }
    let Some(roots) = state.compiler_options.type_roots.clone() else {
        return Ok(None);
    };
    for root in roots {
        let candidate = state.get_candidate_from_type_root(&root);
        if let Some(mut found) = state.load_module_from_file(Extensions::DECLARATION, &candidate) {
            let package = module::node_module_package_root_for_file(&found.path);
            if !package.is_empty() {
                let info = state.get_package_json_info(&package);
                found.package_id = state.get_package_id(&found.path, &info);
            }
            return Ok(Some(found));
        }
        if let Some(found) = load_node_candidate(state, Extensions::DECLARATION, &candidate, true)?
        {
            return Ok(Some(found));
        }
    }
    Ok(None)
}

pub(super) fn resolve_modern(
    resolver: &DefaultResolver,
    name: &str,
    directory: &str,
    mode: ts_goport::options::ResolutionMode,
    redirected: Option<&dyn ModuleResolvedProjectReference>,
    base_url: Option<&str>,
) -> Result<program::ResolvedModule, String> {
    let mut state = module::new_resolution_state(
        name,
        directory,
        false,
        mode,
        &resolver.compiler_options,
        redirected,
        resolver,
        resolver.new_trace_builder(),
    );
    modern_state(&mut state, base_url, 0)
}

fn modern_state(
    state: &mut ResolutionState<'_>,
    base_url: Option<&str>,
    depth: u32,
) -> Result<program::ResolvedModule, String> {
    if depth > 64 {
        return Err("NATIVE_SDK59_IMPORT_RECURSION_UNAVAILABLE".into());
    }
    let extensions = state.extensions;
    if let Some(found) = optional_settings(state, LegacyMode::Node10, extensions, base_url)? {
        return Ok(state.create_resolved_module_handling_symlink(Some(found)));
    }
    let name = state.name.clone();
    if tspath::is_external_module_name_relative(&name) {
        let candidate =
            module::normalize_path_for_cjs_resolution(&state.containing_directory, &name);
        let found = load_node_candidate(state, extensions, &candidate, true)?;
        return Ok(state.create_resolved_module_handling_symlink(found));
    }
    if state
        .features
        .intersects(module::NodeResolutionFeatures::IMPORTS)
        && name.starts_with('#')
        && let Some(found) = modern_imports(state, extensions, depth, base_url)?
    {
        return Ok(state.create_resolved_module(Some(found), false));
    }
    if state
        .features
        .intersects(module::NodeResolutionFeatures::SELF_NAME)
        && let Some(found) = modern_self(state, extensions, depth)?
    {
        return Ok(state.create_resolved_module(Some(found), false));
    }
    if name.contains(':') {
        return Ok(state.create_resolved_module(None, false));
    }
    let typed = extensions & (Extensions::TYPE_SCRIPT | Extensions::DECLARATION);
    let secondary = extensions & !(Extensions::TYPE_SCRIPT | Extensions::DECLARATION);
    let mut found = None;
    for ext in [typed, secondary] {
        if ext.0 != 0 {
            found = nearest_packages(state, ext, false, depth)?;
        }
        if found.is_some() {
            break;
        }
    }
    if found.is_none() {
        found = type_roots(state, extensions)?;
    }
    if state.compiler_options.preserve_symlinks != Tristate::True
        && let Some(target) = found
            .as_ref()
            .filter(|target| !target.path.is_empty() && target.original_path.is_empty())
    {
        let (original, resolved) = state.get_original_and_resolved_file_name(&target.path);
        if !original.is_empty() {
            found.as_mut().unwrap().original_path = original;
            found.as_mut().unwrap().path = resolved;
        }
    }
    Ok(state.create_resolved_module(found, true))
}

fn sdk_truthy(target: &ExportsOrImports) -> bool {
    match target.json_value.type_ {
        JSONValueType::NOT_PRESENT | JSONValueType::NULL => false,
        JSONValueType::STRING => !target.json_value.as_string().is_empty(),
        JSONValueType::BOOLEAN => matches!(
            target.json_value.value,
            ts_goport::frontend::packagejson::JsonAny::Bool(true)
        ),
        JSONValueType::NUMBER => {
            matches!(target.json_value.value, ts_goport::frontend::packagejson::JsonAny::Number(value) if value != 0.0)
        }
        _ => true,
    }
}

fn sdk_condition(state: &ResolutionState<'_>, condition: &str) -> bool {
    if condition == "default" || state.conditions.iter().any(|value| value == condition) {
        return true;
    }
    if !state.conditions.iter().any(|value| value == "types") {
        return false;
    }
    let Some(range) = condition.strip_prefix("types@") else {
        return false;
    };
    let (range, valid) = semver::try_parse_version_range(range);
    valid && range.test(&semver::try_parse_version("5.9.3").unwrap())
}

#[expect(
    clippy::too_many_arguments,
    reason = "The native SDK resolution inputs remain explicit in this feasibility port."
)]
fn modern_target(
    state: &mut ResolutionState<'_>,
    ext: Extensions,
    name: &str,
    scope: &Rc<InfoCacheEntry>,
    imports: bool,
    target: &ExportsOrImports,
    subpath: &str,
    pattern: bool,
    key: &str,
    depth: u32,
    base_url: Option<&str>,
) -> Result<Option<Resolved>, String> {
    if depth > 64 {
        return Err("NATIVE_SDK59_IMPORT_RECURSION_UNAVAILABLE".into());
    }
    match target.json_value.type_ {
        JSONValueType::NULL => Ok(None),
        JSONValueType::OBJECT => {
            for (condition, target) in target.as_object() {
                if sdk_condition(state, condition)
                    && let Some(found) = modern_target(
                        state,
                        ext,
                        name,
                        scope,
                        imports,
                        target,
                        subpath,
                        pattern,
                        key,
                        depth + 1,
                        base_url,
                    )?
                {
                    return Ok(Some(found));
                }
            }
            Ok(None)
        }
        JSONValueType::ARRAY => {
            for target in target.as_array() {
                if let Some(found) = modern_target(
                    state,
                    ext,
                    name,
                    scope,
                    imports,
                    target,
                    subpath,
                    pattern,
                    key,
                    depth + 1,
                    base_url,
                )? {
                    return Ok(Some(found));
                }
            }
            Ok(None)
        }
        JSONValueType::STRING if imports && !target.json_value.as_string().starts_with("./") => {
            let target = target.json_value.as_string();
            if target.starts_with("../")
                || target.starts_with('/')
                || tspath::is_rooted_disk_path(target)
                || (!pattern && !subpath.is_empty() && !target.ends_with('/'))
            {
                return Ok(None);
            }
            let target = if pattern {
                target.replace('*', subpath)
            } else {
                format!("{target}{subpath}")
            };
            let saved_name = std::mem::replace(&mut state.name, target);
            let saved_directory = std::mem::replace(
                &mut state.containing_directory,
                tspath::ensure_trailing_directory_separator(&scope.package_directory),
            );
            let saved_extensions = std::mem::replace(&mut state.extensions, ext);
            let result = modern_state(state, base_url, depth + 1);
            state.name = saved_name;
            state.containing_directory = saved_directory;
            state.extensions = saved_extensions;
            let result = result?;
            Ok(result.is_resolved().then(|| Resolved {
                path: result.resolved_file_name,
                extension: result.extension,
                package_id: result.package_id,
                original_path: result.original_path,
                resolved_using_ts_extension: result.resolved_using_ts_extension,
                ..Default::default()
            }))
        }
        _ => Ok(state.load_module_from_target_export_or_import(
            ext, name, scope, imports, target, subpath, pattern, key,
        )),
    }
}

#[expect(
    clippy::too_many_arguments,
    reason = "The native SDK resolution inputs remain explicit in this feasibility port."
)]
fn modern_lookup(
    state: &mut ResolutionState<'_>,
    ext: Extensions,
    name: &str,
    table: &ExportsOrImports,
    scope: &Rc<InfoCacheEntry>,
    imports: bool,
    depth: u32,
    base_url: Option<&str>,
) -> Result<Option<Resolved>, String> {
    let table = table.as_object();
    if !name.ends_with('/')
        && !name.contains('*')
        && let Some(target) = table.get(name)
    {
        return modern_target(
            state, ext, name, scope, imports, target, "", false, name, depth, base_url,
        );
    }
    let mut keys: Vec<_> = table
        .keys()
        .filter(|key| key.matches('*').count() == 1 || key.ends_with('/'))
        .collect();
    keys.sort_by(|left, right| module::compare_pattern_keys(left, right).cmp(&0));
    for key in keys {
        if let Some(star) = key.find('*') {
            let prefix = &key[..star];
            let suffix = &key[star + 1..];
            if name.starts_with(prefix)
                && name.ends_with(suffix)
                && name.len() >= prefix.len() + suffix.len()
                && (suffix.is_empty()
                    || state
                        .features
                        .intersects(module::NodeResolutionFeatures::EXPORTS_PATTERN_TRAILERS))
            {
                return modern_target(
                    state,
                    ext,
                    name,
                    scope,
                    imports,
                    &table[key],
                    &name[prefix.len()..name.len() - suffix.len()],
                    true,
                    key,
                    depth,
                    base_url,
                );
            }
        } else if name.starts_with(key) {
            return modern_target(
                state,
                ext,
                name,
                scope,
                imports,
                &table[key],
                &name[key.len()..],
                false,
                key,
                depth,
                base_url,
            );
        }
    }
    Ok(None)
}

fn modern_exports(
    state: &mut ResolutionState<'_>,
    ext: Extensions,
    info: &Option<Rc<InfoCacheEntry>>,
    subpath: &str,
    depth: u32,
) -> Result<Option<Resolved>, String> {
    let Some(scope) = info.as_ref().filter(|entry| entry.exists()) else {
        return Ok(None);
    };
    let contents = scope.contents.as_ref().unwrap();
    let exports = &contents.fields.path_fields.exports;
    if !sdk_truthy(exports) {
        return Ok(None);
    }
    if subpath == "." {
        let target = match exports.json_value.type_ {
            JSONValueType::STRING | JSONValueType::ARRAY => Some(exports),
            JSONValueType::OBJECT if exports.is_conditions() => Some(exports),
            JSONValueType::OBJECT => exports.as_object().get("."),
            _ => None,
        };
        if let Some(target) = target {
            return modern_target(
                state, ext, subpath, scope, false, target, "", false, ".", depth, None,
            );
        }
    } else if exports.json_value.type_ == JSONValueType::OBJECT && exports.is_subpaths() {
        return modern_lookup(state, ext, subpath, exports, scope, false, depth, None);
    }
    Ok(None)
}

fn modern_imports(
    state: &mut ResolutionState<'_>,
    ext: Extensions,
    depth: u32,
    base_url: Option<&str>,
) -> Result<Option<Resolved>, String> {
    if state.name == "#" || state.name.starts_with("#/") {
        return Ok(None);
    }
    let directory = state.containing_directory.clone();
    let Some(scope) = state
        .get_package_scope_for_path(&directory)
        .filter(|entry| entry.exists())
    else {
        return Ok(None);
    };
    let contents = scope.contents.as_ref().unwrap();
    let imports = &contents.fields.path_fields.imports;
    if imports.json_value.type_ != JSONValueType::OBJECT {
        return Ok(None);
    }
    modern_lookup(
        state,
        ext,
        &state.name.clone(),
        imports,
        &scope,
        true,
        depth,
        base_url,
    )
}

fn modern_self(
    state: &mut ResolutionState<'_>,
    ext: Extensions,
    depth: u32,
) -> Result<Option<Resolved>, String> {
    let directory = state.containing_directory.clone();
    let scope = state.get_package_scope_for_path(&directory);
    let Some(contents) = scope.as_ref().and_then(|entry| entry.contents.as_ref()) else {
        return Ok(None);
    };
    if !sdk_truthy(&contents.fields.path_fields.exports) {
        return Ok(None);
    }
    let (name, valid) = contents.fields.header_fields.name.get_value();
    if !valid || !(state.name == name || state.name.starts_with(&format!("{name}/"))) {
        return Ok(None);
    }
    let subpath = if state.name == name {
        ".".to_owned()
    } else {
        format!("./{}", &state.name[name.len() + 1..])
    };
    if state.compiler_options.get_allow_js()
        && !state.containing_directory.contains("/node_modules/")
    {
        return modern_exports(state, ext, &scope, &subpath, depth);
    }
    for ext in [
        ext & (Extensions::TYPE_SCRIPT | Extensions::DECLARATION),
        ext & !(Extensions::TYPE_SCRIPT | Extensions::DECLARATION),
    ] {
        if ext.0 != 0
            && let Some(found) = modern_exports(state, ext, &scope, &subpath, depth)?
        {
            return Ok(Some(found));
        }
    }
    Ok(None)
}

pub(super) fn type_reference(
    resolver: &DefaultResolver,
    name: &str,
    file: &str,
    mode: ts_goport::options::ResolutionMode,
    redirected: Option<&dyn ModuleResolvedProjectReference>,
) -> Result<module::ResolvedTypeReferenceDirective, String> {
    let options =
        module::get_compiler_options_with_redirect(&resolver.compiler_options, redirected);
    let directory = tspath::get_directory_path(file);
    let (roots, configured_roots) =
        options.get_effective_type_roots(resolver.host.get_current_directory());
    let mut state = module::new_resolution_state(
        name,
        &directory,
        true,
        mode,
        &options,
        redirected,
        resolver,
        resolver.new_trace_builder(),
    );
    if matches!(
        options.module_resolution,
        ModuleResolutionKind::CLASSIC | ModuleResolutionKind::NODE10
    ) {
        state.features = module::NodeResolutionFeatures::NONE;
        state.conditions.clear();
        state.esm_mode = false;
    }
    if mode != ModuleKind::NONE {
        state.features |= module::NodeResolutionFeatures::NODE16_DEFAULT;
        state.conditions = module::get_conditions(&options, mode);
    }
    for root in roots {
        let candidate = state.get_candidate_from_type_root(&root);
        if configured_roots
            && !tspath::has_trailing_directory_separator(&candidate)
            && let Some(mut found) =
                state.load_module_from_file(Extensions::DECLARATION, &candidate)
        {
            let package = module::node_module_package_root_for_file(&found.path);
            if !package.is_empty() {
                let info = state.get_package_json_info(&package);
                found.package_id = state.get_package_id(&found.path, &info);
            }
            return Ok(state.create_resolved_type_reference_directive(Some(found), true));
        }
        let info = state.get_package_json_info(&candidate);
        let found = load_directory(&mut state, Extensions::DECLARATION, &candidate, &info)?;
        if found.is_some() {
            let found = with_package_id(&mut state, found, &info);
            return Ok(state.create_resolved_type_reference_directive(found, true));
        }
    }
    let found = if configured_roots && file.ends_with(module::INFERRED_TYPES_CONTAINING_FILE) {
        None
    } else if !tspath::is_external_module_name_relative(name) {
        nearest_packages(&mut state, Extensions::DECLARATION, false, 0)?
    } else {
        let candidate = module::normalize_path_for_cjs_resolution(&directory, name);
        load_node_candidate(&mut state, Extensions::DECLARATION, &candidate, true)?
    };
    Ok(state.create_resolved_type_reference_directive(found, false))
}

#[cfg(test)]
#[path = "../tests/unit/legacy_resolution.rs"]
mod tests;
