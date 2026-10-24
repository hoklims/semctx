use crate::ordinary::{Extraction, Symbol};
use serde_json::{Value, json};
use std::{
    cmp::Ordering,
    collections::{BTreeMap, BTreeSet},
    path::Path,
};
use unicode_normalization::UnicodeNormalization;

type Coordinate = (String, String);
type Reasons = BTreeMap<String, BTreeSet<String>>;

fn compare_ids(left: &str, right: &str) -> Ordering {
    left.encode_utf16().cmp(right.encode_utf16())
}
fn normalized_path(value: &str) -> String {
    let value = value.replace('\\', "/");
    value.strip_prefix("./").unwrap_or(&value).to_owned()
}
fn slugify(value: &str) -> String {
    let lowered = value.to_lowercase();
    let mut output = String::new();
    let mut separated = false;
    for c in lowered.nfkd().filter(char::is_ascii) {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            if separated && !output.is_empty() {
                output.push('-')
            }
            separated = false;
            output.push(c);
        } else {
            separated = true
        }
    }
    if output.is_empty() {
        "empty".into()
    } else {
        output.chars().take(60).collect()
    }
}
fn edge_id(kind: &str, from: &str, to: &str) -> String {
    let mut hash = 0x811c9dc5u32;
    for unit in format!("{from}->{to}").encode_utf16() {
        hash = (hash ^ u32::from(unit)).wrapping_mul(0x01000193);
    }
    format!("edge:{kind}:{hash:08x}")
}
fn insert_node(nodes: &mut BTreeMap<String, Value>, mut incoming: Value) -> Result<(), String> {
    let id = incoming["id"].as_str().ok_or("INVALID_NODE_ID")?.to_owned();
    for (key, default) in [
        ("evidence", json!([])),
        ("tags", json!([])),
        ("metadata", json!({})),
    ] {
        if incoming.get(key).is_none() {
            incoming[key] = default
        }
    }
    let Some(existing) = nodes.get_mut(&id) else {
        nodes.insert(id, incoming);
        return Ok(());
    };
    if ["kind", "name"]
        .iter()
        .any(|key| existing[key] != incoming[key])
        || ["filePath", "boundedContext"].iter().any(|key| {
            existing.get(key).is_some()
                && incoming.get(key).is_some()
                && existing[key] != incoming[key]
        })
    {
        return Err(format!("FACT_ID_CONFLICT:{id}"));
    }
    for (key, value) in incoming["metadata"]
        .as_object()
        .ok_or("INVALID_NODE_METADATA")?
    {
        if key != "statement"
            && existing["metadata"]
                .get(key)
                .is_some_and(|old| old != value)
        {
            return Err(format!("FACT_ID_CONFLICT:{id}:metadata:{key}"));
        }
    }
    existing["evidence"]
        .as_array_mut()
        .ok_or("INVALID_NODE_EVIDENCE")?
        .extend(
            incoming["evidence"]
                .as_array()
                .ok_or("INVALID_NODE_EVIDENCE")?
                .iter()
                .cloned(),
        );
    for tag in incoming["tags"].as_array().ok_or("INVALID_NODE_TAGS")? {
        if !existing["tags"]
            .as_array()
            .ok_or("INVALID_NODE_TAGS")?
            .contains(tag)
        {
            existing["tags"].as_array_mut().unwrap().push(tag.clone());
        }
    }
    for (key, value) in incoming["metadata"].as_object().unwrap() {
        if existing["metadata"].get(key).is_none() {
            existing["metadata"][key] = value.clone()
        }
    }
    for key in ["filePath", "boundedContext"] {
        if existing.get(key).is_none()
            && let Some(value) = incoming.get(key)
        {
            existing[key] = value.clone()
        }
    }
    if incoming["exported"] == true {
        existing["exported"] = json!(true)
    }
    Ok(())
}

fn path(symbol: &Symbol) -> String {
    symbol
        .scope
        .iter()
        .chain(std::iter::once(&symbol.name))
        .cloned()
        .collect::<Vec<_>>()
        .join(".")
}

fn unique<'a>(
    index: &'a BTreeMap<Coordinate, Vec<String>>,
    file: &str,
    name: &str,
) -> Option<&'a String> {
    let values = index.get(&(file.into(), name.into()))?;
    (values.len() == 1).then(|| &values[0])
}

fn reason(reasons: &mut Reasons, file: &str, value: String) {
    reasons.entry(file.into()).or_default().insert(value);
}

fn coordinate_reason(
    index: &BTreeMap<Coordinate, Vec<String>>,
    modules: &BTreeSet<String>,
    reasons: &mut Reasons,
    owner: &str,
    role: &str,
    file: &str,
    name: &str,
) {
    if !modules.contains(file) {
        return;
    }
    let count = index.get(&(file.into(), name.into())).map_or(0, Vec::len);
    if count != 1 {
        reason(
            reasons,
            owner,
            format!(
                "QUALIFIED_CALL_COORDINATE_{role}_{}:{file}:{name}",
                if count == 0 { "MISSING" } else { "AMBIGUOUS" }
            ),
        );
    }
}

#[expect(
    clippy::excessive_nesting,
    reason = "The native graph assembly keeps declaration and marker traversal explicit in this feasibility port."
)]
pub fn assemble(
    raw: &Extraction,
    roles: &BTreeMap<String, String>,
    qualified: bool,
    repo: &str,
    dynamic_imports: &BTreeSet<(String, u32, String)>,
) -> Result<Value, String> {
    let mut groups: BTreeMap<(String, String, String, String), Vec<&Symbol>> = BTreeMap::new();
    for symbol in &raw.symbols {
        groups
            .entry((
                symbol.kind.clone(),
                symbol.rel_path.clone(),
                symbol.scope.join("."),
                symbol.name.clone(),
            ))
            .or_default()
            .push(symbol);
    }
    let mut symbols = vec![];
    let mut coordinates: BTreeMap<Coordinate, Vec<String>> = BTreeMap::new();
    let mut importable: BTreeMap<Coordinate, Vec<String>> = BTreeMap::new();
    let mut nodes = BTreeMap::new();
    let leaf = repo
        .split(['/', '\\'])
        .rfind(|part| !part.is_empty())
        .unwrap_or("repository");
    let repository_id = format!("repo:{}", slugify(leaf));
    insert_node(
        &mut nodes,
        json!({"id":repository_id,"kind":"repository",
        "name":Path::new(repo).file_name().and_then(|name|name.to_str()).filter(|s|!s.is_empty()).unwrap_or("repository"),
        "metadata":{"root":repo}}),
    )?;
    let mut marker_statements: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    let mut import_specifiers: BTreeMap<(String, String), BTreeSet<String>> = BTreeMap::new();
    let mut edge_map: BTreeMap<(String, String, String), Vec<Value>> = BTreeMap::new();
    let module_ids: BTreeMap<String, String> = roles
        .iter()
        .map(|(file, role)| {
            (
                file.clone(),
                format!(
                    "{}:{}",
                    if role == "test" { "test" } else { "mod" },
                    normalized_path(file)
                ),
            )
        })
        .collect();
    for (file, id) in &module_ids {
        insert_node(
            &mut nodes,
            json!({"id":id,"kind":if roles[file] == "test" { "test" } else { "module" },
            "name":Path::new(file).file_name().and_then(|name|name.to_str()).unwrap_or(file),"filePath":file,
            "evidence":[{"filePath":file,"sourceKind":if roles[file]=="test" {"test"} else {"code"}}]}),
        )?;
        edge_map
            .entry(("belongs_to".into(), id.clone(), repository_id.clone()))
            .or_default()
            .push(json!({"filePath":file,"sourceKind":"code"}));
    }
    let mut ordered_groups: Vec<_> = groups.into_values().collect();
    ordered_groups.sort_by(|left, right| {
        compare_ids(
            &format!(
                "sym:{}:{}:{}",
                left[0].kind,
                normalized_path(&left[0].rel_path),
                path(left[0])
            ),
            &format!(
                "sym:{}:{}:{}",
                right[0].kind,
                normalized_path(&right[0].rel_path),
                path(right[0])
            ),
        )
    });
    for mut members in ordered_groups {
        members.sort_by_key(|symbol| (symbol.start_line, symbol.end_line));
        let first = members[0];
        let collision = first.kind == "function"
            && members
                .iter()
                .filter(|symbol| symbol.signature_only != Some(true))
                .count()
                > 1;
        let chunks = if collision {
            members
                .iter()
                .map(|symbol| vec![*symbol])
                .collect::<Vec<_>>()
        } else {
            vec![members.clone()]
        };
        for (ordinal, chunk) in chunks.into_iter().enumerate() {
            let first = chunk[0];
            let coordinate = path(first);
            let id = format!(
                "sym:{}:{}:{coordinate}{}",
                first.kind,
                normalized_path(&first.rel_path),
                if collision {
                    format!("#{}", ordinal + 1)
                } else {
                    String::new()
                }
            );
            let declarations: Vec<_> = chunk
                .iter()
                .map(|symbol| json!({"startLine":symbol.start_line,"endLine":symbol.end_line,"startUtf16":symbol.start_utf16,"endUtf16":symbol.end_utf16}))
                .collect();
            let evidence: Vec<_> = chunk.iter().map(|symbol| json!({"filePath":symbol.rel_path,"startLine":symbol.start_line,"endLine":symbol.end_line,"sourceKind":"code"})).collect();
            let mut markers = vec![];
            let mut seen = BTreeSet::new();
            for symbol in &chunk {
                for marker in &symbol.markers {
                    if seen.insert((
                        marker.tag.clone(),
                        marker.slug.clone(),
                        marker.statement.clone().unwrap_or_default(),
                        symbol.start_line,
                    )) {
                        let mut value = serde_json::to_value(marker).expect("marker serialization");
                        value["startLine"] = json!(symbol.start_line);
                        markers.push(value);
                    }
                }
            }
            let mut logical = json!({"id":id,"name":first.name,"kind":first.kind,"relPath":first.rel_path,"scope":first.scope,"exported":chunk.iter().any(|s|s.exported),"declarations":declarations,"markers":markers});
            if let Some(doc) = chunk.iter().find_map(|symbol| symbol.jsdoc.as_ref()) {
                logical["jsdoc"] = json!(doc);
            }
            symbols.push(logical.clone());
            let mut metadata = json!({"exported":chunk.iter().any(|s|s.exported)});
            if !first.scope.is_empty() {
                metadata["scope"] = json!(first.scope.join("."))
            }
            insert_node(
                &mut nodes,
                json!({"id":id,"kind":first.kind,"name":first.name,"filePath":first.rel_path,
                "exported":chunk.iter().any(|s|s.exported),"evidence":evidence,"metadata":metadata}),
            )?;
            for marker in logical["markers"].as_array().unwrap() {
                let tag = marker["tag"].as_str().unwrap_or_default();
                let slug = marker["slug"].as_str().unwrap_or_default();
                let ev = json!({"filePath":first.rel_path,"startLine":marker["startLine"],"sourceKind":"code"});
                if tag == "tag" {
                    let tags = nodes.get_mut(&id).unwrap()["tags"].as_array_mut().unwrap();
                    if !tags.contains(&json!(slug)) {
                        tags.push(json!(slug))
                    }
                    continue;
                }
                let (prefix, kind, relation) = match tag {
                    "capability" => ("cap", "capability", "implements_capability"),
                    "invariant" => ("inv", "invariant", "constrained_by"),
                    "contract" => ("contract", "contract", "declares"),
                    "risk" => ("risk", "risk", "related_to"),
                    "boundedContext" => ("bc", "bounded_context", "belongs_to"),
                    _ => continue,
                };
                let target = format!("{prefix}:{}", slugify(slug));
                let mut marker_node = json!({"id":target,"kind":kind,"name":slug,"evidence":[ev],"tags":[],"metadata":{}});
                if tag != "boundedContext" {
                    marker_node["tags"] = json!(["from-code"]);
                    if let Some(statement) = marker.get("statement") {
                        marker_node["metadata"]["statement"] = statement.clone();
                        if let Some(text) = statement.as_str() {
                            marker_statements
                                .entry(target.clone())
                                .or_default()
                                .insert(text.into());
                        }
                    }
                } else if nodes[&id].get("boundedContext").is_none() {
                    nodes.get_mut(&id).unwrap()["boundedContext"] = json!(slug);
                }
                insert_node(&mut nodes, marker_node)?;
                edge_map
                    .entry((relation.into(), id.clone(), target))
                    .or_default()
                    .push(ev);
            }
            coordinates
                .entry((first.rel_path.clone(), coordinate))
                .or_default()
                .push(id.clone());
            if first.scope.is_empty() {
                importable
                    .entry((first.rel_path.clone(), first.name.clone()))
                    .or_default()
                    .push(id.clone());
            }
            if let Some(module) = module_ids.get(&first.rel_path) {
                edge_map.entry(("declares".into(),module.clone(),id)).or_default().push(json!({"filePath":first.rel_path,"startLine":first.start_line,"sourceKind":"code"}));
            }
        }
    }
    let modules: BTreeSet<_> = raw.modules.iter().cloned().collect();
    let mut reasons = Reasons::new();
    for call in &raw.calls {
        if qualified {
            if let Some(unmodeled) = &call.caller_unmodeled_reason
                && modules.contains(&call.caller_rel_path)
            {
                reason(
                    &mut reasons,
                    &call.caller_rel_path,
                    format!(
                        "QUALIFIED_CALL_COORDINATE_CALLER_UNMODELED:{}:{unmodeled}",
                        call.caller_rel_path
                    ),
                );
                continue;
            }
            if let (Some(file), Some(unmodeled)) =
                (&call.callee_rel_path, &call.callee_unmodeled_reason)
                && modules.contains(file)
            {
                reason(
                    &mut reasons,
                    &call.caller_rel_path,
                    format!("QUALIFIED_CALL_COORDINATE_CALLEE_UNMODELED:{file}:{unmodeled}"),
                );
                continue;
            }
            if let Some(name) = &call.caller_symbol_path {
                coordinate_reason(
                    &coordinates,
                    &modules,
                    &mut reasons,
                    &call.caller_rel_path,
                    "CALLER",
                    &call.caller_rel_path,
                    name,
                );
            }
            if let (Some(file), Some(name)) = (&call.callee_rel_path, &call.callee_symbol_path) {
                coordinate_reason(
                    &coordinates,
                    &modules,
                    &mut reasons,
                    &call.caller_rel_path,
                    "CALLEE",
                    file,
                    name,
                );
            }
        }
        let (Some(callee_file), Some(callee_name)) =
            (&call.callee_rel_path, &call.callee_symbol_path)
        else {
            continue;
        };
        let Some(to) = unique(&coordinates, callee_file, callee_name) else {
            continue;
        };
        let from = match &call.caller_symbol_path {
            Some(name) => unique(&coordinates, &call.caller_rel_path, name),
            None => module_ids.get(&call.caller_rel_path),
        };
        if let Some(from) = from {
            edge_map.entry(("calls".into(),from.clone(),to.clone())).or_default().push(json!({"filePath":call.caller_rel_path,"startLine":call.line,"sourceKind":"code"}));
        }
    }
    for import in &raw.imports {
        if let (Some(from), Some(to)) = (
            module_ids.get(&import.from_rel_path),
            import
                .resolved_rel_path
                .as_ref()
                .and_then(|file| module_ids.get(file)),
        ) {
            edge_map.entry(("imports".into(),from.clone(),to.clone())).or_default().push(json!({"filePath":import.from_rel_path,"startLine":import.line,"sourceKind":"code"}));
            import_specifiers
                .entry((from.clone(), to.clone()))
                .or_default()
                .insert(import.module_specifier.clone());
        }
        if qualified {
            if import.binding_targets.is_none()
                && dynamic_imports.contains(&(
                    import.from_rel_path.clone(),
                    import.line,
                    import.module_specifier.clone(),
                ))
                && let Some(resolved) = &import.resolved_rel_path
            {
                reason(
                    &mut reasons,
                    &import.from_rel_path,
                    format!("QUALIFIED_TEST_DYNAMIC_IMPORT_BINDING_UNPROVEN:{resolved}"),
                );
            }
            for binding in import.binding_targets.iter().flatten() {
                if binding.runtime_used == Some(false) || !modules.contains(&binding.rel_path) {
                    continue;
                }
                let count = coordinates
                    .get(&(binding.rel_path.clone(), binding.symbol_path.clone()))
                    .map_or(0, Vec::len);
                if count == 1 && binding.unmodeled_reason.is_none() {
                    continue;
                }
                let prefix = if roles
                    .get(&import.from_rel_path)
                    .is_some_and(|role| role == "test")
                {
                    "QUALIFIED_TEST_BINDING"
                } else {
                    "QUALIFIED_IMPORT_BINDING"
                };
                let kind = if count == 0 {
                    "MISSING"
                } else if count > 1 {
                    "AMBIGUOUS"
                } else {
                    "UNMODELED"
                };
                let suffix = if kind == "UNMODELED" {
                    format!(
                        ":{}",
                        binding.unmodeled_reason.as_deref().unwrap_or_default()
                    )
                } else {
                    String::new()
                };
                reason(
                    &mut reasons,
                    &import.from_rel_path,
                    format!(
                        "{prefix}_{kind}:{}:{}{suffix}",
                        binding.rel_path, binding.symbol_path
                    ),
                );
            }
        }
        if roles
            .get(&import.from_rel_path)
            .is_none_or(|role| role != "test")
        {
            continue;
        }
        let Some(test) = module_ids.get(&import.from_rel_path) else {
            continue;
        };
        let targets = match &import.binding_targets {
            Some(bindings) => bindings
                .iter()
                .filter(|binding| binding.unmodeled_reason.is_none())
                .filter_map(|binding| unique(&coordinates, &binding.rel_path, &binding.symbol_path))
                .collect::<Vec<_>>(),
            None => import
                .resolved_rel_path
                .as_ref()
                .map(|file| {
                    import
                        .names
                        .iter()
                        .filter_map(|name| unique(&importable, file, name))
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default(),
        };
        for target in targets {
            let evidence = json!({"filePath":import.from_rel_path,"startLine":import.line,"sourceKind":"test"});
            edge_map
                .entry(("tested_by".into(), target.clone(), test.clone()))
                .or_default()
                .push(evidence.clone());
            edge_map
                .entry(("covers".into(), test.clone(), target.clone()))
                .or_default()
                .push(evidence);
        }
    }

    for (id, statements) in marker_statements {
        if statements.len() < 2 {
            continue;
        }
        let node = nodes.get_mut(&id).ok_or("MISSING_MARKER_NODE")?;
        node["metadata"]
            .as_object_mut()
            .unwrap()
            .remove("statement");
        let tags = node["tags"].as_array_mut().unwrap();
        if !tags.contains(&json!("statement-divergent")) {
            tags.push(json!("statement-divergent"))
        }
        tags.sort_by(|left, right| {
            compare_ids(
                left.as_str().unwrap_or_default(),
                right.as_str().unwrap_or_default(),
            )
        });
    }
    let mut edges:Vec<_>=edge_map.into_iter().map(|((kind,from,to),mut evidence)| {
        let mut metadata=json!({});
        if kind=="imports" {
            evidence.sort_by(|left,right|compare_ids(&crate::identity::canonical_json(left),&crate::identity::canonical_json(right)));
            evidence.dedup();
            let mut specifiers:Vec<_>=import_specifiers.remove(&(from.clone(),to.clone())).unwrap_or_default().into_iter().collect();
            specifiers.sort_by(|left,right|compare_ids(left,right));
            metadata=if specifiers.len()==1 {json!({"specifier":specifiers[0]})}
                else {json!({"specifiers":crate::identity::canonical_json(&json!(specifiers))})};
        }
        json!({"id":edge_id(&kind,&from,&to),"kind":kind,"from":from,"to":to,"evidence":evidence,"metadata":metadata})
    }).collect();
    edges.sort_by(|left, right| {
        compare_ids(
            left["id"].as_str().unwrap_or_default(),
            right["id"].as_str().unwrap_or_default(),
        )
    });
    symbols.sort_by(|left, right| {
        compare_ids(
            left["id"].as_str().unwrap_or_default(),
            right["id"].as_str().unwrap_or_default(),
        )
    });
    let mut nodes: Vec<_> = nodes.into_values().collect();
    nodes.sort_by(|left, right| {
        compare_ids(
            left["id"].as_str().unwrap_or_default(),
            right["id"].as_str().unwrap_or_default(),
        )
    });
    Ok(json!({"symbols":symbols,"nodes":nodes,"edges":edges,"integrityReasons":reasons}))
}

#[cfg(test)]
#[path = "../tests/unit/assembly.rs"]
mod tests;
