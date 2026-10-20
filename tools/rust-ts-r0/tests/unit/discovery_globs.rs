
use super::*;
#[test]
fn native_globs_preserve_selection_recursion_braces_negation_and_unicode() {
    for (pattern, accepted, refused) in [
        (
            "**/*",
            vec!["main.ts", "src/.hidden.js", "x.min.js"],
            vec![],
        ),
        (
            "src/**/*.ts",
            vec!["src/main.ts", "src/deep/main.ts"],
            vec!["main.ts", "other/main.ts", "src/main.tsx"],
        ),
        ("{a,b}", vec!["a", "b"], vec!["ab", "{a,b}"]),
        ("{a}", vec!["a"], vec!["{a}", "b"]),
        ("!a", vec!["b", "ab", "aé"], vec!["a"]),
        ("a?", vec!["ab", "aé"], vec!["a", "a/b", "abc"]),
        ("[!a]", vec!["b", "é"], vec!["a", "ab", "/"]),
        ("[^a]", vec!["b", "é"], vec!["a", "ab", "/"]),
        (
            "**/*.{ts,tsx,mts,cts}",
            vec!["main.ts", "src/main.tsx", "deep/a.cts"],
            vec!["main.jsx", "main.ts.map"],
        ),
    ] {
        let matcher = Globs::new(&[pattern.into()]).unwrap();
        for path in accepted {
            assert!(matcher.matches(path), "{pattern} rejects {path}");
        }
        for path in refused {
            assert!(!matcher.matches(path), "{pattern} accepts {path}");
        }
    }
}
