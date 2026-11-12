use serde_json::{Value, json};
use std::collections::BTreeSet;
use ts_goport::{
    ast,
    astdata::SyntaxKind as K,
    core::Node,
    flags::{JsxEmit, ModifierFlags, ModuleKind, NodeFlags, ScriptKind, ScriptTarget},
    frontend::{
        parser::{SourceFileParseOptions, parse_source_file},
        tspath::Path,
    },
};

fn children(node: Node, output: &mut Vec<Node>) {
    output.push(node);
    node.for_each_child(|child| {
        children(child, output);
        false
    });
}

fn modeled(node: Node) -> bool {
    match node.kind() {
        K::Identifier | K::PropertyAccessExpression | K::ImportKeyword => true,
        K::ParenthesizedExpression
        | K::AsExpression
        | K::TypeAssertionExpression
        | K::NonNullExpression
        | K::SatisfiesExpression => modeled(node.expression()),
        _ => false,
    }
}

fn module_links(nodes: &[Node]) -> Vec<String> {
    nodes
        .iter()
        .filter_map(|node| {
            let specifier = match node.kind() {
                K::ImportDeclaration | K::ExportDeclaration => node.module_specifier(),
                K::CallExpression
                    if node.expression().kind() == K::ImportKeyword
                        && node.arguments().len() == 1 =>
                {
                    node.arguments().get(0)
                }
                _ => Node::NIL,
            };
            (specifier.is_some() && specifier.kind() == K::StringLiteral)
                .then(|| specifier.text().to_owned())
        })
        .collect()
}

fn collect_statement_exports(
    statement: Node,
    exports: &mut Vec<Value>,
    reasons: &mut BTreeSet<String>,
) {
    match statement.kind() {
        K::ExportAssignment => {
            exports.push(json!({"name":"default","declarationKind":"expression"}))
        }
        K::ExportDeclaration => {
            let clause = statement.export_clause();
            if clause.is_nil() {
                exports.push(json!({"name":"*","declarationKind":"reexport"}));
            } else if clause.kind() == K::NamespaceExport {
                exports.push(
                    json!({"name":clause.name().text(),"declarationKind":"namespace-reexport"}),
                );
            } else {
                for e in clause.elements().iter() {
                    exports.push(json!({"name":e.name().text(),"declarationKind":if statement.module_specifier().is_some() {"reexport"} else {"local-binding"}}));
                }
            }
        }
        K::VariableStatement | K::FunctionDeclaration | K::ClassDeclaration
            if statement.modifier_flags().intersects(ModifierFlags::EXPORT) =>
        {
            if statement.kind() == K::VariableStatement {
                for d in statement.declaration_list().declarations().nodes().iter() {
                    if d.name().kind() == K::Identifier {
                        exports.push(json!({"name":d.name().text(),"declarationKind":"variable"}));
                    } else {
                        reasons.insert("JAVASCRIPT_EXPORTED_DESTRUCTURING_UNSUPPORTED".into());
                    }
                }
            } else {
                let name = if statement
                    .modifier_flags()
                    .intersects(ModifierFlags::DEFAULT)
                {
                    Some("default")
                } else if statement.name().is_some() {
                    Some(statement.name().text())
                } else {
                    None
                };
                if let Some(name) = name {
                    exports.push(json!({"name":name,"declarationKind":if statement.kind() == K::FunctionDeclaration {"function"} else {"class"}}));
                }
            }
        }
        _ => {}
    }
}

fn syntax_projection(input: &Value) -> Result<Value, String> {
    let source = input["source"].as_str().ok_or("source string required")?;
    let filename = input["filename"]
        .as_str()
        .ok_or("filename string required")?;
    let kind = if filename.ends_with(".tsx") {
        ScriptKind::TSX
    } else if filename.ends_with(".jsx") {
        ScriptKind::JSX
    } else if [".js", ".mjs", ".cjs"]
        .iter()
        .any(|s| filename.ends_with(s))
    {
        ScriptKind::JS
    } else if [".ts", ".mts", ".cts"]
        .iter()
        .any(|s| filename.ends_with(s))
    {
        ScriptKind::TS
    } else {
        return Err("unsupported source extension".into());
    };
    let parsed = parse_source_file(
        &SourceFileParseOptions {
            file_name: filename.into(),
            path: Path(filename.into()),
            ..Default::default()
        },
        ast::FileText::new(source.into(), false),
        kind,
    );
    let file = parsed.root;
    let positions = ast::compute_position_map(source);
    let diagnostics = ast::source_file_diagnostics(file).iter().map(|d| json!({"code":d.code(),"message":d.localize(&ts_goport::locale::DEFAULT),"start_utf16":positions.utf8_to_utf16(d.pos()),"end_utf16":positions.utf8_to_utf16(d.end())})).collect::<Vec<_>>();
    let parsing_reasons = ast::source_file_diagnostics(file)
        .iter()
        .map(|d| {
            format!(
                "SOURCE_PARSE_ERROR:{}:{}",
                d.code(),
                d.localize(&ts_goport::locale::DEFAULT).replace('\n', " ")
            )
        })
        .collect::<Vec<_>>();
    let mut nodes = vec![];
    children(file, &mut nodes);
    let javascript = file.flags().intersects(NodeFlags::JAVA_SCRIPT_FILE);
    let mut jsdoc_import = false;
    for node in &nodes {
        for doc in node.js_doc(file).iter() {
            let mut doc_nodes = vec![];
            children(doc, &mut doc_nodes);
            jsdoc_import |= doc_nodes
                .iter()
                .any(|n| matches!(n.kind(), K::ImportType | K::JsDocImportTag));
        }
    }
    jsdoc_import &= javascript;
    let default_expression = file
        .statement_list()
        .nodes()
        .iter()
        .any(|n| n.kind() == K::ExportAssignment && !n.is_export_equals());
    let mut reasons = BTreeSet::<String>::new();
    let mut scope = BTreeSet::<String>::new();
    if filename.ends_with(".cts") || filename.ends_with(".cjs") {
        scope.insert("SOURCE_COMMONJS_EXTENSION_UNSUPPORTED".into());
    }
    if parsed.external_module_indicator.is_nil()
        && !filename.ends_with(".mts")
        && !filename.ends_with(".mjs")
    {
        scope.insert("SOURCE_GLOBAL_SCRIPT_UNSUPPORTED".into());
    }
    if default_expression {
        reasons.insert("SOURCE_DEFAULT_EXPRESSION_UNSUPPORTED".into());
        if javascript {
            reasons.insert("JAVASCRIPT_DEFAULT_EXPRESSION_UNSUPPORTED".into());
        }
    }
    if jsdoc_import {
        reasons.insert("SOURCE_JSDOC_IMPORT_UNSUPPORTED".into());
        reasons.insert("JAVASCRIPT_JSDOC_IMPORT_UNSUPPORTED".into());
    }
    if javascript && filename.ends_with(".cjs") {
        reasons.insert("JAVASCRIPT_COMMONJS_UNSUPPORTED".into());
    }
    for node in &nodes {
        match node.kind() {
            K::ModuleDeclaration => {
                if ast::is_global_scope_augmentation(*node) {
                    scope.insert("SOURCE_GLOBAL_AUGMENTATION_UNSUPPORTED".into());
                }
                if node.name().kind() == K::StringLiteral {
                    scope.insert("SOURCE_MODULE_AUGMENTATION_UNSUPPORTED".into());
                }
            }
            K::TaggedTemplateExpression => {
                reasons.insert("SOURCE_TAGGED_TEMPLATE_UNSUPPORTED".into());
                if javascript {
                    reasons.insert("JAVASCRIPT_TAGGED_TEMPLATE_UNSUPPORTED".into());
                }
            }
            K::CallExpression => {
                if !modeled(node.expression()) {
                    reasons.insert(
                        if javascript {
                            "JAVASCRIPT_DYNAMIC_CALL_UNSUPPORTED"
                        } else {
                            "SOURCE_DYNAMIC_CALL_UNSUPPORTED"
                        }
                        .into(),
                    );
                }
                if javascript
                    && node.expression().kind() == K::ImportKeyword
                    && (node.arguments().len() != 1
                        || node.arguments().get(0).kind() != K::StringLiteral)
                {
                    reasons.insert("JAVASCRIPT_DYNAMIC_IMPORT_UNSUPPORTED".into());
                }
            }
            K::WithStatement if javascript => {
                reasons.insert("JAVASCRIPT_DYNAMIC_SCOPE_UNSUPPORTED".into());
            }
            _ => {}
        }
    }
    let mut exports = vec![];
    if javascript {
        for n in file.statement_list().nodes().iter() {
            collect_statement_exports(n, &mut exports, &mut reasons);
        }
    }
    exports.sort_by(|a, b| {
        a["name"]
            .as_str()
            .unwrap()
            .encode_utf16()
            .cmp(b["name"].as_str().unwrap().encode_utf16())
    });
    let mut configuration_reasons = vec![];
    if default_expression {
        configuration_reasons.push("SOURCE_DEFAULT_EXPRESSION_UNSUPPORTED".to_owned());
    }
    if jsdoc_import {
        configuration_reasons.push("SOURCE_JSDOC_IMPORT_UNSUPPORTED".to_owned());
    }
    configuration_reasons.extend(
        reasons
            .iter()
            .filter(|r| {
                r.starts_with("SOURCE_")
                    && !r.contains("DEFAULT_EXPRESSION")
                    && !r.contains("JSDOC_IMPORT")
            })
            .cloned(),
    );
    let configuration_without_scope = configuration_reasons.clone();
    configuration_reasons.extend(scope.iter().cloned());
    let mut js_reasons = reasons
        .iter()
        .filter(|r| r.starts_with("JAVASCRIPT_"))
        .cloned()
        .collect::<BTreeSet<_>>();
    js_reasons.extend(configuration_without_scope);
    Ok(json!({
        "moduleConfigurationReasons": configuration_reasons,
        "javascriptReasons": js_reasons,
        "executed": true,
        "unsupported": [],
        "staticModuleLinks": [],
        "parsingReasons": parsing_reasons,
        "diagnostics": diagnostics,
        "hasSyntaxErrors": !diagnostics.is_empty(),
        "jsdocImport": jsdoc_import,
        "defaultExpression": default_expression,
        "scanReasons": reasons,
        "scopeReasons": scope,
        "staticExports": exports,
        "moduleSpecifiers": module_links(&nodes)
    }))
}

pub fn observe(input: &Value) -> Result<Value, String> {
    let mut result = syntax_projection(input)?;
    let source = input["source"].as_str().ok_or("source string required")?;
    let filename = input["filename"]
        .as_str()
        .ok_or("filename string required")?;
    let javascript = [".js", ".jsx", ".mjs", ".cjs"]
        .iter()
        .any(|suffix| filename.ends_with(suffix));
    let js_output = if javascript {
        ts_goport::transpile::transpile_module(
            &ts_goport::gostd::context::background(),
            source,
            ts_goport::transpile::Options {
                compiler_options: Some(ts_goport::options::CompilerOptions {
                    target: ScriptTarget::ES2022,
                    module: ModuleKind::ES_NEXT,
                    jsx: JsxEmit::PRESERVE,
                    ..Default::default()
                }),
                file_name: filename.into(),
                report_diagnostics: true,
            },
        )
    } else {
        None
    };
    let mut js_reasons = result["javascriptReasons"]
        .as_array()
        .ok_or("syntax reasons missing")?
        .iter()
        .map(|reason| {
            reason
                .as_str()
                .map(str::to_owned)
                .ok_or("invalid syntax reason")
        })
        .collect::<Result<BTreeSet<_>, _>>()?;
    if let Some(output) = &js_output {
        for diagnostic in &output.diagnostics {
            js_reasons.insert(format!(
                "JAVASCRIPT_PARSE_ERROR:{}:{}",
                diagnostic.code(),
                diagnostic
                    .localize(&ts_goport::locale::DEFAULT)
                    .replace('\n', " ")
            ));
        }
    }
    result["javascriptReasons"] = json!(js_reasons);
    result["javascriptParseFailed"] = json!(
        js_output
            .as_ref()
            .map(|output| !output.diagnostics.is_empty())
    );
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::syntax_projection as observe;
    use serde_json::json;

    #[test]
    fn jsdoc_import_depends_on_compiler_attachment_and_javascript_mode() {
        let _publication = crate::UPSTREAM_FILE_PUBLICATION.lock().unwrap();
        let _program = ts_goport::core::enter_program(None);
        let doc = "/** @type {import('./types').Shape} */ export let value;";
        assert_eq!(
            observe(&json!({"filename":"main.js","source":doc})).unwrap()["jsdocImport"],
            true
        );
        assert_eq!(
            observe(&json!({"filename":"main.ts","source":doc})).unwrap()["jsdocImport"],
            false
        );
        assert_eq!(observe(&json!({"filename":"main.js","source":"/** prose import('./types') */ export let value;"})).unwrap()["jsdocImport"], false);
    }

    #[test]
    fn jsdoc_tags_and_nested_attachments_are_semantic_without_exported_variables() {
        let _publication = crate::UPSTREAM_FILE_PUBLICATION.lock().unwrap();
        let _program = ts_goport::core::enter_program(None);
        for source in [
            "/** @type {import('./types').Shape} */ let value; export {};",
            "/** @typedef {import('./types').Shape} Shape */ let value; export {};",
            "/** @import { Shape } from './types' */ let value; export {};",
            "export function outer() {\n/** @type {import('./types').Shape} */\nlet value; return value;\n}",
        ] {
            let observation = observe(&json!({"filename":"main.js","source":source})).unwrap();
            assert_eq!(observation["jsdocImport"], true);
            assert_eq!(
                observation["moduleConfigurationReasons"],
                json!(["SOURCE_JSDOC_IMPORT_UNSUPPORTED"])
            );
            assert_eq!(observation["parsingReasons"], json!([]));
            assert_eq!(
                observe(&json!({"filename":"main.ts","source":source})).unwrap()["jsdocImport"],
                false
            );
        }
        for source in [
            "/** import('./types') is prose */ let value; export {};",
            "/** @type {number} */ let value; export {};",
        ] {
            let observation = observe(&json!({"filename":"main.js","source":source})).unwrap();
            assert_eq!(observation["jsdocImport"], false);
            assert_eq!(observation["moduleConfigurationReasons"], json!([]));
        }
    }

    #[test]
    fn parser_recovery_is_distinct_from_a_type_error() {
        let _publication = crate::UPSTREAM_FILE_PUBLICATION.lock().unwrap();
        let _program = ts_goport::core::enter_program(None);
        assert_eq!(
            observe(&json!({"filename":"main.ts","source":"export const value = ;"})).unwrap()["hasSyntaxErrors"],
            true
        );
        assert_eq!(
            observe(
                &json!({"filename":"main.ts","source":"export const value: number = 'wrong';"})
            )
            .unwrap()["parsingReasons"],
            json!([])
        );
    }

    #[test]
    fn default_assignments_are_distinct_from_declarations_and_export_equals() {
        let _publication = crate::UPSTREAM_FILE_PUBLICATION.lock().unwrap();
        let _program = ts_goport::core::enter_program(None);
        for (source, expected) in [
            ("export default 1;", true),
            ("export default function() {}", false),
            ("const value = 1; export = value;", false),
        ] {
            assert_eq!(
                observe(&json!({"filename":"main.ts","source":source})).unwrap()["defaultExpression"],
                expected
            );
        }
    }

    #[test]
    fn malformed_input_is_rejected() {
        let _publication = crate::UPSTREAM_FILE_PUBLICATION.lock().unwrap();
        assert!(observe(&json!({"filename":"main.ts"})).is_err());
        assert!(observe(&json!({"filename":"main.txt","source":""})).is_err());
    }
}
