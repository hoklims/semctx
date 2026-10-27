use crate::graph_query::{Anchor, Entity, Nodes, Operation, Query, Route, Step};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use ts_goport::{prelude::*, scanner_util::get_token_pos_of_node};

const MAX_ENTITIES: usize = 16384;

#[derive(Default)]
pub struct Graph {
    known: BTreeSet<String>,
    rows: BTreeMap<String, Value>,
    pending: VecDeque<(Entity, Route)>,
    nodes: Nodes,
    source_paths: BTreeSet<String>,
    truncated: bool,
    symbol_types: BTreeMap<(String, Anchor), Value>,
    property_lookups: BTreeMap<(String, String), Value>,
}

impl Graph {
    fn intern(&mut self, entity: Entity, route: Route) -> Value {
        let Some(id) = entity.key() else {
            return Value::Null;
        };
        if !self.known.contains(&id) {
            if self.known.len() >= MAX_ENTITIES {
                self.truncated = true;
                return json!(id);
            }
            self.known.insert(id.clone());
            self.pending.push_back((entity, route));
        }
        json!(id)
    }

    fn node(&mut self, node: Node) -> Value {
        if node.is_nil() {
            return Value::Null;
        }
        self.intern(Entity::Node(node), Route::node(node))
    }

    fn reference(&mut self, node: Node) -> Value {
        if node.is_nil() {
            return Value::Null;
        }
        let anchor = Anchor::of(node);
        self.source_paths.insert(anchor.path.clone());
        let mut value = serde_json::to_value(&anchor).expect("native anchor serialization");
        value["id"] = json!(Entity::Node(node).key());
        value["anchor"] = json!(anchor);
        value["route"] = json!(Route::node(node));
        value
    }

    fn symbol_type(
        &mut self,
        checker: &mut Checker,
        symbol: SymbolId,
        location: Node,
        route: &Route,
    ) -> Value {
        let anchor = Anchor::of(location);
        let ty = checker.get_type_of_symbol_at_location(symbol, location);
        let type_id = self.intern(
            Entity::Type(ty),
            route.then(Step::SymbolType {
                location: anchor.clone(),
            }),
        );
        let symbol_id = Entity::Symbol(symbol).key().expect("observed symbol");
        self.symbol_types.insert(
            (symbol_id.clone(), anchor.clone()),
            json!({"symbolId":symbol_id,"location":anchor,"typeId":type_id}),
        );
        type_id
    }

    pub fn annotate(&mut self, checker: &mut Checker, node: Node, fact: &mut Value) {
        let route = Route::node(node);
        fact["id"] = self.node(node);
        fact["anchor"] = json!(route.anchor);
        fact["route"] = json!(route);
        let symbol = checker.get_symbol_at_location_exported(node);
        fact["symbolId"] = self.intern(Entity::Symbol(symbol), route.then(Step::Symbol));
        if is_expression(node) || node.kind() == SyntaxKind::Identifier || is_type_node(node) {
            let ty = checker.get_type_at_location(node);
            fact["typeId"] = self.intern(Entity::Type(ty), route.then(Step::Type));
        }
        if matches!(
            node.kind(),
            SyntaxKind::CallExpression | SyntaxKind::NewExpression
        ) {
            let signature = checker.get_resolved_signature_exported(node);
            fact["signatureId"] = self.intern(
                Entity::Signature(signature),
                route.then(Step::ResolvedSignature),
            );
        }
        let property_name = match node.kind() {
            SyntaxKind::PropertyAccessExpression => Some(node.name().text().to_string()),
            SyntaxKind::ElementAccessExpression
                if is_string_literal_like(node.argument_expression())
                    || node.argument_expression().kind() == SyntaxKind::NumericLiteral =>
            {
                Some(node.argument_expression().text().to_string())
            }
            _ => None,
        };
        if let Some(name) = property_name {
            let receiver = node.expression();
            let receiver_type = checker.get_type_at_location(receiver);
            let receiver_route = Route::node(receiver).then(Step::Type);
            let type_id = self.intern(Entity::Type(receiver_type), receiver_route.clone());
            let property = checker.get_property_of_type_exported(receiver_type, &name);
            let property_route = receiver_route.then(Step::Property { name: name.clone() });
            let symbol_id = self.intern(Entity::Symbol(property), property_route.clone());
            self.property_lookups.insert(
                (
                    type_id.as_str().expect("receiver type").to_string(),
                    name.clone(),
                ),
                json!({"typeId":type_id,"name":name,"symbolId":symbol_id}),
            );
            if property.is_some() {
                self.symbol_type(checker, property, receiver, &property_route);
            }
        }
        if node.kind() == SyntaxKind::ShorthandPropertyAssignment {
            let symbol = checker.get_shorthand_assignment_value_symbol(node);
            fact["shorthandValueSymbolId"] = self.intern(
                Entity::Symbol(symbol),
                route.then(Step::ShorthandValueSymbol),
            );
        }
    }

    fn node_row(&mut self, checker: &mut Checker, node: Node) -> Result<Value, String> {
        let file = get_source_file_of_node(node);
        let start = get_token_pos_of_node(node, file, false);
        let mut row = self.reference(node);
        row["pos"] = json!(node.pos());
        row["literalText"] = json!(node.text());
        if node.kind() != SyntaxKind::SourceFile {
            row["text"] = json!(
                source_file_text(file)
                    .get(start.max(0) as usize..node.end().max(start) as usize)
                    .unwrap_or_default()
            );
        }
        row["flagsBits"] = json!(node.flags().0);
        row["modifierFlagsBits"] = json!(get_combined_modifier_flags(node).0);
        row["isTypeNode"] = json!(is_type_node(node));
        row["isExpression"] = json!(is_expression(node));
        row["isFunctionLike"] = json!(is_function_like(node));
        row["isClassLike"] = json!(is_class_like(node));
        row["canHaveModifiers"] = json!(can_have_modifiers(node));
        row["isStringLiteralLike"] = json!(is_string_literal_like(node));
        row["syntaxValues"] = crate::syntax::values(node);
        row["parent"] = self.reference(node.parent());
        self.node(node.parent());
        self.node(node.name());
        row["sourceFileId"] = self.node(file);
        let mut fields = crate::syntax::fields(node, file);
        for value in fields
            .as_object_mut()
            .expect("native syntax fields")
            .values_mut()
        {
            self.add_reference_ids(value, source_file_file_name(file))?;
        }
        row["fields"] = fields;
        let mut children = Vec::new();
        node.for_each_child(|child| {
            children.push(self.reference(child));
            false
        });
        row["children"] = json!(children);
        if matches!(
            node.kind(),
            SyntaxKind::PrefixUnaryExpression
                | SyntaxKind::PostfixUnaryExpression
                | SyntaxKind::TypeOperator
        ) {
            row["operator"] = json!(format!("{:?}", node.operator()));
        }
        self.annotate(checker, node, &mut row);
        Ok(row)
    }

    fn add_reference_ids(&mut self, value: &mut Value, path: &str) -> Result<(), String> {
        if let Some(values) = value.as_array_mut() {
            for value in values {
                self.add_reference_ids(value, path)?;
            }
        } else if value.is_object() {
            value["path"] = json!(path);
            let anchor: Anchor =
                serde_json::from_value(value.clone()).map_err(|error| error.to_string())?;
            let node = self.nodes.find(&anchor)?;
            *value = self.reference(node);
        }
        Ok(())
    }

    fn symbol_row(&mut self, checker: &mut Checker, symbol: SymbolId, route: &Route) -> Value {
        let data = checker.sym(symbol);
        let declarations = data.declarations.clone();
        let flags = data.flags;
        let name = data.name.to_string();
        let declarations: Vec<Value> = declarations
            .iter()
            .map(|node| {
                self.node(*node);
                self.reference(*node)
            })
            .collect();
        let alias = if flags.intersects(SymbolFlags::ALIAS) {
            let target = checker.get_aliased_symbol(symbol);
            self.intern(Entity::Symbol(target), route.then(Step::AliasTarget))
        } else {
            Value::Null
        };
        json!({"name":name,"flagsBits":flags.0,"declarations":declarations,"aliasTarget":alias})
    }

    fn type_row(&mut self, checker: &mut Checker, ty: TypeId, route: &Route) -> Value {
        let flags = checker.ty(ty).flags;
        let symbol = checker.ty(ty).symbol;
        let mut row = json!({"text":checker.type_to_string(ty),"flagsBits":flags.0,"symbol":self.intern(Entity::Symbol(symbol),route.then(Step::Symbol))});
        for (key, kind) in [
            ("callSignatures", SignatureKind::CALL),
            ("constructSignatures", SignatureKind::CONSTRUCT),
        ] {
            let ids = checker.get_signatures_of_type_exported(ty, kind);
            row[key] = json!(
                ids.into_iter()
                    .enumerate()
                    .map(|(index, id)| {
                        let step = if kind == SignatureKind::CALL {
                            Step::CallSignature { index }
                        } else {
                            Step::ConstructSignature { index }
                        };
                        self.intern(Entity::Signature(id), route.then(step))
                    })
                    .collect::<Vec<_>>()
            );
        }
        for (key, flag) in [
            ("unionTypes", TypeFlags::UNION),
            ("intersectionTypes", TypeFlags::INTERSECTION),
        ] {
            let ids = if flags.intersects(flag) {
                checker.ty(ty).types().to_vec()
            } else {
                Vec::new()
            };
            row[key] = json!(
                ids.into_iter()
                    .enumerate()
                    .map(|(index, id)| {
                        let step = if flag == TypeFlags::UNION {
                            Step::Union { index }
                        } else {
                            Step::Intersection { index }
                        };
                        self.intern(Entity::Type(id), route.then(step))
                    })
                    .collect::<Vec<_>>()
            );
        }
        let number = checker.get_number_type();
        let index = checker.get_index_type_of_type_exported(ty, number);
        row["numberIndexType"] =
            self.intern(Entity::Type(index), route.then(Step::NumberIndexType));
        let constraint = checker.get_base_constraint_of_type_exported(ty);
        row["baseConstraint"] =
            self.intern(Entity::Type(constraint), route.then(Step::BaseConstraint));
        row
    }

    fn signature_row(
        &mut self,
        checker: &mut Checker,
        signature: SignatureId,
        route: &Route,
    ) -> Value {
        let data = checker.sig(signature);
        let declaration = data.declaration;
        let parameters = data.parameters.clone();
        let flags = data.flags;
        let has_rest = data.has_rest_parameter();
        let parameters: Vec<Value> = parameters
            .into_iter()
            .enumerate()
            .map(|(index, id)| {
                let parameter_route = route.then(Step::Parameter { index });
                let symbol_id = self.intern(Entity::Symbol(id), parameter_route.clone());
                if declaration.is_some() {
                    self.symbol_type(checker, id, declaration, &parameter_route);
                }
                symbol_id
            })
            .collect();
        let result = checker.get_return_type_of_signature_exported(signature);
        self.node(declaration);
        json!({"declaration":self.reference(declaration),"parameters":parameters,"returnType":self.intern(Entity::Type(result),route.then(Step::ReturnType)),"flagsBits":flags.0,"hasRestParameter":has_rest})
    }

    fn drain(&mut self, checker: &mut Checker) -> Result<(), String> {
        while let Some((entity, route)) = self.pending.pop_front() {
            let mut row = match entity {
                Entity::Node(node) => self.node_row(checker, node)?,
                Entity::Symbol(symbol) => self.symbol_row(checker, symbol, &route),
                Entity::Type(ty) => self.type_row(checker, ty, &route),
                Entity::Signature(signature) => self.signature_row(checker, signature, &route),
            };
            let key = entity.key().expect("queued native entity");
            row["id"] = json!(key);
            row["route"] = json!(route);
            self.rows.insert(key, row);
        }
        Ok(())
    }

    pub fn finish(mut self, checker: &mut Checker, queries: &[Query]) -> Result<Value, String> {
        self.drain(checker)?;
        let mut results = Vec::new();
        for query in queries {
            let entity = self.nodes.resolve(checker, &query.route)?;
            let (kind, value) = match (&query.operation, entity) {
                (Operation::Properties, Entity::Type(ty)) if ty.is_some() => {
                    let properties = checker.get_properties_of_type_exported(ty);
                    let values: Vec<Value> = properties
                        .into_iter()
                        .map(|symbol| {
                            let name = checker.sym(symbol).name.to_string();
                            self.intern(
                                Entity::Symbol(symbol),
                                query.route.then(Step::Property { name }),
                            )
                        })
                        .collect();
                    ("symbols", json!(values))
                }
                (Operation::SymbolType, Entity::Symbol(symbol)) if symbol.is_some() => {
                    let location = query
                        .location
                        .as_ref()
                        .ok_or("FACT_QUERY_LOCATION_REQUIRED")?;
                    let location_node = self.nodes.find(location)?;
                    let ty = checker.get_type_of_symbol_at_location(symbol, location_node);
                    (
                        "type",
                        self.intern(
                            Entity::Type(ty),
                            query.route.then(Step::SymbolType {
                                location: location.clone(),
                            }),
                        ),
                    )
                }
                (Operation::ModuleExports, Entity::Symbol(symbol))
                    if symbol.is_some()
                        && checker.sym(symbol).flags.intersects(SymbolFlags::MODULE) =>
                {
                    let exports = checker.get_exports_of_module_exported(symbol);
                    let values: Vec<Value> = exports
                        .into_iter()
                        .enumerate()
                        .map(|(index, symbol)| {
                            self.intern(
                                Entity::Symbol(symbol),
                                query.route.then(Step::Export { index }),
                            )
                        })
                        .collect();
                    ("symbols", json!(values))
                }
                (Operation::Node, Entity::Node(node)) => ("node", self.node(node)),
                (Operation::Resolve, entity) => {
                    let kind = match entity {
                        Entity::Node(_) => "node",
                        Entity::Symbol(_) => "symbol",
                        Entity::Type(_) => "type",
                        Entity::Signature(_) => "signature",
                    };
                    (kind, self.intern(entity, query.route.clone()))
                }
                _ => return Err("FACT_QUERY_OPERATION_KIND_MISMATCH".into()),
            };
            results.push(json!({"id":query.id,"kind":kind,"value":value}));
            self.drain(checker)?;
        }
        let rows = |prefix: char| {
            self.rows
                .iter()
                .filter(|(key, _)| key.starts_with(prefix))
                .map(|(_, value)| value.clone())
                .collect::<Vec<_>>()
        };
        Ok(
            json!({"schemaVersion":1,"truncated":self.truncated,"entityLimit":MAX_ENTITIES,"nodes":rows('n'),"symbols":rows('s'),"types":rows('t'),"signatures":rows('g'),"queryResults":results,"sourcePaths":self.source_paths,"symbolTypes":self.symbol_types.into_values().collect::<Vec<_>>(),"propertyLookups":self.property_lookups.into_values().collect::<Vec<_>>()}),
        )
    }
}
