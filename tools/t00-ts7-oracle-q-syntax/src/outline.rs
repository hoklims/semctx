use serde_json::{Value, json};
use std::collections::BTreeSet;
use ts_goport::{
    ast,
    astdata::SyntaxKind,
    astnav,
    core::Node,
    flags::{NodeFlags, ScriptKind},
    frontend::{
        parser::{SourceFileParseOptions, parse_source_file},
        tspath::Path,
    },
};

fn sorted_names(names: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut names: Vec<_> = names.into_iter().collect();
    names.sort_by(|left, right| left.encode_utf16().cmp(right.encode_utf16()));
    names.dedup();
    names
}

fn children(node: Node) -> Vec<Node> {
    let mut result = Vec::new();
    node.for_each_child(|child| {
        result.push(child);
        false
    });
    result
}

fn has(node: Node, kind: SyntaxKind) -> bool {
    node.modifiers()
        .nodes()
        .iter()
        .any(|modifier| modifier.kind() == kind)
}

fn binding_names(node: Node) -> Vec<String> {
    if node.is_nil() {
        return Vec::new();
    }
    if node.kind() == SyntaxKind::Identifier {
        return vec![node.text().into()];
    }
    node.elements()
        .iter()
        .filter(|element| element.kind() != SyntaxKind::OmittedExpression)
        .flat_map(|element| binding_names(element.name()))
        .collect()
}

fn describe(node: Node) -> Value {
    use SyntaxKind::*;
    let exported = has(node, ExportKeyword);
    let default_export = has(node, DefaultKeyword);
    let kind = match node.kind() {
        FunctionDeclaration => "function",
        ClassDeclaration => "class",
        InterfaceDeclaration => "interface",
        TypeAliasDeclaration => "type",
        EnumDeclaration => "enum",
        ModuleDeclaration => "namespace",
        VariableStatement => "variable",
        ImportDeclaration | ImportEqualsDeclaration => "import",
        ExportDeclaration | ExportAssignment => "export",
        _ => "statement",
    };
    let mut declared = Vec::<String>::new();
    let mut locals = Vec::<String>::new();
    let mut side_effect = false;
    match node.kind() {
        FunctionDeclaration | ClassDeclaration | InterfaceDeclaration | TypeAliasDeclaration
        | EnumDeclaration | ModuleDeclaration => {
            let name = node.name();
            if !name.is_nil() && name.kind() == Identifier {
                declared.push(name.text().into());
            } else if default_export {
                declared.push("default".into());
            }
            if exported {
                locals.extend(declared.clone());
                if default_export && !name.is_nil() {
                    locals.push("default".into());
                }
            }
        }
        VariableStatement => {
            for declaration in node.declaration_list().declarations().nodes().iter() {
                declared.extend(binding_names(declaration.name()));
            }
            if exported {
                locals.extend(declared.clone());
            }
        }
        ImportDeclaration => {
            let clause = node.import_clause();
            side_effect = clause.is_nil();
            if !clause.is_nil() {
                if !clause.name().is_nil() {
                    declared.push(clause.name().text().into());
                }
                let names = clause.named_bindings();
                if !names.is_nil() {
                    if names.kind() == NamespaceImport {
                        declared.push(names.name().text().into());
                    } else {
                        declared.extend(
                            names
                                .elements()
                                .iter()
                                .map(|element| element.name().text().to_owned()),
                        );
                    }
                }
            }
        }
        ImportEqualsDeclaration => {
            declared.push(node.name().text().into());
            if exported {
                locals.extend(declared.clone());
            }
        }
        ExportDeclaration => {
            let clause = node.export_clause();
            if node.module_specifier().is_nil() && !clause.is_nil() && clause.kind() == NamedExports
            {
                for element in clause.elements().iter() {
                    locals.push(element.property_name_or_name().text().into());
                }
            }
        }
        ExportAssignment => {
            declared.push("default".into());
            locals.push("default".into());
            let mut expression = node.expression();
            while matches!(
                expression.kind(),
                PropertyAccessExpression | ElementAccessExpression | ParenthesizedExpression
            ) {
                expression = expression.expression();
            }
            if expression.kind() == Identifier {
                locals.push(expression.text().into());
            }
        }
        _ => {}
    }
    let mut description = json!({"kind":kind,"declaredNames":declared,"exportedLocals":locals});
    if side_effect {
        description["sideEffectImport"] = json!(true);
    }
    description
}

fn names_member(identifier: Node, parent: Node) -> bool {
    use SyntaxKind::*;
    if parent.is_nil() {
        return false;
    }
    match parent.kind() {
        PropertyAccessExpression => parent.name() == identifier,
        QualifiedName => parent.right() == identifier,
        PropertyAssignment | PropertyDeclaration | PropertySignature | MethodDeclaration
        | MethodSignature | GetAccessor | SetAccessor | EnumMember | JsxAttribute => {
            parent.name() == identifier
        }
        BindingElement | ImportSpecifier | ExportSpecifier => parent.property_name() == identifier,
        _ => false,
    }
}

fn reference_names(node: Node, declared: &BTreeSet<String>) -> BTreeSet<String> {
    fn visit(node: Node, parent: Node, declared: &BTreeSet<String>, result: &mut BTreeSet<String>) {
        if node.kind() == SyntaxKind::Identifier {
            if !names_member(node, parent) && !declared.contains(node.text()) {
                result.insert(node.text().into());
            }
            return;
        }
        if node.kind() == SyntaxKind::ShorthandPropertyAssignment {
            result.insert(node.name().text().into());
        }
        for child in children(node) {
            visit(child, node, declared, result);
        }
    }
    let mut result = BTreeSet::new();
    for child in children(node) {
        visit(child, node, declared, &mut result);
    }
    result
}

fn class_runs(node: Node) -> bool {
    use SyntaxKind::*;
    if has(node, Decorator) {
        return true;
    }
    if node.heritage_clauses().nodes().iter().any(|clause| {
        clause.token() == ExtendsKeyword
            && clause
                .types()
                .nodes()
                .iter()
                .any(|ty| expression_runs(ty.expression()))
    }) {
        return true;
    }
    node.members().iter().any(|member| {
        if member.kind() == ClassStaticBlockDeclaration || has(member, Decorator) {
            return true;
        }
        if ast::is_function_like(member)
            && member
                .parameters()
                .iter()
                .any(|parameter| has(parameter, Decorator))
        {
            return true;
        }
        let named = matches!(
            member.kind(),
            Constructor
                | MethodDeclaration
                | GetAccessor
                | SetAccessor
                | PropertyDeclaration
                | SemicolonClassElement
                | IndexSignature
        );
        if named {
            let name = member.name();
            if !name.is_nil()
                && name.kind() == ComputedPropertyName
                && expression_runs(name.expression())
            {
                return true;
            }
        }
        member.kind() == PropertyDeclaration
            && has(member, StaticKeyword)
            && !member.initializer().is_nil()
            && expression_runs(member.initializer())
    })
}

fn expression_runs(node: Node) -> bool {
    use SyntaxKind::*;
    if matches!(
        node.kind(),
        ArrowFunction
            | FunctionExpression
            | FunctionDeclaration
            | MethodDeclaration
            | GetAccessor
            | SetAccessor
            | Constructor
    ) {
        if has(node, Decorator) {
            return true;
        }
        let name = node.name();
        return !name.is_nil()
            && name.kind() == ComputedPropertyName
            && expression_runs(name.expression());
    }
    if ast::is_class_like(node) {
        return class_runs(node);
    }
    if matches!(
        node.kind(),
        CallExpression
            | NewExpression
            | TaggedTemplateExpression
            | AwaitExpression
            | YieldExpression
            | DeleteExpression
            | Decorator
    ) {
        return true;
    }
    if node.kind() == BinaryExpression && ast::is_assignment_operator(node.operator_token().kind())
    {
        return true;
    }
    if matches!(node.kind(), PrefixUnaryExpression | PostfixUnaryExpression)
        && matches!(node.operator(), PlusPlusToken | MinusMinusToken)
    {
        return true;
    }
    children(node)
        .into_iter()
        .filter(|child| !ast::is_type_node(*child))
        .any(expression_runs)
}

fn statement_runs(node: Node) -> bool {
    use SyntaxKind::*;
    if has(node, DeclareKeyword) {
        return false;
    }
    match node.kind() {
        FunctionDeclaration | InterfaceDeclaration | TypeAliasDeclaration => false,
        ImportDeclaration => node.import_clause().is_nil() || !node.import_clause().is_type_only(),
        ImportEqualsDeclaration => !node.is_type_only(),
        ExportDeclaration => !node.module_specifier().is_nil() && !node.is_type_only(),
        ExportAssignment => expression_runs(node.expression()),
        ClassDeclaration => class_runs(node),
        EnumDeclaration => {
            !has(node, ConstKeyword)
                && node.members().iter().any(|member| {
                    !member.initializer().is_nil() && expression_runs(member.initializer())
                })
        }
        ModuleDeclaration => {
            let body = node.body();
            if body.is_nil() {
                return false;
            }
            if body.kind() == ModuleBlock {
                body.statement_list().nodes().iter().any(statement_runs)
            } else {
                statement_runs(body)
            }
        }
        VariableStatement => {
            let declarations = node.declaration_list();
            declarations.flags().intersects(NodeFlags::USING)
                || declarations
                    .declarations()
                    .nodes()
                    .iter()
                    .any(|declaration| {
                        !declaration.initializer().is_nil()
                            && expression_runs(declaration.initializer())
                    })
        }
        _ => true,
    }
}

fn module_details(node: Node) -> Value {
    use SyntaxKind::*;
    let mut result = json!({});
    match node.kind() {
        ImportDeclaration => {
            let clause = node.import_clause();
            let mut bindings = Vec::new();
            let mut load = "yes";
            if !clause.is_nil() {
                let type_only = clause.is_type_only();
                if !clause.name().is_nil() {
                    bindings.push(json!({"local":clause.name().text(),"imported":"default","typeOnly":type_only}));
                }
                let named = clause.named_bindings();
                if !named.is_nil() {
                    if named.kind() == NamespaceImport {
                        bindings.push(json!({"local":named.name().text(),"imported":"*","typeOnly":type_only}));
                    } else {
                        bindings.extend(named.elements().iter().map(|binding| json!({"local":binding.name().text(),"imported":binding.property_name_or_name().text(),"typeOnly":type_only || binding.is_type_only()})));
                    }
                }
                load = if type_only {
                    "never"
                } else if !clause.name().is_nil()
                    || (!named.is_nil()
                        && (named.kind() == NamespaceImport
                            || named
                                .elements()
                                .iter()
                                .any(|element| !element.is_type_only())))
                {
                    "yes"
                } else {
                    "maybe"
                };
            }
            result["loadsModule"] = json!(load);
            if let Some(specifier) = literal(node.module_specifier()) {
                result["moduleSpecifier"] = json!(specifier);
                result["importBindings"] = json!(bindings);
            }
        }
        ImportEqualsDeclaration if node.module_reference().kind() == ExternalModuleReference => {
            result["loadsModule"] = json!(if node.is_type_only() { "never" } else { "yes" });
            if let Some(specifier) = literal(node.module_reference().expression()) {
                result["moduleSpecifier"] = json!(specifier);
                result["importBindings"] = json!([{"local":node.name().text(),"imported":"=","typeOnly":node.is_type_only()}]);
            }
        }
        ExportDeclaration if !node.module_specifier().is_nil() => {
            if let Some(specifier) = literal(node.module_specifier()) {
                result["moduleSpecifier"] = json!(specifier);
            }
            let clause = node.export_clause();
            let load = if node.is_type_only() {
                "never"
            } else if !clause.is_nil()
                && clause.kind() == NamedExports
                && clause
                    .elements()
                    .iter()
                    .all(|element| element.is_type_only())
            {
                "maybe"
            } else {
                "yes"
            };
            result["loadsModule"] = json!(load);
        }
        _ => {}
    }
    result
}

fn literal(node: Node) -> Option<String> {
    (!node.is_nil()
        && matches!(
            node.kind(),
            SyntaxKind::StringLiteral | SyntaxKind::NoSubstitutionTemplateLiteral
        ))
    .then(|| node.text().into())
}

fn line(file: Node, position: i32) -> usize {
    ast::source_file_ecma_line_map(file).partition_point(|start| *start <= position)
}

fn module_links(file: Node) -> Vec<Value> {
    fn visit(node: Node, file: Node, result: &mut Vec<Value>) {
        use SyntaxKind::*;
        let mut found = None;
        match node.kind() {
            ImportDeclaration => {
                let clause = node.import_clause();
                let whole = !clause.is_nil()
                    && !clause.is_type_only()
                    && !clause.named_bindings().is_nil()
                    && clause.named_bindings().kind() == NamespaceImport;
                found = Some(("import", literal(node.module_specifier()), whole));
            }
            ExportDeclaration if !node.module_specifier().is_nil() => {
                found = Some((
                    "reexport",
                    literal(node.module_specifier()),
                    !node.is_type_only()
                        && (node.export_clause().is_nil()
                            || node.export_clause().kind() == NamespaceExport),
                ));
            }
            ImportEqualsDeclaration
                if node.module_reference().kind() == ExternalModuleReference =>
            {
                found = Some((
                    "require",
                    literal(node.module_reference().expression()),
                    !node.is_type_only(),
                ));
            }
            CallExpression => {
                let expression = node.expression();
                if expression.kind() == ImportKeyword
                    || (expression.kind() == Identifier && expression.text() == "require")
                {
                    found = Some((
                        if expression.kind() == ImportKeyword {
                            "dynamic_import"
                        } else {
                            "require"
                        },
                        node.arguments().iter().next().and_then(literal),
                        true,
                    ));
                }
            }
            _ => {}
        }
        if let Some((kind, specifier, whole)) = found {
            let mut link = json!({"kind":kind,"specifier":specifier,"line":line(file, astnav::get_start_of_node(node,file,false))});
            if whole {
                link["whole"] = json!(true);
            }
            result.push(link);
        }
        for child in children(node) {
            visit(child, file, result);
        }
    }
    let mut result = Vec::new();
    visit(file, file, &mut result);
    result
}

fn word_end(text: &str, end: usize) -> bool {
    text[end..]
        .chars()
        .next()
        .is_none_or(|character| !character.is_ascii_alphanumeric() && character != '_')
}

fn directive(text: &str) -> bool {
    let prefixes = [
        "@ts-ignore",
        "@ts-expect-error",
        "@ts-nocheck",
        "@ts-check",
        "@jsx",
        "@jsxFrag",
        "@jsxImportSource",
        "@jsxRuntime",
    ];
    if prefixes.iter().any(|prefix| {
        text.match_indices(prefix)
            .any(|(start, _)| word_end(text, start + prefix.len()))
    }) {
        return true;
    }
    if [
        "#__PURE__",
        "@__PURE__",
        "__NO_SIDE_EFFECTS__",
        "@vite-ignore",
    ]
    .iter()
    .any(|needle| text.contains(needle))
    {
        return true;
    }
    for (start, _) in text.match_indices("webpack") {
        let suffix = &text[start + 7..];
        if suffix
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_uppercase)
        {
            let end = suffix.bytes().take_while(u8::is_ascii_alphabetic).count();
            if suffix[end..].trim_start().starts_with(':') {
                return true;
            }
        }
    }
    text.trim_start().strip_prefix("///").is_some_and(|suffix| {
        let suffix = suffix.trim_start();
        suffix.starts_with("<reference") || suffix.starts_with("<amd-module")
    })
}

fn marker(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    [
        "capability",
        "invariant",
        "contract",
        "risk",
        "boundedcontext",
        "tag",
    ]
    .iter()
    .any(|tag| {
        lower
            .match_indices(&format!("@{tag}"))
            .any(|(start, matched)| {
                let suffix = &lower[start + matched.len()..];
                let spaces = suffix
                    .bytes()
                    .take_while(|byte| matches!(byte, b' ' | b'\t'))
                    .count();
                spaces > 0
                    && suffix
                        .as_bytes()
                        .get(spaces)
                        .is_some_and(u8::is_ascii_alphanumeric)
            })
    })
}

fn structural_tokens(
    node: Node,
    file: Node,
    source: &str,
    tokens: &mut Vec<String>,
) -> Result<(), String> {
    use SyntaxKind::*;
    if node.kind() as u32 >= JsDocTypeExpression as u32 {
        return Ok(());
    }
    tokens.push(format!("{:?}", node.kind()));
    match node.kind() {
        Identifier
        | PrivateIdentifier
        | StringLiteral
        | NumericLiteral
        | BigIntLiteral
        | RegularExpressionLiteral
        | JsxText => tokens.push(node.text().into()),
        NoSubstitutionTemplateLiteral | TemplateHead | TemplateMiddle | TemplateTail => {
            let start = usize::try_from(astnav::get_start_of_node(node, file, false))
                .map_err(|_| "negative native template start")?;
            let end = usize::try_from(node.end()).map_err(|_| "negative native template end")?;
            tokens.push(
                source
                    .get(start..end)
                    .ok_or("native template span outside UTF-8 source")?
                    .into(),
            );
        }
        _ => {}
    }
    let children = ts_goport::ls::utilities::get_children_from_non_js_doc_node(node, file);
    for (position, child) in children.iter().enumerate() {
        if child.kind() == CommaToken
            || child.kind() == SemicolonToken && position + 1 == children.len()
        {
            continue;
        }
        structural_tokens(*child, file, source, tokens)?;
    }
    tokens.push(")".into());
    Ok(())
}

fn yield_expressions(node: Node, deferred: bool, result: &mut Vec<Value>) {
    let deferred = deferred || ast::is_function_like(node);
    if node.kind() == SyntaxKind::YieldExpression {
        result.push(json!({"fileScope":!deferred}));
    }
    for child in children(node) {
        yield_expressions(child, deferred, result);
    }
}

pub fn observe(input: &Value) -> Result<Value, String> {
    let source = input["source"]
        .as_str()
        .ok_or("outline requires string source")?;
    let filename = input["filename"]
        .as_str()
        .ok_or("outline requires string filename")?;
    let digest_relation = input.get("digestRelation").map_or(Ok(false), |value| {
        value.as_bool().ok_or("digestRelation requires boolean")
    })?;
    let yield_syntax = input.get("yieldSyntax").map_or(Ok(false), |value| {
        value.as_bool().ok_or("yieldSyntax requires boolean")
    })?;
    let parsed = parse_source_file(
        &SourceFileParseOptions {
            file_name: filename.into(),
            path: Path(filename.into()),
            ..Default::default()
        },
        ast::FileText::new(source.to_owned(), false),
        if filename.ends_with(".tsx") {
            ScriptKind::TSX
        } else {
            ScriptKind::TS
        },
    );
    let file = parsed.root;
    let mut exported = BTreeSet::<String>::new();
    let mut statements = Vec::new();
    let factory = ast::NodeFactory::new();
    for node in file.statement_list().nodes().iter() {
        let mut description = describe(node);
        for name in description["exportedLocals"].as_array().unwrap() {
            exported.insert(name.as_str().unwrap().into());
        }
        description
            .as_object_mut()
            .unwrap()
            .remove("exportedLocals");
        let names = description["declaredNames"]
            .as_array()
            .unwrap()
            .iter()
            .map(|name| name.as_str().unwrap().into())
            .collect();
        let start = astnav::get_start_of_node(node, file, false);
        description["startLine"] = json!(line(file, start));
        description["endLine"] = json!(line(file, node.end()));
        let comments =
            ts_goport::frontend::scanner::get_leading_comment_ranges(&factory, source, node.pos());
        description["leadingStartLine"] = json!(line(
            file,
            comments.first().map_or(start, |comment| comment.pos())
        ));
        description["referencedNames"] = json!(sorted_names(reference_names(node, &names)));
        description["executesOnLoad"] = json!(statement_runs(node));
        description
            .as_object_mut()
            .unwrap()
            .extend(module_details(node).as_object().unwrap().clone());
        statements.push(description);
    }
    let source_lines: Vec<_> = source.split('\n').collect();
    let mut observation = json!({
        "statements":statements,"exportedNames":sorted_names(exported),
        "hasSyntaxErrors":!ast::source_file_diagnostics(file).is_empty(),
        "directiveLines":source_lines.iter().enumerate().filter(|(_,text)| directive(text)).map(|(index,_)| index+1).collect::<Vec<_>>(),
        "markerLines":source_lines.iter().enumerate().filter(|(_,text)| marker(text)).map(|(index,_)| index+1).collect::<Vec<_>>(),
        "moduleLinks":module_links(file)
    });
    if digest_relation {
        let nodes: Vec<_> = file.statement_list().nodes().iter().collect();
        if nodes.len() != 2 || !ast::source_file_diagnostics(file).is_empty() {
            return Err("digestRelation requires exactly two syntax-clean statements".into());
        }
        let tokens: Vec<Vec<String>> = nodes
            .into_iter()
            .map(|node| {
                let mut tokens = Vec::new();
                structural_tokens(node, file, source, &mut tokens)?;
                Ok(tokens)
            })
            .collect::<Result<_, String>>()?;
        observation["digestEqual"] = json!(tokens[0] == tokens[1]);
        observation["structuralTokens"] = json!(tokens);
    }
    if yield_syntax {
        let mut expressions = Vec::new();
        yield_expressions(file, false, &mut expressions);
        observation["yieldExpressions"] = json!(expressions);
    }
    Ok(observation)
}

#[cfg(test)]
mod tests {
    use super::observe;
    use serde_json::json;

    #[test]
    fn projects_bindings_references_and_evaluation_from_native_syntax() {
        let _program = ts_goport::core::enter_program(None);
        let observed = observe(&json!({"source":"export const { a: local, nested: [first,,...rest] } = source;\nconst deferred = () => run();\nclass C { static value = run(); }", "filename":"main.ts"})).unwrap();
        assert_eq!(
            observed["statements"][0]["declaredNames"],
            json!(["local", "first", "rest"])
        );
        assert_eq!(
            observed["statements"][0]["referencedNames"],
            json!(["source"])
        );
        assert_eq!(observed["statements"][1]["executesOnLoad"], false);
        assert_eq!(observed["statements"][2]["executesOnLoad"], true);
    }

    #[test]
    fn distinguishes_module_loads_and_links() {
        let _program = ts_goport::core::enter_program(None);
        let observed = observe(&json!({"source":"import type * as types from './types';\nimport { type X } from './mixed';\nexport * from './star';\nimport(path); require('./dep');", "filename":"main.ts"})).unwrap();
        assert_eq!(observed["statements"][0]["loadsModule"], "never");
        assert_eq!(observed["statements"][1]["loadsModule"], "maybe");
        assert_eq!(
            observed["moduleLinks"][0],
            json!({"kind":"import","specifier":"./types","line":1})
        );
        assert_eq!(
            observed["moduleLinks"][3],
            json!({"kind":"dynamic_import","specifier":null,"line":4,"whole":true})
        );
    }

    #[test]
    fn counts_lines_after_astral_text_comments_and_ecma_line_breaks() {
        let _program = ts_goport::core::enter_program(None);
        let observed = observe(&json!({"source":"/** 😀 */\r\nconst value = source;\u{2028}class C {}", "filename":"main.ts"})).unwrap();
        assert_eq!(observed["statements"][0]["startLine"], 2);
        assert_eq!(observed["statements"][0]["leadingStartLine"], 1);
        assert_eq!(observed["statements"][1]["startLine"], 3);
        assert_eq!(observed["hasSyntaxErrors"], false);
    }

    #[test]
    fn reports_syntax_recovery_and_directive_controls() {
        let _program = ts_goport::core::enter_program(None);
        let observed = observe(&json!({"source":"// @ts-check\n// @ts-checkmate\n/** @invariant INV-1 */\nconst broken = ;", "filename":"main.ts"})).unwrap();
        assert_eq!(observed["directiveLines"], json!([1]));
        assert_eq!(observed["markerLines"], json!([3]));
        assert_eq!(observed["hasSyntaxErrors"], true);
    }

    #[test]
    fn orders_names_by_utf16_code_units() {
        let _program = ts_goport::core::enter_program(None);
        let observed = observe(
            &json!({"source":"const value = [𐐀, Ａ]; export {𐐀, Ａ};", "filename":"main.ts"}),
        )
        .unwrap();
        assert_eq!(
            observed["statements"][0]["referencedNames"],
            json!(["𐐀", "Ａ"])
        );
        assert_eq!(observed["exportedNames"], json!(["𐐀", "Ａ"]));
    }

    #[test]
    fn rejects_missing_source() {
        assert!(observe(&json!({"filename":"main.ts"})).is_err());
    }

    #[test]
    fn token_children_distinguish_semantic_edits_and_ignore_layout() {
        let _program = ts_goport::core::enter_program(None);
        for (left, right, equal) in [
            (
                "const value = left + right;",
                "const value = left - right;",
                false,
            ),
            (
                "class Value extends Base {}",
                "class Value implements Base {}",
                false,
            ),
            ("let value = 1;", "const value = 1;", false),
            (
                "const value = String.raw`a\\nb`;",
                "const value = String.raw`a\\x0ab`;",
                false,
            ),
            (
                "const value = String.raw`😀a\\nb`;",
                "const value = String.raw`😀a\\x0ab`;",
                false,
            ),
            (
                "const value = String.raw`😀`;",
                "const value = String.raw`😀`",
                true,
            ),
            (
                "class Value { #first = 1; }",
                "class Value { #second = 1; }",
                false,
            ),
            (
                "const value = [1, 2];",
                "const value = [ 1, /* keep */ 2, ]",
                true,
            ),
            (
                "interface Value { a: string; b: number }",
                "interface Value { a: string, b: number, }",
                true,
            ),
        ] {
            let observed = observe(&json!({"filename":"main.ts", "source":format!("{left}\n{right}"), "digestRelation":true})).unwrap();
            assert_eq!(observed["digestEqual"], equal, "{left} / {right}");
        }
    }

    #[test]
    fn digest_relation_requires_two_statements() {
        let _program = ts_goport::core::enter_program(None);
        assert!(
            observe(
                &json!({"filename":"main.ts", "source":"const value = 1;", "digestRelation":true})
            )
            .is_err()
        );
        assert!(observe(&json!({"filename":"main.ts", "source":"const value = ;\nconst other = ;", "digestRelation":true})).is_err());
        for field in ["digestRelation", "yieldSyntax"] {
            let mut input = json!({"filename":"main.ts", "source":"const value = 1;"});
            input[field] = json!("true");
            assert!(observe(&input).is_err());
        }
    }

    #[test]
    fn observes_yield_syntax_separately_from_accepted_execution() {
        let _program = ts_goport::core::enter_program(None);
        let observed = observe(&json!({"filename":"main.ts", "source":"const value = yield 1;\nfunction* deferred() { yield 1; }", "yieldSyntax":true})).unwrap();
        assert_eq!(
            observed["yieldExpressions"],
            json!([{"fileScope":true}, {"fileScope":false}])
        );
        assert_eq!(observed["statements"][0]["executesOnLoad"], true);
        assert_eq!(observed["statements"][1]["executesOnLoad"], false);
    }
}
