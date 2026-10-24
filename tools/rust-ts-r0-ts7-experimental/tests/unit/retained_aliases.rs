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
