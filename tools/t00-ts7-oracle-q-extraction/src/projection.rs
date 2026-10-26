use serde_json::{Value, json};
use ts_goport::{
    ast::{self, NodeFactory},
    astdata::SyntaxKind as K,
    core::Node,
    flags::ModifierFlags,
    frontend::scanner::get_leading_comment_ranges,
    scanner_util,
};

fn function_value(node: Node) -> bool {
    matches!(node.kind(), K::ArrowFunction | K::FunctionExpression)
}

pub fn owner_name(node: Node) -> Option<String> {
    match node.kind() {
        K::FunctionDeclaration | K::ClassDeclaration => {
            if !node.name().is_nil() {
                return Some(node.name().text().to_string());
            }
            ast::get_combined_modifier_flags(node)
                .intersects(ModifierFlags::DEFAULT)
                .then(|| "default".to_string())
        }
        K::MethodDeclaration | K::ModuleDeclaration if node.name().kind() == K::Identifier => {
            Some(node.name().text().to_string())
        }
        K::VariableDeclaration
            if node.name().kind() == K::Identifier && function_value(node.initializer()) =>
        {
            Some(node.name().text().to_string())
        }
        _ => None,
    }
}

pub fn scope(node: Node, interfaces: bool) -> Vec<String> {
    let mut names = Vec::new();
    let mut parent = node.parent();
    while !parent.is_nil() {
        let name = if interfaces && parent.kind() == K::InterfaceDeclaration {
            Some(parent.name().text().to_string())
        } else {
            owner_name(parent)
        };
        if let Some(name) = name {
            names.push(name);
        }
        parent = parent.parent();
    }
    names.reverse();
    names
}

pub fn unwrap(mut node: Node) -> Node {
    while matches!(
        node.kind(),
        K::ParenthesizedExpression
            | K::AsExpression
            | K::TypeAssertionExpression
            | K::NonNullExpression
            | K::SatisfiesExpression
    ) {
        node = node.expression();
    }
    node
}

fn object_member_ancestor(node: Node) -> bool {
    let mut ancestor = node.parent();
    while !ancestor.is_nil() {
        if matches!(
            ancestor.kind(),
            K::MethodDeclaration | K::GetAccessor | K::SetAccessor
        ) && ancestor.parent().kind() == K::ObjectLiteralExpression
        {
            return true;
        }
        if function_value(ancestor) {
            let mut owner = ancestor.parent();
            while matches!(
                owner.kind(),
                K::ParenthesizedExpression
                    | K::AsExpression
                    | K::TypeAssertionExpression
                    | K::NonNullExpression
                    | K::SatisfiesExpression
            ) {
                owner = owner.parent();
            }
            if owner.kind() == K::PropertyAssignment
                && owner.parent().kind() == K::ObjectLiteralExpression
            {
                return true;
            }
        }
        ancestor = ancestor.parent();
    }
    false
}

fn line(source: Node, position: i32) -> i32 {
    scanner_util::get_ecma_line_and_utf16_character_of_position(source, position).0 + 1
}

fn doc(text: &str, node: Node) -> Option<String> {
    let factory = NodeFactory::new();
    get_leading_comment_ranges(&factory, text, node.pos())
        .iter()
        .filter_map(|range| text.get(range.pos() as usize..range.end() as usize))
        .rfind(|comment| comment.starts_with("/**"))
        .map(str::to_string)
}

fn record_symbol(node: Node, source: Node, text: &str, path: &str) -> Option<Value> {
    let (kind, name, start_node) = match node.kind() {
        K::FunctionDeclaration => ("function", owner_name(node)?, node),
        K::ClassDeclaration => ("class", owner_name(node)?, node),
        K::InterfaceDeclaration => ("interface", node.name().text().to_string(), node),
        K::TypeAliasDeclaration => ("type", node.name().text().to_string(), node),
        K::EnumDeclaration => ("enum", node.name().text().to_string(), node),
        K::VariableDeclaration
            if node.name().kind() == K::Identifier && function_value(node.initializer()) =>
        {
            let statement = node.parent().parent();
            if statement.kind() != K::VariableStatement {
                return None;
            }
            ("function", node.name().text().to_string(), statement)
        }
        _ => return None,
    };
    let start = scanner_util::get_token_pos_of_node(start_node, source, false);
    let mut result = json!({"name":name,"kind":kind,"relPath":path,"scope":scope(node, false),
        "startLine":line(source,start),"endLine":line(source,node.end()),
        "startUtf16":scanner_util::utf16_len(&text[..start as usize]),
        "endUtf16":scanner_util::utf16_len(&text[..node.end() as usize]),
        "exported":ast::get_combined_modifier_flags(start_node).intersects(ModifierFlags::EXPORT),"markers":[]});
    if node.kind() == K::FunctionDeclaration && node.body().is_nil() {
        result["signatureOnly"] = json!(true);
    }
    if let Some(value) = doc(text, start_node) {
        result["jsdoc"] = json!(value);
    }
    Some(result)
}

fn import_names(node: Node, retained: bool) -> Vec<String> {
    let clause = node.import_clause();
    if clause.is_nil() || clause.is_type_only() {
        return vec![];
    }
    let mut names = Vec::new();
    if !clause.name().is_nil() {
        names.push("default".to_string());
    }
    let bindings = clause.named_bindings();
    if bindings.is_some() && bindings.kind() == K::NamespaceImport {
        names.push(bindings.name().text().to_string());
    }
    if bindings.is_some() && bindings.kind() == K::NamedImports {
        for element in bindings.elements() {
            if element.is_type_only() {
                continue;
            }
            let property = element.property_name();
            names.push(
                if property.is_nil() || !retained {
                    element.name()
                } else {
                    property
                }
                .text()
                .to_string(),
            );
        }
    }
    names
}

fn walk(node: Node, source: Node, text: &str, path: &str, retained: bool, out: &mut Value) {
    if let Some(value) = record_symbol(node, source, text, path) {
        out["symbols"].as_array_mut().unwrap().push(value);
    }
    if node.kind() == K::FunctionDeclaration {
        let name = owner_name(node);
        let coordinate = name.as_ref().filter(|_| !node.body().is_nil()).map(|name| {
            let mut names = scope(node, true);
            names.push(name.clone());
            json!({"relPath":path,"symbolPath":names.join(".")})
        });
        out["functionOwners"].as_array_mut().unwrap().push(json!({"bodyPresent":!node.body().is_nil(),"namePresent":name.is_some(),"coordinate":coordinate}));
    }
    if node.kind() == K::CallExpression {
        if retained && node.expression().kind() == K::ImportKeyword {
            let arguments = node.arguments();
            if arguments.len() == 1 && arguments.get(0).kind() == K::StringLiteral {
                out["imports"].as_array_mut().unwrap().push(json!({"fromRelPath":path,"moduleSpecifier":arguments.get(0).text(),"names":[],"line":line(source,scanner_util::get_token_pos_of_node(node,source,false))}));
            }
        }
        let callee = if retained {
            unwrap(node.expression())
        } else {
            node.expression()
        };
        let name = match callee.kind() {
            K::Identifier => Some(callee.text()),
            K::PropertyAccessExpression => Some(callee.name().text()),
            _ => None,
        };
        if let Some(name) = name {
            let mut call = json!({"callerRelPath":path,"calleeName":name,"_startByte":scanner_util::get_token_pos_of_node(node,source,false),"line":line(source, scanner_util::get_token_pos_of_node(node, source, false))});
            let mut ancestor = node.parent();
            while !ancestor.is_nil() {
                if matches!(
                    ancestor.kind(),
                    K::FunctionDeclaration | K::ClassDeclaration | K::VariableDeclaration
                ) && let Some(name) = owner_name(ancestor)
                {
                    let mut names = scope(ancestor, false);
                    names.push(name);
                    call["callerSymbolPath"] = json!(names.join("."));
                    break;
                }
                ancestor = ancestor.parent();
            }
            if retained && object_member_ancestor(node) {
                call["callerUnmodeledReason"] = json!("OBJECT_LITERAL_MEMBER");
            }
            out["calls"].as_array_mut().unwrap().push(call);
        }
    }
    if node.kind() == K::ImportDeclaration && node.module_specifier().kind() == K::StringLiteral {
        out["imports"].as_array_mut().unwrap().push(json!({"fromRelPath":path,"moduleSpecifier":node.module_specifier().text(),"_startByte":scanner_util::get_token_pos_of_node(node,source,false),
            "names":import_names(node, retained),"bindingTargets":[],"line":line(source,scanner_util::get_token_pos_of_node(node,source,false))}));
    }
    node.for_each_child(|child| {
        walk(child, source, text, path, retained, out);
        false
    });
}

pub fn extract(source: Node, text: &str, path: &str, retained: bool, out: &mut Value) {
    walk(source, source, text, path, retained, out);
}

pub fn ast_specifiers(source: Node, path: &str) -> Value {
    use ts_goport::{
        flags::ScriptKind,
        frontend::parser::{SourceFileParseOptions, parse_source_file},
        prelude::source_file_text,
    };
    let parsed = parse_source_file(
        &SourceFileParseOptions {
            file_name: path.into(),
            ..Default::default()
        },
        source_file_text(source),
        ScriptKind::TSX,
    );
    let source = parsed.root;
    fn visit(
        node: Node,
        source: Node,
        path: &str,
        relative: &mut Vec<Value>,
        dynamic: &mut Vec<Value>,
    ) {
        let specifier = match node.kind() {
            K::ImportDeclaration | K::ExportDeclaration => node.module_specifier(),
            K::CallExpression
                if node.expression().kind() == K::ImportKeyword && !node.arguments().is_empty() =>
            {
                node.arguments().get(0)
            }
            _ => Node::NIL,
        };
        if specifier.is_some() && specifier.kind() == K::StringLiteral {
            if specifier.text().starts_with('.') {
                relative.push(json!(specifier.text()));
            }
            if node.kind() == K::CallExpression && node.arguments().len() == 1 {
                dynamic.push(json!({"file":path,"line":line(source,scanner_util::get_token_pos_of_node(node,source,false)),"specifier":specifier.text()}));
            }
        }
        node.for_each_child(|child| {
            visit(child, source, path, relative, dynamic);
            false
        });
    }
    let mut relative = Vec::new();
    let mut dynamic = Vec::new();
    visit(source, source, path, &mut relative, &mut dynamic);
    json!({"relativeSpecifiers":relative,"dynamicImports":dynamic})
}

pub fn config_references(
    files: &std::collections::BTreeMap<String, String>,
) -> Result<Value, String> {
    use ts_goport::{
        flags::ScriptKind,
        frontend::parser::{SourceFileParseOptions, parse_source_file},
    };
    let mut result = Vec::new();
    for (path, text) in files.iter().filter(|(path, _)| path.ends_with(".json")) {
        let parsed = parse_source_file(
            &SourceFileParseOptions {
                file_name: path.clone(),
                ..Default::default()
            },
            ast::FileText::new(text.clone(), false),
            ScriptKind::JSON,
        );
        let diagnostics = ts_goport::frontend::parser::parsed_source_file_diagnostics(parsed.root);
        if !diagnostics.is_empty() {
            return Err(format!(
                "invalid JSONC config {path}: TS{}",
                diagnostics[0].code
            ));
        }
        let mut references = Vec::new();
        fn visit(node: Node, references: &mut Vec<String>) {
            if node.kind() == K::PropertyAssignment && node.name().text() != "extends" {
                return;
            }
            if node.kind() == K::PropertyAssignment && node.name().text() == "extends" {
                references.clear();
                let value = node.initializer();
                if value.kind() == K::StringLiteral {
                    references.push(value.text().into());
                }
                if value.kind() == K::ArrayLiteralExpression {
                    references.extend(
                        value
                            .elements()
                            .iter()
                            .filter(|element| element.kind() == K::StringLiteral)
                            .map(|element| element.text().to_string()),
                    );
                }
                return;
            }
            node.for_each_child(|child| {
                visit(child, references);
                false
            });
        }
        visit(parsed.root, &mut references);
        result.push(json!({"path":path,"extends":references}));
    }
    Ok(json!(result))
}

#[cfg(test)]
mod tests {
    use super::*;
    use ts_goport::{
        flags::ScriptKind,
        frontend::parser::{SourceFileParseOptions, parse_source_file},
    };
    #[test]
    fn preserves_relative_ast_sequence_and_separates_single_literal_dynamic_imports() {
        let _context = ts_goport::core::enter_program(None);
        let parsed = parse_source_file(&SourceFileParseOptions {file_name:"/project/a.ts".into(),..Default::default()},ast::FileText::new("import './a'; export * from '../b'; import('./c'); import('bare'); require('./no'); import(foo); import('./no', {}); import alias = require('./equal'); import(`./template`);".into(),false),ScriptKind::TS);
        let got = ast_specifiers(parsed.root, "a.ts");
        assert_eq!(
            got["relativeSpecifiers"],
            json!(["./a", "../b", "./c", "./no"])
        );
        assert_eq!(got["dynamicImports"].as_array().unwrap().len(), 2);
    }
    #[test]
    fn reads_jsonc_extends_strings_without_nested_or_nonstring_guesses() {
        let _context = ts_goport::core::enter_program(None);
        let files=std::collections::BTreeMap::from([("/project/tsconfig.json".to_string(),r#"{/* note */ "extends":"./obsolete", "extends":["./base",false,42,"package",],"compilerOptions":{"extends":"./nested"}}"#.to_string())]);
        assert_eq!(
            config_references(&files).unwrap(),
            json!([{"path":"/project/tsconfig.json","extends":["./base","package"]}])
        );
    }
    #[test]
    fn refuses_malformed_jsonc_instead_of_guessing_config_edges() {
        let _context = ts_goport::core::enter_program(None);
        let files = std::collections::BTreeMap::from([(
            "/project/tsconfig.json".into(),
            r#"{"extends":["./partial""#.into(),
        )]);
        assert!(
            config_references(&files)
                .unwrap_err()
                .starts_with("invalid JSONC config /project/tsconfig.json: TS")
        );
    }
}
