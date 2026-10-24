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

pub fn to_units(text: &str) -> Vec<u16> {
    use ts_goport::scanner_util::{GoUnit, go_unit_at, go_value};
    let text = go_value(text);
    let mut units = vec![];
    let mut offset = 0;
    while offset < text.len() {
        let (unit, width) = go_unit_at(&text, offset);
        match unit {
            GoUnit::Char(character) => {
                units.extend_from_slice(character.encode_utf16(&mut [0; 2]));
            }
            GoUnit::Surrogate(unit) => units.push(unit as u16),
            GoUnit::InvalidByte(_) => units.push(0xfffd),
        }
        offset += width;
    }
    units
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
#[path = "../tests/unit/source_text.rs"]
mod tests;
