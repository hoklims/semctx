use std::{fs, path::PathBuf, process::Command};

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../fixture")
        .join(name)
}

#[test]
fn reports_symbols_and_preserves_fixture_doc_markers() {
    let output = Command::new(env!("CARGO_BIN_EXE_semctx-rust-syn-probe"))
        .arg(fixture("domain/src/model.rs"))
        .output()
        .unwrap();
    assert!(output.status.success());
    let output = String::from_utf8(output.stdout).unwrap();
    assert!(
        output.contains("summary\titems\t3\tmethods\t1\n"),
        "{output}"
    );
    assert!(output.contains("symbol\tstruct\tAmount\t"), "{output}");
    assert!(
        output.contains("@invariant discovery-fixture-only:"),
        "{output}"
    );
}

#[test]
fn rejects_malformed_source_without_partial_summary() {
    let output = Command::new(env!("CARGO_BIN_EXE_semctx-rust-syn-probe"))
        .arg(fixture("negative/malformed.rs"))
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    assert!(String::from_utf8(output.stderr).unwrap().contains("parse:"));
}

#[test]
fn rejects_missing_arguments_and_unreadable_sources() {
    let executable = env!("CARGO_BIN_EXE_semctx-rust-syn-probe");
    let missing_argument = Command::new(executable).output().unwrap();
    assert!(!missing_argument.status.success());
    assert!(String::from_utf8(missing_argument.stderr)
        .unwrap()
        .contains("usage:"));
    let unreadable = Command::new(executable)
        .arg(fixture("absent.rs"))
        .output()
        .unwrap();
    assert!(!unreadable.status.success());
    assert!(String::from_utf8(unreadable.stderr)
        .unwrap()
        .contains("read:"));
}

#[test]
fn rejects_invalid_utf8_before_parsing() {
    let path = std::env::temp_dir().join(format!("semctx-346-invalid-utf8-{}", std::process::id()));
    fs::write(&path, [0xff, 0xfe]).unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_semctx-rust-syn-probe"))
        .arg(&path)
        .output()
        .unwrap();
    fs::remove_file(path).unwrap();
    assert!(!output.status.success());
    assert!(String::from_utf8(output.stderr).unwrap().contains("read:"));
}

#[test]
fn reports_original_byte_ranges_after_bom_with_unicode_and_crlf() {
    let path = std::env::temp_dir().join(format!("semctx-346-bom-{}", std::process::id()));
    for (source, expected) in [
        ("\u{feff}fn okay() {}\n", "symbol\tfn\tokay\t3\t15\t"),
        ("\u{feff}fn café() {}\r\n", "symbol\tfn\tcafé\t3\t16\t"),
    ] {
        fs::write(&path, source).unwrap();
        let output = Command::new(env!("CARGO_BIN_EXE_semctx-rust-syn-probe"))
            .arg(&path)
            .output()
            .unwrap();
        assert!(output.status.success());
        let output = String::from_utf8(output.stdout).unwrap();
        assert!(output.contains(expected), "{output}");
    }
    fs::remove_file(path).unwrap();
}
