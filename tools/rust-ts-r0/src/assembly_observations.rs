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

pub fn test_dynamic_imports(file: core::Node, relative: &str) -> BTreeSet<(String, u32, String)> {
    let mut nodes = vec![];
    calls(file, &mut nodes);
    let mut observed = BTreeSet::new();
    for node in nodes {
        if node.expression().kind() == SyntaxKind::ImportKeyword
            && node.arguments().len() == 1
            && node.arguments().get(0).kind() == SyntaxKind::StringLiteral
        {
            let starts = ast::source_file_ecma_line_map(file);
            let line = starts
                .partition_point(|start| *start <= astnav::get_start_of_node(node, file, false))
                .max(1) as u32;
            observed.insert((
                relative.to_owned(),
                line,
                node.arguments().get(0).text().to_owned(),
            ));
        }
    }
    observed
}

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
mod tests {
    use super::*;

    fn fixture() -> (Value, Sdk) {
        let sensitive = ts_goport::frontend::vfs::osvfs_fs().use_case_sensitive_file_names();
        let analysis = json!({"id":"controlledAssemblyDev","cwd":"/repo","sdk_directory":"/sdk/lib","case_sensitive":sensitive,"roots":["/repo/factory.ts","/repo/use.test.ts"],"files":{"/repo/factory.ts":"export function nativeOwnedFactory(){return 67;}","/repo/use.test.ts":"export async function observedCheck(){const dep=await import('./factory');return dep.nativeOwnedFactory();}","/repo/package.json":"{\"type\":\"module\"}"},"options":{"target":"ES2022","module":"ESNext","moduleResolution":"Bundler","allowJs":true,"jsx":"Preserve","skipLibCheck":true,"noEmit":true,"strict":false},"roles":{"factory.ts":"source","use.test.ts":"test"},"selection":{},"disabled":[],"retained":true,"qualified":true,"utf16_files":{},"raw_files":{}});
        let descriptor = json!({"analysis":analysis,"control":{"fromRelPath":"use.test.ts","moduleSpecifier":"./factory","line":1,"bindingTargets":[{"relPath":"factory.ts","symbolPath":"nativeOwnedFactory"}]}});
        let sdk = serde_json::from_slice(
            &std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/sdk/sdk-input.json")).unwrap(),
        )
        .unwrap();
        (descriptor, sdk)
    }

    #[test]
    fn private_consumer_distinguishes_defined_binding_arrays_without_public_reachability_credit() {
        let (descriptor, sdk) = fixture();
        let bound = run(descriptor.clone(), &sdk);
        assert_eq!(bound["executed"], true, "{bound}");
        assert_eq!(bound["unsupported"], json!([]));
        assert_eq!(
            bound["native_original_import"]["bindingTargets"],
            Value::Null
        );
        assert!(
            bound["native_original_import"]
                .get("bindingTargets")
                .is_none()
        );
        assert_eq!(
            bound["dynamic_imports"],
            json!([["use.test.ts", 1, "./factory"]])
        );
        assert!(
            bound["assembly"]["integrityReasons"]
                .as_object()
                .unwrap()
                .is_empty()
        );
        let coverage = |value: &Value| {
            value["assembly"]["edges"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|edge| edge["kind"] == "covers" || edge["kind"] == "tested_by")
                .count()
        };
        assert_eq!(coverage(&bound), 2);
        assert_eq!(bound["public_extractor_reachability_claimed"], false);
        assert_eq!(bound["global_admission_inferred"], false);
        let mut missing_coordinate = descriptor.clone();
        missing_coordinate["control"]["bindingTargets"][0]["symbolPath"] = json!("missingFactory");
        let missing_coordinate = run(missing_coordinate, &sdk);
        assert_eq!(missing_coordinate["executed"], true);
        assert_eq!(coverage(&missing_coordinate), 0);
        assert_eq!(
            missing_coordinate["assembly"]["integrityReasons"]["use.test.ts"],
            json!(["QUALIFIED_TEST_BINDING_MISSING:factory.ts:missingFactory"])
        );
        let mut empty = descriptor;
        empty["control"]["bindingTargets"] = json!([]);
        let empty = run(empty, &sdk);
        assert_eq!(empty["executed"], true, "{empty}");
        assert_eq!(empty["controlled_import"]["bindingTargets"], json!([]));
        assert!(
            empty["assembly"]["integrityReasons"]
                .as_object()
                .unwrap()
                .is_empty()
        );
        assert_eq!(coverage(&empty), 0);
        assert_eq!(
            empty["native_original_import"],
            bound["native_original_import"]
        );
    }

    #[test]
    fn private_control_rejects_missing_malformed_or_foreign_context() {
        let (descriptor, sdk) = fixture();
        let mut malformed = vec![json!({})];
        for replacement in [
            Value::Null,
            json!("absent"),
            json!({}),
            json!([{"relPath":"factory.ts"}]),
            json!([{"relPath":"factory.ts","symbolPath":"nativeOwnedFactory","runtimeUsed":true}]),
        ] {
            let mut bad = descriptor.clone();
            bad["control"]["bindingTargets"] = replacement;
            malformed.push(bad);
        }
        let mut missing = descriptor.clone();
        missing["control"]
            .as_object_mut()
            .unwrap()
            .remove("bindingTargets");
        malformed.push(missing);
        let mut extra = descriptor.clone();
        extra["request_descriptor_id"] = json!("forged");
        malformed.push(extra);
        let mut wrong_mode = descriptor.clone();
        wrong_mode["analysis"]["qualified"] = json!(false);
        malformed.push(wrong_mode);
        let mut raw = descriptor.clone();
        raw["analysis"]["raw_files"] =
            json!({"/repo/raw.ts":{"bytes":[65],"profile":"retained_utf8"}});
        assert_eq!(
            run(raw.clone(), &sdk)["unsupported"],
            json!(["CONTROLLED_ASSEMBLY_TEXT_CAPTURE_REQUIRED"])
        );
        malformed.push(raw);
        let mut decoded = descriptor.clone();
        decoded["analysis"]["utf16_files"] = json!({"/repo/decoded.ts":[65]});
        assert_eq!(
            run(decoded.clone(), &sdk)["unsupported"],
            json!(["CONTROLLED_ASSEMBLY_TEXT_CAPTURE_REQUIRED"])
        );
        malformed.push(decoded);
        let mut source_role = descriptor.clone();
        source_role["analysis"]["roles"]["use.test.ts"] = json!("source");
        malformed.push(source_role);
        let mut two_arguments = descriptor.clone();
        two_arguments["analysis"]["files"]["/repo/use.test.ts"] = json!(
            "export async function observedCheck(){return import('./factory',{with:{type:'json'}});}"
        );
        malformed.push(two_arguments);
        let mut absent = descriptor.clone();
        absent["control"]["line"] = json!(2);
        malformed.push(absent);
        let mut ambiguous = descriptor.clone();
        ambiguous["analysis"]["files"]["/repo/use.test.ts"] = json!(
            "export async function observedCheck(){await import('./factory');return import('./factory');}"
        );
        malformed.push(ambiguous);
        for bad in malformed {
            let refused = run(bad, &sdk);
            assert_eq!(refused["state"], "CONTROLLED_ASSEMBLY_REFUSED", "{refused}");
            assert_eq!(refused["executed"], false);
            assert!(!refused["unsupported"].as_array().unwrap().is_empty());
            assert_eq!(refused["global_admission_inferred"], false);
        }
        let mut empty_sdk = sdk;
        empty_sdk.files.clear();
        assert_eq!(run(descriptor, &empty_sdk)["executed"], false);
    }

    #[test]
    fn private_command_requires_sdk_and_binds_actual_descriptor_and_artifact() {
        let (descriptor, sdk) = fixture();
        let root = std::env::temp_dir().join(format!(
            "semctx-controlled-assembly-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&root).unwrap();
        let path = root.join("descriptor.json");
        let sdk_path = root.join("sdk.json");
        std::fs::write(&path, serde_json::to_vec(&descriptor).unwrap()).unwrap();
        std::fs::write(&sdk_path, serde_json::to_vec(&sdk).unwrap()).unwrap();
        let args = vec![
            "probe".to_owned(),
            "--observe-controlled-assembly".to_owned(),
            path.to_string_lossy().into_owned(),
            sdk_path.to_string_lossy().into_owned(),
        ];
        for count in [2, 3] {
            assert!(additional_observation(&args[..count]).is_err());
        }
        let mut extra = args.clone();
        extra.push("extra".into());
        assert!(additional_observation(&extra).is_err());
        let observed = additional_observation(&args)
            .unwrap()
            .expect("recognized private command");
        assert_eq!(observed["executed"], true, "{observed}");
        assert_eq!(
            observed["request_descriptor_id"],
            identity::digest(&descriptor)
        );
        assert_eq!(
            observed["sdk_input_id"],
            identity::digest(&serde_json::to_value(sdk).unwrap())
        );
        assert_eq!(
            observed["producer_artifact_id"],
            identity::digest_bytes(&std::fs::read(std::env::current_exe().unwrap()).unwrap())
        );
        std::fs::remove_dir_all(root).unwrap();
    }
}
