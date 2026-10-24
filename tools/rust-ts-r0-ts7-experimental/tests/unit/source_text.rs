use super::*;

#[test]
fn compiler_decoding_strips_only_initial_bom_and_retained_utf8_keeps_it() {
    let bytes = b"\xef\xbb\xbflet dev = 3;\r\n";
    assert_eq!(
        decode(bytes, ReadProfile::CompilerSystem),
        "let dev = 3;\r\n"
    );
    assert_eq!(
        decode(bytes, ReadProfile::RetainedUtf8),
        "\u{feff}let dev = 3;\r\n"
    );
    assert_eq!(
        decode(b"\xff\xfeA\0B\0x", ReadProfile::CompilerSystem),
        "AB"
    );
    assert_eq!(decode(b"\xfe\xff\0A\0B", ReadProfile::CompilerSystem), "AB");
}

#[test]
fn lone_surrogates_and_astral_pairs_keep_javascript_utf16_width() {
    let units = [0x41, 0xd834, 0x42, 0xd83d, 0xde80, 0x43, 0xdc01];
    let port = from_units(&units);
    let bytes = ts_goport::scanner_util::go_string_bytes(&port);
    assert_eq!(&*bytes, b"A\xed\xa0\xb4B\xf0\x9f\x9a\x80C\xed\xb0\x81");
    let map = ts_goport::ast::compute_position_map(&port);
    assert_eq!(map.utf8_to_utf16(port.len() as i32), units.len() as i32);
    assert_eq!(to_units(&port), units);
    let markers = [
        0xfdd0, 0xd800, 0xd800, 0xd83d, 0xde00, 0xfdd0, 0xdbfe, 0xdc00,
    ];
    assert_eq!(to_units(&from_units(&markers)), markers);
}
