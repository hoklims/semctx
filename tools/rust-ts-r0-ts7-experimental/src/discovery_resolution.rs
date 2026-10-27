use super::*;
use ts_goport::frontend::module::{self, Resolver, ResolverOptions};

struct ConfinedFs {
    base: Rc<dyn Fs>,
    root: PathBuf,
    logical_root: PathBuf,
    outside: RefCell<BTreeSet<String>>,
    errors: RefCell<Vec<String>>,
    probes: RefCell<Vec<serde_json::Value>>,
    read_bytes: RefCell<usize>,
}
impl ConfinedFs {
    fn admitted(&self, path: &str) -> bool {
        let target = lexical(Path::new(&resolver_path(path)));
        if !target.starts_with(&self.logical_root) {
            return false;
        }
        match physical(&target) {
            Ok(actual) if actual.starts_with(&self.root) => true,
            Ok(_) => {
                self.outside.borrow_mut().insert(path.into());
                false
            }
            Err(error) => {
                self.errors.borrow_mut().push(error);
                false
            }
        }
    }
    fn record(&self, operation: &str, path: &str, found: bool) {
        self.probes
            .borrow_mut()
            .push(serde_json::json!({"operation":operation,"path":path,"found":found}));
    }
}
impl Fs for ConfinedFs {
    fn use_case_sensitive_file_names(&self) -> bool {
        self.base.use_case_sensitive_file_names()
    }
    fn file_exists(&self, path: &str) -> bool {
        if !lexical(Path::new(&resolver_path(path))).starts_with(&self.logical_root)
            && Path::new(path)
                .file_name()
                .is_some_and(|name| name != "package.json")
            && self.base.file_exists(&resolver_path(path))
        {
            self.outside.borrow_mut().insert(path.into());
        }
        let found = self.admitted(path) && self.base.file_exists(&resolver_path(path));
        self.record("file_exists", path, found);
        found
    }
    fn directory_exists(&self, path: &str) -> bool {
        let found = self.admitted(path) && self.base.directory_exists(&resolver_path(path));
        self.record("directory_exists", path, found);
        found
    }
    fn read_file(&self, path: &str) -> (String, bool) {
        if !self.admitted(path) {
            self.record("read_file", path, false);
            return (String::new(), false);
        }
        let read = fs::File::open(resolver_path(path)).and_then(|file| {
            let mut bytes = vec![];
            file.take(33_554_433).read_to_end(&mut bytes)?;
            Ok(bytes)
        });
        let bytes = match read {
            Ok(bytes) => bytes,
            Err(error) => {
                if error.kind() != std::io::ErrorKind::NotFound {
                    self.errors
                        .borrow_mut()
                        .push(format!("DISCOVERY_RESOLUTION_READ_FAILED:{error}"));
                }
                self.record("read_file", path, false);
                return (String::new(), false);
            }
        };
        let mut total = self.read_bytes.borrow_mut();
        *total = total.saturating_add(bytes.len());
        if *total > 33_554_432 {
            self.errors
                .borrow_mut()
                .push("DISCOVERY_RESOLUTION_CAPTURE_LIMIT".into());
            self.record("read_file", path, false);
            return (String::new(), false);
        }
        self.probes.borrow_mut().push(serde_json::json!({"operation":"read_file","path":path,"found":true,"raw_bytes_sha256":identity::digest_bytes(&bytes)}));
        (
            source_text::decode(&bytes, source_text::ReadProfile::CompilerSystem),
            true,
        )
    }
    fn get_accessible_entries(&self, path: &str) -> Entries {
        let found = self.admitted(path) && self.base.directory_exists(&resolver_path(path));
        self.record("directory_entries", path, found);
        if found {
            self.base.get_accessible_entries(&resolver_path(path))
        } else {
            Entries {
                files: vec![],
                directories: vec![],
                symlinks: Some(Default::default()),
            }
        }
    }
    fn stat(&self, path: &str) -> Option<FileInfo> {
        let info = self
            .admitted(path)
            .then(|| self.base.stat(&resolver_path(path)))
            .flatten();
        self.record("stat", path, info.is_some());
        info
    }
    fn realpath(&self, path: &str) -> String {
        let found = self.admitted(path) && self.base.stat(&resolver_path(path)).is_some();
        self.record("realpath", path, found);
        if found {
            resolver_path(&self.base.realpath(&resolver_path(path)))
        } else {
            resolver_path(path)
        }
    }
    fn write_file(&self, _: &str, _: &str) -> Result<(), FsError> {
        Err(FsError::Permission)
    }
    fn append_file(&self, _: &str, _: &str) -> Result<(), FsError> {
        Err(FsError::Permission)
    }
    fn remove(&self, _: &str) -> Result<(), FsError> {
        Err(FsError::Permission)
    }
    fn chtimes(
        &self,
        _: &str,
        _: Option<SystemTime>,
        _: Option<SystemTime>,
    ) -> Result<(), FsError> {
        Err(FsError::Permission)
    }
}

pub(super) fn outside(
    root: &Path,
    path: &Path,
    specifier: &str,
    probes: &mut Vec<serde_json::Value>,
) -> Result<bool, String> {
    let fs = Rc::new(ConfinedFs {
        base: ts_goport::frontend::vfs::osvfs_fs(),
        root: root.to_path_buf(),
        logical_root: PathBuf::from(resolver_path(&path_text(root)?)),
        outside: RefCell::new(BTreeSet::new()),
        errors: RefCell::new(vec![]),
        probes: RefCell::new(vec![]),
        read_bytes: RefCell::new(0),
    });
    let options = compiler_options();
    let resolver: Rc<dyn Resolver> = Rc::new(module::new_resolver(ResolverOptions {
        host: Some(Rc::new(tsoptions::ResolverHost {
            fs: fs.clone(),
            current_directory: resolver_path(&path_text(root)?),
        })),
        compiler_options: Some(Rc::new(options)),
        ..Default::default()
    }));
    let (found, diagnostics, error) = resolver.resolve_module_name(
        specifier,
        &resolver_path(&path_text(path)?),
        ModuleKind::NONE,
        None,
    );
    probes.extend(fs.probes.borrow().iter().cloned());
    if let Some(error) = fs.errors.borrow().first() {
        return Err(error.clone());
    }
    if let Some(error) = error {
        return Err(format!("DISCOVERY_NATIVE_MODULE_RESOLUTION_FAILED:{error}"));
    }
    if !diagnostics.is_empty() {
        return Err("DISCOVERY_NATIVE_MODULE_RESOLUTION_DIAGNOSTICS".into());
    }
    if !fs.outside.borrow().is_empty() {
        return Ok(true);
    }
    found
        .filter(|found| !found.resolved_file_name.is_empty())
        .map(|found| {
            physical(Path::new(&resolver_path(&found.resolved_file_name)))
                .map(|actual| !actual.starts_with(root))
        })
        .transpose()
        .map(|outside| outside.unwrap_or(false))
}

fn resolver_path(path: &str) -> String {
    native_paths::compiler_path(path)
}

#[cfg(test)]
#[path = "../tests/unit/discovery_resolution.rs"]
mod tests;
