#[path = "support/receiver_context.rs"]
mod receiver_context;
#[path = "support/transport_process.rs"]
mod transport_process;
use std::{
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};

#[test]
fn real_native_transport_distinguishes_declared_refusal_truncation_and_owned_cancellation() {
    let helper = PathBuf::from(
        std::env::var_os("SEMCTX_PROCESS_HELPER").expect("compiled process helper required"),
    );
    let fixture = std::env::var_os("SEMCTX_TRANSPORT_FIXTURE")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            helper.with_file_name(if cfg!(windows) {
                "semctx-gates-fixture.exe"
            } else {
                "semctx-gates-fixture"
            })
        });
    let sdk = std::env::var_os("SEMCTX_NATIVE_SDK")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("sdk/sdk-input.json"));
    let evidence = std::env::var_os("SEMCTX_NATIVE_EVIDENCE")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("development-evidence/native-transport")
        });
    let run = evidence.join(format!(
        "transport-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let tools = transport_process::Tools {
        producer: std::path::Path::new(env!("CARGO_BIN_EXE_semctx-r0-probe")),
        helper: &helper,
        fixture: &fixture,
        sdk: &sdk,
    };
    for scenario in ["T-nonzero", "T-invalid-json", "T-cancelled"] {
        let observed = transport_process::run(&tools, &run.join(scenario), scenario).unwrap();
        assert_eq!(observed["qualification_success"], false);
        assert_eq!(observed["before_control_healthy"], true);
        assert_eq!(observed["after_control_healthy"], true);
    }
    eprintln!("native transport DEV evidence: {}", run.display());
}
