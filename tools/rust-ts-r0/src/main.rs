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
mod native_program;
mod ordinary;
mod outline;
mod parallel_observations;
mod partition_observations;
mod qualified;
mod qualified_path_eligibility;
mod qualified_verification;
mod repository_discovery;
mod retained_aliases;
mod retained_discovery_observations;
mod retained_manifest;
mod runtime_configuration;
mod scope_received;
mod sdk_compatibility;
mod sdk_inventory;
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    source_revision: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    library_manifest_sha256: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    archive_sha256: Option<String>,
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
    let host = compiler::new_compiler_host(cwd, fs.clone(), sdk, None, None, None);
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
        program: native_program::frontend(options, &fs),
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
    let _semantic = native_program::NativeProgram::enter(&frontend.program);
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
    let retained_function_owners =
        component_observations::retained_function_owners(file, &repository, retained);
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
    let capability_scope = serde_json::json!({"language":if ast::is_in_js_file(file){"javascript"}else{"typescript"},"dialectVersion":core::version(),"compilerIdentity":{"version":core::version(),"sourceRevision":"780dc512d64f40afebffa6a7028207649fb7ed1c"}});
    Ok(
        serde_json::json!({"path":path,"outcome":outcome,"reasons":reasons,"unimplemented":unimplemented,"parseDiagnostics":parsing,"sourceFileObservation":source_file_observation,"capabilityScope":capability_scope,"retainedScopeSyntaxObservation":retained_scope_syntax,"retainedCallableInitializers":callable_initializers,"retainedFunctionOwners":retained_function_owners,"semanticObservation":semantic_observation,"sourceParsingObservation":source_parsing_observation,"moduleConfigurationObservations":module_configuration_observations,"javascriptObservation":javascript_observation,"javascript":javascript,"graphMetadata":graph_metadata,"runtimeConfiguration":runtime,"configurationConsumed":configuration.consumed,"admission":"not_evaluated","semanticContextProbes":semantic_fs.log.borrow().clone(),"resolutionObservations":resolution}),
    )
}

#[expect(
    clippy::excessive_nesting,
    reason = "The feasibility probe retains explicit captured request and fact assembly branches."
)]
fn analyze(request: Request, sdk: Sdk) -> Result<serde_json::Value, String> {
    let compatibility = sdk_compatibility::classify(&sdk, &request.sdk_directory)?;
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
    if compatibility == sdk_compatibility::Compatibility::Native {
        sdk.validate_libraries(&request.sdk_directory)?;
    }
    let sdk_identity = sdk.capability_identity(compatibility);
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
    let sdk_keys = sdk
        .files
        .keys()
        .filter(|path| !path.ends_with("/package.json"))
        .cloned()
        .collect::<Vec<_>>();
    for (path, text) in sdk.files {
        if path.ends_with("/package.json") {
            continue;
        }
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
    let _current = native_program::NativeProgram::enter(&frontend.program);
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
        subject["capabilityScope"]["sdkIdentity"] = sdk_identity.clone();
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
        serde_json::json!({"schema_version":1,"request":request.id,"request_id":request_identity,"input_manifest_id":input_identity,"scope_id":identity::digest(&serde_json::json!({"roles":all_roles,"selection":selection})),"producer_artifact_id":artifact_identity,"engine_revision":"780dc512d64f40afebffa6a7028207649fb7ed1c","native_compiler_version":core::version(),"sdk_version":sdk.version,"calls":result,"raw_extraction":extraction,"assembly":assembly,"test_dynamic_import_keys":test_dynamic_import_keys,"outlines":outlines,"partitionObservation":partition_observation,"subjects":subjects,"complete":true,"global_admission_inferred":false,"capture_probes":fs.log.borrow().clone(),"ambient_cwd":std::env::current_dir().map_err(|e|e.to_string())?,"ambient_native_case_sensitive":native_case_sensitive,"status":"development_observation_not_qualification"}),
    )
}
fn additional_observation(args: &[String]) -> Result<Option<serde_json::Value>, String> {
    let Some(mode) = args.get(1).map(String::as_str).filter(|mode| {
        matches!(
            *mode,
            "--observe-primitives"
                | "--discover-repository"
                | "--observe-path-eligibility"
                | "--extract-worker"
                | "--extract-parallel"
                | "--consume-worker"
                | "--observe-system"
                | "--observe-configured-resolution"
                | "--observe-controlled-assembly"
                | "--analyze-retained-discovery"
                | "--analyze-retained-runtime"
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
            | "--analyze-retained-runtime"
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
                    | "--analyze-retained-runtime"
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
            "--analyze-retained-runtime" => retained_discovery_observations::observe(
                descriptor.clone(),
                sdk.as_ref().ok_or("retained runtime SDK input missing")?,
            )?,
            "--observe-controlled-assembly" => assembly_observations::run(
                descriptor.clone(),
                sdk.as_ref()
                    .ok_or("controlled assembly SDK input missing")?,
            ),
            "--discover-repository" => repository_discovery::run(descriptor.clone()),
            "--observe-path-eligibility" => qualified_path_eligibility::run(descriptor.clone()),
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
    let mut exit_code = 0;
    let result = (|| {
        let args = std::env::args().collect::<Vec<_>>();
        if args.get(1).is_some_and(|mode| mode == "verify") {
            let verified = qualified_verification::command(&args)?;
            exit_code = verified.exit_code();
            return Ok(verified.report);
        }
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
        sdk_compatibility::warn(sdk_compatibility::classify(&sdk, &request.sdk_directory)?);
        let observed = analyze(request.clone(), sdk.clone())?;
        if batch_mode {
            serde_json::to_value(batch::build(&request, &sdk, &observed)?)
                .map_err(|error| error.to_string())
        } else {
            Ok(observed)
        }
    })();
    match result {
        Ok(value) => {
            println!("{}", value);
            if exit_code != 0 {
                std::process::exit(exit_code);
            }
        }
        Err(error) => {
            eprintln!("{}", serde_json::json!({"error":error}));
            std::process::exit(1);
        }
    }
}

#[cfg(test)]
#[path = "../tests/unit/main_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "../tests/unit/main_pass2_javascript.rs"]
mod pass2_javascript_development;
