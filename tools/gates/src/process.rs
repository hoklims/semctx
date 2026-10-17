//! Bounded process-tree ownership. This is lifecycle control, not a sandbox.
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    io::{IsTerminal, Read, Write},
    path::Path,
    process::{Child, ChildStderr, ChildStdin, ChildStdout, Command, ExitStatus, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::{Duration, Instant},
};

#[derive(Debug)]
pub enum ProcessError {
    Invalid(String),
    Io {
        operation: &'static str,
        source: std::io::Error,
    },
}
impl ProcessError {
    fn io(operation: &'static str, source: std::io::Error) -> Self {
        Self::Io { operation, source }
    }
}
impl std::fmt::Display for ProcessError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Invalid(message) => formatter.write_str(message),
            Self::Io { operation, source } => write!(formatter, "{operation}: {source}"),
        }
    }
}
impl std::error::Error for ProcessError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Invalid(_) => None,
            Self::Io { source, .. } => Some(source),
        }
    }
}
impl From<&str> for ProcessError {
    fn from(message: &str) -> Self {
        Self::Invalid(message.into())
    }
}
impl From<String> for ProcessError {
    fn from(message: String) -> Self {
        Self::Invalid(message)
    }
}
impl From<ProcessError> for String {
    fn from(error: ProcessError) -> Self {
        error.to_string()
    }
}
pub type Result<T> = std::result::Result<T, ProcessError>;

static CANCELLED: AtomicBool = AtomicBool::new(false);
pub fn request_cancellation() {
    CANCELLED.store(true, Ordering::SeqCst);
}
pub fn cancellation_requested() -> bool {
    CANCELLED.load(Ordering::SeqCst)
}

/// Live progress is interactive only. A caller-owned pipe may never be drained.
pub fn interactive_progress() -> bool {
    std::io::stderr().is_terminal()
}

/// Interruptible reads allow finalization to close pipes retained by a POSIX descendant
/// which escaped the owned process group. This does not terminate that descendant.
pub struct PipeReader<R> {
    inner: R,
    stop: Arc<AtomicBool>,
    #[cfg(unix)]
    fd: std::os::fd::RawFd,
}
impl<R: Read> Read for PipeReader<R> {
    fn read(&mut self, bytes: &mut [u8]) -> std::io::Result<usize> {
        loop {
            if self.stop.load(Ordering::SeqCst) {
                return Err(std::io::Error::other(
                    "pipe capture finalization deadline exceeded",
                ));
            }
            match self.inner.read(bytes) {
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    #[cfg(unix)]
                    self.wait_readable()?;
                    #[cfg(windows)]
                    thread::sleep(Duration::from_millis(5));
                }
                result => return result,
            }
        }
    }
}
#[cfg(unix)]
impl<R> PipeReader<R> {
    fn wait_readable(&self) -> std::io::Result<()> {
        let mut descriptor = libc::pollfd {
            fd: self.fd,
            events: libc::POLLIN,
            revents: 0,
        };
        // SAFETY: fd belongs to inner, which stays alive throughout this call. poll receives
        // one initialized descriptor and waits at most 5 ms before cancellation is rechecked.
        if unsafe { libc::poll(&mut descriptor, 1, 5) } < 0 {
            let error = std::io::Error::last_os_error();
            if error.kind() != std::io::ErrorKind::Interrupted {
                return Err(error);
            }
        }
        Ok(())
    }
}
#[cfg(unix)]
pub fn pipe_reader<R: Read + std::os::fd::AsRawFd>(
    inner: R,
    stop: &Arc<AtomicBool>,
) -> Result<PipeReader<R>> {
    let fd = inner.as_raw_fd();
    // SAFETY: fd is the live, uniquely owned read end of a child pipe; flags preserve existing bits.
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    // SAFETY: F_SETFL changes only the nonblocking status of that live pipe read end.
    if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
        return Err(ProcessError::io(
            "nonblocking child pipe",
            std::io::Error::last_os_error(),
        ));
    }
    Ok(PipeReader {
        inner,
        stop: stop.clone(),
        fd,
    })
}
#[cfg(windows)]
pub fn pipe_reader<R: Read>(inner: R, stop: &Arc<AtomicBool>) -> Result<PipeReader<R>> {
    Ok(PipeReader {
        inner,
        stop: stop.clone(),
    })
}

/// Give EOF a bounded grace after process-tree cleanup, then cancel incomplete captures.
/// Unix readers observe cancellation without abandoning their threads or descriptors.
pub fn finish_reader<T>(reader: thread::JoinHandle<T>, stop: &AtomicBool) -> Result<T> {
    let started = Instant::now();
    while !reader.is_finished() && started.elapsed() < Duration::from_millis(500) {
        thread::sleep(Duration::from_millis(5));
    }
    if !reader.is_finished() {
        stop.store(true, Ordering::SeqCst);
        while !reader.is_finished() && started.elapsed() < Duration::from_millis(1000) {
            thread::sleep(Duration::from_millis(5));
        }
        if !reader.is_finished() {
            return Err("pipe capture cleanup incomplete".into());
        }
    }
    reader.join().map_err(|_| "pipe reader panicked".into())
}
#[derive(Clone, Copy, PartialEq, Eq)]
enum OutputMode {
    Capture,
    Stderr,
}
impl OutputMode {
    fn forward(self, bytes: &[u8]) -> std::io::Result<()> {
        if self == Self::Capture {
            return Ok(());
        }
        let mut stderr = std::io::stderr().lock();
        stderr.write_all(bytes).and_then(|()| stderr.flush())
    }
}
#[derive(Clone, Copy, PartialEq, Eq)]
enum InputMode {
    Closed,
    Streaming,
}
enum Environment<'a> {
    Inherited(Option<&'a BTreeMap<String, String>>),
    Exact(&'a BTreeMap<String, String>),
}
#[derive(Clone, Copy, PartialEq, Eq)]
enum OutcomeKind {
    Success,
    Cancelled,
    Timeout,
    OutputLimit,
    Nonzero,
    WaitError,
    CaptureError,
    MalformedOutput,
}
impl OutcomeKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Success => "success",
            Self::Cancelled => "cancelled",
            Self::Timeout => "timeout",
            Self::OutputLimit => "output_limit",
            Self::Nonzero => "nonzero",
            Self::WaitError => "wait_error",
            Self::CaptureError => "capture_error",
            Self::MalformedOutput => "malformed_output",
        }
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Outcome {
    pub kind: String,
    pub exit_code: Option<i32>,
    pub duration_ms: u64,
    pub stdout: String,
    pub stderr: String,
    pub stdout_bytes: u64,
    pub stderr_bytes: u64,
    pub stdout_hash: String,
    pub stderr_hash: String,
}
struct Capture {
    bytes: Vec<u8>,
    count: u64,
    hash: sha2::Sha256,
    error: bool,
}
impl Capture {
    fn new() -> Self {
        use sha2::Digest;
        Self {
            bytes: vec![],
            count: 0,
            hash: sha2::Sha256::new(),
            error: false,
        }
    }
}
fn drain(
    mut reader: impl Read + Send + 'static,
    cap: usize,
    output_mode: OutputMode,
) -> (Arc<Mutex<Capture>>, thread::JoinHandle<()>) {
    use sha2::Digest;
    let data = Arc::new(Mutex::new(Capture::new()));
    let result = data.clone();
    let handle = thread::spawn(move || {
        let mut buffer = [0u8; 8192];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(n) => {
                    let mut d = data
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner);
                    d.count += n as u64;
                    d.hash.update(&buffer[..n]);
                    let keep = n.min(cap.saturating_sub(d.bytes.len()));
                    d.bytes.extend_from_slice(&buffer[..keep]);
                    drop(d);
                    if output_mode.forward(&buffer[..keep]).is_err() {
                        data.lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner)
                            .error = true;
                        break;
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => {
                    data.lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner)
                        .error = true;
                    break;
                }
            }
        }
    });
    (result, handle)
}

#[cfg(unix)]
struct Tree {
    group: i32,
}
#[cfg(unix)]
impl Tree {
    fn attach(child: &Child) -> Result<Self> {
        Ok(Self {
            group: child.id() as i32,
        })
    }
    fn kill(&self) {
        // SAFETY: POSIX kill accepts a negative process-group ID assigned by Command::process_group.
        unsafe {
            libc::kill(-self.group, libc::SIGKILL);
        }
    }
}
#[cfg(unix)]
impl Drop for Tree {
    fn drop(&mut self) {
        self.kill();
    }
}

#[cfg(windows)]
struct Tree {
    job: windows_sys::Win32::Foundation::HANDLE,
}
#[cfg(windows)]
impl Tree {
    fn attach(child: &Child) -> Result<Self> {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::{Foundation::CloseHandle, System::JobObjects::*};
        // SAFETY: Win32 receives live process/job handles and a correctly sized initialized job-info buffer.
        unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                return Err(ProcessError::io(
                    "CreateJobObject",
                    std::io::Error::last_os_error(),
                ));
            }
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &info as *const _ as _,
                std::mem::size_of_val(&info) as u32,
            ) == 0
                || AssignProcessToJobObject(job, child.as_raw_handle() as _) == 0
            {
                let error = std::io::Error::last_os_error();
                CloseHandle(job);
                return Err(ProcessError::io("assign JobObject", error));
            }
            Ok(Self { job })
        }
    }
    fn kill(&self) {
        // SAFETY: Win32 TerminateJobObject accepts the live job handle retained until Tree::drop.
        unsafe {
            windows_sys::Win32::System::JobObjects::TerminateJobObject(self.job, 124);
        }
    }
}
#[cfg(windows)]
impl Drop for Tree {
    fn drop(&mut self) {
        self.kill();
        // SAFETY: Win32 CloseHandle releases the uniquely owned job handle once, after termination.
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.job);
        }
    }
}

pub fn install_cancellation() {
    #[cfg(unix)]
    // SAFETY: libc::signal receives a static C-ABI handler that only stores an AtomicBool.
    unsafe {
        extern "C" fn handler(_: i32) {
            CANCELLED.store(true, Ordering::SeqCst);
        }
        libc::signal(libc::SIGINT, handler as *const () as libc::sighandler_t);
        libc::signal(libc::SIGTERM, handler as *const () as libc::sighandler_t);
    }
    #[cfg(windows)]
    // SAFETY: Win32 retains this static system-ABI callback; it only stores an AtomicBool.
    unsafe {
        unsafe extern "system" fn handler(event: u32) -> i32 {
            if event == 0 || event == 1 {
                CANCELLED.store(true, Ordering::SeqCst);
                1
            } else {
                0
            }
        }
        windows_sys::Win32::System::Console::SetConsoleCtrlHandler(Some(handler), 1);
    }
}

// The helper cannot execute the requested command until its parent has assigned its process tree.
pub fn helper(argv: &[String]) -> Result<i32> {
    helper_mode(argv, InputMode::Closed)
}

/// Internal executable entrypoint for streaming transports. The parent owns the helper's
/// process tree before sending the acknowledgement, so no product process can escape the
/// Windows job assignment race. stdin's persistent buffer retains bytes read with the ACK.
pub fn helper_stream(argv: &[String]) -> Result<i32> {
    helper_mode(argv, InputMode::Streaming)
}

fn helper_mode(argv: &[String], input_mode: InputMode) -> Result<i32> {
    let mut ack = [0u8; 1];
    std::io::stdin()
        .read_exact(&mut ack)
        .map_err(|e| ProcessError::io("read supervisor acknowledgement", e))?;
    if ack != [b'!'] {
        return Err("missing supervisor acknowledgement".into());
    }
    let (program, args) = argv.split_first().ok_or("empty command")?;
    let mut child = Command::new(program)
        .args(args)
        .stdin(if input_mode == InputMode::Streaming {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .spawn()
        .map_err(|e| ProcessError::io("spawn target", e))?;
    if input_mode == InputMode::Streaming {
        let mut input = child.stdin.take().ok_or("missing streaming stdin")?;
        // Stdin owns one shared BufReader. Taking its lock in this thread preserves any
        // protocol bytes prefetched while reading the ACK in the calling thread.
        thread::spawn(move || {
            let _ = std::io::copy(&mut std::io::stdin().lock(), &mut input);
        });
        // Do not join an input thread waiting for EOF when the real child has already exited.
        // The helper's exit closes that thread and the owned process tree contains its child.
    }
    finish_status(
        child
            .wait()
            .map_err(|e| ProcessError::io("wait target", e))?,
    )
}

fn finish_status(status: ExitStatus) -> Result<i32> {
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        if let Some(signal) = status.signal() {
            // Preserve signal termination through the helper rather than converting a crash
            // into an ordinary success or expected refusal.
            // SAFETY: POSIX signal/raise accept the signal returned by ExitStatusExt::signal.
            unsafe {
                libc::signal(signal, libc::SIG_DFL);
                libc::raise(signal);
            }
            return Err(format!("child terminated by signal {signal}").into());
        }
    }
    Ok(status.code().unwrap_or(125))
}

/// An acknowledged process with lifetime ownership. Call cleanup before joining pipe readers;
/// a descendant may retain a pipe after the direct child exits. This is not a sandbox.
pub struct OwnedChild {
    child: Child,
    tree: Tree,
}

impl OwnedChild {
    pub fn id(&self) -> u32 {
        self.child.id()
    }
    pub fn take_stdin(&mut self) -> Option<ChildStdin> {
        self.child.stdin.take()
    }
    pub fn take_stdout(&mut self) -> Option<ChildStdout> {
        self.child.stdout.take()
    }
    pub fn take_stderr(&mut self) -> Option<ChildStderr> {
        self.child.stderr.take()
    }
    pub fn try_wait(&mut self) -> std::io::Result<Option<ExitStatus>> {
        self.child.try_wait()
    }
    pub fn wait(&mut self) -> std::io::Result<ExitStatus> {
        self.child.wait()
    }
    pub fn kill(&self) {
        self.tree.kill();
    }
    pub fn cleanup(&mut self) -> Result<()> {
        self.kill();
        self.child
            .wait()
            .map(|_| ())
            .map_err(|e| ProcessError::io("reap owned process", e))
    }
}
impl Drop for OwnedChild {
    fn drop(&mut self) {
        let _ = self.cleanup();
    }
}

pub fn spawn_owned(
    argv: &[String],
    root: &Path,
    env: Option<&BTreeMap<String, String>>,
    helper_path: &Path,
) -> Result<OwnedChild> {
    spawn_owned_mode(
        argv,
        root,
        Environment::Inherited(env),
        helper_path,
        InputMode::Streaming,
    )
}

/// Launch with exactly the supplied environment (plus no inherited variables). The caller
/// owns explicit Git configuration isolation; no host Git/GCM variables are imported.
pub fn spawn_owned_with_env(
    argv: &[String],
    root: &Path,
    exact_env: &BTreeMap<String, String>,
    helper_path: &Path,
) -> Result<OwnedChild> {
    spawn_owned_mode(
        argv,
        root,
        Environment::Exact(exact_env),
        helper_path,
        InputMode::Streaming,
    )
}

fn spawn_owned_mode(
    argv: &[String],
    root: &Path,
    environment: Environment<'_>,
    helper_path: &Path,
    input_mode: InputMode,
) -> Result<OwnedChild> {
    if argv.is_empty() {
        return Err("empty owned command".into());
    }
    let mut command = Command::new(helper_path);
    command
        .arg(if input_mode == InputMode::Streaming {
            "__exec-stream"
        } else {
            "__exec"
        })
        .args(argv)
        .current_dir(root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    match environment {
        Environment::Exact(env) => {
            command.env_clear().envs(env);
        }
        Environment::Inherited(env) => {
            let mut keys = std::env::vars_os().map(|(key, _)| key).collect::<Vec<_>>();
            if let Some(env) = env {
                command.envs(env);
                keys.extend(env.keys().map(std::ffi::OsString::from));
            }
            for key in keys {
                let name = key.to_string_lossy().to_ascii_uppercase();
                if name == "GIT" || name.starts_with("GIT_") || name.starts_with("GCM_") {
                    command.env_remove(key);
                }
            }
        }
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x00000200 | 0x08000000);
    }
    let mut child = command
        .spawn()
        .map_err(|e| ProcessError::io("spawn supervisor", e))?;
    let tree = match Tree::attach(&child) {
        Ok(tree) => tree,
        Err(e) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(e);
        }
    };
    let mut owned = OwnedChild { child, tree };
    // This is the only release point. On attach failure the helper is killed without an ACK.
    owned
        .child
        .stdin
        .as_mut()
        .ok_or("missing supervisor stdin")?
        .write_all(b"!")
        .map_err(|e| ProcessError::io("supervisor acknowledgement", e))?;
    if input_mode == InputMode::Closed {
        drop(owned.child.stdin.take());
    }
    Ok(owned)
}

pub fn run(argv: &[String], root: &Path, timeout_ms: u64, cap: usize) -> Result<Outcome> {
    run_with_helper(
        argv,
        root,
        timeout_ms,
        cap,
        &std::env::current_exe()
            .map_err(|e| ProcessError::io("resolve supervisor executable", e))?,
    )
}

pub fn run_with_helper(
    argv: &[String],
    root: &Path,
    timeout_ms: u64,
    cap: usize,
    executable: &Path,
) -> Result<Outcome> {
    run_mode(argv, root, timeout_ms, cap, executable, OutputMode::Capture)
}

pub fn run_logged(argv: &[String], root: &Path, timeout_ms: u64, cap: usize) -> Result<Outcome> {
    run_with_helper_logged(
        argv,
        root,
        timeout_ms,
        cap,
        &std::env::current_exe()
            .map_err(|e| ProcessError::io("resolve supervisor executable", e))?,
    )
}

pub fn run_with_helper_logged(
    argv: &[String],
    root: &Path,
    timeout_ms: u64,
    cap: usize,
    executable: &Path,
) -> Result<Outcome> {
    run_mode(
        argv,
        root,
        timeout_ms,
        cap,
        executable,
        if interactive_progress() {
            OutputMode::Stderr
        } else {
            OutputMode::Capture
        },
    )
}

fn run_mode(
    argv: &[String],
    root: &Path,
    timeout_ms: u64,
    cap: usize,
    executable: &Path,
    output_mode: OutputMode,
) -> Result<Outcome> {
    if argv.is_empty() || timeout_ms == 0 || cap == 0 {
        return Err("invalid process budget/command".into());
    }
    let start = Instant::now();
    let mut owned = spawn_owned_mode(
        argv,
        root,
        Environment::Inherited(None),
        executable,
        InputMode::Closed,
    )?;
    let child = &mut owned.child;
    let tree = &owned.tree;
    let stop = Arc::new(AtomicBool::new(false));
    let (out, out_thread) = drain(
        pipe_reader(child.stdout.take().ok_or("missing stdout")?, &stop)?,
        cap,
        output_mode,
    );
    let (err, err_thread) = drain(
        pipe_reader(child.stderr.take().ok_or("missing stderr")?, &stop)?,
        cap,
        output_mode,
    );
    let mut kind = OutcomeKind::Success;
    let exit_code;
    loop {
        if cancellation_requested() {
            kind = OutcomeKind::Cancelled;
            tree.kill();
        } else if start.elapsed() >= Duration::from_millis(timeout_ms) {
            kind = OutcomeKind::Timeout;
            tree.kill();
        } else if out
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .count
            > cap as u64
            || err
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .count
                > cap as u64
        {
            kind = OutcomeKind::OutputLimit;
            tree.kill();
        }
        if kind != OutcomeKind::Success {
            exit_code = child.wait().ok().and_then(|s| s.code());
            break;
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                exit_code = status.code();
                if exit_code != Some(0) {
                    kind = OutcomeKind::Nonzero;
                }
                break;
            }
            Ok(None) => thread::sleep(Duration::from_millis(5)),
            Err(_) => {
                kind = OutcomeKind::WaitError;
                tree.kill();
                exit_code = child.wait().ok().and_then(|s| s.code());
                break;
            }
        }
    }
    // Descendants may retain inherited pipes after the direct process exits. Terminate the tree
    // before joining readers; joining first would make a timeout itself hang indefinitely.
    tree.kill();
    let out_failure = finish_reader(out_thread, &stop).is_err();
    let err_failure = finish_reader(err_thread, &stop).is_err();
    let reader_failure = out_failure || err_failure;
    use sha2::Digest;
    let out = out
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let err = err
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if out.count > cap as u64 || err.count > cap as u64 {
        kind = OutcomeKind::OutputLimit;
    } else if reader_failure || out.error || err.error {
        kind = OutcomeKind::CaptureError;
    } else if std::str::from_utf8(&out.bytes).is_err() || std::str::from_utf8(&err.bytes).is_err() {
        kind = OutcomeKind::MalformedOutput;
    }
    Ok(Outcome {
        kind: kind.as_str().into(),
        exit_code,
        duration_ms: start.elapsed().as_millis() as u64,
        stdout: String::from_utf8_lossy(&out.bytes).into_owned(),
        stderr: String::from_utf8_lossy(&err.bytes).into_owned(),
        stdout_bytes: out.count,
        stderr_bytes: err.count,
        stdout_hash: format!("{:x}", out.hash.clone().finalize()),
        stderr_hash: format!("{:x}", err.hash.clone().finalize()),
    })
}
