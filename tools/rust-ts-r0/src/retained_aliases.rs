mod bun_collections {
    pub struct BoundedArray<T, const N: usize>(Vec<T>);
    impl<T, const N: usize> Default for BoundedArray<T, N> {
        fn default() -> Self {
            Self(Vec::new())
        }
    }
    impl<T, const N: usize> BoundedArray<T, N> {
        pub fn push(&mut self, value: T) -> Result<(), ()> {
            if self.0.len() == N {
                return Err(());
            }
            self.0.push(value);
            Ok(())
        }
        pub fn pop(&mut self) -> Option<T> {
            self.0.pop()
        }
        pub fn len(&self) -> usize {
            self.0.len()
        }
        pub fn as_slice(&self) -> &[T] {
            &self.0
        }
    }
}
mod bun_core {
    pub mod strings {
        pub struct Rune {
            pub code_point: u32,
            pub len: u8,
        }
        pub fn wtf8_byte_sequence_length(c: u8) -> u8 {
            match c {
                0..=0x7f => 1,
                0xc0..=0xdf => 2,
                0xe0..=0xef => 3,
                0xf0..=0xf7 => 4,
                _ => 1,
            }
        }
        pub fn utf8_codepoint_with_fffd(b: &[u8]) -> Rune {
            let n = wtf8_byte_sequence_length(b[0]) as usize;
            let c = b
                .get(..n)
                .and_then(|s| std::str::from_utf8(s).ok())
                .and_then(|s| s.chars().next());
            match c {
                Some(c) => Rune {
                    code_point: c as u32,
                    len: n as u8,
                },
                None => Rune {
                    code_point: 0xfffd,
                    len: 1,
                },
            }
        }
    }
}
mod bun_paths {
    pub fn is_sep_native(c: u8) -> bool {
        c == b'/' || (cfg!(windows) && c == b'\\')
    }
}
#[path = "vendor/bun_1_4_3_glob.rs"]
mod upstream;

pub fn matches(pattern: &str, path: &str) -> bool {
    upstream::r#match(pattern.as_bytes(), path.as_bytes())
}

pub fn matches_port_strings(pattern: &str, path: &str) -> bool {
    let pattern = String::from_utf16_lossy(&crate::source_text::to_units(pattern));
    let path = String::from_utf16_lossy(&crate::source_text::to_units(path));
    matches(&pattern, &path)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn retained_aliases_preserve_literal_escapes_classes_and_brace_alternatives() {
        for (pattern, text, expected) in [
            (r"extern\al", "external", true),
            (r"extern\*al", "external", false),
            (r"extern\*al", "extern*al", true),
            ("foo(bar)", "foo(bar)", true),
            ("@(foo|bar)", "@(foo|bar)", true),
            ("@(foo|bar)", "foo", false),
            ("[broken", "external", false),
            ("![broken", "external", true),
            ("[]a]", "]", true),
            (r"[\]]", "]", true),
            ("[z-aX]", "X", true),
            ("[z-a]", "z", false),
            ("[!a]", "/", true),
            ("[/]", "/", true),
            ("[é]", "é", true),
            (r"a\{b", "a{b", true),
            ("[{]", "{", true),
            ("[}]", "}", true),
            ("{a,{b,c}}", "c", true),
            (r"{a\,b,c}", "a,b", true),
            ("{foo", "foo", false),
            ("{a,b", "a", true),
            ("{a,b", "b", false),
            ("a}", "a}", true),
            ("a\\", "a", false),
            ("!**{,a}", "external/sub", true),
            ("**{,a}", "external/sub", false),
            ("!{external/,other/}**", "external/sub/deep", true),
            ("{external/,other/}**", "external/sub/deep", false),
            ("!{external,other}", "external", false),
            ("!{external,other}", "third", true),
            ("**/*", "", false),
            ("**/*", "external/", false),
            ("!**/*", "external/", true),
        ] {
            assert_eq!(matches(pattern, text), expected, "{pattern} {text}");
        }
    }
}
