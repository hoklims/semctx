use serde_json::{Value, json};
use std::{collections::BTreeMap, rc::Rc, sync::Mutex};
use ts_goport::{
    ast,
    emitter::emitter::get_script_transformers,
    frontend::{
        compiler,
        parser::{SourceFileParseOptions, parse_source_file},
        tsoptions,
        tspath::{ComparePathsOptions, Path},
    },
    prelude::*,
    printer::{PrintHandlers, PrinterOptions, new_emit_context, new_printer},
};
mod files;
static UPSTREAM_FILE_PUBLICATION: Mutex<()> = Mutex::new(());

fn compiler_options(input: &Value) -> Result<CompilerOptions, String> {
    let mut values = json!({"target":"ES2022","module":"ESNext","jsx":"Preserve"});
    if let Some(options) = input.get("options") {
        let options = options.as_object().ok_or("options must be an object")?;
        for (key, value) in options {
            if !matches!(
                key.as_str(),
                "target"
                    | "module"
                    | "moduleResolution"
                    | "jsx"
                    | "importHelpers"
                    | "jsxFactory"
                    | "jsxFragmentFactory"
                    | "jsxImportSource"
                    | "experimentalDecorators"
            ) {
                return Err(format!("unsupported oracle option {key}"));
            }
            let boolean_option = matches!(key.as_str(), "importHelpers" | "experimentalDecorators");
            if (boolean_option && !value.is_boolean()) || (!boolean_option && !value.is_string()) {
                return Err(format!("invalid type for option {key}"));
            }
            values[key] = value.clone();
        }
    }
    let mut arguments = Vec::new();
    for (key, value) in values.as_object().expect("options object") {
        arguments.push(format!("--{key}"));
        arguments.push(match value {
            Value::String(text) => text.clone(),
            Value::Bool(value) => value.to_string(),
            _ => return Err(format!("option {key} must be string or boolean")),
        });
    }
    let parsed = tsoptions::parse_command_line_worker(
        &tsoptions::COMPILER_OPTIONS_DID_YOU_MEAN_DIAGNOSTICS,
        &arguments,
        None,
        "/project".into(),
    );
    if !parsed.errors.is_empty() {
        return Err(parsed
            .errors
            .iter()
            .map(|error| error.localize(&ts_goport::locale::DEFAULT))
            .collect::<Vec<_>>()
            .join("; "));
    }
    let mut options = CompilerOptions::default();
    for (key, value) in parsed.options {
        tsoptions::parse_compiler_options(&key, value, &mut options);
    }
    if options.target < ScriptTarget::ES2015 {
        return Err(
            "TS7 targets older than ES2015 are excluded; ARB-003 receives no credit".into(),
        );
    }
    if matches!(
        options.module,
        ModuleKind::NONE | ModuleKind::AMD | ModuleKind::UMD | ModuleKind::SYSTEM
    ) {
        return Err("module format removed by TS7".into());
    }
    options.allow_js = Tristate::True;
    options.no_check = Tristate::True;
    options.no_lib = Tristate::True;
    options.no_resolve = Tristate::True;
    options.isolated_modules = Tristate::True;
    Ok(options)
}

fn visit(node: Node, callback: &mut impl FnMut(Node)) {
    callback(node);
    node.for_each_child(|child| {
        visit(child, callback);
        false
    });
}

fn diagnostic_values(file: Node, phase: &str) -> Vec<Value> {
    ast::source_file_diagnostics(file).iter().map(|diagnostic| json!({
        "phase":phase,"code":diagnostic.code(),"pos":diagnostic.pos(),"end":diagnostic.end(),
        "message":diagnostic.localize(&ts_goport::locale::DEFAULT)
    })).collect()
}

fn observe_source(
    input: &Value,
    options: CompilerOptions,
    mut files: BTreeMap<String, String>,
) -> Result<Value, String> {
    let _publication = UPSTREAM_FILE_PUBLICATION
        .lock()
        .map_err(|_| "upstream file publication lock poisoned")?;
    let source = input["source"].as_str().ok_or("source string required")?;
    let filename = input["file_name"]
        .as_str()
        .ok_or("file_name string required")?;
    if filename.is_empty() || filename.split('/').any(|part| part == "..") {
        return Err("file_name must be a nonempty path without parent traversal".into());
    }
    if ![".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]
        .iter()
        .any(|extension| filename.ends_with(extension))
    {
        return Err("unsupported source extension".into());
    }
    let filename = if filename.starts_with('/') {
        filename.to_string()
    } else {
        format!("/project/{filename}")
    };
    files.insert(filename.clone(), source.to_string());
    let transpiled = ts_goport::transpile::transpile_module(
        &ts_goport::gostd::context::background(),
        input["source"].as_str().ok_or("source string required")?,
        ts_goport::transpile::Options {
            compiler_options: Some(options.clone()),
            file_name: input["file_name"]
                .as_str()
                .ok_or("file_name string required")?
                .into(),
            report_diagnostics: true,
        },
    )
    .ok_or("upstream transpilation cancelled")?;
    let diagnostics: Vec<Value> = transpiled
        .diagnostics
        .iter()
        .map(|diagnostic| {
            json!({
                "code":diagnostic.code(),"pos":diagnostic.pos(),"end":diagnostic.end(),
                "message":diagnostic.localize(&ts_goport::locale::DEFAULT)
            })
        })
        .collect();
    let config = Rc::new(tsoptions::new_parsed_command_line(
        Rc::new(options.clone()),
        vec![filename.clone()],
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
    let frontend_program = Rc::new(compiler::new_program(compiler::ProgramOptions {
        host,
        config,
        use_source_of_project_reference: false,
        single_threaded: Tristate::True,
        typings_location: String::new(),
        project_name: String::new(),
        create_module_resolver: None,
        skip_module_resolution: true,
    }));
    let version = ts_goport::program::new_program_version(&frontend_program, None);
    let _program_scope = enter_program(Some(version));
    let file = frontend_program
        .get_source_file(&filename)
        .ok_or("upstream did not parse the requested source")?
        .root;
    let positions = ast::compute_position_map(source);
    let mut spans = Vec::new();
    let mut token_spans = Vec::new();
    visit(file, &mut |node| {
        if matches!(
            node.kind(),
            SyntaxKind::JsxElement | SyntaxKind::JsxSelfClosingElement | SyntaxKind::JsxFragment
        ) {
            spans.push(json!([
                positions.utf8_to_utf16(node.pos()),
                positions.utf8_to_utf16(node.end())
            ]));
            token_spans.push(json!([
                positions.utf8_to_utf16(ts_goport::scanner_util::get_token_pos_of_node(
                    node, file, false
                )),
                positions.utf8_to_utf16(node.end())
            ]));
        }
    });
    let base = ast::get_jsx_implicit_import_base(&options, file);

    let source_text = source.to_string();
    let emit_options = options.clone();
    let mut emitted_facts = run_on_checker_threads_for_files(&[file], move |file| {
        let options = &emit_options;
        let positions = ast::compute_position_map(&source_text);
        let context = new_emit_context();
        let resolver = new_emit_host(file).new_emit_resolver(context.clone());
        let mut transformed = file;
        for mut transformer in get_script_transformers(resolver, file) {
            transformed = transformer.transform_source_file(transformed);
        }
        let helpers = context
            .get_emit_helpers(transformed)
            .iter()
            .map(|helper| json!({"name":helper.name,"scoped":helper.scoped}))
            .collect::<Vec<_>>();
        let mut calls = Vec::new();
        visit(transformed, &mut |node| {
            if node.kind() == SyntaxKind::CallExpression {
                let original = context.most_original(node);
                calls.push(json!({"synthetic":node.flags().intersects(NodeFlags::SYNTHESIZED),
                "pos":positions.utf8_to_utf16(node.pos()),"end":positions.utf8_to_utf16(node.end()),
                "originalPos":positions.utf8_to_utf16(original.pos()),"originalEnd":positions.utf8_to_utf16(original.end())}));
            }
        });
        let mut printer = new_printer(
            PrinterOptions {
                target: options.target,
                ..Default::default()
            },
            PrintHandlers::default(),
            Some(context),
        );
        let emitted = printer.emit_source_file_exported(transformed);
        (helpers, calls, emitted)
    });
    let (helpers, calls, emitted) = emitted_facts
        .pop()
        .ok_or("upstream did not transform source")?;
    let emitted_kind = if matches!(options.jsx, JsxEmit::PRESERVE | JsxEmit::REACT_NATIVE) {
        ScriptKind::JSX
    } else {
        ScriptKind::JS
    };
    let parsed = parse_source_file(
        &SourceFileParseOptions {
            file_name: "/project/emitted.jsx".into(),
            path: Path("/project/emitted.jsx".into()),
            ..Default::default()
        },
        ast::FileText::new(emitted.clone(), false),
        emitted_kind,
    );
    let emitted_diagnostics = diagnostic_values(parsed.root, "emitted");
    let mut imports = Vec::new();
    visit(parsed.root, &mut |node| {
        let specifier = match node.kind() {
            SyntaxKind::ImportDeclaration | SyntaxKind::ExportDeclaration => {
                node.module_specifier()
            }
            SyntaxKind::CallExpression
                if ast::is_require_call(node, true)
                    || node.expression().kind() == SyntaxKind::ImportKeyword =>
            {
                node.arguments().get(0)
            }
            _ => Node::NIL,
        };
        if specifier.is_some() && specifier.kind() == SyntaxKind::StringLiteral {
            imports.push(specifier.text().to_string());
        }
    });
    imports.sort();
    imports.dedup();
    Ok(
        json!({"fileName":source_file_file_name(file),"helpers":helpers,"imports":imports,"jsxSpans":spans,"jsxTokenSpans":token_spans,"calls":calls,"automaticImportBase":base,"diagnostics":diagnostics,"emittedParseDiagnostics":emitted_diagnostics,"emittedText":emitted}),
    )
}

pub fn observe(input: &Value) -> Result<Value, String> {
    if std::env::var_os("GOPORT_BUILD_VERSION").is_some() {
        return Err("GOPORT_BUILD_VERSION must be absent".into());
    }
    let options = compiler_options(input)?;
    let sdk = input["sdk_directory"]
        .as_str()
        .ok_or("explicit sdk_directory required")?;
    let mut files = BTreeMap::new();
    for entry in std::fs::read_dir(sdk).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with("lib.") && name.ends_with(".d.ts") {
            files.insert(
                format!("/sdk/lib/{name}"),
                std::fs::read_to_string(entry.path()).map_err(|error| error.to_string())?,
            );
        }
    }
    let count = files.len();
    if count != 115 {
        return Err(format!(
            "SDK requires 115 declaration libraries, found {count}"
        ));
    }
    let _scope = enter_program(None);
    let observation = observe_source(input, options, files)?;
    Ok(
        json!({"compilerVersion":ts_goport::core::version(),"sourceRevision":"780dc512d64f40afebffa6a7028207649fb7ed1c","sdkLibraryCount":count,"observation":observation}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture(source: &str, filename: &str, options: Value) -> Value {
        let input = json!({"source":source,"file_name":filename,"options":options});
        std::thread::Builder::new()
            .stack_size(16 * 1024 * 1024)
            .spawn(move || {
                let _scope = enter_program(None);
                observe_source(&input, compiler_options(&input).unwrap(), BTreeMap::new()).unwrap()
            })
            .unwrap()
            .join()
            .unwrap()
    }
    #[test]
    fn refuses_unsupported_es5_target() {
        assert!(
            observe(&json!({"options":{"target":"ES5"}}))
                .unwrap_err()
                .contains("ARB-003")
        );
    }
    #[test]
    fn imports_runtime_helpers_only_when_the_transform_requires_them() {
        let source = "export async function read() { return await Promise.resolve(1); }";
        let active = fixture(
            source,
            "read.js",
            json!({"target":"es2015","importHelpers":true}),
        );
        assert_eq!(active["imports"], json!(["tslib"]));
        assert!(active["helpers"].as_array().is_some_and(|helpers| {
            helpers
                .iter()
                .any(|helper| helper["name"] == "typescript:awaiter" && helper["scoped"] == false)
        }));
        let disabled = fixture(
            source,
            "read.js",
            json!({"target":"es2015","importHelpers":false}),
        );
        assert_eq!(disabled["imports"], json!([]));
        let modern = fixture(
            source,
            "read.js",
            json!({"target":"es2022","importHelpers":true}),
        );
        assert_eq!(modern["helpers"], json!([]));
        assert_eq!(modern["imports"], json!([]));
    }
    #[test]
    fn preserves_distinct_raw_jsx_and_synthesized_factory_spans() {
        let source = "const title = 'é😀'; export const view = /* trivia */ <section />;";
        let classic = fixture(source, "view.jsx", json!({"jsx":"react"}));
        assert_eq!(classic["automaticImportBase"], "");
        assert_eq!(classic["jsxSpans"], json!([[40, 65]]));
        assert_eq!(classic["jsxTokenSpans"], json!([[54, 65]]));
        assert!(classic["calls"].as_array().is_some_and(|calls| {
            calls.iter().any(|call| {
                call["synthetic"] == true
                    && classic["jsxTokenSpans"][0] == json!([call["pos"], call["end"]])
            })
        }));
        let preserve = fixture(source, "view.jsx", json!({"jsx":"preserve"}));
        assert_eq!(preserve["jsxSpans"], classic["jsxSpans"]);
        assert_eq!(preserve["calls"], json!([]));
        let without_trivia = fixture(
            "export const view=<section/>;",
            "view.jsx",
            json!({"jsx":"react"}),
        );
        assert_eq!(without_trivia["jsxSpans"], without_trivia["jsxTokenSpans"]);
        assert!(without_trivia["calls"].as_array().is_some_and(|calls| {
            calls.iter().any(|call| {
                call["synthetic"] == true
                    && without_trivia["jsxSpans"][0] == json!([call["pos"], call["end"]])
            })
        }));
    }
    #[test]
    fn authored_factory_calls_do_not_count_as_synthesized_jsx() {
        let output = fixture(
            "export const view=React.createElement('section', null);",
            "view.jsx",
            json!({"jsx":"react"}),
        );
        assert_eq!(output["jsxSpans"], json!([]));
        assert!(
            output["calls"]
                .as_array()
                .is_some_and(|calls| calls.len() == 1 && calls[0]["synthetic"] == false)
        );
    }
    #[test]
    fn lets_upstream_interpret_automatic_runtime_pragmas() {
        let active = fixture(
            "/** @jsxRuntime automatic */\nexport const view = <section />;",
            "view.jsx",
            json!({"jsx":"react"}),
        );
        assert_eq!(active["automaticImportBase"], "react");
        assert_eq!(active["imports"], json!(["react/jsx-runtime"]));
        let classic = fixture(
            "/** @jsxRuntime classic */\nexport const view = <section />;",
            "view.jsx",
            json!({"jsx":"react-jsx"}),
        );
        assert_eq!(classic["automaticImportBase"], "");
        assert_eq!(classic["imports"], json!([]));
        let custom = fixture(
            "/** @jsxImportSource preact */\nexport const view = <section />;",
            "view.jsx",
            json!({"jsx":"react-jsx"}),
        );
        assert_eq!(custom["automaticImportBase"], "preact");
        assert_eq!(custom["imports"], json!(["preact/jsx-runtime"]));
    }
    #[test]
    fn reports_javascript_annotation_diagnostics_from_transpile_module() {
        let active = fixture("export const answer: number = 42;", "answer.js", json!({}));
        assert!(active["diagnostics"].as_array().is_some_and(|diagnostics| {
            diagnostics
                .iter()
                .any(|diagnostic| diagnostic["code"] == 8010)
        }));
        let control = fixture("export const answer = 42;", "answer.js", json!({}));
        assert_eq!(control["diagnostics"], json!([]));
        let malformed = fixture("export const answer = ;", "answer.js", json!({}));
        assert!(
            malformed["diagnostics"]
                .as_array()
                .is_some_and(|diagnostics| diagnostics
                    .iter()
                    .any(|diagnostic| diagnostic["code"] == 1109))
        );
    }
    #[test]
    fn rejects_invalid_source_values_and_paths_before_compiler_entry() {
        for input in [
            json!({"source":17,"file_name":"view.jsx"}),
            json!({"source":"export const value=1;"}),
            json!({"source":"export const value=1;","file_name":17}),
            json!({"source":"export const value=1;","file_name":""}),
            json!({"source":"export const value=1;","file_name":"/project/../escape.jsx"}),
            json!({"source":"export const value=1;","file_name":"view.json"}),
        ] {
            let options = compiler_options(&input).unwrap();
            assert!(observe_source(&input, options, BTreeMap::new()).is_err());
        }
    }
    #[test]
    fn rejects_invalid_option_types_and_removed_modules() {
        assert!(compiler_options(&json!({"options":{"importHelpers":"true"}})).is_err());
        assert!(compiler_options(&json!({"options":{"module":"amd"}})).is_err());
        assert!(compiler_options(&json!({"options":{"target":"unknown"}})).is_err());
    }
}
