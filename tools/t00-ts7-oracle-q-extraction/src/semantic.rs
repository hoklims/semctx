use crate::projection;
use serde_json::{Value, json};
use ts_goport::{prelude::*, scanner_util::get_token_pos_of_node};

pub fn relative(path: &str, root: &str) -> String {
    let path: Vec<&str> = path.split('/').filter(|part| !part.is_empty()).collect();
    let root: Vec<&str> = root.split('/').filter(|part| !part.is_empty()).collect();
    let shared = path
        .iter()
        .zip(&root)
        .take_while(|(left, right)| left == right)
        .count();
    std::iter::repeat_n("..", root.len() - shared)
        .chain(path[shared..].iter().copied())
        .collect::<Vec<_>>()
        .join("/")
}

fn coordinate(mut node: Node, root: &str) -> Option<Value> {
    while node.is_some() {
        if let Some(name) = projection::owner_name(node) {
            let mut names = projection::scope(node, false);
            names.push(name);
            return Some(
                json!({"relPath":relative(source_file_file_name(get_source_file_of_node(node)),root),"symbolPath":names.join(".")}),
            );
        }
        node = node.parent();
    }
    None
}

fn symbol_coordinate(checker: &mut Checker, node: Node, root: &str) -> Option<Value> {
    let mut id = checker.get_symbol_at_location_exported(node);
    if id.is_nil() {
        return None;
    }
    if checker.sym(id).flags.intersects(SymbolFlags::ALIAS) {
        id = checker.get_aliased_symbol(id);
    }
    if id.is_nil() {
        return None;
    }
    checker
        .sym(id)
        .declarations
        .iter()
        .find_map(|declaration| coordinate(*declaration, root)).or_else(|| {
            checker.sym(id).declarations.iter().find_map(|declaration| {
                let file=get_source_file_of_node(*declaration);
                file.is_some().then(||json!({"relPath":relative(source_file_file_name(file),root),"symbolPath":checker.sym(id).name.to_string()}))
            })
        })
}

fn binding_target(checker: &mut Checker, source: Node, name: Node, root: &str) -> Option<Value> {
    let mut target = symbol_coordinate(checker, name, root)?;
    let id = checker.get_symbol_at_location_exported(name);
    if id.is_some() {
        let used = checker
            .get_references_to_symbol_in_file(source, id)
            .iter()
            .any(|reference| {
                if *reference == name || ts_goport::ast::is_part_of_type_node(*reference) {
                    return false;
                }
                let mut parent = reference.parent();
                while parent.is_some() {
                    if ts_goport::ast::is_type_node(parent)
                        || matches!(
                            parent.kind(),
                            SyntaxKind::InterfaceDeclaration | SyntaxKind::TypeAliasDeclaration
                        )
                        || parent.kind() == SyntaxKind::ImportDeclaration
                        || parent.kind() == SyntaxKind::ImportEqualsDeclaration
                    {
                        return false;
                    }
                    if matches!(
                        parent.kind(),
                        SyntaxKind::ExportSpecifier | SyntaxKind::ExportDeclaration
                    ) && parent.is_type_only()
                    {
                        return false;
                    }
                    parent = parent.parent();
                }
                true
            });
        if !used {
            target["runtimeUsed"] = json!(false);
        }
    }
    Some(target)
}

fn import_bindings(checker: &mut Checker, source: Node, clause: Node, root: &str) -> Vec<Value> {
    if clause.is_nil() || clause.is_type_only() {
        return Vec::new();
    }
    let mut bindings = Vec::new();
    if clause.name().is_some()
        && let Some(target) = binding_target(checker, source, clause.name(), root)
    {
        bindings.push(target);
    }
    let named = clause.named_bindings();
    if named.is_nil() || named.kind() != SyntaxKind::NamedImports {
        return bindings;
    }
    bindings.extend(
        named
            .elements()
            .iter()
            .filter(|binding| !binding.is_type_only())
            .filter_map(|binding| binding_target(checker, source, binding.name(), root)),
    );
    bindings
}

pub fn enrich(node: Node, source: Node, checker: &mut Checker, root: &str, out: &mut Value) {
    let path = relative(source_file_file_name(source), root);
    if node.kind() == SyntaxKind::CallExpression {
        let callee = projection::unwrap(node.expression());
        if let Some(target) = symbol_coordinate(checker, callee, root) {
            for call in out["calls"]
                .as_array_mut()
                .unwrap()
                .iter_mut()
                .filter(|call| {
                    call["callerRelPath"] == path
                        && call["_startByte"] == get_token_pos_of_node(node, source, false)
                        && call["calleeName"].as_str()
                            == Some(if callee.kind() == SyntaxKind::PropertyAccessExpression {
                                callee.name().text()
                            } else if callee.kind() == SyntaxKind::Identifier {
                                callee.text()
                            } else {
                                ""
                            })
                })
            {
                call["calleeRelPath"] = target["relPath"].clone();
                call["calleeSymbolPath"] = target["symbolPath"].clone();
            }
        }
    }
    if node.kind() == SyntaxKind::ImportDeclaration {
        let specifier = node.module_specifier();
        if specifier.kind() == SyntaxKind::StringLiteral {
            let id = checker.get_symbol_at_location_exported(specifier);
            let resolved = if id.is_some() {
                checker.sym(id).declarations.iter().find_map(|declaration| {
                    let file = get_source_file_of_node(*declaration);
                    file.is_some()
                        .then(|| relative(source_file_file_name(file), root))
                })
            } else {
                None
            };
            let bindings = import_bindings(checker, source, node.import_clause(), root);
            for import in out["imports"]
                .as_array_mut()
                .unwrap()
                .iter_mut()
                .filter(|import| {
                    import["fromRelPath"] == path
                        && import["_startByte"] == get_token_pos_of_node(node, source, false)
                        && import["moduleSpecifier"] == specifier.text()
                })
            {
                if let Some(ref resolved) = resolved {
                    import["resolvedRelPath"] = json!(resolved);
                }
                if import.get("bindingTargets").is_some() {
                    import["bindingTargets"] = json!(bindings);
                }
            }
        }
    }
    if node.kind() == SyntaxKind::CallExpression
        && node.expression().kind() == SyntaxKind::ImportKeyword
        && node.arguments().len() == 1
        && node.arguments().get(0).kind() == SyntaxKind::StringLiteral
    {
        let specifier = node.arguments().get(0);
        if let Some(resolved) =
            ts_goport::program::get_resolved_module_from_module_specifier(source, specifier)
            && !resolved.resolved_file_name.is_empty()
        {
            for import in out["imports"]
                .as_array_mut()
                .unwrap()
                .iter_mut()
                .filter(|import| {
                    import["fromRelPath"] == path
                        && import["_startByte"] == get_token_pos_of_node(node, source, false)
                        && import["moduleSpecifier"] == specifier.text()
                })
            {
                import["resolvedRelPath"] = json!(relative(&resolved.resolved_file_name, root));
            }
        }
    }
    node.for_each_child(|child| {
        enrich(child, source, checker, root, out);
        false
    });
}
