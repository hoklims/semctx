# Semantic Reconstruction Control Plane v1

> Status: implemented read-only control plane. Plane C compiles versioned semantic intent and
> evaluates the actual working diff; it does not execute either.

## Boundary

Semctx keeps three kinds of truth separate:

| Plane | Authority | Examples |
| --- | --- | --- |
| A — observed repository | derived from the indexed repository | symbols, modules, calls, tests, capabilities |
| B — authored semantic intent | Git-versioned `.sem` declarations | goals, invariants, decisions, evidence, change contracts |
| C — reconstruction control | deterministic projection of explicit, sealed A+B inputs | coordinates, planning bundles, reconciliation reports, proof admission |

Plane C never writes back into A or B. Its planning and reconciliation adapters open the existing
SQLite index through a narrow read-only interface, load Plane B from authored files and observe Git
without accepting caller-selected refs. Missing or unsafe inputs produce a versioned blocked or
refused result, not an inferred target.

## Control freshness seal

Every successful index now captures one versioned `control_index_snapshot_v1` envelope and writes
the graph, evidence, claims and envelope in the same SQLite transaction. The envelope records the
canonical root, captured `HEAD`, Plane A facts hash (graph, claims and evidence), direct
analyzer-input manifest, full
Plane B semantic-model hash, working-diff hash, store/tool versions and capture time. `semctx setup`
creates or preserves Plane B before indexing, so the semantic model belongs to the state being
sealed.

`semctx index --json`, Plane C trace reports and migration-plan reports expose a strict
`ControlFreshnessSeal`. It binds:

- the canonical local repository `realpath`;
- `headAtCapture` and the distinct `indexedHeadCommit`;
- current and indexed Plane A facts hashes (kept in the v1 `repositoryGraphHash` fields for wire
  compatibility), covering the repository graph, claims and evidence consumed by link resolution;
- current and indexed analyzer-input hashes (parsed config plus every discovered source/test/doc/
  migration path, role and content hash, including inputs ignored by Git);
- current and indexed Plane B hashes, including source file/line provenance;
- current and indexed working-diff hashes;
- seal schema, store schema and producing application-service version.

All hashes use domain-separated SHA-256 v1 inputs and deterministic code-unit ordering. One
`--no-optional-locks` Git porcelain-v2 capture binds `HEAD`, staged object ids, tracked worktree bytes
and non-ignored untracked paths/modes/bytes without refreshing the Git index. Semctx's own mutable
SQLite files (`semctx.db` plus WAL, SHM and journal sidecars) are excluded from that working-diff
hash; the persisted envelope, graph and store schema bind their authoritative content instead. The
independent analyzer-input manifest covers ignored and `skip-worktree` inputs that Git status may
omit. Git errors fail closed instead of becoming the hash of an empty diff. Submodules and untracked
symlinks are explicitly unsupported in v1; semantic-model symlinks are rejected.

The direct analyzer manifest is the parsed Semctx config plus bytes returned by `discoverFiles`.
TypeScript can additionally consult dependency declarations or package metadata while resolving a
program; v1 binds their effect in the persisted repository-graph hash but does not enumerate every
external resolution read. This remains a declared residual boundary of the verdict. A future analyzer
snapshot/`CompilerHost` should record
those reads if dependency-resolution drift becomes an authoritative status input.

The seal is a local consistency attestation, not a signature or authenticity proof: the local SQLite
store and repository remain editable by the same user. An older index without the versioned envelope
is represented honestly by null indexed fields, never by a graph fingerprint disguised as a Git
commit.

## Explicit freshness verdict

`semctx status` and `semctx_control_status` evaluate the seal against the current read-only state:

- `FRESH`: every current/indexed pair matches and the sealed working diff is empty;
- `DIRTY_KNOWN`: every pair matches and the non-empty working diff exactly matches the sealed diff;
- `STALE`: at least one current/indexed repository, Git, graph, semantic, analyzer, schema or tool
  input differs;
- `UNSEALED`: initialization, index snapshot, Git state, store-schema evidence or the authored
  semantic model itself is absent or invalid.

The versioned status report includes canonical machine reasons, the underlying seal when available,
and `canRunHighRiskControl`. `FRESH` and `DIRTY_KNOWN` admit control operations; `STALE` and
`UNSEALED` fail closed. Trace rejects unsafe input before traversal. Plan returns a normal `BLOCKED`
report with `control_inputs_stale` or `control_inputs_unsealed` and no steps when the persisted
snapshot is structurally valid. A structurally invalid or unbound persisted snapshot is instead a
store-integrity failure: status and query envelopes remain answerable as
`UNSEALED / INDEX_SNAPSHOT_INVALID`, while trace and plan stop before traversal or planning. Status
itself never initializes, indexes or mutates the repository.

The preflight always answers with one of the four verdicts. An authored model that cannot be
projected into Plane C is a bounded verdict, not a transport error: error-severity diagnostics or
duplicate ids report `SEMANTIC_MODEL_INVALID`, and error-severity lifecycle findings report
`SEMANTIC_LIFECYCLE_INVALID`. Both are `UNSEALED` with no seal, because no seal can be built over
inputs that do not project. Other Plane C operations still refuse the projection outright — the
distinction is that refusing to act never becomes refusing to say why. A caller that received an
untyped configuration error could neither proceed nor prove it had to stop, and the same drift also
blocks `semctx index`, so the tool that names the repair must stay answerable.

## Required-altitude authority

A change's abstraction altitude decides which authority it requires. One canonical table holds the
rule so that Codex and Claude Code derive the same regime instead of each restating it:

| Required altitude | Regime | Adds over the looser regime |
| --- | --- | --- |
| L0-L1 syntax, symbols, tests, schemas | `autonomous` | — (`preflight_fresh_inputs` is the floor) |
| L2 components, boundaries | `constrained` | `bound_repository_scope` |
| L3 capabilities | `reviewed_plan` | `reviewed_refinement_plan`, `declared_rollback` |
| L4-L6 invariants, product intent, strategy | `human_authority` | `explicit_human_authority` |

Obligations accumulate: each regime is a strict superset of the looser one, so an agent that
satisfies a higher regime has already satisfied every lower one.

Autonomy is a conjunction, never an inheritance. `allowsAutonomousWrite` is true only when the
regime is `autonomous` **and** the preflight verdict admits high-risk control. A `STALE` or
`UNSEALED` preflight therefore withdraws autonomous write at every altitude, including L0 — the
policy cannot be more confident than the state it was computed from.

Naming the authority a change requires is not holding it: the report carries
`executionAuthority: "none"` like every other Plane C artifact, and no host guard becomes a sandbox
or a boundary against a hostile agent. Both `semctx control authority` and
`semctx_control_authority` return the same versioned report for the same repository state.

## Semantic coordinates

Ids are plane-qualified: `repo:<repository-node-id>` or `semantic:<semantic-node-id>`. The mapping is
closed and explicit:

| Level | Meaning | Plane A kinds | Plane B kinds |
| --- | --- | --- | --- |
| L0 | syntax | sealed observed diff hunks | unsupported |
| L1 | code entity | symbol, type, function, class, interface, enum, test, migration, document, contract, risk, external integration | unsupported |
| L2 | structural boundary | package, module, bounded context | unsupported |
| L3 | capability | capability | unsupported |
| L4 | invariant/policy | invariant | invariant |
| L5 | goal/decision | decision | goal, decision |
| L6 | system/strategy | repository | unsupported |

Assumptions, unknowns, evidence and change contracts remain support/control artifacts. They appear
under `unsupported` in the coordinate report and are not assigned a level from tags or prose.
Every coordinate build reports mapped, unsupported and unmapped inputs. L0 coordinates are
content-addressed, byte-exact `ObservedDiffHunkV1` values; a clean diff may legitimately have zero
L0 coverage.

Plane B checks and Plane C coordinate construction use one canonical repository-link resolver. Node
links resolve by graph node id, file links resolve through indexed `filePath` values, and claim or
evidence links resolve against their indexed stores without being promoted into coordinates. The
coordinate report carries the same ordered `staleLinks` and `danglingReferences` as `semantic check`;
resolved non-coordinate facts remain explicit under `unsupported` rather than being mislabeled stale.

The bounded operations are:

- `lift`: follow evidence-backed edges toward a requested higher level;
- `lower`: traverse toward a requested lower level;
- `impact`: return the bounded transitive affected set and its paths;
- `explainWhy`: find paths to authored goals, invariants or decisions, or return an explicit unknown.

All results use locale-independent code-unit ordering and are capped by depth, result, expansion and
queue budgets. Hitting any hard budget is reported as truncation.

## Pre-edit semantic planning

The pre-edit boundary keeps four concepts distinct:

| Object | Authority and lifetime |
| --- | --- |
| `TaskFrameSnapshotV1` | Versioned snapshot of task classification: raw-text digest, mode, signals and advisory profile/altitude candidates. It identifies no repository file or symbol. |
| Plane-B `ChangeContract` | Git-authored long-lived intent: statement, goals served, invariants preserved, required evidence, unknowns and optional reviewed target identity. |
| `TaskEnvelopeV1` | Immutable pre-edit join of the TaskFrame snapshot, ChangeContract hash, sealed coordinate graph, freshness/index seals, explicit resolved bindings, permitted scope, expectations and proof obligations. |
| `SemanticChangeSetV1` | Planned cross-level delta: ordered refinement steps, semantic and repository edit expectations, rollback, tests and acceptance evidence. |

`PlanningBundleV1` binds the envelope, change set and workspace baseline to one planning commit.
Every envelope, change set and bundle has `schemaVersion: 1`, a domain-separated content hash and
`executionAuthority: "none"`.

Task text may suggest mode, risk, altitude and candidate anchors. A path, symbol or coordinate
becomes authoritative only through an authored link or explicit discovery with binding evidence,
repository path, planning commit, graph seal and bounded scope. Candidate anchors remain advisory.
For additions and the new side of renames, `newPath` is exact planned intent in the ChangeSet, not a
claim that a pre-edit repository coordinate already exists. Candidate analysis binds that side only
after observing the diff.

The refinement planner selects one of five profiles: `local_patch`, `refactor`, `feature`,
`redesign` or `migration`. The migration shadow/cutover/deletion DAG remains a specialized planning
template. It is not used for ordinary changes and still grants no authority to perform a step.

## Versioned target architecture

Target artifacts live under
`.semctx/semantic/targets/<targetId>/r<revision>.target.json`, inside Plane B's Git-versioned source
of truth. Each immutable revision binds its base commit, source graph seal, elements, relations,
preserved invariants, authorship origin and artifact hash.

A proposal is `normativeStatus: "proposed"` and remains hypothetical/non-load-bearing. Review
creates the next immutable `accepted` revision only when a fresh, commit-bound canonical attestation
matches the proposal. The accepted revision preserves the proposal payload and records both the
review attestation and exact superseded artifact. Plans consume the stable
`{ targetId, revision, artifactHash }` identity. Imported targets, unreviewed proposals and
hypothetical relations may orient or diagnose; they cannot certify realization.

## Architecture comparison and migration planning

The current `ArchitectureSnapshot` is derived from the read-only coordinate graph. The Plane B
`ChangeContract` is projected into the planning input: goals served, invariants preserved, required
evidence and open unknowns remain visible. A target snapshot is an explicit input.
`compareArchitectures(current, target)` produces a deterministic delta; a supplied delta must equal the
computed delta.

Planning is fail-closed:

- no target: `BLOCKED / target_architecture_missing`;
- open Plane B unknown: `BLOCKED / open_unknowns`;
- required Plane B evidence not proven: `BLOCKED / required_evidence_unsatisfied`;
- inconsistent supplied delta: `BLOCKED / architecture_delta_inconsistent`;
- explicit current/target and consistent delta: a typed acyclic plan may be `READY`.

The migration skeleton is ordered:

`capture → characterize → introduce → shadow_compare → cutover → observe → deletion_check`.

This is a plan and admission surface, not an executor.

## Actual working-diff reconciliation

`reconcileWorkingTree` captures the current `HEAD` and worktree, parses byte-exact hunks, analyzes
the candidate repository and compares the sealed result with one `PlanningBundleV1`. A second
capture must match the first: commit drift, changed candidate bytes, stale index, mismatched seals,
unbound attestations or malformed/hashes-mismatched contracts return `REFUSED`.

When inputs are admissible, the report matches exact planned edits and checks:

- scope escapes and unplanned coordinates;
- required planned edits that are missing;
- preserved-invariant drift and undeclared lifted goal/invariant impact;
- accepted target elements that are not realized or remain unproven;
- required evidence bound to the planning commit, observed diff and semantic model;
- adjacent, evidence-bearing round trips from the exact semantic expectation to matched L0 hunks.

A round trip certifies only when every adjacent step is sealed, untruncated, evidence-bearing and
neither `llm_inferred` nor `hypothetical`. Imports, proximity, multi-level shortcuts and
LLM-only paths remain diagnostics. Non-sealed evidence and unreviewed targets never become
load-bearing.

`ReconcileDiffReportV1` has deterministic status precedence:

`REFUSED → VIOLATED → UNPROVEN → REALIZED`.

Within a status, `primaryReason` is the first code in the public canonical order: refusal codes,
then violation codes, then proof-insufficiency codes. Violations include `SCOPE_ESCAPE`,
`INVARIANT_DRIFT`, `UNDECLARED_LIFTED_IMPACT`, `MISSING_PLANNED_EDIT`,
`UNPLANNED_COORDINATE` and `TARGET_NOT_REALIZED`. Insufficient proof remains `UNPROVEN`, never a
false `REALIZED`; advisory diagnostics cannot upgrade the terminal status.

## Manual Control Handoff v2

Control Handoff v2 is an additive Plane C surface. It does not replace the legacy Plane-B
`semctx_handoff` / `semctx_resume` Handoff v1 contract or its working files.

Capture accepts one strict object:

```text
{
  schemaVersion: 2,
  planningBundle: PlanningBundleV1,
  progress:
    | { state: "not_started", currentCoordinateId }
    | { state: "step_completed", completedRefinementStepId, currentCoordinateId }
}
```

The progress object requests a current-state proof boundary; it is never an execution log. The
caller cannot provide the current abstraction level, proof-bearing progress receipts, seals, observed
commit/diff, touched coordinates, proofs, or next transition. The application service runs a fresh
actual-diff reconciliation and derives those fields from the sealed candidate analysis.

`step_completed` may name only a proof-bearing refinement step. Semctx accepts it only when that
step and every earlier proof-bearing step have their required edits, required outputs and certified
round trips, and step-specific evidence satisfied. For an edit-only step, the current focus may be
the exact sealed observed hunk SHA-256 coordinate at L0. A caller assertion is not a receipt.

A planner step with no required edit, output, or evidence is descriptive only when the planner
explicitly emits `completionEvidenceRequirementIds: []`. The capsule lists all such labels in
`descriptiveRefinementStepIds`; they never populate `completedRefinementStep`. An older empty step
without that field is `legacy_ambiguous` and fails closed.

The capsule binds the PlanningBundle, TaskEnvelope, ChangeSet, planning commit, repository identity,
reconciliation hashes, observed working-diff hash, machine-derived proof-bearing progress,
`descriptiveRefinementStepIds`, satisfied proof evaluations, and one next valid transition. That
transition selects the first later non-descriptive step: it may skip only explicitly descriptive
labels and never jumps over a proof-bearing or `legacy_ambiguous` step. The capsule fixes
`enforcementMode: "shadow"`,
`blockingEnabled: false`, `executionAuthority: "none"`, and `sourceContentCollected: false`. Its
canonical content includes no timestamp, absolute path, source bytes, host/session id, or free-form
note.

Canonical migration steps retain their per-step proof obligations. Several obligations have no
automatic derivation. Unless supplied sealed evidence satisfies them, reconciliation remains
`UNPROVEN`; Handoff v2 neither completes nor skips those steps.

Capture stores the canonical record under the ignored local directory
`.semctx/working/handoffs/v2/`, keyed by capsule hash. Resume requires that exact hash, reloads the
original request, re-runs reconciliation, rebuilds the capsule, and returns `capsule: null` when
HEAD, diff, seals, repository identity, record bytes, or rebuilt hash no longer match. It never
returns stored facts as current merely because a file exists. A repository without Semctx returns a
write-free `NO_OP`; an unready Semctx repository refuses.

Global `semctx status` freshness is not the post-edit handoff validation basis. Normal edits can
make the global seal `STALE / WORKING_DIFF_MISMATCH`; Handoff v2 instead relies on the task-bound,
double-captured reconciliation described above. `REALIZED`, `VIOLATED`, and `UNPROVEN` are all
resumable when their exact state remains valid; the capsule preserves the reconciliation result and
does not turn it into completion or execution authority.

## State and risk

Only adjacent forward transitions are legal:

`OBSERVED → MODELED → TARGET_PROPOSED → PROOFS_DEFINED → PARALLEL_IMPLEMENTATION → SHADOW_VALIDATED → CUTOVER → LEGACY_REMOVABLE → DELETED`.

Risk is independent of state:

- R0: observation;
- R1: additive change with no traffic/data switch;
- R2: reversible behavior or data-path change;
- R3: cutover or destructive action.

R2/R3 require a tested rollback. R3 requires human approval. Any L4 invariant change also requires
human approval.

Step authorization consumes an attested `ExecutionState`, not a caller-asserted list of completed ids.
Every completed step is replayed against its canonical profile and only its referenced, fresh,
commit-matching attestations. A deletion check always composes the full deletion authorization.

## Proof admission

Attestations identify their obligation, subject, epistemic status, references, commit, observation time
and expiry. The policy distinguishes `human_declared`, `statically_observed`,
`dynamically_observed`, `test_observed`, `historically_observed`, `llm_inferred` and `hypothetical`.

Human approval never proves a static or runtime fact. `llm_inferred` and `hypothetical` never authorize
a step. Historical evidence alone cannot authorize R2/R3, cutover or deletion. Destructive decisions
require fresh, commit-matching static, runtime and test evidence plus explicit approval.

Legacy deletion remains denied until replacement presence, zero static dependencies, zero runtime
dependencies, invariant preservation, accepted behavior delta, completed data migration and tested
rollback are all proven.

## Shared agent workflow contract

`AgentWorkflowContractV1` is the machine source for the Codex and Claude Code lifecycle. Its
canonical stage order covers repository inspection, semantic and freshness preflight, task
framing, scope binding, L0-L6 trace, altitude authority, optional target proposal, refinement,
authored change-contract maintenance, user-authorized implementation, actual-diff reconciliation,
composed verification and handoff. Each stage declares its MCP surfaces, observable write effect,
activation condition and whether user write scope is required.

The contract is deliberately advisory: `enforcementMode: "shadow"`, `blockingEnabled: false`,
`nonSemctxRepository: "no_op"` and `executionAuthority: "none"`. The plugin build renders this
single strict policy into both host skills. Host-specific CLI resolution remains outside the
machine contract and is generated separately.

## Shared agent lifecycle checkpoint

`AgentLifecyclePolicyV1` adds one strict, host-neutral stage-presence contract without changing
`AgentWorkflowContractV1`. Codex and Claude Code expose it through the same read-only,
MCP-only `semctx_control_agent_lifecycle` tool. Agents must invoke the tool explicitly:

1. `before_implementation_write` before the first eligible L2+ implementation write;
2. `after_repository_edits` after edits;
3. `before_completion` before a completion claim;
4. `before_compaction` before compaction or owner transfer.

Each request supplies the `implementation` or `migration` profile, `requiredAltitude`, caller-recorded
stage ids, prior touched coordinate ids, and newly observed touched coordinate ids. Pre-write L0-L1
is not applicable. Pre-write L2-L6 requires the canonical preparation stages; migration also
requires `target_propose`. Completion requires `reconcile_diff`, `verify_change`, and
`change_verify`; compaction requires `handoff`. The after-edit checkpoint has no stage-presence
requirement and folds touched coordinates.

The presence verdicts have narrow meanings:

- `NO_OP`: no stage-presence obligation applies;
- `RECORDED`: every required stage id is caller-recorded;
- `INCOMPLETE`: one or more required stage ids are missing.

The report fixes `stageOutcomesEvaluated` to `false` and `admissibility` to `not_evaluated`.
Recording a stage says nothing about its result, freshness, proof, or admissibility. A repository
without Semctx is `non_semctx` and returns a true no-op with empty output arrays. A repository with
Semctx markers but no ready index remains `semctx_unready`; it never collapses to `non_semctx`.

Touched coordinates carry `touchEvidence: "caller_observed_advisory"` and
`accumulationSemantics: "stateless_caller_reinjected_unbound"`. The caller must reinject prior ids.
Semctx persists nothing and binds the fold to no task, session, diff, commit, or handoff. The tool
is source-non-collecting: it does not collect source content or read source files to construct
coordinate ids.

Every report fixes `enforcementMode` to `shadow`, `blockingEnabled` to `false`, and
`executionAuthority` to `none`. The lifecycle checkpoint adds no automatic host lifecycle hooks,
persisted or measured telemetry, enforcement, executor, or CLI equivalent. Manual Control Handoff
v2 is a separate CLI/MCP surface; the checkpoint does not invoke it. The generated host instructions
establish shared exposure and invocation guidance, not proof that a host event ran.

## Agent transports

```text
semctx status [--json]
semctx control trace <repo:...|semantic:...> [--to 0..6] [--direction lift|lower] [--json]
semctx control plan <change-id> [--target <snapshot.json>] [--delta <delta.json>] [--json]
semctx control target-propose --input <proposal.json> [--json]
semctx control bind-scope <change-id> --task-id <task-id> [--input <bindings.json>] [--json]
semctx control plan-change <change-id> --task-id <task-id> --input <planner.json> [--json]
semctx control reconcile-diff <input.json> [--json]
semctx control handoff <input.json> [--json]
semctx control resume-handoff <capsule-hash> [--json]
```

MCP exposes the equivalent `semctx_control_status`, `semctx_control_trace`, and
`semctx_control_plan` tools, plus `semctx_control_target_propose`, `semctx_control_bind_scope`,
`semctx_control_plan_change`, `semctx_control_reconcile_diff`, `semctx_control_handoff`,
`semctx_control_resume`, and the MCP-only `semctx_control_agent_lifecycle` checkpoint. The older
`frame-task`/`semctx_control_frame_task` surfaces retain their wider framing contract and are
byte-compatible when given binding-only inputs. CLI and MCP call the same application services,
validate the same strict schemas and serialize successful results with the same canonical byte
representation.

`target-propose` is the only primitive in this set that writes Git-versioned authored state: from a
`FRESH` state it creates one new immutable, hypothetical Plane-B artifact and never overwrites a
revision. `control handoff` writes only a content-addressed ignored local record; non-Semctx is
write-free. `reconcile-diff` and exact-hash resume read the current worktree and reject
caller-selected base/head refs. None of these surfaces applies a patch, schedules a command, accepts
a target or grants execution authority.

## Public output contract

Most Plane C reports use `schemaVersion: 1`: freshness status, coordinate graph, traversal, impact,
explanation, architecture comparison, migration plan, planning bundle, reconciliation report,
transition authorization, step authorization and deletion authorization.
Trace and plan envelopes may additionally carry a `ControlFreshnessSeal` with its independent
`sealSchemaVersion: 1`. Fields may be added compatibly; a semantic break requires a new schema
version. Manual Control Handoff capture/resume and capsules use the separate strict
`schemaVersion: 2` contract.

## Non-goals

v1 does not execute commands, apply patches, mutate Git, switch traffic, migrate data, collect
runtime proof, run cutover or delete legacy code. The immutable Plane-B target proposal/review path
is bounded authoring, not execution authority. Plane C provides deterministic intent, coordinates,
plan shape, actual-diff reconciliation and fail-closed admission policy; an executor remains a
separate future milestone.
