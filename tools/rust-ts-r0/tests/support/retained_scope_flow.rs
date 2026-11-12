use semctx_gates::process;
use semctx_r0_probe::identity;
use serde_json::{Value, json};
use std::{
    fs,
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};

#[test]
fn native_retained_scope_distinguishes_import_types_and_external_import_equals_from_syntax_controls()
 {
    let crate_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let run = std::env::var_os("SEMCTX_NATIVE_EVIDENCE")
        .map(PathBuf::from)
        .unwrap_or_else(|| crate_root.join("development-evidence/retained-scope"))
        .join(format!(
            "scope-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
    fs::create_dir_all(&run).unwrap();
    fs::write(run.join("ScopeCase"), b"case mode").unwrap();
    let sensitive = !run.join("scopecase").exists();
    fs::remove_file(run.join("ScopeCase")).unwrap();
    let cwd = run
        .canonicalize()
        .unwrap()
        .to_string_lossy()
        .replace('\\', "/");
    let producer = PathBuf::from(env!("CARGO_BIN_EXE_semctx-r0-probe"));
    let helper = PathBuf::from(
        std::env::var_os("SEMCTX_PROCESS_HELPER").expect("actual process helper required"),
    );
    let sdk = crate_root.join("sdk/sdk-input.json");
    let producer_sha = identity::digest_bytes(&fs::read(&producer).unwrap());
    let helper_sha = identity::digest_bytes(&fs::read(&helper).unwrap());
    let sdk_sha = identity::digest_bytes(&fs::read(&sdk).unwrap());
    let target = "export interface Value {n:number}\nexport const value=1;\n";
    for (id, source, retained, expected, failure) in [
        (
            "import-type",
            "export type Type=import('./target').Value;",
            true,
            vec!["DEPENDENCY_SCOPE_IMPORT_TYPE_UNSUPPORTED:src/main.ts"],
            None,
        ),
        (
            "external-equals",
            "import dep = require('./target');export const value=dep;",
            true,
            vec!["DEPENDENCY_SCOPE_COMMONJS_UNSUPPORTED:src/main.ts"],
            None,
        ),
        (
            "export-equals",
            "const value=1;export = value;",
            true,
            vec!["DEPENDENCY_SCOPE_COMMONJS_UNSUPPORTED:src/main.ts"],
            None,
        ),
        (
            "internal-alias",
            "namespace Own {export const value=1;} import ref=Own;export {ref};",
            true,
            vec![],
            None,
        ),
        (
            "type-only-declaration",
            "import type {Value} from './target';export type Type=Value;",
            true,
            vec![],
            None,
        ),
        (
            "quoted-syntax",
            "export const note=\"import dep = require('./target'); import('./target').Value\";",
            true,
            vec![],
            None,
        ),
        (
            "ordinary-not-retained",
            "export type Type=import('./target').Value;",
            false,
            vec![],
            Some("COMPONENT_RETAINED_INPUTS_NOT_ENABLED"),
        ),
        (
            "invalid-source",
            "export type Type=import(",
            true,
            vec![],
            Some("RETAINED_SCOPE_SYNTAX_PARSE_FAILED"),
        ),
    ] {
        let request = json!({"id":id,"cwd":cwd,"sdk_directory":"/sdk/lib","case_sensitive":sensitive,"roots":[format!("{cwd}/src/main.ts"),format!("{cwd}/src/target.ts")],"files":{format!("{cwd}/src/main.ts"):source,format!("{cwd}/src/target.ts"):target,format!("{cwd}/package.json"):"{\"name\":\"scope-dev\",\"type\":\"module\"}\n"},"options":{"target":"ES2022","module":"ESNext","moduleResolution":"Bundler","allowJs":true,"jsx":"Preserve","skipLibCheck":true,"noEmit":true,"strict":false},"retained":retained,"qualified":false});
        let request_path = run.join(format!("{id}-request.json"));
        fs::write(&request_path, serde_json::to_vec_pretty(&request).unwrap()).unwrap();
        let argv = vec![
            producer.to_string_lossy().into_owned(),
            request_path.to_string_lossy().into_owned(),
            sdk.to_string_lossy().into_owned(),
        ];
        let outcome = process::run_with_helper(&argv, &run, 20_000, 8_388_608, &helper).unwrap();
        fs::write(run.join(format!("{id}-process.json")),serde_json::to_vec_pretty(&json!({"argv":argv,"cwd":run,"actualOutcome":outcome,"producer_sha256":producer_sha,"helper_sha256":helper_sha,"sdk_sha256":sdk_sha})).unwrap()).unwrap();
        assert_eq!(outcome.kind, "success", "{id}: {outcome:?}");
        assert_eq!(outcome.exit_code, Some(0), "{id}");
        let observed: Value = serde_json::from_str(&outcome.stdout).unwrap();
        let subject = observed["subjects"]
            .as_array()
            .unwrap()
            .iter()
            .find(|subject| subject["path"] == "src/main.ts")
            .unwrap();
        let syntax = &subject["retainedScopeSyntaxObservation"];
        assert_eq!(syntax["executed"], failure.is_none(), "{id}: {syntax}");
        assert_eq!(syntax["reasons"], json!(expected), "{id}");
        assert_eq!(
            syntax["unsupported"],
            failure.map_or_else(|| json!([]), |reason| json!([reason])),
            "{id}"
        );
        assert_eq!(observed["global_admission_inferred"], false, "{id}");
        assert_eq!(
            producer_sha,
            identity::digest_bytes(&fs::read(&producer).unwrap())
        );
        assert_eq!(
            helper_sha,
            identity::digest_bytes(&fs::read(&helper).unwrap())
        );
        assert_eq!(sdk_sha, identity::digest_bytes(&fs::read(&sdk).unwrap()));
    }
}
