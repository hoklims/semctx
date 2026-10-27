use super::*;

pub fn with_project<T>(
    files: BTreeMap<String, String>,
    roots: Vec<String>,
    run: impl FnOnce() -> T,
) -> T {
    with_options(files, roots, true, run)
}

pub fn with_sdk_project<T>(
    mut files: BTreeMap<String, String>,
    roots: Vec<String>,
    run: impl FnOnce() -> T,
) -> T {
    let bytes = std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/sdk/sdk-input.json"))
        .expect("explicit captured SDK fixture");
    let sdk: Sdk = serde_json::from_slice(&bytes).expect("captured SDK descriptor");
    assert_eq!(sdk.version, "7.1.0-dev");
    assert_eq!(sdk.files.len(), 115);
    for (path, text) in sdk.files {
        assert!(files.insert(path, text).is_none(), "foreign SDK overlap");
    }
    with_options(files, roots, false, run)
}

fn with_options<T>(
    files: BTreeMap<String, String>,
    roots: Vec<String>,
    no_lib: bool,
    run: impl FnOnce() -> T,
) -> T {
    let sensitive = ts_goport::frontend::vfs::osvfs_fs().use_case_sensitive_file_names();
    let fs = Rc::new(CaptureFs::new(files, sensitive));
    let options = CompilerOptions {
        target: ScriptTarget::ES2022,
        module: ModuleKind::ES_NEXT,
        module_resolution: ModuleResolutionKind::BUNDLER,
        allow_js: Tristate::True,
        jsx: JsxEmit::PRESERVE,
        no_lib: if no_lib {
            Tristate::True
        } else {
            Tristate::False
        },
        skip_lib_check: Tristate::True,
        no_emit: Tristate::True,
        strict: Tristate::False,
        ..Default::default()
    };
    let config = Rc::new(tsoptions::new_parsed_command_line(
        Rc::new(options),
        roots,
        None,
        ComparePathsOptions {
            use_case_sensitive_file_names: sensitive,
            current_directory: "/repo".into(),
        },
    ));
    let host = compiler::new_compiler_host("/repo", fs.clone(), "/sdk/lib", None, None, None);
    let frontend = {
        let _empty = core::enter_program(None);
        native_program::frontend(
            compiler::ProgramOptions {
                host,
                config,
                use_source_of_project_reference: false,
                single_threaded: Tristate::True,
                typings_location: String::new(),
                project_name: String::new(),
                create_module_resolver: None,
                skip_module_resolution: false,
            },
            &fs,
        )
    };
    let _current = native_program::NativeProgram::enter(&frontend);
    program::bind_all();
    run()
}
