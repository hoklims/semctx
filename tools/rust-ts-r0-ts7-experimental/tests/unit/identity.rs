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
