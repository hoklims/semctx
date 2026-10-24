use crate::identity;
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
use ts_goport::{
    ast,
    astdata::SyntaxKind,
    astnav,
    core::{self, Node},
    flags::ScriptKind,
    frontend::{
        parser::{SourceFileParseOptions, parse_source_file},
        tspath::Path,
    },
    scanner_util,
};

pub fn scan_node(file: Node, relative: &str) -> BTreeSet<(String, u32, String)> {
    fn visit(
        node: Node,
        file: Node,
        relative: &str,
        observed: &mut BTreeSet<(String, u32, String)>,
    ) {
        if node.kind() == SyntaxKind::CallExpression
            && node.expression().kind() == SyntaxKind::ImportKeyword
            && node.arguments().len() == 1
            && node.arguments().get(0).kind() == SyntaxKind::StringLiteral
        {
            let starts = ast::source_file_ecma_line_map(file);
            let line = starts
                .partition_point(|start| *start <= astnav::get_start_of_node(node, file, false))
                .max(1) as u32;
            observed.insert((
                relative.to_owned(),
                line,
                node.arguments().get(0).text().to_owned(),
            ));
        }
        node.for_each_child(&mut |child| {
            visit(child, file, relative, observed);
            false
        });
    }
    let mut observed = BTreeSet::new();
    visit(file, file, relative, &mut observed);
    observed
}

fn canonical_relative(path: &str) -> bool {
    !path.is_empty()
        && !path.contains(['\\', ':', '\0'])
        && path.split('/').all(|part| !matches!(part, "" | "." | ".."))
}

pub fn observe(
    retained_texts: BTreeMap<String, String>,
    test_paths: Vec<String>,
) -> Result<Value, String> {
    if retained_texts.keys().any(|path| !canonical_relative(path))
        || test_paths.iter().any(|path| !canonical_relative(path))
    {
        return Err("TEST_DYNAMIC_SCAN_RELATIVE_PATH_INVALID".into());
    }
    let mut seen = BTreeSet::new();
    let mut states = BTreeMap::new();
    let mut keys = BTreeSet::new();
    for path in test_paths {
        if !seen.insert(path.clone()) {
            return Err("TEST_DYNAMIC_SCAN_DUPLICATE_TEST_PATH".into());
        }
        let kind = if path.ends_with(".tsx") {
            ScriptKind::TSX
        } else if path.ends_with(".jsx") {
            ScriptKind::JSX
        } else if [".js", ".mjs", ".cjs"]
            .iter()
            .any(|suffix| path.ends_with(suffix))
        {
            ScriptKind::JS
        } else if [".ts", ".mts", ".cts"]
            .iter()
            .any(|suffix| path.ends_with(suffix))
        {
            ScriptKind::TS
        } else {
            return Err("TEST_DYNAMIC_SCAN_SCRIPT_KIND_UNSUPPORTED".into());
        };
        let Some(source) = retained_texts.get(&path) else {
            states.insert(path, json!({"state":"missing"}));
            continue;
        };
        let _empty = core::enter_program(None);
        let parsed = parse_source_file(
            &SourceFileParseOptions {
                file_name: path.clone(),
                path: Path(path.clone()),
                ..Default::default()
            },
            ast::FileText::new(scanner_util::go_string_from_utf8(source.clone()), false),
            kind,
        );
        for (path, line, specifier) in scan_node(parsed.root, &path) {
            keys.insert(format!("{path}:{line}:{specifier}"));
        }
        states.insert(
            path,
            json!({"state":"present","text_id":identity::digest_bytes(source.as_bytes())}),
        );
    }
    Ok(
        json!({"dynamic_keys":keys,"source_states":states,"observation_scope":"private_retained_test_scan","public_reachability_claimed":false,"global_admission_inferred":false}),
    )
}
