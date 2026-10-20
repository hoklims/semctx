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
    astnav,
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
    pub emission: EmissionObservation,
}

#[derive(Debug, Default, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum EmissionObservation {
    #[default]
    NotRequested,
    Unavailable {
        reason: String,
    },
    Observed {
        observation: EmitObservation,
    },
}

pub fn inspect(source: Node, options: &CompilerOptions) -> RuntimeConfiguration {
    let mut result = RuntimeConfiguration::default();
    if source.is_nil() {
        result.emission = EmissionObservation::Unavailable {
            reason: "RUNTIME_CONFIGURATION_SOURCE_UNAVAILABLE".into(),
        };
        result
            .unsupported
            .insert("RUNTIME_CONFIGURATION_SOURCE_UNAVAILABLE".into());
        return result;
    }
    let mut spans = BTreeSet::new();
    collect_jsx_spans(source, source, &mut spans);
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
            result.emission = EmissionObservation::Observed { observation };
        }
        Err(reason) => {
            result.unsupported.insert(reason.clone());
            result.emission = EmissionObservation::Unavailable { reason };
        }
    }
    result
}

struct EmitAttempt {
    observation: Result<EmitObservation, String>,
    fs_probes: Vec<serde_json::Value>,
}

#[derive(Debug, Serialize)]
pub struct EmitObservation {
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

fn collect_jsx_spans(node: Node, source: Node, spans: &mut BTreeSet<(i32, i32)>) {
    if matches!(
        node.kind(),
        SyntaxKind::JsxElement | SyntaxKind::JsxSelfClosingElement | SyntaxKind::JsxFragment
    ) {
        spans.insert((astnav::get_start_of_node(node, source, false), node.end()));
    }
    for child in node.iter_children() {
        collect_jsx_spans(child, source, spans);
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
        crate::native_program::frontend(
            compiler::ProgramOptions {
                host,
                config,
                use_source_of_project_reference: false,
                single_threaded: Tristate::True,
                typings_location: String::new(),
                project_name: String::new(),
                create_module_resolver: None,
                skip_module_resolution: true,
            },
            &fs,
        )
    };
    let result = {
        let _current = crate::native_program::NativeProgram::enter(&frontend);
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
        collect_jsx_spans(source, source, &mut spans);
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
#[path = "../tests/unit/runtime_configuration.rs"]
mod tests;
