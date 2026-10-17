# Rust codebase indexing discovery

- Status: **discovery evidence; recommendation proposed, not an accepted ADR**.
- Date: 2026-10-15. Repository baseline: `60938305a3e810c1801a6e03047b8366e55dd060`.
- Scope: [#346](https://github.com/hoklims/semctx/issues/346), under
  [#345](https://github.com/hoklims/semctx/issues/345). This document informs
  [#347](https://github.com/hoklims/semctx/issues/347); it does not implement it.
  Rewriting Semctx in Rust ([#365](https://github.com/hoklims/semctx/issues/365)) is excluded.
- Evidence: [replay protocol](rust-indexing/replay.md),
  [raw observations](rust-indexing/results/), [claim audit](rust-indexing/claim-audit.md).

## Recommendation and decision boundary

Recommend **tree-sitter-rust through WASM for source structure, combined with an explicitly
opted-in rust-analyzer LSP process for resolved navigation**. Neither component supplies Semctx
consumer admission. Keep the components' fact kinds and provenance distinct; do not silently
replace failed semantic analysis with syntax facts that appear equally admissible.

Tree-sitter runs without compiling the indexed repository and retains malformed-source diagnostics.
The LSP trial resolves a cross-crate alias and returns concrete outgoing navigation targets,
including methods. Batch SCIP is attractive for occurrences and persisted interchange, but the
tested exporter leaves symbol relationships empty, reports ambiguous duplicate symbols on our
multitarget fixture, and executes build scripts even with the LSP disable options in its config.
It cannot alone satisfy M05 or the default no-execution boundary. `syn` produces useful typed ASTs
and source spans convertible to byte offsets for the probed non-proc-macro inputs, but brings a
per-platform helper without adding name/type resolution.

The edge trials also show a decisive qualification gap in **both RA transports**: an ambiguous
glob import rejected by Cargo as E0659 still yields a single navigation target, with no LSP
diagnostic in this probe. A unique returned location therefore does not establish an unambiguous
binding. The proposed semantic component remains diagnostic until a reviewed profile can detect
and refuse that case; the syntax/navigation combination alone does not close B04.

This is a conditional choice, not approval to start #347. Review the engine combination and the
decisions B01–B07 below first. If an isolated/trusted Cargo execution boundary cannot be accepted,
**no compared option currently demonstrates the requested minimum parity**. A syntax-only Rust
vertical would require an explicit scope decision; it must not quietly replace #347's criteria.

An accepted ADR should follow that review, using the next free `docs/adr/` number and the existing
`Status`, `Date`, `Context`, `Decision`, `Consequences`, `Revisit` format. No ADR number is reserved
by this discovery, and no existing accepted ADR is amended.

## Current architecture and authority

The architectural authorities are accepted [ADR 0010](../adr/0010-multilanguage-plane-a-capability-and-authority.md),
[ADR 0009](../adr/0009-semantic-layer-is-separate-from-the-repository-graph.md),
[ADR 0030](../adr/0030-change-impact-contract.md) and
[ADR 0035](../adr/0035-qualified-static-analysis-admission.md). Their historical context is not
an inventory of today's implementation. [ADR 0011](../adr/0011-lezer-python-for-first-plane-a-vertical.md)
is accepted for the provisional Python vertical; its JavaScript-only packaging decision is not a
Rust decision. The plugins' historical SCIP reassessment does not qualify current Rust exports.

Source checks confirm the closed producer dispatch in
`packages/app-services/src/plane-a-runtime.ts`, the independent consumer registry in
`plane-a-capability-requirements.ts`, and the TS/JS-specific eligibility/outline path in
`change-impact.ts`. The current `.rs` coverage label is `rust`/`LANGUAGE_UNSUPPORTED`, not an
analyzer. The generic graph vocabulary and exact repository-link resolver are reusable mechanisms,
not an implemented Rust mapping or proof of downstream parity.

```text
selected Rust sources + Cargo inputs
  -> structural facts             -> private Plane-A composition
  -> opt-in resolved navigation   -> same composition, separate profiles
  -> exact source/range evidence  -> binding + freshness + consumer admission
                                  -> inspect / verify / impact / semantic / control
authored goals and invariants ------------------------------------------^
```

The source graph does not infer authored intent. Inspection is indexed inspection, not primary
content search; the optional ContextPack provider remains non-authoritative under ADR 0005.
Control reports and authorization capsules keep `executionAuthority: none`.

## Compared releases, dependencies and execution

Pins below identify experiments, not newly shipped product dependencies. Direct dependencies in
the `syn` helper are exact and its transitive resolution is locked. No GitHub Action is added or
changed. Licenses of vendored input and probe dependencies are separate from Semctx's license.

| Engine/transport | Exact pin and primary source | Distribution and dependency surface | Observed/absent semantics |
| --- | --- | --- | --- |
| Tree-sitter, T | [`tree-sitter-rust` 0.24.2](https://github.com/tree-sitter/tree-sitter-rust/tree/v0.24.2), commit `77a3747266f4d621d0757825e6b11edcbf991ca5`, MIT; [`web-tree-sitter` 0.27.1](https://www.npmjs.com/package/web-tree-sitter/v/0.27.1), MIT | Bun loads the official grammar WASM (1,118,099 bytes) and parser runtime WASM; no Cargo/sysroot for indexing. A native Node addon is an alternative, not tested here. | CST, attributes, visibility syntax, call expressions and macro token trees; no symbol/type resolution, cfg evaluation or macro expansion. Grammar acceptance does not select or validate a Cargo edition. |
| RA batch SCIP, S | [`rust-analyzer` 2026-10-12](https://github.com/rust-lang/rust-analyzer/tree/2026-10-12), `0.3.3081-standalone`, commit `2ad81e72b7e978cb800dffe1bcce5c9f98032acf`, MIT OR Apache-2.0 | Native executable + Cargo/rustc + matching sysroot sources + dependency cache. macOS arm64 archive 13,943,252 bytes. Exporter locks SCIP crate 0.7.1; diagnostic printer used here is [`scip` 0.10.0](https://github.com/scip-code/scip/releases/tag/v0.10.0), Apache-2.0. | Documents, occurrences, definition roles, UTF-8 positions, symbol documentation and enclosing ranges. `relationships` is empty in this exporter. Occurrences are not classified call edges. Subcommands explicitly have no stability guarantee. |
| RA LSP, L | Same exact binary as S; [LSP 3.17](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/) and pinned [RA extensions](https://github.com/rust-lang/rust-analyzer/blob/2026-10-12/docs/book/src/contributing/lsp-extensions.md) | Same native/toolchain inputs; persistent child, framed JSON-RPC, initialization/configuration and readiness tracking. Prototype has a whole-probe deadline and forced child termination. Probe uses Python stdlib, not a product Python dependency. | Observed document symbols, definitions and outgoing hierarchy are navigation facts. Upstream additionally exposes references/incoming hierarchy; incoming starts from usages, outgoing resolves callable expressions. Those additional queries remain P04/P05 witnesses. Neither proves runtime reachability or exhaustiveness. |
| Syn, Y | [`syn` 3.0.9](https://docs.rs/syn/3.0.9/syn/), [`proc-macro2` 1.0.107](https://docs.rs/proc-macro2/1.0.107/proc_macro2/struct.Span.html), MIT OR Apache-2.0; lock includes `quote` 1.0.47 and `unicode-ident` 1.0.27 | Rust build toolchain to produce the standalone helper, then a native helper per OS/architecture; measured release binary 2,215,024 bytes. `full`, `visit`, `span-locations` enabled. | Typed AST, attrs and spans; syntax only, no cross-file resolution, cfg evaluation or expansion. Syn v3 documents most stable Rust plus some unstable syntax, not all possible valid Rust. Stable span precision applies outside a proc macro, as in this helper. |

The [SCIP exporter source](https://github.com/rust-lang/rust-analyzer/blob/2026-10-12/crates/rust-analyzer/src/cli/scip.rs)
sets `load_out_dirs_from_check: true` and `ProcMacroServerChoice::Sysroot`.
[`Config::cargo`](https://github.com/rust-lang/rust-analyzer/blob/2026-10-12/crates/rust-analyzer/src/config.rs)
does not carry the LSP `cargo.buildScripts.enable`/`procMacro.enable` controls into that loader.
The execution sentinel in the replay protocol independently reproduced this distinction.

For LSP the probe disables build scripts, proc macros and check-on-save and requests offline Cargo.
These settings are **not a sandbox**: rust-analyzer's
[security policy](https://github.com/rust-lang/rust-analyzer/blob/2026-10-12/docs/book/src/security.md)
assumes trusted code, and Cargo configuration/toolchain files can select executables. Offline Cargo
also cannot constrain networking by arbitrary executed code. The prototype therefore runs only our
reviewed public/synthetic inputs. An execution boundary is a decision, not a capability label.

[`scip-rust` 0.0.6](https://github.com/scip-code/scip-rust/tree/v0.0.6), Apache-2.0, is a shell
wrapper invoking `rust-analyzer scip`, not a fifth engine. Its Nix/container packaging does not
establish native Windows support. Direct RA invocation removes this extra shell dependency.

Other options were screened, not benchmarked: pinned RA's
[`ra_ap_syntax`](https://github.com/rust-lang/rust-analyzer/blob/2026-10-12/crates/syntax/src/lib.rs)
adds edition-aware CST/reparsing but no independent resolver; include it if WASM integration fails.
Keep [`rustc` stable](https://doc.rust-lang.org/rustc/command-line-arguments.html#--emit-specifies-the-types-of-output-files-to-generate)
as the compilation oracle. [`rustc_driver`/`rustc_private`](https://rustc-dev-guide.rust-lang.org/rustc-driver/intro.html)
would tie a helper to compiler internals, and [rustdoc JSON](https://doc.rust-lang.org/rustdoc/unstable-features.html#-w--output-format-output-format)
remains experimental/documentation-oriented. No demonstrated benefit here justifies that extra
integration surface.

## Corpus and observations

The deterministic [fixture](rust-indexing/fixture/) has two Cargo crates, editions 2021 and 2024,
five ordinary `.rs` files, 2,465 source bytes, inline and integration tests, `#[path]`, alias/reexport,
traits/impls, generic and dynamic dispatch, `macro_rules!`, feature-gated source and an explicit
`#[doc = "@invariant …"]` marker. Its negative directory is outside Cargo targets. The marker is
experimental input, not a new Rust marker convention or authored Semctx invariant.

The real snapshot is [`pico-args` 0.5.0](https://github.com/RazrFalcon/pico-args/tree/56e8872fa31f168fd87e84fdc5f24bd60875daea),
commit `56e8872fa31f168fd87e84fdc5f24bd60875daea`, MIT, edition 2018. The
[vendored subset](rust-indexing/corpus/pico-args-0.5.0/) contains unchanged manifest bytes (`Cargo.toml.snapshot`), `src/lib.rs`
and `README.md`, plus `LICENSE` with its final empty line removed for diff hygiene; hashes and the
archive pin are in the replay protocol. Its single source
is 808 lines / 26,273 bytes, with no Cargo dependencies or build script. It is deliberately small:
it exercises a real API and platform-specific source, not proc-macro or large-workspace scalability.
The generated dependency-free `Cargo.lock` is local experiment metadata, not an upstream source.

| Witness | Independently expected behavior | Observation and limit |
| --- | --- | --- |
| W01 structure | `Amount`, `Outcome`, `Quote`, `FixedQuote`, methods, `main`, nested test and `extra_quote` exist textually. | T and Y retain syntax including inactive `extra_quote`. Y totals 22 AST items / 3 methods over normal sources; AST item count is not semantic symbol count. |
| W02 resolution | `dispatch_quote` denotes `calculations::quote`; concrete `provider.quote` denotes its impl. | L definition returns `operations.rs` line 20 (one-based); outgoing `main` has five targets (`new`, concrete `quote`, `Amount`, generic `quote`, `quote_dyn`). S has 174 occurrences across five documents, but no relationships. T/Y cannot establish these bindings. |
| W03 limits | Calling `quote_dyn` is a definite call to the wrapper; its inner dispatch is not proof of the runtime implementation. | L navigation provides targets, not a closed runtime call graph. No engine is credited with negative completeness or exhaustive dispatch. |
| W04 configuration | `extra_quote` is inactive in default Cargo config; syntax parsers still see its declaration. | S default output omits `extra_quote`; feature-enabled/native checks are reproducible. Edition 2018/2021/2024 compile on pinned toolchain; 2015 and other target semantics are not qualified. |
| W05 errors | Malformed syntax is not completed semantic analysis; an unresolved identifier is not a call edge. | T records `hasError: true` for `malformed.rs` and accepts syntax of `unresolved.rs`; Y exits nonzero for malformed syntax but accepts unresolved syntax; rustc rejects unresolved names. Invalid Cargo manifest makes S exit nonzero without an index. |
| W06 spans | Unicode and CRLF must preserve exact source byte ranges rather than guessing byte = column. | Helper tests exercise UTF-8 byte extraction for LF/CRLF and invalid boundaries. L requests UTF-16 positions; S exporter declares UTF-8 code-unit positions. WASM string indices must be treated according to its binding, not assumed equal to native byte indices. Cross-engine CRLF/macro-origin parity remains B04. |
| W07 execution | Disabling LSP options must not be presumed to disable batch execution. | S with both options false creates the benign build-script sentinel. L disables those paths in the protocol probe; trusted Cargo input is still required. |
| W08 identity | A multitarget index must not silently merge identities. | S logs duplicate `indexing-domain 0.1.0 crate/` plus a missing-definition error for `model.rs`; exit is still zero and bytes repeat across three runs. An exit code alone is insufficient admission. |
| W09 transport | Exact JSON-RPC byte framing; malformed/truncated body, absent binary and deadline expiry remain failures. | Python tests cover UTF-8, consecutive frames, corrupt/truncated bodies. Real probe runs show `FileNotFoundError` and `TimeoutError`, with child cleanup; no green fallback. |
| W10 lifecycle | Rust mutation/add/delete/rename/worktree/TOCTOU, symlink escape and artifact tampering must withdraw admission. | No Rust Plane-A integration exists to exercise this. Existing Semctx oracles below are the reuse boundary; Rust witnesses remain #347 obligations, not passed trials. |
| W11 ambiguity/indirection | Duplicate glob names must not become a unique binding; an unknown function stays unresolved; a function parameter is not a concrete callee. | In the dependency-free edge workspace Cargo reports E0659/E0425. L and S nevertheless choose `left::shared` for the ambiguous call. L returns `[]` for the missing name, and a parameter location rather than a concrete function for the indirect call; its outgoing hierarchy for that wrapper is empty. |
| W12 macro/generated origins | A generated declaration is not automatically an ordinary repository-source definition. | L with expansion/build disabled returns `[]` for procedural/generated calls; declarative expansion gives definition and invocation locations. S executes the benign proc macro/build.rs, exports call occurrences but no definition-role occurrence for their generated declarations; OUT_DIR generated.rs is not a document. |
| W13 cfg/targets | Default/alternate feature and Unix/Windows worlds must have distinct bindings; syntax alone retains both branches. | L/S select different `configured` and `platform` declarations; T/Y retain both textually. Native Windows-target compilation fails E0463 because its std is absent, despite successful navigation into the Windows branch. |

The [edge workspace](rust-indexing/edge-cases/) and retained `edge-summary.json` exercise those
engine-level failures independently of Semctx integration. The native fixture test passes in both
default and alternate profiles. Proc-macro/generated-origin support, unselected modules, arbitrary
extern crates, function-pointer target closure and simultaneous feature/target worlds remain
unqualified: the experiments establish their limits, not complete support. Syntax presence is
diagnostic evidence, not a resolved source-origin fact.

Proposed mapping, subject to B03: crate/workspace to manifest-evidenced `package`, module to
`module`, struct/trait to `type` with explicit Rust-kind metadata, enum to `enum`, impl block to
`symbol`, function/method to `function`, and identified test body to `test`. Preserve Rust visibility,
namespace and impl identity explicitly rather than coercing a trait to a TypeScript interface.
The structural producer would own declaration facts; the semantic producer would contribute
disjoint resolved edge kinds. Join LSP endpoints to unique confined source declarations; missing
or ambiguous matches remain unresolved. Do not emit two batches claiming the same subject/fact
kind, join by basename, infer a `calls` edge from every reference occurrence, or trust an ambiguous
RA singleton without the independently established diagnostic/refusal boundary. This mapping and
its future tests are a proposal, not current graph semantics.

## Engine × M01–M22 compatibility matrix

Each cell evaluates the **engine's contribution**, not shipped Semctx Rust support (none is added).
`D/P` = direct data, partial feature; `C/P` = feasible composition, partial/unimplemented;
`U` = missing contribution for the required semantic behavior;
`I/NA` = engine-independent layer, with the independence stated in the cell.
No cell claims complete end-to-end Rust support. All four columns have negative completeness **N0**:
no exact negative-fact profile is established. Resolution `R0` is syntax only, `R1` is resolved
navigation within the one configured Cargo world, `R–` is independent of resolution.

The row's `W` witness and `K` cost apply to **every cell** in that row, in addition to the per-engine
runtime/performance/dependency cost in the tables above and below. A planned witness is explicitly
labelled; it cannot upgrade a cell to complete. This shared accounting avoids pretending each
consumer separately runs an engine or has an independently measured budget.

| Feature / shared witness / incremental cost | T: tree-sitter WASM | S: RA → SCIP | L: RA LSP | Y: syn helper |
| --- | --- | --- | --- | --- |
| M01 selection/readiness · W01/W05 + planned P01 · K1 | C/P R0: globs/off/test role outside parser | C/P R1: intersect Cargo world with exact selection; no omission-as-success | C/P R1: same plus readiness generation | C/P R0: globs/off/roles outside helper |
| M02 crates/workspaces · W02/W04 + P02 · K1 | C/P R0: Cargo metadata needed; CST `mod` is not membership | D/P R1: Cargo workspace; confine every loaded path | D/P R1: Cargo workspace; freeze config/target/generation | C/P R0: Cargo metadata + explicit module resolver needed |
| M03 symbols/graph · W01/W08 + P03 · K2 | D/P R0: CST declarations/visibility; IDs and kind mapping owed | D/P R1: monikers/definitions; duplicate identities block direct ingestion | D/P R1: symbols/ranges; canonical non-positional IDs owed | D/P R0: typed declarations/attrs; IDs and mapping owed |
| M04 imports/references · W02/W05/W11 + P04 · K3 | U R0 for resolution; can record raw `use`/`mod` only | D/P R1: occurrence candidates; ambiguous glob may still resolve to one target | D/P R1: navigation candidates; W11 disproves singleton ⇒ unambiguous binding | U R0 for resolution; typed paths are not bindings |
| M05 calls/graph paths · W02/W03/W11 + P05 · K3 | U R0: call expressions have no resolved targets | U R1 for native call edges; occurrences do not classify calls | D/P R1: outgoing hierarchy; function-value call has no concrete target; qualify incoming usages | U R0: syntactic `ExprCall`/`ExprMethodCall` only |
| M06 tests/recommendations · W01/W04 + P06 · K3 | C/P R0: test attrs/module role; no resolved tested_by/covers | C/P R1: resolve test occurrences plus syntax/role; imports alone do not prove coverage | C/P R1: syntax + selected test-body navigation; no execution evidence | C/P R0: attrs/`cfg(test)` visible; no semantic test link |
| M07 markers/claims/docs/SQL · W01 + P07 · K2 | C/P R0: parse explicit doc attrs/comments then existing docs/SQL composition | C/P R1: doc text insufficient alone; source markers still required | C/P R1: navigate source; marker and docs/SQL extractors still required | D/P R0 for attrs, C/P for marker/claims/docs/SQL |
| M08 evidence/provenance · W06/W12 + P08 · K2 | D/P R0: CST spans; binding-specific offset conversion and raw-source excerpts | D/P R1: UTF-8 ranges; generated declaration origin missing in W12 | D/P R1: UTF-16; declarative macro can return definition + invocation locations | D/P R0: spans converted to original bytes; BOM regression covered, cross-engine origins still owed |
| M09 capabilities/seals/authority · W10 + P09 · K4 | C/P R0: producer/config/scope + independent registry; N0 | C/P R1: artifact not attestation; bind binary/config/Cargo inputs; N0 | C/P R1: bind complete generation and responses; N0 | C/P R0: helper version/config/scope + independent registry; N0 |
| M10 persistence/freshness · W10 + P10 · K4 | C/P R0: atomic common store and stable capture still owed | C/P R1: one batch ≠ source binding; all Cargo/target inputs must be captured | C/P R1: reject mixed document versions/restarts; atomic store still owed | C/P R0: common store/capture; subprocess failure cannot publish partial index |
| M11 index-health/coverage · W05/W08 + P11 · K4 | C/P R0: errors and unsupported cfg scope remain visible | C/P R1: Cargo warnings/duplicates/missing data may reduce or fail outcome | C/P R1: readiness failure/timeouts/version drift visible per source | C/P R0: parser error distinct from unsupported/disabled/excluded |
| M12 indexed inspection · W01/W02 + P12 · K5 | C/P R0: useful structure once mapped, no resolver promise | C/P R1: occurrence/symbol graph once mapped; duplicate lookup refused | C/P R1: facts must be persisted; live LSP is not replacement search | C/P R0: useful structure once mapped; no primary content search |
| M13 verify diff · W10 + P13 · K5 | U alone: structure cannot supply retained resolved call/test witnesses | C/P R1 with syntax/call complement and explicit admission; no standalone parity | C/P R1 with syntax/markers, admission and rule fixtures | U alone: unresolved AST cannot satisfy retained semantic witnesses |
| M14 impact diff · W02/W10 + P14 · K5 | C/P R0 for hunks/outline; U alone for resolved reach | C/P R1 for references; needs Rust outline and admissible call complement | C/P R1: Rust hunk-side outline + adapted reach needed; no proof verdict | C/P R0 for outline; U alone for resolved reach |
| M15 authored links/check · W10 + P15 · K5 | C/P R–: exact anchors work only after canonical mapped facts | C/P R–: same; reject duplicate/missing monikers, no fuzzy rebinding | C/P R–: same; LSP URI/position is not stable authored ID | C/P R–: same; source offsets alone are not stable authored ID |
| M16 control/proofs · W10 + P16 · K5 | C/P R–: overlay consumes admitted coordinates; no parser-generated proof | C/P R–: same, duplicate coordinates denied | C/P R–: same, snapshot version coherence required | C/P R–: same, no parser-generated proof |
| M17 semantic slice · P17 · K6 | I/NA R–: authored slice needs no parser; Rust refs still need M15 | I/NA R–: same authored model, not SCIP output | I/NA R–: same authored model, not LSP state | I/NA R–: same authored model, not AST |
| M18 continuation/capsules · P18 · K6 | C/P R– for references/binding; offline cryptographic verification itself I/NA | C/P R– for references/binding; offline verifier independent of SCIP | C/P R– for references/binding; offline verifier independent of LSP | C/P R– for references/binding; offline verifier independent of helper |
| M19 reconciliation · W10 + P19 · K5 | C/P R0: post-image structural reanalysis; semantic obligations remain | C/P R1: rerun batch per post-image; B01/B02 apply | C/P R1: fresh post-image generation; never reuse old response blindly | C/P R0: reparse post-images; semantic obligations remain |
| M20 provider/ContextPack · P20 · K6 | C/P R–: graph projection + optional candidates; no retrieval authority | C/P R–: same; SCIP is not primary content search | C/P R–: same; live queries do not expand provider authority | C/P R–: same; syntax cannot invent candidates or intent |
| M21 qualification · P21 · K6 | I/NA R–: TS admission is engine-independent; preserve Rust refusal | I/NA R–: same; seal/index is no qualification | I/NA R–: same; resolved navigation is no TS-profile admission | I/NA R–: same; AST acceptance is no qualification |
| M22 CLI/MCP/distribution · W09 + P22 · K7 | C/P R0: macOS + Linux arm64 container parse smoke | C/P R1: macOS export; Linux binary runs but missing rust-src reduces facts | C/P R1: macOS navigation; native target/package lifecycle still B05 | C/P R0: macOS + Linux arm64 native helper tests; bundle/distribution B05 |

## Cost, performance and operating profile

Effort estimates are engineering estimates for one contributor familiar with Semctx, not timings
or commitments: K1 selection/Cargo boundary 2–4 days; K2 mapping/evidence/markers 3–6; K3 resolution,
calls and tests 5–10; K4 capture/registry/lifecycle/health 4–8; K5 shared consumers including Rust
impact/reconciliation 5–10; K6 mostly reusable authored/provider/refusal layers 2–4; K7 distribution,
transport and target evidence 3–6. Groups overlap: do not sum them as an approved schedule.
T adds WASM loading/version upkeep; S adds protobuf ingestion and exporter-version/diagnostic
upkeep; L adds a bounded request scheduler and generation lifecycle; Y adds a Rust helper release
matrix. Each matrix cell pays its row group plus that engine's shared cost, not a new engine run.

The proposed profile is Cargo-manifest-evidenced edition 2018/2021/2024 sources, one explicitly
selected feature/target world at a time, source/test roles, modules including confined `#[path]`,
struct/enum/trait/impl/method/generic declarations, explicit markers, local/inter-crate references
and individually resolved direct navigation. Keep external targets diagnostic unless their exact
source/provenance is selected. No exhaustive dispatch, arbitrary generated code, proc-macro origins,
cross-target union or negative evidence is claimed. Index dependencies and stdlib as analysis
inputs without projecting outside-repository source as repository-owned nodes.

Toolchain used is Rust/Cargo **1.98.1**, sysroot source component installed, target
`aarch64-apple-darwin`. RA officially supports latest stable stdlib sources; this older exact pin
is experimental evidence, not an upstream compatibility promise. Record the toolchain/sysroot
digest as well as RA's version in any future profile.

Measurements, raw samples, first-process/stable-repeat distinction, resource-accounting limits,
artifact sizes and edited-document latency are in the [performance record](rust-indexing/performance.md).
Syntax timings and semantic workspace loading are different work and must not be ranked as
equivalent indexing throughput. No persistent Semctx Rust index or production reindex latency is
measured in #346.

Proposed #347 budgets follow an interactive workflow, not a threshold fitted to this corpus:
foreground indexed queries should fit a 250 ms response budget; cold workspace analysis should
run asynchronously with a 60 s configurable deadline; a selected 10 kLOC workspace should target
at most 1 GiB peak child RSS. These are **unapproved planning budgets**, not benchmark PASS criteria.
There was no preregistered engine speed selection threshold, so none is inferred after measurement.
Calibrate these proposals on a representative larger, pinned workspace before accepting them (B06).

## Six independent gates, for every candidate

None of the engine outputs supplies all six gates. This table applies independently to T/S/L/Y;
gate 5 is inapplicable only to a positive fact, never because another coordinate is missing.

| Gate | Current Rust state | Required integration evidence / refusal |
| --- | --- | --- |
| 1 discovery/scope | No Rust producer; normal Rust input is unsupported today. | Exactly one completed result and declaring batch per selected fact kind; Cargo membership and path confinement. Disabled/unsupported/failed remain distinct; no batch or ambiguous batch is not analyzed. |
| 2 binding/integrity | Probe files/hashes are observations, not Plane-A attestations. | Bind selected bytes, manifests/lock, relevant Cargo config/toolchain/sysroot/features/target, producer/runtime versions and fact bytes; reject tampering and capture drift. |
| 3 current freshness | No Rust seal or current-source preflight is delivered. | Mutated source/config or mixed LSP generation withdraws use; historical artifact remains diagnostic. |
| 4 exact capability | Closed consumer registry contains no Rust tuple. | Separately register reviewed exact fact kinds/profile/evidence contract. Producer declarations alone fail `CAPABILITY_MISSING`. |
| 5 negative completeness | N0 for all candidates; neither missing occurrence nor empty hierarchy establishes absence. | Preserve `UNKNOWN`/`INSUFFICIENT_ANALYSIS`; `negativeEvidenceEligible: false`. No “no calls/tests/impact” guarantee. |
| 6 task authority | No Rust task/operation grant is added. | Both generic task policy and exact app-services policy must grant; otherwise `POLICY_DENIED`, regardless of freshness or engine success. |

The independent oracle is `packages/plane-a-internal/test/evaluation.test.ts`; the audit ran its
independent-gate cases. This is evidence for the common mechanism, not a Rust six-gate integration
result. For `impact diff`, preserve null derived fields after broken binding and
`explicitlyUnaffected: []` in schema v1. #347/P21 must add a Rust public-path witness retaining the
current qualified profile's bounded TS/JS refusal. Exact Rust reason behavior is debt until that
witness is green; the existing green outside-profile oracle uses Python. Any separate Rust
qualification needs its own decision and behaviorally relevant public-path evidence.

## Proof plan and named blockers

Use native parser/compilation/Cargo metadata checks for syntax/manifests, existing graph schemas
and Plane-A conformance for composition, real SQLite/Git tests for lifecycle, then public CLI/MCP
integration. No declaration-mirroring gate or replacement validation infrastructure is proposed.
The persistent discovery fixture can seed, but does not satisfy, #347's required
`examples/sample-rust-repo/`, mixed-language workspaces and analyzer-owned real corpus.

| Plan ID | #347 witness to add/reuse | Existing oracle / ownership boundary |
| --- | --- | --- |
| P01 M01 | Explicit on/off, globs/exclusions, failed syntax and source/test roles; v1 unchanged. | `packages/ts-analyzer/test/discovery-selection.test.ts`; native parser outcomes; shared ledger conformance. |
| P02 M02 | Two crates + mixed TS/JS/Python/Rust; invalid manifests and external/symlinked modules. | `packages/workspace-analyzer-internal/test/workspace-analyzer.test.ts`; real `cargo metadata`, confined file reads. |
| P03 M03 | Declaration/visibility mapping, homonyms, stable non-positional IDs and sorted output. | `packages/plane-a-internal/test/assembler.test.ts`; new Rust extraction witnesses and W08 duplicate refusal. |
| P04 M04 | Alias/reexport/glob/module/inter-crate references; absent/ambiguous names stay unresolved. | `packages/app-services/src/unresolved-references.ts`; real resolver integration against known source targets. |
| P05 M05 | Concrete, generic, trait-object, function-value and macro call sites with labelled uncertainty. | `packages/context-engine/test/change-impact.test.ts`; extraction fixture with independently named targets. |
| P06 M06 | Inline/#[test]/tests/ roles and justified tested_by/covers; no import-only coverage. | `packages/context-engine/test/verify.test.ts`; Rust test-body relation witnesses. |
| P07 M07 | Explicit doc marker joins existing docs/ADR/SQL claims and statement contradictions. | `packages/context-engine/test/claim-builder-divergence.test.ts`; marker extraction at source boundary. |
| P08 M08 | UTF-8/UTF-16/non-BMP/LF/CRLF ranges, source excerpts and macro/generated origins. | Helper's range tests now; future cross-engine evidence tests plus existing assembler schema. |
| P09 M09 | Each exact gate independently fails, unknown version/config/profile denied, N0 remains. | `packages/plane-a-internal/test/evaluation.test.ts`; `packages/app-services/test/plane-a-capability-requirements.test.ts`. |
| P10 M10 | Cold/stable/edit/add/delete/rename/checkout/worktree and capture mutation; atomic replacement. | `packages/app-services/test/indexing-toctou.test.ts`, `freshness.test.ts`, `verify-index-binding.test.ts`; real Git/SQLite. |
| P11 M11 | Outcome vs partial coverage vs binding/freshness, including external process failures. | `packages/app-services/test/index-health.test.ts`, `index-health-view.test.ts`. |
| P12 M12 | Public inspect by name/id/kind returns mapped Rust relations/claims/evidence. | `packages/context-engine/src/inspect.ts`; CLI/MCP inspect integration. |
| P13 M13 | Benign, contract-breaking and invariant-violating diffs: PASS/WARN/BLOCK and inadmissible refusal. | `packages/app-services/test/verify-analysis-scope.test.ts`, `verify-deleted-test-evidence.test.ts`; public rule fixture. |
| P14 M14 | Old/new hunk outlines, direct/transitive/possible paths, via/distance, unresolved/surfaces. | `packages/app-services/test/change-impact.test.ts`, `change-impact-coverage-authority.test.ts`; no proof vocabulary. |
| P15 M15 | Exact authored anchors resolve; deleted/renamed/ambiguous anchors refuse without rewriting intent. | `packages/semantic-model/test/link-diagnostics.test.ts`; `packages/app-services/test/link-consistency.test.ts`. |
| P16 M16 | Trace/traversal/lift/lower/architecture/plans and transition/step/deletion obligations over Rust facts. | Existing `packages/control-engine/test/` boundary suites; no parser-created evidence status. |
| P17 M17 | Authored slice retains Rust refs/provenance and unresolved references. | `packages/semantic-engine/src/slice.ts`; existing semantic slice tests with Rust-linked fixture. |
| P18 M18 | Rust-linked handoff/continuation/capsule fresh/stale/tampered/expired/offline results. | `packages/change-authorization-verifier/test/`; `packages/app-services/src/control-continuation.ts`. |
| P19 M19 | Reanalyze Rust post-images, bind scope, surface escape/drift and pending evidence. | `packages/control-engine/src/reconciliation.ts`; `packages/app-services/src/reconciliation-index.ts` with real source snapshots. |
| P20 M20 | Optional provider absent vs failed, ContextPack preserves fact provenance and no authority upgrade. | `packages/cocoindex-adapter/test/`; `packages/context-engine/src/context-pack-builder.ts`. |
| P21 M21 | Public Rust changes remain outside current TS/ESM profile, including mixed checkout. | `packages/app-services/test/qualified-checkout-boundaries.test.ts`; new explicit Rust refusal witness. |
| P22 M22 | CLI/MCP output and refusals, schemas/size limits, missing/incompatible binary, timeout/corrupt output. | Python transport tests now; existing CLI/MCP boundary suites plus native Linux/Windows/macOS packaging. |

| Blocker / decision | Evidence and consequence | Exit condition before dependent #347 work |
| --- | --- | --- |
| B01 execution policy | W07 + RA security model: SCIP can execute repository build scripts; LSP flags do not isolate Cargo configuration. | Accept a trusted/isolated opt-in boundary, inputs and subprocess/network policy; otherwise do not adopt semantic Cargo execution. |
| B02 SCIP identity/semantics | W08 duplicate crate symbol/missing definition; zero exported relationships. | Independently qualify a repaired exporter/profile or reject direct SCIP ingestion; a syntax join must not guess ambiguous identity or turn references into calls. |
| B03 graph/profile decision | Current node kinds lack a Rust-specific mapping; consumer registry is closed. | Review mapping of struct/trait/impl/method/enum/crate, stable namespace IDs and exact capability tuples. Existing scalar metadata may suffice; schema changes require separate acceptance only if necessary. |
| B04 semantic boundaries | W11–W13 show ambiguous RA singleton targets, missing generated definitions, indirect-call gaps and target navigation despite absent target std; cross-engine origin/offset parity remains unqualified. | Establish diagnostics/refusal that catches ambiguity, retained positive witnesses and exact origin/target scope before making these facts admissible. A singleton source-location join alone is insufficient. |
| B05 platforms | macOS arm64 trials plus Linux arm64 container T/Y smokes passed; Linux S ran with missing rust-src and fewer occurrences. No native Windows runner is exposed; local cross-compilation failed E0463. | Exercise complete replay/packaging on `ubuntu-latest`, native `windows-latest`, `macos-15`; bind sysroot and architecture. Existing container/cross-target results do not qualify native Windows or Linux release packaging. |
| B06 representative budgets | Small no-dependency corpus, three repeats, no accepted perf threshold or large-world sample. | Review workflow-derived budgets and repeat on a larger pinned multicrate/dependency corpus; include cold/edit/add/delete and bounded query fan-out. |
| B07 downstream parity | No Rust producer, hunk outline, semantic generation capture, or public Rust path is integrated. | #347 supplies P01–P22 and the three diff scenarios; do not declare support from this discovery or bypass existing qualification. |

These are named implementation decisions/limitations, not changes to issue state or claims that
#347 is unblocked. The separate repository-workflow problem `ACTIVE_CHANGE_OBSOLETE` is handled
by PR #378. This discovery is stacked on its `chore/close-stale-contracts` branch, which supplies
the contract closures needed for repository verification before #378 merges.

## Evidence discipline

Author task: `/root`; isolated claim auditor: `/root/audit_discovery_claims`. The
[full claim ledger](rust-indexing/claim-audit.md) distinguishes held common mechanisms from
Rust integration debt and contradicted guarantees. Read-only audit checks ran on macOS 27.0.1
arm64 / Bun 1.4.3. Runtime checks of this change and their final result belong in PR evidence;
Linux arm64 container smokes are recorded separately; native Windows remains unexercised locally.

No authored code comment is introduced by the probes/fixture. The real corpus preserves upstream
comments/doc comments verbatim as part of the pinned source, and generated Cargo lockfiles retain
Cargo's generated-file headers; neither records new Semctx behavior.

## 2026-10-17 evidence update: bounded engine reanalysis

The [Windows A3 series](rust-indexing/results/reanalysis-windows-2026-10-17/README.md) adds
three measured function-addition pairs for each of T/Y/S/L on both pinned inputs. Native
structured outputs prove the new function appears after the edit; timing, direct-process
RSS and original digests are retained. This supplies the engine-level cold/reanalysis
comparison missing from #346, with unequal semantic scope explicitly labelled. It does not
implement Semctx reindexing, resolve B01–B07, accept the proposed ADR or admit #347/#365.
Windows SCIP paths remain protocol-nonconforming and are matched only through an explicit
diagnostic mode; decoder/duplicate-symbol limits and historical observations stay visible.
