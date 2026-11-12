use super::*;
use configuration::System;

#[derive(Default)]
pub(super) struct Cache(RefCell<BTreeMap<(String, Vec<String>), Inspection>>);

#[derive(Clone, Serialize)]
struct Read {
    path: String,
    content: Option<String>,
    consumed_before_delegate: bool,
}

#[derive(Clone, Serialize)]
struct Inspection {
    reasons: Vec<String>,
    consumed: BTreeSet<String>,
    reads: Vec<Read>,
    cached: bool,
}

struct RecordingSystem {
    fs: Rc<dyn System>,
    consumed: Rc<RefCell<BTreeSet<String>>>,
    reads: RefCell<Vec<Read>>,
}

impl System for RecordingSystem {
    fn key(&self, path: &str) -> String {
        self.fs.key(path)
    }
    fn probes(&self) -> Rc<RefCell<Vec<Probe>>> {
        self.fs.probes()
    }
    fn configuration_exists(&self, path: &str) -> bool {
        self.fs.configuration_exists(path)
    }
    fn workspace_profile(&self) -> bool {
        self.fs.workspace_profile()
    }
    fn sensitive(&self) -> bool {
        self.fs.sensitive()
    }
    fn contained(&self, root: &str, path: &str) -> bool {
        self.fs.contained(root, path)
    }
}

impl Fs for RecordingSystem {
    fn use_case_sensitive_file_names(&self) -> bool {
        self.fs.use_case_sensitive_file_names()
    }
    fn file_exists(&self, path: &str) -> bool {
        self.fs.file_exists(path)
    }
    fn read_file(&self, path: &str) -> (String, bool) {
        let key = normalized(self.fs.as_ref(), "/", path);
        self.consumed.borrow_mut().insert(key.clone());
        let before = self.consumed.borrow().contains(&key);
        let (text, found) = self.fs.read_file(path);
        self.reads.borrow_mut().push(Read {
            path: key,
            content: found.then(|| text.clone()),
            consumed_before_delegate: before,
        });
        (text, found)
    }
    fn directory_exists(&self, path: &str) -> bool {
        self.fs.directory_exists(path)
    }
    fn get_accessible_entries(&self, path: &str) -> Entries {
        self.fs.get_accessible_entries(path)
    }
    fn stat(&self, path: &str) -> Option<FileInfo> {
        self.fs.stat(path)
    }
    fn realpath(&self, path: &str) -> String {
        self.fs.realpath(path)
    }
    fn write_file(&self, path: &str, text: &str) -> Result<(), FsError> {
        self.fs.write_file(path, text)
    }
    fn append_file(&self, path: &str, text: &str) -> Result<(), FsError> {
        self.fs.append_file(path, text)
    }
    fn remove(&self, path: &str) -> Result<(), FsError> {
        self.fs.remove(path)
    }
    fn chtimes(
        &self,
        path: &str,
        access: Option<SystemTime>,
        modified: Option<SystemTime>,
    ) -> Result<(), FsError> {
        self.fs.chtimes(path, access, modified)
    }
}

fn resolved_source(root: &str, path: &str) -> String {
    let absolute = if path.starts_with('/') {
        path.to_owned()
    } else {
        format!("{root}/{path}")
    };
    let mut parts = vec![];
    for part in absolute.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            _ => parts.push(part),
        }
    }
    format!("/{}", parts.join("/"))
}

fn normalized(fs: &dyn System, root: &str, path: &str) -> String {
    let result = resolved_source(root, path).replace('\\', "/");
    if fs.sensitive() {
        result
    } else {
        result.to_lowercase()
    }
}

fn named(path: &str) -> bool {
    let path = path.replace('\\', "/");
    let name = path.rsplit('/').next().unwrap_or_default();
    name.starts_with("tsconfig") && name.ends_with(".json") && name.len() > "tsconfig.json".len()
}

fn source(path: &str) -> bool {
    matches!(
        path.rsplit('.').next(),
        Some(
            "ts" | "tsx"
                | "js"
                | "jsx"
                | "mts"
                | "mtsx"
                | "cts"
                | "ctsx"
                | "mjs"
                | "mjsx"
                | "cjs"
                | "cjsx"
        )
    )
}

fn inspect(
    cache: &Cache,
    fs: Rc<dyn System>,
    root: &str,
    paths: &[String],
) -> Result<Inspection, String> {
    let mut ordered = paths.to_vec();
    ordered.sort();
    let key = (fs.key(root), ordered);
    if let Some(cached) = cache.0.borrow().get(&key) {
        let mut result = cached.clone();
        result.cached = true;
        result.reads.clear();
        return Ok(result);
    }
    let named_paths = paths
        .iter()
        .filter(|path| named(path))
        .map(|path| normalized(fs.as_ref(), root, path))
        .collect::<BTreeSet<_>>();
    let system = Rc::new(RecordingSystem {
        fs,
        consumed: Rc::new(RefCell::new(BTreeSet::new())),
        reads: RefCell::new(vec![]),
    });
    if !named_paths.is_empty() {
        let mut governing = BTreeMap::new();
        for path in paths.iter().filter(|path| source(path)) {
            let path = resolved_source(root, path);
            if let Some(config) = configuration::find_configuration(system.as_ref(), &path) {
                governing.entry(system.key(&config)).or_insert(path);
            }
        }
        for path in governing.values() {
            configuration::inspect_system(system.clone(), path, root)?;
        }
    }
    let consumed = system.consumed.borrow().clone();
    let reasons = if named_paths.iter().any(|path| !consumed.contains(path)) {
        vec!["SOURCE_NAMED_CONFIGURATION_UNSUPPORTED".into()]
    } else {
        vec![]
    };
    let result = Inspection {
        reasons,
        consumed,
        reads: system.reads.borrow().clone(),
        cached: false,
    };
    cache.0.borrow_mut().insert(key, result.clone());
    Ok(result)
}

pub(super) fn inspect_captured(
    fs: Rc<CaptureFs>,
    root: &str,
    paths: &[String],
) -> Result<Vec<String>, String> {
    inspect(&fs.named_cache, fs.clone(), root, paths).map(|result| result.reasons)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Snapshot {
    files: BTreeMap<String, String>,
    paths: Option<Vec<String>>,
    #[serde(default)]
    read_failures: Vec<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    root: String,
    snapshots: Vec<Snapshot>,
    passes: Vec<usize>,
}

struct CapturedSnapshot {
    fs: Rc<CaptureFs>,
    paths: Vec<String>,
}

fn capture(snapshot: Snapshot, root: &str, sensitive: bool) -> Result<CapturedSnapshot, String> {
    let normalizer = CaptureFs::new(BTreeMap::new(), sensitive);
    let paths = snapshot
        .paths
        .unwrap_or_else(|| snapshot.files.keys().cloned().collect());
    let mut files = BTreeMap::new();
    for (path, text) in snapshot.files {
        let key = normalized(&normalizer, root, &path);
        if !configuration::System::contained(&normalizer, root, &key) {
            return Err("NAMED_CONFIGURATION_INPUT_OUTSIDE_REPOSITORY".into());
        }
        if files.get(&key).is_some_and(|existing| existing != &text) {
            return Err("NAMED_CONFIGURATION_CONFLICTING_INPUT".into());
        }
        files.insert(key, text);
    }
    for path in &paths {
        if !configuration::System::contained(
            &normalizer,
            root,
            &normalized(&normalizer, root, path),
        ) {
            return Err("NAMED_CONFIGURATION_INPUT_OUTSIDE_REPOSITORY".into());
        }
    }
    let mut fs = CaptureFs::new(files, sensitive);
    let mut readable = fs.files.clone();
    for path in snapshot.read_failures {
        if readable.remove(&normalized(&fs, root, &path)).is_none() {
            return Err("NAMED_CONFIGURATION_READ_FAILURE_NOT_CAPTURED".into());
        }
    }
    fs.captured = Captured::new(readable);
    Ok(CapturedSnapshot {
        fs: Rc::new(fs),
        paths,
    })
}

fn observe(descriptor: serde_json::Value) -> Result<serde_json::Value, String> {
    let request: Request = serde_json::from_value(descriptor)
        .map_err(|error| format!("NAMED_CONFIGURATION_REQUEST_INVALID:{error}"))?;
    if !captured_system_observations::absolute(&request.root)
        || request.snapshots.is_empty()
        || request.passes.is_empty()
    {
        return Err("NAMED_CONFIGURATION_SEQUENCE_REQUIRED".into());
    }
    let sensitive = ts_goport::frontend::vfs::osvfs_fs().use_case_sensitive_file_names();
    let snapshots = request
        .snapshots
        .into_iter()
        .map(|snapshot| capture(snapshot, &request.root, sensitive))
        .collect::<Result<Vec<_>, _>>()?;
    let mut passes = vec![];
    for index in request.passes {
        let snapshot = snapshots
            .get(index)
            .ok_or("NAMED_CONFIGURATION_SNAPSHOT_INDEX_INVALID")?;
        let inspection = inspect(
            &snapshot.fs.named_cache,
            snapshot.fs.clone(),
            &request.root,
            &snapshot.paths,
        )?;
        let normalizations = snapshot.paths.iter().map(|path| serde_json::json!({"input":path,"normalized":normalized(snapshot.fs.as_ref(), &request.root, path)})).collect::<Vec<_>>();
        passes.push(serde_json::json!({"snapshot":index,"inspection":inspection,"normalizations":normalizations}));
    }
    Ok(
        serde_json::json!({"executed":true,"unsupported":[],"passes":passes,"case_sensitive":sensitive,"global_admission_inferred":false,"status":"development_observation_not_qualification"}),
    )
}

pub(super) fn run(descriptor: serde_json::Value) -> serde_json::Value {
    match observe(descriptor) {
        Ok(value) => value,
        Err(error) => serde_json::json!({"executed":false,"unsupported":[],"error":error}),
    }
}

#[cfg(test)]
#[path = "../tests/unit/named_configuration.rs"]
mod tests;
