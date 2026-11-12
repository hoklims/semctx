use super::*;
use ts_goport::frontend::{
    module::{self, Resolver, ResolverOptions},
    parser::{SourceFileParseOptions, parse_source_file},
    tspath,
};

pub struct Inputs<'a> {
    pub root: &'a str,
    pub sdk_root: &'a str,
    pub roots: &'a [String],
    pub configured_resolution: bool,
    pub ordinary_system_resolution: bool,
}

fn contained(fs: &CaptureFs, root: &str, path: &str) -> bool {
    let root = fs.key(root);
    let path = fs.key(path);
    path == root || relative_source_path(&root, &path, fs.sensitive).is_ok()
}

fn physical(path: &str) -> Result<std::path::PathBuf, String> {
    let mut ancestor = std::path::absolute(tspath::normalize_path(path))
        .map_err(|error| format!("SOURCE_CANONICAL_PATH_UNAVAILABLE: {path}: {error}"))?;
    let mut tail = Vec::new();
    loop {
        match ancestor.canonicalize() {
            Ok(mut resolved) => {
                for part in tail.iter().rev() {
                    resolved.push(part);
                }
                return Ok(resolved);
            }
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
                ) =>
            {
                tail.push(
                    ancestor
                        .file_name()
                        .ok_or_else(|| format!("SOURCE_CANONICAL_PATH_UNAVAILABLE: {path}"))?
                        .to_os_string(),
                );
                if !ancestor.pop() {
                    return Err(format!("SOURCE_CANONICAL_PATH_UNAVAILABLE: {path}"));
                }
            }
            Err(error) => {
                return Err(format!(
                    "SOURCE_CANONICAL_PATH_UNAVAILABLE: {path}: {error}"
                ));
            }
        }
    }
}

fn target(
    fs: &CaptureFs,
    root: &str,
    physical_root: &std::path::Path,
    path: &str,
    name: &str,
    reason: &str,
) -> Result<String, String> {
    let lexical = tspath::resolve_path(&tspath::get_directory_path(path), &[name]);
    if !contained(fs, root, &lexical)
        || !contained(fs, root, &fs.realpath(&lexical))
        || !physical(&lexical)?.starts_with(physical_root)
    {
        return Err(format!("{reason}: {name}"));
    }
    Ok(lexical)
}

fn imports(node: core::Node, names: &mut Vec<String>) {
    if node.kind() == SyntaxKind::CallExpression
        && node.expression().kind() == SyntaxKind::ImportKeyword
        && let Some(argument) = node.arguments().iter().next()
        && ast::is_string_literal_like(argument)
    {
        names.push(argument.text().to_owned());
    }
    node.for_each_child(&mut |child| {
        imports(child, names);
        false
    });
}

fn skip_template(scanner: &mut ts_goport::frontend::scanner::Scanner<'_>) {
    let mut stack = vec![SyntaxKind::TemplateHead];
    while !stack.is_empty() {
        let kind = scanner.scan();
        match kind {
            SyntaxKind::EndOfFile => break,
            SyntaxKind::TemplateHead | SyntaxKind::OpenBraceToken => stack.push(kind),
            SyntaxKind::CloseBraceToken => {
                let closes = stack.last() != Some(&SyntaxKind::TemplateHead)
                    || scanner.re_scan_template_token(false) == SyntaxKind::TemplateTail;
                if closes {
                    stack.pop();
                }
            }
            _ => {}
        }
    }
}

fn javascript_imports(text: &str, names: &mut Vec<String>) {
    let mut scanner = ts_goport::frontend::scanner::new_scanner();
    scanner.set_text(text);
    scanner.set_skip_trivia(true);
    let literal = |kind| {
        matches!(
            kind,
            SyntaxKind::StringLiteral | SyntaxKind::NoSubstitutionTemplateLiteral
        )
    };
    let mut kind = scanner.scan();
    while kind != SyntaxKind::EndOfFile {
        if kind == SyntaxKind::TemplateHead {
            skip_template(&mut scanner);
            kind = scanner.scan();
            continue;
        }
        if kind == SyntaxKind::RequireKeyword {
            kind = scanner.scan();
            if kind == SyntaxKind::OpenParenToken {
                kind = scanner.scan();
                if literal(kind) {
                    names.push(scanner.token_value().to_owned());
                }
            }
            continue;
        }
        if kind == SyntaxKind::Identifier && scanner.token_value() == "define" {
            kind = scanner.scan();
            if kind != SyntaxKind::OpenParenToken {
                continue;
            }
            kind = scanner.scan();
            if literal(kind) {
                kind = scanner.scan();
                if kind != SyntaxKind::CommaToken {
                    continue;
                }
                kind = scanner.scan();
            }
            if kind != SyntaxKind::OpenBracketToken {
                continue;
            }
            kind = scanner.scan();
            while !matches!(kind, SyntaxKind::CloseBracketToken | SyntaxKind::EndOfFile) {
                if literal(kind) {
                    names.push(scanner.token_value().to_owned());
                }
                kind = scanner.scan();
            }
            continue;
        }
        kind = scanner.scan();
    }
}

fn resolved_module(
    resolver: &dyn Resolver,
    name: &str,
    path: &str,
) -> Result<Option<String>, String> {
    let (found, diagnostics, error) =
        resolver.resolve_module_name(name, path, ModuleKind::NONE, None);
    if let Some(error) = error {
        return Err(format!("SOURCE_CONFINEMENT_RESOLUTION_FAILED: {error}"));
    }
    if !diagnostics.is_empty() {
        return Err(format!("SOURCE_CONFINEMENT_RESOLUTION_DIAGNOSTICS: {name}"));
    }
    Ok(found
        .filter(|found| !found.resolved_file_name.is_empty())
        .map(|found| found.resolved_file_name.clone()))
}

pub fn check(fs: Rc<CaptureFs>, input: Inputs<'_>) -> Result<(), String> {
    let physical_root = physical(input.root)?;
    let options = ResolverOptions {
        host: Some(Rc::new(tsoptions::ResolverHost {
            fs: fs.clone(),
            current_directory: input.root.into(),
        })),
        compiler_options: Some(Rc::new(compiler_options())),
        ..Default::default()
    };
    let resolver: Rc<dyn Resolver> = if input.configured_resolution {
        let (create, _) =
            configured_resolver::factory(fs.clone(), input.root.into(), input.sdk_root.into());
        create(options)
    } else {
        Rc::new(module::new_resolver(options))
    };
    let mut resolvers = vec![resolver];
    if input.ordinary_system_resolution {
        resolvers.push(Rc::new(module::new_resolver(ResolverOptions {
            host: Some(Rc::new(tsoptions::ResolverHost {
                fs: ts_goport::frontend::vfs::osvfs_fs(),
                current_directory: input.root.into(),
            })),
            compiler_options: Some(Rc::new(compiler_options())),
            ..Default::default()
        })));
    }
    let mut pending = input.roots.to_vec();
    let mut visited = BTreeSet::new();
    let _empty = core::enter_program(None);
    while let Some(path) = pending.pop() {
        let resolved_path = fs.realpath(&path);
        if !contained(&fs, input.root, &path)
            || !contained(&fs, input.root, &resolved_path)
            || !physical(&path)?.starts_with(&physical_root)
        {
            return Err(format!("SOURCE_LINK_OUTSIDE_REPOSITORY: {path}"));
        }
        if !visited.insert(fs.key(&resolved_path)) {
            continue;
        }
        let (text, found) = fs.read_file(&path);
        if !found {
            return Err(format!(
                "SOURCE_SNAPSHOT_MISSING: {}",
                relative_source_path(input.root, &path, fs.sensitive)?
            ));
        }
        let kind = if path.ends_with(".tsx") {
            ts_goport::flags::ScriptKind::TSX
        } else if path.ends_with(".jsx") {
            ts_goport::flags::ScriptKind::JSX
        } else if [".js", ".mjs", ".cjs"]
            .iter()
            .any(|suffix| path.ends_with(suffix))
        {
            ts_goport::flags::ScriptKind::JS
        } else {
            ts_goport::flags::ScriptKind::TS
        };
        let parsed = parse_source_file(
            &SourceFileParseOptions {
                file_name: path.clone(),
                path: tspath::Path(path.clone()),
                ..Default::default()
            },
            ast::FileText::new(text.clone(), false),
            kind,
        );
        if parsed.root.is_nil() || parsed.root.kind() != SyntaxKind::SourceFile {
            return Err(format!("SOURCE_CONFINEMENT_PARSE_UNAVAILABLE: {path}"));
        }
        let mut names = parsed
            .imports
            .iter()
            .map(|node| node.text().to_owned())
            .collect();
        imports(parsed.root, &mut names);
        javascript_imports(&text, &mut names);
        for name in names.into_iter().filter(|name| name.starts_with('.')) {
            target(
                &fs,
                input.root,
                &physical_root,
                &path,
                &name,
                "IMPORT_OUTSIDE_REPOSITORY",
            )?;
            for resolver in &resolvers {
                let Some(resolved) = resolved_module(resolver.as_ref(), &name, &path)? else {
                    continue;
                };
                if !contained(&fs, input.root, &resolved)
                    || !contained(&fs, input.root, &fs.realpath(&resolved))
                    || !physical(&resolved)?.starts_with(&physical_root)
                {
                    return Err(format!("IMPORT_OUTSIDE_REPOSITORY: {name}"));
                }
                pending.push(resolved);
            }
        }
        for reference in parsed.referenced_files {
            let resolved = target(
                &fs,
                input.root,
                &physical_root,
                &path,
                &reference.file_name,
                "REFERENCE_OUTSIDE_REPOSITORY",
            )?;
            if fs.file_exists(&resolved) {
                pending.push(resolved);
            }
        }
    }
    Ok(())
}
