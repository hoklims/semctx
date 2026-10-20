use std::collections::BTreeSet;
use ts_goport::{
    ast, astdata::SyntaxKind, core::Node, options::CompilerOptions,
    printer::emit_context::EmitContext,
};

#[derive(Debug, Default, serde::Serialize)]
pub struct HelperRequests {
    pub names: BTreeSet<String>,
    pub unsupported: BTreeSet<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Expression {
    PackedArray,
    Array,
    ReadHelper,
    SpreadArrayHelper,
    Other,
}

pub fn collect(source: Node, options: &CompilerOptions, context: &EmitContext) -> HelperRequests {
    if source.is_nil() {
        return HelperRequests {
            unsupported: BTreeSet::from([
                "RUNTIME_HELPERS_ES5_TRANSFORMED_SOURCE_UNAVAILABLE".into()
            ]),
            ..Default::default()
        };
    }
    let mut collector = Collector {
        requests: HelperRequests::default(),
        downlevel_iteration: options.downlevel_iteration.is_true(),
        context,
    };
    collector.visit(source);
    collector.requests
}

struct Collector<'a> {
    requests: HelperRequests,
    downlevel_iteration: bool,
    context: &'a EmitContext,
}

impl Collector<'_> {
    fn request(&mut self, name: &str) {
        self.requests.names.insert(name.into());
    }

    fn visit(&mut self, node: Node) -> Expression {
        if node.is_nil() {
            return Expression::Other;
        }
        if ast::is_function_like_declaration(node)
            && !node.asterisk_token().is_nil()
            && !node.body().is_nil()
        {
            self.request("typescript:generator");
        }
        match node.kind() {
            SyntaxKind::ClassDeclaration | SyntaxKind::ClassExpression
                if !ast::get_class_extends_heritage_element(node).is_nil() =>
            {
                self.request("typescript:extends");
            }
            SyntaxKind::ForOfStatement => {
                if self.downlevel_iteration {
                    self.request("typescript:values");
                }
                let initializer = node.initializer();
                if matches!(
                    initializer.kind(),
                    SyntaxKind::ArrayLiteralExpression | SyntaxKind::ObjectLiteralExpression
                ) {
                    self.assignment_pattern(initializer);
                } else {
                    self.visit(initializer);
                }
                self.visit(node.expression());
                self.visit(node.statement());
                return Expression::Other;
            }
            SyntaxKind::Parameter if ast::is_binding_pattern(node.name()) => {
                let name = node.name();
                if !name.elements().is_empty() || !node.dot_dot_dot_token().is_nil() {
                    self.pattern(name);
                }
                self.visit(node.initializer());
                return Expression::Other;
            }
            SyntaxKind::TaggedTemplateExpression => {
                self.request("typescript:makeTemplateObject");
            }
            SyntaxKind::ArrayBindingPattern | SyntaxKind::ObjectBindingPattern => {
                self.pattern(node);
                return Expression::Other;
            }
            SyntaxKind::BinaryExpression
                if node.operator_token().kind() == SyntaxKind::EqualsToken
                    && matches!(
                        node.left().kind(),
                        SyntaxKind::ArrayLiteralExpression | SyntaxKind::ObjectLiteralExpression
                    ) =>
            {
                self.assignment_pattern(node.left());
                self.visit(node.right());
                return Expression::Other;
            }
            SyntaxKind::ArrayLiteralExpression => {
                let elements = node.elements().iter().collect::<Vec<_>>();
                if elements
                    .iter()
                    .any(|node| node.kind() == SyntaxKind::SpreadElement)
                {
                    return self.spread(&elements, false, false);
                }
                for element in &elements {
                    self.visit(*element);
                }
                return if elements
                    .iter()
                    .all(|node| node.kind() != SyntaxKind::OmittedExpression)
                {
                    Expression::PackedArray
                } else {
                    Expression::Array
                };
            }
            SyntaxKind::CallExpression | SyntaxKind::NewExpression => {
                if self.native_assign_helper(node) {
                    self.request("typescript:assign");
                }
                self.visit(node.expression());
                let arguments = node.arguments().iter().collect::<Vec<_>>();
                if arguments
                    .iter()
                    .any(|node| node.kind() == SyntaxKind::SpreadElement)
                {
                    self.spread(&arguments, true, node.kind() == SyntaxKind::NewExpression);
                } else {
                    for argument in arguments {
                        self.visit(argument);
                    }
                }
                if self.context.is_call_to_helper(node, "__read") {
                    return Expression::ReadHelper;
                }
                if self.context.is_call_to_helper(node, "__spreadArray") {
                    return Expression::SpreadArrayHelper;
                }
                return Expression::Other;
            }
            _ => {}
        }
        for child in node.iter_children() {
            self.visit(child);
        }
        Expression::Other
    }

    fn native_assign_helper(&self, node: Node) -> bool {
        let node = self.context.most_original(node);
        if node.kind() != SyntaxKind::CallExpression {
            return false;
        }
        let callee = node.expression();
        if callee.kind() != SyntaxKind::PropertyAccessExpression {
            return false;
        }
        let owner = callee.expression();
        let name = callee.name();
        if owner.kind() != SyntaxKind::Identifier
            || name.kind() != SyntaxKind::Identifier
            || owner.text() != "Object"
            || name.text() != "assign"
        {
            return false;
        }
        let nodes = [node, callee, owner, name];
        let provenance = nodes.map(|node| {
            ast::is_synthetic_node(node)
                && node.pos() == -1
                && node.end() == -1
                && self.context.original(node).is_nil()
        });
        #[cfg(test)]
        eprintln!(
            "{}",
            serde_json::json!({"kind":"native-assign-factory-provenance","factoryNodes":provenance,
            "ranges":nodes.map(|node|[node.pos(),node.end()])})
        );
        provenance.into_iter().all(|generated| generated)
    }

    fn assignment_pattern(&mut self, node: Node) {
        let empty = match node.kind() {
            SyntaxKind::ArrayLiteralExpression => node.elements().is_empty(),
            SyntaxKind::ObjectLiteralExpression => node.properties().is_empty(),
            _ => false,
        };
        if !empty {
            self.pattern(node);
        }
    }

    fn pattern(&mut self, node: Node) {
        if node.is_nil() {
            return;
        }
        match node.kind() {
            SyntaxKind::ArrayLiteralExpression | SyntaxKind::ArrayBindingPattern => {
                if self.downlevel_iteration {
                    self.request("typescript:read");
                }
                for element in node.elements().iter() {
                    self.pattern(element);
                }
            }
            SyntaxKind::ObjectLiteralExpression => {
                for property in node.properties().iter() {
                    self.pattern(property);
                }
            }
            SyntaxKind::ObjectBindingPattern => {
                for element in node.elements().iter() {
                    self.pattern(element);
                }
            }
            SyntaxKind::BindingElement => {
                let property = node.property_name();
                if !property.is_nil() {
                    self.visit(property);
                }
                self.pattern(node.name());
                let initializer = node.initializer();
                if !initializer.is_nil() {
                    self.visit(initializer);
                }
            }
            SyntaxKind::PropertyAssignment => {
                self.visit(node.name());
                self.pattern(node.initializer());
            }
            SyntaxKind::SpreadElement
            | SyntaxKind::SpreadAssignment
            | SyntaxKind::ParenthesizedExpression => {
                self.pattern(node.expression());
            }
            SyntaxKind::BinaryExpression
                if node.operator_token().kind() == SyntaxKind::EqualsToken =>
            {
                self.pattern(node.left());
                self.visit(node.right());
            }
            _ => {
                self.visit(node);
            }
        }
    }

    fn spread(&mut self, elements: &[Node], argument_list: bool, prepend_void: bool) -> Expression {
        let mut segments = Vec::new();
        let mut non_spread = prepend_void;
        for element in elements {
            if element.kind() != SyntaxKind::SpreadElement {
                self.visit(*element);
                non_spread = true;
                continue;
            }
            if non_spread {
                segments.push(Expression::PackedArray);
                non_spread = false;
            }
            let mut expression = self.visit(element.expression());
            if self.downlevel_iteration
                && !matches!(
                    expression,
                    Expression::PackedArray | Expression::Array | Expression::ReadHelper
                )
            {
                self.request("typescript:read");
                expression = Expression::ReadHelper;
            }
            segments.push(expression);
        }
        if non_spread {
            segments.push(Expression::PackedArray);
        }
        if let [first] = segments.as_slice()
            && (argument_list && !self.downlevel_iteration
                || matches!(
                    first,
                    Expression::PackedArray | Expression::SpreadArrayHelper
                ))
        {
            return *first;
        }
        if !segments.is_empty() {
            self.request("typescript:spreadArray");
            Expression::SpreadArrayHelper
        } else {
            self.requests
                .unsupported
                .insert("RUNTIME_HELPERS_ES5_SPREAD_SEGMENTS_UNAVAILABLE".into());
            Expression::Other
        }
    }
}

pub fn lower_template_import_surface(text: &str) -> Result<String, String> {
    use ts_goport::{
        flags::ScriptKind,
        frontend::{
            parser::{SourceFileParseOptions, parse_source_file},
            tspath::Path,
        },
    };
    let parsed = parse_source_file(
        &SourceFileParseOptions {
            file_name: "/runtime-helper-import-surface.tsx".into(),
            path: Path("/runtime-helper-import-surface.tsx".into()),
            ..Default::default()
        },
        ast::FileText::new(text.to_owned(), false),
        ScriptKind::TSX,
    );
    if !parsed.diagnostics.is_empty() {
        return Err("RUNTIME_HELPERS_ES5_IMPORT_SURFACE_PARSE_UNAVAILABLE".into());
    }
    let mut replacements = Vec::new();
    template_replacements(parsed.root, parsed.root, false, &mut replacements)?;
    replacements.sort_by_key(|replacement| replacement.0);
    let mut result = String::new();
    let mut cursor = 0;
    for (start, end, replacement) in replacements {
        let (Ok(start), Ok(end)) = (usize::try_from(start), usize::try_from(end)) else {
            return Err("RUNTIME_HELPERS_ES5_TEMPLATE_RANGE_UNAVAILABLE".into());
        };
        if start < cursor
            || end < start
            || end > text.len()
            || !text.is_char_boundary(start)
            || !text.is_char_boundary(end)
        {
            return Err("RUNTIME_HELPERS_ES5_TEMPLATE_RANGE_UNAVAILABLE".into());
        }
        result.push_str(&text[cursor..start]);
        result.push_str(&replacement);
        cursor = end;
    }
    result.push_str(&text[cursor..]);
    Ok(result)
}

fn template_replacements(
    node: Node,
    source_file: Node,
    tagged: bool,
    replacements: &mut Vec<(i32, i32, String)>,
) -> Result<(), String> {
    if node.kind() == SyntaxKind::TaggedTemplateExpression {
        template_replacements(node.tag(), source_file, false, replacements)?;
        template_replacements(node.template(), source_file, true, replacements)?;
        return Ok(());
    }
    if tagged && node.kind() == SyntaxKind::NoSubstitutionTemplateLiteral {
        let argument = template_object_argument(&[node], source_file)?;
        replacements.push((node.pos(), node.end(), format!("({argument})")));
        return Ok(());
    }
    if node.kind() == SyntaxKind::TemplateExpression {
        let head = node.head();
        let opening = if tagged {
            let mut literals = vec![head];
            literals.extend(
                node.template_spans()
                    .nodes()
                    .iter()
                    .map(|span| span.literal()),
            );
            format!("({},", template_object_argument(&literals, source_file)?)
        } else {
            format!("{}.concat(", serde_json::Value::String(head.text().into()))
        };
        replacements.push((head.pos(), head.end(), opening));
        for span in node.template_spans().nodes().iter() {
            template_replacements(span.expression(), source_file, false, replacements)?;
            let literal = span.literal();
            let ending = if literal.kind() == SyntaxKind::TemplateTail {
                ")"
            } else if tagged {
                ","
            } else {
                ").concat("
            };
            let cooked = if tagged || literal.text().is_empty() {
                String::new()
            } else {
                format!(",{}", serde_json::Value::String(literal.text().into()))
            };
            replacements.push((literal.pos(), literal.end(), format!("{cooked}{ending}")));
        }
        return Ok(());
    }
    for child in node.iter_children() {
        template_replacements(child, source_file, false, replacements)?;
    }
    Ok(())
}

fn template_object_argument(literals: &[Node], source_file: Node) -> Result<String, String> {
    use ts_goport::{flags::TokenFlags, scanner_util::get_source_text_of_node_from_source_file};
    let mut cooked = Vec::new();
    let mut raw = Vec::new();
    for &literal in literals {
        cooked.push(
            if literal.template_flags().intersects(TokenFlags::IS_INVALID) {
                "void 0".into()
            } else {
                serde_json::Value::String(literal.text().into()).to_string()
            },
        );
        let mut raw_text = literal.raw_text().to_string();
        if raw_text.is_empty() {
            let token = get_source_text_of_node_from_source_file(source_file, literal, false);
            let end_length = if matches!(
                literal.kind(),
                SyntaxKind::NoSubstitutionTemplateLiteral | SyntaxKind::TemplateTail
            ) {
                1
            } else {
                2
            };
            let Some(end) = token.len().checked_sub(end_length) else {
                return Err("RUNTIME_HELPERS_ES5_TEMPLATE_RAW_UNAVAILABLE".into());
            };
            let Some(text) = token.get(1..end) else {
                return Err("RUNTIME_HELPERS_ES5_TEMPLATE_RAW_UNAVAILABLE".into());
            };
            raw_text = text.to_owned();
        }
        raw.push(
            serde_json::Value::String(raw_text.replace("\r\n", "\n").replace('\r', "\n"))
                .to_string(),
        );
    }
    Ok(format!(
        "__makeTemplateObject([{}],[{}])",
        cooked.join(","),
        raw.join(",")
    ))
}
