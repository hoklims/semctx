# Sample Rust booking workspace

This committed fixture has a Cargo workspace with `booking-domain` (Rust 2021) and `booking-app` (Rust 2024). `domain/src/reservation.rs` carries explicit capability, invariant and contract markers. `domain/src/capacity.rs` includes an inline `#[cfg(test)]` test; `domain/tests/confirmation.rs` tests the public confirmation behavior. `docs/capacity.md` and the fixture ADR state the intended rule independently of the code.

From this directory, run `cargo test --offline` with Rust 1.98.1. For Semctx v2, select `**/*.rs` and `docs/**/*.md`, exclude `**/target/**`, and set `languages.rust` and `languages.markdown` to `on`. Navigation additionally requires the explicitly trusted, pinned rust-analyzer/toolchain configuration described in accepted repository ADR 0038.

Reproducible single-line changes, each from a clean copy of this fixture:

| Scenario | File and replacement | Expected domain observation |
| --- | --- | --- |
| Benign | Append one blank line to `domain/src/reservation.rs`. | No change to the Rust test result; source binding changes and must be refreshed before current-index verification. |
| Contract break | In `domain/src/reservation.rs`, change `Confirmation::Full` to `Confirmation::Accepted` in the `else` branch. | `full_venue_refuses_confirmation` fails. |
| Invariant violation | In `domain/src/reservation.rs`, change `remaining_capacity(total, confirmed) > 0` to `>= 0`. | `full_venue_refuses_confirmation` fails because an exhausted venue is accepted. |
| Advisory API change | In `domain/src/capacity.rs`, change `pub total: u32` to `pub(crate) total: u32`. | External access to the public field is removed; the configured advisory contract rule reports WARN. |

The bounded Rust profile has no negative completeness. A green index or a recommended test is not evidence that these tests ran or passed. Verification tests establish the stated Semctx verdicts independently of this fixture description.
