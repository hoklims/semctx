#[path = "es5_helpers.rs"]
mod es5_helpers;

use serde::Serialize;
use std::{
    cell::RefCell,
    collections::{BTreeMap, BTreeSet},
    rc::Rc,
    sync::{Arc, Mutex},
};
use ts_goport::{
    ast,
    astdata::SyntaxKind,
    core::{self, Node},
    emitter::{
        emitter::{EmitOnly, Emitter},
        program_emit::{EmitResult, WriteFile},
    },
    flags::{JsxEmit, ModuleKind, ScriptTarget},
    frontend::{compiler, tsoptions, tspath::ComparePathsOptions, vfs},
    options::{CompilerOptions, Tristate},
    printer, program,
};

#[derive(Debug, Default, Serialize)]
pub struct RuntimeConfiguration {
    pub reasons: BTreeSet<String>,
    pub unsupported: BTreeSet<String>,
    pub emit_fs_probes: Vec<serde_json::Value>,
}

pub fn inspect(source: Node, options: &CompilerOptions) -> RuntimeConfiguration {
    let mut result = RuntimeConfiguration::default();
    if source.is_nil() {
        result
            .unsupported
            .insert("RUNTIME_CONFIGURATION_SOURCE_UNAVAILABLE".into());
        return result;
    }
    let mut spans = BTreeSet::new();
    collect_jsx_spans(source, &mut spans);
    if !spans.is_empty() && !ast::get_jsx_implicit_import_base(options, source).is_empty() {
        result
            .reasons
            .insert("SOURCE_AUTOMATIC_JSX_RUNTIME_UNSUPPORTED".into());
    }
    if spans.is_empty() && !options.import_helpers.is_true() {
        return result;
    }
    let observe_classic = !spans.is_empty()
        && !result
            .reasons
            .contains("SOURCE_AUTOMATIC_JSX_RUNTIME_UNSUPPORTED");
    if !observe_classic && !options.import_helpers.is_true() {
        return result;
    }
    let import_helpers = options.import_helpers.is_true();
    let options = transpile_options(options);
    let file_name = ast::source_file_file_name(source).to_string();
    let text = ast::source_file_text(source).to_string();
    let attempt = observe_emission(file_name, text, options, observe_classic);
    result.emit_fs_probes = attempt.fs_probes;
    match attempt.observation {
        Ok(observation) => {
            #[cfg(test)]
            eprintln!(
                "{}",
                serde_json::json!({"kind":"native-runtime-emission-observation","observation":&observation})
            );
            if observe_classic && observation.classic_factory {
                result
                    .reasons
                    .insert("SOURCE_CLASSIC_JSX_RUNTIME_UNSUPPORTED".into());
            }
            result
                .unsupported
                .extend(observation.es5_requests.unsupported.iter().cloned());
            let imports_tslib = match &observation.imports_tslib {
                Ok(found) => *found,
                Err(reason) => {
                    result.unsupported.insert(reason.clone());
                    false
                }
            };
            if import_helpers
                && observation.helpers_visible_at_source_file
                && (!observation.sdk_non_scoped_helpers.is_empty()
                    || !observation.es5_requests.names.is_empty())
                && (imports_tslib || observation.es5_external_helper_import)
            {
                result
                    .reasons
                    .insert("SOURCE_CONFIGURATION_HELPERS_UNSUPPORTED".into());
            }
        }
        Err(reason) => {
            result.unsupported.insert(reason);
        }
    }
    result
}

struct EmitAttempt {
    observation: Result<EmitObservation, String>,
    fs_probes: Vec<serde_json::Value>,
}

#[derive(Debug, Serialize)]
struct EmitObservation {
    classic_factory: bool,
    non_scoped_helpers: Vec<String>,
    sdk_non_scoped_helpers: Vec<String>,
    output_text: String,
    diagnostic_codes: Vec<i32>,
    es5_requests: es5_helpers::HelperRequests,
    es5_external_helper_import: bool,
    helpers_visible_at_source_file: bool,
    imports_tslib: Result<bool, String>,
}

fn collect_jsx_spans(node: Node, spans: &mut BTreeSet<(i32, i32)>) {
    if matches!(
        node.kind(),
        SyntaxKind::JsxElement | SyntaxKind::JsxSelfClosingElement | SyntaxKind::JsxFragment
    ) {
        spans.insert((node.pos(), node.end()));
    }
    for child in node.iter_children() {
        collect_jsx_spans(child, spans);
    }
}

fn has_classic_factory(node: Node, spans: &BTreeSet<(i32, i32)>) -> bool {
    if node.kind() == SyntaxKind::CallExpression
        && ast::is_synthetic_node(node)
        && spans.contains(&(node.pos(), node.end()))
    {
        return true;
    }
    node.iter_children()
        .any(|child| has_classic_factory(child, spans))
}

fn transpile_options(options: &CompilerOptions) -> CompilerOptions {
    let mut options = options.clone();
    if options.target == ScriptTarget::NONE {
        options.target = ScriptTarget::ES5;
    }
    if options.jsx == JsxEmit::NONE {
        options.jsx = JsxEmit::PRESERVE;
    }
    if options.module == ModuleKind::NONE {
        options.module = if options.target >= ScriptTarget::ES2015 {
            ModuleKind::ES2015
        } else {
            ModuleKind::COMMON_JS
        };
    }
    if options.es_module_interop == Tristate::Unknown {
        options.es_module_interop = if matches!(
            options.module,
            ModuleKind::NODE16
                | ModuleKind::NODE18
                | ModuleKind::NODE20
                | ModuleKind::NODE_NEXT
                | ModuleKind::PRESERVE
        ) {
            Tristate::True
        } else {
            Tristate::False
        };
    }
    options.allow_importing_ts_extensions = Tristate::Unknown;
    options.allow_non_ts_extensions = Tristate::True;
    options.composite = Tristate::Unknown;
    options.emit_declaration_only = Tristate::Unknown;
    options.declaration = Tristate::False;
    options.declaration_dir.clear();
    options.declaration_map = Tristate::False;
    if !options.verbatim_module_syntax.is_true() {
        options.isolated_modules = Tristate::True;
    }
    options.isolated_declarations = Tristate::False;
    options.incremental = Tristate::Unknown;
    options.lib = None;
    options.no_emit = Tristate::Unknown;
    options.no_check = Tristate::True;
    options.no_lib = Tristate::True;
    options.no_emit_on_error = Tristate::Unknown;
    options.no_resolve = Tristate::True;
    options.paths = None;
    options.root_dirs = None;
    options.suppress_output_path_check = Tristate::True;
    options.ts_build_info_file.clear();
    options.types = None;
    options.out_file.clear();
    options
}

fn observe_emission(
    file_name: String,
    text: String,
    mut options: CompilerOptions,
    observe_classic: bool,
) -> EmitAttempt {
    let system_module = options.get_emit_module_kind() == ModuleKind::SYSTEM;
    if system_module {
        options.module = ModuleKind::ES_NEXT;
    }
    let sensitive = vfs::osvfs_fs().use_case_sensitive_file_names();
    let fs = Rc::new(crate::CaptureFs::new(
        BTreeMap::from([(file_name.clone(), text)]),
        sensitive,
    ));
    let config = Rc::new(tsoptions::new_parsed_command_line(
        Rc::new(options),
        vec![file_name.clone()],
        None,
        ComparePathsOptions {
            use_case_sensitive_file_names: sensitive,
            current_directory: "/".into(),
        },
    ));
    let host = compiler::new_compiler_host("/", fs.clone(), "/runtime-sdk", None, None, None);
    let frontend = {
        let _empty = core::enter_program(None);
        Rc::new(compiler::new_program(compiler::ProgramOptions {
            host,
            config,
            use_source_of_project_reference: false,
            single_threaded: Tristate::True,
            typings_location: String::new(),
            project_name: String::new(),
            create_module_resolver: None,
            skip_module_resolution: true,
        }))
    };
    let loaded = program::new_program_version(&frontend, None);
    let result = {
        let _current = core::enter_program(Some(loaded));
        let source = program::get_source_file(&file_name);
        if source.is_nil() {
            Err("RUNTIME_CONFIGURATION_EMIT_SOURCE_UNAVAILABLE".into())
        } else {
            program::bind_all();
            let mut results = program::run_on_checker_threads_for_files(&[source], move |source| {
                observe_on_checker_thread(source, observe_classic, system_module)
            });
            results
                .pop()
                .unwrap_or_else(|| Err("RUNTIME_CONFIGURATION_EMIT_RESULT_UNAVAILABLE".into()))
        }
    };
    program::release_program(loaded);
    let fs_probes=fs.log.borrow().iter().map(|probe|serde_json::json!({"operation":probe.operation,"path":probe.path,"found":probe.found})).collect();
    EmitAttempt {
        observation: result,
        fs_probes,
    }
}

fn observe_on_checker_thread(
    source: Node,
    observe_classic: bool,
    system_module: bool,
) -> Result<EmitObservation, String> {
    let host = program::new_emit_host(source);
    let paths =
        program::get_output_paths_for_source_file(source, host.as_ref(), Default::default());
    let output = Arc::new(Mutex::new(Vec::<String>::new()));
    let write_file: WriteFile = {
        let output = Arc::clone(&output);
        Arc::new(move |file, text, _| {
            if !file.ends_with(".map") {
                output
                    .lock()
                    .map_err(|_| "runtime emit output lock poisoned".to_string())?
                    .push(text.into());
            }
            Ok(())
        })
    };
    let mut emitter = Emitter {
        host,
        emit_only: EmitOnly::Js,
        emitter_diagnostics: Default::default(),
        writer: Some(Rc::new(RefCell::new(printer::new_text_writer(
            program::options().new_line.get_new_line_character(),
            0,
        )))),
        paths,
        source_file: source,
        emit_result: EmitResult::default(),
        force_emit: true,
        write_file: Some(write_file),
        js_part: None,
    };
    let Some(print) = emitter.transform_js_part() else {
        return Err("RUNTIME_CONFIGURATION_TRANSFORM_UNAVAILABLE".into());
    };
    let mut spans = BTreeSet::new();
    if observe_classic {
        collect_jsx_spans(source, &mut spans);
    }
    let classic_factory = observe_classic && has_classic_factory(print.source_file, &spans);
    let helpers_visible_at_source_file = !system_module
        || !(ast::is_effective_external_module(source, program::options())
            || print
                .source_file
                .subtree_facts()
                .intersects(ts_goport::flags::SubtreeFacts::SUBTREE_CONTAINS_DYNAMIC_IMPORT));
    let es5_requests = if program::options().target < ScriptTarget::ES2015 {
        es5_helpers::collect(print.source_file, program::options(), &print.emit_context)
    } else {
        es5_helpers::HelperRequests::default()
    };
    let es5_external_helper_import = !es5_requests.names.is_empty()
        && program::options().import_helpers.is_true()
        && ast::is_effective_external_module(source, program::options());
    let non_scoped_helpers: Vec<String> = print
        .emit_context
        .get_emit_helpers(print.source_file)
        .iter()
        .filter(|helper| !helper.scoped)
        .map(|helper| helper.name.to_string())
        .collect();
    let sdk_non_scoped_helpers: Vec<String> = non_scoped_helpers
        .iter()
        .filter(|name| {
            program::options().es_module_interop.is_true()
                || !matches!(
                    name.as_str(),
                    "typescript:commonjscreatebinding"
                        | "typescript:commonjscreatevalue"
                        | "typescript:commonjsimportstar"
                        | "typescript:commonjsimportdefault"
                )
        })
        .cloned()
        .collect();
    emitter.finish_js_part(print);
    let diagnostic_codes = emitter
        .emit_result
        .diagnostics
        .iter()
        .map(|diagnostic| diagnostic.code())
        .collect();
    let mut output = output
        .lock()
        .map_err(|_| "RUNTIME_CONFIGURATION_EMIT_OUTPUT_LOCK_POISONED".to_string())?;
    if output.len() != 1 {
        return Err("RUNTIME_CONFIGURATION_EMIT_OUTPUT_UNAVAILABLE".into());
    }
    let output_text = output.pop().unwrap();
    let imports_tslib = if program::options().import_helpers.is_true()
        && helpers_visible_at_source_file
        && (!sdk_non_scoped_helpers.is_empty() || !es5_requests.names.is_empty())
    {
        if program::options().target < ScriptTarget::ES2015 {
            es5_helpers::lower_template_import_surface(&output_text)
                .map(|surface| emitted_imports_tslib(&surface))
        } else {
            Ok(emitted_imports_tslib(&output_text))
        }
    } else {
        Ok(false)
    };
    Ok(EmitObservation {
        classic_factory,
        non_scoped_helpers,
        sdk_non_scoped_helpers,
        output_text,
        diagnostic_codes,
        es5_requests,
        es5_external_helper_import,
        helpers_visible_at_source_file,
        imports_tslib,
    })
}

fn emitted_imports_tslib(text: &str) -> bool {
    use ts_goport::frontend::scanner::scanner_p1::new_scanner;
    let mut scanner = new_scanner();
    scanner.set_text(text);
    scanner.set_script_target(ScriptTarget::ES5);
    let mut input = EmittedImportScanner {
        scanner,
        current: SyntaxKind::Unknown,
        last: SyntaxKind::Unknown,
        braces: 0,
        external_module: false,
        ambient_tslib_depths: Vec::new(),
        found: false,
    };
    input.next();
    while input.scanner.token() != SyntaxKind::EndOfFile {
        if input.scanner.token() == SyntaxKind::TemplateHead {
            input.template();
            input.next();
        }
        if input.declare()
            || input.import()
            || input.export()
            || input.require(false, true)
            || input.define()
        {
            continue;
        }
        input.next();
    }
    input.found
        || input
            .ambient_tslib_depths
            .iter()
            .any(|depth| input.external_module || *depth != 0)
}

struct EmittedImportScanner<'a> {
    scanner: ts_goport::frontend::scanner::scanner_p1::Scanner<'a>,
    current: SyntaxKind,
    last: SyntaxKind,
    braces: i32,
    external_module: bool,
    ambient_tslib_depths: Vec<i32>,
    found: bool,
}

impl EmittedImportScanner<'_> {
    fn next(&mut self) -> SyntaxKind {
        self.last = self.current;
        self.current = self.scanner.scan();
        match self.current {
            SyntaxKind::OpenBraceToken => self.braces += 1,
            SyntaxKind::CloseBraceToken => self.braces -= 1,
            _ => {}
        }
        self.current
    }
    fn record(&mut self) {
        self.found |= self.scanner.token_value() == "tslib";
        if self.braces == 0 {
            self.external_module = true;
        }
    }
    fn peek(&mut self) -> SyntaxKind {
        let state = self.scanner.mark();
        let token = self.scanner.scan();
        self.scanner.rewind(state);
        token
    }
    fn identifier(token: SyntaxKind) -> bool {
        token == SyntaxKind::Identifier || ast::is_keyword_kind(token)
    }
    fn string(token: SyntaxKind) -> bool {
        matches!(
            token,
            SyntaxKind::StringLiteral | SyntaxKind::NoSubstitutionTemplateLiteral
        )
    }
    fn declare(&mut self) -> bool {
        if self.scanner.token() != SyntaxKind::DeclareKeyword {
            return false;
        }
        if self.next() == SyntaxKind::ModuleKeyword
            && self.next() == SyntaxKind::StringLiteral
            && self.scanner.token_value() == "tslib"
        {
            self.ambient_tslib_depths.push(self.braces);
        }
        true
    }
    fn import(&mut self) -> bool {
        if self.last == SyntaxKind::DotToken || self.scanner.token() != SyntaxKind::ImportKeyword {
            return false;
        }
        let mut token = self.next();
        if token == SyntaxKind::OpenParenToken {
            token = self.next();
            if Self::string(token) {
                self.record();
            }
            return true;
        }
        if token == SyntaxKind::StringLiteral {
            self.record();
            return true;
        }
        if token == SyntaxKind::TypeKeyword {
            let lookahead = self.peek();
            if lookahead != SyntaxKind::FromKeyword
                && (matches!(
                    lookahead,
                    SyntaxKind::AsteriskToken | SyntaxKind::OpenBraceToken
                ) || Self::identifier(lookahead))
            {
                token = self.next();
            }
        }
        if Self::identifier(token) {
            token = self.next();
            if token == SyntaxKind::FromKeyword {
                if self.next() == SyntaxKind::StringLiteral {
                    self.record();
                }
                return true;
            }
            if token == SyntaxKind::EqualsToken {
                self.require(true, false);
                return true;
            }
            if token == SyntaxKind::CommaToken {
                token = self.next();
            } else {
                return true;
            }
        }
        if token == SyntaxKind::OpenBraceToken {
            token = self.next();
            while !matches!(token, SyntaxKind::CloseBraceToken | SyntaxKind::EndOfFile) {
                token = self.next();
            }
            if token == SyntaxKind::CloseBraceToken
                && self.next() == SyntaxKind::FromKeyword
                && self.next() == SyntaxKind::StringLiteral
            {
                self.record();
            }
        } else if token == SyntaxKind::AsteriskToken
            && self.next() == SyntaxKind::AsKeyword
            && Self::identifier(self.next())
            && self.next() == SyntaxKind::FromKeyword
            && self.next() == SyntaxKind::StringLiteral
        {
            self.record();
        }
        true
    }
    fn export(&mut self) -> bool {
        if self.scanner.token() != SyntaxKind::ExportKeyword {
            return false;
        }
        if self.braces == 0 {
            self.external_module = true;
        }
        let mut token = self.next();
        if token == SyntaxKind::TypeKeyword
            && matches!(
                self.peek(),
                SyntaxKind::AsteriskToken | SyntaxKind::OpenBraceToken
            )
        {
            token = self.next();
        }
        if token == SyntaxKind::OpenBraceToken {
            token = self.next();
            while !matches!(token, SyntaxKind::CloseBraceToken | SyntaxKind::EndOfFile) {
                token = self.next();
            }
            if token == SyntaxKind::CloseBraceToken
                && self.next() == SyntaxKind::FromKeyword
                && self.next() == SyntaxKind::StringLiteral
            {
                self.record();
            }
        } else if token == SyntaxKind::AsteriskToken {
            if self.next() == SyntaxKind::FromKeyword && self.next() == SyntaxKind::StringLiteral {
                self.record();
            }
        } else if token == SyntaxKind::ImportKeyword {
            token = self.next();
            if token == SyntaxKind::TypeKeyword && Self::identifier(self.peek()) {
                token = self.next();
            }
            if Self::identifier(token) && self.next() == SyntaxKind::EqualsToken {
                self.require(true, false);
            }
        }
        true
    }
    fn require(&mut self, skip_current: bool, allow_templates: bool) -> bool {
        let token = if skip_current {
            self.next()
        } else {
            self.scanner.token()
        };
        if token != SyntaxKind::RequireKeyword {
            return false;
        }
        if self.next() == SyntaxKind::OpenParenToken {
            let token = self.next();
            if token == SyntaxKind::StringLiteral
                || (allow_templates && token == SyntaxKind::NoSubstitutionTemplateLiteral)
            {
                self.record();
            }
        }
        true
    }
    fn define(&mut self) -> bool {
        if self.scanner.token() != SyntaxKind::Identifier || self.scanner.token_value() != "define"
        {
            return false;
        }
        if self.next() != SyntaxKind::OpenParenToken {
            return true;
        }
        let mut token = self.next();
        if Self::string(token) {
            if self.next() != SyntaxKind::CommaToken {
                return true;
            }
            token = self.next();
        }
        if token != SyntaxKind::OpenBracketToken {
            return true;
        }
        token = self.next();
        while !matches!(token, SyntaxKind::CloseBracketToken | SyntaxKind::EndOfFile) {
            if Self::string(token) {
                self.record();
            }
            token = self.next();
        }
        true
    }
    fn template(&mut self) {
        let mut stack = vec![self.scanner.token()];
        while !stack.is_empty() {
            match self.scanner.scan() {
                SyntaxKind::EndOfFile => break,
                SyntaxKind::ImportKeyword => {
                    self.import();
                }
                SyntaxKind::TemplateHead => stack.push(SyntaxKind::TemplateHead),
                SyntaxKind::OpenBraceToken => stack.push(SyntaxKind::OpenBraceToken),
                SyntaxKind::CloseBraceToken
                    if stack.last() != Some(&SyntaxKind::TemplateHead)
                        || self.scanner.re_scan_template_token(false)
                            == SyntaxKind::TemplateTail =>
                {
                    stack.pop();
                }
                _ => {}
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    use ts_goport::{
        flags::{JsxEmit, ModuleKind, ScriptTarget},
        options::Tristate,
        program,
    };

    fn run(
        text: &str,
        jsx: JsxEmit,
        import_helpers: bool,
        target: ScriptTarget,
    ) -> RuntimeConfiguration {
        use sha2::Digest;
        eprintln!(
            "{}",
            serde_json::json!({"kind":"runtime-configuration-development-input", "source":text,
            "sourceSha256":format!("{:x}", sha2::Sha256::digest(text.as_bytes())),
            "jsx":format!("{jsx:?}"), "importHelpers":import_helpers, "target":format!("{target:?}")})
        );
        let options = CompilerOptions {
            jsx,
            import_helpers: if import_helpers {
                Tristate::True
            } else {
                Tristate::False
            },
            target,
            module: ModuleKind::ES_NEXT,
            no_emit: Tristate::True,
            ..Default::default()
        };
        crate::development::with_project(
            BTreeMap::from([("/repo/runtime-development.tsx".into(), text.into())]),
            vec!["/repo/runtime-development.tsx".into()],
            move || {
                let source = program::get_source_file("/repo/runtime-development.tsx");
                inspect(source, &options)
            },
        )
    }

    #[test]
    fn observe_native_es5_helper_emission_component_only() {
        let source = "class Base {} export class Child extends Base {}";
        let options = CompilerOptions {
            target: ScriptTarget::ES5,
            module: ModuleKind::ES_NEXT,
            import_helpers: Tristate::True,
            ..Default::default()
        };
        let output = ts_goport::transpile::transpile_module(
            &ts_goport::gostd::context::background(),
            source,
            ts_goport::transpile::Options {
                compiler_options: Some(options),
                file_name: "/repo/es5-development.ts".into(),
                report_diagnostics: true,
            },
        )
        .expect("native component emit output");
        eprintln!(
            "{}",
            serde_json::json!({"kind":"native-component-es5-observation","source":source,
            "outputText":output.output_text,"diagnosticCodes":output.diagnostics.iter().map(|diagnostic|diagnostic.code()).collect::<Vec<_>>()})
        );
    }

    #[test]
    fn emitted_import_projection_preserves_sdk_scanner_boundaries() {
        assert!(!emitted_imports_tslib(
            "const result = `${require(\"tslib\")}`;"
        ));
        assert!(emitted_imports_tslib(
            "const result = `${import(\"tslib\")}`;"
        ));
        assert!(emitted_imports_tslib(
            "const page = <div>require(\"tslib\")</div>;"
        ));
        assert!(!emitted_imports_tslib(
            "export * as helpers from \"tslib\";"
        ));
        assert!(emitted_imports_tslib(
            "const expression = /require(\"tslib\")/;"
        ));
        assert!(!emitted_imports_tslib("object.import(\"tslib\");"));
        assert!(emitted_imports_tslib("object.define([\"tslib\"],()=>{});"));
    }

    #[test]
    fn jsx_automatic_classic_and_preserve_follow_actual_runtime_configuration() {
        let source = "export const page=<main data-id='runtime-development'/>;";
        let automatic = run(source, JsxEmit::REACT_JSX, false, ScriptTarget::ES2022);
        assert!(
            automatic
                .reasons
                .contains("SOURCE_AUTOMATIC_JSX_RUNTIME_UNSUPPORTED"),
            "{automatic:?}"
        );
        let classic = run(source, JsxEmit::REACT, false, ScriptTarget::ES2022);
        assert!(
            classic
                .reasons
                .contains("SOURCE_CLASSIC_JSX_RUNTIME_UNSUPPORTED"),
            "{classic:?}"
        );
        assert!(classic.unsupported.is_empty(), "{classic:?}");
        assert!(
            classic
                .emit_fs_probes
                .iter()
                .any(|probe| probe["operation"] == "read_file"
                    && probe["path"] == "/repo/runtime-development.tsx"
                    && probe["found"] == true),
            "{classic:?}"
        );
        let preserve = run(source, JsxEmit::PRESERVE, false, ScriptTarget::ES2022);
        assert!(preserve.reasons.is_empty(), "{preserve:?}");
        assert!(preserve.unsupported.is_empty(), "{preserve:?}");
        let no_jsx = run(
            "export const value=1;",
            JsxEmit::REACT_JSX,
            false,
            ScriptTarget::ES2022,
        );
        assert!(no_jsx.reasons.is_empty(), "{no_jsx:?}");
    }

    #[test]
    fn last_jsx_runtime_pragma_overrides_automatic_configuration() {
        let source =
            "/** @jsxRuntime automatic */\n/** @jsxRuntime classic */\nexport const page=<aside/>;";
        let result = run(source, JsxEmit::REACT_JSX, false, ScriptTarget::ES2022);
        assert!(
            !result
                .reasons
                .contains("SOURCE_AUTOMATIC_JSX_RUNTIME_UNSUPPORTED"),
            "{result:?}"
        );
        assert!(
            result
                .reasons
                .contains("SOURCE_CLASSIC_JSX_RUNTIME_UNSUPPORTED"),
            "{result:?}"
        );
        let reverse =
            "/** @jsxRuntime classic */\n/** @jsxRuntime automatic */\nexport const page=<aside/>;";
        assert!(
            run(reverse, JsxEmit::REACT, false, ScriptTarget::ES2022)
                .reasons
                .contains("SOURCE_AUTOMATIC_JSX_RUNTIME_UNSUPPORTED")
        );
    }

    #[test]
    fn import_helpers_requires_a_real_non_scoped_emit_helper_and_emitted_tslib_import() {
        let source =
            "export async function resolveDevelopment(){await Promise.resolve(1); return 2;}";
        let emitted = run(source, JsxEmit::PRESERVE, true, ScriptTarget::ES2015);
        assert!(
            emitted
                .reasons
                .contains("SOURCE_CONFIGURATION_HELPERS_UNSUPPORTED"),
            "{emitted:?}"
        );
        let no_import = run(source, JsxEmit::PRESERVE, false, ScriptTarget::ES2015);
        assert!(
            !no_import
                .reasons
                .contains("SOURCE_CONFIGURATION_HELPERS_UNSUPPORTED"),
            "{no_import:?}"
        );
        let no_helper = run(
            "export const development=1;",
            JsxEmit::PRESERVE,
            true,
            ScriptTarget::ES2015,
        );
        assert!(
            !no_helper
                .reasons
                .contains("SOURCE_CONFIGURATION_HELPERS_UNSUPPORTED"),
            "{no_helper:?}"
        );
        let manual_import = run(
            "import {identity} from 'tslib'; export const development=identity(1);",
            JsxEmit::PRESERVE,
            true,
            ScriptTarget::ES2015,
        );
        assert!(
            !manual_import
                .reasons
                .contains("SOURCE_CONFIGURATION_HELPERS_UNSUPPORTED"),
            "{manual_import:?}"
        );
        let global_helper = run(
            "async function globalDevelopment(){await Promise.resolve(1);}",
            JsxEmit::PRESERVE,
            true,
            ScriptTarget::ES2015,
        );
        assert!(
            !global_helper
                .reasons
                .contains("SOURCE_CONFIGURATION_HELPERS_UNSUPPORTED"),
            "{global_helper:?}"
        );
    }

    #[test]
    fn arbitrary_classic_factory_name_is_observed_by_original_jsx_range() {
        let value = run(
            "/** @jsx composeDevelopment */ export const page=<><article/></>;",
            JsxEmit::REACT,
            false,
            ScriptTarget::ES2022,
        );
        assert!(
            value
                .reasons
                .contains("SOURCE_CLASSIC_JSX_RUNTIME_UNSUPPORTED"),
            "{value:?}"
        );
        assert!(value.unsupported.is_empty(), "{value:?}");
    }

    #[test]
    fn es5_extends_helper_is_observed_for_explicit_and_sdk_default_target() {
        for target in [ScriptTarget::ES5, ScriptTarget::NONE] {
            let value = run(
                "class Base{} export class Child extends Base{}",
                JsxEmit::PRESERVE,
                true,
                target,
            );
            assert!(
                value
                    .reasons
                    .contains("SOURCE_CONFIGURATION_HELPERS_UNSUPPORTED"),
                "{value:?}"
            );
        }
    }
    fn assert_es5_vectors(vectors: Vec<serde_json::Value>) {
        for vector in vectors {
            let source = vector["source"].as_str().unwrap();
            let mut options = CompilerOptions {
                target: ScriptTarget::ES5,
                module: ModuleKind::ES_NEXT,
                import_helpers: Tristate::True,
                ..Default::default()
            };
            if vector["options"]
                .get("target")
                .is_some_and(serde_json::Value::is_null)
            {
                options.target = ScriptTarget::NONE;
            }
            if vector["options"]["target"] == 2 {
                options.target = ScriptTarget::ES2015;
            }
            options.downlevel_iteration = if vector["options"]["downlevelIteration"] == true {
                Tristate::True
            } else {
                Tristate::False
            };
            options.experimental_decorators = if vector["options"]["experimentalDecorators"] == true
            {
                Tristate::True
            } else {
                Tristate::False
            };
            options.module = match vector["options"]["module"].as_i64() {
                Some(1) => ModuleKind::COMMON_JS,
                Some(2) => ModuleKind::AMD,
                Some(3) => ModuleKind::UMD,
                Some(4) => ModuleKind::SYSTEM,
                Some(100) => ModuleKind::NODE16,
                Some(199) => ModuleKind::NODE_NEXT,
                Some(200) => ModuleKind::PRESERVE,
                _ => ModuleKind::ES_NEXT,
            };
            options.module_detection = match vector["options"]["moduleDetection"].as_i64() {
                Some(1) => ts_goport::flags::ModuleDetectionKind::LEGACY,
                Some(2) => ts_goport::flags::ModuleDetectionKind::AUTO,
                Some(3) => ts_goport::flags::ModuleDetectionKind::FORCE,
                _ => ts_goport::flags::ModuleDetectionKind::NONE,
            };
            options.jsx = match vector["options"]["jsx"].as_i64() {
                Some(1) => JsxEmit::PRESERVE,
                Some(2) => JsxEmit::REACT,
                Some(4) => JsxEmit::REACT_JSX,
                _ => JsxEmit::NONE,
            };
            options.es_module_interop = match vector["options"]["esModuleInterop"].as_bool() {
                Some(true) => Tristate::True,
                Some(false) => Tristate::False,
                None => Tristate::Unknown,
            };
            options.allow_js = if vector["options"]["allowJs"] == true {
                Tristate::True
            } else {
                Tristate::Unknown
            };
            options.no_emit_helpers = if vector["options"]["noEmitHelpers"] == true {
                Tristate::True
            } else {
                Tristate::Unknown
            };
            let file_name = vector["fileName"]
                .as_str()
                .unwrap_or("/repo/t00-es5-dev.ts");
            eprintln!(
                "{}",
                serde_json::json!({"kind":"es5-helper-development-input","vector":&vector})
            );
            let value = crate::development::with_project(
                BTreeMap::from([(file_name.into(), source.into())]),
                vec![file_name.into()],
                || inspect(program::get_source_file(file_name), &options),
            );
            assert!(
                value.unsupported.is_empty(),
                "{}: {value:?}",
                vector["name"]
            );
            assert_eq!(
                value
                    .reasons
                    .contains("SOURCE_CONFIGURATION_HELPERS_UNSUPPORTED"),
                vector["expected"].as_bool().unwrap(),
                "{}: {value:?}",
                vector["name"]
            );
        }
    }
    #[test]
    fn es5_helper_decision_matches_sdk_development_pairs() {
        let vectors: Vec<serde_json::Value> = serde_json::from_str(r###"[{"name":"derived","source":"class T00HBase {} export class T00HChild extends T00HBase {}","options":{},"sourceSha256":"d7ba61668d4ee36c001b603d2ad118930b6ebe7c52a4b7b5020d47c5cb446a9f","expected":true},{"name":"ambient-derived","source":"declare class T00HAmbient extends T00HBase {} export {};","options":{},"sourceSha256":"f899baac3026c2d9528d9cc3248d2013e2a9d9211103342e534cc43c5aabcc40","expected":false},{"name":"spread-array","source":"export const t00HArray=[...t00HItems];","options":{},"sourceSha256":"ed730856bb78d9131add4ab14a268ece0eb1d701ed8e28bf54651aee2329d2b4","expected":true},{"name":"packed-spread-array","source":"export const t00HPacked=[...[1,2]];","options":{},"sourceSha256":"67bf2f5c5485c16aed8c68d92411a14d4486dec19b764df1470b48021aee2158","expected":false},{"name":"call-single-spread","source":"export const t00HCall=t00HInvoke(...t00HItems);","options":{},"sourceSha256":"7d5a3c4cc27f522aa666e205ae88721896cf30331765b366da8ed88a7b1a8147","expected":false},{"name":"call-mixed-spread","source":"export const t00HCall=t00HInvoke(1,...t00HItems);","options":{},"sourceSha256":"56b108b317e20e737735b4a8843233c536717137ebdbb1314258f15cae7d6eec","expected":true},{"name":"new-spread","source":"export const t00HNew=new T00HConstructor(...t00HItems);","options":{},"sourceSha256":"fd457d2499d7793dc453420f0939163be31685de7beb7fa95a1104f96db8a6bb","expected":true},{"name":"forof-array","source":"export function t00HVisit(){for(const value of t00HItems){t00HInvoke(value)}}","options":{},"sourceSha256":"a01fa8c0ab118004fc3397e031929293b5ebc8222df51c700e38653e589a1866","expected":false},{"name":"forof-iterator","source":"export function t00HVisit(){for(const value of t00HItems){t00HInvoke(value)}}","options":{"downlevelIteration":true},"sourceSha256":"a01fa8c0ab118004fc3397e031929293b5ebc8222df51c700e38653e589a1866","expected":true},{"name":"binding-array","source":"export const [t00HHead]=t00HItems;","options":{},"sourceSha256":"8664ac3986a8c5da3285f812f34aea0c460d3e4c7657d224b113afda07aff030","expected":false},{"name":"binding-iterator","source":"export const [t00HHead]=t00HItems;","options":{"downlevelIteration":true},"sourceSha256":"8664ac3986a8c5da3285f812f34aea0c460d3e4c7657d224b113afda07aff030","expected":true},{"name":"assignment-iterator","source":"export function t00HAssign(){let head; [head]=t00HItems;return head}","options":{"downlevelIteration":true},"sourceSha256":"4e05a06d051b7b6b8c5ae8d7a7ec59eb7df03b3ed7ee4f3995addbdeff5ecd5c","expected":true},{"name":"parameter-iterator","source":"export function t00HParameter([head]){return head}","options":{"downlevelIteration":true},"sourceSha256":"1b94ec5feda45f728a37d8d489032cba7db377e3af77580f38888cc7ac90d7fe","expected":true},{"name":"tagged-template","source":"export const t00HTagged=t00HTag`raw ${t00HValue}`;","options":{},"sourceSha256":"57410829bddf05a54b4268a34b35b6c888748b98f18d7ae30e0da0a31657b07b","expected":true},{"name":"plain-template","source":"export const t00HTemplate=`raw ${t00HValue}`;","options":{},"sourceSha256":"46e20051882c8a9fbf20dbe7569dac21a12f25614e1777af2a777f07669bc633","expected":false},{"name":"generator","source":"export function* t00HGenerator(){yield 1}","options":{},"sourceSha256":"b8de55bd32e2b8d6858ad8346c8db7dc3c087ded6e831a750f77601e5dcb8986","expected":true},{"name":"empty-generator","source":"export function* t00HEmpty(){}","options":{},"sourceSha256":"e288f30f0bdf10d80e8128d134cee0699cd4d6a07febf4f40a7ebcc5d989652a","expected":true},{"name":"generator-method","source":"export const t00HObject={*produce(){yield 2}};","options":{},"sourceSha256":"8600f4dc46c9c1ad37e9106093f9af4a4a854fcac2b2c60aa929fc9ed905fe7d","expected":true},{"name":"async","source":"export async function t00HAsync(){await t00HInput; return 1}","options":{},"sourceSha256":"40bc8b49acce9c08eb15dd5abd8342c22b35313a657d677d5f664b7568543e8f","expected":true},{"name":"global-derived","source":"class T00HGlobalBase{} class T00HGlobalChild extends T00HGlobalBase{}","options":{},"sourceSha256":"db44562f955cafff1c5b01eea6c344fd312d5007c2f695da6034b9df3a022109","expected":false},{"name":"global-manual-tslib","source":"require(\"tslib\"); class T00HGlobalBase{} class T00HGlobalChild extends T00HGlobalBase{}","options":{},"sourceSha256":"2949d4b0a93bcc047dff91f7d6f15727b7637c068efcef35a00f682452472ce8","expected":true},{"name":"type-only-module-derived","source":"import type {T00HType} from \"./types\"; class T00HTypeBase{} class T00HTypeChild extends T00HTypeBase{}","options":{},"sourceSha256":"aef56b53be3a2e3ad5288d8a8d74f37500f233bc7a9c696dfe06010cb01ae160","expected":true},{"name":"namespace-derived","source":"namespace T00HScope {export class Base{} export class Child extends Base{}}","options":{},"sourceSha256":"c10168619387370ce2ed5adbf2b3342a1775a4cf5ddf1c839cead50fd025b5e8","expected":false},{"name":"sparse-spread","source":"export const t00HSparse=[...[,2]];","options":{},"sourceSha256":"a4987a8f580eec24f7b6d8f267f6a6f466971273c8879f32c66725d62109d680","expected":true},{"name":"packed-call-iteration","source":"export const t00HCall=t00HInvoke(...[1,2]);","options":{"downlevelIteration":true},"sourceSha256":"a5b6d2595361eb56dc8d1ef7cefdfb004cd9244aeea20dc84f66481d671c5906","expected":false},{"name":"call-iteration","source":"export const t00HCall=t00HInvoke(...t00HItems);","options":{"downlevelIteration":true},"sourceSha256":"7d5a3c4cc27f522aa666e205ae88721896cf30331765b366da8ed88a7b1a8147","expected":true},{"name":"private-fields","source":"export class T00HPrivate {#value=1;get(){return this.#value}}","options":{},"sourceSha256":"070ee92afd3c1656253ea66f66e9140eb32533d843ebd4d97f5188027c591542","expected":true},{"name":"standard-decorator","source":"@t00HDecorate export class T00HDecorated {}","options":{},"sourceSha256":"e1fba7acba81b67bf67b3c6f6041906ddbc40706a37cbb3ab3869c353c7b1d7a","expected":true},{"name":"legacy-decorator","source":"@t00HDecorate export class T00HDecorated {}","options":{"experimentalDecorators":true},"sourceSha256":"e1fba7acba81b67bf67b3c6f6041906ddbc40706a37cbb3ab3869c353c7b1d7a","expected":true},{"name":"no-helpers","source":"export const t00HPlain=3;","options":{},"sourceSha256":"37e11491c140f976c8422e448b224c880e148e01a2a194a321ca50992cfea5e9","expected":false},{"name":"default-target-derived","source":"class T00HDefaultBase {} export class T00HDefaultChild extends T00HDefaultBase {}","options":{"target":null},"sourceSha256":"d1b022832d86a9f75b33c3c166c2651bda29905e59d2e3d623e6a4175b9ccbde","expected":true}]"###).unwrap();
        assert_es5_vectors(vectors);
    }

    #[test]
    fn es5_pattern_and_spread_contexts_preserve_sdk_negative_controls() {
        let vectors = serde_json::from_str(r###"[{"name":"forof-rest-assignment","source":"export function t00HRestLoop(){let rest;for([...rest] of t00HItems){t00HInvoke(rest)}}","options":{},"sourceSha256":"b966c2cb5374678e1c7551bd33532f57345a1ff489433f1d03364a924b1eaebc","expected":false},{"name":"forin-rest-assignment","source":"export function t00HRestKeys(){let rest;for([...rest] in t00HObject){t00HInvoke(rest)}}","options":{},"sourceSha256":"3dc23e23f116f37cab12c317d4d29b433db5f08b5b40df0fe95843d235af93c0","expected":true},{"name":"empty-assignment","source":"export function t00HEmptyAssign(){[]=t00HItems}","options":{"downlevelIteration":true},"sourceSha256":"c65f9fa4c9dfbcd8f71f26902ff182dec9f8d14055cc464c85b46b4ec1d99170","expected":false},{"name":"empty-parameter","source":"export function t00HEmptyParameter([]){}","options":{"downlevelIteration":true},"sourceSha256":"6b3057b2f92887b001fcf14e58da7cd491e476578b7de32cb49bde0c93718b18","expected":false},{"name":"empty-rest-parameter","source":"export function t00HEmptyRest(...[]){}","options":{"downlevelIteration":true},"sourceSha256":"6fc0936fe2a7083117bcf358bdfe95d17463b8f9fbf590876b70ed93fc870499","expected":true},{"name":"empty-binding","source":"export const []=t00HItems;","options":{"downlevelIteration":true},"sourceSha256":"c8654241c3081e5f4bedb6df828263aeface1238642c94ed72e9b096dc4c2abb","expected":true},{"name":"nested-empty-assignment","source":"export function t00HNestedEmpty(){({x:[]}=t00HObject)}","options":{"downlevelIteration":true},"sourceSha256":"316670a9b249241481397502c8f17e2f8641b06d80566d1d0914a8e5fb00bd00","expected":true},{"name":"empty-assignment-rhs-helper","source":"export function t00HEmptyRight(){[]=[...t00HItems]}","options":{"downlevelIteration":true},"sourceSha256":"b8a024ba24a0025fb7743545e9c84b069b02acac1cf9537b4bcd714d6c18badf","expected":true},{"name":"empty-parameter-default-helper","source":"export function t00HEmptyDefault([]=[...t00HItems]){}","options":{"downlevelIteration":true},"sourceSha256":"d43bb446431a138a71aab172c2278b0ec479ed7a1827787e09de89777d156693","expected":true},{"name":"nested-assignment-rest","source":"export function t00HNestedRest(){let rest;({x:[...rest]}=t00HObject)}","options":{},"sourceSha256":"3d38e8bf8a343a6dbd1fb193c034f64fd1f2b8a0189d3f152d47bbca360c4db7","expected":false},{"name":"nested-packed-array","source":"export const t00HNestedPacked=[...[...[1,2]]];","options":{},"sourceSha256":"5c915a1032527c27967883101b0e8ad7b27c2723bc1026f9a6dfac6ffbdff48c","expected":false},{"name":"parenthesized-packed-array","source":"export const t00HParenthesized=[...([1,2])];","options":{},"sourceSha256":"03ad5ef30f6fe44d44209211cddc5a052d86b598d32219cfc042a7c2e33c7ec6","expected":true},{"name":"multiple-packed-spreads","source":"export const t00HMultiple=[...[1],...[2]];","options":{},"sourceSha256":"300343abe24b9be6c6d57f7c561ee1132fa5df763fa743866eddd351223fa034","expected":true},{"name":"optional-spread-call","source":"export const t00HOptional=t00HReceiver.method?.(...t00HItems);","options":{},"sourceSha256":"27f232edf4a891b2b2a92aad81d8460fb5dfe212f0c870c000c2f6d7c4e0dc5f","expected":true},{"name":"forin-empty-assignment","source":"export function t00HEmptyKeys(){for([] in t00HObject){}}","options":{"downlevelIteration":true},"sourceSha256":"3e3de377e35aee1e6c127d92ee4fbdcfc2b94a2cfbc4297ae3864713cbc54bc2","expected":false}]"###).unwrap();
        assert_es5_vectors(vectors);
    }

    #[test]
    fn es5_prior_transforms_and_module_gating_match_sdk_observation() {
        let vectors = serde_json::from_str(r###"[{"name":"module-commonjs","source":"class T00HModeBase{} export class T00HModeChild extends T00HModeBase{}","options":{"module":1},"sourceSha256":"e1f4daf58d8a7abec3280cf2eaf39d813e09078415334aa416875bd1ec3e4bae","expected":true},{"name":"module-amd","source":"class T00HModeBase{} export class T00HModeChild extends T00HModeBase{}","options":{"module":2},"sourceSha256":"e1f4daf58d8a7abec3280cf2eaf39d813e09078415334aa416875bd1ec3e4bae","expected":true},{"name":"module-umd","source":"class T00HModeBase{} export class T00HModeChild extends T00HModeBase{}","options":{"module":3},"sourceSha256":"e1f4daf58d8a7abec3280cf2eaf39d813e09078415334aa416875bd1ec3e4bae","expected":true},{"name":"module-system","source":"class T00HModeBase{} export class T00HModeChild extends T00HModeBase{}","options":{"module":4},"sourceSha256":"e1f4daf58d8a7abec3280cf2eaf39d813e09078415334aa416875bd1ec3e4bae","expected":false},{"name":"module-preserve","source":"class T00HModeBase{} export class T00HModeChild extends T00HModeBase{}","options":{"module":200},"sourceSha256":"e1f4daf58d8a7abec3280cf2eaf39d813e09078415334aa416875bd1ec3e4bae","expected":true},{"name":"module-node16","source":"class T00HModeBase{} export class T00HModeChild extends T00HModeBase{}","options":{"module":100},"sourceSha256":"e1f4daf58d8a7abec3280cf2eaf39d813e09078415334aa416875bd1ec3e4bae","expected":true},{"name":"module-nodenext","source":"class T00HModeBase{} export class T00HModeChild extends T00HModeBase{}","options":{"module":199},"sourceSha256":"e1f4daf58d8a7abec3280cf2eaf39d813e09078415334aa416875bd1ec3e4bae","expected":true},{"name":"js-commonjs-exports","source":"class T00HJSBase{} exports.Derived=class extends T00HJSBase{};","options":{"module":1,"allowJs":true},"sourceSha256":"40a55814c554a68f68159fa8799c70c45b91ec878cdacb7dd689082fb8487faf","expected":true,"fileName":"/repo/t00-es5-dev.js"},{"name":"ts-commonjs-exports","source":"class T00HTSBase{} exports.Derived=class extends T00HTSBase{};","options":{"module":1},"sourceSha256":"c78b454739e8e149c459b41154f6711d671275d3e270ab070629cd1c04513954","expected":false},{"name":"global-force-module","source":"class T00HForceBase{} class T00HForceChild extends T00HForceBase{}","options":{"moduleDetection":3},"sourceSha256":"3b1874a91c352b8034a39ef78723ad615746e12205de2be1dc3d3553048ba382","expected":true},{"name":"external-type-only","source":"import type {T00HPhantom} from \"./types\"; class T00HPhantomBase{} class T00HPhantomChild extends T00HPhantomBase{}","options":{"module":1},"sourceSha256":"b467e397ede21667f668a080cb6880a07322fe7aecea6e14123f75a8b8778829","expected":true},{"name":"jsx-classic-spread","source":"export const t00HView=<main {...t00HProps}/>;","options":{"jsx":2},"sourceSha256":"0f5d2d581148eafd7f9e45be593e8d4955b069b31dac558b84a27503d4fc5cfe","expected":true,"fileName":"/repo/t00-es5-dev.tsx"},{"name":"jsx-auto-spread","source":"export const t00HAuto=<main {...t00HProps}/>;","options":{"jsx":4},"sourceSha256":"501eebdcc992c37353bf0bcdd00e3b6978f857dba72ef883280993f18fa05e71","expected":true,"fileName":"/repo/t00-es5-dev.tsx"},{"name":"jsx-preserve-spread","source":"export const t00HPreserve=<main {...t00HProps}/>;","options":{"jsx":1},"sourceSha256":"4a6e1eb198c512b769a24c3826053a2afce9b964120efa49d545f0fc0a73dd30","expected":false,"fileName":"/repo/t00-es5-dev.tsx"},{"name":"class-computed-field","source":"export class T00HComputed {[t00HKey]=1}","options":{},"sourceSha256":"b2efa3f55225e4ba34de3b1f6094b038ca547bdcf05b887f0098100f2da2cc08","expected":false},{"name":"class-arrow-field","source":"export class T00HArrow {value=()=>this}","options":{},"sourceSha256":"23c4720e59852a7c03de6369e3187959439c36f9525fe3eedd0da4d6d5acf726","expected":false},{"name":"object-rest-array-binding","source":"export const {head:[t00HHead],...t00HTail}=t00HObject;","options":{"downlevelIteration":true},"sourceSha256":"437f2f3616c4dc484d6d56e68668ab9171a3f94cd7a471ba33509732bde631c3","expected":true},{"name":"async-generator","source":"export async function* t00HAsyncGenerator(){yield await t00HInput}","options":{},"sourceSha256":"7e9687d4ba73dcec2ad2070378089df111448d5cfc695553ae2543c37d8d39d2","expected":true},{"name":"default-export-anonymous-class","source":"export default class {value=1}","options":{},"sourceSha256":"51b25ada4a458a62fa6c3395a4acf431d5ceea265d05a20d95d410d1fc153b07","expected":false},{"name":"explicit-no-emit-helpers","source":"class T00HNoEmitBase{} export class T00HNoEmitChild extends T00HNoEmitBase{}","options":{"noEmitHelpers":true},"sourceSha256":"ed1e7227b54be3c08e98fa7e67ab1ae582fcc0b27e3bb8e738d17e878dde33f7","expected":true}]"###).unwrap();
        assert_es5_vectors(vectors);
    }
    #[test]
    fn es5_assign_requests_require_native_factory_provenance() {
        let vectors = serde_json::from_str(r###"[{"name":"user-object-assign","source":"export const t00HUserAssign=Object.assign({},t00HInput);","options":{},"sourceSha256":"5325e7c5b74eb0ba12c643a29df8f8e2c2e69cc749a05a4c7b1747193c9bd410","expected":false},{"name":"rewritten-user-object-assign","source":"export const t00HRewriteAssign=Object.assign({},t00HInput?.value);","options":{},"sourceSha256":"d4f17164e381335eb4284e7d26c65ff5683aed94ffa9e06767a09162e00bfb65","expected":false},{"name":"spread-user-object-assign","source":"export const t00HSpreadAssign=Object.assign(...t00HArgs);","options":{},"sourceSha256":"27da47583fab8206b2ed69160acf235cb5f676e6d7cdad25c3256fffb9a226fe","expected":false},{"name":"homonym-object-assign","source":"const Object={assign(...args){return args}};export const t00HShadow=Object.assign({},t00HInput);","options":{},"sourceSha256":"23f69a931ae2df70833afe04397c4a0c2bdb0392a876e7d56b16c2c0916b2292","expected":false},{"name":"class-user-object-assign","source":"export class T00HAssignField {value=Object.assign({},t00HInput?.value)}","options":{},"sourceSha256":"2c306dd7abe94c53f6b53cf81cdb7a58bfe61a83031c77612374239a3365cef2","expected":false},{"name":"object-spread","source":"export const t00HObjectSpread={...t00HInput};","options":{},"sourceSha256":"024f8ec747c40a0ba86749eabf650982503c7413010ba397f3b2050ecc248228","expected":true},{"name":"object-literal-spread","source":"export const t00HObjectLiteral={...{value:1}};","options":{},"sourceSha256":"c83d68f7bf79909a626af1839b8f8d0ade25e9046fab588477259ba666d3842e","expected":true},{"name":"jsx-literal-spread","source":"export const t00HSpreadLiteral=<main {...{value:1}}/>;","options":{"jsx":2},"sourceSha256":"7f1198dd59d4ac6d15a8234d10f2432af6e31e705d7d0c841dd0c1ed25aa623b","expected":false,"fileName":"/repo/t00-es5-dev.tsx"},{"name":"jsx-flattened-literal-spread","source":"export const t00HFlattenLiteral=<main {...{...{value:1}}}/>;","options":{"jsx":2},"sourceSha256":"1103c24d0db3bee46c1894ab45f63eac4900bd15d250d8d9dceba5b7a927b834","expected":false,"fileName":"/repo/t00-es5-dev.tsx"},{"name":"jsx-flattened-external-spread","source":"export const t00HFlattenExternal=<main {...{...t00HInput}}/>;","options":{"jsx":2},"sourceSha256":"23a2f0a0b1e1e8e9cf7b9e3ea67c87ba744e6e5eb9384411dfc65c6791300f1d","expected":true,"fileName":"/repo/t00-es5-dev.tsx"},{"name":"es2015-jsx-spread","source":"export const t00HNewerJSX=<main {...t00HInput}/>;","options":{"jsx":2,"target":2},"sourceSha256":"b4af5a4e9e6eda6a216fe823c599f85bbbcc525bec4c753d0c26ac9ddd51b46b","expected":false,"fileName":"/repo/t00-es5-dev.tsx"},{"name":"es2015-object-spread","source":"export const t00HNewerObject={...t00HInput};","options":{"target":2},"sourceSha256":"1a5c24e2ce2284a50bbee31f6ad8e932820cec75d22ff422360938b67ccd195c","expected":false},{"name":"system-global-manual","source":"require(\"tslib\");class T00HSystemBase{}class T00HSystemChild extends T00HSystemBase{}","options":{"module":4},"sourceSha256":"be66636bce725e0a3a5d304e91274d02059c476e4be3cdeed74d9f06c0536c24","expected":true},{"name":"system-dynamic-import-manual","source":"require(\"tslib\");import(\"./other\");class T00HDynamicBase{}class T00HDynamicChild extends T00HDynamicBase{}","options":{"module":4},"sourceSha256":"85987910bc8da83dbb0804c52d5b64f4918062efccf2a3d6792609a35eed8a14","expected":false}]"###).unwrap();
        assert_es5_vectors(vectors);
    }
    #[test]
    fn es5_assign_factory_provenance_survives_later_transforms() {
        let vectors = serde_json::from_str(r###"[{"name":"jsx-optional-spread","source":"export const t00HOptionalView=<main {...t00HMaybe?.props}/>;","options":{"jsx":2},"sourceSha256":"c89705660b7212dc2de35d9e22da72ee6e275b10a52a00ea6190f5b004c8ccd6","expected":true,"fileName":"/repo/t00-es5-dev.tsx"},{"name":"jsx-optional-attribute","source":"export const t00HOptionalAttribute=<main {...t00HProps} value={t00HMaybe?.value}/>;","options":{"jsx":2},"sourceSha256":"8f0c9b65f0be7b3c1618e813842b72ab9b9c88de59c3384b6c78eef89680720d","expected":true,"fileName":"/repo/t00-es5-dev.tsx"},{"name":"object-optional-spread","source":"export const t00HOptionalObject={...t00HMaybe?.props};","options":{},"sourceSha256":"69089c28fc10cf99df1fe6c0fb3ce4606056bc03b8094273c958dc6e843381a2","expected":true},{"name":"nested-user-and-generated-assign","source":"export const t00HNestedAssign=Object.assign({}, {...t00HProps});","options":{},"sourceSha256":"b178ceeb39ffdfb7f686e6f953f28ca960719afefd42a1a0e9094cea57778346","expected":true}]"###).unwrap();
        assert_es5_vectors(vectors);
    }
    #[test]
    fn es5_module_identity_uses_erased_stream_and_real_file_extension() {
        let vectors = serde_json::from_str(r###"[{"name":"mts-auto-module","source":"class T00HExtensionBase{} class T00HExtensionChild extends T00HExtensionBase{}","options":{"module":100},"sourceSha256":"228ac2347138b693d7957582409b05e69bb03a43a3709084ed7440e26e489857","expected":true,"fileName":"/repo/t00-es5-dev.mts"},{"name":"cts-auto-module","source":"class T00HExtensionBase{} class T00HExtensionChild extends T00HExtensionBase{}","options":{"module":100},"sourceSha256":"228ac2347138b693d7957582409b05e69bb03a43a3709084ed7440e26e489857","expected":true,"fileName":"/repo/t00-es5-dev.cts"},{"name":"js-esm-commonjs-expression","source":"class T00HBrowserBase{} exports.Derived=class extends T00HBrowserBase{};","options":{"module":99,"allowJs":true},"sourceSha256":"1dcc530401245e61e745634dad8b46b607ce424f75859127d1c21dfcf5837c8e","expected":false,"fileName":"/repo/t00-es5-dev.js"},{"name":"legacy-module-script","source":"class T00HExtensionBase{} class T00HExtensionChild extends T00HExtensionBase{}","options":{"moduleDetection":1},"sourceSha256":"228ac2347138b693d7957582409b05e69bb03a43a3709084ed7440e26e489857","expected":false},{"name":"classic-jsx-script","source":"class T00HExtensionBase{} class T00HExtensionChild extends T00HExtensionBase{};const view=<main/>;","options":{"jsx":2},"sourceSha256":"903107382de17f5e4c352f6e15a739ec6acee77a25cc59a4ef539d953cd74e13","expected":false,"fileName":"/repo/t00-es5-dev.tsx"},{"name":"automatic-jsx-script","source":"class T00HExtensionBase{} class T00HExtensionChild extends T00HExtensionBase{};const view=<main/>;","options":{"jsx":4},"sourceSha256":"903107382de17f5e4c352f6e15a739ec6acee77a25cc59a4ef539d953cd74e13","expected":true,"fileName":"/repo/t00-es5-dev.tsx"},{"name":"system-erased-import-type","source":"declare namespace T00HPhantom {const value:typeof import(\"./types\")} require(\"tslib\");class T00HExtensionBase{} class T00HExtensionChild extends T00HExtensionBase{}","options":{"module":4},"sourceSha256":"351da25169c6f150985761678729b17879893754f6801f72e42f70620e4a463c","expected":true},{"name":"system-erased-ambient-import","source":"declare namespace T00HAmbient {const value=import(\"./types\")} require(\"tslib\");class T00HExtensionBase{} class T00HExtensionChild extends T00HExtensionBase{}","options":{"module":4},"sourceSha256":"a6fa2cae861bc6fd5dc1078f787091fa66d445391db722217362a4c5d6d32d29","expected":true},{"name":"system-type-only-export","source":"import type {T00HPhantom} from \"./types\";class T00HExtensionBase{} class T00HExtensionChild extends T00HExtensionBase{}","options":{"module":4},"sourceSha256":"687c5dbd68fca35fb4b993549a3a8953bb1f73422c544b3b959c2905101ac861","expected":false},{"name":"cast-user-assign","source":"export const t00HCastAssign=(Object as any).assign({},t00HMaybe?.value);","options":{},"sourceSha256":"6eb08738b09796c339e271324ee3f9c6e949158d64158ef7de8363082533479d","expected":false}]"###).unwrap();
        assert_es5_vectors(vectors);
    }

    #[test]
    fn unavailable_source_cannot_establish_absence_of_helpers() {
        let value = inspect(Node::NIL, &CompilerOptions::default());
        assert!(value.reasons.is_empty());
        assert_eq!(
            value.unsupported,
            BTreeSet::from(["RUNTIME_CONFIGURATION_SOURCE_UNAVAILABLE".into()])
        );
        let requests =
            es5_helpers::collect(Node::NIL, &CompilerOptions::default(), &Default::default());
        assert!(requests.names.is_empty());
        assert_eq!(
            requests.unsupported,
            BTreeSet::from(["RUNTIME_HELPERS_ES5_TRANSFORMED_SOURCE_UNAVAILABLE".into()])
        );
        assert_eq!(
            es5_helpers::lower_template_import_surface("const t00HBrokenSurface = ;"),
            Err("RUNTIME_HELPERS_ES5_IMPORT_SURFACE_PARSE_UNAVAILABLE".into())
        );
    }
    #[test]
    fn es5_catch_patterns_and_preexisting_helpers_follow_sdk_boundaries() {
        let vectors = serde_json::from_str(r###"[{"name":"catch-array-iterator","source":"export function t00HCatch(){try{t00HInvoke()}catch([value]){return value}}","options":{"downlevelIteration":true},"sourceSha256":"a9030050ad263c3c93564f7380a1e20bf9637a505d50f370b665c2d7d6f244b7","expected":true},{"name":"catch-array-no-iterator","source":"export function t00HCatchPlain(){try{t00HInvoke()}catch([value]){return value}}","options":{},"sourceSha256":"81e1855365638af3d4d0e07a52243f64602f15377275187e943b68f0e7e6015c","expected":false},{"name":"system-es2015-async","source":"export async function t00HSystemAsync(){await t00HInput}","options":{"target":2,"module":4},"sourceSha256":"b0cc9b8e71c5002ac8d13059a957c723c9f5b7ccba8ade9812a289d6bd5d1fdd","expected":false},{"name":"commonjs-es2015-async","source":"export async function t00HCJSAsync(){await t00HInput}","options":{"target":2,"module":1},"sourceSha256":"c852e68ee4af1c5cf689c546f9357353c301177ea8ddd4f71460f5d237a76e7a","expected":true},{"name":"system-es2015-manual-async","source":"require(\"tslib\");async function t00HGlobalAsync(){await t00HInput}","options":{"target":2,"module":4},"sourceSha256":"f4a3d91889d21cbb4df03b249ff5985849af1cd3f926b71d193ed3d812083c11","expected":true},{"name":"tagged-invalid-escape","source":"export const t00HInvalidTagged=t00HTag`\\unicode`;","options":{},"sourceSha256":"4f58aac83c4f4e81d3fcfba782c2405a75b781fef9bf63ae7b26b0c02b8ba42e","expected":true}]"###).unwrap();
        assert_es5_vectors(vectors);
    }
    #[test]
    fn es5_template_lowering_exposes_imports_in_substitution_expressions() {
        let vectors = serde_json::from_str(r###"[{"name":"lowered-template-require","source":"class T00HTemplateBase{}class T00HTemplateChild extends T00HTemplateBase{};const message=`${require(\"tslib\")}`;","options":{},"sourceSha256":"eb69e9e3d412c03383b93c90931bea85cb1ef8a7493fbf8541b8830b6e8c3ece","expected":true},{"name":"lowered-template-regex","source":"class T00HTemplateBase{}class T00HTemplateChild extends T00HTemplateBase{};const message=`${/require(\"tslib\")/}`;","options":{},"sourceSha256":"8c4d56eb3e4644b28aa5109e26c5d8a079cc072bbedc04f702242d6a715553ef","expected":true},{"name":"lowered-template-string","source":"class T00HTemplateBase{}class T00HTemplateChild extends T00HTemplateBase{};const message=`${\"require(\\\"tslib\\\")\"}`;","options":{},"sourceSha256":"6ea39b46689698bcc1894fe02ae44c5e75982544c2e4da7ba8398af2abca859b","expected":false},{"name":"lowered-template-define","source":"class T00HTemplateBase{}class T00HTemplateChild extends T00HTemplateBase{};const message=`${define([\"tslib\"],()=>{})}`;","options":{},"sourceSha256":"008360f60fa8ac005edccfa7320da8d30b9e7c072bbc9c5a090cf9e59ad5cb56","expected":true},{"name":"lowered-template-nested","source":"class T00HTemplateBase{}class T00HTemplateChild extends T00HTemplateBase{};const message=`${`inner ${require(\"tslib\")}`}`;","options":{},"sourceSha256":"59e6814d6fee475ddfa750820fba73d20549987f6fb371617f55dc77611550eb","expected":true},{"name":"lowered-tagged-require","source":"class T00HTemplateBase{}class T00HTemplateChild extends T00HTemplateBase{};const message=t00HTag`raw ${require(\"tslib\")}`;","options":{},"sourceSha256":"53a44577509a57c8fba480e0e69ec927f8d8508f37008c205249a17922fdd384","expected":true},{"name":"lowered-template-no-helper","source":"const message=`${require(\"tslib\")}`;","options":{},"sourceSha256":"6b79794dd9206a730cc80644e23630ef69c85ae54be810c6649ad7abd95fad90","expected":false},{"name":"lowered-template-raw-text","source":"class T00HTemplateBase{}class T00HTemplateChild extends T00HTemplateBase{};const message=`require(\"tslib\")`;","options":{},"sourceSha256":"d44938c37232f30d32b733d181462007b35f6c48a2e8b68c2cec2dc6f28809da","expected":false}]"###).unwrap();
        assert_es5_vectors(vectors);
    }
    #[test]
    fn es5_template_surface_preserves_scanner_literal_and_argument_boundaries() {
        let vectors = serde_json::from_str(r###"[{"name":"template-module-head","source":"class T00HSurfaceBase{}class T00HSurfaceChild extends T00HSurfaceBase{};const result=require(`tslib${suffix}`);","options":{},"sourceSha256":"227140f702b60e5b73d814a1e7c96578bd1f14a73bee13e0ea5d7fea44726ce2","expected":true},{"name":"template-other-head","source":"class T00HSurfaceBase{}class T00HSurfaceChild extends T00HSurfaceBase{};const result=require(`other${\"tslib\"}`);","options":{},"sourceSha256":"40de8194f4792dbdb49bb4bddde5dde55c7850d1812efae6292fa2103f3d68d5","expected":false},{"name":"template-define-head","source":"class T00HSurfaceBase{}class T00HSurfaceChild extends T00HSurfaceBase{};define([`tslib${suffix}`],()=>{});","options":{},"sourceSha256":"e82df0b54c8b847d7d5ff7109b084841038a7aaba84e9c28ab8162d68d3ae368","expected":true},{"name":"tag-require-first-substitution","source":"class T00HSurfaceBase{}class T00HSurfaceChild extends T00HSurfaceBase{};const result=require`raw ${\"tslib\"}`;","options":{},"sourceSha256":"43ad31123d4c9a6bcb0b015ac68241a888a90b6ce108fd9689323e73c56de4cf","expected":false},{"name":"tag-define-first-substitution","source":"class T00HSurfaceBase{}class T00HSurfaceChild extends T00HSurfaceBase{};const result=define`raw ${[\"tslib\"]}`;","options":{},"sourceSha256":"86ee7b931061d73b640d6b277df28ebf02154ecf6cf9bbcf79207b520f57c4fb","expected":false},{"name":"template-regex-brace","source":"class T00HSurfaceBase{}class T00HSurfaceChild extends T00HSurfaceBase{};const result=`${/}/.test(value)&&require(\"tslib\")}`;","options":{},"sourceSha256":"fa2f1ccf6114ccd120a512159c46cbe6a4821c8f820adcf3830d7e034a9f90d6","expected":true},{"name":"template-unicode-prefix","source":"class T00HSurfaceBase{}class T00HSurfaceChild extends T00HSurfaceBase{};const result=`\u00e9 ${require(\"tslib\")}`;","options":{},"sourceSha256":"c106864d76d69ac080a06df71e4a87e31d4191e89f494c0417b9783cd5aa34bd","expected":true},{"name":"template-object-call","source":"class T00HSurfaceBase{}class T00HSurfaceChild extends T00HSurfaceBase{};const result=`${require({a:1})} ${require(\"tslib\")}`;","options":{},"sourceSha256":"c3d316ed6ce291e2bbe102677eb06ab6f555d72895a9f0a633f23e7adff40d41","expected":true},{"name":"template-escaped-head","source":"class T00HSurfaceBase{}class T00HSurfaceChild extends T00HSurfaceBase{};const result=require(`t\\x73lib${suffix}`);","options":{},"sourceSha256":"321d295fdc67924a4828760420d275132d501a201083127b75275d6c0c0b6570","expected":true}]"###).unwrap();
        assert_es5_vectors(vectors);
    }
    #[test]
    fn helper_metadata_respects_sdk_module_interop_options() {
        let vectors = serde_json::from_str(r###"[{"name":"interop-cjs-default","source":"import * as T00HInterop from \"./dep\";export const answer=T00HInterop.answer;","options":{"module":1},"sourceSha256":"8016ec83f8aef125ecb9c0714e66d1a3f1e811e49aa8082139c522defae7273e","expected":false},{"name":"interop-cjs-explicit","source":"import * as T00HInterop from \"./dep\";export const answer=T00HInterop.answer;","options":{"module":1,"esModuleInterop":true},"sourceSha256":"8016ec83f8aef125ecb9c0714e66d1a3f1e811e49aa8082139c522defae7273e","expected":true},{"name":"interop-node16-disabled","source":"import * as T00HInterop from \"./dep\";export const answer=T00HInterop.answer;","options":{"module":100,"esModuleInterop":false},"sourceSha256":"8016ec83f8aef125ecb9c0714e66d1a3f1e811e49aa8082139c522defae7273e","expected":false},{"name":"interop-export-star","source":"export * from \"./dep\";","options":{"module":1},"sourceSha256":"feca3bbdd1c641a057a77dd8eecd2cd714974472aa921c4f7b23cba68232e42e","expected":true},{"name":"interop-named-reexport","source":"export {answer} from \"./dep\";","options":{"module":1},"sourceSha256":"bae7d3f186055ae7f410de85bb03fbd86eda96b3a282463f8a47422bf0508dbd","expected":false},{"name":"interop-dynamic-default","source":"export const t00HDynamic=import(\"./dep\");","options":{"module":1},"sourceSha256":"6e73283f8a604b3628d60ab2b417066409293be6b610c661a6891a43c7e36beb","expected":false},{"name":"interop-es2015-default","source":"import * as T00HInterop from \"./dep\";export const answer=T00HInterop.answer;","options":{"module":1,"target":2},"sourceSha256":"8016ec83f8aef125ecb9c0714e66d1a3f1e811e49aa8082139c522defae7273e","expected":false},{"name":"interop-es2015-enabled","source":"import * as T00HInterop from \"./dep\";export const answer=T00HInterop.answer;","options":{"module":1,"target":2,"esModuleInterop":true},"sourceSha256":"8016ec83f8aef125ecb9c0714e66d1a3f1e811e49aa8082139c522defae7273e","expected":true}]"###).unwrap();
        assert_es5_vectors(vectors);
    }
    #[test]
    fn es5_review1_preserves_cooked_template_tails_for_define_scanner() {
        let vectors = serde_json::from_str(r###"[{"name":"review1-tail-positive","source":"class T00ReviewBase{} class T00ReviewChild extends T00ReviewBase{};define([`${value}tslib`],()=>{});","options":{},"fileName":"/repo/t00-review.ts","sourceSha256":"000184a0cbfe293a66ccc496826609196d2c3750bbc0940e95419b889e7b76b1","expected":true},{"name":"review1-tail-control","source":"class T00ReviewBase{} class T00ReviewChild extends T00ReviewBase{};define([`${value}other`],()=>{});","options":{},"fileName":"/repo/t00-review.ts","sourceSha256":"c3a25c14d5bd55626b4d050487bf6a0fae58ec6ad29a294b95e7a52e07eac61c","expected":false},{"name":"review1-middle-positive","source":"class T00ReviewBase{} class T00ReviewChild extends T00ReviewBase{};define([`prefix${first}tslib${second}tail`],()=>{});","options":{},"fileName":"/repo/t00-review.ts","sourceSha256":"f7b232a9a1061ca800259f74582a4691ae8633cd3d8f89478fe6b2ed784dd4ff","expected":true},{"name":"review1-cooked-tail-positive","source":"class T00ReviewBase{} class T00ReviewChild extends T00ReviewBase{};define([`${value}t\\x73lib`],()=>{});","options":{},"fileName":"/repo/t00-review.ts","sourceSha256":"1938ecd3f26344087f7ed3f734a30c779106836db7899cff133221a07db385c5","expected":true},{"name":"review1-empty-tail-control","source":"class T00ReviewBase{} class T00ReviewChild extends T00ReviewBase{};define([`${value}`],()=>{});","options":{},"fileName":"/repo/t00-review.ts","sourceSha256":"6d59e1ed5b150a63a7df5fbb4b4d6bb3b68207440cf53e81ab51417290c51566","expected":false}]"###).unwrap();
        assert_es5_vectors(vectors);
    }

    #[test]
    fn es5_review2_preserves_tagged_template_array_barriers_for_define_scanner() {
        let vectors = serde_json::from_str(r###"[{"name":"review2-substitution-negative","source":"define([tag`raw${\"tslib\"}`],()=>{});","options":{},"fileName":"/repo/t00-review.ts","sourceSha256":"3e5a05c285d348df622c9aa3829e05d9b5f83b96b437deb9f0d25fda35f14d45","expected":false},{"name":"review2-head-positive","source":"define([tag`tslib${value}`],()=>{});","options":{},"fileName":"/repo/t00-review.ts","sourceSha256":"a043c04919730bb0182166b0ead0a3ab350e2a2633616e52e99048b94bc6cc8b","expected":true},{"name":"review2-tail-positive","source":"define([tag`raw${value}tslib`],()=>{});","options":{},"fileName":"/repo/t00-review.ts","sourceSha256":"eea4ba3e62eb9b01d7e8f89ba0024ecb28918d93795f258add0058e29a27a735","expected":true},{"name":"review2-cooked-head-positive","source":"define([tag`t\\x73lib${value}`],()=>{});","options":{},"fileName":"/repo/t00-review.ts","sourceSha256":"04792bd9bd95337517eac0651a5134f6009ca78ba412e74b68a34bd1537e8690","expected":true},{"name":"review2-array-substitution-negative","source":"define([tag`raw${[\"tslib\"]}`],()=>{});","options":{},"fileName":"/repo/t00-review.ts","sourceSha256":"5c973814b6b1d34b53bc4349c276f6d6ba384d9d7a2bea174348750ae3be31e6","expected":false},{"name":"review2-no-substitution-barrier-negative","source":"define([tag`raw`,\"tslib\"],()=>{});","options":{},"fileName":"/repo/t00-review.ts","sourceSha256":"5cac564c85ba6a44a5d3df9722a58795f4af82b97c82cbaf4c96ed9b3cdf24e0","expected":false},{"name":"review2-no-substitution-positive","source":"define([tag`tslib`],()=>{});","options":{},"fileName":"/repo/t00-review.ts","sourceSha256":"fc5cdaebe8343bb5f84e13c0408fb37e27245eddb9424b6b5abe10726e919ec2","expected":true},{"name":"review2-direct-tag-control","source":"define`tslib${value}`;","options":{},"fileName":"/repo/t00-review.ts","sourceSha256":"7346c74935dfb0aaed85ef453c59523c113134ea5188a8ed1f8688103239c7fe","expected":false},{"name":"review2-require-substitution-positive","source":"define([tag`raw${require(\"tslib\")}`],()=>{});","options":{},"fileName":"/repo/t00-review.ts","sourceSha256":"bd42efcce0c94d05e5b8036dcc29934d08a4aa0493892e0523849d42ce74bce2","expected":true},{"name":"review2-invalid-cooked-control","source":"define([tag`\\unicode${\"tslib\"}`],()=>{});","options":{},"fileName":"/repo/t00-review.ts","sourceSha256":"7b9a14d31019821a6f7e226ab06048893d910326d2c0fec96a9cac7b26bbe731","expected":false}]"###).unwrap();
        assert_es5_vectors(vectors);
    }
}
