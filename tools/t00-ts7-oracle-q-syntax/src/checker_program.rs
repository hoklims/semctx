use serde_json::Value;
use std::{collections::BTreeMap, rc::Rc};
use ts_goport::{
    frontend::{compiler, tsoptions, tspath::ComparePathsOptions},
    prelude::*,
};

pub fn install(input: &Value) -> Result<Vec<String>, String> {
    if input.get("roots").is_some_and(|roots| !roots.is_array()) {
        return Err("roots must be an array".into());
    }
    if let Some(options) = input.get("options") {
        let defaults = serde_json::json!({"target":"ES2022","module":"ESNext","moduleResolution":"Bundler","allowJs":true,"jsx":"Preserve","skipLibCheck":true,"noEmit":true,"strict":false});
        if !options.as_object().is_some_and(|options| {
            options
                .iter()
                .all(|(key, value)| defaults.get(key) == Some(value))
        }) {
            return Err("checker requires the declared ES2022/ESNext/Bundler options".into());
        }
    }
    let supplied = input["files"].as_object().ok_or("checker requires files")?;
    if supplied.is_empty() {
        return Err("checker requires nonempty files".into());
    }
    let mut files = BTreeMap::new();
    for (path, text) in supplied {
        if path.starts_with('/')
            || path.contains('\\')
            || path.split('/').any(|part| matches!(part, ".." | "." | ""))
        {
            return Err("checker requires canonical relative paths".into());
        }
        files.insert(
            format!("/project/{path}"),
            text.as_str().ok_or("source must be text")?.to_string(),
        );
    }
    let roots: Vec<String> = if let Some(roots) = input["roots"].as_array() {
        roots
            .iter()
            .map(|root| {
                root.as_str()
                    .map(|path| format!("/project/{path}"))
                    .ok_or("root must be text".to_string())
            })
            .collect::<Result<_, _>>()?
    } else {
        files
            .keys()
            .filter(|path| {
                [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]
                    .iter()
                    .any(|extension| path.ends_with(extension))
            })
            .cloned()
            .collect()
    };
    if roots.is_empty() || !roots.iter().all(|root| files.contains_key(root)) {
        return Err("roots must name supplied source files".into());
    }
    let native =
        input["nativeNoResolve"].as_bool() == Some(true) || input["operation"] == "checker-native";
    let sdk = input["sdk_directory"]
        .as_str()
        .ok_or("SDK directory required")?;
    let mut libraries = 0;
    for entry in std::fs::read_dir(sdk).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with("lib.") && name.ends_with(".d.ts") {
            libraries += 1;
            if !native {
                files.insert(
                    format!("/sdk/lib/{name}"),
                    std::fs::read_to_string(entry.path()).map_err(|error| error.to_string())?,
                );
            }
        }
    }
    if libraries != 115 {
        return Err(format!("SDK requires 115 libraries, found {libraries}"));
    }
    let options = CompilerOptions {
        target: if native {
            ScriptTarget::ES_NEXT
        } else {
            ScriptTarget::ES2022
        },
        module: ModuleKind::ES_NEXT,
        module_resolution: ModuleResolutionKind::BUNDLER,
        allow_js: Tristate::True,
        jsx: JsxEmit::PRESERVE,
        skip_lib_check: Tristate::True,
        no_emit: Tristate::True,
        strict: Tristate::False,
        no_lib: if native {
            Tristate::True
        } else {
            Tristate::False
        },
        no_resolve: if native {
            Tristate::True
        } else {
            Tristate::False
        },
        ..Default::default()
    };
    let config = Rc::new(tsoptions::new_parsed_command_line(
        Rc::new(options),
        roots.clone(),
        None,
        ComparePathsOptions {
            use_case_sensitive_file_names: true,
            current_directory: "/project".into(),
        },
    ));
    let host = compiler::new_compiler_host(
        "/project",
        Rc::new(crate::files::Files(files)),
        "/sdk/lib",
        None,
        None,
        None,
    );
    let program = {
        let _scope = ts_goport::core::enter_program(None);
        let frontend = Rc::new(compiler::new_program(compiler::ProgramOptions {
            host,
            config,
            use_source_of_project_reference: false,
            single_threaded: Tristate::True,
            typings_location: String::new(),
            project_name: String::new(),
            create_module_resolver: None,
            skip_module_resolution: native,
        }));
        new_program_version(&frontend, None)
    };
    ts_goport::core::set_thread_program(Some(program));
    Ok(roots)
}

#[cfg(test)]
pub struct TestSdk {
    pub path: std::path::PathBuf,
}

#[cfg(test)]
pub fn test_sdk_directory() -> TestSdk {
    use std::sync::OnceLock;
    static DIRECTORY: OnceLock<std::path::PathBuf> = OnceLock::new();
    let path = DIRECTORY.get_or_init(|| {
        let sdk: Value = serde_json::from_str(include_str!("../../rust-ts-r0/sdk/sdk-input.json"))
            .expect("canonical SDK JSON");
        assert_eq!(sdk["version"], "7.1.0-dev");
        assert_eq!(sdk["files"].as_object().unwrap().len(), 115);
        let executable = std::env::current_exe().expect("test executable path");
        let path = executable
            .parent()
            .expect("test executable directory")
            .to_path_buf();
        for (name, text) in sdk["files"].as_object().unwrap() {
            let name = name.strip_prefix("/sdk/lib/").expect("SDK library root");
            let target = path.join(name);
            let text = text.as_str().unwrap();
            if target.exists() {
                assert_eq!(
                    std::fs::read_to_string(&target).expect("existing SDK library"),
                    text,
                    "test executable has a different SDK library: {name}"
                );
            } else {
                std::fs::write(&target, text).expect("materialize canonical SDK library");
            }
        }
        path
    });
    TestSdk { path: path.clone() }
}
