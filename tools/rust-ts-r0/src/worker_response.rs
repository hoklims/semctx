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
mod tests {
    use super::*;

    fn descriptor() -> Value {
        let root = std::env::temp_dir().join("semctx-r0-worker-schema-development-root");
        json!({
            "request":{"schemaVersion":1,"jobId":"worker-consumer-development","repoRoot":root,"rootAbsPaths":[root.join("worker-development.ts")],"emitAbsPaths":[root.join("worker-development.ts")]},
            "response":{"schemaVersion":1,"jobId":"worker-consumer-development","ok":true,"extraction":{
                "modules":["worker-development.ts"],
                "symbols":[{"name":"workerSchemaDevelopment","kind":"function","relPath":"worker-development.ts","scope":[],"startLine":1,"endLine":2,"exported":true,"markers":[{"tag":"contract","slug":"worker-schema-development"}]}],
                "imports":[{"fromRelPath":"worker-development.ts","moduleSpecifier":"./dependency","names":["invokeDevelopment"],"resolvedRelPath":"dependency.ts","bindingTargets":[{"relPath":"dependency.ts","symbolPath":"invokeDevelopment","runtimeUsed":true}],"line":1}],
                "calls":[{"callerRelPath":"worker-development.ts","calleeName":"invokeDevelopment","calleeRelPath":"dependency.ts","calleeSymbolPath":"invokeDevelopment","line":2}]
            }}
        })
    }

    #[test]
    fn worker_response_consumer_returns_exact_valid_raw_extraction() {
        let descriptor = descriptor();
        let observed = consume(&descriptor);
        assert_eq!(observed["valid"], true);
        assert_eq!(observed["accepted"], true);
        assert_eq!(observed["worker_failed"], false);
        assert_eq!(observed["extraction"], descriptor["response"]["extraction"]);
    }

    #[test]
    fn worker_response_consumer_refuses_forged_ownership_shapes_and_optional_nulls() {
        for (pointer, value) in [
            ("/schemaVersion", json!(2)),
            ("/jobId", json!("foreign-job")),
            ("/ok", json!("true")),
            ("/extraction/modules", json!([])),
            (
                "/extraction/modules",
                json!(["worker-development.ts", "worker-development.ts"]),
            ),
            ("/extraction/modules", json!(["foreign.ts"])),
            ("/extraction/symbols/0/relPath", json!("foreign.ts")),
            ("/extraction/symbols/0/name", Value::Null),
            ("/extraction/symbols/0/kind", json!("variable")),
            ("/extraction/symbols/0/scope", json!([1])),
            ("/extraction/symbols/0/startLine", json!(0)),
            ("/extraction/symbols/0/endLine", json!(0)),
            ("/extraction/symbols/0/exported", Value::Null),
            ("/extraction/symbols/0/markers/0/tag", json!("unknown")),
            ("/extraction/symbols/0/markers/0/slug", json!(3)),
            ("/extraction/imports/0/fromRelPath", json!("foreign.ts")),
            ("/extraction/imports/0/moduleSpecifier", Value::Null),
            ("/extraction/imports/0/names", json!([true])),
            ("/extraction/imports/0/bindingTargets", Value::Null),
            (
                "/extraction/imports/0/bindingTargets/0/relPath",
                json!("../outside.ts"),
            ),
            (
                "/extraction/imports/0/bindingTargets/0/symbolPath",
                Value::Null,
            ),
            (
                "/extraction/imports/0/bindingTargets/0/runtimeUsed",
                json!(1),
            ),
            ("/extraction/imports/0/line", json!(1.5)),
            ("/extraction/calls/0/callerRelPath", json!("foreign.ts")),
            ("/extraction/calls/0/calleeName", Value::Null),
            ("/extraction/calls/0/line", json!(-1)),
        ] {
            let mut descriptor = descriptor();
            *descriptor["response"].pointer_mut(pointer).unwrap() = value;
            let observed = consume(&descriptor);
            assert_eq!(observed["valid"], false, "{pointer}: {observed}");
            assert_eq!(observed["accepted"], false, "{pointer}");
            assert!(observed.get("extraction").is_none(), "{pointer}");
        }
        for (collection, field) in [
            ("symbols", "signatureOnly"),
            ("symbols", "jsdoc"),
            ("calls", "callerSymbolPath"),
            ("calls", "calleeSymbolPath"),
            ("calls", "calleeUnmodeledReason"),
            ("calls", "callerUnmodeledReason"),
        ] {
            let mut descriptor = descriptor();
            descriptor["response"]["extraction"][collection][0][field] = Value::Null;
            assert_eq!(consume(&descriptor)["valid"], false, "{field}");
        }
        for target in [
            "",
            "..",
            "../outside.ts",
            "/absolute.ts",
            "C:drive.ts",
            "part\\child.ts",
            "part//child.ts",
            "part/../child.ts",
            "./child.ts",
        ] {
            for (collection, field) in [("imports", "resolvedRelPath"), ("calls", "calleeRelPath")]
            {
                let mut descriptor = descriptor();
                descriptor["response"]["extraction"][collection][0][field] = json!(target);
                assert_eq!(consume(&descriptor)["valid"], false, "{field}:{target}");
            }
        }
    }

    #[test]
    fn worker_response_consumer_distinguishes_well_formed_worker_failure_from_acceptance() {
        let mut descriptor = descriptor();
        descriptor["response"] = json!({"schemaVersion":1,"jobId":"worker-consumer-development","ok":false,"error":"development worker failed","extraction":null});
        let observed = consume(&descriptor);
        assert_eq!(observed["valid"], true);
        assert_eq!(observed["accepted"], false);
        assert_eq!(observed["worker_failed"], true);
        assert_eq!(
            observed["error"],
            "index worker failed: development worker failed"
        );
        descriptor["response"]["error"] = Value::Null;
        assert_eq!(consume(&descriptor)["valid"], false);
    }

    #[test]
    fn worker_response_consumer_preserves_baseline_extras_empty_emit_and_canonical_dot_paths() {
        let mut descriptor = descriptor();
        descriptor["response"]["schemaVersion"] = json!(1.0);
        descriptor["response"]["extraction"]["symbols"][0]["startLine"] = json!(1.0);
        descriptor["response"]["extraction"]["symbols"][0]["startUtf16"] =
            json!("extra is ignored by this historical schema");
        descriptor["response"]["extraction"]["symbols"][0]["signatureOnly"] = json!(false);
        descriptor["response"]["extraction"]["symbols"][0]["jsdoc"] = json!("");
        descriptor["response"]["extra"] = Value::Null;
        assert_eq!(consume(&descriptor)["accepted"], true);
        for target in [".", "./", "folder/", "dependency.ts"] {
            descriptor["response"]["extraction"]["imports"][0]["resolvedRelPath"] = json!(target);
            descriptor["response"]["extraction"]["imports"][0]["bindingTargets"][0]["relPath"] =
                json!(target);
            descriptor["response"]["extraction"]["calls"][0]["calleeRelPath"] = json!(target);
            assert_eq!(consume(&descriptor)["accepted"], true, "{target}");
        }
        for tag in [
            "capability",
            "invariant",
            "contract",
            "risk",
            "boundedContext",
            "tag",
        ] {
            descriptor["response"]["extraction"]["symbols"][0]["markers"][0]["tag"] = json!(tag);
            assert_eq!(consume(&descriptor)["accepted"], true, "{tag}");
        }
        let emit = descriptor["request"]["emitAbsPaths"][0].clone();
        descriptor["request"]["emitAbsPaths"] = json!([emit, emit]);
        assert_eq!(consume(&descriptor)["accepted"], true);
        descriptor["request"]["emitAbsPaths"] = json!([]);
        descriptor["response"]["extraction"] =
            json!({"modules":[],"symbols":[],"imports":[],"calls":[]});
        assert_eq!(consume(&descriptor)["accepted"], true);
        assert_eq!(consume(&Value::Null)["valid"], false);
    }

    #[test]
    fn worker_response_consumer_refuses_missing_arrays_and_optional_marker_target_fields() {
        for collection in ["modules", "symbols", "imports", "calls"] {
            let mut descriptor = descriptor();
            descriptor["response"]["extraction"]
                .as_object_mut()
                .unwrap()
                .remove(collection);
            assert_eq!(consume(&descriptor)["valid"], false, "{collection}");
        }
        let mut descriptor = descriptor();
        descriptor["response"]["extraction"]["symbols"][0]["markers"][0]["statement"] = Value::Null;
        assert_eq!(consume(&descriptor)["valid"], false);
        descriptor["response"]["extraction"]["symbols"][0]["markers"][0]["statement"] = json!("");
        assert_eq!(consume(&descriptor)["valid"], true);
        descriptor["response"]["extraction"]["imports"][0]["bindingTargets"][0]["unmodeledReason"] =
            Value::Null;
        assert_eq!(consume(&descriptor)["valid"], false);
    }

    #[test]
    fn worker_response_consumer_uses_lexical_emit_identity_without_repository_reads() {
        let mut descriptor = descriptor();
        let root = std::env::temp_dir().join("semctx-r0-worker-schema-development-root");
        descriptor["request"]["emitAbsPaths"] =
            json!([root.join("not-existing/../worker-development.ts")]);
        assert_eq!(consume(&descriptor)["accepted"], true);
        descriptor["request"]["emitAbsPaths"] =
            json!([root.join("../outside-worker-development.ts")]);
        descriptor["response"]["extraction"] = json!({"modules":["../outside-worker-development.ts"],"symbols":[],"imports":[],"calls":[]});
        assert_eq!(consume(&descriptor)["accepted"], true);
    }

    #[test]
    fn worker_response_consumer_resolves_relative_job_paths_from_native_cwd() {
        let mut descriptor = descriptor();
        descriptor["request"]["repoRoot"] = json!("");
        descriptor["request"]["rootAbsPaths"] = json!(["worker-development.ts"]);
        descriptor["request"]["emitAbsPaths"] = json!(["unused/../worker-development.ts"]);
        assert_eq!(consume(&descriptor)["accepted"], true);
    }
}
