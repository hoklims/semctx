use serde::Serialize;
use ts_goport::{checker::Checker, core::Node};

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeBindings {
    pub common_js_unsupported: bool,
    pub unmodeled_members: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime_evaluation_unsupported: Option<bool>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StaticExport {
    pub name: String,
    pub declaration_kind: String,
}

#[derive(Debug, Serialize)]
pub struct StaticModuleLink {
    pub specifier: String,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JavascriptScan {
    pub reasons: Vec<String>,
    pub native: NativeBindings,
    pub static_exports: Vec<StaticExport>,
    pub static_module_links: Vec<StaticModuleLink>,
    pub qualified_scope_reasons: Vec<String>,
}

use std::collections::{BTreeSet, HashSet};
use ts_goport::{
    ast,
    astdata::SyntaxKind as K,
    core::SymbolId,
    flags::{ModifierFlags, NodeFlags},
};

trait OptionalNodeKind {
    fn optional_kind(self) -> K;
}
impl OptionalNodeKind for Node {
    fn optional_kind(self) -> K {
        if self.is_nil() {
            K::Unknown
        } else {
            self.kind()
        }
    }
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum Origin {
    Factory,
    Namespace,
    Global,
    BrowserGlobal,
    ModuleMeta,
    Process,
    Evaluation,
    Ordinary,
    Unmodeled,
    Other,
}

#[derive(Clone, Default)]
struct Seen {
    symbols: HashSet<SymbolId>,
    nodes: HashSet<Node>,
}

struct Native<'a> {
    source: Node,
    checker: &'a mut Checker,
    result: NativeBindings,
    members: BTreeSet<String>,
}

fn static_name(node: Node) -> Option<String> {
    if node.is_some() && matches!(node.optional_kind(), K::Identifier | K::StringLiteral) {
        Some(node.text().into())
    } else {
        None
    }
}
fn node_module(node: Node) -> bool {
    node.is_some()
        && node.optional_kind() == K::StringLiteral
        && matches!(node.text(), "module" | "node:module")
}
fn node_process(node: Node) -> bool {
    node.is_some()
        && node.optional_kind() == K::StringLiteral
        && matches!(node.text(), "process" | "node:process")
}
fn import_meta(node: Node) -> bool {
    node.optional_kind() == K::MetaProperty
        && node.keyword_token() == K::ImportKeyword
        && node.name().text() == "meta"
}
fn member(node: Node) -> bool {
    matches!(
        node.optional_kind(),
        K::PropertyAccessExpression | K::ElementAccessExpression
    )
}
fn wrapped(node: Node) -> bool {
    matches!(
        node.optional_kind(),
        K::ParenthesizedExpression | K::AsExpression | K::NonNullExpression | K::AwaitExpression
    )
}
fn import_owner(mut node: Node) -> Node {
    while node.is_some() {
        if node.optional_kind() == K::ImportDeclaration {
            return node;
        }
        node = node.parent();
    }
    Node::NIL
}
fn sorted(mut names: Vec<String>) -> Vec<String> {
    names.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    names.dedup();
    names
}

impl Native<'_> {
    fn native_export(&mut self, name: Option<&str>) -> Origin {
        match name {
            Some("createRequire" | "_load") => Origin::Factory,
            Some("default" | "Module") => Origin::Namespace,
            Some("isBuiltin" | "builtinModules") => Origin::Ordinary,
            _ => {
                self.members.insert(name.unwrap_or("<computed>").into());
                Origin::Unmodeled
            }
        }
    }
    fn process_export(&mut self, name: Option<&str>) -> Origin {
        match name {
            Some("default") => Origin::Process,
            Some("getBuiltinModule") => {
                self.members.insert("process.getBuiltinModule".into());
                Origin::Unmodeled
            }
            Some(name) if crate::qualified::is_ordinary_native_process_member(name) => {
                Origin::Ordinary
            }
            _ => {
                self.members
                    .insert(format!("process.{}", name.unwrap_or("<computed>")));
                Origin::Unmodeled
            }
        }
    }
    fn global_member(&mut self, name: Option<&str>) -> Origin {
        match name {
            Some("eval" | "Function") => Origin::Evaluation,
            Some("window" | "self") => Origin::BrowserGlobal,
            Some("require") => Origin::Factory,
            Some("module" | "exports") => {
                self.result.common_js_unsupported = true;
                Origin::Namespace
            }
            Some("process") => Origin::Process,
            Some("global" | "globalThis") => Origin::Global,
            _ => Origin::Other,
        }
    }
    fn container_member(
        &mut self,
        container: Origin,
        name: Option<&str>,
        destructuring: bool,
    ) -> Origin {
        match container {
            Origin::ModuleMeta => {
                if name == Some("require") {
                    Origin::Factory
                } else {
                    Origin::Ordinary
                }
            }
            Origin::Namespace => self.native_export(name),
            Origin::Global => self.global_member(name),
            Origin::Process => self.process_export(name),
            Origin::BrowserGlobal => match name {
                Some("eval" | "Function") => Origin::Evaluation,
                Some("window" | "self" | "globalThis") if !destructuring => Origin::BrowserGlobal,
                _ => Origin::Other,
            },
            _ => Origin::Other,
        }
    }
    fn declarations(&self, symbol: SymbolId) -> Vec<Node> {
        if symbol.is_nil() {
            vec![]
        } else {
            self.checker
                .sym(symbol)
                .declarations
                .iter()
                .copied()
                .filter(|d| ast::get_source_file_of_node(*d) == self.source)
                .collect()
        }
    }
    #[expect(
        clippy::excessive_nesting,
        reason = "The native JavaScript AST traversal retains its explicit syntax dispatch in this feasibility port."
    )]
    fn origin(&mut self, node: Node, seen: Seen) -> Origin {
        if node.is_nil() {
            return Origin::Other;
        }
        if import_meta(node) {
            return Origin::ModuleMeta;
        }
        if wrapped(node) {
            return self.origin(node.expression(), seen);
        }
        if node.optional_kind() == K::CallExpression
            && node.expression().optional_kind() == K::ImportKeyword
        {
            let argument = node.arguments().iter().next().unwrap_or(Node::NIL);
            if node_module(argument) {
                return Origin::Namespace;
            }
            if node_process(argument) {
                return Origin::Process;
            }
        }
        if member(node) {
            let name = if node.optional_kind() == K::PropertyAccessExpression {
                Some(node.name().text().to_owned())
            } else if node.argument_expression().optional_kind() == K::StringLiteral {
                Some(node.argument_expression().text().to_owned())
            } else {
                None
            };
            let container = self.origin(node.expression(), seen);
            return self.container_member(container, name.as_deref(), false);
        }
        if node.optional_kind() != K::Identifier {
            return Origin::Other;
        }
        let symbol = self.checker.get_symbol_at_location_exported(node);
        let declarations = self.declarations(symbol);
        let synthetic = declarations.is_empty()
            || declarations.iter().all(|d| {
                matches!(
                    d.optional_kind(),
                    K::BinaryExpression
                        | K::SourceFile
                        | K::PropertyAccessExpression
                        | K::ElementAccessExpression
                )
            });
        if synthetic && matches!(node.text(), "globalThis" | "module" | "exports" | "require") {
            let mut scope = node.parent();
            while scope.is_some() {
                if ast::is_function_like(scope)
                    && scope.parameters().iter().any(|p| {
                        p.name().optional_kind() == K::Identifier && p.name().text() == node.text()
                    })
                {
                    return Origin::Other;
                }
                if matches!(
                    scope.optional_kind(),
                    K::SourceFile | K::Block | K::ModuleBlock
                ) {
                    let statements = scope.statement_list().nodes().to_vec();
                    for statement in &statements {
                        if statement.optional_kind() != K::VariableStatement {
                            continue;
                        }
                        for declaration in
                            statement.declaration_list().declarations().nodes().iter()
                        {
                            if declaration.name().optional_kind() == K::Identifier
                                && declaration.name().text() == node.text()
                            {
                                if declaration.initializer().is_nil()
                                    || seen.nodes.contains(&declaration)
                                {
                                    return Origin::Other;
                                }
                                let mut next = seen.clone();
                                next.nodes.insert(declaration);
                                return self.origin(declaration.initializer(), next);
                            }
                        }
                    }
                    if statements.iter().any(|s| {
                        matches!(
                            s.optional_kind(),
                            K::FunctionDeclaration | K::ClassDeclaration
                        ) && s.name().is_some()
                            && s.name().text() == node.text()
                    }) {
                        return Origin::Other;
                    }
                }
                scope = scope.parent();
            }
        }
        if synthetic {
            return self.global_member(Some(node.text()));
        }
        if seen.symbols.contains(&symbol) {
            return Origin::Other;
        }
        let mut next = seen;
        next.symbols.insert(symbol);
        for declaration in declarations {
            if matches!(
                declaration.optional_kind(),
                K::ImportSpecifier | K::NamespaceImport | K::ImportClause
            ) {
                let owner = import_owner(declaration);
                if owner.is_nil()
                    || owner.import_clause().is_type_only()
                    || (declaration.optional_kind() == K::ImportSpecifier
                        && declaration.is_type_only())
                {
                    continue;
                }
                if node_process(owner.module_specifier()) {
                    if declaration.optional_kind() == K::ImportSpecifier {
                        return self.process_export(
                            static_name(declaration.property_name_or_name()).as_deref(),
                        );
                    }
                    return Origin::Process;
                }
                if node_module(owner.module_specifier()) {
                    if declaration.optional_kind() == K::ImportSpecifier {
                        return self.native_export(
                            static_name(declaration.property_name_or_name()).as_deref(),
                        );
                    }
                    return Origin::Namespace;
                }
            }
            if declaration.optional_kind() == K::VariableDeclaration
                && declaration.initializer().is_some()
            {
                return self.origin(declaration.initializer(), next.clone());
            }
            if declaration.optional_kind() == K::BindingElement
                && declaration.parent().optional_kind() == K::ObjectBindingPattern
                && declaration.parent().parent().optional_kind() == K::VariableDeclaration
                && declaration.parent().parent().initializer().is_some()
            {
                let container =
                    self.origin(declaration.parent().parent().initializer(), next.clone());
                return self.container_member(
                    container,
                    static_name(declaration.property_name_or_name()).as_deref(),
                    true,
                );
            }
        }
        Origin::Other
    }
    fn mark_escape(&mut self, origin: Origin) {
        match origin {
            Origin::Factory | Origin::Namespace => self.result.common_js_unsupported = true,
            Origin::Global => {
                self.members.insert("ambient-global".into());
            }
            Origin::Process => {
                self.members.insert("ambient-process".into());
            }
            _ => {}
        }
    }
    #[expect(
        clippy::excessive_nesting,
        reason = "The native JavaScript AST traversal retains its explicit syntax dispatch in this feasibility port."
    )]
    fn reexports(&mut self) {
        for statement in self.source.statement_list().nodes().iter() {
            if statement.optional_kind() != K::ExportDeclaration || statement.is_type_only() {
                continue;
            }
            let clause = statement.export_clause();
            if node_process(statement.module_specifier()) {
                if clause.is_nil() || clause.optional_kind() == K::NamespaceExport {
                    self.process_export(Some("getBuiltinModule"));
                } else {
                    for element in clause.elements().iter() {
                        if !element.is_type_only() {
                            let kind = self.process_export(
                                static_name(element.property_name_or_name()).as_deref(),
                            );
                            if kind == Origin::Process {
                                self.process_export(Some("getBuiltinModule"));
                            }
                        }
                    }
                }
            } else if node_module(statement.module_specifier()) {
                if clause.is_nil() || clause.optional_kind() == K::NamespaceExport {
                    self.result.common_js_unsupported = true;
                } else {
                    for element in clause.elements().iter() {
                        if !element.is_type_only() {
                            let kind = self.native_export(
                                static_name(element.property_name_or_name()).as_deref(),
                            );
                            if matches!(kind, Origin::Factory | Origin::Namespace) {
                                self.result.common_js_unsupported = true;
                            }
                        }
                    }
                }
            }
        }
    }
    fn visit(&mut self, node: Node) {
        if ast::is_type_node(node) || node.optional_kind() == K::ImportDeclaration {
            return;
        }
        if node.optional_kind() == K::ShorthandPropertyAssignment {
            let symbol = self.checker.get_shorthand_assignment_value_symbol(node);
            for declaration in self.declarations(symbol) {
                if declaration.name().optional_kind() == K::Identifier {
                    let origin = self.origin(declaration.name(), Seen::default());
                    self.mark_escape(origin);
                }
            }
        }
        if node.optional_kind() == K::ExportAssignment {
            let origin = self.origin(node.expression(), Seen::default());
            self.mark_escape(origin);
        }
        if node.optional_kind() == K::VariableStatement
            && node.modifier_flags().intersects(ModifierFlags::EXPORT)
        {
            for declaration in node.declaration_list().declarations().nodes().iter() {
                if declaration.initializer().is_some() {
                    let origin = self.origin(declaration.initializer(), Seen::default());
                    self.mark_escape(origin);
                }
            }
        }
        if node.optional_kind() == K::ExportSpecifier
            && !node.is_type_only()
            && !node.parent().parent().is_type_only()
        {
            let symbol = self.checker.get_export_specifier_local_target_symbol(node);
            for declaration in self.declarations(symbol) {
                if declaration.name().optional_kind() == K::Identifier {
                    let origin = self.origin(declaration.name(), Seen::default());
                    self.mark_escape(origin);
                }
            }
        }
        let parent = node.parent();
        let declaration_name = node.optional_kind() == K::Identifier
            && ((parent.optional_kind() == K::VariableDeclaration && parent.name() == node)
                || (parent.optional_kind() == K::BindingElement
                    && (parent.name() == node || parent.property_name() == node))
                || (parent.optional_kind() == K::PropertyAccessExpression
                    && parent.name() == node)
                || (parent.optional_kind() == K::PropertyAssignment && parent.name() == node)
                || (parent.optional_kind() == K::Parameter && parent.name() == node));
        if !declaration_name {
            let kind = self.origin(node, Seen::default());
            let computed = parent.optional_kind() == K::ElementAccessExpression
                && parent.expression() == node
                && parent.argument_expression().optional_kind() != K::StringLiteral;
            let safe = safe_namespace_use(node);
            match kind {
                Origin::Factory => self.result.common_js_unsupported = true,
                Origin::Evaluation => self.result.runtime_evaluation_unsupported = Some(true),
                Origin::ModuleMeta if !safe || computed => self.result.common_js_unsupported = true,
                Origin::BrowserGlobal if !safe || computed => {
                    self.result.runtime_evaluation_unsupported = Some(true)
                }
                Origin::Namespace if !safe => self.result.common_js_unsupported = true,
                Origin::Global if !safe || computed => {
                    self.members.insert("ambient-global".into());
                }
                Origin::Process if !safe => {
                    self.members.insert("ambient-process".into());
                }
                _ => {}
            }
        }
        node.for_each_child(|child| {
            self.visit(child);
            false
        });
    }
}

fn safe_namespace_use(node: Node) -> bool {
    let parent = node.parent();
    if parent.is_nil() {
        return false;
    }
    if (member(parent) || wrapped(parent)) && parent.expression() == node {
        return true;
    }
    if parent.optional_kind() == K::TypeOfExpression || ast::is_type_node(parent) {
        return true;
    }
    if parent.optional_kind() != K::VariableDeclaration
        || parent.initializer() != node
        || !parent.parent().flags().intersects(NodeFlags::CONST)
    {
        return false;
    }
    let name = parent.name();
    name.optional_kind() == K::Identifier
        || (name.optional_kind() == K::ObjectBindingPattern
            && name.elements().iter().all(|e| {
                e.dot_dot_dot_token().is_nil()
                    && e.name().optional_kind() == K::Identifier
                    && (e.property_name().is_nil()
                        || matches!(
                            e.property_name().optional_kind(),
                            K::Identifier | K::StringLiteral
                        ))
            }))
}

pub fn inspect_native_module_bindings(source: Node, checker: &mut Checker) -> NativeBindings {
    let mut scan = Native {
        source,
        checker,
        result: NativeBindings::default(),
        members: BTreeSet::new(),
    };
    scan.reexports();
    scan.visit(source);
    scan.result.unmodeled_members = sorted(scan.members.into_iter().collect());
    scan.result
}

pub fn has_unsupported_default_expression(source: Node) -> bool {
    source
        .statement_list()
        .nodes()
        .iter()
        .any(|s| s.optional_kind() == K::ExportAssignment && !s.is_export_equals())
}

pub fn has_semantic_jsdoc_import(source: Node) -> bool {
    if !source.flags().intersects(NodeFlags::JAVA_SCRIPT_FILE) {
        return false;
    }
    fn doc(node: Node) -> bool {
        matches!(node.optional_kind(), K::ImportType | K::JsDocImportTag)
            || node.for_each_child(doc)
    }
    fn visit(node: Node, source: Node) -> bool {
        node.js_doc(source).iter().any(doc) || node.for_each_child(|n| visit(n, source))
    }
    visit(source, source)
}

fn modeled_call(mut node: Node) -> bool {
    while matches!(
        node.optional_kind(),
        K::ParenthesizedExpression
            | K::AsExpression
            | K::TypeAssertionExpression
            | K::NonNullExpression
            | K::SatisfiesExpression
    ) {
        node = node.expression();
    }
    matches!(
        node.optional_kind(),
        K::Identifier | K::PropertyAccessExpression | K::ImportKeyword
    )
}

pub fn inspect_unmodeled_invocations(source: Node) -> Vec<String> {
    fn visit(node: Node, javascript: bool, reasons: &mut BTreeSet<String>) {
        if node.optional_kind() == K::TaggedTemplateExpression {
            reasons.insert("SOURCE_TAGGED_TEMPLATE_UNSUPPORTED".into());
        }
        if !javascript
            && node.optional_kind() == K::CallExpression
            && !modeled_call(node.expression())
        {
            reasons.insert("SOURCE_DYNAMIC_CALL_UNSUPPORTED".into());
        }
        node.for_each_child(|n| {
            visit(n, javascript, reasons);
            false
        });
    }
    let mut reasons = BTreeSet::new();
    visit(
        source,
        source.flags().intersects(NodeFlags::JAVA_SCRIPT_FILE),
        &mut reasons,
    );
    sorted(reasons.into_iter().collect())
}

pub fn inspect_qualified_module_scope(source: Node, path: &str) -> Vec<String> {
    fn visit(node: Node, reasons: &mut Vec<String>) {
        if node.optional_kind() == K::ModuleDeclaration {
            if ast::is_global_scope_augmentation(node) {
                reasons.push("SOURCE_GLOBAL_AUGMENTATION_UNSUPPORTED".into());
            }
            if node.name().optional_kind() == K::StringLiteral {
                reasons.push("SOURCE_MODULE_AUGMENTATION_UNSUPPORTED".into());
            }
        }
        node.for_each_child(|n| {
            visit(n, reasons);
            false
        });
    }
    let mut reasons = vec![];
    if path.ends_with(".cts") || path.ends_with(".cjs") {
        reasons.push("SOURCE_COMMONJS_EXTENSION_UNSUPPORTED".into());
    }
    visit(source, &mut reasons);
    if !ast::is_external_module(source) && !path.ends_with(".mjs") && !path.ends_with(".mts") {
        reasons.push("SOURCE_GLOBAL_SCRIPT_UNSUPPORTED".into());
    }
    let mut seen = BTreeSet::new();
    reasons.retain(|r| seen.insert(r.clone()));
    reasons
}

fn syntax_scan(node: Node, reasons: &mut BTreeSet<String>, links: &mut Vec<StaticModuleLink>) {
    if node.optional_kind() == K::TaggedTemplateExpression {
        reasons.insert("JAVASCRIPT_TAGGED_TEMPLATE_UNSUPPORTED".into());
    }
    if node.optional_kind() == K::CallExpression {
        if !modeled_call(node.expression()) {
            reasons.insert("JAVASCRIPT_DYNAMIC_CALL_UNSUPPORTED".into());
        }
        if node.expression().optional_kind() == K::ImportKeyword {
            let args = node.arguments();
            if args.len() != 1 || args.get(0).optional_kind() != K::StringLiteral {
                reasons.insert("JAVASCRIPT_DYNAMIC_IMPORT_UNSUPPORTED".into());
            } else {
                links.push(StaticModuleLink {
                    specifier: args.get(0).text().into(),
                });
            }
        }
    }
    if node.optional_kind() == K::WithStatement {
        reasons.insert("JAVASCRIPT_DYNAMIC_SCOPE_UNSUPPORTED".into());
    }
    if matches!(
        node.optional_kind(),
        K::ImportDeclaration | K::ExportDeclaration
    ) && node.module_specifier().optional_kind() == K::StringLiteral
    {
        links.push(StaticModuleLink {
            specifier: node.module_specifier().text().into(),
        });
    }
    node.for_each_child(|n| {
        syntax_scan(n, reasons, links);
        false
    });
}

#[expect(
    clippy::excessive_nesting,
    reason = "The native JavaScript AST traversal retains its explicit syntax dispatch in this feasibility port."
)]
fn static_exports(source: Node, reasons: &mut BTreeSet<String>) -> Vec<StaticExport> {
    let mut exports = vec![];
    for statement in source.statement_list().nodes().iter() {
        if statement.optional_kind() == K::ExportDeclaration {
            let clause = statement.export_clause();
            if clause.optional_kind() == K::NamedExports {
                for element in clause.elements().iter() {
                    exports.push(StaticExport {
                        name: element.name().text().into(),
                        declaration_kind: if statement.module_specifier().is_some() {
                            "reexport"
                        } else {
                            "local-binding"
                        }
                        .into(),
                    });
                }
            } else if clause.optional_kind() == K::NamespaceExport {
                exports.push(StaticExport {
                    name: clause.name().text().into(),
                    declaration_kind: "namespace-reexport".into(),
                });
            } else {
                exports.push(StaticExport {
                    name: "*".into(),
                    declaration_kind: "reexport".into(),
                });
            }
        } else if statement.optional_kind() == K::ExportAssignment {
            exports.push(StaticExport {
                name: "default".into(),
                declaration_kind: "expression".into(),
            });
        } else if matches!(
            statement.optional_kind(),
            K::VariableStatement | K::FunctionDeclaration | K::ClassDeclaration
        ) && statement.modifier_flags().intersects(ModifierFlags::EXPORT)
        {
            if statement.optional_kind() == K::VariableStatement {
                for declaration in statement.declaration_list().declarations().nodes().iter() {
                    if declaration.name().optional_kind() == K::Identifier {
                        exports.push(StaticExport {
                            name: declaration.name().text().into(),
                            declaration_kind: "variable".into(),
                        });
                    } else {
                        reasons.insert("JAVASCRIPT_EXPORTED_DESTRUCTURING_UNSUPPORTED".into());
                    }
                }
            } else {
                let name = if statement
                    .modifier_flags()
                    .intersects(ModifierFlags::DEFAULT)
                {
                    Some("default".into())
                } else {
                    static_name(statement.name())
                };
                if let Some(name) = name {
                    exports.push(StaticExport {
                        name,
                        declaration_kind: if statement.optional_kind() == K::FunctionDeclaration {
                            "function"
                        } else {
                            "class"
                        }
                        .into(),
                    });
                }
            }
        }
    }
    exports.sort_by(|a, b| a.name.encode_utf16().cmp(b.name.encode_utf16()));
    exports
}

pub fn inspect(
    source: Node,
    checker: &mut Checker,
    rel_path: &str,
    retained: bool,
) -> JavascriptScan {
    let javascript = source.flags().intersects(NodeFlags::JAVA_SCRIPT_FILE);
    let native = inspect_native_module_bindings(source, checker);
    let mut reasons = BTreeSet::new();
    let default = has_unsupported_default_expression(source);
    let jsdoc = has_semantic_jsdoc_import(source);
    if default {
        reasons.insert(
            if javascript {
                "JAVASCRIPT_DEFAULT_EXPRESSION_UNSUPPORTED"
            } else {
                "SOURCE_DEFAULT_EXPRESSION_UNSUPPORTED"
            }
            .into(),
        );
    }
    if jsdoc {
        reasons.insert("JAVASCRIPT_JSDOC_IMPORT_UNSUPPORTED".into());
    }
    let mut links = vec![];
    let mut exports = vec![];
    if javascript {
        if rel_path.ends_with(".cjs") {
            reasons.insert("JAVASCRIPT_COMMONJS_UNSUPPORTED".into());
        }
        if native.common_js_unsupported {
            reasons.insert("JAVASCRIPT_COMMONJS_UNSUPPORTED".into());
        }
        if native.runtime_evaluation_unsupported == Some(true) {
            reasons.insert("JAVASCRIPT_DYNAMIC_EVALUATION_UNSUPPORTED".into());
        }
        for member in &native.unmodeled_members {
            reasons.insert(format!(
                "JAVASCRIPT_NATIVE_MODULE_MEMBER_UNSUPPORTED:{member}"
            ));
        }
        exports = static_exports(source, &mut reasons);
        syntax_scan(source, &mut reasons, &mut links);
    }
    if retained {
        if default {
            reasons.insert("SOURCE_DEFAULT_EXPRESSION_UNSUPPORTED".into());
        }
        if jsdoc {
            reasons.insert("SOURCE_JSDOC_IMPORT_UNSUPPORTED".into());
        }
        reasons.extend(inspect_unmodeled_invocations(source));
        if native.common_js_unsupported {
            reasons.insert("SOURCE_COMMONJS_UNSUPPORTED".into());
        }
    }
    JavascriptScan {
        reasons: sorted(reasons.into_iter().collect()),
        native,
        static_exports: exports,
        static_module_links: links,
        qualified_scope_reasons: inspect_qualified_module_scope(source, rel_path),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JavaScriptSourceObservation {
    pub executed: bool,
    pub parse_failed: Option<bool>,
    pub reasons: Vec<String>,
    pub unsupported: BTreeSet<String>,
    pub static_exports: Vec<StaticExport>,
    pub static_module_links: serde_json::Value,
}

pub struct JavaScriptSourceInputs<'a> {
    pub source: Node,
    pub path: &'a str,
    pub native: &'a NativeBindings,
    pub semantic: &'a crate::qualified::QualifiedScan,
    pub configuration: &'a crate::component_observations::Observation,
    pub static_module_links: &'a serde_json::Value,
    pub unsupported: &'a BTreeSet<String>,
}

pub fn inspect_javascript_source(
    inputs: JavaScriptSourceInputs<'_>,
) -> JavaScriptSourceObservation {
    use ts_goport::{
        flags::{JsxEmit, ModuleKind, ScriptTarget},
        options::CompilerOptions,
        transpile,
    };

    if !inputs
        .source
        .flags()
        .intersects(NodeFlags::JAVA_SCRIPT_FILE)
    {
        return JavaScriptSourceObservation {
            executed: false,
            parse_failed: None,
            reasons: vec![],
            unsupported: BTreeSet::from(["COMPONENT_JAVASCRIPT_SOURCE_REQUIRED".into()]),
            static_exports: vec![],
            static_module_links: serde_json::json!([]),
        };
    }
    let output = transpile::transpile_module(
        &ts_goport::gostd::context::background(),
        &ast::source_file_text(inputs.source),
        transpile::Options {
            compiler_options: Some(CompilerOptions {
                target: ScriptTarget::ES2022,
                module: ModuleKind::ES_NEXT,
                jsx: JsxEmit::PRESERVE,
                ..Default::default()
            }),
            file_name: inputs.path.into(),
            report_diagnostics: true,
        },
    );
    let mut unsupported = inputs.unsupported.clone();
    unsupported.extend(inputs.semantic.unsupported.iter().cloned());
    unsupported.extend(inputs.configuration.unsupported.iter().cloned());
    if !inputs.configuration.executed {
        unsupported.insert("NATIVE_JAVASCRIPT_CONFIGURATION_NOT_EXECUTED".into());
    }
    let Some(output) = output else {
        unsupported.insert("NATIVE_JAVASCRIPT_TRANSPILATION_CANCELLED".into());
        return JavaScriptSourceObservation {
            executed: false,
            parse_failed: None,
            reasons: vec![],
            unsupported,
            static_exports: vec![],
            static_module_links: serde_json::json!([]),
        };
    };
    let mut reasons = BTreeSet::new();
    for diagnostic in &output.diagnostics {
        reasons.insert(format!(
            "JAVASCRIPT_PARSE_ERROR:{}:{}",
            diagnostic.code(),
            diagnostic
                .localize(&ts_goport::locale::DEFAULT)
                .replace('\n', " "),
        ));
    }
    reasons.extend(
        inputs
            .semantic
            .reasons
            .iter()
            .map(|reason| reason.replacen("SOURCE_", "JAVASCRIPT_", 1)),
    );
    if inputs.path.ends_with(".cjs") || inputs.native.common_js_unsupported {
        reasons.insert("JAVASCRIPT_COMMONJS_UNSUPPORTED".into());
    }
    if has_semantic_jsdoc_import(inputs.source) {
        reasons.insert("JAVASCRIPT_JSDOC_IMPORT_UNSUPPORTED".into());
    }
    if has_unsupported_default_expression(inputs.source) {
        reasons.insert("JAVASCRIPT_DEFAULT_EXPRESSION_UNSUPPORTED".into());
    }
    if inputs.native.runtime_evaluation_unsupported == Some(true) {
        reasons.insert("JAVASCRIPT_DYNAMIC_EVALUATION_UNSUPPORTED".into());
    }
    for member in &inputs.native.unmodeled_members {
        reasons.insert(format!(
            "JAVASCRIPT_NATIVE_MODULE_MEMBER_UNSUPPORTED:{member}"
        ));
    }
    let exports = static_exports(inputs.source, &mut reasons);
    let mut links = vec![];
    syntax_scan(inputs.source, &mut reasons, &mut links);
    for link in inputs.static_module_links.as_array().into_iter().flatten() {
        if link["resolution"] == "unresolved"
            && let Some(specifier) = link["specifier"].as_str()
        {
            reasons.insert(format!("JAVASCRIPT_IMPORT_UNRESOLVED:{specifier}"));
        }
    }
    reasons.extend(inputs.configuration.reasons.iter().cloned());
    JavaScriptSourceObservation {
        executed: true,
        parse_failed: Some(!output.diagnostics.is_empty()),
        reasons: sorted(reasons.into_iter().collect()),
        unsupported,
        static_exports: exports,
        static_module_links: inputs.static_module_links.clone(),
    }
}

#[cfg(test)]
#[path = "../tests/unit/javascript.rs"]
mod tests;
