use std::collections::{BTreeMap, BTreeSet};
use ts_goport::{
    ast,
    astdata::SyntaxKind as K,
    astnav,
    core::Node,
    frontend::{parser, tsoptions, tspath},
};

pub struct Manifest {
    pub name: Option<String>,
    pub external_packages: BTreeSet<String>,
    pub aliases: Vec<String>,
}

#[derive(Clone)]
enum Value {
    Null,
    Scalar,
    String(String),
    Array(Vec<Value>),
    Object(Object),
}

#[derive(Clone)]
enum Prototype {
    Builtin,
    Null,
    Value(Box<Value>),
}

#[derive(Clone)]
struct Object {
    own: BTreeMap<String, Value>,
    prototype: Prototype,
}

impl Object {
    fn new() -> Self {
        Self {
            own: BTreeMap::new(),
            prototype: Prototype::Builtin,
        }
    }

    fn uses_proto_setter(&self) -> bool {
        !self.own.contains_key("__proto__")
            && match &self.prototype {
                Prototype::Builtin => true,
                Prototype::Null => false,
                Prototype::Value(value) => match value.as_ref() {
                    Value::Object(object) => object.uses_proto_setter(),
                    Value::Array(_) => true,
                    _ => false,
                },
            }
    }

    fn assign(&mut self, key: String, value: Value) {
        if key == "__proto__" && self.uses_proto_setter() {
            match value {
                Value::Null => self.prototype = Prototype::Null,
                Value::Object(_) | Value::Array(_) => {
                    self.prototype = Prototype::Value(Box::new(value))
                }
                _ => {}
            }
        } else {
            self.own.insert(key, value);
        }
    }
}

impl Value {
    fn get(&self, key: &str) -> Option<&Self> {
        let Self::Object(object) = self else {
            return None;
        };
        object.own.get(key).or_else(|| match &object.prototype {
            Prototype::Value(value) => value.get(key),
            _ => None,
        })
    }

    fn string(&self) -> Option<&str> {
        match self {
            Self::String(value) => Some(value),
            _ => None,
        }
    }

    fn entries(&self) -> Vec<(String, Self)> {
        match self {
            Self::Object(object) => object
                .own
                .iter()
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect(),
            Self::Array(values) => values
                .iter()
                .cloned()
                .enumerate()
                .map(|(i, v)| (i.to_string(), v))
                .collect(),
            Self::String(text) => crate::source_text::to_units(text)
                .into_iter()
                .enumerate()
                .map(|(i, unit)| {
                    (
                        i.to_string(),
                        Self::String(crate::source_text::from_units(&[unit])),
                    )
                })
                .collect(),
            _ => vec![],
        }
    }
}

fn double_quoted(node: Node, source: Node, text: &str) -> bool {
    node.kind() == K::StringLiteral
        && usize::try_from(astnav::get_start_of_node(node, source, false))
            .ok()
            .and_then(|start| text.as_bytes().get(start))
            == Some(&b'"')
}

fn convert(node: Node, source: Node, text: &str) -> Option<Value> {
    match node.kind() {
        K::NullKeyword => Some(Value::Null),
        K::TrueKeyword | K::FalseKeyword | K::NumericLiteral | K::PrefixUnaryExpression => {
            Some(Value::Scalar)
        }
        K::StringLiteral if double_quoted(node, source, text) => {
            Some(Value::String(node.text().to_owned()))
        }
        K::ArrayLiteralExpression => node
            .elements()
            .iter()
            .map(|node| convert(node, source, text))
            .collect::<Option<Vec<_>>>()
            .map(Value::Array),
        K::ObjectLiteralExpression => {
            let mut object = Object::new();
            for property in node.properties().iter() {
                if property.kind() != K::PropertyAssignment
                    || !double_quoted(property.name(), source, text)
                {
                    return None;
                }
                object.assign(
                    property.name().text().to_owned(),
                    convert(property.initializer(), source, text)?,
                );
            }
            Some(Value::Object(object))
        }
        _ => None,
    }
}

pub fn inspect(path: &str, text: &str) -> Option<Manifest> {
    let source = parser::parse_source_file(
        &parser::SourceFileParseOptions {
            file_name: path.into(),
            path: tspath::Path(path.into()),
            ..Default::default()
        },
        ast::FileText::new(text.to_owned(), false),
        ts_goport::flags::ScriptKind::JSON,
    )
    .root;
    let (_, errors) = tsoptions::convert_config_file_to_object(source, None);
    if !errors.is_empty() || !ast::source_file_diagnostics(source).is_empty() {
        return None;
    }
    let value = if source.statements().is_empty() {
        Value::Object(Object::new())
    } else {
        convert(source.statements().get(0).expression(), source, text)?
    };
    let name = value.get("name").and_then(Value::string).map(str::to_owned);
    let mut dependencies = BTreeMap::new();
    for field in [
        "dependencies",
        "devDependencies",
        "peerDependencies",
        "optionalDependencies",
    ] {
        if let Some(declared) = value.get(field) {
            dependencies.extend(declared.entries());
        }
    }
    let external_packages = dependencies
        .into_iter()
        .filter_map(|(name, value)| {
            let version = value.string()?;
            (!["workspace:", "file:", "link:"]
                .iter()
                .any(|prefix| version.starts_with(prefix)))
            .then_some(name)
        })
        .collect();
    let aliases = value
        .get("compilerOptions")
        .and_then(|options| options.get("paths"))
        .map(|paths| paths.entries().into_iter().map(|(key, _)| key).collect())
        .unwrap_or_default();
    Some(Manifest {
        name,
        external_packages,
        aliases,
    })
}
