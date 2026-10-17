use std::process::Command;

#[test]
fn accepted_reservation_exits_successfully() {
    let output = Command::new(env!("CARGO_BIN_EXE_booking-app"))
        .output()
        .expect("run the booking app");
    assert!(output.status.success());
    assert!(output.stdout.is_empty());
    assert!(output.stderr.is_empty());
}
