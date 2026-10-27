use serde_json::{Value, json};
use std::{
    fs,
    io::{BufRead, BufReader, Read, Write},
    path::PathBuf,
    process::{Child, ChildStdin, Command, Stdio},
    sync::mpsc::{self, Receiver},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

struct Fixture {
    directory: PathBuf,
    root: PathBuf,
    source: PathBuf,
    request_path: PathBuf,
    request: Value,
}

impl Fixture {
    fn new(source: &str) -> Self {
        let directory = std::env::var_os("SEMCTX_NATIVE_EVIDENCE")
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir)
            .join(format!(
                "application-session-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
        fs::create_dir_all(directory.join("workspace/src")).unwrap();
        let directory = directory.canonicalize().unwrap();
        let root = directory.join("workspace");
        let source_path = root.join("src/main.ts");
        fs::write(&source_path, source).unwrap();
        fs::write(root.join("CaseProbe"), "case").unwrap();
        let case_sensitive = !root.join("caseprobe").exists();
        fs::remove_file(root.join("CaseProbe")).unwrap();
        let request = json!({
            "id":"native-application-session","cwd":root,"sdk_directory":"/sdk/lib",
            "case_sensitive":case_sensitive,"roots":[source_path],
            "files":{(source_path.to_string_lossy()):source},
            "options":{"target":"ES2022","module":"ESNext","moduleResolution":"Bundler","allowJs":true,"jsx":"Preserve","skipLibCheck":true,"noEmit":true,"strict":false},
            "retained":true,"qualified":true
        });
        let request_path = directory.join("request.json");
        fs::write(&request_path, serde_json::to_vec(&request).unwrap()).unwrap();
        Self {
            directory,
            root,
            source: source_path,
            request_path,
            request,
        }
    }

    fn start(&self, replaceable: bool) -> Session {
        let binary = if replaceable {
            let binary = self.directory.join("producer");
            fs::copy(env!("CARGO_BIN_EXE_semctx-r0-probe"), &binary).unwrap();
            binary
        } else {
            PathBuf::from(env!("CARGO_BIN_EXE_semctx-r0-probe"))
        };
        let mut child = Command::new(&binary)
            .arg("--experimental-application-session")
            .arg(&self.request_path)
            .arg(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("sdk/sdk-input.json"))
            .current_dir(&self.root)
            .env("GOPORT_LIB_PARSE_SNAPSHOT", "0")
            .env("GOPORT_LIB_SNAPSHOT", "0")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        let (sender, frames) = mpsc::channel();
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let frame = line.map_err(|error| error.to_string()).and_then(|line| {
                    serde_json::from_str(&line).map_err(|error| error.to_string())
                });
                if sender.send(frame).is_err() {
                    break;
                }
            }
        });
        Session {
            child,
            stdin: Some(stdin),
            frames,
            binary,
        }
    }
}

struct Session {
    child: Child,
    stdin: Option<ChildStdin>,
    frames: Receiver<Result<Value, String>>,
    binary: PathBuf,
}

impl Session {
    fn frame(&mut self) -> Value {
        match self.frames.recv_timeout(Duration::from_secs(20)) {
            Ok(frame) => frame.unwrap(),
            Err(error) => {
                let mut diagnostic = String::new();
                if self.child.try_wait().unwrap().is_some() {
                    self.child
                        .stderr
                        .take()
                        .unwrap()
                        .read_to_string(&mut diagnostic)
                        .unwrap();
                }
                panic!("native session must emit its next frame: {error}; {diagnostic}");
            }
        }
    }
    fn send(&mut self, frame: &Value) {
        writeln!(self.stdin.as_mut().unwrap(), "{frame}").unwrap();
    }
    fn finish(&mut self, accepted: bool) -> String {
        self.stdin.take();
        let start = Instant::now();
        let status = loop {
            if let Some(status) = self.child.try_wait().unwrap() {
                break status;
            }
            assert!(
                start.elapsed() < Duration::from_secs(20),
                "native session failed to terminate"
            );
            thread::sleep(Duration::from_millis(10));
        };
        let mut stderr = String::new();
        self.child
            .stderr
            .take()
            .unwrap()
            .read_to_string(&mut stderr)
            .unwrap();
        assert_eq!(
            status.success(),
            accepted,
            "native session stderr: {stderr}"
        );
        assert!(
            self.frames.recv_timeout(Duration::from_secs(1)).is_err(),
            "unexpected accepted frame after terminal state"
        );
        stderr
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn graph(produced: &Value) -> Value {
    let assembly = &produced["observation"]["assembly"];
    json!({"nodes":assembly["nodes"],"edges":assembly["edges"]})
}

#[test]
fn native_application_session_keeps_receipt_through_ownership_and_final() {
    let fixture = Fixture::new("export function chosen() { return 7; }\n");
    let mut session = fixture.start(false);
    let produced = session.frame();
    assert_eq!(produced["phase"], "produced");
    assert_eq!(produced["disposition"], "analyzed");
    assert!(produced.get("receipt").is_none());
    let graph = graph(&produced);
    assert!(
        graph["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|node| node["name"] == "chosen")
    );
    session.send(&json!({"phase":"ownership","graph":graph,"files":fixture.request["files"]}));
    let ownership = session.frame();
    assert_eq!(ownership["phase"], "ownership");
    assert_eq!(ownership["accepted"], true);
    assert_eq!(ownership["subjects"][0]["path"], "src/main.ts");
    assert_eq!(ownership["subjects"][0]["outcome"], "analyzed");
    session.send(&json!({"phase":"final","graph":graph,"files":fixture.request["files"]}));
    assert_eq!(session.frame(), json!({"phase":"final","accepted":true}));
    assert!(session.finish(true).is_empty());
}

#[test]
fn native_application_session_refuses_mutations_before_either_receipt_revalidation() {
    for phase in ["ownership", "final"] {
        for mutation in [
            "graph-node",
            "graph-edge",
            "graph-evidence",
            "graph-extra",
            "capture",
            "inventory",
            "live",
            "missing",
            "artifact",
        ] {
            let fixture = Fixture::new("export function chosen() { return 7; }\n");
            let mut session = fixture.start(mutation == "artifact");
            let produced = session.frame();
            assert_eq!(produced["disposition"], "analyzed", "{phase}/{mutation}");
            let mut graph = graph(&produced);
            let mut files = fixture.request["files"].clone();
            if phase == "final" {
                session.send(&json!({"phase":"ownership","graph":graph,"files":files}));
                assert_eq!(session.frame()["accepted"], true);
            }
            match mutation {
                "graph-node" => graph["nodes"][0]["name"] = json!("forged"),
                "graph-edge" => {
                    graph["edges"].as_array_mut().unwrap().remove(0);
                }
                "graph-evidence" => {
                    graph["nodes"][0]["evidence"] =
                        json!([{"filePath":"foreign.ts","source":"forged"}])
                }
                "graph-extra" => graph["provenance"] = json!("unbound"),
                "capture" => {
                    files[fixture.source.to_string_lossy().as_ref()] =
                        json!("export const altered = 1;")
                }
                "inventory" => {
                    files.as_object_mut().unwrap().clear();
                }
                "live" => fs::write(&fixture.source, "export const altered = 1;").unwrap(),
                "missing" => fs::remove_file(&fixture.source).unwrap(),
                "artifact" => {
                    let replacement = fixture.directory.join("replacement");
                    fs::write(&replacement, b"changed native artifact").unwrap();
                    fs::rename(replacement, &session.binary).unwrap();
                }
                _ => unreachable!(),
            }
            session.send(&json!({"phase":phase,"graph":graph,"files":files}));
            let error = session.finish(false);
            assert!(
                error.contains("application session"),
                "{phase}/{mutation}: {error}"
            );
        }
    }
}

#[test]
fn native_application_session_preserves_refusal_diagnostics_without_ownership() {
    let fixture = Fixture::new("export const value = require('./missing');\n");
    let mut session = fixture.start(false);
    let produced = session.frame();
    assert_eq!(produced["phase"], "produced");
    assert_eq!(produced["disposition"], "controlled_refusal");
    assert!(
        !produced["observation"]["subjects"][0]["reasons"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    session.send(
        &json!({"phase":"ownership","graph":graph(&produced),"files":fixture.request["files"]}),
    );
    assert!(session.finish(false).contains("RefusalHasNoOwnership"));
}

#[test]
fn native_application_session_refuses_invalid_or_incomplete_frames() {
    for variant in [
        "eof",
        "malformed",
        "wrong-phase",
        "unknown-field",
        "oversized",
    ] {
        let fixture = Fixture::new("export function chosen() { return 7; }\n");
        let mut session = fixture.start(false);
        let produced = session.frame();
        assert_eq!(produced["disposition"], "analyzed");
        match variant {
            "eof" => { session.stdin.take(); },
            "malformed" => writeln!(session.stdin.as_mut().unwrap(), "{{").unwrap(),
            "wrong-phase" => session.send(&json!({"phase":"final","graph":graph(&produced),"files":fixture.request["files"]})),
            "unknown-field" => session.send(&json!({"phase":"ownership","graph":graph(&produced),"files":fixture.request["files"],"receipt":"forged"})),
            "oversized" => {
                let bytes = vec![b' '; 16_777_217];
                let _ = session.stdin.as_mut().unwrap().write_all(&bytes);
            }
            _ => unreachable!(),
        }
        assert!(
            session.finish(false).contains("application session"),
            "{variant}"
        );
    }
}

#[test]
fn native_application_session_rejects_unbound_initial_inputs_before_produced() {
    for variant in [
        "ordinary",
        "snapshotless",
        "empty-roots",
        "foreign-root",
        "foreign-capture",
        "changed-live",
        "utf16-capture",
        "raw-capture",
        "unknown-field",
    ] {
        let mut fixture = Fixture::new("export function chosen() { return 7; }\n");
        match variant {
            "ordinary" => fixture.request["qualified"] = json!(false),
            "snapshotless" => fixture.request["retained"] = json!(false),
            "empty-roots" => fixture.request["roots"] = json!([]),
            "foreign-root" => {
                fixture.request["roots"] = json!([fixture.directory.join("absent.ts")])
            }
            "foreign-capture" => {
                let path = fixture.directory.join("outside.ts");
                fs::write(&path, "export const value = 3;").unwrap();
                fixture.request["files"][path.to_string_lossy().as_ref()] =
                    json!("export const value = 3;");
            }
            "changed-live" => fs::write(&fixture.source, "export const changed = 1;").unwrap(),
            "utf16-capture" => {
                fixture.request["utf16_files"] = json!({(fixture.source.to_string_lossy()):[65]})
            }
            "raw-capture" => {
                fixture.request["raw_files"] = json!({(fixture.source.to_string_lossy()):{"bytes":[65],"profile":"retained_utf8"}})
            }
            "unknown-field" => fixture.request["receipt"] = json!("forged"),
            _ => unreachable!(),
        }
        fs::write(
            &fixture.request_path,
            serde_json::to_vec(&fixture.request).unwrap(),
        )
        .unwrap();
        let mut session = fixture.start(false);
        assert!(
            session.finish(false).contains("application session"),
            "{variant}"
        );
    }
}
