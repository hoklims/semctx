use super::*;

fn document() -> Value {
    serde_json::from_slice(
        &std::fs::read(std::env::var("SEMANTIC_REASON_TEST_DOCUMENT").unwrap()).unwrap(),
    )
    .unwrap()
}
fn checks(assertion: &Value) -> Vec<Value> {
    let mut result = assertion["checks"].as_array().unwrap().clone();
    let prefix = result[0]["target"].as_array().unwrap()[..4].to_vec();
    for (field, expected) in [("executed", json!(true)), ("unsupported", json!([]))] {
        let mut target = prefix.clone();
        target.push(json!(field));
        result.push(json!({"target":target,"expected":expected,"mode":"eq","observation":0,"actual_transform":"none"}));
    }
    result
}
fn observed(reasons: &Value) -> Value {
    json!({"subjects":[{"path":"main.ts","moduleConfigurationObservations":{"retainedWithoutSource":{"reasons":reasons,"executed":true,"unsupported":[]}}}]})
}

#[test]
fn six_real_baseline_observations_match_exact_checks_and_existing_routing_guard() {
    let data = document();
    assert_eq!(data["assertions"].as_array().unwrap().len(), 6);
    for assertion in data["assertions"].as_array().unwrap() {
        let unit = data["units"]
            .as_array()
            .unwrap()
            .iter()
            .find(|u| u["unit_id"] == assertion["unit_id"])
            .unwrap();
        let raw = &unit["operations"][0]["reasons"];
        let response = observed(raw);
        let check = &assertion["checks"][0];
        validate_component_checks(&checks(assertion)).unwrap();
        let actual = select(&response, check["target"].as_array().unwrap()).unwrap();
        assert!(compare(actual, &check["expected"], check["mode"].as_str().unwrap()).unwrap());
        assert_eq!(
            unit["operations"][0]["reasons"],
            unit["operations"][1]["reasons"]
        );
    }
}

#[test]
fn dropping_each_observed_reason_is_a_mismatch_including_promise_assimilation() {
    let data = document();
    let mut dropped = 0;
    for assertion in data["assertions"].as_array().unwrap() {
        let check = &assertion["checks"][0];
        let reasons = check["expected"]["exact_set"].as_array().unwrap();
        for index in 0..reasons.len() {
            let mut poison = reasons.clone();
            poison.remove(index);
            assert!(!compare(&json!(poison), &check["expected"], "reason_constraints").unwrap());
            dropped += 1;
        }
    }
    assert_eq!(dropped, 4);
    let promise = data["assertions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|a| a["unit_id"].as_str().unwrap().starts_with("V2-G12"))
        .unwrap();
    assert!(
        !compare(
            &json!(["SOURCE_SDK_ITERATION_UNSUPPORTED"]),
            &promise["checks"][0]["expected"],
            "reason_constraints"
        )
        .unwrap()
    );
}

#[test]
fn existing_empty_controls_reject_positive_pair_reasons() {
    let data = document();
    for pair in data["contrasts"].as_array().unwrap() {
        assert_eq!(pair["control_reasons"], json!([]));
        let control = data["assertions"]
            .as_array()
            .unwrap()
            .iter()
            .find(|a| a["unit_id"] == pair["existing_control"])
            .unwrap();
        assert!(
            !compare(
                &pair["positive_reasons"],
                &control["checks"][0]["expected"],
                "reason_constraints"
            )
            .unwrap()
        );
    }
}

#[test]
fn missing_misbound_or_unverified_operation_metadata_is_rejected_by_existing_guard() {
    let data = document();
    for assertion in data["assertions"].as_array().unwrap() {
        let check = &assertion["checks"][0];
        let mut missing = check.clone();
        missing.as_object_mut().unwrap().remove("operation_binding");
        assert!(
            validate_reason_routing(&missing)
                .unwrap_err()
                .contains("no source operation binding")
        );
        let mut wrong_target = check.clone();
        wrong_target["operation_binding"]["target"] = json!(["wrong", "reasons"]);
        assert!(validate_reason_routing(&wrong_target).is_err());
        let mut wrong_status = check.clone();
        wrong_status["operation_binding"]["status"] = json!("UNVERIFIED");
        assert!(validate_reason_routing(&wrong_status).is_err());
        let mut null_authority = check.clone();
        null_authority["operation_binding"]["authority"] = Value::Null;
        assert!(validate_reason_routing(&null_authority).is_err());
    }
}

#[test]
fn missing_component_completeness_and_wrong_reason_target_do_not_pass() {
    let data = document();
    for assertion in data["assertions"].as_array().unwrap() {
        assert!(
            validate_component_checks(assertion["checks"].as_array().unwrap())
                .unwrap_err()
                .contains("completeness check")
        );
        let response = observed(&assertion["checks"][0]["expected"]["exact_set"]);
        let wrong = json!(["subjects",{"path":"main.ts"},"semanticObservation","reasons"]);
        assert!(select(&response, wrong.as_array().unwrap()).is_err());
    }
}
