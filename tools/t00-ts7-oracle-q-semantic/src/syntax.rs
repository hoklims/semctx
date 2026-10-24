use crate::facts::reference;
use serde_json::{Value, json};
use ts_goport::prelude::*;

fn references(nodes: NodeSlice, file: Node) -> Value {
    Value::Array(nodes.iter().map(|node| reference(node, file)).collect())
}

pub fn fields(node: Node, file: Node) -> Value {
    let mut fields = json!({
        "name":reference(node.name(),file),
        "expression":reference(node.expression(),file),
        "initializer":reference(node.initializer(),file),
        "body":reference(node.body(),file),
        "type":reference(node.type_(),file),
        "propertyName":reference(node.property_name(),file),
        "arguments":references(node.arguments(),file),
        "parameters":references(node.parameters(),file),
        "members":references(node.members(),file),
        "properties":references(node.properties(),file),
        "elements":references(node.elements(),file),
        "modifiers":references(node.modifiers().nodes(),file),
        "statements":references(node.statements(),file),
        "typeParameters":references(node.type_parameters(),file),
        "typeArguments":references(node.type_arguments(),file),
        "tagName":reference(node.tag_name(),file),
        "moduleSpecifier":reference(node.module_specifier(),file),
        "importClause":reference(node.import_clause(),file),
        "statement":reference(node.statement(),file),
        "attributes":reference(node.attributes(),file)
    });
    if matches!(
        node.kind(),
        SyntaxKind::BinaryExpression | SyntaxKind::QualifiedName
    ) {
        fields["left"] = reference(node.left(), file);
        fields["right"] = reference(node.right(), file);
    }
    if node.kind() == SyntaxKind::BinaryExpression {
        fields["operatorToken"] = reference(node.operator_token(), file);
    }
    if matches!(
        node.kind(),
        SyntaxKind::PrefixUnaryExpression | SyntaxKind::PostfixUnaryExpression
    ) {
        fields["operand"] = reference(node.operand(), file);
    }
    if node.kind() == SyntaxKind::ElementAccessExpression {
        fields["argumentExpression"] = reference(node.argument_expression(), file);
    }
    if node.kind() == SyntaxKind::VariableStatement {
        fields["declarationList"] = reference(node.declaration_list(), file);
    }
    if node.kind() == SyntaxKind::VariableDeclarationList {
        fields["declarations"] = references(node.declarations().nodes(), file);
    }
    if matches!(
        node.kind(),
        SyntaxKind::Parameter | SyntaxKind::BindingElement
    ) {
        fields["dotDotDotToken"] = reference(node.dot_dot_dot_token(), file);
    }
    match node.kind() {
        SyntaxKind::ImportClause => {
            fields["namedBindings"] = reference(node.named_bindings(), file)
        }
        SyntaxKind::ExportDeclaration => {
            fields["exportClause"] = reference(node.export_clause(), file)
        }
        SyntaxKind::ImportEqualsDeclaration => {
            fields["moduleReference"] = reference(node.module_reference(), file)
        }
        SyntaxKind::JsxNamespacedName => fields["namespace"] = reference(node.namespace(), file),
        SyntaxKind::TaggedTemplateExpression => {
            fields["tag"] = reference(node.tag(), file);
            fields["template"] = reference(node.template(), file);
        }
        SyntaxKind::TemplateExpression | SyntaxKind::TemplateLiteralType => {
            fields["head"] = reference(node.head(), file);
            fields["templateSpans"] = references(node.template_spans().nodes(), file);
        }
        SyntaxKind::TemplateSpan
        | SyntaxKind::LiteralType
        | SyntaxKind::TemplateLiteralTypeSpan => {
            fields["literal"] = reference(node.literal(), file);
        }
        SyntaxKind::ClassDeclaration
        | SyntaxKind::ClassExpression
        | SyntaxKind::InterfaceDeclaration => {
            fields["heritageClauses"] = references(node.heritage_clauses().nodes(), file);
        }
        SyntaxKind::HeritageClause | SyntaxKind::UnionType | SyntaxKind::IntersectionType => {
            fields["types"] = references(node.types().nodes(), file);
        }
        SyntaxKind::ForOfStatement | SyntaxKind::ForInStatement => {
            fields["awaitModifier"] = reference(node.await_modifier(), file);
        }
        SyntaxKind::IfStatement => {
            fields["thenStatement"] = reference(node.then_statement(), file);
            fields["elseStatement"] = reference(node.else_statement(), file);
        }
        SyntaxKind::ConditionalExpression => {
            fields["condition"] = reference(node.condition(), file);
            fields["whenTrue"] = reference(node.when_true(), file);
            fields["whenFalse"] = reference(node.when_false(), file);
        }
        SyntaxKind::ForStatement => {
            fields["condition"] = reference(node.condition(), file);
            fields["incrementor"] = reference(node.incrementor(), file);
        }
        SyntaxKind::ShorthandPropertyAssignment => {
            fields["objectAssignmentInitializer"] =
                reference(node.object_assignment_initializer(), file);
        }
        _ => {}
    }
    if matches!(
        node.kind(),
        SyntaxKind::FunctionDeclaration
            | SyntaxKind::Constructor
            | SyntaxKind::GetAccessor
            | SyntaxKind::SetAccessor
            | SyntaxKind::MethodDeclaration
            | SyntaxKind::YieldExpression
            | SyntaxKind::ArrowFunction
            | SyntaxKind::FunctionExpression
            | SyntaxKind::ModuleDeclaration
    ) {
        fields["asteriskToken"] = reference(node.asterisk_token(), file);
    }
    fields
}

pub fn values(node: Node) -> Value {
    let mut values = json!({"isTypeOnly":node.is_type_only()});
    if node.kind() == SyntaxKind::MetaProperty {
        values["keywordToken"] = json!(format!("{:?}", node.keyword_token()));
    }
    if matches!(
        node.kind(),
        SyntaxKind::HeritageClause | SyntaxKind::ImportAttributes
    ) {
        values["token"] = json!(format!("{:?}", node.token()));
    }
    if node.kind() == SyntaxKind::ExportAssignment {
        values["isExportEquals"] = json!(node.is_export_equals());
    }
    values
}

pub fn constants() -> Value {
    json!({
        "useCaseSensitiveFileNames":true,
        "typeFlags":{
            "Any":TypeFlags::ANY.0,"Unknown":TypeFlags::UNKNOWN.0,
            "TypeParameter":TypeFlags::TYPE_PARAMETER.0,"Object":TypeFlags::OBJECT.0,
            "StringLike":TypeFlags::STRING_LIKE.0,"NumberLike":TypeFlags::NUMBER_LIKE.0,
            "BooleanLike":TypeFlags::BOOLEAN_LIKE.0,"BigIntLike":TypeFlags::BIG_INT_LIKE.0,
            "ESSymbolLike":TypeFlags::ES_SYMBOL_LIKE.0,"Null":TypeFlags::NULL.0,
            "Undefined":TypeFlags::UNDEFINED.0,"Union":TypeFlags::UNION.0,
            "Intersection":TypeFlags::INTERSECTION.0
        },
        "symbolFlags":{"Alias":SymbolFlags::ALIAS.0},
        "modifierFlags":{"Default":ModifierFlags::DEFAULT.0},
        "nodeFlags":{"Const":NodeFlags::CONST.0,"Using":NodeFlags::USING.0}
    })
}
