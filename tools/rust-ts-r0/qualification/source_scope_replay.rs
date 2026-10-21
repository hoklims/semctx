//! Consumer-only wrapper: genuine AST scope DTO plus a complete frozen comparison.
use super::*;

pub(super) fn allows_unborn_head(recipe: &Value) -> bool {
    recipe["allow_unborn_head"] == true
        && recipe["source_scope_origin"]
            == "923a03767cd5f675c66f4a35b458dcd6f38554fe3c41f90f5a83eebc7292ddc6"
        && recipe["public_flow_kind"] == "retained-scope"
        && recipe["git_setup"] == json!([["git", "init", "-q"]])
        && recipe["git_after_current"] == json!([])
        && matches!(
            recipe["unit_id"].as_str(),
            Some(
                "source::reference-unretained"
                    | "source::reference-retained"
                    | "source::reference-outside"
                    | "source::optional-opaque"
                    | "source::excluded-parse"
                    | "source::excluded-computed"
                    | "source::excluded-unresolved"
            )
        )
}

pub(super) fn run(recipe: &Value, dir: &Path, fixture: &Value) -> Result<Value, String> {
    if recipe["surface"] != "source_scope_cli" || !allows_unborn_head(recipe) {
        return Err("source scope wrapper outside exact seven frozen inputs".into());
    }
    let mut native_recipe = recipe.clone();
    native_recipe["surface"] = json!("qualified_flow_cli");
    let observed = qualified_flow_replay::run(&native_recipe, dir, fixture)?;
    if observed["observed"]["scope_ast_receipt"]["kind"] != "rust-consumer-native-ast-v1"
        || observed["observed"]["scope_ast_receipt"]["input_manifest_id"]
            != observed["observed"]["raw_scope"]["input_manifest_id"]
        || !observed["observed"]["rust_scope_projection"].is_object()
    {
        return Err("source scope actual bound Rust AST observation absent".into());
    }
    let check = json!({"target":[],"mode":"eq","actual_transform":"none",
        "expected":recipe["expected_scope"],"expected_origin":recipe["expected_scope_ref"]});
    let result = evaluate(&observed["observed"]["rust_scope_projection"], &check);
    Ok(
        json!({"state":"COMPLETE_SOURCE_SCOPE_COMPARISON","pass":result["state"] == "PASS_PROJECTED_PROPERTY",
        "comparison":result,"observation":observed,"qualification_credit":0}),
    )
}

#[test]
fn unborn_head_permission_is_exact_source_scope_only() {
    let mut value = json!({"allow_unborn_head":true,
        "source_scope_origin":"923a03767cd5f675c66f4a35b458dcd6f38554fe3c41f90f5a83eebc7292ddc6",
        "public_flow_kind":"retained-scope","git_setup":[["git","init","-q"]],
        "git_after_current":[],"unit_id":"source::reference-retained"});
    assert!(allows_unborn_head(&value));
    value["unit_id"] = json!("public::scope-admission-01");
    assert!(!allows_unborn_head(&value));
    value["unit_id"] = json!("source::reference-retained");
    value["public_flow_kind"] = json!("public-verify");
    assert!(!allows_unborn_head(&value));
}
