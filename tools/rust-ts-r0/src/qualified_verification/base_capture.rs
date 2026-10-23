use semctx_gates::process;
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const CAPTURE_LIMIT: usize = 67_108_864;
static CAPTURE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

struct Entry {
    path: String,
    oid: String,
    mode: String,
}

#[derive(Default, PartialEq, Eq)]
struct Snapshot {
    files: BTreeMap<PathBuf, Vec<u8>>,
    directories: BTreeSet<PathBuf>,
}

pub(super) struct BaseCapture {
    root: PathBuf,
    files: BTreeMap<String, Vec<u8>>,
    inventory: BTreeSet<String>,
    snapshot: Snapshot,
    git_snapshot: Snapshot,
}

impl BaseCapture {
    pub(super) fn root(&self) -> &Path {
        &self.root
    }
    pub(super) fn raw_files(&self) -> &BTreeMap<String, Vec<u8>> {
        &self.files
    }
    pub(super) fn inventory(&self) -> BTreeSet<String> {
        self.inventory.clone()
    }
    pub(super) fn revalidate(&self) -> Result<(), String> {
        let (workspace, git) = split_snapshot(&self.root, snapshot(&self.root)?);
        if workspace != self.snapshot || git != self.git_snapshot {
            return Err("immutable base capture changed during analysis".into());
        }
        Ok(())
    }
}

impl Drop for BaseCapture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn environment() -> Result<BTreeMap<String, String>, String> {
    let mut env = BTreeMap::new();
    for key in ["PATH", "HOME", "SystemRoot", "TMPDIR", "TEMP", "TMP"] {
        if let Some(value) = std::env::var_os(key) {
            env.insert(
                key.into(),
                value
                    .into_string()
                    .map_err(|_| "Git environment is not UTF-8")?,
            );
        }
    }
    env.insert("GIT_CONFIG_NOSYSTEM".into(), "1".into());
    env.insert(
        "GIT_CONFIG_GLOBAL".into(),
        if cfg!(windows) { "NUL" } else { "/dev/null" }.into(),
    );
    env.insert("GIT_NO_REPLACE_OBJECTS".into(), "1".into());
    env.insert("LC_ALL".into(), "C".into());
    Ok(env)
}

fn raw_git(root: &Path, helper: &Path, args: &[String], input: Vec<u8>) -> Result<Vec<u8>, String> {
    if input.len() > CAPTURE_LIMIT {
        return Err("immutable base Git input exceeds capture limit".into());
    }
    let mut argv = vec![
        "git".into(),
        "-c".into(),
        "core.autocrlf=false".into(),
        "-c".into(),
        "core.fsmonitor=false".into(),
    ];
    argv.extend_from_slice(args);
    let mut child = process::spawn_owned_with_env(&argv, root, &environment()?, helper)?;
    let stop = Arc::new(AtomicBool::new(false));
    let mut stdin = child.take_stdin().ok_or("base Git stdin absent")?;
    let stdout = process::pipe_reader(child.take_stdout().ok_or("base Git stdout absent")?, &stop)?;
    let stderr = process::pipe_reader(child.take_stderr().ok_or("base Git stderr absent")?, &stop)?;
    let input_thread = thread::spawn(move || stdin.write_all(&input));
    let output_thread = thread::spawn(move || bounded_read(stdout, CAPTURE_LIMIT));
    let error_thread = thread::spawn(move || bounded_read(stderr, 65_536));
    let started = Instant::now();
    let status = loop {
        if process::cancellation_requested() || started.elapsed() >= Duration::from_secs(5) {
            child.kill();
            break Err("immutable base Git operation cancelled or timed out".to_string());
        }
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Ok(None) => thread::sleep(Duration::from_millis(5)),
            Err(error) => break Err(format!("immutable base Git wait failed: {error}")),
        }
    };
    child.kill();
    let written = process::finish_reader(input_thread, &stop);
    let output = process::finish_reader(output_thread, &stop);
    let errors = process::finish_reader(error_thread, &stop);
    written?.map_err(|error| format!("immutable base Git input failed: {error}"))?;
    let output = output??;
    let errors = errors??;
    if !status?.success() {
        return Err(format!(
            "immutable base Git operation failed: {}",
            String::from_utf8_lossy(&errors)
        ));
    }
    Ok(output)
}

fn bounded_read(reader: impl Read, limit: usize) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    reader
        .take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() > limit {
        return Err("immutable base Git output exceeds capture limit".into());
    }
    Ok(bytes)
}

fn arguments(args: &[&str]) -> Vec<String> {
    args.iter().map(|arg| arg.to_string()).collect()
}

fn object_id(value: &str) -> bool {
    matches!(value.len(), 40 | 64)
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn inventory(bytes: &[u8], commit: &str) -> Result<Vec<Entry>, String> {
    if !bytes.is_empty() && bytes.last() != Some(&0) {
        return Err("immutable base tree has incomplete records".into());
    }
    let mut entries = Vec::new();
    let mut paths = BTreeSet::new();
    for record in bytes
        .split(|byte| *byte == 0)
        .filter(|record| !record.is_empty())
    {
        let record = std::str::from_utf8(record).map_err(|_| "immutable base path is not UTF-8")?;
        let (header, path) = record
            .split_once('\t')
            .ok_or("immutable base tree record lacks path")?;
        let fields = header.split(' ').collect::<Vec<_>>();
        if fields.len() != 3
            || !matches!(fields[0], "100644" | "100755")
            || fields[1] != "blob"
            || !object_id(fields[2])
            || fields[2].len() != commit.len()
        {
            return Err(
                "immutable base links, gitlinks or invalid tree entries are unsupported".into(),
            );
        }
        if path.is_empty()
            || Path::new(path).is_absolute()
            || path.contains([':', '\\'])
            || path.split('/').any(|part| {
                part.is_empty() || matches!(part, "." | "..") || part.eq_ignore_ascii_case(".git")
            })
            || !paths.insert(path.to_string())
        {
            return Err("immutable base tree path is unsafe or duplicated".into());
        }
        entries.push(Entry {
            path: path.into(),
            oid: fields[2].into(),
            mode: fields[0].into(),
        });
    }
    Ok(entries)
}

fn scratch() -> Result<PathBuf, String> {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_nanos();
    let root = std::env::temp_dir().join(format!(
        "semctx-native-base-{}-{nonce}-{}",
        std::process::id(),
        CAPTURE_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    let mut builder = fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(&root).map_err(|error| error.to_string())?;
    root.canonicalize().map_err(|error| error.to_string())
}

fn materialize(root: &Path, entries: &[Entry], bytes: &[u8]) -> Result<(), String> {
    let mut offset = 0;
    for entry in entries {
        let newline = bytes
            .get(offset..)
            .and_then(|remaining| remaining.iter().position(|byte| *byte == b'\n'))
            .ok_or("immutable base blob header absent")?
            + offset;
        let header = std::str::from_utf8(&bytes[offset..newline])
            .map_err(|_| "immutable base blob header is not UTF-8")?;
        let fields = header.split(' ').collect::<Vec<_>>();
        if fields.len() != 3 || fields[0] != entry.oid || fields[1] != "blob" {
            return Err("immutable base blob identity mismatch".into());
        }
        let size = fields[2]
            .parse::<usize>()
            .map_err(|_| "immutable base blob size invalid")?;
        offset = newline + 1;
        let end = offset
            .checked_add(size)
            .filter(|end| *end < bytes.len())
            .ok_or("immutable base blob truncated")?;
        if bytes[end] != b'\n' {
            return Err("immutable base blob separator absent".into());
        }
        let destination = root.join(&entry.path);
        fs::create_dir_all(
            destination
                .parent()
                .ok_or("immutable base path parent absent")?,
        )
        .map_err(|error| error.to_string())?;
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&destination)
            .map_err(|error| format!("immutable base path alias or creation failure: {error}"))?;
        file.write_all(&bytes[offset..end])
            .map_err(|error| error.to_string())?;
        offset = end + 1;
    }
    if offset != bytes.len() {
        return Err("immutable base blob stream contains unexpected bytes".into());
    }
    Ok(())
}

fn verify_objects(root: &Path, helper: &Path, entries: &[Entry]) -> Result<(), String> {
    for chunk in entries.chunks(128) {
        let mut args = arguments(&["hash-object", "--no-filters", "--"]);
        args.extend(chunk.iter().map(|entry| entry.path.clone()));
        let output = raw_git(root, helper, &args, vec![])?;
        let hashes = std::str::from_utf8(&output)
            .map_err(|_| "immutable base hash result is not UTF-8")?
            .lines()
            .collect::<Vec<_>>();
        if hashes
            != chunk
                .iter()
                .map(|entry| entry.oid.as_str())
                .collect::<Vec<_>>()
        {
            return Err("immutable base blob bytes do not match Git object identities".into());
        }
    }
    Ok(())
}

fn snapshot(root: &Path) -> Result<Snapshot, String> {
    let mut pending = vec![root.to_path_buf()];
    let mut snapshot = Snapshot::default();
    let mut size = 0usize;
    while let Some(directory) = pending.pop() {
        if !fs::symlink_metadata(&directory)
            .map_err(|error| error.to_string())?
            .is_dir()
        {
            return Err("immutable base directory replaced or linked".into());
        }
        snapshot.directories.insert(directory.clone());
        for entry in fs::read_dir(&directory).map_err(|error| error.to_string())? {
            let path = entry.map_err(|error| error.to_string())?.path();
            let kind = fs::symlink_metadata(&path)
                .map_err(|error| error.to_string())?
                .file_type();
            if kind.is_dir() {
                pending.push(path);
                continue;
            }
            if !kind.is_file() {
                return Err("immutable base file replaced or linked".into());
            }
            let file = fs::File::open(&path).map_err(|error| error.to_string())?;
            let bytes = bounded_read(file, CAPTURE_LIMIT - size)?;
            size = size
                .checked_add(bytes.len())
                .filter(|size| *size <= CAPTURE_LIMIT)
                .ok_or("immutable base materialization exceeds capture limit")?;
            snapshot.files.insert(path, bytes);
        }
    }
    Ok(snapshot)
}

fn split_snapshot(root: &Path, snapshot: Snapshot) -> (Snapshot, Snapshot) {
    let git = root.join(".git");
    let (git_files, files) = snapshot
        .files
        .into_iter()
        .partition(|(path, _)| path.starts_with(&git));
    let (git_directories, directories) = snapshot
        .directories
        .into_iter()
        .partition(|path| path.starts_with(&git));
    (
        Snapshot { files, directories },
        Snapshot {
            files: git_files,
            directories: git_directories,
        },
    )
}

pub(super) fn capture(
    root: &Path,
    commit: &str,
    helper: &Path,
    current_policy: Option<&[u8]>,
) -> Result<BaseCapture, String> {
    if !object_id(commit) {
        return Err("immutable base requires a resolved Git object identity".into());
    }
    let tree = raw_git(
        root,
        helper,
        &arguments(&["ls-tree", "-r", "-z", commit]),
        vec![],
    )?;
    let entries = inventory(&tree, commit)?;
    let input = entries
        .iter()
        .map(|entry| format!("{}\n", entry.oid))
        .collect::<String>()
        .into_bytes();
    let blobs = raw_git(root, helper, &arguments(&["cat-file", "--batch"]), input)?;
    let mut capture = BaseCapture {
        root: scratch()?,
        files: BTreeMap::new(),
        inventory: entries.iter().map(|entry| entry.path.clone()).collect(),
        snapshot: Snapshot::default(),
        git_snapshot: Snapshot::default(),
    };
    materialize(&capture.root, &entries, &blobs)?;
    let materialized = snapshot(&capture.root)?;
    if materialized.files.keys().cloned().collect::<BTreeSet<_>>()
        != entries
            .iter()
            .map(|entry| capture.root.join(&entry.path))
            .collect()
    {
        return Err("immutable base tree paths alias on the native filesystem".into());
    }
    capture.snapshot = materialized;
    let format = if commit.len() == 64 {
        "--object-format=sha256"
    } else {
        "--object-format=sha1"
    };
    raw_git(
        &capture.root,
        helper,
        &arguments(&["init", "-q", "--template=", format]),
        vec![],
    )?;
    verify_objects(&capture.root, helper, &entries)?;
    let index = entries
        .iter()
        .map(|entry| format!("{} {}\t{}\0", entry.mode, entry.oid, entry.path))
        .collect::<String>()
        .into_bytes();
    raw_git(
        &capture.root,
        helper,
        &arguments(&["update-index", "--info-only", "-z", "--index-info"]),
        index,
    )?;
    if split_snapshot(&capture.root, snapshot(&capture.root)?).0 != capture.snapshot {
        return Err("immutable base materialization differs from captured Git blobs".into());
    }
    let policy = capture.root.join(".semctx/config.json");
    if policy.exists() {
        fs::remove_file(&policy).map_err(|error| error.to_string())?;
    }
    capture.snapshot.files.remove(&policy);
    if let Some(bytes) = current_policy {
        fs::create_dir_all(policy.parent().ok_or("base policy parent absent")?)
            .map_err(|error| error.to_string())?;
        fs::write(&policy, bytes).map_err(|error| error.to_string())?;
        capture.snapshot.files.insert(policy, bytes.to_vec());
        capture
            .snapshot
            .directories
            .insert(capture.root.join(".semctx"));
    }
    let (workspace, git) = split_snapshot(&capture.root, snapshot(&capture.root)?);
    if workspace != capture.snapshot {
        return Err("immutable base materialization differs from captured Git blobs".into());
    }
    capture.git_snapshot = git;
    for (path, bytes) in &capture.snapshot.files {
        capture.files.insert(
            path.to_str()
                .ok_or("immutable base materialized path is not UTF-8")?
                .to_string(),
            bytes.clone(),
        );
    }
    Ok(capture)
}
