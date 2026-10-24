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
        for (collection, field) in [("imports", "resolvedRelPath"), ("calls", "calleeRelPath")] {
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
    descriptor["request"]["emitAbsPaths"] = json!([root.join("../outside-worker-development.ts")]);
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
