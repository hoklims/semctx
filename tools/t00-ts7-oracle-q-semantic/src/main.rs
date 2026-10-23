mod facts;
mod files;
use facts::{signature, symbol};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{collections::BTreeMap, rc::Rc};
use ts_goport::{
    frontend::{compiler, tsoptions, tspath::ComparePathsOptions},
    prelude::*,
    scanner_util::get_token_pos_of_node,
};

#[derive(Deserialize)]
struct Request {
    files: BTreeMap<String, String>,
    #[serde(default)]
    roots: Vec<String>,
    options: Option<Value>,
}
#[derive(Deserialize)]
struct Sdk {
    version: String,
    files: BTreeMap<String, String>,
}

fn walk(node: Node, file: Node, checker: &mut Checker, nodes: &mut Vec<Value>) {
    let start = get_token_pos_of_node(node, file, false);
    let end = node.end();
    let source_text = source_file_text(file);
    let text = source_text
        .get(start.max(0) as usize..end.max(start) as usize)
        .unwrap_or_default();
    let parent_kind = node
        .parent()
        .is_some()
        .then(|| format!("{:?}", node.parent().kind()));
    let mut fact = json!({"kind":format!("{:?}",node.kind()),"start":start,"end":end,"text":text,"parentKind":parent_kind});
    fact["parent"] = facts::reference(node.parent(), file);
    fact["flagsBits"] = json!(node.flags().0);
    fact["modifierFlagsBits"] = json!(get_combined_modifier_flags(node).0);
    fact["fields"] = facts::syntax(node, file);
    let mut children = Vec::new();
    node.for_each_child(|child| {
        children.push(facts::reference(child, file));
        false
    });
    fact["children"] = json!(children);
    if matches!(
        node.kind(),
        SyntaxKind::PrefixUnaryExpression
            | SyntaxKind::PostfixUnaryExpression
            | SyntaxKind::TypeOperator
    ) {
        fact["operator"] = json!(format!("{:?}", node.operator()));
    }
    if node.kind() == SyntaxKind::PropertyAccessExpression {
        let receiver_type = checker.get_type_at_location(node.expression());
        let property = checker.get_property_of_type_exported(receiver_type, node.name().text());
        fact["receiverPropertySymbol"] = symbol(checker, property);
    }
    if is_expression(node) || node.kind() == SyntaxKind::Identifier {
        let id = checker.get_symbol_at_location_exported(node);
        fact["symbol"] = symbol(checker, id);
        if id.is_some() && checker.sym(id).flags.intersects(SymbolFlags::ALIAS) {
            let alias = checker.get_aliased_symbol(id);
            fact["aliasedSymbol"] = symbol(checker, alias);
        }
        let type_id = checker.get_type_at_location(node);
        if type_id.is_some() {
            fact["type"] = facts::type_fact(checker, type_id);
        }
    }
    if node.kind() == SyntaxKind::ShorthandPropertyAssignment {
        let value = checker.get_shorthand_assignment_value_symbol(node);
        fact["shorthandValueSymbol"] = symbol(checker, value);
    }
    if matches!(
        node.kind(),
        SyntaxKind::CallExpression | SyntaxKind::NewExpression
    ) {
        let id = checker.get_resolved_signature_exported(node);
        fact["signature"] = signature(checker, id);
    }
    nodes.push(fact);
    node.for_each_child(|child| {
        walk(child, file, checker, nodes);
        false
    });
}

fn run(request_path: &str, sdk_path: &str) -> Result<Value, String> {
    let request: Request =
        serde_json::from_slice(&std::fs::read(request_path).map_err(|error| error.to_string())?)
            .map_err(|error| error.to_string())?;
    if let Some(options) = &request.options {
        let defaults = json!({"target":"ES2022","module":"ESNext","moduleResolution":"Bundler","strict":false,"allowJs":true,"checkJs":false,"jsx":"Preserve","skipLibCheck":true,"noEmit":true});
        let Some(options) = options.as_object() else {
            return Err("options must be an object".into());
        };
        if !options
            .iter()
            .all(|(key, value)| defaults.get(key) == Some(value))
        {
            return Err("only the reported ES2022/Bundler default options are supported".into());
        }
    }
    let sdk: Sdk =
        serde_json::from_slice(&std::fs::read(sdk_path).map_err(|error| error.to_string())?)
            .map_err(|error| error.to_string())?;
    if sdk.version != "7.1.0-dev"
        || sdk.files.len() != 115
        || !sdk
            .files
            .keys()
            .all(|path| path.starts_with("/sdk/lib/lib") && path.ends_with(".d.ts"))
    {
        return Err("SDK must contain the 115 pinned TS7 libraries under /sdk/lib".into());
    }
    if request.files.is_empty()
        || !request.files.keys().all(|path| {
            path.starts_with("/project/")
                && !path.split('/').any(|part| part == ".." || part == ".")
        })
    {
        return Err("nonempty request files must use canonical /project paths".into());
    }
    let roots = if request.roots.is_empty() {
        request
            .files
            .keys()
            .filter(|path| {
                path.ends_with(".ts")
                    || path.ends_with(".tsx")
                    || path.ends_with(".js")
                    || path.ends_with(".jsx")
            })
            .cloned()
            .collect()
    } else {
        request.roots
    };
    if roots.is_empty() || !roots.iter().all(|root| request.files.contains_key(root)) {
        return Err("roots must name supplied files".into());
    }
    let input_paths: Vec<String> = request.files.keys().cloned().collect();
    let mut files = request.files;
    files.extend(sdk.files);
    let fs = Rc::new(files::Files(files));
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
    let host = compiler::new_compiler_host("/project", fs, "/sdk/lib", None, None, None);
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
    let mut loaded_files = Vec::new();
    let mut output = Vec::new();
    for file in source_files() {
        let path = source_file_file_name(file).to_string();
        loaded_files.push(path.clone());
        if input_paths.contains(&path) {
            let nodes = with_type_checker_for_file(file, move |checker| {
                let mut nodes = Vec::new();
                walk(file, file, checker, &mut nodes);
                nodes
            });
            output.push(json!({"path":path,"nodes":nodes}));
        }
    }
    output.sort_by(|left, right| left["path"].as_str().cmp(&right["path"].as_str()));
    loaded_files.sort();
    Ok(
        json!({"schemaVersion":1,"compilerVersion":ts_goport::core::version(),"revision":"780dc512d64f40afebffa6a7028207649fb7ed1c","sdkLibraries":115,"loadedFiles":loaded_files,"options":{"target":"ES2022","module":"ESNext","moduleResolution":"Bundler","strict":false,"allowJs":true,"jsx":"Preserve","skipLibCheck":true,"noEmit":true},"files":output}),
    )
}

fn main() {
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    if arguments.len() != 2 {
        eprintln!("usage: t00-ts7-oracle-q-semantic REQUEST.json SDK.json");
        std::process::exit(2);
    }
    let result = std::thread::Builder::new()
        .stack_size(16 * 1024 * 1024)
        .spawn(move || run(&arguments[0], &arguments[1]))
        .expect("oracle worker")
        .join();
    match result {
        Ok(Ok(value)) => println!("{}", value),
        Ok(Err(error)) => {
            eprintln!("{error}");
            std::process::exit(2);
        }
        Err(_) => {
            eprintln!("upstream compiler panicked; no facts are qualified");
            std::process::exit(2);
        }
    }
}
