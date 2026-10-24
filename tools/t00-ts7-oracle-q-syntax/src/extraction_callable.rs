use serde_json::{Value, json};
use std::{collections::BTreeMap, rc::Rc};
use ts_goport::{
    frontend::{compiler, tsoptions, tspath::ComparePathsOptions},
    prelude::*,
};

#[path = "extraction_files.rs"]
mod files;

fn callable_declaration(node: Node) -> bool {
    match node.kind() {
        SyntaxKind::FunctionDeclaration => node.body().is_some(),
        SyntaxKind::ClassDeclaration => true,
        SyntaxKind::MethodDeclaration => matches!(
            node.parent().kind(),
            SyntaxKind::ClassDeclaration | SyntaxKind::ClassExpression
        ),
        SyntaxKind::VariableDeclaration => {
            node.name().kind() == SyntaxKind::Identifier
                && matches!(
                    node.initializer().kind(),
                    SyntaxKind::ArrowFunction | SyntaxKind::FunctionExpression
                )
        }
        _ => false,
    }
}

fn unwrap(mut node: Node) -> Node {
    while matches!(
        node.kind(),
        SyntaxKind::ParenthesizedExpression
            | SyntaxKind::AsExpression
            | SyntaxKind::TypeAssertionExpression
            | SyntaxKind::NonNullExpression
            | SyntaxKind::SatisfiesExpression
    ) {
        node = node.expression();
    }
    node
}

fn coordinate(expression: Node, checker: &mut Checker) -> Value {
    let mut receiver = unwrap(expression);
    while matches!(
        receiver.kind(),
        SyntaxKind::PropertyAccessExpression | SyntaxKind::ElementAccessExpression
    ) {
        receiver = unwrap(receiver.expression());
    }
    let origin = checker.get_symbol_at_location_exported(receiver);
    if origin.is_some()
        && checker
            .sym(origin)
            .declarations
            .iter()
            .any(|declaration| match declaration.kind() {
                SyntaxKind::ImportSpecifier | SyntaxKind::ImportClause => {
                    declaration.is_type_only()
                }
                SyntaxKind::NamespaceImport => declaration.parent().is_type_only(),
                _ => false,
            })
    {
        return json!({"state":"undefined"});
    }
    let mut symbol = checker.get_symbol_at_location_exported(expression);
    if symbol.is_nil() {
        return json!({"state":"undefined"});
    }
    if checker.sym(symbol).flags.intersects(SymbolFlags::ALIAS) {
        symbol = checker.get_aliased_symbol(symbol);
    }
    if symbol.is_nil() {
        return json!({"state":"undefined"});
    }
    let declaration = checker
        .sym(symbol)
        .declarations
        .iter()
        .copied()
        .find(|declaration| callable_declaration(*declaration));
    let Some(declaration) = declaration else {
        return json!({"state":"undefined"});
    };
    let file = get_source_file_of_node(declaration);
    let mut names = super::scope(declaration, true);
    let Some(name) = super::owner_name(declaration) else {
        return json!({"state":"undefined"});
    };
    names.push(name);
    json!({"relPath":source_file_file_name(file).trim_start_matches("/project/"),"symbolPath":names.join(".")})
}

fn visit(node: Node, checker: &mut Checker, variables: &mut Vec<Value>) {
    if node.kind() == SyntaxKind::VariableDeclaration
        && node.name().kind() == SyntaxKind::Identifier
    {
        let value = if node.initializer().is_nil() {
            json!({"state":"no_initializer"})
        } else {
            coordinate(node.initializer(), checker)
        };
        variables.push(json!({"name":node.name().text(),"coordinate":value}));
    }
    node.for_each_child(|child| {
        visit(child, checker, variables);
        false
    });
}

fn opaque_calls(
    node: Node,
    source: Node,
    checker: &mut Checker,
    calls: &mut Vec<Value>,
    callbacks: &mut Vec<bool>,
) {
    if node.kind() == SyntaxKind::CallExpression {
        let expression = unwrap(node.expression());
        let name = match expression.kind() {
            SyntaxKind::Identifier => Some(expression.text()),
            SyntaxKind::PropertyAccessExpression => Some(expression.name().text()),
            _ => None,
        };
        if let Some(name) = name {
            let target = coordinate(expression, checker);
            let mut call = json!({"calleeName":name,"callerRelPath":source_file_file_name(source).trim_start_matches("/project/"),"line":super::line(source, ts_goport::scanner_util::get_token_pos_of_node(node, source, false))});
            let mut parent = node.parent();
            while parent.is_some() {
                if matches!(
                    parent.kind(),
                    SyntaxKind::FunctionDeclaration
                        | SyntaxKind::ClassDeclaration
                        | SyntaxKind::VariableDeclaration
                ) && let Some(name) = super::owner_name(parent)
                {
                    let mut names = super::scope(parent, false);
                    names.push(name);
                    call["callerSymbolPath"] = json!(names.join("."));
                    break;
                }
                parent = parent.parent();
            }
            if super::object_member_ancestor(node) {
                call["callerUnmodeledReason"] = json!("OBJECT_LITERAL_MEMBER");
            }
            if target.get("relPath").is_some() {
                call["calleeRelPath"] = target["relPath"].clone();
                call["calleeSymbolPath"] = target["symbolPath"].clone();
            }
            calls.push(call);
        }
        for argument in node.arguments() {
            if matches!(
                argument.kind(),
                SyntaxKind::ArrowFunction | SyntaxKind::FunctionExpression
            ) {
                let mut inner_calls = Vec::new();
                opaque_calls(
                    argument.body(),
                    source,
                    checker,
                    &mut inner_calls,
                    &mut Vec::new(),
                );
                callbacks.push(
                    !inner_calls.is_empty()
                        && inner_calls
                            .iter()
                            .all(|call| call.get("calleeRelPath").is_some()),
                );
            }
        }
    }
    node.for_each_child(|child| {
        opaque_calls(child, source, checker, calls, callbacks);
        false
    });
}

fn complete_import_clause(node: Node) -> Result<Node, String> {
    let clause = node.import_clause();
    if clause.is_some() && (clause.is_type_only() || clause.named_bindings().is_some()) {
        return Err("full extraction oracle supports runtime default imports only".into());
    }
    if node.module_specifier().kind() != SyntaxKind::StringLiteral {
        return Err("full extraction oracle requires literal static imports".into());
    }
    Ok(clause)
}

fn complete_imports(
    node: Node,
    source: Node,
    checker: &mut Checker,
    imports: &mut Vec<Value>,
) -> Result<(), String> {
    if node.kind() == SyntaxKind::ImportDeclaration {
        let clause = complete_import_clause(node)?;
        let literal = node.module_specifier();
        let mut targets = Vec::new();
        if clause.is_some() && clause.name().is_some() {
            let target = coordinate(clause.name(), checker);
            if target.get("relPath").is_some() {
                targets.push(target);
            }
        }
        let mut import = json!({"fromRelPath":source_file_file_name(source).trim_start_matches("/project/"),"moduleSpecifier":literal.text(),"names":super::import_names(node),"bindingTargets":targets,"line":super::line(source,ts_goport::scanner_util::get_token_pos_of_node(node,source,false))});
        let symbol = checker.get_symbol_at_location_exported(literal);
        if symbol.is_some()
            && let Some(declaration) = checker.sym(symbol).declarations.first()
        {
            let file = get_source_file_of_node(*declaration);
            if file.is_some() {
                import["resolvedRelPath"] =
                    json!(source_file_file_name(file).trim_start_matches("/project/"));
            }
        }
        imports.push(import);
    }
    for child in node.iter_children() {
        complete_imports(child, source, checker, imports)?;
    }
    Ok(())
}

fn complete_extraction(roots: &[String]) -> Result<Value, String> {
    let mut output = json!({"modules":[],"symbols":[],"imports":[],"calls":[],"functionOwners":[]});
    let mut construction = false;
    for path in roots {
        let file = source_files()
            .into_iter()
            .find(|file| source_file_file_name(*file) == path)
            .ok_or("full extraction root not loaded")?;
        if path.ends_with(".d.ts") || path.ends_with(".d.mts") || path.ends_with(".d.cts") {
            continue;
        }
        let relative = path.trim_start_matches("/project/");
        let text = source_file_text(file);
        let mut facts = json!({"symbols":[],"imports":[],"calls":[],"functionOwners":[]});
        super::walk(file, file, &text, relative, true, &mut facts);
        let (calls, imports, has_construction) =
            with_type_checker_for_file(file, move |checker| {
                let mut calls = Vec::new();
                opaque_calls(file, file, checker, &mut calls, &mut Vec::new());
                let mut imports = Vec::new();
                complete_imports(file, file, checker, &mut imports)?;
                fn has_new(node: Node) -> bool {
                    node.kind() == SyntaxKind::NewExpression || node.iter_children().any(has_new)
                }
                Ok::<_, String>((calls, imports, has_new(file)))
            })?;
        construction |= has_construction;
        output["modules"]
            .as_array_mut()
            .unwrap()
            .push(json!(relative));
        for field in ["symbols", "functionOwners"] {
            output[field]
                .as_array_mut()
                .unwrap()
                .extend(facts[field].as_array().unwrap().iter().cloned());
        }
        output["calls"].as_array_mut().unwrap().extend(calls);
        output["imports"].as_array_mut().unwrap().extend(imports);
    }
    let mut integrity = BTreeMap::<String, Vec<String>>::new();
    let mut edges = std::collections::BTreeSet::new();
    for call in output["calls"].as_array().unwrap() {
        let path = call["callerRelPath"].as_str().unwrap();
        if let Some(reason) = call["callerUnmodeledReason"].as_str() {
            integrity.entry(path.to_owned()).or_default().push(format!(
                "QUALIFIED_CALL_COORDINATE_CALLER_UNMODELED:{path}:{reason}"
            ));
        } else if let (Some(owner), Some(target_path), Some(target)) = (
            call["callerSymbolPath"].as_str(),
            call["calleeRelPath"].as_str(),
            call["calleeSymbolPath"].as_str(),
        ) {
            edges.insert((
                path.to_owned(),
                owner.to_owned(),
                target_path.to_owned(),
                target.to_owned(),
            ));
        }
    }
    for reasons in integrity.values_mut() {
        reasons.sort();
        reasons.dedup();
    }
    output["integrityReasons"] = json!(integrity);
    output["callEdgeCount"] = json!(edges.len());
    output["constructionReason"] = json!(construction);
    Ok(output)
}

pub fn observe(input: &Value) -> Result<Value, String> {
    let input_files = input["files"]
        .as_object()
        .ok_or("callable oracle requires files")?;
    let selected = input["filename"]
        .as_str()
        .ok_or("callable oracle requires filename")?;
    let mut files = BTreeMap::new();
    for (path, text) in input_files {
        if path.starts_with('/')
            || path
                .split('/')
                .any(|part| part == "." || part == ".." || part.is_empty())
        {
            return Err("callable oracle files require relative canonical paths".into());
        }
        files.insert(
            format!("/project/{path}"),
            text.as_str()
                .ok_or("callable oracle requires source strings")?
                .to_owned(),
        );
    }
    let selected = format!("/project/{selected}");
    if !files.contains_key(&selected) {
        return Err("callable oracle selected file missing".into());
    }
    let mut roots: Vec<String> = files
        .keys()
        .filter(|path| {
            [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"]
                .iter()
                .any(|extension| path.ends_with(extension))
        })
        .cloned()
        .collect();
    if input["completeExtraction"].as_bool() == Some(true) && input["roots"].as_array().is_none() {
        return Err("full extraction requires root array".into());
    }
    if let Some(supplied) = input["roots"].as_array() {
        if supplied.is_empty() {
            return Err("full extraction requires nonempty roots".into());
        }
        roots = supplied
            .iter()
            .map(|root| {
                let path = format!(
                    "/project/{}",
                    root.as_str()
                        .ok_or("full extraction roots require strings")?
                );
                if !files.contains_key(&path) {
                    return Err("full extraction root not captured");
                }
                Ok(path)
            })
            .collect::<Result<Vec<_>, _>>()?;
    }
    let sdk_path = input["sdk_input"]
        .as_str()
        .ok_or("callable oracle requires sdk_input")?;
    let sdk: Value =
        serde_json::from_slice(&std::fs::read(sdk_path).map_err(|error| error.to_string())?)
            .map_err(|error| error.to_string())?;
    let sdk_files = sdk["files"]
        .as_object()
        .ok_or("callable oracle requires SDK files")?;
    if sdk["version"] != "7.1.0-dev" || sdk_files.len() != 115 {
        return Err("callable oracle requires pinned SDK115".into());
    }
    let extraction_roots = roots.clone();
    for (path, text) in sdk_files {
        if !path.starts_with("/sdk/lib/lib") || !path.ends_with(".d.ts") {
            return Err("callable oracle SDK path mismatch".into());
        }
        files.insert(
            path.clone(),
            text.as_str()
                .ok_or("callable SDK requires text")?
                .to_owned(),
        );
    }
    let options = CompilerOptions {
        target: ScriptTarget::ES2022,
        module: ModuleKind::ES_NEXT,
        module_resolution: ModuleResolutionKind::BUNDLER,
        allow_js: Tristate::True,
        jsx: JsxEmit::PRESERVE,
        skip_lib_check: Tristate::True,
        no_emit: Tristate::True,
        strict: Tristate::False,
        ..Default::default()
    };
    let config = Rc::new(tsoptions::new_parsed_command_line(
        Rc::new(options),
        roots,
        None,
        ComparePathsOptions {
            use_case_sensitive_file_names: true,
            current_directory: "/project".into(),
        },
    ));
    let host = compiler::new_compiler_host(
        "/project",
        Rc::new(files::Files(files)),
        "/sdk/lib",
        None,
        None,
        None,
    );
    install_new_program(compiler::ProgramOptions {
        host,
        config,
        use_source_of_project_reference: false,
        single_threaded: Tristate::True,
        typings_location: String::new(),
        project_name: String::new(),
        create_module_resolver: None,
        skip_module_resolution: false,
    })?;
    if input["completeExtraction"].as_bool() == Some(true) {
        return complete_extraction(&extraction_roots);
    }
    let file = source_files()
        .into_iter()
        .find(|file| source_file_file_name(*file) == selected)
        .ok_or("callable oracle selected source not loaded")?;
    let opaque_ownership = input["opaqueOwnership"].as_bool() == Some(true);
    let observation = with_type_checker_for_file(file, move |checker| {
        let mut variables = Vec::new();
        visit(file, checker, &mut variables);
        let mut result = json!({"executed":true,"unsupported":[],"variables":variables});
        if opaque_ownership {
            let mut calls = Vec::new();
            let mut callbacks = Vec::new();
            opaque_calls(file, file, checker, &mut calls, &mut callbacks);
            result["calls"] = json!(calls);
            result["beforeOpaqueReason"] = json!(!callbacks.is_empty());
            result["afterOpaqueReason"] = json!(callbacks.iter().any(|owned| !owned));
            result["removedOpaqueReason"] = json!(!callbacks.is_empty());
        }
        result
    });
    Ok(observation)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ts_goport::{
        ast::FileText,
        frontend::parser::{SourceFileParseOptions, parse_source_file},
    };

    #[test]
    fn full_extraction_accepts_runtime_default_imports_and_refuses_uncovered_forms() {
        let parsed = parse_source_file(
            &SourceFileParseOptions { file_name: "imports.ts".into(), ..Default::default() },
            FileText::new("import value from './value'; import './side'; import type erased from './value'; import { value } from './value'; import invalid from 1;".into(), false),
            ScriptKind::TS,
        );
        let imports = parsed.root.statement_list().nodes();
        assert!(complete_import_clause(imports.get(0)).is_ok());
        assert!(complete_import_clause(imports.get(1)).is_ok());
        assert!(complete_import_clause(imports.get(2)).is_err());
        assert!(complete_import_clause(imports.get(3)).is_err());
        assert!(complete_import_clause(imports.get(4)).is_err());
    }

    #[test]
    fn ts7_declarations_distinguish_eligible_callables_from_signatures_and_data() {
        let parsed = parse_source_file(
            &SourceFileParseOptions { file_name: "main.ts".into(), ..Default::default() },
            FileText::new("function implementation() {} declare function signature(): void; class Service { method() {} get value() { return 1; } } const arrow = () => 1, expression = function() {}, data = 1, wrapped = (() => 1);".into(), false),
            ScriptKind::TS,
        );
        fn declarations(node: Node, result: &mut Vec<(String, bool)>) {
            if matches!(
                node.kind(),
                SyntaxKind::FunctionDeclaration
                    | SyntaxKind::ClassDeclaration
                    | SyntaxKind::MethodDeclaration
                    | SyntaxKind::GetAccessor
                    | SyntaxKind::VariableDeclaration
            ) {
                result.push((node.name().text().into(), callable_declaration(node)));
            }
            node.for_each_child(|child| {
                declarations(child, result);
                false
            });
        }
        let mut got = Vec::new();
        declarations(parsed.root, &mut got);
        assert_eq!(
            got,
            vec![
                ("implementation".into(), true),
                ("signature".into(), false),
                ("Service".into(), true),
                ("method".into(), true),
                ("value".into(), false),
                ("arrow".into(), true),
                ("expression".into(), true),
                ("data".into(), false),
                ("wrapped".into(), false),
            ]
        );
    }

    #[test]
    fn missing_source_and_escaping_inputs_refuse_before_constructing_a_program() {
        for input in [
            json!({}),
            json!({"files":{},"filename":"main.ts"}),
            json!({"files":{"../main.ts":""},"filename":"main.ts"}),
            json!({"files":{"/project/main.ts":""},"filename":"main.ts"}),
            json!({"files":{"main.ts":null},"filename":"main.ts"}),
            json!({"files":{"main.ts":""},"filename":"main.ts"}),
            json!({"files":{"main.ts":""},"filename":"main.ts","completeExtraction":true}),
            json!({"files":{"main.ts":""},"filename":"main.ts","completeExtraction":true,"roots":[]}),
            json!({"files":{"main.ts":""},"filename":"main.ts","completeExtraction":true,"roots":[7]}),
            json!({"files":{"main.ts":""},"filename":"main.ts","completeExtraction":true,"roots":["absent.ts"]}),
        ] {
            assert!(observe(&input).is_err());
        }
    }

    #[test]
    fn sdk_read_decode_inventory_and_content_failures_remain_errors() {
        let directory =
            std::env::temp_dir().join(format!("t00-callable-sdk-failures-{}", std::process::id()));
        std::fs::create_dir(&directory).unwrap();
        let path = directory.join("sdk.json");
        let input = json!({"files":{"main.ts":""},"filename":"main.ts","sdk_input":path});
        assert!(observe(&input).is_err());
        for bytes in ["{", "null", "{}", "{\"files\":[]}"] {
            std::fs::write(&path, bytes).unwrap();
            assert!(observe(&input).is_err(), "{bytes}");
        }
        let valid_files = (0..115)
            .map(|index| (format!("/sdk/lib/lib.test{index}.d.ts"), json!("")))
            .collect::<serde_json::Map<_, _>>();
        for version in [json!(null), json!("5.9.3")] {
            std::fs::write(
                &path,
                json!({"version":version,"files":valid_files}).to_string(),
            )
            .unwrap();
            assert_eq!(
                observe(&input).unwrap_err(),
                "callable oracle requires pinned SDK115"
            );
        }
        std::fs::write(&path, json!({"version":"7.1.0-dev","files":{}}).to_string()).unwrap();
        assert_eq!(
            observe(&input).unwrap_err(),
            "callable oracle requires pinned SDK115"
        );
        for (entry, value, error) in [
            (
                "/outside.d.ts",
                json!(""),
                "callable oracle SDK path mismatch",
            ),
            (
                "/sdk/lib/lib.test0.d.ts",
                json!(null),
                "callable SDK requires text",
            ),
        ] {
            let mut files = valid_files.clone();
            files.remove("/sdk/lib/lib.test0.d.ts");
            files.insert(entry.into(), value);
            std::fs::write(
                &path,
                json!({"version":"7.1.0-dev","files":files}).to_string(),
            )
            .unwrap();
            assert_eq!(observe(&input).unwrap_err(), error);
        }
        std::fs::remove_dir_all(directory).unwrap();
    }
}
