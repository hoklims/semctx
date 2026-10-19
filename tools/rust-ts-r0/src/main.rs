use semctx_r0_probe::{identity, wire};
mod assembly;
mod assembly_observations;
mod batch;
mod captured;
mod captured_confinement;
mod captured_system_observations;
mod component_observations;
mod configuration;
mod configured_resolution_observations;
mod configured_resolver;
#[cfg(test)]
mod development;
mod input_identity;
mod javascript;
mod ordinary;
mod outline;
mod parallel_observations;
mod partition_observations;
mod qualified;
mod repository_discovery;
mod retained_aliases;
mod retained_discovery_observations;
mod retained_manifest;
mod runtime_configuration;
mod source_text;
mod worker_observations;
use captured::Captured;
use serde::{Deserialize, Serialize};
use std::{
    cell::RefCell,
    collections::{BTreeMap, BTreeSet},
    rc::Rc,
    time::SystemTime,
};
use ts_goport::{
    ast,
    astdata::SyntaxKind,
    astnav, core,
    flags::{JsxEmit, ModuleKind, ModuleResolutionKind, ScriptTarget, SymbolFlags},
    frontend::{
        compiler, tsoptions,
        tspath::ComparePathsOptions,
        vfs::{Entries, FileInfo, FileMode, Fs, FsError},
    },
    options::{CompilerOptions, Tristate},
    program,
};

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Request {
    id: String,
    cwd: String,
    sdk_directory: String,
    case_sensitive: bool,
    roots: Vec<String>,
    files: BTreeMap<String, String>,
    options: serde_json::Value,
    #[serde(default)]
    roles: BTreeMap<String, String>,
    #[serde(default)]
    selection: BTreeMap<String, wire::Selection>,
    #[serde(default)]
    disabled: BTreeSet<String>,
    #[serde(default = "retained_default")]
    retained: bool,
    #[serde(default)]
    qualified: bool,
    #[serde(default)]
    utf16_files: BTreeMap<String, Vec<u16>>,
    #[serde(default)]
    raw_files: BTreeMap<String, RawFile>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct RawFile {
    bytes: Vec<u8>,
    profile: source_text::ReadProfile,
}
fn retained_default() -> bool {
    true
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Sdk {
    version: String,
    archive_sha256: String,
    files: BTreeMap<String, String>,
}
#[derive(Clone, Serialize)]
struct Probe {
    operation: String,
    path: String,
    found: bool,
    content_id: Option<String>,
}
struct CaptureFs {
    captured: Captured,
    workspace: Option<captured_system_observations::Workspace>,
    sdk_keys: BTreeSet<String>,
    files: BTreeMap<String, String>,
    dirs: BTreeSet<String>,
    spelling: BTreeMap<String, String>,
    sensitive: bool,
    log: Rc<RefCell<Vec<Probe>>>,
}
impl CaptureFs {
    fn record(&self, operation: &str, path: &str, found: bool) {
        self.log.borrow_mut().push(Probe {
            operation: operation.into(),
            path: path.into(),
            found,
            content_id: None,
        });
    }
    fn key(&self, path: &str) -> String {
        let replaced = path.replace('\\', "/");
        let mut parts = vec![];
        for part in replaced.split('/') {
            match part {
                "" | "." => {}
                ".." => {
                    parts.pop();
                }
                _ => parts.push(part),
            }
        }
        let result = format!("/{}", parts.join("/"));
        if self.sensitive {
            result
        } else {
            result.to_lowercase()
        }
    }
    fn new(files: BTreeMap<String, String>, sensitive: bool) -> Self {
        let mut result = Self {
            captured: Captured::new(BTreeMap::new()),
            workspace: None,
            sdk_keys: BTreeSet::new(),
            files: BTreeMap::new(),
            dirs: BTreeSet::from(["/".into()]),
            spelling: BTreeMap::from([("/".into(), "/".into())]),
            sensitive,
            log: Rc::new(RefCell::new(vec![])),
        };
        for (path, text) in files {
            let path = path.replace('\\', "/");
            let key = result.key(&path);
            result.spelling.insert(key.clone(), path.clone());
            let mut parent = path.as_str();
            while let Some((dir, _)) = parent.rsplit_once('/') {
                let dir = if dir.is_empty() { "/" } else { dir };
                let key = result.key(dir);
                result.dirs.insert(key.clone());
                result
                    .spelling
                    .entry(key)
                    .or_insert_with(|| dir.to_string());
                if dir == "/" {
                    break;
                }
                parent = dir;
            }
            result.files.insert(key, text);
        }
        result.captured = Captured::new(result.files.clone());
        result
    }
    fn with_workspace_root(
        files: BTreeMap<String, String>,
        sensitive: bool,
        root: &str,
        sdk_directory: Option<&str>,
    ) -> Self {
        let mut fs = Self::new(files, sensitive);
        fs.workspace = Some(captured_system_observations::Workspace::build(
            &fs,
            root,
            sdk_directory,
        ));
        fs
    }
    fn resolved_path(&self, path: &str) -> Option<String> {
        if let Some(workspace) = &self.workspace {
            return workspace.resolve(self, path);
        }
        let key = self.key(path);
        (self.files.contains_key(&key) || self.dirs.contains(&key)).then_some(key)
    }
    fn record_resolved(
        &self,
        operation: &str,
        requested: &str,
        physical: Option<&str>,
        found: bool,
    ) {
        let path = physical
            .and_then(|key| self.spelling.get(key).map(String::as_str))
            .unwrap_or(requested);
        self.record(operation, path, found);
    }
    fn retained_read_directory(&self, path: &str) -> Vec<String> {
        self.record("read_directory", path, false);
        vec![]
    }
    fn with_sdk_keys<'a>(
        mut self,
        paths: impl IntoIterator<Item = &'a str>,
    ) -> Result<Self, String> {
        let keys = paths
            .into_iter()
            .map(|path| self.key(path))
            .collect::<BTreeSet<_>>();
        if keys.iter().any(|path| !self.files.contains_key(path)) {
            return Err("CAPTURED_SYSTEM_SDK_FILE_NOT_CAPTURED".into());
        }
        if let Some(workspace) = self.workspace.as_mut() {
            workspace.enable_sdk(keys.clone())?;
        }
        self.sdk_keys = keys;
        Ok(self)
    }
    fn workspace_profile(&self, root: &str, sdk_directory: Option<&str>) -> Result<Self, String> {
        let files = self
            .files
            .iter()
            .map(|(key, text)| {
                (
                    self.spelling
                        .get(key)
                        .cloned()
                        .unwrap_or_else(|| key.clone()),
                    text.clone(),
                )
            })
            .collect();
        let mut profile = Self::new(files, self.sensitive);
        profile.dirs = self.dirs.clone();
        profile.spelling = self.spelling.clone();
        profile.workspace = Some(captured_system_observations::Workspace::build(
            &profile,
            root,
            sdk_directory,
        ));
        let mut profile = profile.with_sdk_keys(self.sdk_keys.iter().map(String::as_str))?;
        profile.log = self.log.clone();
        Ok(profile)
    }
    fn deny(&self, operation: &str, path: &str) -> Result<(), FsError> {
        self.record(operation, path, false);
        Err(FsError::Permission)
    }
}
impl Fs for CaptureFs {
    fn use_case_sensitive_file_names(&self) -> bool {
        self.record("case_sensitive", "", self.sensitive);
        self.sensitive
    }
    fn file_exists(&self, path: &str) -> bool {
        let physical = self.resolved_path(path);
        let closest_configuration = self.workspace.as_ref().is_some_and(|workspace| {
            let key = self.key(path);
            (key == workspace.root || key.starts_with(&format!("{}/", workspace.root)))
                && key.ends_with("/tsconfig.json")
                && self.files.contains_key(&key)
        });
        let found = physical
            .as_ref()
            .is_some_and(|key| self.files.contains_key(key))
            || closest_configuration;
        self.record_resolved("file_exists", path, physical.as_deref(), found);
        found
    }
    fn read_file(&self, path: &str) -> (String, bool) {
        let physical = self.resolved_path(path);
        let value = physical
            .as_ref()
            .and_then(|key| self.captured.read(key))
            .map(str::to_owned);
        self.record_resolved("read_file", path, physical.as_deref(), value.is_some());
        self.log.borrow_mut().last_mut().unwrap().content_id = value
            .as_ref()
            .map(|text| identity::digest_bytes(text.as_bytes()));
        (value.clone().unwrap_or_default(), value.is_some())
    }
    fn directory_exists(&self, path: &str) -> bool {
        let physical = self.resolved_path(path);
        let found = physical.as_ref().is_some_and(|key| self.dirs.contains(key))
            || self
                .workspace
                .as_ref()
                .is_some_and(|workspace| workspace.virtual_node_modules(self, path));
        self.record_resolved("directory_exists", path, physical.as_deref(), found);
        found
    }
    fn get_accessible_entries(&self, path: &str) -> Entries {
        let physical = self.resolved_path(path);
        self.record_resolved(
            "directory_entries",
            path,
            physical.as_deref(),
            physical.as_ref().is_some_and(|key| self.dirs.contains(key)),
        );
        let Some(key) = physical else {
            return Entries {
                files: vec![],
                directories: vec![],
                symlinks: Some(Default::default()),
            };
        };
        let prefix = if key == "/" {
            "/".into()
        } else {
            format!("{key}/")
        };
        let files = self
            .files
            .keys()
            .filter_map(|p| p.strip_prefix(&prefix))
            .filter(|p| !p.contains('/'))
            .map(|name| {
                self.spelling
                    .get(&format!("{prefix}{name}"))
                    .map(|path| path.rsplit('/').next().unwrap_or(name))
                    .unwrap_or(name)
                    .to_string()
            })
            .collect();
        let directories = self
            .dirs
            .iter()
            .filter_map(|p| p.strip_prefix(&prefix))
            .filter(|p| !p.is_empty() && !p.contains('/'))
            .map(|name| {
                self.spelling
                    .get(&format!("{prefix}{name}"))
                    .map(|path| path.rsplit('/').next().unwrap_or(name))
                    .unwrap_or(name)
                    .to_string()
            })
            .collect();
        Entries {
            files,
            directories,
            symlinks: Some(Default::default()),
        }
    }
    fn stat(&self, path: &str) -> Option<FileInfo> {
        let physical = self.resolved_path(path);
        self.record_resolved("stat", path, physical.as_deref(), physical.is_some());
        let key = physical?;
        let file = self.files.get(&key);
        let dir = self.dirs.contains(&key);
        if file.is_none() && !dir {
            return None;
        }
        Some(FileInfo {
            name: key.rsplit('/').next().unwrap_or("").into(),
            size: file.map_or(0, |s| s.len() as i64),
            mode: if dir { FileMode::DIR } else { FileMode(0) },
            mod_time: None,
        })
    }
    fn realpath(&self, path: &str) -> String {
        let physical = self.resolved_path(path);
        self.record_resolved("realpath", path, physical.as_deref(), physical.is_some());
        match physical {
            Some(key) => self.spelling.get(&key).cloned().unwrap_or(key),
            None if self.workspace.is_some() => path.into(),
            None => self.key(path),
        }
    }
    fn write_file(&self, path: &str, _: &str) -> Result<(), FsError> {
        self.deny("write_file", path)
    }
    fn append_file(&self, path: &str, _: &str) -> Result<(), FsError> {
        self.deny("append_file", path)
    }
    fn remove(&self, path: &str) -> Result<(), FsError> {
        self.deny("remove", path)
    }
    fn chtimes(
        &self,
        path: &str,
        _: Option<SystemTime>,
        _: Option<SystemTime>,
    ) -> Result<(), FsError> {
        self.deny("chtimes", path)
    }
}
#[derive(Serialize, Ord, PartialOrd, Eq, PartialEq)]
struct Declaration {
    file: String,
    start_utf16: i32,
    end_utf16: i32,
    default_library: bool,
}
#[derive(Serialize, Ord, PartialOrd, Eq, PartialEq)]
struct Call {
    file: String,
    start_utf16: i32,
    end_utf16: i32,
    callee_text: String,
    symbol_name: Option<String>,
    declarations: Vec<Declaration>,
}
fn calls(node: core::Node, found: &mut Vec<core::Node>) {
    if node.kind() == SyntaxKind::CallExpression {
        found.push(node);
    }
    node.for_each_child(|child| {
        calls(child, found);
        false
    });
}
fn validate_case_mode(captured: bool, native: bool) -> Result<(), String> {
    if captured != native {
        return Err(format!(
            "captured/native case mismatch: captured={captured} native={native}"
        ));
    }
    Ok(())
}

fn relative_source_path(root: &str, path: &str, sensitive: bool) -> Result<String, String> {
    let normalizer = CaptureFs::new(BTreeMap::new(), true);
    let root = normalizer.key(root);
    let path = normalizer.key(path);
    let root_parts = root
        .split('/')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>();
    let path_parts = path
        .split('/')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>();
    if path_parts.len() <= root_parts.len()
        || !root_parts.iter().zip(&path_parts).all(|(root, path)| {
            if sensitive {
                root == path
            } else {
                root.to_lowercase() == path.to_lowercase()
            }
        })
    {
        return Err(format!("source outside repository: {path}"));
    }
    Ok(path_parts[root_parts.len()..].join("/"))
}

fn compiler_options() -> CompilerOptions {
    CompilerOptions {
        target: ScriptTarget::ES2022,
        module: ModuleKind::ES_NEXT,
        module_resolution: ModuleResolutionKind::BUNDLER,
        allow_js: Tristate::True,
        jsx: JsxEmit::PRESERVE,
        skip_lib_check: Tristate::True,
        no_emit: Tristate::True,
        strict: Tristate::False,
        ..Default::default()
    }
}

struct NativeFrontend {
    program: Rc<compiler::NewProgram>,
    resolution: Option<Rc<RefCell<configured_resolver::ResolutionObservations>>>,
}

fn native_frontend(
    fs: Rc<CaptureFs>,
    cwd: &str,
    sdk: &str,
    roots: Vec<String>,
    configured: bool,
) -> NativeFrontend {
    native_frontend_with_options(fs, cwd, sdk, roots, configured, compiler_options())
}

fn ordinary_javascript_frontend(
    fs: Rc<CaptureFs>,
    cwd: &str,
    sdk: &str,
    path: &str,
) -> Result<NativeFrontend, String> {
    let configuration = configuration::inspect(fs.clone(), path, cwd)?;
    let (options, _) = configuration::merge_configured_options(&compiler_options(), &configuration);
    Ok(native_frontend_with_options(
        fs,
        cwd,
        sdk,
        vec![path.to_string()],
        true,
        options,
    ))
}

fn native_frontend_with_options(
    fs: Rc<CaptureFs>,
    cwd: &str,
    sdk: &str,
    roots: Vec<String>,
    configured: bool,
    mut options: CompilerOptions,
) -> NativeFrontend {
    let mut enumeration = options.clone();
    enumeration.types = Some(vec!["*".into()]);
    let names = ts_goport::frontend::module::get_automatic_type_directive_names(
        &enumeration,
        &tsoptions::ResolverHost {
            fs: fs.clone(),
            current_directory: cwd.into(),
        },
    );
    options.types = Some(names);
    let config = Rc::new(tsoptions::new_parsed_command_line(
        Rc::new(options),
        roots,
        None,
        ComparePathsOptions {
            use_case_sensitive_file_names: fs.sensitive,
            current_directory: cwd.into(),
        },
    ));
    let (create_module_resolver, resolution) = if configured {
        let (factory, observations) =
            configured_resolver::factory(fs.clone(), cwd.into(), sdk.into());
        (Some(factory), Some(observations))
    } else {
        (None, None)
    };
    let host = compiler::new_compiler_host(cwd, fs, sdk, None, None, None);
    let options = compiler::ProgramOptions {
        host,
        config,
        use_source_of_project_reference: false,
        single_threaded: Tristate::True,
        typings_location: String::new(),
        project_name: String::new(),
        create_module_resolver,
        skip_module_resolution: false,
    };
    let _empty = core::enter_program(None);
    NativeFrontend {
        program: Rc::new(compiler::new_program(options)),
        resolution,
    }
}

fn javascript_module_resolutions(
    frontend: &NativeFrontend,
    path: &str,
) -> Result<BTreeMap<(i32, i32), String>, String> {
    if let Some(error) = &frontend.program.module_resolution_error {
        return Err(format!(
            "native JavaScript module resolution failed: {error}"
        ));
    }
    if let Some(observations) = &frontend.resolution
        && !observations.borrow().errors.is_empty()
    {
        return Err(format!(
            "native JavaScript resolver errors: {:?}",
            observations.borrow().errors
        ));
    }
    let parsed = frontend
        .program
        .get_source_file(path)
        .ok_or("missing configured JavaScript source")?;
    Ok(parsed
        .imports
        .iter()
        .filter_map(|literal| {
            frontend
                .program
                .get_resolved_module_from_module_specifier(parsed.as_ref(), *literal)
                .filter(|module| !module.resolved_file_name.is_empty())
                .map(|module| {
                    (
                        (literal.pos(), literal.end()),
                        module.resolved_file_name.clone(),
                    )
                })
        })
        .collect())
}

fn all_nodes(node: core::Node, found: &mut Vec<core::Node>) {
    found.push(node);
    node.for_each_child(|child| {
        all_nodes(child, found);
        false
    });
}

fn qualified_span(node: core::Node, sensitive: bool) -> qualified::QualifiedSpan {
    let file = ast::get_source_file_of_node(node);
    let path = ast::source_file_file_name(file).replace('\\', "/");
    let positions = ast::source_file_get_position_map(file);
    qualified::QualifiedSpan {
        path: if sensitive { path } else { path.to_lowercase() },
        start_utf16: positions.utf8_to_utf16(astnav::get_start_of_node(node, file, false)),
        end_utf16: positions.utf8_to_utf16(node.end()),
    }
}

fn ordinary_builtin(specifier: &str) -> Result<bool, String> {
    let inventory: serde_json::Value =
        serde_json::from_str(include_str!("../builtin-modules.json"))
            .map_err(|error| error.to_string())?;
    let name = specifier.strip_prefix("node:").unwrap_or(specifier);
    Ok(inventory["ordinary_modules"]
        .as_array()
        .ok_or("missing ordinary builtin inventory")?
        .iter()
        .any(|value| value.as_str() == Some(name)))
}

fn declared_external(fs: &CaptureFs, path: &str, root: &str, specifier: &str) -> bool {
    let parts = specifier.split('/').collect::<Vec<_>>();
    let package = if specifier.starts_with('@') {
        parts.iter().take(2).copied().collect::<Vec<_>>().join("/")
    } else {
        parts[0].into()
    };
    let mut directory = ts_goport::frontend::tspath::get_directory_path(path);
    loop {
        if relative_source_path(
            root,
            &format!("{directory}/__manifest_context__"),
            fs.sensitive,
        )
        .is_err()
        {
            return false;
        }
        let (text, found) = fs.read_file(&format!("{directory}/package.json"));
        if found {
            let Ok(manifest) = serde_json::from_str::<serde_json::Value>(&text) else {
                return false;
            };
            if manifest["name"].as_str() == Some(&package) {
                return false;
            }
            for field in [
                "dependencies",
                "devDependencies",
                "peerDependencies",
                "optionalDependencies",
            ] {
                if let Some(version) = manifest[field][&package].as_str() {
                    return !["workspace:", "file:", "link:"]
                        .iter()
                        .any(|prefix| version.starts_with(prefix));
                }
            }
        }
        let parent = ts_goport::frontend::tspath::get_directory_path(&directory);
        if parent == directory {
            return false;
        }
        directory = parent;
    }
}

#[expect(
    clippy::too_many_arguments,
    reason = "The feasibility probe keeps captured subject inputs explicit at its boundary."
)]
fn inspect_subject(
    fs: Rc<CaptureFs>,
    path: &str,
    root: &str,
    sdk: &str,
    project: std::sync::Arc<BTreeMap<String, String>>,
    graph: serde_json::Value,
    retained: bool,
    qualified: bool,
) -> Result<serde_json::Value, String> {
    let relative = relative_source_path(root, path, fs.sensitive)?;
    let configuration = configuration::inspect(fs.clone(), path, root)?;
    let ordinary_fs = if retained {
        Rc::new(fs.workspace_profile(root, Some(sdk))?)
    } else {
        fs.clone()
    };
    let first_ordinary_issue = ordinary_fs
        .workspace
        .as_ref()
        .map_or(0, |workspace| workspace.issues.borrow().len());
    let ordinary_configuration = configuration::inspect(ordinary_fs.clone(), path, root)?;
    let ordinary_unsupported = ordinary_fs
        .workspace
        .as_ref()
        .map(|workspace| {
            workspace
                .issues
                .borrow()
                .iter()
                .skip(first_ordinary_issue)
                .filter(|issue| issue.kind == "unsupported")
                .map(|issue| issue.detail.clone())
                .collect::<BTreeSet<_>>()
        })
        .unwrap_or_default();
    let outside = configuration
        .reasons
        .iter()
        .any(|reason| reason == "SOURCE_CONFIGURATION_OUTSIDE_REPOSITORY");
    let component_named_reasons = if retained {
        configuration::unconsumed_named(
            fs.clone(),
            root,
            &project.keys().cloned().collect::<Vec<_>>(),
        )?
    } else {
        vec![]
    };
    let semantic_roots = if retained {
        project
            .keys()
            .filter(|path| {
                [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]
                    .iter()
                    .any(|suffix| path.ends_with(suffix))
            })
            .cloned()
            .collect()
    } else {
        vec![path.to_string()]
    };
    let semantic_fs = if retained {
        fs.clone()
    } else {
        let sdk_key = fs.key(sdk);
        let mut files = fs
            .files
            .iter()
            .filter(|(path, _)| path.starts_with(&format!("{sdk_key}/")))
            .map(|(path, text)| {
                (
                    fs.spelling
                        .get(path)
                        .cloned()
                        .unwrap_or_else(|| path.clone()),
                    text.clone(),
                )
            })
            .collect::<BTreeMap<_, _>>();
        let (text, found) = fs.read_file(path);
        if !found {
            return Err(format!("missing source subject: {path}"));
        }
        files.insert(path.into(), text);
        Rc::new(CaptureFs::new(files, fs.sensitive))
    };
    let is_js = [".js", ".jsx", ".mjs", ".cjs"]
        .iter()
        .any(|suffix| path.ends_with(suffix));
    let frontend = native_frontend(semantic_fs.clone(), root, sdk, semantic_roots, true);
    let link_frontend = (!retained && is_js)
        .then(|| ordinary_javascript_frontend(fs.clone(), root, sdk, path))
        .transpose()?;
    let module_frontend = link_frontend.as_ref().unwrap_or(&frontend);
    let loaded = program::new_program_version(&frontend.program, None);
    let _semantic = core::enter_program(Some(loaded));
    program::bind_all();
    let file = program::get_source_file(path);
    if file.is_nil() {
        return Err(format!("semantic source not loaded: {path}"));
    }
    let positions = ast::source_file_get_position_map(file);
    let parsing:Vec<_>=ast::source_file_diagnostics(file).iter().map(|diagnostic|serde_json::json!({"code":diagnostic.code(),"message":diagnostic.localize(&ts_goport::locale::DEFAULT),"start_utf16":positions.utf8_to_utf16(diagnostic.pos()),"end_utf16":positions.utf8_to_utf16(diagnostic.end())})).collect();
    let semantic_required = qualified || is_js;
    let case_sensitive = fs.sensitive;
    let repository = root.to_string();
    let root = root.to_string();
    let retained_files = project
        .as_ref()
        .iter()
        .map(|(path, text)| (fs.key(path), text.clone()))
        .collect::<BTreeMap<_, _>>();
    let builtin: serde_json::Value = serde_json::from_str(include_str!("../builtin-modules.json"))
        .map_err(|error| error.to_string())?;
    let builtin_modules = builtin["modules"]
        .as_array()
        .ok_or("invalid compiled builtin inventory")?
        .iter()
        .filter_map(|value| value.as_str().map(str::to_string))
        .collect();
    let coordinate_reasons = if qualified {
        graph["integrityReasons"][&relative]
            .as_array()
            .map(|values| {
                values
                    .iter()
                    .filter_map(|value| value.as_str().map(str::to_string))
                    .collect::<BTreeSet<_>>()
            })
            .unwrap_or_default()
    } else {
        BTreeSet::new()
    };
    let runtime = if retained && !outside {
        runtime_configuration::inspect(file, &configuration.options)
    } else {
        runtime_configuration::RuntimeConfiguration::default()
    };
    let retained_scope_syntax =
        component_observations::retained_scope_syntax(file, &relative, retained);
    let (semantic, javascript, mut callable_initializers) = program::with_type_checker_for_file(
        file,
        move |checker| {
            let mut inputs = qualified::QualifiedInputs {
                repository_root: root.clone(),
                retained_files: retained_files.clone(),
                retained_paths: if retained {
                    retained_files.keys().cloned().collect()
                } else {
                    BTreeSet::from([qualified_span(file, case_sensitive).path])
                },
                graph: qualified.then_some(graph),
                builtin_modules,
                case_sensitive,
                retained_callable_coordinates_observed: true,
                inline_callback_ownership_observed: true,
                ..Default::default()
            };
            for captured_path in project.keys() {
                let source = program::get_source_file(captured_path);
                if source.is_nil() {
                    continue;
                }
                let mut nodes = vec![];
                all_nodes(source, &mut nodes);
                for node in nodes {
                    if matches!(
                        node.kind(),
                        SyntaxKind::Identifier
                            | SyntaxKind::PropertyAccessExpression
                            | SyntaxKind::ElementAccessExpression
                    ) && ordinary::retained_callable_coordinate(
                        node,
                        checker,
                        &ordinary::ExtractionContext {
                            repository_root: &root,
                            static_module_links: true,
                            retained: true,
                            javascript_enabled: true,
                            captured_files: Some(&retained_files),
                            case_sensitive,
                        },
                    )
                    .is_some()
                    {
                        inputs
                            .retained_callable_coordinates
                            .insert(qualified_span(node, case_sensitive));
                    }
                }
            }
            let semantic = qualified::inspect_semantic_dependencies(file, checker, &inputs);
            let javascript = javascript::inspect(file, checker, &relative, retained);
            let callable_initializers = if retained {
                component_observations::retained_callable_initializers(
                    file,
                    checker,
                    &ordinary::ExtractionContext {
                        repository_root: &root,
                        static_module_links: true,
                        retained: true,
                        javascript_enabled: true,
                        captured_files: Some(&retained_files),
                        case_sensitive,
                    },
                )
            } else {
                serde_json::json!({"executed":false,"unsupported":["COMPONENT_RETAINED_INPUTS_NOT_ENABLED"],"variables":[]})
            };
            (semantic, javascript, callable_initializers)
        },
    );
    let semantic_observation = component_observations::semantic(&semantic);
    let source_parsing_observation = component_observations::source_parsing(&parsing);
    let module_configuration_observations = component_observations::module_configuration(
        component_observations::ModuleConfigurationInputs {
            source: file,
            path,
            retained,
            named_reasons: &component_named_reasons,
            configuration: &configuration,
            ordinary_configuration: &ordinary_configuration,
            ordinary_unsupported: &ordinary_unsupported,
            semantic: &semantic,
            javascript: &javascript,
            runtime: &runtime,
        },
    );
    let mut unimplemented = if semantic_required {
        semantic.unsupported.clone()
    } else {
        BTreeSet::new()
    };
    if retained && semantic_required && !outside {
        unimplemented.extend(runtime.unsupported.iter().cloned());
    }
    let mut reasons = if qualified || is_js {
        configuration
            .reasons
            .iter()
            .cloned()
            .collect::<BTreeSet<_>>()
    } else {
        BTreeSet::new()
    };
    reasons.extend(coordinate_reasons);
    if is_js || (qualified && !outside) {
        reasons.extend(javascript.reasons.iter().cloned());
    }
    if qualified && !outside {
        reasons.extend(javascript.qualified_scope_reasons.iter().cloned());
        reasons.extend(retained_scope_syntax.reasons.iter().cloned());
    }
    if is_js {
        reasons.extend(
            semantic
                .reasons
                .iter()
                .map(|reason| reason.replacen("SOURCE_", "JAVASCRIPT_", 1)),
        );
    }
    if retained && (qualified || is_js) && !outside {
        reasons.extend(semantic.reasons.iter().cloned());
        reasons.extend(runtime.reasons.iter().cloned());
    }
    for diagnostic in &parsing {
        reasons.insert(format!(
            "{}_PARSE_ERROR:{}:{}",
            if is_js { "JAVASCRIPT" } else { "SOURCE" },
            diagnostic["code"],
            diagnostic["message"]
                .as_str()
                .unwrap_or_default()
                .replace('\n', " ")
        ));
    }
    let javascript_native = javascript.native.clone();
    let exports_json =
        serde_json::to_string(&javascript.static_exports).map_err(|error| error.to_string())?;
    let mut javascript = serde_json::to_value(javascript).map_err(|error| error.to_string())?;
    let graph_metadata = if is_js {
        #[derive(Serialize)]
        struct ResolvedStaticLink<'a> {
            specifier: &'a str,
            resolution: &'static str,
        }
        let parsed = module_frontend
            .program
            .get_source_file(path)
            .ok_or("missing frontend source")?;
        let mut nodes = vec![];
        all_nodes(file, &mut nodes);
        let mut links = vec![];
        for link in javascript["staticModuleLinks"]
            .as_array()
            .ok_or("missing javascript links")?
        {
            let specifier = link["specifier"]
                .as_str()
                .ok_or("invalid javascript specifier")?;
            let literal = nodes.iter().find(|node| {
                !node.is_nil()
                    && node.kind() == SyntaxKind::StringLiteral
                    && node.text() == specifier
                    && !node.parent().is_nil()
                    && matches!(
                        node.parent().kind(),
                        SyntaxKind::ImportDeclaration
                            | SyntaxKind::ExportDeclaration
                            | SyntaxKind::CallExpression
                    )
            });
            let resolved = literal
                .and_then(|literal| {
                    module_frontend
                        .program
                        .get_resolved_module_from_module_specifier(parsed.as_ref(), *literal)
                })
                .filter(|resolved| !resolved.resolved_file_name.is_empty())
                .map(|resolved| resolved.resolved_file_name.clone());
            let external = ordinary_builtin(specifier)?
                || resolved
                    .as_ref()
                    .is_some_and(|path| path.replace('\\', "/").contains("/node_modules/"))
                || (resolved.is_none()
                    && !specifier.starts_with('.')
                    && declared_external(&fs, path, &repository, specifier));
            let resolution = if external {
                "external"
            } else if resolved.is_some() {
                "resolved"
            } else {
                "unresolved"
            };
            if resolution == "unresolved" {
                reasons.insert(format!("JAVASCRIPT_IMPORT_UNRESOLVED:{specifier}"));
            }
            links.push(ResolvedStaticLink {
                specifier,
                resolution,
            });
        }
        let links_json = serde_json::to_string(&links).map_err(|error| error.to_string())?;
        javascript["staticModuleLinks"] = serde_json::json!(links);
        serde_json::json!({"staticExports":exports_json,"staticModuleLinks":links_json})
    } else {
        serde_json::Value::Null
    };
    if let Some(observations) = &module_frontend.resolution {
        unimplemented.extend(observations.borrow().errors.values().cloned());
    }
    if let Some(error) = &module_frontend.program.module_resolution_error {
        unimplemented.insert(format!("NATIVE_MODULE_RESOLUTION_ERROR:{error}"));
    }
    let mut semantic_frontend_unsupported = BTreeSet::new();
    if let Some(observations) = &frontend.resolution {
        semantic_frontend_unsupported.extend(observations.borrow().errors.values().cloned());
    }
    if let Some(error) = &frontend.program.module_resolution_error {
        semantic_frontend_unsupported.insert(format!("NATIVE_MODULE_RESOLUTION_ERROR:{error}"));
    }
    unimplemented.extend(semantic_frontend_unsupported.iter().cloned());
    if retained {
        callable_initializers["unsupported"] = serde_json::json!(semantic_frontend_unsupported);
    }
    let javascript_observation =
        javascript::inspect_javascript_source(javascript::JavaScriptSourceInputs {
            source: file,
            path,
            native: &javascript_native,
            semantic: &semantic,
            configuration: if retained {
                &module_configuration_observations.retained_without_source
            } else {
                &module_configuration_observations.ordinary_without_snapshot
            },
            static_module_links: &javascript["staticModuleLinks"],
            unsupported: &unimplemented,
        });
    if is_js {
        reasons.extend(javascript_observation.reasons.iter().cloned());
        unimplemented.extend(javascript_observation.unsupported.iter().cloned());
        if !javascript_observation.executed {
            unimplemented.insert("JAVASCRIPT_COMPONENT_NOT_EXECUTED".into());
        }
    }
    let outcome = if !parsing.is_empty() || javascript_observation.parse_failed == Some(true) {
        "failed"
    } else if !unimplemented.is_empty() {
        "unknown"
    } else if (qualified || is_js) && !reasons.is_empty() {
        "unsupported"
    } else {
        "analyzed"
    };
    let resolution = frontend.resolution.as_ref().map(|observations| {
        serde_json::to_value(&*observations.borrow()).expect("resolution serialization")
    });
    let source_file_observation = serde_json::json!({
        "executed": true,
        "external_module": ast::is_external_module(file),
        "unsupported": [],
    });
    Ok(
        serde_json::json!({"path":path,"outcome":outcome,"reasons":reasons,"unimplemented":unimplemented,"parseDiagnostics":parsing,"sourceFileObservation":source_file_observation,"retainedScopeSyntaxObservation":retained_scope_syntax,"retainedCallableInitializers":callable_initializers,"semanticObservation":semantic_observation,"sourceParsingObservation":source_parsing_observation,"moduleConfigurationObservations":module_configuration_observations,"javascriptObservation":javascript_observation,"javascript":javascript,"graphMetadata":graph_metadata,"runtimeConfiguration":runtime,"configurationConsumed":configuration.consumed,"admission":"not_evaluated","semanticContextProbes":semantic_fs.log.borrow().clone(),"resolutionObservations":resolution}),
    )
}

#[expect(
    clippy::excessive_nesting,
    reason = "The feasibility probe retains explicit captured request and fact assembly branches."
)]
fn analyze(request: Request, sdk: Sdk) -> Result<serde_json::Value, String> {
    if request.qualified && !request.retained {
        return Err("SOURCE_SNAPSHOT_REQUIRED".into());
    }
    if request.id.is_empty() {
        return Err("empty request identity".into());
    }
    let expected = serde_json::json!({"target":"ES2022","module":"ESNext","moduleResolution":"Bundler","allowJs":true,"jsx":"Preserve","skipLibCheck":true,"noEmit":true,"strict":false});
    if request.options != expected {
        return Err("unsupported explicit options".into());
    }
    let native_case_sensitive =
        ts_goport::frontend::vfs::osvfs_fs().use_case_sensitive_file_names();
    validate_case_mode(request.case_sensitive, native_case_sensitive)?;
    for variable in ["GOPORT_LIB_PARSE_SNAPSHOT", "GOPORT_LIB_SNAPSHOT"] {
        if std::env::var(variable).as_deref() != Ok("0") {
            return Err(format!("captured SDK requires {variable}=0"));
        }
    }
    if sdk.version != "5.9.3"
        || sdk.archive_sha256 != "10e108c9cf7d5f2879053dff18515fb405abf2ccef63eaaf017d9c571687a1d3"
    {
        return Err("foreign SDK descriptor".into());
    }
    let request_identity =
        identity::digest(&serde_json::to_value(&request).map_err(|error| error.to_string())?);
    let input_identity = identity::digest(&batch::input_manifest(&request, &sdk)?);
    let repository_root = request.cwd.clone();
    let roots = request.roots.clone();
    let retained = request.retained;
    let qualified = request.qualified;
    let mut roles = BTreeMap::new();
    for path in &roots {
        if [".d.ts", ".d.mts", ".d.cts"]
            .iter()
            .any(|extension| path.ends_with(extension))
        {
            continue;
        }
        let relative = relative_source_path(&repository_root, path, request.case_sensitive)?;
        let role = request
            .roles
            .get(&relative)
            .map(String::as_str)
            .unwrap_or("source");
        if !matches!(role, "source" | "test") {
            return Err(format!("unknown role: {role}"));
        }
        if roles.insert(relative, role.to_string()).is_some() {
            return Err("duplicate root subject".into());
        }
    }
    if request.roles.keys().any(|path| !roles.contains_key(path)) {
        return Err("foreign role subject".into());
    }
    if request
        .selection
        .keys()
        .any(|path| !roles.contains_key(path))
    {
        return Err("foreign selection subject".into());
    }
    if request.disabled.iter().any(|path| {
        !roles.contains_key(path) || request.selection.get(path) == Some(&wire::Selection::Excluded)
    }) {
        return Err("invalid disabled analysis subject".into());
    }
    let disabled = request.disabled.clone();
    let all_roles = roles.clone();
    let selection = request.selection.clone();
    roles.retain(|path, _| {
        selection.get(path) != Some(&wire::Selection::Excluded) && !disabled.contains(path)
    });
    let program_roots = roots
        .iter()
        .filter(|path| {
            relative_source_path(&repository_root, path, request.case_sensitive)
                .ok()
                .is_some_and(|path| {
                    selection.get(&path) != Some(&wire::Selection::Excluded)
                        && !disabled.contains(&path)
                })
        })
        .cloned()
        .collect::<Vec<_>>();
    let javascript_enabled = program_roots.iter().any(|path| {
        [".js", ".jsx", ".mjs", ".cjs"]
            .iter()
            .any(|extension| path.ends_with(extension))
    });
    let static_module_links = retained || javascript_enabled;
    let mut files = request
        .files
        .into_iter()
        .map(|(path, text)| (path, ts_goport::scanner_util::go_string_from_utf8(text)))
        .collect::<BTreeMap<_, _>>();
    for (path, units) in request.utf16_files {
        if files
            .insert(path, source_text::from_units(&units))
            .is_some()
        {
            return Err("duplicate decoded source path".into());
        }
    }
    for (path, raw) in request.raw_files {
        if files
            .insert(path, source_text::decode(&raw.bytes, raw.profile))
            .is_some()
        {
            return Err("duplicate decoded source path".into());
        }
    }
    let project_files = std::sync::Arc::new(files.clone());
    let sdk_keys = sdk.files.keys().cloned().collect::<Vec<_>>();
    for (path, text) in sdk.files {
        if files
            .insert(path, ts_goport::scanner_util::go_string_from_utf8(text))
            .is_some()
        {
            return Err("duplicate captured path".into());
        }
    }
    let normalizer = CaptureFs::new(BTreeMap::new(), request.case_sensitive);
    let mut keys = BTreeSet::new();
    for path in files.keys() {
        if !keys.insert(normalizer.key(path)) {
            return Err(format!("conflicting captured key: {path}"));
        }
    }
    let fs = if retained {
        CaptureFs::new(files, request.case_sensitive)
    } else {
        CaptureFs::with_workspace_root(
            files,
            request.case_sensitive,
            &request.cwd,
            Some(&request.sdk_directory),
        )
    };
    let fs = Rc::new(fs.with_sdk_keys(sdk_keys.iter().map(String::as_str))?);
    fs.record("captured_cwd", &request.cwd, true);
    captured_confinement::check(
        fs.clone(),
        captured_confinement::Inputs {
            root: &request.cwd,
            sdk_root: &request.sdk_directory,
            roots: &program_roots,
            configured_resolution: static_module_links,
            ordinary_system_resolution: !request.retained && !static_module_links,
        },
    )?;
    let frontend = native_frontend(
        fs.clone(),
        &request.cwd,
        &request.sdk_directory,
        program_roots.clone(),
        static_module_links,
    );
    let loaded = program::new_program_version(&frontend.program, None);
    let _current = core::enter_program(Some(loaded));
    program::bind_all();
    let partition_observation = if !retained && !qualified {
        partition_observations::observe(&frontend.program, &fs, &repository_root, &program_roots)
    } else {
        serde_json::json!({"executed":false,"unsupported":["COMPONENT_ORDINARY_INPUTS_NOT_ENABLED"],"parallelSafetyEvaluated":false,"globalAdmissionInferred":false})
    };
    let mut before_ownership = BTreeMap::new();
    if retained && qualified {
        for path in &roots {
            if [".d.ts", ".d.mts", ".d.cts"]
                .iter()
                .any(|extension| path.ends_with(extension))
            {
                continue;
            }
            let relative = relative_source_path(&repository_root, path, fs.sensitive)?;
            if !roles.contains_key(&relative) {
                continue;
            }
            let subject = inspect_subject(
                fs.clone(),
                path,
                &repository_root,
                &request.sdk_directory,
                project_files.clone(),
                serde_json::json!({"nodes":[],"edges":[]}),
                retained,
                qualified,
            )?;
            before_ownership.insert(relative, subject);
        }
    }
    let mut result = vec![];
    let mut extraction = ordinary::Extraction::default();
    let mut dynamic_imports = BTreeSet::new();
    let mut outlines = BTreeMap::new();
    let captured_files = std::sync::Arc::new(fs.files.clone());
    let case_sensitive = fs.sensitive;
    for path in &roots {
        if [".d.ts", ".d.mts", ".d.cts"]
            .iter()
            .any(|extension| path.ends_with(extension))
        {
            continue;
        }
        let relative = relative_source_path(&repository_root, path, request.case_sensitive)?;
        if selection.get(&relative) == Some(&wire::Selection::Excluded)
            || disabled.contains(&relative)
        {
            continue;
        }
        let file = program::get_source_file(path);
        if file.is_nil() {
            return Err(format!("source not loaded: {path}"));
        }
        outlines.insert(relative.clone(),serde_json::json!({"outline":outline::outline(file,&ast::source_file_text(file),&relative),"moduleLinks":outline::module_links(file,&ast::source_file_text(file))}));
        let dynamic_path = relative.clone();
        let root = repository_root.clone();
        let captured = captured_files.clone();
        let module_resolutions = if !retained
            && [".js", ".jsx", ".mjs", ".cjs"]
                .iter()
                .any(|extension| path.ends_with(extension))
        {
            let configured = ordinary_javascript_frontend(
                fs.clone(),
                &request.cwd,
                &request.sdk_directory,
                path,
            )?;
            Some(javascript_module_resolutions(&configured, path)?)
        } else {
            None
        };
        let mut raw = program::with_type_checker_for_file(file, move |checker| {
            let context = ordinary::ExtractionContext {
                repository_root: &root,
                static_module_links,
                retained,
                javascript_enabled,
                captured_files: Some(&captured),
                case_sensitive,
            };
            match module_resolutions.as_ref() {
                Some(resolutions) => ordinary::extract_with_module_resolutions(
                    file,
                    checker,
                    &relative,
                    &context,
                    Some(resolutions),
                ),
                None => ordinary::extract(file, checker, &relative, &context),
            }
        })?;
        extraction.modules.append(&mut raw.modules);
        extraction.symbols.append(&mut raw.symbols);
        extraction.imports.append(&mut raw.imports);
        extraction.calls.append(&mut raw.calls);
        let mut nodes = vec![];
        calls(file, &mut nodes);
        if roles.get(&dynamic_path).is_some_and(|role| role == "test") {
            dynamic_imports.extend(assembly_observations::test_dynamic_imports(
                file,
                &dynamic_path,
            ));
        }
        let mut rows = program::with_type_checker_for_file(file, move |checker| {
            let mut rows = vec![];
            for node in nodes {
                let expression = node.expression();
                let mut symbol = checker.get_symbol_at_location_exported(expression);
                if symbol.is_some() && checker.sym(symbol).flags.intersects(SymbolFlags::ALIAS) {
                    symbol = checker.get_aliased_symbol(symbol);
                }
                let (name, decls) = if symbol.is_some() {
                    (
                        Some(checker.sym(symbol).name.to_string()),
                        checker.sym(symbol).declarations.to_vec(),
                    )
                } else {
                    (None, vec![])
                };
                let mut declarations = vec![];
                for decl in decls {
                    let owner = ast::get_source_file_of_node(decl);
                    if owner.is_nil() {
                        continue;
                    }
                    let name = ast::source_file_file_name(owner).to_string();
                    let positions = ast::source_file_get_position_map(owner);
                    declarations.push(Declaration {
                        default_library: program::is_source_file_default_library(&name),
                        file: name,
                        start_utf16: positions
                            .utf8_to_utf16(astnav::get_start_of_node(decl, owner, false)),
                        end_utf16: positions.utf8_to_utf16(decl.end()),
                    });
                }
                declarations.sort();
                let positions = ast::source_file_get_position_map(file);
                rows.push(Call {
                    file: ast::source_file_file_name(file).into(),
                    start_utf16: positions
                        .utf8_to_utf16(astnav::get_start_of_node(node, file, false)),
                    end_utf16: positions.utf8_to_utf16(node.end()),
                    callee_text: if expression.kind() == SyntaxKind::PropertyAccessExpression {
                        expression.name().text().into()
                    } else {
                        expression.text().into()
                    },
                    symbol_name: name,
                    declarations,
                });
            }
            rows
        });
        result.append(&mut rows);
    }
    result.sort();
    let mut assembly = assembly::assemble(
        &extraction,
        &roles,
        qualified,
        &repository_root,
        &dynamic_imports,
    )?;
    let named_reasons = if retained {
        configuration::unconsumed_named(
            fs.clone(),
            &repository_root,
            &project_files.keys().cloned().collect::<Vec<_>>(),
        )?
    } else {
        vec![]
    };
    let unresolved_imports = if retained && qualified {
        component_observations::unresolved_import_reasons(
            &extraction.imports,
            &project_files,
            &repository_root,
            case_sensitive,
        )?
    } else {
        BTreeMap::new()
    };
    let mut subjects = vec![];
    for path in &roots {
        if [".d.ts", ".d.mts", ".d.cts"]
            .iter()
            .any(|extension| path.ends_with(extension))
        {
            continue;
        }
        let relative = relative_source_path(&repository_root, path, case_sensitive)?;
        if selection.get(&relative) == Some(&wire::Selection::Excluded) {
            subjects.push(serde_json::json!({"path":relative,"role":all_roles[&relative],"selection":"excluded","outcome":"not_applicable","reasons":[],"unimplemented":[],"admission":"not_evaluated"}));
            continue;
        }
        if disabled.contains(&relative) {
            subjects.push(serde_json::json!({"path":relative,"role":all_roles[&relative],"selection":"selected","outcome":"disabled","reasons":["LANGUAGE_DISABLED"],"unimplemented":[],"admission":"not_evaluated"}));
            continue;
        }
        let mut subject = inspect_subject(
            fs.clone(),
            path,
            &repository_root,
            &request.sdk_directory,
            project_files.clone(),
            assembly.clone(),
            retained,
            qualified,
        )?;
        subject["opaqueCallbackOwnership"] = if retained && qualified {
            let mut removed_graph = assembly.clone();
            removed_graph["edges"] = serde_json::json!([]);
            let removed = inspect_subject(
                fs.clone(),
                path,
                &repository_root,
                &request.sdk_directory,
                project_files.clone(),
                removed_graph.clone(),
                retained,
                qualified,
            )?;
            component_observations::opaque_callback_ownership(
                before_ownership
                    .get(&relative)
                    .ok_or("missing pre-extraction ownership observation")?,
                &subject,
                &removed,
                &assembly,
                &removed_graph,
            )?
        } else {
            serde_json::json!({"executed":false,"unsupported":["COMPONENT_RETAINED_QUALIFIED_INPUTS_NOT_ENABLED"]})
        };
        let unresolved_imports = unresolved_imports
            .get(&relative)
            .cloned()
            .unwrap_or_default();
        if (qualified
            || [".js", ".jsx", ".mjs", ".cjs"]
                .iter()
                .any(|suffix| path.ends_with(suffix)))
            && (!named_reasons.is_empty() || !unresolved_imports.is_empty())
            && !subject["reasons"].as_array().is_some_and(|reasons| {
                reasons
                    .iter()
                    .any(|reason| reason == "SOURCE_CONFIGURATION_OUTSIDE_REPOSITORY")
            })
        {
            let mut reasons = subject["reasons"]
                .as_array()
                .ok_or("invalid subject reasons")?
                .iter()
                .filter_map(|value| value.as_str().map(str::to_string))
                .collect::<BTreeSet<_>>();
            reasons.extend(named_reasons.iter().cloned());
            reasons.extend(
                unresolved_imports
                    .iter()
                    .map(|units| String::from_utf16_lossy(units)),
            );
            subject["reasons"] = serde_json::json!(reasons);
            subject["unresolvedImportReasonsUtf16"] = serde_json::json!(unresolved_imports);
            if subject["outcome"] == "analyzed" {
                subject["outcome"] = serde_json::json!("unsupported");
            }
        }
        subject["path"] = serde_json::json!(relative);
        subject["role"] = serde_json::json!(roles[&relative]);
        subject["selection"] = serde_json::json!("selected");
        subjects.push(subject);
    }
    for node in assembly["nodes"]
        .as_array_mut()
        .ok_or("missing assembled nodes")?
    {
        if node["kind"] != "module" && node["kind"] != "test" {
            continue;
        }
        let Some(subject) = subjects
            .iter()
            .find(|subject| subject["path"] == node["filePath"])
        else {
            continue;
        };
        if subject["graphMetadata"].is_object() {
            node["metadata"] = subject["graphMetadata"].clone();
        }
    }
    let artifact_identity = identity::digest_bytes(
        &std::fs::read(std::env::current_exe().map_err(|error| error.to_string())?)
            .map_err(|error| error.to_string())?,
    );
    let test_dynamic_import_keys = dynamic_imports
        .into_iter()
        .map(|(path, line, specifier)| format!("{path}:{line}:{specifier}"))
        .collect::<Vec<_>>();
    Ok(
        serde_json::json!({"schema_version":1,"request":request.id,"request_id":request_identity,"input_manifest_id":input_identity,"scope_id":identity::digest(&serde_json::json!({"roles":all_roles,"selection":selection})),"producer_artifact_id":artifact_identity,"engine_revision":"780dc512d64f40afebffa6a7028207649fb7ed1c","sdk_version":sdk.version,"calls":result,"raw_extraction":extraction,"assembly":assembly,"test_dynamic_import_keys":test_dynamic_import_keys,"outlines":outlines,"partitionObservation":partition_observation,"subjects":subjects,"complete":true,"global_admission_inferred":false,"capture_probes":fs.log.borrow().clone(),"ambient_cwd":std::env::current_dir().map_err(|e|e.to_string())?,"ambient_native_case_sensitive":native_case_sensitive,"status":"development_observation_not_qualification"}),
    )
}
fn additional_observation(args: &[String]) -> Result<Option<serde_json::Value>, String> {
    let Some(mode) = args.get(1).map(String::as_str).filter(|mode| {
        matches!(
            *mode,
            "--observe-primitives"
                | "--discover-repository"
                | "--extract-worker"
                | "--extract-parallel"
                | "--consume-worker"
                | "--observe-system"
                | "--observe-configured-resolution"
                | "--observe-controlled-assembly"
                | "--analyze-retained-discovery"
        )
    }) else {
        return Ok(None);
    };
    let valid_arity = if mode == "--extract-parallel" {
        args.len() == 5
    } else if matches!(
        mode,
        "--extract-worker"
            | "--observe-configured-resolution"
            | "--observe-controlled-assembly"
            | "--analyze-retained-discovery"
    ) {
        args.len() == 4
    } else if mode == "--observe-system" {
        args.len() == 3 || args.len() == 4
    } else {
        args.len() == 3
    };
    if !valid_arity {
        return Err(format!(
            "expected {mode} REQUEST.json{}",
            if mode == "--extract-parallel" {
                " SDK.json HELPER"
            } else if matches!(
                mode,
                "--extract-worker"
                    | "--observe-configured-resolution"
                    | "--observe-controlled-assembly"
                    | "--analyze-retained-discovery"
            ) {
                " SDK.json"
            } else if mode == "--observe-system" {
                " [SDK.json]"
            } else {
                ""
            }
        ));
    }
    let descriptor: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&args[2]).map_err(|error| error.to_string())?)
            .map_err(|error| error.to_string())?;
    let malformed = if mode == "--extract-worker" {
        worker_observations::malformed_request(&descriptor)
    } else {
        None
    };
    let sdk: Option<Sdk> = if malformed.is_none()
        && (args.len() == 4 || mode == "--extract-parallel")
    {
        Some(
            serde_json::from_slice(&std::fs::read(&args[3]).map_err(|error| error.to_string())?)
                .map_err(|error| error.to_string())?,
        )
    } else {
        None
    };
    let mut observed = if let Some(refusal) = malformed {
        refusal
    } else {
        match mode {
            "--extract-parallel" => parallel_observations::run(
                &descriptor,
                sdk.as_ref().ok_or("parallel SDK input missing")?,
                std::path::Path::new(&args[3]),
                std::path::Path::new(&args[4]),
            ),
            "--analyze-retained-discovery" => retained_discovery_observations::run(
                descriptor.clone(),
                sdk.as_ref().ok_or("retained discovery SDK input missing")?,
            ),
            "--observe-controlled-assembly" => assembly_observations::run(
                descriptor.clone(),
                sdk.as_ref()
                    .ok_or("controlled assembly SDK input missing")?,
            ),
            "--discover-repository" => repository_discovery::run(descriptor.clone()),
            "--observe-primitives" => {
                semctx_r0_probe::primitive_observations::handle_observation(descriptor.clone())?
            }
            "--extract-worker" => worker_observations::run(
                descriptor.clone(),
                sdk.as_ref().ok_or("worker SDK input missing")?,
            ),
            "--consume-worker" => worker_observations::consume_worker(&descriptor),
            "--observe-configured-resolution" => configured_resolution_observations::run(
                descriptor.clone(),
                sdk.as_ref().ok_or("configured query SDK input missing")?,
            ),
            "--observe-system" => {
                captured_system_observations::run(descriptor.clone(), sdk.as_ref())
            }
            _ => return Err("unknown native observation command".into()),
        }
    };
    observed["request_descriptor_id"] = serde_json::json!(identity::digest(&descriptor));
    if let Some(sdk) = &sdk {
        observed["sdk_input_id"] = serde_json::json!(identity::digest(
            &serde_json::to_value(sdk).map_err(|error| error.to_string())?
        ));
    }
    let executable = std::env::current_exe().map_err(|error| error.to_string())?;
    observed["producer_artifact_id"] = serde_json::json!(identity::digest_bytes(
        &std::fs::read(executable).map_err(|error| error.to_string())?
    ));
    if matches!(mode, "--extract-worker" | "--extract-parallel") {
        observed["producer_process_id"] = serde_json::json!(std::process::id());
    }
    Ok(Some(observed))
}

fn main() {
    let result = (|| {
        let args = std::env::args().collect::<Vec<_>>();
        if let Some(observed) = additional_observation(&args)? {
            return Ok(observed);
        }
        let batch_mode = args.get(1).is_some_and(|value| value == "--batch");
        let first = if batch_mode { 2 } else { 1 };
        if args.len() != first + 2 {
            return Err("expected [--batch] REQUEST.json SDK.json".into());
        }
        let request: Request = serde_json::from_slice(
            &std::fs::read(&args[first]).map_err(|error| error.to_string())?,
        )
        .map_err(|error| error.to_string())?;
        let sdk: Sdk = serde_json::from_slice(
            &std::fs::read(&args[first + 1]).map_err(|error| error.to_string())?,
        )
        .map_err(|error| error.to_string())?;
        let observed = analyze(request.clone(), sdk.clone())?;
        if batch_mode {
            serde_json::to_value(batch::build(&request, &sdk, &observed)?)
                .map_err(|error| error.to_string())
        } else {
            Ok(observed)
        }
    })();
    match result {
        Ok(value) => println!("{}", value),
        Err(error) => {
            eprintln!("{}", serde_json::json!({"error":error}));
            std::process::exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn component_request(id: &str, path: &str, text: &str) -> Request {
        serde_json::from_value(serde_json::json!({
            "id": id, "cwd": "/repo", "sdk_directory": "/sdk/lib",
            "case_sensitive": ts_goport::frontend::vfs::osvfs_fs().use_case_sensitive_file_names(),
            "roots": [path], "files": {path: text},
            "options": {"target":"ES2022","module":"ESNext","moduleResolution":"Bundler","allowJs":true,"jsx":"Preserve","skipLibCheck":true,"noEmit":true,"strict":false}
        })).unwrap()
    }

    fn component_sdk() -> Sdk {
        serde_json::from_slice(
            &std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/sdk/sdk-input.json")).unwrap(),
        )
        .unwrap()
    }

    fn dynamic_import_request(text: &str) -> Request {
        let mut request = component_request("dynamicImportDev", "/repo/src/target.test.ts", text);
        request.qualified = true;
        request
            .roles
            .insert("src/target.test.ts".into(), "test".into());
        request.roots.push("/repo/src/target.ts".into());
        request.files.insert(
            "/repo/src/target.ts".into(),
            "export function helper(){return 1;}\n".into(),
        );
        request.files.insert(
            "/repo/package.json".into(),
            r#"{"name":"qualified-fixture","type":"module"}"#.into(),
        );
        request
    }

    #[test]
    fn retained_dynamic_computed_imports_refuse_with_the_scope_reason() {
        let sdk = component_sdk();
        for text in [
            "const name='./target';export async function check(){return import(name);}\n",
            "export async function check(){return import('./target',{with:{type:'json'}});}\n",
        ] {
            let request = dynamic_import_request(text);
            let observed = analyze(request.clone(), sdk.clone()).unwrap();
            let subject = observed["subjects"]
                .as_array()
                .unwrap()
                .iter()
                .find(|subject| subject["path"] == "src/target.test.ts")
                .unwrap();
            assert!(
                subject["reasons"]
                    .as_array()
                    .unwrap()
                    .contains(&serde_json::json!(
                        "DEPENDENCY_SCOPE_COMPUTED_IMPORT:src/target.test.ts"
                    ))
            );
            assert_eq!(
                serde_json::to_value(batch::build(&request, &sdk, &observed).unwrap()).unwrap()["terminal"],
                "refused"
            );
        }
    }

    #[test]
    fn retained_unresolved_relative_import_refuses_without_inventing_a_target() {
        let sdk = component_sdk();
        let request =
            dynamic_import_request("export async function check(){return import('./missing');}\n");
        let observed = analyze(request.clone(), sdk.clone()).unwrap();
        let import = &observed["raw_extraction"]["imports"][0];
        assert_eq!(import["moduleSpecifier"], "./missing");
        assert!(import.get("resolvedRelPath").is_none());
        let subject = observed["subjects"]
            .as_array()
            .unwrap()
            .iter()
            .find(|subject| subject["path"] == "src/target.test.ts")
            .unwrap();
        assert!(
            subject["reasons"]
                .as_array()
                .unwrap()
                .contains(&serde_json::json!(
                    "DEPENDENCY_SCOPE_UNRESOLVED_IMPORT:src/target.test.ts:./missing"
                ))
        );
        assert_eq!(
            serde_json::to_value(batch::build(&request, &sdk, &observed).unwrap()).unwrap()["terminal"],
            "refused"
        );
    }

    #[test]
    fn retained_unresolved_undeclared_package_refuses_without_inventing_a_target() {
        let sdk = component_sdk();
        let request = dynamic_import_request(
            "import { missing } from 'missing';export function check(){return missing();}\n",
        );
        let observed = analyze(request.clone(), sdk.clone()).unwrap();
        let import = &observed["raw_extraction"]["imports"][0];
        assert_eq!(import["moduleSpecifier"], "missing");
        assert!(import.get("resolvedRelPath").is_none());
        let subject = observed["subjects"]
            .as_array()
            .unwrap()
            .iter()
            .find(|subject| subject["path"] == "src/target.test.ts")
            .unwrap();
        assert!(
            subject["reasons"]
                .as_array()
                .unwrap()
                .contains(&serde_json::json!(
                    "DEPENDENCY_SCOPE_UNRESOLVED_IMPORT:src/target.test.ts:missing"
                ))
        );
        assert_eq!(subject["outcome"], "unsupported");
        assert_eq!(
            serde_json::to_value(batch::build(&request, &sdk, &observed).unwrap()).unwrap()["terminal"],
            "refused"
        );
    }

    #[test]
    fn retained_unresolved_imports_distinguish_external_packages_workspaces_and_aliases() {
        let sdk = component_sdk();
        for (specifier, manifest, extra, external) in [
            (
                "external",
                r#"{"dependencies":{"external":"1"}}"#,
                None,
                true,
            ),
            (
                "@scope/external/sub",
                r#"{"devDependencies":{"@scope/external":"1"}}"#,
                None,
                true,
            ),
            (
                "externalish",
                r#"{"dependencies":{"external":"1"}}"#,
                None,
                false,
            ),
            (
                "external",
                r#"{"dependencies":{"external":1}}"#,
                None,
                false,
            ),
            (
                "external",
                "{/* retained JSONC */\"dependencies\":{\"external\":\"1\",},}",
                None,
                true,
            ),
            (
                "external",
                r#"{"dependencies":{"external":"1"},"optionalDependencies":{"external":"workspace:*"}}"#,
                None,
                false,
            ),
            (
                "external",
                r#"{"dependencies":{"external":"file:../external"}}"#,
                None,
                false,
            ),
            (
                "external",
                r#"{"dependencies":{"external":"link:../external"}}"#,
                None,
                false,
            ),
            (
                "external",
                r#"{"dependencies":{"external":"1"}}"#,
                Some((
                    "/repo/packages/internal/package.json",
                    r#"{"name":"external"}"#,
                )),
                false,
            ),
            (
                "external",
                r#"{"dependencies":{"external":"1"}}"#,
                Some((
                    "/repo/src/package.json",
                    r#"{"dependencies":{"external":"workspace:*"}}"#,
                )),
                true,
            ),
            (
                "external",
                r#"{"dependencies":{"external":"1"}}"#,
                Some((
                    "/repo/tsconfig.json",
                    r#"{"compilerOptions":{"paths":{"external":["./missing"]}}}"#,
                )),
                false,
            ),
            (
                "external/sub",
                r#"{"dependencies":{"external":"1"}}"#,
                Some((
                    "/repo/tsconfig.json",
                    r#"{"compilerOptions":{"paths":{"external/*":["./missing/*"]}}}"#,
                )),
                false,
            ),
            (
                "external/sub",
                r#"{"dependencies":{"external":"1"}}"#,
                Some((
                    "/repo/config/tsconfig.extra.json",
                    r#"{"compilerOptions":{"paths":{"external/*":["./missing/*"]}}}"#,
                )),
                false,
            ),
            ("node:fs", "{}", None, true),
            ("fs/promises", "{}", None, true),
            ("missing", "{broken", None, false),
            ("/repo/missing", "{}", None, false),
        ] {
            let mut request = dynamic_import_request(&format!(
                "export function check(){{return import('{specifier}');}}\n"
            ));
            request
                .files
                .insert("/repo/package.json".into(), manifest.into());
            if let Some((path, text)) = extra {
                request.files.insert(path.into(), text.into());
            }
            let observed = analyze(request, sdk.clone()).unwrap();
            let import = &observed["raw_extraction"]["imports"][0];
            assert_eq!(import["moduleSpecifier"], specifier);
            assert!(
                import.get("resolvedRelPath").is_none(),
                "{specifier} {manifest}"
            );
            let subject = observed["subjects"]
                .as_array()
                .unwrap()
                .iter()
                .find(|subject| subject["path"] == "src/target.test.ts")
                .unwrap();
            let reason = serde_json::json!(format!(
                "DEPENDENCY_SCOPE_UNRESOLVED_IMPORT:src/target.test.ts:{specifier}"
            ));
            assert_eq!(
                subject["reasons"].as_array().unwrap().contains(&reason),
                !external,
                "{specifier} {manifest} {extra:?}"
            );
            if !external {
                assert_eq!(subject["outcome"], "unsupported");
            }
            assert_eq!(observed["global_admission_inferred"], false);
        }
    }

    #[test]
    fn unresolved_dependency_scope_refusal_requires_the_retained_qualified_profile() {
        let sdk = component_sdk();
        for retained in [true, false] {
            let mut request =
                dynamic_import_request("export function check(){return import('missing');}\n");
            request.retained = retained;
            request.qualified = false;
            let observed = analyze(request, sdk.clone()).unwrap();
            let subject = observed["subjects"]
                .as_array()
                .unwrap()
                .iter()
                .find(|subject| subject["path"] == "src/target.test.ts")
                .unwrap();
            assert!(
                !subject["reasons"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|reason| reason
                        .as_str()
                        .unwrap()
                        .starts_with("DEPENDENCY_SCOPE_UNRESOLVED_IMPORT:"))
            );
        }
    }

    #[test]
    fn retained_unresolved_aliases_preserve_bun_literals_and_escapes() {
        let sdk = component_sdk();
        for (alias, specifier, local) in [
            (r"extern\al", "external", true),
            ("foo(bar)", "external", false),
            ("foo(bar)", "foo(bar)", true),
            ("[broken", "external", false),
            ("![broken", "external", true),
            (r"extern\*al", "external", false),
            (r"extern\*al", "extern*al", true),
            (r"extern\{al", "extern{al", true),
            ("!{external,other}", "external", false),
        ] {
            let mut request = dynamic_import_request(&format!(
                "export function check(){{return import('{specifier}');}}\n"
            ));
            request.files.insert(
                "/repo/package.json".into(),
                serde_json::json!({
                    "dependencies": {specifier: "1"}
                })
                .to_string(),
            );
            request.files.insert(
                "/repo/tsconfig.json".into(),
                serde_json::json!({
                    "compilerOptions": {"paths": {alias: ["./missing"]}}
                })
                .to_string(),
            );
            let observed = analyze(request, sdk.clone()).unwrap();
            assert!(
                observed["raw_extraction"]["imports"][0]
                    .get("resolvedRelPath")
                    .is_none()
            );
            let subject = observed["subjects"]
                .as_array()
                .unwrap()
                .iter()
                .find(|subject| subject["path"] == "src/target.test.ts")
                .unwrap();
            assert_eq!(
                subject["reasons"]
                    .as_array()
                    .unwrap()
                    .contains(&serde_json::json!(format!(
                        "DEPENDENCY_SCOPE_UNRESOLVED_IMPORT:src/target.test.ts:{specifier}"
                    ))),
                local,
                "{alias} {specifier}"
            );
        }
    }

    #[test]
    fn retained_negated_globstar_alias_refuses_a_trailing_slash_import() {
        let sdk = component_sdk();
        let mut request =
            dynamic_import_request("export function check(){return import('external/');}\n");
        request.files.insert(
            "/repo/package.json".into(),
            r#"{"dependencies":{"external":"1"}}"#.into(),
        );
        request.files.insert(
            "/repo/tsconfig.json".into(),
            r#"{"compilerOptions":{"paths":{"!**/*":["./missing"]}}}"#.into(),
        );
        let observed = analyze(request.clone(), sdk.clone()).unwrap();
        let subject = observed["subjects"]
            .as_array()
            .unwrap()
            .iter()
            .find(|subject| subject["path"] == "src/target.test.ts")
            .unwrap();
        assert!(
            subject["reasons"]
                .as_array()
                .unwrap()
                .contains(&serde_json::json!(
                    "DEPENDENCY_SCOPE_UNRESOLVED_IMPORT:src/target.test.ts:external/"
                ))
        );
        assert_eq!(subject["outcome"], "unsupported");
        assert_eq!(
            serde_json::to_value(batch::build(&request, &sdk, &observed).unwrap()).unwrap()["terminal"],
            "refused"
        );
    }

    #[test]
    fn retained_alias_braces_do_not_change_globstar_kind() {
        let sdk = component_sdk();
        for (alias, specifier, local) in [
            ("!**{,a}", "external/sub", true),
            ("**{,a}", "external/sub", false),
            ("!{,a}**", "external/sub", true),
            ("{,a}**", "external/sub", false),
            ("!{external/,other/}**", "external/sub/deep", true),
            ("{external/,other/}**", "external/sub/deep", false),
        ] {
            for dynamic in [true, false] {
                let text = if dynamic {
                    format!("export function check(){{return import('{specifier}');}}\n")
                } else {
                    format!("import '{specifier}';export function check(){{return 1;}}\n")
                };
                let mut request = dynamic_import_request(&text);
                request.files.insert(
                    "/repo/package.json".into(),
                    r#"{"dependencies":{"external":"1"}}"#.into(),
                );
                request.files.insert(
                    "/repo/tsconfig.json".into(),
                    serde_json::json!({
                        "compilerOptions":{"paths":{alias:["./missing"]}}
                    })
                    .to_string(),
                );
                let observed = analyze(request.clone(), sdk.clone()).unwrap();
                let subject = observed["subjects"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|subject| subject["path"] == "src/target.test.ts")
                    .unwrap();
                assert_eq!(
                    subject["reasons"]
                        .as_array()
                        .unwrap()
                        .contains(&serde_json::json!(format!(
                            "DEPENDENCY_SCOPE_UNRESOLVED_IMPORT:src/target.test.ts:{specifier}"
                        ))),
                    local,
                    "{alias} {specifier} dynamic={dynamic}"
                );
                if local {
                    let batch =
                        serde_json::to_value(batch::build(&request, &sdk, &observed).unwrap())
                            .unwrap();
                    assert_eq!(batch["terminal"], "refused");
                    let subject = batch["subjects"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .find(|subject| subject["subject_id"] == "src/target.test.ts")
                        .unwrap();
                    assert!(
                        subject["coverage"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .all(|coverage| coverage["negative_evidence_eligible"] == false)
                    );
                }
            }
        }
    }

    #[test]
    fn retained_scope_preserves_enumerable_manifest_entries() {
        let sdk = component_sdk();
        for (manifest, specifier, local) in [
            (
                r#"{"dependencies":{"0":"1"},"compilerOptions":{"paths":"a"}}"#,
                "0",
                true,
            ),
            (
                r#"{"dependencies":{"0":"1"},"compilerOptions":{"paths":["./missing"]}}"#,
                "0",
                true,
            ),
            (
                r#"{"dependencies":{"1":"1"},"compilerOptions":{"paths":"😀"}}"#,
                "1",
                true,
            ),
            (
                r#"{"dependencies":{"0":"1"},"compilerOptions":{"paths":false}}"#,
                "0",
                false,
            ),
            (r#"{"dependencies":["1"]}"#, "0", false),
            (r#"{"dependencies":"1"}"#, "0", false),
            (r#"{"dependencies":"😀"}"#, "1", false),
            (r#"{"dependencies":"\ufdd0"}"#, "1", true),
            (r#"{"dependencies":"\ud800"}"#, "1", true),
            (
                r#"{"dependencies":["1"],"optionalDependencies":{"0":false}}"#,
                "0",
                true,
            ),
        ] {
            for dynamic in [true, false] {
                let text = if dynamic {
                    format!("export function check(){{return import('{specifier}');}}\n")
                } else {
                    format!("import '{specifier}';export function check(){{return 1;}}\n")
                };
                let mut request = dynamic_import_request(&text);
                request
                    .files
                    .insert("/repo/package.json".into(), manifest.into());
                let observed = analyze(request.clone(), sdk.clone()).unwrap();
                let subject = observed["subjects"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|subject| subject["path"] == "src/target.test.ts")
                    .unwrap();
                assert_eq!(
                    subject["reasons"]
                        .as_array()
                        .unwrap()
                        .contains(&serde_json::json!(format!(
                            "DEPENDENCY_SCOPE_UNRESOLVED_IMPORT:src/target.test.ts:{specifier}"
                        ))),
                    local,
                    "{manifest} {specifier} dynamic={dynamic}"
                );
                let batch =
                    serde_json::to_value(batch::build(&request, &sdk, &observed).unwrap()).unwrap();
                assert_eq!(
                    batch["terminal"],
                    if local { "refused" } else { "complete" }
                );
                if local {
                    let subject = batch["subjects"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .find(|subject| subject["subject_id"] == "src/target.test.ts")
                        .unwrap();
                    assert!(
                        subject["coverage"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .all(|entry| entry["negative_evidence_eligible"] == false)
                    );
                }
            }
        }
    }

    #[test]
    fn retained_scope_preserves_parsed_manifest_prototypes() {
        let sdk = component_sdk();
        for (manifest, specifier, local) in [
            (r#"{"dependencies":{"__proto__":"1"}}"#, "__proto__", true),
            (
                r#"{"dependencies":{"external":"1"},"__proto__":{"compilerOptions":{"paths":{"external":["./missing"]}}}}"#,
                "external",
                true,
            ),
            (
                r#"{"__proto__":{"dependencies":{"external":"1"}}}"#,
                "external",
                false,
            ),
            (
                r#"{"__proto__":{"name":"external"},"dependencies":{"external":"1"}}"#,
                "external",
                true,
            ),
            (
                r#"{"dependencies":{"__proto__":null,"__proto__":"1"},"compilerOptions":{"paths":{"__proto__":null,"__proto__":["./missing"]}}}"#,
                "__proto__",
                true,
            ),
            (
                r#"{"dependencies":{"external":"1"},"compilerOptions":{"__proto__":{"paths":{"external":["./missing"]}}}}"#,
                "external",
                true,
            ),
            (
                r#"{"dependencies":{"external":"1"},"compilerOptions":{"paths":{"__proto__":{"external":["./missing"]}}}}"#,
                "external",
                false,
            ),
            (
                r#"{"dependencies":{"__proto__":null,"__proto__":"1"}}"#,
                "__proto__",
                false,
            ),
            (
                r#"{"dependencies":{"__proto__":{},"__proto__":"1"}}"#,
                "__proto__",
                true,
            ),
            (
                r#"{"__proto__":{"compilerOptions":{"paths":{"external":["./missing"]}}},"__proto__":"ignored","dependencies":{"external":"1"}}"#,
                "external",
                true,
            ),
            (
                r#"{"__proto__":{"compilerOptions":{"paths":{"external":["./missing"]}}},"__proto__":null,"dependencies":{"external":"1"}}"#,
                "external",
                false,
            ),
            ("{'dependencies':{'external':'1'}}", "external", true),
        ] {
            for dynamic in [true, false] {
                let text = if dynamic {
                    format!("export function check(){{return import('{specifier}');}}\n")
                } else {
                    format!("import '{specifier}';export function check(){{return 1;}}\n")
                };
                let mut request = dynamic_import_request(&text);
                request
                    .files
                    .insert("/repo/package.json".into(), manifest.into());
                let observed = analyze(request.clone(), sdk.clone()).unwrap();
                let subject = observed["subjects"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|subject| subject["path"] == "src/target.test.ts")
                    .unwrap();
                assert_eq!(
                    subject["reasons"]
                        .as_array()
                        .unwrap()
                        .contains(&serde_json::json!(format!(
                            "DEPENDENCY_SCOPE_UNRESOLVED_IMPORT:src/target.test.ts:{specifier}"
                        ))),
                    local,
                    "{manifest} {specifier} dynamic={dynamic}"
                );
                let batch =
                    serde_json::to_value(batch::build(&request, &sdk, &observed).unwrap()).unwrap();
                assert_eq!(
                    batch["terminal"],
                    if local { "refused" } else { "complete" }
                );
                if local {
                    let subject = batch["subjects"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .find(|subject| subject["subject_id"] == "src/target.test.ts")
                        .unwrap();
                    assert!(
                        subject["coverage"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .all(|entry| entry["negative_evidence_eligible"] == false)
                    );
                }
            }
        }
    }

    #[test]
    fn retained_aliases_use_javascript_characters_instead_of_port_string_markers() {
        let sdk = component_sdk();
        for (literal, alias, local) in [
            (r"\ufdd0", "?", true),
            (r"\ufdd0", "??", false),
            (r"\ufdd0", "!?", false),
            (r"\ud800", "?", true),
            (r"\ud800", "??", false),
            (r"\ud800", r"[\ufffd]", true),
            (r"\ud800", r"[!\ufffd]", false),
            (r"\ud800\ud800", "??", true),
            (r"\ud800\ud800", "?", false),
            (r"\ud800\ud800", r"\ufffd\ufffd", true),
            (r"\ud800\udc00", "?", true),
            (r"\ud800\udc00", r"[\ufffd]", false),
            (r"\udc00\ud800", "??", true),
        ] {
            for dynamic in [true, false] {
                let text = if dynamic {
                    format!("export function check(){{return import('{literal}');}}\n")
                } else {
                    format!("import '{literal}';export function check(){{return 1;}}\n")
                };
                let mut request = dynamic_import_request(&text);
                request.files.insert("/repo/package.json".into(), format!(
                    r#"{{"dependencies":{{"{literal}":"1"}},"compilerOptions":{{"paths":{{"{alias}":[]}}}}}}"#
                ));
                let observed = analyze(request.clone(), sdk.clone()).unwrap();
                let subject = observed["subjects"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|subject| subject["path"] == "src/target.test.ts")
                    .unwrap();
                assert_eq!(
                    subject["reasons"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|reason| reason
                            .as_str()
                            .unwrap()
                            .starts_with("DEPENDENCY_SCOPE_UNRESOLVED_IMPORT:src/target.test.ts:")),
                    local,
                    "{literal} {alias} dynamic={dynamic}"
                );
                let batch =
                    serde_json::to_value(batch::build(&request, &sdk, &observed).unwrap()).unwrap();
                assert_eq!(
                    batch["terminal"],
                    if local { "refused" } else { "complete" }
                );
                if local {
                    let subject = batch["subjects"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .find(|subject| subject["subject_id"] == "src/target.test.ts")
                        .unwrap();
                    assert!(
                        subject["coverage"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .all(|entry| entry["negative_evidence_eligible"] == false)
                    );
                }
            }
        }
    }

    #[test]
    fn retained_scope_keeps_package_suffix_metadata_from_consumed_configurations() {
        let sdk = component_sdk();
        for (filename, package, configuration, local) in [
            (
                "tsconfigpackage.json",
                r#"{"dependencies":{"external":"1"}}"#,
                r#"{"name":"external"}"#,
                true,
            ),
            (
                "tsconfig.package.json",
                r#"{"dependencies":{"external":"1"}}"#,
                "{}",
                true,
            ),
            (
                "tsconfigpackage.json",
                "{}",
                r#"{"dependencies":{"external":"1"}}"#,
                false,
            ),
            (
                "configpackage.json",
                r#"{"dependencies":{"external":"1"}}"#,
                r#"{"name":"external"}"#,
                false,
            ),
        ] {
            for dynamic in [true, false] {
                let text = if dynamic {
                    "export function check(){return import('external');}\n"
                } else {
                    "import 'external';export function check(){return 1;}\n"
                };
                let mut request = dynamic_import_request(text);
                request
                    .files
                    .insert("/repo/package.json".into(), package.into());
                request
                    .files
                    .insert(format!("/repo/{filename}"), configuration.into());
                request.files.insert(
                    "/repo/tsconfig.json".into(),
                    serde_json::json!({"extends":format!("./{filename}")}).to_string(),
                );
                let observed = analyze(request.clone(), sdk.clone()).unwrap();
                let subject = observed["subjects"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|subject| subject["path"] == "src/target.test.ts")
                    .unwrap();
                assert_eq!(
                    subject["reasons"]
                        .as_array()
                        .unwrap()
                        .contains(&serde_json::json!(
                            "DEPENDENCY_SCOPE_UNRESOLVED_IMPORT:src/target.test.ts:external"
                        )),
                    local,
                    "{filename} {configuration} dynamic={dynamic}"
                );
                let batch =
                    serde_json::to_value(batch::build(&request, &sdk, &observed).unwrap()).unwrap();
                assert_eq!(
                    batch["terminal"],
                    if local { "refused" } else { "complete" }
                );
                if local {
                    let subject = batch["subjects"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .find(|subject| subject["subject_id"] == "src/target.test.ts")
                        .unwrap();
                    assert!(
                        subject["coverage"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .all(|entry| entry["negative_evidence_eligible"] == false)
                    );
                }
            }
        }
    }

    #[test]
    fn retained_scope_applies_same_directory_metadata_in_javascript_capture_order() {
        let sdk = component_sdk();
        for external in [false, true] {
            for dynamic in [true, false] {
                let text = if dynamic {
                    "export function check(){return import('external');}\n"
                } else {
                    "import 'external';export function check(){return 1;}\n"
                };
                let mut request = dynamic_import_request(text);
                request
                    .files
                    .insert("/repo/package.json".into(), "{}".into());
                let declaration = r#"{"dependencies":{"external":"1"}}"#;
                request.files.insert(
                    "/repo/tsconfig😀package.json".into(),
                    if external { "{}" } else { declaration }.into(),
                );
                request.files.insert(
                    "/repo/tsconfig\u{e000}package.json".into(),
                    if external { declaration } else { "{}" }.into(),
                );
                request.files.insert("/repo/tsconfig.json".into(), serde_json::json!({"extends":["./tsconfig😀package.json", "./tsconfig\u{e000}package.json"]}).to_string());
                let observed = analyze(request.clone(), sdk.clone()).unwrap();
                let subject = observed["subjects"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|subject| subject["path"] == "src/target.test.ts")
                    .unwrap();
                assert_eq!(
                    subject["reasons"]
                        .as_array()
                        .unwrap()
                        .contains(&serde_json::json!(
                            "DEPENDENCY_SCOPE_UNRESOLVED_IMPORT:src/target.test.ts:external"
                        )),
                    !external,
                    "external={external} dynamic={dynamic}"
                );
                let batch =
                    serde_json::to_value(batch::build(&request, &sdk, &observed).unwrap()).unwrap();
                assert_eq!(
                    batch["terminal"],
                    if external { "complete" } else { "refused" }
                );
                if !external {
                    let subject = batch["subjects"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .find(|subject| subject["subject_id"] == "src/target.test.ts")
                        .unwrap();
                    assert!(
                        subject["coverage"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .all(|entry| entry["negative_evidence_eligible"] == false)
                    );
                }
            }
        }
    }

    #[test]
    fn retained_unresolved_diagnostics_keep_exact_utf16_at_the_batch_boundary() {
        let sdk = component_sdk();
        for (literal, units) in [
            (r"\ufdd0", vec![0xfdd0]),
            (r"\ud800", vec![0xd800]),
            (r"\ud800\ud800", vec![0xd800, 0xd800]),
            (r"\udc00\ud800", vec![0xdc00, 0xd800]),
            (r"\ud800\udc00", vec![0xd800, 0xdc00]),
        ] {
            let request = dynamic_import_request(&format!(
                "export function check(){{return import('{literal}');}}\n"
            ));
            let mut expected = "DEPENDENCY_SCOPE_UNRESOLVED_IMPORT:src/target.test.ts:"
                .encode_utf16()
                .collect::<Vec<_>>();
            expected.extend(units);
            let observed = analyze(request.clone(), sdk.clone()).unwrap();
            let subject = observed["subjects"]
                .as_array()
                .unwrap()
                .iter()
                .find(|subject| subject["path"] == "src/target.test.ts")
                .unwrap();
            assert_eq!(
                subject["reasons"],
                serde_json::json!([String::from_utf16_lossy(&expected)])
            );
            assert_eq!(
                subject["unresolvedImportReasonsUtf16"],
                serde_json::json!([expected.clone()])
            );
            let batch =
                serde_json::to_value(batch::build(&request, &sdk, &observed).unwrap()).unwrap();
            assert_eq!(batch["terminal"], "refused");
            let diagnostics = batch["diagnostics"].as_array().unwrap();
            let diagnostic = diagnostics
                .iter()
                .find(|diagnostic| {
                    diagnostic["code"]
                        .as_str()
                        .is_some_and(|code| code.starts_with("DEPENDENCY_SCOPE_UNRESOLVED_IMPORT:"))
                })
                .unwrap();
            assert_eq!(diagnostic["code_utf16"], serde_json::json!(expected));
            assert_eq!(diagnostic["message_utf16"], serde_json::json!(expected));
            assert_eq!(diagnostic["code"], String::from_utf16_lossy(&expected));
            for malformed in [
                serde_json::Value::Null,
                serde_json::json!([[65536]]),
                serde_json::json!([[]]),
                serde_json::json!([expected.clone(), expected.clone()]),
            ] {
                let mut altered = observed.clone();
                let subject = altered["subjects"]
                    .as_array_mut()
                    .unwrap()
                    .iter_mut()
                    .find(|subject| subject["path"] == "src/target.test.ts")
                    .unwrap();
                subject["unresolvedImportReasonsUtf16"] = malformed;
                assert!(batch::build(&request, &sdk, &altered).is_err());
            }
        }
        let request = dynamic_import_request(
            "export function check(){return Promise.all([import('\\ud800'),import('\\ud801')]);}\n",
        );
        let observed = analyze(request.clone(), sdk.clone()).unwrap();
        let batch = serde_json::to_value(batch::build(&request, &sdk, &observed).unwrap()).unwrap();
        let diagnostics = batch["diagnostics"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|d| {
                d["code"]
                    .as_str()
                    .is_some_and(|c| c.starts_with("DEPENDENCY_SCOPE_UNRESOLVED_IMPORT:"))
            })
            .collect::<Vec<_>>();
        assert_eq!(diagnostics.len(), 2);
        assert_eq!(diagnostics[0]["code"], diagnostics[1]["code"]);
        assert_ne!(diagnostics[0]["code_utf16"], diagnostics[1]["code_utf16"]);
    }

    #[test]
    fn retained_alias_inspection_keeps_valid_large_configuration_contexts() {
        let sdk = component_sdk();
        for aliases in [
            (0..1025)
                .map(|index| {
                    (
                        format!("unrelated-{index}"),
                        serde_json::json!(["./missing"]),
                    )
                })
                .collect::<serde_json::Map<_, _>>(),
            serde_json::Map::from_iter([("a".repeat(4097), serde_json::json!(["./missing"]))]),
        ] {
            let mut request =
                dynamic_import_request("export function check(){return import('external');}\n");
            request.files.insert(
                "/repo/package.json".into(),
                r#"{"dependencies":{"external":"1"}}"#.into(),
            );
            request.files.insert(
                "/repo/tsconfig.json".into(),
                serde_json::json!({
                    "compilerOptions":{"paths":aliases}
                })
                .to_string(),
            );
            let observed = analyze(request.clone(), sdk.clone()).unwrap();
            assert_eq!(
                serde_json::to_value(batch::build(&request, &sdk, &observed).unwrap()).unwrap()["terminal"],
                "complete"
            );
        }
    }

    #[test]
    fn retained_unresolved_builtins_keep_the_qualified_prefix_distinctions() {
        let sdk = component_sdk();
        for (specifier, external) in [
            ("sqlite", false),
            ("node:test", true),
            ("node:node:sqlite", true),
        ] {
            let request = dynamic_import_request(&format!(
                "export function check(){{return import('{specifier}');}}\n"
            ));
            let observed = analyze(request, sdk.clone()).unwrap();
            let import = &observed["raw_extraction"]["imports"][0];
            assert_eq!(import["moduleSpecifier"], specifier);
            assert!(import.get("resolvedRelPath").is_none());
            let subject = observed["subjects"]
                .as_array()
                .unwrap()
                .iter()
                .find(|subject| subject["path"] == "src/target.test.ts")
                .unwrap();
            assert_eq!(
                subject["reasons"]
                    .as_array()
                    .unwrap()
                    .contains(&serde_json::json!(format!(
                        "DEPENDENCY_SCOPE_UNRESOLVED_IMPORT:src/target.test.ts:{specifier}"
                    ))),
                !external,
                "{specifier}"
            );
        }
    }

    #[test]
    fn retained_literal_dynamic_import_keeps_its_resolved_unproven_binding() {
        let request = dynamic_import_request(
            "export async function check(){const dep=await import('./target');return dep.helper();}\n",
        );
        let observed = analyze(request, component_sdk()).unwrap();
        assert_eq!(
            observed["test_dynamic_import_keys"],
            serde_json::json!(["src/target.test.ts:1:./target"])
        );
        assert_eq!(
            observed["raw_extraction"]["imports"][0]["resolvedRelPath"],
            "src/target.ts"
        );
        assert!(
            observed["raw_extraction"]["imports"][0]
                .get("bindingTargets")
                .is_none()
        );
        let subject = observed["subjects"]
            .as_array()
            .unwrap()
            .iter()
            .find(|subject| subject["path"] == "src/target.test.ts")
            .unwrap();
        assert!(
            subject["reasons"]
                .as_array()
                .unwrap()
                .contains(&serde_json::json!(
                    "QUALIFIED_TEST_DYNAMIC_IMPORT_BINDING_UNPROVEN:src/target.ts"
                ))
        );
        assert!(
            !subject["reasons"]
                .as_array()
                .unwrap()
                .iter()
                .any(|reason| reason.as_str().unwrap().starts_with("DEPENDENCY_SCOPE_"))
        );
    }

    #[test]
    #[cfg(unix)]
    fn captured_analysis_checks_physical_aliases_and_surfaces_canonicalization_failures() {
        let directory = std::env::temp_dir().join(format!(
            "semctx-captured-alias-dev-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let root = directory.join("repo");
        let outside = directory.join("outside");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, root.join("external")).unwrap();
        std::os::unix::fs::symlink("loop", root.join("loop")).unwrap();
        std::fs::write(root.join("inside.ts"), "export const leaf = 1;").unwrap();
        std::os::unix::fs::symlink("inside.ts", root.join("alias.ts")).unwrap();
        let root_text = root.to_str().unwrap();
        let source = root.join("main.ts");
        let observe = |text: &str, leaf: Option<(&str, &str)>| {
            let mut request = component_request("physicalAliasDev", source.to_str().unwrap(), text);
            request.cwd = root_text.into();
            if let Some((path, text)) = leaf {
                request
                    .files
                    .insert(format!("{root_text}/{path}"), text.into());
            }
            analyze(request, component_sdk())
        };
        let missing = observe("import './external/missing'; export const value = 1;", None);
        let looped = observe("import './loop'; export const value = 1;", None);
        let internal = observe(
            "import {leaf} from './alias.ts'; export const value = leaf;",
            Some(("alias.ts", "export const leaf = 1;")),
        );
        std::fs::remove_dir_all(directory).unwrap();
        assert_eq!(
            missing.err(),
            Some("IMPORT_OUTSIDE_REPOSITORY: ./external/missing".into())
        );
        assert!(
            looped
                .unwrap_err()
                .starts_with("SOURCE_CANONICAL_PATH_UNAVAILABLE:")
        );
        assert!(internal.is_ok());
    }

    #[test]
    fn captured_analysis_refuses_property_require_and_amd_dependencies() {
        for text in [
            "custom.require('../../guardOutside'); export const value = 1;",
            "define(['../../guardOutside'], () => 1);",
            "define('named', ['../../guardOutside'], () => 1);",
        ] {
            let request = component_request("javascriptImportsDev", "/repo/main.ts", text);
            assert_eq!(
                analyze(request, component_sdk()).err(),
                Some("IMPORT_OUTSIDE_REPOSITORY: ../../guardOutside".into()),
                "{text}"
            );
        }
    }

    #[test]
    fn captured_analysis_keeps_sdk59_non_dependency_call_and_template_contexts() {
        for text in [
            "export const note = \"define(['../../guardOutside'])\";",
            "export const note = `${require('../../guardOutside')}`;",
            "export const note = `${custom.require('../../guardOutside')}`;",
            "(require)('../../guardOutside'); export const value = 1;",
            "custom['require']('../../guardOutside'); export const value = 1;",
            "require?.('../../guardOutside'); export const value = 1;",
            "define?.(['../../guardOutside'], () => 1);",
        ] {
            let request = component_request("nonDependencyContextDev", "/repo/main.ts", text);
            assert!(analyze(request, component_sdk()).is_ok(), "{text}");
        }
    }

    #[test]
    fn captured_analysis_accepts_equivalent_dot_and_parent_repository_roots() {
        let directory =
            std::env::temp_dir().join(format!("semctx-root-spelling-dev-{}", std::process::id()));
        std::fs::create_dir(&directory).unwrap();
        let source = directory.join("main.ts");
        let mut request = component_request(
            "rootSpellingDev",
            source.to_str().unwrap(),
            "export const value = 1;",
        );
        request.cwd = format!("{}/./missing/..", directory.display());
        let observed = analyze(request, component_sdk());
        std::fs::remove_dir(directory).unwrap();
        assert!(observed.is_ok(), "{:?}", observed.err());
    }

    #[test]
    fn captured_analysis_refuses_relative_import_escape_even_when_target_is_absent() {
        for outside_present in [false, true] {
            let mut request = component_request(
                "capturedConfinementDev",
                "/repo/src/guardConsumer.ts",
                "import { guardedValue } from '../../guardOutside'; export const observed = guardedValue;",
            );
            if outside_present {
                request.files.insert(
                    "/guardOutside.ts".into(),
                    "export const guardedValue = 109;".into(),
                );
            }
            assert_eq!(
                analyze(request, component_sdk()).err(),
                Some("IMPORT_OUTSIDE_REPOSITORY: ../../guardOutside".into()),
                "outside target present: {outside_present}"
            );
        }
    }

    #[test]
    fn captured_analysis_keeps_a_parent_directory_import_inside_the_repository() {
        let mut request = component_request(
            "capturedConfinementParentDev",
            "/repo/src/guardConsumer.ts",
            "import { guardedValue } from '..'; export const observed = guardedValue;",
        );
        request.files.insert(
            "/repo/index.ts".into(),
            "export const guardedValue = 113;".into(),
        );
        let observed = analyze(request, component_sdk()).unwrap();
        assert_eq!(
            observed["raw_extraction"]["imports"][0]["resolvedRelPath"],
            "index.ts"
        );
    }

    #[test]
    fn captured_analysis_checks_relative_imports_in_reached_dependencies() {
        let mut request = component_request(
            "capturedConfinementTransitiveDev",
            "/repo/src/guardConsumer.ts",
            "import { guardedValue } from './bridge'; export const observed = guardedValue;",
        );
        request.files.insert(
            "/repo/src/bridge.ts".into(),
            "import { guardedValue } from '../../guardOutside'; export { guardedValue };".into(),
        );
        assert_eq!(
            analyze(request, component_sdk()).err(),
            Some("IMPORT_OUTSIDE_REPOSITORY: ../../guardOutside".into())
        );
    }

    #[test]
    fn captured_analysis_does_not_check_unreached_captured_sources() {
        let mut request = component_request(
            "capturedConfinementUnreachedDev",
            "/repo/src/guardConsumer.ts",
            "export const observed = 127;",
        );
        request.files.insert(
            "/repo/unreached.ts".into(),
            "import { guardedValue } from '../guardOutside'; export { guardedValue };".into(),
        );
        let observed = analyze(request, component_sdk()).unwrap();
        assert_eq!(
            observed["raw_extraction"]["modules"],
            serde_json::json!(["src/guardConsumer.ts"])
        );
    }

    #[test]
    fn captured_analysis_refuses_an_outside_reference_and_a_traversing_root() {
        let request = component_request(
            "capturedConfinementReferenceDev",
            "/repo/src/guardConsumer.ts",
            "/// <reference path=\"../../guardOutside.d.ts\" />\nexport const observed = 131;",
        );
        assert_eq!(
            analyze(request, component_sdk()).err(),
            Some("REFERENCE_OUTSIDE_REPOSITORY: ../../guardOutside.d.ts".into())
        );
        let request = component_request(
            "capturedConfinementRootDev",
            "/repo/src/../../guardOutside.ts",
            "export const observed = 137;",
        );
        assert!(
            analyze(request, component_sdk())
                .err()
                .is_some_and(|error| error.starts_with("source outside repository:"))
        );
    }

    #[test]
    fn captured_analysis_refuses_missing_source_bytes_before_native_analysis() {
        let mut request = component_request(
            "capturedConfinementMissingDev",
            "/repo/src/guardConsumer.ts",
            "export const observed = 139;",
        );
        request.files.clear();
        assert_eq!(
            analyze(request, component_sdk()).err(),
            Some("SOURCE_SNAPSHOT_MISSING: src/guardConsumer.ts".into())
        );
    }

    #[test]
    fn captured_analysis_confines_the_sdk59_relative_dependency_syntaxes() {
        for source in [
            "import { x } from '../../guardOutside';",
            "export { x } from '../../guardOutside';",
            "export const x = import('../../guardOutside');",
            "const x = require('../../guardOutside');",
            "export type X = import('../../guardOutside').X;",
            "import x = require('../../guardOutside');",
        ] {
            let request = component_request(
                "capturedConfinementSyntaxDev",
                "/repo/src/guardConsumer.ts",
                source,
            );
            assert_eq!(
                analyze(request, component_sdk()).err(),
                Some("IMPORT_OUTSIDE_REPOSITORY: ../../guardOutside".into()),
                "{source}"
            );
        }
        let request = component_request(
            "capturedConfinementQuotedDev",
            "/repo/src/guardConsumer.ts",
            "export const note = \"import { x } from '../../guardOutside';\";",
        );
        assert!(analyze(request, component_sdk()).is_ok());
    }

    #[test]
    fn loaded_module_partition_connects_selected_roots_through_an_unselected_source() {
        let mut request = component_request(
            "loadedPartitionDev",
            "/repo/a.ts",
            "import { middle } from './middle'; export const a = middle + 1\n",
        );
        request.retained = false;
        request.roots.push("/repo/b.ts".into());
        request.files.insert(
            "/repo/middle.ts".into(),
            "import { b } from './b'; export const middle = b + 1\n".into(),
        );
        request
            .files
            .insert("/repo/b.ts".into(), "export const b = 1\n".into());
        request.files.insert(
            "/repo/unloaded.ts".into(),
            "export const unloaded = 2;".into(),
        );
        let observed = analyze(request, component_sdk()).unwrap();
        let partition = &observed["partitionObservation"];
        assert_eq!(partition["executed"], true, "{partition}");
        assert_eq!(partition["unsupported"], serde_json::json!([]));
        assert_eq!(
            partition["selectedRoots"],
            serde_json::json!(["a.ts", "b.ts"])
        );
        assert_eq!(
            partition["dependencyComponents"],
            serde_json::json!([["a.ts", "b.ts"]])
        );
        assert_eq!(
            partition["loadedRepositorySources"],
            serde_json::json!(["a.ts", "b.ts", "middle.ts"])
        );
        assert_eq!(
            partition["resolvedEdges"],
            serde_json::json!([
                {"from":"a.ts","specifier":"./middle","to":"middle.ts"},
                {"from":"middle.ts","specifier":"./b","to":"b.ts"}
            ])
        );
        assert_eq!(
            observed["raw_extraction"]["modules"],
            serde_json::json!(["a.ts", "b.ts"])
        );
        assert_eq!(partition["globalAdmissionInferred"], false);
    }

    #[test]
    fn loaded_module_partition_excludes_a_shared_external_package_from_connectivity() {
        let mut request = component_request(
            "externalPartitionDev",
            "/repo/a.ts",
            "import { marker } from 'shared-package'; export const a = marker;",
        );
        request.retained = false;
        request.roots.push("/repo/b.ts".into());
        request.files.extend([
            (
                "/repo/b.ts".into(),
                "import { marker } from 'shared-package'; export const b = marker;".into(),
            ),
            (
                "/repo/node_modules/shared-package/package.json".into(),
                r#"{"name":"shared-package","types":"index.d.ts"}"#.into(),
            ),
            (
                "/repo/node_modules/shared-package/index.d.ts".into(),
                "export declare const marker: number;".into(),
            ),
        ]);
        let observed = analyze(request, component_sdk()).unwrap();
        assert_eq!(observed["partitionObservation"]["executed"], true);
        assert_eq!(
            observed["partitionObservation"]["dependencyComponents"],
            serde_json::json!([["a.ts"], ["b.ts"]])
        );
        assert_eq!(
            observed["partitionObservation"]["loadedRepositorySources"],
            serde_json::json!(["a.ts", "b.ts"])
        );
        assert_eq!(
            observed["partitionObservation"]["resolvedEdges"],
            serde_json::json!([])
        );
        assert!(
            observed["capture_probes"]
                .as_array()
                .unwrap()
                .iter()
                .any(|probe| {
                    probe["operation"] == "read_file"
                        && probe["found"] == true
                        && probe["path"] == "/repo/node_modules/shared-package/index.d.ts"
                })
        );
    }

    #[test]
    fn loaded_module_partition_connectivity_is_undirected() {
        let mut request =
            component_request("reversePartitionDev", "/repo/a.ts", "export const a=1;");
        request.retained = false;
        request.roots.push("/repo/b.ts".into());
        request.files.extend([
            (
                "/repo/middle.ts".into(),
                "import { a } from './a'; export const middle=a+1;".into(),
            ),
            (
                "/repo/b.ts".into(),
                "import { middle } from './middle'; export const b=middle+1;".into(),
            ),
        ]);
        let observed = analyze(request, component_sdk()).unwrap();
        assert_eq!(
            observed["partitionObservation"]["dependencyComponents"],
            serde_json::json!([["a.ts", "b.ts"]])
        );
        assert_eq!(
            observed["partitionObservation"]["resolvedEdges"],
            serde_json::json!([
                {"from":"b.ts","specifier":"./middle","to":"middle.ts"},
                {"from":"middle.ts","specifier":"./a","to":"a.ts"}
            ])
        );
    }

    #[test]
    fn loaded_module_partition_does_not_claim_parallel_safety_or_retained_execution() {
        for (retained, qualified) in [(false, false), (true, false), (true, true)] {
            let mut request =
                component_request("partitionScopeDev", "/repo/global.ts", "const shared=1;");
            request.retained = retained;
            request.qualified = qualified;
            let observed = analyze(request, component_sdk()).unwrap();
            let partition = &observed["partitionObservation"];
            assert_eq!(partition["parallelSafetyEvaluated"], false);
            assert_eq!(partition["globalAdmissionInferred"], false);
            assert_eq!(partition["executed"], !retained);
            if retained {
                assert_eq!(
                    partition["unsupported"],
                    serde_json::json!(["COMPONENT_ORDINARY_INPUTS_NOT_ENABLED"])
                );
                assert!(partition.get("dependencyComponents").is_none());
            } else {
                assert_eq!(
                    partition["dependencyComponents"],
                    serde_json::json!([["global.ts"]])
                );
            }
        }
    }

    #[test]
    fn loaded_module_partition_reports_unavailable_or_duplicate_selected_context() {
        let fs = Rc::new(CaptureFs::new(
            BTreeMap::from([
                ("/repo/a.ts".into(), "export const a=1;".into()),
                (
                    "/outside/external.ts".into(),
                    "export const external=2;".into(),
                ),
            ]),
            ts_goport::frontend::vfs::osvfs_fs().use_case_sensitive_file_names(),
        ));
        let mut options = compiler_options();
        options.no_lib = Tristate::True;
        let frontend = native_frontend_with_options(
            fs.clone(),
            "/repo",
            "/sdk/lib",
            vec!["/repo/a.ts".into(), "/outside/external.ts".into()],
            false,
            options,
        );
        let loaded = program::new_program_version(&frontend.program, None);
        let _current = core::enter_program(Some(loaded));
        program::bind_all();
        for (roots, expected) in [
            (
                vec!["/repo/missing.ts".into()],
                "PARTITION_SELECTED_SOURCE_UNAVAILABLE",
            ),
            (
                vec!["/repo/a.ts".into(), "/repo/a.ts".into()],
                "PARTITION_DUPLICATE_SELECTED_SOURCE",
            ),
            (
                vec!["/outside/external.ts".into()],
                "PARTITION_SELECTED_SOURCE_OUTSIDE_GRAPH",
            ),
        ] {
            let observed = partition_observations::observe(&frontend.program, &fs, "/repo", &roots);
            assert_eq!(observed["executed"], false, "{observed}");
            assert_eq!(observed["unsupported"], serde_json::json!([expected]));
            assert!(observed.get("dependencyComponents").is_none());
        }
        let empty = partition_observations::observe(&frontend.program, &fs, "/repo", &[]);
        assert_eq!(empty["executed"], true);
        assert_eq!(empty["dependencyComponents"], serde_json::json!([]));
    }

    #[test]
    fn opaque_callback_observation_tracks_actual_graph_ownership_and_edge_removal() {
        let source = "import { register } from 'opaque'; function helper() { return 1; } export function main() { return register(() => helper()); }";
        let mut request = component_request("opaqueOwnershipDev", "/repo/main.ts", source);
        request.retained = true;
        request.qualified = true;
        request.files.insert(
            "/repo/package.json".into(),
            r#"{"dependencies":{"opaque":"1.0.0"}}"#.into(),
        );
        let observed = analyze(request, component_sdk()).unwrap();
        let ownership = &observed["subjects"][0]["opaqueCallbackOwnership"];
        assert_eq!(ownership["executed"], true, "{ownership}");
        assert_eq!(ownership["unsupported"], serde_json::json!([]));
        for (phase, expected) in [
            ("beforeAnalysis", true),
            ("afterAnalysis", false),
            ("afterGraphEdgesRemoved", true),
        ] {
            let phase = &ownership[phase];
            assert_eq!(phase["executed"], true, "{phase}");
            assert_eq!(phase["unsupported"], serde_json::json!([]), "{phase}");
            assert_eq!(
                phase["reasons"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|reason| reason == "SOURCE_OPAQUE_CALLBACK_UNSUPPORTED"),
                expected,
                "{phase}"
            );
        }
        let graph = &observed["assembly"];
        assert_eq!(
            ownership["graphBeforeEdgeRemovalId"],
            identity::digest(graph)
        );
        let mut removed_graph = graph.clone();
        removed_graph["edges"] = serde_json::json!([]);
        assert_eq!(
            ownership["graphAfterEdgeRemovalId"],
            identity::digest(&removed_graph)
        );
        let nodes = graph["nodes"].as_array().unwrap();
        let caller = nodes.iter().find(|node| node["name"] == "main").unwrap();
        let helper = nodes.iter().find(|node| node["name"] == "helper").unwrap();
        assert!(graph["edges"].as_array().unwrap().iter().any(|edge| {
            edge["kind"] == "calls" && edge["from"] == caller["id"] && edge["to"] == helper["id"]
        }));
        assert_eq!(ownership["globalAdmissionInferred"], false);
    }

    #[test]
    fn opaque_callback_observation_requires_retained_qualified_inputs() {
        for (retained, qualified) in [(false, false), (true, false)] {
            let mut request = component_request(
                "opaqueOwnershipModeDev",
                "/repo/mode.ts",
                "export function leaf(){return 1;}",
            );
            request.retained = retained;
            request.qualified = qualified;
            let observed = analyze(request, component_sdk()).unwrap();
            let ownership = &observed["subjects"][0]["opaqueCallbackOwnership"];
            assert_eq!(ownership["executed"], false, "{ownership}");
            assert_eq!(
                ownership["unsupported"],
                serde_json::json!(["COMPONENT_RETAINED_QUALIFIED_INPUTS_NOT_ENABLED"])
            );
            assert!(ownership.get("beforeAnalysis").is_none());
            assert!(ownership.get("afterAnalysis").is_none());
            assert!(ownership.get("afterGraphEdgesRemoved").is_none());
        }
    }

    #[test]
    fn opaque_callback_observation_does_not_substitute_a_missing_native_phase() {
        let observed = serde_json::json!({
            "moduleConfigurationObservations":{
                "retainedWithoutSource":{"executed":true,"unsupported":[],"reasons":[]}
            }
        });
        let graph = serde_json::json!({"nodes":[],"edges":[]});
        for missing in [
            serde_json::Value::Null,
            serde_json::json!({}),
            serde_json::json!({"moduleConfigurationObservations":{"retainedWithoutSource":null}}),
            serde_json::json!({"moduleConfigurationObservations":{"retainedWithoutSource":[]}}),
        ] {
            for index in 0..3 {
                let mut phases = [&observed, &observed, &observed];
                phases[index] = &missing;
                assert!(
                    component_observations::opaque_callback_ownership(
                        phases[0], phases[1], phases[2], &graph, &graph
                    )
                    .is_err()
                );
            }
        }
    }

    #[test]
    fn explicit_configured_query_cli_resolves_without_inserting_an_import() {
        let directory = std::env::temp_dir().join(format!(
            "semctx-explicit-configured-query-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&directory).unwrap();
        let descriptor = serde_json::json!({
            "root":"/repo", "sdk_directory":"/sdk/lib",
            "case_sensitive":ts_goport::frontend::vfs::osvfs_fs().use_case_sensitive_file_names(),
            "files":{
                "/repo/source.ts":"export const sourceDev = 53;",
                "/repo/leaf.ts":"export const leafDev = 59;",
                "/repo/tsconfig.json":r##"{"compilerOptions":{"baseUrl":".","paths":{"#leaf":["./leaf.ts"]}}}"##
            },
            "directories":["/repo/.git"],
            "containing_file":"/repo/source.ts", "specifier":"#leaf"
        });
        let request = directory.join("descriptor.json");
        std::fs::write(&request, serde_json::to_vec(&descriptor).unwrap()).unwrap();
        let args = vec![
            "semctx-r0-probe".into(),
            "--observe-configured-resolution".into(),
            request.to_string_lossy().into_owned(),
            concat!(env!("CARGO_MANIFEST_DIR"), "/sdk/sdk-input.json").into(),
        ];
        let observed = additional_observation(&args).unwrap();
        std::fs::remove_dir_all(&directory).unwrap();
        let observed = observed.expect("explicit configured-resolution operation must execute");
        assert_eq!(observed["executed"], true, "{observed}");
        assert_eq!(observed["unsupported"], serde_json::json!([]));
        assert_eq!(observed["resolved_relative_path"], "leaf.ts");
        assert_eq!(
            observed["configuration"],
            serde_json::json!({"executed":true,"reasons":[],"unsupported":[]})
        );
        assert_eq!(
            observed["capturedDirectories"],
            serde_json::json!([{"path":"/repo/.git","found":true}])
        );
        assert_eq!(
            observed["request_descriptor_id"],
            serde_json::json!(identity::digest(&descriptor))
        );
        assert_eq!(observed["containing_file"], "/repo/source.ts");
        assert_eq!(observed["specifier"], "#leaf");
    }

    #[test]
    fn retained_callable_observation_distinguishes_type_origins_and_noncallable_initializers() {
        let text = "import { callableOwnerDev, type callableOwnerDev as typeOwnerDev } from './callable-owner-dev'; import type defaultOwnerDev from './callable-owner-dev'; import type * as typeNamespaceDev from './callable-owner-dev'; export const liveDev = callableOwnerDev; export const specifierDev = typeOwnerDev; export const defaultDev = defaultOwnerDev; export const namespaceDev = typeNamespaceDev.callableOwnerDev; export const dataDev = 1; export const arrowDev = () => 17; export const observedArrowDev = arrowDev; export const observedDataDev = dataDev; export let pendingDev;";
        let mut request = component_request(
            "callableObservationDev",
            "/repo/callable-consumer-dev.ts",
            text,
        );
        request.retained = true;
        request.files.insert(
            "/repo/callable-owner-dev.ts".into(),
            "export function callableOwnerDev() {} export default function defaultOwnerDev() {}"
                .into(),
        );
        let ordinary = Request {
            retained: false,
            ..request.clone()
        };
        let observed = analyze(request, component_sdk()).unwrap();
        let component = &observed["subjects"][0]["retainedCallableInitializers"];
        assert_eq!(component["executed"], true);
        assert_eq!(component["unsupported"], serde_json::json!([]));
        let variables = component["variables"].as_array().unwrap();
        let coordinate =
            |name: &str| &variables.iter().find(|v| v["name"] == name).unwrap()["coordinate"];
        assert_eq!(
            coordinate("liveDev"),
            &serde_json::json!({"relPath":"callable-owner-dev.ts","symbolPath":"callableOwnerDev"})
        );
        assert_eq!(
            coordinate("observedArrowDev"),
            &serde_json::json!({"relPath":"callable-consumer-dev.ts","symbolPath":"arrowDev"})
        );
        for name in [
            "specifierDev",
            "defaultDev",
            "namespaceDev",
            "observedDataDev",
        ] {
            assert_eq!(coordinate(name), &serde_json::json!({"state":"undefined"}));
        }
        assert_eq!(
            coordinate("pendingDev"),
            &serde_json::json!({"state":"no_initializer"})
        );
        let observed = analyze(ordinary, component_sdk()).unwrap();
        assert_eq!(
            observed["subjects"][0]["retainedCallableInitializers"],
            serde_json::json!({"executed":false,"unsupported":["COMPONENT_RETAINED_INPUTS_NOT_ENABLED"],"variables":[]})
        );
    }

    #[test]
    fn retained_callable_observation_preserves_native_resolution_failures_until_restored() {
        for (mapping, error) in [
            (
                serde_json::json!("index.ts"),
                Some("NATIVE_SDK59_SCALAR_VERSION_PATH_UNAVAILABLE"),
            ),
            (
                serde_json::json!([7]),
                Some("NATIVE_SDK59_VERSION_PATH_ELEMENT_UNAVAILABLE"),
            ),
            (serde_json::json!(["index.ts"]), None),
        ] {
            let mut request = component_request(
                "callableFailureObservationDev",
                "/repo/callable-failure-dev.ts",
                "import { callableFailureDev } from 'callable-failure-dev'; export const observed = callableFailureDev;",
            );
            request.retained = true;
            request.files.insert(
                "/repo/node_modules/callable-failure-dev/package.json".into(),
                serde_json::json!({"types":"index.ts","typesVersions":{"<6":{"*":mapping}}})
                    .to_string(),
            );
            request.files.insert(
                "/repo/node_modules/callable-failure-dev/index.ts".into(),
                "export function callableFailureDev() { return 19; }".into(),
            );
            let observed = analyze(request, component_sdk()).unwrap();
            let component = &observed["subjects"][0]["retainedCallableInitializers"];
            assert_eq!(component["executed"], true);
            let unsupported = component["unsupported"].as_array().unwrap();
            if let Some(error) = error {
                assert!(
                    unsupported.contains(&serde_json::json!(error)),
                    "{component}"
                );
                assert!(
                    unsupported
                        .iter()
                        .any(|value| value.as_str().is_some_and(|reason| reason
                            .starts_with("NATIVE_MODULE_RESOLUTION_ERROR:")
                            && reason.contains(error))),
                    "{component}"
                );
            } else {
                assert!(unsupported.is_empty(), "{component}");
                assert_eq!(
                    component["variables"][0]["coordinate"],
                    serde_json::json!({"relPath":"node_modules/callable-failure-dev/index.ts","symbolPath":"callableFailureDev"})
                );
            }
        }
    }

    #[test]
    fn source_file_observation_reports_the_native_module_marker_independently_of_scope_refusals() {
        for (source, external) in [
            ("export const gapModuleMarker = 211;", true),
            (
                "export {}; declare global { const gapAugmentation: number; }",
                true,
            ),
            ("const gapGlobalScript = 223;", false),
        ] {
            let request = component_request("gapModuleObservation", "/repo/marker.ts", source);
            let result = analyze(request, component_sdk()).unwrap();
            let observation = &result["subjects"][0]["sourceFileObservation"];
            assert_eq!(observation["executed"], true);
            assert_eq!(observation["external_module"], external);
            assert_eq!(observation["unsupported"], serde_json::json!([]));
        }
    }

    #[test]
    fn imported_classic_factory_observation_distinguishes_generated_and_written_calls() {
        for (jsx, generated) in [("react", true), ("preserve", false)] {
            let mut request = component_request(
                "gapImportedFactory",
                "/repo/view.tsx",
                "import { constructGap } from './factory'; export const manual=constructGap('manual',null); export function view(){return <div/>;}",
            );
            request.files.insert(
                "/repo/factory.ts".into(),
                "export function constructGap(){return 0;}".into(),
            );
            request.files.insert("/repo/tsconfig.json".into(), serde_json::json!({"compilerOptions":{"jsx":jsx,"jsxFactory":"constructGap","module":"ESNext","moduleResolution":"Bundler"}}).to_string());
            let result = analyze(request, component_sdk()).unwrap();
            let runtime = &result["subjects"][0]["runtimeConfiguration"];
            assert_eq!(runtime["emission"]["state"], "observed");
            assert_eq!(
                runtime["emission"]["observation"]["classic_factory"],
                generated
            );
            assert_eq!(
                runtime["reasons"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|reason| reason == "SOURCE_CLASSIC_JSX_RUNTIME_UNSUPPORTED"),
                generated
            );
        }
    }

    #[test]
    fn ordinary_javascript_conditional_imports_keep_the_native_resolution_paths() {
        let mut request = component_request(
            "gapConditionalImportDev",
            "/repo/entry.cjs",
            "import { dualValue } from '@dev/dual'; export const observed=dualValue; export function later(){return import('@dev/dual');}",
        );
        request.retained = false;
        request.files.extend(BTreeMap::from([
            ("/repo/tsconfig.json".into(), "{\"compilerOptions\":{\"module\":\"NodeNext\",\"moduleResolution\":\"NodeNext\"}}".into()),
            ("/repo/node_modules/@dev/dual/package.json".into(), "{\"name\":\"@dev/dual\",\"exports\":{\"import\":\"./import.js\",\"require\":\"./require.js\"}}".into()),
            ("/repo/node_modules/@dev/dual/import.js".into(), "export const dualValue=233;".into()),
            ("/repo/node_modules/@dev/dual/require.js".into(), "export const dualValue=239;".into()),
        ]));
        let result = analyze(request, component_sdk()).unwrap();
        let imports = result["raw_extraction"]["imports"].as_array().unwrap();
        assert_eq!(imports.len(), 2);
        assert_eq!(
            imports[0]["resolvedRelPath"],
            "node_modules/@dev/dual/require.js"
        );
        assert_eq!(
            imports[1]["resolvedRelPath"],
            "node_modules/@dev/dual/import.js"
        );
    }

    #[test]
    fn ordinary_javascript_resolution_errors_and_missing_context_do_not_become_empty_success() {
        let path = "/repo/resolutionErrorsDev.js";
        let fs = Rc::new(CaptureFs::new(
            BTreeMap::from([(path.into(), "export const resolutionErrorsDev=241;".into())]),
            true,
        ));
        let mut frontend = ordinary_javascript_frontend(fs, "/repo", "/sdk/lib", path).unwrap();
        assert!(
            javascript_module_resolutions(&frontend, path)
                .unwrap()
                .is_empty()
        );
        assert!(javascript_module_resolutions(&frontend, "/repo/absentDev.js").is_err());
        Rc::get_mut(&mut frontend.program)
            .unwrap()
            .module_resolution_error = Some(ts_goport::gostd::errors::new(
            "resolution error from native program",
        ));
        assert!(
            javascript_module_resolutions(&frontend, path)
                .unwrap_err()
                .contains("resolution error from native program")
        );
        Rc::get_mut(&mut frontend.program)
            .unwrap()
            .module_resolution_error = None;
        frontend
            .resolution
            .as_ref()
            .unwrap()
            .borrow_mut()
            .errors
            .insert(
                path.into(),
                "resolution error from configured resolver".into(),
            );
        assert!(
            javascript_module_resolutions(&frontend, path)
                .unwrap_err()
                .contains("resolution error from configured resolver")
        );
        frontend
            .resolution
            .as_ref()
            .unwrap()
            .borrow_mut()
            .errors
            .clear();
        assert!(
            javascript_module_resolutions(&frontend, path)
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn retained_configuration_keeps_workspace_links_in_ordinary_observation_only() {
        let mut request = component_request(
            "t00WorkspaceConfigurationDev",
            "/repo/apps/web/main.ts",
            "export const t00WorkspaceConfigurationDev = 379;",
        );
        request.files.extend(BTreeMap::from([
            (
                "/repo/package.json".into(),
                r#"{"private":true,"workspaces":["packages/*","apps/*"]}"#.into(),
            ),
            (
                "/repo/apps/web/package.json".into(),
                r#"{"name":"web","dependencies":{"@t00/config":"workspace:*"}}"#.into(),
            ),
            (
                "/repo/apps/web/tsconfig.json".into(),
                r#"{"extends":"@t00/config/base.json"}"#.into(),
            ),
            (
                "/repo/packages/config/package.json".into(),
                r#"{"name":"@t00/config","version":"1.0.0"}"#.into(),
            ),
            (
                "/repo/packages/config/base.json".into(),
                r#"{"compilerOptions":{"module":"ESNext"}}"#.into(),
            ),
        ]));
        let observed = analyze(request, component_sdk()).unwrap();
        let modes = &observed["subjects"][0]["moduleConfigurationObservations"];
        assert_eq!(
            modes["retainedWithoutSource"]["reasons"],
            serde_json::json!(["SOURCE_CONFIGURATION_OUTSIDE_REPOSITORY"]),
            "{modes}"
        );
        assert_eq!(
            modes["ordinaryWithoutSnapshot"]["reasons"],
            serde_json::json!([])
        );
    }

    #[test]
    fn unsupported_workspace_configuration_stays_unknown_in_ordinary_observation() {
        let mut request = component_request(
            "t00UnknownWorkspaceDev",
            "/repo/apps/web/main.ts",
            "export const t00UnknownWorkspaceDev = 397;",
        );
        request.files.extend(BTreeMap::from([
            (
                "/repo/pnpm-workspace.yaml".into(),
                "packages: [apps/*, settings/*]".into(),
            ),
            (
                "/repo/apps/web/package.json".into(),
                r#"{"name":"web","dependencies":{"@t00/config":"workspace:*"}}"#.into(),
            ),
            (
                "/repo/apps/web/tsconfig.json".into(),
                r#"{"extends":"@t00/config/base.json"}"#.into(),
            ),
            (
                "/repo/settings/config/package.json".into(),
                r#"{"name":"@t00/config","version":"1.0.0"}"#.into(),
            ),
            ("/repo/settings/config/base.json".into(), "{}".into()),
        ]));
        let observed = analyze(request, component_sdk()).unwrap();
        let ordinary =
            &observed["subjects"][0]["moduleConfigurationObservations"]["ordinaryWithoutSnapshot"];
        assert!(
            ordinary["unsupported"]
                .as_array()
                .unwrap()
                .contains(&serde_json::json!("WORKSPACE_PNPM_DECLARATION_UNSUPPORTED")),
            "{ordinary}"
        );
    }

    #[test]
    fn component_observation_executes_semantics_for_ordinary_ts_without_changing_admission() {
        let request = component_request(
            "t00ComponentObservationsP",
            "/repo/component-observations-p.ts",
            r#"/// <reference path="./component-absent-p.ts" />
const t00ComponentObservationsP = 227;"#,
        );
        let observed = analyze(request, component_sdk()).unwrap();
        let subject = &observed["subjects"][0];
        assert_eq!(subject["semanticObservation"]["executed"], true);
        assert_eq!(
            subject["semanticObservation"]["reasons"],
            serde_json::json!(["SOURCE_REFERENCE_PATH_UNSUPPORTED"])
        );
        assert_eq!(
            subject["semanticObservation"]["unsupported"],
            serde_json::json!([])
        );
        assert_eq!(subject["outcome"], "analyzed");
        assert_eq!(subject["reasons"], serde_json::json!([]));
        let configurations = &subject["moduleConfigurationObservations"];
        assert_eq!(configurations["retainedWithoutSource"]["executed"], true);
        assert_eq!(
            configurations["retainedWithoutSource"]["reasons"],
            serde_json::json!(["SOURCE_REFERENCE_PATH_UNSUPPORTED"])
        );
        assert_eq!(
            configurations["retainedWithSource"]["reasons"],
            serde_json::json!([
                "SOURCE_REFERENCE_PATH_UNSUPPORTED",
                "SOURCE_GLOBAL_SCRIPT_UNSUPPORTED"
            ])
        );
        assert_eq!(
            configurations["ordinaryWithoutSnapshot"]["reasons"],
            serde_json::json!([])
        );
    }

    #[test]
    fn component_observation_keeps_snapshot_profile_out_of_ordinary_configuration() {
        let mut request = component_request(
            "t00ComponentProfileQ",
            "/repo/component-profile-q.ts",
            "const t00ComponentProfileQ = 229; export default t00ComponentProfileQ;",
        );
        request.files.insert(
            "/repo/tsconfig.json".into(),
            r#"{"compilerOptions":{"module":"CommonJS","moduleResolution":"Node10"}}"#.into(),
        );
        let observed = analyze(request, component_sdk()).unwrap();
        let modes = &observed["subjects"][0]["moduleConfigurationObservations"];
        let expected = serde_json::json!([
            "SOURCE_DEFAULT_EXPRESSION_UNSUPPORTED",
            "SOURCE_CONFIGURATION_MODULE_UNSUPPORTED:CommonJS",
            "SOURCE_CONFIGURATION_RESOLUTION_UNSUPPORTED:Node10"
        ]);
        assert_eq!(modes["retainedWithoutSource"]["reasons"], expected);
        assert_eq!(modes["retainedWithSource"]["reasons"], expected);
        assert_eq!(
            modes["ordinaryWithoutSnapshot"]["reasons"],
            serde_json::json!([])
        );
    }

    #[test]
    fn component_observation_source_parser_uses_source_codes_for_javascript() {
        let request = component_request(
            "t00ComponentParserR",
            "/repo/component-parser-r.js",
            "export const t00ComponentParserR = ;",
        );
        let observed = analyze(request, component_sdk()).unwrap();
        let parsing = &observed["subjects"][0]["sourceParsingObservation"];
        assert_eq!(parsing["executed"], true);
        assert_eq!(
            parsing["reasons"],
            serde_json::json!(["SOURCE_PARSE_ERROR:1109:Expression expected."])
        );
        assert_eq!(parsing["diagnosticCodes"], serde_json::json!([1109]));
        assert_eq!(parsing["diagnostics"][0]["start_utf16"], 35);
        assert_eq!(parsing["diagnostics"][0]["end_utf16"], 36);
    }

    #[test]
    fn component_observation_outside_configuration_short_circuits_all_source_reasons() {
        let mut request = component_request(
            "t00ComponentOutsideS",
            "/repo/component-outside-s.ts",
            "const t00ComponentOutsideS = 233; export default t00ComponentOutsideS;",
        );
        request.files.insert(
            "/tsconfig.json".into(),
            r#"{"compilerOptions":{"module":"CommonJS"}}"#.into(),
        );
        let observed = analyze(request, component_sdk()).unwrap();
        let modes = &observed["subjects"][0]["moduleConfigurationObservations"];
        for mode in [
            "retainedWithoutSource",
            "retainedWithSource",
            "ordinaryWithoutSnapshot",
        ] {
            assert_eq!(modes[mode]["executed"], true);
            assert_eq!(
                modes[mode]["reasons"],
                serde_json::json!(["SOURCE_CONFIGURATION_OUTSIDE_REPOSITORY"])
            );
            assert_eq!(modes[mode]["unsupported"], serde_json::json!([]));
        }
    }

    #[test]
    fn component_observation_invalid_json_configuration_preserves_source_and_parser_reasons() {
        let mut request = component_request(
            "t00ComponentInvalidT",
            "/repo/component-invalid-t.ts",
            "const t00ComponentInvalidT = 239; export default t00ComponentInvalidT;",
        );
        request.files.insert(
            "/repo/tsconfig.json".into(),
            r#"{"compilerOptions": "#.into(),
        );
        let observed = analyze(request, component_sdk()).unwrap();
        let modes = &observed["subjects"][0]["moduleConfigurationObservations"];
        let retained = modes["retainedWithoutSource"]["reasons"]
            .as_array()
            .unwrap();
        let ordinary = modes["ordinaryWithoutSnapshot"]["reasons"]
            .as_array()
            .unwrap();
        assert_eq!(
            retained.first().unwrap(),
            "SOURCE_DEFAULT_EXPRESSION_UNSUPPORTED"
        );
        assert!(!ordinary.is_empty());
        assert!(ordinary.iter().all(|reason| {
            reason
                .as_str()
                .unwrap()
                .starts_with("SOURCE_CONFIGURATION_INVALID:")
        }));
        assert_eq!(&retained[1..], ordinary);
    }

    #[test]
    fn component_observation_distinguishes_explicit_module_none_from_omission() {
        let mut request = component_request(
            "t00ComponentNoneV",
            "/repo/component-none-v.ts",
            "export const t00ComponentNoneV = 241;",
        );
        request.files.insert(
            "/repo/tsconfig.json".into(),
            r#"{"compilerOptions":{"module":"none"}}"#.into(),
        );
        let observed = analyze(request.clone(), component_sdk()).unwrap();
        let modes = &observed["subjects"][0]["moduleConfigurationObservations"];
        assert_eq!(
            modes["retainedWithoutSource"]["reasons"],
            serde_json::json!(["SOURCE_CONFIGURATION_MODULE_UNSUPPORTED:None"])
        );
        assert_eq!(
            modes["ordinaryWithoutSnapshot"]["reasons"],
            serde_json::json!([])
        );
        request
            .files
            .insert("/repo/tsconfig.json".into(), "{}".into());
        let omitted = analyze(request, component_sdk()).unwrap();
        assert_eq!(
            omitted["subjects"][0]["moduleConfigurationObservations"]["retainedWithoutSource"]["reasons"],
            serde_json::json!([])
        );
    }

    #[test]
    fn component_observation_distinguishes_absent_and_invalid_configuration_for_jsx() {
        let mut request = component_request(
            "t00ComponentViewU",
            "/repo/component-view-u.tsx",
            "/** @jsxRuntime automatic */\nconst t00ComponentViewU=<aside/>; export {};",
        );
        let absent = analyze(request.clone(), component_sdk()).unwrap();
        assert_eq!(
            absent["subjects"][0]["moduleConfigurationObservations"]["retainedWithoutSource"]["reasons"],
            serde_json::json!(["SOURCE_AUTOMATIC_JSX_RUNTIME_UNSUPPORTED"])
        );
        request.files.insert(
            "/repo/tsconfig.json".into(),
            r#"{"compilerOptions": "#.into(),
        );
        let invalid = analyze(request, component_sdk()).unwrap();
        let reasons = invalid["subjects"][0]["moduleConfigurationObservations"]["retainedWithoutSource"]["reasons"].as_array().unwrap();
        assert!(!reasons.is_empty());
        assert!(reasons.iter().all(|reason| {
            reason
                .as_str()
                .unwrap()
                .starts_with("SOURCE_CONFIGURATION_INVALID:")
        }));
    }

    #[test]
    fn case_mode_accepts_matching_native_semantics_and_rejects_mismatch() {
        assert!(validate_case_mode(false, false).is_ok());
        assert!(validate_case_mode(true, true).is_ok());
        assert!(validate_case_mode(true, false).is_err());
        assert!(validate_case_mode(false, true).is_err());
    }
    #[test]
    fn case_insensitive_capture_preserves_spelling_and_read_only_disposition() {
        let fs = CaptureFs::new(
            BTreeMap::from([("/repo/CamelName.ts".into(), "export const leaf = 1;".into())]),
            false,
        );
        assert_eq!(
            fs.read_file("/REPO/camelname.ts"),
            ("export const leaf = 1;".into(), true)
        );
        assert_eq!(fs.realpath("/repo/camelname.ts"), "/repo/CamelName.ts");
        assert_eq!(
            fs.get_accessible_entries("/REPO").files,
            vec!["CamelName.ts"]
        );
        assert!(matches!(
            fs.write_file("/repo/CamelName.ts", "changed"),
            Err(FsError::Permission)
        ));
        assert_eq!(fs.read_file("/etc/passwd"), (String::new(), false));
        assert!(!fs.log.borrow().last().unwrap().found);
        assert!(fs.log.borrow().last().unwrap().content_id.is_none());
    }

    #[test]
    fn development_driver_extracts_alias_calls_and_structural_test_binding() {
        let request: Request = serde_json::from_value(serde_json::json!({
            "id":"t00DevelopmentDriverA","cwd":"/repo","sdk_directory":"/sdk/lib",
            "case_sensitive":ts_goport::frontend::vfs::osvfs_fs().use_case_sensitive_file_names(),
            "roots":["/repo/leaf.ts","/repo/entry.test.ts"],
            "files":{"/repo/leaf.ts":"export function t00DevelopmentDriverLeaf() { return 19; }","/repo/entry.test.ts":"import { t00DevelopmentDriverLeaf as t00DevelopmentDriverAlias } from './leaf.js'; export function t00DevelopmentDriverCaller() { return t00DevelopmentDriverAlias(); }"},
            "roles":{"leaf.ts":"source","entry.test.ts":"test"},
            "options":{"target":"ES2022","module":"ESNext","moduleResolution":"Bundler","allowJs":true,"jsx":"Preserve","skipLibCheck":true,"noEmit":true,"strict":false}
        })).unwrap();
        let sdk: Sdk = serde_json::from_slice(
            &std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/sdk/sdk-input.json")).unwrap(),
        )
        .unwrap();
        let result = analyze(request, sdk).unwrap();
        assert_eq!(
            result["raw_extraction"]["symbols"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        let edges = result["assembly"]["edges"].as_array().unwrap();
        assert!(edges.iter().any(|edge| edge["kind"] == "calls"
            && edge["from"] == "sym:function:entry.test.ts:t00DevelopmentDriverCaller"
            && edge["to"] == "sym:function:leaf.ts:t00DevelopmentDriverLeaf"));
        assert!(edges.iter().any(|edge| edge["kind"] == "tested_by"));
        assert_eq!(result["subjects"].as_array().unwrap().len(), 2);
        assert_eq!(result["complete"], true);
        assert_eq!(result["global_admission_inferred"], false);
    }

    #[test]
    fn development_driver_observes_configured_aliases_and_runtime_jsx_boundary() {
        let request:Request=serde_json::from_value(serde_json::json!({"id":"t00DevelopmentIntegratedConfigC","cwd":"/repo","sdk_directory":"/sdk/lib","case_sensitive":ts_goport::frontend::vfs::osvfs_fs().use_case_sensitive_file_names(),"roots":["/repo/leaf.ts","/repo/use.jsx"],"files":{"/repo/leaf.ts":"export function t00DevelopmentConfiguredLeafC(){ return 149; }","/repo/use.jsx":"import {t00DevelopmentConfiguredLeafC} from '@t00-owned'; export function t00DevelopmentConfiguredUseC(){ t00DevelopmentConfiguredLeafC(); return <main />; }","/repo/tsconfig.json":"{\"compilerOptions\":{\"module\":\"ESNext\",\"moduleResolution\":\"Bundler\",\"paths\":{\"@t00-owned\":[\"./leaf.ts\"]},\"jsx\":\"react-jsx\"}}"},"qualified":true,"options":{"target":"ES2022","module":"ESNext","moduleResolution":"Bundler","allowJs":true,"jsx":"Preserve","skipLibCheck":true,"noEmit":true,"strict":false}})).unwrap();
        let sdk: Sdk = serde_json::from_slice(
            &std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/sdk/sdk-input.json")).unwrap(),
        )
        .unwrap();
        let result = analyze(request, sdk).unwrap();
        assert_eq!(
            result["raw_extraction"]["calls"][0]["calleeRelPath"],
            "leaf.ts"
        );
        let subject = result["subjects"]
            .as_array()
            .unwrap()
            .iter()
            .find(|subject| subject["path"] == "use.jsx")
            .unwrap();
        assert!(
            subject["reasons"]
                .as_array()
                .unwrap()
                .iter()
                .any(|reason| reason == "SOURCE_AUTOMATIC_JSX_RUNTIME_UNSUPPORTED")
        );
        assert_eq!(
            subject["javascript"]["staticModuleLinks"][0]["resolution"],
            "resolved"
        );
        assert_eq!(subject["outcome"], "unsupported");
    }

    #[test]
    fn development_driver_keeps_assembly_coordinate_refusal_at_consumer_boundary() {
        let request:Request=serde_json::from_value(serde_json::json!({"id":"t00DevelopmentCoordinateDriverD","cwd":"/repo","sdk_directory":"/sdk/lib","case_sensitive":ts_goport::frontend::vfs::osvfs_fs().use_case_sensitive_file_names(),"roots":["/repo/duplicates.ts"],"files":{"/repo/duplicates.ts":"export function t00DevelopmentDuplicateD(){ return t00DevelopmentLeafD(); } export function t00DevelopmentDuplicateD(){ return t00DevelopmentLeafD(); } export function t00DevelopmentLeafD(){ return 163; }"},"qualified":true,"options":{"target":"ES2022","module":"ESNext","moduleResolution":"Bundler","allowJs":true,"jsx":"Preserve","skipLibCheck":true,"noEmit":true,"strict":false}})).unwrap();
        let sdk: Sdk = serde_json::from_slice(
            &std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/sdk/sdk-input.json")).unwrap(),
        )
        .unwrap();
        let result = analyze(request, sdk).unwrap();
        assert!(
            result["subjects"][0]["reasons"]
                .as_array()
                .unwrap()
                .iter()
                .any(|reason| reason
                    .as_str()
                    .unwrap_or_default()
                    .starts_with("QUALIFIED_CALL_COORDINATE_CALLER_AMBIGUOUS:"))
        );
        assert_eq!(result["subjects"][0]["outcome"], "unsupported");
    }

    #[test]
    fn development_selection_exclusion_is_distinct_from_disabled_analysis() {
        let request:Request=serde_json::from_value(serde_json::json!({"id":"t00DevelopmentSelectionE","cwd":"/repo","sdk_directory":"/sdk/lib","case_sensitive":ts_goport::frontend::vfs::osvfs_fs().use_case_sensitive_file_names(),"roots":["/repo/live.ts","/repo/disabled.ts"],"files":{"/repo/live.ts":"export function t00DevelopmentLiveE(){return 173;}","/repo/disabled.ts":"export function t00DevelopmentDisabledE(){return 179;}"},"selection":{"disabled.ts":"excluded"},"options":{"target":"ES2022","module":"ESNext","moduleResolution":"Bundler","allowJs":true,"jsx":"Preserve","skipLibCheck":true,"noEmit":true,"strict":false}})).unwrap();
        let sdk: Sdk = serde_json::from_slice(
            &std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/sdk/sdk-input.json")).unwrap(),
        )
        .unwrap();
        let result = analyze(request.clone(), sdk.clone()).unwrap();
        assert_eq!(
            result["raw_extraction"]["symbols"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        let subject = result["subjects"]
            .as_array()
            .unwrap()
            .iter()
            .find(|subject| subject["path"] == "disabled.ts")
            .unwrap();
        assert_eq!(subject["outcome"], "not_applicable");
        assert_eq!(subject["selection"], "excluded");
        assert!(
            !result["assembly"]["nodes"]
                .as_array()
                .unwrap()
                .iter()
                .any(|node| node["filePath"] == "disabled.ts")
        );
        let mut language_off = request;
        language_off.disabled.insert("live.ts".into());
        let off = analyze(language_off, sdk).unwrap();
        let disabled = off["subjects"]
            .as_array()
            .unwrap()
            .iter()
            .find(|subject| subject["path"] == "live.ts")
            .unwrap();
        assert_eq!(disabled["outcome"], "disabled");
        assert_eq!(disabled["selection"], "selected");
        assert!(
            off["raw_extraction"]["symbols"]
                .as_array()
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn development_review_boundary_rejects_qualified_without_retained_capture() {
        let request:Request=serde_json::from_value(serde_json::json!({"id":"t00DevelopmentRetainedL","cwd":"/repo","sdk_directory":"/sdk/lib","case_sensitive":ts_goport::frontend::vfs::osvfs_fs().use_case_sensitive_file_names(),"roots":["/repo/retained.ts"],"files":{"/repo/retained.ts":"export function t00DevelopmentRetainedL(){return 197;}"},"qualified":true,"retained":false,"options":{"target":"ES2022","module":"ESNext","moduleResolution":"Bundler","allowJs":true,"jsx":"Preserve","skipLibCheck":true,"noEmit":true,"strict":false}})).unwrap();
        let sdk: Sdk = serde_json::from_slice(
            &std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/sdk/sdk-input.json")).unwrap(),
        )
        .unwrap();
        assert!(matches!(analyze(request,sdk),Err(error) if error=="SOURCE_SNAPSHOT_REQUIRED"));
    }

    #[test]
    fn development_review_boundary_refuses_late_javascript_configuration_reason() {
        let request:Request=serde_json::from_value(serde_json::json!({"id":"t00DevelopmentNamedM","cwd":"/repo","sdk_directory":"/sdk/lib","case_sensitive":ts_goport::frontend::vfs::osvfs_fs().use_case_sensitive_file_names(),"roots":["/repo/named.js"],"files":{"/repo/named.js":"export function t00DevelopmentNamedM(){return 199;}","/repo/tsconfig.build.json":"{}"},"options":{"target":"ES2022","module":"ESNext","moduleResolution":"Bundler","allowJs":true,"jsx":"Preserve","skipLibCheck":true,"noEmit":true,"strict":false}})).unwrap();
        let sdk: Sdk = serde_json::from_slice(
            &std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/sdk/sdk-input.json")).unwrap(),
        )
        .unwrap();
        let observed = analyze(request.clone(), sdk.clone()).unwrap();
        assert!(
            observed["subjects"][0]["reasons"]
                .as_array()
                .unwrap()
                .iter()
                .any(|reason| reason == "SOURCE_NAMED_CONFIGURATION_UNSUPPORTED")
        );
        assert_eq!(observed["subjects"][0]["outcome"], "unsupported");
        assert_eq!(
            batch::build(&request, &sdk, &observed).unwrap().terminal,
            wire::Terminal::Refused
        );
    }

    #[test]
    fn development_review_boundary_normalizes_windows_capture_directory_spelling() {
        let fs = CaptureFs::new(
            BTreeMap::from([(
                "C:\\repo\\Nested\\leaf.ts".into(),
                "export const t00DevelopmentWindowsN=211;".into(),
            )]),
            false,
        );
        assert!(fs.file_exists("c:/REPO/nested/leaf.ts"));
        assert!(fs.directory_exists("C:\\repo\\Nested"));
        assert_eq!(
            fs.get_accessible_entries("C:\\repo\\Nested").files,
            vec!["leaf.ts"]
        );
        assert_eq!(
            fs.realpath("c:/repo/nested/leaf.ts"),
            "C:/repo/Nested/leaf.ts"
        );
    }

    #[test]
    fn development_input_read_observations_bind_returned_source_and_sdk_text() {
        let source = "export function t00DevelopmentReadK(){return 193;}";
        let request:Request=serde_json::from_value(serde_json::json!({"id":"t00DevelopmentReadK","cwd":"/repo","sdk_directory":"/sdk/lib","case_sensitive":ts_goport::frontend::vfs::osvfs_fs().use_case_sensitive_file_names(),"roots":["/repo/read.ts"],"files":{"/repo/read.ts":source},"options":{"target":"ES2022","module":"ESNext","moduleResolution":"Bundler","allowJs":true,"jsx":"Preserve","skipLibCheck":true,"noEmit":true,"strict":false}})).unwrap();
        let sdk: Sdk = serde_json::from_slice(
            &std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/sdk/sdk-input.json")).unwrap(),
        )
        .unwrap();
        let observed = analyze(request.clone(), sdk.clone()).unwrap();
        let batch = batch::build(&request, &sdk, &observed).unwrap();
        let source_read = batch
            .input_observations
            .iter()
            .find(|probe| {
                probe.operation == "read_file" && probe.path == "/repo/read.ts" && probe.found
            })
            .unwrap();
        assert_eq!(
            source_read.content_id,
            Some(identity::digest_bytes(source.as_bytes()))
        );
        let sdk_path = "/sdk/lib/lib.es2022.full.d.ts";
        let library_read = batch
            .input_observations
            .iter()
            .find(|probe| probe.operation == "read_file" && probe.path == sdk_path && probe.found)
            .unwrap();
        assert_eq!(
            library_read.content_id,
            Some(identity::digest_bytes(sdk.files[sdk_path].as_bytes()))
        );
    }

    #[test]
    fn development_default_program_observes_automatic_type_directives() {
        let request:Request=serde_json::from_value(serde_json::json!({"id":"t00DevelopmentAutomaticJ","cwd":"/repo","sdk_directory":"/sdk/lib","case_sensitive":ts_goport::frontend::vfs::osvfs_fs().use_case_sensitive_file_names(),"roots":["/repo/automatic.ts"],"files":{"/repo/automatic.ts":"export function t00DevelopmentAutomaticJ(){return t00AmbientAutomaticJ();}","/repo/node_modules/@types/t00-development-automatic-j/index.d.ts":"declare function t00AmbientAutomaticJ():number;"},"options":{"target":"ES2022","module":"ESNext","moduleResolution":"Bundler","allowJs":true,"jsx":"Preserve","skipLibCheck":true,"noEmit":true,"strict":false}})).unwrap();
        let sdk: Sdk = serde_json::from_slice(
            &std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/sdk/sdk-input.json")).unwrap(),
        )
        .unwrap();
        let observed = analyze(request, sdk).unwrap();
        assert_eq!(observed["calls"][0]["symbol_name"], "t00AmbientAutomaticJ");
        assert_eq!(
            observed["calls"][0]["declarations"][0]["file"],
            "/repo/node_modules/@types/t00-development-automatic-j/index.d.ts"
        );
    }

    #[test]
    fn development_graph_preserves_javascript_metadata_and_source_line_evidence() {
        let request:Request=serde_json::from_value(serde_json::json!({"id":"t00DevelopmentGraphMetadataI","cwd":"/repo","sdk_directory":"/sdk/lib","case_sensitive":ts_goport::frontend::vfs::osvfs_fs().use_case_sensitive_file_names(),"roots":["/repo/metadata.js"],"files":{"/repo/metadata.js":"import {join} from 'node:path';\nexport function t00DevelopmentMetadataI(){return join('a','b');}"},"options":{"target":"ES2022","module":"ESNext","moduleResolution":"Bundler","allowJs":true,"jsx":"Preserve","skipLibCheck":true,"noEmit":true,"strict":false}})).unwrap();
        let sdk: Sdk = serde_json::from_slice(
            &std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/sdk/sdk-input.json")).unwrap(),
        )
        .unwrap();
        let observed = analyze(request, sdk).unwrap();
        let nodes = observed["assembly"]["nodes"].as_array().unwrap();
        let module = nodes.iter().find(|node| node["kind"] == "module").unwrap();
        assert_eq!(
            module["metadata"]["staticExports"],
            "[{\"name\":\"t00DevelopmentMetadataI\",\"declarationKind\":\"function\"}]"
        );
        assert_eq!(
            module["metadata"]["staticModuleLinks"],
            "[{\"specifier\":\"node:path\",\"resolution\":\"external\"}]"
        );
        let symbol = nodes
            .iter()
            .find(|node| node["kind"] == "function")
            .unwrap();
        assert_eq!(
            symbol["evidence"],
            serde_json::json!([{"filePath":"metadata.js","startLine":2,"endLine":2,"sourceKind":"code"}])
        );
    }

    #[test]
    fn development_wire_batch_binds_input_scope_and_exact_native_fact_ranges() {
        let request:Request=serde_json::from_value(serde_json::json!({"id":"t00DevelopmentWireG","cwd":"/repo","sdk_directory":"/sdk/lib","case_sensitive":ts_goport::frontend::vfs::osvfs_fs().use_case_sensitive_file_names(),"roots":["/repo/wire.ts"],"files":{"/repo/wire.ts":"// 🦀\nexport function t00DevelopmentWireG(){ return 181; }"},"qualified":true,"options":{"target":"ES2022","module":"ESNext","moduleResolution":"Bundler","allowJs":true,"jsx":"Preserve","skipLibCheck":true,"noEmit":true,"strict":false}})).unwrap();
        let sdk: Sdk = serde_json::from_slice(
            &std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/sdk/sdk-input.json")).unwrap(),
        )
        .unwrap();
        let observation = analyze(request.clone(), sdk.clone()).unwrap();
        let batch = batch::build(&request, &sdk, &observation).unwrap();
        let value = serde_json::to_value(&batch).unwrap();
        assert_eq!(batch.request_id, "t00DevelopmentWireG");
        assert_eq!(batch.profile, "modelo-suite-static-v1");
        assert_eq!(batch.subjects.len(), 1);
        assert_eq!(
            batch.subjects[0].outcome,
            Some(wire::AnalysisOutcome::Analyzed)
        );
        let fact = value["facts"]
            .as_array()
            .unwrap()
            .iter()
            .find(|fact| fact["id"] == "sym:function:wire.ts:t00DevelopmentWireG")
            .unwrap();
        assert_eq!(fact["range"]["start_utf16"], 6);
        assert_eq!(fact["range"]["start_line"], 2);
        assert_eq!(batch.facts_id, identity::digest(&value["facts"]));
        assert_ne!(batch.snapshot_id, batch.scope_id);
        assert_ne!(batch.capture_id, batch.producer_artifact_id);
        assert!(batch.complete);
        assert!(batch.producer_claimed_ownership.is_none());
        let mut incomplete = observation;
        incomplete["subjects"][0]["outcome"] = serde_json::json!("unknown");
        let unknown = batch::build(&request, &sdk, &incomplete).unwrap();
        assert_eq!(
            unknown.subjects[0].outcome,
            Some(wire::AnalysisOutcome::Unknown)
        );
        assert!(
            unknown.subjects[0]
                .coverage
                .iter()
                .all(|coverage| !coverage.complete && !coverage.negative_evidence_eligible)
        );
    }

    #[test]
    fn development_request_preserves_utf16_sources_and_rejects_conflicting_capture_keys() {
        let base = serde_json::json!({"id":"t00DevelopmentBoundaryB","cwd":"/repo","sdk_directory":"/sdk/lib","case_sensitive":ts_goport::frontend::vfs::osvfs_fs().use_case_sensitive_file_names(),"roots":["/repo/units.ts"],"files":{},"utf16_files":{"/repo/units.ts":[47,47,32,55296,13,10,101,120,112,111,114,116,32,102,117,110,99,116,105,111,110,32,116,48,48,68,101,118,101,108,111,112,109,101,110,116,85,110,105,116,115,40,41,32,123,125]},"options":{"target":"ES2022","module":"ESNext","moduleResolution":"Bundler","allowJs":true,"jsx":"Preserve","skipLibCheck":true,"noEmit":true,"strict":false}});
        let sdk = || {
            serde_json::from_slice::<Sdk>(
                &std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/sdk/sdk-input.json")).unwrap(),
            )
            .unwrap()
        };
        let result = analyze(serde_json::from_value(base.clone()).unwrap(), sdk()).unwrap();
        assert_eq!(
            result["raw_extraction"]["symbols"][0]["name"],
            "t00DevelopmentUnits"
        );
        assert_eq!(result["raw_extraction"]["symbols"][0]["startLine"], 2);
        assert_eq!(result["raw_extraction"]["symbols"][0]["startUtf16"], 6);
        assert_eq!(result["raw_extraction"]["symbols"][0]["endUtf16"], 46);
        let mut conflict = base.clone();
        conflict["files"] = serde_json::json!({"/repo/./units.ts":"export const another = 2;"});
        assert!(
            analyze(serde_json::from_value(conflict).unwrap(), sdk())
                .unwrap_err()
                .starts_with("conflicting captured key:")
        );
        let mut malformed = base;
        malformed["raw_files"] =
            serde_json::json!({"/repo/bad.ts":{"bytes":[256],"profile":"compiler_system"}});
        assert!(serde_json::from_value::<Request>(malformed).is_err());
    }

    #[test]
    fn development_driver_reports_ambiguous_exports_without_arbitrary_call_edge() {
        let request:Request=serde_json::from_value(serde_json::json!({"id":"t00DevelopmentDriverAmbiguity","cwd":"/repo","sdk_directory":"/sdk/lib","case_sensitive":ts_goport::frontend::vfs::osvfs_fs().use_case_sensitive_file_names(),"roots":["/repo/first.ts","/repo/second.ts","/repo/public.ts","/repo/use.ts"],"files":{"/repo/first.ts":"export function t00DevelopmentDriverShared(){ return 61; }","/repo/second.ts":"export function t00DevelopmentDriverShared(){ return 67; }","/repo/public.ts":"export * from './first.js'; export * from './second.js';","/repo/use.ts":"import {t00DevelopmentDriverShared} from './public.js'; export function t00DevelopmentDriverUse(){ return t00DevelopmentDriverShared(); }"},"qualified":true,"options":{"target":"ES2022","module":"ESNext","moduleResolution":"Bundler","allowJs":true,"jsx":"Preserve","skipLibCheck":true,"noEmit":true,"strict":false}})).unwrap();
        let sdk: Sdk = serde_json::from_slice(
            &std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/sdk/sdk-input.json")).unwrap(),
        )
        .unwrap();
        let result = analyze(request, sdk).unwrap();
        let public = result["subjects"]
            .as_array()
            .unwrap()
            .iter()
            .find(|subject| subject["path"] == "public.ts")
            .unwrap();
        assert!(public["reasons"].as_array().unwrap().iter().any(|reason| {
            reason
                .as_str()
                .unwrap_or_default()
                .starts_with("SOURCE_EXPORT_AMBIGUOUS")
        }));
        assert_eq!(public["outcome"], "unsupported");
        assert!(
            !result["assembly"]["edges"]
                .as_array()
                .unwrap()
                .iter()
                .any(|edge| edge["kind"] == "calls")
        );
    }
}

#[cfg(test)]
mod pass2_javascript_development {
    use super::*;

    fn observe(text: &str, retained: bool, configuration: Option<&str>) -> serde_json::Value {
        observe_files(text, retained, configuration, BTreeMap::new())
    }
    fn observe_files(
        text: &str,
        retained: bool,
        configuration: Option<&str>,
        additional: BTreeMap<String, String>,
    ) -> serde_json::Value {
        let mut files: BTreeMap<String, String> =
            BTreeMap::from([("/repo/t00JavascriptFullDev.js".into(), text.into())]);
        files.extend(additional);
        if let Some(configuration) = configuration {
            files.insert("/repo/tsconfig.json".into(), configuration.into());
        }
        let request: Request = serde_json::from_value(serde_json::json!({
            "id":"t00JavascriptFullDev", "cwd":"/repo", "sdk_directory":"/sdk/lib",
            "case_sensitive":ts_goport::frontend::vfs::osvfs_fs().use_case_sensitive_file_names(),
            "roots":["/repo/t00JavascriptFullDev.js"], "files":files, "retained":retained,
            "options":{"target":"ES2022","module":"ESNext","moduleResolution":"Bundler","allowJs":true,"jsx":"Preserve","skipLibCheck":true,"noEmit":true,"strict":false}
        })).unwrap();
        let sdk: Sdk = serde_json::from_slice(
            &std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/sdk/sdk-input.json")).unwrap(),
        )
        .unwrap();
        analyze(request, sdk).unwrap()["subjects"][0].clone()
    }

    #[test]
    fn ordinary_javascript_links_use_captured_dependencies_and_declared_external_packages() {
        for (specifier, files, resolution) in [
            (
                "./t00DependencyDev.js",
                BTreeMap::from([(
                    "/repo/t00DependencyDev.js".into(),
                    "export const dependencyDev = 409;".into(),
                )]),
                "resolved",
            ),
            (
                "t00-external-dev",
                BTreeMap::from([(
                    "/repo/package.json".into(),
                    r#"{"dependencies":{"t00-external-dev":"1.0.0"}}"#.into(),
                )]),
                "external",
            ),
        ] {
            let source = format!("import '{specifier}'; export const t00LinkDev = 419;");
            let observed = observe_files(&source, false, None, files);
            let operation = &observed["javascriptObservation"];
            assert_eq!(operation["executed"], true);
            assert_eq!(operation["unsupported"], serde_json::json!([]));
            assert_eq!(
                operation["staticModuleLinks"],
                serde_json::json!([{"specifier":specifier,"resolution":resolution}])
            );
            assert!(
                !operation["reasons"]
                    .as_array()
                    .unwrap()
                    .contains(&serde_json::json!(format!(
                        "JAVASCRIPT_IMPORT_UNRESOLVED:{specifier}"
                    )))
            );
        }
    }

    #[test]
    fn javascript_operation_preserves_retained_and_ordinary_configuration_boundaries() {
        for retained in [false, true] {
            let subject = observe(
                "export default 293;",
                retained,
                Some(r#"{"compilerOptions":{"module":"CommonJS","moduleResolution":"Node10"}}"#),
            );
            let observation = &subject["javascriptObservation"];
            assert_eq!(observation["executed"], true);
            assert_eq!(observation["parseFailed"], false);
            assert_eq!(observation["unsupported"], serde_json::json!([]));
            let expected = if retained {
                serde_json::json!([
                    "JAVASCRIPT_DEFAULT_EXPRESSION_UNSUPPORTED",
                    "SOURCE_CONFIGURATION_MODULE_UNSUPPORTED:CommonJS",
                    "SOURCE_CONFIGURATION_RESOLUTION_UNSUPPORTED:Node10",
                    "SOURCE_DEFAULT_EXPRESSION_UNSUPPORTED"
                ])
            } else {
                serde_json::json!(["JAVASCRIPT_DEFAULT_EXPRESSION_UNSUPPORTED"])
            };
            assert_eq!(observation["reasons"], expected);
            assert_eq!(
                observation["staticExports"],
                serde_json::json!([{"name":"default","declarationKind":"expression"}])
            );
        }
    }

    #[test]
    fn javascript_operation_uses_transpilation_diagnostics_for_js_type_syntax() {
        let subject = observe(
            "export const t00JavascriptTypedDev: number = 307;",
            true,
            None,
        );
        let observation = &subject["javascriptObservation"];
        assert_eq!(observation["executed"], true);
        assert_eq!(observation["parseFailed"], true);
        assert_eq!(subject["outcome"], "failed");
        assert_eq!(observation["unsupported"], serde_json::json!([]));
        assert_eq!(
            observation["reasons"],
            serde_json::json!([
                "JAVASCRIPT_PARSE_ERROR:8010:Type annotations can only be used in TypeScript files."
            ])
        );
    }

    #[test]
    fn javascript_operation_composes_semantic_native_and_resolution_reasons() {
        for retained in [false, true] {
            let generator = observe(
                "export function* t00JavascriptGeneratorDev(){ yield 317; }",
                retained,
                None,
            );
            let expected = if retained {
                serde_json::json!([
                    "JAVASCRIPT_ITERATION_UNSUPPORTED",
                    "SOURCE_ITERATION_UNSUPPORTED"
                ])
            } else {
                serde_json::json!(["JAVASCRIPT_ITERATION_UNSUPPORTED"])
            };
            assert_eq!(generator["javascriptObservation"]["reasons"], expected);
            assert_eq!(
                generator["javascriptObservation"]["unsupported"],
                serde_json::json!([])
            );
            let loader = observe("const t00JavascriptLoaderDev = require;", retained, None);
            let expected = if retained {
                serde_json::json!([
                    "JAVASCRIPT_COMMONJS_UNSUPPORTED",
                    "SOURCE_COMMONJS_UNSUPPORTED"
                ])
            } else {
                serde_json::json!(["JAVASCRIPT_COMMONJS_UNSUPPORTED"])
            };
            assert_eq!(loader["javascriptObservation"]["reasons"], expected);
            assert_eq!(
                loader["javascriptObservation"]["unsupported"],
                serde_json::json!([])
            );
            assert_eq!(loader["javascript"]["native"]["commonJsUnsupported"], true);
            let missing = observe(
                "import { t00MissingDev } from './t00JavascriptAbsentDev.js'; export { t00MissingDev };",
                retained,
                None,
            );
            assert_eq!(
                missing["javascriptObservation"]["reasons"],
                serde_json::json!(["JAVASCRIPT_IMPORT_UNRESOLVED:./t00JavascriptAbsentDev.js"])
            );
            assert_eq!(
                missing["javascriptObservation"]["unsupported"],
                serde_json::json!([])
            );
            assert_eq!(
                missing["javascriptObservation"]["staticModuleLinks"],
                serde_json::json!([{"specifier":"./t00JavascriptAbsentDev.js","resolution":"unresolved"}])
            );
        }
    }

    #[test]
    fn javascript_operation_does_not_add_explicit_source_scope_refusal() {
        let subject = observe("const t00JavascriptScriptDev = 311;", true, None);
        let observation = &subject["javascriptObservation"];
        assert_eq!(observation["executed"], true);
        assert_eq!(observation["parseFailed"], false);
        assert_eq!(observation["reasons"], serde_json::json!([]));
        assert_eq!(observation["unsupported"], serde_json::json!([]));
        assert_eq!(
            subject["moduleConfigurationObservations"]["retainedWithSource"]["reasons"],
            serde_json::json!(["SOURCE_GLOBAL_SCRIPT_UNSUPPORTED"])
        );
    }
}
