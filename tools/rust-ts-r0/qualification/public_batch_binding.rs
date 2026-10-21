//! Consumer-only batch identity admission. Independent DTO encodings mirror
//! C1 batch::{input,capture,snapshot,scope}_manifest; no expected output is read.
use super::*;

fn captured_configuration_exists(
    request: &Value,
    sdk: &Value,
    key: &str,
    sensitive: bool,
) -> Result<bool, String> {
    let mut known = false;
    for files in [&request["files"], &sdk["files"]] {
        for candidate in files.as_object().ok_or("batch input files absent")?.keys() {
            let matches = verifier_absolute_key(candidate, sensitive)? == key;
            known |= matches;
        }
    }
    Ok(known)
}

fn validate_input_probe(probe: &Value, request: &Value, sdk: &Value) -> Result<(), String> {
    if probe["context"] != "captured-filesystem" || !probe["found"].is_boolean() {
        return Err("batch read inventory has a foreign capture context".into());
    }
    let sensitive = request["case_sensitive"]
        .as_bool()
        .ok_or("batch request case mode absent")?;
    let operation = value_text(probe, "operation")?;
    let path = value_text(probe, "path")?;
    match operation {
        "captured_cwd" => {
            if probe["found"] != true
                || !probe["content_id"].is_null()
                || verifier_absolute_key(path, sensitive)?
                    != verifier_absolute_key(value_text(request, "cwd")?, sensitive)?
            {
                return Err("batch captured cwd differs from exact request".into());
            }
        }
        "case_sensitive" => {
            if !path.is_empty()
                || probe["found"] != json!(sensitive)
                || !probe["content_id"].is_null()
            {
                return Err("batch case probe differs from exact request".into());
            }
        }
        "configuration_discovery_file_exists" => {
            let key = verifier_absolute_key(path, sensitive)?;
            if !probe["content_id"].is_null() {
                return Err("configuration existence probe claims content bytes".into());
            }
            if probe["found"] == true
                && !captured_configuration_exists(request, sdk, &key, sensitive)?
            {
                return Err("positive configuration probe has no captured file".into());
            }
        }
        "read_file" | "file_exists" | "directory_exists" | "directory_entries" | "realpath"
        | "stat" => {}
        _ => return Err("batch read inventory has a foreign capture operation".into()),
    }
    Ok(())
}

pub(super) fn validate_batch(
    batch: &Value,
    request: &Value,
    sdk: &Value,
    artifact_sha: &str,
) -> Result<Value, String> {
    // Validate the whole advertised wire shape before evaluating any positive.
    let _: semctx_r0_probe::wire::Batch = serde_json::from_value(batch.clone())
        .map_err(|e| format!("invalid actual batch wire schema: {e}"))?;
    let input = verifier_logical_input(request, sdk)?;
    let capture = json!({"domain":"T00-logical-capture-v2","repository_root":"T00_REPOSITORY_ROOT","case_sensitive":request["case_sensitive"],"project":input["project"]});
    let input_id = identity::digest(&input);
    let capture_id = identity::digest(&capture);
    let snapshot = json!({"domain":"T00-captured-snapshot-v2","input_manifest_id":input_id,"capture_id":capture_id});
    let sensitive = request["case_sensitive"]
        .as_bool()
        .ok_or("batch request case mode absent")?;
    let cwd = value_text(request, "cwd")?;
    let mut subjects = serde_json::Map::new();
    for path in request["roots"]
        .as_array()
        .ok_or("batch request roots absent")?
    {
        let path = path.as_str().ok_or("non-text batch root")?;
        if [".d.ts", ".d.mts", ".d.cts"]
            .iter()
            .any(|suffix| path.ends_with(suffix))
        {
            continue;
        }
        let (_, location) = verifier_location(cwd, path, sensitive, "repository")?;
        if location["domain"] != "repository" {
            return Err("batch root outside repository".into());
        }
        let relative = value_text(&location, "path")?;
        let role = request["roles"]
            .get(relative)
            .cloned()
            .unwrap_or(json!("source"));
        let selection = request["selection"]
            .get(relative)
            .cloned()
            .unwrap_or(json!("selected"));
        subjects.insert(relative.into(), json!({"role":role,"selection":selection}));
    }
    let profile = if request["qualified"] == true {
        "modelo-suite-static-v1"
    } else {
        "ordinary"
    };
    let mut scope = json!({"profile":profile,"repository_root":request["cwd"],"sdk_directory":request["sdk_directory"],"retained":request["retained"],"effective_options":request["options"],"subjects":subjects});
    if request["disabled"]
        .as_array()
        .is_some_and(|v| !v.is_empty())
    {
        scope["disabled"] = request["disabled"].clone();
    }
    if batch["schema_version"] != 1
        || batch["case_id"] != request["id"]
        || batch["request_id"] != request["id"]
        || batch["producer_artifact_id"]
            != format!("sha256:{}", artifact_sha.trim_start_matches("sha256:"))
        || batch["input_manifest_id"] != input_id
        || batch["capture_id"] != capture_id
        || batch["snapshot_id"] != identity::digest(&snapshot)
        || batch["scope_id"] != identity::digest(&scope)
        || batch["profile"] != profile
        || batch["complete"] != true
    {
        return Err(
            "batch request/input/capture/snapshot/scope/profile/artifact binding mismatch".into(),
        );
    }
    let facts = batch["facts"].as_array().ok_or("batch facts absent")?;
    let nodes = facts
        .iter()
        .filter(|f| f["record"] == "node")
        .map(|f| f["payload"].clone())
        .collect::<Vec<_>>();
    let edges = facts
        .iter()
        .filter(|f| f["record"] == "edge")
        .map(|f| f["payload"].clone())
        .collect::<Vec<_>>();
    if batch["facts_id"] != identity::digest(&json!(facts))
        || batch["graph_id"] != identity::digest(&json!({"nodes":nodes,"edges":edges}))
    {
        return Err("batch actual facts/graph digest mismatch".into());
    }
    let reports = batch["subjects"]
        .as_array()
        .ok_or("batch subjects absent")?;
    let ids = reports
        .iter()
        .map(|r| r["subject_id"].as_str().ok_or("batch subject id absent"))
        .collect::<Result<BTreeSet<_>, _>>()?;
    if ids.len() != reports.len()
        || ids != subjects.keys().map(String::as_str).collect::<BTreeSet<_>>()
    {
        return Err("batch subject denominator differs from request".into());
    }
    let diagnostics = batch["diagnostics"]
        .as_array()
        .ok_or("batch diagnostic inventory absent")?;
    if diagnostics
        .iter()
        .any(|d| !ids.contains(d["subject_id"].as_str().unwrap_or("")))
    {
        return Err("batch diagnostic refers to a foreign subject".into());
    }
    let expected_kinds = receiver_context::KINDS
        .iter()
        .copied()
        .collect::<BTreeSet<_>>();
    for report in reports {
        let id = value_text(report, "subject_id")?;
        let wanted = subjects.get(id).ok_or("foreign batch subject")?;
        if report["selection"] != wanted["selection"] {
            return Err("batch subject selection contradicts requested selection".into());
        }
        let coverage = report["coverage"]
            .as_array()
            .ok_or("batch subject coverage absent")?;
        if wanted["selection"] == "excluded" {
            if !report["outcome"].is_null() || !coverage.is_empty() {
                return Err("excluded subject claims an executed outcome/coverage".into());
            }
        } else if report["outcome"] == "analyzed" {
            let kinds = coverage
                .iter()
                .map(|c| value_text(c, "fact_kind"))
                .collect::<Result<BTreeSet<_>, _>>()?;
            if coverage.len() != kinds.len()
                || kinds != expected_kinds
                || coverage.iter().any(|c| {
                    c["complete"] != true
                        || c["negative_evidence_eligible"]
                            != json!(request["qualified"] == true && request["retained"] == true)
                })
            {
                return Err(
                    "analyzed batch subject coverage/proof shape differs from requested profile"
                        .into(),
                );
            }
            let expected_module = if wanted["role"] == "test" {
                "test"
            } else if wanted["role"] == "source" {
                "module"
            } else {
                return Err("unsupported requested batch role".into());
            };
            if facts
                .iter()
                .filter(|f| {
                    f["record"] == "node"
                        && f["subject_id"] == id
                        && f["payload"]["filePath"] == id
                        && f["payload"]["kind"] == expected_module
                })
                .count()
                != 1
            {
                return Err(
                    "analyzed subject has no unique actual node for its requested role".into(),
                );
            }
        } else {
            if !["failed", "unsupported", "unknown", "disabled"]
                .contains(&report["outcome"].as_str().unwrap_or(""))
                || !coverage.is_empty()
                || !diagnostics.iter().any(|d| d["subject_id"] == id)
            {
                return Err("controlled subject refusal has no outcome/diagnostic proof".into());
            }
        }
    }
    // InputObservation uses the same operation/path/found/content_id fields as
    // raw capture_probes. Adapt only the envelope and reuse the normative byte
    // join over every reported read; never claim all supplied SDK was consumed.
    let probes = batch["input_observations"]
        .as_array()
        .ok_or("batch read inventory absent")?;
    for probe in probes {
        validate_input_probe(probe, request, sdk)?;
    }
    let joined_reads = join_successful_reads(&json!({"capture_probes":probes}), request, sdk)?;
    let refused = reports
        .iter()
        .any(|r| r["selection"] == "selected" && r["outcome"] != "analyzed");
    let terminal = if refused { "refused" } else { "complete" };
    if batch["terminal"] != terminal {
        return Err("batch terminal contradicts actual selected subject outcomes".into());
    }
    Ok(
        json!({"state":if refused{"BOUND_CONTROLLED_REFUSAL"}else{"BOUND_COMPLETE_INDEX_BATCH"},"terminal":terminal,
        "admissible_index_store":!refused,"input_manifest_id":input_id,"capture_id":capture_id,"snapshot_id":identity::digest(&snapshot),"scope_id":identity::digest(&scope),
        "batch_id":identity::digest(batch),"reported_reads":joined_reads}),
    )
}

#[cfg(test)]
mod comparator_tests {
    use super::*;
    fn inputs() -> (Value, Value) {
        (
            json!({"id":"synthetic","cwd":"/w","sdk_directory":"/sdk","case_sensitive":true,"roots":["/w/a.ts"],"files":{"/w/a.ts":"export const a=1"},"utf16_files":{},"raw_files":{},"options":{},"roles":{},"selection":{},"disabled":[],"retained":true,"qualified":false}),
            json!({"version":"synthetic","archive_sha256":"synthetic","files":{"/sdk/lib.d.ts":""}}),
        )
    }
    fn batch(request: &Value, sdk: &Value) -> Value {
        let input = verifier_logical_input(request, sdk).unwrap();
        let input_id = identity::digest(&input);
        let capture = json!({"domain":"T00-logical-capture-v2","repository_root":"T00_REPOSITORY_ROOT","case_sensitive":true,"project":input["project"]});
        let capture_id = identity::digest(&capture);
        let snapshot = json!({"domain":"T00-captured-snapshot-v2","input_manifest_id":input_id,"capture_id":capture_id});
        let scope = json!({"profile":"ordinary","repository_root":"/w","sdk_directory":"/sdk","retained":true,"effective_options":{},"subjects":{"a.ts":{"role":"source","selection":"selected"}}});
        let payload = json!({"id":"mod:a.ts","kind":"module","name":"a.ts","filePath":"a.ts","tags":[],"metadata":{},"evidence":[]});
        let facts = json!([{"record":"node","id":"mod:a.ts","subject_id":"a.ts","fact_kind":"node:module","path":"a.ts","range":null,"payload":payload}]);
        let coverage = receiver_context::KINDS
            .iter()
            .map(
                |kind| json!({"fact_kind":kind,"complete":true,"negative_evidence_eligible":false}),
            )
            .collect::<Vec<_>>();
        json!({"schema_version":1,"case_id":"synthetic","request_id":"synthetic","producer_artifact_id":"sha256:artifact","input_manifest_id":input_id,"capture_id":capture_id,"snapshot_id":identity::digest(&snapshot),"scope_id":identity::digest(&scope),"profile":"ordinary","complete":true,"terminal":"complete","subjects":[{"subject_id":"a.ts","selection":"selected","outcome":"analyzed","coverage":coverage}],"facts":facts,"facts_id":identity::digest(&facts),"graph_id":identity::digest(&json!({"nodes":[payload],"edges":[]})),"diagnostics":[],"input_observations":[{"context":"captured-filesystem","operation":"read_file","path":"/w/a.ts","found":true,"content_id":identity::digest_bytes(request["files"]["/w/a.ts"].as_str().unwrap().as_bytes())}]})
    }
    #[test]
    fn swapped_input_manifest_is_foreign() {
        let (req, sdk) = inputs();
        let mut batch = batch(&req, &sdk);
        assert!(validate_batch(&batch, &req, &sdk, "artifact").is_ok());
        batch["input_manifest_id"] = json!("sha256:other");
        assert!(validate_batch(&batch, &req, &sdk, "artifact").is_err());
    }
    #[test]
    fn complete_transport_with_refused_terminal_is_not_an_index_success() {
        let (req, sdk) = inputs();
        let mut batch = batch(&req, &sdk);
        batch["terminal"] = json!("refused");
        batch["subjects"][0]["outcome"] = json!("unsupported");
        batch["subjects"][0]["coverage"] = json!([]);
        batch["diagnostics"] = json!([{"subject_id":"a.ts","code":"UNSUPPORTED_SYNTHETIC","message":"UNSUPPORTED_SYNTHETIC"}]);
        let receipt = validate_batch(&batch, &req, &sdk, "artifact").unwrap();
        assert_eq!(receipt["state"], "BOUND_CONTROLLED_REFUSAL");
        assert_eq!(receipt["admissible_index_store"], false);
        batch["terminal"] = json!("complete");
        assert!(validate_batch(&batch, &req, &sdk, "artifact").is_err());
    }
    #[test]
    fn selected_subject_cannot_be_relabelled_excluded() {
        let (req, sdk) = inputs();
        let mut batch = batch(&req, &sdk);
        batch["subjects"][0]["selection"] = json!("excluded");
        batch["subjects"][0]["outcome"] = Value::Null;
        assert!(validate_batch(&batch, &req, &sdk, "artifact").is_err());
    }
    #[test]
    fn advertised_correct_ids_do_not_admit_a_foreign_successful_read() {
        let (req, sdk) = inputs();
        let mut batch = batch(&req, &sdk);
        assert!(validate_batch(&batch, &req, &sdk, "artifact").is_ok());
        batch["input_observations"][0]["content_id"] = json!("sha256:foreign");
        assert!(validate_batch(&batch, &req, &sdk, "artifact").is_err());
    }
}

#[cfg(test)]
mod capture_probe_tests {
    use super::*;
    #[test]
    fn comparator_batch_native_context_probes_require_exact_request_values() {
        let request =
            json!({"cwd":"/dev","case_sensitive":false,"files":{"/dev/config.json":"{}"}});
        let sdk = json!({"files":{"/sdk/lib/lib.d.ts":"declare const x:number;"}});
        let probes = [
            json!({"context":"captured-filesystem","operation":"captured_cwd","path":"/dev","found":true,"content_id":null}),
            json!({"context":"captured-filesystem","operation":"case_sensitive","path":"","found":false,"content_id":null}),
            json!({"context":"captured-filesystem","operation":"configuration_discovery_file_exists","path":"/dev/config.json","found":true,"content_id":null}),
            json!({"context":"captured-filesystem","operation":"configuration_discovery_file_exists","path":"/missing/config.json","found":false,"content_id":null}),
        ];
        for probe in &probes {
            assert!(validate_input_probe(probe, &request, &sdk).is_ok());
            let mut poison = probe.clone();
            poison["context"] = json!("foreign");
            assert!(validate_input_probe(&poison, &request, &sdk).is_err());
        }
        for (index, field, value) in [
            (0, "path", json!("/foreign")),
            (0, "found", json!(false)),
            (1, "found", json!(true)),
            (1, "path", json!("/dev")),
            (2, "path", json!("/foreign/config.json")),
            (3, "content_id", json!("sha256:foreign")),
        ] {
            let mut poison = probes[index].clone();
            poison[field] = value;
            assert!(
                validate_input_probe(&poison, &request, &sdk).is_err(),
                "{index}:{field}"
            );
        }
    }
}
