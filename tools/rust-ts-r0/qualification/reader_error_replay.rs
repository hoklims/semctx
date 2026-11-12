use super::*;
use std::{
    io::Read,
    sync::{Arc, atomic::AtomicBool},
    thread,
};

fn capture(first: fs::File, tail: fs::File, cap: usize) -> Result<Value, String> {
    let stop = Arc::new(AtomicBool::new(false));
    let first = process::pipe_reader(first, &stop).map_err(|e| e.to_string())?;
    let tail = process::pipe_reader(tail, &stop).map_err(|e| e.to_string())?;
    let reader = thread::spawn(move || {
        let mut reader = first.chain(tail);
        let mut bytes = vec![];
        let mut chunk = [0; 128];
        let error = loop {
            match reader.read(&mut chunk) {
                Ok(0) => break None,
                Ok(count) => {
                    if bytes.len() + count > cap {
                        return Err("reader witness exceeded its capture budget".to_string());
                    }
                    bytes.extend_from_slice(&chunk[..count]);
                }
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(error) => {
                    break Some(
                        json!({"kind":format!("{:?}",error.kind()),"raw_os_error":error.raw_os_error(),"message":error.to_string()}),
                    );
                }
            }
        };
        Ok(
            json!({"bytes":bytes,"byte_count":bytes.len(),"sha256":sha(&bytes),"error":error,"capture_budget":cap}),
        )
    });
    process::finish_reader(reader, &stop).map_err(|e| e.to_string())?
}

fn failure_projection(captured: &Value, expected: &[u8], cap: usize) -> Result<Value, String> {
    let bytes: Vec<u8> =
        serde_json::from_value(captured["bytes"].clone()).map_err(|e| e.to_string())?;
    if bytes != expected
        || bytes.len() > cap
        || captured["byte_count"] != bytes.len()
        || captured["capture_budget"] != cap
        || captured["sha256"] != sha(&bytes)
    {
        return Err("reader failure lost or substituted available bounded capture".into());
    }
    let cause = &captured["error"];
    if cause["raw_os_error"].as_i64().is_none()
        || cause["kind"].as_str().is_none_or(str::is_empty)
        || cause["message"].as_str().is_none_or(str::is_empty)
    {
        return Err("reader did not expose a real kernel IO failure".into());
    }
    Ok(
        json!({"qualification_success":false,"useful_product_success":false,"controlled_product_refusal":false,"failure_kind":"reader_io_error","failure_kind_distinct_from_success":true,"available_bounded_capture_retained":true,"error_identity_preserved":true,"cause":cause,"reader_capture_id":identity::digest(captured)}),
    )
}

pub(super) fn run(recipe: &Value, dir: &Path) -> Result<Value, String> {
    if recipe["surface"] != "reader_error_component"
        || recipe["fault_injection_mechanism"] != "kernel_read_of_write_only_file"
        || recipe["capture_budget"] != 64
        || recipe["gaps"].as_array().is_none_or(|v| !v.is_empty())
    {
        return Err("incomplete or foreign reader-error recipe".into());
    }
    let checks = recipe["checks"]
        .as_array()
        .filter(|c| !c.is_empty())
        .ok_or("missing reader failure checks")?;
    validate_component_checks(checks)?;
    fs::create_dir(dir).map_err(|e| e.to_string())?;
    let prefix = b"available capture before kernel reader failure\n";
    let first = dir.join("prefix.bin");
    let tail = dir.join("tail.bin");
    fs::write(&first, prefix).map_err(|e| e.to_string())?;
    fs::write(&tail, []).map_err(|e| e.to_string())?;
    let mut observations = vec![];
    for (index, fault) in [false, true, false].into_iter().enumerate() {
        let first = fs::File::open(&first).map_err(|e| e.to_string())?;
        let tail = if fault {
            fs::OpenOptions::new().write(true).open(&tail)
        } else {
            fs::File::open(&tail)
        }
        .map_err(|e| e.to_string())?;
        let observed = capture(first, tail, 64)?;
        save(&dir.join(format!("reader-{index}.json")), &observed)?;
        observations.push(observed);
    }
    for control in [&observations[0], &observations[2]] {
        if !control["error"].is_null()
            || control["bytes"] != json!(prefix.as_slice())
            || failure_projection(control, prefix, 64).is_ok()
        {
            return Err("healthy reader control failed or was classified as failure".into());
        }
    }
    let observed = failure_projection(&observations[1], prefix, 64)?;
    save(&dir.join("consumed-reader-failure.json"), &observed)?;
    let evaluated = checks
        .iter()
        .map(|c| evaluate(&observed, c))
        .collect::<Vec<_>>();
    let pass = evaluated
        .iter()
        .all(|c| c["state"] == "PASS_PROJECTED_PROPERTY");
    let executable = std::env::current_exe().map_err(|e| e.to_string())?;
    Ok(
        json!({"state":if pass{"PASS_REAL_READER_FAILURE"}else{"MISMATCH_REAL_READER_FAILURE"},"pass":pass,"checks":evaluated,"observation":observed,"native_observer_sha256":sha(&fs::read(executable).map_err(|e|e.to_string())?),"proof_scope":"Actual reused pipe_reader and finish_reader on owned files with a kernel read refusal after a captured prefix, between two EOF controls. No outer process::run capture_error, child lifecycle, C1 semantic result or product refusal inferred."}),
    )
}

#[test]
fn comparator_reader_error_rejects_eof_missing_cause_and_substituted_capture() {
    let root = std::env::temp_dir().join(format!(
        "r0-reader-error-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir(&root).unwrap();
    let prefix = root.join("prefix");
    let empty = root.join("empty");
    fs::write(&prefix, b"native reader prefix").unwrap();
    fs::write(&empty, []).unwrap();
    let failed = capture(
        fs::File::open(&prefix).unwrap(),
        fs::OpenOptions::new().write(true).open(&empty).unwrap(),
        64,
    )
    .unwrap();
    let observed = failure_projection(&failed, b"native reader prefix", 64).unwrap();
    assert_eq!(observed["cause"], failed["error"]);
    let healthy = capture(
        fs::File::open(&prefix).unwrap(),
        fs::File::open(&empty).unwrap(),
        64,
    )
    .unwrap();
    assert!(failure_projection(&healthy, b"native reader prefix", 64).is_err());
    for field in ["bytes", "byte_count", "sha256", "error", "capture_budget"] {
        let mut changed = failed.clone();
        changed.as_object_mut().unwrap().remove(field);
        assert!(
            failure_projection(&changed, b"native reader prefix", 64).is_err(),
            "{field}"
        );
    }
    for field in ["kind", "raw_os_error", "message"] {
        let mut changed = failed.clone();
        changed["error"].as_object_mut().unwrap().remove(field);
        assert!(
            failure_projection(&changed, b"native reader prefix", 64).is_err(),
            "{field}"
        );
    }
    assert!(failure_projection(&failed, b"different capture", 64).is_err());
    assert!(failure_projection(&failed, b"native reader prefix", 1).is_err());
    assert!(
        capture(
            fs::File::open(&prefix).unwrap(),
            fs::File::open(&empty).unwrap(),
            1
        )
        .is_err()
    );
    fs::remove_dir_all(root).unwrap();
}
