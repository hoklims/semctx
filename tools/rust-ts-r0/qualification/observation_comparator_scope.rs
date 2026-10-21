//! Component-only modes cannot turn unexecuted extraction placeholders into proof.
use super::*;

pub(super) fn validate(recipe: &Value) -> Result<(), String> {
    let checks = recipe["checks"]
        .as_array()
        .ok_or("missing credited raw checks")?;
    validate_component_checks(checks)?;
    if !matches!(
        recipe["surface"].as_str(),
        Some("source_component_cli" | "declaration_root_cli")
    ) {
        return Ok(());
    }
    if checks.is_empty() || recipe["relations"].as_array().is_none_or(|r| !r.is_empty()) {
        return Err("component observation comparator scope: checks required and extraction relations unavailable".into());
    }
    for check in checks {
        let target = check["target"]
            .as_array()
            .ok_or("component selector absent")?;
        let selector = target.get(1).and_then(Value::as_object);
        let source =
            selector.is_some_and(|s| s.len() == 1 && s.get("path").is_some_and(Value::is_string));
        let component = match target.get(2).and_then(Value::as_str) {
            Some("sourceFileObservation") => true,
            Some("componentRootSource") => recipe["surface"] == "source_component_cli",
            Some("declarationRootSource") => recipe["surface"] == "declaration_root_cli",
            Some("javascript") => target.get(3).is_some_and(|v| v == "native"),
            Some("moduleConfigurationObservations") => matches!(
                target.get(3).and_then(Value::as_str),
                Some("retainedWithoutSource" | "retainedWithSource" | "ordinaryWithoutSnapshot")
            ),
            _ => false,
        };
        if target.first().is_none_or(|v| v != "subjects") || !source || !component {
            return Err(
                "component observation comparator scope: target was not executed by this mode"
                    .into(),
            );
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn recipe() -> Value {
        json!({"surface":"source_component_cli","relations":[],"checks":[
            {"target":["subjects",{"path":"main.ts"},"sourceFileObservation","executed"],"expected":true,"mode":"eq"},
            {"target":["subjects",{"path":"main.ts"},"sourceFileObservation","unsupported"],"expected":[],"mode":"eq"}]})
    }
    #[test]
    fn comparator_component_modes_reject_unexecuted_empty_extraction_and_relations() {
        for surface in ["source_component_cli", "declaration_root_cli"] {
            let mut positive = recipe();
            positive["surface"] = json!(surface);
            let context = if surface == "source_component_cli" {
                "componentRootSource"
            } else {
                "declarationRootSource"
            };
            positive["checks"].as_array_mut().unwrap().push(json!({"target":["subjects",{"path":"main.ts"},context,"executed"],"expected":true,"mode":"eq"}));
            assert!(validate(&positive).is_ok());
            for target in [
                json!(["raw_extraction", "imports"]),
                json!(["assembly", "edges"]),
                json!(["calls"]),
                json!(["subjects",{"path":"main.ts"},"outcome"]),
            ] {
                let mut negative = positive.clone();
                negative["checks"]
                    .as_array_mut()
                    .unwrap()
                    .push(json!({"target":target,"expected":[],"mode":"eq"}));
                assert!(
                    validate(&negative).is_err(),
                    "accepted an unexecuted extraction target"
                );
            }
            let mut negative = positive.clone();
            negative["relations"] =
                json!([{"target":["raw_extraction","imports"],"expected_equal":true}]);
            assert!(
                validate(&negative).is_err(),
                "accepted a relation over unexecuted extraction"
            );
        }
        let ordinary = json!({"surface":"raw_cli","checks":[{"target":["raw_extraction","imports"],"expected":[],"mode":"eq"}],"relations":[]});
        assert!(
            validate(&ordinary).is_ok(),
            "ordinary executed extraction keeps its existing scope"
        );
    }
}
