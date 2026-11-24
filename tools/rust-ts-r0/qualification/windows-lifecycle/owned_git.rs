//! Owned Git transport. The separately admitted controller owns entry and custody.

use semctx_gates::process;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, OpenOptions},
    io::{self, Read, Write},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::{Duration, Instant},
};

const CAPACITY: usize = 8_388_608;
const WINDOWS_FIXTURE_ROOT: &str = r"D:\r";
const DEADLINE: Duration = Duration::from_secs(20);

#[derive(Debug, Default)]
pub struct Observed {
    pub exit_code: Option<i32>,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub timed_out: bool,
    pub output_exceeded: bool,
    pub complete_capture: bool,
    pub owned_tree_quiescent: bool,
    pub duration_ms: u128,
}

fn safe_relative(name: &str) -> bool {
    name.is_ascii()
        && name.split('/').all(|part| {
            let upper = part.to_ascii_uppercase();
            let stem = upper.split('.').next().unwrap_or_default();
            let device = matches!(stem, "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$")
                || (stem.len() == 4
                    && matches!(&stem[..3], "COM" | "LPT")
                    && matches!(stem.as_bytes()[3], b'1'..=b'9'));
            !part.is_empty()
                && !matches!(upper.as_str(), "." | ".." | ".GIT" | ".SEMCTX")
                && !part.ends_with([' ', '.'])
                && !device
                && !part
                    .chars()
                    .any(|c| c.is_ascii_control() || "<>:\"\\|?*".contains(c))
        })
}

fn isolated_environment(system: &str, git_dir: &str, control: &str) -> BTreeMap<String, String> {
    let home = format!(r"{control}\home");
    let temp = format!(r"{control}\tmp");
    BTreeMap::from([
        ("SystemRoot".into(), system.into()),
        ("WINDIR".into(), system.into()),
        ("PATH".into(), format!(r"{git_dir};{system}\System32")),
        ("HOME".into(), home.clone()),
        ("USERPROFILE".into(), home.clone()),
        ("XDG_CONFIG_HOME".into(), home),
        ("TEMP".into(), temp.clone()),
        ("TMP".into(), temp),
        ("GIT_ATTR_NOSYSTEM".into(), "1".into()),
        ("GIT_CONFIG_NOSYSTEM".into(), "1".into()),
        ("GIT_CONFIG_GLOBAL".into(), "NUL".into()),
        ("GIT_TERMINAL_PROMPT".into(), "0".into()),
        ("GIT_TEMPLATE_DIR".into(), format!(r"{control}\template")),
        ("LC_ALL".into(), "C".into()),
    ])
}

fn acceptable_config(expected: Option<&[u8]>, capture: &Observed) -> bool {
    if capture.exit_code != Some(0) || !capture.complete_capture || !capture.stderr.is_empty() {
        return false;
    }
    expected.map_or_else(
        || capture.stdout.is_empty(),
        |value| {
            capture
                .stdout
                .strip_suffix(b"\r\n")
                .or_else(|| capture.stdout.strip_suffix(b"\n"))
                .unwrap_or(&capture.stdout)
                == value
        },
    )
}

type DrainedStream = (
    Arc<Mutex<Vec<u8>>>,
    Arc<AtomicBool>,
    thread::JoinHandle<io::Result<()>>,
);

fn drain(mut pipe: impl Read + Send + 'static, cap: usize) -> DrainedStream {
    let bytes = Arc::new(Mutex::new(Vec::new()));
    let exceeded = Arc::new(AtomicBool::new(false));
    let output = Arc::clone(&bytes);
    let overflow = Arc::clone(&exceeded);
    let reader = thread::spawn(move || {
        let mut block = [0u8; 8192];
        loop {
            match pipe.read(&mut block) {
                Ok(0) => return Ok(()),
                Ok(count) => {
                    let mut buffer = output
                        .lock()
                        .map_err(|_| io::Error::other("capture stream lock poisoned"))?;
                    let retain = count.min(cap - buffer.len());
                    buffer.extend_from_slice(&block[..retain]);
                    if retain < count {
                        overflow.store(true, Ordering::SeqCst);
                        return Ok(());
                    }
                }
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                Err(error) => return Err(error),
            }
        }
    });
    (bytes, exceeded, reader)
}

fn drain_complete(stdout: bool, stderr: bool, stop: &AtomicBool) -> bool {
    stdout && stderr && !stop.load(Ordering::SeqCst)
}

fn quiescence_before(
    released: bool,
    deadline: Instant,
    query: impl FnOnce() -> process::Result<bool>,
) -> process::Result<bool> {
    if !released || Instant::now() >= deadline {
        return Err("owned quiescence deadline exceeded".into());
    }
    let quiet = query()?;
    if Instant::now() >= deadline {
        return Err("owned quiescence deadline exceeded".into());
    }
    Ok(quiet)
}

fn await_quiescence(
    released: bool,
    deadline: Instant,
    mut query: impl FnMut() -> process::Result<bool>,
) -> bool {
    loop {
        match quiescence_before(released, deadline, &mut query) {
            Ok(true) => return true,
            Ok(false) => thread::sleep(
                Duration::from_millis(5).min(deadline.saturating_duration_since(Instant::now())),
            ),
            Err(_) => return false,
        }
    }
}

fn command_status_before(
    deadline: Instant,
    poll: impl FnOnce() -> io::Result<Option<std::process::ExitStatus>>,
) -> io::Result<Option<std::process::ExitStatus>> {
    if Instant::now() >= deadline {
        return Err(io::Error::new(
            io::ErrorKind::TimedOut,
            "owned command deadline exceeded",
        ));
    }
    let status = poll();
    if Instant::now() >= deadline {
        return Err(io::Error::new(
            io::ErrorKind::TimedOut,
            "owned command deadline exceeded",
        ));
    }
    status
}

fn finish_capture_before(
    released: bool,
    deadline: Instant,
    stdout: thread::JoinHandle<io::Result<()>>,
    stderr: thread::JoinHandle<io::Result<()>>,
    stop: &AtomicBool,
    mut query: impl FnMut() -> process::Result<bool>,
) -> (bool, bool) {
    let quiet = await_quiescence(released, deadline, &mut query);
    let stdout_complete = matches!(
        process::finish_reader_before(stdout, stop, deadline),
        Ok(Ok(()))
    );
    let stderr_complete = matches!(
        process::finish_reader_before(stderr, stop, deadline),
        Ok(Ok(()))
    );
    let readers_complete = drain_complete(stdout_complete, stderr_complete, stop);
    // A second kernel observation follows pipe draining; a prior zero count is
    // only a momentary observation, not a promise about future OS scheduling.
    let quiet = quiet && quiescence_before(released, deadline, query).unwrap_or(false);
    (quiet, readers_complete)
}

fn run_owned(
    argv: &[String],
    cwd: &Path,
    environment: &BTreeMap<String, String>,
    helper: &Path,
    budget: Duration,
    cap: usize,
) -> Result<Observed, String> {
    if argv.is_empty() || cap == 0 || budget.is_zero() || process::cancellation_requested() {
        return Err("owned command disabled by its budget or cancellation".into());
    }
    let started = Instant::now();
    let mut child = process::spawn_owned_with_env_bounded(
        argv,
        cwd,
        environment,
        helper,
        Duration::from_secs(2),
    )?;
    drop(child.take_stdin());
    let stop = Arc::new(AtomicBool::new(false));
    let out = process::pipe_reader(child.take_stdout().ok_or("owned stdout missing")?, &stop)?;
    let err = process::pipe_reader(child.take_stderr().ok_or("owned stderr missing")?, &stop)?;
    let (stdout, stdout_overflow, out_reader) = drain(out, cap);
    let (stderr, stderr_overflow, err_reader) = drain(err, cap);
    let over_limit =
        || stdout_overflow.load(Ordering::SeqCst) || stderr_overflow.load(Ordering::SeqCst);
    let command_deadline = started + budget;
    let mut timed_out = false;
    let code = loop {
        if process::cancellation_requested() || over_limit() {
            break None;
        }
        if Instant::now() >= command_deadline {
            timed_out = true;
            break None;
        }
        match command_status_before(command_deadline, || child.try_wait()) {
            Ok(Some(status)) => break status.code(),
            Ok(None) => thread::sleep(
                Duration::from_millis(5)
                    .min(command_deadline.saturating_duration_since(Instant::now())),
            ),
            Err(error) => {
                timed_out = error.kind() == io::ErrorKind::TimedOut;
                break None;
            }
        }
    };
    let reaped = child.cleanup_and_release_handle().is_ok();
    let quiescence_deadline = Instant::now() + Duration::from_secs(2);
    let (owned_tree_quiescent, readers_complete) = finish_capture_before(
        reaped,
        quiescence_deadline,
        out_reader,
        err_reader,
        &stop,
        || child.tree_quiescent(),
    );
    let stdout = stdout
        .lock()
        .map_err(|_| "owned stdout reader panicked")?
        .clone();
    let stderr = stderr
        .lock()
        .map_err(|_| "owned stderr reader panicked")?
        .clone();
    let output_exceeded = over_limit();
    Ok(Observed {
        exit_code: code,
        stdout,
        stderr,
        timed_out,
        output_exceeded,
        complete_capture: reaped
            && owned_tree_quiescent
            && readers_complete
            && code.is_some()
            && !timed_out
            && !output_exceeded
            && !process::cancellation_requested(),
        duration_ms: started.elapsed().as_millis(),
        owned_tree_quiescent,
    })
}

fn non_link(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    let reparse = {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    };
    #[cfg(not(windows))]
    let reparse = false;
    !metadata.file_type().is_symlink() && !reparse
}

fn directory(path: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    if !path.is_absolute() || !metadata.is_dir() || !non_link(&metadata) {
        return Err(format!("owned directory differs: {}", path.display()));
    }
    #[cfg(windows)]
    {
        let physical = fs::canonicalize(path).map_err(|error| error.to_string())?;
        if utf8(&physical)?.strip_prefix(r"\\?\") != Some(utf8(path)?) {
            return Err(format!("physical directory differs: {}", path.display()));
        }
    }
    Ok(())
}

fn subdirectories(root: &Path, relative: &Path) -> Result<PathBuf, String> {
    let mut current = root.to_owned();
    for component in relative.components() {
        let std::path::Component::Normal(name) = component else {
            return Err("workspace component is not relative".into());
        };
        current.push(name);
        match fs::create_dir(&current) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error.to_string()),
        }
        directory(&current)?;
    }
    Ok(current)
}

fn workspace_relative(key: &str) -> Result<PathBuf, String> {
    let id = key
        .strip_prefix("lifecycle-")
        .ok_or("foreign lifecycle group")?;
    if id.len() != 64
        || !id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err("invalid lifecycle group".into());
    }
    Ok([
        "supplement-evidence",
        "public",
        "invocations",
        key,
        "input",
        "workspace",
    ]
    .iter()
    .collect())
}

/// Stage only the exact file bytes supplied by the admitted plan loader.
pub fn stage_fixture(
    root: &Path,
    key: &str,
    files: &BTreeMap<String, Vec<u8>>,
) -> Result<PathBuf, String> {
    if cfg!(windows) && root != Path::new(WINDOWS_FIXTURE_ROOT) {
        return Err("native fixture root differs from the disabled plan".into());
    }
    let mut aliases = BTreeSet::new();
    if files.is_empty()
        || files
            .keys()
            .any(|name| !safe_relative(name) || !aliases.insert(name.to_ascii_lowercase()))
    {
        return Err("unsafe or aliased fixture input".into());
    }
    if aliases.iter().any(|name| {
        name.match_indices('/')
            .any(|(index, _)| aliases.contains(&name[..index]))
    }) {
        return Err("fixture file and directory overlap".into());
    }
    directory(root)?;
    let relative = workspace_relative(key)?;
    let parent = subdirectories(root, relative.parent().ok_or("fixture parent missing")?)?;
    let cwd = parent.join("workspace");
    fs::create_dir(&cwd).map_err(|error| error.to_string())?;
    directory(&cwd)?;
    for (name, bytes) in files {
        let path = Path::new(name);
        let parent = subdirectories(&cwd, path.parent().ok_or("file parent missing")?)?;
        let target = parent.join(path.file_name().ok_or("fixture filename missing")?);
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target)
            .map_err(|error| error.to_string())?;
        file.write_all(bytes).map_err(|error| error.to_string())?;
        file.sync_all().map_err(|error| error.to_string())?;
        if fs::read(target).map_err(|error| error.to_string())? != *bytes {
            return Err("fixture write identity changed".into());
        }
    }
    Ok(cwd)
}

#[derive(Clone, Copy)]
pub enum GitStep {
    Version,
    Init,
    SetAutocrlf,
    ReadAutocrlf,
    SetSafecrlf,
    ReadSafecrlf,
    Add,
    Commit,
}

impl GitStep {
    fn arguments(self, metadata: &str) -> Vec<String> {
        let raw = match self {
            Self::Version => vec!["--version"],
            Self::Init => vec!["init", "-q"],
            Self::Add => vec!["add", "."],
            Self::Commit => vec![
                "-c",
                "user.name=T00Fixture",
                "-c",
                "user.email=t00@example.test",
                "commit",
                "-qm",
                "initial",
            ],
            _ => {
                let mut command = vec!["--git-dir", metadata, "config", "--local", "--type=bool"];
                let name = match self {
                    Self::SetAutocrlf | Self::ReadAutocrlf => "core.autocrlf",
                    _ => "core.safecrlf",
                };
                if matches!(self, Self::ReadAutocrlf | Self::ReadSafecrlf) {
                    command.extend(["--get", name]);
                } else {
                    command.extend([name, "false"]);
                }
                command
            }
        };
        raw.into_iter().map(str::to_owned).collect()
    }
}

pub struct ArtifactPin<'a> {
    pub path: &'a Path,
    pub sha256: &'a str,
}

impl ArtifactPin<'_> {
    fn matches(&self) -> bool {
        let Ok(metadata) = fs::symlink_metadata(self.path) else {
            return false;
        };
        self.path.is_absolute()
            && metadata.is_file()
            && non_link(&metadata)
            && self
                .path
                .parent()
                .is_some_and(|path| directory(path).is_ok())
            && fs::read(self.path)
                .is_ok_and(|bytes| format!("{:x}", Sha256::digest(bytes)) == self.sha256)
    }
}

pub struct NativeGit<'a> {
    pub git: ArtifactPin<'a>,
    pub supervisor: ArtifactPin<'a>,
    pub system: &'a Path,
}

pub struct GitObservation {
    pub argv: Vec<String>,
    pub cwd: PathBuf,
    pub capture: Observed,
    pub pins_unchanged: bool,
    pub step_accepted: bool,
}

fn utf8(path: &Path) -> Result<&str, String> {
    path.to_str()
        .ok_or_else(|| "native path is not UTF-8".into())
}

fn is_git_payload(path: &Path) -> bool {
    let bin = path.parent();
    let layout = bin.and_then(Path::parent);
    path.is_absolute()
        && path
            .file_name()
            .and_then(|part| part.to_str())
            .is_some_and(|part| part.eq_ignore_ascii_case("git.exe"))
        && bin
            .and_then(Path::file_name)
            .and_then(|part| part.to_str())
            .is_some_and(|part| part.eq_ignore_ascii_case("bin"))
        && layout
            .and_then(Path::file_name)
            .and_then(|part| part.to_str())
            .is_some_and(|part| {
                part.eq_ignore_ascii_case("mingw64") || part.eq_ignore_ascii_case("ucrt64")
            })
        && fs::symlink_metadata(path)
            .is_ok_and(|metadata| metadata.is_file() && non_link(&metadata))
        && path.ancestors().skip(1).all(|parent| {
            fs::symlink_metadata(parent)
                .is_ok_and(|metadata| metadata.is_dir() && non_link(&metadata))
        })
}

impl NativeGit<'_> {
    /// The admitted controller supplies the frozen sequence and its exclusive
    /// short root. A returned capture is never an admission.
    pub fn observe(&self, key: &str, step: GitStep) -> Result<GitObservation, String> {
        if !cfg!(windows) {
            return Err("native Git transport requires Windows".into());
        }
        let root = Path::new(WINDOWS_FIXTURE_ROOT);
        directory(root)?;
        let mut cwd = root.to_owned();
        for component in workspace_relative(key)?.components() {
            cwd.push(component);
            directory(&cwd)?;
        }
        let metadata = cwd.join(".git");
        if matches!(step, GitStep::Init) {
            match fs::symlink_metadata(&metadata) {
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                _ => return Err("fixture Git metadata already exists".into()),
            }
        } else if !matches!(step, GitStep::Version) {
            directory(&metadata)?;
        }
        let control = subdirectories(root, Path::new("control"))?;
        for label in ["home", "tmp", "template"] {
            subdirectories(&control, Path::new(label))?;
        }
        if fs::read_dir(control.join("template"))
            .map_err(|error| error.to_string())?
            .next()
            .is_some()
        {
            return Err("Git template directory is not empty".into());
        }
        if directory(self.system).is_err()
            || !is_git_payload(self.git.path)
            || !self.git.matches()
            || !self.supervisor.matches()
        {
            return Err("native Git or supervisor pin differs".into());
        }
        let git_dir = self.git.path.parent().ok_or("Git directory missing")?;
        if utf8(self.system)?.contains(';') || utf8(git_dir)?.contains(';') {
            return Err("native trusted PATH component differs".into());
        }
        let environment = isolated_environment(utf8(self.system)?, utf8(git_dir)?, utf8(&control)?);
        let mut argv = vec![utf8(self.git.path)?.to_owned()];
        argv.extend(step.arguments(utf8(&metadata)?));
        let capture = run_owned(
            &argv,
            &cwd,
            &environment,
            self.supervisor.path,
            DEADLINE,
            CAPACITY,
        )?;
        let pins_unchanged =
            self.git.matches() && self.supervisor.matches() && directory(&cwd).is_ok();
        let step_accepted = pins_unchanged
            && match step {
                GitStep::SetAutocrlf | GitStep::SetSafecrlf => acceptable_config(None, &capture),
                GitStep::ReadAutocrlf | GitStep::ReadSafecrlf => {
                    acceptable_config(Some(b"false"), &capture)
                }
                _ => capture.exit_code == Some(0) && capture.complete_capture,
            };
        Ok(GitObservation {
            argv,
            cwd,
            capture,
            pins_unchanged,
            step_accepted,
        })
    }
}

#[cfg(test)]
#[path = "test_owned_git.rs"]
mod tests;
