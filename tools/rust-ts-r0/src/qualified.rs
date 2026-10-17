use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet, HashSet};
use ts_goport::{
    ast,
    astdata::SyntaxKind as K,
    astnav,
    checker::Checker,
    core::{Node, SignatureId, SymbolId, TypeId},
    flags::{ModifierFlags, NodeFlags, SignatureKind, SymbolFlags, TypeFlags},
    program,
};

#[derive(Clone, Debug, Eq, PartialEq, Ord, PartialOrd, Serialize)]
pub struct QualifiedSpan {
    pub path: String,
    pub start_utf16: i32,
    pub end_utf16: i32,
}

#[derive(Default)]
pub struct QualifiedInputs {
    pub repository_root: String,
    pub retained_files: BTreeMap<String, String>,
    pub graph: Option<serde_json::Value>,
    pub builtin_modules: BTreeSet<String>,
    pub retained_paths: BTreeSet<String>,
    pub case_sensitive: bool,
    pub inline_owned_callbacks: BTreeSet<QualifiedSpan>,
    pub retained_callable_coordinates: BTreeSet<QualifiedSpan>,
    pub retained_callable_coordinates_observed: bool,
    pub inline_callback_ownership_observed: bool,
}

#[derive(Debug, Default, Serialize)]
pub struct QualifiedScan {
    pub reasons: BTreeSet<String>,
    pub unsupported: BTreeSet<String>,
}

pub fn inspect_semantic_dependencies(
    source: Node,
    checker: &mut Checker,
    inputs: &QualifiedInputs,
) -> QualifiedScan {
    let mut scan = Scan {
        checker,
        inputs,
        source,
        result: QualifiedScan::default(),
        callback_cache: BTreeMap::new(),
    };
    if source.is_nil() {
        scan.reason("SOURCE_SEMANTIC_SOURCE_UNAVAILABLE");
        return scan.result;
    }
    if !ast::source_file_info(source).referenced_files.is_empty() {
        scan.reason("SOURCE_REFERENCE_PATH_UNSUPPORTED");
    }
    if scan.inspect_syntax(source) {
        if !crate::ordinary::export_ambiguities(source, scan.checker).is_empty() {
            scan.reason("SOURCE_EXPORT_AMBIGUOUS");
        }
        scan.inspect_exports();
        scan.visit(source);
    }
    scan.result
}

struct Scan<'a> {
    checker: &'a mut Checker,
    inputs: &'a QualifiedInputs,
    source: Node,
    result: QualifiedScan,
    callback_cache: BTreeMap<QualifiedSpan, bool>,
}

fn unwrap(mut node: Node) -> Node {
    while node.is_some()
        && matches!(
            node.kind(),
            K::ParenthesizedExpression
                | K::AsExpression
                | K::TypeAssertionExpression
                | K::NonNullExpression
                | K::SatisfiesExpression
        )
    {
        node = node.expression();
    }
    node
}

fn member(node: Node) -> bool {
    node.is_some()
        && matches!(
            node.kind(),
            K::PropertyAccessExpression | K::ElementAccessExpression
        )
}

fn named_value(node: Node) -> bool {
    node.is_some() && (node.kind() == K::Identifier || member(node))
}

fn is_const(node: Node) -> bool {
    node.is_some()
        && ast::is_variable_declaration(node)
        && node.parent().is_some()
        && ast::is_variable_declaration_list(node.parent())
        && node.parent().flags().intersects(NodeFlags::CONST)
}

fn is_async(node: Node) -> bool {
    node.modifier_flags().intersects(ModifierFlags::ASYNC)
}

fn ancestor(mut node: Node, mut predicate: impl FnMut(Node) -> bool) -> bool {
    while node.is_some() {
        if predicate(node) {
            return true;
        }
        node = node.parent();
    }
    false
}

fn async_owner(node: Node) -> bool {
    let mut owner = node.parent();
    while owner.is_some() {
        if ast::is_function_like(owner) {
            return is_async(owner);
        }
        owner = owner.parent();
    }
    false
}

fn assignment(node: Node) -> bool {
    ast::is_binary_expression(node) && ast::is_assignment_operator(node.operator_token().kind())
}

fn numeric_unary(node: Node) -> bool {
    matches!(
        node.kind(),
        K::PrefixUnaryExpression | K::PostfixUnaryExpression
    ) && matches!(
        node.operator(),
        K::PlusToken | K::MinusToken | K::TildeToken | K::PlusPlusToken | K::MinusMinusToken
    )
}

fn coercing_binary(node: Node) -> bool {
    ast::is_binary_expression(node)
        && matches!(
            node.operator_token().kind(),
            K::PlusToken
                | K::MinusToken
                | K::AsteriskToken
                | K::SlashToken
                | K::PercentToken
                | K::AsteriskAsteriskToken
                | K::LessThanLessThanToken
                | K::GreaterThanGreaterThanToken
                | K::GreaterThanGreaterThanGreaterThanToken
                | K::AmpersandToken
                | K::BarToken
                | K::CaretToken
                | K::LessThanToken
                | K::LessThanEqualsToken
                | K::GreaterThanToken
                | K::GreaterThanEqualsToken
                | K::EqualsEqualsToken
                | K::ExclamationEqualsToken
                | K::PlusEqualsToken
                | K::MinusEqualsToken
                | K::AsteriskEqualsToken
                | K::SlashEqualsToken
                | K::PercentEqualsToken
                | K::AsteriskAsteriskEqualsToken
                | K::LessThanLessThanEqualsToken
                | K::GreaterThanGreaterThanEqualsToken
                | K::GreaterThanGreaterThanGreaterThanEqualsToken
                | K::AmpersandEqualsToken
                | K::BarEqualsToken
                | K::CaretEqualsToken
        )
}

fn primitive_flags() -> TypeFlags {
    TypeFlags::STRING_LIKE
        | TypeFlags::NUMBER_LIKE
        | TypeFlags::BIG_INT_LIKE
        | TypeFlags::BOOLEAN_LIKE
        | TypeFlags::ES_SYMBOL_LIKE
        | TypeFlags::NULL
        | TypeFlags::UNDEFINED
}

pub fn is_ordinary_native_process_member(name: &str) -> bool {
    matches!(
        name,
        "argv"
            | "cwd"
            | "env"
            | "execPath"
            | "exit"
            | "exitCode"
            | "platform"
            | "stderr"
            | "stdout"
            | "versions"
    )
}

impl Scan<'_> {
    fn reason(&mut self, reason: &str) {
        self.result.reasons.insert(reason.into());
    }
    fn unsupported(&mut self, feature: &str) {
        self.result.unsupported.insert(feature.into());
    }
    fn canonical_path(&self, path: &str) -> String {
        let path = path.replace('\\', "/");
        if self.inputs.case_sensitive {
            path
        } else {
            path.to_lowercase()
        }
    }
    fn span(&self, node: Node) -> QualifiedSpan {
        let file = ast::get_source_file_of_node(node);
        let map = ast::source_file_get_position_map(file);
        QualifiedSpan {
            path: self.canonical_path(ast::source_file_file_name(file)),
            start_utf16: map.utf8_to_utf16(astnav::get_start_of_node(node, file, false)),
            end_utf16: map.utf8_to_utf16(node.end()),
        }
    }
    fn sdk(&self, node: Node) -> bool {
        node.is_some()
            && program::is_source_file_default_library(ast::source_file_file_name(
                ast::get_source_file_of_node(node),
            ))
    }
    fn internal(&self, node: Node) -> bool {
        node.is_some()
            && !self.sdk(node)
            && self.inputs.retained_paths.contains(&self.canonical_path(
                ast::source_file_file_name(ast::get_source_file_of_node(node)),
            ))
    }
    fn symbol(&mut self, node: Node) -> SymbolId {
        let symbol = self.checker.get_symbol_at_location_exported(unwrap(node));
        if symbol.is_some()
            && self
                .checker
                .sym(symbol)
                .flags
                .intersects(SymbolFlags::ALIAS)
        {
            self.checker.get_aliased_symbol(symbol)
        } else {
            symbol
        }
    }
    fn raw_origins(&mut self, node: Node) -> Vec<Node> {
        let symbol = self.checker.get_symbol_at_location_exported(unwrap(node));
        self.symbol_origins(symbol)
    }
    fn symbol_origins(&self, symbol: SymbolId) -> Vec<Node> {
        if symbol.is_nil() {
            Vec::new()
        } else {
            self.checker.sym(symbol).declarations.to_vec()
        }
    }
    fn origins(&mut self, node: Node) -> Vec<Node> {
        let symbol = self.symbol(node);
        self.symbol_origins(symbol)
    }
    fn symbol_name(&self, symbol: SymbolId) -> String {
        if symbol.is_nil() {
            String::new()
        } else {
            self.checker.sym(symbol).name.to_string()
        }
    }
    fn property(&mut self, receiver: Node, name: &str) -> SymbolId {
        let ty = self.checker.get_type_at_location(receiver);
        self.checker.get_property_of_type_exported(ty, name)
    }
    fn signatures(&mut self, ty: TypeId) -> Vec<SignatureId> {
        let mut signatures = self
            .checker
            .get_signatures_of_type_exported(ty, SignatureKind::CALL);
        signatures.extend(
            self.checker
                .get_signatures_of_type_exported(ty, SignatureKind::CONSTRUCT),
        );
        signatures
    }
    fn parts(&self, ty: TypeId) -> Vec<TypeId> {
        if self
            .checker
            .ty(ty)
            .flags
            .intersects(TypeFlags::UNION_OR_INTERSECTION)
        {
            self.checker.ty(ty).types().to_vec()
        } else {
            Vec::new()
        }
    }
    fn potential_callable(&mut self, ty: TypeId) -> bool {
        if self
            .checker
            .ty(ty)
            .flags
            .intersects(TypeFlags::ANY | TypeFlags::UNKNOWN | TypeFlags::TYPE_PARAMETER)
        {
            return true;
        }
        let parts = self.parts(ty);
        if !parts.is_empty() {
            return parts.into_iter().any(|part| self.potential_callable(part));
        }
        !self.signatures(ty).is_empty()
    }
    fn destructured_origin(&mut self, node: Node, seen: &mut HashSet<Node>) -> bool {
        if !seen.insert(node) {
            return false;
        }
        if ast::is_binding_element(node) {
            return true;
        }
        if !ast::is_variable_declaration(node) || node.initializer().is_nil() {
            return false;
        }
        let init = unwrap(node.initializer());
        init.kind() == K::Identifier
            && self
                .origins(init)
                .into_iter()
                .any(|origin| self.destructured_origin(origin, seen))
    }
    fn inspect_exports(&mut self) {
        let symbol = self.checker.get_symbol_at_location_exported(self.source);
        if symbol.is_nil() {
            return;
        }
        for mut exported in self.checker.get_exports_of_module_exported(symbol) {
            if self
                .checker
                .sym(exported)
                .flags
                .intersects(SymbolFlags::ALIAS)
            {
                exported = self.checker.get_aliased_symbol(exported);
            }
            let origins = self.symbol_origins(exported);
            let site = origins.first().copied().unwrap_or(self.source);
            let ty = self.checker.get_type_of_symbol_at_location(exported, site);
            if origins.iter().any(|origin| {
                self.internal(*origin) && self.destructured_origin(*origin, &mut HashSet::new())
            }) && self.potential_callable(ty)
            {
                self.reason("SOURCE_DESTRUCTURED_CALLABLE_EXPORT_UNSUPPORTED");
            }
            if origins.iter().any(|origin| {
                self.internal(*origin)
                    && ast::is_variable_declaration(*origin)
                    && (origin.initializer().is_nil()
                        || !matches!(
                            origin.initializer().kind(),
                            K::ArrowFunction | K::FunctionExpression
                        ))
            }) && self.potential_callable(ty)
            {
                self.reason("SOURCE_CALLABLE_EXPORT_UNSUPPORTED");
            }
        }
    }
    fn actual(&mut self, node: Node) -> Node {
        self.actual_seen(node, &mut HashSet::new())
    }
    fn actual_seen(&mut self, node: Node, seen: &mut HashSet<Node>) -> Node {
        let value = unwrap(node);
        if !seen.insert(value) {
            return value;
        }
        for origin in self.origins(value) {
            if is_const(origin) && origin.initializer().is_some() {
                return self.actual_seen(origin.initializer(), seen);
            }
        }
        value
    }
    fn constant_string(&mut self, node: Node) -> Option<String> {
        self.constant_string_seen(node, &mut HashSet::new())
    }
    fn constant_string_seen(&mut self, node: Node, seen: &mut HashSet<Node>) -> Option<String> {
        let value = unwrap(node);
        if !seen.insert(value) {
            return None;
        }
        if ast::is_string_literal_like(value) {
            return Some(value.text().to_string());
        }
        for origin in self.origins(value) {
            if is_const(origin) && origin.initializer().is_some() {
                let name = self.constant_string_seen(origin.initializer(), seen);
                if name.is_some() {
                    return name;
                }
            }
        }
        None
    }
    fn static_name(&mut self, node: Node) -> Option<String> {
        if ast::is_property_access_expression(node) {
            return Some(node.name().text().into());
        }
        if ast::is_element_access_expression(node) {
            return self.constant_string(node.argument_expression());
        }
        None
    }
    fn property_name(&mut self, node: Node) -> Option<String> {
        if node.is_nil() {
            return None;
        }
        if ast::is_computed_property_name(node) {
            return self.constant_string(node.expression());
        }
        matches!(
            node.kind(),
            K::Identifier | K::StringLiteral | K::NoSubstitutionTemplateLiteral | K::NumericLiteral
        )
        .then(|| node.text().to_string())
    }
    fn sdk_value(&mut self, node: Node) -> SymbolId {
        self.sdk_value_seen(node, &mut HashSet::new())
    }
    fn sdk_value_seen(&mut self, node: Node, seen: &mut HashSet<Node>) -> SymbolId {
        let value = unwrap(node);
        if !named_value(value) || !seen.insert(value) {
            return SymbolId::NIL;
        }
        let origins = self.origins(value);
        if !origins.is_empty() && origins.iter().all(|origin| self.sdk(*origin)) {
            return self.symbol(value);
        }
        for origin in origins.iter().copied() {
            if is_const(origin) && origin.initializer().is_some() {
                let symbol = self.sdk_value_seen(origin.initializer(), seen);
                if symbol.is_some() {
                    return symbol;
                }
            }
        }
        for origin in origins {
            if !ast::is_binding_element(origin) || !ast::is_object_binding_pattern(origin.parent())
            {
                continue;
            }
            let declaration = origin.parent().parent();
            if !is_const(declaration)
                || declaration.initializer().is_nil()
                || self
                    .sdk_value_seen(declaration.initializer(), seen)
                    .is_nil()
            {
                continue;
            }
            let member = origin.property_name_or_name();
            if !matches!(member.kind(), K::Identifier | K::StringLiteral) {
                continue;
            }
            let property = self.property(declaration.initializer(), member.text());
            let declarations = self.symbol_origins(property);
            if !declarations.is_empty() && declarations.iter().all(|origin| self.sdk(*origin)) {
                return property;
            }
        }
        SymbolId::NIL
    }
    fn primitive(&mut self, node: Node) -> bool {
        self.primitive_seen(node, &mut HashSet::new())
    }
    fn primitive_seen(&mut self, node: Node, seen: &mut HashSet<Node>) -> bool {
        let value = unwrap(node);
        if value.is_nil() || !seen.insert(value) {
            return false;
        }
        if matches!(
            value.kind(),
            K::NumericLiteral
                | K::BigIntLiteral
                | K::StringLiteral
                | K::NoSubstitutionTemplateLiteral
                | K::VoidExpression
                | K::NullKeyword
                | K::TrueKeyword
                | K::FalseKeyword
                | K::TypeOfExpression
        ) {
            return true;
        }
        if value.kind() == K::Identifier
            && value.text() == "undefined"
            && self.origins(value).is_empty()
        {
            let ty = self.checker.get_type_at_location(value);
            if self.checker.ty(ty).flags.intersects(TypeFlags::UNDEFINED) {
                return true;
            }
        }
        if value.kind() == K::TemplateExpression {
            return value
                .template_spans()
                .nodes()
                .to_vec()
                .iter()
                .all(|span| self.primitive_seen(span.expression(), &mut seen.clone()));
        }
        if ast::is_binary_expression(value) && value.operator_token().kind() == K::PlusToken {
            return self.primitive_seen(value.left(), &mut seen.clone())
                && self.primitive_seen(value.right(), &mut seen.clone());
        }
        if value.kind() == K::PrefixUnaryExpression {
            return value.operator() == K::ExclamationToken
                || self.primitive_seen(value.operand(), &mut seen.clone());
        }
        self.origins(value).into_iter().any(|origin| {
            is_const(origin)
                && origin.initializer().is_some()
                && self.primitive_seen(origin.initializer(), &mut seen.clone())
        })
    }
    fn property_key(&mut self, node: Node) -> bool {
        self.property_key_seen(node, &mut HashSet::new())
    }
    fn property_key_seen(&mut self, node: Node, seen: &mut HashSet<Node>) -> bool {
        let value = unwrap(node);
        if !seen.insert(value) {
            return false;
        }
        if self.primitive(value) {
            return true;
        }
        if member(value) {
            let receiver = self.sdk_value(value.expression());
            if self.symbol_name(receiver) == "Symbol" && self.sdk_value(value).is_some() {
                let ty = self.checker.get_type_at_location(value);
                if self
                    .checker
                    .ty(ty)
                    .flags
                    .intersects(TypeFlags::ES_SYMBOL_LIKE)
                {
                    return true;
                }
            }
        }
        self.origins(value).into_iter().any(|origin| {
            is_const(origin)
                && origin.initializer().is_some()
                && self.property_key_seen(origin.initializer(), seen)
        })
    }
    fn protocol_key(&mut self, node: Node, iterator_only: bool) -> bool {
        self.protocol_key_seen(node, iterator_only, &mut HashSet::new())
    }
    fn protocol_key_seen(
        &mut self,
        node: Node,
        iterator_only: bool,
        seen: &mut HashSet<Node>,
    ) -> bool {
        let value = unwrap(node);
        if !seen.insert(value) {
            return false;
        }
        let names: &[&str] = if iterator_only {
            &["iterator", "asyncIterator"]
        } else {
            &[
                "iterator",
                "asyncIterator",
                "hasInstance",
                "toPrimitive",
                "match",
                "matchAll",
                "replace",
                "search",
                "split",
                "species",
            ]
        };
        if member(value) {
            let receiver = self.sdk_value(value.expression());
            if self.symbol_name(receiver) == "Symbol" {
                let symbol = self.sdk_value(value);
                return names.contains(&self.symbol_name(symbol).as_str());
            }
        }
        self.origins(value).into_iter().any(|origin| {
            if is_const(origin) && origin.initializer().is_some() {
                return self.protocol_key_seen(origin.initializer(), iterator_only, seen);
            }
            if ast::is_binding_element(origin) && ast::is_object_binding_pattern(origin.parent()) {
                let declaration = origin.parent().parent();
                if is_const(declaration) && declaration.initializer().is_some() {
                    let receiver = self.sdk_value(declaration.initializer());
                    let symbol = self.sdk_value(value);
                    return self.symbol_name(receiver) == "Symbol"
                        && names.contains(&self.symbol_name(symbol).as_str());
                }
            }
            false
        })
    }
    fn sdk_construction(&mut self, symbol: SymbolId) -> bool {
        let origins = self.symbol_origins(symbol);
        let Some(site) = origins.first() else {
            return false;
        };
        let ty = self.checker.get_type_of_symbol_at_location(symbol, *site);
        self.checker
            .get_signatures_of_type_exported(ty, SignatureKind::CONSTRUCT)
            .into_iter()
            .any(|sig| self.sdk(self.checker.sig(sig).declaration))
    }
    fn sdk_runtime(&mut self, node: Node) -> bool {
        self.sdk_runtime_seen(node, &mut HashSet::new())
    }
    fn sdk_runtime_seen(&mut self, node: Node, seen: &mut HashSet<Node>) -> bool {
        let value = self.actual(node);
        if !seen.insert(value) {
            return false;
        }
        if member(value) {
            return self.sdk_runtime_seen(value.expression(), seen)
                && self.sdk_value(value).is_some();
        }
        let origins = self.origins(value);
        if !origins.is_empty() && origins.iter().all(|origin| self.sdk(*origin)) {
            return true;
        }
        if value.kind() == K::Identifier
            && value.text() == "globalThis"
            && origins.is_empty()
            && self
                .checker
                .get_symbol_at_location_exported(value)
                .is_some()
        {
            return true;
        }
        self.sdk_value(value).is_some()
            && origins.into_iter().any(|origin| {
                if !ast::is_binding_element(origin)
                    || !ast::is_object_binding_pattern(origin.parent())
                {
                    return false;
                }
                let declaration = origin.parent().parent();
                is_const(declaration)
                    && declaration.initializer().is_some()
                    && self.sdk_runtime_seen(declaration.initializer(), seen)
            })
    }
    fn sdk_constructor(&mut self, node: Node) -> SymbolId {
        let symbol = self.sdk_value(node);
        if self.sdk_construction(symbol) && self.sdk_runtime(node) {
            symbol
        } else {
            SymbolId::NIL
        }
    }
    fn intrinsic_date_copy(&mut self, node: Node) -> bool {
        if node.kind() != K::NewExpression || node.arguments().to_vec().len() != 1 {
            return false;
        }
        let constructor = self.sdk_constructor(node.expression());
        if self.symbol_name(constructor) != "Date" {
            return false;
        }
        let value = self.actual(node.arguments().to_vec()[0]);
        if value.kind() != K::NewExpression {
            return false;
        }
        let constructor = self.sdk_constructor(value.expression());
        self.symbol_name(constructor) == "Date"
    }
    fn sdk_origin(&mut self, node: Node) -> bool {
        self.sdk_origin_seen(node, &mut HashSet::new())
    }
    fn sdk_origin_seen(&mut self, node: Node, seen: &mut HashSet<Node>) -> bool {
        let value = self.actual(node);
        if value.is_nil() || !seen.insert(value) {
            return false;
        }
        if ast::is_array_literal_expression(value) || ast::is_string_literal_like(value) {
            return true;
        }
        if value.kind() == K::NewExpression {
            return self.sdk_constructor(value.expression()).is_some();
        }
        if member(value) {
            return self.sdk_origin_seen(value.expression(), seen)
                && self.sdk_value(value).is_some();
        }
        let origins = self.origins(value);
        (!origins.is_empty() && origins.iter().all(|origin| self.sdk(*origin)))
            || (value.kind() == K::Identifier
                && value.text() == "globalThis"
                && origins.is_empty()
                && self
                    .checker
                    .get_symbol_at_location_exported(value)
                    .is_some())
    }
    fn callable_type(&mut self, node: Node) -> TypeId {
        let value = self.actual(node);
        if member(value) {
            let receiver = self.actual(value.expression());
            if let Some(name) = self.static_name(value) {
                let symbol = self.property(receiver, &name);
                if symbol.is_some() {
                    return self
                        .checker
                        .get_type_of_symbol_at_location(symbol, receiver);
                }
            }
        }
        self.checker.get_type_at_location(value)
    }
    fn callback_type(&mut self, ty: TypeId) -> bool {
        if !self.signatures(ty).is_empty() {
            return true;
        }
        if self
            .parts(ty)
            .into_iter()
            .any(|part| self.callback_type(part))
        {
            return true;
        }
        let symbol = self.checker.ty(ty).symbol;
        self.symbol_name(symbol) == "Function"
            && self
                .symbol_origins(symbol)
                .iter()
                .all(|origin| self.sdk(*origin))
    }
    fn iterable_type(&mut self, ty: TypeId, seen: &mut HashSet<TypeId>) -> bool {
        if !seen.insert(ty) || self.checker.ty(ty).flags.intersects(primitive_flags()) {
            return false;
        }
        let parts = self.parts(ty);
        if !parts.is_empty() {
            return parts
                .into_iter()
                .any(|part| self.iterable_type(part, &mut seen.clone()));
        }
        let constraint = self.checker.get_base_constraint_of_type_exported(ty);
        if constraint.is_some()
            && constraint != ty
            && self.iterable_type(constraint, &mut seen.clone())
        {
            return true;
        }
        self.checker
            .get_properties_of_type_exported(ty)
            .into_iter()
            .any(|property| {
                self.symbol_origins(property)
                    .into_iter()
                    .any(|declaration| {
                        self.sdk(declaration)
                            && (ast::is_method_signature_declaration(declaration)
                                || ast::is_property_signature_declaration(declaration))
                            && ast::is_computed_property_name(declaration.name())
                            && self.protocol_key(declaration.name().expression(), true)
                    })
            })
    }
    fn iterable_parameter(&mut self, parameter: SymbolId, declaration: Node) -> bool {
        if self.symbol_origins(parameter).iter().any(|origin| {
            ast::is_parameter_declaration(*origin) && origin.dot_dot_dot_token().is_some()
        }) {
            return false;
        }
        let ty = self
            .checker
            .get_type_of_symbol_at_location(parameter, declaration);
        self.iterable_type(ty, &mut HashSet::new())
    }
    fn sdk_callback_dictionary(&mut self, ty: TypeId, declaration: Node) -> bool {
        let parts = self.parts(ty);
        if !parts.is_empty() {
            return parts
                .into_iter()
                .any(|part| self.sdk_callback_dictionary(part, declaration));
        }
        if !self.checker.ty(ty).flags.intersects(TypeFlags::OBJECT) || self.callback_type(ty) {
            return false;
        }
        self.checker
            .get_properties_of_type_exported(ty)
            .into_iter()
            .any(|member| {
                let origins = self.symbol_origins(member);
                if origins.is_empty()
                    || !origins.into_iter().all(|origin| {
                        ast::is_property_signature_declaration(origin) && self.sdk(origin)
                    })
                {
                    return false;
                }
                let member_type = self
                    .checker
                    .get_type_of_symbol_at_location(member, declaration);
                self.callback_type(member_type)
            })
    }
    fn sdk_callback_signature(&mut self, ty: TypeId) -> bool {
        self.signatures(ty).into_iter().any(|sig| {
            let declaration = self.checker.sig(sig).declaration;
            let parameters = self.checker.sig(sig).parameters.clone();
            self.sdk(declaration)
                && parameters.into_iter().any(|parameter| {
                    let ty = self
                        .checker
                        .get_type_of_symbol_at_location(parameter, declaration);
                    self.callback_type(ty)
                })
        })
    }
    fn declared_on(&self, symbol: SymbolId, owners: &[&str]) -> bool {
        self.symbol_origins(symbol).into_iter().any(|origin| {
            self.sdk(origin)
                && ast::is_interface_declaration(origin.parent())
                && owners.contains(&origin.parent().name().text())
        })
    }
    #[expect(
        clippy::excessive_nesting,
        reason = "The native SDK and AST traversal retains its explicit semantic branches in this feasibility port."
    )]
    fn inspect_sdk_callbacks(&mut self, node: Node) {
        let callee = self.actual(node.expression());
        if member(callee)
            && self
                .static_name(callee)
                .is_some_and(|name| ["call", "apply", "bind"].contains(&name.as_str()))
        {
            let receiver = self.actual(callee.expression());
            let name = self.static_name(callee).unwrap();
            let ty = self.callable_type(receiver);
            let helper = self.checker.get_property_of_type_exported(ty, &name);
            if self.declared_on(helper, &["Function", "CallableFunction", "NewableFunction"]) {
                if self.sdk_callback_signature(ty) {
                    self.reason("SOURCE_SDK_CALLBACK_UNSUPPORTED");
                }
                for sig in self.signatures(ty) {
                    let declaration = self.checker.sig(sig).declaration;
                    let parameters = self.checker.sig(sig).parameters.clone();
                    if self.sdk(declaration)
                        && parameters
                            .into_iter()
                            .any(|parameter| self.iterable_parameter(parameter, declaration))
                    {
                        self.reason("SOURCE_SDK_ITERATION_UNSUPPORTED");
                    }
                }
            }
        }
        let ty = self.callable_type(callee);
        let kind = if node.kind() == K::NewExpression {
            SignatureKind::CONSTRUCT
        } else {
            SignatureKind::CALL
        };
        for sig in self.checker.get_signatures_of_type_exported(ty, kind) {
            let declaration = self.checker.sig(sig).declaration;
            if !self.sdk(declaration) {
                continue;
            }
            for (index, parameter) in self
                .checker
                .sig(sig)
                .parameters
                .clone()
                .into_iter()
                .enumerate()
            {
                let Some(argument) = node.arguments().to_vec().get(index).copied() else {
                    continue;
                };
                let parameter_type = self
                    .checker
                    .get_type_of_symbol_at_location(parameter, declaration);
                if self.sdk_origin(callee)
                    && self.sdk_callback_dictionary(parameter_type, declaration)
                    && !(index == 0 && self.intrinsic_date_copy(node))
                    && !self.literal_data(argument)
                {
                    self.reason("SOURCE_SDK_CALLBACK_UNSUPPORTED");
                }
                if self.iterable_parameter(parameter, declaration)
                    && !self.intrinsic_iterable(argument)
                {
                    self.reason("SOURCE_SDK_ITERATION_UNSUPPORTED");
                }
                let actual_argument = self.actual(argument);
                let callable_argument = self.callable_type(argument);
                if self.callback_type(parameter_type)
                    && (!self.sdk_origin(callee)
                        || !(self.primitive(actual_argument)
                            || self.sdk_origin(argument) && self.callback_type(callable_argument)))
                {
                    self.reason("SOURCE_SDK_CALLBACK_UNSUPPORTED");
                }
            }
        }
    }
    fn sdk_callable_member(&mut self, receiver: Node, name: Option<&str>) -> bool {
        let Some(name) = name else {
            return false;
        };
        let receiver = unwrap(receiver);
        let symbol = self.property(receiver, name);
        let origins = self.symbol_origins(symbol);
        if origins.is_empty() || !origins.iter().all(|origin| self.sdk(*origin)) {
            return false;
        }
        let ty = self
            .checker
            .get_type_of_symbol_at_location(symbol, receiver);
        !self.signatures(ty).is_empty()
    }
    fn sdk_callable_property(&mut self, node: Node) -> bool {
        let value = unwrap(node);
        if !member(value) {
            return false;
        }
        let name = self.static_name(value);
        self.sdk_callable_member(value.expression(), name.as_deref())
    }
    fn literal_data(&mut self, node: Node) -> bool {
        let value = unwrap(node);
        if self.primitive(value) {
            return true;
        }
        if ast::is_array_literal_expression(value) {
            return value.elements().to_vec().iter().all(|item| {
                ast::is_expression(*item)
                    && !ast::is_spread_element(*item)
                    && self.literal_data(*item)
            });
        }
        if !ast::is_object_literal_expression(value) {
            return false;
        }
        value.properties().to_vec().iter().all(|property| {
            if ast::is_shorthand_property_assignment(*property) {
                return property.object_assignment_initializer().is_nil()
                    && self.primitive(property.name());
            }
            if !ast::is_property_assignment(*property) {
                return false;
            }
            let name = property.name();
            matches!(
                name.kind(),
                K::Identifier
                    | K::StringLiteral
                    | K::NoSubstitutionTemplateLiteral
                    | K::NumericLiteral
            ) && name.text() != "__proto__"
                && self.literal_data(property.initializer())
        })
    }
    fn intrinsic_iterable(&mut self, node: Node) -> bool {
        let value = self.actual(node);
        if ast::is_array_literal_expression(value)
            || ast::is_string_literal_like(value)
            || value.kind() == K::TemplateExpression
        {
            return true;
        }
        if value.kind() != K::NewExpression {
            return false;
        }
        let symbol = self.sdk_constructor(value.expression());
        ["Array", "Map", "Set"].contains(&self.symbol_name(symbol).as_str())
    }
    fn binding_value(&mut self, pattern: Node) -> Node {
        let parent = pattern.parent();
        if ast::is_variable_declaration(parent) {
            return parent.initializer();
        }
        if !ast::is_binding_element(parent)
            || !ast::is_array_binding_pattern(parent.parent())
            || parent.dot_dot_dot_token().is_some()
        {
            return Node::NIL;
        }
        let outer = self.binding_value(parent.parent());
        if outer.is_nil() {
            return Node::NIL;
        }
        let array = self.actual(outer);
        if !ast::is_array_literal_expression(array) {
            return Node::NIL;
        }
        let Some(index) = parent
            .parent()
            .elements()
            .to_vec()
            .iter()
            .position(|item| *item == parent)
        else {
            return Node::NIL;
        };
        if array
            .elements()
            .to_vec()
            .iter()
            .take(index + 1)
            .any(|item| ast::is_spread_element(*item))
        {
            return Node::NIL;
        }
        array
            .elements()
            .to_vec()
            .get(index)
            .copied()
            .filter(|item| !ast::is_omitted_expression(*item))
            .unwrap_or(Node::NIL)
    }
    fn binding_written(&mut self, symbol: SymbolId, source: Node) -> bool {
        if symbol.is_nil() {
            return false;
        }
        if assignment(source) && self.binding_contains(source.left(), symbol) {
            return true;
        }
        if (ast::is_for_of_statement(source) || ast::is_for_in_statement(source))
            && !ast::is_variable_declaration_list(source.initializer())
            && self.binding_contains(source.initializer(), symbol)
        {
            return true;
        }
        if matches!(
            source.kind(),
            K::PrefixUnaryExpression | K::PostfixUnaryExpression
        ) && matches!(source.operator(), K::PlusPlusToken | K::MinusMinusToken)
            && self
                .checker
                .get_symbol_at_location_exported(unwrap(source.operand()))
                == symbol
        {
            return true;
        }
        source
            .iter_children()
            .any(|child| self.binding_written(symbol, child))
    }
    fn binding_contains(&mut self, node: Node, symbol: SymbolId) -> bool {
        if node.is_nil() {
            return false;
        }
        let value = unwrap(node);
        if ast::is_identifier(value) {
            return self.checker.get_symbol_at_location_exported(value) == symbol;
        }
        if ast::is_shorthand_property_assignment(value) {
            return self.checker.get_shorthand_assignment_value_symbol(value) == symbol;
        }
        if ast::is_binary_expression(value) && value.operator_token().kind() == K::EqualsToken {
            return self.binding_contains(value.left(), symbol);
        }
        if member(value) {
            return false;
        }
        value
            .iter_children()
            .any(|child| self.binding_contains(child, symbol))
    }
    fn async_value(&mut self, node: Node, seen: &mut HashSet<Node>) -> bool {
        let value = unwrap(node);
        if !seen.insert(value) {
            return false;
        }
        if matches!(value.kind(), K::ArrowFunction | K::FunctionExpression) {
            return is_async(value);
        }
        let symbol = self.symbol(value);
        let origins = self.symbol_origins(symbol);
        if origins
            .iter()
            .any(|origin| self.binding_written(symbol, ast::get_source_file_of_node(*origin)))
        {
            return false;
        }
        origins.into_iter().any(|origin| {
            (matches!(origin.kind(), K::FunctionDeclaration | K::MethodDeclaration)
                && is_async(origin))
                || (is_const(origin)
                    && origin.initializer().is_some()
                    && self.async_value(origin.initializer(), seen))
        })
    }
    fn safe_await(&mut self, node: Node) -> bool {
        self.safe_await_seen(node, &mut HashSet::new())
    }
    #[expect(
        clippy::excessive_nesting,
        reason = "The native SDK and AST traversal retains its explicit semantic branches in this feasibility port."
    )]
    fn safe_await_seen(&mut self, node: Node, seen: &mut HashSet<Node>) -> bool {
        let value = unwrap(node);
        if value.is_nil() || !seen.insert(value) {
            return false;
        }
        if value.kind() == K::AwaitExpression {
            return self.safe_await_seen(value.expression(), seen);
        }
        if self.primitive(value) {
            return true;
        }
        if value.kind() == K::NewExpression {
            let symbol = self.sdk_constructor(value.expression());
            if self.symbol_name(symbol) == "Promise" {
                return true;
            }
        }
        if value.kind() == K::CallExpression {
            if value.expression().kind() == K::ImportKeyword
                && value.arguments().to_vec().len() == 1
                && ast::is_string_literal_like(value.arguments().to_vec()[0])
            {
                return true;
            }
            if self.async_value(value.expression(), &mut HashSet::new()) {
                return true;
            }
            let callee = self.actual(value.expression());
            if member(callee) {
                let receiver = self.sdk_value(callee.expression());
                if self.symbol_name(receiver) == "Promise" {
                    let name = self.static_name(callee);
                    if name.as_deref() == Some("reject") {
                        return true;
                    }
                    if name.as_deref() == Some("resolve") {
                        return value
                            .arguments()
                            .to_vec()
                            .first()
                            .is_none_or(|argument| self.safe_await_seen(*argument, seen));
                    }
                }
            }
        }
        self.origins(value).into_iter().any(|origin| {
            is_const(origin)
                && origin.initializer().is_some()
                && self.safe_await_seen(origin.initializer(), seen)
        })
    }
    fn internal_callable(&mut self, node: Node, seen: &mut HashSet<Node>) -> bool {
        let value = unwrap(node);
        if !seen.insert(value) {
            return false;
        }
        let ty = self.checker.get_type_at_location(value);
        if self
            .signatures(ty)
            .into_iter()
            .any(|sig| self.internal(self.checker.sig(sig).declaration))
        {
            return true;
        }
        self.origins(value).into_iter().any(|origin| {
            ast::is_variable_declaration(origin)
                && origin.initializer().is_some()
                && self.internal_callable(origin.initializer(), seen)
        })
    }
    fn function_helper(&mut self, node: Node) -> bool {
        if !["call", "apply", "bind"].contains(&node.name().text()) {
            return false;
        }
        let receiver = unwrap(node.expression());
        let mut symbol = self.checker.get_symbol_at_location_exported(node);
        if symbol.is_nil() {
            symbol = self.property(receiver, node.name().text());
        }
        self.declared_on(symbol, &["Function", "CallableFunction", "NewableFunction"])
            && ["call", "apply", "bind"].contains(&self.symbol_name(symbol).as_str())
            && self.internal_callable(receiver, &mut HashSet::new())
    }
    fn intrinsic_constructor(&mut self, node: Node) -> bool {
        let name = if ast::is_property_access_expression(node) {
            Some(node.name().text())
        } else if ast::is_element_access_expression(node)
            && ast::is_string_literal(node.argument_expression())
        {
            Some(node.argument_expression().text())
        } else {
            None
        };
        if name != Some("constructor") {
            return false;
        }
        let receiver = unwrap(node.expression());
        let ty = self.checker.get_type_at_location(receiver);
        if self.signatures(ty).is_empty() {
            return false;
        }
        let mut symbol = self.checker.get_symbol_at_location_exported(node);
        if symbol.is_nil() {
            symbol = self
                .checker
                .get_property_of_type_exported(ty, "constructor");
        }
        self.symbol_name(symbol) == "constructor" && self.declared_on(symbol, &["Object"])
    }
    fn skip_binding(&self, node: Node) -> bool {
        if !ast::is_identifier(node) {
            return false;
        }
        let parent = node.parent();
        (ast::is_property_access_expression(parent) && parent.name() == node)
            || (ast::is_variable_declaration(parent) && parent.name() == node)
            || ast::is_binding_element(parent)
    }
    fn usage(&self, mut node: Node) -> Node {
        while node.parent().is_some()
            && matches!(
                node.parent().kind(),
                K::ParenthesizedExpression
                    | K::AsExpression
                    | K::TypeAssertionExpression
                    | K::NonNullExpression
                    | K::SatisfiesExpression
            )
        {
            node = node.parent();
        }
        node
    }
    fn alias_usage(&self, node: Node) -> bool {
        let parent = node.parent();
        is_const(parent) && parent.initializer() == node && ast::is_identifier(parent.name())
    }
    fn sdk_meta_operation(&mut self, node: Node, names: &[&str], owners: &[&str]) -> bool {
        let value = self.actual(node);
        if member(value)
            && self
                .static_name(value)
                .is_some_and(|name| names.contains(&name.as_str()))
        {
            let receiver = self.actual(value.expression());
            let symbol = self.sdk_value(receiver);
            if owners.contains(&self.symbol_name(symbol).as_str()) {
                return true;
            }
        }
        let symbol = self.sdk_value(value);
        if !names.contains(&self.symbol_name(symbol).as_str()) {
            return false;
        }
        self.symbol_origins(symbol).into_iter().any(|origin| {
            if !self.sdk(origin) {
                return false;
            }
            let parent = origin.parent();
            (ast::is_interface_declaration(parent)
                && owners
                    .iter()
                    .any(|owner| parent.name().text() == format!("{owner}Constructor")))
                || (ast::is_module_block(parent)
                    && ast::is_module_declaration(parent.parent())
                    && owners.contains(&parent.parent().name().text()))
        })
    }
    fn sdk_member_of(&mut self, node: Node, owner: &str, name: &str) -> bool {
        let value = self.actual(node);
        let symbol = self.sdk_value(value);
        self.symbol_name(symbol) == name
            && self.symbol_origins(symbol).into_iter().any(|origin| {
                ancestor(origin.parent(), |parent| {
                    matches!(
                        parent.kind(),
                        K::InterfaceDeclaration | K::ModuleDeclaration
                    ) && parent.name().text() == owner
                })
            })
    }
    fn sdk_global_origins(&self, origins: &[Node]) -> bool {
        !origins.is_empty()
            && origins.iter().all(|origin| self.sdk(*origin))
            && origins
                .iter()
                .any(|origin| ast::is_variable_declaration(*origin))
    }
    fn sdk_global_member(&mut self, node: Node, name: Option<&str>) -> bool {
        let Some(name) = name else {
            return false;
        };
        let receiver = self.actual(node);
        let global_this = ast::is_identifier(receiver)
            && receiver.text() == "globalThis"
            && self
                .checker
                .get_symbol_at_location_exported(receiver)
                .is_some()
            && self
                .origins(receiver)
                .iter()
                .all(|origin| ast::is_identifier(*origin) && origin.text() == "globalThis");
        if !global_this && !self.sdk_origin(receiver) {
            return false;
        }
        let symbol = self.property(receiver, name);
        let origins: Vec<_> = self
            .symbol_origins(symbol)
            .into_iter()
            .filter(|origin| self.sdk(*origin))
            .collect();
        self.sdk_global_origins(&origins)
    }
    fn sdk_global_assignment(&mut self, node: Node) -> bool {
        let value = unwrap(node);
        if ast::is_array_literal_expression(value) {
            return value.elements().iter().any(|element| {
                if ast::is_spread_element(element) {
                    self.sdk_global_assignment(element.expression())
                } else {
                    ast::is_expression(element) && self.sdk_global_assignment(element)
                }
            });
        }
        if ast::is_object_literal_expression(value) {
            return value.properties().iter().any(|property| {
                if ast::is_property_assignment(property) {
                    return self.sdk_global_assignment(property.initializer());
                }
                if ast::is_spread_assignment(property) {
                    return self.sdk_global_assignment(property.expression());
                }
                if ast::is_shorthand_property_assignment(property) {
                    let symbol = self.checker.get_shorthand_assignment_value_symbol(property);
                    return self.sdk_global_origins(&self.symbol_origins(symbol));
                }
                false
            });
        }
        if assignment(value) {
            return self.sdk_global_assignment(value.left());
        }
        let origins = self.origins(value);
        self.sdk_global_origins(&origins)
    }
    fn descriptor_factory(&mut self, node: Node, seen: &mut HashSet<Node>) -> bool {
        let value = unwrap(node);
        if !seen.insert(value) {
            return false;
        }
        if member(value) && self.static_name(value).as_deref() == Some("defineProperty") {
            let receiver = self.actual(value.expression());
            let symbol = self.sdk_value(receiver);
            if ["Object", "Reflect"].contains(&self.symbol_name(symbol).as_str()) {
                return true;
            }
        }
        let symbol = self.sdk_value(value);
        if self.symbol_name(symbol) == "defineProperty"
            && self.symbol_origins(symbol).into_iter().any(|origin| {
                self.sdk(origin)
                    && ast::is_module_block(origin.parent())
                    && ast::is_module_declaration(origin.parent().parent())
                    && origin.parent().parent().name().text() == "Reflect"
            })
        {
            return true;
        }
        self.origins(value).into_iter().any(|origin| {
            if is_const(origin) && origin.initializer().is_some() {
                return self.descriptor_factory(origin.initializer(), seen);
            }
            if ast::is_binding_element(origin)
                && ast::is_object_binding_pattern(origin.parent())
                && self
                    .property_name(origin.property_name_or_name())
                    .as_deref()
                    == Some("defineProperty")
            {
                let declaration = origin.parent().parent();
                if is_const(declaration) && declaration.initializer().is_some() {
                    let symbol = self.sdk_value(declaration.initializer());
                    return ["Object", "Reflect"].contains(&self.symbol_name(symbol).as_str());
                }
            }
            false
        })
    }
    fn data_descriptor(&mut self, node: Node) -> bool {
        let value = unwrap(node);
        ast::is_object_literal_expression(value)
            && value.properties().to_vec().iter().all(|property| {
                !ast::is_spread_assignment(*property)
                    && self.property_name(property.name()).is_some_and(|name| {
                        ["value", "writable", "enumerable", "configurable"].contains(&name.as_str())
                    })
            })
    }
    #[expect(
        clippy::excessive_nesting,
        reason = "The native SDK and AST traversal retains its explicit semantic branches in this feasibility port."
    )]
    fn inspect_descriptor(&mut self, node: Node) {
        if self.skip_binding(node) || !self.descriptor_factory(node, &mut HashSet::new()) {
            return;
        }
        let usage = self.usage(node);
        if self.alias_usage(usage) {
            return;
        }
        let parent = usage.parent();
        if ast::is_call_expression(parent)
            && parent.expression() == usage
            && parent
                .arguments()
                .to_vec()
                .get(2)
                .is_some_and(|argument| self.data_descriptor(*argument))
        {
            if let Some(key) = parent.arguments().to_vec().get(1) {
                let name = self.constant_string(*key);
                if self.protocol_key(*key, false) || name.as_deref() == Some("then") {
                    self.reason("SOURCE_PROTOCOL_DESCRIPTOR_UNSUPPORTED");
                    return;
                }
                if let Some(target) = parent.arguments().to_vec().first() {
                    if self.sdk_global_member(*target, name.as_deref()) {
                        self.reason("SOURCE_SDK_GLOBAL_MUTATION_UNSUPPORTED");
                        return;
                    }
                    if self.sdk_callable_member(*target, name.as_deref()) {
                        self.reason("SOURCE_SDK_CALLABLE_MUTATION_UNSUPPORTED");
                        return;
                    }
                }
            }
            return;
        }
        self.reason("SOURCE_DESCRIPTOR_ACCESSOR_UNSUPPORTED");
    }
    fn inspect_meta_object(&mut self, node: Node) {
        if self.skip_binding(node) {
            return;
        }
        if self.sdk_meta_operation(node, &["setPrototypeOf"], &["Object", "Reflect"]) {
            self.reason("SOURCE_PROTOTYPE_MUTATION_UNSUPPORTED");
            return;
        }
        if !self.sdk_meta_operation(node, &["defineProperties", "create"], &["Object"]) {
            return;
        }
        let usage = self.usage(node);
        if self.alias_usage(usage) {
            return;
        }
        let parent = usage.parent();
        if !ast::is_call_expression(parent) || parent.expression() != usage {
            self.reason("SOURCE_DESCRIPTOR_UNSUPPORTED");
            return;
        }
        let create = self.sdk_meta_operation(node, &["create"], &["Object"]);
        if create
            && parent
                .arguments()
                .to_vec()
                .first()
                .is_none_or(|target| !self.literal_data(*target))
        {
            self.reason("SOURCE_PROTOTYPE_MUTATION_UNSUPPORTED");
        }
        let Some(map) = parent.arguments().to_vec().get(1).copied() else {
            if !create {
                self.reason("SOURCE_DESCRIPTOR_UNSUPPORTED");
            }
            return;
        };
        let descriptors = unwrap(map);
        if !ast::is_object_literal_expression(descriptors) {
            self.reason("SOURCE_DESCRIPTOR_UNSUPPORTED");
            return;
        }
        for entry in descriptors.properties().to_vec().iter() {
            if !ast::is_property_assignment(*entry) {
                self.reason("SOURCE_DESCRIPTOR_UNSUPPORTED");
                continue;
            }
            let key = entry.name();
            if ast::is_computed_property_name(key) && self.protocol_key(key.expression(), false) {
                self.reason("SOURCE_PROTOCOL_DESCRIPTOR_UNSUPPORTED");
            }
            let name = self.property_name(key);
            if !create
                && parent
                    .arguments()
                    .to_vec()
                    .first()
                    .is_some_and(|target| self.sdk_global_member(*target, name.as_deref()))
            {
                self.reason("SOURCE_SDK_GLOBAL_MUTATION_UNSUPPORTED");
            }
            let known = name.is_some()
                || (ast::is_computed_property_name(key) && self.property_key(key.expression()));
            if !known
                || name.as_deref() == Some("__proto__")
                || !self.data_descriptor(entry.initializer())
            {
                self.reason("SOURCE_DESCRIPTOR_UNSUPPORTED");
            }
            let descriptor = unwrap(entry.initializer());
            if name.is_some() && ast::is_object_literal_expression(descriptor) {
                let value = descriptor
                    .properties()
                    .to_vec()
                    .iter()
                    .find(|property| {
                        !ast::is_spread_assignment(**property)
                            && self.property_name(property.name()).as_deref() == Some("value")
                    })
                    .copied();
                if let (Some(target), Some(value)) = (parent.arguments().to_vec().first(), value)
                    && self.sdk_callable_member(*target, name.as_deref())
                    && (!ast::is_property_assignment(value) || !self.primitive(value.initializer()))
                {
                    self.reason("SOURCE_SDK_CALLABLE_MUTATION_UNSUPPORTED");
                }
            }
        }
    }
    fn inspect_reflect_set(&mut self, node: Node) {
        if !self.sdk_meta_operation(node, &["set"], &["Reflect"]) || self.skip_binding(node) {
            return;
        }
        let usage = self.usage(node);
        if self.alias_usage(usage) {
            return;
        }
        let parent = usage.parent();
        if !ast::is_call_expression(parent)
            || parent.expression() != usage
            || parent.arguments().to_vec().len() < 2
        {
            self.reason("SOURCE_PROTOCOL_MUTATION_UNSUPPORTED");
            return;
        }
        let target = self.actual(parent.arguments().to_vec()[0]);
        let key = parent.arguments().to_vec()[1];
        let value = parent.arguments().to_vec().get(2).copied();
        let name = self.constant_string(key);
        if self.sdk_global_member(target, name.as_deref()) {
            self.reason("SOURCE_SDK_GLOBAL_MUTATION_UNSUPPORTED");
        }
        if self.protocol_key(key, false)
            || (name.as_deref() == Some("then") && value.is_none_or(|value| !self.primitive(value)))
        {
            self.reason("SOURCE_PROTOCOL_MUTATION_UNSUPPORTED");
        } else if self.sdk_callable_member(target, name.as_deref())
            && value.is_none_or(|value| !self.primitive(value))
        {
            self.reason("SOURCE_SDK_CALLABLE_MUTATION_UNSUPPORTED");
        }
    }
    #[expect(
        clippy::excessive_nesting,
        reason = "The native SDK and AST traversal retains its explicit semantic branches in this feasibility port."
    )]
    fn inspect_mutation(&mut self, node: Node) {
        if !self.sdk_meta_operation(node, &["assign"], &["Object"]) || self.skip_binding(node) {
            return;
        }
        let usage = self.usage(node);
        if self.alias_usage(usage) {
            return;
        }
        let parent = usage.parent();
        if !ast::is_call_expression(parent)
            || parent.expression() != usage
            || parent.arguments().to_vec().is_empty()
        {
            self.reason("SOURCE_SDK_MUTATION_UNSUPPORTED");
            return;
        }
        let target = self.actual(parent.arguments().to_vec()[0]);
        for argument in parent.arguments().to_vec().iter().skip(1) {
            let source = unwrap(*argument);
            if !ast::is_object_literal_expression(source) {
                if self.sdk_origin(target) {
                    self.reason("SOURCE_SDK_MUTATION_UNSUPPORTED");
                }
                continue;
            }
            for property in source.properties().to_vec().iter() {
                if ast::is_spread_assignment(*property) {
                    if self.sdk_origin(target) {
                        self.reason("SOURCE_SDK_MUTATION_UNSUPPORTED");
                    }
                    continue;
                }
                let name = self.property_name(property.name());
                let value = if ast::is_property_assignment(*property) {
                    Some(property.initializer())
                } else if ast::is_shorthand_property_assignment(*property) {
                    Some(property.name())
                } else {
                    None
                };
                if self.sdk_global_member(target, name.as_deref()) {
                    self.reason("SOURCE_SDK_GLOBAL_MUTATION_UNSUPPORTED");
                }
                if (ast::is_computed_property_name(property.name())
                    && self.protocol_key(property.name().expression(), false))
                    || (name.as_deref() == Some("then")
                        && value.is_none_or(|value| !self.primitive(value)))
                    || (name.is_some()
                        && self.sdk_callable_member(target, name.as_deref())
                        && value.is_none_or(|value| !self.primitive(value)))
                    || (name.is_none() && self.sdk_origin(target))
                {
                    self.reason("SOURCE_SDK_MUTATION_UNSUPPORTED");
                }
            }
        }
    }

    #[expect(
        clippy::excessive_nesting,
        reason = "The native SDK and AST traversal retains its explicit semantic branches in this feasibility port."
    )]
    fn builtin_module_value(&mut self, node: Node, seen: &mut HashSet<Node>) -> Option<String> {
        let value = unwrap(node);
        if !seen.insert(value) {
            return None;
        }
        if member(value) || value.kind() == K::AwaitExpression {
            return self.builtin_module_value(value.expression(), seen);
        }
        if ast::is_call_expression(value)
            && value.expression().kind() == K::ImportKeyword
            && let Some(argument) = value
                .arguments()
                .to_vec()
                .first()
                .filter(|argument| ast::is_string_literal_like(**argument))
        {
            return Some(argument.text().into());
        }
        for origin in self.raw_origins(value) {
            if matches!(
                origin.kind(),
                K::ImportSpecifier | K::NamespaceImport | K::ImportClause
            ) {
                if matches!(origin.kind(), K::ImportSpecifier | K::ImportClause)
                    && origin.is_type_only()
                {
                    continue;
                }
                let mut statement = origin;
                while statement.is_some() && !ast::is_import_declaration(statement) {
                    statement = statement.parent();
                }
                if statement.is_some()
                    && (statement.import_clause().is_nil()
                        || !statement.import_clause().is_type_only())
                    && ast::is_string_literal(statement.module_specifier())
                {
                    return Some(statement.module_specifier().text().into());
                }
            }
            if is_const(origin) && origin.initializer().is_some() {
                let module = self.builtin_module_value(origin.initializer(), seen);
                if module.is_some() {
                    return module;
                }
            }
            if ast::is_binding_element(origin) && ast::is_object_binding_pattern(origin.parent()) {
                let declaration = origin.parent().parent();
                if is_const(declaration) && declaration.initializer().is_some() {
                    let module = self.builtin_module_value(declaration.initializer(), seen);
                    if module.is_some() {
                        return module;
                    }
                }
            }
        }
        None
    }
    fn inspect_builtin_process(&mut self, node: Node) {
        if ast::is_identifier(node)
            && (matches!(
                node.parent().kind(),
                K::ImportSpecifier | K::NamespaceImport | K::ImportClause
            ) || self.skip_binding(node))
        {
            return;
        }
        let module = self.builtin_module_value(node, &mut HashSet::new());
        if let Some(reason) = execution_module(module.as_deref().unwrap_or("")) {
            self.reason(reason);
            return;
        }
        if !matches!(module.as_deref(), Some("cluster" | "node:cluster")) {
            return;
        }
        let value = self.actual(node);
        let launch = self
            .static_name(value)
            .is_some_and(|name| ["fork", "setupPrimary"].contains(&name.as_str()))
            || self.raw_origins(value).into_iter().any(|origin| {
                matches!(origin.kind(), K::ImportSpecifier | K::BindingElement)
                    && matches!(
                        origin.property_name_or_name().kind(),
                        K::Identifier | K::StringLiteral
                    )
                    && ["fork", "setupPrimary"].contains(&origin.property_name_or_name().text())
            });
        if launch {
            self.reason("SOURCE_PROCESS_LAUNCH_UNSUPPORTED");
        }
    }
    #[expect(
        clippy::excessive_nesting,
        reason = "The native SDK and AST traversal retains its explicit semantic branches in this feasibility port."
    )]
    fn runtime_primitive(&mut self, node: Node, required: Option<&str>) -> bool {
        let value = unwrap(node);
        if !ast::is_identifier(value) {
            return false;
        }
        let symbol = self.checker.get_symbol_at_location_exported(value);
        let origins = self.symbol_origins(symbol);
        if origins.len() != 1 {
            return false;
        }
        let origin = origins[0];
        if !((ast::is_parameter_declaration(origin) || is_const(origin))
            && ast::is_identifier(origin.name()))
            || self.binding_written(symbol, self.source)
        {
            return false;
        }
        let mut child = value;
        let mut parent = child.parent();
        while parent.is_some() {
            if ast::is_function_like(parent) {
                break;
            }
            if matches!(parent.kind(), K::Block | K::SourceFile) {
                for statement in parent.statements().to_vec().iter() {
                    if statement.end() > child.pos() {
                        break;
                    }
                    if !ast::is_if_statement(*statement) {
                        continue;
                    }
                    let then = statement.then_statement();
                    let throws = then.kind() == K::ThrowStatement
                        || (then.kind() == K::Block
                            && then.statements().to_vec().len() == 1
                            && then.statements().to_vec()[0].kind() == K::ThrowStatement);
                    if !throws {
                        continue;
                    }
                    let condition = unwrap(statement.expression());
                    if !ast::is_binary_expression(condition)
                        || condition.operator_token().kind() != K::ExclamationEqualsEqualsToken
                    {
                        continue;
                    }
                    let left = unwrap(condition.left());
                    let right = unwrap(condition.right());
                    if left.kind() == K::TypeOfExpression
                        && right.kind() == K::StringLiteral
                        && [
                            "string",
                            "number",
                            "bigint",
                            "boolean",
                            "symbol",
                            "undefined",
                        ]
                        .contains(&right.text())
                        && required.is_none_or(|kind| kind == right.text())
                        && self
                            .checker
                            .get_symbol_at_location_exported(unwrap(left.expression()))
                            == symbol
                        && (ast::is_parameter_declaration(origin) || statement.pos() > origin.end())
                    {
                        return true;
                    }
                }
            }
            child = parent;
            parent = child.parent();
        }
        false
    }
    fn returned_primitive(&mut self, node: Node) -> bool {
        let value = unwrap(node);
        if !ast::is_call_expression(value) {
            return false;
        }
        let callee = self.actual(value.expression());
        let implementations: Vec<_> = self
            .origins(callee)
            .into_iter()
            .filter_map(|origin| {
                if matches!(origin.kind(), K::FunctionDeclaration | K::MethodDeclaration) {
                    return origin.body().is_some().then_some(origin);
                }
                if ast::is_variable_declaration(origin)
                    && ast::is_identifier(origin.name())
                    && origin.initializer().is_some()
                    && matches!(
                        origin.initializer().kind(),
                        K::ArrowFunction | K::FunctionExpression
                    )
                {
                    return Some(origin.initializer());
                }
                None
            })
            .collect();
        if implementations.len() != 1 {
            return false;
        }
        let implementation = implementations[0];
        if !self.internal(implementation)
            || (implementation.kind() != K::ArrowFunction
                && implementation.asterisk_token().is_some())
            || is_async(implementation)
        {
            return false;
        }
        let symbol = self.symbol(callee);
        if symbol.is_nil()
            || self.binding_written(symbol, ast::get_source_file_of_node(implementation))
        {
            return false;
        }
        let body = implementation.body();
        if body.is_nil() {
            return false;
        }
        if body.kind() != K::Block {
            return self.primitive(body);
        }
        let (count, valid) = self.primitive_returns(body, body);
        count > 0 && valid
    }
    fn primitive_returns(&mut self, node: Node, body: Node) -> (usize, bool) {
        if node != body && ast::is_function_like(node) {
            return (0, true);
        }
        let mut count = 0;
        let mut valid = true;
        if node.kind() == K::ReturnStatement {
            count += 1;
            valid = node.expression().is_nil() || self.primitive(node.expression());
        }
        for child in node.iter_children() {
            let (child_count, child_valid) = self.primitive_returns(child, body);
            count += child_count;
            valid &= child_valid;
        }
        (count, valid)
    }
    fn opaque_callee(&mut self, node: Node) -> bool {
        let value = self.actual(node);
        if self.sdk_origin(value) {
            return false;
        }
        !self.origins(value).into_iter().any(|origin| {
            self.internal(origin)
                && ((matches!(origin.kind(), K::FunctionDeclaration | K::MethodDeclaration)
                    && origin.body().is_some())
                    || (ast::is_variable_declaration(origin)
                        && origin.initializer().is_some()
                        && matches!(
                            origin.initializer().kind(),
                            K::ArrowFunction | K::FunctionExpression
                        )))
        })
    }
    fn lookup_graph_coordinate(
        graph: &serde_json::Value,
        coordinate: Option<(String, String)>,
    ) -> Option<(String, String)> {
        let (file, symbol_path) = coordinate?;
        let matches: Vec<_> = graph
            .get("nodes")?
            .as_array()?
            .iter()
            .filter(|node| {
                let kind = node.get("kind").and_then(serde_json::Value::as_str);
                let scope = node
                    .get("metadata")
                    .and_then(|metadata| metadata.get("scope"))
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("");
                let name = node
                    .get("name")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("");
                let path = if scope.is_empty() {
                    name.to_string()
                } else {
                    format!("{scope}.{name}")
                };
                matches!(kind, Some("function" | "class"))
                    && node.get("filePath").and_then(serde_json::Value::as_str)
                        == Some(file.as_str())
                    && path == symbol_path
            })
            .collect();
        if matches.len() != 1 {
            return None;
        }
        Some((
            matches[0].get("id")?.as_str()?.to_string(),
            matches[0].get("kind")?.as_str()?.to_string(),
        ))
    }
    #[expect(
        clippy::excessive_nesting,
        reason = "The native SDK and AST traversal retains its explicit semantic branches in this feasibility port."
    )]
    fn original_import(&mut self, node: Node) -> bool {
        let value = unwrap(node);
        for origin in self.raw_origins(value) {
            if !matches!(
                origin.kind(),
                K::ImportSpecifier | K::ImportClause | K::NamespaceImport
            ) {
                continue;
            }
            let mut statement = origin;
            while statement.is_some() && !ast::is_import_declaration(statement) {
                statement = statement.parent();
            }
            if statement.is_nil()
                || !ast::is_string_literal(statement.module_specifier())
                || (statement.import_clause().is_some() && statement.import_clause().is_type_only())
                || (origin.kind() == K::ImportSpecifier && origin.is_type_only())
            {
                continue;
            }
            let name = statement.module_specifier().text();
            if self.inputs.builtin_modules.contains(name) {
                return true;
            }
            let components: Vec<_> = name.split('/').collect();
            let package = if name.starts_with('@') {
                components
                    .iter()
                    .take(2)
                    .copied()
                    .collect::<Vec<_>>()
                    .join("/")
            } else {
                components[0].to_string()
            };
            if self.inputs.retained_files.iter().any(|(file, text)| {
                if !file.replace('\\', "/").ends_with("/package.json") {
                    return false;
                }
                let Ok(manifest) = serde_json::from_str::<serde_json::Value>(text) else {
                    return false;
                };
                [
                    "dependencies",
                    "devDependencies",
                    "optionalDependencies",
                    "peerDependencies",
                ]
                .iter()
                .any(|field| {
                    manifest
                        .get(field)
                        .and_then(|values| values.get(&package))
                        .and_then(serde_json::Value::as_str)
                        .is_some_and(|version| {
                            !["workspace:", "file:", "link:"]
                                .iter()
                                .any(|prefix| version.starts_with(prefix))
                        })
                })
            }) {
                return true;
            }
            if self.inputs.builtin_modules.is_empty()
                && !name.starts_with('.')
                && !name.starts_with('/')
            {
                self.unsupported("BUILTIN_MODULE_CLASSIFICATION_UNAVAILABLE");
            }
        }
        false
    }
    fn external_value(&mut self, node: Node, seen: &mut HashSet<Node>) -> bool {
        let value = self.actual(node);
        if !seen.insert(value) {
            return false;
        }
        if self.original_import(value) && self.origins(value).is_empty() {
            return true;
        }
        if member(value) || ast::is_call_expression(value) {
            return self.external_value(value.expression(), seen);
        }
        false
    }
    fn inline_owned(&mut self, callback: Node) -> Option<bool> {
        let span = self.span(callback);
        if self.inputs.inline_owned_callbacks.contains(&span) {
            return Some(true);
        }
        if let Some(value) = self.callback_cache.get(&span) {
            return Some(*value);
        }
        let inputs = self.inputs;
        let Some(graph) = inputs.graph.as_ref() else {
            return inputs.inline_callback_ownership_observed.then_some(false);
        };
        let (Some(nodes), Some(_)) = (
            graph.get("nodes").and_then(serde_json::Value::as_array),
            graph.get("edges").and_then(serde_json::Value::as_array),
        ) else {
            self.unsupported("RETAINED_GRAPH_SHAPE_UNSUPPORTED");
            return None;
        };
        let source_path = ast::source_file_file_name(self.source).replace('\\', "/");
        let root = inputs.repository_root.replace('\\', "/");
        let Some(path) = source_path
            .strip_prefix(&format!("{}/", root.trim_end_matches('/')))
            .map(str::to_string)
        else {
            self.unsupported("REPOSITORY_RELATIVE_PATH_UNAVAILABLE");
            return None;
        };
        let context = crate::ordinary::ExtractionContext {
            repository_root: &inputs.repository_root,
            static_module_links: true,
            retained: true,
            javascript_enabled: true,
            captured_files: Some(&inputs.retained_files),
            case_sensitive: inputs.case_sensitive,
        };
        let mut owner = None;
        let mut named_owner = false;
        let mut parent = callback.parent();
        while parent.is_some() {
            if ast::is_function_declaration(parent) {
                named_owner = true;
                owner = Self::lookup_graph_coordinate(
                    graph,
                    crate::ordinary::retained_function_owner_coordinate(
                        parent,
                        &inputs.repository_root,
                    ),
                );
                break;
            }
            if ast::is_method_declaration(parent) && ast::is_identifier(parent.name()) {
                named_owner = true;
                let coordinate = crate::ordinary::retained_callable_coordinate(
                    parent.name(),
                    self.checker,
                    &context,
                );
                owner = Self::lookup_graph_coordinate(graph, coordinate);
                break;
            }
            if matches!(parent.kind(), K::ArrowFunction | K::FunctionExpression)
                && ast::is_variable_declaration(parent.parent())
                && ast::is_identifier(parent.parent().name())
            {
                named_owner = true;
                let coordinate = crate::ordinary::retained_callable_coordinate(
                    parent.parent().name(),
                    self.checker,
                    &context,
                );
                owner = Self::lookup_graph_coordinate(graph, coordinate);
                break;
            }
            if matches!(
                parent.kind(),
                K::PropertyAssignment | K::PropertyDeclaration
            ) {
                self.callback_cache.insert(span, false);
                return Some(false);
            }
            parent = parent.parent();
        }
        if !named_owner {
            owner = nodes
                .iter()
                .find(|node| {
                    node.get("filePath").and_then(serde_json::Value::as_str) == Some(path.as_str())
                        && matches!(
                            node.get("kind").and_then(serde_json::Value::as_str),
                            Some("test" | "module")
                        )
                })
                .and_then(|node| {
                    Some((
                        node.get("id")?.as_str()?.to_string(),
                        node.get("kind")?.as_str()?.to_string(),
                    ))
                });
        }
        let mut count = 0;
        let valid = owner.is_some_and(|(id, kind)| {
            self.visit_inline_reference(
                callback.body(),
                &id,
                &kind,
                graph,
                &path,
                &context,
                &mut count,
            )
        }) && count > 0;
        self.callback_cache.insert(span, valid);
        Some(valid)
    }
    #[expect(
        clippy::too_many_arguments,
        reason = "The recursive AST visitor keeps its independent traversal inputs explicit."
    )]
    #[expect(
        clippy::excessive_nesting,
        reason = "The native SDK and AST traversal retains its explicit semantic branches in this feasibility port."
    )]
    fn visit_inline_reference(
        &mut self,
        node: Node,
        owner: &str,
        owner_kind: &str,
        graph: &serde_json::Value,
        path: &str,
        context: &crate::ordinary::ExtractionContext<'_>,
        count: &mut usize,
    ) -> bool {
        if ast::is_type_node(node) {
            return true;
        }
        if named_value(node) {
            let parent = node.parent();
            let binding = ast::is_identifier(node)
                && ((ast::is_property_access_expression(parent) && parent.name() == node)
                    || (parent.name() == node && !ast::is_shorthand_property_assignment(parent))
                    || ast::is_binding_element(parent));
            let ty = self.checker.get_type_at_location(node);
            if !binding
                && self.potential_callable(ty)
                && !self.sdk_origin(node)
                && !self.external_value(node, &mut HashSet::new())
            {
                let coordinate =
                    crate::ordinary::retained_callable_coordinate(node, self.checker, context);
                let Some((target, _)) = Self::lookup_graph_coordinate(graph, coordinate) else {
                    return false;
                };
                *count += 1;
                let usage = self.usage(node);
                let edges = graph
                    .get("edges")
                    .and_then(serde_json::Value::as_array)
                    .expect("validated retained graph edges");
                let has_edge = |kind: &str, from: &str, to: &str| {
                    edges.iter().any(|edge| {
                        edge.get("kind").and_then(serde_json::Value::as_str) == Some(kind)
                            && edge.get("from").and_then(serde_json::Value::as_str) == Some(from)
                            && edge.get("to").and_then(serde_json::Value::as_str) == Some(to)
                    })
                };
                let paired_test = owner_kind == "test"
                    && has_edge("covers", owner, &target)
                    && has_edge("tested_by", &target, owner);
                let line = ast::source_file_ecma_line_map(self.source)
                    .partition_point(|start| {
                        *start <= astnav::get_start_of_node(usage, self.source, false)
                    })
                    .max(1) as u32;
                let modeled = matches!(
                    unwrap(usage).kind(),
                    K::Identifier | K::PropertyAccessExpression | K::ImportKeyword
                );
                let invoked = ast::is_call_expression(usage.parent())
                    && usage.parent().expression() == usage
                    && modeled
                    && edges.iter().any(|edge| {
                        edge.get("kind").and_then(serde_json::Value::as_str) == Some("calls")
                            && edge.get("from").and_then(serde_json::Value::as_str) == Some(owner)
                            && edge.get("to").and_then(serde_json::Value::as_str)
                                == Some(target.as_str())
                            && edge
                                .get("evidence")
                                .and_then(serde_json::Value::as_array)
                                .is_some_and(|evidence| {
                                    evidence.iter().any(|entry| {
                                        entry.get("filePath").and_then(serde_json::Value::as_str)
                                            == Some(path)
                                            && entry
                                                .get("startLine")
                                                .and_then(serde_json::Value::as_f64)
                                                == Some(f64::from(line))
                                    })
                                })
                    });
                if !paired_test && !invoked {
                    return false;
                }
            }
        }
        node.iter_children().all(|child| {
            self.visit_inline_reference(child, owner, owner_kind, graph, path, context, count)
        })
    }

    #[expect(
        clippy::excessive_nesting,
        reason = "The native SDK and AST traversal retains its explicit semantic branches in this feasibility port."
    )]
    fn inspect_opaque_callbacks(&mut self, node: Node) {
        if !self.opaque_callee(node.expression()) {
            return;
        }
        let callee = self.actual(node.expression());
        if member(callee) {
            let receiver = unwrap(callee.expression());
            let caller_owned = self.origins(receiver).into_iter().any(|origin| {
                self.internal(origin)
                    && (ast::is_variable_declaration(origin)
                        || (ast::is_binding_element(origin)
                            && ast::is_variable_declaration(origin.parent().parent())))
            });
            let module = self.builtin_module_value(receiver, &mut HashSet::new());
            let external = module.as_deref().is_some_and(|module| {
                !(module.starts_with('.')
                    || module.starts_with('/')
                    || module.len() > 1
                        && module.as_bytes()[0].is_ascii_alphabetic()
                        && module.as_bytes()[1] == b':')
            });
            let name = self.static_name(callee).unwrap_or_default();
            if !(!caller_owned
                || external
                || self.sdk_origin(callee)
                || self.runtime_primitive(receiver, Some("string"))
                    && self.sdk_member_of(callee, "String", &name))
            {
                let members = self.origins(callee);
                let declared = !members.is_empty()
                    && members.iter().all(|origin| {
                        self.internal(*origin)
                            && (matches!(
                                origin.kind(),
                                K::PropertyAssignment
                                    | K::ShorthandPropertyAssignment
                                    | K::MethodDeclaration
                                    | K::PropertyDeclaration
                            ) || ast::is_property_signature_declaration(*origin)
                                || ast::is_method_signature_declaration(*origin))
                    });
                if !declared
                    && !self
                        .inputs
                        .retained_callable_coordinates
                        .contains(&self.span(callee))
                {
                    if self.inputs.retained_callable_coordinates_observed {
                        self.reason("SOURCE_UNRESOLVED_CALLEE_UNSUPPORTED");
                    } else {
                        self.unsupported("RETAINED_CALLABLE_COORDINATE_PROOF_UNAVAILABLE");
                    }
                }
            }
            let mut root = self.actual(callee.expression());
            let mut members = vec![self.static_name(callee)];
            let mut seen = HashSet::new();
            while seen.insert(root) {
                if member(root) {
                    members.push(self.static_name(root));
                    root = self.actual(root.expression());
                    continue;
                }
                let binding = self.raw_origins(root).into_iter().find(|origin| {
                    ast::is_binding_element(*origin)
                        && ast::is_object_binding_pattern(origin.parent())
                        && is_const(origin.parent().parent())
                        && origin.parent().parent().initializer().is_some()
                });
                let Some(binding) = binding else {
                    break;
                };
                members.push(self.property_name(binding.property_name_or_name()));
                root = self.actual(binding.parent().parent().initializer());
            }
            if ast::is_identifier(root) {
                let origins = self.raw_origins(root);
                let runtime = origins.iter().any(|origin| {
                    self.internal(*origin)
                        && !ast::source_file_info(ast::get_source_file_of_node(*origin))
                            .is_declaration_file
                        && !ancestor(*origin, |parent| {
                            parent.modifier_flags().intersects(ModifierFlags::AMBIENT)
                                || (matches!(parent.kind(), K::ImportClause | K::ImportSpecifier)
                                    && parent.is_type_only())
                        })
                        && (matches!(
                            origin.kind(),
                            K::VariableDeclaration
                                | K::Parameter
                                | K::BindingElement
                                | K::ClassDeclaration
                                | K::ImportClause
                                | K::NamespaceImport
                                | K::ImportSpecifier
                        ) || (origin.kind() == K::FunctionDeclaration
                            && origin.body().is_some()))
                });
                let ambient = origins.is_empty()
                    || origins.iter().all(|origin| {
                        matches!(
                            origin.kind(),
                            K::BinaryExpression
                                | K::SourceFile
                                | K::PropertyAccessExpression
                                | K::ElementAccessExpression
                        ) || (ast::is_identifier(*origin)
                            && member(origin.parent())
                            && origin.parent().expression() == *origin)
                    });
                let process_member = if root.text() == "process" {
                    members.last().and_then(Option::as_deref)
                } else if ["globalThis", "global"].contains(&root.text())
                    && members.last().and_then(Option::as_deref) == Some("process")
                {
                    members.iter().rev().nth(1).and_then(Option::as_deref)
                } else {
                    None
                };
                let ordinary_process =
                    ambient && process_member.is_some_and(is_ordinary_native_process_member);
                let sdk = self.sdk_origin(callee)
                    || (self.sdk_origin(root) && self.sdk_value(callee).is_some());
                if !runtime && !sdk && !ordinary_process {
                    self.reason("SOURCE_UNRESOLVED_CALLEE_UNSUPPORTED");
                }
            }
        }
        for argument in node.arguments().to_vec().iter() {
            let value = unwrap(*argument);
            let actual = self.actual(value);
            let ty = self.checker.get_type_at_location(actual);
            let sdk_data = self.sdk_origin(value)
                && (self.potential_callable(ty)
                    || self.checker.ty(ty).flags.intersects(
                        TypeFlags::STRING_LIKE
                            | TypeFlags::NUMBER_LIKE
                            | TypeFlags::BIG_INT_LIKE
                            | TypeFlags::BOOLEAN_LIKE
                            | TypeFlags::ES_SYMBOL_LIKE,
                    ));
            if self.literal_data(value)
                || self.runtime_primitive(value, None)
                || self.returned_primitive(value)
                || sdk_data
            {
                continue;
            }
            if matches!(value.kind(), K::ArrowFunction | K::FunctionExpression) {
                match self.inline_owned(value) {
                    Some(true) => {}
                    Some(false) => self.reason("SOURCE_OPAQUE_CALLBACK_UNSUPPORTED"),
                    None => self.unsupported("OPAQUE_CALLBACK_GRAPH_OWNERSHIP_PROOF_UNAVAILABLE"),
                }
                continue;
            }
            self.reason("SOURCE_OPAQUE_CALLBACK_UNSUPPORTED");
        }
    }
    fn inspect_default_sort(&mut self, node: Node) {
        let callee = unwrap(node.expression());
        let symbol = self.sdk_value(callee);
        if self.symbol_name(symbol) != "sort" || !self.declared_on(symbol, &["Array"]) {
            return;
        }
        if let Some(comparator) = node.arguments().to_vec().first() {
            let comparator = self.actual(*comparator);
            let ty = self.checker.get_type_at_location(comparator);
            if !(self.checker.ty(ty).flags.intersects(TypeFlags::UNDEFINED)
                && self.primitive(comparator))
            {
                return;
            }
        }
        if !member(callee) {
            self.reason("SOURCE_SORT_COERCION_UNSUPPORTED");
            return;
        }
        let receiver = unwrap(callee.expression());
        if !ast::is_array_literal_expression(receiver)
            || !receiver
                .elements()
                .to_vec()
                .iter()
                .all(|element| ast::is_expression(*element) && self.primitive(*element))
        {
            self.reason("SOURCE_SORT_COERCION_UNSUPPORTED");
        }
    }
    fn inspect_promise_resolve(&mut self, node: Node) {
        if !self.sdk_meta_operation(node, &["resolve"], &["Promise"]) || self.skip_binding(node) {
            return;
        }
        let usage = self.usage(node);
        if self.alias_usage(usage) {
            return;
        }
        let parent = usage.parent();
        if ast::is_call_expression(parent)
            && parent.expression() == usage
            && parent
                .arguments()
                .to_vec()
                .first()
                .is_none_or(|arg| self.safe_await(*arg))
        {
            return;
        }
        self.reason("SOURCE_PROMISE_ASSIMILATION_UNSUPPORTED");
    }
    fn inspect_serializer(&mut self, node: Node) {
        let value = self.actual(node);
        let direct = if member(value) && self.static_name(value).as_deref() == Some("stringify") {
            let receiver = self.actual(value.expression());
            let symbol = self.sdk_value(receiver);
            self.symbol_name(symbol) == "JSON"
        } else {
            false
        };
        let symbol = self.sdk_value(value);
        if !(direct
            || (self.symbol_name(symbol) == "stringify" && self.declared_on(symbol, &["JSON"])))
            || self.skip_binding(node)
        {
            return;
        }
        let usage = self.usage(node);
        if self.alias_usage(usage) {
            return;
        }
        let parent = usage.parent();
        if ast::is_call_expression(parent)
            && parent.expression() == usage
            && parent
                .arguments()
                .to_vec()
                .first()
                .is_none_or(|arg| self.literal_data(*arg))
        {
            return;
        }
        self.reason("SOURCE_SERIALIZATION_UNSUPPORTED");
    }
    fn inspect_combinator(&mut self, node: Node) {
        if !self.sdk_meta_operation(node, &["all", "allSettled", "race", "any"], &["Promise"])
            || self.skip_binding(node)
        {
            return;
        }
        let usage = self.usage(node);
        if self.alias_usage(usage) {
            return;
        }
        let parent = usage.parent();
        if ast::is_call_expression(parent)
            && parent.expression() == usage
            && let Some(argument) = parent.arguments().to_vec().first()
        {
            let array = unwrap(*argument);
            if ast::is_array_literal_expression(array)
                && array
                    .elements()
                    .to_vec()
                    .iter()
                    .all(|element| !ast::is_spread_element(*element) && self.safe_await(*element))
            {
                return;
            }
        }
        self.reason("SOURCE_PROMISE_ASSIMILATION_UNSUPPORTED");
    }
    fn sdk_timer(&self, symbol: SymbolId) -> bool {
        let origins = self.symbol_origins(symbol);
        ["setTimeout", "setInterval"].contains(&self.symbol_name(symbol).as_str())
            && !origins.is_empty()
            && origins.iter().all(|origin| self.sdk(*origin))
    }
    #[expect(
        clippy::excessive_nesting,
        reason = "The native SDK and AST traversal retains its explicit semantic branches in this feasibility port."
    )]
    fn timer_value(&mut self, node: Node, seen: &mut HashSet<Node>) -> bool {
        let value = unwrap(node);
        if !seen.insert(value) {
            return false;
        }
        let symbol = self.sdk_value(value);
        if self.sdk_timer(symbol) {
            return true;
        }
        for origin in self.origins(value) {
            if is_const(origin)
                && origin.initializer().is_some()
                && self.timer_value(origin.initializer(), seen)
            {
                return true;
            }
            if ast::is_binding_element(origin) && ast::is_object_binding_pattern(origin.parent()) {
                let declaration = origin.parent().parent();
                if is_const(declaration) && declaration.initializer().is_some() {
                    let member = origin.property_name_or_name();
                    if matches!(member.kind(), K::Identifier | K::StringLiteral) {
                        let symbol = self.property(declaration.initializer(), member.text());
                        if self.sdk_timer(symbol) {
                            return true;
                        }
                    }
                }
            }
        }
        false
    }
    fn unsafe_handler(&mut self, ty: TypeId) -> bool {
        let unsafe_flags = TypeFlags::STRING_LIKE
            | TypeFlags::ANY
            | TypeFlags::UNKNOWN
            | TypeFlags::TYPE_PARAMETER;
        let flags = self.checker.ty(ty).flags;
        if flags.intersects(unsafe_flags) {
            return true;
        }
        if flags.intersects(TypeFlags::UNION) {
            return self
                .parts(ty)
                .into_iter()
                .any(|part| self.unsafe_handler(part));
        }
        if flags.intersects(TypeFlags::INTERSECTION)
            && self
                .parts(ty)
                .into_iter()
                .any(|part| self.checker.ty(part).flags.intersects(unsafe_flags))
        {
            return true;
        }
        let symbol = self.checker.ty(ty).symbol;
        self.checker
            .get_signatures_of_type_exported(ty, SignatureKind::CALL)
            .is_empty()
            && !(self.symbol_name(symbol) == "Function"
                && self
                    .symbol_origins(symbol)
                    .iter()
                    .all(|origin| self.sdk(*origin)))
    }
    fn inspect_timer(&mut self, node: Node) {
        if self.skip_binding(node)
            || !self.timer_value(node, &mut HashSet::new())
            || ancestor(node, ast::is_type_node)
        {
            return;
        }
        let usage = self.usage(node);
        if self.alias_usage(usage) {
            return;
        }
        let parent = usage.parent();
        if ast::is_call_expression(parent)
            && parent.expression() == usage
            && let Some(argument) = parent.arguments().to_vec().first()
        {
            let ty = self.checker.get_type_at_location(unwrap(*argument));
            if !self.unsafe_handler(ty) {
                self.reason("SOURCE_TIMER_CALLBACK_UNSUPPORTED");
                return;
            }
        }
        self.reason("SOURCE_TIMER_EVALUATION_UNSUPPORTED");
    }
    fn internal_base(&mut self, node: Node, seen: &mut HashSet<Node>) -> bool {
        let value = unwrap(node);
        if !seen.insert(value) {
            return false;
        }
        if value.kind() == K::ConditionalExpression {
            return self.internal_base(value.when_true(), seen)
                || self.internal_base(value.when_false(), seen);
        }
        let ty = self.checker.get_type_at_location(value);
        let symbol = self.checker.ty(ty).symbol;
        if self.symbol_origins(symbol).into_iter().any(|origin| {
            self.internal(origin)
                && matches!(origin.kind(), K::ClassDeclaration | K::ClassExpression)
        }) {
            return true;
        }
        self.origins(value).into_iter().any(|origin| {
            (self.internal(origin)
                && matches!(
                    origin.kind(),
                    K::ClassDeclaration | K::ClassExpression | K::FunctionDeclaration
                ))
                || (ast::is_variable_declaration(origin)
                    && origin.initializer().is_some()
                    && self.internal_base(origin.initializer(), seen))
        })
    }

    fn import_meta_member(&mut self, node: Node, seen: &mut HashSet<Node>) -> bool {
        let value = self.actual(node);
        if !seen.insert(value) {
            return false;
        }
        if member(value) {
            let receiver = self.actual(value.expression());
            if receiver.kind() == K::MetaProperty && receiver.keyword_token() == K::ImportKeyword {
                return self.static_name(value).as_deref() != Some("require");
            }
            let ty = self.checker.get_type_at_location(receiver);
            return !self.checker.ty(ty).flags.intersects(
                TypeFlags::STRING_LIKE
                    | TypeFlags::NUMBER_LIKE
                    | TypeFlags::BOOLEAN_LIKE
                    | TypeFlags::BIG_INT_LIKE
                    | TypeFlags::ES_SYMBOL_LIKE,
            ) && self.import_meta_member(receiver, seen);
        }
        self.raw_origins(value).into_iter().any(|origin| {
            if !ast::is_binding_element(origin) || !ast::is_object_binding_pattern(origin.parent())
            {
                return false;
            }
            let declaration = origin.parent().parent();
            ast::is_variable_declaration(declaration)
                && declaration.initializer().is_some()
                && self.actual(declaration.initializer()).kind() == K::MetaProperty
                && self
                    .property_name(origin.property_name_or_name())
                    .as_deref()
                    != Some("require")
        })
    }
    fn inspect_import_meta(&mut self, node: Node) {
        if !self.import_meta_member(node, &mut HashSet::new()) {
            return;
        }
        let value = self.actual(node);
        let ty = self.checker.get_type_at_location(value);
        if !self.potential_callable(ty) {
            return;
        }
        let parent = node.parent();
        if self.skip_binding(node)
            || (member(parent) && parent.expression() == node)
            || (is_const(parent)
                && parent.initializer() == node
                && ast::is_identifier(parent.name()))
        {
            return;
        }
        self.reason("SOURCE_IMPORT_META_CALLABLE_UNSUPPORTED");
    }
    fn sdk_invocation(&mut self, node: Node) -> (Node, Node, Option<Vec<Node>>) {
        let callee = self.actual(node.expression());
        let receiver = if member(callee) {
            callee.expression()
        } else {
            Node::NIL
        };
        let direct = (callee, receiver, Some(node.arguments().to_vec()));
        if !ast::is_call_expression(node) {
            return direct;
        }
        let helper_callee = if ast::is_call_expression(callee) {
            self.actual(callee.expression())
        } else {
            callee
        };
        if !member(helper_callee) {
            return direct;
        }
        let name = self.static_name(helper_callee).unwrap_or_default();
        let target = self.actual(helper_callee.expression());
        if !["call", "apply", "bind"].contains(&name.as_str()) || !self.sdk_origin(target) {
            return direct;
        }
        let ty = self.callable_type(target);
        let helper = self.checker.get_property_of_type_exported(ty, &name);
        if !self.declared_on(helper, &["Function", "CallableFunction", "NewableFunction"]) {
            return direct;
        }
        if ast::is_call_expression(callee) {
            if name != "bind" {
                return direct;
            }
            let mut args: Vec<_> = callee
                .arguments()
                .to_vec()
                .iter()
                .skip(1)
                .copied()
                .collect();
            args.extend(node.arguments().to_vec().iter().copied());
            return (
                target,
                callee
                    .arguments()
                    .to_vec()
                    .first()
                    .copied()
                    .unwrap_or(Node::NIL),
                Some(args),
            );
        }
        if name == "bind" {
            return direct;
        }
        let receiver = node
            .arguments()
            .to_vec()
            .first()
            .copied()
            .unwrap_or(Node::NIL);
        if name == "call" {
            return (
                target,
                receiver,
                Some(node.arguments().to_vec().iter().skip(1).copied().collect()),
            );
        }
        let list = node.arguments().to_vec().get(1).copied().map(unwrap);
        let arguments = match list {
            None => Some(Vec::new()),
            Some(list) if list.kind() == K::NullKeyword => Some(Vec::new()),
            Some(list)
                if ast::is_array_literal_expression(list)
                    && !list
                        .elements()
                        .to_vec()
                        .iter()
                        .any(|element| ast::is_spread_element(*element)) =>
            {
                Some(list.elements().to_vec())
            }
            _ => None,
        };
        (target, receiver, arguments)
    }
    #[expect(
        clippy::excessive_nesting,
        reason = "The native SDK and AST traversal retains its explicit semantic branches in this feasibility port."
    )]
    fn inspect_sdk_coercion(&mut self, callee: Node, receiver: Node, arguments: Option<&[Node]>) {
        if !self.sdk_origin(callee) {
            return;
        }
        let symbol = self.sdk_value(callee);
        let name = self.symbol_name(symbol);
        if ["String", "Number"].contains(&name.as_str())
            && arguments.is_none_or(|args| args.first().is_some_and(|arg| !self.primitive(*arg)))
        {
            self.reason("SOURCE_COERCION_UNSUPPORTED");
        }
        if self.sdk_member_of(callee, "Math", &name) {
            let ty = self.callable_type(callee);
            for signature in self
                .checker
                .get_signatures_of_type_exported(ty, SignatureKind::CALL)
            {
                let declaration = self.checker.sig(signature).declaration;
                if !self.sdk(declaration) {
                    continue;
                }
                for (index, parameter) in self
                    .checker
                    .sig(signature)
                    .parameters
                    .clone()
                    .into_iter()
                    .enumerate()
                {
                    let rest = self.symbol_origins(parameter).iter().any(|origin| {
                        ast::is_parameter_declaration(*origin)
                            && origin.dot_dot_dot_token().is_some()
                    });
                    let ty = self
                        .checker
                        .get_type_of_symbol_at_location(parameter, declaration);
                    let numeric = if rest {
                        let key = self.checker.get_number_type();
                        self.checker.get_index_type_of_type_exported(ty, key)
                    } else {
                        ty
                    };
                    if numeric.is_nil()
                        || !self
                            .checker
                            .ty(numeric)
                            .flags
                            .intersects(TypeFlags::NUMBER_LIKE)
                    {
                        continue;
                    }
                    let consumed = arguments.map(|args| {
                        let begin = index.min(args.len());
                        if rest {
                            &args[begin..]
                        } else {
                            &args[begin..(begin + 1).min(args.len())]
                        }
                    });
                    if consumed.is_none_or(|args| args.iter().any(|arg| !self.primitive(*arg))) {
                        self.reason("SOURCE_COERCION_UNSUPPORTED");
                    }
                }
            }
        }
        if self.sdk_member_of(callee, "Array", "join") {
            let array = unwrap(receiver);
            if array.is_nil()
                || !ast::is_array_literal_expression(array)
                || !array
                    .elements()
                    .to_vec()
                    .iter()
                    .all(|element| ast::is_expression(*element) && self.primitive(*element))
                || arguments
                    .is_none_or(|args| args.first().is_some_and(|arg| !self.primitive(*arg)))
            {
                self.reason("SOURCE_COERCION_UNSUPPORTED");
            }
        }
        if self.sdk_member_of(callee, "Array", "toLocaleString") {
            let array = unwrap(receiver);
            let locales = arguments.and_then(|args| args.first()).copied();
            let options = arguments.and_then(|args| args.get(1)).copied();
            let safe_locales = locales.is_none_or(|locales| {
                let value = unwrap(locales);
                self.primitive(locales)
                    || (ast::is_array_literal_expression(value)
                        && value.elements().to_vec().iter().all(|element| {
                            ast::is_expression(*element) && self.primitive(*element)
                        }))
            });
            let safe_options = options.is_none_or(|options| {
                let value = unwrap(options);
                self.primitive(options)
                    || (ast::is_object_literal_expression(value)
                        && self.literal_data(value)
                        && value.properties().to_vec().iter().all(|property| {
                            if ast::is_property_assignment(*property) {
                                self.primitive(property.initializer())
                            } else {
                                ast::is_shorthand_property_assignment(*property)
                                    && self.primitive(property.name())
                            }
                        }))
            });
            if array.is_nil()
                || !ast::is_array_literal_expression(array)
                || !array
                    .elements()
                    .to_vec()
                    .iter()
                    .all(|element| ast::is_expression(*element) && self.primitive(*element))
                || arguments.is_none()
                || !safe_locales
                || !safe_options
            {
                self.reason("SOURCE_COERCION_UNSUPPORTED");
            }
        }
    }
    fn sdk_script_element(&mut self, node: Node) -> bool {
        let value = self.actual(node);
        if !ast::is_call_expression(value)
            || !value.arguments().to_vec().first().is_some_and(|arg| {
                self.constant_string(*arg)
                    .is_some_and(|name| name.eq_ignore_ascii_case("script"))
            })
        {
            return false;
        }
        let callee = self.actual(value.expression());
        member(callee)
            && self.sdk_origin(callee.expression())
            && self.sdk_member_of(callee, "Document", "createElement")
    }
    fn inspect_runtime_code(&mut self, node: Node) {
        let (callee, receiver, args) = self.sdk_invocation(node);
        self.inspect_sdk_coercion(callee, receiver, args.as_deref());
        if self.sdk_origin(node.expression())
            && ((ast::is_call_expression(node)
                && ["instantiate", "instantiateStreaming"]
                    .iter()
                    .any(|name| self.sdk_member_of(node.expression(), "WebAssembly", name)))
                || (ast::is_new_expression(node)
                    && self.sdk_member_of(node.expression(), "WebAssembly", "Instance")))
        {
            self.reason("SOURCE_WASM_INSTANTIATION_UNSUPPORTED");
        }
        if !ast::is_call_expression(node) {
            return;
        }
        let callee = self.actual(node.expression());
        if !member(callee) || !self.sdk_origin(callee.expression()) {
            return;
        }
        if ["write", "writeln"]
            .iter()
            .any(|name| self.sdk_member_of(callee, "Document", name))
        {
            self.reason("SOURCE_DOCUMENT_WRITE_UNSUPPORTED");
        }
        let insertions = [
            ("Node", "appendChild", Some(0)),
            ("Node", "insertBefore", Some(0)),
            ("Node", "replaceChild", Some(0)),
            ("ParentNode", "append", None),
            ("ParentNode", "prepend", None),
            ("ParentNode", "replaceChildren", None),
            ("ChildNode", "before", None),
            ("ChildNode", "after", None),
            ("ChildNode", "replaceWith", None),
            ("Element", "insertAdjacentElement", Some(1)),
            ("Range", "insertNode", Some(0)),
        ];
        if let Some((_, _, index)) = insertions
            .into_iter()
            .find(|(owner, name, _)| self.sdk_member_of(callee, owner, name))
        {
            let inserted = if let Some(index) = index {
                node.arguments()
                    .to_vec()
                    .get(index)
                    .copied()
                    .into_iter()
                    .collect::<Vec<_>>()
            } else {
                node.arguments().to_vec()
            };
            if inserted.into_iter().any(|arg| self.sdk_script_element(arg)) {
                self.reason("SOURCE_SCRIPT_INSERTION_UNSUPPORTED");
            }
        }
    }
    fn service_worker_loader(&mut self, node: Node) -> bool {
        let value = unwrap(node);
        if member(value) && self.static_name(value).as_deref() == Some("register") {
            let symbol = self.sdk_value(value.expression());
            if self.symbol_name(symbol) == "serviceWorker" {
                return true;
            }
        }
        let symbol = self.sdk_value(node);
        self.symbol_name(symbol) == "register"
            && self.declared_on(symbol, &["ServiceWorkerContainer"])
    }
    fn worklet_loader(&mut self, node: Node) -> bool {
        let value = self.actual(node);
        let symbol = if member(value) {
            if let Some(name) = self.static_name(value) {
                let receiver = self.actual(value.expression());
                self.property(receiver, &name)
            } else {
                self.sdk_value(value)
            }
        } else {
            self.sdk_value(value)
        };
        self.symbol_name(symbol) == "addModule" && self.declared_on(symbol, &["Worklet"])
    }
    fn proxy_factory(&mut self, node: Node) -> bool {
        let value = unwrap(node);
        if member(value) && self.static_name(value).as_deref() == Some("revocable") {
            let symbol = self.sdk_value(value.expression());
            if self.symbol_name(symbol) == "Proxy" {
                return true;
            }
        }
        let symbol = self.sdk_value(value);
        self.symbol_name(symbol) == "revocable" && self.declared_on(symbol, &["ProxyConstructor"])
    }
    fn reflected_invocation(&mut self, node: Node) -> bool {
        let symbol = self.sdk_value(node);
        ["apply", "construct"].contains(&self.symbol_name(symbol).as_str())
            && self.symbol_origins(symbol).into_iter().any(|origin| {
                self.sdk(origin)
                    && ast::is_module_block(origin.parent())
                    && ast::is_module_declaration(origin.parent().parent())
                    && origin.parent().parent().name().text() == "Reflect"
            })
    }
    fn runtime_property(&self, node: Node) -> bool {
        !ast::source_file_info(ast::get_source_file_of_node(node)).is_declaration_file
            && !ancestor(node, |owner| {
                owner.modifier_flags().intersects(ModifierFlags::AMBIENT)
            })
    }
    fn inspect_syntax(&mut self, node: Node) -> bool {
        let mut needed = false;
        if node.kind() == K::MetaProperty && node.keyword_token() == K::ImportKeyword {
            needed = true;
        }
        if ast::is_property_assignment(node)
            && matches!(node.name().kind(), K::Identifier | K::StringLiteral)
            && node.name().text() == "__proto__"
        {
            needed = true;
        }
        if ast::is_import_declaration(node)
            && ast::is_string_literal(node.module_specifier())
            && execution_module(node.module_specifier().text()).is_some()
        {
            needed = true;
        }
        if ast::is_export_declaration(node)
            && !node.is_type_only()
            && node.module_specifier().is_some()
            && ast::is_string_literal(node.module_specifier())
        {
            let clause = node.export_clause();
            let only_types = clause.is_some()
                && ast::is_named_exports(clause)
                && clause
                    .elements()
                    .to_vec()
                    .iter()
                    .all(|element| element.is_type_only());
            if !only_types {
                if let Some(reason) = execution_module(node.module_specifier().text()) {
                    self.reason(reason);
                }
                if ["cluster", "node:cluster"].contains(&node.module_specifier().text())
                    && clause.is_some()
                    && ast::is_named_exports(clause)
                    && clause.elements().to_vec().iter().any(|element| {
                        !element.is_type_only()
                            && ["fork", "setupPrimary"]
                                .contains(&element.property_name_or_name().text())
                    })
                {
                    self.reason("SOURCE_PROCESS_LAUNCH_UNSUPPORTED");
                }
            }
        }
        if ast::is_variable_declaration_list(node) && node.flags().intersects(NodeFlags::USING) {
            self.reason("SOURCE_DISPOSAL_UNSUPPORTED");
        }
        if node.kind() == K::Decorator {
            self.reason("SOURCE_DECORATOR_UNSUPPORTED");
        }
        if matches!(
            node.kind(),
            K::FunctionDeclaration | K::FunctionExpression | K::MethodDeclaration
        ) && node.asterisk_token().is_some()
        {
            self.reason("SOURCE_ITERATION_UNSUPPORTED");
        }
        if matches!(node.kind(), K::GetAccessor | K::SetAccessor) {
            self.reason("SOURCE_ACCESSOR_UNSUPPORTED");
        }
        if ast::is_jsx_opening_element(node) || ast::is_jsx_self_closing_element(node) {
            let tag = node.tag_name();
            let name = if ast::is_identifier(tag) {
                Some(tag.text().to_string())
            } else if ast::is_jsx_namespaced_name(tag) {
                Some(format!("{}:{}", tag.namespace().text(), tag.name().text()))
            } else {
                None
            };
            if !name.is_some_and(|name| {
                name.as_bytes().first().is_some_and(u8::is_ascii_lowercase) || name.contains('-')
            }) {
                self.reason("SOURCE_JSX_COMPONENT_UNSUPPORTED");
            }
        }
        if matches!(
            node.kind(),
            K::CallExpression
                | K::NewExpression
                | K::ElementAccessExpression
                | K::ComputedPropertyName
                | K::TemplateExpression
                | K::ForOfStatement
                | K::SpreadElement
                | K::AwaitExpression
                | K::ExportDeclaration
        ) || coercing_binary(node)
            || numeric_unary(node)
            || assignment(node)
            || (ast::is_binary_expression(node)
                && matches!(
                    node.operator_token().kind(),
                    K::InKeyword | K::InstanceOfKeyword
                ))
            || (node.kind() == K::ReturnStatement && async_owner(node))
            || (node.kind() == K::ArrowFunction && is_async(node))
            || (matches!(node.kind(), K::Identifier | K::StringLiteral)
                && [
                    "register",
                    "defineProperty",
                    "importScripts",
                    "Proxy",
                    "revocable",
                    "Reflect",
                    "construct",
                    "setTimeout",
                    "setInterval",
                ]
                .contains(&node.text()))
            || (ast::is_function_declaration(node) && node.body().is_nil())
            || (node.kind() == K::YieldExpression && node.asterisk_token().is_some())
            || (ast::is_parameter_declaration(node) && ast::is_array_binding_pattern(node.name()))
            || (ast::is_variable_declaration(node) && !ast::is_identifier(node.name()))
            || (node.kind() == K::VariableStatement
                && node.modifier_flags().intersects(ModifierFlags::EXPORT))
            || (ast::is_property_access_expression(node)
                && ["call", "apply", "bind", "constructor"].contains(&node.name().text()))
            || (ast::is_heritage_clause(node)
                && node.token() == K::ExtendsKeyword
                && ast::is_class_like(node.parent()))
        {
            needed = true;
        }
        for child in node.iter_children() {
            needed |= self.inspect_syntax(child);
        }
        needed
    }

    #[expect(
        clippy::excessive_nesting,
        reason = "The native SDK and AST traversal retains its explicit semantic branches in this feasibility port."
    )]
    fn visit(&mut self, node: Node) {
        if ast::is_type_node(node) || ast::is_interface_declaration(node) {
            return;
        }
        if ast::is_call_expression(node) || ast::is_new_expression(node) {
            self.inspect_sdk_callbacks(node);
            self.inspect_runtime_code(node);
        }
        if ast::is_call_expression(node) {
            self.inspect_opaque_callbacks(node);
            self.inspect_default_sort(node);
        }
        if named_value(node) {
            self.inspect_import_meta(node);
        }
        if ast::is_property_assignment(node)
            && ast::is_object_literal_expression(node.parent())
            && matches!(node.name().kind(), K::Identifier | K::StringLiteral)
            && node.name().text() == "__proto__"
            && !self.literal_data(node.initializer())
        {
            self.reason("SOURCE_PROTOTYPE_MUTATION_UNSUPPORTED");
        }
        if ast::is_function_declaration(node) && node.body().is_nil() {
            let declared = node.name().is_some()
                && self.origins(node.name()).into_iter().any(|origin| {
                    ast::is_function_declaration(origin)
                        && origin.body().is_some()
                        && self.internal(origin)
                        && !origin.modifier_flags().intersects(ModifierFlags::AMBIENT)
                });
            if !declared {
                self.reason("SOURCE_AMBIENT_FUNCTION_UNSUPPORTED");
            }
        }
        if self.runtime_property(node)
            && ((ast::is_element_access_expression(node)
                && !self.property_key(node.argument_expression()))
                || (ast::is_computed_property_name(node) && !self.property_key(node.expression())))
        {
            self.reason("SOURCE_PROPERTY_KEY_UNSUPPORTED");
        }
        if ast::is_computed_property_name(node)
            && self.runtime_property(node)
            && self.protocol_key(node.expression(), false)
        {
            let parent = node.parent();
            if ast::is_method_declaration(parent)
                || (ast::is_property_assignment(parent) && !self.primitive(parent.initializer()))
                || (ast::is_property_declaration(parent)
                    && parent.initializer().is_some()
                    && !self.primitive(parent.initializer()))
            {
                self.reason("SOURCE_PROTOCOL_DEFINITION_UNSUPPORTED");
            }
        }
        if assignment(node) {
            let target = unwrap(node.left());
            let name = self.static_name(target);
            if name.as_deref() == Some("then") && !self.primitive(node.right()) {
                self.reason("SOURCE_THENABLE_MUTATION_UNSUPPORTED");
            }
            if member(target)
                && name.as_deref() == Some("href")
                && self.sdk_origin(target.expression())
            {
                let receiver = self.actual(target.expression());
                let symbol = self.property(receiver, "href");
                if self.declared_on(symbol, &["Location"]) {
                    let url = self.constant_string(node.right());
                    if unsafe_script_navigation(url.as_deref()) {
                        self.reason("SOURCE_SCRIPT_NAVIGATION_UNSUPPORTED");
                    }
                }
            }
            if self.sdk_global_assignment(target) {
                self.reason("SOURCE_SDK_GLOBAL_MUTATION_UNSUPPORTED");
            }
            if ast::is_element_access_expression(target)
                && self.protocol_key(target.argument_expression(), true)
            {
                self.reason("SOURCE_ITERATOR_MUTATION_UNSUPPORTED");
            } else if ast::is_element_access_expression(target)
                && self.protocol_key(target.argument_expression(), false)
            {
                self.reason("SOURCE_PROTOCOL_MUTATION_UNSUPPORTED");
            }
            if self.sdk_callable_property(target) && !self.primitive(node.right()) {
                self.reason("SOURCE_SDK_CALLABLE_MUTATION_UNSUPPORTED");
            }
        }
        if (coercing_binary(node)
            && (!self.primitive(node.left()) || !self.primitive(node.right())))
            || (ast::is_binary_expression(node)
                && node.operator_token().kind() == K::InKeyword
                && !self.property_key(node.left()))
            || (numeric_unary(node) && !self.primitive(node.operand()))
            || (node.kind() == K::TemplateExpression
                && node
                    .template_spans()
                    .nodes()
                    .to_vec()
                    .iter()
                    .any(|span| !self.primitive(span.expression())))
        {
            self.reason("SOURCE_COERCION_UNSUPPORTED");
        }
        if (node.kind() == K::ReturnStatement
            && node.expression().is_some()
            && async_owner(node)
            && !self.safe_await(node.expression()))
            || (node.kind() == K::ArrowFunction
                && node.body().kind() != K::Block
                && is_async(node)
                && !self.safe_await(node.body()))
        {
            self.reason("SOURCE_ASYNC_RETURN_UNSUPPORTED");
        }
        if named_value(node) {
            if self.service_worker_loader(node) {
                self.reason("SOURCE_SERVICE_WORKER_LOADER_UNSUPPORTED");
            }
            if self.worklet_loader(node) {
                self.reason("SOURCE_WORKLET_LOADER_UNSUPPORTED");
            }
            let symbol = self.sdk_value(node);
            if self.symbol_name(symbol) == "importScripts" {
                self.reason("SOURCE_WORKER_LOADER_UNSUPPORTED");
            }
            self.inspect_descriptor(node);
            self.inspect_reflect_set(node);
            self.inspect_meta_object(node);
            self.inspect_builtin_process(node);
            self.inspect_promise_resolve(node);
            self.inspect_serializer(node);
            self.inspect_combinator(node);
            self.inspect_mutation(node);
            if self.proxy_factory(node) {
                self.reason("SOURCE_PROXY_UNSUPPORTED");
            }
        }
        if node.kind() == K::AwaitExpression && !self.safe_await(node.expression()) {
            self.reason("SOURCE_AWAIT_UNSUPPORTED");
        }
        if ast::is_binary_expression(node)
            && node.operator_token().kind() == K::InstanceOfKeyword
            && self.sdk_constructor(node.right()).is_nil()
        {
            self.reason("SOURCE_INSTANCEOF_UNSUPPORTED");
        }
        if ast::is_array_binding_pattern(node) {
            let value = self.binding_value(node);
            if value.is_nil() || !self.intrinsic_iterable(value) {
                self.reason("SOURCE_ITERATION_UNSUPPORTED");
            }
        }
        if (ast::is_binary_expression(node)
            && node.operator_token().kind() == K::EqualsToken
            && ast::is_array_literal_expression(node.left())
            && !self.intrinsic_iterable(node.right()))
            || (node.kind() == K::YieldExpression
                && node.asterisk_token().is_some()
                && (node.expression().is_nil() || !self.intrinsic_iterable(node.expression())))
        {
            self.reason("SOURCE_ITERATION_UNSUPPORTED");
        }
        if named_value(node) && self.reflected_invocation(node) {
            self.reason("SOURCE_REFLECT_INVOCATION_UNSUPPORTED");
        }
        if (ast::is_for_of_statement(node) || ast::is_spread_element(node))
            && !self.intrinsic_iterable(node.expression())
        {
            self.reason("SOURCE_ITERATION_UNSUPPORTED");
        }
        if ast::is_for_of_statement(node) && node.await_modifier().is_some() {
            let iterable = unwrap(node.expression());
            let safe = ast::is_array_literal_expression(iterable)
                && iterable.elements().to_vec().iter().all(|item| {
                    ast::is_omitted_expression(*item)
                        || (!ast::is_spread_element(*item) && self.safe_await(*item))
                });
            if !safe && !self.primitive(iterable) {
                self.reason("SOURCE_AWAIT_UNSUPPORTED");
            }
        }
        if ast::is_new_expression(node) {
            let origin = self.sdk_constructor(node.expression());
            let name = self.symbol_name(origin);
            if origin.is_nil() {
                self.reason("SOURCE_CONSTRUCTION_UNSUPPORTED");
            } else if name == "Date" {
                if !self.intrinsic_date_copy(node)
                    && node
                        .arguments()
                        .to_vec()
                        .iter()
                        .take(7)
                        .any(|argument| !self.primitive(*argument))
                {
                    self.reason("SOURCE_COERCION_UNSUPPORTED");
                }
            } else if ["Worker", "SharedWorker"].contains(&name.as_str()) {
                self.reason("SOURCE_WORKER_LOADER_UNSUPPORTED");
            } else if name == "Proxy" {
                self.reason("SOURCE_PROXY_UNSUPPORTED");
            }
        }
        if named_value(node) {
            self.inspect_timer(node);
        }
        if ast::is_property_access_expression(node) && self.function_helper(node) {
            self.reason("SOURCE_FUNCTION_HELPER_UNSUPPORTED");
        }
        if member(node) && self.intrinsic_constructor(node) {
            self.reason("SOURCE_DYNAMIC_EVALUATION_UNSUPPORTED");
        }
        if ast::is_heritage_clause(node)
            && node.token() == K::ExtendsKeyword
            && ast::is_class_like(node.parent())
        {
            for base in node.types().nodes().to_vec().iter() {
                if self.internal_base(base.expression(), &mut HashSet::new()) {
                    self.reason("SOURCE_INTERNAL_HERITAGE_UNSUPPORTED");
                }
            }
        }
        for child in node.iter_children() {
            self.visit(child);
        }
    }
}

fn execution_module(name: &str) -> Option<&'static str> {
    match name {
        "child_process" | "node:child_process" => Some("SOURCE_PROCESS_LAUNCH_UNSUPPORTED"),
        "vm" | "node:vm" => Some("SOURCE_RUNTIME_EVALUATION_UNSUPPORTED"),
        _ => None,
    }
}

fn unsafe_script_navigation(value: Option<&str>) -> bool {
    let Some(value) = value else {
        return true;
    };
    let normalized: String = value
        .chars()
        .filter(|c| !matches!(c, '\t' | '\n' | '\r'))
        .collect();
    let normalized = normalized.trim_start_matches(|c| c <= '\u{20}');
    let Some((scheme, _)) = normalized.split_once(':') else {
        return false;
    };
    let mut chars = scheme.chars();
    if !chars.next().is_some_and(|c| c.is_ascii_alphabetic())
        || !chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-'))
    {
        return false;
    }
    !scheme.eq_ignore_ascii_case("http") && !scheme.eq_ignore_ascii_case("https")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    fn scan_code(source: &str) -> QualifiedScan {
        scan_code_with_proof_state(source, false, false)
    }

    #[expect(
        clippy::excessive_nesting,
        reason = "The captured SDK test context requires nested program and checker callbacks."
    )]
    fn scan_code_with_proof_state(
        source: &str,
        observed: bool,
        prove_inline: bool,
    ) -> QualifiedScan {
        use sha2::Digest;
        eprintln!(
            "{}",
            serde_json::json!({"kind":"qualified-development-input", "source":source,
            "sourceSha256":format!("{:x}", sha2::Sha256::digest(source.as_bytes())), "observed":observed,
            "proveInline":prove_inline, "sdk":"captured-typescript-5.9.3"})
        );
        let files = BTreeMap::from([("/repo/qualified-development.ts".into(), source.into())]);
        crate::development::with_sdk_project(
            files,
            vec!["/repo/qualified-development.ts".into()],
            move || {
                let source = program::get_source_file("/repo/qualified-development.ts");
                assert!(source.is_some());
                program::with_type_checker_for_file(source, move |checker| {
                    let mut inputs = QualifiedInputs {
                        retained_paths: BTreeSet::from(["/repo/qualified-development.ts".into()]),
                        case_sensitive: ts_goport::frontend::vfs::osvfs_fs()
                            .use_case_sensitive_file_names(),
                        retained_callable_coordinates_observed: observed,
                        inline_callback_ownership_observed: observed,
                        ..Default::default()
                    };
                    if prove_inline {
                        let mut nodes = vec![source];
                        while let Some(node) = nodes.pop() {
                            if node.kind() == K::ArrowFunction {
                                let map = ast::source_file_get_position_map(source);
                                inputs.inline_owned_callbacks.insert(QualifiedSpan {
                                    path: "/repo/qualified-development.ts".into(),
                                    start_utf16: map.utf8_to_utf16(astnav::get_start_of_node(
                                        node, source, false,
                                    )),
                                    end_utf16: map.utf8_to_utf16(node.end()),
                                });
                                break;
                            }
                            nodes.extend(node.iter_children());
                        }
                    }
                    inspect_semantic_dependencies(source, checker, &inputs)
                })
            },
        )
    }

    #[test]
    fn observed_callback_ownership_distinguishes_refusal_proof_from_unavailable_mechanism() {
        let source = "declare function foreign(callback:()=>number):void; function leaf(){return 1;} export function run(){ foreign(()=>leaf()); }";
        let unknown = scan_code_with_proof_state(source, false, false);
        assert!(
            unknown
                .unsupported
                .contains("OPAQUE_CALLBACK_GRAPH_OWNERSHIP_PROOF_UNAVAILABLE"),
            "{unknown:?}"
        );
        let refused = scan_code_with_proof_state(source, true, false);
        assert!(
            refused
                .reasons
                .contains("SOURCE_OPAQUE_CALLBACK_UNSUPPORTED"),
            "{refused:?}"
        );
        assert!(
            !refused
                .unsupported
                .contains("OPAQUE_CALLBACK_GRAPH_OWNERSHIP_PROOF_UNAVAILABLE"),
            "{refused:?}"
        );
        let proved = scan_code_with_proof_state(source, true, true);
        assert!(
            !proved
                .reasons
                .contains("SOURCE_OPAQUE_CALLBACK_UNSUPPORTED"),
            "{proved:?}"
        );
        assert!(
            !proved
                .unsupported
                .contains("OPAQUE_CALLBACK_GRAPH_OWNERSHIP_PROOF_UNAVAILABLE"),
            "{proved:?}"
        );
    }

    #[test]
    fn observed_missing_callable_coordinate_refuses_instead_of_claiming_unknown() {
        let source = "export function run(){ const value:any={}; value.missing(); }";
        let unknown = scan_code_with_proof_state(source, false, false);
        assert!(
            unknown
                .unsupported
                .contains("RETAINED_CALLABLE_COORDINATE_PROOF_UNAVAILABLE"),
            "{unknown:?}"
        );
        let refused = scan_code_with_proof_state(source, true, false);
        assert!(
            refused
                .reasons
                .contains("SOURCE_UNRESOLVED_CALLEE_UNSUPPORTED"),
            "{refused:?}"
        );
        assert!(
            !refused
                .unsupported
                .contains("RETAINED_CALLABLE_COORDINATE_PROOF_UNAVAILABLE"),
            "{refused:?}"
        );
    }

    fn scan_graph(source: &str, graph: serde_json::Value) -> QualifiedScan {
        use sha2::Digest;
        eprintln!(
            "{}",
            serde_json::json!({"kind":"qualified-graph-development-input", "source":source,
            "sourceSha256":format!("{:x}", sha2::Sha256::digest(source.as_bytes())), "graph":&graph,
            "graphSha256":format!("{:x}", sha2::Sha256::digest(serde_json::to_vec(&graph).unwrap())), "noLib":true})
        );
        let files = BTreeMap::from([("/repo/qualified-development.ts".into(), source.into())]);
        let retained_files = files.clone();
        crate::development::with_project(
            files,
            vec!["/repo/qualified-development.ts".into()],
            move || {
                let source = program::get_source_file("/repo/qualified-development.ts");
                program::with_type_checker_for_file(source, move |checker| {
                    let inputs = QualifiedInputs {
                        repository_root: "/repo".into(),
                        retained_files,
                        graph: Some(graph),
                        retained_paths: BTreeSet::from(["/repo/qualified-development.ts".into()]),
                        case_sensitive: ts_goport::frontend::vfs::osvfs_fs()
                            .use_case_sensitive_file_names(),
                        ..Default::default()
                    };
                    inspect_semantic_dependencies(source, checker, &inputs)
                })
            },
        )
    }

    fn callback_graph() -> serde_json::Value {
        serde_json::json!({"nodes":[
            {"id":"run","kind":"function","name":"run","filePath":"qualified-development.ts","metadata":{"scope":""}},
            {"id":"leaf","kind":"function","name":"leaf","filePath":"qualified-development.ts","metadata":{"scope":""}}
        ],"edges":[{"kind":"calls","from":"run","to":"leaf","evidence":[{"filePath":"qualified-development.ts","startLine":1}]}]})
    }

    #[test]
    fn inline_owned_requires_unique_owner_and_exact_call_evidence() {
        let source = "declare function foreign(callback:()=>number):void; function leaf(){return 1;} export function run(){ foreign(()=>leaf()); }";
        let proved = scan_graph(source, callback_graph());
        assert!(
            !proved
                .reasons
                .contains("SOURCE_OPAQUE_CALLBACK_UNSUPPORTED"),
            "{proved:?}"
        );
        assert!(
            !proved
                .unsupported
                .contains("OPAQUE_CALLBACK_GRAPH_OWNERSHIP_PROOF_UNAVAILABLE"),
            "{proved:?}"
        );
        let mut missing = callback_graph();
        missing["edges"] = serde_json::json!([]);
        let refused = scan_graph(source, missing);
        assert!(
            refused
                .reasons
                .contains("SOURCE_OPAQUE_CALLBACK_UNSUPPORTED"),
            "{refused:?}"
        );
        let mut wrong_line = callback_graph();
        wrong_line["edges"][0]["evidence"][0]["startLine"] = serde_json::json!(2);
        assert!(
            scan_graph(source, wrong_line)
                .reasons
                .contains("SOURCE_OPAQUE_CALLBACK_UNSUPPORTED")
        );
        let mut duplicate = callback_graph();
        let owner = duplicate["nodes"][0].clone();
        duplicate["nodes"].as_array_mut().unwrap().push(owner);
        assert!(
            scan_graph(source, duplicate)
                .reasons
                .contains("SOURCE_OPAQUE_CALLBACK_UNSUPPORTED")
        );
    }

    #[test]
    fn inline_owned_test_pair_requires_both_edges_and_a_callable_reference() {
        let source = "declare function foreign(callback:()=>unknown):void; function leaf(){return 1;} foreign(()=>leaf);";
        let graph = serde_json::json!({"nodes":[
            {"id":"test","kind":"test","name":"spec","filePath":"qualified-development.ts"},
            {"id":"leaf","kind":"function","name":"leaf","filePath":"qualified-development.ts","metadata":{"scope":""}}
        ],"edges":[{"kind":"covers","from":"test","to":"leaf"},{"kind":"tested_by","from":"leaf","to":"test"}]});
        let proved = scan_graph(source, graph.clone());
        assert!(
            !proved
                .reasons
                .contains("SOURCE_OPAQUE_CALLBACK_UNSUPPORTED"),
            "{proved:?}"
        );
        let mut one_way = graph.clone();
        one_way["edges"].as_array_mut().unwrap().pop();
        assert!(
            scan_graph(source, one_way)
                .reasons
                .contains("SOURCE_OPAQUE_CALLBACK_UNSUPPORTED")
        );
        let no_reference = "declare function foreign(callback:()=>unknown):void; function leaf(){return 1;} foreign(()=>1);";
        assert!(
            scan_graph(no_reference, graph)
                .reasons
                .contains("SOURCE_OPAQUE_CALLBACK_UNSUPPORTED")
        );
    }

    #[test]
    fn inline_owned_never_falls_back_through_property_owner_or_missing_named_owner() {
        let property = "declare function foreign(callback:()=>number):void; function leaf(){return 1;} const owner={run:()=>foreign(()=>leaf())};";
        let mut graph = callback_graph();
        graph["nodes"][0] = serde_json::json!({"id":"module","kind":"module","name":"mod","filePath":"qualified-development.ts"});
        graph["edges"][0]["from"] = serde_json::json!("module");
        assert!(
            scan_graph(property, graph.clone())
                .reasons
                .contains("SOURCE_OPAQUE_CALLBACK_UNSUPPORTED")
        );
        let named = "declare function foreign(callback:()=>number):void; function leaf(){return 1;} function missing(){foreign(()=>leaf());}";
        assert!(
            scan_graph(named, graph)
                .reasons
                .contains("SOURCE_OPAQUE_CALLBACK_UNSUPPORTED")
        );
    }

    #[test]
    fn sdk_callback_signature_refuses_sdk_map_and_preserves_owned_homonym() {
        let sdk = scan_code("export function run(){ return [1,2].map(value => value + 1); }");
        assert!(
            sdk.reasons.contains("SOURCE_SDK_CALLBACK_UNSUPPORTED"),
            "{sdk:?}"
        );
        let owned = scan_code(
            "const owned={map(value:number){ return value + 1; }}; export function run(){ return owned.map(2); }",
        );
        assert!(
            !owned.reasons.contains("SOURCE_SDK_CALLBACK_UNSUPPORTED"),
            "{owned:?}"
        );
        assert!(owned.unsupported.is_empty(), "{owned:?}");
    }

    #[test]
    fn runtime_typeof_refusal_proves_primitive_argument_but_annotation_alone_does_not() {
        let guarded = scan_code(
            "declare function sink(value:unknown):void; export function run(value:unknown){ if(typeof value !== 'string') throw 0; sink(value); }",
        );
        assert!(
            !guarded
                .reasons
                .contains("SOURCE_OPAQUE_CALLBACK_UNSUPPORTED"),
            "{guarded:?}"
        );
        let annotation = scan_code(
            "declare function sink(value:unknown):void; export function run(value:string){ sink(value); }",
        );
        assert!(
            annotation
                .reasons
                .contains("SOURCE_OPAQUE_CALLBACK_UNSUPPORTED"),
            "{annotation:?}"
        );
    }

    #[test]
    fn sdk_symbol_protocol_definition_and_plain_computed_key_are_distinct() {
        let protocol = scan_code("export const value = { [Symbol.iterator](){ return [1]; } };");
        assert!(
            protocol
                .reasons
                .contains("SOURCE_PROTOCOL_DEFINITION_UNSUPPORTED"),
            "{protocol:?}"
        );
        let plain =
            scan_code("const key='ordinary'; export const value = { [key](){ return 1; } };");
        assert!(
            !plain
                .reasons
                .contains("SOURCE_PROTOCOL_DEFINITION_UNSUPPORTED"),
            "{plain:?}"
        );
        assert!(
            !plain.reasons.contains("SOURCE_PROPERTY_KEY_UNSUPPORTED"),
            "{plain:?}"
        );
    }

    #[test]
    fn sdk_constructor_provenance_preserves_date_and_refuses_owned_construction() {
        let sdk = scan_code("export function run(){ return new Date(1); }");
        assert!(
            !sdk.reasons.contains("SOURCE_CONSTRUCTION_UNSUPPORTED"),
            "{sdk:?}"
        );
        let owned = scan_code(
            "class Date { constructor(value:number){} } export function run(){ return new Date(1); }",
        );
        assert!(
            owned.reasons.contains("SOURCE_CONSTRUCTION_UNSUPPORTED"),
            "{owned:?}"
        );
    }

    #[test]
    fn computed_sdk_destructuring_does_not_prove_a_transparent_constructor_binding() {
        let value = scan_code(
            "const key='Instance'; const {[key]: Constructor}=WebAssembly; export function run(){ return new Constructor({} as WebAssembly.Module); }",
        );
        assert!(
            value.reasons.contains("SOURCE_CONSTRUCTION_UNSUPPORTED"),
            "{value:?}"
        );
    }

    #[test]
    fn descriptors_distinguish_literal_data_from_getter_execution() {
        let data = scan_code(
            "export function run(){ return Object.defineProperty({}, 'value', {value:1}); }",
        );
        assert!(
            !data
                .reasons
                .contains("SOURCE_DESCRIPTOR_ACCESSOR_UNSUPPORTED"),
            "{data:?}"
        );
        let getter = scan_code(
            "export function run(){ return Object.defineProperty({}, 'value', {get(){return 1;}}); }",
        );
        assert!(
            getter
                .reasons
                .contains("SOURCE_DESCRIPTOR_ACCESSOR_UNSUPPORTED"),
            "{getter:?}"
        );
    }

    #[test]
    fn runtime_builtin_execution_is_distinct_from_type_only_import() {
        let runtime = scan_code(
            "import {exec} from 'node:child_process'; export function run(){ exec('id'); }",
        );
        assert!(
            runtime
                .reasons
                .contains("SOURCE_PROCESS_LAUNCH_UNSUPPORTED"),
            "{runtime:?}"
        );
        let types =
            scan_code("import type {exec} from 'node:child_process'; export type Fn=typeof exec;");
        assert!(
            !types.reasons.contains("SOURCE_PROCESS_LAUNCH_UNSUPPORTED"),
            "{types:?}"
        );
    }

    #[test]
    fn navigation_strips_browser_control_whitespace_before_reading_the_scheme() {
        assert!(unsafe_script_navigation(Some(
            " \u{0}\tjava\rscript:alert(1)"
        )));
        assert!(unsafe_script_navigation(None));
        assert!(!unsafe_script_navigation(Some("HTTPS://example.test")));
        assert!(!unsafe_script_navigation(Some("/relative/path")));
        assert!(!unsafe_script_navigation(Some("1invalid:scheme")));
    }
}
