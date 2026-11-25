use super::*;

pub struct Configuration {
    pub options: Rc<CompilerOptions>,
    pub raw: Option<tsoptions::CompilerOptionsValue>,
    pub raw_chain: Vec<(String, tsoptions::CompilerOptionsValue)>,
    pub reasons: Vec<String>,
    pub consumed: BTreeSet<String>,
}

const SDK59_INVALID_TARGET: &str = "SOURCE_CONFIGURATION_INVALID:6046:Argument for '--target' option must be: 'es5', 'es6', 'es2015', 'es2016', 'es2017', 'es2018', 'es2019', 'es2020', 'es2021', 'es2022', 'es2023', 'es2024', 'esnext'.";
const SDK59_TARGET_TYPE: &str =
    "SOURCE_CONFIGURATION_INVALID:5024:Compiler option 'target' requires a value of type string.";

fn sdk59_configuration_reason(diagnostic: &core::Diagnostic) -> String {
    // Keep the engine's diagnostic identity and emission order, restoring only
    // the two module messages that differ from the captured SDK 5.9 contract.
    match (diagnostic.code(), diagnostic.message_args().first().map(String::as_str)) {
        (6046, Some("--module")) => "SOURCE_CONFIGURATION_INVALID:6046:Argument for '--module' option must be: 'none', 'commonjs', 'amd', 'system', 'umd', 'es6', 'es2015', 'es2020', 'es2022', 'esnext', 'node16', 'node18', 'node20', 'nodenext', 'preserve'.".into(),
        (5024, Some("module")) => "SOURCE_CONFIGURATION_INVALID:5024:Compiler option 'module' requires a value of type string.".into(),
        _ => format!(
            "SOURCE_CONFIGURATION_INVALID:{}:{}",
            diagnostic.code(),
            diagnostic.localize(&ts_goport::locale::DEFAULT).replace('\n', " ")
        ),
    }
}

fn sdk59_target(value: &tsoptions::CompilerOptionsValue) -> Result<ScriptTarget, &'static str> {
    use tsoptions::CompilerOptionsValue;
    let target = match value {
        CompilerOptionsValue::Nil => ScriptTarget::NONE,
        CompilerOptionsValue::String(value) => match value.to_lowercase().as_str() {
            // TypeScript 5.9 still accepts deprecated ES3 in config JSON (value 0),
            // but omits it from the invalid-option diagnostic's suggested values.
            "es3" => ScriptTarget::NONE,
            "es5" => ScriptTarget::ES5,
            "es6" | "es2015" => ScriptTarget::ES2015,
            "es2016" => ScriptTarget::ES2016,
            "es2017" => ScriptTarget::ES2017,
            "es2018" => ScriptTarget::ES2018,
            "es2019" => ScriptTarget::ES2019,
            "es2020" => ScriptTarget::ES2020,
            "es2021" => ScriptTarget::ES2021,
            "es2022" => ScriptTarget::ES2022,
            "es2023" => ScriptTarget::ES2023,
            "es2024" => ScriptTarget::ES2024,
            "esnext" => ScriptTarget::ES_NEXT,
            _ => return Err(SDK59_INVALID_TARGET),
        },
        _ => return Err(SDK59_TARGET_TYPE),
    };
    Ok(target)
}

fn raw_target(raw: &tsoptions::CompilerOptionsValue) -> Option<&tsoptions::CompilerOptionsValue> {
    let tsoptions::CompilerOptionsValue::Map(raw) = raw else {
        return None;
    };
    let Some(tsoptions::CompilerOptionsValue::Map(options)) = raw.get("compilerOptions") else {
        return None;
    };
    options.get("target")
}

fn inherited_target_reasons(source: core::Node) -> Option<Vec<(i32, String)>> {
    if source.is_nil() || source.statements().is_empty() {
        return None;
    }
    let root = source.statements().get(0).expression();
    if root.kind() != SyntaxKind::ObjectLiteralExpression {
        return None;
    }
    let mut observed = false;
    let mut reasons = vec![];
    for property in root.properties().iter() {
        if property.kind() != SyntaxKind::PropertyAssignment {
            continue;
        }
        let (name, present) = ast::try_get_text_of_property_name(property.name());
        let options = property.initializer();
        if !present
            || name != "compilerOptions"
            || options.kind() != SyntaxKind::ObjectLiteralExpression
        {
            continue;
        }
        // Extended configurations are parsed as JSON source files: every option
        // occurrence is validated, even when a later duplicate supplies the value.
        for property in options.properties().iter() {
            if property.kind() != SyntaxKind::PropertyAssignment {
                continue;
            }
            let (name, present) = ast::try_get_text_of_property_name(property.name());
            if !present || name != "target" {
                continue;
            }
            observed = true;
            let value = property.initializer();
            let reason = match value.kind() {
                SyntaxKind::StringLiteral => sdk59_target(
                    &tsoptions::CompilerOptionsValue::String(value.text().to_owned()),
                )
                .err(),
                SyntaxKind::NullKeyword => None,
                _ => Some(SDK59_TARGET_TYPE),
            };
            if let Some(reason) = reason {
                reasons.push((property.loc().pos(), reason.to_owned()));
            }
        }
    }
    observed.then_some(reasons)
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
    let mut target_reasons = vec![];
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
        // Validate and merge this field against the captured SDK contract, rather
        // than accepting newer targets (or newer diagnostics) from the engine.
        if let Some(value) = values.shift_remove("target") {
            match sdk59_target(&value) {
                Ok(target) => merged.target = target,
                Err(reason) => {
                    merged.target = ScriptTarget::NONE;
                    target_reasons.push(reason.into());
                }
            }
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
            reasons.insert(sdk59_configuration_reason(&error));
        }
        if module_none {
            for error in tsoptions::parse_compiler_options(
                "module",
                tsoptions::CompilerOptionsValue::ModuleKind(ModuleKind::NONE),
                &mut merged,
            ) {
                reasons.insert(sdk59_configuration_reason(&error));
            }
        }
    }
    if final_module_none {
        reasons.insert("SOURCE_CONFIGURATION_MODULE_UNSUPPORTED:None".into());
    }
    (merged, reasons.into_iter().chain(target_reasons).collect())
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
struct ConfigurationLineage {
    raw_chain: RefCell<Vec<(String, tsoptions::CompilerOptionsValue)>>,
    target_preorder: RefCell<Vec<Option<TargetDiagnosticSource>>>,
    target_sources: RefCell<BTreeSet<String>>,
    // Canonical engine paths identify cycles; these normalized, case-preserving
    // names supply the SDK diagnostic's display spelling.
    display_stack: RefCell<Vec<String>>,
}

struct TargetDiagnosticSource {
    path: String,
    file: core::Node,
    reasons: Vec<(i32, String)>,
}

fn diagnostic_source_ordinal(
    sources: &[Option<TargetDiagnosticSource>],
    file: core::Node,
    fs: &CaptureFs,
) -> usize {
    let path = fs.key(ast::source_file_file_name(file));
    let mut fallback = 0;
    for (ordinal, source) in sources.iter().enumerate() {
        let Some(source) = source else { continue };
        if source.file == file {
            return ordinal + 1;
        }
        if fallback == 0 && fs.key(&source.path) == path {
            fallback = ordinal + 1;
        }
    }
    fallback
}

impl tsoptions::ExtendedConfigCache for ConfigurationLineage {
    fn get_extended_config(
        &self,
        file_name: &str,
        path: &ts_goport::frontend::tspath::Path,
        resolution_stack: &[ts_goport::frontend::tspath::Path],
        host: &dyn tsoptions::ParseConfigHost,
    ) -> Rc<tsoptions::ExtendedConfigCacheEntry> {
        // Reserve before recursion so diagnostics retain source visitation order
        // and repeated parents; raw_chain separately retains merge postorder.
        let ordinal = {
            let mut preorder = self.target_preorder.borrow_mut();
            let ordinal = preorder.len();
            preorder.push(None);
            ordinal
        };
        self.display_stack.borrow_mut().push(file_name.into());
        let mut parsed = tsoptions::parse_extended_config(
            file_name,
            path.clone(),
            resolution_stack,
            host,
            Some(self),
        );
        let display_stack = self.display_stack.borrow().clone();
        self.display_stack.borrow_mut().pop();
        // The engine bypasses this cache for the closing edge of a cycle.
        // Recover its omitted formatting argument at the immediate parent,
        // using the resolved extends paths rather than the raw JSON spelling.
        // Already repaired child diagnostics retain their own source/order.
        if let (Some(config), Some(source)) = (&parsed.extended_config, &parsed.extended_result) {
            let mut stack = resolution_stack.to_vec();
            stack.push(path.clone());
            let mut closing_paths =
                config
                    .extended_config_path
                    .iter()
                    .flatten()
                    .filter(|extended| {
                        stack.contains(&ts_goport::frontend::tspath::to_path(
                            extended,
                            &host.get_current_directory(),
                            host.fs().use_case_sensitive_file_names(),
                        ))
                    });
            for diagnostic in &mut parsed.errors {
                if diagnostic.code() == 18000
                    && diagnostic.message_args().is_empty()
                    && let Some(closing_path) = closing_paths.next()
                {
                    let chain = display_stack
                        .iter()
                        .map(String::as_str)
                        .chain(std::iter::once(closing_path.as_str()))
                        .collect::<Vec<_>>()
                        .join(" -> ");
                    diagnostic.message_args = vec![chain];
                    // Circularity follows the parent's option validation.
                    diagnostic.file = source.source_file;
                    diagnostic.pos = i32::MAX;
                    diagnostic.end = i32::MAX;
                }
            }
        }
        if let Some(config) = &parsed.extended_config {
            self.raw_chain
                .borrow_mut()
                .push((file_name.into(), config.raw.clone()));
            if let Some(source) = &parsed.extended_result {
                let reasons = inherited_target_reasons(source.source_file);
                if reasons.is_some() {
                    self.target_sources.borrow_mut().insert(file_name.into());
                }
                self.target_preorder.borrow_mut()[ordinal] = Some(TargetDiagnosticSource {
                    path: file_name.into(),
                    file: source.source_file,
                    reasons: reasons.unwrap_or_default(),
                });
            }
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

fn module_none_value(raw: &tsoptions::CompilerOptionsValue) -> bool {
    let tsoptions::CompilerOptionsValue::Map(raw) = raw else {
        return false;
    };
    let Some(tsoptions::CompilerOptionsValue::Map(options)) = raw.get("compilerOptions") else {
        return false;
    };
    matches!(options.get("module"),Some(tsoptions::CompilerOptionsValue::String(value)) if value.eq_ignore_ascii_case("none"))
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
        let candidate = format!("{}/tsconfig.json", dir.trim_end_matches('/'));
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
    let (json, mut diagnostics) = tsoptions::parse_config_file_text_to_json(
        &config,
        ts_goport::frontend::tspath::Path(config.clone()),
        &text,
    );
    let lineage = ConfigurationLineage {
        display_stack: RefCell::new(vec![
            ts_goport::frontend::tspath::get_normalized_absolute_path(
                "",
                &ts_goport::frontend::tspath::get_directory_path(&config),
            ),
        ]),
        ..Default::default()
    };
    let parsed = if diagnostics.is_empty() {
        Some(tsoptions::parse_json_config_file_content(
            &json,
            &Host {
                fs: fs.clone(),
                cwd: repository.into(),
            },
            &ts_goport::frontend::tspath::get_directory_path(&config),
            None,
            // Match parseJsonConfigFileContent's omitted configFileName in the
            // SDK baseline: the initial resolution-stack entry is the directory.
            "",
            &[],
            Some(&lineage),
        ))
    } else {
        None
    };
    if let Some(parsed) = &parsed {
        diagnostics.extend(parsed.get_config_file_parsing_diagnostics());
    }
    let raw = parsed.as_ref().map(|parsed| parsed.raw.clone());
    let parent_preorder = lineage.target_preorder.into_inner();
    let parent_target_sources = lineage.target_sources.into_inner();
    let root_option_order: BTreeMap<String, i32> = raw
        .as_ref()
        .and_then(|raw| match raw {
            tsoptions::CompilerOptionsValue::Map(raw) => raw.get("compilerOptions"),
            _ => None,
        })
        .and_then(|options| match options {
            tsoptions::CompilerOptionsValue::Map(options) => Some(options),
            _ => None,
        })
        .into_iter()
        .flat_map(|options| options.keys().enumerate())
        .map(|(ordinal, name)| (name.clone(), ordinal as i32))
        .collect();
    let mut target_events = vec![];
    if let Some(reason) = raw
        .as_ref()
        .and_then(raw_target)
        .and_then(|value| sdk59_target(value).err())
    {
        target_events.push(((0, root_option_order["target"]), reason.to_owned()));
    }
    for (ordinal, source) in parent_preorder.iter().enumerate() {
        if let Some(source) = source {
            target_events.extend(
                source
                    .reasons
                    .iter()
                    .map(|(pos, reason)| ((ordinal + 1, *pos), reason.clone())),
            );
        }
    }
    target_events.sort_by_key(|(slot, _)| *slot);
    let ordered_target_errors = !target_events.is_empty();
    let mut target_events = target_events.into_iter().peekable();
    let mut ordered_diagnostics = vec![];
    let mut raw_chain = lineage.raw_chain.into_inner();
    if let Some(raw) = &raw {
        raw_chain.push((config.clone(), raw.clone()));
    }
    let mut reasons = BTreeSet::new();
    for diagnostic in diagnostics {
        let slot = if diagnostic.file().is_nil() && diagnostic.code() == 6114 {
            // The JSON-object parser checks the root `excludes` misspelling
            // before converting compilerOptions, independent of property order.
            (0, i32::MIN)
        } else if diagnostic.file().is_nil() {
            let option = diagnostic
                .message_args()
                .first()
                .map(|arg| arg.strip_prefix("--").unwrap_or(arg));
            (
                0,
                option
                    .and_then(|name| root_option_order.get(name))
                    .copied()
                    .unwrap_or(i32::MAX),
            )
        } else {
            (
                diagnostic_source_ordinal(&parent_preorder, diagnostic.file(), &fs),
                diagnostic.pos(),
            )
        };
        // Keep native diagnostics in their original order. Insert SDK-only target
        // errors at their raw-option/AST slot, including targets TS7 accepts.
        while let Some((_, reason)) = target_events.next_if(|(target_slot, _)| *target_slot <= slot)
        {
            ordered_diagnostics.push(reason);
        }
        let diagnostic_path = if diagnostic.file().is_nil() {
            config.as_str()
        } else {
            ast::source_file_file_name(diagnostic.file())
        };
        let removed_module_none = diagnostic.code() == 6046
            && diagnostic
                .message_args()
                .first()
                .is_some_and(|option| option == "--module")
            && raw_chain.iter().any(|(path, raw)| {
                fs.key(path) == fs.key(diagnostic_path) && module_none_value(raw)
            });
        let replaced_target = matches!(diagnostic.code(), 6046 | 5024)
            && diagnostic.message_args().first().is_some_and(|option| {
                option
                    == if diagnostic.code() == 6046 {
                        "--target"
                    } else {
                        "target"
                    }
            })
            && (raw_chain.iter().any(|(path, raw)| {
                fs.key(path) == fs.key(diagnostic_path) && raw_target(raw).is_some()
            }) || parent_target_sources
                .iter()
                .any(|path| fs.key(path) == fs.key(diagnostic_path)));
        if diagnostic.code() != 18003 && !removed_module_none && !replaced_target {
            let reason = sdk59_configuration_reason(&diagnostic);
            if ordered_target_errors {
                ordered_diagnostics.push(reason);
            } else {
                reasons.insert(reason);
            }
        }
    }
    ordered_diagnostics.extend(target_events.map(|(_, reason)| reason));
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
    reasons.extend(
        additional
            .into_iter()
            .filter(|reason| !matches!(reason.as_str(), SDK59_INVALID_TARGET | SDK59_TARGET_TYPE))
            .filter(|reason| !ordered_diagnostics.contains(reason)),
    );
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
        ordered_diagnostics.clear();
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
        reasons: ordered_diagnostics.into_iter().chain(reasons).collect(),
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
