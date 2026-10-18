use super::receiver_context::*;
use semctx_gates::process::{self, Outcome};
use semctx_r0_probe::{identity, receiver::*, wire};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    fs,
    path::Path,
    time::{Duration, Instant},
};

pub(super) struct Tools<'a> {
    pub producer: &'a Path,
    pub helper: &'a Path,
    pub fixture: &'a Path,
    pub sdk: &'a Path,
}

fn file_hash(path: &Path) -> Result<String, String> {
    let bytes = fs::read(path).map_err(|error| error.to_string())?;
    Ok(identity::digest_bytes(&bytes)
        .trim_start_matches("sha256:")
        .to_owned())
}

fn require(ok: bool, error: &str) -> Result<(), String> {
    if ok { Ok(()) } else { Err(error.into()) }
}
fn save(path: &Path, value: &Value) -> Result<(), String> {
    fs::write(
        path,
        serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())
}
fn captured(outcome: &Outcome) -> bool {
    [
        (&outcome.stdout, outcome.stdout_bytes, &outcome.stdout_hash),
        (&outcome.stderr, outcome.stderr_bytes, &outcome.stderr_hash),
    ]
    .iter()
    .all(|(text, size, hash)| {
        text.len() <= 8_388_608
            && text.len() as u64 == *size
            && identity::digest_bytes(text.as_bytes()).trim_start_matches("sha256:")
                == hash.as_str()
    })
}
fn execute(
    tools: &Tools<'_>,
    argv: Vec<String>,
    root: &Path,
    dir: &Path,
    label: &str,
) -> Result<Outcome, String> {
    let paths = [tools.producer, tools.helper, tools.fixture, tools.sdk];
    let hashes = || {
        paths
            .iter()
            .map(|p| {
                fs::read(p)
                    .map(|b| identity::digest_bytes(&b))
                    .map_err(|e| e.to_string())
            })
            .collect::<Result<Vec<_>, _>>()
    };
    let before = hashes()?;
    let outcome = process::run_with_helper(&argv, root, 20_000, 8_388_608, tools.helper)
        .map_err(|e| e.to_string())?;
    let after = hashes()?;
    save(
        &dir.join(format!("{label}.json")),
        &json!({"argv":argv,"cwd":root,"timeout_ms":20000,"output_cap":8388608,"tools":paths,"before":before,"after":after,"outcome":outcome}),
    )?;
    require(before == after, "transport tools changed during execution")?;
    require(
        captured(&outcome),
        "transport capture incomplete or inconsistent",
    )?;
    Ok(outcome)
}
fn rejection(
    receiver: &Receiver,
    outcome: &Outcome,
    observed: &Observed,
    expected: Rejection,
) -> Result<(), String> {
    match receiver.receive(outcome, &observed.current()) {
        Err(actual) if actual == expected => Ok(()),
        Err(actual) => Err(format!("expected {expected:?}, received {actual:?}")),
        Ok(_) => Err(format!(
            "transport evidence accepted instead of {expected:?}"
        )),
    }
}

pub(super) fn run(tools: &Tools<'_>, dir: &Path, scenario: &str) -> Result<Value, String> {
    require(
        matches!(scenario, "T-cancelled" | "T-invalid-json" | "T-nonzero"),
        "unknown native transport scenario",
    )?;
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let frozen: Value = serde_json::from_str(FROZEN_CASES).map_err(|e| e.to_string())?;
    require(
        identity::digest_bytes(FROZEN_CASES.as_bytes())
            == "sha256:9e7646eeb7938ee4831cd2314af2140b73100b4a059e51f3c8de6c59e9682c7a",
        "ancillary refusal fixture changed",
    )?;
    let case = &frozen["cases"][1];
    let root = dir.join("workspace");
    fs::create_dir(&root).map_err(|e| e.to_string())?;
    fs::write(root.join("TransportCaseProbe"), b"case").map_err(|e| e.to_string())?;
    let sensitive = !root.join("transportcaseprobe").exists();
    fs::remove_file(root.join("TransportCaseProbe")).map_err(|e| e.to_string())?;
    let cwd = root
        .canonicalize()
        .map_err(|e| e.to_string())?
        .to_string_lossy()
        .replace('\\', "/");
    let files = case["files"]
        .as_object()
        .ok_or("ancillary files absent")?
        .iter()
        .map(|(p, t)| {
            let physical = root.join(p);
            fs::create_dir_all(physical.parent().unwrap()).map_err(|e| e.to_string())?;
            fs::write(physical, t.as_str().ok_or("ancillary source absent")?)
                .map_err(|e| e.to_string())?;
            Ok((format!("{cwd}/{p}"), t.clone()))
        })
        .collect::<Result<BTreeMap<_, _>, String>>()?;
    let roots = case["roots"]
        .as_array()
        .ok_or("ancillary roots absent")?
        .iter()
        .map(|p| format!("{cwd}/{}", p.as_str().unwrap()))
        .collect::<Vec<_>>();
    let request = json!({"id":case["id"],"cwd":cwd,"sdk_directory":"/sdk/lib","case_sensitive":sensitive,"roots":roots,"files":files,"options":{"target":"ES2022","module":"ESNext","moduleResolution":"Bundler","allowJs":true,"jsx":"Preserve","skipLibCheck":true,"noEmit":true,"strict":false},"retained":true,"qualified":true,"roles":{},"selection":{},"utf16_files":{},"raw_files":{}});
    let request_path = dir.join("request.json");
    save(&request_path, &request)?;
    let sdk: Value = serde_json::from_slice(&fs::read(tools.sdk).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    require(
        sdk["version"] == "5.9.3"
            && sdk["archive_sha256"]
                == "10e108c9cf7d5f2879053dff18515fb405abf2ccef63eaaf017d9c571687a1d3",
        "transport SDK identity differs",
    )?;
    let direct = vec![
        tools.producer.to_string_lossy().into_owned(),
        "--batch".into(),
        request_path.to_string_lossy().into_owned(),
        tools.sdk.to_string_lossy().into_owned(),
    ];
    let before = execute(tools, direct.clone(), &root, dir, "before-control")?;
    let batch: wire::Batch = serde_json::from_str(&before.stdout).map_err(|e| e.to_string())?;
    let observed = bindings_and_observation(
        &request,
        &sdk,
        &batch,
        fs::read(tools.producer).map_err(|e| e.to_string())?,
    );
    let receiver = ready_receiver(case, &observed, Duration::from_secs(120));
    let control = receiver
        .receive(&before, &observed.current())
        .map_err(|e| format!("before control: {e:?}"))?;
    require(
        control.disposition() == EvidenceDisposition::ControlledRefusal,
        "ancillary control is not a refusal",
    )?;
    require(
        matches!(
            receiver.revalidate(&control, &observed.current()),
            Err(Rejection::RefusalHasNoOwnership)
        ),
        "refusal acquired ownership",
    )?;
    let mut policy = expected(case, &observed, Instant::now() + Duration::from_secs(120));
    policy.terminal = ExpectedTerminal::ControlledRefusal {
        exit_code: 3,
        reason_codes: strings(&["SOURCE_DEFAULT_EXPRESSION_UNSUPPORTED"]),
    };
    let declared =
        Receiver::new(policy.clone()).map_err(|e| format!("declared refusal policy: {e:?}"))?;
    let mut branches = vec![];
    if scenario == "T-cancelled" {
        let argv = vec![
            tools.fixture.to_string_lossy().into_owned(),
            "cancel-outcome-supervisor".into(),
            tools.helper.to_string_lossy().into_owned(),
        ];
        let outer = execute(tools, argv, &root, dir, "cancel-supervisor")?;
        require(
            outer.kind == "success" && outer.exit_code == Some(0),
            "cancellation supervisor failed",
        )?;
        let report: Value = serde_json::from_str(&outer.stdout).map_err(|e| e.to_string())?;
        let actual: Outcome =
            serde_json::from_value(report["outcome"].clone()).map_err(|e| e.to_string())?;
        let ready: Value = serde_json::from_str(&actual.stdout).map_err(|e| e.to_string())?;
        require(
            report["trigger"]["ready"] == true
                && ready["descendant_pid"].as_u64().is_some_and(|pid| pid > 0)
                && ready["descendant_pid"] == report["trigger"]["descendant_pid"]
                && ready["descendant_pid"] != ready["parent_pid"],
            "owned descendant was not observed ready before cancellation",
        )?;
        require(
            actual.kind == "cancelled"
                && actual.stdout.len() <= 1024
                && actual.stderr.len() <= 1024
                && captured(&actual),
            "actual cancellation capture inconsistent",
        )?;
        rejection(&receiver, &actual, &observed, Rejection::ProcessFailure)?;
        branches.push(json!({"mode":"owned-descendant-cancellation","outcome":actual,"readiness":report["trigger"],"rejection":"ProcessFailure","controlled_product_refusal":false,"unexpected_process_failure":true,"qualification_success":false}));
    } else {
        let modes: &[&str] = if scenario == "T-invalid-json" {
            &["truncated-0"]
        } else {
            &["complete-3", "truncated-3", "empty-3", "unexpected-7"]
        };
        for mode in modes {
            let outcome = if *mode == "unexpected-7" {
                execute(
                    tools,
                    vec![
                        tools.fixture.to_string_lossy().into_owned(),
                        "nonzero".into(),
                    ],
                    &root,
                    dir,
                    mode,
                )?
            } else {
                execute(
                    tools,
                    vec![
                        tools.fixture.to_string_lossy().into_owned(),
                        "batch-proxy".into(),
                        tools.helper.to_string_lossy().into_owned(),
                        tools.producer.to_string_lossy().into_owned(),
                        request_path.to_string_lossy().into_owned(),
                        tools.sdk.to_string_lossy().into_owned(),
                        dir.join(format!("{mode}-inner.json"))
                            .to_string_lossy()
                            .into_owned(),
                        (*mode).into(),
                    ],
                    &root,
                    dir,
                    mode,
                )?
            };
            let code = if *mode == "truncated-0" {
                0
            } else if *mode == "unexpected-7" {
                7
            } else {
                3
            };
            require(
                outcome.exit_code == Some(code)
                    && outcome.kind == if code == 0 { "success" } else { "nonzero" },
                "proxy did not produce the declared actual exit",
            )?;
            if *mode != "unexpected-7" {
                let report: Value = serde_json::from_slice(
                    &fs::read(dir.join(format!("{mode}-inner.json"))).map_err(|e| e.to_string())?,
                )
                .map_err(|e| e.to_string())?;
                let paths = [tools.producer, tools.helper, &request_path, tools.sdk];
                let hashes = paths
                    .iter()
                    .map(|path| file_hash(path))
                    .collect::<Result<Vec<_>, _>>()?;
                require(
                    report["argv"] == json!([tools.producer, "--batch", request_path, tools.sdk])
                        && report["cwd"] == json!(root)
                        && report["paths"] == json!(paths)
                        && report["before"] == json!(hashes)
                        && report["after"] == json!(hashes),
                    "inner C1 invocation or tool/input identities differ",
                )?;
                let inner: Outcome =
                    serde_json::from_value(report["outcome"].clone()).map_err(|e| e.to_string())?;
                require(
                    inner.kind == "success" && inner.exit_code == Some(0) && captured(&inner),
                    "inner C1 capture failed",
                )?;
                let receipt = receiver
                    .receive(&inner, &observed.current())
                    .map_err(|e| format!("inner C1 refusal: {e:?}"))?;
                require(
                    receipt.disposition() == EvidenceDisposition::ControlledRefusal,
                    "inner C1 is not a controlled refusal",
                )?;
                let bytes = inner.stdout.trim_end();
                let forwarded = match *mode {
                    "complete-3" => inner.stdout.as_str(),
                    "empty-3" => "",
                    _ => bytes
                        .strip_suffix('}')
                        .ok_or("inner batch has no closing brace")?,
                };
                require(
                    outcome.stdout == forwarded,
                    "proxy output differs from the declared actual C1 byte prefix",
                )?;
            }
            if *mode == "complete-3" {
                let receipt = declared
                    .receive(&outcome, &observed.current())
                    .map_err(|e| format!("declared actual exit3 refusal: {e:?}"))?;
                require(
                    receipt.disposition() == EvidenceDisposition::ControlledRefusal,
                    "exit3 refusal not distinguished",
                )?;
                require(
                    matches!(
                        declared.revalidate(&receipt, &observed.current()),
                        Err(Rejection::RefusalHasNoOwnership)
                    ),
                    "exit3 refusal acquired ownership",
                )?;
                rejection(&receiver, &outcome, &observed, Rejection::ProcessFailure)?;
                let mut wrong = policy.clone();
                wrong.terminal = ExpectedTerminal::ControlledRefusal {
                    exit_code: 3,
                    reason_codes: strings(&["SOURCE_BODY_UNSUPPORTED"]),
                };
                rejection(
                    &Receiver::new(wrong).map_err(|e| format!("wrong reason policy: {e:?}"))?,
                    &outcome,
                    &observed,
                    Rejection::RefusalMismatch,
                )?;
                branches.push(json!({"mode":mode,"outcome":outcome,"controlled_product_refusal":true,"unexpected_process_failure":false,"expected_refusal_case_satisfied":true,"qualification_success":false,"ownership_granted":false,"wrong_reason_rejected":true,"undeclared_exit_rejected":true}));
            } else {
                let expected = if *mode == "unexpected-7" {
                    Rejection::ProcessFailure
                } else {
                    Rejection::MalformedOutput
                };
                rejection(
                    if code == 0 { &receiver } else { &declared },
                    &outcome,
                    &observed,
                    expected.clone(),
                )?;
                branches.push(json!({"mode":mode,"outcome":outcome,"rejection":format!("{expected:?}"),"controlled_product_refusal":false,"unexpected_process_failure":true,"qualification_success":false}));
            }
        }
    }
    let after = execute(tools, direct, &root, dir, "after-control")?;
    let receipt = ready_receiver(case, &observed, Duration::from_secs(20))
        .receive(&after, &observed.current())
        .map_err(|e| format!("after control: {e:?}"))?;
    require(
        receipt.disposition() == EvidenceDisposition::ControlledRefusal,
        "after control failed",
    )?;
    let result = json!({"scenario":scenario,"branches":branches,"qualification_success":false,"useful_product_success":false,"controlled_product_refusal":false,"failure_kind_distinct_from_success":true,"available_bounded_capture_retained":true,"error_identity_preserved":true,"lower_level_errors_invented":false,"before_control_healthy":true,"after_control_healthy":true,"global_admission_inferred":false,"ancillary_scope":"Frozen DEV default-expression refusal; no semantic credit transferred. The native fixture is a transport fault injector, C1 remains the fact producer; exit3 is the explicitly declared proxy convention, not a C1 exit code."});
    save(&dir.join("observation.json"), &result)?;
    Ok(result)
}
