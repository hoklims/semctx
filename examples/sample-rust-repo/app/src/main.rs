use booking_domain::{confirm as confirm_reservation, reservation::Confirmation};

fn main() -> std::process::ExitCode {
    let result = confirm_reservation(10, 4);
    match result {
        Confirmation::Accepted => std::process::ExitCode::SUCCESS,
        Confirmation::Full => std::process::ExitCode::FAILURE,
    }
}
