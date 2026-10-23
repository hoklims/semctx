mod files;
mod projection;
mod semantic;
use semantic::{enrich, relative};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{collections::BTreeMap, rc::Rc};
use ts_goport::{
    frontend::{compiler, tsoptions, tspath::ComparePathsOptions},
    prelude::*,
    scanner_util::get_token_pos_of_node,
};

#[derive(Deserialize)]
struct Request {
    files: BTreeMap<String, String>,
    #[serde(default)]
    roots: Vec<String>,
    options: Option<Value>,
    #[serde(rename = "repoRoot", default = "default_root")]
    repo_root: String,
    #[serde(default = "default_retained")]
    retained: bool,
    #[serde(rename = "caseSensitive", default = "default_retained")]
    case_sensitive: bool,
}
#[derive(Deserialize)]
struct Sdk {
    version: String,
    files: BTreeMap<String, String>,
}

fn default_root() -> String {
    "/project".into()
}
fn default_retained() -> bool {
    true
}
fn run(request_path: &str, sdk_path: &str) -> Result<Value, String> {
    if std::env::var_os("GOPORT_BUILD_VERSION").is_some() {
        return Err("GOPORT_BUILD_VERSION must be absent".into());
    }
    let bytes = if request_path == "-" {
        let mut bytes = Vec::new();
        std::io::Read::read_to_end(&mut std::io::stdin(), &mut bytes)
            .map_err(|error| error.to_string())?;
        bytes
    } else {
        std::fs::read(request_path).map_err(|error| error.to_string())?
    };
    let request: Request = serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
    let sdk: Sdk =
        serde_json::from_slice(&std::fs::read(sdk_path).map_err(|error| error.to_string())?)
            .map_err(|error| error.to_string())?;
    if sdk.version != "7.1.0-dev"
        || sdk.files.len() != 115
        || !sdk
            .files
            .keys()
            .all(|path| path.starts_with("/sdk/lib/lib") && path.ends_with(".d.ts"))
    {
        return Err("SDK must contain the 115 pinned TS7 libraries under /sdk/lib".into());
    }
    if request.files.is_empty()
        || !request.files.keys().all(|path| {
            path.starts_with('/') && !path.split('/').any(|part| part == ".." || part == ".")
        })
    {
        return Err("nonempty request files must use canonical absolute paths".into());
    }
    let roots = if request.roots.is_empty() {
        request
            .files
            .keys()
            .filter(|path| {
                path.ends_with(".ts")
                    || path.ends_with(".tsx")
                    || path.ends_with(".js")
                    || path.ends_with(".jsx")
                    || path.ends_with(".mts")
                    || path.ends_with(".cts")
                    || path.ends_with(".mjs")
                    || path.ends_with(".cjs")
            })
            .cloned()
            .collect()
    } else {
        request.roots
    };
    if roots.is_empty() || !roots.iter().all(|root| request.files.contains_key(root)) {
        return Err("roots must name supplied files".into());
    }
    let input_paths: Vec<String> = request.files.keys().cloned().collect();
    let config_files = request.files.clone();
    let mut files = request.files;
    files.extend(sdk.files);
    let fs = Rc::new(files::Files(files, request.case_sensitive));
    let mut options = CompilerOptions {
        target: ScriptTarget::ES2022,
        module: ModuleKind::ES_NEXT,
        module_resolution: ModuleResolutionKind::BUNDLER,
        allow_js: Tristate::True,
        jsx: JsxEmit::PRESERVE,
        skip_lib_check: Tristate::True,
        no_emit: Tristate::True,
        strict: Tristate::False,
        ..Default::default()
    };
    if let Some(raw) = request.options.as_ref() {
        let raw = raw.as_object().ok_or("options must be an object")?;
        for (key, value) in raw {
            match (key.as_str(), value.as_str()) {
                ("target", Some("ES2022")) => {}
                ("module", Some("ESNext")) => options.module = ModuleKind::ES_NEXT,
                ("module", Some("Node16")) => options.module = ModuleKind::NODE16,
                ("module", Some("NodeNext")) => options.module = ModuleKind::NODE_NEXT,
                ("module", Some("CommonJS")) => options.module = ModuleKind::COMMON_JS,
                ("moduleResolution", Some("Bundler")) => {
                    options.module_resolution = ModuleResolutionKind::BUNDLER
                }
                ("moduleResolution", Some("Node16")) => {
                    options.module_resolution = ModuleResolutionKind::NODE16
                }
                ("moduleResolution", Some("NodeNext")) => {
                    options.module_resolution = ModuleResolutionKind::NODE_NEXT
                }
                ("moduleResolution", Some("Node10")) => {
                    options.module_resolution = ModuleResolutionKind::NODE10
                }
                ("moduleResolution", Some("Classic")) => {
                    options.module_resolution = ModuleResolutionKind::CLASSIC
                }
                ("strict", _) if value == false => {}
                ("allowJs", _) if value == true => {}
                ("checkJs", _) if value == false => {}
                ("jsx", Some("Preserve")) => {}
                ("skipLibCheck", _) | ("noEmit", _) if value == true => {}
                _ => return Err(format!("unsupported oracle option {key}: {value}")),
            }
        }
    }
    let config = Rc::new(tsoptions::new_parsed_command_line(
        Rc::new(options),
        roots,
        None,
        ComparePathsOptions {
            use_case_sensitive_file_names: request.case_sensitive,
            current_directory: request.repo_root.clone(),
        },
    ));
    let host = compiler::new_compiler_host(&request.repo_root, fs, "/sdk/lib", None, None, None);
    install_new_program(compiler::ProgramOptions {
        host,
        config,
        use_source_of_project_reference: false,
        single_threaded: Tristate::True,
        typings_location: String::new(),
        project_name: String::new(),
        create_module_resolver: None,
        skip_module_resolution: false,
    })?;
    let config_references = projection::config_references(&config_files)?;
    let mut resolved_module_specifiers = Vec::new();
    let mut loaded_files = Vec::new();
    let mut output = json!({"modules":[],"symbols":[],"calls":[],"imports":[],"functionOwners":[],"relativeSpecifiers":{},"dynamicImports":[]});
    for file in source_files() {
        let path = source_file_file_name(file).to_string();
        loaded_files.push(path.clone());
        if !path.starts_with("/sdk/") {
            for specifier in source_file_imports(file) {
                let mode = ts_goport::program::get_mode_for_usage_location(file, specifier);
                let mut observation = json!({"fromRelPath":relative(&path,&request.repo_root),"moduleSpecifier":specifier.text(),"line":ts_goport::scanner_util::get_ecma_line_and_utf16_character_of_position(file,get_token_pos_of_node(specifier,file,false)).0+1,"resolutionMode":format!("{:?}",mode)});
                if let Some(resolved) =
                    ts_goport::program::get_resolved_module_from_module_specifier(file, specifier)
                    && !resolved.resolved_file_name.is_empty()
                {
                    observation["resolvedRelPath"] =
                        json!(relative(&resolved.resolved_file_name, &request.repo_root));
                }
                resolved_module_specifiers.push(observation);
            }
        }
        if !path.ends_with(".d.ts")
            && !path.ends_with(".d.mts")
            && !path.ends_with(".d.cts")
            && input_paths.iter().any(|input| {
                if request.case_sensitive {
                    input == &path
                } else {
                    input.eq_ignore_ascii_case(&path)
                }
            })
        {
            let path = relative(&path, &request.repo_root);
            output["modules"].as_array_mut().unwrap().push(json!(path));
            projection::extract(
                file,
                &source_file_text(file),
                &path,
                request.retained,
                &mut output,
            );
            let specifiers = projection::ast_specifiers(file, &path);
            output["relativeSpecifiers"][&path] = specifiers["relativeSpecifiers"].clone();
            output["dynamicImports"].as_array_mut().unwrap().extend(
                specifiers["dynamicImports"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .cloned(),
            );
            let root = request.repo_root.clone();
            output = with_type_checker_for_file(file, move |checker| {
                enrich(file, file, checker, &root, &mut output);
                output
            });
        }
    }
    for field in ["calls", "imports"] {
        for record in output[field].as_array_mut().unwrap() {
            record.as_object_mut().unwrap().remove("_startByte");
        }
    }
    output["caseSensitive"] = json!(request.case_sensitive);
    output["compilerVersion"] = json!(ts_goport::core::version());
    output["revision"] = json!("780dc512d64f40afebffa6a7028207649fb7ed1c");
    output["sdkLibraries"] = json!(115);
    output["loadedFiles"] = json!(loaded_files);
    output["resolvedModuleSpecifiers"] = json!(resolved_module_specifiers);
    output["configReferences"] = config_references;
    Ok(output)
}

fn main() {
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    if arguments.len() != 2 {
        eprintln!("usage: t00-ts7-oracle-q-extraction REQUEST.json SDK.json");
        std::process::exit(2);
    }
    let result = std::thread::Builder::new()
        .stack_size(16 * 1024 * 1024)
        .spawn(move || run(&arguments[0], &arguments[1]))
        .expect("oracle worker")
        .join();
    match result {
        Ok(Ok(value)) => println!("{}", value),
        Ok(Err(error)) => {
            eprintln!("{error}");
            std::process::exit(2);
        }
        Err(_) => {
            eprintln!("upstream compiler panicked; no facts are qualified");
            std::process::exit(2);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ts7_checker_separates_runtime_alias_references_from_type_queries() {
        let request = json!({"files":{
            "/project/a.ts":"import { leaf, unused } from './b'; export function outer(){return leaf();} type T = typeof unused;",
            "/project/b.ts":"export function leaf(){return 1;} export function unused(){return 2;}"
        },"roots":["/project/a.ts"]});
        let path = std::env::temp_dir().join(format!(
            "semctx-extraction-oracle-runtime-{}.json",
            std::process::id()
        ));
        std::fs::write(&path, serde_json::to_vec(&request).unwrap()).unwrap();
        let request_path = path.to_str().unwrap().to_string();
        let sdk = format!(
            "{}/../rust-ts-r0/sdk/sdk-input.json",
            env!("CARGO_MANIFEST_DIR")
        );
        let observation = std::thread::Builder::new()
            .stack_size(16 * 1024 * 1024)
            .spawn(move || run(&request_path, &sdk))
            .unwrap()
            .join()
            .unwrap()
            .unwrap();
        std::fs::remove_file(path).unwrap();
        assert_eq!(observation["modules"], json!(["b.ts", "a.ts"]));
        assert_eq!(
            observation["imports"][0]["bindingTargets"],
            json!([
                {"relPath":"b.ts","symbolPath":"leaf","runtimeUsed":true},
                {"relPath":"b.ts","symbolPath":"unused"}
            ])
        );
        assert_eq!(observation["calls"][0]["calleeRelPath"], "b.ts");
        assert_eq!(
            observation["resolvedModuleSpecifiers"][0]["resolvedRelPath"],
            "b.ts"
        );
    }
    #[test]
    fn refuses_unbound_or_noncanonical_inputs_and_unsupported_options() {
        let path = std::env::temp_dir().join(format!(
            "semctx-extraction-oracle-refusals-{}.json",
            std::process::id()
        ));
        let sdk = format!(
            "{}/../rust-ts-r0/sdk/sdk-input.json",
            env!("CARGO_MANIFEST_DIR")
        );
        let cases = [
            (
                json!({"files":{"/project/../a.ts":""}}),
                "canonical absolute paths",
            ),
            (
                json!({"files":{"/project/a.ts":""},"roots":["/project/absent.ts"]}),
                "roots must name supplied files",
            ),
            (
                json!({"files":{"/project/a.ts":""},"options":{"module":"AMD"}}),
                "unsupported oracle option module",
            ),
        ];
        for (request, reason) in cases {
            std::fs::write(&path, serde_json::to_vec(&request).unwrap()).unwrap();
            assert!(
                run(path.to_str().unwrap(), &sdk)
                    .unwrap_err()
                    .contains(reason)
            );
        }
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn refuses_foreign_sdk_version_wrong_inventory_size_or_foreign_library_paths() {
        let stem = std::env::temp_dir().join(format!(
            "semctx-extraction-oracle-sdk-refusals-{}",
            std::process::id()
        ));
        let request_path = stem.with_extension("request.json");
        let sdk_path = stem.with_extension("sdk.json");
        std::fs::write(
            &request_path,
            serde_json::to_vec(&json!({"files":{"/project/a.ts":"export {};"}})).unwrap(),
        )
        .unwrap();
        let files: BTreeMap<String, String> = (0..115)
            .map(|index| (format!("/sdk/lib/lib.fixture-{index}.d.ts"), String::new()))
            .collect();
        let mut foreign_paths = files.clone();
        foreign_paths.remove("/sdk/lib/lib.fixture-0.d.ts");
        foreign_paths.insert("/foreign/lib.fixture-0.d.ts".into(), String::new());
        for sdk in [
            json!({"version":"5.9.3","files":files}),
            json!({"version":"7.1.0-dev","files":{}}),
            json!({"version":"7.1.0-dev","files":foreign_paths}),
        ] {
            std::fs::write(&sdk_path, serde_json::to_vec(&sdk).unwrap()).unwrap();
            assert!(
                run(request_path.to_str().unwrap(), sdk_path.to_str().unwrap())
                    .unwrap_err()
                    .starts_with("SDK must contain")
            );
        }
        std::fs::remove_file(request_path).unwrap();
        std::fs::remove_file(sdk_path).unwrap();
    }
}
