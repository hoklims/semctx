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
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn source_identity_normalizes_crlf_but_preserves_bom_and_lone_cr() {
        assert_eq!(
            canonical_source("\u{feff}one\r\ntwo\rthree"),
            "\u{feff}one\ntwo\rthree"
        );
        assert_eq!(
            digest_bytes(b"abc"),
            "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn canonical_object_order_follows_javascript_utf16_keys_and_array_order_remains_observable() {
        assert_eq!(
            canonical_json(&json!({"\u{e000}":1,"\u{10000}":2,"a":3})),
            "{\"a\":3,\"𐀀\":2,\"\":1}"
        );
        assert_ne!(digest(&json!([1, 2])), digest(&json!([2, 1])));
    }

    #[test]
    fn integer_property_order_and_number_rendering_follow_javascript_json() {
        assert_eq!(
            canonical_json(&json!({"10":1.0,"2":-0.0,"01":1e-7})),
            "{\"2\":0,\"10\":1,\"01\":1e-7}"
        );
    }
}
