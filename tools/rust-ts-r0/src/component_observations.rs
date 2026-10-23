use super::*;

#[derive(Serialize)]
pub struct Observation {
    pub executed: bool,
    pub reasons: Vec<String>,
    pub unsupported: BTreeSet<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModuleConfigurationObservations {
    pub retained_without_source: Observation,
    pub retained_with_source: Observation,
    pub ordinary_without_snapshot: Observation,
    pub ordinary_with_source: Observation,
}

pub struct ModuleConfigurationInputs<'a> {
    pub source: core::Node,
    pub path: &'a str,
    pub retained: bool,
    pub named_reasons: &'a [String],
    pub configuration: &'a configuration::Configuration,
    pub ordinary_configuration: &'a configuration::Configuration,
    pub ordinary_unsupported: &'a BTreeSet<String>,
    pub semantic: &'a qualified::QualifiedScan,
    pub javascript: &'a javascript::JavascriptScan,
    pub runtime: &'a runtime_configuration::RuntimeConfiguration,
}

fn observed(reasons: Vec<String>, unsupported: BTreeSet<String>) -> Observation {
    Observation {
        executed: true,
        reasons,
        unsupported,
    }
}

fn not_executed() -> Observation {
    Observation {
        executed: false,
        reasons: vec![],
        unsupported: BTreeSet::from(["COMPONENT_RETAINED_INPUTS_NOT_ENABLED".into()]),
    }
}

pub fn retained_scope_syntax(source: core::Node, path: &str, retained: bool) -> Observation {
    if !retained {
        return not_executed();
    }
    let failure = if source.is_nil() || source.kind() != SyntaxKind::SourceFile {
        Some("RETAINED_SCOPE_SYNTAX_SOURCE_UNAVAILABLE")
    } else if !ast::source_file_diagnostics(source).is_empty() {
        Some("RETAINED_SCOPE_SYNTAX_PARSE_FAILED")
    } else {
        None
    };
    if let Some(reason) = failure {
        return Observation {
            executed: false,
            reasons: vec![],
            unsupported: BTreeSet::from([reason.into()]),
        };
    }
    fn visit(node: core::Node, path: &str, reasons: &mut BTreeSet<String>) {
        let reason = match node.kind() {
            SyntaxKind::CallExpression
                if node.expression().kind() == SyntaxKind::ImportKeyword
                    && (node.arguments().len() != 1
                        || node.arguments().get(0).kind() != SyntaxKind::StringLiteral) =>
            {
                Some("DEPENDENCY_SCOPE_COMPUTED_IMPORT")
            }
            SyntaxKind::ImportType => Some("DEPENDENCY_SCOPE_IMPORT_TYPE_UNSUPPORTED"),
            SyntaxKind::ImportEqualsDeclaration
                if node.module_reference().kind() == SyntaxKind::ExternalModuleReference =>
            {
                Some("DEPENDENCY_SCOPE_COMMONJS_UNSUPPORTED")
            }
            SyntaxKind::ExportAssignment if node.is_export_equals() => {
                Some("DEPENDENCY_SCOPE_COMMONJS_UNSUPPORTED")
            }
            _ => None,
        };
        if let Some(reason) = reason {
            reasons.insert(format!("{reason}:{path}"));
        }
        node.for_each_child(|child| {
            visit(child, path, reasons);
            false
        });
    }
    let mut reasons = BTreeSet::new();
    visit(source, path, &mut reasons);
    observed(reasons.into_iter().collect(), BTreeSet::new())
}

pub struct RetainedImportScope {
    pub unresolved_import_reasons: BTreeMap<String, BTreeSet<Vec<u16>>>,
    pub external_module_specifiers: Vec<String>,
}

pub fn unresolved_import_reasons(
    imports: &[ordinary::Import],
    files: &BTreeMap<String, String>,
    root: &str,
    sensitive: bool,
) -> Result<BTreeMap<String, BTreeSet<Vec<u16>>>, String> {
    Ok(retained_import_scope(imports, files, root, sensitive)?.unresolved_import_reasons)
}

pub fn retained_import_scope(
    imports: &[ordinary::Import],
    files: &BTreeMap<String, String>,
    root: &str,
    sensitive: bool,
) -> Result<RetainedImportScope, String> {
    let mut workspace_names = BTreeSet::new();
    let mut external_packages = BTreeMap::new();
    let mut aliases = vec![];
    let builtin_inventory: serde_json::Value =
        serde_json::from_str(include_str!("../builtin-modules.json"))
            .map_err(|error| error.to_string())?;
    let builtins = builtin_inventory["modules"]
        .as_array()
        .ok_or("invalid qualified builtin inventory")?
        .iter()
        .map(|value| value.as_str().ok_or("invalid qualified builtin name"))
        .collect::<Result<BTreeSet<_>, _>>()?;
    let _empty = core::enter_program(None);
    let mut ordered = files.iter().collect::<Vec<_>>();
    ordered.sort_by(|(left, _), (right, _)| left.encode_utf16().cmp(right.encode_utf16()));
    for (path, text) in ordered {
        let Ok(relative) = relative_source_path(root, path, sensitive) else {
            continue;
        };
        let name = relative.rsplit('/').next().unwrap_or(&relative);
        if name != "package.json" && !(name.starts_with("tsconfig") && name.ends_with(".json")) {
            continue;
        }
        let Some(manifest) = retained_manifest::inspect(path, text) else {
            continue;
        };
        if name.ends_with("package.json") {
            if let Some(name) = manifest.name {
                workspace_names.insert(name);
            }
            external_packages.insert(
                ts_goport::frontend::tspath::get_directory_path(&relative),
                manifest.external_packages,
            );
        }
        aliases.extend(manifest.aliases);
    }
    let mut reasons: BTreeMap<String, BTreeSet<Vec<u16>>> = BTreeMap::new();
    let mut external_module_specifiers = BTreeSet::new();
    for import in imports {
        let specifier = &import.module_specifier;
        if builtins.contains(specifier.as_str()) {
            external_module_specifiers.insert(specifier.clone());
            continue;
        }
        let local_path = specifier.starts_with('.') || specifier.starts_with('/');
        let alias = !local_path
            && aliases
                .iter()
                .any(|alias| retained_aliases::matches_port_strings(alias, specifier));
        let package = specifier
            .split('/')
            .take(if specifier.starts_with('@') { 2 } else { 1 })
            .collect::<Vec<_>>()
            .join("/");
        let mut external = false;
        if !local_path && !alias && !workspace_names.contains(&package) {
            let mut directory =
                ts_goport::frontend::tspath::get_directory_path(&import.from_rel_path);
            loop {
                if external_packages
                    .get(&directory)
                    .is_some_and(|packages| packages.contains(&package))
                {
                    external = true;
                    break;
                }
                let parent = ts_goport::frontend::tspath::get_directory_path(&directory);
                if parent == directory {
                    break;
                }
                directory = parent;
            }
        }
        if external {
            external_module_specifiers.insert(specifier.clone());
        } else if import.resolved_rel_path.is_none() {
            let mut reason = format!(
                "DEPENDENCY_SCOPE_UNRESOLVED_IMPORT:{}:",
                import.from_rel_path
            )
            .encode_utf16()
            .collect::<Vec<_>>();
            reason.extend(source_text::to_units(specifier));
            reasons
                .entry(import.from_rel_path.clone())
                .or_default()
                .insert(reason);
        }
    }
    let mut external_module_specifiers = external_module_specifiers.into_iter().collect::<Vec<_>>();
    external_module_specifiers.sort_by_key(|specifier| source_text::to_units(specifier));
    Ok(RetainedImportScope {
        unresolved_import_reasons: reasons,
        external_module_specifiers,
    })
}

pub fn ordinary_module_configuration(
    configuration: &configuration::Configuration,
    unsupported: BTreeSet<String>,
) -> Observation {
    let ordinary = if configuration
        .reasons
        .iter()
        .any(|reason| reason == "SOURCE_CONFIGURATION_OUTSIDE_REPOSITORY")
    {
        vec!["SOURCE_CONFIGURATION_OUTSIDE_REPOSITORY".into()]
    } else {
        configuration
            .reasons
            .iter()
            .filter(|reason| reason.starts_with("SOURCE_CONFIGURATION_INVALID:"))
            .cloned()
            .collect()
    };
    observed(ordinary, unsupported)
}

fn source_default_reasons(source: core::Node) -> Vec<String> {
    if source.is_nil() {
        return vec![];
    }
    let mut reasons = vec![];
    if javascript::has_unsupported_default_expression(source) {
        reasons.push("SOURCE_DEFAULT_EXPRESSION_UNSUPPORTED".into());
    }
    if javascript::has_semantic_jsdoc_import(source) {
        reasons.push("SOURCE_JSDOC_IMPORT_UNSUPPORTED".into());
    }
    reasons
}

pub fn module_configuration(
    inputs: ModuleConfigurationInputs<'_>,
) -> ModuleConfigurationObservations {
    let configuration = inputs.configuration;
    let outside = configuration
        .reasons
        .iter()
        .any(|reason| reason == "SOURCE_CONFIGURATION_OUTSIDE_REPOSITORY");
    let ordinary_without_snapshot = ordinary_module_configuration(
        inputs.ordinary_configuration,
        inputs.ordinary_unsupported.clone(),
    );
    let source_available = inputs.source.is_some();
    let ordinary_source_reasons = if ordinary_without_snapshot
        .reasons
        .iter()
        .any(|reason| reason == "SOURCE_CONFIGURATION_OUTSIDE_REPOSITORY")
    {
        ordinary_without_snapshot.reasons.clone()
    } else {
        source_default_reasons(inputs.source)
            .into_iter()
            .chain(ordinary_without_snapshot.reasons.iter().cloned())
            .collect()
    };
    let ordinary_with_source =
        observed(ordinary_source_reasons, inputs.ordinary_unsupported.clone());
    if !inputs.retained {
        return ModuleConfigurationObservations {
            retained_without_source: not_executed(),
            retained_with_source: not_executed(),
            ordinary_without_snapshot,
            ordinary_with_source,
        };
    }
    if outside {
        return ModuleConfigurationObservations {
            retained_without_source: observed(
                vec!["SOURCE_CONFIGURATION_OUTSIDE_REPOSITORY".into()],
                BTreeSet::new(),
            ),
            retained_with_source: observed(
                vec!["SOURCE_CONFIGURATION_OUTSIDE_REPOSITORY".into()],
                BTreeSet::new(),
            ),
            ordinary_without_snapshot,
            ordinary_with_source,
        };
    }
    let mut reasons = if source_available {
        inputs.named_reasons.to_vec()
    } else {
        vec![]
    };
    reasons.extend(source_default_reasons(inputs.source));
    if source_available {
        reasons.extend(javascript::inspect_unmodeled_invocations(inputs.source));
        if inputs.javascript.native.common_js_unsupported {
            reasons.push("SOURCE_COMMONJS_UNSUPPORTED".into());
        }
        reasons.extend(inputs.semantic.reasons.iter().cloned());
    }
    reasons.extend(
        configuration
            .reasons
            .iter()
            .filter(|reason| reason.starts_with("SOURCE_CONFIGURATION_INVALID:"))
            .cloned(),
    );
    let has_configuration = !configuration.consumed.is_empty();
    let configuration_parsed = configuration.raw.is_some();
    let mut unsupported = if source_available {
        inputs.semantic.unsupported.clone()
    } else {
        BTreeSet::new()
    };
    if source_available && (!has_configuration || configuration_parsed) {
        reasons.extend(inputs.runtime.reasons.iter().cloned());
        unsupported.extend(inputs.runtime.unsupported.iter().cloned());
    }
    if configuration_parsed {
        for prefix in [
            "SOURCE_CONFIGURATION_MODULE_UNSUPPORTED:",
            "SOURCE_CONFIGURATION_RESOLUTION_UNSUPPORTED:",
        ] {
            reasons.extend(
                configuration
                    .reasons
                    .iter()
                    .filter(|reason| reason.starts_with(prefix))
                    .cloned(),
            );
        }
    }
    let retained_without_source = observed(reasons.clone(), unsupported.clone());
    if source_available {
        reasons.extend(javascript::inspect_qualified_module_scope(
            inputs.source,
            inputs.path,
        ));
    }
    ModuleConfigurationObservations {
        retained_without_source,
        retained_with_source: observed(reasons, unsupported),
        ordinary_without_snapshot,
        ordinary_with_source,
    }
}

pub fn semantic(scan: &qualified::QualifiedScan) -> Observation {
    observed(
        scan.reasons.iter().cloned().collect(),
        scan.unsupported.clone(),
    )
}

pub fn opaque_callback_ownership(
    before: &serde_json::Value,
    after: &serde_json::Value,
    removed: &serde_json::Value,
    graph: &serde_json::Value,
    removed_graph: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    let phase = |subject: &serde_json::Value| {
        subject
            .pointer("/moduleConfigurationObservations/retainedWithoutSource")
            .filter(|value| value.is_object())
            .cloned()
            .ok_or_else(|| "missing native module-configuration phase".to_string())
    };
    Ok(serde_json::json!({
        "executed":true,
        "unsupported":[],
        "beforeAnalysis":phase(before)?,
        "afterAnalysis":phase(after)?,
        "afterGraphEdgesRemoved":phase(removed)?,
        "graphBeforeEdgeRemovalId":identity::digest(graph),
        "graphAfterEdgeRemovalId":identity::digest(removed_graph),
        "observationScope":"native_module_configuration_graph_ownership",
        "globalAdmissionInferred":false
    }))
}

pub fn source_parsing(diagnostics: &[serde_json::Value]) -> serde_json::Value {
    let reasons = diagnostics
        .iter()
        .map(|diagnostic| {
            format!(
                "SOURCE_PARSE_ERROR:{}:{}",
                diagnostic["code"],
                diagnostic["message"]
                    .as_str()
                    .unwrap_or_default()
                    .replace('\n', " ")
            )
        })
        .collect::<Vec<_>>();
    let codes = diagnostics
        .iter()
        .map(|diagnostic| diagnostic["code"].clone())
        .collect::<Vec<_>>();
    serde_json::json!({
        "executed": true, "reasons": reasons, "unsupported": [],
        "diagnosticCodes": codes, "diagnostics": diagnostics,
    })
}

pub fn retained_callable_initializers(
    source: core::Node,
    checker: &mut ts_goport::checker::Checker,
    context: &ordinary::ExtractionContext<'_>,
) -> serde_json::Value {
    let mut nodes = vec![];
    all_nodes(source, &mut nodes);
    let variables = nodes
        .into_iter()
        .filter(|node| {
            node.kind() == SyntaxKind::VariableDeclaration
                && node.name().kind() == SyntaxKind::Identifier
        })
        .map(|node| {
            let coordinate = if node.initializer().is_nil() {
                serde_json::json!({"state":"no_initializer"})
            } else if let Some((path, symbol)) =
                ordinary::retained_callable_coordinate(node.initializer(), checker, context)
            {
                serde_json::json!({"relPath":path,"symbolPath":symbol})
            } else {
                serde_json::json!({"state":"undefined"})
            };
            serde_json::json!({"name":node.name().text(),"coordinate":coordinate})
        })
        .collect::<Vec<_>>();
    serde_json::json!({"executed":true,"unsupported":[],"variables":variables})
}
