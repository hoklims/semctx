use semctx_gates::process;
use semctx_r0_probe::identity;
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

fn sha(bytes: &[u8]) -> String {
    identity::digest_bytes(bytes)
        .trim_start_matches("sha256:")
        .into()
}
fn read_json(path: &Path) -> Result<Value, String> {
    serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}
fn save(path: &Path, value: &Value) -> Result<(), String> {
    fs::write(
        path,
        serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())
}
fn value_text<'a>(v: &'a Value, key: &str) -> Result<&'a str, String> {
    v.get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("missing string {key}"))
}
fn exact_hash(path: &Path, expected: &str) -> Result<String, String> {
    let actual = sha(&fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?);
    if actual != expected.trim_start_matches("sha256:") {
        return Err(format!("identity mismatch: {}", path.display()));
    }
    Ok(actual)
}
fn select<'a>(root: &'a Value, steps: &[Value]) -> Result<&'a Value, String> {
    let mut cursor = root;
    for step in steps {
        if let Some(key) = step.as_str() {
            cursor = cursor
                .get(key)
                .ok_or_else(|| format!("missing observed field {key}"))?;
        } else if let Some(index) = step.as_u64() {
            cursor = cursor
                .get(index as usize)
                .ok_or_else(|| format!("missing observed index {index}"))?;
        } else if let Some(filter) = step.as_object() {
            let values = cursor
                .as_array()
                .ok_or("selector requires observed array")?;
            let found = values
                .iter()
                .filter(|v| filter.iter().all(|(k, x)| v.get(k) == Some(x)))
                .collect::<Vec<_>>();
            if found.len() != 1 {
                return Err(format!(
                    "selector expected one observed value, found {}",
                    found.len()
                ));
            }
            cursor = found[0];
        } else {
            return Err("invalid adapter selector".into());
        }
    }
    Ok(cursor)
}
fn projected_eq(actual: &Value, expected: &Value) -> bool {
    match expected {
        Value::Object(fields) => actual.as_object().is_some_and(|a| {
            fields.iter().all(|(k, v)| {
                if v == &json!({"$field_absent":true}) {
                    !a.contains_key(k)
                } else {
                    a.get(k).is_some_and(|av| projected_eq(av, v))
                }
            })
        }),
        Value::Array(values) => actual.as_array().is_some_and(|a| {
            a.len() == values.len() && a.iter().zip(values).all(|(av, ev)| projected_eq(av, ev))
        }),
        _ => actual == expected,
    }
}
fn injective_matches(actual: &[Value], expected: &[Value]) -> bool {
    fn augment(
        e: usize,
        a: &[Value],
        b: &[Value],
        seen: &mut [bool],
        owners: &mut [Option<usize>],
    ) -> bool {
        for n in 0..a.len() {
            if !seen[n] && projected_eq(&a[n], &b[e]) {
                seen[n] = true;
                if owners[n].is_none() || augment(owners[n].unwrap(), a, b, seen, owners) {
                    owners[n] = Some(e);
                    return true;
                }
            }
        }
        false
    }
    let mut owners = vec![None; actual.len()];
    (0..expected.len()).all(|e| {
        augment(
            e,
            actual,
            expected,
            &mut vec![false; actual.len()],
            &mut owners,
        )
    })
}
fn clone_field(object: &mut serde_json::Map<String, Value>, value: &Value, to: &str, from: &str) {
    if let Some(v) = value.get(from) {
        object.insert(to.into(), v.clone());
    }
}
fn transform(actual: &Value, name: &str) -> Result<Value, String> {
    if name == "none" {
        return Ok(actual.clone());
    }
    if name == "logical_coverage_edges" || name == "logical_import_edges" {
        let nodes = actual["nodes"]
            .as_array()
            .ok_or("missing actual graph nodes")?;
        let symbols = actual["symbols"]
            .as_array()
            .ok_or("missing actual grouped symbols")?;
        let coordinate = |id: &Value| -> Result<Value, String> {
            let matches = nodes
                .iter()
                .filter(|n| n.get("id") == Some(id))
                .collect::<Vec<_>>();
            if matches.len() != 1 {
                return Err("graph endpoint does not identify one actual node".into());
            }
            let node = matches[0];
            let path = value_text(node, "filePath")?;
            if node["kind"] == "test" {
                return Ok(json!({"path":path,"test_node":true}));
            }
            if node["kind"] == "module" {
                return Ok(json!({"path":path,"module_node":true}));
            }
            let matches = symbols
                .iter()
                .filter(|n| n.get("id") == Some(id))
                .collect::<Vec<_>>();
            if matches.len() != 1 {
                return Err("symbol endpoint lacks unique actual logical coordinate".into());
            }
            let symbol = matches[0];
            let mut names = symbol["scope"]
                .as_array()
                .ok_or("missing symbol scope")?
                .iter()
                .map(|s| s.as_str().ok_or("invalid scope"))
                .collect::<Result<Vec<_>, _>>()?;
            names.push(value_text(symbol, "name")?);
            Ok(json!({"path":path,"symbol_path":names.join(".")}))
        };
        let mut values = vec![];
        for edge in actual["edges"]
            .as_array()
            .ok_or("missing actual graph edges")?
        {
            let kind = value_text(edge, "kind")?;
            if if name == "logical_coverage_edges" {
                !["covers", "tested_by"].contains(&kind)
            } else {
                kind != "imports"
            } {
                continue;
            }
            values.push(json!({"kind":kind,"from":coordinate(&edge["from"])?,"to":coordinate(&edge["to"])?}));
        }
        return Ok(json!(values));
    }
    let values = actual
        .as_array()
        .ok_or("adapter transform requires observed array")?;
    if name == "reason_prefix" {
        return values
            .iter()
            .map(|v| {
                let text = v.as_str().ok_or("malformed native reason string")?;
                let (prefix, _) = text
                    .split_once(':')
                    .ok_or("native reason lacks declared prefix separator")?;
                Ok(json!(prefix))
            })
            .collect::<Result<Vec<_>, String>>()
            .map(Value::Array);
    }
    if name == "configuration_diagnostic_projection" {
        let mut diagnostics = vec![];
        for value in values {
            let reason = value
                .as_str()
                .ok_or("malformed native configuration reason")?;
            if let Some(detail) = reason.strip_prefix("SOURCE_CONFIGURATION_INVALID:") {
                let (code, _) = detail
                    .split_once(':')
                    .ok_or("native configuration diagnostic lacks message separator")?;
                let code = code
                    .parse::<u32>()
                    .map_err(|_| "native configuration diagnostic code malformed")?;
                diagnostics.push(json!({"reason":"SOURCE_CONFIGURATION_INVALID","code":code}));
            }
        }
        return Ok(json!(diagnostics));
    }
    if let Some(field) = name.strip_prefix("pluck:") {
        return values
            .iter()
            .map(|v| {
                v.get(field)
                    .cloned()
                    .ok_or_else(|| format!("missing actual projection field {field}"))
            })
            .collect::<Result<Vec<_>, _>>()
            .map(Value::Array);
    }
    if name == "statement_line_triples" {
        return values
            .iter()
            .map(|v| {
                Ok(json!([
                    v.get("startLine").ok_or("missing startLine")?,
                    v.get("endLine").ok_or("missing endLine")?,
                    v.get("leadingStartLine")
                        .ok_or("missing leadingStartLine")?
                ]))
            })
            .collect::<Result<Vec<Value>, String>>()
            .map(Value::Array);
    }
    let mut result = vec![];
    for value in values {
        if name == "symbol_coordinates" {
            let path = value.get("relPath").ok_or("missing symbol path")?;
            let mut parts = value
                .get("scope")
                .and_then(Value::as_array)
                .cloned()
                .ok_or("missing symbol scope")?;
            parts.push(value.get("name").ok_or("missing symbol name")?.clone());
            let names = parts
                .iter()
                .map(|p| p.as_str().ok_or("invalid symbol scope"))
                .collect::<Result<Vec<_>, _>>()?;
            result.push(json!([path, names.join(".")]));
            continue;
        }
        if name == "binding_aliases" {
            let Some(bindings) = value.get("bindingTargets") else {
                continue;
            };
            for binding in bindings.as_array().ok_or("invalid bindingTargets")? {
                let mut object = binding
                    .as_object()
                    .cloned()
                    .ok_or("invalid binding target")?;
                clone_field(&mut object, value, "importer", "fromRelPath");
                if let (Some(p), Some(s)) = (binding.get("relPath"), binding.get("symbolPath")) {
                    object.insert("target".into(), json!([p, s]));
                }
                result.push(Value::Object(object));
            }
            continue;
        }
        let mut object = value
            .as_object()
            .cloned()
            .ok_or("invalid observed object")?;
        match name {
            "symbol_aliases" => clone_field(&mut object, value, "path", "relPath"),
            "import_aliases" => {
                for (to, from) in [
                    ("from", "fromRelPath"),
                    ("specifier", "moduleSpecifier"),
                    ("resolved", "resolvedRelPath"),
                ] {
                    clone_field(&mut object, value, to, from);
                }
            }
            "call_aliases" | "public_call_aliases" => {
                for (to, from) in [
                    ("caller_path", "callerRelPath"),
                    ("caller_symbol", "callerSymbolPath"),
                    ("callee_path", "calleeRelPath"),
                    ("callee_symbol", "calleeSymbolPath"),
                ] {
                    clone_field(&mut object, value, to, from);
                }
                if let (Some(p), Some(s)) =
                    (value.get("callerRelPath"), value.get("callerSymbolPath"))
                {
                    object.insert("caller".into(), json!([p, s]));
                }
                if let (Some(p), Some(s)) =
                    (value.get("calleeRelPath"), value.get("calleeSymbolPath"))
                {
                    object.insert("callee".into(), json!([p, s]));
                }
            }
            _ => return Err(format!("unknown adapter transform {name}")),
        }
        result.push(Value::Object(object));
    }
    Ok(Value::Array(result))
}
fn confined_coordinate(path: &str) -> bool {
    !path.starts_with('/')
        && !path.starts_with('\\')
        && !path.split(['/', '\\']).any(|part| part == "..")
        && path.as_bytes().get(1).is_none_or(|byte| *byte != b':')
}
fn compare(actual: &Value, expected: &Value, mode: &str) -> Result<bool, String> {
    match mode {
        "eq" => Ok(actual == expected),
        "neq" => Ok(actual != expected),
        "contains_text" => Ok(actual
            .as_str()
            .ok_or("expected observed error string")?
            .contains(expected.as_str().ok_or("expected frozen error substring")?)),
        "prefix_count" => {
            let rows = actual.as_array().ok_or("missing observed rows")?;
            let prefix = value_text(expected, "prefix")?;
            let count = expected["count"].as_u64().ok_or("missing expected count")?;
            let ids = rows
                .iter()
                .map(|n| value_text(n, "id"))
                .collect::<Result<Vec<_>, _>>()?;
            Ok(ids.iter().filter(|id| id.starts_with(prefix)).count() as u64 == count)
        }
        "ordered_projected_eq" => Ok(projected_eq(actual, expected)),
        "unordered_projected_eq" | "contains_projected" | "excludes_projected" => {
            let a = actual.as_array().ok_or("expected observed array")?;
            let e = expected.as_array().ok_or("expected frozen array")?;
            Ok(match mode {
                "unordered_projected_eq" => a.len() == e.len() && injective_matches(a, e),
                "contains_projected" => injective_matches(a, e),
                _ => !a.iter().any(|v| e.iter().any(|x| projected_eq(v, x))),
            })
        }
        "indexed_field_absences" => {
            let a = actual.as_array().ok_or("expected observed binding list")?;
            let entries = expected.as_array().ok_or("expected indexed absence list")?;
            for e in entries {
                let index = e["index"].as_u64().ok_or("missing binding index")? as usize;
                let object = a
                    .get(index)
                    .and_then(Value::as_object)
                    .ok_or("missing observed binding index")?;
                for field in e["fields"].as_array().ok_or("missing absence fields")? {
                    if object.contains_key(field.as_str().ok_or("invalid absence field")?) {
                        return Ok(false);
                    }
                }
            }
            Ok(true)
        }
        "all_fields_absent" => {
            let a = actual.as_array().ok_or("expected observed array")?;
            let e = expected.as_array().ok_or("expected frozen field list")?;
            Ok(a.iter().all(|v| {
                v.as_object().is_some_and(|o| {
                    e.iter()
                        .all(|k| k.as_str().is_some_and(|s| !o.contains_key(s)))
                })
            }))
        }
        "reason_constraints" => {
            let a = actual.as_array().ok_or("expected observed reason list")?;
            if a.iter().any(|v| !v.is_string()) {
                return Err("malformed observed reason".into());
            }
            let e = expected.as_object().ok_or("expected frozen constraints")?;
            let supported = [
                "contains",
                "excludes",
                "exact_set",
                "contains_prefix",
                "global_admission_inferred",
            ];
            if e.get("global_admission_inferred")
                .is_some_and(|v| v != &Value::Bool(false))
            {
                return Err("a reason projection cannot infer global admission".into());
            }
            if let Some(k) = e.keys().find(|k| !supported.contains(&k.as_str())) {
                return Err(format!("unmapped reason constraint {k}"));
            }
            let list = |key: &str| -> Result<Vec<String>, String> {
                match e.get(key) {
                    None | Some(Value::Null) => Ok(vec![]),
                    Some(v) => v
                        .as_array()
                        .ok_or_else(|| format!("invalid constraint {key}"))?
                        .iter()
                        .map(|x| {
                            x.as_str()
                                .map(str::to_string)
                                .ok_or_else(|| format!("invalid constraint value {key}"))
                        })
                        .collect(),
                }
            };
            let contains = list("contains")?;
            let excludes = list("excludes")?;
            let prefixes = list("contains_prefix")?;
            let mut ok = contains
                .iter()
                .all(|e| a.iter().any(|v| v.as_str() == Some(e)))
                && excludes
                    .iter()
                    .all(|e| a.iter().all(|v| v.as_str() != Some(e)))
                && prefixes
                    .iter()
                    .all(|e| a.iter().any(|v| v.as_str().unwrap().starts_with(e)));
            if let Some(exact) = e.get("exact_set").filter(|v| !v.is_null()) {
                let exact = exact.as_array().ok_or("invalid exact reason set")?;
                let av = a
                    .iter()
                    .map(|v| v.as_str().unwrap())
                    .collect::<BTreeSet<_>>();
                let ev = exact
                    .iter()
                    .map(|v| v.as_str().ok_or("invalid exact reason"))
                    .collect::<Result<BTreeSet<_>, _>>()?;
                ok &= av == ev && av.len() == a.len();
            }
            Ok(ok)
        }
        "confined_paths" => {
            fn confined(v: &Value) -> bool {
                match v {
                    Value::Object(o) => o.iter().all(|(k, x)| {
                        if [
                            "relPath",
                            "fromRelPath",
                            "resolvedRelPath",
                            "callerRelPath",
                            "calleeRelPath",
                        ]
                        .contains(&k.as_str())
                        {
                            x.as_str().is_some_and(confined_coordinate)
                        } else {
                            confined(x)
                        }
                    }),
                    Value::Array(a) => a.iter().all(confined),
                    _ => true,
                }
            }
            Ok(expected == &Value::Bool(true) && confined(actual))
        }
        _ => Err(format!("unimplemented comparator {mode}")),
    }
}
fn evaluate(observed: &Value, check: &Value) -> Value {
    let result = (|| -> Result<bool, String> {
        let steps = check
            .get("target")
            .and_then(Value::as_array)
            .ok_or("missing adapter selector")?;
        validate_reason_routing(check)?;
        let actual = select(observed, steps)?;
        let filtered = if let Some(filter) = check.get("actual_filter") {
            let f = filter
                .as_object()
                .ok_or("invalid explicit projection filter")?;
            Value::Array(
                actual
                    .as_array()
                    .ok_or("filter requires observed array")?
                    .iter()
                    .filter(|v| f.iter().all(|(k, e)| v.get(k) == Some(e)))
                    .cloned()
                    .collect(),
            )
        } else {
            actual.clone()
        };
        let filtered = if let Some(prefixes) = check.get("actual_filter_prefix") {
            let fields = prefixes.as_object().ok_or("invalid prefix filter")?;
            Value::Array(
                filtered
                    .as_array()
                    .ok_or("prefix filter requires observed array")?
                    .iter()
                    .filter(|v| {
                        fields.iter().all(|(k, p)| {
                            v.get(k)
                                .and_then(Value::as_str)
                                .zip(p.as_str())
                                .is_some_and(|(v, p)| v.starts_with(p))
                        })
                    })
                    .cloned()
                    .collect(),
            )
        } else {
            filtered
        };
        let transformed = transform(&filtered, value_text(check, "actual_transform")?)?;
        compare(
            &transformed,
            check.get("expected").ok_or("missing frozen expected")?,
            value_text(check, "mode")?,
        )
    })();
    match result {
        Ok(true) => json!({"state":"PASS_PROJECTED_PROPERTY"}),
        Ok(false) => json!({"state":"MISMATCH"}),
        Err(error) => json!({"state":"UNKNOWN_UNMAPPED_OR_MALFORMED","error":error}),
    }
}
fn join_successful_reads(observed: &Value, request: &Value, sdk: &Value) -> Result<Value, String> {
    let mut known = BTreeMap::new();
    for field in [request.get("files"), sdk.get("files")] {
        for (path, text) in field
            .and_then(Value::as_object)
            .ok_or("missing input file map")?
        {
            known.insert(
                path.clone(),
                identity::digest_bytes(
                    text.as_str().ok_or("non-string captured input")?.as_bytes(),
                ),
            );
        }
    }
    let probes = observed
        .get("capture_probes")
        .and_then(Value::as_array)
        .ok_or("missing real capture probes")?;
    let mut reads = BTreeSet::new();
    for probe in probes {
        let op = value_text(probe, "operation")?;
        let successful = op == "read_file" && probe.get("found") == Some(&Value::Bool(true));
        if successful {
            let path = value_text(probe, "path")?;
            let content = value_text(probe, "content_id")?;
            if known.get(path).map(String::as_str) != Some(content) {
                return Err(format!(
                    "successful read does not join captured input: {path}"
                ));
            }
            reads.insert(path.to_string());
        } else if probe.get("content_id").is_some_and(|v| !v.is_null()) {
            return Err("content identity claimed for a non-read".into());
        }
    }
    Ok(
        json!({"state":"JOINED_REPORTED_SUCCESSFUL_READS_ONLY","read_paths":reads,"supplied_sdk_files":sdk["files"].as_object().unwrap().len(),"all_supplied_sdk_consumed_claimed":false,"os_sandbox_claimed":false}),
    )
}
fn safe_relative(path: &str) -> bool {
    !path.is_empty()
        && !Path::new(path).is_absolute()
        && !path.split(['/', '\\']).any(|p| p == "..")
        && path.as_bytes().get(1).is_none_or(|c| *c != b':')
}
fn materialize(template: &Value, root: &Path, case_sensitive: bool) -> Result<Value, String> {
    let cwd = root
        .canonicalize()
        .map_err(|e| e.to_string())?
        .to_string_lossy()
        .replace('\\', "/");
    let mut request = template.clone();
    let mut files = serde_json::Map::new();
    for (path, text) in template["files"]
        .as_object()
        .ok_or("missing prepared input files")?
    {
        if !safe_relative(path) {
            return Err("authored path needs explicit root recipe".into());
        }
        let target = root.join(path);
        fs::create_dir_all(target.parent().unwrap()).map_err(|e| e.to_string())?;
        fs::write(
            &target,
            text.as_str()
                .ok_or("prepared source must be string")?
                .as_bytes(),
        )
        .map_err(|e| e.to_string())?;
        files.insert(format!("{cwd}/{path}"), text.clone());
    }
    let roots = template["roots"]
        .as_array()
        .ok_or("missing prepared roots")?
        .iter()
        .map(|p| {
            p.as_str()
                .filter(|p| safe_relative(p))
                .map(|p| json!(format!("{cwd}/{p}")))
                .ok_or("invalid prepared root")
        })
        .collect::<Result<Vec<_>, _>>()?;
    request["files"] = Value::Object(files);
    request["roots"] = Value::Array(roots);
    request["cwd"] = json!(cwd);
    request["case_sensitive"] = json!(case_sensitive);
    Ok(request)
}
fn verify_sources(base: &Path, recipes: &Value) -> Result<(), String> {
    exact_hash(
        &base.join("index.json"),
        value_text(recipes, "source_index_sha256")?,
    )?;
    for reference in recipes["immutable_sources"]
        .as_object()
        .ok_or("missing frozen source refs")?
        .values()
    {
        let path = value_text(reference, "path")?;
        if !safe_relative(path) {
            return Err("invalid frozen source path".into());
        }
        exact_hash(&base.join(path), value_text(reference, "sha256")?)?;
    }
    Ok(())
}
fn evaluate_relation(observations: &[Value], relation: &Value) -> Value {
    let result = (|| -> Result<bool, String> {
        let left = relation["left_observation"]
            .as_u64()
            .ok_or("missing left observation")? as usize;
        let right = relation["right_observation"]
            .as_u64()
            .ok_or("missing right observation")? as usize;
        let target = relation["target"]
            .as_array()
            .ok_or("missing relation target")?;
        let mut a = transform(
            select(
                observations
                    .get(left)
                    .ok_or("missing left native observation")?,
                target,
            )?,
            value_text(relation, "transform")?,
        )?;
        let mut b = transform(
            select(
                observations
                    .get(right)
                    .ok_or("missing right native observation")?,
                target,
            )?,
            value_text(relation, "transform")?,
        )?;
        if relation["first_only"] == true {
            a = a
                .as_array()
                .and_then(|v| v.first())
                .cloned()
                .ok_or("missing first actual left value")?;
            b = b
                .as_array()
                .and_then(|v| v.first())
                .cloned()
                .ok_or("missing first actual right value")?;
        }
        if let Some(expected) = relation["expected_equal"].as_bool() {
            return Ok((a == b) == expected);
        }
        let expected = relation["expected_equal"]
            .as_array()
            .ok_or("missing frozen pairwise relation")?;
        let av = a.as_array().ok_or("missing actual left collection")?;
        let bv = b.as_array().ok_or("missing actual right collection")?;
        Ok(av.len() == expected.len()
            && bv.len() == expected.len()
            && av
                .iter()
                .zip(bv)
                .zip(expected)
                .all(|((a, b), e)| e.as_bool() == Some(a == b)))
    })();
    match result {
        Ok(true) => json!({"state":"PASS_PROJECTED_PROPERTY"}),
        Ok(false) => json!({"state":"MISMATCH"}),
        Err(error) => json!({"state":"UNKNOWN_UNMAPPED_OR_MALFORMED","error":error}),
    }
}
fn run_raw_recipe(
    recipe: &Value,
    dir: &Path,
    artifact: &Path,
    helper: &Path,
    sdk_input: (&Path, &Value),
    artifact_sha: &str,
    helper_sha: &str,
) -> Result<Value, String> {
    let (sdk_path, sdk) = sdk_input;
    if let Err(error) = validate_component_checks(
        recipe["checks"]
            .as_array()
            .ok_or("missing credited raw checks")?,
    ) {
        return Ok(
            json!({"state":"NOT_EXECUTABLE_INCOMPLETE_COMPONENT_COMPARATOR","error":error,"pass":false}),
        );
    }
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let templates = recipe["requests"]
        .as_array()
        .ok_or("missing native request templates")?;
    if templates.is_empty() {
        return Ok(
            json!({"state":"NOT_EXECUTABLE_INPUT_GAP","pass":false,"error":"no actual request"}),
        );
    }
    let mut observations = vec![];
    let mut boundaries = vec![];
    for (index, template) in templates.iter().enumerate() {
        let subdir = if templates.len() == 1 {
            dir.to_path_buf()
        } else {
            dir.join(format!("observation-{index:03}"))
        };
        let root = subdir.join("workspace");
        fs::create_dir_all(&root).map_err(|e| e.to_string())?;
        let sentinel = root.join("T00NativeCaseSentinel");
        fs::write(&sentinel, b"native case probe").map_err(|e| e.to_string())?;
        let case_sensitive = !root.join("t00nativecasesentinel").exists();
        fs::remove_file(sentinel).map_err(|e| e.to_string())?;
        let request = match materialize(template, &root, case_sensitive) {
            Ok(v) => v,
            Err(error) => {
                return Ok(json!({"state":"NOT_EXECUTABLE_INPUT_GAP","error":error,"pass":false}));
            }
        };
        let request_path = subdir.join("request.json");
        save(&request_path, &request)?;
        let setup = apply_physical_post_capture(
            &request,
            &recipe["physical_live_after_capture"],
            &root,
            &request_path,
        )?;
        save(&subdir.join("physical-post-capture-setup.json"), &setup)?;
        let before = json!({"artifact_sha256":exact_hash(artifact,artifact_sha)?,"helper_sha256":exact_hash(helper,helper_sha)?});
        let argv = vec![
            artifact.to_string_lossy().into_owned(),
            request_path.to_string_lossy().into_owned(),
            sdk_path.to_string_lossy().into_owned(),
        ];
        let outcome = process::run_with_helper(&argv, &root, 20_000, 8_388_608, helper)
            .map_err(|e| e.to_string())?;
        let after = json!({"artifact_sha256":exact_hash(artifact,artifact_sha)?,"helper_sha256":exact_hash(helper,helper_sha)?});
        save(
            &subdir.join("process-outcome.json"),
            &serde_json::to_value(&outcome).map_err(|e| e.to_string())?,
        )?;
        save(
            &subdir.join("artifact-observation.json"),
            &json!({"before":before,"after":after}),
        )?;
        if outcome.kind != "success" || outcome.exit_code != Some(0) {
            return Ok(
                json!({"state":"PROCESS_FAILURE_OR_CONTROLLED_REFUSAL_REQUIRES_DISTINCT_EXPECTATION","outcome_kind":outcome.kind,"observation":index,"pass":false}),
            );
        }
        let observed: Value = match serde_json::from_str(&outcome.stdout) {
            Ok(v) => v,
            Err(error) => {
                return Ok(
                    json!({"state":"MALFORMED_NATIVE_OBSERVATION","error":error.to_string(),"observation":index,"pass":false}),
                );
            }
        };
        let binding = match observation_bound_to_request(&observed, &request, sdk, artifact_sha) {
            Ok(v) => v,
            Err(error) => {
                return Ok(
                    json!({"state":"INVALID_NATIVE_OBSERVATION_BINDING","error":error,"observation":index,"pass":false}),
                );
            }
        };
        save(&subdir.join("verified-input-binding.json"), &binding)?;
        let mut scope = recipe.clone();
        scope["checks"] = json!(
            recipe["checks"]
                .as_array()
                .ok_or("missing checks")?
                .iter()
                .filter(
                    |c| c.get("observation").and_then(Value::as_u64).unwrap_or(0) as usize == index
                )
                .cloned()
                .collect::<Vec<_>>()
        );
        if let Some(relations) = recipe.get("relations").and_then(Value::as_array) {
            for relation in relations {
                if ["left_observation", "right_observation"]
                    .iter()
                    .any(|key| relation[*key].as_u64() == Some(index as u64))
                {
                    scope["checks"]
                        .as_array_mut()
                        .unwrap()
                        .push(json!({"target":relation["target"],"expected":null}));
                }
            }
        }
        let capability = native_product_capability(&observed, &request, &scope);
        let reads = join_successful_reads(&observed, &request, sdk);
        boundaries.push(json!({"observation":index,"native_product_capability":match capability {Ok(v)=>v,Err(e)=>json!({"state":"NATIVE_PRODUCT_CONTEXT_UNKNOWN_OR_UNIMPLEMENTED","error":e})},"read_provenance":match reads {Ok(v)=>v,Err(e)=>json!({"state":"READ_PROVENANCE_REJECTED","error":e})}}));
        observations.push(observed);
    }
    let checks=recipe["checks"].as_array().ok_or("missing checks")?.iter().map(|c| {
        let i=c.get("observation").and_then(Value::as_u64).unwrap_or(0) as usize;
        let result=observations.get(i).map(|o|evaluate(o,c)).unwrap_or_else(||json!({"state":"UNKNOWN_UNMAPPED_OR_MALFORMED","error":"missing bound native observation"}));
        json!({"expected_origin":c["expected_origin"],"observation":i,"target":c["target"],"result":result})
    }).collect::<Vec<_>>();
    let relations = recipe
        .get("relations")
        .and_then(Value::as_array)
        .map(|rs| {
            rs.iter()
                .map(|r| json!({"origin":r["origin"],"result":evaluate_relation(&observations,r)}))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let pass = (!checks.is_empty() || !relations.is_empty())
        && checks
            .iter()
            .all(|c| c["result"]["state"] == "PASS_PROJECTED_PROPERTY")
        && relations
            .iter()
            .all(|c| c["result"]["state"] == "PASS_PROJECTED_PROPERTY")
        && boundaries.iter().all(|b| {
            b["native_product_capability"].get("error").is_none()
                && b["read_provenance"].get("error").is_none()
        });
    let result = json!({"state":if pass{"PASS_FROZEN_PROJECTED_UNIT"}else{"NONPASS_PROJECTED_UNIT"},"checks":checks,"relations":relations,"bound_observations":boundaries,"pass":pass,"global_admission_inferred":false});
    save(&dir.join("result.json"), &result)?;
    Ok(result)
}
fn run_consumer_recipe(
    recipe: &Value,
    dir: &Path,
    artifact: &Path,
    helper: &Path,
    artifact_sha: &str,
    helper_sha: &str,
) -> Result<Value, String> {
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let root = dir
        .canonicalize()
        .map_err(|e| e.to_string())?
        .to_string_lossy()
        .replace('\\', "/");
    let mut observations = vec![];
    for (index, template) in recipe["consumer_descriptors"]
        .as_array()
        .ok_or("missing frozen consumer descriptors")?
        .iter()
        .enumerate()
    {
        let mut descriptor = template.clone();
        if descriptor["request"]["repoRoot"] == "NATIVE_ROOT" {
            descriptor["request"]["repoRoot"] = json!(root);
        }
        for field in ["rootAbsPaths", "emitAbsPaths"] {
            for path in descriptor["request"][field]
                .as_array_mut()
                .ok_or("missing controlled valid request path array")?
            {
                let relative = path
                    .as_str()
                    .and_then(|s| s.strip_prefix("ROOT/"))
                    .ok_or("consumer path requires controlled root recipe")?;
                if !safe_relative(relative) {
                    return Err("consumer request root escapes case workspace".into());
                }
                *path = json!(format!("{root}/{relative}"));
            }
        }
        let subdir = dir.join(format!("observation-{index:03}"));
        fs::create_dir_all(&subdir).map_err(|e| e.to_string())?;
        let path = subdir.join("consumer-descriptor.json");
        save(&path, &descriptor)?;
        let before = json!({"artifact_sha256":exact_hash(artifact,artifact_sha)?,"helper_sha256":exact_hash(helper,helper_sha)?});
        let argv = vec![
            artifact.to_string_lossy().into_owned(),
            "--consume-worker".into(),
            path.to_string_lossy().into_owned(),
        ];
        let outcome = process::run_with_helper(&argv, &subdir, 20_000, 8_388_608, helper)
            .map_err(|e| e.to_string())?;
        let after = json!({"artifact_sha256":exact_hash(artifact,artifact_sha)?,"helper_sha256":exact_hash(helper,helper_sha)?});
        save(
            &subdir.join("process-outcome.json"),
            &serde_json::to_value(&outcome).map_err(|e| e.to_string())?,
        )?;
        save(
            &subdir.join("artifact-observation.json"),
            &json!({"before":before,"after":after}),
        )?;
        if outcome.kind != "success" || outcome.exit_code != Some(0) {
            return Ok(
                json!({"state":"CONSUMER_TRANSPORT_PROCESS_NONPASS","outcome_kind":outcome.kind,"pass":false}),
            );
        }
        let observed: Value = match serde_json::from_str(&outcome.stdout) {
            Ok(v) => v,
            Err(error) => {
                return Ok(
                    json!({"state":"MALFORMED_CONSUMER_NATIVE_OBSERVATION","error":error.to_string(),"pass":false}),
                );
            }
        };
        if observed["request_descriptor_id"] != identity::digest(&descriptor)
            || observed["producer_artifact_id"] != json!(format!("sha256:{artifact_sha}"))
        {
            return Ok(json!({"state":"INVALID_CONSUMER_DESCRIPTOR_BINDING","pass":false}));
        }
        save(
            &subdir.join("verified-descriptor-binding.json"),
            &json!({"request_descriptor_id":observed["request_descriptor_id"],"artifact_sha256":artifact_sha,"compiler_or_sdk_consumption_claimed":false}),
        )?;
        observations.push(observed);
    }
    let checks=recipe["checks"].as_array().ok_or("missing consumer assertions")?.iter().map(|c|{let index=c["observation"].as_u64().unwrap_or(0) as usize;json!({"observation":index,"target":c["target"],"expected_origin":c["expected_origin"],"result":observations.get(index).map(|o|evaluate(o,c)).unwrap_or_else(||json!({"state":"UNKNOWN_UNMAPPED_OR_MALFORMED","error":"missing bound actual consumer observation"}))})}).collect::<Vec<_>>();
    let pass = !checks.is_empty()
        && checks
            .iter()
            .all(|c| c["result"]["state"] == "PASS_PROJECTED_PROPERTY");
    let result = json!({"state":if pass{"PASS_FROZEN_NATIVE_RAW_CONSUMER_CONTROL"}else{"NONPASS_NATIVE_RAW_CONSUMER_CONTROL"},"checks":checks,"pass":pass,"proof_scope":"Actual native raw extraction response consumer, controlled structure-valid frozen carrier and one authored mutation; no actual producer semantic parity or graph admission inferred."});
    save(&dir.join("result.json"), &result)?;
    Ok(result)
}
fn worker_bound_to_request(
    observed: &Value,
    request: &Value,
    sdk: &Value,
    artifact_sha: &str,
    controlled_refusal: bool,
) -> Result<Value, String> {
    if observed["request_descriptor_id"] != identity::digest(request)
        || observed["producer_artifact_id"] != json!(format!("sha256:{artifact_sha}"))
    {
        return Err("worker response not bound to exact request descriptor/artifact".into());
    }
    if controlled_refusal {
        if observed["ok"] != false || observed["extraction_started"] != false {
            return Err("worker malformed-request refusal not observed before extraction".into());
        }
    } else if observed["ok"] != true || observed["sdk_input_id"] != identity::digest(sdk) {
        return Err("worker useful result lacks expected SDK binding".into());
    }
    Ok(
        json!({"request_descriptor_id":observed["request_descriptor_id"],"sdk_input_id":observed.get("sdk_input_id"),"artifact_sha256":artifact_sha,"controlled_malformed_request":controlled_refusal,"atomic_capture_claimed":false,"absence_of_all_os_reads_claimed":false}),
    )
}
fn worker_negative_boundary_directory_probes(
    observed: &Value,
    request: &Value,
    case_sensitive: bool,
) -> Result<Vec<Value>, String> {
    let issues = observed["frontendCapabilityObservation"]["workspaceIssues"]
        .as_array()
        .ok_or("missing worker workspace issue inventory")?;
    let reported_probes = observed
        .get("compiler_probes")
        .map(|value| {
            value
                .as_array()
                .ok_or("invalid worker compiler probe inventory")
        })
        .transpose()?;
    for probe in reported_probes.into_iter().flatten() {
        if probe["operation"] != "case_sensitive" {
            continue;
        }
        let sensitive = probe["found"].as_bool().ok_or("invalid case capability")?;
        if sensitive != case_sensitive
            || *probe
                != json!({"path":"","operation":"case_sensitive","found":sensitive,"content_id":null})
        {
            return Err("invalid pathless compiler capability probe".into());
        }
    }
    if issues.is_empty() {
        return Ok(vec![]);
    }
    let raw_root = value_text(request, "repoRoot")?;
    if verifier_absolute_key(raw_root, true)? != raw_root.replace('\\', "/") {
        return Err("worker repository coordinate is not canonical".into());
    }
    let root = verifier_absolute_key(raw_root, case_sensitive)?;
    let volume_root = if root.starts_with('/') {
        "/"
    } else {
        &root[..3]
    };
    let mut allowed = BTreeSet::new();
    let mut ancestor = root.clone();
    while ancestor != volume_root {
        let end = ancestor
            .rfind('/')
            .ok_or("missing worker repository ancestor")?;
        ancestor = if end < volume_root.len() {
            volume_root.to_owned()
        } else {
            ancestor[..end].to_owned()
        };
        allowed.insert(ancestor.clone());
        allowed.insert(format!(
            "{}/node_modules/@types",
            ancestor.trim_end_matches('/')
        ));
    }
    let probes = reported_probes
        .ok_or("missing actual worker compiler probes")?
        .iter()
        .map(|probe| {
            if probe["operation"] == "case_sensitive" {
                return Ok(probe.clone());
            }
            let path = verifier_absolute_key(value_text(probe, "path")?, case_sensitive)?;
            let mut normalized = probe.clone();
            normalized["path"] = json!(path);
            Ok(normalized)
        })
        .collect::<Result<Vec<Value>, String>>()?;
    for issue in issues {
        let raw_path = value_text(issue, "path")?;
        let path = verifier_absolute_key(raw_path, case_sensitive)?;
        if !allowed.contains(&path)
            || *issue
                != json!({"path":raw_path,"kind":"refusal","detail":"WORKSPACE_PATH_OUTSIDE_ROOT"})
        {
            return Err(
                "worker workspace issue is outside the negative ancestor-directory scope".into(),
            );
        }
        let matching = probes
            .iter()
            .filter(|probe| probe["path"] == path)
            .collect::<Vec<_>>();
        let expected =
            json!({"path":path,"operation":"directory_exists","found":false,"content_id":null});
        if matching.is_empty() || matching.iter().any(|probe| **probe != expected) {
            return Err(
                "worker boundary refusal lacks exclusively negative bound directory probes".into(),
            );
        }
    }
    Ok(issues.clone())
}
fn worker_frontend_capability(
    observed: &Value,
    request: &Value,
    case_sensitive: bool,
) -> Result<Value, String> {
    let capability = &observed["frontendCapabilityObservation"];
    if capability["executed"] != true
        || capability["unsupported"] != json!([])
        || capability["resolutionErrors"] != json!({})
    {
        return Err("worker native frontend context is incomplete or unresolved".into());
    }
    let negative_boundary_directory_probes =
        worker_negative_boundary_directory_probes(observed, request, case_sensitive)?;
    let roots = capability["roots"]
        .as_array()
        .ok_or("missing worker root capability observations")?;
    let expected = request["rootAbsPaths"]
        .as_array()
        .ok_or("missing worker root descriptor")?;
    let paths = roots.iter().map(|r| r["path"].clone()).collect::<Vec<_>>();
    let mut actual = paths
        .iter()
        .map(identity::canonical_json)
        .collect::<Vec<_>>();
    actual.sort();
    let mut expected = expected
        .iter()
        .map(identity::canonical_json)
        .collect::<Vec<_>>();
    expected.sort();
    if actual != expected
        || roots
            .iter()
            .any(|r| r["loaded"] != true || r["parseDiagnosticCodes"] != json!([]))
    {
        return Err("worker did not load every exact root without parser incapacity".into());
    }
    Ok(
        json!({"state":"COMPLETE_OBSERVED_NATIVE_WORKER_CONTEXT","roots":paths,"case_sensitive":case_sensitive,"negative_boundary_directory_probes":negative_boundary_directory_probes,"global_admission_inferred":false}),
    )
}
fn run_worker_recipe(
    recipe: &Value,
    dir: &Path,
    artifact: &Path,
    helper: &Path,
    sdk_input: (&Path, &Value),
    artifact_sha: &str,
    helper_sha: &str,
) -> Result<Value, String> {
    let (sdk_path, sdk) = sdk_input;
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let root = dir.join("workspace");
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let sentinel = root.join("T00WorkerCaseSentinel");
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&sentinel)
        .map_err(|e| e.to_string())?;
    let case_sensitive = !root
        .join("t00workercasesentinel")
        .try_exists()
        .map_err(|e| e.to_string())?;
    fs::remove_file(&sentinel).map_err(|e| e.to_string())?;
    let cwd = root
        .canonicalize()
        .map_err(|e| e.to_string())?
        .to_string_lossy()
        .replace('\\', "/");
    let mut source_inputs = serde_json::Map::new();
    for (path, text) in recipe["physical_files"]
        .as_object()
        .ok_or("missing authored physical worker inputs")?
    {
        if !safe_relative(path) {
            return Err("worker physical input escapes case root".into());
        }
        let content = text.as_str().ok_or("non-string worker input")?;
        let target = root.join(path);
        fs::create_dir_all(target.parent().unwrap()).map_err(|e| e.to_string())?;
        fs::write(&target, content.as_bytes()).map_err(|e| e.to_string())?;
        source_inputs.insert(format!("{cwd}/{path}"), text.clone());
    }
    let mut request = recipe["worker_request"].clone();
    if let Some(object) = request.as_object_mut() {
        if object.get("repoRoot") == Some(&json!("NATIVE_ROOT")) {
            object.insert("repoRoot".into(), json!(cwd));
        }
        for field in ["rootAbsPaths", "emitAbsPaths"] {
            let Some(paths) = object.get_mut(field).and_then(Value::as_array_mut) else {
                continue;
            };
            for path in paths {
                let Some(relative) = path.as_str().and_then(|s| s.strip_prefix("ROOT/")) else {
                    continue;
                };
                if !safe_relative(relative) {
                    return Err("worker requested path escapes authored root".into());
                }
                *path = json!(format!("{cwd}/{relative}"));
            }
        }
    }
    let request_path = dir.join("worker-request.json");
    save(&request_path, &request)?;
    let before = json!({"artifact_sha256":exact_hash(artifact,artifact_sha)?,"helper_sha256":exact_hash(helper,helper_sha)?});
    let argv = vec![
        artifact.to_string_lossy().into_owned(),
        "--extract-worker".into(),
        request_path.to_string_lossy().into_owned(),
        sdk_path.to_string_lossy().into_owned(),
    ];
    let outcome = process::run_with_helper(&argv, &root, 20_000, 8_388_608, helper)
        .map_err(|e| e.to_string())?;
    let after = json!({"artifact_sha256":exact_hash(artifact,artifact_sha)?,"helper_sha256":exact_hash(helper,helper_sha)?});
    save(
        &dir.join("process-outcome.json"),
        &serde_json::to_value(&outcome).map_err(|e| e.to_string())?,
    )?;
    save(
        &dir.join("artifact-observation.json"),
        &json!({"before":before,"after":after}),
    )?;
    if outcome.kind != "success" || outcome.exit_code != Some(0) {
        return Ok(
            json!({"state":"WORKER_TRANSPORT_PROCESS_NONPASS","outcome_kind":outcome.kind,"pass":false}),
        );
    }
    let observed: Value = match serde_json::from_str(&outcome.stdout) {
        Ok(v) => v,
        Err(error) => {
            return Ok(
                json!({"state":"MALFORMED_WORKER_NATIVE_OBSERVATION","error":error.to_string(),"pass":false}),
            );
        }
    };
    let controlled = recipe["controlled_request_refusal"] == true;
    let binding = match worker_bound_to_request(&observed, &request, sdk, artifact_sha, controlled)
    {
        Ok(v) => v,
        Err(error) => {
            return Ok(
                json!({"state":"INVALID_WORKER_BINDING_OR_REFUSAL","error":error,"pass":false}),
            );
        }
    };
    save(&dir.join("verified-input-binding.json"), &binding)?;
    let provenance = (|| -> Result<Value, String> {
        if controlled {
            return Ok(
                json!({"state":"CONTROLLED_REQUEST_REFUSAL_NO_USEFUL_COMPILER_RESULT_CREDITED","absence_of_all_os_reads_claimed":false}),
            );
        }
        let frontend = worker_frontend_capability(&observed, &request, case_sensitive)?;
        let repository_reads = observed["read_observations"]
            .as_array()
            .ok_or("missing actual worker repository reads")?;
        let expected_paths = source_inputs.keys().cloned().collect::<BTreeSet<_>>();
        let actual_paths = repository_reads
            .iter()
            .map(|r| value_text(r, "path").map(str::to_owned))
            .collect::<Result<BTreeSet<_>, _>>()?;
        if actual_paths != expected_paths || actual_paths.len() != repository_reads.len() {
            return Err(
                "worker captured source denominator differs from authored physical files".into(),
            );
        }
        for observation in repository_reads {
            let path = value_text(observation, "path")?;
            let text = source_inputs
                .get(path)
                .and_then(Value::as_str)
                .ok_or("reported worker read does not match authored source path")?;
            let target = Path::new(path).canonicalize().map_err(|e| e.to_string())?;
            let actual = fs::read(&target).map_err(|e| e.to_string())?;
            if actual != text.as_bytes()
                || observation["raw_bytes_sha256"] != identity::digest_bytes(text.as_bytes())
                || observation["canonical_path"]
                    != json!(target.to_string_lossy().replace('\\', "/"))
            {
                return Err("worker source read bytes or physical after observation do not match authored input".into());
            }
            if !text.is_ascii() {
                return Err(
                    "worker decoded-port hash needs explicit non-ASCII profile mapping".into(),
                );
            }
            if observation["decoded_port_text_sha256"] != identity::digest_bytes(text.as_bytes()) {
                return Err("worker ASCII decoded source identity mismatch".into());
            }
        }
        let reads = join_successful_reads(
            &json!({"capture_probes":observed["compiler_probes"]}),
            &json!({"files":source_inputs}),
            sdk,
        )?;
        let read_paths = reads["read_paths"]
            .as_array()
            .ok_or("missing joined worker compiler reads")?;
        for root in request["rootAbsPaths"]
            .as_array()
            .ok_or("missing native worker roots")?
        {
            if !read_paths.contains(root) {
                return Err(
                    "requested worker source root has no successful compiler read observation"
                        .into(),
                );
            }
        }
        for basename in ["/lib.es5.d.ts", "/lib.es2022.full.d.ts"] {
            let path = sdk["files"]
                .as_object()
                .ok_or("missing pinned SDK file map")?
                .keys()
                .find(|p| p.ends_with(basename))
                .ok_or("required baseline ES2022 default library absent from pinned SDK")?;
            if !read_paths.contains(&json!(path)) {
                return Err("worker actual ES2022 default library consumption not observed".into());
            }
        }
        Ok(
            json!({"state":"JOINED_REPORTED_NATIVE_WORKER_READS_ONLY","compiler_reads":reads,"frontend":frontend,"atomic_capture_claimed":false,"all_sdk_supplied_consumed_claimed":false}),
        )
    })();
    let checks=recipe["checks"].as_array().ok_or("missing worker checks")?.iter().map(|c|json!({"expected_origin":c["expected_origin"],"target":c["target"],"result":evaluate(&observed,c)})).collect::<Vec<_>>();
    let mut direct_relation = json!({"state":"NOT_REQUIRED"});
    let mut direct_pass = true;
    if let Some(direct) = recipe.get("direct_recipe") {
        let result = run_raw_recipe(
            direct,
            &dir.join("direct-control"),
            artifact,
            helper,
            (sdk_path, sdk),
            artifact_sha,
            helper_sha,
        )?;
        direct_pass = result["pass"] == true;
        if direct_pass {
            let control = read_json(&dir.join("direct-control/process-outcome.json"))?;
            let raw: Value =
                serde_json::from_str(value_text(&control, "stdout")?).map_err(|e| e.to_string())?;
            let same = ["modules", "symbols", "imports", "calls"]
                .iter()
                .all(|field| {
                    let canonical = |v: &Value| -> Option<Vec<String>> {
                        let mut values = v
                            .as_array()?
                            .iter()
                            .map(identity::canonical_json)
                            .collect::<Vec<_>>();
                        values.sort();
                        Some(values)
                    };
                    canonical(&observed["extraction"][field])
                        .zip(canonical(&raw["raw_extraction"][field]))
                        .is_some_and(|(a, b)| a == b)
                });
            direct_relation = json!({"state":if same{"PASS_EXACT_COMPLETE_LOGICAL_SETS_WORKER_AND_DIRECT"}else{"MISMATCH_WORKER_DIRECT_EXTRACTION"},"pass":same});
            direct_pass &= same;
        } else {
            direct_relation = json!({"state":"DIRECT_EXPECTED_PROJECTION_NONPASS","result":result});
        }
    }
    let pass = !checks.is_empty()
        && checks
            .iter()
            .all(|c| c["result"]["state"] == "PASS_PROJECTED_PROPERTY")
        && provenance.is_ok()
        && direct_pass;
    let result = json!({"state":if pass{"PASS_FROZEN_NATIVE_WORKER_PROJECTED_UNIT"}else{"NONPASS_NATIVE_WORKER_PROJECTED_UNIT"},"checks":checks,"direct_relation":direct_relation,"provenance":match provenance{Ok(v)=>v,Err(error)=>json!({"state":"WORKER_READ_PROVENANCE_REJECTED","error":error})},"pass":pass,"global_admission_inferred":false});
    save(&dir.join("result.json"), &result)?;
    Ok(result)
}
fn system_complete_binding(
    observed: &Value,
    request: &Value,
    artifact_sha: &str,
) -> Result<Value, String> {
    if observed["request_descriptor_id"] != identity::digest(request)
        || observed["requestDescriptorId"] != identity::digest(request)
        || observed["producer_artifact_id"] != json!(format!("sha256:{artifact_sha}"))
        || observed["executed"] != true
        || observed["unsupported"] != json!([])
    {
        return Err("captured-system observation is unbound or incomplete".into());
    }
    let queries = request["queries"]
        .as_array()
        .ok_or("missing system queries")?;
    let results = observed["results"]
        .as_array()
        .ok_or("missing system results")?;
    if queries.len() != results.len() {
        return Err("system result denominator differs from requested queries".into());
    }
    for (query, result) in queries.iter().zip(results) {
        if result["operation"] != query["operation"]
            || result["path"] != query["path"]
            || result["executed"] != true
            || result["unsupported"] != json!([])
            || result["refusals"] != json!([])
        {
            return Err("system query is unbound, refused or unsupported".into());
        }
    }
    let reads = join_successful_reads(
        &json!({"capture_probes":observed["probes"]}),
        &json!({"files":request["files"]}),
        &json!({"files":{}}),
    )?;
    Ok(
        json!({"state":"BOUND_ACTUAL_CAPTURED_SYSTEM_QUERIES","reads":reads,"all_os_reads_observed_claimed":false,"cache_identity_claimed":false}),
    )
}
fn system_observation_json(stdout: &str) -> Result<Value, Value> {
    serde_json::from_str(stdout).map_err(|error|json!({"state":"MALFORMED_SYSTEM_NATIVE_OBSERVATION","error":error.to_string(),"pass":false}))
}
fn run_system_recipe(
    recipe: &Value,
    dir: &Path,
    artifact: &Path,
    helper: &Path,
    artifact_sha: &str,
    helper_sha: &str,
) -> Result<Value, String> {
    let root = dir.join("workspace");
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let cwd = root
        .canonicalize()
        .map_err(|e| e.to_string())?
        .to_string_lossy()
        .replace('\\', "/");
    let mut files = serde_json::Map::new();
    for (path, text) in recipe["system_files"]
        .as_object()
        .ok_or("missing frozen system snapshot")?
    {
        if !safe_relative(path) {
            return Err("system snapshot path escapes case root".into());
        }
        let target = root.join(path);
        fs::create_dir_all(target.parent().unwrap()).map_err(|e| e.to_string())?;
        fs::write(
            &target,
            text.as_str().ok_or("nonstring system source")?.as_bytes(),
        )
        .map_err(|e| e.to_string())?;
        files.insert(format!("{cwd}/{path}"), text.clone());
    }
    let sentinel = root.join("NativeSystemCaseProbe");
    fs::write(&sentinel, b"case").map_err(|e| e.to_string())?;
    let sensitive = !root.join("nativesystemcaseprobe").exists();
    fs::remove_file(sentinel).map_err(|e| e.to_string())?;
    let queries = recipe["system_queries"]
        .as_array()
        .ok_or("missing frozen system queries")?
        .iter()
        .map(|q| {
            let path = value_text(q, "path")?;
            if !safe_relative(path) {
                return Err("system query escapes root".into());
            }
            Ok(json!({"operation":q["operation"],"path":format!("{cwd}/{path}")}))
        })
        .collect::<Result<Vec<_>, String>>()?;
    let request = json!({"profile":recipe["system_profile"],"root":cwd,"case_sensitive":sensitive,"files":files,"utf16_files":{},"raw_files":{},"sdk_directory":null,"queries":queries});
    let request_path = dir.join("system-request.json");
    save(&request_path, &request)?;
    let descriptor_bytes = fs::read(&request_path).map_err(|e| e.to_string())?;
    let mut setup = vec![];
    for (path, text) in recipe["system_live_after_capture"]
        .as_object()
        .ok_or("missing frozen system live map")?
    {
        if !safe_relative(path) {
            return Err("system physical live path escapes root".into());
        }
        let target = root.join(path);
        fs::create_dir_all(target.parent().unwrap()).map_err(|e| e.to_string())?;
        let bytes = text
            .as_str()
            .ok_or("nonstring physical system setup")?
            .as_bytes();
        fs::write(&target, bytes).map_err(|e| e.to_string())?;
        if fs::read(&target).map_err(|e| e.to_string())? != bytes {
            return Err("physical live system setup not held".into());
        }
        setup.push(json!({"path":path,"physical_sha256":sha(bytes),"retained_value":recipe["system_files"].get(path)}));
    }
    if fs::read(&request_path).map_err(|e| e.to_string())? != descriptor_bytes {
        return Err("retained system descriptor changed during physical setup".into());
    }
    save(&dir.join("physical-live-setup.json"), &json!(setup))?;
    let before = json!({"artifact_sha256":exact_hash(artifact,artifact_sha)?,"helper_sha256":exact_hash(helper,helper_sha)?});
    let argv = vec![
        artifact.to_string_lossy().into_owned(),
        "--observe-system".into(),
        request_path.to_string_lossy().into_owned(),
    ];
    let outcome = process::run_with_helper(&argv, &root, 20_000, 8_388_608, helper)
        .map_err(|e| e.to_string())?;
    let after = json!({"artifact_sha256":exact_hash(artifact,artifact_sha)?,"helper_sha256":exact_hash(helper,helper_sha)?});
    save(
        &dir.join("process-outcome.json"),
        &serde_json::to_value(&outcome).map_err(|e| e.to_string())?,
    )?;
    save(
        &dir.join("artifact-observation.json"),
        &json!({"before":before,"after":after}),
    )?;
    if outcome.kind != "success" || outcome.exit_code != Some(0) {
        return Ok(json!({"state":"SYSTEM_PROCESS_NONPASS","pass":false}));
    }
    let observed = match system_observation_json(&outcome.stdout) {
        Ok(observed) => observed,
        Err(nonpass) => {
            save(&dir.join("result.json"), &nonpass)?;
            return Ok(nonpass);
        }
    };
    let binding = system_complete_binding(&observed, &request, artifact_sha);
    let checks = recipe["checks"]
        .as_array()
        .ok_or("missing system expectations")?
        .iter()
        .map(|c| evaluate(&observed, c))
        .collect::<Vec<_>>();
    let pass = binding.is_ok()
        && !checks.is_empty()
        && checks
            .iter()
            .all(|c| c["state"] == "PASS_PROJECTED_PROPERTY");
    let result = json!({"state":if pass{"PASS_FROZEN_CAPTURED_SYSTEM_COMPONENT"}else{"NONPASS_CAPTURED_SYSTEM_COMPONENT"},"pass":pass,"checks":checks,"binding":match binding{Ok(v)=>v,Err(error)=>json!({"error":error})},"sdk_fallback_claimed":false,"cache_identity_claimed":false,"global_admission_inferred":false});
    save(&dir.join("result.json"), &result)?;
    Ok(result)
}
fn primitive_bound_to_request(
    observed: &Value,
    request: &Value,
    artifact_sha: &str,
) -> Result<Value, String> {
    if observed["request_descriptor_id"] != identity::digest(request)
        || observed["producer_artifact_id"] != json!(format!("sha256:{artifact_sha}"))
        || observed["operation"] != request["operation"]
        || observed["executed"] != true
        || observed["unsupported"] != json!([])
    {
        return Err("primitive observation not bound to exact descriptor/artifact and complete native operation".into());
    }
    Ok(
        json!({"request_descriptor_id":observed["request_descriptor_id"],"artifact_sha256":artifact_sha,"operation":request["operation"],"sdk_readset_claimed":false}),
    )
}
fn run_primitive_recipe(
    recipe: &Value,
    dir: &Path,
    artifact: &Path,
    helper: &Path,
    artifact_sha: &str,
    helper_sha: &str,
) -> Result<Value, String> {
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let templates = recipe["primitive_requests"]
        .as_array()
        .ok_or("missing primitive descriptors")?;
    let mut observations = vec![];
    for (index, template) in templates.iter().enumerate() {
        let subdir = dir.join(format!("observation-{index:03}"));
        fs::create_dir_all(&subdir).map_err(|e| e.to_string())?;
        let root = subdir
            .canonicalize()
            .map_err(|e| e.to_string())?
            .to_string_lossy()
            .replace('\\', "/");
        let mut request = template.clone();
        if request.get("cwd") == Some(&json!("NATIVE_ROOT")) {
            request["cwd"] = json!(root);
        }
        if let Some(path) = request
            .get("path")
            .and_then(Value::as_str)
            .map(str::to_owned)
            && (path == "ROOT" || path.starts_with("ROOT/") || path.starts_with("ROOT\\"))
        {
            request["path"] = json!(format!(
                "{}{}",
                dir.canonicalize()
                    .map_err(|e| e.to_string())?
                    .to_string_lossy()
                    .replace('\\', "/"),
                &path[4..]
            ));
        }
        if request.get("cwd").is_some() {
            request["cwd"] = json!(
                dir.canonicalize()
                    .map_err(|e| e.to_string())?
                    .to_string_lossy()
                    .replace('\\', "/")
            );
        }
        let path = subdir.join("descriptor.json");
        save(&path, &request)?;
        let before = json!({"artifact_sha256":exact_hash(artifact,artifact_sha)?,"helper_sha256":exact_hash(helper,helper_sha)?});
        let argv = vec![
            artifact.to_string_lossy().into_owned(),
            "--observe-primitives".into(),
            path.to_string_lossy().into_owned(),
        ];
        let outcome = process::run_with_helper(&argv, &subdir, 20_000, 8_388_608, helper)
            .map_err(|e| e.to_string())?;
        let after = json!({"artifact_sha256":exact_hash(artifact,artifact_sha)?,"helper_sha256":exact_hash(helper,helper_sha)?});
        save(
            &subdir.join("process-outcome.json"),
            &serde_json::to_value(&outcome).map_err(|e| e.to_string())?,
        )?;
        save(
            &subdir.join("artifact-observation.json"),
            &json!({"before":before,"after":after}),
        )?;
        if outcome.kind != "success" || outcome.exit_code != Some(0) {
            return Ok(
                json!({"state":"PRIMITIVE_PROCESS_NONPASS","outcome_kind":outcome.kind,"observation":index,"pass":false}),
            );
        }
        let observed: Value = match serde_json::from_str(&outcome.stdout) {
            Ok(v) => v,
            Err(error) => {
                return Ok(
                    json!({"state":"MALFORMED_PRIMITIVE_OBSERVATION","error":error.to_string(),"pass":false}),
                );
            }
        };
        match primitive_bound_to_request(&observed, &request, artifact_sha) {
            Ok(binding) => save(&subdir.join("verified-descriptor-binding.json"), &binding)?,
            Err(error) => {
                return Ok(json!({"state":"INVALID_PRIMITIVE_BINDING","error":error,"pass":false}));
            }
        };
        observations.push(observed);
    }
    let checks=recipe["checks"].as_array().ok_or("missing primitive checks")?.iter().map(|c|{
        let i=c.get("observation").and_then(Value::as_u64).unwrap_or(0) as usize;
        json!({"expected_origin":c["expected_origin"],"observation":i,"target":c["target"],"result":observations.get(i).map(|o|evaluate(o,c)).unwrap_or_else(||json!({"state":"UNKNOWN_UNMAPPED_OR_MALFORMED","error":"missing actual primitive observation"}))})
    }).collect::<Vec<_>>();
    let relations = recipe
        .get("relations")
        .and_then(Value::as_array)
        .map(|rs| {
            rs.iter()
                .map(|r| json!({"origin":r["origin"],"result":evaluate_relation(&observations,r)}))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let gaps = recipe
        .get("gaps")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let passed_checks = (!checks.is_empty() || !relations.is_empty())
        && checks
            .iter()
            .all(|c| c["result"]["state"] == "PASS_PROJECTED_PROPERTY")
        && relations
            .iter()
            .all(|c| c["result"]["state"] == "PASS_PROJECTED_PROPERTY");
    let pass = passed_checks && gaps.is_empty();
    let result = json!({"state":if pass{"PASS_FROZEN_PRIMITIVE_PROJECTED_UNIT"}else if passed_checks && !gaps.is_empty(){"PARTIAL_PRIMITIVE_OBSERVATION_WITH_EXPLICIT_GAPS"}else{"NONPASS_PRIMITIVE_PROJECTED_UNIT"},"checks":checks,"relations":relations,"gaps":gaps,"pass":pass,"sdk_readset_claimed":false,"global_admission_inferred":false});
    save(&dir.join("result.json"), &result)?;
    Ok(result)
}
fn support_projection(support: &Value) -> Value {
    let id = support.get("support_id").cloned().unwrap_or(Value::Null);
    let p = &support["payload"];
    let result = (|| -> Result<Value, String> {
        if let Some(v) = p.get("value") {
            let canonical = identity::canonical_json(v);
            let digest = identity::digest(v);
            let pass = p.get("canonical_json").and_then(Value::as_str) == Some(canonical.as_str())
                && p.get("expected_digest").and_then(Value::as_str) == Some(digest.as_str());
            return Ok(
                json!({"state":if pass{"PASS_FIXED_IDENTITY_DESCRIPTOR"}else{"MISMATCH_FIXED_IDENTITY_DESCRIPTOR"},"pass":pass,"proof_scope":"fixed canonical descriptor and digest only; no artifact/capture acquisition asserted"}),
            );
        }
        if let Some(v) = p.get("mutated_record") {
            let digest = identity::digest(v);
            let pass = p.get("expected_digest").and_then(Value::as_str) == Some(digest.as_str());
            return Ok(
                json!({"state":if pass{"PASS_FIXED_MUTATED_IDENTITY_DIGEST"}else{"MISMATCH_FIXED_MUTATED_IDENTITY_DIGEST"},"pass":pass,"proof_scope":"fixed descriptor digest only; original-request rejection requires actual receiver controls"}),
            );
        }
        if let Some(p) = p.get("projection").filter(|p| p.get("bytes_hex").is_some()) {
            let text = value_text(p, "bytes_hex")?;
            if text.len() % 2 != 0 {
                return Err("invalid fixed byte vector".into());
            }
            let bytes = (0..text.len())
                .step_by(2)
                .map(|i| u8::from_str_radix(&text[i..i + 2], 16).map_err(|e| e.to_string()))
                .collect::<Result<Vec<_>, _>>()?;
            let pass = identity::digest_bytes(&bytes) == value_text(p, "expected_sha256")?;
            return Ok(
                json!({"state":if pass{"PASS_FIXED_SHA256_PRIMITIVE"}else{"MISMATCH_FIXED_SHA256_PRIMITIVE"},"pass":pass,"proof_scope":"SHA256 primitive only, not aggregate analyzer identity"}),
            );
        }
        Err("support requires native decoder/consumer/acquisition observation beyond fixed digest API".into())
    })();
    match result {
        Ok(mut r) => {
            r["support_id"] = id;
            r
        }
        Err(error) => {
            json!({"support_id":id,"state":"NOT_EXECUTABLE_SUPPORT_API_OR_MAPPING_GAP","error":error,"pass":false})
        }
    }
}
fn replay() -> Result<Value, String> {
    if std::env::var("SEMCTX_QUALIFICATION_RUN_SIGNAL").as_deref()
        != Ok("stage5-optimized-frozen-stage6-authorized")
    {
        return Err(
            "qualification execution is not authorized by root optimized-freeze signal".into(),
        );
    }
    let manifest = PathBuf::from(
        std::env::var_os("SEMCTX_QUALIFICATION_FREEZE_MANIFEST")
            .ok_or("missing stage5 freeze manifest")?,
    );
    let freeze = read_json(&manifest)?;
    if freeze["optimized_frozen"] != true {
        return Err("candidate is not optimized-frozen".into());
    }
    let artifact = PathBuf::from(value_text(&freeze, "artifact_path")?);
    let helper = PathBuf::from(value_text(&freeze, "helper_path")?);
    let sdk_path = PathBuf::from(value_text(&freeze, "sdk_path")?);
    let recipes_path = PathBuf::from(value_text(&freeze, "recipes_path")?);
    let base = PathBuf::from(value_text(&freeze, "cases_path")?);
    let artifact_sha = exact_hash(&artifact, value_text(&freeze, "artifact_sha256")?)?;
    let helper_sha = exact_hash(&helper, value_text(&freeze, "helper_sha256")?)?;
    exact_hash(&sdk_path, value_text(&freeze, "sdk_sha256")?)?;
    exact_hash(&recipes_path, value_text(&freeze, "recipes_sha256")?)?;
    let sdk = read_json(&sdk_path)?;
    if sdk["version"] != "5.9.3"
        || sdk["archive_sha256"]
            != "10e108c9cf7d5f2879053dff18515fb405abf2ccef63eaaf017d9c571687a1d3"
    {
        return Err("SDK identity mismatch".into());
    }
    let recipes = read_json(&recipes_path)?;
    verify_sources(&base, &recipes)?;
    let units = recipes["recipes"]
        .as_array()
        .ok_or("missing replay recipes")?;
    if units.len() != 354 {
        return Err("unit denominator drift".into());
    }
    let out = PathBuf::from(
        std::env::var_os("SEMCTX_QUALIFICATION_EVIDENCE")
            .ok_or("missing caller-owned evidence directory")?,
    );
    if out.exists() {
        return Err("evidence directory already exists; overwrite forbidden".into());
    }
    fs::create_dir_all(&out).map_err(|e| e.to_string())?;
    save(&out.join("freeze-manifest.json"), &freeze)?;
    let inputs = read_json(&base.join("allocation/input-index.json"))?;
    let guard_inputs = inputs["qualification_records"]
        .as_array()
        .ok_or("missing input records")?
        .iter()
        .map(|r| (r["case_id"].as_str().unwrap(), &r["input_specification"]))
        .collect::<BTreeMap<_, _>>();
    let artifact_bytes = fs::read(&artifact).map_err(|e| e.to_string())?;
    let mut results = vec![];
    for (index, recipe) in units.iter().enumerate() {
        let uid = value_text(recipe, "unit_id")?;
        if recipe["surface"] == "captured_system_cli" {
            let mut result = run_system_recipe(
                recipe,
                &out.join(format!("unit-{index:03}")),
                &artifact,
                &helper,
                &artifact_sha,
                &helper_sha,
            )?;
            result["unit_id"] = json!(uid);
            results.push(result);
            continue;
        }
        if recipe["surface"] == "worker_consumer_cli" {
            let mut result = run_consumer_recipe(
                recipe,
                &out.join(format!("unit-{index:03}")),
                &artifact,
                &helper,
                &artifact_sha,
                &helper_sha,
            )?;
            result["unit_id"] = json!(uid);
            results.push(result);
            continue;
        }
        if recipe["surface"] == "worker_cli" {
            if recipe["gaps"]
                .as_array()
                .ok_or("missing worker gap registry")?
                .iter()
                .next()
                .is_some()
            {
                results.push(json!({"unit_id":uid,"state":"NOT_EXECUTABLE_EXPLICIT_GAPS","gaps":recipe["gaps"],"pass":false}));
                continue;
            }
            let mut result = run_worker_recipe(
                recipe,
                &out.join(format!("unit-{index:03}")),
                &artifact,
                &helper,
                (&sdk_path, &sdk),
                &artifact_sha,
                &helper_sha,
            )?;
            result["unit_id"] = json!(uid);
            results.push(result);
            continue;
        }
        if recipe["surface"] == "primitive_cli" {
            let mut result = run_primitive_recipe(
                recipe,
                &out.join(format!("unit-{index:03}")),
                &artifact,
                &helper,
                &artifact_sha,
                &helper_sha,
            )?;
            result["unit_id"] = json!(uid);
            results.push(result);
            continue;
        }
        if recipe["surface"] == "private_receiver_component" {
            exact_hash(&artifact, &artifact_sha)?;
            let input = guard_inputs
                .get(value_text(recipe, "guard_input_case_id")?)
                .ok_or("missing guard frozen input")?;
            let mut result =
                receiver_guard_projection(input, &recipe["guard_variant"], &artifact_bytes);
            result["unit_id"] = json!(uid);
            result["required_external_property_links"] =
                recipe["required_external_property_links"].clone();
            results.push(result);
            continue;
        }
        let gaps = recipe["gaps"].as_array().ok_or("missing gap status")?;
        if !gaps.is_empty() {
            results.push(json!({"unit_id":uid,"state":"NOT_EXECUTABLE_EXPLICIT_GAPS","gaps":gaps,"pass":false}));
            continue;
        }
        if let Err(error) = validate_component_checks(
            recipe["checks"]
                .as_array()
                .ok_or("missing credited checks")?,
        ) {
            results.push(json!({"unit_id":uid,"state":"NOT_EXECUTABLE_INCOMPLETE_COMPONENT_COMPARATOR","error":error,"pass":false}));
            continue;
        }
        let dir = out.join(format!("unit-{index:03}"));
        let mut result = run_raw_recipe(
            recipe,
            &dir,
            &artifact,
            &helper,
            (&sdk_path, &sdk),
            &artifact_sha,
            &helper_sha,
        )?;
        result["unit_id"] = json!(uid);
        results.push(result);
    }
    verify_sources(&base, &recipes)?;
    exact_hash(&artifact, &artifact_sha)?;
    exact_hash(&helper, &helper_sha)?;
    let supports = read_json(&base.join("qualification/support.json"))?;
    let support_results = supports["support_units"]
        .as_array()
        .ok_or("missing supports")?
        .iter()
        .enumerate()
        .map(|(index, support)| {
            let recipe = recipes
                .get("support_recipes")
                .and_then(Value::as_array)
                .and_then(|rs| rs.iter().find(|r| r["support_id"] == support["support_id"]));
            if let Some(recipe) = recipe {
                let mut result = if recipe["surface"] == "raw_cli" {
                    run_raw_recipe(
                        recipe,
                        &out.join(format!("support-{index:03}")),
                        &artifact,
                        &helper,
                        (&sdk_path, &sdk),
                        &artifact_sha,
                        &helper_sha,
                    )?
                } else {
                    run_primitive_recipe(
                        recipe,
                        &out.join(format!("support-{index:03}")),
                        &artifact,
                        &helper,
                        &artifact_sha,
                        &helper_sha,
                    )?
                };
                result["support_id"] = support["support_id"].clone();
                Ok(result)
            } else {
                Ok(support_projection(support))
            }
        })
        .collect::<Result<Vec<_>, String>>()?;
    if support_results.len() != 51 {
        return Err("support denominator drift".into());
    }
    let obligations = read_json(&base.join("qualification/obligations.json"))?;
    let results_by_id = results
        .iter()
        .map(|r| (r["unit_id"].as_str().unwrap(), r["pass"] == true))
        .collect::<BTreeMap<_, _>>();
    let obligation_results=obligations["obligations"].as_array().ok_or("missing obligation map")?.iter().map(|o|{let ids=o["qualification_execution_unit_ids"].as_array().unwrap();let passed=ids.iter().all(|id|results_by_id.get(id.as_str().unwrap())==Some(&true));json!({"obligation_id":o["obligation_id"],"associated_units_all_passed":passed,"state":"REQUIRES_PROPERTY_AND_SUPPORT_REVIEW","qualified":false})}).collect::<Vec<_>>();
    let report = json!({"phase":"stage6_qualification","platform":std::env::consts::OS,"architecture":std::env::consts::ARCH,"timestamp_unix_ms":SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis(),"denominators":{"records":268,"units":354,"supports":51,"obligations":240},"units":results,"supports":support_results,"obligations":obligation_results,"qualified":false,"R0_decision":"NOT_MADE_BY_ADAPTER","source_expectations_unchanged":true,"artifact_sha256":artifact_sha,"helper_sha256":helper_sha});
    save(&out.join("report.json"), &report)?;
    Ok(report)
}

#[test]
fn qualification_replay_requires_explicit_optimized_freeze() {
    let report = replay().expect("qualification preparation is not execution authorization");
    assert_eq!(report["units"].as_array().unwrap().len(), 354);
    assert_eq!(report["supports"].as_array().unwrap().len(), 51);
    assert!(
        report["units"]
            .as_array()
            .unwrap()
            .iter()
            .all(|r| r["pass"] == true),
        "qualification has explicit nonpass units; inspect report.json"
    );
    assert!(
        report["supports"]
            .as_array()
            .unwrap()
            .iter()
            .all(|r| r["pass"] == true),
        "qualification has explicit nonpass supports; inspect report.json"
    );
}
#[test]
fn comparator_exact_projection_detects_missing_extra_and_wrong_properties() {
    let expected = json!([{"name":"devAlpha","kind":"function"}]);
    assert!(
        compare(
            &json!([{"name":"devAlpha","kind":"function","offset":19}]),
            &expected,
            "unordered_projected_eq"
        )
        .unwrap()
    );
    assert!(!compare(&json!([]), &expected, "unordered_projected_eq").unwrap());
    assert!(
        !compare(
            &json!([{"name":"devAlpha","kind":"function"},{"name":"devExtra","kind":"function"}]),
            &expected,
            "unordered_projected_eq"
        )
        .unwrap()
    );
    assert!(
        !compare(
            &json!([{"name":"devAlpha","kind":"class"}]),
            &expected,
            "unordered_projected_eq"
        )
        .unwrap()
    );
}
#[test]
fn comparator_matching_is_injective_and_handles_overlapping_projections() {
    assert!(injective_matches(
        &[json!({"x":1,"y":2}), json!({"x":1,"y":3})],
        &[json!({"x":1}), json!({"x":1,"y":2})]
    ));
    assert!(!injective_matches(
        &[json!({"x":1})],
        &[json!({"x":1}), json!({"x":1})]
    ));
}
#[test]
fn comparator_missing_fields_and_unmapped_constraints_are_unknown() {
    let c = json!({"target":["absent"],"mode":"eq","actual_transform":"none","expected":false});
    assert_eq!(
        evaluate(&json!({}), &c)["state"],
        "UNKNOWN_UNMAPPED_OR_MALFORMED"
    );
    assert!(
        compare(
            &json!([]),
            &json!({"novel_constraint":true}),
            "reason_constraints"
        )
        .is_err()
    );
}
#[test]
fn comparator_reasons_preserve_exact_set_contains_and_excludes_strength() {
    assert!(compare(&json!(["DEV_REASON_A","DEV_REASON_B"]),&json!({"contains":["DEV_REASON_A"],"excludes":["DEV_REASON_C"],"contains_prefix":["DEV_REASON_"]}),"reason_constraints").unwrap());
    assert!(
        !compare(
            &json!(["DEV_REASON_A", "DEV_REASON_B"]),
            &json!({"exact_set":["DEV_REASON_A"]}),
            "reason_constraints"
        )
        .unwrap()
    );
    assert!(
        !compare(
            &json!(["DEV_REASON_A", "DEV_REASON_A"]),
            &json!({"exact_set":["DEV_REASON_A"]}),
            "reason_constraints"
        )
        .unwrap()
    );
    assert!(
        !compare(
            &json!(["DEV_REASON_A"]),
            &json!({"excludes":["DEV_REASON_A"]}),
            "reason_constraints"
        )
        .unwrap()
    );
}
#[test]
fn comparator_reported_reads_require_known_input_bytes_and_nonread_absence() {
    let source = "export const devOnly=73;";
    let content = identity::digest_bytes(source.as_bytes());
    let request = json!({"files":{"/dev/source.ts":source}});
    let sdk = json!({"files":{}});
    let good = json!({"capture_probes":[{"operation":"read_file","path":"/dev/source.ts","found":true,"content_id":content}]});
    assert!(join_successful_reads(&good, &request, &sdk).is_ok());
    let mut poison = good.clone();
    poison["capture_probes"][0]["content_id"] = json!("sha256:forged");
    assert!(join_successful_reads(&poison, &request, &sdk).is_err());
    poison = good.clone();
    poison["capture_probes"][0]["operation"] = json!("file_exists");
    assert!(join_successful_reads(&poison, &request, &sdk).is_err());
    poison = good;
    poison["capture_probes"][0]["path"] = json!("/dev/foreign.ts");
    assert!(join_successful_reads(&poison, &request, &sdk).is_err());
}
#[test]
fn comparator_never_promotes_admission_from_reason_constraints() {
    assert!(
        compare(
            &json!([]),
            &json!({"global_admission_inferred":true}),
            "reason_constraints"
        )
        .is_err()
    );
}
#[test]
fn comparator_subject_selector_rejects_ambiguous_native_observation() {
    assert!(
        select(
            &json!({"subjects":[{"path":"dev.ts"},{"path":"dev.ts"}]}),
            &[json!("subjects"), json!({"path":"dev.ts"})]
        )
        .is_err()
    );
}

#[test]
fn comparator_identity_support_rejects_forged_fixed_digest() {
    let good = json!({"support_id":"DEV-ONLY-ADAPTER-DIGEST","payload":{"projection":{"bytes_hex":"616461707465722d6f776e65642d6465762d3230323631303137","expected_sha256":"sha256:0bb65b58df6781d5214b1918e34def9a0ea56f28ee5953ab8b82d5ca4f80e8b0"}}});
    assert_eq!(support_projection(&good)["pass"], true);
    let mut bad = good;
    bad["payload"]["projection"]["expected_sha256"] = json!("sha256:forged");
    assert_eq!(support_projection(&bad)["pass"], false);
}

#[test]
fn comparator_private_guard_carrier_detects_missing_seal_with_new_dev_input() {
    let input = json!({"files":{"adapterDevelopmentGuard.ts":"export function adapterDevelopmentGuard(){ return 913; }"},"base_observations":{"expected_profile":"modelo-suite-static-v1","observed_profile":"modelo-suite-static-v1","expected_root":"development-root","observed_root":"development-root","expected_capture_identity":"development-capture-A","observed_capture_identity":"development-capture-A","actual_observed_facts_hash":"development-facts-A","sealed_facts_hash":"development-facts-A","indexed_facts_hash":"development-facts-A","sealed_input_hash":"development-input-A","indexed_input_hash":"development-input-A","consumed_input_hash":"development-input-A","expected_input_hash":"development-input-A","binding_valid":true,"build_complete":true,"check_changed":false,"freshness_verdict":"FRESH","freshness_reasons":[],"seal_present":true,"receiver_execution_observation":{"matching_request":true,"terminal_success":true,"complete_valid_artifact":true,"artifact_matches_observed_process":true,"input_capture_bound":true,"late_or_cancelled":false}}});
    let valid = json!({"id":"development-valid","replace_observations":{},"consumer_owned_context_available":true});
    assert_eq!(
        receiver_guard_projection(&input, &valid, b"development-guard-native-artifact")["pass"],
        true
    );
    let missing = json!({"id":"development-missing","replace_observations":{"seal_present":false},"consumer_owned_context_available":false});
    assert_eq!(
        receiver_guard_projection(&input, &missing, b"development-guard-native-artifact")["pass"],
        true
    );
}

fn receiver_guard_projection(input: &Value, variant: &Value, artifact_bytes: &[u8]) -> Value {
    use semctx_r0_probe::{receiver::*, wire};
    use std::time::{Duration, Instant};
    let replay = |producer_claimed_ownership: bool| -> Result<Value, String> {
        let base = input["base_observations"]
            .as_object()
            .ok_or("missing frozen receiver base observations")?;
        let mut current = base.clone();
        for (key, value) in variant["replace_observations"]
            .as_object()
            .ok_or("missing guard replacements")?
        {
            current.insert(key.clone(), value.clone());
        }
        let observed = Value::Object(current);
        let original = Value::Object(base.clone());
        let boolean = |value: &Value, key: &str| {
            value
                .get(key)
                .and_then(Value::as_bool)
                .ok_or_else(|| format!("missing guard boolean {key}"))
        };
        let changed = |key: &str| -> Result<bool, String> {
            let now = observed
                .get(key)
                .ok_or_else(|| format!("missing current guard value {key}"))?;
            let before = original
                .get(key)
                .ok_or_else(|| format!("missing base guard value {key}"))?;
            Ok(now != before)
        };
        let execution = &observed["receiver_execution_observation"];
        let source_files = input["files"]
            .as_object()
            .ok_or("missing frozen guard input files")?;
        let path = source_files
            .keys()
            .find(|p| p.ends_with(".ts"))
            .ok_or("missing guard source path")?
            .clone();
        let source = source_files[&path]
            .as_str()
            .ok_or("missing guard source bytes")?;
        let input_a = json!({"files":source_files});
        let input_b = json!({"files":source_files,"foreign_input":true});
        let capture_a = json!({"root":original["expected_root"],"files":source_files});
        let capture_b =
            json!({"root":observed["observed_root"],"files":source_files,"foreign_capture":true});
        let facts_a: Vec<wire::Fact> = vec![];
        let facts_b = vec![wire::Fact::Node {
            id: "guard-mutated-fact".into(),
            subject_id: path.clone(),
            fact_kind: "node:module".into(),
            path: Some(path.clone()),
            range: None,
            payload: json!({"id":"guard-mutated-fact","kind":"module","name":path,"filePath":path,"evidence":[],"tags":[],"metadata":{}}),
        }];
        let graph_a = json!({"nodes":[],"edges":[]});
        let graph_b = json!({"nodes":[{"id":"guard-mutated-fact","kind":"module","name":path,"filePath":path,"evidence":[],"tags":[],"metadata":{}}],"edges":[]});
        let snapshot = json!({"guard_fixture_snapshot":capture_a});
        let scope = json!({"profile":original["expected_profile"],"root":original["expected_root"],"selection_mode":original.get("expected_selection_mode")});
        let facts_id_a =
            FactsId::observed_json(&serde_json::to_value(&facts_a).map_err(|e| e.to_string())?);
        let facts_id_b =
            FactsId::observed_json(&serde_json::to_value(&facts_b).map_err(|e| e.to_string())?);
        let input_id_a = InputId::observed_json(&input_a);
        let input_id_b = InputId::observed_json(&input_b);
        let bindings = Bindings {
            artifact: ArtifactId::observed_bytes(artifact_bytes),
            input: if changed("expected_input_hash")? {
                input_id_b.clone()
            } else {
                input_id_a.clone()
            },
            capture: CaptureId::observed_json(&capture_a),
            facts: facts_id_a.clone(),
            graph: GraphId::observed_json(&graph_a),
            snapshot: SnapshotId::observed_json(&snapshot),
            scope: ScopeId::observed_json(&scope),
        };
        let freshness = Freshness {
            verdict: match value_text(&observed, "freshness_verdict")? {
                "FRESH" => FreshnessVerdict::Fresh,
                "DIRTY_KNOWN" => FreshnessVerdict::DirtyKnown,
                "STALE" => FreshnessVerdict::Stale,
                "UNKNOWN" => FreshnessVerdict::Unknown,
                _ => return Err("unsupported frozen freshness verdict".into()),
            },
            reasons: observed["freshness_reasons"]
                .as_array()
                .ok_or("missing freshness reasons")?
                .iter()
                .map(|v| {
                    v.as_str()
                        .map(str::to_string)
                        .ok_or("invalid freshness reason")
                })
                .collect::<Result<Vec<_>, _>>()?,
            seal: if boolean(&observed, "seal_present")? {
                Some(FreshnessSeal {
                    repository_facts: if changed("sealed_facts_hash")? {
                        facts_id_b.clone()
                    } else {
                        facts_id_a.clone()
                    },
                    indexed_facts: if changed("indexed_facts_hash")? {
                        facts_id_b.clone()
                    } else {
                        facts_id_a.clone()
                    },
                    analysis_input: if changed("sealed_input_hash")? {
                        input_id_b.clone()
                    } else {
                        input_id_a.clone()
                    },
                    indexed_input: if changed("indexed_input_hash")? {
                        input_id_b.clone()
                    } else {
                        input_id_a.clone()
                    },
                })
            } else {
                None
            },
        };
        let fresh_base = Freshness {
            verdict: FreshnessVerdict::Fresh,
            reasons: vec![],
            seal: Some(FreshnessSeal {
                repository_facts: facts_id_a.clone(),
                indexed_facts: facts_id_a.clone(),
                analysis_input: input_id_a.clone(),
                indexed_input: input_id_a.clone(),
            }),
        };
        let batch = wire::Batch {
            schema_version: 1,
            case_id: "controlled-receiver-guard".into(),
            request_id: value_text(variant, "id")?.into(),
            snapshot_id: bindings.snapshot.as_str().into(),
            scope_id: bindings.scope.as_str().into(),
            profile: value_text(&original, "expected_profile")?.into(),
            producer_artifact_id: bindings.artifact.as_str().into(),
            input_manifest_id: input_id_a.as_str().into(),
            capture_id: bindings.capture.as_str().into(),
            facts_id: facts_id_a.as_str().into(),
            graph_id: bindings.graph.as_str().into(),
            complete: boolean(execution, "complete_valid_artifact")?,
            terminal: wire::Terminal::Complete,
            subjects: vec![wire::SubjectReport {
                subject_id: path.clone(),
                selection: wire::Selection::Selected,
                outcome: Some(wire::AnalysisOutcome::Analyzed),
                coverage: vec![],
            }],
            facts: facts_a.clone(),
            diagnostics: vec![],
            input_observations: vec![],
            producer_claimed_ownership: Some(producer_claimed_ownership),
        };
        let stdout = serde_json::to_string(&batch).map_err(|e| e.to_string())?;
        let outcome = process::Outcome {
            kind: if boolean(execution, "terminal_success")? {
                "success"
            } else if boolean(execution, "late_or_cancelled")? {
                "cancelled"
            } else {
                "nonzero"
            }
            .into(),
            exit_code: Some(if boolean(execution, "terminal_success")? {
                0
            } else {
                1
            }),
            duration_ms: 1,
            stdout_bytes: stdout.len() as u64,
            stderr_bytes: 0,
            stdout_hash: sha(stdout.as_bytes()),
            stderr_hash: sha(b""),
            stdout,
            stderr: String::new(),
        };
        let expected = Expected {
            case_id: "controlled-receiver-guard".into(),
            request: RequestId::new(value_text(variant, "id")?).map_err(|e| format!("{e:?}"))?,
            bindings,
            profile: value_text(&original, "expected_profile")?.into(),
            subjects: vec![ExpectedSubject {
                id: SubjectId::new(path.clone()).map_err(|e| format!("{e:?}"))?,
                selection: wire::Selection::Selected,
                source: Some(SourceExtent {
                    path: path.clone(),
                    utf16_length: source.encode_utf16().count() as u64,
                    line_count: source.bytes().filter(|b| *b == b'\n').count() as u32 + 1,
                }),
                fact_kinds: BTreeSet::new(),
                ranged_fact_kinds: BTreeSet::new(),
                pathless_fact_kinds: BTreeSet::new(),
                absence_allowed_kinds: BTreeSet::new(),
            }],
            terminal: ExpectedTerminal::Analyzed,
            deadline: if boolean(execution, "late_or_cancelled")? {
                Instant::now() - Duration::from_millis(1)
            } else {
                Instant::now() + Duration::from_secs(20)
            },
            max_duration_ms: 20_000,
            output_cap: 8_388_608,
        };
        let receiver =
            Receiver::new(expected).map_err(|e| format!("invalid controlled expected: {e:?}"))?;
        let post_receipt = value_text(variant, "id")?.starts_with("post-receipt-");
        let facts_changed = changed("actual_observed_facts_hash")?;
        let capture_changed = changed("observed_capture_identity")?
            || changed("observed_root")?
            || !boolean(execution, "input_capture_bound")?;
        let artifact_variant: &[u8] = if boolean(execution, "artifact_matches_observed_process")? {
            artifact_bytes
        } else {
            b"controlled foreign artifact bytes"
        };
        let state = ObservedState {
            artifact_bytes: artifact_variant,
            input_manifest: if changed("consumed_input_hash")? {
                &input_b
            } else {
                &input_a
            },
            capture: if capture_changed {
                &capture_b
            } else {
                &capture_a
            },
            facts: if facts_changed { &facts_b } else { &facts_a },
            graph: if facts_changed { &graph_b } else { &graph_a },
            snapshot: &snapshot,
            scope: &scope,
            profile: value_text(&observed, "observed_profile")?,
            freshness: &freshness,
            binding_valid: boolean(&observed, "binding_valid")?,
            build_complete: boolean(&observed, "build_complete")?,
            check_changed: boolean(&observed, "check_changed")?,
            request_current: boolean(execution, "matching_request")?,
        };
        let before = ObservedState {
            artifact_bytes,
            input_manifest: &input_a,
            capture: &capture_a,
            facts: &facts_a,
            graph: &graph_a,
            snapshot: &snapshot,
            scope: &scope,
            profile: value_text(&original, "expected_profile")?,
            freshness: &fresh_base,
            binding_valid: true,
            build_complete: true,
            check_changed: false,
            request_current: true,
        };
        let result = receiver
            .receive(&outcome, if post_receipt { &before } else { &state })
            .and_then(|receipt| receiver.context(Some(&receipt), &state).map(|_| ()));
        let available = result.is_ok();
        let expected_available = boolean(variant, "consumer_owned_context_available")?;
        Ok(
            json!({"producer_claimed_ownership":producer_claimed_ownership,"available":available,"expected_available":expected_available,"pass":available==expected_available,"observed_rejection":result.err().map(|e|format!("{e:?}")),"phase":if post_receipt{"revalidate_after_receipt"}else{"receive_and_context"}}),
        )
    };
    let results = [replay(true), replay(false)];
    let mut observations = vec![];
    let mut pass = true;
    for result in results {
        match result {
            Ok(v) => {
                pass &= v["pass"] == true;
                observations.push(v);
            }
            Err(error) => {
                pass = false;
                observations.push(
                    json!({"state":"NOT_EXECUTABLE_GUARD_MAPPING","error":error,"pass":false}),
                );
            }
        }
    }
    json!({"state":if pass{"PASS_CONTROLLED_RECEIVER_GUARD_ONLY"}else{"NONPASS_CONTROLLED_RECEIVER_GUARD"},"pass":pass,"observations":observations,"proof_scope":"controlled receiver guard, synthetic structure-valid carrier, actual frozen artifact bytes; not actual producer stdout/process attestation or semantic parity","global_admission_inferred":false,"opaque_graph_owner_discharge_performed":false})
}
#[test]
fn comparator_absence_marker_does_not_accept_null_or_present_value() {
    let expected = json!({"signatureOnly":{"$field_absent":true}});
    assert!(projected_eq(&json!({"name":"adapterDevAbsent"}), &expected));
    assert!(!projected_eq(&json!({"signatureOnly":null}), &expected));
    assert!(!projected_eq(&json!({"signatureOnly":false}), &expected));
}
#[test]
fn comparator_indexed_absence_checks_real_binding_field() {
    let e = json!([{"index":0,"fields":["runtimeUsed"]}]);
    assert!(
        compare(
            &json!([{"relPath":"adapterDevTarget.ts"}]),
            &e,
            "indexed_field_absences"
        )
        .unwrap()
    );
    assert!(
        !compare(
            &json!([{"relPath":"adapterDevTarget.ts","runtimeUsed":false}]),
            &e,
            "indexed_field_absences"
        )
        .unwrap()
    );
}
#[test]
fn comparator_explicit_filter_preserves_only_declared_output_scope() {
    let observed = json!({"items":[{"owner":"adapterDevA","name":"expected"},{"owner":"adapterDevB","name":"outside-projection"}]});
    let c = json!({"target":["items"],"actual_filter":{"owner":"adapterDevA"},"mode":"unordered_projected_eq","actual_transform":"none","expected":[{"name":"expected"}]});
    assert_eq!(evaluate(&observed, &c)["state"], "PASS_PROJECTED_PROPERTY");
}
#[test]
fn comparator_component_projection_rejects_missing_unsupported_observation() {
    let checks = json!([
        {"target":["subjects",{"path":"adapterDev.ts"},"semanticObservation","executed"],"expected":true,"mode":"eq","actual_transform":"none"},
        {"target":["subjects",{"path":"adapterDev.ts"},"semanticObservation","reasons"],"expected":{"contains":["DEV_REASON"]},"mode":"reason_constraints","actual_transform":"none"}
    ]);
    assert!(validate_component_checks(checks.as_array().unwrap()).is_err());
    let mut complete = checks.as_array().unwrap().clone();
    complete[1]["operation_binding"] = json!({"status":"VERIFIED_SOURCE_OPERATION","target":complete[1]["target"],"baseline_operation":"DEV semantic component","authority":"independently authored DEV"});
    complete.push(json!({"target":["subjects",{"path":"adapterDev.ts"},"semanticObservation","unsupported"],"expected":[],"mode":"eq","actual_transform":"none"}));
    assert!(validate_component_checks(&complete).is_ok());
    let observed = json!({"subjects":[{"path":"adapterDev.ts","semanticObservation":{"executed":true,"reasons":["DEV_REASON"],"unsupported":["DEV_NOT_IMPLEMENTED"]}}]});
    assert!(
        complete
            .iter()
            .any(|c| evaluate(&observed, c)["state"] != "PASS_PROJECTED_PROPERTY")
    );
}
#[test]
fn comparator_same_label_different_input_is_rejected_before_projection() {
    let a = json!({"id":"development-shared-label","cwd":"/dev","sdk_directory":"/sdk/lib","case_sensitive":true,"files":{"/dev/adapterBinding.ts":"export const adapterBinding = 827;"},"utf16_files":{},"raw_files":{},"disabled":[]});
    let mut b = a.clone();
    b["files"]["/dev/adapterBinding.ts"] = json!("export const adapterBinding = 829;");
    let sdk =
        json!({"version":"development-sdk-only","archive_sha256":"development-archive","files":{}});
    let input = json!({"domain":"T00-logical-input-v2","project":[{"location":{"domain":"repository","path":"adapterBinding.ts"},"representation":"text","text":"export const adapterBinding = 827;"}],"sdk":{"domain":"T00-logical-sdk-v2","version":"development-sdk-only","archive_sha256":"development-archive","files":[]}});
    assert_eq!(verifier_logical_input(&a, &sdk).unwrap(), input);
    let observed = json!({"request":a["id"],"request_id":identity::digest(&a),"input_manifest_id":identity::digest(&input),"producer_artifact_id":"sha256:development-artifact","complete":true,"global_admission_inferred":false});
    assert!(observation_bound_to_request(&observed, &a, &sdk, "development-artifact").is_ok());
    assert!(observation_bound_to_request(&observed, &b, &sdk, "development-artifact").is_err());
}

#[test]
fn comparator_post_capture_setup_changes_physical_bytes_and_preserves_request() {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!("semctx-adapter-owned-dev-{stamp}"));
    fs::create_dir_all(&root).unwrap();
    let root = root.canonicalize().unwrap();
    let source = "export const adapterCapture = 177;";
    let target = root.join("adapterCapture.ts");
    fs::write(&target, source).unwrap();
    let request = json!({"files":{target.to_string_lossy().to_string():source}});
    let request_path = root.join("request.json");
    save(&request_path, &request).unwrap();
    let original = fs::read(&request_path).unwrap();
    let mutation = json!({"adapterCapture.ts":"export const adapterCapture = 179;"});
    let proof = apply_physical_post_capture(&request, &mutation, &root, &request_path).unwrap();
    assert_eq!(proof[0]["physical_differs_from_retained"], true);
    assert_eq!(fs::read(&request_path).unwrap(), original);
    assert_eq!(read_json(&request_path).unwrap(), request);
    assert!(
        apply_physical_post_capture(
            &request,
            &json!({"../foreign.ts":"foreign"}),
            &root,
            &request_path
        )
        .is_err()
    );
    fs::remove_dir_all(root).unwrap();
}

fn validate_reason_routing(check: &Value) -> Result<(), String> {
    let target = check["target"]
        .as_array()
        .ok_or("invalid credited target")?;
    if target.last().and_then(Value::as_str) != Some("reasons") {
        return Ok(());
    }
    let binding = check
        .get("operation_binding")
        .ok_or("reason projection has no source operation binding")?;
    if binding["status"] != "VERIFIED_SOURCE_OPERATION"
        || binding["target"] != check["target"]
        || binding
            .get("baseline_operation")
            .and_then(Value::as_str)
            .is_none_or(str::is_empty)
        || binding.get("authority").is_none_or(Value::is_null)
    {
        return Err("reason projection does not match its verified source operation".into());
    }
    Ok(())
}
fn validate_component_checks(checks: &[Value]) -> Result<(), String> {
    for check in checks {
        validate_reason_routing(check)?;
        let target = check["target"]
            .as_array()
            .ok_or("invalid credited target")?;
        let component_index = target.iter().position(|s| {
            [
                "semanticObservation",
                "sourceParsingObservation",
                "moduleConfigurationObservations",
                "javascriptObservation",
            ]
            .contains(&s.as_str().unwrap_or(""))
        });
        let Some(component_index) = component_index else {
            continue;
        };
        if matches!(
            target.last().and_then(Value::as_str),
            Some("executed" | "unsupported")
        ) {
            continue;
        }
        let component_end = component_index
            + 1
            + usize::from(target[component_index] == "moduleConfigurationObservations");
        if component_end > target.len() {
            return Err("component mode is missing".into());
        }
        let prefix = &target[..component_end];
        let observation = check
            .get("observation")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        for (field, expected) in [("executed", json!(true)), ("unsupported", json!([]))] {
            let mut path = prefix.to_vec();
            path.push(json!(field));
            if !checks.iter().any(|c| {
                c["target"] == json!(path)
                    && c["mode"] == "eq"
                    && c["expected"] == expected
                    && c.get("observation").and_then(Value::as_u64).unwrap_or(0) == observation
            }) {
                return Err(format!(
                    "component projection lacks {field} completeness check"
                ));
            }
        }
    }
    Ok(())
}
fn verifier_absolute_key(path: &str, sensitive: bool) -> Result<String, String> {
    let path = path.replace('\\', "/");
    if path.starts_with("//") {
        return Err("UNC identity requires a separately verified native path recipe".into());
    }
    let (prefix, rest) = if let Some(rest) = path.strip_prefix('/') {
        ("/".to_string(), rest)
    } else if path.as_bytes().get(1) == Some(&b':') && path.as_bytes().get(2) == Some(&b'/') {
        (path[..3].to_string(), &path[3..])
    } else {
        return Err("identity descriptor path must be absolute".into());
    };
    let mut parts = vec![];
    for part in rest.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                if parts.pop().is_none() {
                    return Err("identity path escapes its native root".into());
                }
            }
            _ => parts.push(part),
        }
    }
    let key = format!("{prefix}{}", parts.join("/"));
    Ok(if sensitive { key } else { key.to_lowercase() })
}
fn verifier_location(
    root: &str,
    path: &str,
    sensitive: bool,
    domain: &str,
) -> Result<(String, Value), String> {
    let root = verifier_absolute_key(root, sensitive)?;
    let path = verifier_absolute_key(path, sensitive)?;
    let relative = if path == root {
        Some("")
    } else {
        path.strip_prefix(&format!("{}/", root.trim_end_matches('/')))
    };
    let location = match relative {
        Some(relative) => json!({"domain":domain,"path":relative}),
        None => json!({"domain":"external","path":path}),
    };
    Ok((path, location))
}
fn verifier_logical_input(request: &Value, sdk: &Value) -> Result<Value, String> {
    let sensitive = request["case_sensitive"]
        .as_bool()
        .ok_or("missing native case sensitivity")?;
    let root = value_text(request, "cwd")?;
    let mut seen = BTreeSet::new();
    let mut project = vec![];
    for (field, representation, payload) in [
        ("files", "text", "text"),
        ("utf16_files", "utf16", "units"),
        ("raw_files", "raw", "bytes"),
    ] {
        for (path, value) in request[field]
            .as_object()
            .ok_or("missing explicit input representation")?
        {
            let (key, location) = verifier_location(root, path, sensitive, "repository")?;
            if !seen.insert(key) {
                return Err("duplicate canonical captured input key".into());
            }
            let mut entry = json!({"location":location,"representation":representation});
            if field == "raw_files" {
                entry["bytes"] = value.get("bytes").ok_or("missing raw input bytes")?.clone();
                entry["profile"] = value
                    .get("profile")
                    .ok_or("missing raw decoding profile")?
                    .clone();
            } else {
                entry[payload] = value.clone();
            }
            project.push(entry);
        }
    }
    project.sort_by_key(identity::canonical_json);
    let sdk_root = value_text(request, "sdk_directory")?;
    let mut sdk_files = vec![];
    for (path, text) in sdk["files"].as_object().ok_or("missing SDK file map")? {
        let (key, location) = verifier_location(sdk_root, path, sensitive, "sdk")?;
        if !seen.insert(key) {
            return Err("captured project/SDK canonical key collision".into());
        }
        sdk_files.push(json!({"location":location,"text":text}));
    }
    sdk_files.sort_by_key(identity::canonical_json);
    Ok(
        json!({"domain":"T00-logical-input-v2","project":project,"sdk":{"domain":"T00-logical-sdk-v2","version":sdk.get("version").ok_or("missing SDK version")?,"archive_sha256":sdk.get("archive_sha256").ok_or("missing SDK archive identity")?,"files":sdk_files}}),
    )
}
fn observation_bound_to_request(
    observed: &Value,
    request: &Value,
    sdk: &Value,
    artifact_sha: &str,
) -> Result<Value, String> {
    use semctx_r0_probe::receiver::InputId;
    let input = verifier_logical_input(request, sdk)?;
    let request_id = identity::digest(request);
    let input_id = InputId::observed_json(&input);
    if observed["producer_artifact_id"] != json!(format!("sha256:{artifact_sha}"))
        || observed["request"] != request["id"]
        || observed["request_id"] != request_id
        || observed["input_manifest_id"] != input_id.as_str()
        || observed["complete"] != true
        || observed["global_admission_inferred"] != false
    {
        return Err("native observation not bound to exact request/input/artifact".into());
    }
    Ok(
        json!({"request_id":request_id,"input_manifest_id":input_id.as_str(),"artifact_sha256":artifact_sha,"descriptor_contract":"native Request DTO with every default explicit; independently encoded T00-logical-input-v2 project/SDK descriptor; request digest remains physical"}),
    )
}
fn apply_physical_post_capture(
    request: &Value,
    mutations: &Value,
    root: &Path,
    request_path: &Path,
) -> Result<Value, String> {
    let before_request = fs::read(request_path).map_err(|e| e.to_string())?;
    let root_canonical = root.canonicalize().map_err(|e| e.to_string())?;
    let mut proof = vec![];
    for (path, text) in mutations
        .as_object()
        .ok_or("invalid live-source mutation map")?
    {
        if !safe_relative(path) {
            return Err("physical mutation escapes retained root".into());
        }
        let target = root.join(path);
        let canonical = target.canonicalize().map_err(|e| e.to_string())?;
        if !canonical.starts_with(&root_canonical) || canonical == request_path {
            return Err("physical mutation target is outside captured source root".into());
        }
        let key = canonical.to_string_lossy().replace('\\', "/");
        let retained = request["files"]
            .get(&key)
            .and_then(Value::as_str)
            .ok_or("physical mutation must target captured source")?;
        let physical_before = fs::read(&canonical).map_err(|e| e.to_string())?;
        if physical_before != retained.as_bytes() {
            return Err("physical source differs before declared post-capture mutation".into());
        }
        let changed = text.as_str().ok_or("non-string physical mutation")?;
        if changed == retained {
            return Err("post-capture mutation does not create required differing bytes".into());
        }
        fs::write(&canonical, changed.as_bytes()).map_err(|e| e.to_string())?;
        let physical_after = fs::read(&canonical).map_err(|e| e.to_string())?;
        if physical_after != changed.as_bytes() {
            return Err("physical post-capture bytes differ from declared setup".into());
        }
        proof.push(json!({"path":path,"retained_sha256":sha(retained.as_bytes()),"physical_before_sha256":sha(&physical_before),"physical_after_sha256":sha(&physical_after),"physical_differs_from_retained":true}));
    }
    let after_request = fs::read(request_path).map_err(|e| e.to_string())?;
    if after_request != before_request
        || serde_json::from_slice::<Value>(&after_request).map_err(|e| e.to_string())? != *request
    {
        return Err("retained request changed during physical setup".into());
    }
    Ok(Value::Array(proof))
}
#[test]
fn comparator_products_do_not_pass_with_identical_rows_and_unimplemented_context() {
    let request = json!({"cwd":"/dev","roots":["/dev/adapterProducts.ts"]});
    let recipe = json!({"checks":[{"target":["raw_extraction","symbols"]}]});
    let actual = json!({"raw_extraction":{"symbols":[{"name":"adapterProducts","kind":"function"}]},"subjects":[{"path":"adapterProducts.ts","outcome":"analyzed","unimplemented":[]}]});
    assert!(native_product_capability(&actual, &request, &recipe).is_ok());
    let mut unsupported = actual.clone();
    unsupported["subjects"][0]["unimplemented"] = json!(["DEV_NATIVE_CONTEXT_UNIMPLEMENTED"]);
    assert!(native_product_capability(&unsupported, &request, &recipe).is_err());
    let mut unknown = actual.clone();
    unknown["subjects"][0]["outcome"] = json!("unknown");
    assert!(native_product_capability(&unknown, &request, &recipe).is_err());
    let mut malformed = actual.clone();
    malformed["subjects"][0]["outcome"] = json!("malformed-state");
    assert!(native_product_capability(&malformed, &request, &recipe).is_err());
    let mut failed = actual.clone();
    failed["subjects"][0]["outcome"] = json!("failed");
    assert!(native_product_capability(&failed, &request, &recipe).is_err());
    let recovery_recipe = json!({"checks":[{"target":["outlines","adapterProducts.ts","outline","hasSyntaxErrors"],"expected":true}]});
    assert!(native_product_capability(&failed, &request, &recovery_recipe).is_ok());
    assert!(native_product_capability(&unknown, &request, &recovery_recipe).is_err());
    let mut refused = actual;
    refused["subjects"][0]["outcome"] = json!("unsupported");
    assert!(native_product_capability(&refused, &request, &recipe).is_ok());
}

fn native_product_capability(
    observed: &Value,
    request: &Value,
    recipe: &Value,
) -> Result<Value, String> {
    let checks = recipe["checks"]
        .as_array()
        .ok_or("missing product checks")?;
    let mut whole_program = false;
    let mut paths = BTreeSet::new();
    let mut explicit_syntax_recovery = BTreeSet::new();
    for check in checks {
        let target = check["target"].as_array().ok_or("missing product target")?;
        match target.first().and_then(Value::as_str) {
            Some("raw_extraction" | "assembly" | "calls") => whole_program = true,
            Some("outlines") => {
                if target.last().and_then(Value::as_str) == Some("hasSyntaxErrors")
                    && check["expected"] == true
                {
                    explicit_syntax_recovery.insert(
                        target
                            .get(1)
                            .and_then(Value::as_str)
                            .ok_or("missing recovered outline path")?
                            .to_string(),
                    );
                }
                paths.insert(
                    target
                        .get(1)
                        .and_then(Value::as_str)
                        .ok_or("missing outline product path")?
                        .to_string(),
                );
            }
            Some("subjects") if target.get(2).and_then(Value::as_str) == Some("javascript") => {
                paths.insert(
                    target
                        .get(1)
                        .and_then(|v| v.get("path"))
                        .and_then(Value::as_str)
                        .ok_or("missing javascript product path")?
                        .to_string(),
                );
            }
            _ => (),
        }
    }
    if whole_program {
        let cwd = value_text(request, "cwd")?;
        let prefix = format!("{cwd}/");
        for root in request["roots"]
            .as_array()
            .ok_or("missing materialized roots")?
        {
            let path = root
                .as_str()
                .ok_or("invalid materialized root")?
                .strip_prefix(&prefix)
                .ok_or("root outside exact materialized capture")?;
            if ![".d.ts", ".d.mts", ".d.cts"]
                .iter()
                .any(|suffix| path.ends_with(suffix))
            {
                paths.insert(path.into());
            }
        }
    }
    if paths.is_empty() {
        return Ok(json!({"state":"NO_NATIVE_PRODUCT_PROJECTION_CREDITED"}));
    }
    let subjects = observed["subjects"]
        .as_array()
        .ok_or("missing native product subjects")?;
    for path in &paths {
        let matching = subjects
            .iter()
            .filter(|s| s["path"].as_str() == Some(path))
            .collect::<Vec<_>>();
        if matching.len() != 1 {
            return Err(format!(
                "native product subject cardinality differs for {path}"
            ));
        }
        let subject = matching[0];
        let unimplemented = subject["unimplemented"]
            .as_array()
            .ok_or("missing native product capability status")?;
        if !unimplemented.is_empty() {
            return Err(format!("native product context unimplemented for {path}"));
        }
        match value_text(subject, "outcome")? {
            "analyzed" | "unsupported" | "disabled" | "not_applicable" => (),
            "failed" if !whole_program && explicit_syntax_recovery.contains(path) => (),
            "unknown" | "failed" => {
                return Err(format!(
                    "unknown or failed native product outcome for {path}"
                ));
            }
            _ => return Err(format!("malformed native product outcome for {path}")),
        }
    }
    Ok(
        json!({"state":"NO_REPORTED_NATIVE_PRODUCT_INCAPACITY_IN_CREDITED_SCOPE","paths":paths,"requires_global_analyzed":false}),
    )
}

#[test]
fn comparator_reason_routing_rejects_empty_wrong_component_and_missing_authority() {
    let target = json!(["subjects",{"path":"adapterRouting.ts"},"semanticObservation","reasons"]);
    let binding = json!({"target":target,"baseline_operation":"inspectSemanticDependencies","authority":"independent DEV component contract","status":"VERIFIED_SOURCE_OPERATION"});
    let check = json!({"target":target,"mode":"reason_constraints","expected":{"exact_set":[]},"actual_transform":"none","operation_binding":binding});
    let mut checks = vec![check.clone()];
    for (field, value) in [("executed", json!(true)), ("unsupported", json!([]))] {
        checks.push(json!({"target":["subjects",{"path":"adapterRouting.ts"},"semanticObservation",field],"mode":"eq","expected":value,"actual_transform":"none"}));
    }
    assert!(validate_component_checks(&checks).is_ok());
    let mut poison = checks.clone();
    for c in &mut poison {
        let tail = c["target"].as_array().unwrap().last().unwrap().clone();
        c["target"] = json!(["subjects",{"path":"adapterRouting.ts"},"moduleConfigurationObservations","retainedWithoutSource",tail]);
    }
    assert!(validate_component_checks(&poison).is_err());
    let mut javascript_poison = checks.clone();
    for c in &mut javascript_poison {
        let tail = c["target"].as_array().unwrap().last().unwrap().clone();
        c["target"] = json!(["subjects",{"path":"adapterRouting.ts"},"javascriptObservation",tail]);
    }
    assert!(validate_component_checks(&javascript_poison).is_err());
    let mut missing = checks;
    missing[0]
        .as_object_mut()
        .unwrap()
        .remove("operation_binding");
    assert!(validate_component_checks(&missing).is_err());
}

#[test]
fn comparator_graph_projection_uses_actual_endpoint_nodes_and_rejects_orphans() {
    let graph = json!({"nodes":[{"id":"dev-f","kind":"function","filePath":"devGraph.ts"},{"id":"dev-t","kind":"test","filePath":"devGraph.test.ts"}],"symbols":[{"id":"dev-f","name":"devGraph","scope":[]}],"edges":[{"kind":"tested_by","from":"dev-f","to":"dev-t"}]});
    let expected = json!([{"kind":"tested_by","from":{"path":"devGraph.ts","symbol_path":"devGraph"},"to":{"path":"devGraph.test.ts","test_node":true}}]);
    assert_eq!(
        transform(&graph, "logical_coverage_edges").unwrap(),
        expected
    );
    let mut poison = graph.clone();
    poison["edges"][0]["to"] = json!("missing-node");
    assert!(transform(&poison, "logical_coverage_edges").is_err());
    let mut poison = graph;
    poison["nodes"][0]["id"] = json!("changed-id");
    assert!(transform(&poison, "logical_coverage_edges").is_err());
}
#[test]
fn comparator_prefix_count_and_projection_filters_observe_extra_rows() {
    assert!(
        compare(
            &json!([{"id":"dev:x#1"},{"id":"dev:x#2"}]),
            &json!({"prefix":"dev:x#","count":2}),
            "prefix_count"
        )
        .unwrap()
    );
    assert!(
        !compare(
            &json!([{"id":"dev:x#1"}]),
            &json!({"prefix":"dev:x#","count":2}),
            "prefix_count"
        )
        .unwrap()
    );
    assert!(
        compare(
            &json!([{}]),
            &json!({"prefix":"dev:x#","count":0}),
            "prefix_count"
        )
        .is_err()
    );
}

#[test]
fn comparator_coupled_relations_use_two_actual_observations_and_exact_cardinality() {
    let relation = json!({"left_observation":0,"right_observation":1,"target":["rows"],"transform":"pluck:digest","expected_equal":[true,false]});
    let a = json!({"rows":[{"digest":"dev-a"},{"digest":"dev-b"}]});
    let b = json!({"rows":[{"digest":"dev-a"},{"digest":"dev-c"}]});
    assert_eq!(
        evaluate_relation(&[a.clone(), b.clone()], &relation)["state"],
        "PASS_PROJECTED_PROPERTY"
    );
    assert_ne!(
        evaluate_relation(&[a.clone(), a.clone()], &relation)["state"],
        "PASS_PROJECTED_PROPERTY"
    );
    assert_ne!(
        evaluate_relation(std::slice::from_ref(&a), &relation)["state"],
        "PASS_PROJECTED_PROPERTY"
    );
    let short = json!({"rows":[{"digest":"dev-a"}]});
    assert_ne!(
        evaluate_relation(&[a, short], &relation)["state"],
        "PASS_PROJECTED_PROPERTY"
    );
}

#[test]
fn comparator_primitive_binding_rejects_swapped_descriptor_artifact_and_incapacity() {
    let request = json!({"operation":"decode","bytes":[65,66],"profile":"compiler_system","offsets_utf16":[0,2]});
    let observed = json!({"operation":"decode","executed":true,"unsupported":[],"producer_artifact_id":"sha256:dev-native-artifact","request_descriptor_id":identity::digest(&request)});
    assert!(primitive_bound_to_request(&observed, &request, "dev-native-artifact").is_ok());
    let mut swapped = request.clone();
    swapped["bytes"] = json!([65, 67]);
    assert!(primitive_bound_to_request(&observed, &swapped, "dev-native-artifact").is_err());
    let mut poison = observed.clone();
    poison["unsupported"] = json!(["DEV_MISSING_NATIVE_OPERATION"]);
    assert!(primitive_bound_to_request(&poison, &request, "dev-native-artifact").is_err());
    assert!(primitive_bound_to_request(&observed, &request, "dev-other-artifact").is_err());
}

#[test]
fn comparator_config_diagnostic_projection_retains_unexpected_18003_and_rejects_malformed_codes() {
    let valid = json!([
        "SOURCE_CONFIGURATION_INVALID:5023:raw wording",
        "SOURCE_GLOBAL_SCRIPT_UNSUPPORTED"
    ]);
    assert_eq!(
        transform(&valid, "configuration_diagnostic_projection").unwrap(),
        json!([{"reason":"SOURCE_CONFIGURATION_INVALID","code":5023}])
    );
    let extra = json!(["SOURCE_CONFIGURATION_INVALID:18003:no inputs"]);
    assert!(
        !compare(
            &transform(&extra, "configuration_diagnostic_projection").unwrap(),
            &json!([]),
            "unordered_projected_eq"
        )
        .unwrap()
    );
    assert!(
        transform(
            &json!(["SOURCE_CONFIGURATION_INVALID:wrong:message"]),
            "configuration_diagnostic_projection"
        )
        .is_err()
    );
    assert!(
        transform(
            &json!(["SOURCE_CONFIGURATION_INVALID:5023"]),
            "configuration_diagnostic_projection"
        )
        .is_err()
    );
    assert!(transform(&json!([null]), "configuration_diagnostic_projection").is_err());
}

#[test]
fn comparator_worker_refusal_and_descriptor_binding_do_not_promote_useful_success() {
    let request = json!({"schemaVersion":9,"jobId":"dev-worker"});
    let sdk = json!({"version":"dev-sdk-only"});
    let observed = json!({"schemaVersion":1,"jobId":"unbound","ok":false,"extraction_started":false,"request_descriptor_id":identity::digest(&request),"producer_artifact_id":"sha256:dev-worker-artifact"});
    assert!(
        worker_bound_to_request(&observed, &request, &sdk, "dev-worker-artifact", true).is_ok()
    );
    assert!(
        worker_bound_to_request(&observed, &request, &sdk, "dev-worker-artifact", false).is_err()
    );
    let mut poison = observed.clone();
    poison["extraction_started"] = json!(true);
    assert!(worker_bound_to_request(&poison, &request, &sdk, "dev-worker-artifact", true).is_err());
    assert!(
        worker_bound_to_request(&observed, &json!({}), &sdk, "dev-worker-artifact", true).is_err()
    );
}

#[test]
fn comparator_nonreason_component_flag_needs_execution_and_no_unsupported() {
    let check = json!({"target":["subjects",{"path":"devParsingFlag.mjs"},"javascriptObservation","parseFailed"],"expected":false,"mode":"eq","actual_transform":"none"});
    assert!(validate_component_checks(std::slice::from_ref(&check)).is_err());
    let mut complete = vec![check];
    for (field, value) in [("executed", json!(true)), ("unsupported", json!([]))] {
        complete.push(json!({"target":["subjects",{"path":"devParsingFlag.mjs"},"javascriptObservation",field],"expected":value,"mode":"eq","actual_transform":"none"}));
    }
    assert!(validate_component_checks(&complete).is_ok());
    let mut other_observation = complete.clone();
    other_observation[0]["observation"] = json!(1);
    assert!(validate_component_checks(&other_observation).is_err());
    let observed = json!({"subjects":[{"path":"devParsingFlag.mjs","javascriptObservation":{"parseFailed":false,"executed":false,"unsupported":["DEV_NOT_IMPLEMENTED"]}}]});
    assert!(
        complete
            .iter()
            .any(|c| evaluate(&observed, c)["state"] != "PASS_PROJECTED_PROPERTY")
    );
}

#[test]
fn comparator_logical_binding_preserves_relocation_but_rejects_aliases_and_sdk_changes() {
    let sdk = json!({"version":"development-sdk","archive_sha256":"development-archive","files":{"/sdk/lib/dev.d.ts":"declare const development: number;"}});
    let a = json!({"cwd":"/alpha","sdk_directory":"/sdk/lib","case_sensitive":false,"files":{"/alpha/SOURCE.ts":"export const development = 907;"},"utf16_files":{},"raw_files":{}});
    let mut b = a.clone();
    b["cwd"] = json!("/beta");
    b["files"] = json!({"/beta/source.ts":"export const development = 907;"});
    let logical = verifier_logical_input(&a, &sdk).unwrap();
    assert_eq!(logical, verifier_logical_input(&b, &sdk).unwrap());
    assert_ne!(identity::digest(&a), identity::digest(&b));
    let mut alias = a.clone();
    alias["utf16_files"] = json!({"/ALPHA/dir/../source.ts":[1]});
    assert!(verifier_logical_input(&alias, &sdk).is_err());
    let mut collision = a.clone();
    collision["files"]["/sdk/lib/dev.d.ts"] = json!("collision");
    assert!(verifier_logical_input(&collision, &sdk).is_err());
    for field in ["version", "archive_sha256"] {
        let mut changed = sdk.clone();
        changed[field] = json!("foreign");
        assert_ne!(logical, verifier_logical_input(&a, &changed).unwrap());
    }
    let mut changed = sdk.clone();
    changed["files"]["/sdk/lib/dev.d.ts"] = json!("different");
    assert_ne!(logical, verifier_logical_input(&a, &changed).unwrap());
    assert!(verifier_absolute_key("//server/share/file.ts", true).is_err());
}

#[test]
fn comparator_worker_identical_facts_cannot_mask_unknown_frontend_or_missing_roots() {
    let request = json!({"rootAbsPaths":["/dev/workerCapability.ts"]});
    let good = json!({"extraction":{"symbols":[]},"frontendCapabilityObservation":{"executed":true,"roots":[{"path":"/dev/workerCapability.ts","loaded":true,"parseDiagnosticCodes":[]}],"unsupported":[],"workspaceIssues":[],"resolutionErrors":{}}});
    assert!(worker_frontend_capability(&good, &request, true).is_ok());
    for (field, value) in [
        ("executed", json!(false)),
        ("unsupported", json!(["DEV_UNKNOWN"])),
        (
            "workspaceIssues",
            json!([{"path":"/dev/x","kind":"unsupported","detail":"DEV_UNKNOWN"}]),
        ),
        ("resolutionErrors", json!({"/dev/x":"DEV_UNKNOWN"})),
        ("roots", json!([])),
    ] {
        let mut poison = good.clone();
        poison["frontendCapabilityObservation"][field] = value;
        assert!(worker_frontend_capability(&poison, &request, true).is_err());
    }
    let mut poison = good.clone();
    poison["frontendCapabilityObservation"]["roots"][0]["parseDiagnosticCodes"] = json!([1134]);
    assert!(worker_frontend_capability(&poison, &request, true).is_err());
    let mut poison = good.clone();
    poison["frontendCapabilityObservation"]["roots"][0]["loaded"] = json!(false);
    assert!(worker_frontend_capability(&poison, &request, true).is_err());
}

#[test]
fn comparator_system_result_binding_rejects_same_values_with_unexecuted_or_wrong_query() {
    let request = json!({"files":{"/dev/system.ts":"retained development"},"queries":[{"operation":"file_exists","path":"/dev/system.ts"}]});
    let good = json!({"request_descriptor_id":identity::digest(&request),"requestDescriptorId":identity::digest(&request),"producer_artifact_id":"sha256:development-system","executed":true,"unsupported":[],"probes":[],"results":[{"operation":"file_exists","path":"/dev/system.ts","executed":true,"unsupported":[],"refusals":[],"value":true}]});
    assert!(system_complete_binding(&good, &request, "development-system").is_ok());
    for (field, value) in [
        ("executed", json!(false)),
        ("unsupported", json!(["DEV_UNKNOWN"])),
        ("refusals", json!(["DEV_REFUSED"])),
        ("path", json!("/dev/foreign.ts")),
        ("operation", json!("directory_exists")),
    ] {
        let mut poison = good.clone();
        poison["results"][0][field] = value;
        assert!(system_complete_binding(&poison, &request, "development-system").is_err());
    }
    let mut poison = good.clone();
    poison["request_descriptor_id"] = json!("sha256:foreign");
    assert!(system_complete_binding(&poison, &request, "development-system").is_err());
    let mut poison = good.clone();
    poison["results"] = json!([]);
    assert!(system_complete_binding(&poison, &request, "development-system").is_err());
}

#[test]
fn comparator_system_malformed_stdout_is_unit_nonpass_without_retry_or_fallback() {
    let malformed = system_observation_json("not a native JSON observation").unwrap_err();
    assert_eq!(malformed["pass"], false);
    assert_eq!(malformed["state"], "MALFORMED_SYSTEM_NATIVE_OBSERVATION");
    assert!(system_observation_json("{}").is_ok());
    assert!(system_complete_binding(&json!({}), &json!({}), "development-system").is_err());
}

fn repair_units(ids: &[&str]) {
    let recipe_path =
        PathBuf::from(std::env::var_os("SEMCTX_REPAIR_RECIPES").expect("repair recipes"));
    let fixture = read_json(&PathBuf::from(
        std::env::var_os("SEMCTX_REPAIR_FIXTURE").expect("repair fixture"),
    ))
    .unwrap();
    let out =
        PathBuf::from(std::env::var_os("SEMCTX_REPAIR_EVIDENCE").expect("fresh repair evidence"))
            .join(format!("units-{}", ids[0].split("::").next().unwrap()));
    assert!(!out.exists(), "repair evidence must be fresh");
    fs::create_dir_all(&out).unwrap();
    let recipes = read_json(&recipe_path).unwrap();
    verify_sources(Path::new(fixture["cases_path"].as_str().unwrap()), &recipes).unwrap();
    let artifact = Path::new(fixture["artifact_path"].as_str().unwrap());
    let helper = Path::new(fixture["helper_path"].as_str().unwrap());
    let sdk_path = Path::new(fixture["sdk_path"].as_str().unwrap());
    let artifact_sha = fixture["artifact_sha256"].as_str().unwrap();
    let helper_sha = fixture["helper_sha256"].as_str().unwrap();
    exact_hash(artifact, artifact_sha).unwrap();
    exact_hash(helper, helper_sha).unwrap();
    exact_hash(sdk_path, fixture["sdk_sha256"].as_str().unwrap()).unwrap();
    let sdk = read_json(sdk_path).unwrap();
    let mut results = vec![];
    for (index, id) in ids.iter().enumerate() {
        let recipe = recipes["recipes"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["unit_id"] == *id)
            .expect("existing frozen unit");
        let dir = out.join(format!("unit-{index:03}"));
        let result = match recipe["surface"].as_str().unwrap() {
            "raw_cli" => run_raw_recipe(
                recipe,
                &dir,
                artifact,
                helper,
                (sdk_path, &sdk),
                artifact_sha,
                helper_sha,
            ),
            "worker_consumer_cli" => {
                run_consumer_recipe(recipe, &dir, artifact, helper, artifact_sha, helper_sha)
            }
            "worker_cli" => run_worker_recipe(
                recipe,
                &dir,
                artifact,
                helper,
                (sdk_path, &sdk),
                artifact_sha,
                helper_sha,
            ),
            other => panic!("unsupported repair unit surface {other}"),
        }
        .unwrap_or_else(|error| json!({"pass":false,"error":error}));
        results.push(json!({"unit_id":id,"result":result}));
    }
    save(&out.join("repair-results.json"), &json!(results)).unwrap();
    assert!(
        results.iter().all(|r| r["result"]["pass"] == true),
        "repair observations: {}",
        serde_json::to_string(&results).unwrap()
    );
}

#[test]
fn repair_role_context_preserves_canonical_test_owners() {
    repair_units(&[
        "P07-namespace-real-owner::base",
        "V2-E04-default-through-barrel-test-owner::base",
    ]);
}

#[test]
fn repair_worker_mutations_start_from_an_accepted_emit_subset() {
    repair_units(&[
        "N13-malformed-worker-evidence::mutation-01",
        "N13-malformed-worker-evidence::mutation-02",
        "N13-malformed-worker-evidence::mutation-03",
    ]);
}

#[test]
fn repair_encoding_coordinates_submit_only_utf16_offsets() {
    let fixture = read_json(&PathBuf::from(
        std::env::var_os("SEMCTX_REPAIR_FIXTURE").expect("repair fixture"),
    ))
    .unwrap();
    let recipes = read_json(&PathBuf::from(
        std::env::var_os("SEMCTX_REPAIR_RECIPES").expect("repair recipes"),
    ))
    .unwrap();
    verify_sources(Path::new(fixture["cases_path"].as_str().unwrap()), &recipes).unwrap();
    let out =
        PathBuf::from(std::env::var_os("SEMCTX_REPAIR_EVIDENCE").expect("fresh repair evidence"))
            .join("encoding");
    assert!(!out.exists(), "repair evidence must be fresh");
    fs::create_dir_all(&out).unwrap();
    let artifact = Path::new(fixture["artifact_path"].as_str().unwrap());
    let helper = Path::new(fixture["helper_path"].as_str().unwrap());
    let artifact_sha = fixture["artifact_sha256"].as_str().unwrap();
    let helper_sha = fixture["helper_sha256"].as_str().unwrap();
    exact_hash(artifact, artifact_sha).unwrap();
    exact_hash(helper, helper_sha).unwrap();
    let mut results = vec![];
    for (index, id) in [
        "ENC::R02-retained-bom::retained",
        "ENC::R06-combined-retained-raw-text::ordinary",
        "ENC::R06-combined-retained-raw-text::retained",
    ]
    .iter()
    .enumerate()
    {
        let recipe = recipes["support_recipes"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["support_id"] == *id)
            .expect("existing frozen support");
        let result = run_primitive_recipe(
            recipe,
            &out.join(format!("support-{index:03}")),
            artifact,
            helper,
            artifact_sha,
            helper_sha,
        )
        .unwrap_or_else(|error| json!({"pass":false,"error":error}));
        results.push(json!({"support_id":id,"result":result}));
    }
    save(&out.join("repair-results.json"), &json!(results)).unwrap();
    assert!(
        results.iter().all(|r| r["result"]["pass"] == true),
        "encoding repairs: {}",
        serde_json::to_string(&results).unwrap()
    );
}

#[test]
fn comparator_worker_capability_accepts_only_bound_negative_ancestor_directory_probes() {
    let request =
        json!({"repoRoot":"/dev/outer/workspace","rootAbsPaths":["/dev/outer/workspace/main.ts"]});
    let issue = json!({"path":"/dev/outer/node_modules/@types","kind":"refusal","detail":"WORKSPACE_PATH_OUTSIDE_ROOT"});
    let probe = json!({"path":"/dev/outer/node_modules/@types","operation":"directory_exists","found":false,"content_id":null});
    let good = json!({"frontendCapabilityObservation":{"executed":true,"roots":[{"path":"/dev/outer/workspace/main.ts","loaded":true,"parseDiagnosticCodes":[]}],"unsupported":[],"workspaceIssues":[issue],"resolutionErrors":{}},"compiler_probes":[probe]});
    assert!(worker_frontend_capability(&good, &request, true).is_ok());
    for sensitive in [false, true] {
        let mut with_capability = good.clone();
        with_capability["compiler_probes"]
            .as_array_mut()
            .unwrap()
            .push(
                json!({"path":"","operation":"case_sensitive","found":sensitive,"content_id":null}),
            );
        assert!(worker_frontend_capability(&with_capability, &request, sensitive).is_ok());
        for (field, value) in [
            ("operation", json!("read_file")),
            ("found", json!(null)),
            ("content_id", json!("sha256:forged")),
        ] {
            let mut poison = with_capability.clone();
            poison["compiler_probes"][1][field] = value;
            assert!(worker_frontend_capability(&poison, &request, sensitive).is_err());
        }
    }
    for path in [
        "/dev/outer",
        "/dev",
        "/",
        "/node_modules/@types",
        "/dev/node_modules/@types",
    ] {
        let mut variant = good.clone();
        variant["frontendCapabilityObservation"]["workspaceIssues"][0]["path"] = json!(path);
        variant["compiler_probes"][0]["path"] = json!(path);
        assert!(
            worker_frontend_capability(&variant, &request, true).is_ok(),
            "allowed discovery directory {path}"
        );
    }
    for (field, value) in [
        ("kind", json!("unsupported")),
        ("kind", json!(null)),
        ("detail", json!("UNKNOWN")),
        ("detail", json!("WORKSPACE_NESTED_REPOSITORY")),
        ("path", json!("/dev/outer/workspace/main.ts")),
        ("path", json!("/dev/outer/workspace-adjacent")),
        ("path", json!("/unrelated")),
        ("path", json!("/dev/outer/../outer")),
        ("path", json!("/dev/outer/@types")),
    ] {
        let mut poison = good.clone();
        poison["frontendCapabilityObservation"]["workspaceIssues"][0][field] = value;
        assert!(
            worker_frontend_capability(&poison, &request, true).is_err(),
            "unapproved issue field {field}"
        );
    }
    for (field, value) in [
        ("operation", json!("read_file")),
        ("operation", json!("file_exists")),
        ("found", json!(true)),
        ("content_id", json!("sha256:forged")),
    ] {
        let mut poison = good.clone();
        poison["compiler_probes"][0][field] = value;
        assert!(
            worker_frontend_capability(&poison, &request, true).is_err(),
            "unsafe probe field {field}"
        );
    }
    let mut poison = good.clone();
    poison["compiler_probes"][0]
        .as_object_mut()
        .unwrap()
        .remove("content_id");
    assert!(worker_frontend_capability(&poison, &request, true).is_err());
    let mut poison = good.clone();
    poison["compiler_probes"] = json!([]);
    assert!(worker_frontend_capability(&poison, &request, true).is_err());
    let mut poison = good.clone();
    poison["compiler_probes"].as_array_mut().unwrap().push(json!({"path":"/dev/outer/node_modules/@types","operation":"read_file","found":true,"content_id":"sha256:outside"}));
    assert!(worker_frontend_capability(&poison, &request, true).is_err());
    let mut poison = good.clone();
    poison["frontendCapabilityObservation"]["workspaceIssues"].as_array_mut().unwrap().push(json!({"path":"/dev/outer/workspace/main.ts","kind":"refusal","detail":"WORKSPACE_NESTED_REPOSITORY"}));
    assert!(worker_frontend_capability(&poison, &request, true).is_err());
    let mut poison = good.clone();
    poison["frontendCapabilityObservation"]["workspaceIssues"][0]["unsupported"] = json!(true);
    assert!(worker_frontend_capability(&poison, &request, true).is_err());
    for (field, value) in [
        ("executed", json!(false)),
        ("unsupported", json!(["UNKNOWN"])),
        (
            "resolutionErrors",
            json!({"/dev/outer/workspace/main.ts":"UNKNOWN"}),
        ),
        ("roots", json!([])),
        ("workspaceIssues", json!(null)),
    ] {
        let mut poison = good.clone();
        poison["frontendCapabilityObservation"][field] = value;
        assert!(worker_frontend_capability(&poison, &request, true).is_err());
    }
    let mut poison = good.clone();
    poison["frontendCapabilityObservation"]["roots"][0]["loaded"] = json!(false);
    assert!(worker_frontend_capability(&poison, &request, true).is_err());
    let mut poison = good.clone();
    poison["frontendCapabilityObservation"]["roots"][0]["parseDiagnosticCodes"] = json!([1134]);
    assert!(worker_frontend_capability(&poison, &request, true).is_err());
    let mut malformed_request = request.clone();
    malformed_request
        .as_object_mut()
        .unwrap()
        .remove("repoRoot");
    assert!(worker_frontend_capability(&good, &malformed_request, true).is_err());
    malformed_request["repoRoot"] = json!("relative/workspace");
    assert!(worker_frontend_capability(&good, &malformed_request, true).is_err());
}

#[test]
fn repair_worker_facts_and_emit_subset_preserve_complete_native_context() {
    repair_units(&[
        "P13-worker-preserves-facts::base",
        "ORD-WORKER-EMIT-SUBSET::base",
    ]);
}

#[test]
fn comparator_worker_boundary_probe_aliases_cannot_hide_nonnegative_operations() {
    let request =
        json!({"repoRoot":"/dev/outer/workspace","rootAbsPaths":["/dev/outer/workspace/main.ts"]});
    let good = json!({"frontendCapabilityObservation":{"executed":true,"roots":[{"path":"/dev/outer/workspace/main.ts","loaded":true,"parseDiagnosticCodes":[]}],"unsupported":[],"workspaceIssues":[{"path":"/dev/outer/node_modules/@types","kind":"refusal","detail":"WORKSPACE_PATH_OUTSIDE_ROOT"}],"resolutionErrors":{}},"compiler_probes":[{"path":"/dev/outer/node_modules/@types","operation":"directory_exists","found":false,"content_id":null}]});
    for path in [
        "/dev/outer/node_modules/./@types",
        "/dev/outer/node_modules/foo/../@types",
        "\\dev\\outer\\node_modules\\@types",
        "/dev/outer/node_modules/@types/",
    ] {
        for (operation, found) in [("read_file", false), ("directory_exists", true)] {
            let mut poison = good.clone();
            poison["compiler_probes"]
                .as_array_mut()
                .unwrap()
                .push(json!({"path":path,"operation":operation,"found":found,"content_id":null}));
            assert!(
                worker_frontend_capability(&poison, &request, true).is_err(),
                "aliased {operation} must remain visible: {path}"
            );
        }
        let mut equivalent = good.clone();
        equivalent["compiler_probes"][0]["path"] = json!(path);
        assert!(
            worker_frontend_capability(&equivalent, &request, true).is_ok(),
            "equivalent negative directory probe: {path}"
        );
        equivalent["frontendCapabilityObservation"]["workspaceIssues"][0]["path"] = json!(path);
        assert!(
            worker_frontend_capability(&equivalent, &request, true).is_ok(),
            "equivalent bound refusal: {path}"
        );
    }
    for path in [
        json!(null),
        json!(42),
        json!("relative/path"),
        json!("/../../escape"),
    ] {
        let mut poison = good.clone();
        poison["compiler_probes"].as_array_mut().unwrap().push(
            json!({"path":path,"operation":"directory_exists","found":false,"content_id":null}),
        );
        assert!(
            worker_frontend_capability(&poison, &request, true).is_err(),
            "malformed probe path"
        );
    }
}

#[test]
fn comparator_worker_case_insensitive_probe_aliases_cannot_hide_nonnegative_operations() {
    let request =
        json!({"repoRoot":"/dev/outer/workspace","rootAbsPaths":["/dev/outer/workspace/main.ts"]});
    let good = json!({"frontendCapabilityObservation":{"executed":true,"roots":[{"path":"/dev/outer/workspace/main.ts","loaded":true,"parseDiagnosticCodes":[]}],"unsupported":[],"workspaceIssues":[{"path":"/dev/outer/node_modules/@types","kind":"refusal","detail":"WORKSPACE_PATH_OUTSIDE_ROOT"}],"resolutionErrors":{}},"compiler_probes":[{"path":"","operation":"case_sensitive","found":false,"content_id":null},{"path":"/dev/outer/node_modules/@types","operation":"directory_exists","found":false,"content_id":null}]});
    assert!(worker_frontend_capability(&good, &request, false).is_ok());
    for (operation, found) in [("read_file", false), ("directory_exists", true)] {
        let mut poison = good.clone();
        poison["compiler_probes"].as_array_mut().unwrap().push(
            json!({"path":"/DEV/OUTER/node_modules/@types","operation":operation,"found":found,"content_id":null}),
        );
        assert!(
            worker_frontend_capability(&poison, &request, false).is_err(),
            "case-insensitive alias {operation} must remain visible"
        );
    }
    let mut equivalent = good.clone();
    equivalent["compiler_probes"][1]["path"] = json!("/DEV/OUTER/node_modules/part/../@TYPES");
    equivalent["frontendCapabilityObservation"]["workspaceIssues"][0]["path"] =
        json!("/Dev/Outer/node_modules/./@Types/");
    assert!(worker_frontend_capability(&equivalent, &request, false).is_ok());
    let mut mixed_case_root = request.clone();
    mixed_case_root["repoRoot"] = json!("/Dev/Outer/workspace");
    assert!(worker_frontend_capability(&equivalent, &mixed_case_root, false).is_ok());
    for sensitive in [false, true] {
        let mut native = good.clone();
        native["compiler_probes"][0]["found"] = json!(sensitive);
        assert!(worker_frontend_capability(&native, &request, sensitive).is_ok());
        assert!(worker_frontend_capability(&native, &request, !sensitive).is_err());
        let mut malformed = native.clone();
        malformed["compiler_probes"][0]["path"] = json!("/unrelated/capability");
        assert!(worker_frontend_capability(&malformed, &request, sensitive).is_err());
        let mut contradictory = native.clone();
        contradictory["compiler_probes"].as_array_mut().unwrap().push(
            json!({"path":"","operation":"case_sensitive","found":!sensitive,"content_id":null}),
        );
        assert!(worker_frontend_capability(&contradictory, &request, sensitive).is_err());
        let mut distinct = native.clone();
        distinct["compiler_probes"][1]["path"] = json!("/DEV/OUTER/node_modules/@types");
        assert_eq!(
            worker_frontend_capability(&distinct, &request, sensitive).is_ok(),
            !sensitive
        );
    }
    let drive_request = json!({"repoRoot":"C:/Dev/Outer/workspace","rootAbsPaths":["C:/Dev/Outer/workspace/main.ts"]});
    let mut drive = good.clone();
    drive["frontendCapabilityObservation"]["roots"][0]["path"] =
        drive_request["rootAbsPaths"][0].clone();
    drive["frontendCapabilityObservation"]["workspaceIssues"][0]["path"] =
        json!("C:/Dev/Outer/node_modules/@types");
    drive["compiler_probes"][1]["path"] = json!("c:\\DEV\\OUTER\\node_modules\\.\\@TYPES");
    assert!(worker_frontend_capability(&drive, &drive_request, false).is_ok());
    drive["compiler_probes"].as_array_mut().unwrap().push(
        json!({"path":"C:/DEV/OUTER/node_modules/part/../@types","operation":"read_file","found":false,"content_id":null}),
    );
    assert!(worker_frontend_capability(&drive, &drive_request, false).is_err());
}

#[test]
fn comparator_worker_case_metadata_is_checked_without_workspace_refusals() {
    let request =
        json!({"repoRoot":"/dev/outer/workspace","rootAbsPaths":["/dev/outer/workspace/main.ts"]});
    let good = json!({"frontendCapabilityObservation":{"executed":true,"roots":[{"path":"/dev/outer/workspace/main.ts","loaded":true,"parseDiagnosticCodes":[]}],"unsupported":[],"workspaceIssues":[],"resolutionErrors":{}},"compiler_probes":[{"path":"","operation":"case_sensitive","found":true,"content_id":null}]});
    assert!(worker_frontend_capability(&good, &request, true).is_ok());
    for (field, value) in [
        ("found", json!(false)),
        ("found", json!(null)),
        ("path", json!("/unrelated/capability")),
        ("content_id", json!("sha256:foreign")),
    ] {
        let mut malformed = good.clone();
        malformed["compiler_probes"][0][field] = value;
        assert!(worker_frontend_capability(&malformed, &request, true).is_err());
    }
    let mut contradictory = good.clone();
    contradictory["compiler_probes"]
        .as_array_mut()
        .unwrap()
        .push(json!({"path":"","operation":"case_sensitive","found":false,"content_id":null}));
    assert!(worker_frontend_capability(&contradictory, &request, true).is_err());
    for value in [json!(null), json!({})] {
        let mut malformed = good.clone();
        malformed["compiler_probes"] = value;
        assert!(worker_frontend_capability(&malformed, &request, true).is_err());
    }
}
