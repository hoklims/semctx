//! Standalone syntax counterpart of baseline inspectRetainedQualifiedScope.
//! Uses the same pinned ts_goport parser as C1, including malformed ASTs. It is
//! consumer-owned evidence, never a claim that C1 emitted unexposed AST fields.
use super::*;
#[path = "consumer_retained_aliases.rs"]
mod consumer_retained_aliases;
#[path = "../src/retained_manifest.rs"]
#[expect(
    dead_code,
    reason = "shared metadata module also exports configuration helpers outside this scope consumer"
)]
mod consumer_retained_manifest;
use ts_goport::{
    ast,
    astdata::SyntaxKind as K,
    core::Node,
    flags::ScriptKind,
    frontend::{
        parser::{SourceFileParseOptions, parse_source_file},
        tspath::Path as CompilerPath,
    },
};

fn visit(node: Node, path: &str, reasons: &mut Vec<String>) {
    if node.is_nil() {
        return;
    }
    let code = match node.kind() {
        K::CallExpression
            if node.expression().kind() == K::ImportKeyword
                && (node.arguments().len() != 1
                    || node.arguments().get(0).kind() != K::StringLiteral) =>
        {
            Some("DEPENDENCY_SCOPE_COMPUTED_IMPORT")
        }
        K::ImportEqualsDeclaration
            if node.module_reference().kind() == K::ExternalModuleReference =>
        {
            Some("DEPENDENCY_SCOPE_COMMONJS_UNSUPPORTED")
        }
        K::ExportAssignment if node.is_export_equals() => {
            Some("DEPENDENCY_SCOPE_COMMONJS_UNSUPPORTED")
        }
        K::ImportType => Some("DEPENDENCY_SCOPE_IMPORT_TYPE_UNSUPPORTED"),
        K::WithStatement => Some("DEPENDENCY_SCOPE_RUNTIME_CODE"),
        _ => None,
    };
    if let Some(code) = code {
        reasons.push(format!("{code}:{path}"));
    }
    node.for_each_child(|child| {
        visit(child, path, reasons);
        false
    });
}

fn external_policy(request: &Value) -> Result<Value, String> {
    let root = value_text(request, "cwd")?;
    let sensitive = request["case_sensitive"]
        .as_bool()
        .ok_or("external policy case absent")?;
    let inventory: Value =
        serde_json::from_str(include_str!("../builtin-modules.json")).map_err(|e| e.to_string())?;
    let mut names = BTreeSet::new();
    let mut packages = serde_json::Map::new();
    let mut aliases = vec![];
    let mut receipts = vec![];
    let _program = ts_goport::core::enter_program(None);
    for (path, text) in request["files"]
        .as_object()
        .ok_or("captured metadata map absent")?
    {
        let (_, location) = verifier_location(root, path, sensitive, "repository")?;
        if location["domain"] != "repository" {
            continue;
        }
        let relative = value_text(&location, "path")?;
        let filename = relative.rsplit('/').next().unwrap_or(relative);
        if filename != "package.json"
            && !(filename.starts_with("tsconfig") && filename.ends_with(".json"))
        {
            continue;
        }
        let text = text.as_str().ok_or("captured metadata text absent")?;
        let parsed = consumer_retained_manifest::inspect(path, text);
        receipts.push(json!({"path":relative,"content_id":identity::digest_bytes(text.as_bytes()),"parsed":parsed.is_some()}));
        // Baseline parseConfigFileTextToJson errors are skipped; configuration
        // components independently retain the error. Never invent declarations.
        let Some(parsed) = parsed else {
            continue;
        };
        if filename == "package.json" {
            if let Some(name) = parsed.name {
                names.insert(name);
            }
            packages.insert(
                relative.rsplit_once('/').map(|p| p.0).unwrap_or("").into(),
                json!(parsed.external_packages),
            );
        }
        aliases.extend(parsed.aliases);
    }
    Ok(
        json!({"workspace_names":names,"external_packages":packages,"aliases":aliases,
        "builtins":inventory["modules"],"builtin_inventory_id":identity::digest(&inventory),"metadata_reads":receipts}),
    )
}

fn is_external(policy: &Value, specifier: &str, from: &str) -> Result<bool, String> {
    let builtins = policy["builtins"]
        .as_array()
        .ok_or("consumer builtin inventory absent")?;
    if builtins.iter().any(|p| p.as_str() == Some(specifier)) {
        return Ok(true);
    }
    let aliases = policy["aliases"]
        .as_array()
        .ok_or("captured aliases absent")?;
    if specifier.starts_with('.')
        || specifier.starts_with('/')
        || aliases.iter().any(|alias| {
            alias.as_str().is_some_and(|alias| {
                consumer_retained_aliases::matches_port_strings(alias, specifier)
            })
        })
    {
        return Ok(false);
    }
    let package = specifier
        .split('/')
        .take(if specifier.starts_with('@') { 2 } else { 1 })
        .collect::<Vec<_>>()
        .join("/");
    if policy["workspace_names"]
        .as_array()
        .ok_or("captured workspace names absent")?
        .iter()
        .any(|v| v.as_str() == Some(package.as_str()))
    {
        return Ok(false);
    }
    if !safe_relative(from) {
        return Err("scope importer outside repository".into());
    }
    let mut directory = from.rsplit_once('/').map(|p| p.0).unwrap_or("");
    loop {
        if policy["external_packages"]
            .get(directory)
            .and_then(Value::as_array)
            .is_some_and(|v| v.iter().any(|p| p.as_str() == Some(package.as_str())))
        {
            return Ok(true);
        }
        if directory.is_empty() {
            return Ok(false);
        }
        directory = directory.rsplit_once('/').map(|p| p.0).unwrap_or("");
    }
}

pub(super) fn observe(
    request: &Value,
    sdk: &Value,
    raw: &Value,
    probe_artifact_sha: &str,
    consumer_artifact_sha: &str,
) -> Result<Value, String> {
    // Independently admitted C1 context; this also establishes exact SDK files,
    // options and canonical capture identity for the source texts parsed below.
    observation_bound_to_request(raw, request, sdk, probe_artifact_sha)?;
    let root = value_text(request, "cwd")?;
    let sensitive = request["case_sensitive"]
        .as_bool()
        .ok_or("AST case mode absent")?;
    let files = request["files"]
        .as_object()
        .ok_or("AST captured source texts absent")?;
    let capture_keys = files
        .keys()
        .map(|p| verifier_absolute_key(p, sensitive))
        .collect::<Result<BTreeSet<_>, _>>()?;
    let mut sources = vec![];
    for path in request["roots"].as_array().ok_or("AST roots absent")? {
        let path = path.as_str().ok_or("non-text AST root")?;
        let text = files
            .get(path)
            .and_then(Value::as_str)
            .ok_or("AST root outside admitted captured map")?;
        let (_, location) = verifier_location(root, path, sensitive, "repository")?;
        if location["domain"] != "repository" {
            return Err("scope AST root outside repository".into());
        }
        let relative = value_text(&location, "path")?;
        let kind = if path.ends_with(".tsx") {
            ScriptKind::TSX
        } else if path.ends_with(".jsx") {
            ScriptKind::JSX
        } else if [".js", ".mjs", ".cjs"].iter().any(|s| path.ends_with(s)) {
            ScriptKind::JS
        } else {
            ScriptKind::TS
        };
        let parsed = parse_source_file(
            &SourceFileParseOptions {
                file_name: path.into(),
                path: CompilerPath(path.into()),
                ..Default::default()
            },
            ast::FileText::new(text.to_string(), false),
            kind,
        );
        let mut syntax = Vec::new();
        visit(parsed.root, relative, &mut syntax);
        let mut references = vec![];
        for reference in &parsed.referenced_files {
            let parent = Path::new(path).parent().ok_or("AST source parent absent")?;
            let target = parent
                .join(&reference.file_name)
                .to_string_lossy()
                .replace('\\', "/");
            let key = verifier_absolute_key(&target, sensitive)?;
            references.push(json!({"file_name":reference.file_name,"target_key":key,"retained":capture_keys.contains(&key)}));
        }
        sources.push(json!({"path":relative,"source_sha256":identity::digest_bytes(text.as_bytes()),"references":references,
            "syntax_reasons":syntax,"has_parse_diagnostics":!ast::source_file_diagnostics(parsed.root).is_empty()}));
    }
    let consumer = std::env::current_exe().map_err(|e| e.to_string())?;
    let consumer_id = identity::digest_bytes(&fs::read(consumer).map_err(|e| e.to_string())?);
    if consumer_id.trim_start_matches("sha256:")
        != consumer_artifact_sha.trim_start_matches("sha256:")
    {
        return Err("native AST consumer artifact differs from frozen permit".into());
    }
    let mut result = json!({"kind":"rust-consumer-native-ast-v1","engine_revision":identity::ENGINE_REVISION,"engine_upstream_revision":identity::ENGINE_UPSTREAM_REVISION,
        "syntax_only":true,"semantic_program_substituted":false,"consumer_artifact_id":consumer_id,
        "request_descriptor_id":identity::digest(request),"input_manifest_id":raw["input_manifest_id"],"sdk_input_id":identity::digest(sdk),
        "source_parser_contract":"standalone native syntax parser; references and dependency visitor mirror baseline ts.createSourceFile Latest; semantic options/SDK remain bound to the independent actual C1 Program receipt",
        "sources":sources,"retained_external_policy":external_policy(request)?,"global_admission_inferred":false});
    result["ast_receipt_id"] = json!(identity::digest(&result));
    Ok(result)
}

fn confinement_reasons(raw: &Value, broad: &Value) -> Result<Vec<String>, String> {
    if raw["observation_mode"] != "source_components" {
        return Ok(vec![]);
    }
    let guard = &raw["confinementObservation"];
    if guard["executed"] != true {
        return Err("actual source component confinement guard missing".into());
    }
    if guard["state"] == "clear" {
        if !guard["code"].is_null()
            || !guard["error"].is_null()
            || raw["extraction_executed"] != false
        {
            return Err("source scope clear guard has contradictory fields".into());
        }
        return Ok(vec![]);
    }
    if guard["state"] != "refused"
        || guard["code"] != "REFERENCE_OUTSIDE_REPOSITORY"
        || !guard["error"]
            .as_str()
            .is_some_and(|e| e.starts_with("REFERENCE_OUTSIDE_REPOSITORY: "))
        || raw["extraction_executed"] != false
        || broad["executed"] != true
        || broad["unsupported"] != json!([])
    {
        return Err("source scope confinement refusal is incomplete or foreign".into());
    }
    // Baseline catches this extraction refusal, leaving no analyzed source files.
    // Unreadable here is an analysis result, not a fabricated physical I/O error.
    let mut reasons = vec!["DEPENDENCY_SCOPE_OUTSIDE_REPOSITORY".to_string()];
    for file in broad["files"]
        .as_array()
        .ok_or("actual broad files missing")?
    {
        let path = value_text(file, "relPath")?;
        if file["language"] == "typescript" {
            reasons.push(format!("DEPENDENCY_SCOPE_UNREADABLE:{path}"));
        }
    }
    Ok(reasons)
}

pub(super) fn project(
    raw: &Value,
    ast_receipt: &Value,
    graph: &Value,
    broad: &Value,
    expected_capture: &str,
    consumed_capture: &str,
) -> Result<Value, String> {
    if raw["complete"] != true
        || raw["global_admission_inferred"] != false
        || ast_receipt["kind"] != "rust-consumer-native-ast-v1"
        || ast_receipt["input_manifest_id"] != raw["input_manifest_id"]
    {
        return Err("scope AST/native capture receipt incomplete or foreign".into());
    }
    let mut unsigned = ast_receipt.clone();
    unsigned
        .as_object_mut()
        .ok_or("AST receipt not object")?
        .remove("ast_receipt_id");
    if ast_receipt["ast_receipt_id"] != identity::digest(&unsigned) {
        return Err("scope AST receipt hash differs".into());
    }
    let imports = raw["raw_extraction"]["imports"]
        .as_array()
        .ok_or("native scope imports absent")?;
    let subjects = raw["subjects"]
        .as_array()
        .ok_or("native scope subjects absent")?;
    let mut links = vec![];
    let mut reasons = confinement_reasons(raw, broad)?;
    let mut unresolved = vec![];
    let mut external = BTreeSet::new();
    for import in imports {
        if let Some(to) = import["resolvedRelPath"].as_str() {
            links.push(json!([import["fromRelPath"], to]));
        }
    }
    let nodes = graph["nodes"]
        .as_array()
        .ok_or("scope graph input nodes absent")?;
    for edge in graph["edges"]
        .as_array()
        .ok_or("scope graph input edges absent")?
    {
        if !["imports", "exports", "calls", "depends_on"]
            .contains(&edge["kind"].as_str().unwrap_or(""))
        {
            continue;
        }
        let from = nodes
            .iter()
            .find(|n| n["id"] == edge["from"])
            .and_then(|n| n["filePath"].as_str());
        let to = nodes
            .iter()
            .find(|n| n["id"] == edge["to"])
            .and_then(|n| n["filePath"].as_str());
        if let (Some(from), Some(to)) = (from, to) {
            links.push(json!([from, to]));
        }
    }
    if expected_capture != consumed_capture {
        reasons.push("DEPENDENCY_SCOPE_INPUT_CHANGED".to_string());
    }
    for import in imports {
        let from = value_text(import, "fromRelPath")?;
        let spec = value_text(import, "moduleSpecifier")?;
        if is_external(&ast_receipt["retained_external_policy"], spec, from)? {
            external.insert(spec.to_string());
        } else if !import["resolvedRelPath"].is_string() {
            reasons.push(format!("DEPENDENCY_SCOPE_UNRESOLVED_IMPORT:{from}:{spec}"));
            unresolved.push(json!({"path":from,"specifier":spec}));
        }
    }
    if broad["executed"] != true || broad["unsupported"] != json!([]) {
        return Err("actual broad discovery incomplete".into());
    }
    for candidate in broad["candidates"]
        .as_array()
        .ok_or("broad candidate inventory absent")?
    {
        let reason = value_text(candidate, "reason")?;
        if reason == "READ_FAILED" || reason.ends_with("OUTSIDE_REPOSITORY") {
            reasons.push(format!(
                "DEPENDENCY_SCOPE_UNREADABLE:{}",
                value_text(candidate, "relPath")?
            ));
        }
    }
    for file in broad["files"].as_array().ok_or("broad files absent")? {
        if file["role"] == "migration" && file["language"] == "typescript" {
            reasons.push(format!(
                "DEPENDENCY_SCOPE_MIGRATION_SOURCE_UNSUPPORTED:{}",
                value_text(file, "relPath")?
            ));
        }
    }
    for source in ast_receipt["sources"]
        .as_array()
        .ok_or("actual AST source receipts absent")?
    {
        let path = value_text(source, "path")?;
        let subject = subjects
            .iter()
            .find(|s| s["path"] == path)
            .ok_or("native AST scope subject absent")?;
        if [".d.ts", ".d.mts", ".d.cts"]
            .iter()
            .any(|s| path.ends_with(s))
        {
            reasons.push(format!("DEPENDENCY_SCOPE_DECLARATION_UNSUPPORTED:{path}"));
        }
        let native = &subject["javascript"]["native"];
        if native["commonJsUnsupported"] == true {
            reasons.push(format!("DEPENDENCY_SCOPE_COMMONJS_UNSUPPORTED:{path}"));
        }
        if native["runtimeEvaluationUnsupported"] == true {
            reasons.push(format!("DEPENDENCY_SCOPE_RUNTIME_CODE:{path}"));
        }
        for reference in source["references"]
            .as_array()
            .ok_or("actual AST reference inventory absent")?
        {
            if reference["retained"] == false {
                reasons.push(format!(
                    "DEPENDENCY_SCOPE_UNRETAINED_REFERENCE:{path}:{}",
                    value_text(reference, "file_name")?
                ));
            }
        }
        for member in native["unmodeledMembers"]
            .as_array()
            .ok_or("native member inventory absent")?
        {
            reasons.push(format!(
                "DEPENDENCY_SCOPE_NATIVE_MODULE_MEMBER_UNSUPPORTED:{path}:{}",
                member.as_str().ok_or("invalid native member")?
            ));
        }
        for (component, prefix) in [
            (
                &subject["sourceParsingObservation"],
                "DEPENDENCY_SCOPE_PARSE_FAILED",
            ),
            (
                &subject["moduleConfigurationObservations"]["retainedWithSource"],
                "DEPENDENCY_SCOPE_CONFIGURATION",
            ),
        ] {
            if component["executed"] != true || component["unsupported"] != json!([]) {
                return Err("actual scope parsing/configuration component incomplete".into());
            }
            for reason in component["reasons"]
                .as_array()
                .ok_or("scope component reasons absent")?
            {
                reasons.push(format!(
                    "{prefix}:{path}:{}",
                    reason.as_str().ok_or("invalid scope reason")?
                ));
            }
        }
        for reason in source["syntax_reasons"]
            .as_array()
            .ok_or("actual AST dependency syntax inventory absent")?
        {
            reasons.push(reason.as_str().ok_or("invalid AST syntax reason")?.into());
        }
    }
    Ok(
        json!({"links":links,"reasons":reasons,"externalModuleSpecifiers":external,"unresolvedImports":unresolved}),
    )
}

#[cfg(test)]
mod comparator_tests {
    use super::*;
    #[test]
    fn comparator_scope_external_status_uses_captured_metadata_not_absent_native_marker() {
        let mut request = json!({"cwd":"/case","case_sensitive":true,"files":{
            "/case/package.json":"{\"dependencies\":{\"opaque\":\"1.0.0\",\"@hidden/inbound\":\"workspace:*\"}}"}});
        let policy = external_policy(&request).unwrap();
        assert!(!is_external(&policy, "@hidden/inbound", "hidden.ts").unwrap());
        assert!(is_external(&policy, "opaque/subpath", "src/main.ts").unwrap());
        assert!(is_external(&policy, "node:fs", "main.ts").unwrap());
        assert!(!is_external(&policy, "./opaque", "main.ts").unwrap());
        request["files"]["/case/package.json"] =
            json!("{\"name\":\"opaque\",\"dependencies\":{\"opaque\":\"1\"}}");
        assert!(!is_external(&external_policy(&request).unwrap(), "opaque", "main.ts").unwrap());
        request["files"]["/case/package.json"] =
            json!("{\"dependencies\":{\"@hidden/inbound\":\"1\"}}");
        request["files"]["/case/tsconfig.json"] =
            json!("{\"compilerOptions\":{\"paths\":{\"@hidden/*\":[\"src/*\"]}}}");
        let policy = external_policy(&request).unwrap();
        assert!(!is_external(&policy, "@hidden/inbound", "main.ts").unwrap());
        assert!(is_external(&policy, "opaque", "../main.ts").is_err());
        request["files"] = json!({});
        assert!(!is_external(&external_policy(&request).unwrap(), "opaque", "main.ts").unwrap());
    }
    #[test]
    fn actual_native_ast_exposes_reference_literal_without_regex() {
        let parsed = parse_source_file(
            &SourceFileParseOptions {
                file_name: "/w/a.ts".into(),
                path: CompilerPath("/w/a.ts".into()),
                ..Default::default()
            },
            ast::FileText::new(
                "/// <reference path=\"./dep.ts\" />\nexport {};".into(),
                false,
            ),
            ScriptKind::TS,
        );
        assert_eq!(parsed.referenced_files.len(), 1);
        assert_eq!(parsed.referenced_files[0].file_name, "./dep.ts");
    }
    #[test]
    fn malformed_ast_keeps_actual_dependency_visitor_evidence() {
        let parsed = parse_source_file(
            &SourceFileParseOptions {
                file_name: "/w/a.ts".into(),
                path: CompilerPath("/w/a.ts".into()),
                ..Default::default()
            },
            ast::FileText::new("import(name); export function broken( {".into(), false),
            ScriptKind::TS,
        );
        assert!(!ast::source_file_diagnostics(parsed.root).is_empty());
        let mut reasons = vec![];
        visit(parsed.root, "a.ts", &mut reasons);
        assert!(reasons.contains(&"DEPENDENCY_SCOPE_COMPUTED_IMPORT:a.ts".to_string()));
    }
}

#[test]
fn comparator_source_scope_refusal_is_an_analysis_boundary_not_a_physical_failure() {
    let raw = json!({"observation_mode":"source_components","extraction_executed":false,
        "confinementObservation":{"executed":true,"state":"refused","code":"REFERENCE_OUTSIDE_REPOSITORY","error":"REFERENCE_OUTSIDE_REPOSITORY: ../missing.ts"}});
    let broad = json!({"executed":true,"unsupported":[],"files":[{"relPath":"main.ts","language":"typescript"}]});
    assert_eq!(
        confinement_reasons(&raw, &broad).unwrap(),
        vec![
            "DEPENDENCY_SCOPE_OUTSIDE_REPOSITORY",
            "DEPENDENCY_SCOPE_UNREADABLE:main.ts"
        ]
    );
    for (pointer, value) in [
        ("/extraction_executed", json!(true)),
        ("/confinementObservation/executed", json!(false)),
        ("/confinementObservation/code", json!("OTHER_ERROR")),
    ] {
        let mut poison = raw.clone();
        *poison.pointer_mut(pointer).unwrap() = value;
        assert!(confinement_reasons(&poison, &broad).is_err());
    }
    let mut poison = broad.clone();
    poison["executed"] = json!(false);
    assert!(confinement_reasons(&raw, &poison).is_err());
}
