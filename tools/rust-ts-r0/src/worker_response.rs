use serde_json::{Value, json};
use std::{
    collections::BTreeSet,
    path::{Component, PathBuf},
};

fn refusal(error: &str) -> Value {
    json!({"valid":false,"accepted":false,"worker_failed":false,"error":error})
}

fn absolute_lexical(path: &str) -> Option<PathBuf> {
    let absolute = std::path::absolute(if path.is_empty() { "." } else { path }).ok()?;
    let mut resolved = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                resolved.pop();
            }
            _ => resolved.push(component.as_os_str()),
        }
    }
    Some(resolved)
}

fn same_native_component(left: &str, right: &str) -> bool {
    if cfg!(windows) {
        left.to_lowercase() == right.to_lowercase()
    } else {
        left == right
    }
}

fn emit_relative(root: &str, path: &str) -> Option<String> {
    let root = absolute_lexical(root)?;
    let target = absolute_lexical(path)?;
    let root = root
        .components()
        .map(|part| part.as_os_str().to_str().map(str::to_owned))
        .collect::<Option<Vec<_>>>()?;
    let target = target
        .components()
        .map(|part| part.as_os_str().to_str().map(str::to_owned))
        .collect::<Option<Vec<_>>>()?;
    let common = root
        .iter()
        .zip(&target)
        .take_while(|(left, right)| same_native_component(left, right))
        .count();
    let relative = if common == 0 {
        absolute_lexical(path)?.to_str()?.to_string()
    } else {
        std::iter::repeat_n("..".to_string(), root.len() - common)
            .chain(target[common..].iter().cloned())
            .collect::<Vec<_>>()
            .join("/")
    };
    let replaced = relative.replace('\\', "/");
    Some(replaced.strip_prefix("./").unwrap_or(&replaced).to_string())
}

fn in_repository(value: &Value) -> bool {
    let Some(path) = value.as_str() else {
        return false;
    };
    if path.is_empty()
        || path.contains('\\')
        || path.starts_with('/')
        || path == ".."
        || path.starts_with("../")
    {
        return false;
    }
    if path.as_bytes().first().is_some_and(u8::is_ascii_alphabetic)
        && path.as_bytes().get(1) == Some(&b':')
    {
        return false;
    }
    let mut parts = vec![];
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." if parts.last().is_some_and(|last| *last != "..") => {
                parts.pop();
            }
            _ => parts.push(part),
        }
    }
    let mut normalized = if parts.is_empty() {
        ".".to_string()
    } else {
        parts.join("/")
    };
    if path.ends_with('/') {
        normalized.push('/');
    }
    normalized == path
}

fn positive_integer(value: &Value) -> bool {
    value
        .as_f64()
        .is_some_and(|number| number >= 1.0 && number.fract() == 0.0)
}

fn strings(value: &Value) -> bool {
    value
        .as_array()
        .is_some_and(|items| items.iter().all(Value::is_string))
}

fn optional_string(value: &Value, key: &str) -> bool {
    value.get(key).is_none_or(Value::is_string)
}

fn optional_bool(value: &Value, key: &str) -> bool {
    value.get(key).is_none_or(Value::is_boolean)
}

fn owned(value: &Value, emit: &BTreeSet<String>) -> bool {
    value.as_str().is_some_and(|path| emit.contains(path))
}

fn marker(value: &Value) -> bool {
    value.is_object()
        && matches!(
            value["tag"].as_str(),
            Some("capability" | "invariant" | "contract" | "risk" | "boundedContext" | "tag")
        )
        && value["slug"].is_string()
        && optional_string(value, "statement")
}

fn symbol(value: &Value, emit: &BTreeSet<String>) -> bool {
    value.is_object()
        && value["name"].is_string()
        && matches!(
            value["kind"].as_str(),
            Some("function" | "class" | "interface" | "type" | "enum")
        )
        && owned(&value["relPath"], emit)
        && strings(&value["scope"])
        && positive_integer(&value["startLine"])
        && positive_integer(&value["endLine"])
        && value["endLine"].as_f64() >= value["startLine"].as_f64()
        && value["exported"].is_boolean()
        && optional_bool(value, "signatureOnly")
        && optional_string(value, "jsdoc")
        && value["markers"]
            .as_array()
            .is_some_and(|markers| markers.iter().all(marker))
}

fn binding_target(value: &Value) -> bool {
    value.is_object()
        && in_repository(&value["relPath"])
        && value["symbolPath"].is_string()
        && optional_bool(value, "runtimeUsed")
        && optional_string(value, "unmodeledReason")
}

fn import(value: &Value, emit: &BTreeSet<String>) -> bool {
    value.is_object()
        && owned(&value["fromRelPath"], emit)
        && value["moduleSpecifier"].is_string()
        && value.get("resolvedRelPath").is_none_or(in_repository)
        && strings(&value["names"])
        && value.get("bindingTargets").is_none_or(|targets| {
            targets
                .as_array()
                .is_some_and(|items| items.iter().all(binding_target))
        })
        && positive_integer(&value["line"])
}

fn call(value: &Value, emit: &BTreeSet<String>) -> bool {
    value.is_object()
        && owned(&value["callerRelPath"], emit)
        && optional_string(value, "callerSymbolPath")
        && value["calleeName"].is_string()
        && value.get("calleeRelPath").is_none_or(in_repository)
        && optional_string(value, "calleeSymbolPath")
        && optional_string(value, "calleeUnmodeledReason")
        && optional_string(value, "callerUnmodeledReason")
        && positive_integer(&value["line"])
}

pub fn consume(descriptor: &Value) -> Value {
    let Some(request) = super::parse_request(&descriptor["request"]) else {
        return refusal("malformed extraction request");
    };
    let response = &descriptor["response"];
    let malformed = "index worker returned a malformed extraction DTO";
    if !response.is_object()
        || response["schemaVersion"].as_f64() != Some(1.0)
        || response["jobId"].as_str() != Some(&request.job_id)
        || !response["ok"].is_boolean()
    {
        return refusal(malformed);
    }
    if response["ok"] == false {
        return if let Some(error) = response["error"].as_str() {
            json!({"valid":true,"accepted":false,"worker_failed":true,"error":format!("index worker failed: {error}")})
        } else {
            refusal(malformed)
        };
    }
    let extraction = &response["extraction"];
    if !extraction.is_object() {
        return refusal(malformed);
    }
    let Some(modules) = extraction["modules"].as_array() else {
        return refusal(malformed);
    };
    let Some(symbols) = extraction["symbols"].as_array() else {
        return refusal(malformed);
    };
    let Some(imports) = extraction["imports"].as_array() else {
        return refusal(malformed);
    };
    let Some(calls) = extraction["calls"].as_array() else {
        return refusal(malformed);
    };
    let Some(emit) = request
        .emit_abs_paths
        .iter()
        .map(|path| emit_relative(&request.repo_root, path))
        .collect::<Option<BTreeSet<_>>>()
    else {
        return refusal(malformed);
    };
    let unique = modules
        .iter()
        .filter_map(Value::as_str)
        .collect::<BTreeSet<_>>();
    if modules.len() != emit.len()
        || unique.len() != modules.len()
        || !modules.iter().all(|path| owned(path, &emit))
        || !symbols.iter().all(|value| symbol(value, &emit))
        || !imports.iter().all(|value| import(value, &emit))
        || !calls.iter().all(|value| call(value, &emit))
    {
        return refusal(malformed);
    }
    json!({"valid":true,"accepted":true,"worker_failed":false,"extraction":extraction})
}

#[cfg(test)]
#[path = "../tests/unit/worker_response.rs"]
mod tests;
