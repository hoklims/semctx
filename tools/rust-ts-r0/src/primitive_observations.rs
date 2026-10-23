use crate::{identity, source_text};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    path::{Component, Path, PathBuf},
};
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
    NativeAnalyzerIdentity {
        repository_root: PathBuf,
        compiler_package_root: PathBuf,
    },
    BaselineAnalyzerIdentity {
        repository_root: PathBuf,
        compiler_package_root: PathBuf,
    },
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

    TestDynamicImports {
        retained_texts: BTreeMap<String, String>,
        test_paths: Vec<String>,
    },
    CanonicalFileKey {
        path: String,
        case_sensitive: bool,
        realpath_results: BTreeMap<String, String>,
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
        Request::NativeAnalyzerIdentity {
            repository_root,
            compiler_package_root,
        } => (
            "native_analyzer_identity",
            crate::native_identity::observe(repository_root, compiler_package_root),
        ),
        Request::BaselineAnalyzerIdentity {
            repository_root,
            compiler_package_root,
        } => (
            "baseline_analyzer_identity",
            crate::baseline_identity::observe(repository_root, compiler_package_root),
        ),
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
        Request::TestDynamicImports {
            retained_texts,
            test_paths,
        } => (
            "test_dynamic_imports",
            crate::test_dynamic_imports::observe(retained_texts, test_paths)?,
        ),
        Request::CanonicalJson { value } => (
            "canonical_json",
            json!({"canonical_json":identity::canonical_json(&value),"canonical_descriptor_sha256":identity::digest(&value)}),
        ),
        Request::CanonicalFileKey {
            path,
            case_sensitive,
            realpath_results,
        } => {
            let resolved = realpath_results
                .get(&path)
                .ok_or("PRIMITIVE_CONTROLLED_REALPATH_MISSING")?;
            if path.is_empty()
                || path.contains('\0')
                || resolved.is_empty()
                || resolved.contains('\0')
            {
                return Err("PRIMITIVE_CONTROLLED_REALPATH_INVALID".into());
            }
            let normalized = resolved.replace('\\', "/");
            let normalized = normalized
                .strip_prefix("./")
                .unwrap_or(&normalized)
                .to_owned();
            let key = if case_sensitive {
                normalized
            } else {
                let lowered =
                    scanner_util::to_lower_js(&scanner_util::go_string_from_utf8(normalized));
                String::from_utf16_lossy(&units(&lowered))
            };
            (
                "canonical_file_key",
                json!({"key":key,"realpath_result":resolved,"realpath_source":"supplied_controlled_system","case_sensitive":case_sensitive}),
            )
        }
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
#[path = "../tests/unit/primitive_observations.rs"]
mod tests;
