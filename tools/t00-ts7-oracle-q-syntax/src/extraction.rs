use serde_json::{Value, json};
use ts_goport::{
    ast::{self, ModifierList, NodeFactory, NodeList},
    astdata::SyntaxKind as K,
    core::Node,
    flags::{ModifierFlags, ScriptKind},
    frontend::{
        parser::{SourceFileParseOptions, parse_source_file},
        scanner::get_leading_comment_ranges,
    },
    scanner_util,
};

#[path = "extraction_callable.rs"]
mod callable;

pub(crate) fn function_value(node: Node) -> bool {
    node.is_some() && matches!(node.kind(), K::ArrowFunction | K::FunctionExpression)
}

pub(crate) fn owner_name(node: Node) -> Option<String> {
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

pub(crate) fn scope(node: Node, interfaces: bool) -> Vec<String> {
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

pub(crate) fn unwrap(mut node: Node) -> Node {
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

pub(crate) fn object_member_ancestor(node: Node) -> bool {
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

pub(crate) fn line(source: Node, position: i32) -> i32 {
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

pub(crate) fn record_symbol(node: Node, source: Node, text: &str, path: &str) -> Option<Value> {
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

pub(crate) fn import_names(node: Node) -> Vec<String> {
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
                if property.is_nil() {
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
        out["functionOwners"].as_array_mut().unwrap().push(json!({"bodyPresent":!node.body().is_nil(),"namePresent":!node.name().is_nil(),"coordinate":coordinate}));
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
            let mut call = json!({"callerRelPath":path,"calleeName":name,"line":line(source, scanner_util::get_token_pos_of_node(node, source, false))});
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
        out["imports"].as_array_mut().unwrap().push(json!({"fromRelPath":path,"moduleSpecifier":node.module_specifier().text(),
            "names":import_names(node),"bindingTargets":[],"line":line(source,scanner_util::get_token_pos_of_node(node,source,false))}));
    }
    node.for_each_child(|child| {
        walk(child, source, text, path, retained, out);
        false
    });
}

pub fn observe(input: &Value) -> Result<Value, String> {
    if input["callableInitializers"].as_bool() == Some(true)
        || input["completeExtraction"].as_bool() == Some(true)
    {
        return callable::observe(input);
    }
    let files = input["files"]
        .as_object()
        .ok_or("extraction oracle requires files object")?;
    let mut result = json!({"modules":[],"symbols":[],"calls":[],"imports":[],"functionOwners":[]});
    for (path, text) in files {
        let text = text
            .as_str()
            .ok_or("extraction oracle requires source text strings")?;
        let parsed = parse_source_file(
            &SourceFileParseOptions {
                file_name: path.clone(),
                ..Default::default()
            },
            ast::FileText::new(text.to_string(), false),
            ScriptKind::TS,
        );
        if parsed.is_declaration_file {
            continue;
        }
        result["modules"].as_array_mut().unwrap().push(json!(path));
        walk(
            parsed.root,
            parsed.root,
            text,
            path,
            input["retained"].as_bool() != Some(false),
            &mut result,
        );
    }
    if input["syntheticOwnerAbsence"].as_bool() == Some(true) {
        let factory = NodeFactory::new();
        let cases = [(false, false), (false, true), (true, false), (true, true)].map(|(body, name)| {
            let declaration = factory.new_function_declaration(
                ModifierList::NIL, Node::NIL,
                if name { factory.new_identifier("named") } else { Node::NIL },
                NodeList::NIL, NodeList::NIL, Node::NIL, Node::NIL,
                if body { factory.new_block(NodeList::NIL, false) } else { Node::NIL },
            );
            json!({"bodyPresent":!declaration.body().is_nil(),"namePresent":!declaration.name().is_nil(),"ownerEligible":!declaration.body().is_nil() && owner_name(declaration).is_some()})
        });
        result["ownerAbsenceCases"] = json!(cases);
    }
    if let Some(path) = input["historicalConsumerFile"].as_str() {
        let source = files
            .get(path)
            .and_then(Value::as_str)
            .ok_or("historical consumer file missing")?;
        let request = json!({"source":source,"filename":path});
        result["outline"] = crate::outline::observe(&request)?;
        result["syntax"] = crate::syntax::observe(&request)?;
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::observe;
    use serde_json::json;

    #[test]
    fn records_complete_symbol_coordinates_and_nearest_doc() {
        let _publication = crate::UPSTREAM_FILE_PUBLICATION.lock().unwrap();
        let source = "/** older */\r\n/** closest 😀 */\r\nexport function outer() {\r\n const inner = () => 1;\r\n}\r\n// ordinary\r\nclass Local {}";
        let got = observe(&json!({"files":{"main.ts":source}})).unwrap();
        assert_eq!(got["symbols"][0]["name"], "outer");
        assert_eq!(got["symbols"][0]["jsdoc"], "/** closest 😀 */");
        assert_eq!(got["symbols"][0]["startLine"], 3);
        assert_eq!(got["symbols"][0]["endLine"], 5);
        assert_eq!(got["symbols"][0]["startUtf16"], 33);
        assert_eq!(got["symbols"][1]["scope"], json!(["outer"]));
        assert_eq!(got["symbols"][2]["exported"], false);
        assert_eq!(got["symbols"][2].get("jsdoc"), None);
    }

    #[test]
    fn owner_body_and_name_absence_are_independent() {
        let _publication = crate::UPSTREAM_FILE_PUBLICATION.lock().unwrap();
        let got = observe(&json!({"files":{"main.ts":"declare function declared(): void;\nexport default function () {}\nfunction named() {}"},"syntheticOwnerAbsence":true})).unwrap();
        assert_eq!(
            got["ownerAbsenceCases"],
            json!([
                {"bodyPresent":false,"namePresent":false,"ownerEligible":false},
                {"bodyPresent":false,"namePresent":true,"ownerEligible":false},
                {"bodyPresent":true,"namePresent":false,"ownerEligible":false},
                {"bodyPresent":true,"namePresent":true,"ownerEligible":true}
            ])
        );
        assert_eq!(got["functionOwners"][0]["coordinate"], json!(null));
        assert_eq!(
            got["functionOwners"][1]["coordinate"],
            json!({"relPath":"main.ts","symbolPath":"default"})
        );
        assert_eq!(
            got["functionOwners"][2]["coordinate"],
            json!({"relPath":"main.ts","symbolPath":"named"})
        );
    }

    #[test]
    fn malformed_requests_fail_without_fabricating_observations() {
        let _publication = crate::UPSTREAM_FILE_PUBLICATION.lock().unwrap();
        assert!(observe(&json!({})).is_err());
        assert!(observe(&json!({"files":{"main.ts":7}})).is_err());
    }

    #[test]
    fn default_only_and_side_effect_imports_have_no_named_binding_node() {
        let _publication = crate::UPSTREAM_FILE_PUBLICATION.lock().unwrap();
        let got = observe(&json!({"files":{"main.ts":"import main from './main';\nimport './side';\nimport type Type from './type';"}})).unwrap();
        assert_eq!(
            got["imports"],
            json!([
                {"fromRelPath":"main.ts","moduleSpecifier":"./main","names":["default"],"bindingTargets":[],"line":1},
                {"fromRelPath":"main.ts","moduleSpecifier":"./side","names":[],"bindingTargets":[],"line":2},
                {"fromRelPath":"main.ts","moduleSpecifier":"./type","names":[],"bindingTargets":[],"line":3}
            ])
        );
    }
}
