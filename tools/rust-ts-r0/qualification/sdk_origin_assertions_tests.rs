//! Bounded comparator tests fed only by the fresh TS oracle DTO adapter, never native outputs.
use crate::sdk_origin_assertions::project;
use serde_json::{Value, json};

fn bundle() -> Value {
    serde_json::from_slice(
        &std::fs::read(
            std::env::var("SDK_ORIGIN_TEST_BUNDLE")
                .expect("set SDK_ORIGIN_TEST_BUNDLE to fresh TS-derived comparator evidence"),
        )
        .unwrap(),
    )
    .unwrap()
}
fn rejects(observed: &Value, unit: &Value, sdk: &Value) -> bool {
    project(observed, &unit["request"], sdk).map_or(true, |actual| actual != unit["expected"])
}

#[test]
fn ts5_all_twelve_complete_call_and_read_projections_match() {
    let data = bundle();
    let units = data["units"].as_array().unwrap();
    assert_eq!(units.len(), 12);
    for unit in units {
        assert_eq!(
            project(&unit["observed"], &unit["request"], &data["sdk"]).unwrap(),
            unit["expected"],
            "{}",
            unit["unit_id"]
        );
        assert_eq!(unit["expected"]["sdk_supplied_count"], 100);
        assert_eq!(unit["expected"]["sdk_consumed_count"], 63);
    }
}

#[test]
fn property_access_dto_requires_ast_leaf_while_raw_full_expression_is_preserved() {
    let data = bundle();
    for unit in data["units"].as_array().unwrap() {
        let raw = &unit["raw_callee_observations"][0];
        assert_eq!(raw["dto"]["syntax_kind"], "PropertyAccessExpression");
        assert_eq!(raw["dto"]["rule"], "PropertyAccessExpression.name.text");
        assert_eq!(
            unit["observed"]["calls"][0]["callee_text"],
            raw["dto"]["text"]
        );
        assert_ne!(raw["full_ts_expression"], raw["dto"]["text"]);
        let mut full_expression = unit["observed"].clone();
        full_expression["calls"][0]["callee_text"] = raw["full_ts_expression"].clone();
        assert!(
            rejects(&full_expression, unit, &data["sdk"]),
            "full expression incorrectly accepted as leaf DTO: {}",
            unit["unit_id"]
        );
    }
}

#[test]
fn inverted_default_library_is_mismatch_on_each_existing_unit() {
    let data = bundle();
    for unit in data["units"].as_array().unwrap() {
        let mut poison = unit["observed"].clone();
        let value = poison["calls"][0]["declarations"][0]["default_library"]
            .as_bool()
            .unwrap();
        poison["calls"][0]["declarations"][0]["default_library"] = json!(!value);
        assert!(
            rejects(&poison, unit, &data["sdk"]),
            "default_library inversion accepted: {}",
            unit["unit_id"]
        );
    }
}

#[test]
fn shifted_get_start_utf16_is_mismatch_on_each_existing_unit() {
    let data = bundle();
    for unit in data["units"].as_array().unwrap() {
        for field in ["start_utf16", "end_utf16"] {
            let mut poison = unit["observed"].clone();
            let offset = poison["calls"][0]["declarations"][0][field]
                .as_u64()
                .unwrap();
            poison["calls"][0]["declarations"][0][field] = json!(offset + 1);
            assert!(
                rejects(&poison, unit, &data["sdk"]),
                "shift {field} accepted: {}",
                unit["unit_id"]
            );
        }
    }
}

#[test]
fn forged_sdk_read_hash_is_explicitly_rejected_on_each_existing_unit() {
    let data = bundle();
    for unit in data["units"].as_array().unwrap() {
        let mut poison = unit["observed"].clone();
        let probe = poison["capture_probes"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|p| p["path"].as_str().unwrap().starts_with("/sdk/lib/"))
            .unwrap();
        probe["content_id"] = json!(format!("sha256:{}", "0".repeat(64)));
        let error = project(&poison, &unit["request"], &data["sdk"]).unwrap_err();
        assert!(
            error.contains("read hash mismatch"),
            "wrong defect: {error}"
        );
    }
}

#[test]
fn unread_declaration_is_explicitly_rejected_on_each_existing_unit() {
    let data = bundle();
    for unit in data["units"].as_array().unwrap() {
        let mut poison = unit["observed"].clone();
        let file = poison["calls"][0]["declarations"][0]["file"].clone();
        poison["capture_probes"]
            .as_array_mut()
            .unwrap()
            .retain(|p| p["path"] != file);
        let error = project(&poison, &unit["request"], &data["sdk"]).unwrap_err();
        assert!(
            error.contains("no successful read"),
            "wrong defect: {error}"
        );
    }
}

#[test]
fn missing_extra_declarations_and_changed_call_identity_are_mismatches() {
    let data = bundle();
    for unit in data["units"].as_array().unwrap() {
        let mut missing = unit["observed"].clone();
        missing["calls"][0]["declarations"]
            .as_array_mut()
            .unwrap()
            .pop();
        assert!(rejects(&missing, unit, &data["sdk"]));
        let mut extra = unit["observed"].clone();
        let duplicate = extra["calls"][0]["declarations"][0].clone();
        extra["calls"][0]["declarations"]
            .as_array_mut()
            .unwrap()
            .push(duplicate);
        assert!(rejects(&extra, unit, &data["sdk"]));
        for (field, value) in [
            ("callee_text", json!("forged")),
            ("symbol_name", json!("forged")),
            ("file", json!("/outside.ts")),
            ("start_utf16", json!(0)),
            ("end_utf16", json!(0)),
        ] {
            let mut poison = unit["observed"].clone();
            poison["calls"][0][field] = value;
            assert!(
                rejects(&poison, unit, &data["sdk"]),
                "accepted changed {field}"
            );
        }
    }
}

#[test]
fn ordering_is_irrelevant_but_read_flags_and_supplied_count_are_not() {
    let data = bundle();
    for unit in data["units"].as_array().unwrap() {
        let mut reordered = unit["observed"].clone();
        reordered["calls"].as_array_mut().unwrap().reverse();
        for call in reordered["calls"].as_array_mut().unwrap() {
            call["declarations"].as_array_mut().unwrap().reverse();
        }
        reordered["capture_probes"]
            .as_array_mut()
            .unwrap()
            .reverse();
        assert_eq!(
            project(&reordered, &unit["request"], &data["sdk"]).unwrap(),
            unit["expected"]
        );
        let mut poison = unit["observed"].clone();
        poison["capture_probes"][0]["operation"] = json!("file_exists");
        assert!(
            project(&poison, &unit["request"], &data["sdk"])
                .unwrap_err()
                .contains("nonread")
        );
        let mut sdk = data["sdk"].clone();
        sdk["files"]
            .as_object_mut()
            .unwrap()
            .insert("/sdk/lib/lib.additional.d.ts".into(), json!(""));
        assert!(rejects(&unit["observed"], unit, &sdk));
    }
}

#[test]
fn bound_project_relocation_preserves_only_the_normalized_projection() {
    let data = bundle();
    for unit in data["units"].as_array().unwrap() {
        let mut request = unit["request"].clone();
        request["cwd"] = json!("C:/relocated/capture");
        let files = request["files"]
            .as_object()
            .unwrap()
            .iter()
            .map(|(key, value)| {
                (
                    key.replacen("/project/", "C:/relocated/capture/", 1),
                    value.clone(),
                )
            })
            .collect();
        request["files"] = Value::Object(files);
        let mut observed = unit["observed"].clone();
        for call in observed["calls"].as_array_mut().unwrap() {
            call["file"] = json!(call["file"].as_str().unwrap().replacen(
                "/project/",
                "C:/relocated/capture/",
                1
            ));
            for declaration in call["declarations"].as_array_mut().unwrap() {
                declaration["file"] = json!(declaration["file"].as_str().unwrap().replacen(
                    "/project/",
                    "C:/relocated/capture/",
                    1
                ));
            }
        }
        for probe in observed["capture_probes"].as_array_mut().unwrap() {
            probe["path"] = json!(probe["path"].as_str().unwrap().replacen(
                "/project/",
                "C:/relocated/capture/",
                1
            ));
        }
        assert_eq!(
            project(&observed, &request, &data["sdk"]).unwrap(),
            unit["expected"]
        );
        request["cwd"] = json!("C:/foreign/capture");
        assert!(project(&observed, &request, &data["sdk"]).is_err());
    }
}
