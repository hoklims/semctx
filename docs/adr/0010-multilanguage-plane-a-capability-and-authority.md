# ADR 0010 — Multi-language Plane A is capability-, scope-, and authority-gated

- Status: accepted
- Date: 2026-07-28
- Issue: [#57](https://github.com/hoklims/semctx/issues/57)
- Related: ADR 0003 (task-relative authority), ADR 0004 (provider sealing), ADR 0008
  (versioned machine output), ADR 0009 (Plane A/Plane B separation)

## Context

Plane A currently derives repository facts through a TypeScript-shaped pipeline. Discovery walks
the repository, applies the current approximate exclusion behavior, does not apply configured
`include`, and retains TypeScript, Markdown, and SQL files. Extraction and graph assembly are
coupled to the TypeScript analyzer. Existing graph consumers and `verify diff` also rely on
TypeScript-shaped nodes and edges.

Adding a language name, a glob, a file node, or a workspace directory would therefore not establish
semantic support. More importantly, a selected file can be unsupported, a producer can emit only a
partial fact set, a correctly sealed result can be outside its registered capability, and a
historically valid batch can be stale for the current source. Collapsing those states into one
language tier or one green health value would create false PASS or BLOCK conclusions.

Polyglot repositories add a second ambiguity. Directories such as `packages/` and `apps/` suggest
workspace units but do not prove them. Existing `package` and `belongs_to` graph concepts cannot
silently acquire new workspace semantics without changing public graph behavior.

This ADR establishes the semantic and migration boundary before implementation.

> **Scope:** this ADR is documentation and design only. It changes no runtime behavior, schema,
> test, dependency, lockfile, CLI, MCP, plugin, generated artifact, or public API. It does not
> deliver multi-language support, enable configured `include`, create workspace edges, or freeze a
> concrete adapter interface.

> **Runtime follow-up:** issues #58–#61 implement these invariants through private provisional
> packages and sidecars. See
> [Multi-language Plane A runtime](../architecture/multilanguage-plane-a-runtime.md). This does not
> retroactively turn the logical names in this ADR into a stable public API.

## Decision

Plane A support is modeled through exact capability and scope coordinates, independent trust
dimensions, and ordered load-bearing gates. The following names describe logical objects and
invariants. They are not prescribed TypeScript interfaces, packages, public schemas, serialization
layouts, or wire formats.

### Independent trust dimensions

The following five dimensions remain independent:

1. **Discovery state:** what was considered, selected, excluded, disabled, unsupported, failed, or
   analyzed for an exact scope.
2. **Fact capability:** which fact kinds a producer can soundly emit, and with what exact
   completeness, evidence, resolution, language, dialect, and scope claims.
3. **Provenance and binding:** which producer result, configuration, source state, and fact bytes
   are bound by an integrity attestation.
4. **Current freshness:** whether that bound state is admissible relative to the source and
   configuration now being evaluated.
5. **Task-relative authority:** whether a policy permits the exact fact to affect a particular
   task and operation.

No dimension supplies another. In particular, `FRESH` does not mean supported or complete; a valid
seal does not grant authority; selection does not establish capability; completeness does not
establish freshness; and policy cannot repair a failed discovery, binding, freshness, capability,
or negative-completeness gate.

### `ArtifactScope`

`ArtifactScope` identifies the exact domain of a claim:

- canonical repository and source-state identity;
- deterministic selected path set or path-domain digest;
- a manifest-evidenced workspace-unit identity, or an explicit repository-root scope;
- language and dialect/version where applicable.

A capability, fact, or completeness claim cannot be reused outside an equal scope. A broader or
wildcard policy is valid only when explicitly registered as policy; it cannot erase a mismatch in
the underlying capability coordinates.

### Selection, terminal analysis outcome, and `DiscoveryLedger`

Discovery is a product of two independent fields, not one pseudo-enum:

- `selectionDecision`: `selected` or `excluded`;
- `analysisOutcome`: `not_applicable`, `disabled`, `unsupported`, `failed`, or `analyzed`.

Only these combinations are valid:

| `selectionDecision` | Required `analysisOutcome` | Meaning |
| --- | --- | --- |
| `excluded` | `not_applicable` | The candidate was deterministically considered but not selected. |
| `selected` | `disabled` | The candidate was selected, but configuration explicitly disabled analysis. |
| `selected` | `unsupported` | No registered producer can analyze the exact selected language/scope. |
| `selected` | `failed` | The selected producer attempted analysis and failed terminally. |
| `selected` | `analyzed` | The ledger references exactly one completed producer result, and every evaluation subject/fact kind resolves to exactly one corresponding `FactBatch` that declares that fact kind present or queried. |

All other pairs are invalid, including `selected`/`not_applicable`, any outcome other than
`not_applicable` for `excluded`, and any entry that records more than one terminal analysis outcome.
The optional configuration or UX word `off` maps a selected artifact to
`selected`/`disabled`. `off` is not a selection decision, fidelity, capability, soundness, or
completeness value. A disabled analysis produces no analyzed `FactBatch`.

`selected`/`analyzed` is rejected unless both cardinalities above equal exactly one. A missing
completed result, multiple candidate results, a structurally absent batch, no batch declaring the
subject's fact kind, or multiple matching batches is deterministically normalized to
`selected`/`failed` with `PRODUCER_FAILED`. The reason detail uses `resultCardinality` or
`factBatchCardinality`, `expected: 1`, and canonical numeric `actual` equal to `0` or the observed
count. This gate-1 normalization does not invent binding, freshness, capability, completeness, or
policy failures.

`DiscoveryLedger` is the complete, deterministically ordered record of candidate artifacts. Every
entry contains its `ArtifactScope`, the two fields above, selection and analysis reasons, and the
selected producer when one exists. It must distinguish excluded, disabled, selected-but-unsupported,
producer failure, and successful analysis without treating those terminal outcomes as simultaneous
states of one entry. A selected changed scope without an admissible analyzer yields
`INSUFFICIENT_ANALYSIS`, never PASS.

### `FactBatch`

`FactBatch` is an atomic set of positive and/or negative facts bound to:

- one `ArtifactScope`;
- the fact kinds present or queried;
- producer identity and version;
- producer-configuration digest and fact-schema digest;
- evidence records satisfying the declared evidence contract;
- a referenced `CapabilityProfile`;
- source/result binding and integrity attestations when available.

For one exact evaluation subject and fact kind, exactly one corresponding batch must exist and
explicitly declare that fact kind present or queried before gate 1 can accept
`selected`/`analyzed`. A batch may contain zero positive fact instances when it still exists,
declares the queried fact kind and exact completeness claim, and satisfies the remaining gates.
An empty result set is therefore distinct from a structurally absent or ambiguous batch.

A provider or freshness seal proves only the binding and integrity it declares. It does not create
a missing capability, prove completeness, establish current freshness, or grant task-relative
authority. A validly sealed `FactBatch` may remain diagnostic-only.

### `CapabilityProfile`

A `CapabilityProfile` is keyed by the complete product of:

- fact kind: `module`, declaration, import, reference, call, marker, test link, inferred contract,
  or an explicit negative fact kind;
- exact selected path/workspace `ArtifactScope`;
- language and dialect/version;
- producer identity and version;
- producer-configuration digest;
- fact-schema digest;
- evidence contract;
- resolution semantics;
- soundness claim;
- completeness claim for that exact fact kind and scope;
- `negativeEvidenceEligible`, derived only when the exact completeness, evidence, resolution, and
  soundness requirements for the negative conclusion hold.

No language name or scalar label supplies a missing coordinate. `structural` and `precise` may be
derived human-facing summaries of one or more profiles, but they are non-normative. Different
profiles may render the same label, and the same profile may be summarized differently by different
views. Authority policies, blocking rules, and machine gates must not consume these labels.

### Evaluation requests, exact subjects, `IndexHealth`, and `admissibleFor`

`IndexHealth` composes the discovery ledger, fact batches, scope and capability gaps, and current
freshness without collapsing them to one scalar. It can therefore report `FRESH` source binding
alongside partial, unsupported, failed, or insufficient analysis.

Gate evaluation starts from an **evaluation request**, identified by task, operation, fact kind,
requested-scope descriptor, and candidate identity. The requested-scope descriptor is input to
scope resolution; it is not an `ArtifactScope` and must not be reported as one.

Gate 1 first produces a **scope-resolution decision**. If layout, candidate discovery, or scope
resolution cannot establish one exact `ArtifactScope`, this is a pre-subject decision carrying the
request/candidate identity and the applicable `AMBIGUOUS_LAYOUT`, `AMBIGUOUS_SCOPE`, or
`DISCOVERY_NOT_ESTABLISHED` reasons. It does not create an evaluation subject, does not invent an
exact scope, and marks gates 2-6 not applicable because their coordinates require an exact subject.

Only successful exact scope resolution creates an **evaluation subject**: the evaluation request
plus one exact `ArtifactScope`, fact kind, current source state, and ledger entry. Its producer result
or `FactBatch` may be absent when the terminal `analysisOutcome` is `disabled`, `unsupported`, or
`failed`; that terminal outcome supplies the gate-1 decision instead of fabricating a missing
result. For `selected`/`analyzed`, the subject must instead bind exactly one completed producer
result and one corresponding fact-kind-declaring `FactBatch`; otherwise gate 1 normalizes it to
`selected`/`failed`.
A terminal selection or analysis state belongs to one ledger entry; mutually exclusive terminal
states can coexist only in an `IndexHealth` or report because they describe distinct exact subjects.

Each pre-subject scope-resolution decision and each exact-subject decision produces its own ordered
reasons and `primaryReason`. `IndexHealth` and versioned reports aggregate an ordered discriminated
union of both decision kinds. A pre-subject member retains task, operation, fact kind,
requested-scope descriptor, and candidate identity; an exact-subject member retains its exact
`ArtifactScope`. A report must not merge the two kinds, invent a synthetic scope, or discard their
decision-level reason records. A report-level reason summary may deduplicate codes for presentation
only.

`admissibleFor(task, operation, factKind, scope)` is the task-relative policy decision over exact
coordinates. It returns admissible or not admissible plus deterministic reasons. It is evaluated
only after the earlier load-bearing gates; favorable policy cannot make invalid facts valid.

Negative conclusions such as “no test”, “no reference”, “no dependency”, or “no impacted contract”
require exact scoped completeness for the queried negative fact kind and
`negativeEvidenceEligible: true`. Otherwise the result is `UNKNOWN` or
`INSUFFICIENT_ANALYSIS`, never an asserted absence and never PASS.

## Ordered load-bearing gates

Every fact or negative conclusion that could influence PASS, WARN, or BLOCK starts at gate 1. Gates
2-6 run in order only after gate 1 establishes a valid exact `selected`/`analyzed` subject. For every
such subject, gates 2, 3, 4, and 6 are always applicable; gate 5 is additionally applicable to a
negative conclusion. A missing downstream coordinate fails its owning gate and never makes that gate
not applicable. Implementations collect every applicable failure within that decision;
ending with a pre-subject scope-resolution decision is not short-circuiting because downstream gates
are undefined without an exact scope. Every applicable gate is independently necessary; no gate is
sufficient by itself.

| Order | Gate | Pass condition | Denial result |
| ---: | --- | --- | --- |
| 1 | Discovery and scope | Resolve the evaluation request to one exact `ArtifactScope`; require `selectionDecision: selected` plus `analysisOutcome: analyzed`; require exactly one completed producer result and exactly one corresponding `FactBatch` declaring the subject fact kind present or queried. | Without an exact scope, emit a pre-subject decision. For a non-analyzed outcome or invalid result/batch cardinality, retain an exact subject, normalize cardinality failure to `selected`/`failed`, and return diagnostic-only `INSUFFICIENT_ANALYSIS`. Do not evaluate gates 2-6 or synthesize their failures. |
| 2 | Provider/result binding and integrity | The exact `FactBatch`, producer result, source state, producer configuration, and fact bytes are covered by a valid integrity attestation. | Diagnostic-only; unsealed or invalid facts are inadmissible. |
| 3 | Current freshness preflight | Current state is `FRESH`, or sealed `DIRTY_KNOWN` whose exact non-empty diff matches the admitted contract. `STALE` and `UNSEALED` deny. | Diagnostic-only and `UNKNOWN` or `INSUFFICIENT_ANALYSIS`, never PASS. |
| 4 | Capability match | Fact kind, exact scope, language/dialect, producer identity/version, config and schema digests, resolution/soundness, and evidence contract exactly match the registered profile. | Diagnostic-only and inadmissible for the requested operation. |
| 5 | Negative completeness | For a negative fact, exact fact-kind/scope completeness holds and `negativeEvidenceEligible` is true. Positive facts mark this gate not applicable. | `UNKNOWN` or `INSUFFICIENT_ANALYSIS`; absence cannot be asserted. |
| 6 | Task-relative authority | `admissibleFor(task, operation, factKind, scope)` grants use under the current policy. | `POLICY_DENIED`; the fact remains diagnostic-only. |

### Current-staleness withdrawal

A provider seal remains inspectable as historical evidence after source mutation, but it is
re-evaluated against current freshness. If the preflight is now `STALE`, gates 1, 2, 4, 5, and 6
may still match while gate 3 withdraws load-bearing admissibility. The historical binding is not
rewritten or declared invalid; the current conclusion becomes diagnostic-only and `UNKNOWN` or
`INSUFFICIENT_ANALYSIS`, never PASS.

## Closed reason catalogue

The first implementation may map these logical reasons into a versioned machine schema, but it must
not introduce semantically overlapping aliases. The catalogue is closed and ordered:

| Order | Reason |
| ---: | --- |
| 1 | `AMBIGUOUS_LAYOUT` |
| 2 | `AMBIGUOUS_SCOPE` |
| 3 | `DISCOVERY_NOT_ESTABLISHED` |
| 4 | `ANALYSIS_DISABLED` |
| 5 | `LANGUAGE_UNSUPPORTED` |
| 6 | `PRODUCER_FAILED` |
| 7 | `BINDING_UNSEALED` |
| 8 | `BINDING_INVALID` |
| 9 | `CURRENT_STATE_UNSEALED` |
| 10 | `CURRENT_STATE_STALE` |
| 11 | `SCOPE_MISMATCH` |
| 12 | `CAPABILITY_MISSING` |
| 13 | `PRODUCER_VERSION_MISMATCH` |
| 14 | `CONFIG_DIGEST_MISMATCH` |
| 15 | `SCHEMA_DIGEST_MISMATCH` |
| 16 | `EVIDENCE_CONTRACT_MISMATCH` |
| 17 | `NEGATIVE_COMPLETENESS_MISSING` |
| 18 | `POLICY_DENIED` |

Composition is canonical:

1. construct the evaluation request from task, operation, fact kind, requested-scope descriptor, and
   candidate identity;
2. evaluate gate 1 scope resolution;
3. if no exact `ArtifactScope` exists, emit one pre-subject scope-resolution decision, collect its
   applicable gate-1 reasons, mark gates 2-6 not applicable, and stop that request;
4. otherwise create one exact evaluation subject and evaluate the remaining gate-1
   selection/analysis conditions, completed-result cardinality, and corresponding fact-batch
   cardinality;
5. if gate 1 observes zero or multiple completed results or matching batches, normalize the exact
   subject to `selected`/`failed`, emit `PRODUCER_FAILED` with cardinality detail, mark gates 2-6 not
   applicable, and do not synthesize downstream reasons;
6. for a valid `selected`/`analyzed` subject, evaluate gates 2, 3, 4, and 6 unconditionally and gate
   5 for a negative conclusion; missing coordinates deny at their owning gate;
7. emit one reason record per code per decision and merge its structured details;
8. deduplicate exact detail triples and order them by `coordinate`, then canonical `expected`, then
   canonical `actual`;
9. order decision reasons by the catalogue above and expose the first as that decision's
   `primaryReason`;
10. aggregate the discriminated union by task, operation, fact kind, requested-scope descriptor,
   candidate identity, decision kind, and exact `ArtifactScope` when present;
11. derive any report-level code summary by catalogue order while retaining all decision records.

Decision-level and report-level `primaryReason` values are presentation, not authority. A
decision-level value is the first reason for that pre-subject or exact-subject decision. A
report-level value is the first catalogue-ordered code across the ordered union and must not imply
that all records share one scope or subject. Neither suppresses a secondary failure. Unknown aliases,
omitted applicable reasons, duplicates, and encounter-order output fail conformance.

Every reason record has structured detail
`{ coordinate, expected, actual }`. `coordinate` is one of the normative coordinate names below;
`expected` and `actual` are canonical scalar or structured values, not prose aliases. When several
coordinates map to the same code for one decision, the implementation emits that code once and
merges the ordered detail triples. No component-specific alias may be added to the closed catalogue.

### Normative gate and coordinate reason mapping

| Gate | Failed coordinate or condition | Required reason code |
| ---: | --- | --- |
| 1 | Evaluation request `workspaceLayout` is conflicting, cyclic, external, escaping, or symlinked; emit a pre-subject decision | `AMBIGUOUS_LAYOUT` |
| 1 | Evaluation request `requestedScopeDescriptor` cannot resolve to one exact `ArtifactScope`; emit a pre-subject decision | `AMBIGUOUS_SCOPE` |
| 1 | Evaluation request candidate/ledger discovery is not established; emit a pre-subject decision | `DISCOVERY_NOT_ESTABLISHED` |
| 1 | Exact subject `selectionDecision` is `excluded` | `DISCOVERY_NOT_ESTABLISHED` |
| 1 | `analysisOutcome` is `disabled` | `ANALYSIS_DISABLED` |
| 1 | `analysisOutcome` is `unsupported` | `LANGUAGE_UNSUPPORTED` |
| 1 | `analysisOutcome` is `failed` | `PRODUCER_FAILED` |
| 1 | `selected`/`analyzed` has `resultCardinality` other than exactly one completed producer result | `PRODUCER_FAILED` |
| 1 | `selected`/`analyzed` has `factBatchCardinality` other than exactly one batch declaring the subject fact kind present or queried | `PRODUCER_FAILED` |
| 2 | `bindingAttestation` is absent | `BINDING_UNSEALED` |
| 2 | `bindingAttestation` is present but invalid | `BINDING_INVALID` |
| 3 | `currentFreshness` is `UNSEALED` | `CURRENT_STATE_UNSEALED` |
| 3 | `currentFreshness` is `STALE` | `CURRENT_STATE_STALE` |
| 4 | `factKind` has no registered matching profile | `CAPABILITY_MISSING` |
| 4 | `artifactScope` differs from the profile's exact selected path/workspace scope | `SCOPE_MISMATCH` |
| 4 | `language` or `dialectVersion` differs from every registered matching profile | `CAPABILITY_MISSING` |
| 4 | `producerIdentity` differs from every registered matching profile | `CAPABILITY_MISSING` |
| 4 | `producerVersion` differs from the matching producer profile | `PRODUCER_VERSION_MISMATCH` |
| 4 | `producerConfigurationDigest` differs | `CONFIG_DIGEST_MISMATCH` |
| 4 | `factSchemaDigest` differs | `SCHEMA_DIGEST_MISMATCH` |
| 4 | `evidenceContract` differs | `EVIDENCE_CONTRACT_MISMATCH` |
| 4 | `resolutionSemantics` or `soundnessClaim` differs from every registered matching profile | `CAPABILITY_MISSING` |
| 4 | `completenessClaim` required as a capability coordinate is absent or mismatched | `CAPABILITY_MISSING` |
| 5 | Exact negative `completenessClaim` is insufficient for the queried fact kind/scope | `NEGATIVE_COMPLETENESS_MISSING` |
| 5 | `negativeEvidenceEligible` is not exactly `true` | `NEGATIVE_COMPLETENESS_MISSING` |
| 6 | `taskRelativeAuthority` does not grant the exact task/operation/fact-kind/scope tuple | `POLICY_DENIED` |

`LANGUAGE_UNSUPPORTED` is reserved for the terminal discovery outcome of a selected subject.
A language or dialect mismatch against an otherwise completed producer result is a gate-4
`CAPABILITY_MISSING`; it does not create a second alias. For positive facts, gate 5 is not
applicable; a completeness coordinate consumed at gate 4 still uses `CAPABILITY_MISSING`.

## Workspace and graph semantics

The existing `NodeKind: "package"` is reserved for a manifest-evidenced **workspace unit**: a
repository-contained build or distribution unit established by explicit supported workspace or
package metadata. Directory layout such as `packages/` or `apps/` creates candidates only.
Workspace detection never implies language support, fact capability, completeness, or authority.

There is no synthetic root `package`. An artifact with no admitted workspace unit retains repository
`ArtifactScope` and current legacy `belongs_to` behavior. External roots, roots that escape through
`..`, and all symlinked workspace roots are rejected.

New workspace containment uses dedicated, versioned relations:

| Edge | Domain | Codomain | Cardinality and deterministic selection |
| --- | --- | --- | --- |
| `contained_in_workspace` | A file-backed analyzable `module`, `test`, `document`, or `migration` artifact | An admitted workspace-unit `package` | `0..1` outgoing; select the most-specific admitted ancestor workspace. |
| `workspace_member_of` | An admitted workspace-unit `package` | Its nearest enclosing admitted `package`, otherwise the repository | Exactly `1` outgoing. |

The following rules are normative:

- Nested manifest-evidenced units are allowed. A nested unit points to its nearest enclosing unit;
  artifacts point only to their most-specific admitted unit.
- Duplicate evidence for the same canonical root coalesces only when workspace identity and parent
  agree. Otherwise it emits `AMBIGUOUS_LAYOUT`, and no membership edges are emitted for the
  conflict.
- Non-ancestor overlapping ownership claims conflict, emit `AMBIGUOUS_LAYOUT`, and emit no
  conflicting membership edges.
- Candidate parent links that would create a cycle are rejected as `AMBIGUOUS_LAYOUT`.
- The admitted workspace graph is acyclic.
- Containment traversal may be used only for containment and scope. It must not imply imports,
  references, refinement, dependency, proof, capability, or authority.
- Existing `belongs_to` bytes and traversal behavior remain unchanged until the F3 graph-schema
  migration. F3 versions public graph output and proves legacy behavior with compatibility
  fixtures.

### Workspace worked cases

| Case | Evidence | Required result |
| ---: | --- | --- |
| 1 | `packages/foo` exists without manifest/workspace evidence. | Candidate only; no workspace node or membership edge. |
| 2 | A supported manifest declares `packages/foo`. | Admit one workspace unit with one parent edge. |
| 3 | Two authoritative detectors assign conflicting roots. | `AMBIGUOUS_LAYOUT`; no conflicting membership edges. |
| 4 | Nested manifest-evidenced units exist. | The artifact has one edge to the most-specific unit; the nested unit has one edge to the nearest enclosing unit. |
| 5 | Duplicate same-root evidence disagrees on identity or parent. | `AMBIGUOUS_LAYOUT`; coalesce only when both identity and parent agree. |
| 6 | Two non-ancestor ownership claims overlap. | `AMBIGUOUS_LAYOUT`; no conflicting membership edges. |
| 7 | A root is external, `..`-escaping, or symlinked. | Reject it; emit no workspace node or edge. |
| 8 | An artifact has no admitted workspace. | No synthetic package; retain repository scope and legacy `belongs_to` behavior. |
| 9 | Candidate parent links form a cycle. | Reject the candidate graph as `AMBIGUOUS_LAYOUT`. |

## Compatibility and migration

| Phase | Compatibility requirement |
| --- | --- |
| RFC | Documentation only. Existing config, graph bytes, seals, CLI text and exit semantics, machine schemas, MCP, and plugin behavior are unchanged. |
| F1 | Preserve byte-identical TypeScript graph, evidence, claims, verification behavior, and analysis-input fingerprints, or separately version and approve intentional drift. The adapter seam remains internal and provisional. |
| F2 | Do not silently shrink graphs for old configurations. Preserve legacy selection by default or require an explicit config/schema-version migration. Selection changes the exact scope and hash only through that explicit path. |
| F3 | Add versioned `contained_in_workspace` and `workspace_member_of` edges. Preserve legacy `belongs_to` bytes and traversal behavior until migration. Keep source freshness separate from `IndexHealth`; maintain text/JSON/CLI/MCP/plugin parity under ADR 0008. |
| F4 | Preserve existing TypeScript behavior while a real second-language vertical exercises the provisional model. Machine-output changes remain versioned. Stabilization requires the 13 behavioral ADR cases, all three F4 corpus fixtures, and `GATE-C14` on the F4 branch. |

Current configuration documentation must remain explicit that `include` is not presently applied and
that non-TypeScript globs do not enable semantic support.

## Provisional follow-ups and stabilization gate

All follow-ups are open and currently unassigned. Each is blocked on the acceptance and merge of
#57 and this ADR.

| Phase | Issue | Dependency and acceptance gate | Stop condition |
| --- | --- | --- | --- |
| F1 | [#58 — Plane A language-neutral adapter and graph assembly boundary](https://github.com/hoklims/semctx/issues/58) | Introduce an internal provisional seam and prove TypeScript golden equivalence, deterministic normalization, exact capability coordinates, independent gates, and reason-coded rejection. | Stop on unapproved TypeScript drift or any public/stable adapter API. |
| F2 | [#59 — Honor include/exclude with explicit selection compatibility](https://github.com/hoklims/semctx/issues/59) | Integrate with F1 without stabilizing it; define deterministic selection and an explicit legacy or versioned migration. | Stop on silent graph shrink, implicit schema migration, or undocumented selection-hash change. |
| F3 | [#60 — Manifest-evidenced workspaces and separate index health](https://github.com/hoklims/semctx/issues/60) | Consume F1 and coordinate exact scope with F2; prove manifest evidence, cardinalities, nesting, ambiguity rejection, acyclicity, versioned edges, legacy `belongs_to`, and health/freshness separation. | Stop on layout-only admission, ambiguous membership, cardinality/cycle violation, synthetic roots, legacy drift, or collapsed health/freshness. |
| F4 | [#61 — First real second-language Plane A vertical and corpus gate](https://github.com/hoklims/semctx/issues/61) | Blocked on F1-F3. Implement one genuine semantic vertical; pass `ADR-C01..C10` and `ADR-C15..C17`; pass the deterministic unit fixture, mixed-workspace fixture, and real-repository snapshot pinned to commit and producer version; run and pass `GATE-C14` on the F4 branch. | Stop on any failed ADR case, corpus fixture, or F4 branch gate; silent failure; incomplete-negative PASS; unpinned evidence; TypeScript regression; or value no stronger than path grep. |

Only the semantic invariants, conformance cases, and migration gates in this ADR are stable now.
Any F1 adapter API remains provisional and internal through F2 and F3. It must not be declared
public or stable before F4 supplies real cross-language counterpressure and the complete conformance
suite passes.

For F4 stabilization, “complete conformance suite” means exactly the 13 behavioral ADR cases
(`ADR-C01..C10` and `ADR-C15..C17`), the three F4 corpus fixtures, and `GATE-C14` using the exact
typecheck, test, and plugin-check commands on the F4 branch. `DOC-C11..C12` remain applicable
documentation and lifecycle controls whenever those records are reviewed or changed, but they are
not substitutes for runtime evidence. `SCOPE-C13` applies only to the docs-only RFC #57 PR; it is
not rerun as a docs-only constraint on the runtime F4 PR.

## Conformance decision table

Every named case below must be reviewed as behavior, not as keyword presence.

| Case | Input or operation | Required decision |
| --- | --- | --- |
| `ADR-C01-DIMENSIONS` | The source/index seal is `FRESH`, but a selected changed Python scope is unsupported. | Freshness remains `FRESH`; `IndexHealth` is partial/insufficient; `admissibleFor` denies load-bearing use. An overall green PASS fails conformance. |
| `ADR-C02-OFF` | Language configuration uses UX value `off` for a selected artifact. | Record `selectionDecision: selected` and `analysisOutcome: disabled`; produce no `FactBatch`; reject `off` as a selection decision, fidelity, or capability. |
| `ADR-C03-LABELS` | Two producers both render `structural`, but one has complete module imports and the other only local declarations; repeat with two `precise` labels differing by scope or version. | Profiles and fact-kind authorization differ. Any gate that consumes the UX label fails. |
| `ADR-C04-CAPABILITY-KEY` | Fact kind matches but path scope, workspace, dialect, producer version, config digest, schema digest, evidence contract, resolution/soundness, or completeness differs. | Do not reuse the capability. Emit the applicable exact-coordinate reason. Wildcard authorization fails unless explicitly registered as policy and still cannot repair the profile mismatch. |
| `ADR-C05-SEAL` | A `FactBatch` has a valid exact-source/result seal but contains a fact outside registered capability or current task policy. | Binding/integrity passes; the fact remains diagnostic-only and inadmissible. |
| `ADR-C06-NEGATIVE` | No `tested_by` edge is reported, but test-link completeness is partial, unknown, or for a different scope/version. | Return `UNKNOWN` or `INSUFFICIENT_ANALYSIS`, never “no test” or PASS. Eligibility requires exact completeness and the required evidence/resolution/soundness contract. |
| `ADR-C07-FRESH-PARTIAL` | Captured files/config are unchanged while one selected workspace is unsupported or failed. | Report `FRESH` and partial/insufficient analysis as separate dimensions; neither overwrites the other. |
| `ADR-C08-WORKSPACE` | Apply workspace cases 1-9 above, then inspect cardinality and traversal. | Produce exactly the worked-case results; every workspace has exactly one parent, eligible artifacts have at most one most-specific containment edge, the graph is acyclic, and containment grants no semantic or authority implication. |
| `ADR-C09-EDGES` | Compare the pre-F3 graph using `belongs_to` with the F3 workspace migration. | Pre-migration bytes/traversals remain unchanged. New semantics use versioned `contained_in_workspace` and `workspace_member_of`; `belongs_to` is not silently overloaded. |
| `ADR-C10-PROVISIONAL` | F1 proposes a public/stable adapter API before an F4 second-language conformance and corpus run. | Reject stabilization. Only this ADR's semantic invariants and gates are frozen. |
| `DOC-C11-INCLUDE` | Compare configuration documentation with current discovery behavior. | State that current `include` is not applied and non-TypeScript globs do not enable support. |
| `DOC-C12-FOLLOWUPS` | Inspect F1-F4 delivery records. | Require linked issues #58-#61, dependencies, acceptance and stop gates, unassigned/owner state, and backlinks to #57/ADR 0010. |
| `SCOPE-C13-DOCS-ONLY` | Inspect the RFC PR changed-file set. | Permit only approved documentation/roadmap scope; any runtime, schema, test, dependency, lockfile, generated, CLI, MCP, or plugin behavior change fails. |
| `GATE-C14-REPO` | Run repository typecheck, tests, and plugin checks. | All must exit zero, or an unrelated pre-existing failure must be recorded exactly. Do not report green without fresh evidence. |
| `ADR-C15-GATE-ORDER` | Fail gate-1 scope resolution as a pre-subject request; fail gate 1 with an exact non-analyzed subject; present `selected`/`analyzed` with zero and multiple completed results or matching fact batches; then independently fail gates 2-6 after valid exact-subject creation while all other applicable gates pass. | A pre-subject or gate-1 cardinality failure does not evaluate gates 2-6. Cardinality failures normalize to `selected`/`failed` plus `PRODUCER_FAILED`. For every valid exact `selected`/`analyzed` subject, gates 2, 3, 4, and 6 are mandatory, and gate 5 is mandatory for negative conclusions. |
| `ADR-C16-STALE-WITHDRAWAL` | Start with a valid historical seal, exact capability/scope/version/digests/evidence, complete eligible negative facts, and favorable policy; then mutate selected source so current state is `STALE`. | Historical binding remains inspectable, but current load-bearing admissibility is withdrawn. Return diagnostic-only and `UNKNOWN` or `INSUFFICIENT_ANALYSIS`, never PASS. |
| `ADR-C17-REASONS` | Compose compatible failures per exact evaluation subject, then aggregate pre-subject requests and distinct exact subjects as worked below. | Produce canonical decision-level reasons and `primaryReason`, then aggregate without inventing a scope, collapsing decision identity, or treating mutually exclusive terminal states as one subject. |

### `ADR-C15-GATE-ORDER` independent failures

| Failed gate with all others passing | Required non-PASS outcome |
| --- | --- |
| 1 — unresolved discovery/scope request | Pre-subject `INSUFFICIENT_ANALYSIS`; gates 2-6 are not applicable and no `ArtifactScope` is invented. |
| 1 — exact subject with non-analyzed terminal outcome | `INSUFFICIENT_ANALYSIS`; diagnostic-only; absent producer/result coordinates do not synthesize downstream failures. |
| 1 — `selected`/`analyzed` with zero or multiple completed results | Normalize to `selected`/`failed`; `PRODUCER_FAILED` with `resultCardinality`, `expected: 1`, and numeric `actual`; gates 2-6 are not evaluated. |
| 1 — `selected`/`analyzed` with zero or multiple matching fact-kind batches | Normalize to `selected`/`failed`; `PRODUCER_FAILED` with `factBatchCardinality`, `expected: 1`, and numeric `actual`; gates 2-6 are not evaluated. |
| 2 — binding/integrity | Unsealed or invalid and inadmissible; diagnostic-only. |
| 3 — current freshness | `UNKNOWN` or `INSUFFICIENT_ANALYSIS`; diagnostic-only. |
| 4 — capability match | Coordinate-specific mismatch; diagnostic-only and inadmissible. |
| 5 — negative completeness | `UNKNOWN` or `INSUFFICIENT_ANALYSIS`; no asserted absence. |
| 6 — task policy | `POLICY_DENIED`; diagnostic-only. |

### `ADR-C17-REASONS` worked compositions

The first row is one exact subject with compatible failures. The other rows are report-level
compositions across the explicitly distinct pre-subject requests and exact subjects shown; their
identities and exclusive terminal states must not be collapsed.

| Evaluation decision(s) | Canonical ordered reasons; first is `primaryReason` |
| --- | --- |
| Subject A: one exact negative conclusion has a profile `SCOPE_MISMATCH`, stale current state, wrong config digest, incomplete negative coverage, and policy denial. | Subject A: `CURRENT_STATE_STALE`, `SCOPE_MISMATCH`, `CONFIG_DIGEST_MISMATCH`, `NEGATIVE_COMPLETENESS_MISSING`, `POLICY_DENIED`. |
| Request B: workspace-layout conflict yields a pre-subject decision. Request C: requested scope cannot be resolved exactly and yields a pre-subject decision. Subject D: exact scope D is `selected`/`disabled`. Subject E: exact scope E is `selected`/`unsupported`. Subject F: exact scope F is `selected`/`failed`. | Report summary: `AMBIGUOUS_LAYOUT`, `AMBIGUOUS_SCOPE`, `ANALYSIS_DISABLED`, `LANGUAGE_UNSUPPORTED`, `PRODUCER_FAILED`; each code remains attached to Request B, Request C, Subject D, Subject E, or Subject F respectively, and neither request is assigned an `ArtifactScope`. |
| Subject G: binding attestation absent. Subject H: a distinct binding attestation is present but invalid. Subject I: a distinct analyzed scope has missing capability, wrong producer version, wrong schema digest, and wrong evidence contract. | Report summary: `BINDING_UNSEALED`, `BINDING_INVALID`, `CAPABILITY_MISSING`, `PRODUCER_VERSION_MISMATCH`, `SCHEMA_DIGEST_MISMATCH`, `EVIDENCE_CONTRACT_MISMATCH`; each subject retains its own ordered reasons and `primaryReason`. |

## Alternatives considered

### ADR plus foundation extraction

This would immediately pressure the TypeScript boundary and provide golden equivalence evidence, but
it would broaden #57 into a runtime refactor and could fossilize a TypeScript-shaped API. It is
deferred to provisional F1.

### ADR plus a first second-language vertical

This would provide the strongest cross-language counterpressure, but it couples trust semantics,
selection migration, workspace modeling, output compatibility, producer choice, and dependency
risk. It is deferred to F4 after F1-F3 gates.

### Configuration or file-node shortcut

Treating non-TypeScript globs, discovered file nodes, or layout directories as support would create
false confidence without semantic facts, exact completeness, or task authority. This alternative is
rejected.

### Scalar language tiers

Using `off`, `structural`, and `precise` as machine capabilities collapses incompatible fact kinds,
scopes, producer versions, and evidence contracts. It is rejected; those words may only be derived
UX summaries as specified above.

## Consequences

- #57 establishes a falsifiable design boundary without claiming immediate polyglot value.
- Unsupported, partial, failed, stale, or policy-denied analysis cannot silently produce PASS.
- Absence becomes evidence only under exact scoped completeness and
  `negativeEvidenceEligible`.
- Provider and freshness seals retain their binding role without becoming authority.
- Workspace membership is manifest-evidenced, deterministic, versioned, and separate from semantic
  relations and legacy `belongs_to`.
- Existing TypeScript behavior remains the compatibility golden until an explicit versioned
  migration.
- The cost is staged delivery: the model remains paper architecture until F1-F4 supply executable
  evidence, and no adapter API can stabilize before the F4 corpus and conformance gates pass.
