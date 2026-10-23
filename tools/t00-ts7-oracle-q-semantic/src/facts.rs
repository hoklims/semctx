use serde_json::{Value, json};
use ts_goport::{prelude::*, scanner_util::get_token_pos_of_node};

pub fn reference(node: Node, file: Node) -> Value {
    if node.is_nil() {
        return Value::Null;
    }
    json!({"kind":format!("{:?}",node.kind()),"start":get_token_pos_of_node(node,file,false),"end":node.end()})
}

fn references(nodes: NodeSlice, file: Node) -> Value {
    Value::Array(nodes.iter().map(|node| reference(node, file)).collect())
}

pub fn syntax(node: Node, file: Node) -> Value {
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
        "statements":references(node.statements(),file)
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
    fields
}

pub fn declaration(node: Node) -> Value {
    if node.is_nil() {
        return Value::Null;
    }
    let file = get_source_file_of_node(node);
    let path = source_file_file_name(file);
    let mut fact = reference(node, file);
    fact["path"] = json!(path);
    fact["sdk"] = json!(path.starts_with("/sdk/lib/"));
    fact["defaultLibrary"] = json!(is_source_file_default_library(&source_file_info(file).path));
    let parent = node.parent();
    fact["parent"] = reference(parent, file);
    if parent.is_some() {
        fact["parentKind"] = json!(format!("{:?}", parent.kind()));
        if parent.name().is_some() {
            fact["parentName"] = json!(parent.name().text());
        }
    }
    fact
}

pub fn symbol(checker: &Checker, id: SymbolId) -> Value {
    if !id.is_some() {
        return Value::Null;
    }
    let data = checker.sym(id);
    let declarations: Vec<Value> = data
        .declarations
        .iter()
        .map(|node| declaration(*node))
        .collect();
    json!({"name":data.name.to_string(),"flags":format!("{:?}",data.flags),"flagsBits":data.flags.0,"declarations":declarations})
}

fn type_basic(checker: &mut Checker, id: TypeId) -> Value {
    if !id.is_some() {
        return Value::Null;
    }
    let data = checker.ty(id);
    let flags = data.flags;
    let symbol = symbol(checker, data.symbol);
    json!({"text":checker.type_to_string(id),"flags":format!("{flags:?}"),"flagsBits":flags.0,"symbol":symbol})
}

fn type_summary(checker: &mut Checker, id: TypeId) -> Value {
    let mut fact = type_basic(checker, id);
    if !id.is_some() {
        return fact;
    }
    fact["callSignatureCount"] = json!(
        checker
            .get_signatures_of_type_exported(id, SignatureKind::CALL)
            .len()
    );
    fact["constructSignatureCount"] = json!(
        checker
            .get_signatures_of_type_exported(id, SignatureKind::CONSTRUCT)
            .len()
    );
    let number = checker.get_number_type();
    let number_index = checker.get_index_type_of_type_exported(id, number);
    fact["numberIndexType"] = type_basic(checker, number_index);
    let properties = checker.get_properties_of_type_exported(id);
    let mut computed = Vec::new();
    for property in properties {
        let declarations = checker.sym(property).declarations.clone();
        for declaration_node in declarations {
            let name = declaration_node.name();
            if name.is_nil() || name.kind() != SyntaxKind::ComputedPropertyName {
                continue;
            }
            let mut value = symbol(checker, property);
            let expression = name.expression();
            let name_symbol = checker.get_symbol_at_location_exported(expression);
            value["nameExpressionSymbol"] = symbol(checker, name_symbol);
            value["nameExpression"] =
                reference(expression, get_source_file_of_node(declaration_node));
            computed.push(value);
        }
    }
    fact["computedProperties"] = json!(computed);
    let flags = checker.ty(id).flags;
    for (key, flag) in [
        ("unionTypes", TypeFlags::UNION),
        ("intersectionTypes", TypeFlags::INTERSECTION),
    ] {
        let parts = if flags.intersects(flag) {
            checker.ty(id).types().to_vec()
        } else {
            Vec::new()
        };
        fact[key] = Value::Array(
            parts
                .into_iter()
                .map(|part| type_summary(checker, part))
                .collect(),
        );
    }
    fact
}

pub fn signature(checker: &mut Checker, id: SignatureId) -> Value {
    if !id.is_some() {
        return Value::Null;
    }
    let data = checker.sig(id);
    let declaration = declaration(data.declaration);
    let has_rest = data.has_rest_parameter();
    let flags = data.flags.0;
    let parameter_ids = data.parameters.clone();
    let parameters: Vec<Value> = parameter_ids
        .into_iter()
        .map(|parameter| {
            let mut value = symbol(checker, parameter);
            let type_id = checker.get_type_of_symbol_exported(parameter);
            value["type"] = type_summary(checker, type_id);
            value
        })
        .collect();
    let return_type = checker.get_return_type_of_signature_exported(id);
    json!({"text":checker.signature_to_string(id),"declaration":declaration,"flagsBits":flags,"hasRestParameter":has_rest,"parameters":parameters,"returnType":type_summary(checker,return_type)})
}

pub fn type_fact(checker: &mut Checker, id: TypeId) -> Value {
    let mut fact = type_summary(checker, id);
    if !id.is_some() {
        return fact;
    }
    for (key, kind) in [
        ("callSignatures", SignatureKind::CALL),
        ("constructSignatures", SignatureKind::CONSTRUCT),
    ] {
        let signatures = checker.get_signatures_of_type_exported(id, kind);
        fact[key] = Value::Array(
            signatures
                .into_iter()
                .map(|id| signature(checker, id))
                .collect(),
        );
    }
    let flags = checker.ty(id).flags;
    for (key, flag) in [
        ("unionTypes", TypeFlags::UNION),
        ("intersectionTypes", TypeFlags::INTERSECTION),
    ] {
        let parts = if flags.intersects(flag) {
            checker.ty(id).types().to_vec()
        } else {
            Vec::new()
        };
        fact[key] = Value::Array(
            parts
                .into_iter()
                .map(|part| type_fact(checker, part))
                .collect(),
        );
    }
    fact
}
