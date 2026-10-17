# Rust product qualification

This internal Rust harness drives shipped CLI and MCP **processes**, outside the source
checkout, using disposable Git fixtures. It does not import the product's libraries or
invoke a global Semctx installation. The explicit Bun adapter is temporary while the
product moves to Rust; the harness and admission oracle already run natively.

```sh
cargo test --locked --manifest-path tools/qualification/Cargo.toml
cargo run --locked --manifest-path tools/qualification/Cargo.toml -- \
  --cli /absolute/plugins/semctx-control/dist/semctx.js \
  --mcp /absolute/plugins/semctx-control/dist/semctx-mcp.js \
  --runtime /absolute/bun --out /absolute/new-output \
  --plan /absolute/plan.json --os ubuntu-latest
cargo run --locked --manifest-path tools/qualification/Cargo.toml -- verify \
  --reports /absolute/downloaded-artifacts --plan /absolute/plan.json
```

`--out` must not exist. A complete JSON report is printed to stdout and saved as
`report.json`; raw observations are retained with SHA-256 digests under `raw/`.
`--plan` binds the report to the gate plan's 64-character `plan_id`. `--os` is the
CI lane label (`ubuntu-latest`, `windows-latest`, `macos-15`). The verifier requires
exactly one downloaded artifact directory per lane. Run it in the candidate checkout;
it compares the reported shipped entrypoints, shared chunks, workers and compiler
libraries with those checkout bytes (override entrypoints with `--cli`/`--mcp`).
It re-evaluates raw observations rather than trusting each case's green label, rejects
missing/duplicate cases and OS lanes, wrong plans, modified bytes and malformed JSON.

The frozen cases exercise setup/index, a benign comment, a required exported-interface
field addition, missing-index and invalid-config refusals, drift and documented repair,
explicit Python partial coverage, real stdio initialize/tools/status/inspect, and an
external CLI rebuild observed by the **same** connected MCP process. Drift invalidates
recorded semantic evidence first: the exact expected result is `UNSEALED` with
`EVIDENCE_BASELINE_STALE` and `semctx index --record`, rather than an assumed `STALE`.

The runtime must be explicit Bun **1.4.3**. The report identifies the complete portable
artifact tree and selected runtime before execution and detects byte drift afterward.
Each CLI/Git process and MCP request is bounded to 60 seconds; output is limited to 8 MiB.
Children receive an environment allowlist, never caller tokens or user configuration
roots. Fixtures are deleted by RAII after their observations have been persisted.

`qualified` applies only to this CLI/direct-MCP case inventory on the observed lane.
Host activation is always `not_observed`: this harness does not launch installed Codex,
Claude, paid models, live hooks or user workspaces. Background/hook qualification and
semantic precision require separate gates. A correct refusal is recorded separately
from useful success, and any unexpected result or missing obligation fails the report.

SHA-256 detects changed bytes; it is not an execution signature or an isolation boundary
against arbitrary candidate code. The workflow's accepted policy, checkout identity and
artifact-download provenance remain part of aggregate admission.
