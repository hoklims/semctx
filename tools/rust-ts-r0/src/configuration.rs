use super::*;

fn localized_diagnostic(diagnostic: &core::Diagnostic) -> String {
    std::iter::once(
        diagnostic
            .localize(&ts_goport::locale::DEFAULT)
            .replace('\n', " "),
    )
    .chain(diagnostic.message_chain().iter().map(localized_diagnostic))
    .collect::<Vec<_>>()
    .join(" ")
}

fn invalid_configuration_reason(diagnostic: &core::Diagnostic) -> String {
    format!(
        "SOURCE_CONFIGURATION_INVALID:{}:{}",
        diagnostic.code(),
        localized_diagnostic(diagnostic)
    )
}

fn compiler_option_diagnostics(
    parsed: &tsoptions::ParsedCommandLine,
    repository: &str,
    sensitive: bool,
) -> Vec<core::Diagnostic> {
    let mut options = compiler_options();
    let raw = match &parsed.raw {
        tsoptions::CompilerOptionsValue::Map(raw) => Some(raw),
        _ => None,
    };
    tsoptions::merge_compiler_options(&mut options, Some(parsed.compiler_options()), raw);
    let mut config = tsoptions::new_parsed_command_line(
        Rc::new(options),
        vec![],
        None,
        ComparePathsOptions {
            use_case_sensitive_file_names: sensitive,
            current_directory: repository.into(),
        },
    );
    config.config_file = parsed.config_file.clone();
    let validation_fs = Rc::new(CaptureFs::new(BTreeMap::new(), sensitive));
    let host = compiler::new_compiler_host(repository, validation_fs, repository, None, None, None);
    compiler::new_program(compiler::ProgramOptions {
        host,
        config: Rc::new(config),
        use_source_of_project_reference: false,
        single_threaded: Tristate::True,
        typings_location: String::new(),
        project_name: String::new(),
        create_module_resolver: None,
        skip_module_resolution: true,
    })
    .program_diagnostics
}

pub struct Configuration {
    pub options: Rc<CompilerOptions>,
    pub raw: Option<tsoptions::CompilerOptionsValue>,
    pub raw_chain: Vec<(String, tsoptions::CompilerOptionsValue)>,
    pub reasons: Vec<String>,
    pub consumed: BTreeSet<String>,
}

pub fn merge_configured_options(
    base: &CompilerOptions,
    configuration: &crate::configuration::Configuration,
) -> (CompilerOptions, Vec<String>) {
    let mut merged = base.clone();
    let raw = match &configuration.raw {
        Some(tsoptions::CompilerOptionsValue::Map(raw)) => Some(raw),
        _ => None,
    };
    tsoptions::merge_compiler_options(&mut merged, Some(&configuration.options), raw);
    let mut reasons = BTreeSet::new();
    let mut final_module_none = false;
    for (path, raw) in &configuration.raw_chain {
        let tsoptions::CompilerOptionsValue::Map(raw) = raw else {
            continue;
        };
        let Some(tsoptions::CompilerOptionsValue::Map(values)) = raw.get("compilerOptions") else {
            continue;
        };
        let mut values = values.clone();
        values.retain(|key, _| {
            matches!(
                key.as_str(),
                "target"
                    | "module"
                    | "moduleResolution"
                    | "allowJs"
                    | "jsx"
                    | "skipLibCheck"
                    | "noEmit"
                    | "strict"
            )
        });
        let module_none = matches!(values.get("module"), Some(tsoptions::CompilerOptionsValue::String(value)) if value.eq_ignore_ascii_case("none"));
        if values.contains_key("module") {
            final_module_none = module_none;
        }
        if module_none {
            values.shift_remove("module");
        }
        let mut wrapper = raw.clone();
        wrapper.clear();
        wrapper.insert(
            "compilerOptions".into(),
            tsoptions::CompilerOptionsValue::Map(values.clone()),
        );
        tsoptions::merge_compiler_options(
            &mut merged,
            Some(&CompilerOptions::default()),
            Some(&wrapper),
        );
        let (_, errors) = tsoptions::convert_options_from_json(
            &tsoptions::COMMAND_LINE_COMPILER_OPTIONS_MAP,
            &tsoptions::CompilerOptionsValue::Map(values),
            &ts_goport::frontend::tspath::get_directory_path(path),
            tsoptions::CompilerOptionsParser {
                compiler_options: &mut merged,
            },
        );
        for error in errors {
            reasons.insert(invalid_configuration_reason(&error));
        }
        if module_none {
            for error in tsoptions::parse_compiler_options(
                "module",
                tsoptions::CompilerOptionsValue::ModuleKind(ModuleKind::NONE),
                &mut merged,
            ) {
                reasons.insert(invalid_configuration_reason(&error));
            }
        }
    }
    if final_module_none {
        reasons.insert("SOURCE_CONFIGURATION_MODULE_UNSUPPORTED:None".into());
    }
    (merged, reasons.into_iter().collect())
}

struct Host {
    fs: Rc<CaptureFs>,
    cwd: String,
}

struct ConfigurationFs {
    fs: Rc<CaptureFs>,
    root: String,
}
impl Fs for ConfigurationFs {
    fn use_case_sensitive_file_names(&self) -> bool {
        self.fs.sensitive
    }
    fn file_exists(&self, path: &str) -> bool {
        self.fs.file_exists(path)
    }
    fn read_file(&self, path: &str) -> (String, bool) {
        if !contained(&self.fs, &self.root, path) {
            self.fs.record("read_file", path, false);
            return (String::new(), false);
        }
        self.fs.read_file(path)
    }
    fn directory_exists(&self, path: &str) -> bool {
        self.fs.directory_exists(path)
    }
    fn get_accessible_entries(&self, path: &str) -> Entries {
        self.fs.get_accessible_entries(path)
    }
    fn stat(&self, path: &str) -> Option<FileInfo> {
        self.fs.stat(path)
    }
    fn realpath(&self, path: &str) -> String {
        self.fs.realpath(path)
    }
    fn write_file(&self, path: &str, text: &str) -> Result<(), FsError> {
        self.fs.write_file(path, text)
    }
    fn append_file(&self, path: &str, text: &str) -> Result<(), FsError> {
        self.fs.append_file(path, text)
    }
    fn remove(&self, path: &str) -> Result<(), FsError> {
        self.fs.remove(path)
    }
    fn chtimes(
        &self,
        path: &str,
        access: Option<SystemTime>,
        modified: Option<SystemTime>,
    ) -> Result<(), FsError> {
        self.fs.chtimes(path, access, modified)
    }
}

#[derive(Default)]
struct ConfigurationLineage(RefCell<Vec<(String, tsoptions::CompilerOptionsValue)>>);

impl tsoptions::ExtendedConfigCache for ConfigurationLineage {
    fn get_extended_config(
        &self,
        file_name: &str,
        path: &ts_goport::frontend::tspath::Path,
        resolution_stack: &[ts_goport::frontend::tspath::Path],
        host: &dyn tsoptions::ParseConfigHost,
    ) -> Rc<tsoptions::ExtendedConfigCacheEntry> {
        let parsed = tsoptions::parse_extended_config(
            file_name,
            path.clone(),
            resolution_stack,
            host,
            Some(self),
        );
        if let Some(config) = &parsed.extended_config {
            self.0
                .borrow_mut()
                .push((file_name.into(), config.raw.clone()));
        }
        Rc::new(parsed)
    }
}

impl tsoptions::ParseConfigHost for Host {
    fn fs(&self) -> Rc<dyn Fs> {
        Rc::new(ConfigurationFs {
            fs: self.fs.clone(),
            root: self.cwd.clone(),
        })
    }

    fn get_current_directory(&self) -> String {
        self.cwd.clone()
    }
}

fn contained(fs: &CaptureFs, repository: &str, path: &str) -> bool {
    let root = fs.key(repository);
    let candidate = fs.key(path);
    candidate == root || candidate.starts_with(&format!("{root}/"))
}

fn negative_ancestor_package_directory(fs: &CaptureFs, repository: &str, probe: &Probe) -> bool {
    if fs.workspace.is_none() || probe.operation != "directory_exists" || probe.found {
        return false;
    }
    let key = fs.key(&probe.path);
    key.strip_suffix("/node_modules")
        .is_some_and(|ancestor| fs.key(repository).starts_with(&format!("{ancestor}/")))
}

pub fn inspect(fs: Rc<CaptureFs>, path: &str, repository: &str) -> Result<Configuration, String> {
    if !contained(&fs, repository, path) {
        return Err("source outside repository".into());
    }
    let first_probe = fs.log.borrow().len();
    let mut dir = ts_goport::frontend::tspath::get_directory_path(path);
    let config = loop {
        let candidate = format!("{dir}/tsconfig.json");
        let found = fs.files.contains_key(&fs.key(&candidate));
        fs.record("configuration_discovery_file_exists", &candidate, found);
        if found {
            break Some(candidate);
        }
        let parent = ts_goport::frontend::tspath::get_directory_path(&dir);
        if parent == dir {
            break None;
        }
        dir = parent;
    };
    let Some(config) = config else {
        return Ok(Configuration {
            options: Rc::new(CompilerOptions::default()),
            raw: None,
            raw_chain: vec![],
            reasons: vec![],
            consumed: BTreeSet::new(),
        });
    };
    if !contained(&fs, repository, &config) {
        return Ok(Configuration {
            options: Rc::new(CompilerOptions::default()),
            raw: None,
            raw_chain: vec![],
            reasons: vec!["SOURCE_CONFIGURATION_OUTSIDE_REPOSITORY".into()],
            consumed: BTreeSet::new(),
        });
    }
    let (text, found) = fs.read_file(&config);
    if !found {
        return Err("configuration disappeared from capture".into());
    }
    let _empty = core::enter_program(None);
    let source_file = tsoptions::new_tsconfig_source_file_from_file_path(
        &config,
        ts_goport::frontend::tspath::Path(config.clone()),
        &text,
    );
    let (_, mut diagnostics) =
        tsoptions::convert_config_file_to_object(source_file.source_file, None);
    diagnostics.extend(
        ts_goport::frontend::parser::parsed_source_file_diagnostics(source_file.source_file)
            .iter()
            .cloned(),
    );
    let lineage = ConfigurationLineage::default();
    let parsed = if diagnostics.is_empty() {
        Some(tsoptions::parse_json_source_file_config_file_content(
            source_file,
            &Host {
                fs: fs.clone(),
                cwd: repository.into(),
            },
            &ts_goport::frontend::tspath::get_directory_path(&config),
            None,
            None,
            &config,
            &[],
            Some(&lineage),
        ))
    } else {
        None
    };
    if let Some(parsed) = &parsed {
        diagnostics.extend(parsed.get_config_file_parsing_diagnostics());
        diagnostics.extend(compiler_option_diagnostics(
            parsed,
            repository,
            fs.sensitive,
        ));
    }
    let raw = parsed.as_ref().map(|parsed| parsed.raw.clone());
    let mut raw_chain = lineage.0.into_inner();
    if let Some(raw) = &raw {
        raw_chain.push((config.clone(), raw.clone()));
    }
    let mut reasons = BTreeSet::new();
    for diagnostic in diagnostics {
        if diagnostic.code() != 18003 {
            reasons.insert(invalid_configuration_reason(&diagnostic));
        }
    }
    let options = parsed
        .map(|parsed| parsed.compiler_options().clone())
        .unwrap_or_else(|| Rc::new(CompilerOptions::default()));
    let provisional = Configuration {
        options,
        raw: raw.clone(),
        raw_chain: raw_chain.clone(),
        reasons: vec![],
        consumed: BTreeSet::new(),
    };
    let (normalized, additional) =
        merge_configured_options(&CompilerOptions::default(), &provisional);
    reasons.extend(additional);
    let options = Rc::new(normalized);
    let module = options.module;
    if module != ModuleKind::NONE && module != ModuleKind::ES_NEXT {
        let name = match module {
            ModuleKind::COMMON_JS => "CommonJS",
            ModuleKind::AMD => "AMD",
            ModuleKind::UMD => "UMD",
            ModuleKind::SYSTEM => "System",
            ModuleKind::ES2015 => "ES2015",
            ModuleKind::ES2020 => "ES2020",
            ModuleKind::ES2022 => "ES2022",
            ModuleKind::NODE16 => "Node16",
            ModuleKind::NODE18 => "Node18",
            ModuleKind::NODE20 => "Node20",
            ModuleKind::NODE_NEXT => "NodeNext",
            ModuleKind::PRESERVE => "Preserve",
            _ => return Err(format!("unknown native module option: {module:?}")),
        };
        reasons.insert(format!("SOURCE_CONFIGURATION_MODULE_UNSUPPORTED:{name}"));
    }
    let resolution = options.module_resolution;
    if resolution != ModuleResolutionKind::UNKNOWN && resolution != ModuleResolutionKind::BUNDLER {
        let name = match resolution {
            ModuleResolutionKind::CLASSIC => "Classic",
            ModuleResolutionKind::NODE10 => "Node10",
            ModuleResolutionKind::NODE16 => "Node16",
            ModuleResolutionKind::NODE_NEXT => "NodeNext",
            _ => return Err(format!("unknown native resolution option: {resolution:?}")),
        };
        reasons.insert(format!(
            "SOURCE_CONFIGURATION_RESOLUTION_UNSUPPORTED:{name}"
        ));
    }
    let probes = fs.log.borrow();
    let new_probes = &probes[first_probe..];
    if new_probes.iter().any(|probe| {
        !probe.path.is_empty()
            && !contained(&fs, repository, &probe.path)
            && !negative_ancestor_package_directory(&fs, repository, probe)
    }) {
        reasons.clear();
        reasons.insert("SOURCE_CONFIGURATION_OUTSIDE_REPOSITORY".into());
    }
    let consumed = new_probes
        .iter()
        .filter(|probe| probe.operation == "read_file" && probe.found)
        .map(|probe| probe.path.clone())
        .collect();
    Ok(Configuration {
        options,
        raw,
        raw_chain,
        reasons: reasons.into_iter().collect(),
        consumed,
    })
}

pub fn unconsumed_named(
    fs: Rc<CaptureFs>,
    repository: &str,
    paths: &[String],
) -> Result<Vec<String>, String> {
    let named: Vec<_> = paths
        .iter()
        .filter(|path| {
            let normalized = path.replace('\\', "/");
            let name = normalized.rsplit('/').next().unwrap_or_default();
            name.starts_with("tsconfig")
                && name.ends_with(".json")
                && name.len() > "tsconfig.json".len()
        })
        .collect();
    if named.is_empty() {
        return Ok(vec![]);
    }
    let mut consumed = BTreeSet::new();
    for path in paths.iter().filter(|path| {
        matches!(
            path.rsplit('.').next(),
            Some(
                "ts" | "tsx"
                    | "js"
                    | "jsx"
                    | "mts"
                    | "mtsx"
                    | "cts"
                    | "ctsx"
                    | "mjs"
                    | "mjsx"
                    | "cjs"
                    | "cjsx"
            )
        )
    }) {
        consumed.extend(
            inspect(fs.clone(), path, repository)?
                .consumed
                .into_iter()
                .map(|path| fs.key(&path)),
        );
    }
    Ok(
        if named.iter().any(|path| !consumed.contains(&fs.key(path))) {
            vec!["SOURCE_NAMED_CONFIGURATION_UNSUPPORTED".into()]
        } else {
            vec![]
        },
    )
}

#[cfg(test)]
#[path = "../tests/unit/configuration.rs"]
mod tests;
