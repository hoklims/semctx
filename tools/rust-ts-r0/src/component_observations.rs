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
}

pub struct ModuleConfigurationInputs<'a> {
    pub source: core::Node,
    pub path: &'a str,
    pub retained: bool,
    pub named_reasons: &'a [String],
    pub configuration: &'a configuration::Configuration,
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

pub fn module_configuration(
    inputs: ModuleConfigurationInputs<'_>,
) -> ModuleConfigurationObservations {
    let configuration = inputs.configuration;
    let outside = configuration
        .reasons
        .iter()
        .any(|reason| reason == "SOURCE_CONFIGURATION_OUTSIDE_REPOSITORY");
    let ordinary = if outside {
        vec!["SOURCE_CONFIGURATION_OUTSIDE_REPOSITORY".into()]
    } else {
        configuration
            .reasons
            .iter()
            .filter(|reason| reason.starts_with("SOURCE_CONFIGURATION_INVALID:"))
            .cloned()
            .collect()
    };
    let ordinary_without_snapshot = observed(ordinary, BTreeSet::new());
    if !inputs.retained {
        return ModuleConfigurationObservations {
            retained_without_source: not_executed(),
            retained_with_source: not_executed(),
            ordinary_without_snapshot,
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
        };
    }
    let mut reasons = inputs.named_reasons.to_vec();
    if javascript::has_unsupported_default_expression(inputs.source) {
        reasons.push("SOURCE_DEFAULT_EXPRESSION_UNSUPPORTED".into());
    }
    if javascript::has_semantic_jsdoc_import(inputs.source) {
        reasons.push("SOURCE_JSDOC_IMPORT_UNSUPPORTED".into());
    }
    reasons.extend(javascript::inspect_unmodeled_invocations(inputs.source));
    if inputs.javascript.native.common_js_unsupported {
        reasons.push("SOURCE_COMMONJS_UNSUPPORTED".into());
    }
    reasons.extend(inputs.semantic.reasons.iter().cloned());
    reasons.extend(
        configuration
            .reasons
            .iter()
            .filter(|reason| reason.starts_with("SOURCE_CONFIGURATION_INVALID:"))
            .cloned(),
    );
    let has_configuration = !configuration.consumed.is_empty();
    let configuration_parsed = configuration.raw.is_some();
    let mut unsupported = inputs.semantic.unsupported.clone();
    if !has_configuration || configuration_parsed {
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
    reasons.extend(javascript::inspect_qualified_module_scope(
        inputs.source,
        inputs.path,
    ));
    ModuleConfigurationObservations {
        retained_without_source,
        retained_with_source: observed(reasons, unsupported),
        ordinary_without_snapshot,
    }
}

pub fn semantic(scan: &qualified::QualifiedScan) -> Observation {
    observed(
        scan.reasons.iter().cloned().collect(),
        scan.unsupported.clone(),
    )
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
