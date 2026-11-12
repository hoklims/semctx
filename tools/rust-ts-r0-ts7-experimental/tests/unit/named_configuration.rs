use crate::{CaptureFs, configuration};
use std::{collections::BTreeMap, rc::Rc};
use ts_goport::frontend::vfs::Fs;

fn snapshot(extends: bool) -> Rc<CaptureFs> {
    Rc::new(CaptureFs::new(
        BTreeMap::from([
            ("/repo/main.ts".into(), "export const value = 1;".into()),
            (
                "/repo/tsconfig.json".into(),
                if extends {
                    r#"{"extends":"./tsconfig.extra.json"}"#
                } else {
                    "{}"
                }
                .into(),
            ),
            ("/repo/tsconfig.extra.json".into(), "{}".into()),
        ]),
        true,
    ))
}

#[test]
fn named_configuration_cache_reuses_only_its_immutable_snapshot() {
    let paths = vec![
        "/repo/main.ts".into(),
        "/repo/tsconfig.json".into(),
        "/repo/tsconfig.extra.json".into(),
    ];
    let first = snapshot(true);
    assert!(
        configuration::unconsumed_named(first.clone(), "/repo", &paths)
            .unwrap()
            .is_empty()
    );
    let reads = first
        .log
        .borrow()
        .iter()
        .filter(|probe| probe.operation == "read_file")
        .count();
    assert!(reads > 0);
    assert!(
        configuration::unconsumed_named(first.clone(), "/repo", &paths)
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        first
            .log
            .borrow()
            .iter()
            .filter(|probe| probe.operation == "read_file")
            .count(),
        reads
    );
    let second = snapshot(false);
    assert_eq!(
        configuration::unconsumed_named(second.clone(), "/repo", &paths).unwrap(),
        ["SOURCE_NAMED_CONFIGURATION_UNSUPPORTED"]
    );
    assert!(
        configuration::unconsumed_named(first, "/repo", &paths)
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        configuration::unconsumed_named(second, "/repo", &paths).unwrap(),
        ["SOURCE_NAMED_CONFIGURATION_UNSUPPORTED"]
    );
}

#[test]
fn named_configuration_normalizes_relative_inputs() {
    let fs = snapshot(true);
    let paths = vec![
        "main.ts".into(),
        "tsconfig.json".into(),
        "nested/../tsconfig.extra.json".into(),
    ];
    assert!(
        configuration::unconsumed_named(fs, "/repo", &paths)
            .unwrap()
            .is_empty()
    );
}

#[test]
fn callback_normalization_resolves_posix_segments_before_separator_conversion() {
    let sensitive = CaptureFs::new(BTreeMap::new(), true);
    assert_eq!(
        super::normalized(&sensitive, "/repo", "nested/../Tsconfig.extra.json"),
        "/repo/Tsconfig.extra.json"
    );
    assert_eq!(
        super::normalized(&sensitive, "/repo", "\\repo\\tsconfig.extra.json"),
        "/repo//repo/tsconfig.extra.json"
    );
    let insensitive = CaptureFs::new(BTreeMap::new(), false);
    assert_eq!(
        super::normalized(&insensitive, "/Repo", "Tsconfig.extra.json"),
        "/repo/tsconfig.extra.json"
    );
}

#[test]
fn failed_native_reads_are_consumed_before_delegation_and_cached_with_the_snapshot() {
    let result = super::run(
        serde_json::json!({"root":"/repo","snapshots":[{"files":{"/repo/main.ts":"export {};","/repo/tsconfig.json":"{\"extends\":\"./tsconfig.extra.json\"}","/repo/tsconfig.extra.json":"{}"},"read_failures":["/repo/tsconfig.extra.json"]}],"passes":[0,0]}),
    );
    assert_eq!(result["executed"], true, "{result}");
    assert_eq!(
        result["passes"][0]["inspection"]["reasons"],
        serde_json::json!([])
    );
    let reads = result["passes"][0]["inspection"]["reads"]
        .as_array()
        .unwrap();
    assert!(
        reads
            .iter()
            .any(|read| read["path"] == "/repo/tsconfig.extra.json"
                && read["content"].is_null()
                && read["consumed_before_delegate"] == true)
    );
    assert_eq!(result["passes"][1]["inspection"]["cached"], true);
    assert_eq!(
        result["passes"][1]["inspection"]["reads"],
        serde_json::json!([])
    );
}

#[test]
fn malformed_governing_configuration_does_not_consume_the_named_chain() {
    let result = super::run(
        serde_json::json!({"root":"/repo","snapshots":[{"files":{"/repo/main.ts":"export {};","/repo/tsconfig.json":"{\"extends\":\"./tsconfig.extra.json\",","/repo/tsconfig.extra.json":"{}"}}],"passes":[0]}),
    );
    assert_eq!(result["executed"], true, "{result}");
    assert_eq!(
        result["passes"][0]["inspection"]["reasons"],
        serde_json::json!(["SOURCE_NAMED_CONFIGURATION_UNSUPPORTED"])
    );
    let reads = result["passes"][0]["inspection"]["reads"]
        .as_array()
        .unwrap();
    assert!(
        !reads
            .iter()
            .any(|read| read["path"] == "/repo/tsconfig.extra.json")
    );
}

struct ReadWitness {
    fs: CaptureFs,
    consumed: std::rc::Rc<std::cell::RefCell<std::collections::BTreeSet<String>>>,
    observed_at_entry: std::cell::RefCell<Vec<bool>>,
}

impl crate::configuration::System for ReadWitness {
    fn key(&self, path: &str) -> String {
        self.fs.key(path)
    }
    fn sensitive(&self) -> bool {
        self.fs.sensitive
    }
    fn probes(&self) -> std::rc::Rc<std::cell::RefCell<Vec<crate::Probe>>> {
        self.fs.log.clone()
    }
    fn configuration_exists(&self, path: &str) -> bool {
        self.fs.files.contains_key(&self.fs.key(path))
    }
}

impl ts_goport::frontend::vfs::Fs for ReadWitness {
    fn use_case_sensitive_file_names(&self) -> bool {
        self.fs.sensitive
    }
    fn read_file(&self, path: &str) -> (String, bool) {
        self.observed_at_entry
            .borrow_mut()
            .push(self.consumed.borrow().contains(path));
        self.fs.read_file(path)
    }
    fn file_exists(&self, path: &str) -> bool {
        self.fs.file_exists(path)
    }
    fn directory_exists(&self, path: &str) -> bool {
        self.fs.directory_exists(path)
    }
    fn get_accessible_entries(&self, path: &str) -> crate::Entries {
        self.fs.get_accessible_entries(path)
    }
    fn stat(&self, path: &str) -> Option<crate::FileInfo> {
        self.fs.stat(path)
    }
    fn realpath(&self, path: &str) -> String {
        self.fs.realpath(path)
    }
    fn write_file(&self, path: &str, text: &str) -> Result<(), crate::FsError> {
        self.fs.write_file(path, text)
    }
    fn append_file(&self, path: &str, text: &str) -> Result<(), crate::FsError> {
        self.fs.append_file(path, text)
    }
    fn remove(&self, path: &str) -> Result<(), crate::FsError> {
        self.fs.remove(path)
    }
    fn chtimes(
        &self,
        path: &str,
        access: Option<std::time::SystemTime>,
        modified: Option<std::time::SystemTime>,
    ) -> Result<(), crate::FsError> {
        self.fs.chtimes(path, access, modified)
    }
}

#[test]
fn actual_delegate_observes_consumption_before_successful_and_failed_reads() {
    for found in [true, false] {
        let path = "/repo/tsconfig.extra.json";
        let consumed = std::rc::Rc::new(std::cell::RefCell::new(std::collections::BTreeSet::new()));
        let witness = std::rc::Rc::new(ReadWitness {
            fs: CaptureFs::new(
                if found {
                    BTreeMap::from([(path.into(), "{}".into())])
                } else {
                    BTreeMap::new()
                },
                true,
            ),
            consumed: consumed.clone(),
            observed_at_entry: std::cell::RefCell::new(vec![]),
        });
        let recorder = super::RecordingSystem {
            fs: witness.clone(),
            consumed,
            reads: std::cell::RefCell::new(vec![]),
        };
        assert_eq!(recorder.read_file(path).1, found);
        assert_eq!(
            *witness.observed_at_entry.borrow(),
            [true],
            "delegate must observe consumption before returning success={found}"
        );
    }
}

#[cfg(unix)]
#[test]
fn source_parent_is_derived_before_normalizing_a_posix_source_key() {
    for (source, first_read, reasons) in [
        (
            "/repo/src\\extra.ts",
            "/repo/tsconfig.json",
            serde_json::json!(["SOURCE_NAMED_CONFIGURATION_UNSUPPORTED"]),
        ),
        (
            "/repo/src/extra.ts",
            "/repo/src/tsconfig.json",
            serde_json::json!([]),
        ),
    ] {
        let observed = super::run(
            serde_json::json!({"root":"/repo","snapshots":[{"files":{(source):"export const extra=1;","/repo/tsconfig.json":"{}","/repo/src/tsconfig.json":"{\"extends\":\"./tsconfig.extra.json\"}","/repo/src/tsconfig.extra.json":"{}"}}],"passes":[0]}),
        );
        assert_eq!(observed["executed"], true, "{observed}");
        let inspection = &observed["passes"][0]["inspection"];
        assert_eq!(inspection["reasons"], reasons, "{source}");
        assert_eq!(inspection["reads"][0]["path"], first_read, "{source}");
    }
}
