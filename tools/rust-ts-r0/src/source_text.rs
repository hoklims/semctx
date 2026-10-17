#[derive(Clone, Copy, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ReadProfile {
    CompilerSystem,
    RetainedUtf8,
}

pub fn from_units(units: &[u16]) -> String {
    let mut bytes = vec![];
    for decoded in char::decode_utf16(units.iter().copied()) {
        match decoded {
            Ok(character) => {
                let mut buffer = [0; 4];
                bytes.extend_from_slice(character.encode_utf8(&mut buffer).as_bytes());
            }
            Err(error) => {
                let surrogate = error.unpaired_surrogate();
                bytes.extend_from_slice(&[
                    0xe0 | (surrogate >> 12) as u8,
                    0x80 | ((surrogate >> 6) & 0x3f) as u8,
                    0x80 | (surrogate & 0x3f) as u8,
                ]);
            }
        }
    }
    ts_goport::scanner_util::go_string_from_bytes(bytes)
}

pub fn decode(bytes: &[u8], profile: ReadProfile) -> String {
    let mut bytes = bytes;
    if matches!(profile, ReadProfile::CompilerSystem) {
        if bytes.starts_with(&[0xff, 0xfe]) || bytes.starts_with(&[0xfe, 0xff]) {
            let big_endian = bytes[0] == 0xfe;
            let units = bytes[2..]
                .chunks_exact(2)
                .map(|pair| {
                    if big_endian {
                        u16::from_be_bytes([pair[0], pair[1]])
                    } else {
                        u16::from_le_bytes([pair[0], pair[1]])
                    }
                })
                .collect::<Vec<_>>();
            return from_units(&units);
        }
        if let Some(without_bom) = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]) {
            bytes = without_bom;
        }
    }
    ts_goport::scanner_util::go_string_from_utf8(String::from_utf8_lossy(bytes).into_owned())
}

#[cfg(test)]
mod tests {
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
    }
}
