use super::*;

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
            reasons.insert(format!(
                "SOURCE_CONFIGURATION_INVALID:{}:{}",
                error.code(),
                error
                    .localize(&ts_goport::locale::DEFAULT)
                    .replace('\n', " ")
            ));
        }
        if module_none {
            for error in tsoptions::parse_compiler_options(
                "module",
                tsoptions::CompilerOptionsValue::ModuleKind(ModuleKind::NONE),
                &mut merged,
            ) {
                reasons.insert(format!(
                    "SOURCE_CONFIGURATION_INVALID:{}:{}",
                    error.code(),
                    error
                        .localize(&ts_goport::locale::DEFAULT)
                        .replace('\n', " ")
                ));
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
    let (json, mut diagnostics) = tsoptions::parse_config_file_text_to_json(
        &config,
        ts_goport::frontend::tspath::Path(config.clone()),
        &text,
    );
    let lineage = ConfigurationLineage::default();
    let parsed = if diagnostics.is_empty() {
        Some(tsoptions::parse_json_config_file_content(
            &json,
            &Host {
                fs: fs.clone(),
                cwd: repository.into(),
            },
            &ts_goport::frontend::tspath::get_directory_path(&config),
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
    }
    let raw = parsed.as_ref().map(|parsed| parsed.raw.clone());
    let mut raw_chain = lineage.0.into_inner();
    if let Some(raw) = &raw {
        raw_chain.push((config.clone(), raw.clone()));
    }
    let mut reasons = BTreeSet::new();
    for diagnostic in diagnostics {
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
        if diagnostic.code() != 18003 && !removed_module_none {
            reasons.insert(format!(
                "SOURCE_CONFIGURATION_INVALID:{}:{}",
                diagnostic.code(),
                diagnostic
                    .localize(&ts_goport::locale::DEFAULT)
                    .replace('\n', " ")
            ));
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
mod tests {
    use super::*;

    #[test]
    fn parses_inherited_options_from_captured_configuration_and_rejects_invalid_text() {
        let fs = Rc::new(CaptureFs::new(
            BTreeMap::from([
                (
                    "/repo/tsconfig.json".into(),
                    "{\"extends\":\"./foundation.json\",\"compilerOptions\":{\"allowJs\":true,},}"
                        .into(),
                ),
                (
                    "/repo/foundation.json".into(),
                    "{\"compilerOptions\":{\"module\":\"nodenext\"}}".into(),
                ),
            ]),
            true,
        ));
        let result = inspect(fs.clone(), "/repo/src/main.ts", "/repo").unwrap();
        assert_eq!(result.options.module, ModuleKind::NODE_NEXT);
        assert!(
            result
                .reasons
                .contains(&"SOURCE_CONFIGURATION_MODULE_UNSUPPORTED:NodeNext".into())
        );
        assert!(result.consumed.contains("/repo/foundation.json"));
        assert_eq!(
            result
                .raw_chain
                .iter()
                .map(|(path, _)| path.as_str())
                .collect::<Vec<_>>(),
            vec!["/repo/foundation.json", "/repo/tsconfig.json"]
        );
        let invalid = Rc::new(CaptureFs::new(
            BTreeMap::from([("/repo/tsconfig.json".into(), "{ invalid".into())]),
            true,
        ));
        assert!(
            inspect(invalid, "/repo/main.ts", "/repo")
                .unwrap()
                .reasons
                .iter()
                .any(|reason| reason.starts_with("SOURCE_CONFIGURATION_INVALID:"))
        );
    }

    #[test]
    fn named_configuration_must_be_consumed_by_an_actual_source_lineage() {
        for inherited in [false, true] {
            let fs = Rc::new(CaptureFs::new(
                BTreeMap::from([
                    (
                        "/repo/main.ts".into(),
                        "export const t00DevelopmentConfigWitness=157;".into(),
                    ),
                    (
                        "/repo/tsconfig.json".into(),
                        if inherited {
                            "{\"extends\":\"./tsconfig.used.json\"}"
                        } else {
                            "{}"
                        }
                        .into(),
                    ),
                    ("/repo/tsconfig.used.json".into(), "{}".into()),
                ]),
                true,
            ));
            let result = unconsumed_named(
                fs,
                "/repo",
                &[
                    "/repo/main.ts".into(),
                    "/repo/tsconfig.json".into(),
                    "/repo/tsconfig.used.json".into(),
                ],
            )
            .unwrap();
            assert_eq!(
                result,
                if inherited {
                    vec![]
                } else {
                    vec!["SOURCE_NAMED_CONFIGURATION_UNSUPPORTED"]
                }
            );
        }
    }

    #[test]
    fn nearest_parent_configuration_outside_root_is_not_silently_absent() {
        let fs = Rc::new(CaptureFs::new(
            BTreeMap::from([("/tsconfig.json".into(), "{}".into())]),
            true,
        ));
        let result = inspect(fs, "/repo/source.ts", "/repo").unwrap();
        assert_eq!(
            result.reasons,
            vec!["SOURCE_CONFIGURATION_OUTSIDE_REPOSITORY"]
        );
        assert!(result.consumed.is_empty());
    }

    #[test]
    fn missing_package_configuration_keeps_6053_despite_negative_ancestor_package_probes() {
        let fs = Rc::new(CaptureFs::with_workspace_root(
            BTreeMap::from([
                (
                    "/repo/app/package.json".into(),
                    r#"{"name":"dev-app"}"#.into(),
                ),
                (
                    "/repo/app/source.ts".into(),
                    "export const sourceDev = 73;".into(),
                ),
                (
                    "/repo/app/tsconfig.json".into(),
                    r#"{"extends":"@dev/missing/base.json"}"#.into(),
                ),
            ]),
            true,
            "/repo",
            None,
        ));
        let observed = inspect(fs.clone(), "/repo/app/source.ts", "/repo").unwrap();
        assert!(
            fs.log
                .borrow()
                .iter()
                .any(|probe| probe.operation == "directory_exists"
                    && probe.path == "/node_modules"
                    && !probe.found)
        );
        assert!(
            observed
                .reasons
                .iter()
                .any(|reason| reason.starts_with("SOURCE_CONFIGURATION_INVALID:6053")),
            "{:?}",
            observed.reasons
        );
        assert!(
            !observed
                .reasons
                .contains(&"SOURCE_CONFIGURATION_OUTSIDE_REPOSITORY".into())
        );
    }

    #[test]
    fn inherited_configuration_outside_repository_is_never_consumed() {
        let fs = Rc::new(CaptureFs::new(
            BTreeMap::from([
                (
                    "/repo/tsconfig.json".into(),
                    "{\"extends\":\"../private-options.json\"}".into(),
                ),
                (
                    "/private-options.json".into(),
                    "{\"compilerOptions\":{\"module\":\"CommonJS\"}}".into(),
                ),
            ]),
            true,
        ));
        let result = inspect(fs.clone(), "/repo/source.ts", "/repo").unwrap();
        assert_eq!(
            result.reasons,
            vec!["SOURCE_CONFIGURATION_OUTSIDE_REPOSITORY"]
        );
        assert!(!result.consumed.contains("/private-options.json"));
        assert!(
            !fs.log
                .borrow()
                .iter()
                .any(|probe| probe.operation == "read_file"
                    && probe.path == "/private-options.json"
                    && probe.found)
        );
    }

    #[test]
    fn refuses_inherited_configuration_outside_repository() {
        let fs = Rc::new(CaptureFs::new(
            BTreeMap::from([(
                "/repo/tsconfig.json".into(),
                "{\"extends\":\"../outside.json\"}".into(),
            )]),
            true,
        ));
        let result = inspect(fs, "/repo/main.ts", "/repo").unwrap();
        assert!(
            result
                .reasons
                .contains(&"SOURCE_CONFIGURATION_OUTSIDE_REPOSITORY".into())
        );
    }

    #[test]
    fn sdk59_module_none_is_explicitly_unsupported_and_not_a_native_invalid_option() {
        for (base, leaf, expected) in [
            ("{}", "{\"compilerOptions\":{\"module\":\"none\"}}", true),
            (
                "{\"compilerOptions\":{\"module\":\"ESNext\"}}",
                "{\"extends\":\"./base.json\",\"compilerOptions\":{\"module\":\"none\"}}",
                true,
            ),
            (
                "{\"compilerOptions\":{\"module\":\"none\"}}",
                "{\"extends\":\"./base.json\",\"compilerOptions\":{\"module\":\"ESNext\"}}",
                false,
            ),
            (
                "{\"compilerOptions\":{\"module\":\"none\"}}",
                "{\"extends\":\"./base.json\",\"compilerOptions\":{\"module\":null}}",
                false,
            ),
        ] {
            let fs = Rc::new(CaptureFs::new(
                BTreeMap::from([
                    ("/repo/base.json".into(), base.into()),
                    ("/repo/tsconfig.json".into(), leaf.into()),
                ]),
                true,
            ));
            let result = inspect(fs, "/repo/source.ts", "/repo").unwrap();
            assert_eq!(
                result.reasons,
                if expected {
                    vec!["SOURCE_CONFIGURATION_MODULE_UNSUPPORTED:None"]
                } else {
                    vec![]
                }
            );
            if expected {
                assert_eq!(result.options.module, ModuleKind::NONE);
            }
        }
        let fs = Rc::new(CaptureFs::new(
            BTreeMap::from([
                (
                    "/repo/base.json".into(),
                    "{\"compilerOptions\":{\"module\":\"none\"}}".into(),
                ),
                (
                    "/repo/tsconfig.json".into(),
                    "{\"extends\":\"./base.json\",\"compilerOptions\":{\"module\":\"wrong-kind\"}}"
                        .into(),
                ),
            ]),
            true,
        ));
        let result = inspect(fs, "/repo/source.ts", "/repo").unwrap();
        assert!(
            result
                .reasons
                .iter()
                .any(|reason| reason.starts_with("SOURCE_CONFIGURATION_INVALID:6046:"))
        );
    }
}
