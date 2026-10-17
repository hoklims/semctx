#![cfg(test)]

use serde_json::Value;
use std::{fs, process::Command};

#[test]
fn native_cli_adapter_records_identity_and_rejects_a_non_product_rust_fixture() {
    let root = tempfile::tempdir().unwrap();
    let distribution = root.path().join("distribution");
    fs::create_dir(&distribution).unwrap();
    let suffix = std::env::consts::EXE_SUFFIX;
    let cli = distribution.join(format!("fixture-cli{suffix}"));
    let mcp = distribution.join(format!("fixture-mcp{suffix}"));
    // The already-built Rust harness is a native fixture, deliberately lacking the
    // product's CLI/MCP semantics. Never compile or resolve a runtime in the consumer.
    for destination in [&cli, &mcp] {
        fs::copy(env!("CARGO_BIN_EXE_semctx-qualification"), destination).unwrap();
    }
    let output = root.path().join("observations");
    let observed = Command::new(env!("CARGO_BIN_EXE_semctx-qualification"))
        .arg("--cli")
        .arg(&cli)
        .arg("--mcp")
        .arg(&mcp)
        .args(["--runtime", "native", "--out"])
        .arg(&output)
        .output()
        .unwrap();
    assert_eq!(observed.status.code(), Some(1));
    let report: Value = serde_json::from_slice(&observed.stdout).unwrap();
    assert_eq!(report["status"], "failed");
    assert_eq!(report["runtime"]["kind"], "native");
    assert_eq!(report["adapter"], "native-explicit-v1");
    assert!(report["runtime"].get("version").is_none());
    assert_eq!(report["host_activation"], "not_observed");
    assert_eq!(report["host_os"], std::env::consts::OS);
    assert_eq!(report["host_arch"], std::env::consts::ARCH);
    assert_eq!(report["arch"], report["host_arch"]);
    assert_eq!(
        semctx_qualification::lane_host_os(report["os"].as_str().unwrap()),
        Some(std::env::consts::OS)
    );
    assert_eq!(
        report["cases"].as_array().unwrap().len(),
        semctx_qualification::CASES.len()
    );
    assert!(
        report["cases"]
            .as_array()
            .unwrap()
            .iter()
            .all(|case| case["outcome"] == "failure")
    );
    assert!(output.join("raw/001-runtime-identity.json").is_file());
    assert!(!output.join("raw/001-runtime-version.json").exists());
    let stored: Value =
        serde_json::from_slice(&fs::read(output.join("report.json")).unwrap()).unwrap();
    assert_eq!(report, stored);
}

#[test]
fn producer_rejects_an_os_lane_different_from_its_actual_host_before_qualification() {
    let wrong = if std::env::consts::OS == "windows" {
        "ubuntu-latest"
    } else {
        "windows-latest"
    };
    let observed = Command::new(env!("CARGO_BIN_EXE_semctx-qualification"))
        .args(["--os", wrong])
        .output()
        .unwrap();
    assert_eq!(observed.status.code(), Some(1));
    let report: Value = serde_json::from_slice(&observed.stdout).unwrap();
    assert_eq!(report["status"], "failed");
    assert!(
        report["error"]
            .as_str()
            .unwrap()
            .contains("does not match observed host OS")
    );
    assert!(report.get("cases").is_none());
}
