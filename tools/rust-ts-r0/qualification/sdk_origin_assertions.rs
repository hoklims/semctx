//! Comparator-only projection. It consumes bound public DTOs, never calls the producer.
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

fn text<'a>(v: &'a Value, key: &str) -> Result<&'a str, String> {
    v.get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("sdk-origin missing string {key}"))
}
fn rows<'a>(v: &'a Value, key: &str) -> Result<&'a Vec<Value>, String> {
    v.get(key)
        .and_then(Value::as_array)
        .ok_or_else(|| format!("sdk-origin missing array {key}"))
}
fn coordinate(v: &Value, key: &str) -> Result<u64, String> {
    v.get(key)
        .and_then(Value::as_u64)
        .ok_or_else(|| format!("sdk-origin invalid UTF16 {key}"))
}
fn span(v: &Value) -> Result<(u64, u64), String> {
    let start = coordinate(v, "start_utf16")?;
    let end = coordinate(v, "end_utf16")?;
    if start > end {
        return Err("sdk-origin reversed UTF16 span".into());
    }
    Ok((start, end))
}
fn content_id(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}
fn path(value: &str) -> Result<String, String> {
    let p = value.replace('\\', "/");
    if p.split('/').any(|s| s == "." || s == "..") {
        return Err("sdk-origin noncanonical path".into());
    }
    Ok(p)
}
fn sort(values: &mut [Value]) {
    values.sort_by_cached_key(Value::to_string);
}

/// Called only after observation_bound_to_request succeeds. The added value belongs to the
/// comparator evaluation context, not the native response or a claimed compiler read.
pub fn project(observed: &Value, request: &Value, sdk: &Value) -> Result<Value, String> {
    let cwd = path(text(request, "cwd")?)?;
    let prefix = format!("{}/", cwd.trim_end_matches('/'));
    let mut known = BTreeMap::new();
    let mut supplied_sdk = 0;
    for (source, is_sdk) in [(request, false), (sdk, true)] {
        for (physical, value) in source
            .get("files")
            .and_then(Value::as_object)
            .ok_or("sdk-origin missing file map")?
        {
            let physical = path(physical)?;
            let body = value.as_str().ok_or("sdk-origin nontext input")?;
            let logical = if is_sdk {
                supplied_sdk += 1;
                let name = physical
                    .strip_prefix("/sdk/lib/")
                    .ok_or("sdk-origin SDK outside /sdk/lib")?;
                if name.is_empty() || name.contains('/') {
                    return Err("sdk-origin SDK path not direct library".into());
                }
                physical.clone()
            } else {
                let relative = physical
                    .strip_prefix(&prefix)
                    .ok_or("sdk-origin project outside bound cwd")?;
                if relative.is_empty() {
                    return Err("sdk-origin empty project file".into());
                }
                format!("/project/{relative}")
            };
            if known
                .insert(
                    physical,
                    (logical, content_id(body.as_bytes()), body.len(), is_sdk),
                )
                .is_some()
            {
                return Err("sdk-origin duplicate captured path".into());
            }
        }
    }
    let mut successful = BTreeMap::new();
    for probe in rows(observed, "capture_probes")? {
        if text(probe, "operation")? == "read_file"
            && probe.get("found") == Some(&Value::Bool(true))
        {
            let physical = path(text(probe, "path")?)?;
            let captured = known
                .get(&physical)
                .ok_or("sdk-origin read outside captured input")?;
            if text(probe, "content_id")? != captured.1 {
                return Err("sdk-origin SDK/source read hash mismatch".into());
            }
            successful.insert(physical, captured);
        } else if probe.get("content_id").is_some_and(|v| !v.is_null()) {
            return Err("sdk-origin content identity on nonread".into());
        }
    }
    let resolve = |physical: &str| -> Result<(&str, &str), String> {
        let physical = path(physical)?;
        let value = successful
            .get(&physical)
            .ok_or("sdk-origin declaration/call file has no successful read")?;
        Ok((&value.0, &value.1))
    };
    let mut calls = Vec::new();
    for call in rows(observed, "calls")? {
        let (file, _) = resolve(text(call, "file")?)?;
        let (start, end) = span(call)?;
        let symbol = call
            .get("symbol_name")
            .filter(|v| v.is_string() || v.is_null())
            .ok_or("sdk-origin malformed symbol_name")?;
        let mut declarations = Vec::new();
        for declaration in rows(call, "declarations")? {
            let (file, id) = resolve(text(declaration, "file")?)?;
            let (start, end) = span(declaration)?;
            let default_library = declaration
                .get("default_library")
                .and_then(Value::as_bool)
                .ok_or("sdk-origin malformed default_library")?;
            declarations.push(json!({"file":file,"start_utf16":start,"end_utf16":end,"default_library":default_library,"source_content_id":id}));
        }
        sort(&mut declarations);
        calls.push(json!({"file":file,"start_utf16":start,"end_utf16":end,"callee_text":text(call,"callee_text")?,"symbol_name":symbol,"declarations":declarations}));
    }
    sort(&mut calls);
    let mut sdk_reads = successful
        .values()
        .filter(|v| v.3)
        .map(|v| json!({"file":v.0,"content_id":v.1,"size_bytes":v.2}))
        .collect::<Vec<_>>();
    sort(&mut sdk_reads);
    Ok(
        json!({"calls":calls,"sdk_supplied_count":supplied_sdk,"sdk_consumed_count":sdk_reads.len(),"sdk_reads":sdk_reads}),
    )
}
