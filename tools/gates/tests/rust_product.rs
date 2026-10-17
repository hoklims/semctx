#![cfg(test)]
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Output},
    sync::atomic::{AtomicUsize, Ordering},
};
static NEXT: AtomicUsize = AtomicUsize::new(0);
struct Repo {
    root: PathBuf,
}
impl Repo {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "semctx-native-product-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&root).unwrap();
        git(&root, &["init", "-q"]);
        let repo = Self { root };
        repo.write(".gitignore", "target/\n");
        repo
    }
    fn write(&self, path: &str, value: &str) {
        let path = self.root.join(path);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, value).unwrap();
    }
    fn crate_at(&self, directory: &str, name: &str, passing: bool, lock: bool) {
        self.write(
            &format!("{directory}/Cargo.toml"),
            &format!("[package]\nname = \"{name}\"\nversion = \"0.1.0\"\nedition = \"2024\"\n"),
        );
        self.write(&format!("{directory}/src/lib.rs"), &format!("#[test]\nfn actual_product_invariant() {{ assert!({passing}, \"PRODUCT_INVARIANT\"); }}\n"));
        if lock {
            self.write(
                &format!("{directory}/Cargo.lock"),
                &format!("version = 4\n\n[[package]]\nname = \"{name}\"\nversion = \"0.1.0\"\n"),
            );
        }
    }
    fn track(&self) {
        git(&self.root, &["add", "."]);
    }
    fn run(&self) -> Output {
        Command::new(env!("CARGO_BIN_EXE_semctx-gates"))
            .arg("rust-test")
            .arg("--root")
            .arg(&self.root)
            .output()
            .unwrap()
    }
}
impl Drop for Repo {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}
fn git(root: &Path, args: &[&str]) {
    let result = Command::new("git")
        .current_dir(root)
        .args(args)
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
}
#[test]
fn native_product_assertion_fails_then_corrected_product_passes() {
    let r = Repo::new();
    r.crate_at("native/product", "fixture_product", false, true);
    r.track();
    let red = r.run();
    assert!(!red.status.success());
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&red.stdout),
        String::from_utf8_lossy(&red.stderr)
    );
    assert!(
        text.contains("PRODUCT_INVARIANT"),
        "failure must be the actual assertion: {text}"
    );
    r.crate_at("native/product", "fixture_product", true, true);
    r.track();
    let green = r.run();
    assert!(
        green.status.success(),
        "{}",
        String::from_utf8_lossy(&green.stderr)
    );
    let value: serde_json::Value = serde_json::from_slice(&green.stdout).unwrap();
    assert_eq!(value["status"], "passed");
    assert_eq!(value["runs"].as_array().unwrap().len(), 1);
}
#[test]
fn newly_tracked_product_manifest_is_never_ignored() {
    let r = Repo::new();
    r.crate_at("native/a", "fixture_a", true, true);
    r.track();
    assert!(r.run().status.success());
    r.crate_at("other/new", "fixture_new", false, true);
    r.track();
    let red = r.run();
    assert!(!red.status.success());
    assert!(String::from_utf8_lossy(&red.stdout).contains("fixture_new"));
}
#[test]
fn no_product_does_not_qualify_an_absent_port() {
    let r = Repo::new();
    r.crate_at("tools/gates", "fake_tool", false, true);
    r.crate_at("tools/qualification", "fake_qualification", false, true);
    r.track();
    let output = r.run();
    assert!(output.status.success());
    let value: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(value["status"], "no_product");
    assert!(
        value["message"]
            .as_str()
            .unwrap()
            .contains("no native product crates yet")
    );
    assert_eq!(value["runs"].as_array().unwrap().len(), 0);
}
#[test]
fn missing_lock_is_an_explicit_refusal() {
    let r = Repo::new();
    r.crate_at("native/product", "fixture_product", true, false);
    r.track();
    let result = r.run();
    assert!(!result.status.success());
    assert!(String::from_utf8_lossy(&result.stderr).contains("Cargo.lock"));
}
#[test]
fn workspace_members_are_tested_once_each_with_the_root_owner() {
    let r = Repo::new();
    r.crate_at("native/a", "fixture_workspace_a", true, false);
    r.crate_at("native/b", "fixture_workspace_b", true, false);
    r.write(
        "Cargo.toml",
        "[workspace]\nmembers = [\"native/a\", \"native/b\"]\nresolver = \"3\"\n",
    );
    r.write("Cargo.lock", "version = 4\n\n[[package]]\nname = \"fixture_workspace_a\"\nversion = \"0.1.0\"\n\n[[package]]\nname = \"fixture_workspace_b\"\nversion = \"0.1.0\"\n");
    r.track();
    let output = r.run();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let value: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(value["runs"].as_array().unwrap().len(), 2);
    assert!(
        value["runs"][0]["action"]["argv"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v == "--package")
    );
}
#[test]
fn a_tested_workspace_member_cannot_mask_an_untested_member() {
    let r = Repo::new();
    r.crate_at("native/a", "fixture_workspace_a", true, false);
    r.crate_at("native/b", "fixture_workspace_b", true, false);
    r.write("native/b/src/lib.rs", "pub fn compiled_only() {}\n");
    r.write(
        "Cargo.toml",
        "[workspace]\nmembers = [\"native/a\", \"native/b\"]\nresolver = \"3\"\n",
    );
    r.write("Cargo.lock", "version = 4\n\n[[package]]\nname = \"fixture_workspace_a\"\nversion = \"0.1.0\"\n\n[[package]]\nname = \"fixture_workspace_b\"\nversion = \"0.1.0\"\n");
    r.track();
    let output = r.run();
    assert!(
        !output.status.success(),
        "a different member's tests cannot qualify an empty crate"
    );
    let value: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(value["status"], "failed");
    assert!(
        value["message"]
            .as_str()
            .unwrap()
            .contains("fixture_workspace_b"),
        "{value:#}"
    );
}
#[test]
fn zero_executed_tests_cannot_qualify_a_compile_only_crate() {
    let r = Repo::new();
    r.crate_at("native/product", "fixture_empty", true, true);
    r.write("native/product/src/lib.rs", "pub fn compiled_only() {}\n");
    r.track();
    let output = r.run();
    assert!(!output.status.success());
    let value: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(value["status"], "failed");
    assert!(
        value["message"]
            .as_str()
            .unwrap()
            .contains("execution unproven")
    );
}
