use crate::{
    Case, ExpectedOutcome, SupportStatus, artifact, digest, json,
    process::{self, Observation},
    refusal, verify,
};
use serde_json::{Value, json as j};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};

pub const BASE: &str = "export interface CartTotal {\n  subtotalCents: number;\n  taxCents: number;\n}\nexport function computeCartTotal(subtotalCents: number, taxCents: number): CartTotal {\n  return { subtotalCents, taxCents };\n}\n";
pub const RISK: &str = "export interface CartTotal {\n  subtotalCents: number;\n  taxCents: number;\n  discountCents: number;\n}\nexport function computeCartTotal(subtotalCents: number, taxCents: number, discountCents: number): CartTotal {\n  return { subtotalCents, taxCents, discountCents };\n}\n";
pub const SYMBOL: &str =
    "export function oldSymbol(): number {\n  // original comment\n  return 1;\n}\n";

pub struct Runner {
    pub cli: PathBuf,
    pub mcp: PathBuf,
    pub runtime: crate::Runtime,
    pub out: PathBuf,
    pub cases: Vec<Case>,
    pub next: usize,
}

impl Runner {
    pub fn record(&mut self, label: &str, value: &impl serde::Serialize) -> Result<String, String> {
        self.next += 1;
        let name = format!("raw/{:03}-{label}.json", self.next);
        let bytes = serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?;
        fs::write(self.out.join(&name), &bytes).map_err(|e| e.to_string())?;
        Ok(format!("{name}#sha256={}", digest(&bytes)))
    }
    pub fn cli(&mut self, root: &Path, args: &[&str]) -> Result<(Observation, String), String> {
        let mut command = self.runtime.command(&self.cli);
        command.args(args).arg("--root").arg(root);
        let observed =
            process::run(&mut command, root, process::BUDGET).map_err(|e| e.to_string())?;
        let file = self.record(
            args[0],
            &j!({"argv": args, "root":root, "observation":observed}),
        )?;
        Ok((observed, file))
    }
    pub fn case(
        &mut self,
        id: &str,
        support: SupportStatus,
        observation: String,
        result: Result<(), String>,
        expected: ExpectedOutcome,
    ) {
        self.cases.push(Case {
            id: id.into(),
            support_status: support.as_str().into(),
            outcome: if result.is_err() {
                "failure"
            } else {
                expected.as_str()
            }
            .into(),
            obligations: vec![id.into()],
            observations: vec![observation],
            detail: result
                .err()
                .unwrap_or_else(|| "all frozen assertions matched".into()),
        });
    }
    pub fn index(&mut self, root: &Path) -> Result<(), String> {
        let (ob, _) = self.cli(root, &["index", "--record"])?;
        if ob.code != Some(0) || ob.timed_out || ob.output_exceeded {
            return Err(format!(
                "index failed: {:?}: {} {}",
                ob.code, ob.stdout, ob.stderr
            ));
        }
        Ok(())
    }
}

pub fn git(root: &Path, args: &[&str]) -> Result<(), String> {
    let observed = process::run(Command::new("git").args(args), root, process::BUDGET)
        .map_err(|e| e.to_string())?;
    if observed.code != Some(0) || observed.timed_out || observed.output_exceeded {
        return Err(format!("git {args:?}: {}", observed.stderr));
    }
    Ok(())
}
pub fn commit(root: &Path) -> Result<(), String> {
    git(root, &["add", "-A"])?;
    git(
        root,
        &[
            "-c",
            "user.name=Semctx Qualification",
            "-c",
            "user.email=qualification@example.test",
            "commit",
            "--allow-empty",
            "-q",
            "-m",
            "frozen qualification fixture",
        ],
    )
}
pub fn write(root: &Path, rel: &str, text: &str) -> Result<(), String> {
    let path = root.join(rel);
    fs::create_dir_all(path.parent().ok_or("missing fixture parent")?)
        .map_err(|e| e.to_string())?;
    fs::write(path, text).map_err(|e| e.to_string())
}
pub fn fixture(root: &Path) -> Result<(), String> {
    git(root, &["init", "-q", "-b", "main"])?;
    for (path, value) in [
        (".gitignore", ".semctx/\n"),
        (
            "package.json",
            "{\"name\":\"semctx-qualification-fixture\",\"private\":true,\"type\":\"module\"}\n",
        ),
        (
            "tsconfig.json",
            "{\"compilerOptions\":{\"target\":\"ES2022\",\"module\":\"ESNext\",\"moduleResolution\":\"bundler\",\"strict\":true,\"noEmit\":true,\"skipLibCheck\":true,\"types\":[]},\"include\":[\"src/**/*.ts\"]}\n",
        ),
        ("src/cart.ts", BASE),
        ("src/symbol.ts", SYMBOL),
    ] {
        write(root, path, value)?;
    }
    commit(root)
}

fn field(value: &Value, pointer: &str, expected: &Value) -> Result<(), String> {
    if value.pointer(pointer) != Some(expected) {
        Err(format!(
            "expected {pointer}={expected}, observed {:?}",
            value.pointer(pointer)
        ))
    } else {
        Ok(())
    }
}

fn qualify_cli_changes(runner: &mut Runner, root: &Path) -> Result<(), String> {
    fixture(root)?;
    let (ob, raw) = runner.cli(root, &["setup", "--json"])?;
    runner.case(
        "cli.setup",
        SupportStatus::Supported,
        raw,
        json(&ob, 0).and_then(|v| field(&v, "/setupReady", &j!(true))),
        ExpectedOutcome::UsefulSuccess,
    );
    // Setup deliberately creates versionable semantic/configuration files; establish their baseline.
    commit(root)?;
    runner.index(root)?;

    write(
        root,
        "src/symbol.ts",
        &SYMBOL.replace("original comment", "clarified comment"),
    )?;
    runner.index(root)?;
    let (ob, raw) = runner.cli(root, &["verify", "diff", "--json"])?;
    runner.case(
        "cli.benign",
        SupportStatus::Supported,
        raw,
        verify(&ob, &["src/symbol.ts"], "PASS").map(|_| ()),
        ExpectedOutcome::UsefulSuccess,
    );
    write(root, "src/symbol.ts", SYMBOL)?;
    write(root, "src/cart.ts", RISK)?;
    runner.index(root)?;
    let (ob, raw) = runner.cli(root, &["verify", "diff", "--json"])?;
    runner.case(
        "cli.contract-risk",
        SupportStatus::Supported,
        raw,
        verify(&ob, &["src/cart.ts"], "WARN").and_then(|v| {
            if !v["findings"]
                .as_array()
                .ok_or("missing findings")?
                .iter()
                .any(|f| f["rule"] == "contract_changed_without_test" && f["severity"] == "warn")
            {
                return Err("missing discriminant contract risk".into());
            }
            Ok(())
        }),
        ExpectedOutcome::UsefulSuccess,
    );
    write(root, "src/cart.ts", BASE)?;
    runner.index(root)?;

    Ok(())
}

fn qualify_cli_refusals(runner: &mut Runner, root: &Path) -> Result<(), String> {
    let db = root.join(".semctx/semctx.db");
    let backup = root.join(".semctx/held.db");
    fs::rename(&db, &backup).map_err(|e| e.to_string())?;
    let (ob, raw) = runner.cli(root, &["verify", "diff", "--json"])?;
    runner.case(
        "cli.missing-index",
        SupportStatus::Unsupported,
        raw,
        refusal(&ob, "REPO_NOT_INDEXED"),
        ExpectedOutcome::ControlledRefusal,
    );
    fs::rename(&backup, &db).map_err(|e| e.to_string())?;

    let config = root.join(".semctx/config.json");
    let bytes = fs::read(&config).map_err(|e| e.to_string())?;
    fs::write(&config, b"{ invalid json").map_err(|e| e.to_string())?;
    let (ob, raw) = runner.cli(root, &["index"])?;
    let unchanged = fs::read(&config).map_err(|e| e.to_string())? == b"{ invalid json";
    runner.case(
        "cli.invalid-config",
        SupportStatus::Unsupported,
        raw,
        refusal(&ob, "CONFIG_INVALID").and_then(|_| {
            if unchanged {
                Ok(())
            } else {
                Err("refusal modified config".into())
            }
        }),
        ExpectedOutcome::ControlledRefusal,
    );
    fs::write(&config, bytes).map_err(|e| e.to_string())?;

    Ok(())
}

fn qualify_cli_recovery(runner: &mut Runner, root: &Path) -> Result<(), String> {
    write(
        root,
        "src/symbol.ts",
        &SYMBOL.replace("return 1", "return 2"),
    )?;
    let (ob, raw) = runner.cli(root, &["status", "--json"])?;
    runner.case(
        "cli.stale",
        SupportStatus::Supported,
        raw,
        json(&ob, 3).and_then(|v| {
            // Recorded semantic evidence is checked before the freshness seal: source drift
            // invalidates the evidence baseline and therefore yields UNSEALED, not STALE.
            field(&v, "/verdict", &j!("UNSEALED"))?;
            field(&v, "/canRunHighRiskControl", &j!(false))?;
            if !v["explanation"].as_array().is_some_and(|a| {
                a.iter().any(|r| {
                    r["code"] == "EVIDENCE_BASELINE_STALE" && r["remedy"] == "semctx index --record"
                })
            }) {
                return Err("drift report lacks exact evidence-baseline remedy".into());
            }
            Ok(())
        }),
        ExpectedOutcome::ControlledRefusal,
    );
    write(root, "src/symbol.ts", SYMBOL)?;
    runner.index(root)?;
    let (ob, raw) = runner.cli(root, &["status", "--json"])?;
    runner.case(
        "cli.repaired",
        SupportStatus::Supported,
        raw,
        json(&ob, 0).and_then(|v| field(&v, "/verdict", &j!("FRESH"))),
        ExpectedOutcome::UsefulSuccess,
    );

    Ok(())
}

pub fn run(runner: &mut Runner, root: &Path) -> Result<(), String> {
    qualify_cli_changes(runner, root)?;
    qualify_cli_refusals(runner, root)?;
    qualify_cli_recovery(runner, root)?;
    // Python is explicitly partial: the product reports missing negative completeness.
    // Use a fresh independent v2 workspace: --polyglot must never overwrite a v1 config.
    let partial = tempfile::Builder::new()
        .prefix("semctx-qualification-partial-")
        .tempdir()
        .map_err(|e| e.to_string())?;
    fixture(partial.path())?;
    write(
        partial.path(),
        "src/service.py",
        "def service():\n    return 1\n",
    )?;
    commit(partial.path())?;
    let (ob, raw) = runner.cli(partial.path(), &["setup", "--polyglot", "--json"])?;
    runner.case(
        "cli.partial-coverage",
        SupportStatus::Partial,
        raw,
        json(&ob, 0).and_then(|v| {
            field(&v, "/setupReady", &j!(true))?;
            field(&v, "/indexHealth/coverage/status", &j!("partial"))?;
            field(&v, "/selection/selectedByLanguage/python", &j!(1))?;
            if !v["indexHealth"]["reasonSummary"]
                .as_array()
                .ok_or("missing partial reasons")?
                .contains(&j!("NEGATIVE_COMPLETENESS_MISSING"))
            {
                return Err("partial reason is hidden".into());
            }
            Ok(())
        }),
        ExpectedOutcome::UsefulSuccess,
    );
    crate::mcp::run(runner, root)?;
    // Detect modifications to all selected immutable artifacts after the journey.
    for path in [&runner.cli, &runner.mcp] {
        artifact(path)?;
    }
    Ok(())
}
