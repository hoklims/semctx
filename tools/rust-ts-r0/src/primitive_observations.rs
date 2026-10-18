use crate::{identity, source_text};
use serde::Deserialize;
use serde_json::{Value, json};
use std::path::{Component, Path, PathBuf};
use ts_goport::{
    ast,
    astdata::SyntaxKind,
    astnav,
    core::Node,
    flags::ScriptKind,
    frontend::{
        parser::{SourceFileParseOptions, parse_source_file},
        tspath::Path as CompilerPath,
    },
    scanner_util,
};

#[derive(Deserialize)]
#[serde(tag = "operation", rename_all = "snake_case", deny_unknown_fields)]
enum Request {
    Decode {
        bytes: Vec<u8>,
        profile: source_text::ReadProfile,
        offsets_utf16: Vec<u32>,
        filename: Option<String>,
    },
    Utf16 {
        units: Vec<u16>,
        offsets_utf16: Vec<u32>,
        filename: Option<String>,
    },
    CanonicalJson {
        value: Value,
    },
    RelativeImportSpecifiers {
        source: String,
        filename: String,
    },

    SemanticKey {
        cwd: String,
        path: String,
        case_sensitive: bool,
    },
}

fn relative_import_specifiers(source: &str, filename: &str) -> Vec<String> {
    let parsed = parse_source_file(
        &SourceFileParseOptions {
            file_name: filename.into(),
            path: CompilerPath(filename.into()),
            ..Default::default()
        },
        ast::FileText::new(source.to_owned(), false),
        ScriptKind::TSX,
    );
    fn visit(node: Node, specifiers: &mut Vec<String>) {
        let specifier = match node.kind() {
            SyntaxKind::ImportDeclaration | SyntaxKind::ExportDeclaration => {
                node.module_specifier()
            }
            SyntaxKind::CallExpression if node.expression().kind() == SyntaxKind::ImportKeyword => {
                node.arguments().iter().next().unwrap_or(Node::NIL)
            }
            _ => Node::NIL,
        };
        if specifier.is_some()
            && specifier.kind() == SyntaxKind::StringLiteral
            && specifier.text().starts_with('.')
        {
            specifiers.push(specifier.text().to_owned());
        }
        node.for_each_child(&mut |child| {
            visit(child, specifiers);
            false
        });
    }
    let mut specifiers = vec![];
    visit(parsed.root, &mut specifiers);
    specifiers
}

fn units(text: &str) -> Vec<u16> {
    let mut result = vec![];
    let mut offset = 0;
    while offset < text.len() {
        let (code, size, _) = scanner_util::decode_go_js_string_rune(&text[offset..]);
        if code <= u32::from(u16::MAX) {
            result.push(code as u16);
        } else if let Some(character) = char::from_u32(code) {
            result.extend_from_slice(character.encode_utf16(&mut [0; 2]));
        }
        offset += size;
    }
    result
}

fn node_extent(
    node: Node,
    file: Node,
    text: &str,
    positions: &ast::PositionMap,
    lines: &[i32],
) -> Result<Value, String> {
    let start = astnav::get_start_of_node(node, file, false);
    let end = node.end();
    if start < 0 || end < start || end as usize > text.len() {
        return Err("PRIMITIVE_PARSER_INVALID_NODE_RANGE".into());
    }
    let start_utf16 = positions.utf8_to_utf16(start);
    let end_utf16 = positions.utf8_to_utf16(end);
    let start_line = scanner_util::compute_line_of_position(lines, start);
    let end_line = scanner_util::compute_line_of_position(lines, end);
    Ok(json!({
        "kind":format!("{:?}",node.kind()),
        "start_utf16":start_utf16,
        "end_utf16":end_utf16,
        "start_line":start_line,
        "end_line":end_line,
        "start_character":start_utf16-positions.utf8_to_utf16(lines[start_line as usize]),
        "end_character":end_utf16-positions.utf8_to_utf16(lines[end_line as usize])
    }))
}

fn declarations(node: Node, found: &mut Vec<Node>) {
    if matches!(
        node.kind(),
        SyntaxKind::VariableDeclaration
            | SyntaxKind::FunctionDeclaration
            | SyntaxKind::ClassDeclaration
            | SyntaxKind::MethodDeclaration
            | SyntaxKind::PropertyDeclaration
            | SyntaxKind::Parameter
            | SyntaxKind::BindingElement
            | SyntaxKind::ImportSpecifier
            | SyntaxKind::ImportClause
            | SyntaxKind::NamespaceImport
            | SyntaxKind::InterfaceDeclaration
            | SyntaxKind::TypeAliasDeclaration
            | SyntaxKind::EnumDeclaration
            | SyntaxKind::ModuleDeclaration
            | SyntaxKind::TypeParameter
    ) {
        found.push(node);
    }
    node.for_each_child(&mut |child| {
        declarations(child, found);
        false
    });
}

fn observe_parser(text: &str, filename: &str) -> Result<Value, String> {
    let (script_kind, script_kind_name) = if filename.ends_with(".tsx") {
        (ScriptKind::TSX, "TSX")
    } else if filename.ends_with(".jsx") {
        (ScriptKind::JSX, "JSX")
    } else if [".ts", ".mts", ".cts"]
        .iter()
        .any(|suffix| filename.ends_with(suffix))
    {
        (ScriptKind::TS, "TS")
    } else if [".js", ".mjs", ".cjs"]
        .iter()
        .any(|suffix| filename.ends_with(suffix))
    {
        (ScriptKind::JS, "JS")
    } else {
        return Err("PRIMITIVE_PARSER_UNKNOWN_EXTENSION".into());
    };
    let parsed = parse_source_file(
        &SourceFileParseOptions {
            file_name: filename.into(),
            path: CompilerPath(filename.into()),
            ..Default::default()
        },
        ast::FileText::new(text.to_owned(), false),
        script_kind,
    );
    let file = parsed.root;
    let positions = ast::compute_position_map(text);
    let lines = scanner_util::compute_ecma_line_starts(text);
    let diagnostics = ast::source_file_diagnostics(file)
        .iter()
        .map(|diagnostic| {
            json!({
                "code":diagnostic.code(),
                "message":diagnostic.localize(&ts_goport::locale::DEFAULT),
                "start_utf16":positions.utf8_to_utf16(diagnostic.pos()),
                "end_utf16":positions.utf8_to_utf16(diagnostic.end())
            })
        })
        .collect::<Vec<_>>();
    let statements = file
        .statement_list()
        .nodes()
        .iter()
        .map(|statement| node_extent(statement, file, text, &positions, &lines))
        .collect::<Result<Vec<_>, _>>()?;
    let mut nodes = vec![];
    declarations(file, &mut nodes);
    let declarations = nodes
        .into_iter()
        .map(|node| {
            let mut extent = node_extent(node, file, text, &positions, &lines)?;
            let name = node.name();
            extent["name"] = if name.is_nil() {
                Value::Null
            } else {
                let mut name_extent = node_extent(name, file, text, &positions, &lines)?;
                if name.kind() == SyntaxKind::Identifier {
                    name_extent["identifier_utf16_units"] = json!(units(name.text()));
                }
                name_extent
            };
            Ok(extent)
        })
        .collect::<Result<Vec<_>, String>>()?;
    Ok(json!({
        "executed":true,"unsupported":[],"filename":filename,
        "script_kind":script_kind_name,
        "has_syntax_errors":!diagnostics.is_empty(),
        "diagnostics":diagnostics,"statements":statements,"declarations":declarations
    }))
}

fn observe_text(text: &str, offsets: &[u32], filename: Option<&str>) -> Result<Value, String> {
    let decoded = units(text);
    if text.len() > i32::MAX as usize {
        return Err("PRIMITIVE_TEXT_TOO_LARGE".into());
    }
    if offsets
        .iter()
        .any(|offset| *offset as usize > decoded.len())
    {
        return Err("PRIMITIVE_OFFSET_OUT_OF_RANGE".into());
    }
    let canonical = units(&identity::canonical_source(text));
    let positions = ast::compute_position_map(text);
    let lines = scanner_util::compute_ecma_line_starts(text);
    let boundaries = offsets
        .iter()
        .map(|offset| {
            let at = *offset as usize;
            let scalar_boundary = !(at > 0
                && at < decoded.len()
                && (0xd800..=0xdbff).contains(&decoded[at - 1])
                && (0xdc00..=0xdfff).contains(&decoded[at]));
            let port = positions.utf16_to_utf8(*offset as i32);
            let (line, character) =
                scanner_util::ecma_line_and_utf16_character_of_text_position(&lines, text, port);
            let utf16_line = scanner_util::compute_line_of_position(&lines, port);
            let utf16_character = *offset as i32
                - positions.utf8_to_utf16(lines[utf16_line as usize]);
            json!({"offset_utf16":offset,"sdk_port_offset":port,"sdk_roundtrip_utf16":positions.utf8_to_utf16(port),"scalar_boundary":scalar_boundary,"sdk_line":line,"sdk_character":character,"utf16_line":utf16_line,"utf16_character":utf16_character})
        })
        .collect::<Vec<_>>();
    Ok(json!({
        "decoded_utf16_units":decoded,
        "canonical_source_utf16_units":canonical,
        "decoded_utf8_replacement_sha256":identity::digest_bytes(String::from_utf16_lossy(&decoded).as_bytes()),
        "canonical_source_utf8_replacement_sha256":identity::digest_bytes(String::from_utf16_lossy(&canonical).as_bytes()),
        "decoded_go_wtf8_sha256":identity::digest_bytes(&scanner_util::go_string_bytes(text)),
        "line_starts_utf16":lines.iter().map(|offset|positions.utf8_to_utf16(*offset)).collect::<Vec<_>>(),
        "source_parsing_observation":filename.map(|filename|observe_parser(text,filename)).transpose()?,
        "boundaries_sdk":boundaries
    }))
}

fn semantic_key(cwd: &str, path: &str, case_sensitive: bool) -> Result<String, String> {
    if !Path::new(cwd).is_absolute() || cwd.contains('\0') || path.contains('\0') {
        return Err("PRIMITIVE_INVALID_NATIVE_PATH".into());
    }
    if matches!(
        Path::new(path).components().next(),
        Some(Component::Prefix(_))
    ) && !Path::new(path).has_root()
    {
        return Err("PRIMITIVE_DRIVE_RELATIVE_PATH_NOT_OBSERVED".into());
    }
    let mut resolved = PathBuf::new();
    for component in Path::new(cwd).join(path).components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                resolved.pop();
            }
            _ => resolved.push(component.as_os_str()),
        }
    }
    let normalized = resolved
        .to_str()
        .ok_or("PRIMITIVE_NATIVE_PATH_NOT_UTF8")?
        .replace('\\', "/");
    Ok(if case_sensitive {
        normalized
    } else {
        let lowered = scanner_util::to_lower_js(&scanner_util::go_string_from_utf8(normalized));
        String::from_utf16_lossy(&units(&lowered))
    })
}

pub fn handle_observation(request: Value) -> Result<Value, String> {
    let request_descriptor_id = identity::digest(&request);
    let request: Request = serde_json::from_value(request)
        .map_err(|error| format!("PRIMITIVE_INVALID_REQUEST:{error}"))?;
    let (operation, mut observed) = match request {
        Request::Decode {
            bytes,
            profile,
            offsets_utf16,
            filename,
        } => {
            let mut observed = observe_text(
                &source_text::decode(&bytes, profile),
                &offsets_utf16,
                filename.as_deref(),
            )?;
            observed["raw_bytes_sha256"] = json!(identity::digest_bytes(&bytes));
            ("decode", observed)
        }
        Request::Utf16 {
            units,
            offsets_utf16,
            filename,
        } => (
            "utf16",
            observe_text(
                &source_text::from_units(&units),
                &offsets_utf16,
                filename.as_deref(),
            )?,
        ),
        Request::RelativeImportSpecifiers { source, filename } => (
            "relative_import_specifiers",
            json!({"specifiers":relative_import_specifiers(&source, &filename),"runtime_dependency_claim":false}),
        ),
        Request::CanonicalJson { value } => (
            "canonical_json",
            json!({"canonical_json":identity::canonical_json(&value),"canonical_descriptor_sha256":identity::digest(&value)}),
        ),
        Request::SemanticKey {
            cwd,
            path,
            case_sensitive,
        } => (
            "semantic_key",
            json!({"key":semantic_key(&cwd,&path,case_sensitive)?,"case_sensitive":case_sensitive,"path_semantics":std::env::consts::OS}),
        ),
    };
    observed["operation"] = json!(operation);
    observed["request_descriptor_id"] = json!(request_descriptor_id);
    observed["executed"] = json!(true);
    observed["unsupported"] = json!([]);
    Ok(observed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn relative_import_primitive_observes_syntax_order_without_runtime_resolution() {
        let source = "import './same-dev'; export { item } from '../owner-dev'; import './same-dev'; const load = () => import('./lazy-dev', {with:{type:'json'}}); require('./legacy-dev'); import(name); import(`./template-dev`); import 'package-dev'; import '/absolute-dev'; const view = <section>{import('./jsx-dev')}</section>;";
        let observed = handle_observation(json!({"operation":"relative_import_specifiers","source":source,"filename":"suggestions-dev.ts"})).unwrap();
        assert_eq!(
            observed["specifiers"],
            json!([
                "./same-dev",
                "../owner-dev",
                "./same-dev",
                "./lazy-dev",
                "./jsx-dev"
            ])
        );
        assert_eq!(observed["runtime_dependency_claim"], false);
        assert_eq!(observed["executed"], true);
        assert_eq!(observed["unsupported"], json!([]));
        for request in [
            json!({"operation":"relative_import_specifiers","filename":"source.ts"}),
            json!({"operation":"relative_import_specifiers","source":7,"filename":"source.ts"}),
            json!({"operation":"relative_import_specifiers","source":"","filename":null}),
            json!({"operation":"relative_import_specifiers","source":"","filename":"source.ts","unknown":true}),
        ] {
            assert!(
                handle_observation(request)
                    .unwrap_err()
                    .starts_with("PRIMITIVE_INVALID_REQUEST:")
            );
        }
    }

    #[test]
    fn primitive_decoder_observes_actual_utf16_units_and_canonical_source_identity() {
        let observed = handle_observation(json!({
            "operation":"decode",
            "bytes":[255,254,65,0,13,0,10,0,0,216,90,0],
            "profile":"compiler_system",
            "offsets_utf16":[0,1,3,4,5]
        }))
        .unwrap();
        assert_eq!(
            observed["decoded_utf16_units"],
            json!([65, 13, 10, 55296, 90])
        );
        assert_eq!(
            observed["canonical_source_utf16_units"],
            json!([65, 10, 55296, 90])
        );
        assert_eq!(
            observed["decoded_utf8_replacement_sha256"],
            "sha256:64de2db461a4826fd8395bc7367b27e7db1e7a688876791dcb9f150f809423c2"
        );
        assert_eq!(
            observed["canonical_source_utf8_replacement_sha256"],
            "sha256:ee17405bdb51e7abbb79d8a5545a681a8bb577610b6765c771985a4c27874795"
        );
        assert_eq!(observed["boundaries_sdk"][2]["sdk_line"], 1);
        assert_eq!(observed["boundaries_sdk"][2]["sdk_character"], 0);
    }

    #[test]
    fn primitive_utf16_preserves_surrogates_and_observes_sdk_boundary_limits() {
        let request = json!({
            "operation":"utf16",
            "units":[65,55357,56960,13,10,55299,66,56325],
            "offsets_utf16":[0,1,2,3,5,6,8]
        });
        let observed = handle_observation(request.clone()).unwrap();
        assert_eq!(observed["decoded_utf16_units"], request["units"]);
        assert_eq!(
            observed["canonical_source_utf16_units"],
            json!([65, 55357, 56960, 10, 55299, 66, 56325])
        );
        assert_eq!(
            observed["request_descriptor_id"],
            identity::digest(&request)
        );
        assert_eq!(observed["boundaries_sdk"][2]["scalar_boundary"], false);
        assert_eq!(observed["boundaries_sdk"][3]["scalar_boundary"], true);
        assert_eq!(observed["boundaries_sdk"][4]["sdk_line"], 1);
        assert_eq!(observed["boundaries_sdk"][4]["sdk_character"], 0);
        assert_eq!(observed["boundaries_sdk"][5]["sdk_character"], 3);
        assert_eq!(observed["boundaries_sdk"][5]["utf16_character"], 1);
        assert_eq!(observed["boundaries_sdk"][6]["utf16_character"], 3);
    }

    #[test]
    fn primitive_boundary_refuses_foreign_shapes_profiles_units_and_offsets() {
        for request in [
            json!({"operation":"unknown"}),
            json!({"operation":"decode","bytes":[],"profile":"unknown","offsets_utf16":[]}),
            json!({"operation":"decode","bytes":[256],"profile":"compiler_system","offsets_utf16":[]}),
            json!({"operation":"decode","bytes":[],"profile":"compiler_system","offsets_utf16":[],"foreign":true}),
            json!({"operation":"utf16","units":[65536],"offsets_utf16":[]}),
            json!({"operation":"utf16","units":[65],"offsets_utf16":[-1]}),
            json!({"operation":"utf16","units":[65],"offsets_utf16":[2]}),
        ] {
            assert!(handle_observation(request).is_err());
        }
    }

    #[test]
    fn primitive_canonical_descriptor_preserves_javascript_order_and_request_binding() {
        let request = json!({"operation":"canonical_json","value":{"z":1,"2":2,"a":[true,null]}});
        let observed = handle_observation(request.clone()).unwrap();
        assert_eq!(
            observed["canonical_json"],
            "{\"2\":2,\"a\":[true,null],\"z\":1}"
        );
        assert_eq!(
            observed["request_descriptor_id"],
            identity::digest(&request)
        );
        assert!(
            handle_observation(json!({"operation":"canonical_json","value":null,"foreign":0}))
                .is_err()
        );
    }

    #[test]
    fn primitive_semantic_key_resolves_native_lexical_paths_without_realpath() {
        let cwd = std::env::current_dir()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let sensitive = handle_observation(json!({"operation":"semantic_key","cwd":cwd,"path":"alpha/../Leaf.ts","case_sensitive":true})).unwrap();
        assert_eq!(
            sensitive["key"],
            format!("{}/Leaf.ts", cwd.replace('\\', "/"))
        );
        let folded = handle_observation(json!({"operation":"semantic_key","cwd":cwd,"path":"alpha/../Leaf.ts","case_sensitive":false})).unwrap();
        assert_eq!(
            folded["key"],
            format!("{}/leaf.ts", cwd.replace('\\', "/").to_lowercase())
        );
        assert!(handle_observation(json!({"operation":"semantic_key","cwd":"relative","path":"x.ts","case_sensitive":true})).is_err());
    }

    #[test]
    fn primitive_utf16_lines_cover_bom_crlf_astral_and_ecma_separators() {
        let observed = handle_observation(json!({
            "operation":"utf16",
            "units":[65279,65,55356,57099,13,10,55314,8232,90,8233],
            "offsets_utf16":[0,2,3,4,6,7,8,10]
        }))
        .unwrap();
        assert_eq!(observed["line_starts_utf16"], json!([0, 6, 8, 10]));
        let coordinates = observed["boundaries_sdk"]
            .as_array()
            .unwrap()
            .iter()
            .map(|boundary| json!([boundary["utf16_line"], boundary["utf16_character"]]))
            .collect::<Vec<_>>();
        assert_eq!(
            coordinates,
            json!([
                [0, 0],
                [0, 2],
                [0, 3],
                [0, 4],
                [1, 0],
                [1, 1],
                [2, 0],
                [3, 0]
            ])
            .as_array()
            .unwrap()
            .clone()
        );
        assert_eq!(observed["boundaries_sdk"][2]["scalar_boundary"], false);
        assert_eq!(observed["boundaries_sdk"][5]["sdk_character"], 3);
        assert_eq!(observed["boundaries_sdk"][5]["utf16_character"], 1);
    }

    #[test]
    fn primitive_raw_decoding_keeps_compiler_and_retained_profiles_distinct() {
        let ordinary = handle_observation(json!({"operation":"decode","bytes":[239,187,191,81,13,10],"profile":"compiler_system","offsets_utf16":[]})).unwrap();
        let retained = handle_observation(json!({"operation":"decode","bytes":[239,187,191,81,13,10],"profile":"retained_utf8","offsets_utf16":[]})).unwrap();
        assert_eq!(ordinary["decoded_utf16_units"], json!([81, 13, 10]));
        assert_eq!(retained["decoded_utf16_units"], json!([65279, 81, 13, 10]));
        assert_eq!(ordinary["raw_bytes_sha256"], retained["raw_bytes_sha256"]);
        assert_ne!(
            ordinary["decoded_utf8_replacement_sha256"],
            retained["decoded_utf8_replacement_sha256"]
        );
        assert_ne!(
            ordinary["request_descriptor_id"],
            retained["request_descriptor_id"]
        );
    }

    #[test]
    #[cfg(not(windows))]
    fn primitive_posix_key_replaces_backslashes_after_native_resolution() {
        let observed=handle_observation(json!({"operation":"semantic_key","cwd":"/fixture-primitive","path":"part\\..\\Leaf.ts","case_sensitive":true})).unwrap();
        assert_eq!(observed["key"], "/fixture-primitive/part/../Leaf.ts");
        let folded=handle_observation(json!({"operation":"semantic_key","cwd":"/fixture-primitive","path":"ΟΣ.ts","case_sensitive":false})).unwrap();
        assert_eq!(folded["key"], "/fixture-primitive/οσ.ts");
    }

    #[test]
    #[cfg(windows)]
    fn primitive_windows_key_preserves_native_drive_and_unc_resolution() {
        for (cwd, path, expected) in [
            (
                "C:\\Dev\\Semantic",
                "branch\\..\\Leaf.ts",
                "C:/Dev/Semantic/Leaf.ts",
            ),
            ("C:\\Dev\\Semantic", "\\other\\Leaf.ts", "C:/other/Leaf.ts"),
            ("C:\\Dev\\Semantic", "D:\\Leaf.ts", "D:/Leaf.ts"),
            (
                "\\\\server\\share\\project",
                "..\\Leaf.ts",
                "//server/share/Leaf.ts",
            ),
        ] {
            let observed = handle_observation(
                json!({"operation":"semantic_key","cwd":cwd,"path":path,"case_sensitive":true}),
            )
            .unwrap();
            assert_eq!(observed["key"], expected);
        }
        assert!(handle_observation(json!({"operation":"semantic_key","cwd":"C:\\Dev","path":"C:relative.ts","case_sensitive":true})).is_err());
    }

    #[test]
    fn primitive_parser_reports_actual_declaration_name_and_statement_utf16_spans() {
        let observed = handle_observation(json!({
            "operation":"utf16",
            "units":[65279,13,10,99,111,110,115,116,32,112,114,105,109,105,116,105,118,101,70,108,97,103,32,61,32,57,59],
            "offsets_utf16":[],
            "filename":"primitive-positions.ts"
        })).unwrap();
        let parser = &observed["source_parsing_observation"];
        assert_eq!(parser["executed"], true);
        assert_eq!(parser["diagnostics"], json!([]));
        assert_eq!(parser["statements"][0]["kind"], "VariableStatement");
        assert_eq!(parser["statements"][0]["start_utf16"], 3);
        assert_eq!(parser["statements"][0]["end_utf16"], 27);
        assert_eq!(parser["statements"][0]["start_line"], 1);
        let declaration = &parser["declarations"][0];
        assert_eq!(declaration["kind"], "VariableDeclaration");
        assert_eq!(declaration["start_utf16"], 9);
        assert_eq!(declaration["name"]["start_utf16"], 9);
        assert_eq!(declaration["name"]["end_utf16"], 22);
        assert_eq!(
            declaration["name"]["identifier_utf16_units"],
            json!([
                112, 114, 105, 109, 105, 116, 105, 118, 101, 70, 108, 97, 103
            ])
        );
        assert!(
            handle_observation(
                json!({"operation":"utf16","units":[],"offsets_utf16":[],"filename":"unknown.css"})
            )
            .is_err()
        );
    }

    #[test]
    fn primitive_parser_exposes_recovery_diagnostic_without_successful_analysis_claim() {
        let observed = handle_observation(json!({
            "operation":"decode","bytes":b"const flag = ;".to_vec(),
            "profile":"compiler_system","offsets_utf16":[0,14],"filename":"primitive-broken.ts"
        }))
        .unwrap();
        let parser = &observed["source_parsing_observation"];
        assert_eq!(parser["has_syntax_errors"], true);
        assert_eq!(
            parser["diagnostics"],
            json!([{"code":1109,"message":"Expression expected.","start_utf16":13,"end_utf16":14}])
        );
        assert!(observed.get("analysis_success").is_none());
        let empty=handle_observation(json!({"operation":"utf16","units":[],"offsets_utf16":[0],"filename":"primitive-empty.tsx"})).unwrap();
        assert_eq!(empty["source_parsing_observation"]["script_kind"], "TSX");
        assert_eq!(empty["source_parsing_observation"]["statements"], json!([]));
        assert_eq!(empty["boundaries_sdk"][0]["utf16_character"], 0);
    }
}
