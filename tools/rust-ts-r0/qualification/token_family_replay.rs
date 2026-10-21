//! One native observation supplies the separately frozen private-token guard family.
use super::*;

const PACKAGE: &str = "c15fd7803a612c3977913c0662af91287ae6125992ba09a76d000af32583337b";
const MANIFEST: &str = "58036fdf209e27bb8d37027b29afc3b8646c3671dfd9e09dfa22f0421b46f3e5";
const EXPECTED: &str = "9b268653eb2c6d6fd06fa8104fc1fffd52960a0da68a12c0414496caae85a675";

fn validate(plan: &Value, enabled: bool) -> Result<(), String> {
    if plan["kind"] != "INDEPENDENT_TOKEN_GUARD_FAMILY"
        || plan["package_pin_sha256"] != PACKAGE
        || plan["manifest_sha256"] != MANIFEST
        || plan["expected_sha256"] != EXPECTED
        || plan["counts"] != json!({"issuance":13,"revalidation":7,"map_identity":1})
        || plan["baseline_actual_program_records"] != 21
        || plan["planned_native_queries"] != 1
        || plan["native_queries"] != 0
        || plan["execution_enabled"] != enabled
        || plan["candidate_execution_authorized"] != enabled
        || plan["request_template"]["retained"] != true
        || plan["request_template"]["qualified"] != true
        || plan["request_template"]["roots"] != json!(["main.ts"])
        || plan["request_template"]["files"]
            .as_object()
            .is_none_or(|files| {
                files.len() != 2
                    || !files.contains_key("main.ts")
                    || !files.contains_key("package.json")
            })
    {
        return Err("independent token family authority or denominator differs".into());
    }
    let canonical_request = json!({"id":"independent-token-guards","cwd":"$ROOT","sdk_directory":"/sdk/lib","roots":["main.ts"],
        "files":plan["request_template"]["files"],"options":{"target":"ES2022","module":"ESNext","moduleResolution":"Bundler",
        "allowJs":true,"jsx":"Preserve","skipLibCheck":true,"noEmit":true,"strict":false},
        "retained":true,"qualified":true,"roles":{},"selection":{},"disabled":[],"utf16_files":{},"raw_files":{}});
    if plan["request_template"] != canonical_request
        || plan["baseline_program_options"]
            != json!({"target":9,"module":99,"moduleResolution":100,"allowJs":true,"jsx":1,"skipLibCheck":true,"noEmit":true,"strict":false})
        || plan["baseline_program_records_joined"] != 21
        || plan["baseline_retained_map_bytes_joined"] != true
    {
        return Err(
            "token request differs from the full frozen Program input/options context".into(),
        );
    }
    let root = Path::new(value_text(plan, "package_root")?);
    for (name, pin) in [
        ("package-pin.json", PACKAGE),
        ("manifest.json", MANIFEST),
        ("expected.json", EXPECTED),
    ] {
        exact_hash(&root.join(name), pin)?;
    }
    let expected = read_json(&root.join("expected.json"))?;
    if plan["expected"] != expected {
        return Err("token expected content differs from independently frozen bytes".into());
    }
    let manifest = read_json(&root.join("manifest.json"))?;
    for name in ["main.ts", "package.json"] {
        let source = value_text(&plan["request_template"]["files"], name)?;
        let frozen_path = format!("fixture/{name}");
        let matches = manifest["files"]
            .as_array()
            .ok_or("token source manifest absent")?
            .iter()
            .filter(|row| row["path"] == frozen_path)
            .collect::<Vec<_>>();
        if matches.len() != 1
            || matches[0]["sha256"] != sha(source.as_bytes())
            || matches[0]["bytes"] != source.len() as u64
            || plan["source_pins"][name]["sha256"] != matches[0]["sha256"]
            || plan["source_pins"][name]["bytes"] != matches[0]["bytes"]
        {
            return Err("native token source bytes differ from frozen fixture".into());
        }
    }
    Ok(())
}

pub(super) fn run(fixture: &Value, permit: &Value, dir: &Path) -> Result<Value, String> {
    if fixture["token_execution_enabled"] != true || permit["token_execution_authorized"] != true {
        return Err("independent token family is not root-authorized".into());
    }
    let plan_path = Path::new(value_text(fixture, "token_family_path")?);
    exact_hash(plan_path, value_text(fixture, "token_family_sha256")?)?;
    if fixture["token_family_sha256"] != permit["token_family_sha256"] {
        return Err("root permit is not bound to token family bytes".into());
    }
    let plan = read_json(plan_path)?;
    validate(&plan, true)?;
    if dir.exists() {
        return Err("token evidence must be fresh".into());
    }
    fs::create_dir_all(dir).map_err(|error| error.to_string())?;
    let root = dir.join("workspace");
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    let sentinel = root.join("TokenCaseProbe");
    fs::write(&sentinel, b"case probe").map_err(|error| error.to_string())?;
    let case_sensitive = !root.join("tokencaseprobe").exists();
    fs::remove_file(&sentinel).map_err(|error| error.to_string())?;
    let request = materialize(&plan["request_template"], &root, case_sensitive)?;
    let request_path = dir.join("request.json");
    save(&request_path, &request)?;
    let artifact = Path::new(value_text(fixture, "artifact_path")?);
    let helper = Path::new(value_text(fixture, "helper_path")?);
    let sdk_path = Path::new(value_text(fixture, "sdk_path")?);
    let pins = [
        (artifact, value_text(fixture, "artifact_sha256")?),
        (helper, value_text(fixture, "helper_sha256")?),
        (sdk_path, value_text(fixture, "sdk_sha256")?),
    ];
    for (path, pin) in pins {
        exact_hash(path, pin)?;
    }
    let argv = vec![
        artifact.to_string_lossy().into_owned(),
        request_path.to_string_lossy().into_owned(),
        sdk_path.to_string_lossy().into_owned(),
    ];
    let outcome = process::run_with_helper(&argv, &root, 20_000, 8_388_608, helper)
        .map_err(|error| error.to_string())?;
    save(
        &dir.join("process-outcome.json"),
        &serde_json::to_value(&outcome).map_err(|error| error.to_string())?,
    )?;
    save(
        &dir.join("process-invocation.json"),
        &json!({"argv":argv,"cwd":root,"timeout_ms":20_000,"output_cap":8_388_608,"native_queries":1}),
    )?;
    for (path, pin) in pins {
        exact_hash(path, pin)?;
    }
    let sdk = read_json(sdk_path)?;
    let actual = t00_token_consumer::observe(
        &outcome,
        &request,
        &sdk,
        value_text(fixture, "artifact_sha256")?,
    )?;
    save(&dir.join("actual-token-observations.json"), &actual)?;
    let matches = projected_eq(&actual, &plan["expected"]);
    let report = json!({"state":if matches {"TOKEN_GUARD_OBSERVATIONS_MATCH"} else {"TOKEN_GUARD_OBSERVATIONS_MISMATCH"},
        "pass":matches,"actual":actual,"expected":plan["expected"],"counts":plan["counts"],
        "package_pin_sha256":PACKAGE,"manifest_sha256":MANIFEST,"expected_sha256":EXPECTED,
        "native_queries":1,"baseline_actual_program_records":21,"qualified":false,"qualification_credit":0});
    save(&dir.join("token-report.json"), &report)?;
    Ok(report)
}

#[test]
fn comparator_token_family_refuses_disabled_foreign_or_changed_source_plan() {
    // No native process is invoked by these authority controls.
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../docs/research/rust-ts-r0/cases/supplement-token-guards-20261021");
    let files = json!({"main.ts":"import { register } from 'opaque'; function helper() { return 1; } export function main() { return register(() => helper()); }",
        "package.json":"{\"dependencies\":{\"opaque\":\"1.0.0\"}}"});
    let mut source_pins = json!({});
    for name in ["main.ts", "package.json"] {
        let text = files[name].as_str().unwrap();
        source_pins[name] = json!({"sha256":sha(text.as_bytes()),"bytes":text.len()});
    }
    let healthy = json!({"kind":"INDEPENDENT_TOKEN_GUARD_FAMILY","package_pin_sha256":PACKAGE,
        "manifest_sha256":MANIFEST,"expected_sha256":EXPECTED,"package_root":root,
        "counts":{"issuance":13,"revalidation":7,"map_identity":1},"baseline_actual_program_records":21,
        "baseline_program_options":{"target":9,"module":99,"moduleResolution":100,"allowJs":true,"jsx":1,"skipLibCheck":true,"noEmit":true,"strict":false},
        "baseline_program_records_joined":21,"baseline_retained_map_bytes_joined":true,
        "planned_native_queries":1,"native_queries":0,"execution_enabled":true,"candidate_execution_authorized":true,
        "request_template":{"id":"independent-token-guards","cwd":"$ROOT","sdk_directory":"/sdk/lib","retained":true,"qualified":true,"roots":["main.ts"],"files":files,
        "options":{"target":"ES2022","module":"ESNext","moduleResolution":"Bundler","allowJs":true,"jsx":"Preserve","skipLibCheck":true,"noEmit":true,"strict":false},
        "roles":{},"selection":{},"disabled":[],"utf16_files":{},"raw_files":{}},
        "source_pins":source_pins,"expected":read_json(&root.join("expected.json")).unwrap()});
    validate(&healthy, true).unwrap();
    for pointer in [
        "/execution_enabled",
        "/candidate_execution_authorized",
        "/package_pin_sha256",
        "/manifest_sha256",
        "/counts",
        "/request_template/files/main.ts",
        "/request_template/qualified",
        "/request_template/roots",
        "/expected/mapIdentity",
        "/request_template/id",
        "/request_template/cwd",
        "/request_template/sdk_directory",
        "/request_template/options/allowJs",
        "/request_template/options/moduleResolution",
        "/request_template/roles",
        "/request_template/selection",
        "/request_template/disabled",
        "/request_template/utf16_files",
        "/request_template/raw_files",
        "/baseline_program_options",
        "/baseline_program_records_joined",
        "/baseline_retained_map_bytes_joined",
    ] {
        let mut plan = healthy.clone();
        *plan.pointer_mut(pointer).unwrap() = json!("foreign");
        assert!(validate(&plan, true).is_err(), "accepted {pointer}");
    }
    let mut extra = healthy.clone();
    extra["request_template"]["foreign_extra_field"] = json!(true);
    assert!(validate(&extra, true).is_err());
    validate(&healthy, true).unwrap();
}
