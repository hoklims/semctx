# Run and inspect the Rust gates

The internal gates are Rust tools; the published Semctx product and its CLI/MCP contracts are
unchanged. Rust 1.95.0, Cargo, Bun 1.4.3, Python and the pinned quality tools are development
prerequisites. Ripgrep is required by the portable source-fallback scenarios. The toolchain file pins Rust. Install JavaScript dependencies with
`bun install --frozen-lockfile` and quality tools from `requirements-quality.txt`.

## Local verification

```sh
cargo test --manifest-path tools/gates/Cargo.toml --locked
cargo test --manifest-path tools/qualification/Cargo.toml --locked
cargo fmt --manifest-path tools/gates/Cargo.toml --check
cargo fmt --manifest-path tools/qualification/Cargo.toml --check
cargo clippy --manifest-path tools/gates/Cargo.toml --locked --all-targets -- -D warnings
cargo clippy --manifest-path tools/qualification/Cargo.toml --locked --all-targets -- -D warnings
bun run verify:pr
```

The canonical command executes Rust, checks both native tools and discovers product test crates.
The old `scripts/verify-pr.ts` path forwards to it for
existing contributor integrations; its exported legacy functions remain differential fixtures.
Stage intended new files before verification. `--skip-diff` is for the existing release-source
verification contract and omits only diff hygiene. It does not remove quality or test checks.

Clippy denies `unwrap` and `expect` in production. The root `clippy.toml` uses
[Clippy's test option](https://doc.rust-lang.org/clippy/lint_configuration.html#allow-unwrap-in-tests)
to permit `unwrap` inside test functions and `cfg(test)` modules or crates. Standalone fixture
binaries use narrowly scoped `expect` lint attributes with explicit reasons; Clippy reports an
unfulfilled expectation when an exception becomes unnecessary.
Both tool manifests also deny `too_many_lines` and `excessive_nesting`: the root configuration
limits functions to 100 Clippy-counted lines and block nesting to five levels. These targeted
checks follow [Clippy’s documented alternatives to its complexity score](https://clippy.rust-lang.org/rust-1.95.0/index.html#cognitive_complexity).

## Plans and lane receipts

Build the engine with `cargo build --manifest-path tools/gates/Cargo.toml --locked --release`.
The executable is `tools/gates/target/release/semctx-gates`, with `.exe` on Windows. Use a clean
candidate checkout and an output directory outside the repository, or an already ignored one:

```text
semctx-gates ci-plan --root REPO --base BASE_SHA --head HEAD_SHA --output PLAN.json
semctx-gates ci-run --root REPO --plan PLAN.json --lane ZERO_BASED_INDEX --receipt RECEIPT.json
semctx-gates aggregate --root REPO --plan PLAN.json --receipts RECEIPTS_DIRECTORY
semctx-gates rust-test --root REPO
```

`ci-plan` also prints the JSON plan. The matrix carries the lane id, index, OS, profile, targets,
worker smoke and shard. `ci-run` only executes a lane on its declared native OS and emits failed
evidence when it cannot complete. Receipts contain their bounded stdout/stderr traces inline;
the receipt directory must contain exactly the planned JSON receipts, with no foreign files.
Aggregation rechecks source cleanliness, identities, action inventories, outputs and digests.

Live child progress and START messages are emitted only when stderr is a terminal.
With redirected stderr (including CI pipes), the supervisor captures child output exclusively;
lane receipts retain the bounded bytes, counts and hashes. An unread logging pipe therefore
cannot prevent the process deadline from being enforced. After supervision, `verify-pr`
always emits one bounded FAIL summary with the action label, outcome kind and exit code,
including when stderr is redirected; child output stays captured and the original failure
status is preserved. Interactive terminal writes and consumers which stop reading the final
stdout document or final stderr summary are outside the capture deadline guarantee.

After process-tree termination, pipe readers have a 500 ms EOF grace. POSIX read ends are
nonblocking, so a descendant which calls `setsid()` or changes process group cannot hold a
reader indefinitely: unfinished captures are cancelled, their readers close, and the result
is refused as incomplete. The final reader join has a further 500 ms bound. Qualification
CLI and MCP use the same finalization primitive and refuse incomplete capture. This is
process lifecycle control, not OS confinement: an escaped POSIX descendant may survive;
these tools do not claim to terminate arbitrary processes outside their owned group.

MCP validates JSON-RPC envelopes in wire order through shutdown, including output after the
last useful response and behind a notification backlog. Only the outstanding request's single
response is accepted; unsolicited or duplicate responses and invalid envelopes refuse
qualification. Valid notifications remain accepted during final draining.

`rust-test` discovers tracked Cargo manifests for the native product, resolves their workspace
owners with Cargo, and executes each product member once with its workspace's tracked lock. The two tools above
are tested separately. New product crates cannot disappear behind a fixed allowlist; an absent
port is reported as `no_product`, and a crate compiled without tests remains unqualified.

GitHub downloads the original plan and all receipts into `RUNNER_TEMP`. The stable required
result additionally depends on native Rust tests and actual artifact qualification on Ubuntu,
Windows and macOS. `skipped`, `cancelled` and failed producers do not satisfy it.

## Actual artifact qualification

Build the CLI with `bun run cli:build` and the native harness with
`cargo build --manifest-path tools/qualification/Cargo.toml --locked --release`.
Pass absolute paths and a fresh output directory outside the checkout:

```text
semctx-qualification --cli CLI_BUNDLE --mcp MCP_BUNDLE --runtime BUN_BINARY --out NEW_DIRECTORY --plan PLAN.json --os OS_CELL
semctx-qualification verify --reports REPORTS_DIRECTORY --plan PLAN.json --cli CLI_BUNDLE --mcp MCP_BUNDLE
```

`OS_CELL` is one of `ubuntu-latest`, `windows-latest` or `macos-15`. The first command exercises
the product in disposable repositories, stores raw observations and a report, and refuses a
missing or incorrect required scenario. The verifier needs one valid report per OS and checks
artifact and plan binding. Different runtime binary digests across OSes are legitimate; a
different candidate CLI/MCP bundle is not.

The target artifact may later become a native Rust product. Until its corresponding protocol
is exercised on that product, these observations establish only the explicitly identified Bun
CLI/MCP subject. Use `--runtime native` to launch native CLI/MCP artifacts directly; this adapter
requires no Bun or Rust compiler on the consumer machine. Native reports require
`verify --native-artifacts ABS_ROOT`, with one `ABS_ROOT/OS_CELL/artifact-manifest.json` per OS:
schema version 1, the exact `plan_id`, and confined relative `cli`/`mcp` paths. The schema field is
`schema_version`. These expected distributions must come from the independently identified
candidate build, not from the qualification report itself. Each OS is compared with its own
expected binaries. Missing distributions refuse admission. Neither the adapter's fixture tests
nor the existing Bun observations qualify the future Rust product, all languages or all hosts.
Installed/loaded/trusted/observed remain separate; host activation is not observed by this
harness. No paid model session is launched.

## Background inventory and external obligations

`python -B scripts/verify-index-routing.py --inventory` prints the discovered/classified tests.
The normal command executes every portable case for the current OS and writes a structured
report. The inventory is checked against discovery so a new test cannot silently disappear.
Selected failures, runtime skips, expected failures and malformed discovery fail verification.
The original four host-binding/recovery regressions are mandatory.

The bundled suite also contains checks of files belonging to the maintainer's private Codex or
Claude installation, plus optional installed Graphify probes. Those are reported individually
as external, unqualified obligations. Native Windows-only tests are identified separately when
running on another OS. None is counted as a portable pass. This is not proof that an installed
host's hooks are trusted or that its worker is active.

## Boundaries and performance

There is no positive test-result cache and no signature on these receipts. Content hashes are
integrity checks. The current repository workflow remains part of the trust boundary; it is not
an immutable independently hosted verifier. See [ADR 0037](../adr/0037-rust-gates-and-qualified-evidence.md).

Quality runs once in the contract lane. Runtime integration checks and worker equivalence run
once per applicable OS, while all selected test shards remain required. Consumer closure can
select more tests than the old changed-folder planner. Compare the actual obligations before
interpreting runtime: compilation, fixtures, platform coverage and execution costs are distinct.
No numerical speedup is claimed merely because the engine is written in Rust.
