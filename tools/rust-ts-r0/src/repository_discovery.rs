use super::*;
use std::{
    fs,
    io::Read,
    path::{Component, Path, PathBuf},
};
use ts_goport::{
    flags::ScriptKind,
    frontend::parser::{SourceFileParseOptions, parse_source_file},
};
#[path = "discovery_globs.rs"]
mod glob;
#[path = "discovery_resolution.rs"]
mod resolution;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Descriptor {
    repository_root: PathBuf,
    config: Config,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Config {
    version: u8,
    include: Vec<String>,
    exclude: Vec<String>,
    languages: BTreeMap<String, Mode>,
    migrations_dirs: Vec<String>,
}
#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Mode {
    On,
    Off,
}

pub(super) const HARD_IGNORED: &[&str] = &["node_modules", ".git", ".semctx"];
pub(super) const OUTPUT_DIRECTORIES: &[&str] = &["dist", "build", "coverage", ".turbo", ".next"];
fn path_text(path: &Path) -> Result<String, String> {
    path.to_str()
        .map(|s| s.replace('\\', "/"))
        .ok_or("DISCOVERY_PATH_NOT_UTF8".into())
}
fn language(path: &str) -> &'static str {
    match path.rsplit('.').next().unwrap_or("") {
        "ts" | "tsx" | "mts" | "cts" => "typescript",
        "js" | "jsx" | "mjs" | "cjs" => "javascript",
        "py" => "python",
        "md" | "mdx" => "markdown",
        "sql" => "sql",
        _ => "unknown",
    }
}
fn role(path: &str, content: &str, config: &Config) -> &'static str {
    let parts = path.split('/').collect::<Vec<_>>();
    let lang = language(path);
    if lang == "sql"
        || lang == "typescript"
            && (parts
                .iter()
                .any(|p| ["migration", "migrations"].contains(p))
                || config
                    .migrations_dirs
                    .iter()
                    .any(|p| path.starts_with(&p.replace('\\', "/"))))
    {
        return "migration";
    }
    if lang == "markdown" {
        return "document";
    }
    let filename = parts.last().copied().unwrap_or("");
    let test_dir = parts
        .iter()
        .any(|p| ["test", "tests", "__tests__"].contains(p));
    if lang == "python" {
        return if test_dir || filename.starts_with("test_") || filename.ends_with("_test.py") {
            "test"
        } else {
            "source"
        };
    }
    if ["typescript", "javascript"].contains(&lang) {
        let stem = filename.rsplit_once('.').map_or(filename, |(s, _)| s);
        let whitespace = |ch: char| ch.is_whitespace() && ch != '\u{85}' || ch == '\u{feff}';
        let import_test = content.match_indices("from").any(|(index, _)| {
            let suffix = &content[index + 4..];
            if !suffix.chars().next().is_some_and(whitespace) {
                return false;
            }
            let suffix = suffix.trim_start_matches(whitespace);
            ["vitest", "bun:test", "node:test"].iter().any(|name| {
                [format!("\"{name}\""), format!("'{name}'")]
                    .iter()
                    .any(|needle| suffix.starts_with(needle))
            })
        });
        return if test_dir || stem.ends_with(".test") || stem.ends_with(".spec") || import_test {
            "test"
        } else {
            "source"
        };
    }
    "other"
}
fn lexical(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for part in path.components() {
        match part {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            _ => normalized.push(part.as_os_str()),
        }
    }
    normalized
}
fn physical(path: &Path) -> Result<PathBuf, String> {
    let mut parent = path.to_path_buf();
    let mut tail = vec![];
    loop {
        match parent.canonicalize() {
            Ok(mut actual) => {
                for part in tail.iter().rev() {
                    actual.push(part);
                }
                return Ok(actual);
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                tail.push(
                    parent
                        .file_name()
                        .ok_or("DISCOVERY_PATH_UNRESOLVABLE")?
                        .to_os_string(),
                );
                if !parent.pop() {
                    return Err("DISCOVERY_PATH_UNRESOLVABLE".into());
                }
            }
            Err(error) => return Err(format!("DISCOVERY_PATH_UNRESOLVABLE:{error}")),
        }
    }
}
fn boundary(
    root: &Path,
    path: &Path,
    text: &str,
    probes: &mut Vec<serde_json::Value>,
) -> Result<Option<&'static str>, String> {
    let filename = path_text(path)?;
    let kind = match path.extension().and_then(|s| s.to_str()) {
        Some("js" | "mjs" | "cjs") => ScriptKind::JS,
        Some("jsx") => ScriptKind::JSX,
        Some("tsx") => ScriptKind::TSX,
        _ => ScriptKind::TS,
    };
    let file = parse_source_file(
        &SourceFileParseOptions {
            file_name: filename.clone(),
            path: ts_goport::frontend::tspath::Path(filename),
            ..Default::default()
        },
        ast::FileText::new(text.to_owned(), false),
        kind,
    );
    let mut imports = file
        .imports
        .iter()
        .map(|node| node.text().to_owned())
        .collect::<Vec<_>>();
    fn calls(node: core::Node, imports: &mut Vec<String>) {
        if node.kind() == SyntaxKind::CallExpression
            && (node.expression().kind() == SyntaxKind::ImportKeyword
                || ast::is_identifier(node.expression()) && node.expression().text() == "require")
            && let Some(arg) = node.arguments().iter().next()
            && ast::is_string_literal_like(arg)
        {
            imports.push(arg.text().to_owned());
        }
        node.for_each_child(&mut |child| {
            calls(child, imports);
            false
        });
    }
    calls(file.root, &mut imports);
    let parent = path.parent().ok_or("DISCOVERY_SOURCE_PARENT_MISSING")?;
    for (name, reason) in imports
        .iter()
        .map(|s| (s.as_str(), "IMPORT_OUTSIDE_REPOSITORY"))
        .chain(
            file.referenced_files
                .iter()
                .map(|r| (r.file_name.as_str(), "REFERENCE_OUTSIDE_REPOSITORY")),
        )
    {
        if reason == "IMPORT_OUTSIDE_REPOSITORY"
            && !ts_goport::frontend::tspath::is_external_module_name_relative(name)
        {
            continue;
        }
        let target = lexical(&parent.join(name));
        if !target.starts_with(root) || !physical(&target)?.starts_with(root) {
            return Ok(Some(reason));
        }
        if reason == "IMPORT_OUTSIDE_REPOSITORY" && resolution::outside(root, path, name, probes)? {
            return Ok(Some(reason));
        }
    }
    Ok(None)
}
fn walk(
    root: &Path,
    ignored: impl Fn(&str) -> bool,
    nested_worktree: impl Fn(&fs::Metadata) -> bool,
    retain_aliases: bool,
) -> Result<(Vec<PathBuf>, Vec<PathBuf>), String> {
    let mut pending = vec![root.to_path_buf()];
    let mut files = vec![];
    let mut links = vec![];
    let mut seen = 0;
    while let Some(dir) = pending.pop() {
        let entries =
            fs::read_dir(&dir).map_err(|e| format!("DISCOVERY_DIRECTORY_READ_FAILED:{e}"))?;
        for entry in entries {
            let entry = entry.map_err(|e| format!("DISCOVERY_ENTRY_READ_FAILED:{e}"))?;
            let path = entry.path();
            let name = entry.file_name();
            let name = name.to_str().ok_or("DISCOVERY_PATH_NOT_UTF8")?;
            if ignored(name) {
                continue;
            }
            seen += 1;
            if seen > 20_000 {
                return Err("DISCOVERY_ENTRY_LIMIT".into());
            }
            let metadata = fs::symlink_metadata(&path)
                .map_err(|e| format!("DISCOVERY_ENTRY_STAT_FAILED:{e}"))?;
            if metadata.file_type().is_symlink() {
                if retain_aliases {
                    files.push(path.clone());
                }
                if !physical(&path)?.starts_with(root) {
                    links.push(path);
                }
                continue;
            }
            if metadata.is_dir() {
                match fs::symlink_metadata(path.join(".git")) {
                    Ok(marker) if nested_worktree(&marker) => continue,
                    Ok(_) => {}
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                    Err(e) => return Err(format!("DISCOVERY_GIT_MARKER_FAILED:{e}")),
                }
                pending.push(path);
            } else if metadata.is_file() {
                files.push(path);
            }
        }
    }
    files.sort_by_key(|p| {
        path_text(p)
            .unwrap_or_default()
            .encode_utf16()
            .collect::<Vec<_>>()
    });
    links.sort();
    Ok((files, links))
}

pub(super) fn qualified_metadata_paths(root: &Path) -> Result<Vec<PathBuf>, String> {
    walk(
        root,
        |name| HARD_IGNORED.contains(&name),
        |marker| marker.is_file() || marker.file_type().is_symlink(),
        true,
    )
    .map(|(files, _)| files)
}
fn observe_paths(
    value: serde_json::Value,
    retained_paths: Option<&[PathBuf]>,
) -> Result<serde_json::Value, String> {
    let descriptor: Descriptor =
        serde_json::from_value(value).map_err(|e| format!("DISCOVERY_REQUEST_INVALID:{e}"))?;
    let config = &descriptor.config;
    if ![1, 2].contains(&config.version) {
        return Err("DISCOVERY_CONFIG_VERSION_UNSUPPORTED".into());
    }
    if config.languages.keys().any(|name| {
        !["typescript", "javascript", "python", "markdown", "sql"].contains(&name.as_str())
    }) {
        return Err("DISCOVERY_LANGUAGE_UNKNOWN".into());
    }
    let included = glob::Globs::new(&config.include)?;
    let excluded = glob::Globs::new(&config.exclude)?;
    let root = descriptor
        .repository_root
        .canonicalize()
        .map_err(|e| format!("DISCOVERY_REPOSITORY_UNAVAILABLE:{e}"))?;
    if !root.is_dir() {
        return Err("DISCOVERY_REPOSITORY_NOT_DIRECTORY".into());
    }
    let (paths, links) = if let Some(paths) = retained_paths {
        let mut paths = paths
            .iter()
            .filter(|path| {
                path.strip_prefix(&root).is_ok_and(|relative| {
                    !relative.components().any(|part| {
                        part.as_os_str()
                            .to_str()
                            .is_some_and(|name| HARD_IGNORED.contains(&name))
                    })
                })
            })
            .cloned()
            .collect::<Vec<_>>();
        paths.sort();
        (paths, vec![])
    } else {
        walk(
            &root,
            |name| HARD_IGNORED.contains(&name) || OUTPUT_DIRECTORIES.contains(&name),
            |_| true,
            false,
        )?
    };
    let mut files = vec![];
    let mut candidates = vec![];
    let mut reads = vec![];
    let mut resolution_probes = vec![];
    let mut total = 0usize;
    for path in paths {
        let relative = path_text(
            path.strip_prefix(&root)
                .map_err(|_| "DISCOVERY_SOURCE_OUTSIDE_REPOSITORY")?,
        )?;
        let lang = language(&relative);
        let candidate = serde_json::json!({"relPath":relative,"language":lang,"selectionDecision":"selected","reason":"SELECTED"});
        let refusal = if config.version == 1 {
            if config
                .exclude
                .iter()
                .any(|p| relative.contains(&p.replace('*', "")))
            {
                continue;
            }
            (!["typescript", "markdown", "sql"].contains(&lang)).then_some((
                "excluded",
                "not_applicable",
                "LEGACY_UNSUPPORTED_EXTENSION",
            ))
        } else if !included.matches(&relative) || excluded.matches(&relative) {
            Some((
                "excluded",
                "not_applicable",
                if excluded.matches(&relative) {
                    "EXCLUDE_MATCH"
                } else {
                    "INCLUDE_MISS"
                },
            ))
        } else {
            match config.languages.get(lang) {
                None => Some(("selected", "unsupported", "LANGUAGE_UNSUPPORTED")),
                Some(Mode::Off) => Some(("selected", "disabled", "LANGUAGE_DISABLED")),
                Some(Mode::On) => None,
            }
        };
        if let Some((selection, outcome, reason)) = refusal {
            let mut row = candidate;
            row["selectionDecision"] = serde_json::json!(selection);
            row["analysisOutcome"] = serde_json::json!(outcome);
            row["reason"] = serde_json::json!(reason);
            candidates.push(row);
            continue;
        }
        let bytes = match fs::File::open(&path).and_then(|f| {
            let mut bytes = vec![];
            f.take(33_554_433).read_to_end(&mut bytes)?;
            Ok(bytes)
        }) {
            Ok(bytes) => bytes,
            Err(error) => {
                let mut row = candidate;
                row["analysisOutcome"] = serde_json::json!("failed");
                row["reason"] = serde_json::json!("READ_FAILED");
                candidates.push(row);
                reads.push(serde_json::json!({"path":path_text(&path)?,"error":error.to_string()}));
                continue;
            }
        };
        total = total
            .checked_add(bytes.len())
            .ok_or("DISCOVERY_CAPTURE_SIZE_OVERFLOW")?;
        if total > 33_554_432 {
            return Err("DISCOVERY_CAPTURE_LIMIT".into());
        }
        reads.push(serde_json::json!({"path":path_text(&path)?,"raw_bytes_sha256":identity::digest_bytes(&bytes)}));
        let content = String::from_utf8_lossy(&bytes).into_owned();
        if ["typescript", "javascript"].contains(&lang)
            && let Some(reason) = boundary(&root, &path, &content, &mut resolution_probes)?
        {
            let mut row = candidate;
            row["analysisOutcome"] = serde_json::json!("failed");
            row["reason"] = serde_json::json!(reason);
            candidates.push(row);
            continue;
        }
        let role = role(&relative, &content, config);
        if role == "other" {
            let mut row = candidate;
            row["analysisOutcome"] = serde_json::json!("unsupported");
            row["reason"] = serde_json::json!("LANGUAGE_UNSUPPORTED");
            candidates.push(row);
            continue;
        }
        candidates.push(candidate);
        files.push(serde_json::json!({"absPath":path_text(&path)?,"relPath":relative,"role":role,"language":lang,"content":content}));
    }
    for path in links {
        candidates.push(serde_json::json!({"relPath":path_text(path.strip_prefix(&root).map_err(|_|"DISCOVERY_LINK_OUTSIDE_REPOSITORY")?)?,"language":language(&path_text(&path)?),"selectionDecision":"selected","analysisOutcome":"failed","reason":"SOURCE_LINK_OUTSIDE_REPOSITORY"}));
    }
    candidates.sort_by_key(|v| {
        v["relPath"]
            .as_str()
            .unwrap_or("")
            .encode_utf16()
            .collect::<Vec<_>>()
    });
    Ok(
        serde_json::json!({"executed":true,"unsupported":[],"files":files,"candidates":candidates,"reads":reads,"resolution_probes":resolution_probes,"repositoryRoot":path_text(&root)?,"observation_scope":if retained_paths.is_some(){"native_qualified_retained_discovery"}else{"native_ordinary_repository_discovery"},"global_admission_inferred":false}),
    )
}
pub(super) fn run(descriptor: serde_json::Value) -> serde_json::Value {
    observe_paths(descriptor, None).unwrap_or_else(|error|serde_json::json!({"executed":false,"unsupported":[error],"global_admission_inferred":false}))
}

pub(super) fn qualified(descriptor: serde_json::Value, paths: &[PathBuf]) -> serde_json::Value {
    observe_paths(descriptor, Some(paths)).unwrap_or_else(|error|serde_json::json!({"executed":false,"unsupported":[error],"global_admission_inferred":false}))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn config() -> Config {
        serde_json::from_value(serde_json::json!({"version":2,"include":["**/*"],"exclude":[],"languages":{"typescript":"on","javascript":"on"},"migrationsDirs":["migrations"]})).unwrap()
    }
    #[test]
    fn native_discovery_test_import_role_preserves_whitespace_rule() {
        assert_eq!(
            role(
                "src/guard.ts",
                "import {test} from\n\t\"vitest\";",
                &config()
            ),
            "test"
        );
        assert_eq!(
            role(
                "src/guard.ts",
                "import {test} from   'node:test';",
                &config()
            ),
            "test"
        );
        assert_eq!(
            role(
                "src/guard.ts",
                "import {factory} from './vitest';",
                &config()
            ),
            "source"
        );
    }
    #[test]
    fn native_discovery_refuses_invalid_descriptors_and_unavailable_roots() {
        let descriptor = serde_json::json!({"repositoryRoot":"/t00-never-created-root-f18","config":{"version":2,"include":["**/*"],"exclude":[],"languages":{"typescript":"on"},"migrationsDirs":["migrations"]}});
        for (pointer, value, expected) in [
            (
                "/config/version",
                serde_json::json!(99),
                "DISCOVERY_CONFIG_VERSION_UNSUPPORTED",
            ),
            (
                "/config/languages",
                serde_json::json!({"foreign":"on"}),
                "DISCOVERY_LANGUAGE_UNKNOWN",
            ),
            (
                "/config/include",
                serde_json::json!(["[abc"]),
                "DISCOVERY_INVALID_GLOB_CLASS",
            ),
            (
                "/config/include",
                serde_json::json!(["{abc"]),
                "DISCOVERY_INVALID_GLOB_BRACES",
            ),
            (
                "/config/include",
                serde_json::json!(["@(src)/*"]),
                "DISCOVERY_UNSUPPORTED_GLOB_EXTGROUP",
            ),
            (
                "/repositoryRoot",
                serde_json::json!("/t00-never-created-root-f18"),
                "DISCOVERY_REPOSITORY_UNAVAILABLE:",
            ),
        ] {
            let mut input = descriptor.clone();
            *input.pointer_mut(pointer).unwrap() = value;
            let result = run(input);
            assert_eq!(result["executed"], false);
            assert!(
                result["unsupported"][0]
                    .as_str()
                    .unwrap()
                    .starts_with(expected),
                "{pointer}:{result}"
            );
        }
        for value in [
            serde_json::Value::Null,
            serde_json::json!({}),
            serde_json::json!({"repositoryRoot":false,"config":{}}),
            serde_json::json!({"repositoryRoot":".","config":{},"foreign":true}),
        ] {
            let result = run(value);
            assert_eq!(result["executed"], false);
            assert!(
                result["unsupported"][0]
                    .as_str()
                    .unwrap()
                    .starts_with("DISCOVERY_REQUEST_INVALID:")
            );
        }
    }
}
