//! Producer-owned retained dependency scope. Syntax evidence supplements the
//! native Program; declaration component observations never imply qualification.
use super::*;
use serde_json::{Value, json};
use std::path::Path;
use ts_goport::{
    astdata::SyntaxKind as K,
    core::Node,
    flags::ScriptKind,
    frontend::parser::{SourceFileParseOptions, parse_source_file},
    frontend::tspath::Path as CompilerPath,
};

fn text<'a>(value: &'a Value, field: &str) -> Result<&'a str, String> {
    value[field]
        .as_str()
        .ok_or_else(|| format!("retained scope {field} absent"))
}

fn declaration(path: &str) -> bool {
    [".d.ts", ".d.mts", ".d.cts"]
        .iter()
        .any(|s| path.ends_with(s))
}

fn source(path: &str) -> bool {
    [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]
        .iter()
        .any(|s| path.ends_with(s))
}

fn visit(node: Node, path: &str, reasons: &mut Vec<String>) {
    if node.is_nil() {
        return;
    }
    let reason = match node.kind() {
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
    if let Some(reason) = reason {
        reasons.push(format!("{reason}:{path}"));
    }
    node.for_each_child(|child| {
        visit(child, path, reasons);
        false
    });
}

struct ExternalPolicy {
    builtins: BTreeSet<String>,
    names: BTreeSet<String>,
    packages: BTreeMap<String, BTreeSet<String>>,
    aliases: Vec<String>,
    reads: Vec<Value>,
}

impl ExternalPolicy {
    fn capture(request: &Request) -> Result<Self, String> {
        let inventory: Value = serde_json::from_str(include_str!("../builtin-modules.json"))
            .map_err(|e| e.to_string())?;
        let mut policy = Self {
            builtins: serde_json::from_value(inventory["modules"].clone())
                .map_err(|e| e.to_string())?,
            names: BTreeSet::new(),
            packages: BTreeMap::new(),
            aliases: vec![],
            reads: vec![],
        };
        let _program = core::enter_program(None);
        for (path, content) in &request.files {
            let relative = relative_source_path(&request.cwd, path, request.case_sensitive)?;
            let filename = relative.rsplit('/').next().unwrap_or(&relative);
            if filename != "package.json"
                && !(filename.starts_with("tsconfig") && filename.ends_with(".json"))
            {
                continue;
            }
            let manifest = retained_manifest::inspect(path, content);
            policy.reads.push(json!({"path":relative,"content_id":identity::digest_bytes(content.as_bytes()),"parsed":manifest.is_some()}));
            let Some(manifest) = manifest else {
                continue;
            };
            if filename == "package.json" {
                if let Some(name) = manifest.name {
                    policy.names.insert(name);
                }
                policy.packages.insert(
                    relative.rsplit_once('/').map(|p| p.0).unwrap_or("").into(),
                    manifest.external_packages,
                );
            }
            policy.aliases.extend(manifest.aliases);
        }
        Ok(policy)
    }

    fn external(&self, specifier: &str, from: &str) -> bool {
        if self.builtins.contains(specifier) {
            return true;
        }
        if specifier.starts_with('.')
            || specifier.starts_with('/')
            || self
                .aliases
                .iter()
                .any(|a| retained_aliases::matches_port_strings(a, specifier))
        {
            return false;
        }
        let package = specifier
            .split('/')
            .take(if specifier.starts_with('@') { 2 } else { 1 })
            .collect::<Vec<_>>()
            .join("/");
        if self.names.contains(&package) {
            return false;
        }
        let mut directory = from.rsplit_once('/').map(|p| p.0).unwrap_or("");
        loop {
            if self
                .packages
                .get(directory)
                .is_some_and(|p| p.contains(&package))
            {
                return true;
            }
            if directory.is_empty() {
                return false;
            }
            directory = directory.rsplit_once('/').map(|p| p.0).unwrap_or("");
        }
    }
}

fn validate_observation(
    request: &Request,
    sdk: &Sdk,
    observation: &Value,
    expected: &str,
) -> Result<(), String> {
    if observation["complete"] != true
        || observation["global_admission_inferred"] != false
        || observation["input_manifest_id"] != expected
        || observation["request_id"]
            != identity::digest(&serde_json::to_value(request).map_err(|e| e.to_string())?)
        || identity::digest(&batch::input_manifest(request, sdk)?) != expected
    {
        return Err("retained scope native observation is incomplete or foreign".into());
    }
    Ok(())
}

pub(super) fn confinement_code(error: &str) -> Option<&str> {
    let (code, _) = error.split_once(": ")?;
    [
        "IMPORT_OUTSIDE_REPOSITORY",
        "REFERENCE_OUTSIDE_REPOSITORY",
        "SOURCE_LINK_OUTSIDE_REPOSITORY",
    ]
    .contains(&code)
    .then_some(code)
}

/// Preserve native components after an actual whole-extraction confinement
/// refusal. This private scope path accepts retained JS and declarations without
/// broadening either public component-observation request contract.
pub(super) fn components_after_refusal(
    request: &Request,
    sdk: &Sdk,
    refusal: &str,
) -> Result<Value, String> {
    if confinement_code(refusal).is_none()
        || request.qualified
        || !request.retained
        || !request.roles.is_empty()
        || !request.selection.is_empty()
        || !request.disabled.is_empty()
        || !request.raw_files.is_empty()
        || !request.utf16_files.is_empty()
    {
        return Err("retained scope component refusal context differs".into());
    }
    let normalizer = CaptureFs::new(BTreeMap::new(), request.case_sensitive);
    let mut files = BTreeMap::new();
    let mut keys = BTreeSet::new();
    for (path, content) in &request.files {
        relative_source_path(&request.cwd, path, request.case_sensitive)?;
        files.insert(
            path.clone(),
            ts_goport::scanner_util::go_string_from_utf8(content.clone()),
        );
        if !keys.insert(normalizer.key(path)) {
            return Err("retained scope conflicting captured source key".into());
        }
    }
    let project_files = std::sync::Arc::new(files.clone());
    let mut roots = BTreeSet::new();
    for path in &request.roots {
        if !source(path) || !request.files.contains_key(path) || !roots.insert(normalizer.key(path))
        {
            return Err("retained scope component roots differ".into());
        }
    }
    for (path, content) in &sdk.files {
        if !keys.insert(normalizer.key(path)) {
            return Err("retained scope conflicting captured SDK key".into());
        }
        files.insert(
            path.clone(),
            ts_goport::scanner_util::go_string_from_utf8(content.clone()),
        );
    }
    let fs = Rc::new(
        CaptureFs::new(files, request.case_sensitive)
            .with_sdk_keys(sdk.files.keys().map(String::as_str))?,
    );
    fs.record("captured_cwd", &request.cwd, true);
    let guard = captured_confinement::check(
        fs.clone(),
        captured_confinement::Inputs {
            root: &request.cwd,
            sdk_root: &request.sdk_directory,
            roots: &request.roots,
            configured_resolution: true,
            ordinary_system_resolution: false,
        },
    );
    if guard.as_ref().err().map(String::as_str) != Some(refusal) {
        return Err("retained scope component confinement refusal differs".into());
    }
    let frontend = native_frontend(
        fs.clone(),
        &request.cwd,
        &request.sdk_directory,
        request.roots.clone(),
        true,
    );
    let _current = native_program::NativeProgram::enter(&frontend.program);
    program::bind_all();
    let mut subjects = vec![];
    for path in &request.roots {
        let relative = relative_source_path(&request.cwd, path, request.case_sensitive)?;
        let file = program::get_source_file(path);
        if file.is_nil() {
            return Err(format!("RETAINED_SCOPE_COMPONENT_SOURCE_NOT_LOADED:{path}"));
        }
        let source_path = ast::source_file_file_name(file);
        let source_text = ast::source_file_text(file);
        let (captured, found) = fs.read_file(path);
        if !found || fs.key(source_path) != fs.key(path) || captured.as_str() != &*source_text {
            return Err(format!(
                "RETAINED_SCOPE_COMPONENT_SOURCE_CONTEXT_DIFFERS:{path}"
            ));
        }
        let mut subject = inspect_subject(
            fs.clone(),
            path,
            &request.cwd,
            &request.sdk_directory,
            project_files.clone(),
            json!({"nodes":[],"edges":[]}),
            true,
            false,
        )?;
        subject["path"] = json!(relative);
        subject["role"] = json!(if declaration(path) {
            "declaration"
        } else {
            "component"
        });
        subject["selection"] = json!("selected");
        subject["observationScope"] = json!("retained_scope_component_after_refusal");
        subject["componentRootSource"] = json!({"requestedPath":path,"sourcePath":source_path,"sourceTextId":identity::digest_bytes(source_text.as_bytes()),"executed":true,"unsupported":[]});
        subjects.push(subject);
    }
    let artifact = std::fs::read(std::env::current_exe().map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    let mut observed = json!({"request":request.id,"request_id":identity::digest(&serde_json::to_value(request).map_err(|e|e.to_string())?),"input_manifest_id":identity::digest(&batch::input_manifest(request,sdk)?),"producer_artifact_id":identity::digest_bytes(&artifact),"sdk_version":sdk.version,"subjects":subjects,"complete":true,"global_admission_inferred":false,"extraction_executed":false,"raw_extraction":{"imports":[]},"assembly":{"nodes":[],"edges":[]},"confinementObservation":{"executed":true,"state":"refused","code":"REFERENCE_OUTSIDE_REPOSITORY","error":refusal},"capture_probes":fs.log.borrow().clone(),"observation_mode":"retained_scope_components","status":"retained_scope_component_observation_not_qualification"});
    observed["schema_version"] = json!(1);
    observed["confinementObservation"]["code"] =
        json!(confinement_code(refusal).ok_or("retained scope refusal code absent")?);
    observed["engine_revision"] = json!(identity::ENGINE_REVISION);
    observed["engine_upstream_revision"] = json!(identity::ENGINE_UPSTREAM_REVISION);
    observed["native_compiler_version"] = json!(core::version());
    observed["ambient_cwd"] = json!(std::env::current_dir().map_err(|e| e.to_string())?);
    observed["ambient_native_case_sensitive"] =
        json!(ts_goport::frontend::vfs::osvfs_fs().use_case_sensitive_file_names());
    Ok(observed)
}

pub(super) fn inspect(
    request: &Request,
    sdk: &Sdk,
    graph: &Value,
    broad: &Value,
    expected_input_manifest_id: &str,
) -> Result<Value, String> {
    if broad["executed"] != true || broad["unsupported"] != json!([]) {
        return Err("retained scope discovery incomplete".into());
    }
    if identity::digest(&batch::input_manifest(request, sdk)?) != expected_input_manifest_id {
        return Err("retained scope input differs from accepted index".into());
    }
    let mut full = request.clone();
    full.roots = request
        .files
        .keys()
        .filter(|p| source(p) && !declaration(p))
        .cloned()
        .collect();
    let observation = match analyze(full.clone(), sdk.clone()) {
        Ok(observation) => observation,
        Err(error) if confinement_code(&error).is_some() => {
            full.qualified = false;
            components_after_refusal(&full, sdk, &error)?
        }
        Err(error) => return Err(error),
    };
    validate_observation(&full, sdk, &observation, expected_input_manifest_id)?;
    let mut decl = request.clone();
    decl.roots = request
        .files
        .keys()
        .filter(|p| declaration(p))
        .cloned()
        .collect();
    decl.qualified = false;
    let declarations = if decl.roots.is_empty() {
        Value::Null
    } else {
        let observed = match analyze_internal(decl.clone(), sdk.clone(), true, false) {
            Ok(observed) => observed,
            Err(error) if confinement_code(&error).is_some() => {
                components_after_refusal(&decl, sdk, &error)?
            }
            Err(error) => return Err(error),
        };
        validate_observation(&decl, sdk, &observed, expected_input_manifest_id)?;
        observed
    };
    let policy = ExternalPolicy::capture(request)?;
    let mut links = vec![];
    let mut reasons = vec![];
    let mut confinement_refused = false;
    for observed in [&observation, &declarations] {
        if observed["observation_mode"] != "retained_scope_components" {
            continue;
        }
        let guard = &observed["confinementObservation"];
        let code = guard["error"]
            .as_str()
            .and_then(confinement_code)
            .ok_or("retained scope confinement error absent")?;
        if guard["executed"] != true
            || guard["state"] != "refused"
            || guard["code"] != code
            || observed["extraction_executed"] != false
        {
            return Err("retained scope confinement refusal incomplete".into());
        }
        confinement_refused = true;
    }
    if confinement_refused {
        reasons.push("DEPENDENCY_SCOPE_OUTSIDE_REPOSITORY".into());
        for file in broad["files"]
            .as_array()
            .ok_or("retained broad files absent")?
        {
            if file["language"] == "typescript" {
                reasons.push(format!(
                    "DEPENDENCY_SCOPE_UNREADABLE:{}",
                    text(file, "relPath")?
                ));
            }
        }
    }
    let mut external = BTreeSet::new();
    let mut unresolved = vec![];
    for import in observation["raw_extraction"]["imports"]
        .as_array()
        .ok_or("retained native imports missing")?
        .iter()
        .filter(|_| !confinement_refused)
    {
        let from = text(import, "fromRelPath")?;
        let specifier = text(import, "moduleSpecifier")?;
        if let Some(to) = import["resolvedRelPath"].as_str() {
            links.push(json!([from, to]));
        }
        if policy.external(specifier, from) {
            external.insert(specifier.to_string());
        } else if !import["resolvedRelPath"].is_string() {
            reasons.push(format!(
                "DEPENDENCY_SCOPE_UNRESOLVED_IMPORT:{from}:{specifier}"
            ));
            unresolved.push(json!({"path":from,"specifier":specifier}));
        }
    }
    for edge in graph["edges"]
        .as_array()
        .ok_or("retained graph edges missing")?
    {
        if !["imports", "exports", "calls", "depends_on"]
            .contains(&edge["kind"].as_str().unwrap_or(""))
        {
            continue;
        }
        let nodes = graph["nodes"]
            .as_array()
            .ok_or("retained graph nodes missing")?;
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
    for candidate in broad["candidates"]
        .as_array()
        .ok_or("retained candidates missing")?
    {
        let reason = text(candidate, "reason")?;
        if reason == "READ_FAILED" || reason.ends_with("OUTSIDE_REPOSITORY") {
            reasons.push(format!(
                "DEPENDENCY_SCOPE_UNREADABLE:{}",
                text(candidate, "relPath")?
            ));
        }
    }
    for file in broad["files"]
        .as_array()
        .ok_or("retained discovered files missing")?
    {
        if file["role"] == "migration" && file["language"] == "typescript" {
            reasons.push(format!(
                "DEPENDENCY_SCOPE_MIGRATION_SOURCE_UNSUPPORTED:{}",
                text(file, "relPath")?
            ));
        }
    }
    let normalizer = CaptureFs::new(BTreeMap::new(), request.case_sensitive);
    let keys = request
        .files
        .keys()
        .map(|p| normalizer.key(p))
        .collect::<BTreeSet<_>>();
    let _program = core::enter_program(None);
    let mut sources = vec![];
    for (path, content) in request.files.iter().filter(|(p, _)| source(p)) {
        let relative = relative_source_path(&request.cwd, path, request.case_sensitive)?;
        let subjects = if declaration(path) {
            &declarations["subjects"]
        } else {
            &observation["subjects"]
        };
        let subject = subjects
            .as_array()
            .ok_or("retained native subjects missing")?
            .iter()
            .find(|s| s["path"] == relative)
            .ok_or("retained native subject missing")?;
        if declaration(path) {
            reasons.push(format!(
                "DEPENDENCY_SCOPE_DECLARATION_UNSUPPORTED:{relative}"
            ));
        }
        let native = &subject["javascript"]["native"];
        if native["commonJsUnsupported"] == true {
            reasons.push(format!("DEPENDENCY_SCOPE_COMMONJS_UNSUPPORTED:{relative}"));
        }
        if native["runtimeEvaluationUnsupported"] == true {
            reasons.push(format!("DEPENDENCY_SCOPE_RUNTIME_CODE:{relative}"));
        }
        for member in native["unmodeledMembers"]
            .as_array()
            .ok_or("retained native members missing")?
        {
            reasons.push(format!(
                "DEPENDENCY_SCOPE_NATIVE_MODULE_MEMBER_UNSUPPORTED:{relative}:{}",
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
                return Err("retained scope component incomplete".into());
            }
            for reason in component["reasons"]
                .as_array()
                .ok_or("retained component reasons missing")?
            {
                reasons.push(format!(
                    "{prefix}:{relative}:{}",
                    reason.as_str().ok_or("invalid component reason")?
                ));
            }
        }
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
                file_name: path.clone(),
                path: CompilerPath(path.clone()),
                ..Default::default()
            },
            ast::FileText::new(content.clone(), false),
            kind,
        );
        let mut syntax = vec![];
        visit(parsed.root, &relative, &mut syntax);
        reasons.extend(syntax.iter().cloned());
        let mut references = vec![];
        for reference in &parsed.referenced_files {
            let target = Path::new(path)
                .parent()
                .ok_or("retained source parent absent")?
                .join(&reference.file_name)
                .to_string_lossy()
                .replace('\\', "/");
            let key = normalizer.key(&target);
            let retained = keys.contains(&key);
            if !retained {
                reasons.push(format!(
                    "DEPENDENCY_SCOPE_UNRETAINED_REFERENCE:{relative}:{}",
                    reference.file_name
                ));
            }
            references.push(
                json!({"file_name":reference.file_name,"target_key":key,"retained":retained}),
            );
        }
        sources.push(json!({"path":relative,"source_sha256":identity::digest_bytes(content.as_bytes()),"references":references,"syntax_reasons":syntax,"has_parse_diagnostics":!ast::source_file_diagnostics(parsed.root).is_empty()}));
    }
    Ok(
        json!({"projection":{"links":links,"reasons":reasons,"externalModuleSpecifiers":external,"unresolvedImports":unresolved},"full_analysis":observation,"declaration_analysis":declarations,"sources":sources,"metadata_reads":policy.reads,"graph_id":identity::digest(graph),"input_manifest_id":expected_input_manifest_id,"sdk_input_id":identity::digest(&serde_json::to_value(sdk).map_err(|e|e.to_string())?),"global_admission_inferred":false}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request() -> (Request, Sdk) {
        let sdk = serde_json::from_slice(
            &std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/sdk/sdk-input.json")).unwrap(),
        )
        .unwrap();
        let request = serde_json::from_value(json!({"id":"retained-scope-native-regression","cwd":"/scope","sdk_directory":"/sdk/lib","case_sensitive":ts_goport::frontend::vfs::osvfs_fs().use_case_sensitive_file_names(),"files":{"/scope/main.ts":"export {watch} from './monitor';","/scope/monitor.ts":"export function watch(name:string){ return import(name); }","/scope/ambient.d.ts":"declare const ambientFlag: boolean;"},"roots":["/scope/main.ts"],"options":{"target":"ES2022","module":"ESNext","moduleResolution":"Bundler","allowJs":true,"jsx":"Preserve","skipLibCheck":true,"noEmit":true,"strict":false},"retained":true,"qualified":true})).unwrap();
        (request, sdk)
    }

    fn broad() -> Value {
        json!({"executed":true,"unsupported":[],"files":[],"candidates":[]})
    }

    #[test]
    fn retained_scope_outside_declaration_refuses_whole_import_projection() {
        let (mut request, sdk) = request();
        request.files.remove("/scope/monitor.ts");
        request
            .files
            .insert("/scope/main.ts".into(), "export const stable=1;".into());
        request.files.insert(
            "/scope/a.ts".into(),
            "import 'opaque'; import './missing'; export {x} from './b';".into(),
        );
        request
            .files
            .insert("/scope/b.ts".into(), "export const x=1;".into());
        request.files.insert(
            "/scope/package.json".into(),
            r#"{"dependencies":{"opaque":"1"}}"#.into(),
        );
        let graph = json!({"nodes":[{"id":"a","filePath":"graph-a.ts"},{"id":"b","filePath":"graph-b.ts"}],"edges":[{"kind":"calls","from":"a","to":"b"}]});
        let id = identity::digest(&batch::input_manifest(&request, &sdk).unwrap());
        let healthy = inspect(&request, &sdk, &graph, &broad(), &id).unwrap();
        assert!(
            healthy["projection"]["links"]
                .as_array()
                .unwrap()
                .contains(&json!(["a.ts", "b.ts"]))
        );
        assert_eq!(
            healthy["projection"]["externalModuleSpecifiers"],
            json!(["opaque"])
        );
        assert_eq!(
            healthy["projection"]["unresolvedImports"],
            json!([{"path":"a.ts","specifier":"./missing"}])
        );
        request.files.insert(
            "/scope/ambient.d.ts".into(),
            "/// <reference path=\"../outside.d.ts\" />\ndeclare const ambientFlag: boolean;"
                .into(),
        );
        let id = identity::digest(&batch::input_manifest(&request, &sdk).unwrap());
        let refused = inspect(&request, &sdk, &graph, &broad(), &id).unwrap();
        assert_eq!(
            refused["projection"]["links"],
            json!([["graph-a.ts", "graph-b.ts"]]),
            "whole extraction refusal must preserve only the accepted graph links"
        );
        assert_eq!(refused["projection"]["externalModuleSpecifiers"], json!([]));
        assert_eq!(refused["projection"]["unresolvedImports"], json!([]));
        assert!(
            !refused["full_analysis"]["raw_extraction"]["imports"]
                .as_array()
                .unwrap()
                .is_empty(),
            "actual source-only observation must remain intact"
        );
    }

    #[test]
    fn retained_scope_outside_import_preserves_exact_confinement_family() {
        let (mut request, sdk) = request();
        request.files.remove("/scope/ambient.d.ts");
        request
            .files
            .insert("/scope/main.ts".into(), "export const stable=1;".into());
        request.files.insert(
            "/scope/monitor.ts".into(),
            "import '../outside.ts'; export const monitor=1;".into(),
        );
        let id = identity::digest(&batch::input_manifest(&request, &sdk).unwrap());
        let result = inspect(
            &request,
            &sdk,
            &json!({"nodes":[],"edges":[]}),
            &broad(),
            &id,
        )
        .expect("outside import must retain scope rejection DTO");
        assert_eq!(
            result["full_analysis"]["confinementObservation"]["code"],
            "IMPORT_OUTSIDE_REPOSITORY"
        );
        assert_eq!(
            result["full_analysis"]["confinementObservation"]["error"],
            "IMPORT_OUTSIDE_REPOSITORY: ../outside.ts"
        );
        assert_eq!(result["full_analysis"]["extraction_executed"], false);
        assert!(
            result["projection"]["reasons"]
                .as_array()
                .unwrap()
                .contains(&json!("DEPENDENCY_SCOPE_OUTSIDE_REPOSITORY"))
        );
    }

    #[test]
    fn retained_scope_outside_declaration_reference_preserves_projection_and_refusal() {
        let (mut request, sdk) = request();
        request.files.remove("/scope/monitor.ts");
        request
            .files
            .insert("/scope/main.ts".into(), "export const stable=1;".into());
        request.files.insert(
            "/scope/ambient.d.ts".into(),
            "/// <reference path=\"../outside.d.ts\" />\ndeclare const ambientFlag: boolean;"
                .into(),
        );
        let id = identity::digest(&batch::input_manifest(&request, &sdk).unwrap());
        let result = inspect(
            &request,
            &sdk,
            &json!({"nodes":[],"edges":[]}),
            &broad(),
            &id,
        )
        .expect("outside declaration reference must retain scope DTO");
        for field in [
            "links",
            "reasons",
            "externalModuleSpecifiers",
            "unresolvedImports",
        ] {
            assert!(result["projection"][field].is_array());
        }
        let reasons = result["projection"]["reasons"].as_array().unwrap();
        assert!(reasons.contains(&json!(
            "DEPENDENCY_SCOPE_DECLARATION_UNSUPPORTED:ambient.d.ts"
        )));
        assert!(reasons.contains(&json!(
            "DEPENDENCY_SCOPE_UNRETAINED_REFERENCE:ambient.d.ts:../outside.d.ts"
        )));
        assert_eq!(
            result["declaration_analysis"]["confinementObservation"]["state"],
            "refused"
        );
        assert_eq!(result["declaration_analysis"]["extraction_executed"], false);
    }

    #[test]
    fn retained_scope_outside_reference_keeps_javascript_inventory_components() {
        let (mut request, sdk) = request();
        request.files.remove("/scope/ambient.d.ts");
        request
            .files
            .insert("/scope/main.ts".into(), "export const stable=1;".into());
        request.files.insert(
            "/scope/monitor.ts".into(),
            "/// <reference path=\"../outside.ts\" />\nexport const monitor=1;".into(),
        );
        request
            .files
            .insert("/scope/util.js".into(), "export const okay=1;".into());
        let id = identity::digest(&batch::input_manifest(&request, &sdk).unwrap());
        let result = inspect(
            &request,
            &sdk,
            &json!({"nodes":[],"edges":[]}),
            &broad(),
            &id,
        )
        .expect("mixed TS/JS refusal must retain scope DTO");
        assert!(
            result["projection"]["reasons"]
                .as_array()
                .unwrap()
                .contains(&json!(
                    "DEPENDENCY_SCOPE_UNRETAINED_REFERENCE:monitor.ts:../outside.ts"
                ))
        );
        assert!(
            result["full_analysis"]["subjects"]
                .as_array()
                .unwrap()
                .iter()
                .any(|s| s["path"] == "util.js")
        );
        assert_eq!(
            result["full_analysis"]["confinementObservation"]["state"],
            "refused"
        );
        assert_eq!(result["full_analysis"]["extraction_executed"], false);
        assert_eq!(result["sources"].as_array().unwrap().len(), 3);
    }

    #[test]
    fn retained_scope_projects_declaration_and_reached_computed_import_from_full_capture() {
        let (request, sdk) = request();
        let id = identity::digest(&batch::input_manifest(&request, &sdk).unwrap());
        let result = inspect(
            &request,
            &sdk,
            &json!({"nodes":[],"edges":[]}),
            &broad(),
            &id,
        )
        .unwrap();
        let projection = &result["projection"];
        assert_eq!(projection["externalModuleSpecifiers"], json!([]));
        assert_eq!(projection["unresolvedImports"], json!([]));
        assert!(
            projection["links"]
                .as_array()
                .unwrap()
                .contains(&json!(["main.ts", "monitor.ts"]))
        );
        let reasons = projection["reasons"].as_array().unwrap();
        assert!(reasons.contains(&json!("DEPENDENCY_SCOPE_COMPUTED_IMPORT:monitor.ts")));
        assert!(reasons.contains(&json!(
            "DEPENDENCY_SCOPE_DECLARATION_UNSUPPORTED:ambient.d.ts"
        )));
        assert_eq!(
            result["declaration_analysis"]["observation_mode"],
            "declaration_roots"
        );
        assert_eq!(
            result["input_manifest_id"],
            result["full_analysis"]["input_manifest_id"]
        );
        assert_eq!(
            result["input_manifest_id"],
            result["declaration_analysis"]["input_manifest_id"]
        );
        assert_eq!(result["sources"].as_array().unwrap().len(), 3);
        let mut omitted = request.clone();
        omitted.files.remove("/scope/ambient.d.ts");
        assert!(
            inspect(
                &omitted,
                &sdk,
                &json!({"nodes":[],"edges":[]}),
                &broad(),
                &id
            )
            .is_err()
        );
        let mut omitted_source = request.clone();
        omitted_source.files.remove("/scope/monitor.ts");
        assert!(
            inspect(
                &omitted_source,
                &sdk,
                &json!({"nodes":[],"edges":[]}),
                &broad(),
                &id
            )
            .is_err()
        );
        let mut foreign_metadata = request.clone();
        foreign_metadata
            .files
            .insert("/scope/package.json".into(), "{}".into());
        assert!(
            inspect(
                &foreign_metadata,
                &sdk,
                &json!({"nodes":[],"edges":[]}),
                &broad(),
                &id
            )
            .is_err()
        );
        let mut foreign = sdk.clone();
        foreign
            .files
            .remove(foreign.files.keys().next().unwrap().clone().as_str());
        assert!(
            inspect(
                &request,
                &foreign,
                &json!({"nodes":[],"edges":[]}),
                &broad(),
                &id
            )
            .is_err()
        );
    }

    #[test]
    fn retained_scope_keeps_malformed_ast_reasons_and_missing_reference() {
        let (mut request, sdk) = request();
        request.files.remove("/scope/ambient.d.ts");
        request.files.insert(
            "/scope/monitor.ts".into(),
            "/// <reference path=\"./missing.ts\" />\nimport(name); export function broken( {"
                .into(),
        );
        let id = identity::digest(&batch::input_manifest(&request, &sdk).unwrap());
        let result = inspect(
            &request,
            &sdk,
            &json!({"nodes":[],"edges":[]}),
            &broad(),
            &id,
        )
        .unwrap();
        let reasons = result["projection"]["reasons"].as_array().unwrap();
        assert!(reasons.contains(&json!("DEPENDENCY_SCOPE_COMPUTED_IMPORT:monitor.ts")));
        assert!(reasons.contains(&json!(
            "DEPENDENCY_SCOPE_UNRETAINED_REFERENCE:monitor.ts:./missing.ts"
        )));
        assert!(reasons.iter().any(|r| {
            r.as_str()
                .unwrap()
                .starts_with("DEPENDENCY_SCOPE_PARSE_FAILED:monitor.ts:")
        }));
        let mut full_request = request.clone();
        full_request.roots = request.files.keys().cloned().collect();
        assert!(validate_observation(&full_request, &sdk, &result["full_analysis"], &id).is_ok());
        let mut dropped = result["full_analysis"].clone();
        dropped["complete"] = json!(false);
        assert!(validate_observation(&full_request, &sdk, &dropped, &id).is_err());
    }

    #[test]
    fn retained_scope_external_policy_uses_captured_packages_and_aliases() {
        let (mut request, _) = request();
        request.files.insert(
            "/scope/package.json".into(),
            r#"{"dependencies":{"opaque":"1","internal":"workspace:*","aliased":"1"}}"#.into(),
        );
        request.files.insert(
            "/scope/tsconfig.json".into(),
            r#"{"compilerOptions":{"paths":{"aliased":["./monitor.ts"]}}}"#.into(),
        );
        let policy = ExternalPolicy::capture(&request).unwrap();
        assert!(policy.external("opaque/subpath", "main.ts"));
        assert!(policy.external("node:fs", "main.ts"));
        assert!(!policy.external("internal", "main.ts"));
        assert!(!policy.external("aliased", "main.ts"));
        assert!(!policy.external("./opaque", "main.ts"));
        request.files.insert(
            "/scope/nested/package.json".into(),
            r#"{"name":"opaque"}"#.into(),
        );
        assert!(
            !ExternalPolicy::capture(&request)
                .unwrap()
                .external("opaque", "main.ts")
        );
    }
}
