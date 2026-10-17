use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use ts_goport::{
    ast,
    astdata::SyntaxKind as K,
    astnav,
    core::Node,
    flags::{LanguageVariant, NodeFlags, ScriptKind},
};

fn modifier(node: Node, kind: K) -> bool {
    node.modifiers().nodes().iter().any(|m| m.kind() == kind)
}

fn bindings(name: Node, names: &mut Vec<String>) {
    if name.is_nil() {
        return;
    }
    if name.kind() == K::Identifier {
        names.push(name.text().into());
        return;
    }
    for element in name.elements().iter() {
        if element.kind() != K::OmittedExpression {
            bindings(element.name(), names);
        }
    }
}

fn describe(node: Node) -> (&'static str, Vec<String>, Vec<String>, bool) {
    let exported = modifier(node, K::ExportKeyword);
    let default = modifier(node, K::DefaultKeyword);
    let named_kind = match node.kind() {
        K::FunctionDeclaration => Some("function"),
        K::ClassDeclaration => Some("class"),
        K::InterfaceDeclaration => Some("interface"),
        K::TypeAliasDeclaration => Some("type"),
        K::EnumDeclaration => Some("enum"),
        K::ModuleDeclaration => Some("namespace"),
        _ => None,
    };
    if let Some(kind) = named_kind {
        let name = node.name();
        let names = if name.is_some() && name.kind() == K::Identifier {
            vec![name.text().into()]
        } else if default {
            vec!["default".into()]
        } else {
            vec![]
        };
        let mut exports = if exported { names.clone() } else { vec![] };
        if exported && default && name.is_some() {
            exports.push("default".into());
        }
        return (kind, names, exports, false);
    }
    match node.kind() {
        K::VariableStatement => {
            let mut names = vec![];
            for declaration in node.declaration_list().declarations().nodes().iter() {
                bindings(declaration.name(), &mut names);
            }
            (
                "variable",
                names.clone(),
                if exported { names } else { vec![] },
                false,
            )
        }
        K::ImportDeclaration => {
            let clause = node.import_clause();
            if clause.is_nil() {
                return ("import", vec![], vec![], true);
            }
            let mut names = vec![];
            if clause.name().is_some() {
                names.push(clause.name().text().into());
            }
            let named = clause.named_bindings();
            if named.is_some() {
                if named.kind() == K::NamespaceImport {
                    names.push(named.name().text().into());
                } else {
                    for element in named.elements().iter() {
                        names.push(element.name().text().into());
                    }
                }
            }
            ("import", names, vec![], false)
        }
        K::ImportEqualsDeclaration => {
            let names = vec![node.name().text().into()];
            (
                "import",
                names.clone(),
                if exported { names } else { vec![] },
                false,
            )
        }
        K::ExportDeclaration => {
            let mut exports = vec![];
            let clause = node.export_clause();
            if node.module_specifier().is_nil()
                && clause.is_some()
                && clause.kind() == K::NamedExports
            {
                for element in clause.elements().iter() {
                    exports.push(element.property_name_or_name().text().into());
                }
            }
            ("export", vec![], exports, false)
        }
        K::ExportAssignment => {
            let mut root = node.expression();
            while matches!(
                root.kind(),
                K::PropertyAccessExpression
                    | K::ElementAccessExpression
                    | K::ParenthesizedExpression
            ) {
                root = root.expression();
            }
            let mut exports = vec!["default".into()];
            if root.kind() == K::Identifier {
                exports.push(root.text().into());
            }
            ("export", vec!["default".into()], exports, false)
        }
        _ => ("statement", vec![], vec![], false),
    }
}

fn member_name(node: Node) -> bool {
    let parent = node.parent();
    if parent.is_nil() {
        return false;
    }
    match parent.kind() {
        K::PropertyAccessExpression => parent.name() == node,
        K::QualifiedName => parent.right() == node,
        K::PropertyAssignment
        | K::PropertyDeclaration
        | K::PropertySignature
        | K::MethodDeclaration
        | K::MethodSignature
        | K::GetAccessor
        | K::SetAccessor
        | K::EnumMember
        | K::JsxAttribute => parent.name() == node,
        K::BindingElement | K::ImportSpecifier | K::ExportSpecifier => {
            parent.property_name() == node
        }
        _ => false,
    }
}

fn references(statement: Node, declared: &[String]) -> Vec<String> {
    fn visit(node: Node, declared: &[String], found: &mut BTreeSet<String>) {
        if node.kind() == K::Identifier {
            if !member_name(node) && !declared.iter().any(|s| s == node.text()) {
                found.insert(node.text().into());
            }
            return;
        }
        if node.kind() == K::ShorthandPropertyAssignment {
            found.insert(node.name().text().into());
        }
        node.for_each_child(|child| {
            visit(child, declared, found);
            false
        });
    }
    let mut found = BTreeSet::new();
    statement.for_each_child(|child| {
        visit(child, declared, &mut found);
        false
    });
    let mut names = found.into_iter().collect::<Vec<_>>();
    names.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    names
}

fn line_of(text: &str, offset: i32) -> u32 {
    let mut line = 1;
    let mut previous_cr = false;
    for (position, ch) in text.char_indices() {
        if position >= offset.max(0) as usize {
            break;
        }
        if ch == '\r' || ch == '\u{2028}' || ch == '\u{2029}' || (ch == '\n' && !previous_cr) {
            line += 1;
        }
        previous_cr = ch == '\r';
    }
    line
}

fn decorated(node: Node) -> bool {
    modifier(node, K::Decorator)
}

fn computed_executes(node: Node) -> bool {
    let name = node.name();
    name.is_some()
        && name.kind() == K::ComputedPropertyName
        && expression_executes(name.expression())
}

fn class_executes(node: Node) -> bool {
    if decorated(node) {
        return true;
    }
    for clause in node.heritage_clauses().nodes().iter() {
        if clause.token() == K::ExtendsKeyword
            && clause
                .types()
                .nodes()
                .iter()
                .any(|t| expression_executes(t.expression()))
        {
            return true;
        }
    }
    for member in node.members().iter() {
        if member.kind() == K::ClassStaticBlockDeclaration
            || decorated(member)
            || computed_executes(member)
        {
            return true;
        }
        if matches!(
            member.kind(),
            K::MethodDeclaration | K::Constructor | K::GetAccessor | K::SetAccessor
        ) && member.parameters().iter().any(decorated)
        {
            return true;
        }
        if modifier(member, K::StaticKeyword)
            && member.kind() == K::PropertyDeclaration
            && member.initializer().is_some()
            && expression_executes(member.initializer())
        {
            return true;
        }
    }
    false
}

fn assignment(kind: K) -> bool {
    matches!(
        kind,
        K::EqualsToken
            | K::PlusEqualsToken
            | K::MinusEqualsToken
            | K::AsteriskEqualsToken
            | K::AsteriskAsteriskEqualsToken
            | K::SlashEqualsToken
            | K::PercentEqualsToken
            | K::LessThanLessThanEqualsToken
            | K::GreaterThanGreaterThanEqualsToken
            | K::GreaterThanGreaterThanGreaterThanEqualsToken
            | K::AmpersandEqualsToken
            | K::BarEqualsToken
            | K::CaretEqualsToken
            | K::BarBarEqualsToken
            | K::AmpersandAmpersandEqualsToken
            | K::QuestionQuestionEqualsToken
    )
}

fn expression_executes(node: Node) -> bool {
    if node.is_nil() {
        return false;
    }
    if matches!(
        node.kind(),
        K::ArrowFunction
            | K::FunctionExpression
            | K::FunctionDeclaration
            | K::MethodDeclaration
            | K::GetAccessor
            | K::SetAccessor
            | K::Constructor
    ) {
        return decorated(node) || computed_executes(node);
    }
    if matches!(node.kind(), K::ClassDeclaration | K::ClassExpression) {
        return class_executes(node);
    }
    if matches!(
        node.kind(),
        K::CallExpression
            | K::NewExpression
            | K::TaggedTemplateExpression
            | K::AwaitExpression
            | K::YieldExpression
            | K::DeleteExpression
            | K::Decorator
    ) {
        return true;
    }
    if node.kind() == K::BinaryExpression && assignment(node.operator_token().kind()) {
        return true;
    }
    if matches!(
        node.kind(),
        K::PrefixUnaryExpression | K::PostfixUnaryExpression
    ) && matches!(node.operator(), K::PlusPlusToken | K::MinusMinusToken)
    {
        return true;
    }
    node.for_each_child(|child| !ast::is_type_node(child) && expression_executes(child))
}

fn statement_executes(node: Node) -> bool {
    if modifier(node, K::DeclareKeyword) {
        return false;
    }
    match node.kind() {
        K::FunctionDeclaration | K::InterfaceDeclaration | K::TypeAliasDeclaration => false,
        K::ImportDeclaration => {
            node.import_clause().is_nil() || !node.import_clause().is_type_only()
        }
        K::ImportEqualsDeclaration => !node.is_type_only(),
        K::ExportDeclaration => node.module_specifier().is_some() && !node.is_type_only(),
        K::ExportAssignment => expression_executes(node.expression()),
        K::ClassDeclaration => class_executes(node),
        K::EnumDeclaration => {
            !modifier(node, K::ConstKeyword)
                && node
                    .members()
                    .iter()
                    .any(|m| m.initializer().is_some() && expression_executes(m.initializer()))
        }
        K::ModuleDeclaration => {
            let body = node.body();
            if body.is_nil() {
                false
            } else if body.kind() == K::ModuleBlock {
                body.statement_list().nodes().iter().any(statement_executes)
            } else {
                statement_executes(body)
            }
        }
        K::VariableStatement => {
            node.declaration_list().flags().intersects(NodeFlags::USING)
                || node
                    .declaration_list()
                    .declarations()
                    .nodes()
                    .iter()
                    .any(|d| d.initializer().is_some() && expression_executes(d.initializer()))
        }
        _ => true,
    }
}

fn literal(node: Node) -> Option<String> {
    if node.is_some()
        && matches!(
            node.kind(),
            K::StringLiteral | K::NoSubstitutionTemplateLiteral
        )
    {
        Some(node.text().into())
    } else {
        None
    }
}

#[expect(
    clippy::excessive_nesting,
    reason = "The native import AST traversal retains its explicit syntax dispatch in this feasibility port."
)]
fn import_details(statement: Node, output: &mut Value) {
    if statement.kind() == K::ExportDeclaration {
        if let Some(specifier) = literal(statement.module_specifier()) {
            output["moduleSpecifier"] = json!(specifier);
        }
        if statement.module_specifier().is_some() {
            let clause = statement.export_clause();
            output["loadsModule"] = json!(if statement.is_type_only() {
                "never"
            } else if clause.is_some()
                && clause.kind() == K::NamedExports
                && clause.elements().iter().all(|e| e.is_type_only())
            {
                "maybe"
            } else {
                "yes"
            });
        }
        return;
    }
    if statement.kind() == K::ImportEqualsDeclaration {
        let reference = statement.module_reference();
        if reference.kind() == K::ExternalModuleReference {
            output["loadsModule"] = json!(if statement.is_type_only() {
                "never"
            } else {
                "yes"
            });
            if let Some(specifier) = literal(reference.expression()) {
                output["moduleSpecifier"] = json!(specifier);
                output["importBindings"] = json!([{"local":statement.name().text(),"imported":"=","typeOnly":statement.is_type_only()}]);
            }
        }
        return;
    }
    if statement.kind() != K::ImportDeclaration {
        return;
    }
    let clause = statement.import_clause();
    let mut imports = vec![];
    let type_only = clause.is_some() && clause.is_type_only();
    let mut load = if type_only {
        "never"
    } else if clause.is_nil() {
        "yes"
    } else {
        "maybe"
    };
    if clause.is_some() {
        if clause.name().is_some() {
            imports.push(
                json!({"local":clause.name().text(),"imported":"default","typeOnly":type_only}),
            );
            if !type_only {
                load = "yes";
            }
        }
        let named = clause.named_bindings();
        if named.is_some() {
            if named.kind() == K::NamespaceImport {
                imports
                    .push(json!({"local":named.name().text(),"imported":"*","typeOnly":type_only}));
                if !type_only {
                    load = "yes";
                }
            } else {
                for element in named.elements().iter() {
                    imports.push(json!({"local":element.name().text(),"imported":element.property_name_or_name().text(),"typeOnly":type_only || element.is_type_only()}));
                    if !type_only && !element.is_type_only() {
                        load = "yes";
                    }
                }
            }
        }
    }
    output["loadsModule"] = json!(load);
    if let Some(specifier) = literal(statement.module_specifier()) {
        output["moduleSpecifier"] = json!(specifier);
        output["importBindings"] = json!(imports);
    }
}

fn digest(statement: Node, file: Node, text: &str) -> String {
    fn visit(node: Node, parts: &mut Vec<String>) {
        if (node.kind() as u32) >= (K::JsDocTypeExpression as u32) {
            return;
        }
        parts.push(format!("{:?}", node.kind()));
        if matches!(
            node.kind(),
            K::Identifier
                | K::PrivateIdentifier
                | K::StringLiteral
                | K::NumericLiteral
                | K::BigIntLiteral
                | K::RegularExpressionLiteral
                | K::JsxText
        ) {
            parts.push(node.text().into());
        }
        if matches!(
            node.kind(),
            K::NoSubstitutionTemplateLiteral
                | K::TemplateHead
                | K::TemplateMiddle
                | K::TemplateTail
        ) {
            parts.push(node.raw_text().into());
        }
        node.for_each_child(|child| {
            visit(child, parts);
            false
        });
        parts.push(")".into());
    }
    let start = astnav::get_start_of_node(statement, file, false).max(0) as usize;
    let end = statement.end().max(0) as usize;
    let source = text.get(start..end).unwrap_or("");
    fn literal_positions(node: Node, file: Node, start: usize, literals: &mut BTreeMap<usize, K>) {
        if matches!(
            node.kind(),
            K::TemplateMiddle | K::TemplateTail | K::RegularExpressionLiteral
        ) {
            let offset = astnav::get_start_of_node(node, file, false).max(0) as usize;
            literals.insert(offset.saturating_sub(start), node.kind());
        }
        node.for_each_child(|child| {
            literal_positions(child, file, start, literals);
            false
        });
    }
    let mut literals = BTreeMap::new();
    literal_positions(statement, file, start, &mut literals);
    fn removable_semicolons(node: Node, text: &str, start: usize, positions: &mut BTreeSet<usize>) {
        let end = node.end().max(0) as usize;
        if end > start && text.as_bytes().get(end - 1) == Some(&b';') {
            positions.insert(end - 1 - start);
        }
        node.for_each_child(|child| {
            removable_semicolons(child, text, start, positions);
            false
        });
    }
    let mut semicolons = BTreeSet::new();
    removable_semicolons(statement, text, start, &mut semicolons);
    let mut scanner = ts_goport::frontend::scanner::new_scanner();
    scanner.set_text(source);
    scanner.set_skip_trivia(true);
    let mut tokens = vec![];
    loop {
        let mut kind = scanner.scan();
        if let Some(expected) = literals.get(&(scanner.token_start().max(0) as usize)) {
            if matches!(expected, K::TemplateMiddle | K::TemplateTail) {
                kind = scanner.re_scan_template_token(true);
            } else if *expected == K::RegularExpressionLiteral {
                kind = scanner.re_scan_slash_token(false);
            }
        }
        if kind == K::EndOfFile {
            break;
        }
        if kind != K::CommaToken
            && !(kind == K::SemicolonToken
                && semicolons.contains(&(scanner.token_start().max(0) as usize)))
        {
            let value = if matches!(
                kind,
                K::StringLiteral | K::NumericLiteral | K::BigIntLiteral
            ) {
                scanner.token_value()
            } else {
                scanner.token_text()
            };
            tokens.push(format!("{:?}:{value}", kind));
        }
    }
    if tokens
        .last()
        .is_some_and(|s| s.starts_with("SemicolonToken:"))
    {
        tokens.pop();
    }
    let mut parts = vec![];
    visit(statement, &mut parts);
    parts.extend(tokens);
    format!("{:x}", Sha256::digest(parts.join("\0").as_bytes()))[..32].to_owned()
}

fn directive(line: &str) -> bool {
    if [
        "#__PURE__",
        "@__PURE__",
        "__NO_SIDE_EFFECTS__",
        "@vite-ignore",
    ]
    .iter()
    .any(|needle| line.contains(needle))
    {
        return true;
    }
    let fixed = [
        "@ts-ignore",
        "@ts-expect-error",
        "@ts-nocheck",
        "@ts-check",
        "@jsx",
        "@jsxFrag",
        "@jsxImportSource",
        "@jsxRuntime",
    ];
    if fixed.iter().any(|needle| {
        line.match_indices(needle).any(|(i, _)| {
            line[i + needle.len()..]
                .chars()
                .next()
                .is_none_or(|c| !c.is_ascii_alphanumeric() && c != '_')
        })
    }) {
        return true;
    }
    let trimmed = line.trim_start();
    if let Some(rest) = trimmed.strip_prefix("///") {
        let rest = rest.trim_start();
        if rest.starts_with("<reference") || rest.starts_with("<amd-module") {
            return true;
        }
    }
    line.match_indices("webpack").any(|(i, _)| {
        let suffix = &line[i + 7..];
        suffix
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_uppercase())
            && suffix
                .chars()
                .skip_while(|c| c.is_ascii_alphabetic())
                .collect::<String>()
                .trim_start()
                .starts_with(':')
    })
}

fn marker_line(line: &str) -> bool {
    let lower = line.to_ascii_lowercase();
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
        lower.match_indices(&format!("@{tag}")).any(|(i, _)| {
            let rest = &line[i + tag.len() + 1..];
            let trimmed = rest.trim_start_matches([' ', '\t']);
            trimmed.len() != rest.len()
                && trimmed
                    .chars()
                    .next()
                    .is_some_and(|c| c.is_ascii_alphanumeric())
        })
    })
}

fn syntax_file(source_file: Node, text: &str, rel_path: &str) -> Node {
    let jsx = rel_path.ends_with(".tsx");
    if !source_file.flags().intersects(NodeFlags::JAVA_SCRIPT_FILE)
        && (ast::source_file_language_variant(source_file) == LanguageVariant::JSX) == jsx
    {
        return source_file;
    }
    use ts_goport::frontend::{
        parser::{SourceFileParseOptions, parse_source_file},
        tspath::Path,
    };
    parse_source_file(
        &SourceFileParseOptions {
            file_name: rel_path.into(),
            path: Path(rel_path.into()),
            ..Default::default()
        },
        ast::FileText::new(text.to_owned(), false),
        if jsx { ScriptKind::TSX } else { ScriptKind::TS },
    )
    .root
}

pub fn outline(source_file: Node, text: &str, rel_path: &str) -> Value {
    let source_file = syntax_file(source_file, text, rel_path);
    let mut exported = BTreeSet::new();
    let factory = ast::NodeFactory::new();
    let mut statements = vec![];
    for statement in source_file.statement_list().nodes().iter() {
        let (kind, names, exports, side_effect) = describe(statement);
        exported.extend(exports);
        let start = astnav::get_start_of_node(statement, source_file, false);
        let comments = ts_goport::frontend::scanner::get_leading_comment_ranges(
            &factory,
            text,
            statement.pos(),
        );
        let leading = comments.first().map_or(start, |c| c.pos());
        let mut output = json!({"kind":kind,"startLine":line_of(text,start),"endLine":line_of(text,statement.end()),"leadingStartLine":line_of(text,leading),"declaredNames":names,"referencedNames":references(statement,&names),"digest":digest(statement,source_file,text),"executesOnLoad":statement_executes(statement)});
        if side_effect {
            output["sideEffectImport"] = json!(true);
        }
        import_details(statement, &mut output);
        statements.push(output);
    }
    let mut directives = vec![];
    let mut markers = vec![];
    for (index, line) in text.split('\n').enumerate() {
        let line = line.strip_suffix('\r').unwrap_or(line);
        if directive(line) {
            directives.push(index + 1);
        }
        if marker_line(line) {
            markers.push(index + 1);
        }
    }
    let mut exported_names = exported.into_iter().collect::<Vec<_>>();
    exported_names.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    json!({"statements":statements,"exportedNames":exported_names,"hasSyntaxErrors":!ast::source_file_diagnostics(source_file).is_empty(),"directiveLines":directives,"markerLines":markers})
}

pub fn module_links(source_file: Node, text: &str) -> Value {
    let source_file = syntax_file(source_file, text, ast::source_file_file_name(source_file));
    fn visit(node: Node, file: Node, text: &str, links: &mut Vec<Value>) {
        let mut link = None;
        match node.kind() {
            K::ImportDeclaration => {
                let clause = node.import_clause();
                let whole = clause.is_some()
                    && !clause.is_type_only()
                    && clause.named_bindings().is_some()
                    && clause.named_bindings().kind() == K::NamespaceImport;
                link = Some(("import", literal(node.module_specifier()), whole));
            }
            K::ExportDeclaration if node.module_specifier().is_some() => {
                let clause = node.export_clause();
                let whole = !node.is_type_only()
                    && (clause.is_nil() || clause.kind() == K::NamespaceExport);
                link = Some(("reexport", literal(node.module_specifier()), whole));
            }
            K::ImportEqualsDeclaration
                if node.module_reference().kind() == K::ExternalModuleReference =>
            {
                link = Some((
                    "require",
                    literal(node.module_reference().expression()),
                    !node.is_type_only(),
                ));
            }
            K::CallExpression => {
                let expression = node.expression();
                let kind = if expression.kind() == K::ImportKeyword {
                    Some("dynamic_import")
                } else if expression.kind() == K::Identifier && expression.text() == "require" {
                    Some("require")
                } else {
                    None
                };
                if let Some(kind) = kind {
                    link = Some((
                        kind,
                        literal(node.arguments().iter().next().unwrap_or(Node::NIL)),
                        true,
                    ));
                }
            }
            _ => {}
        }
        if let Some((kind, specifier, whole)) = link {
            let mut row = json!({"kind":kind,"specifier":specifier,"line":line_of(text,astnav::get_start_of_node(node,file,false))});
            if whole {
                row["whole"] = json!(true);
            }
            links.push(row);
        }
        node.for_each_child(|child| {
            visit(child, file, text, links);
            false
        });
    }
    let mut links = vec![];
    visit(source_file, source_file, text, &mut links);
    json!(links)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ts_goport::{
        flags::ScriptKind,
        frontend::{
            parser::{SourceFileParseOptions, parse_source_file},
            tspath::Path,
        },
    };

    fn parsed(text: &str) -> Node {
        parse_source_file(
            &SourceFileParseOptions {
                file_name: "/outline-dev.ts".into(),
                path: Path("/outline-dev.ts".into()),
                ..Default::default()
            },
            Box::leak(text.to_owned().into_boxed_str()) as &'static str,
            ScriptKind::TS,
        )
        .root
    }

    #[test]
    fn exported_destructuring_keeps_binding_order_and_comment_line() {
        let text = "// retained documentation\r\nexport const { key: first, nested: [second] } = source;\r\n";
        let result = outline(parsed(text), text, "outline-dev.ts");
        assert_eq!(result["exportedNames"], json!(["first", "second"]));
        assert_eq!(
            result["statements"][0]["declaredNames"],
            json!(["first", "second"])
        );
        assert_eq!(
            result["statements"][0]["referencedNames"],
            json!(["source"])
        );
        assert_eq!(result["statements"][0]["startLine"], 2);
        assert_eq!(result["statements"][0]["leadingStartLine"], 1);
        assert_eq!(result["statements"][0]["executesOnLoad"], false);
    }
    #[test]
    fn type_only_imports_keep_absent_fields_and_loading_distinctions() {
        let text = "import type { A as Alias } from './types';\nimport { type Shape } from './mixed';\nimport './side';\nexport type * from './types';\nimport Handle = require('./external');\nexport { Alias as named };\nexport default (Alias.member);\n";
        let result = outline(parsed(text), text, "outline-dev.ts");
        let rows = result["statements"].as_array().unwrap();
        assert_eq!(
            rows.iter()
                .map(|s| s["loadsModule"].clone())
                .collect::<Vec<_>>(),
            vec![
                json!("never"),
                json!("maybe"),
                json!("yes"),
                json!("never"),
                json!("yes"),
                Value::Null,
                Value::Null
            ]
        );
        assert_eq!(
            rows[0]["importBindings"],
            json!([{"local":"Alias","imported":"A","typeOnly":true}])
        );
        assert_eq!(rows[2]["sideEffectImport"], true);
        assert_eq!(rows[2]["importBindings"], json!([]));
        assert!(rows[0].get("sideEffectImport").is_none());
        assert_eq!(
            rows[4]["importBindings"],
            json!([{"local":"Handle","imported":"=","typeOnly":false}])
        );
        assert!(rows[5].get("moduleSpecifier").is_none());
        assert_eq!(result["exportedNames"], json!(["Alias", "default"]));
        assert_eq!(rows[1]["executesOnLoad"], true);
    }

    #[test]
    fn evaluation_skips_deferred_bodies_but_keeps_definition_effects() {
        let text = "const deferred = () => action();\nconst eager = { [key()]: 0 };\nclass Deferred { field=action(); method(){ action(); } }\nclass Eager { static field=action(); }\ndeclare class Ambient { static field: unknown; }\nenum Ordinary { item=action() }\nconst enum CompileOnly { item=action() }\nnamespace Space { const value=action(); }\nconst arithmetic = count + 1;\nconst increment = count++;\nconst assertion = (1 as typeof action);\nusing resource = plain;\n";
        let result = outline(parsed(text), text, "outline-dev.ts");
        let states = result["statements"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s["executesOnLoad"].as_bool().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(
            states,
            vec![
                false, true, false, true, false, true, false, true, false, true, false, true
            ]
        );
    }

    #[test]
    fn module_links_preserve_source_order_whole_flags_and_computed_absence() {
        let text = "import * as all from './one';\nimport type * as types from './two';\nexport * as publicNames from './three';\nexport type * from './four';\nimport compatibility = require('./five');\nfunction deferred(){ import(target); require(); import('./six'); }\n";
        assert_eq!(
            module_links(parsed(text), text),
            json!([
                {"kind":"import","specifier":"./one","line":1,"whole":true},
                {"kind":"import","specifier":"./two","line":2},
                {"kind":"reexport","specifier":"./three","line":3,"whole":true},
                {"kind":"reexport","specifier":"./four","line":4},
                {"kind":"require","specifier":"./five","line":5,"whole":true},
                {"kind":"dynamic_import","specifier":null,"line":6,"whole":true},
                {"kind":"require","specifier":null,"line":6,"whole":true},
                {"kind":"dynamic_import","specifier":"./six","line":6,"whole":true}
            ])
        );
    }

    #[test]
    fn coordinates_keep_utf16_and_directives_separate_from_line_scanning() {
        let text = "// 😀\r\n// @ts-ignore\r\n// @Invariant shape\r\nexport const label = 'é';\r\n";
        let result = outline(parsed(text), text, "outline-dev.ts");
        assert_eq!(
            line_of(
                "a\r\nb\rc\u{2028}d\u{2029}e",
                "a\r\nb\rc\u{2028}d\u{2029}".len() as i32
            ),
            5
        );
        assert_eq!(result["statements"][0]["startLine"], 4);
        assert_eq!(result["statements"][0]["leadingStartLine"], 1);
        assert_eq!(result["directiveLines"], json!([2]));
        assert_eq!(result["markerLines"], json!([3]));
    }

    #[test]
    fn digest_ignores_trivia_list_commas_and_final_semicolon_but_keeps_operators() {
        fn first(text: &str) -> Value {
            outline(parsed(text), text, "outline-dev.ts")["statements"][0]["digest"].clone()
        }
        assert_eq!(
            first("const labels = ['same', 2,];"),
            first("/* doc */ const labels=[\"same\",2]")
        );
        assert_ne!(
            first("const answer = left + right;"),
            first("const answer = left - right;")
        );
        assert_ne!(first("let mutable = 1;"), first("const mutable = 1;"));
        assert_ne!(
            first(r"const raw = tag`a\nb`;"),
            first("const raw = tag`a\nb`;")
        );
        assert_eq!(
            first("const raw = tag`x${value}y`;"),
            first("const raw = tag`x${ value }y`")
        );
    }

    #[test]
    fn recovered_statements_do_not_hide_parser_failure() {
        let text = "export const broken = ;\nexport function later() {}\n";
        let result = outline(parsed(text), text, "outline-dev.ts");
        assert_eq!(result["hasSyntaxErrors"], true);
        assert_eq!(result["statements"].as_array().unwrap().len(), 2);
    }
    #[test]
    fn directive_patterns_preserve_literal_suffix_and_ascii_word_boundaries() {
        let text = "// #__PURE__suffix\n// @ts-ignoreSuffix\n// @ts-ignoreé\n// webpackChunkName : 'chunk'\n";
        assert_eq!(
            outline(parsed(text), text, "outline-dev.ts")["directiveLines"],
            json!([1, 3, 4])
        );
    }
    #[test]
    fn digest_ignores_statement_semicolons_inside_deferred_bodies() {
        let first = "const deferred = () => { invoke(); };";
        let second = "const deferred=()=>{invoke()}";
        assert_eq!(
            outline(parsed(first), first, "outline-dev.ts")["statements"][0]["digest"],
            outline(parsed(second), second, "outline-dev.ts")["statements"][0]["digest"]
        );
    }

    #[test]
    fn javascript_program_file_uses_baseline_ts_outline_script_kind() {
        use ts_goport::frontend::parser::{SourceFileParseOptions, parse_source_file};
        let text = "const view = <Section />;";
        let file = parse_source_file(
            &SourceFileParseOptions {
                file_name: "/outline-dev.jsx".into(),
                path: Path("/outline-dev.jsx".into()),
                ..Default::default()
            },
            text,
            ScriptKind::JSX,
        )
        .root;
        assert_eq!(
            outline(file, text, "outline-dev.jsx")["hasSyntaxErrors"],
            true
        );
        assert_eq!(
            outline(file, text, "outline-dev.tsx")["hasSyntaxErrors"],
            false
        );
    }

    #[test]
    fn declaration_kinds_defaults_and_references_keep_syntax_overapproximation() {
        let text = "export default function named(value: Model) { return value.item + external; }\nexport default class {}\ninterface Shape { field: Other; method(value: Input): Output; }\ntype Alias = Target;\nnamespace Named {}\nexport = (owned.part);\ntarget();\n";
        let result = outline(parsed(text), text, "outline-dev.ts");
        let statements = result["statements"].as_array().unwrap();
        assert_eq!(
            statements
                .iter()
                .map(|s| s["kind"].clone())
                .collect::<Vec<_>>(),
            vec![
                json!("function"),
                json!("class"),
                json!("interface"),
                json!("type"),
                json!("namespace"),
                json!("export"),
                json!("statement")
            ]
        );
        assert_eq!(
            result["exportedNames"],
            json!(["default", "named", "owned"])
        );
        assert_eq!(
            statements[0]["referencedNames"],
            json!(["Model", "external", "value"])
        );
        assert_eq!(
            statements[2]["referencedNames"],
            json!(["Input", "Other", "Output", "value"])
        );
    }

    #[test]
    fn exported_and_referenced_name_order_matches_javascript_utf16_sort() {
        let text = "export const 𐐀 = 1; export const Ａ = 2; const both = 𐐀 + Ａ;";
        let result = outline(parsed(text), text, "outline-dev.ts");
        assert_eq!(result["exportedNames"], json!(["𐐀", "Ａ"]));
        assert_eq!(
            result["statements"][2]["referencedNames"],
            json!(["𐐀", "Ａ"])
        );
    }
    #[test]
    fn default_only_import_is_a_non_whole_link_without_namespace_binding() {
        let text = "import DefaultValue from './default-owner';";
        assert_eq!(
            module_links(parsed(text), text),
            json!([{"kind":"import","specifier":"./default-owner","line":1}])
        );
    }
}
