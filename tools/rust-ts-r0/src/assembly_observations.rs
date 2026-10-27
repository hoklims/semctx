use super::*;
use serde_json::{Value, json};
use ts_goport::{
    flags::ScriptKind,
    frontend::parser::{SourceFileParseOptions, parse_source_file},
};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    analysis: super::Request,
    control: Control,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Control {
    from_rel_path: String,
    module_specifier: String,
    line: u32,
    binding_targets: Vec<ControlledBinding>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ControlledBinding {
    rel_path: String,
    symbol_path: String,
}

pub use semctx_r0_probe::test_dynamic_imports::scan_node as test_dynamic_imports;

fn controlled_observation(descriptor: Value, sdk: &Sdk) -> Result<Value, String> {
    let request: Request = serde_json::from_value(descriptor)
        .map_err(|error| format!("CONTROLLED_ASSEMBLY_REQUEST_INVALID:{error}"))?;
    let analysis = &request.analysis;
    if !analysis.retained || !analysis.qualified || sdk.files.is_empty() {
        return Err("CONTROLLED_ASSEMBLY_RETAINED_QUALIFIED_CONTEXT_REQUIRED".into());
    }
    if !analysis.raw_files.is_empty() || !analysis.utf16_files.is_empty() {
        return Err("CONTROLLED_ASSEMBLY_TEXT_CAPTURE_REQUIRED".into());
    }
    let native = analyze(analysis.clone(), sdk.clone())?;
    let mut extraction: ordinary::Extraction =
        serde_json::from_value(native["raw_extraction"].clone())
            .map_err(|error| format!("CONTROLLED_ASSEMBLY_NATIVE_EXTRACTION_INVALID:{error}"))?;
    let mut roles = BTreeMap::new();
    for node in native["assembly"]["nodes"]
        .as_array()
        .ok_or("missing native graph nodes")?
    {
        let role = match node["kind"].as_str() {
            Some("module") => "source",
            Some("test") => "test",
            Some(_) => continue,
            None => return Err("CONTROLLED_ASSEMBLY_NATIVE_NODE_KIND_MISSING".into()),
        };
        let path = node["filePath"]
            .as_str()
            .ok_or("native module path missing")?;
        if roles.insert(path.to_owned(), role.to_owned()).is_some() {
            return Err("CONTROLLED_ASSEMBLY_NATIVE_OWNER_AMBIGUOUS".into());
        }
    }
    if roles
        .get(&request.control.from_rel_path)
        .map(String::as_str)
        != Some("test")
    {
        return Err("CONTROLLED_ASSEMBLY_TEST_OWNER_REQUIRED".into());
    }
    let matches = extraction
        .imports
        .iter()
        .enumerate()
        .filter(|(_, import)| {
            import.from_rel_path == request.control.from_rel_path
                && import.module_specifier == request.control.module_specifier
                && import.line == request.control.line
        })
        .map(|(index, _)| index)
        .collect::<Vec<_>>();
    if matches.len() != 1 {
        return Err("CONTROLLED_ASSEMBLY_IMPORT_NOT_UNIQUE".into());
    }
    let normalizer = CaptureFs::new(BTreeMap::new(), analysis.case_sensitive);
    let mut dynamic_imports = BTreeSet::new();
    for (relative, role) in &roles {
        if role != "test" {
            continue;
        }
        let path = normalizer.key(&format!("{}/{relative}", analysis.cwd));
        let (path, text) = analysis
            .files
            .iter()
            .find(|(candidate, _)| normalizer.key(candidate) == path)
            .ok_or("CONTROLLED_ASSEMBLY_TEST_TEXT_MISSING")?;
        let kind = if relative.ends_with(".tsx") {
            ScriptKind::TSX
        } else if relative.ends_with(".jsx") {
            ScriptKind::JSX
        } else if [".js", ".mjs", ".cjs"]
            .iter()
            .any(|suffix| relative.ends_with(suffix))
        {
            ScriptKind::JS
        } else {
            ScriptKind::TS
        };
        let _empty = core::enter_program(None);
        let parsed = parse_source_file(
            &SourceFileParseOptions {
                file_name: path.clone(),
                path: ts_goport::frontend::tspath::Path(path.clone()),
                ..Default::default()
            },
            ast::FileText::new(text.clone(), false),
            kind,
        );
        dynamic_imports.extend(test_dynamic_imports(parsed.root, relative));
    }
    if !dynamic_imports.contains(&(
        request.control.from_rel_path.clone(),
        request.control.line,
        request.control.module_specifier.clone(),
    )) {
        return Err("CONTROLLED_ASSEMBLY_DYNAMIC_IMPORT_NOT_OBSERVED".into());
    }
    let index = matches[0];
    let original_import =
        serde_json::to_value(&extraction.imports[index]).map_err(|error| error.to_string())?;
    extraction.imports[index].binding_targets = Some(
        request
            .control
            .binding_targets
            .into_iter()
            .map(|binding| ordinary::BindingTarget {
                rel_path: binding.rel_path,
                symbol_path: binding.symbol_path,
                runtime_used: None,
                unmodeled_reason: None,
            })
            .collect(),
    );
    let controlled_import =
        serde_json::to_value(&extraction.imports[index]).map_err(|error| error.to_string())?;
    let graph = assembly::assemble(&extraction, &roles, true, &analysis.cwd, &dynamic_imports)?;
    let controlled_extraction =
        serde_json::to_value(&extraction).map_err(|error| error.to_string())?;
    Ok(
        json!({"state":"CONTROLLED_ASSEMBLY_OBSERVED","executed":true,"unsupported":[],"native_original_import":original_import,"controlled_import":controlled_import,"native_extraction_id":identity::digest(&native["raw_extraction"]),"controlled_extraction_id":identity::digest(&controlled_extraction),"controlled_extraction":controlled_extraction,"assembly":graph,"dynamic_imports":dynamic_imports,"native_analysis":native,"control_scope":"PRIVATE_SUPPLIED_EXTRACTION_ONLY","public_extractor_reachability_claimed":false,"global_admission_inferred":false}),
    )
}

pub fn run(descriptor: Value, sdk: &Sdk) -> Value {
    controlled_observation(descriptor, sdk).unwrap_or_else(|error| json!({"state":"CONTROLLED_ASSEMBLY_REFUSED","executed":false,"unsupported":[error],"public_extractor_reachability_claimed":false,"global_admission_inferred":false}))
}

#[cfg(test)]
#[path = "../tests/unit/assembly_observations.rs"]
mod tests;
