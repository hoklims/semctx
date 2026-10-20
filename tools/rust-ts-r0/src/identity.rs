use serde_json::Value;
use sha2::{Digest, Sha256};

pub fn canonical_json(value: &Value) -> String {
    match value {
        Value::Array(items) => format!(
            "[{}]",
            items
                .iter()
                .map(canonical_json)
                .collect::<Vec<_>>()
                .join(",")
        ),
        Value::Object(map) => {
            let index = |key: &str| {
                key.parse::<u32>()
                    .ok()
                    .filter(|value| *value != u32::MAX && value.to_string() == key)
            };
            let mut keys = map.keys().collect::<Vec<_>>();
            keys.sort_by(|left, right| match (index(left), index(right)) {
                (Some(left), Some(right)) => left.cmp(&right),
                (Some(_), None) => std::cmp::Ordering::Less,
                (None, Some(_)) => std::cmp::Ordering::Greater,
                _ => left.encode_utf16().cmp(right.encode_utf16()),
            });
            format!(
                "{{{}}}",
                keys.into_iter()
                    .map(|key| format!(
                        "{}:{}",
                        serde_json::to_string(key).expect("JSON string serialization"),
                        canonical_json(&map[key])
                    ))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
        Value::Number(number) => ryu_js::Buffer::new()
            .format(number.as_f64().expect("finite JSON number"))
            .to_string(),
        _ => value.to_string(),
    }
}

pub fn digest_bytes(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}

pub fn digest(value: &Value) -> String {
    digest_bytes(canonical_json(value).as_bytes())
}

pub fn canonical_source(text: &str) -> String {
    text.replace("\r\n", "\n")
}

#[cfg(test)]
#[path = "../tests/unit/identity.rs"]
mod tests;
