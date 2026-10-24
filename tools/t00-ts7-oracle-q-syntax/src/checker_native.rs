use serde_json::{Value, json};
use std::collections::BTreeSet;
use ts_goport::{ast, astdata::SyntaxKind as K, prelude::*};

#[derive(Clone, Copy, PartialEq, Eq)]
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

#[derive(Default)]
struct Native {
    common_js: bool,
    evaluation: bool,
    unknown: BTreeSet<String>,
}

fn static_name(node: Node) -> Option<String> {
    (node.is_some() && matches!(node.kind(), K::Identifier | K::StringLiteral))
        .then(|| node.text().to_string())
}

fn module_kind(node: Node) -> Origin {
    if node.is_nil() || node.kind() != K::StringLiteral {
        return Origin::Other;
    }
    match node.text() {
        "node:module" | "module" => Origin::Namespace,
        "node:process" | "process" => Origin::Process,
        _ => Origin::Other,
    }
}

fn wrapper(node: Node) -> bool {
    matches!(
        node.kind(),
        K::ParenthesizedExpression | K::AsExpression | K::NonNullExpression | K::AwaitExpression
    )
}

fn lexical_declaration(statement: Node, name: &str) -> Option<Node> {
    if statement.kind() == K::VariableStatement {
        return statement
            .declaration_list()
            .declarations()
            .nodes()
            .iter()
            .find(|declaration| static_name(declaration.name()).as_deref() == Some(name));
    }
    (matches!(
        statement.kind(),
        K::FunctionDeclaration | K::ClassDeclaration
    ) && static_name(statement.name()).as_deref() == Some(name))
    .then_some(statement)
}

impl Native {
    fn lexical_origin(
        &mut self,
        node: Node,
        name: &str,
        checker: &mut Checker,
        seen: &[Node],
    ) -> Option<Origin> {
        let mut scope = node.parent();
        while scope.is_some() {
            if ast::is_function_like(scope)
                && scope
                    .parameters()
                    .iter()
                    .any(|parameter| static_name(parameter.name()).as_deref() == Some(name))
            {
                return Some(Origin::Other);
            }
            if !matches!(scope.kind(), K::SourceFile | K::Block | K::ModuleBlock) {
                scope = scope.parent();
                continue;
            }
            for statement in scope.statements().iter() {
                let Some(declaration) = lexical_declaration(statement, name) else {
                    continue;
                };
                if declaration.kind() != K::VariableDeclaration || seen.contains(&declaration) {
                    return Some(Origin::Other);
                }
                let mut next = seen.to_vec();
                next.push(declaration);
                return Some(self.origin(declaration.initializer(), checker, &next));
            }
            scope = scope.parent();
        }
        None
    }

    fn member(&mut self, container: Origin, property: Option<&str>) -> Origin {
        use Origin::*;
        match container {
            ModuleMeta => {
                if property == Some("require") {
                    Factory
                } else {
                    Ordinary
                }
            }
            Namespace => match property {
                Some("createRequire" | "_load") => Factory,
                Some("default" | "Module") => Namespace,
                Some("isBuiltin" | "builtinModules") => Ordinary,
                _ => {
                    self.unknown.insert(property.unwrap_or("<computed>").into());
                    Unmodeled
                }
            },
            Process => match property {
                Some("default") => Process,
                Some(
                    "argv" | "cwd" | "env" | "execPath" | "exit" | "exitCode" | "platform"
                    | "stderr" | "stdout" | "versions",
                ) => Ordinary,
                _ => {
                    self.unknown
                        .insert(format!("process.{}", property.unwrap_or("<computed>")));
                    Unmodeled
                }
            },
            Global => match property {
                Some("eval" | "Function") => Evaluation,
                Some("window" | "self") => BrowserGlobal,
                Some("require") => Factory,
                Some("module" | "exports") => {
                    self.common_js = true;
                    Namespace
                }
                Some("process") => Process,
                Some("global" | "globalThis") => Global,
                _ => Other,
            },
            BrowserGlobal => match property {
                Some("eval" | "Function") => Evaluation,
                Some("window" | "self" | "globalThis") => BrowserGlobal,
                _ => Other,
            },
            _ => Other,
        }
    }

    fn origin(&mut self, node: Node, checker: &mut Checker, seen: &[Node]) -> Origin {
        if node.is_nil() {
            return Origin::Other;
        }
        if node.kind() == K::MetaProperty
            && node.keyword_token() == K::ImportKeyword
            && node.name().text() == "meta"
        {
            return Origin::ModuleMeta;
        }
        if wrapper(node) {
            return self.origin(node.expression(), checker, seen);
        }
        if node.kind() == K::CallExpression && node.expression().kind() == K::ImportKeyword {
            return node.arguments().first().map_or(Origin::Other, module_kind);
        }
        if matches!(
            node.kind(),
            K::PropertyAccessExpression | K::ElementAccessExpression
        ) {
            let property = if node.kind() == K::PropertyAccessExpression {
                static_name(node.name())
            } else if node.argument_expression().kind() == K::StringLiteral {
                static_name(node.argument_expression())
            } else {
                None
            };
            let container = self.origin(node.expression(), checker, seen);
            return self.member(container, property.as_deref());
        }
        if node.kind() != K::Identifier {
            return Origin::Other;
        }
        let symbol = checker.get_symbol_at_location_exported(node);
        let declarations = if symbol.is_some() {
            checker
                .sym(symbol)
                .declarations
                .iter()
                .copied()
                .collect::<Vec<_>>()
        } else {
            Vec::new()
        };
        let synthetic = declarations.iter().all(|declaration| {
            matches!(
                declaration.kind(),
                K::BinaryExpression
                    | K::SourceFile
                    | K::PropertyAccessExpression
                    | K::ElementAccessExpression
            )
        });
        let name = node.text().to_string();
        if synthetic
            && matches!(
                name.as_str(),
                "globalThis" | "module" | "exports" | "require"
            )
            && let Some(origin) = self.lexical_origin(node, &name, checker, seen)
        {
            return origin;
        }
        if synthetic {
            return self.member(Origin::Global, Some(&name));
        }
        if declarations
            .iter()
            .any(|declaration| seen.contains(declaration))
        {
            return Origin::Other;
        }
        let mut next = seen.to_vec();
        next.extend(declarations.iter().copied());
        for declaration in declarations {
            let mut import = declaration;
            while import.is_some() && !matches!(import.kind(), K::ImportDeclaration | K::SourceFile)
            {
                import = import.parent();
            }
            if import.kind() == K::ImportDeclaration {
                let mut ancestor = declaration;
                let mut erased = false;
                while ancestor != import {
                    erased |= matches!(ancestor.kind(), K::ImportClause | K::ImportSpecifier)
                        && ancestor.is_type_only();
                    ancestor = ancestor.parent();
                }
                if erased {
                    return Origin::Other;
                }
                let container = module_kind(import.module_specifier());
                if declaration.kind() == K::ImportSpecifier {
                    let property = static_name(declaration.property_name_or_name());
                    return self.member(container, property.as_deref());
                }
                if matches!(declaration.kind(), K::ImportClause | K::NamespaceImport) {
                    return container;
                }
            }
            if declaration.kind() == K::VariableDeclaration {
                return self.origin(declaration.initializer(), checker, &next);
            }
            if declaration.kind() == K::BindingElement
                && declaration.parent().kind() == K::ObjectBindingPattern
                && declaration.parent().parent().kind() == K::VariableDeclaration
            {
                let container =
                    self.origin(declaration.parent().parent().initializer(), checker, &next);
                let property = static_name(declaration.property_name_or_name());
                if container == Origin::BrowserGlobal {
                    return match property.as_deref() {
                        Some("eval" | "Function") => Origin::Evaluation,
                        _ => Origin::Other,
                    };
                }
                return self.member(container, property.as_deref());
            }
        }
        Origin::Other
    }

    fn escape(&mut self, origin: Origin) {
        match origin {
            Origin::Factory | Origin::Namespace => self.common_js = true,
            Origin::Global => {
                self.unknown.insert("ambient-global".into());
            }
            Origin::Process => {
                self.unknown.insert("ambient-process".into());
            }
            _ => {}
        }
    }

    fn symbol_escape(&mut self, symbol: SymbolId, checker: &mut Checker) {
        if !symbol.is_some() {
            return;
        }
        for declaration in checker.sym(symbol).declarations.clone() {
            if declaration.name().is_some() && declaration.name().kind() == K::Identifier {
                let origin = self.origin(declaration.name(), checker, &[]);
                self.escape(origin);
            }
        }
    }

    fn visit(&mut self, node: Node, checker: &mut Checker) {
        if ast::is_type_node(node) || node.kind() == K::ImportDeclaration {
            return;
        }
        if node.kind() == K::ShorthandPropertyAssignment {
            let symbol = checker.get_shorthand_assignment_value_symbol(node);
            self.symbol_escape(symbol, checker);
        }
        if node.kind() == K::ExportSpecifier
            && !node.is_type_only()
            && !node.parent().parent().is_type_only()
        {
            let symbol = checker.get_export_specifier_local_target_symbol(node);
            self.symbol_escape(symbol, checker);
        }
        if node.kind() == K::ExportAssignment {
            let origin = self.origin(node.expression(), checker, &[]);
            self.escape(origin);
        }
        if node.kind() == K::VariableStatement
            && ast::get_combined_modifier_flags(node).intersects(ModifierFlags::EXPORT)
        {
            for declaration in node.declaration_list().declarations().nodes().iter() {
                let origin = self.origin(declaration.initializer(), checker, &[]);
                self.escape(origin);
            }
        }
        let parent = node.parent();
        let declaration_name = node.kind() == K::Identifier
            && match parent.kind() {
                K::VariableDeclaration
                | K::Parameter
                | K::PropertyAccessExpression
                | K::PropertyAssignment => parent.name() == node,
                K::BindingElement => parent.name() == node || parent.property_name() == node,
                _ => false,
            };
        if !declaration_name {
            let origin = self.origin(node, checker, &[]);
            let computed = parent.is_some()
                && parent.kind() == K::ElementAccessExpression
                && parent.expression() == node
                && parent.argument_expression().kind() != K::StringLiteral;
            match origin {
                Origin::Factory => self.common_js = true,
                Origin::Evaluation => self.evaluation = true,
                Origin::ModuleMeta if !safe_namespace_use(node) || computed => {
                    self.common_js = true
                }
                Origin::BrowserGlobal if !safe_namespace_use(node) || computed => {
                    self.evaluation = true
                }
                Origin::Namespace if !safe_namespace_use(node) => self.common_js = true,
                Origin::Global if !safe_namespace_use(node) || computed => {
                    self.unknown.insert("ambient-global".into());
                }
                Origin::Process if !safe_namespace_use(node) => {
                    self.unknown.insert("ambient-process".into());
                }
                _ => {}
            }
        }
        node.for_each_child(|child| {
            self.visit(child, checker);
            false
        });
    }

    fn reexports(&mut self, source: Node) {
        for statement in source.statements().iter().filter(|statement| {
            statement.kind() == K::ExportDeclaration && !statement.is_type_only()
        }) {
            let container = module_kind(statement.module_specifier());
            if !matches!(container, Origin::Namespace | Origin::Process) {
                continue;
            }
            let clause = statement.export_clause();
            if clause.is_nil() || clause.kind() == K::NamespaceExport {
                if container == Origin::Namespace {
                    self.common_js = true;
                } else {
                    self.unknown.insert("process.getBuiltinModule".into());
                }
                continue;
            }
            for element in clause
                .elements()
                .iter()
                .filter(|element| !element.is_type_only())
            {
                let property = static_name(element.property_name_or_name());
                let origin = self.member(container, property.as_deref());
                if container == Origin::Namespace {
                    self.escape(origin);
                } else if origin == Origin::Process {
                    self.unknown.insert("process.getBuiltinModule".into());
                }
            }
        }
    }

    fn result(self) -> Value {
        let mut reasons = self
            .unknown
            .iter()
            .map(|member| format!("JAVASCRIPT_NATIVE_MODULE_MEMBER_UNSUPPORTED:{member}"))
            .collect::<Vec<_>>();
        if self.common_js {
            reasons.push("JAVASCRIPT_COMMONJS_UNSUPPORTED".into());
        }
        if self.evaluation {
            reasons.push("JAVASCRIPT_DYNAMIC_EVALUATION_UNSUPPORTED".into());
        }
        reasons.sort();
        let mut native =
            json!({"commonJsUnsupported": self.common_js, "unmodeledMembers": self.unknown});
        if self.evaluation {
            native["runtimeEvaluationUnsupported"] = json!(true);
        }
        json!({"native": native, "nativeReasons": reasons, "executed": true, "unsupported": []})
    }
}

fn safe_namespace_use(node: Node) -> bool {
    let parent = node.parent();
    if matches!(
        parent.kind(),
        K::PropertyAccessExpression | K::ElementAccessExpression
    ) || wrapper(parent)
    {
        return parent.expression() == node;
    }
    if parent.kind() == K::TypeOfExpression || ast::is_type_node(parent) {
        return true;
    }
    if parent.kind() != K::VariableDeclaration
        || parent.initializer() != node
        || !parent.parent().flags().intersects(NodeFlags::CONST)
    {
        return false;
    }
    parent.name().kind() == K::Identifier
        || (parent.name().kind() == K::ObjectBindingPattern
            && parent.name().elements().iter().all(|element| {
                element.dot_dot_dot_token().is_nil()
                    && element.name().kind() == K::Identifier
                    && (element.property_name().is_nil()
                        || static_name(element.property_name()).is_some())
            }))
}

pub fn observe(input: &Value) -> Result<Value, String> {
    let mut input = input.clone();
    input["nativeNoResolve"] = json!(true);
    let roots = crate::checker_program::install(&input)?;
    if roots.len() != 1 {
        return Err("native checker requires exactly one source root".into());
    }
    let source = source_files()
        .into_iter()
        .find(|file| source_file_file_name(*file) == roots[0])
        .ok_or("native source was not loaded")?;
    Ok(with_type_checker_for_file(source, move |checker| {
        let mut native = Native::default();
        native.reexports(source);
        native.visit(source, checker);
        native.result()
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn inspect(source: &str) -> Value {
        let _program = ts_goport::core::enter_program(None);
        let sdk = crate::checker_program::test_sdk_directory();
        observe(&json!({"operation":"checker-native", "files":{"main.ts":source}, "roots":["main.ts"], "sdk_directory":sdk.path})).unwrap()["native"].clone()
    }

    #[test]
    fn checker_distinguishes_ambient_factory_and_lexical_shadows() {
        assert_eq!(
            inspect("require('x'); export {};"),
            json!({"commonJsUnsupported":true,"unmodeledMembers":[]})
        );
        assert_eq!(
            inspect("function f(require) { require('x'); } export {};"),
            json!({"commonJsUnsupported":false,"unmodeledMembers":[]})
        );
    }

    #[test]
    fn checker_tracks_imported_alias_shorthand_and_export_symbols() {
        for source in [
            "import {createRequire as create} from 'node:module'; const factory = create; factory('x');",
            "import * as mod from 'node:module'; const value = {mod};",
            "import * as mod from 'node:module'; export {mod};",
            "import * as mod from 'node:module'; const {createRequire: create} = mod; create('x');",
        ] {
            assert_eq!(
                inspect(source),
                json!({"commonJsUnsupported":true,"unmodeledMembers":[]}),
                "{source}"
            );
        }
    }

    #[test]
    fn erased_import_and_type_query_never_activate_native_origin() {
        for source in [
            "import type {createRequire} from 'node:module'; type Factory = typeof createRequire;",
            "import {type createRequire} from 'node:module'; type Factory = typeof createRequire;",
            "import type * as mod from 'node:module'; type Module = typeof mod;",
        ] {
            assert_eq!(
                inspect(source),
                json!({"commonJsUnsupported":false,"unmodeledMembers":[]})
            );
        }
    }

    #[test]
    fn unknown_process_and_module_members_preserve_distinct_native_reason() {
        assert_eq!(
            inspect("import {register} from 'node:module'; register('x');"),
            json!({"commonJsUnsupported":false,"unmodeledMembers":["register"]})
        );
        assert_eq!(
            inspect("process.getBuiltinModule('fs'); export {};"),
            json!({"commonJsUnsupported":false,"unmodeledMembers":["process.getBuiltinModule"]})
        );
        assert_eq!(
            inspect("process.cwd(); export {};"),
            json!({"commonJsUnsupported":false,"unmodeledMembers":[]})
        );
    }

    #[test]
    fn importmeta_require_and_destructured_require_are_factories() {
        for source in [
            "import.meta.require('x');",
            "const {require: load} = import.meta; load('x');",
        ] {
            assert_eq!(
                inspect(source),
                json!({"commonJsUnsupported":true,"unmodeledMembers":[]})
            );
        }
        assert_eq!(
            inspect("import.meta.url; import.meta.resolve('x');"),
            json!({"commonJsUnsupported":false,"unmodeledMembers":[]})
        );
    }
}
