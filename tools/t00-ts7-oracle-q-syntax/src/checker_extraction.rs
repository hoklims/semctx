use crate::extraction::{
    function_value, import_names, line, object_member_ancestor, owner_name, record_symbol, scope,
    unwrap,
};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
use ts_goport::{prelude::*, scanner_util::get_token_pos_of_node};

fn de_alias(checker: &mut Checker, symbol: SymbolId) -> SymbolId {
    if symbol.is_some() && checker.sym(symbol).flags.intersects(SymbolFlags::ALIAS) {
        checker.get_aliased_symbol(symbol)
    } else {
        symbol
    }
}

fn ambiguous_exports() -> Result<BTreeMap<String, BTreeSet<String>>, String> {
    let mut ambiguous = BTreeMap::<String, BTreeSet<String>>::new();
    for source in source_files() {
        let absolute = source_file_file_name(source);
        let Some(path) = absolute.strip_prefix("/project/") else {
            continue;
        };
        if source_file_info(source).is_declaration_file {
            continue;
        }
        for diagnostic in get_semantic_diagnostics(source) {
            if diagnostic.code != 2308 {
                continue;
            }
            let name = diagnostic
                .message_args
                .get(1)
                .filter(|name| !name.is_empty())
                .ok_or("TS2308 did not expose its ambiguous export name")?;
            ambiguous
                .entry(path.to_string())
                .or_default()
                .insert(name.clone());
        }
    }
    Ok(ambiguous)
}

fn imported_ambiguity(
    checker: &mut Checker,
    symbol: SymbolId,
    input: &Value,
    ambiguous: &BTreeMap<String, BTreeSet<String>>,
) -> bool {
    if !symbol.is_some() || ambiguous.is_empty() {
        return false;
    }
    let declarations: Vec<Node> = checker.sym(symbol).declarations.iter().copied().collect();
    declarations.into_iter().any(|declaration| {
        if declaration.kind() != SyntaxKind::ImportSpecifier {
            return false;
        }
        let name = if declaration.property_name().is_some() {
            declaration.property_name()
        } else {
            declaration.name()
        };
        let mut import = declaration.parent();
        while import.is_some()
            && !matches!(
                import.kind(),
                SyntaxKind::ImportDeclaration | SyntaxKind::SourceFile
            )
        {
            import = import.parent();
        }
        if import.kind() != SyntaxKind::ImportDeclaration {
            return false;
        }
        resolved_module(checker, import.module_specifier(), input)
            .and_then(|path| ambiguous.get(&path))
            .is_some_and(|names| names.contains(name.text()))
    })
}

fn target(
    checker: &mut Checker,
    expression: Node,
    supplied: SymbolId,
    input: &Value,
    ambiguous: &BTreeMap<String, BTreeSet<String>>,
) -> Option<Value> {
    let symbol = if supplied.is_some() {
        supplied
    } else {
        checker.get_symbol_at_location_exported(expression)
    };
    if imported_ambiguity(checker, symbol, input, ambiguous) {
        return None;
    }
    let symbol = de_alias(checker, symbol);
    if !symbol.is_some() {
        return None;
    }
    let declaration = *checker.sym(symbol).declarations.first()?;
    let source = get_source_file_of_node(declaration);
    let path = source_file_file_name(source);
    let mut names = scope(declaration, true);
    names.push(owner_name(declaration).unwrap_or_else(|| checker.sym(symbol).name.to_string()));
    let mut result = json!({"symbolPath":names.join(".")});
    if source_file_info(source).is_declaration_file {
        let javascript = input["roots"]
            .as_array()
            .map(|roots| roots.iter().filter_map(Value::as_str).collect::<Vec<_>>())
            .unwrap_or_else(|| {
                input["files"]
                    .as_object()
                    .unwrap()
                    .keys()
                    .map(String::as_str)
                    .collect()
            });
        if javascript.iter().any(|path| {
            [".js", ".jsx", ".mjs", ".cjs"]
                .iter()
                .any(|extension| path.ends_with(extension))
        }) {
            for (declaration_extension, runtime_extension) in
                [(".d.mts", ".mjs"), (".d.cts", ".cjs"), (".d.ts", ".js")]
            {
                let Some(stem) = path.strip_suffix(declaration_extension) else {
                    continue;
                };
                let runtime = format!("{stem}{runtime_extension}");
                let relative = runtime.strip_prefix("/project/")?;
                if input["files"].get(relative).is_some() {
                    result["relPath"] = json!(relative);
                }
            }
        }
        return Some(result);
    }
    result["relPath"] = json!(path.strip_prefix("/project/")?);
    let reason = if declaration.parent().kind() == SyntaxKind::ObjectLiteralExpression {
        Some("OBJECT_LITERAL_MEMBER")
    } else if matches!(
        declaration.kind(),
        SyntaxKind::EnumDeclaration | SyntaxKind::EnumMember
    ) {
        Some("ENUM_VALUE")
    } else if declaration.kind() == SyntaxKind::VariableDeclaration
        && !function_value(declaration.initializer())
    {
        Some("VALUE_DECLARATION")
    } else {
        None
    };
    if let Some(reason) = reason {
        result["unmodeledReason"] = json!(reason);
    }
    Some(result)
}

fn runtime_references(node: Node, checker: &mut Checker, result: &mut Vec<SymbolId>) {
    let kind = node.kind();
    if matches!(
        kind,
        SyntaxKind::ImportDeclaration
            | SyntaxKind::InterfaceDeclaration
            | SyntaxKind::TypeAliasDeclaration
    ) || get_combined_modifier_flags(node).intersects(ModifierFlags::AMBIENT)
    {
        return;
    }
    if is_type_node(node) {
        let parent = node.parent();
        if kind == SyntaxKind::ExpressionWithTypeArguments
            && parent.kind() == SyntaxKind::HeritageClause
            && parent.token() == SyntaxKind::ExtendsKeyword
            && matches!(
                parent.parent().kind(),
                SyntaxKind::ClassDeclaration | SyntaxKind::ClassExpression
            )
        {
            runtime_references(node.expression(), checker, result);
        }
        return;
    }
    if matches!(
        kind,
        SyntaxKind::ExportDeclaration | SyntaxKind::ExportSpecifier
    ) && node.is_type_only()
    {
        return;
    }
    if kind == SyntaxKind::Identifier {
        let symbol = match node.parent().kind() {
            SyntaxKind::ShorthandPropertyAssignment => {
                checker.get_shorthand_assignment_value_symbol(node.parent())
            }
            SyntaxKind::ExportSpecifier => {
                checker.get_export_specifier_local_target_symbol(node.parent())
            }
            _ => checker.get_symbol_at_location_exported(node),
        };
        if symbol.is_some() {
            result.push(symbol);
        }
    }
    node.for_each_child(|child| {
        runtime_references(child, checker, result);
        false
    });
}

fn namespace_references(
    node: Node,
    checker: &mut Checker,
    result: &mut Vec<(SymbolId, Node, SymbolId)>,
) {
    if is_type_node(node) {
        return;
    }
    let candidate = if node.kind() == SyntaxKind::PropertyAccessExpression
        || (node.kind() == SyntaxKind::ElementAccessExpression
            && is_string_literal_like(node.argument_expression()))
    {
        let mut receiver = unwrap(node.expression());
        while matches!(
            receiver.kind(),
            SyntaxKind::PropertyAccessExpression | SyntaxKind::ElementAccessExpression
        ) {
            receiver = unwrap(receiver.expression());
        }
        Some((
            checker.get_symbol_at_location_exported(receiver),
            node,
            checker.get_symbol_at_location_exported(node),
        ))
    } else if node.kind() == SyntaxKind::BindingElement
        && node.dot_dot_dot_token().is_nil()
        && node.name().kind() == SyntaxKind::Identifier
        && node.parent().kind() == SyntaxKind::ObjectBindingPattern
        && node.parent().parent().kind() == SyntaxKind::VariableDeclaration
        && node.parent().parent().initializer().is_some()
    {
        let receiver = unwrap(node.parent().parent().initializer());
        let binding = checker.get_symbol_at_location_exported(receiver);
        if binding.is_some()
            && checker
                .sym(binding)
                .declarations
                .iter()
                .any(|declaration| declaration.kind() == SyntaxKind::NamespaceImport)
        {
            let property = if node.property_name().is_some() {
                node.property_name()
            } else {
                node.name()
            };
            if property.kind() == SyntaxKind::Identifier || is_string_literal_like(property) {
                let receiver_type = checker.get_type_at_location(receiver);
                Some((
                    binding,
                    node.name(),
                    checker.get_property_of_type_exported(receiver_type, property.text()),
                ))
            } else {
                None
            }
        } else {
            None
        }
    } else {
        None
    };
    if let Some((binding, expression, symbol)) = candidate {
        let symbol = de_alias(checker, symbol);
        if binding.is_some()
            && symbol.is_some()
            && checker
                .sym(symbol)
                .declarations
                .first()
                .is_some_and(|declaration| {
                    matches!(
                        declaration.kind(),
                        SyntaxKind::FunctionDeclaration
                            | SyntaxKind::ClassDeclaration
                            | SyntaxKind::VariableDeclaration
                            | SyntaxKind::EnumDeclaration
                            | SyntaxKind::EnumMember
                    )
                })
        {
            result.push((binding, expression, symbol));
        }
    }
    node.for_each_child(|child| {
        namespace_references(child, checker, result);
        false
    });
}

fn resolved_module(checker: &mut Checker, literal: Node, input: &Value) -> Option<String> {
    let symbol = checker.get_symbol_at_location_exported(literal);
    if !symbol.is_some() {
        return None;
    }
    checker
        .sym(symbol)
        .declarations
        .iter()
        .find_map(|declaration| {
            let source = get_source_file_of_node(*declaration);
            let path = source_file_file_name(source).strip_prefix("/project/")?;
            for (declaration_extension, runtime_extension) in
                [(".d.mts", ".mjs"), (".d.cts", ".cjs"), (".d.ts", ".js")]
            {
                if let Some(stem) = path.strip_suffix(declaration_extension) {
                    let runtime = format!("{stem}{runtime_extension}");
                    if input["files"].get(&runtime).is_some() {
                        return Some(runtime);
                    }
                }
            }
            Some(path.to_string())
        })
}

struct FileFacts<'a> {
    source: Node,
    path: &'a str,
    input: &'a Value,
    ambiguous: &'a BTreeMap<String, BTreeSet<String>>,
    runtime: Vec<SymbolId>,
    namespace: Vec<(SymbolId, Node, SymbolId)>,
    exported: Vec<Node>,
}

fn walk(node: Node, checker: &mut Checker, facts: &FileFacts<'_>, output: &mut Value) {
    let source = facts.source;
    let path = facts.path;
    let text = source_file_text(source);
    if let Some(mut symbol) = record_symbol(node, source, &text, path) {
        if facts.exported.contains(&node) {
            symbol["exported"] = json!(true);
        }
        output["symbols"].as_array_mut().unwrap().push(symbol);
    }
    if node.kind() == SyntaxKind::ImportDeclaration
        && node.module_specifier().kind() == SyntaxKind::StringLiteral
    {
        let clause = node.import_clause();
        let mut references = Vec::new();
        if clause.is_some() && !clause.is_type_only() {
            if clause.name().is_some() {
                references.push((clause.name(), SymbolId::NIL));
            }
            let bindings = clause.named_bindings();
            if bindings.is_some() && bindings.kind() == SyntaxKind::NamedImports {
                references.extend(
                    bindings
                        .elements()
                        .iter()
                        .filter(|binding| !binding.is_type_only())
                        .map(|binding| (binding.name(), SymbolId::NIL)),
                );
            } else if bindings.is_some() && bindings.kind() == SyntaxKind::NamespaceImport {
                let symbol = checker.get_symbol_at_location_exported(bindings.name());
                references.extend(
                    facts
                        .namespace
                        .iter()
                        .filter(|(binding, _, _)| *binding == symbol)
                        .map(|(_, expression, target)| (*expression, *target)),
                );
            }
        }
        let mut targets = Vec::new();
        for (expression, supplied) in references {
            let Some(mut value) =
                target(checker, expression, supplied, facts.input, facts.ambiguous)
            else {
                continue;
            };
            if value.get("relPath").is_none() {
                continue;
            }
            if expression.kind() == SyntaxKind::Identifier && !supplied.is_some() {
                let symbol = checker.get_symbol_at_location_exported(expression);
                if !facts.runtime.contains(&symbol) {
                    value["runtimeUsed"] = json!(false);
                }
            }
            targets.push(value);
        }
        let mut import = json!({"fromRelPath":path,"moduleSpecifier":node.module_specifier().text(),"names":import_names(node),"bindingTargets":targets,"line":line(source,get_token_pos_of_node(node,source,false))});
        if let Some(resolved) = resolved_module(checker, node.module_specifier(), facts.input) {
            import["resolvedRelPath"] = json!(resolved);
        }
        output["imports"].as_array_mut().unwrap().push(import);
    }
    let export_literal = (node.kind() == SyntaxKind::ExportDeclaration
        && node.module_specifier().is_some()
        && node.module_specifier().kind() == SyntaxKind::StringLiteral)
        .then(|| node.module_specifier());
    let dynamic_literal = (node.kind() == SyntaxKind::CallExpression
        && node.expression().kind() == SyntaxKind::ImportKeyword
        && node.arguments().len() == 1
        && node.arguments().get(0).kind() == SyntaxKind::StringLiteral)
        .then(|| node.arguments().get(0));
    if let Some(literal) = export_literal.or(dynamic_literal) {
        let mut import = json!({"fromRelPath":path,"moduleSpecifier":literal.text(),"names":[],"line":line(source,get_token_pos_of_node(node,source,false))});
        if let Some(resolved) = resolved_module(checker, literal, facts.input) {
            import["resolvedRelPath"] = json!(resolved);
        }
        output["imports"].as_array_mut().unwrap().push(import);
    }
    if node.kind() == SyntaxKind::CallExpression {
        let callee = unwrap(node.expression());
        let name = match callee.kind() {
            SyntaxKind::Identifier => Some(callee.text()),
            SyntaxKind::PropertyAccessExpression => Some(callee.name().text()),
            _ => None,
        };
        if let Some(name) = name {
            let mut call = json!({"callerRelPath":path,"calleeName":name,"line":line(source,get_token_pos_of_node(node,source,false))});
            let mut ancestor = node.parent();
            while ancestor.is_some() {
                if matches!(
                    ancestor.kind(),
                    SyntaxKind::FunctionDeclaration
                        | SyntaxKind::ClassDeclaration
                        | SyntaxKind::VariableDeclaration
                ) && let Some(name) = owner_name(ancestor)
                {
                    let mut names = scope(ancestor, false);
                    names.push(name);
                    call["callerSymbolPath"] = json!(names.join("."));
                    break;
                }
                ancestor = ancestor.parent();
            }
            if object_member_ancestor(node) {
                call["callerUnmodeledReason"] = json!("OBJECT_LITERAL_MEMBER");
            }
            if let Some(target) =
                target(checker, callee, SymbolId::NIL, facts.input, facts.ambiguous)
            {
                attach_call_target(&mut call, &target);
            }
            output["calls"].as_array_mut().unwrap().push(call);
        }
    }
    node.for_each_child(|child| {
        walk(child, checker, facts, output);
        false
    });
}

fn attach_call_target(call: &mut Value, target: &Value) {
    for (source, dest) in [
        ("relPath", "calleeRelPath"),
        ("symbolPath", "calleeSymbolPath"),
        ("unmodeledReason", "calleeUnmodeledReason"),
    ] {
        if let Some(value) = target.get(source) {
            call[dest] = value.clone();
        }
    }
}

fn exported_declarations(source: Node, checker: &mut Checker) -> Vec<Node> {
    let symbol = checker.get_symbol_at_location_exported(source);
    if !symbol.is_some() {
        return Vec::new();
    }
    let mut declarations = Vec::new();
    for symbol in checker.get_exports_of_module_exported(symbol) {
        let symbol = de_alias(checker, symbol);
        if symbol.is_some() {
            declarations.extend(checker.sym(symbol).declarations.iter().copied());
        }
    }
    declarations
}

pub fn observe(input: &Value) -> Result<Value, String> {
    let roots = crate::checker_program::install(input)?;
    let ambiguous = if input["qualified"].as_bool() == Some(true) {
        ambiguous_exports()?
    } else {
        BTreeMap::new()
    };
    let mut output = json!({"modules":[],"symbols":[],"imports":[],"calls":[]});
    let mut loaded = Vec::new();
    for source in source_files() {
        let absolute = source_file_file_name(source);
        loaded.push(absolute.to_string());
        if source_file_info(source).is_declaration_file
            || !roots.iter().any(|root| root == absolute)
        {
            continue;
        }
        let path = absolute
            .strip_prefix("/project/")
            .ok_or("source escaped project")?;
        output["modules"].as_array_mut().unwrap().push(json!(path));
        let input = input.clone();
        let ambiguous = ambiguous.clone();
        let file_output = with_type_checker_for_file(source, move |checker| {
            let mut output = json!({"symbols":[],"imports":[],"calls":[]});
            let mut runtime = Vec::new();
            runtime_references(source, checker, &mut runtime);
            let mut namespace = Vec::new();
            namespace_references(source, checker, &mut namespace);
            let exported = exported_declarations(source, checker);
            walk(
                source,
                checker,
                &FileFacts {
                    source,
                    path,
                    input: &input,
                    ambiguous: &ambiguous,
                    runtime,
                    namespace,
                    exported,
                },
                &mut output,
            );
            output
        });
        for field in ["symbols", "imports", "calls"] {
            output[field]
                .as_array_mut()
                .unwrap()
                .extend(file_output[field].as_array().unwrap().iter().cloned());
        }
    }
    loaded.sort();
    output["loadedFiles"] = json!(loaded);
    output["exportAmbiguity"] = json!({});
    for root in &roots {
        let path = root
            .strip_prefix("/project/")
            .ok_or("root escaped project")?;
        let rejected = ambiguous.get(path).is_some_and(|names| !names.is_empty());
        output["exportAmbiguity"][path] = json!({"reasons": if rejected { vec!["SOURCE_EXPORT_AMBIGUOUS"] } else { vec![] }, "outcome": if rejected { "unsupported" } else { "analyzed" }});
    }
    output["callEdges"] = Value::Array(output["calls"].as_array().unwrap().iter().filter_map(|call| {
        Some(json!({"kind":"calls","from":{"path":call["callerRelPath"],"symbol_path":call.get("callerSymbolPath")?},"to":{"path":call.get("calleeRelPath")?,"symbol_path":call.get("calleeSymbolPath")?}}))
    }).collect());
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::observe;
    use serde_json::{Value, json};

    fn extract(files: Value) -> Value {
        let sdk = crate::checker_program::test_sdk_directory();
        observe(&json!({"files":files,"sdk_directory":sdk.path})).unwrap()
    }

    #[test]
    fn exports_aliases_and_call_targets_come_from_program_symbols() {
        let got = extract(
            json!({"main.ts":"import { helper } from './helper'; helper(); missing();", "helper.ts":"function helper() {} export { helper };"}),
        );
        assert_eq!(got["symbols"][0]["exported"], true);
        assert_eq!(
            got["imports"][0]["bindingTargets"],
            json!([{"relPath":"helper.ts","symbolPath":"helper"}])
        );
        assert_eq!(got["calls"][0]["calleeRelPath"], "helper.ts");
        assert_eq!(got["calls"][0]["calleeSymbolPath"], "helper");
        assert_eq!(got["calls"][1].get("calleeRelPath"), None);
        assert!(
            got["loadedFiles"]
                .as_array()
                .unwrap()
                .iter()
                .any(|path| path.as_str().unwrap().starts_with("/sdk/lib/"))
        );
    }

    #[test]
    fn runtime_origins_distinguish_shorthand_exports_extends_and_erased_uses() {
        let got = extract(json!({
            "api.ts":"export function used() {} export function unused() {} export class Base {}",
            "main.ts":"import {used as short, used as exported, Base, unused, used as erased, used as shadowed} from './api'; const object = {short}; export {exported}; class Child extends Base {} type Erased = typeof erased; function f(shadowed: number) {return shadowed;}"
        }));
        let targets = got["imports"][0]["bindingTargets"].as_array().unwrap();
        assert_eq!(targets.len(), 6);
        for target in &targets[..3] {
            assert_eq!(target.get("runtimeUsed"), None);
        }
        for target in &targets[3..] {
            assert_eq!(target["runtimeUsed"], false);
        }
    }

    #[test]
    fn namespace_direct_and_destructured_targets_exclude_literal_brackets() {
        let got = extract(json!({
            "api.ts":"export function helper() {} export function sibling() {} export const FLAG = 1;",
            "main.ts":"import * as ns from './api'; ns.helper(); ns['helper']; const {helper: alias} = ns; ns.FLAG; type Erased = typeof ns.sibling; consume(ns); ns[computed];"
        }));
        assert_eq!(
            got["imports"][0]["bindingTargets"],
            json!([
                {"relPath":"api.ts","symbolPath":"helper"},
                {"relPath":"api.ts","symbolPath":"helper"},
                {"relPath":"api.ts","symbolPath":"FLAG","unmodeledReason":"VALUE_DECLARATION"}
            ])
        );
        let brackets = extract(json!({
            "api.ts":"export function helper() {}",
            "main.ts":"import * as ns from './api'; ns['helper']; ns[`helper`];"
        }));
        assert_eq!(brackets["imports"][0]["bindingTargets"], json!([]));
    }

    #[test]
    fn declaration_only_targets_keep_symbol_without_fabricating_runtime_path() {
        let got = extract(json!({
            "main.ts":"import {declared} from './api'; declared();",
            "api.d.ts":"export declare function declared(): void;"
        }));
        assert_eq!(got["imports"][0]["bindingTargets"], json!([]));
        assert_eq!(got["calls"][0]["calleeSymbolPath"], "declared");
        assert_eq!(got["calls"][0].get("calleeRelPath"), None);
        let got = extract(json!({
            "main.js":"import {declared} from './api.js'; declared();",
            "api.d.ts":"export declare function declared(): void;",
            "api.js":"export function declared() {}"
        }));
        assert_eq!(got["imports"][0]["resolvedRelPath"], "api.js");
        assert_eq!(
            got["imports"][0]["bindingTargets"],
            json!([{"relPath":"api.js","symbolPath":"declared"}])
        );
        assert_eq!(got["calls"][0]["calleeRelPath"], "api.js");
    }

    #[test]
    fn ambiguous_star_orders_refuse_arbitrary_targets_and_explicit_export_controls_the_target() {
        let sdk = crate::checker_program::test_sdk_directory();
        for (barrel, rejected) in [
            ("export * from './a'; export * from './b';", true),
            ("export * from './b'; export * from './a';", true),
            ("export { same } from './b'; export * from './a';", false),
        ] {
            let got = observe(&json!({"qualified":true,"sdk_directory":sdk.path,"files":{
                "a.ts":"export function same() { return 1; }",
                "b.ts":"export function same() { return 2; }",
                "barrel.ts":barrel,
                "main.ts":"import { same } from './barrel'; export function main() { return same(); }"
            }})).unwrap();
            assert_eq!(
                got["exportAmbiguity"]["barrel.ts"]["reasons"],
                if rejected {
                    json!(["SOURCE_EXPORT_AMBIGUOUS"])
                } else {
                    json!([])
                }
            );
            assert_eq!(
                got["exportAmbiguity"]["barrel.ts"]["outcome"],
                if rejected { "unsupported" } else { "analyzed" }
            );
            if rejected {
                assert_eq!(got["calls"][0].get("calleeRelPath"), None);
                assert_eq!(got["calls"][0].get("calleeSymbolPath"), None);
                assert_eq!(got["callEdges"], json!([]));
                let import = got["imports"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|import| import["fromRelPath"] == "main.ts")
                    .unwrap();
                assert_eq!(import["bindingTargets"], json!([]));
            } else {
                assert_eq!(got["calls"][0]["calleeRelPath"], "b.ts");
                assert_eq!(got["calls"][0]["calleeSymbolPath"], "same");
                assert_eq!(
                    got["callEdges"],
                    json!([{"kind":"calls","from":{"path":"main.ts","symbol_path":"main"},"to":{"path":"b.ts","symbol_path":"same"}}])
                );
            }
        }
    }

    #[test]
    fn invalid_file_root_or_sdk_refuses_observation() {
        assert!(observe(&json!({"files":{}})).is_err());
        assert!(observe(&json!({"files":{"main.ts":""},"roots":"main.ts"})).is_err());
        assert!(observe(&json!({"files":{"main.ts":""},"options":{"module":"CommonJS"}})).is_err());
        assert!(observe(&json!({"files":{"../escape.ts":""}})).is_err());
        assert!(observe(&json!({"files":{"main.ts":7}})).is_err());
        assert!(observe(&json!({"files":{"main.ts":""},"roots":["absent.ts"]})).is_err());
        assert!(observe(&json!({"files":{"main.ts":""},"sdk_directory":"/missing-sdk"})).is_err());
    }
}
