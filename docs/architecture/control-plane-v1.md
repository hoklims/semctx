# Semantic Reconstruction Control Plane v1

> Status: read-only MVP. Plane C coordinates and evaluates a migration; it does not execute one.

## Boundary

Semctx keeps three kinds of truth separate:

| Plane | Authority | Examples |
| --- | --- | --- |
| A — observed repository | derived from the indexed repository | symbols, modules, calls, tests, capabilities |
| B — authored semantic intent | Git-versioned `.sem` declarations | goals, invariants, decisions, evidence, change contracts |
| C — reconstruction control | deterministic projection of explicit A+B inputs | coordinates, architecture deltas, migration plans, proof admission |

Plane C never writes back into A or B. Its CLI and MCP adapters open the existing SQLite index through
a narrow read-only interface and load Plane B from its authored files. Missing inputs produce a
versioned `BLOCKED` report, not an inferred target.

## Control freshness seal

Every successful index now captures one versioned `control_index_snapshot_v1` envelope and writes
the graph, evidence, claims and envelope in the same SQLite transaction. The envelope records the
canonical root, captured `HEAD`, Plane A repository-graph hash, direct analyzer-input manifest, full
Plane B semantic-model hash, working-diff hash, store/tool versions and capture time. `semctx setup`
creates or preserves Plane B before indexing, so the semantic model belongs to the state being
sealed.

`semctx index --json`, Plane C trace reports and migration-plan reports expose a strict
`ControlFreshnessSeal`. It binds:

- the canonical local repository `realpath`;
- `headAtCapture` and the distinct `indexedHeadCommit`;
- current and indexed Plane A graph hashes;
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
external resolution read. This is a declared residual boundary, another reason the seal alone must
not be promoted to a freshness verdict. A future analyzer snapshot/`CompilerHost` should record
those reads if dependency-resolution drift becomes an authoritative status input.

The seal is a local consistency attestation, not a signature or authenticity proof: the local SQLite
store and repository remain editable by the same user. It deliberately contains no `FRESH`,
`DIRTY_KNOWN`, `STALE` or `UNSEALED` verdict. Null or unequal current/indexed fields remain evidence
for the next roadmap item to evaluate; callers must not invent that decision. An older index without
the versioned envelope is represented honestly by null indexed fields and an `unsealed` planning
commit, never by a graph fingerprint disguised as a Git commit.

## Semantic coordinates

Ids are plane-qualified: `repo:<repository-node-id>` or `semantic:<semantic-node-id>`. The mapping is
closed and explicit:

| Level | Meaning | Plane A kinds | Plane B kinds |
| --- | --- | --- | --- |
| L0 | syntax | unsupported in v1 | unsupported |
| L1 | code entity | symbol, type, function, class, interface, enum, test, migration, document, contract, risk, external integration | unsupported |
| L2 | structural boundary | package, module, bounded context | unsupported |
| L3 | capability | capability | unsupported |
| L4 | invariant/policy | invariant | invariant |
| L5 | goal/decision | decision | goal, decision |
| L6 | system/strategy | repository | unsupported |

Assumptions, unknowns, evidence and change contracts remain support/control artifacts. They appear under
`unsupported` in the coordinate report and are not assigned a level from tags or prose. Every coordinate build reports mapped,
unsupported and unmapped inputs; L0 may legitimately have zero coverage.

The bounded operations are:

- `lift`: follow evidence-backed edges toward a requested higher level;
- `lower`: traverse toward a requested lower level;
- `impact`: return the bounded transitive affected set and its paths;
- `explainWhy`: find paths to authored goals, invariants or decisions, or return an explicit unknown.

All results use locale-independent code-unit ordering and are capped by depth, result, expansion and
queue budgets. Hitting any hard budget is reported as truncation.

## Architecture comparison and planning

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

## Read-only transports

```text
semctx control trace <repo:...|semantic:...> [--to 0..6] [--direction lift|lower] [--json]
semctx control plan <change-id> [--target <snapshot.json>] [--delta <delta.json>] [--json]
```

MCP exposes the equivalent `semctx_control_trace` and `semctx_control_plan` tools. Opening either
surface must not create `.semctx`, initialize a schema, change metadata, or create SQLite WAL/SHM files.

## Public output contract

Plane C reports use `schemaVersion: 1`: coordinate graph, traversal, impact, explanation, architecture
comparison, migration plan, transition authorization, step authorization and deletion authorization.
Trace and plan envelopes may additionally carry a `ControlFreshnessSeal` with its independent
`sealSchemaVersion: 1`. Fields may be added compatibly; a semantic break requires a new schema
version.

## Non-goals

v1 does not execute commands, mutate Git or files, switch traffic, migrate data, collect runtime proof,
or delete legacy code. It provides the deterministic coordinates, plan shape and fail-closed admission
policy required to build and shadow-test those capabilities later.
