use std::rc::Rc;
use ts_goport::{ast, core, frontend::compiler, program};

pub(super) fn frontend(
    options: compiler::ProgramOptions,
    fs: &crate::CaptureFs,
) -> Rc<compiler::NewProgram> {
    ast::set_editor_process();
    for path in fs.files.keys() {
        ast::note_published_path(path);
    }
    let frontend = Rc::new(compiler::new_program(options));
    for file in frontend.get_source_files() {
        if file.version.get().is_none()
            && !ast::is_published(file.store)
            && ast::freeable_path(&file.path().0)
        {
            let _ = file.version.set(ast::FileVersion::new(file.store));
        }
    }
    frontend
}

pub(super) struct NativeProgram {
    version: &'static core::GoProgram,
    current: Option<core::ProgramScope>,
}

impl NativeProgram {
    pub(super) fn enter(frontend: &Rc<compiler::NewProgram>) -> Self {
        let version = program::new_program_version(frontend, None);
        Self {
            version,
            current: Some(core::enter_program(Some(version))),
        }
    }
}

impl Drop for NativeProgram {
    fn drop(&mut self) {
        drop(self.current.take());
        program::release_program(self.version);
    }
}

#[cfg(test)]
#[path = "../tests/unit/native_program.rs"]
mod tests;
