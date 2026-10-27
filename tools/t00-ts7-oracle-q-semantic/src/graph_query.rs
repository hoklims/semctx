use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use ts_goport::{prelude::*, scanner_util::get_token_pos_of_node};

#[derive(Clone, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
pub struct Anchor {
    pub path: String,
    pub kind: String,
    pub start: i32,
    pub end: i32,
}

impl Anchor {
    pub fn of(node: Node) -> Self {
        let file = get_source_file_of_node(node);
        Self {
            path: source_file_file_name(file).to_string(),
            kind: format!("{:?}", node.kind()),
            start: get_token_pos_of_node(node, file, false),
            end: node.end(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Route {
    pub anchor: Anchor,
    #[serde(default)]
    pub steps: Vec<Step>,
}

impl Route {
    pub fn node(node: Node) -> Self {
        Self {
            anchor: Anchor::of(node),
            steps: Vec::new(),
        }
    }

    pub fn then(&self, step: Step) -> Self {
        let mut route = self.clone();
        route.steps.push(step);
        route
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum Step {
    Symbol,
    Type,
    ShorthandValueSymbol,
    ResolvedSignature,
    Parent,
    SourceFile,
    AliasTarget,
    NumberIndexType,
    BaseConstraint,
    ReturnType,
    Field { name: String, index: Option<usize> },
    Declaration { index: usize },
    CallSignature { index: usize },
    ConstructSignature { index: usize },
    Parameter { index: usize },
    Export { index: usize },
    Union { index: usize },
    Intersection { index: usize },
    Property { name: String },
    SymbolType { location: Anchor },
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Operation {
    Properties,
    SymbolType,
    ModuleExports,
    Node,
    Resolve,
}

#[derive(Clone, Deserialize)]
pub struct Query {
    pub id: String,
    pub file: String,
    pub route: Route,
    pub operation: Operation,
    pub location: Option<Anchor>,
}

#[derive(Clone, Copy)]
pub enum Entity {
    Node(Node),
    Symbol(SymbolId),
    Type(TypeId),
    Signature(SignatureId),
}

impl Entity {
    pub fn key(self) -> Option<String> {
        match self {
            Self::Node(id) if id.is_some() => Some(format!("n{}", id.0)),
            Self::Symbol(id) if id.is_some() => Some(format!("s{}", id.index())),
            Self::Type(id) if id.is_some() => Some(format!("t{}", id.index())),
            Self::Signature(id) if id.is_some() => Some(format!("g{}", id.index())),
            _ => None,
        }
    }
}

#[derive(Default)]
pub struct Nodes {
    files: BTreeMap<String, BTreeMap<Anchor, Vec<Node>>>,
}

impl Nodes {
    pub fn find(&mut self, anchor: &Anchor) -> Result<Node, String> {
        if !self.files.contains_key(&anchor.path) {
            let file = source_files()
                .into_iter()
                .find(|file| source_file_file_name(*file) == anchor.path)
                .ok_or_else(|| format!("FACT_QUERY_SOURCE_NOT_FOUND:{}", anchor.path))?;
            let mut nodes = BTreeMap::new();
            index_nodes(file, &mut nodes);
            self.files.insert(anchor.path.clone(), nodes);
        }
        match self.files[&anchor.path].get(anchor).map(Vec::as_slice) {
            Some([node]) => Ok(*node),
            Some(_) => Err(format!("FACT_QUERY_AMBIGUOUS_ANCHOR:{anchor:?}")),
            None => Err(format!("FACT_QUERY_ANCHOR_NOT_FOUND:{anchor:?}")),
        }
    }

    pub fn resolve(&mut self, checker: &mut Checker, route: &Route) -> Result<Entity, String> {
        let mut entity = Entity::Node(self.find(&route.anchor)?);
        for step in &route.steps {
            entity = self.step(checker, entity, step)?;
        }
        Ok(entity)
    }

    fn step(
        &mut self,
        checker: &mut Checker,
        entity: Entity,
        step: &Step,
    ) -> Result<Entity, String> {
        if entity.key().is_none() {
            return Err("FACT_QUERY_ROUTE_THROUGH_ABSENCE".into());
        }
        Ok(match (entity, step) {
            (Entity::Node(node), Step::Symbol) => {
                Entity::Symbol(checker.get_symbol_at_location_exported(node))
            }
            (Entity::Node(node), Step::Type) => Entity::Type(checker.get_type_at_location(node)),
            (Entity::Node(node), Step::ShorthandValueSymbol)
                if node.kind() == SyntaxKind::ShorthandPropertyAssignment =>
            {
                Entity::Symbol(checker.get_shorthand_assignment_value_symbol(node))
            }
            (Entity::Node(node), Step::ResolvedSignature)
                if matches!(
                    node.kind(),
                    SyntaxKind::CallExpression | SyntaxKind::NewExpression
                ) =>
            {
                Entity::Signature(checker.get_resolved_signature_exported(node))
            }
            (Entity::Node(node), Step::Parent) => Entity::Node(node.parent()),
            (Entity::Node(node), Step::SourceFile) => Entity::Node(get_source_file_of_node(node)),
            (Entity::Node(node), Step::Field { name, index }) => {
                let fields = crate::syntax::fields(node, get_source_file_of_node(node));
                let value = fields
                    .get(name)
                    .ok_or_else(|| format!("FACT_QUERY_UNKNOWN_FIELD:{name}"))?;
                let value = if let Some(index) = index {
                    value.get(index).ok_or("FACT_QUERY_INDEX_OUT_OF_RANGE")?
                } else {
                    value
                };
                if value.is_null() {
                    Entity::Node(Node::NIL)
                } else {
                    let mut reference = value.clone();
                    reference["path"] =
                        serde_json::json!(source_file_file_name(get_source_file_of_node(node)));
                    let anchor = serde_json::from_value(reference)
                        .map_err(|_| "FACT_QUERY_FIELD_NOT_NODE")?;
                    Entity::Node(self.find(&anchor)?)
                }
            }
            (Entity::Symbol(symbol), Step::AliasTarget)
                if checker.sym(symbol).flags.intersects(SymbolFlags::ALIAS) =>
            {
                Entity::Symbol(checker.get_aliased_symbol(symbol))
            }
            (Entity::Symbol(symbol), Step::Export { index })
                if checker.sym(symbol).flags.intersects(SymbolFlags::MODULE) =>
            {
                Entity::Symbol(
                    *checker
                        .get_exports_of_module_exported(symbol)
                        .get(*index)
                        .ok_or("FACT_QUERY_INDEX_OUT_OF_RANGE")?,
                )
            }
            (Entity::Symbol(symbol), Step::Declaration { index }) => Entity::Node(
                *checker
                    .sym(symbol)
                    .declarations
                    .get(*index)
                    .ok_or("FACT_QUERY_INDEX_OUT_OF_RANGE")?,
            ),
            (Entity::Symbol(symbol), Step::SymbolType { location }) => {
                Entity::Type(checker.get_type_of_symbol_at_location(symbol, self.find(location)?))
            }
            (Entity::Type(ty), Step::Symbol) => Entity::Symbol(checker.ty(ty).symbol),
            (Entity::Type(ty), Step::Property { name }) => {
                Entity::Symbol(checker.get_property_of_type_exported(ty, name))
            }
            (Entity::Type(ty), Step::NumberIndexType) => {
                let number = checker.get_number_type();
                Entity::Type(checker.get_index_type_of_type_exported(ty, number))
            }
            (Entity::Type(ty), Step::BaseConstraint) => {
                Entity::Type(checker.get_base_constraint_of_type_exported(ty))
            }
            (Entity::Type(ty), Step::Union { index })
                if checker.ty(ty).flags.intersects(TypeFlags::UNION) =>
            {
                Entity::Type(
                    *checker
                        .ty(ty)
                        .types()
                        .get(*index)
                        .ok_or("FACT_QUERY_INDEX_OUT_OF_RANGE")?,
                )
            }
            (Entity::Type(ty), Step::Intersection { index })
                if checker.ty(ty).flags.intersects(TypeFlags::INTERSECTION) =>
            {
                Entity::Type(
                    *checker
                        .ty(ty)
                        .types()
                        .get(*index)
                        .ok_or("FACT_QUERY_INDEX_OUT_OF_RANGE")?,
                )
            }
            (Entity::Type(ty), Step::CallSignature { index }) => Entity::Signature(
                *checker
                    .get_signatures_of_type_exported(ty, SignatureKind::CALL)
                    .get(*index)
                    .ok_or("FACT_QUERY_INDEX_OUT_OF_RANGE")?,
            ),
            (Entity::Type(ty), Step::ConstructSignature { index }) => Entity::Signature(
                *checker
                    .get_signatures_of_type_exported(ty, SignatureKind::CONSTRUCT)
                    .get(*index)
                    .ok_or("FACT_QUERY_INDEX_OUT_OF_RANGE")?,
            ),
            (Entity::Signature(signature), Step::Declaration { index: 0 }) => {
                Entity::Node(checker.sig(signature).declaration)
            }
            (Entity::Signature(signature), Step::Parameter { index }) => Entity::Symbol(
                *checker
                    .sig(signature)
                    .parameters
                    .get(*index)
                    .ok_or("FACT_QUERY_INDEX_OUT_OF_RANGE")?,
            ),
            (Entity::Signature(signature), Step::ReturnType) => {
                Entity::Type(checker.get_return_type_of_signature_exported(signature))
            }
            _ => return Err(format!("FACT_QUERY_INVALID_STEP:{step:?}")),
        })
    }
}

fn index_nodes(node: Node, nodes: &mut BTreeMap<Anchor, Vec<Node>>) {
    let entries = nodes.entry(Anchor::of(node)).or_default();
    if !entries.contains(&node) {
        entries.push(node);
    }
    node.for_each_child(|child| {
        index_nodes(child, nodes);
        false
    });
}
