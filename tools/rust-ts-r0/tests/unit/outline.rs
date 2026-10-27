use super::*;
use ts_goport::{
    flags::ScriptKind,
    frontend::{
        parser::{SourceFileParseOptions, parse_source_file},
        tspath::Path,
    },
};

fn parsed(text: &str) -> Node {
    parse_source_file(
        &SourceFileParseOptions {
            file_name: "/outline-dev.ts".into(),
            path: Path("/outline-dev.ts".into()),
            ..Default::default()
        },
        Box::leak(text.to_owned().into_boxed_str()) as &'static str,
        ScriptKind::TS,
    )
    .root
}

#[test]
fn exported_destructuring_keeps_binding_order_and_comment_line() {
    let text =
        "// retained documentation\r\nexport const { key: first, nested: [second] } = source;\r\n";
    let result = outline(parsed(text), text, "outline-dev.ts");
    assert_eq!(result["exportedNames"], json!(["first", "second"]));
    assert_eq!(
        result["statements"][0]["declaredNames"],
        json!(["first", "second"])
    );
    assert_eq!(
        result["statements"][0]["referencedNames"],
        json!(["source"])
    );
    assert_eq!(result["statements"][0]["startLine"], 2);
    assert_eq!(result["statements"][0]["leadingStartLine"], 1);
    assert_eq!(result["statements"][0]["executesOnLoad"], false);
}
#[test]
fn type_only_imports_keep_absent_fields_and_loading_distinctions() {
    let text = "import type { A as Alias } from './types';\nimport { type Shape } from './mixed';\nimport './side';\nexport type * from './types';\nimport Handle = require('./external');\nexport { Alias as named };\nexport default (Alias.member);\n";
    let result = outline(parsed(text), text, "outline-dev.ts");
    let rows = result["statements"].as_array().unwrap();
    assert_eq!(
        rows.iter()
            .map(|s| s["loadsModule"].clone())
            .collect::<Vec<_>>(),
        vec![
            json!("never"),
            json!("maybe"),
            json!("yes"),
            json!("never"),
            json!("yes"),
            Value::Null,
            Value::Null
        ]
    );
    assert_eq!(
        rows[0]["importBindings"],
        json!([{"local":"Alias","imported":"A","typeOnly":true}])
    );
    assert_eq!(rows[2]["sideEffectImport"], true);
    assert_eq!(rows[2]["importBindings"], json!([]));
    assert!(rows[0].get("sideEffectImport").is_none());
    assert_eq!(
        rows[4]["importBindings"],
        json!([{"local":"Handle","imported":"=","typeOnly":false}])
    );
    assert!(rows[5].get("moduleSpecifier").is_none());
    assert_eq!(result["exportedNames"], json!(["Alias", "default"]));
    assert_eq!(rows[1]["executesOnLoad"], true);
}

#[test]
fn evaluation_skips_deferred_bodies_but_keeps_definition_effects() {
    let text = "const deferred = () => action();\nconst eager = { [key()]: 0 };\nclass Deferred { field=action(); method(){ action(); } }\nclass Eager { static field=action(); }\ndeclare class Ambient { static field: unknown; }\nenum Ordinary { item=action() }\nconst enum CompileOnly { item=action() }\nnamespace Space { const value=action(); }\nconst arithmetic = count + 1;\nconst increment = count++;\nconst assertion = (1 as typeof action);\nusing resource = plain;\n";
    let result = outline(parsed(text), text, "outline-dev.ts");
    let states = result["statements"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["executesOnLoad"].as_bool().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(
        states,
        vec![
            false, true, false, true, false, true, false, true, false, true, false, true
        ]
    );
}

#[test]
fn module_links_preserve_source_order_whole_flags_and_computed_absence() {
    let text = "import * as all from './one';\nimport type * as types from './two';\nexport * as publicNames from './three';\nexport type * from './four';\nimport compatibility = require('./five');\nfunction deferred(){ import(target); require(); import('./six'); }\n";
    assert_eq!(
        module_links(parsed(text), text),
        json!([
            {"kind":"import","specifier":"./one","line":1,"whole":true},
            {"kind":"import","specifier":"./two","line":2},
            {"kind":"reexport","specifier":"./three","line":3,"whole":true},
            {"kind":"reexport","specifier":"./four","line":4},
            {"kind":"require","specifier":"./five","line":5,"whole":true},
            {"kind":"dynamic_import","specifier":null,"line":6,"whole":true},
            {"kind":"require","specifier":null,"line":6,"whole":true},
            {"kind":"dynamic_import","specifier":"./six","line":6,"whole":true}
        ])
    );
}

#[test]
fn coordinates_keep_utf16_and_directives_separate_from_line_scanning() {
    let text = "// 😀\r\n// @ts-ignore\r\n// @Invariant shape\r\nexport const label = 'é';\r\n";
    let result = outline(parsed(text), text, "outline-dev.ts");
    assert_eq!(
        line_of(
            "a\r\nb\rc\u{2028}d\u{2029}e",
            "a\r\nb\rc\u{2028}d\u{2029}".len() as i32
        ),
        5
    );
    assert_eq!(result["statements"][0]["startLine"], 4);
    assert_eq!(result["statements"][0]["leadingStartLine"], 1);
    assert_eq!(result["directiveLines"], json!([2]));
    assert_eq!(result["markerLines"], json!([3]));
}

#[test]
fn digest_ignores_trivia_list_commas_and_final_semicolon_but_keeps_operators() {
    fn first(text: &str) -> Value {
        outline(parsed(text), text, "outline-dev.ts")["statements"][0]["digest"].clone()
    }
    assert_eq!(
        first("const labels = ['same', 2,];"),
        first("/* doc */ const labels=[\"same\",2]")
    );
    assert_ne!(
        first("const answer = left + right;"),
        first("const answer = left - right;")
    );
    assert_ne!(first("let mutable = 1;"), first("const mutable = 1;"));
    assert_ne!(
        first(r"const raw = tag`a\nb`;"),
        first("const raw = tag`a\nb`;")
    );
    assert_eq!(
        first("const raw = tag`x${value}y`;"),
        first("const raw = tag`x${ value }y`")
    );
}

#[test]
fn recovered_statements_do_not_hide_parser_failure() {
    let text = "export const broken = ;\nexport function later() {}\n";
    let result = outline(parsed(text), text, "outline-dev.ts");
    assert_eq!(result["hasSyntaxErrors"], true);
    assert_eq!(result["statements"].as_array().unwrap().len(), 2);
}
#[test]
fn directive_patterns_preserve_literal_suffix_and_ascii_word_boundaries() {
    let text =
        "// #__PURE__suffix\n// @ts-ignoreSuffix\n// @ts-ignoreé\n// webpackChunkName : 'chunk'\n";
    assert_eq!(
        outline(parsed(text), text, "outline-dev.ts")["directiveLines"],
        json!([1, 3, 4])
    );
}
#[test]
fn digest_ignores_statement_semicolons_inside_deferred_bodies() {
    let first = "const deferred = () => { invoke(); };";
    let second = "const deferred=()=>{invoke()}";
    assert_eq!(
        outline(parsed(first), first, "outline-dev.ts")["statements"][0]["digest"],
        outline(parsed(second), second, "outline-dev.ts")["statements"][0]["digest"]
    );
}

#[test]
fn javascript_program_file_uses_baseline_ts_outline_script_kind() {
    use ts_goport::frontend::parser::{SourceFileParseOptions, parse_source_file};
    let text = "const view = <Section />;";
    let file = parse_source_file(
        &SourceFileParseOptions {
            file_name: "/outline-dev.jsx".into(),
            path: Path("/outline-dev.jsx".into()),
            ..Default::default()
        },
        text,
        ScriptKind::JSX,
    )
    .root;
    assert_eq!(
        outline(file, text, "outline-dev.jsx")["hasSyntaxErrors"],
        true
    );
    assert_eq!(
        outline(file, text, "outline-dev.tsx")["hasSyntaxErrors"],
        false
    );
}

#[test]
fn declaration_kinds_defaults_and_references_keep_syntax_overapproximation() {
    let text = "export default function named(value: Model) { return value.item + external; }\nexport default class {}\ninterface Shape { field: Other; method(value: Input): Output; }\ntype Alias = Target;\nnamespace Named {}\nexport = (owned.part);\ntarget();\n";
    let result = outline(parsed(text), text, "outline-dev.ts");
    let statements = result["statements"].as_array().unwrap();
    assert_eq!(
        statements
            .iter()
            .map(|s| s["kind"].clone())
            .collect::<Vec<_>>(),
        vec![
            json!("function"),
            json!("class"),
            json!("interface"),
            json!("type"),
            json!("namespace"),
            json!("export"),
            json!("statement")
        ]
    );
    assert_eq!(
        result["exportedNames"],
        json!(["default", "named", "owned"])
    );
    assert_eq!(
        statements[0]["referencedNames"],
        json!(["Model", "external", "value"])
    );
    assert_eq!(
        statements[2]["referencedNames"],
        json!(["Input", "Other", "Output", "value"])
    );
}

#[test]
fn exported_and_referenced_name_order_matches_javascript_utf16_sort() {
    let text = "export const 𐐀 = 1; export const Ａ = 2; const both = 𐐀 + Ａ;";
    let result = outline(parsed(text), text, "outline-dev.ts");
    assert_eq!(result["exportedNames"], json!(["𐐀", "Ａ"]));
    assert_eq!(
        result["statements"][2]["referencedNames"],
        json!(["𐐀", "Ａ"])
    );
}
#[test]
fn default_only_import_is_a_non_whole_link_without_namespace_binding() {
    let text = "import DefaultValue from './default-owner';";
    assert_eq!(
        module_links(parsed(text), text),
        json!([{"kind":"import","specifier":"./default-owner","line":1}])
    );
}
