# Rust indexing candidate for #347

This page describes the candidate on the #347 branch. Public support is contingent on the remaining acceptance evidence and CI. The accepted [bounded Rust profile](../adr/0038-bounded-rust-plane-a-profile.md) authorizes explicit selection, structural source facts and conditional navigation for an already trusted repository and toolchain. It does not grant negative completeness or Rust qualification under the current TS/ESM profile.

## Configure and run

Rust requires a version 2 `globs-v1` project configuration. Include `.rs` files, exclude generated targets, and set `languages.rust` to `on`. The default Rust path uses pinned tree-sitter Rust WASM. For example, in [the booking fixture](../../examples/sample-rust-repo/README.md):

```json
{
  "version": 2,
  "selectionMode": "globs-v1",
  "include": ["**/*.rs", "docs/**/*.md"],
  "exclude": ["**/target/**"],
  "docsDirs": ["docs"],
  "migrationsDirs": ["migrations"],
  "testGlobs": ["**/tests/**/*.rs"],
  "languages": { "rust": "on", "markdown": "on" },
  "semanticProvider": "none",
  "blockingRules": []
}
```

The `testGlobs` field is persisted but Rust role classification uses Cargo target and source context, not this field. Version 1 does not select Rust. Setting `languages.rust` to `off` disables its selected files; omitting the key leaves them unsupported. Other language keys may be set in the same version 2 config.

For resolved imports, calls and test links, add the optional `rust` object to that configuration:

```json
{
  "mode": "navigation",
  "trusted": true,
  "rustAnalyzerPath": "/absolute/path/to/rust-analyzer",
  "rustAnalyzerSha256": "0000000000000000000000000000000000000000000000000000000000000000",
  "toolchainRoot": "/absolute/path/to/rust-1.98.1-toolchain",
  "target": "aarch64-apple-darwin",
  "features": [],
  "budgetMs": 30000
}
```

Replace the example paths, target and zero digest with the values of the trusted local toolchain and binary. These are local values, not a sandbox. The binary digest, `rustc`, Cargo, rust-src and target library bytes are bound to the index. Navigation copies selected source and Cargo inputs into a temporary offline workspace; it refuses external dependencies, repository escapes, Cargo configuration and glob imports. A file shared by source and test Cargo targets is refused because one graph node cannot represent both worlds. Build scripts and proc macros are disabled in the LSP configuration. Unknown or ambiguous navigation stays unresolved. Rust 2018, 2021 and 2024 are the bounded dialects. The selected target/features world is partial, and `cfg`, macro expansion, generated origins and indirect dispatch do not establish negative facts.

From the fixture root, use the existing CLI `index`, `index-health --json`, `inspect symbol confirm --json`, `verify diff --format json` and `impact diff --format json` commands. MCP uses the existing index, health, inspect, verify and semantic/control tools; the Rust graph does not add a new primary search interface. `index-health` reports outcomes, partial coverage, binding and freshness separately. After editing source or Cargo inputs, reindex before interpreting current-index verification. A recommended Rust test is a suggestion, not an executed test result. `qualified-static-v1` continues to refuse changed Rust with `OUTSIDE_BOUNDED_ESM_TYPESCRIPT_PROFILE`.

## Acceptance matrix

The named tests below are branch-local witnesses on macOS arm64 with Bun 1.4.3. “Partial” means a positive path exists but the whole #347 cell is not established. “Open” means the named public boundary still needs a Rust witness. Source discovery and the #346 [engine matrix](../research/rust-indexing-discovery.md) are evidence for choosing the profile, not proof of this implementation.

| Cell | Current branch evidence | Remaining acceptance boundary |
| --- | --- | --- |
| M01 selection/readiness | Partial: v1 preservation, v2 on/off/missing, exclusions and roles in `discovery-selection.test.ts`; parse failure in `rust-indexing.test.ts`. | Complete public readiness matrix. |
| M02 crates/workspaces | Partial: multicrate fixture, Cargo membership, explicit target, orphan and absolute-path refusal in `rust-indexing.test.ts`; workspace projection tests. | Broader mixed-workspace manifest and path-escape matrix. |
| M03 symbols/graph | Partial: retained declarations, impl inspection, stable grouping of valid same-target impls and same-name collision refusal in `rust-indexing.test.ts`. | Full visibility and scope matrix. |
| M04 imports/references | Partial: real cross-crate alias/reexport LSP joins and external `mod` file edges in `navigation.integration.test.ts` and `rust-indexing.test.ts`; glob is refused. | Broader unknown/ambiguous import and cross-crate matrix. |
| M05 calls/traversal | Partial: direct/transitive paths, function-value and trait-dispatch refusal, and conditional-call refusal in `rust-indexing.test.ts` and `navigation.integration.test.ts`. | Generic and macro uncertainty matrix. |
| M06 tests | Partial: inline, `#[test]`, conventional and explicit Cargo integration target roles, refusal of dual-role targets and cross-world false coverage, plus resolved recommendation in `rust-indexing.test.ts`. | Full target-world and justified coverage/refusal matrix. |
| M07 intentions/claims | Partial: Rust markers join docs and expose authored contradiction and cross-language statement divergence in `rust-indexing.test.ts`; `pub` alone creates no contract. | SQL/migration join and broader claim-authority matrix. |
| M08 evidence | Partial: source excerpts, marker ranges, CRLF identity and a non-BMP LSP call in `rust-indexing.test.ts`, `rust-extractor.test.ts` and `navigation.integration.test.ts`. | Full cross-engine byte/range and macro/generated-origin matrix. |
| M09 capabilities/authority | Partial: producer sidecar and task/negative gate observations in `rust-indexing.test.ts`; real Rust facts independently fail six evaluator gates and a producer-declared unknown tuple fails gate 4 in `rust-plane-a-gates.test.ts`. | Public seal/freshness/policy derivation and unknown-tuple refusal through persisted index-health, CLI and MCP. |
| M10 SQLite/Git lifecycle | Partial: cold/stable/edit/add/delete/rename/checkout/worktree, toolchain drift and capture mutation in `rust-indexing.test.ts`. | Full sync/async and atomic failure-path matrix. |
| M11 index-health | Partial: persisted analyzed/disabled/unsupported/failed outcomes, insufficient coverage, partial reasons and freshness in `rust-indexing.test.ts`. | Workspace/profile separation and additional external-failure paths. |
| M12 inspect | Partial: persisted CLI/MCP symbol parity in `rust-inspect.test.ts`; impl kind witness. | Relation/claim/evidence and file/path search breadth. |
| M13 verify diff | Partial: fixture benign, break, violation, advisory and strict findings in `rust-indexing.test.ts`; packaged verify witness. | Every inadmissible refusal and exit-code matrix. |
| M14 impact diff | Partial: changed/added Rust units, public method importer possibility, direct/transitive `via`/distance and partial unresolved reach in `rust-indexing.test.ts`. | Full old/new, surfaces and broken-binding schema matrix. |
| M15 authored links | Partial: persisted Rust anchors through semantic check and change verify, including rename/deletion/ambiguity in `rust-indexing.test.ts`. | Public inspect and complete invariant exposure. |
| M16 control/proofs | Partial: real Rust coordinate projection and stale refusal in `rust-inspect.test.ts`. | Trace, refinement, obligations and proof mutation witnesses. |
| M17 semantic slice | Partial: MCP Rust-linked authored slice preserves its anchor, provenance and open unknown after source deletion in `rust-inspect.test.ts`. | Capsule/render and broader authored relation matrix. |
| M18 capsules/continuation | Partial: MCP handoff/resume retains a Rust authored anchor and open unknown; Control Handoff v2 and continuation retain no execution authority and report diff drift in `rust-inspect.test.ts` and `rust-reconciliation.test.ts`. | Authorization capsule, tamper, expiry and offline refusal witnesses. |
| M19 reconciliation | Partial: planned Rust edit binds to reanalyzed post-image; a second file creates scope escape in `rust-reconciliation.test.ts`. | Drift, unknowns and cross-file closure matrix. |
| M20 provider/ContextPack | Partial: Rust capability selects source evidence while an unsealed provider candidate stays diagnostic in `rust-indexing.test.ts`. | Provider failure/absence, sealed candidate and provenance matrix. |
| M21 qualification | Local witness: mixed TS/Rust working-tree, staged and range refusals, including profile precedence, in `qualified-checkout-boundaries.test.ts` and `analysis-admission.test.ts`. | Exact-head multi-OS CI for these witnesses and no Rust qualification expansion. |
| M22 interfaces/distribution | Partial: packaged CLI/plugin Rust smoke in `rust-packaging.test.ts` and inspect parity in `rust-inspect.test.ts`. | Full CLI/MCP/control parity, size limits and native Ubuntu/Windows/macOS packaging. |

The pinned [pico-args corpus](../../packages/rust-analyzer/test/corpus/pico-args-0.5.0/PROVENANCE.md) checks real source extraction with upstream commit, license and byte hashes. It is a small Rust 2018 snapshot, not a representative performance corpus. B06 has no accepted budget or larger multicrate measurement. Local macOS arm64 checks do not establish native Linux or Windows delivery.
