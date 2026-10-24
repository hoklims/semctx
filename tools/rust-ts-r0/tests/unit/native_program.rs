use super::*;
use std::collections::BTreeMap;
use ts_goport::options::Tristate;

fn frontend() -> super::super::NativeFrontend {
    let fs = Rc::new(super::super::CaptureFs::new(
        BTreeMap::from([("/repo/owned.ts".into(), "export const owned = 1;".into())]),
        true,
    ));
    let mut options = super::super::compiler_options();
    options.no_lib = Tristate::True;
    super::super::native_frontend_with_options(
        fs,
        "/repo",
        "/sdk/lib",
        vec!["/repo/owned.ts".into()],
        false,
        options,
    )
}

#[test]
fn program_scope_releases_native_tables_and_frontend() {
    let frontend = frontend();
    let weak = Rc::downgrade(&frontend.program);
    let tables = {
        let scope = NativeProgram::enter(&frontend.program);
        program::bind_all();
        let tables = program::version_tables_probe(scope.version).unwrap();
        assert!(!tables.is_freed());
        tables
    };
    assert!(
        tables.is_freed(),
        "native version tables outlived their scope"
    );
    drop(frontend);
    assert!(
        weak.upgrade().is_none(),
        "native registry retained frontend"
    );
}

#[test]
fn program_scope_releases_native_tables_on_early_error() {
    fn fail(frontend: &crate::NativeFrontend) -> Result<(), program::VersionTablesProbe> {
        let scope = NativeProgram::enter(&frontend.program);
        Err(program::version_tables_probe(scope.version).unwrap())
    }
    let frontend = frontend();
    let weak = Rc::downgrade(&frontend.program);
    assert!(fail(&frontend).unwrap_err().is_freed());
    drop(frontend);
    assert!(weak.upgrade().is_none());
    assert!(core::try_prog().is_none());
}

#[test]
fn program_scope_unwind_releases_child_and_restores_live_parent() {
    let parent = frontend();
    let parent_scope = NativeProgram::enter(&parent.program);
    let parent_tables = program::version_tables_probe(parent_scope.version).unwrap();
    let child = frontend();
    let child_weak = Rc::downgrade(&child.program);
    let mut child_tables = None;
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let child_scope = NativeProgram::enter(&child.program);
        child_tables = program::version_tables_probe(child_scope.version);
        program::bind_all();
        panic!("development unwind");
    }));
    assert!(result.is_err());
    assert!(child_tables.unwrap().is_freed());
    assert!(!parent_tables.is_freed());
    assert!(std::ptr::eq(core::prog(), parent_scope.version));
    program::bind_all();
    drop(child);
    assert!(child_weak.upgrade().is_none());
    drop(parent_scope);
    assert!(parent_tables.is_freed());
    assert!(core::try_prog().is_none());
}

#[test]
fn repeated_frontend_releases_native_file_version() {
    let first_file = {
        let first = frontend();
        let _scope = NativeProgram::enter(&first.program);
        program::bind_all();
        ast::file_version_probe(program::get_source_file("/repo/owned.ts"))
            .expect("first native parse retained a static file version")
    };
    assert!(first_file.is_freed());
    let next = frontend();
    let scope = NativeProgram::enter(&next.program);
    program::bind_all();
    let source = program::get_source_file("/repo/owned.ts");
    assert!(!source.is_nil());
    let file = ts_goport::ast::file_version_probe(source)
        .expect("repeated native parse retained a static file version");
    assert!(!file.is_freed());
    drop(scope);
    drop(next);
    assert!(file.is_freed(), "native file version outlived its frontend");
}
