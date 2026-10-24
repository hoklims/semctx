use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    rc::Rc,
};
use ts_goport::{
    frontend::{
        module::{self, ResolverOptions},
        tsoptions,
    },
    prelude::*,
};

fn literals(node: Node, source: Node, output: &mut Vec<(Node, ResolutionMode)>) {
    let candidate = match node.kind() {
        SyntaxKind::ImportDeclaration | SyntaxKind::ExportDeclaration => {
            Some((node.module_specifier(), false))
        }
        SyntaxKind::ImportEqualsDeclaration
            if node.module_reference().kind() == SyntaxKind::ExternalModuleReference =>
        {
            Some((node.module_reference().expression(), false))
        }
        SyntaxKind::CallExpression if !node.arguments().is_empty() => {
            let callee = node.expression();
            if callee.kind() == SyntaxKind::ImportKeyword {
                Some((node.arguments().get(0), false))
            } else if callee.kind() == SyntaxKind::Identifier && callee.text() == "require" {
                Some((node.arguments().get(0), true))
            } else {
                None
            }
        }
        SyntaxKind::ImportType if node.argument().kind() == SyntaxKind::LiteralType => {
            Some((node.argument().literal(), false))
        }
        _ => None,
    };
    if let Some((literal, commonjs)) = candidate
        && literal.is_some()
        && is_string_literal_like(literal)
    {
        let mode = if commonjs {
            ModuleKind::COMMON_JS
        } else {
            get_mode_for_usage_location(source, literal)
        };
        output.push((literal, mode));
    }
    node.for_each_child(|child| {
        literals(child, source, output);
        false
    });
}

fn relative(path: &str) -> Option<&str> {
    path.strip_prefix("/project/")
        .filter(|path| !path.split('/').any(|part| part == "node_modules"))
}

pub fn observe(input: &Value) -> Result<Value, String> {
    let roots = crate::checker_program::install(input)?;
    let files = input["files"]
        .as_object()
        .ok_or("partition requires files")?
        .iter()
        .map(|(path, text)| {
            Ok((
                format!("/project/{path}"),
                text.as_str().ok_or("source must be text")?.to_owned(),
            ))
        })
        .collect::<Result<BTreeMap<_, _>, String>>()?;
    let resolver = module::new_resolver(ResolverOptions {
        host: Some(Rc::new(tsoptions::ResolverHost {
            fs: Rc::new(crate::files::Files(files)),
            current_directory: "/project".into(),
        })),
        compiler_options: Some(Rc::new(options().clone())),
        ..Default::default()
    });
    let sources: BTreeMap<_, _> = source_files()
        .into_iter()
        .filter_map(|source| {
            relative(source_file_file_name(source)).map(|path| (path.to_owned(), source))
        })
        .collect();
    let mut selected = BTreeSet::new();
    for root in &roots {
        let path = relative(root).ok_or("selected root outside repository graph")?;
        let source = sources.get(path).ok_or("selected source not loaded")?;
        if !source_file_info(*source).is_declaration_file {
            selected.insert(path.to_owned());
        }
    }
    let mut adjacency: BTreeMap<String, BTreeSet<String>> = sources
        .keys()
        .map(|path| (path.clone(), BTreeSet::new()))
        .collect();
    let mut edges = BTreeSet::new();
    let mut usages = Vec::new();
    for (path, source) in &sources {
        let mut found = Vec::new();
        literals(*source, *source, &mut found);
        for (literal, mode) in found {
            let (resolved, diagnostics, error) = resolver.resolve_module_name(
                literal.text(),
                source_file_file_name(*source),
                mode,
                None,
            );
            if let Some(error) = error {
                return Err(format!("TS7 module resolution failed: {error}"));
            }
            if !diagnostics.is_empty() {
                return Err("TS7 module resolution diagnostics".into());
            }
            let target = relative(&resolved.resolved_file_name);
            usages.push(
                json!({"from":path,"specifier":literal.text(),"mode":mode.0,"resolved":target}),
            );
            if let Some(target) = target.filter(|target| sources.contains_key(*target)) {
                adjacency
                    .get_mut(path)
                    .ok_or("loaded source absent")?
                    .insert(target.to_owned());
                adjacency
                    .get_mut(target)
                    .ok_or("loaded target absent")?
                    .insert(path.clone());
                edges.insert((path.clone(), literal.text().to_owned(), target.to_owned()));
            }
        }
    }
    let mut reached = BTreeSet::new();
    let mut groups = Vec::new();
    for root in &selected {
        if reached.contains(root) {
            continue;
        }
        let mut pending = VecDeque::from([root.clone()]);
        let mut group = Vec::new();
        while let Some(path) = pending.pop_front() {
            if !reached.insert(path.clone()) {
                continue;
            }
            if selected.contains(&path) {
                group.push(path.clone());
            }
            pending.extend(adjacency[&path].iter().cloned());
        }
        group.sort_by(|left, right| left.encode_utf16().cmp(right.encode_utf16()));
        groups.push(group);
    }
    groups.sort_by_key(|group| {
        group
            .iter()
            .map(|path| path.encode_utf16().collect::<Vec<_>>())
            .collect::<Vec<_>>()
    });
    let mut loaded: Vec<_> = sources.into_keys().collect();
    loaded.sort_by(|left, right| left.encode_utf16().cmp(right.encode_utf16()));
    let mut selected: Vec<_> = selected.into_iter().collect();
    selected.sort_by(|left, right| left.encode_utf16().cmp(right.encode_utf16()));
    Ok(
        json!({"executed":true,"unsupported":[],"loadedRepositorySources":loaded,"selectedRoots":selected,
        "dependencyComponents":groups,"resolvedEdges":edges.into_iter().map(|(from,specifier,to)| json!({"from":from,"specifier":specifier,"to":to})).collect::<Vec<_>>(),
        "literalUsages":usages}),
    )
}

#[cfg(test)]
mod tests {
    use super::observe;
    use serde_json::{Value, json};

    fn observation(mut input: Value) -> Value {
        let sdk = crate::checker_program::test_sdk_directory();
        input["sdk_directory"] = json!(sdk.path);
        let _program = ts_goport::core::enter_program(None);
        observe(&input).unwrap()
    }

    #[test]
    fn seven_literal_forms_join_endpoints_without_independent_root() {
        for source in [
            "export { value } from './target'",
            "export type { Shape } from './target'",
            "import type { Shape } from './target'; export type Loaded = Shape",
            "export const load = () => import('./target')",
            "export type Loaded = typeof import('./target')",
            "const loaded = require('./target'); export { loaded }",
            "import loaded = require('./target'); export { loaded }",
        ] {
            let got = observation(json!({"files":{
                "source.ts":source,"target.ts":"export interface Shape { id: string }; export const value = 1",
                "independent.ts":"export const independent = true"
            }}));
            assert_eq!(
                got["dependencyComponents"],
                json!([["independent.ts"], ["source.ts", "target.ts"]]),
                "{source}"
            );
        }
    }

    #[test]
    fn intermediate_is_loaded_but_not_selected_and_controls_do_not_join() {
        let got = observation(json!({"roots":["a.ts","b.ts","independent.ts"],"files":{
            "a.ts":"import { middle } from './middle'; export const a = middle",
            "middle.ts":"import { b } from './b'; export const middle = b",
            "b.ts":"export const b = 1",
            "independent.ts":"const specifier = './a'; import(specifier); require(specifier); object.require('./a'); export {}"
        }}));
        assert_eq!(
            got["dependencyComponents"],
            json!([["a.ts", "b.ts"], ["independent.ts"]])
        );
        assert_eq!(
            got["loadedRepositorySources"],
            json!(["a.ts", "b.ts", "independent.ts", "middle.ts"])
        );
        assert_eq!(
            got["selectedRoots"],
            json!(["a.ts", "b.ts", "independent.ts"])
        );
    }

    #[test]
    fn commonjs_require_selects_require_condition_and_import_selects_import_condition() {
        for (source, expected) in [
            (
                "const loaded = require('#choice'); export { loaded }",
                json!([["cjs.ts", "source.ts"], ["esm.ts"]]),
            ),
            (
                "export { value } from '#choice'",
                json!([["cjs.ts"], ["esm.ts", "source.ts"]]),
            ),
        ] {
            let got = observation(json!({"roots":["source.ts","cjs.ts","esm.ts"],"files":{
                "source.ts":source,"cjs.ts":"export const value = 1","esm.ts":"export const value = 2",
                "package.json":"{\"type\":\"module\",\"imports\":{\"#choice\":{\"import\":\"./esm.ts\",\"require\":\"./cjs.ts\"}}}"
            }}));
            assert_eq!(got["dependencyComponents"], expected, "{source}");
        }
    }

    #[test]
    fn external_package_and_unresolved_links_do_not_connect_roots() {
        let got = observation(json!({"roots":["a.ts","b.ts"],"files":{
            "a.ts":"import { value } from 'external'; import './missing'; export const a = value",
            "b.ts":"import { value } from 'external'; export const b = value",
            "node_modules/external/package.json":"{\"types\":\"index.d.ts\"}",
            "node_modules/external/index.d.ts":"export declare const value: number"
        }}));
        assert_eq!(got["dependencyComponents"], json!([["a.ts"], ["b.ts"]]));
        assert_eq!(got["resolvedEdges"], json!([]));
    }

    #[test]
    fn selected_root_outside_repository_graph_refuses() {
        let sdk = crate::checker_program::test_sdk_directory();
        let _program = ts_goport::core::enter_program(None);
        let got = observe(&json!({"sdk_directory":sdk.path,
            "files":{"node_modules/external/index.ts":"export const value = 1"},
            "roots":["node_modules/external/index.ts"]}));
        assert!(got.is_err());
    }

    #[test]
    fn missing_sources_refuse_instead_of_empty_success() {
        let _program = ts_goport::core::enter_program(None);
        assert!(observe(&json!({"files":{}})).is_err());
    }
}
