use super::*;
use std::io::{BufRead, Read, Write};

const FRAME_LIMIT: usize = 16_777_216;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Frame {
    phase: String,
    graph: Value,
    files: BTreeMap<String, String>,
}

struct Session {
    request: Request,
    sdk: Sdk,
    indexed: process::Outcome,
    batch: wire::Batch,
    received: ReceivedIndex,
    executable: PathBuf,
}

fn live_files(request: &Request) -> Result<(), String> {
    let root = Path::new(&request.cwd);
    if !root.is_absolute() {
        return Err("repository root must be absolute".into());
    }
    let root = root.canonicalize().map_err(|error| error.to_string())?;
    if !root.is_dir() {
        return Err("repository root is not a directory".into());
    }
    for (path, text) in &request.files {
        if !Path::new(path).is_absolute() {
            return Err("captured file path must be absolute".into());
        }
        relative_source_path(&request.cwd, path, request.case_sensitive)?;
        let actual = Path::new(path)
            .canonicalize()
            .map_err(|error| error.to_string())?;
        if !actual.starts_with(&root) || !actual.is_file() {
            return Err(format!("captured file escaped repository: {path}"));
        }
        let mut bytes = Vec::new();
        fs::File::open(&actual)
            .and_then(|file| file.take(text.len() as u64 + 1).read_to_end(&mut bytes))
            .map_err(|error| error.to_string())?;
        if bytes != text.as_bytes() {
            return Err(format!("captured file bytes changed: {path}"));
        }
    }
    Ok(())
}

impl Session {
    fn start(request: Request, sdk: Sdk) -> Result<(Self, Value), String> {
        if !request.qualified
            || !request.retained
            || request.roots.is_empty()
            || !request.utf16_files.is_empty()
            || !request.raw_files.is_empty()
            || request
                .roots
                .iter()
                .any(|path| !request.files.contains_key(path))
        {
            return Err("retained qualified UTF-8 source roots are required".into());
        }
        if sdk_compatibility::classify(&sdk, &request.sdk_directory)?
            != sdk_compatibility::Compatibility::Native
        {
            return Err("native TS7 SDK is required".into());
        }
        live_files(&request)?;
        let executable = std::env::current_exe().map_err(|error| error.to_string())?;
        let artifact = fs::read(&executable).map_err(|error| error.to_string())?;
        let started = Instant::now();
        let observation = analyze(request.clone(), sdk.clone())?;
        let batch = batch::build(&request, &sdk, &observation)?;
        let stdout = serde_json::to_string(&batch).map_err(|error| error.to_string())?;
        let indexed = process::Outcome {
            kind: "success".into(),
            exit_code: Some(0),
            duration_ms: u64::try_from(started.elapsed().as_millis())
                .map_err(|error| error.to_string())?,
            stdout_bytes: stdout.len() as u64,
            stdout_hash: identity::digest_bytes(stdout.as_bytes())
                .trim_start_matches("sha256:")
                .into(),
            stdout,
            stderr: String::new(),
            stderr_bytes: 0,
            stderr_hash: identity::digest_bytes(b"")
                .trim_start_matches("sha256:")
                .into(),
        };
        live_files(&request)?;
        let received = receive_index(&request, &sdk, &indexed, &batch, &artifact)?;
        Ok((
            Self {
                request,
                sdk,
                indexed,
                batch,
                received,
                executable,
            },
            observation,
        ))
    }

    fn observe(
        &self,
        frame: Frame,
        phase: &str,
    ) -> Result<(Request, Observation, Vec<u8>), String> {
        if frame.phase != phase {
            return Err(format!("expected {phase} phase"));
        }
        if frame.files != self.request.files {
            return Err("application capture inventory or content changed".into());
        }
        if frame.graph != batch::graph_from_facts(&self.batch.facts) {
            return Err("application graph differs from received extraction".into());
        }
        let mut request = self.request.clone();
        request.files = frame.files;
        live_files(&request)?;
        let mut observation =
            Observation::capture(&request, &self.sdk, &self.indexed, &self.batch)?;
        observation.graph = frame.graph;
        let artifact = fs::read(&self.executable).map_err(|error| error.to_string())?;
        Ok((request, observation, artifact))
    }

    fn ownership(&self, frame: Frame) -> Result<Vec<Value>, String> {
        let (request, observation, artifact) = self.observe(frame, "ownership")?;
        let state = observation.state(&request, &self.batch, &artifact);
        let context = self
            .received
            .receiver
            .context(Some(&self.received.receipt), &state)
            .map_err(|error| format!("ownership receipt rejected: {error:?}"))?;
        let subjects = scope_received::inspect(&request, &self.sdk, &context)?;
        live_files(&request)?;
        let artifact = fs::read(&self.executable).map_err(|error| error.to_string())?;
        let state = observation.state(&request, &self.batch, &artifact);
        self.received
            .receiver
            .revalidate(&self.received.receipt, &state)
            .map_err(|error| format!("ownership receipt changed: {error:?}"))?;
        Ok(subjects)
    }

    fn finish(&self, frame: Frame) -> Result<(), String> {
        let (request, observation, artifact) = self.observe(frame, "final")?;
        let state = observation.state(&request, &self.batch, &artifact);
        self.received
            .receiver
            .revalidate(&self.received.receipt, &state)
            .map_err(|error| format!("final receipt rejected: {error:?}"))?;
        Ok(())
    }
}

fn read_frame(reader: &mut impl BufRead) -> Result<Frame, String> {
    let mut bytes = Vec::new();
    reader
        .take(FRAME_LIMIT as u64 + 1)
        .read_until(b'\n', &mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() > FRAME_LIMIT {
        return Err("frame exceeds 16 MiB".into());
    }
    if bytes.last() != Some(&b'\n') {
        return Err("incomplete frame or EOF".into());
    }
    serde_json::from_slice(&bytes).map_err(|error| format!("invalid frame: {error}"))
}

fn emit(writer: &mut impl Write, value: Value) -> Result<(), String> {
    let bytes = serde_json::to_vec(&value).map_err(|error| error.to_string())?;
    if bytes.len() >= FRAME_LIMIT {
        return Err("output frame exceeds 16 MiB".into());
    }
    writer
        .write_all(&bytes)
        .and_then(|()| writer.write_all(b"\n"))
        .and_then(|()| writer.flush())
        .map_err(|error| error.to_string())
}

fn run(args: &[String]) -> Result<(), String> {
    if args.len() != 4 {
        return Err("expected --experimental-application-session REQUEST.json SDK.json".into());
    }
    let request: Request =
        serde_json::from_slice(&fs::read(&args[2]).map_err(|error| error.to_string())?)
            .map_err(|error| error.to_string())?;
    let sdk: Sdk = serde_json::from_slice(&fs::read(&args[3]).map_err(|error| error.to_string())?)
        .map_err(|error| error.to_string())?;
    let (session, observation) = Session::start(request, sdk)?;
    let disposition = match session.received.receipt.disposition() {
        EvidenceDisposition::Analyzed => "analyzed",
        EvidenceDisposition::ControlledRefusal => "controlled_refusal",
    };
    let mut input = std::io::stdin().lock();
    let mut output = std::io::stdout().lock();
    emit(
        &mut output,
        json!({"phase":"produced","observation":observation,"disposition":disposition}),
    )?;
    let subjects = session.ownership(read_frame(&mut input)?)?;
    emit(
        &mut output,
        json!({"phase":"ownership","accepted":true,"subjects":subjects}),
    )?;
    session.finish(read_frame(&mut input)?)?;
    emit(&mut output, json!({"phase":"final","accepted":true}))
}

pub(super) fn command(args: &[String]) -> Result<(), String> {
    run(args).map_err(|error| format!("application session: {error}"))
}
