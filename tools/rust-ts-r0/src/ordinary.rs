use serde::Serialize;
use std::collections::{BTreeMap, HashMap, HashSet};
use ts_goport::{
    ast,
    astdata::SyntaxKind,
    astnav,
    checker::Checker,
    core::{Node, SymbolId},
    flags::{ModifierFlags, SymbolFlags},
};

#[derive(Clone, Debug, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Extraction {
    pub modules: Vec<String>,
    pub symbols: Vec<Symbol>,
    pub imports: Vec<Import>,
    pub calls: Vec<Call>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Symbol {
    pub name: String,
    pub kind: String,
    pub rel_path: String,
    pub scope: Vec<String>,
    pub start_line: u32,
    pub end_line: u32,
    pub start_utf16: i32,
    pub end_utf16: i32,
    pub exported: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signature_only: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub jsdoc: Option<String>,
    pub markers: Vec<Marker>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct Marker {
    pub tag: String,
    pub slug: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub statement: Option<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BindingTarget {
    pub rel_path: String,
    pub symbol_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime_used: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unmodeled_reason: Option<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Import {
    pub from_rel_path: String,
    pub module_specifier: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolved_rel_path: Option<String>,
    pub names: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub binding_targets: Option<Vec<BindingTarget>>,
    pub line: u32,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Call {
    pub caller_rel_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub caller_symbol_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub caller_unmodeled_reason: Option<String>,
    pub callee_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub callee_rel_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub callee_symbol_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub callee_unmodeled_reason: Option<String>,
    pub line: u32,
}

#[derive(Clone, Copy, Debug)]
pub struct ExtractionContext<'a> {
    pub repository_root: &'a str,
    pub static_module_links: bool,
    pub retained: bool,
    pub javascript_enabled: bool,
    pub captured_files: Option<&'a BTreeMap<String, String>>,
    pub case_sensitive: bool,
}

pub fn retained_function_owner_coordinate(
    declaration: Node,
    repository_root: &str,
) -> Option<(String, String)> {
    if declaration.kind() != SyntaxKind::FunctionDeclaration || declaration.body().is_nil() {
        return None;
    }
    let name = scope_name(declaration)?;
    let owner = ast::get_source_file_of_node(declaration);
    if owner.is_nil() {
        return None;
    }
    Some((
        relative_path(repository_root, ast::source_file_file_name(owner)),
        scoped_path(&enclosing_scope(declaration, true), &name),
    ))
}

pub fn retained_callable_coordinate(
    expression: Node,
    checker: &mut Checker,
    context: &ExtractionContext<'_>,
) -> Option<(String, String)> {
    let mut receiver = unwrap(expression);
    while matches!(
        receiver.kind(),
        SyntaxKind::PropertyAccessExpression | SyntaxKind::ElementAccessExpression
    ) {
        receiver = unwrap(receiver.expression());
    }
    let receiver_symbol = checker.get_symbol_at_location_exported(receiver);
    if receiver_symbol.is_some()
        && checker
            .sym(receiver_symbol)
            .declarations
            .iter()
            .any(|origin| {
                matches!(
                    origin.kind(),
                    SyntaxKind::ImportSpecifier | SyntaxKind::ImportClause
                ) && origin.is_type_only()
                    || origin.kind() == SyntaxKind::NamespaceImport
                        && origin.parent().is_type_only()
            })
    {
        return None;
    }
    let mut symbol = checker.get_symbol_at_location_exported(expression);
    if symbol.is_nil() {
        return None;
    }
    if checker.sym(symbol).flags.intersects(SymbolFlags::ALIAS) {
        symbol = checker.get_aliased_symbol(symbol);
    }
    if symbol.is_nil()
        || !checker.sym(symbol).declarations.iter().any(|declaration| {
            declaration.kind() == SyntaxKind::FunctionDeclaration && !declaration.body().is_nil()
                || declaration.kind() == SyntaxKind::ClassDeclaration
                || declaration.kind() == SyntaxKind::MethodDeclaration
                    && matches!(
                        declaration.parent().kind(),
                        SyntaxKind::ClassDeclaration | SyntaxKind::ClassExpression
                    )
                || declaration.kind() == SyntaxKind::VariableDeclaration
                    && declaration.name().kind() == SyntaxKind::Identifier
                    && function_expression(declaration.initializer())
        })
    {
        return None;
    }
    let retained = ExtractionContext {
        static_module_links: true,
        retained: true,
        javascript_enabled: true,
        ..*context
    };
    let target = resolve_target(expression, checker, &retained, None);
    Some((target.rel_path?, target.symbol_path?))
}

pub fn extract(
    source: Node,
    checker: &mut Checker,
    rel_path: &str,
    context: &ExtractionContext<'_>,
) -> Result<Extraction, String> {
    if source.is_nil() || source.kind() != SyntaxKind::SourceFile {
        return Err("ordinary extraction requires a loaded source file".into());
    }
    if declaration_path(ast::source_file_file_name(source)) {
        return Ok(Extraction::default());
    }
    let mut exported_declarations = HashSet::new();
    if context.static_module_links {
        let module = checker.get_symbol_at_location_exported(source);
        if module.is_some() {
            for mut symbol in checker.get_exports_of_module_exported(module) {
                if checker.sym(symbol).flags.intersects(SymbolFlags::ALIAS) {
                    symbol = checker.get_aliased_symbol(symbol);
                }
                if symbol.is_some() {
                    exported_declarations.extend(checker.sym(symbol).declarations.iter().copied());
                }
            }
        }
    }
    let mut runtime = HashSet::new();
    if context.retained {
        collect_runtime_references(source, checker, &mut runtime);
    }
    let mut namespace_references = HashMap::new();
    if context.static_module_links {
        collect_namespace_references(source, checker, context.retained, &mut namespace_references);
    }
    let mut walker = SymbolWalker {
        checker,
        context: *context,
        exported_declarations,
        runtime,
        namespace_references,
        symbol_scope: Vec::new(),
        source,
        text: ast::source_file_text(source).to_string(),
        rel_path,
        scope: Vec::new(),
        output: Extraction {
            modules: vec![rel_path.to_owned()],
            ..Default::default()
        },
    };
    walker.visit(source);
    Ok(walker.output)
}

fn declaration_path(path: &str) -> bool {
    path.ends_with(".d.ts") || path.ends_with(".d.mts") || path.ends_with(".d.cts")
}

fn runtime_companion(path: &str, context: &ExtractionContext<'_>) -> Option<String> {
    if !context.javascript_enabled {
        return None;
    }
    let (base, suffix) = if let Some(base) = path.strip_suffix(".d.mts") {
        (base, ".mjs")
    } else if let Some(base) = path.strip_suffix(".d.cts") {
        (base, ".cjs")
    } else if let Some(base) = path.strip_suffix(".d.ts") {
        (base, ".js")
    } else {
        return None;
    };
    let runtime = format!("{base}{suffix}");
    let normalize = |path: &str| {
        let path = path.replace('\\', "/");
        if context.case_sensitive {
            path
        } else {
            path.to_lowercase()
        }
    };
    let key = normalize(&runtime);
    context
        .captured_files?
        .keys()
        .any(|candidate| normalize(candidate) == key)
        .then_some(runtime)
}

fn module_source(literal: Node, checker: &mut Checker) -> Option<Node> {
    let symbol = checker.get_symbol_at_location_exported(literal);
    if symbol.is_nil() {
        return None;
    }
    checker
        .sym(symbol)
        .declarations
        .iter()
        .copied()
        .map(ast::get_source_file_of_node)
        .find(|node| !node.is_nil())
}

fn exported_binding_names(node: Node, names: &mut HashSet<String>) {
    if node.kind() == SyntaxKind::Identifier {
        names.insert(node.text().into());
    } else if matches!(
        node.kind(),
        SyntaxKind::ObjectBindingPattern | SyntaxKind::ArrayBindingPattern
    ) {
        for element in node.elements().iter() {
            if element.kind() == SyntaxKind::BindingElement {
                exported_binding_names(element.name(), names);
            }
        }
    }
}

#[expect(
    clippy::excessive_nesting,
    reason = "The native symbol and import AST traversal retains its explicit syntax dispatch in this feasibility port."
)]
pub fn export_ambiguities(source: Node, checker: &mut Checker) -> Vec<String> {
    if source.is_nil() || source.kind() != SyntaxKind::SourceFile {
        return Vec::new();
    }
    let mut pending = vec![source];
    let mut exports = HashMap::<Node, BTreeMap<String, HashSet<SymbolId>>>::new();
    let mut stars = HashMap::<Node, Vec<Node>>::new();
    let mut explicit = HashMap::<Node, HashSet<String>>::new();
    let mut relays = HashMap::<Node, Vec<(String, Node, String)>>::new();
    while let Some(module) = pending.pop() {
        if exports.contains_key(&module) {
            continue;
        }
        let mut names = HashSet::new();
        let mut inherited = Vec::new();
        let mut linked = Vec::new();
        for statement in module.statements().iter() {
            if statement.kind() == SyntaxKind::ExportDeclaration {
                let clause = statement.export_clause();
                if clause.is_nil() && !statement.module_specifier().is_nil() {
                    if let Some(target) = module_source(statement.module_specifier(), checker) {
                        inherited.push(target);
                        pending.push(target);
                    }
                } else if !clause.is_nil() && clause.kind() == SyntaxKind::NamedExports {
                    let target = if statement.module_specifier().is_nil() {
                        None
                    } else {
                        module_source(statement.module_specifier(), checker)
                    };
                    for item in clause.elements().iter() {
                        let name = item.name().text().to_string();
                        names.insert(name.clone());
                        let mut binding = target.map(|module| {
                            (module, item.property_name_or_name().text().to_string())
                        });
                        if binding.is_none() && statement.module_specifier().is_nil() {
                            let local = checker.get_export_specifier_local_target_symbol(item);
                            if local.is_some() {
                                for declaration in checker.sym(local).declarations.clone() {
                                    if declaration.kind() == SyntaxKind::ImportSpecifier {
                                        let import = declaration.parent().parent().parent();
                                        if let Some(module) =
                                            module_source(import.module_specifier(), checker)
                                        {
                                            binding = Some((
                                                module,
                                                declaration
                                                    .property_name_or_name()
                                                    .text()
                                                    .to_string(),
                                            ));
                                            break;
                                        }
                                    }
                                }
                            }
                        }
                        if let Some((target, imported)) = binding {
                            linked.push((name, target, imported));
                            pending.push(target);
                        }
                    }
                } else if !clause.is_nil() && clause.kind() == SyntaxKind::NamespaceExport {
                    names.insert(clause.name().text().into());
                }
            } else if ast::get_combined_modifier_flags(statement).intersects(ModifierFlags::EXPORT)
            {
                if ast::get_combined_modifier_flags(statement).intersects(ModifierFlags::DEFAULT) {
                    names.insert("default".into());
                } else if statement.kind() == SyntaxKind::VariableStatement {
                    for declaration in statement.declaration_list().declarations().nodes().iter() {
                        exported_binding_names(declaration.name(), &mut names);
                    }
                } else if let Some(name) = declaration_name(statement) {
                    names.insert(name);
                }
            } else if statement.kind() == SyntaxKind::ExportAssignment {
                names.insert("default".into());
            }
        }
        let symbol = checker.get_symbol_at_location_exported(module);
        let mut own = BTreeMap::new();
        if symbol.is_some() {
            for exported in checker.get_exports_of_module_exported(symbol) {
                let name = checker.sym(exported).name.to_string();
                if (!inherited.is_empty() && !names.contains(&name))
                    || linked.iter().any(|(exported, _, _)| exported == &name)
                {
                    continue;
                }
                let owner = if checker.sym(exported).flags.intersects(SymbolFlags::ALIAS) {
                    checker.get_aliased_symbol(exported)
                } else {
                    exported
                };
                if owner.is_some() {
                    own.insert(name, HashSet::from([owner]));
                }
            }
        }
        exports.insert(module, own);
        stars.insert(module, inherited);
        relays.insert(module, linked);
        explicit.insert(module, names);
    }
    loop {
        let mut changed = false;
        for (module, inherited) in &stars {
            for target in inherited {
                let incoming = exports.get(target).cloned().unwrap_or_default();
                for (name, owners) in incoming {
                    if name == "default" || explicit[module].contains(&name) {
                        continue;
                    }
                    let current = exports.get_mut(module).unwrap().entry(name).or_default();
                    let before = current.len();
                    current.extend(owners);
                    changed |= current.len() != before;
                }
            }
        }
        for (module, links) in &relays {
            for (exported, target, imported) in links {
                let incoming = exports
                    .get(target)
                    .and_then(|names| names.get(imported))
                    .cloned()
                    .unwrap_or_default();
                let current = exports
                    .get_mut(module)
                    .unwrap()
                    .entry(exported.clone())
                    .or_default();
                let before = current.len();
                current.extend(incoming);
                changed |= current.len() != before;
            }
        }
        if !changed {
            break;
        }
    }
    exports
        .remove(&source)
        .unwrap_or_default()
        .into_iter()
        .filter_map(|(name, owners)| (owners.len() > 1).then_some(name))
        .collect()
}

fn ambiguous_reference(expression: Node, checker: &mut Checker) -> bool {
    let symbol = checker.get_symbol_at_location_exported(expression);
    if symbol.is_some() {
        let declarations = checker.sym(symbol).declarations.clone();
        for declaration in declarations {
            if declaration.kind() == SyntaxKind::ImportSpecifier {
                let import = declaration.parent().parent().parent();
                if let Some(module) = module_source(import.module_specifier(), checker)
                    && export_ambiguities(module, checker)
                        .iter()
                        .any(|name| name == declaration.property_name_or_name().text())
                {
                    return true;
                }
            }
        }
    }
    let mut member = unwrap(expression);
    while matches!(
        member.kind(),
        SyntaxKind::PropertyAccessExpression | SyntaxKind::ElementAccessExpression
    ) {
        let receiver = unwrap(member.expression());
        let symbol = checker.get_symbol_at_location_exported(receiver);
        if symbol.is_some()
            && checker
                .sym(symbol)
                .declarations
                .iter()
                .any(|decl| decl.kind() == SyntaxKind::NamespaceImport)
        {
            let declaration = checker
                .sym(symbol)
                .declarations
                .iter()
                .find(|decl| decl.kind() == SyntaxKind::NamespaceImport)
                .copied()
                .unwrap();
            let name = if member.kind() == SyntaxKind::PropertyAccessExpression {
                member.name()
            } else {
                member.argument_expression()
            };
            if matches!(
                name.kind(),
                SyntaxKind::Identifier
                    | SyntaxKind::StringLiteral
                    | SyntaxKind::NoSubstitutionTemplateLiteral
            ) && let Some(module) =
                module_source(declaration.parent().parent().module_specifier(), checker)
                && export_ambiguities(module, checker)
                    .iter()
                    .any(|export| export == name.text())
            {
                return true;
            }
        }
        member = receiver;
    }
    false
}

fn ambiguous_namespace_member(binding: SymbolId, name: &str, checker: &mut Checker) -> bool {
    if binding.is_nil() {
        return false;
    }
    let declaration = checker
        .sym(binding)
        .declarations
        .iter()
        .find(|declaration| declaration.kind() == SyntaxKind::NamespaceImport)
        .copied();
    let Some(declaration) = declaration else {
        return false;
    };
    module_source(declaration.parent().parent().module_specifier(), checker).is_some_and(|module| {
        export_ambiguities(module, checker)
            .iter()
            .any(|export| export == name)
    })
}

fn function_expression(node: Node) -> bool {
    !node.is_nil()
        && matches!(
            node.kind(),
            SyntaxKind::ArrowFunction | SyntaxKind::FunctionExpression
        )
}

fn declaration_name(node: Node) -> Option<String> {
    let name = node.name();
    if !name.is_nil() && name.kind() == SyntaxKind::Identifier {
        return Some(name.text().into());
    }
    if matches!(
        node.kind(),
        SyntaxKind::FunctionDeclaration | SyntaxKind::ClassDeclaration
    ) && ast::get_combined_modifier_flags(node).intersects(ModifierFlags::DEFAULT)
    {
        return Some("default".into());
    }
    None
}

struct SymbolWalker<'a, 'b> {
    checker: &'b mut Checker,
    context: ExtractionContext<'a>,
    exported_declarations: HashSet<Node>,
    runtime: HashSet<SymbolId>,
    namespace_references: HashMap<SymbolId, Vec<(Node, SymbolId)>>,
    symbol_scope: Vec<String>,
    source: Node,
    text: String,
    rel_path: &'a str,
    scope: Vec<String>,
    output: Extraction,
}

impl SymbolWalker<'_, '_> {
    fn record(&mut self, node: Node, end: Node, name: String, kind: &str, signature: bool) {
        let factory = ast::NodeFactory::new();
        let jsdoc = ts_goport::frontend::scanner::get_leading_comment_ranges(
            &factory,
            &self.text,
            node.pos(),
        )
        .into_iter()
        .filter_map(|range| self.text.get(range.pos() as usize..range.end() as usize))
        .rfind(|text| text.starts_with("/**"))
        .map(str::to_owned);
        let starts = ast::source_file_ecma_line_map(self.source);
        let line = |position: i32| starts.partition_point(|start| *start <= position).max(1) as u32;
        let markers = jsdoc.as_deref().map(parse_markers).unwrap_or_default();
        self.output.symbols.push(Symbol {
            name,
            kind: kind.into(),
            rel_path: self.rel_path.into(),
            scope: self.scope.clone(),
            start_line: line(astnav::get_start_of_node(node, self.source, false)),
            end_line: line(end.end()),
            start_utf16: ast::source_file_get_position_map(self.source)
                .utf8_to_utf16(astnav::get_start_of_node(node, self.source, false)),
            end_utf16: ast::source_file_get_position_map(self.source).utf8_to_utf16(end.end()),
            exported: ast::get_combined_modifier_flags(node).intersects(ModifierFlags::EXPORT)
                || self.exported_declarations.contains(&end),
            signature_only: signature.then_some(true),
            jsdoc,
            markers,
        });
    }

    fn line(&self, node: Node) -> u32 {
        let starts = ast::source_file_ecma_line_map(self.source);
        starts
            .partition_point(|start| *start <= astnav::get_start_of_node(node, self.source, false))
            .max(1) as u32
    }

    fn module_link(&mut self, node: Node, literal: Node) {
        if literal.is_nil() || literal.kind() != SyntaxKind::StringLiteral {
            return;
        }
        let symbol = self.checker.get_symbol_at_location_exported(literal);
        let resolved = if symbol.is_some() {
            self.checker
                .sym(symbol)
                .declarations
                .first()
                .map(|declaration| {
                    let owner = ast::get_source_file_of_node(*declaration);
                    let path = ast::source_file_file_name(owner);
                    relative_path(
                        self.context.repository_root,
                        runtime_companion(path, &self.context)
                            .as_deref()
                            .unwrap_or(path),
                    )
                })
        } else {
            None
        };
        self.output.imports.push(Import {
            from_rel_path: self.rel_path.into(),
            module_specifier: literal.text().into(),
            resolved_rel_path: resolved,
            names: Vec::new(),
            binding_targets: None,
            line: self.line(node),
        });
    }

    #[expect(
        clippy::excessive_nesting,
        reason = "The native symbol and import AST traversal retains its explicit syntax dispatch in this feasibility port."
    )]
    fn import(&mut self, node: Node) {
        if node.module_specifier().is_nil()
            || node.module_specifier().kind() != SyntaxKind::StringLiteral
        {
            return;
        }
        self.module_link(node, node.module_specifier());
        let clause = node.import_clause();
        let mut names = Vec::new();
        let mut bindings = Vec::new();
        let mut namespace = None;
        if !clause.is_nil() && !clause.is_type_only() {
            let default = clause.name();
            if !default.is_nil() {
                names.push(if self.context.static_module_links {
                    "default".into()
                } else {
                    default.text().into()
                });
                bindings.push(default);
            }
            let named = clause.named_bindings();
            if !named.is_nil() {
                if named.kind() == SyntaxKind::NamespaceImport {
                    names.push(named.name().text().into());
                    namespace = Some(self.checker.get_symbol_at_location_exported(named.name()));
                } else {
                    for item in named.elements().iter() {
                        if item.is_type_only() {
                            continue;
                        }
                        names.push(if self.context.static_module_links {
                            item.property_name_or_name().text().into()
                        } else {
                            item.name().text().into()
                        });
                        bindings.push(item.name());
                    }
                }
            }
        }
        let mut targets = Vec::new();
        if self.context.static_module_links {
            for binding in bindings {
                let target = self.target(binding);
                if let (Some(rel_path), Some(symbol_path)) = (target.rel_path, target.symbol_path) {
                    let local = self.checker.get_symbol_at_location_exported(binding);
                    targets.push(BindingTarget {
                        rel_path,
                        symbol_path,
                        runtime_used: (self.context.retained && !self.runtime.contains(&local))
                            .then_some(false),
                        unmodeled_reason: target.unmodeled_reason,
                    });
                }
            }
            if let Some(references) = namespace
                .and_then(|symbol| self.namespace_references.get(&symbol))
                .cloned()
            {
                for (expression, symbol) in references {
                    let target =
                        resolve_target(expression, self.checker, &self.context, Some(symbol));
                    if let (Some(rel_path), Some(symbol_path)) =
                        (target.rel_path, target.symbol_path)
                    {
                        targets.push(BindingTarget {
                            rel_path,
                            symbol_path,
                            runtime_used: None,
                            unmodeled_reason: target.unmodeled_reason,
                        });
                    }
                }
            }
        }
        if let Some(import) = self.output.imports.last_mut() {
            import.names = names;
            import.binding_targets = self.context.static_module_links.then_some(targets);
        }
    }

    fn target(&mut self, expression: Node) -> Target {
        resolve_target(expression, self.checker, &self.context, None)
    }

    fn call(&mut self, node: Node) {
        let mut expression = node.expression();
        if self.context.static_module_links && expression.kind() == SyntaxKind::ImportKeyword {
            if node.arguments().len() == 1 {
                self.module_link(node, node.arguments().get(0));
            }
            return;
        }
        if self.context.static_module_links {
            expression = unwrap(expression);
        }
        let name = match expression.kind() {
            SyntaxKind::Identifier => expression.text().to_owned(),
            SyntaxKind::PropertyAccessExpression => expression.name().text().to_owned(),
            _ => return,
        };
        let target = self.target(expression);
        self.output.calls.push(Call {
            caller_rel_path: self.rel_path.into(),
            caller_symbol_path: self.symbol_scope.last().cloned(),
            caller_unmodeled_reason: (self.context.retained && object_member_ancestor(node))
                .then(|| "OBJECT_LITERAL_MEMBER".into()),
            callee_name: name,
            callee_rel_path: target.rel_path,
            callee_symbol_path: target.symbol_path,
            callee_unmodeled_reason: target.unmodeled_reason,
            line: self.line(node),
        });
    }

    #[expect(
        clippy::excessive_nesting,
        reason = "The native symbol and import AST traversal retains its explicit syntax dispatch in this feasibility port."
    )]
    fn visit(&mut self, node: Node) {
        let mut scoped = None;
        let mut symbol_owner = None;
        match node.kind() {
            SyntaxKind::FunctionDeclaration | SyntaxKind::ClassDeclaration => {
                if let Some(name) = declaration_name(node) {
                    let function = node.kind() == SyntaxKind::FunctionDeclaration;
                    self.record(
                        node,
                        node,
                        name.clone(),
                        if function { "function" } else { "class" },
                        function && node.body().is_nil(),
                    );
                    symbol_owner = Some(scoped_path(&self.scope, &name));
                    scoped = Some(name);
                }
            }
            SyntaxKind::InterfaceDeclaration
            | SyntaxKind::TypeAliasDeclaration
            | SyntaxKind::EnumDeclaration => {
                if let Some(name) = declaration_name(node) {
                    let kind = match node.kind() {
                        SyntaxKind::InterfaceDeclaration => "interface",
                        SyntaxKind::TypeAliasDeclaration => "type",
                        _ => "enum",
                    };
                    self.record(node, node, name, kind, false);
                }
            }
            SyntaxKind::MethodDeclaration | SyntaxKind::ModuleDeclaration => {
                scoped = declaration_name(node)
            }
            SyntaxKind::VariableStatement => {
                for declaration in node.declaration_list().declarations().nodes().iter() {
                    if declaration.name().kind() == SyntaxKind::Identifier
                        && function_expression(declaration.initializer())
                    {
                        let name = declaration.name().text().to_string();
                        self.record(node, declaration, name.clone(), "function", false);
                        self.symbol_scope.push(scoped_path(&self.scope, &name));
                        self.scope.push(name);
                        declaration.for_each_child(|child| {
                            self.visit(child);
                            false
                        });
                        self.scope.pop();
                        self.symbol_scope.pop();
                    } else {
                        declaration.for_each_child(|child| {
                            self.visit(child);
                            false
                        });
                    }
                }
                return;
            }
            SyntaxKind::ImportDeclaration => self.import(node),
            SyntaxKind::ExportDeclaration
                if self.context.static_module_links && !node.module_specifier().is_nil() =>
            {
                self.module_link(node, node.module_specifier());
            }
            SyntaxKind::CallExpression => self.call(node),
            _ => {}
        }
        if let Some(owner) = symbol_owner.as_ref() {
            self.symbol_scope.push(owner.clone());
        }
        if let Some(name) = scoped.as_ref() {
            self.scope.push(name.clone());
        }
        node.for_each_child(|child| {
            self.visit(child);
            false
        });
        if scoped.is_some() {
            self.scope.pop();
        }
        if symbol_owner.is_some() {
            self.symbol_scope.pop();
        }
    }
}

fn resolve_target(
    expression: Node,
    checker: &mut Checker,
    context: &ExtractionContext<'_>,
    target_symbol: Option<SymbolId>,
) -> Target {
    if context.static_module_links && ambiguous_reference(expression, checker) {
        return Target::default();
    }
    let mut symbol =
        target_symbol.unwrap_or_else(|| checker.get_symbol_at_location_exported(expression));
    if symbol.is_nil() {
        return Target::default();
    }
    if checker.sym(symbol).flags.intersects(SymbolFlags::ALIAS) {
        symbol = checker.get_aliased_symbol(symbol);
    }
    if symbol.is_nil() {
        return Target::default();
    }
    let Some(declaration) = checker.sym(symbol).declarations.first().copied() else {
        return Target::default();
    };
    let owner = ast::get_source_file_of_node(declaration);
    if owner.is_nil() {
        return Target::default();
    }
    let name = if context.static_module_links {
        scope_name(declaration).unwrap_or_else(|| checker.sym(symbol).name.to_string())
    } else {
        checker.sym(symbol).name.to_string()
    };
    let path = ast::source_file_file_name(owner);
    let unmodeled = if context.retained && !declaration_path(path) {
        if declaration.parent().kind() == SyntaxKind::ObjectLiteralExpression {
            Some("OBJECT_LITERAL_MEMBER")
        } else if matches!(
            declaration.kind(),
            SyntaxKind::EnumDeclaration | SyntaxKind::EnumMember
        ) {
            Some("ENUM_VALUE")
        } else if declaration.kind() == SyntaxKind::VariableDeclaration
            && !function_expression(declaration.initializer())
        {
            Some("VALUE_DECLARATION")
        } else {
            None
        }
    } else {
        None
    };
    Target {
        rel_path: if declaration_path(path) {
            runtime_companion(path, context)
                .map(|path| relative_path(context.repository_root, &path))
        } else {
            Some(relative_path(context.repository_root, path))
        },
        symbol_path: Some(scoped_path(
            &enclosing_scope(declaration, context.retained),
            &name,
        )),
        unmodeled_reason: unmodeled.map(str::to_owned),
    }
}

#[derive(Default)]
struct Target {
    rel_path: Option<String>,
    symbol_path: Option<String>,
    unmodeled_reason: Option<String>,
}

fn scoped_path(scope: &[String], name: &str) -> String {
    scope
        .iter()
        .map(String::as_str)
        .chain(std::iter::once(name))
        .collect::<Vec<_>>()
        .join(".")
}

fn js_whitespace(character: char) -> bool {
    matches!(character, '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}

fn parse_markers(comment: &str) -> Vec<Marker> {
    let text = comment.trim_start_matches(js_whitespace);
    let text = text
        .strip_prefix("/**")
        .or_else(|| text.strip_prefix("/*"))
        .unwrap_or(text);
    let text = text.trim_end_matches(js_whitespace);
    let text = text.strip_suffix("*/").unwrap_or(text);
    let text = text
        .split('\n')
        .map(|line| {
            let prefix = line.trim_start_matches(js_whitespace);
            let stripped = if let Some(rest) = prefix.strip_prefix('*') {
                rest.strip_prefix([' ', '\t']).unwrap_or(rest)
            } else {
                line
            };
            stripped.trim_end_matches(js_whitespace)
        })
        .collect::<Vec<_>>()
        .join("\n");
    let bytes = text.as_bytes();
    let mut cursor = 0;
    let mut markers = Vec::new();
    while cursor < bytes.len() {
        if bytes[cursor] != b'@' {
            cursor += 1;
            continue;
        }
        cursor += 1;
        let start = cursor;
        while cursor < bytes.len() && bytes[cursor].is_ascii_alphabetic() {
            cursor += 1;
        }
        let tag = text[start..cursor].to_ascii_lowercase();
        if !matches!(
            tag.as_str(),
            "capability" | "invariant" | "contract" | "risk" | "boundedcontext" | "tag"
        ) || cursor == bytes.len()
            || !matches!(bytes[cursor], b' ' | b'\t')
        {
            continue;
        }
        while cursor < bytes.len() && matches!(bytes[cursor], b' ' | b'\t') {
            cursor += 1;
        }
        let start = cursor;
        if cursor == bytes.len() || !bytes[cursor].is_ascii_alphanumeric() {
            continue;
        }
        while cursor < bytes.len()
            && (bytes[cursor].is_ascii_alphanumeric() || matches!(bytes[cursor], b'_' | b'-'))
        {
            cursor += 1;
        }
        let slug = text[start..cursor].to_string();
        while cursor < bytes.len() && matches!(bytes[cursor], b' ' | b'\t') {
            cursor += 1;
        }
        let mut statement = None;
        if bytes.get(cursor) == Some(&b':') {
            let mut start = cursor + 1;
            while start < bytes.len() && matches!(bytes[start], b' ' | b'\t') {
                start += 1;
            }
            if start < bytes.len() && !matches!(bytes[start], b'\r' | b'\n' | b'*') {
                cursor = start;
                while cursor < bytes.len() && !matches!(bytes[cursor], b'\r' | b'\n') {
                    cursor += 1;
                }
                let value = text[start..cursor].trim_matches(js_whitespace);
                if !value.is_empty() {
                    statement = Some(value.to_string());
                }
            }
        }
        markers.push(Marker {
            tag: if tag == "boundedcontext" {
                "boundedContext".into()
            } else {
                tag
            },
            slug,
            statement,
        });
    }
    markers
}

fn relative_path(root: &str, path: &str) -> String {
    let root = root.replace('\\', "/");
    let path = path.replace('\\', "/");
    let from: Vec<_> = root.split('/').filter(|part| !part.is_empty()).collect();
    let to: Vec<_> = path.split('/').filter(|part| !part.is_empty()).collect();
    let common = from.iter().zip(&to).take_while(|(a, b)| a == b).count();
    std::iter::repeat_n("..", from.len() - common)
        .chain(to[common..].iter().copied())
        .collect::<Vec<_>>()
        .join("/")
}

fn scope_name(node: Node) -> Option<String> {
    if node.is_nil() {
        return None;
    }
    match node.kind() {
        SyntaxKind::FunctionDeclaration
        | SyntaxKind::ClassDeclaration
        | SyntaxKind::MethodDeclaration
        | SyntaxKind::ModuleDeclaration => declaration_name(node),
        SyntaxKind::VariableDeclaration
            if !node.name().is_nil()
                && node.name().kind() == SyntaxKind::Identifier
                && function_expression(node.initializer()) =>
        {
            Some(node.name().text().into())
        }
        _ => None,
    }
}

fn enclosing_scope(node: Node, interfaces: bool) -> Vec<String> {
    let mut scope = Vec::new();
    let mut parent = node.parent();
    while !parent.is_nil() {
        if interfaces && parent.kind() == SyntaxKind::InterfaceDeclaration {
            scope.push(parent.name().text().into());
        } else if let Some(name) = scope_name(parent) {
            scope.push(name);
        }
        parent = parent.parent();
    }
    scope.reverse();
    scope
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

fn object_member_ancestor(node: Node) -> bool {
    let mut parent = node.parent();
    while !parent.is_nil() {
        if !parent.parent().is_nil()
            && parent.parent().kind() == SyntaxKind::ObjectLiteralExpression
            && matches!(
                parent.kind(),
                SyntaxKind::MethodDeclaration | SyntaxKind::GetAccessor | SyntaxKind::SetAccessor
            )
        {
            return true;
        }
        if function_expression(parent) {
            let mut owner = parent.parent();
            while !owner.is_nil()
                && matches!(
                    owner.kind(),
                    SyntaxKind::ParenthesizedExpression
                        | SyntaxKind::AsExpression
                        | SyntaxKind::TypeAssertionExpression
                        | SyntaxKind::NonNullExpression
                        | SyntaxKind::SatisfiesExpression
                )
            {
                owner = owner.parent();
            }
            if !owner.is_nil()
                && owner.kind() == SyntaxKind::PropertyAssignment
                && owner.parent().kind() == SyntaxKind::ObjectLiteralExpression
            {
                return true;
            }
        }
        parent = parent.parent();
    }
    false
}

fn collect_runtime_references(node: Node, checker: &mut Checker, symbols: &mut HashSet<SymbolId>) {
    if matches!(
        node.kind(),
        SyntaxKind::ImportDeclaration
            | SyntaxKind::InterfaceDeclaration
            | SyntaxKind::TypeAliasDeclaration
    ) || ast::get_combined_modifier_flags(node).intersects(ModifierFlags::AMBIENT)
    {
        return;
    }
    if ast::is_type_node(node) {
        if node.kind() == SyntaxKind::ExpressionWithTypeArguments
            && node.parent().kind() == SyntaxKind::HeritageClause
            && node.parent().token() == SyntaxKind::ExtendsKeyword
            && matches!(
                node.parent().parent().kind(),
                SyntaxKind::ClassDeclaration | SyntaxKind::ClassExpression
            )
        {
            collect_runtime_references(node.expression(), checker, symbols);
        }
        return;
    }
    if matches!(
        node.kind(),
        SyntaxKind::ExportDeclaration | SyntaxKind::ExportSpecifier
    ) && node.is_type_only()
    {
        return;
    }
    if node.kind() == SyntaxKind::Identifier {
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
            symbols.insert(symbol);
        }
    }
    node.for_each_child(|child| {
        collect_runtime_references(child, checker, symbols);
        false
    });
}

fn collect_namespace_references(
    node: Node,
    checker: &mut Checker,
    retained: bool,
    references: &mut HashMap<SymbolId, Vec<(Node, SymbolId)>>,
) {
    if ast::is_type_node(node) {
        return;
    }
    let reference = if node.kind() == SyntaxKind::PropertyAccessExpression
        || node.kind() == SyntaxKind::ElementAccessExpression
            && matches!(
                node.argument_expression().kind(),
                SyntaxKind::StringLiteral | SyntaxKind::NoSubstitutionTemplateLiteral
            ) {
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
        && !node.parent().parent().initializer().is_nil()
    {
        let receiver = unwrap(node.parent().parent().initializer());
        let binding = checker.get_symbol_at_location_exported(receiver);
        let property = node.property_name_or_name();
        if binding.is_some()
            && checker
                .sym(binding)
                .declarations
                .iter()
                .any(|declaration| declaration.kind() == SyntaxKind::NamespaceImport)
            && matches!(
                property.kind(),
                SyntaxKind::Identifier
                    | SyntaxKind::StringLiteral
                    | SyntaxKind::NoSubstitutionTemplateLiteral
            )
            && !ambiguous_namespace_member(binding, property.text(), checker)
        {
            let ty = checker.get_type_at_location(receiver);
            Some((
                binding,
                node.name(),
                checker.get_property_of_type_exported(ty, property.text()),
            ))
        } else {
            None
        }
    } else {
        None
    };
    if let Some((binding, expression, mut target)) = reference {
        if target.is_some() && checker.sym(target).flags.intersects(SymbolFlags::ALIAS) {
            target = checker.get_aliased_symbol(target);
        }
        let declaration = if target.is_some() {
            checker.sym(target).declarations.first().copied()
        } else {
            None
        };
        if binding.is_some()
            && declaration.is_some_and(|declaration| {
                matches!(
                    declaration.kind(),
                    SyntaxKind::FunctionDeclaration | SyntaxKind::ClassDeclaration
                ) || declaration.kind() == SyntaxKind::VariableDeclaration
                    && function_expression(declaration.initializer())
                    || retained
                        && matches!(
                            declaration.kind(),
                            SyntaxKind::VariableDeclaration
                                | SyntaxKind::EnumDeclaration
                                | SyntaxKind::EnumMember
                        )
            })
        {
            references
                .entry(binding)
                .or_default()
                .push((expression, target));
        }
    }
    node.for_each_child(|child| {
        collect_namespace_references(child, checker, retained, references);
        false
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    use ts_goport::program;

    fn development_extract(files: BTreeMap<String, String>, relative: &str) -> Extraction {
        eprintln!(
            "ordinary_dev_input={}",
            serde_json::to_string(&files).unwrap()
        );
        let roots = files.keys().cloned().collect();
        let captured = files.clone();
        let javascript_enabled = files.keys().any(|path| {
            [".js", ".jsx", ".mjs", ".cjs"]
                .iter()
                .any(|suffix| path.ends_with(suffix))
        });
        let relative = relative.to_owned();
        let path = format!("/repo/{relative}");
        crate::development::with_project(files, roots, move || {
            let source = program::get_source_file(&path);
            program::with_type_checker_for_file(source, move |checker| {
                extract(
                    source,
                    checker,
                    &relative,
                    &ExtractionContext {
                        repository_root: "/repo",
                        static_module_links: true,
                        retained: true,
                        javascript_enabled,
                        captured_files: Some(&captured),
                        case_sensitive: true,
                    },
                )
            })
            .unwrap()
        })
    }

    #[test]
    fn review_development_malformed_import_cannot_replace_previous_record() {
        let controls: serde_json::Value =
            serde_json::from_str(include_str!("../development/review-controls.json")).unwrap();
        let files: BTreeMap<String, String> =
            serde_json::from_value(controls["cases"][0]["files"].clone()).unwrap();
        let result = development_extract(files, "reviewDevelopmentImportConsumerA.ts");
        assert_eq!(result.imports.len(), 1);
        assert_eq!(
            result.imports[0].module_specifier,
            "./reviewDevelopmentImportOwnerA"
        );
        assert_eq!(result.imports[0].names, vec!["reviewDevelopmentFirstA"]);
    }

    #[test]
    fn review_development_named_relay_preserves_ambiguous_origins_and_concrete_override() {
        let controls: serde_json::Value =
            serde_json::from_str(include_str!("../development/review-controls.json")).unwrap();
        for concrete in [false, true] {
            let mut files: BTreeMap<String, String> =
                serde_json::from_value(controls["cases"][1]["files"].clone()).unwrap();
            if concrete {
                files.insert(
                    "/repo/reviewDevelopmentRelayB.ts".into(),
                    controls["cases"][1]["variants"][0]["source"]
                        .as_str()
                        .unwrap()
                        .into(),
                );
            }
            let result = development_extract(files, "reviewDevelopmentConsumerB.ts");
            assert_eq!(
                result.calls[0].callee_rel_path.as_deref(),
                concrete.then_some("reviewDevelopmentFirstB.ts")
            );
            assert_eq!(
                result.calls[0].callee_symbol_path.as_deref(),
                concrete.then_some("reviewDevelopmentClashB")
            );
            assert_eq!(
                result.imports[0].binding_targets.as_ref().unwrap().len(),
                usize::from(concrete)
            );
        }
    }

    #[test]
    fn development_ambiguous_stars_have_no_endpoint_and_explicit_export_resolves() {
        for (explicit, reversed) in [(false, false), (false, true), (true, false), (true, true)] {
            let mut barrel = if reversed {
                "export * from './t00DevelopmentSecondC'; export * from './t00DevelopmentFirstC';"
            } else {
                "export * from './t00DevelopmentFirstC'; export * from './t00DevelopmentSecondC';"
            }
            .to_string();
            if explicit {
                barrel.push_str(" export { t00DevelopmentStarC } from './t00DevelopmentFirstC';");
            }
            let result = development_extract(BTreeMap::from([
                ("/repo/t00DevelopmentFirstC.ts".into(), "export function t00DevelopmentStarC() { return 53; }".into()),
                ("/repo/t00DevelopmentSecondC.ts".into(), "export function t00DevelopmentStarC() { return 59; }".into()),
                ("/repo/t00DevelopmentBarrelC.ts".into(), barrel),
                ("/repo/t00DevelopmentCallerC.ts".into(), "import { t00DevelopmentStarC } from './t00DevelopmentBarrelC'; export function t00DevelopmentCallerC() { return t00DevelopmentStarC(); }".into()),
            ]), "t00DevelopmentCallerC.ts");
            assert_eq!(result.calls.len(), 1);
            assert_eq!(
                result.calls[0].callee_rel_path.as_deref(),
                explicit.then_some("t00DevelopmentFirstC.ts")
            );
            assert_eq!(
                result.calls[0].callee_symbol_path.as_deref(),
                explicit.then_some("t00DevelopmentStarC")
            );
            assert_eq!(
                result.imports[0].binding_targets.as_ref().unwrap().len(),
                usize::from(explicit)
            );
        }
    }

    #[test]
    fn development_alias_uses_remote_declaration_not_local_homonym() {
        let result = development_extract(BTreeMap::from([
            ("/repo/t00DevelopmentRemoteB.ts".into(), "export function t00DevelopmentLeafB() { return 47; }".into()),
            ("/repo/t00DevelopmentCallerB.ts".into(), "import { t00DevelopmentLeafB as t00DevelopmentAliasB } from './t00DevelopmentRemoteB'; function t00DevelopmentLeafB() { return 99; } export function t00DevelopmentCallerB() { return t00DevelopmentAliasB(); }".into()),
        ]), "t00DevelopmentCallerB.ts");
        assert_eq!(result.calls.len(), 1);
        assert_eq!(
            result.calls[0].callee_rel_path.as_deref(),
            Some("t00DevelopmentRemoteB.ts")
        );
        assert_eq!(
            result.calls[0].callee_symbol_path.as_deref(),
            Some("t00DevelopmentLeafB")
        );
        assert_eq!(
            result.calls[0].caller_symbol_path.as_deref(),
            Some("t00DevelopmentCallerB")
        );
        assert_eq!(result.imports.len(), 1);
        assert_eq!(
            result.imports[0].resolved_rel_path.as_deref(),
            Some("t00DevelopmentRemoteB.ts")
        );
        assert_eq!(result.imports[0].names, vec!["t00DevelopmentLeafB"]);
    }

    #[test]
    fn development_callable_coordinate_requires_semantic_callable_and_owner_body() {
        let path = "/repo/t00DevelopmentCoordinatesD.ts";
        let text = "function t00DevelopmentCallableD() {} function t00DevelopmentSignatureD(): void; const t00DevelopmentArrowD = () => {}; const t00DevelopmentDataD = 61; t00DevelopmentCallableD(); t00DevelopmentArrowD(); t00DevelopmentDataD();";
        let files = BTreeMap::from([(path.to_string(), text.to_string())]);
        eprintln!(
            "ordinary_dev_input={}",
            serde_json::to_string(&files).unwrap()
        );
        crate::development::with_project(files, vec![path.to_string()], move || {
            let source = program::get_source_file(path);
            program::with_type_checker_for_file(source, move |checker| {
                let context = ExtractionContext {
                    repository_root: "/repo",
                    static_module_links: true,
                    retained: true,
                    javascript_enabled: false,
                    captured_files: None,
                    case_sensitive: true,
                };
                let statements = source.statements();
                assert_eq!(
                    retained_function_owner_coordinate(statements.get(0), "/repo"),
                    Some((
                        "t00DevelopmentCoordinatesD.ts".into(),
                        "t00DevelopmentCallableD".into()
                    ))
                );
                assert_eq!(
                    retained_function_owner_coordinate(statements.get(1), "/repo"),
                    None
                );
                let mut endpoints = Vec::new();
                for statement in statements.iter().skip(4) {
                    endpoints.push(retained_callable_coordinate(
                        statement.expression().expression(),
                        checker,
                        &context,
                    ));
                }
                assert_eq!(
                    endpoints,
                    vec![
                        Some((
                            "t00DevelopmentCoordinatesD.ts".into(),
                            "t00DevelopmentCallableD".into()
                        )),
                        Some((
                            "t00DevelopmentCoordinatesD.ts".into(),
                            "t00DevelopmentArrowD".into()
                        )),
                        None
                    ]
                );
            });
        });
    }

    #[test]
    fn development_namespace_uses_real_receiver_and_static_members_only() {
        let result = development_extract(BTreeMap::from([
            ("/repo/t00DevelopmentNamespaceLeafE.ts".into(), "export function t00DevelopmentUsedE() {} export function t00DevelopmentUnusedE() {} export const t00DevelopmentValueE = 67;".into()),
            ("/repo/t00DevelopmentNamespaceCallerE.ts".into(), "import * as t00DevelopmentNamespaceE from './t00DevelopmentNamespaceLeafE'; import type * as t00DevelopmentTypesE from './t00DevelopmentNamespaceLeafE'; type t00DevelopmentTypeE = typeof t00DevelopmentTypesE.t00DevelopmentUnusedE; export function t00DevelopmentCallerE() { t00DevelopmentNamespaceE.t00DevelopmentUsedE(); const { t00DevelopmentUsedE: t00DevelopmentAliasE } = t00DevelopmentNamespaceE; t00DevelopmentNamespaceE['t00DevelopmentValueE']; t00DevelopmentNamespaceE.t00DevelopmentValueE; } function t00DevelopmentShadowE(t00DevelopmentNamespaceE: { t00DevelopmentUnusedE(): void }) { t00DevelopmentNamespaceE.t00DevelopmentUnusedE(); }".into()),
        ]), "t00DevelopmentNamespaceCallerE.ts");
        let targets = result.imports[0].binding_targets.as_ref().unwrap();
        assert_eq!(
            targets
                .iter()
                .map(|target| target.symbol_path.as_str())
                .collect::<Vec<_>>(),
            vec![
                "t00DevelopmentUsedE",
                "t00DevelopmentUsedE",
                "t00DevelopmentValueE"
            ]
        );
        assert!(targets.iter().all(|target| target.runtime_used.is_none()));
        assert_eq!(
            targets[2].unmodeled_reason.as_deref(),
            Some("VALUE_DECLARATION")
        );
        assert_eq!(result.imports[1].binding_targets, Some(Vec::new()));
        assert!(result.imports[1].names.is_empty());
    }

    #[test]
    fn development_ambiguous_namespace_does_not_create_binding_targets() {
        let result = development_extract(BTreeMap::from([
            ("/repo/t00DevelopmentFirstF.ts".into(), "export function t00DevelopmentStarF() { return 71; }".into()),
            ("/repo/t00DevelopmentSecondF.ts".into(), "export function t00DevelopmentStarF() { return 73; }".into()),
            ("/repo/t00DevelopmentBarrelF.ts".into(), "export * from './t00DevelopmentFirstF'; export * from './t00DevelopmentSecondF';".into()),
            ("/repo/t00DevelopmentCallerF.ts".into(), "import * as t00DevelopmentNamespaceF from './t00DevelopmentBarrelF'; const { t00DevelopmentStarF: t00DevelopmentAliasF } = t00DevelopmentNamespaceF; t00DevelopmentNamespaceF.t00DevelopmentStarF();".into()),
        ]), "t00DevelopmentCallerF.ts");
        assert_eq!(result.imports[0].binding_targets, Some(Vec::new()));
        assert_eq!(result.calls.len(), 1);
        assert!(result.calls[0].callee_rel_path.is_none());
    }

    #[test]
    fn development_overloads_scopes_ranges_and_explicit_markers() {
        let result = development_extract(BTreeMap::from([("/repo/t00DevelopmentMetadataG.ts".into(), "\u{feff}const t00DevelopmentAstralG = '🦀';\r\n/** @capability t00Development-G: exact author text */\r\nexport function t00DevelopmentOverloadG(value: string): string;\r\nexport function t00DevelopmentOverloadG(value: unknown) { return String(value); }\r\nclass t00DevelopmentClassG { t00DevelopmentMethodG() { function t00DevelopmentInnerG() {} t00DevelopmentInnerG(); } }\r\n".into())]), "t00DevelopmentMetadataG.ts");
        assert_eq!(
            result
                .symbols
                .iter()
                .map(|symbol| symbol.name.as_str())
                .collect::<Vec<_>>(),
            vec![
                "t00DevelopmentOverloadG",
                "t00DevelopmentOverloadG",
                "t00DevelopmentClassG",
                "t00DevelopmentInnerG"
            ]
        );
        assert_eq!(result.symbols[0].signature_only, Some(true));
        assert_eq!(result.symbols[1].signature_only, None);
        assert_eq!(
            (result.symbols[0].start_line, result.symbols[0].end_line),
            (3, 3)
        );
        assert_eq!(
            result.symbols[3].scope,
            vec!["t00DevelopmentClassG", "t00DevelopmentMethodG"]
        );
        assert_eq!(
            result.calls.last().unwrap().callee_symbol_path.as_deref(),
            Some("t00DevelopmentClassG.t00DevelopmentMethodG.t00DevelopmentInnerG")
        );
        assert_eq!(
            result.calls.last().unwrap().caller_symbol_path.as_deref(),
            Some("t00DevelopmentClassG")
        );
        assert_eq!(
            result.symbols[0].markers,
            vec![Marker {
                tag: "capability".into(),
                slug: "t00Development-G".into(),
                statement: Some("exact author text".into())
            }]
        );
        assert!(result.symbols[1].markers.is_empty());
    }

    #[test]
    fn development_class_extends_is_runtime_read_and_type_reference_is_not() {
        let result = development_extract(BTreeMap::from([
            ("/repo/t00DevelopmentBaseH.ts".into(), "export class t00DevelopmentBaseH {}".into()),
            ("/repo/t00DevelopmentDerivedH.ts".into(), "import { t00DevelopmentBaseH } from './t00DevelopmentBaseH'; import { t00DevelopmentBaseH as t00DevelopmentTypeAliasH } from './t00DevelopmentBaseH'; class t00DevelopmentDerivedH extends t00DevelopmentBaseH {} type t00DevelopmentTypeH = t00DevelopmentTypeAliasH;".into()),
        ]), "t00DevelopmentDerivedH.ts");
        assert_eq!(
            result.imports[0].binding_targets.as_ref().unwrap()[0].runtime_used,
            None
        );
        assert_eq!(
            result.imports[1].binding_targets.as_ref().unwrap()[0].runtime_used,
            Some(false)
        );
    }

    #[test]
    fn development_declaration_companion_requires_captured_runtime_file() {
        for present in [true, false] {
            let mut files = BTreeMap::from([
                ("/repo/t00DevelopmentRuntimeI.d.mts".into(), "export declare function t00DevelopmentRuntimeI(): number;".into()),
                ("/repo/t00DevelopmentCallerI.mjs".into(), "import { t00DevelopmentRuntimeI } from './t00DevelopmentRuntimeI.mjs'; export function t00DevelopmentCallerI() { return t00DevelopmentRuntimeI(); }".into()),
            ]);
            if present {
                files.insert(
                    "/repo/t00DevelopmentRuntimeI.mjs".into(),
                    "export function t00DevelopmentRuntimeI() { return 79; }".into(),
                );
            }
            let result = development_extract(files, "t00DevelopmentCallerI.mjs");
            assert_eq!(
                result.imports[0].resolved_rel_path.as_deref(),
                Some(if present {
                    "t00DevelopmentRuntimeI.mjs"
                } else {
                    "t00DevelopmentRuntimeI.d.mts"
                })
            );
            assert_eq!(
                result.calls[0].callee_rel_path.as_deref(),
                present.then_some("t00DevelopmentRuntimeI.mjs")
            );
            assert_eq!(
                result.calls[0].callee_symbol_path.as_deref(),
                Some("t00DevelopmentRuntimeI")
            );
        }
    }

    #[test]
    fn development_declaration_only_endpoint_keeps_symbol_without_value_reason() {
        let result = development_extract(BTreeMap::from([
            ("/repo/t00DevelopmentDeclarationJ.d.ts".into(), "export declare const t00DevelopmentDeclaredJ: () => number;".into()),
            ("/repo/t00DevelopmentCallerJ.ts".into(), "import { t00DevelopmentDeclaredJ } from './t00DevelopmentDeclarationJ'; t00DevelopmentDeclaredJ();".into()),
        ]), "t00DevelopmentCallerJ.ts");
        assert_eq!(result.calls.len(), 1);
        assert_eq!(
            result.calls[0].callee_symbol_path.as_deref(),
            Some("t00DevelopmentDeclaredJ")
        );
        assert_eq!(result.calls[0].callee_rel_path, None);
        assert_eq!(result.calls[0].callee_unmodeled_reason, None);
    }

    #[test]
    fn development_arrow_has_own_scope_and_data_has_no_callable_symbol() {
        let path = "/repo/t00DevelopmentOrdinaryA.ts";
        let text = "export const t00DevelopmentArrowA = () => { function t00DevelopmentInnerA() {} return t00DevelopmentInnerA(); }; export const t00DevelopmentDataA = 43;";
        eprintln!(
            "ordinary_dev_input={}",
            serde_json::to_string(&BTreeMap::from([(path.to_owned(), text.to_owned())])).unwrap()
        );
        crate::development::with_project(
            BTreeMap::from([(path.to_owned(), text.to_owned())]),
            vec![path.to_owned()],
            || {
                let source = program::get_source_file(path);
                let result = program::with_type_checker_for_file(source, move |checker| {
                    extract(
                        source,
                        checker,
                        "t00DevelopmentOrdinaryA.ts",
                        &ExtractionContext {
                            repository_root: "/repo",
                            static_module_links: true,
                            retained: true,
                            javascript_enabled: false,
                            captured_files: None,
                            case_sensitive: true,
                        },
                    )
                })
                .unwrap();
                assert_eq!(result.symbols.len(), 2);
                assert_eq!(result.symbols[0].name, "t00DevelopmentArrowA");
                assert_eq!(result.symbols[0].scope, Vec::<String>::new());
                assert_eq!(result.symbols[1].name, "t00DevelopmentInnerA");
                assert_eq!(result.symbols[1].scope, vec!["t00DevelopmentArrowA"]);
                assert!(
                    !result
                        .symbols
                        .iter()
                        .any(|symbol| symbol.name == "t00DevelopmentDataA")
                );
            },
        );
    }
}
