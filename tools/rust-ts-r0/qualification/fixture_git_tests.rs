//! Actual Git fixture behavior; the hostile global configuration exists only in a child.
use super::*;
use std::process::Command;

const CHILD_ROOT: &str = "SEMCTX_GIT_FIXTURE_TEST_CHILD_ROOT";
const SOURCE: &str = "export const fixture = 1;\n";
const GLOBAL: &str = "[core]\n\tautocrlf = true\n\tsafecrlf = warn\n";

fn git(root: &Path, evidence: &Path, helper: &Path, args: &[&str]) -> process::Outcome {
    let mut argv = vec!["git".to_string()];
    argv.extend(args.iter().map(|value| value.to_string()));
    let helper_sha = sha(&fs::read(helper).unwrap());
    invoke(&argv, root, evidence, helper, &[(helper, &helper_sha)]).unwrap()
}

fn assert_origin(outcome: &process::Outcome, file: &Path, cwd: &Path, expected: &str) {
    assert_eq!(outcome.exit_code, Some(0));
    assert!(outcome.stderr.is_empty());
    let (origin, value) = outcome.stdout.trim_end().split_once('\t').unwrap();
    let source = PathBuf::from(origin.strip_prefix("file:").unwrap());
    let source = if source.is_absolute() {
        source
    } else {
        cwd.join(source)
    };
    assert_eq!(
        source.canonicalize().unwrap(),
        file.canonicalize().unwrap(),
        "Git must read the exact isolated configuration source"
    );
    assert_eq!(value, expected);
}

fn child(root: &Path) {
    let home = root.join("home");
    let global = home.join(".gitconfig");
    for key in ["HOME", "USERPROFILE"] {
        assert_eq!(std::env::var_os(key), Some(home.clone().into_os_string()));
    }
    assert_eq!(
        std::env::var_os("XDG_CONFIG_HOME"),
        Some(root.join("xdg").into_os_string())
    );
    assert_eq!(fs::read_to_string(&global).unwrap(), GLOBAL);
    let helper = PathBuf::from(std::env::var_os("SEMCTX_PROCESS_HELPER").unwrap());
    let helper_sha = sha(&fs::read(&helper).unwrap());
    let fixture = root.join("fixture");
    let outside = root.join("outside");
    let evidence = root.join("evidence");
    fs::create_dir(&fixture).unwrap();
    fs::create_dir(&outside).unwrap();
    fs::create_dir(&evidence).unwrap();
    fs::write(fixture.join("fixture.ts"), SOURCE).unwrap();
    fs::write(outside.join("fixture.ts"), SOURCE).unwrap();
    assert_eq!(
        git(
            &outside,
            &evidence.join("outside-init.json"),
            &helper,
            &["init", "-q"]
        )
        .exit_code,
        Some(0)
    );
    let global_origin = git(
        &outside,
        &evidence.join("global-origin.json"),
        &helper,
        &[
            "config",
            "--global",
            "--show-origin",
            "--get",
            "core.autocrlf",
        ],
    );
    assert_origin(&global_origin, &global, &outside, "true");
    let outside_add = git(
        &outside,
        &evidence.join("outside-add.json"),
        &helper,
        &["add", "."],
    );
    assert_eq!(outside_add.exit_code, Some(0));
    assert!(outside_add.stderr.contains("LF") && outside_add.stderr.contains("CRLF"));

    let commands = json!([
        ["git", "init", "-q"],
        ["git", "add", "."],
        [
            "git",
            "-c",
            "user.name=T00Fixture",
            "-c",
            "user.email=t00@example.test",
            "commit",
            "-qm",
            "initial"
        ]
    ]);
    initialize_fixture_git(
        &commands,
        &fixture,
        &evidence,
        &helper,
        &[(&helper, &helper_sha)],
    )
    .unwrap();
    let added = read_json(&evidence.join("git-setup-1.json")).unwrap();
    let indexed = git(
        &fixture,
        &evidence.join("index-bytes.json"),
        &helper,
        &["show", ":fixture.ts"],
    );
    let local_autocrlf = git(
        &fixture,
        &evidence.join("local-autocrlf.json"),
        &helper,
        &[
            "config",
            "--local",
            "--type=bool",
            "--show-origin",
            "--get",
            "core.autocrlf",
        ],
    );
    let local_safecrlf = git(
        &fixture,
        &evidence.join("local-safecrlf.json"),
        &helper,
        &[
            "config",
            "--local",
            "--type=bool",
            "--show-origin",
            "--get",
            "core.safecrlf",
        ],
    );
    let outsider_config = git(
        &outside,
        &evidence.join("outside-config.json"),
        &helper,
        &[
            "config",
            "--type=bool",
            "--show-origin",
            "--get",
            "core.autocrlf",
        ],
    );
    let real_error = git(
        &fixture,
        &evidence.join("bad-ref.json"),
        &helper,
        &["rev-parse", "--verify", "refs/heads/no-such-fixture-ref"],
    );
    assert_eq!(fs::read_to_string(&global).unwrap(), GLOBAL);
    assert_eq!(
        fs::read_to_string(fixture.join("fixture.ts")).unwrap(),
        SOURCE
    );
    assert_eq!(indexed.stdout, SOURCE);
    assert_eq!(indexed.exit_code, Some(0));
    assert_origin(&outsider_config, &global, &outside, "true");
    assert_ne!(real_error.exit_code, Some(0));
    assert!(!real_error.stderr.is_empty());
    assert_eq!(added["outcome"]["exit_code"], 0);
    assert_eq!(
        added["outcome"]["stderr"], "",
        "configured fixture still inherited Git conversion warnings"
    );
    assert_origin(
        &local_autocrlf,
        &fixture.join(".git/config"),
        &fixture,
        "false",
    );
    assert_origin(
        &local_safecrlf,
        &fixture.join(".git/config"),
        &fixture,
        "false",
    );
}

#[test]
fn fixture_local_line_endings_preserve_bytes_and_external_policy() {
    if let Some(root) = std::env::var_os(CHILD_ROOT) {
        child(&PathBuf::from(root));
        return;
    }
    let parent = std::env::var_os("SEMCTX_GIT_FIXTURE_TEST_EVIDENCE")
        .map_or_else(std::env::temp_dir, PathBuf::from);
    let root = parent.join(format!(
        "semctx-git-fixture-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir(&root).unwrap();
    let home = root.join("home");
    let xdg = root.join("xdg");
    fs::create_dir(&home).unwrap();
    fs::create_dir(&xdg).unwrap();
    let global = home.join(".gitconfig");
    fs::write(&global, GLOBAL).unwrap();
    save(
        &root.join("isolated-home.json"),
        &json!({
            "HOME":home,"USERPROFILE":home,"XDG_CONFIG_HOME":xdg,
            "global_config":global,"global_config_sha256":sha(GLOBAL.as_bytes()),
            "scope":"test child process only; GIT_ overrides are not relied upon"
        }),
    )
    .unwrap();
    let module = module_path!().split_once("::").unwrap().1;
    let name = format!("{module}::fixture_local_line_endings_preserve_bytes_and_external_policy");
    let mut command = Command::new(std::env::current_exe().unwrap());
    command
        .args(["--exact", &name, "--nocapture", "--test-threads=1"])
        .env(CHILD_ROOT, &root)
        .env("HOME", &home)
        .env("USERPROFILE", &home)
        .env("XDG_CONFIG_HOME", &xdg);
    for key in [
        "GIT_CONFIG",
        "GIT_CONFIG_GLOBAL",
        "GIT_CONFIG_COUNT",
        "GIT_CONFIG_PARAMETERS",
        "GIT_DIR",
        "GIT_COMMON_DIR",
        "GIT_WORK_TREE",
        "GIT_INDEX_FILE",
    ] {
        command.env_remove(key);
    }
    let output = command.output().unwrap();
    fs::write(root.join("child.stdout"), &output.stdout).unwrap();
    fs::write(root.join("child.stderr"), &output.stderr).unwrap();
    println!("GIT_FIXTURE_EVIDENCE:{}", root.display());
    assert!(
        output.status.success(),
        "isolated Git fixture failed: {}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}
