# Semantic model (Plane B)

The authored domain model — the contract for `@semantic-context/semantic-model` and the `.sem` DSL.
It is deliberately small, deterministic and parseable. See the ADR
[`0009`](../adr/0009-semantic-layer-is-separate-from-the-repository-graph.md) for why it is a
separate plane from the repository graph.

## Node kinds and statuses

```ts
type SemanticNodeKind   = "goal" | "invariant" | "decision" | "assumption" | "unknown" | "change" | "evidence";
type SemanticStatus     = "declared" | "proposed" | "assumed" | "tested" | "statically_verified" | "runtime_verified" | "contradicted" | "stale";
type SemanticProvenance = "author" | "agent" | "derived";
type SemanticRelationKind = "implements" | "preserves" | "serves" | "justifies" | "depends_on" | "requires_evidence" | "proved_by" | "risks" | "contradicts" | "supersedes";
type ChangeLifecycle    = "draft" | "active" | "verified" | "partial" | "blocked" | "stale" | "superseded";
```

`SemanticStatus` keeps proof, assumption and unverified distinct — `PROVEN_STATUSES` is exactly
`{ tested, statically_verified, runtime_verified }`. Nothing upgrades a status silently.

## Types

```ts
interface RepositoryLink { kind: "symbol"|"file"|"claim"|"invariant"|"contract"|"capability"|"test"|"migration"|"evidence"; ref: string; }
interface SourceRef      { file: string; line: number; }            // where the block was authored
interface SemanticRelation { kind: SemanticRelationKind; to: string; } // to = a semantic id
interface ChangeTargetBindingV1 {
  schemaVersion: 1; targetId: string; revision: number; artifactHash: `sha256:${string}`;
}

interface SemanticNode {          // the six truth kinds (change uses ChangeContract)
  id: string; kind: SemanticNodeKind; statement: string;
  status: SemanticStatus; provenance: SemanticProvenance;
  sourceRefs: SourceRef[]; repositoryLinks: RepositoryLink[]; relations: SemanticRelation[];
  tags: string[]; metadata?: Record<string, string>; appliesAtLevel?: 1|2|3|4|5|6;
}

interface ChangeContract {        // kind "change": proof-carrying
  id: string; statement: string; lifecycle: ChangeLifecycle; provenance: SemanticProvenance;
  sourceRefs: SourceRef[];
  serves: string[]; preserves: string[]; requiresEvidence: string[]; openUnknowns: string[];
  repositoryLinks: RepositoryLink[]; tags: string[]; metadata?: Record<string, string>;
  appliesAtLevel?: 1|2|3|4|5|6; targetBinding?: ChangeTargetBindingV1;
}

interface SemanticModel {
  nodes: SemanticNode[];
  changes: ChangeContract[];
  refinementRelations?: RefinementRelationV1[];
}
```

`kind` and `appliesAtLevel` are independent. Missing legacy levels remain missing and
non-certifying; neither kind nor repository placement supplies a fallback. Authored nodes use
L6 strategy, L5 product intent, L4 invariants/policies, L3 capabilities, L2
components/boundaries and L1 symbols/tests/schemas/contracts. L0 is not an authored semantic node:
it is an immutable Plane-A `ObservedDiffHunkV1`.

`RefinementRelationV1` is the read-only cross-plane overlay. Its kind is one of
`decomposes_to`, `realizes`, `implements`, `constrained_by` or `proved_by`; both endpoints are
tagged as a Plane-B semantic node or Plane-A observed-hunk digest. Every relation carries an exact
epistemic status, `author|agent|derived` provenance and non-empty evidence references.
`constrained_by` and `proved_by` decorate traversal reports, while only adjacent admissible
refinement steps can certify level coverage. LLM-only and multi-level relations are advisory.

`ChangeTargetBindingV1` is the immutable identity of a Git-authored target revision. It does not
embed mutable target JSON and does not grant execution authority. The referenced artifact must
match `targetId`, positive `revision` and `artifactHash`; only a reviewed `accepted` revision can
be load-bearing during planning and reconciliation.

## Task, change and target boundaries

The authored semantic model owns durable intent, not task classification or observed repository
state:

| Contract | Plane | Responsibility |
| --- | --- | --- |
| `TaskFrameSnapshotV1` | task/application input | Versioned classification snapshot. Text-derived mode, risk signals, profile and altitude remain advisory. |
| `ChangeContract` | B | Authored goal/invariant/evidence obligations and optional accepted target identity. |
| `TaskEnvelopeV1` | C | Pre-edit join of the TaskFrame snapshot, ChangeContract hash, sealed Plane-A graph and explicit resolved scope. |
| `SemanticChangeSetV1` | C | Ordered planned semantic/repository delta, rollback and acceptance evidence. |

A `RepositoryLink` or explicit discovery can establish a pre-edit repository binding. Raw task
text, names, imports and proximity cannot. For a planned addition or rename destination,
`newPath` is an exact repository-relative intent in the ChangeSet, not a fabricated pre-edit
coordinate.

Target architecture artifacts live at
`.semctx/semantic/targets/<targetId>/r<revision>.target.json`. A `proposed` artifact is immutable,
Git-versioned and hypothetical/non-normative. Review creates the next `accepted` revision, records
the canonical attestation and superseded artifact identity, and preserves the proposal's
canonical architecture payload under its domain-separated hash.

## Ids

A semantic id is the authored, already-namespaced label. Its prefix must match its kind:

| kind | id prefix | example |
| --- | --- | --- |
| goal | `goal.` | `goal.checkout.reliable-payment` |
| invariant | `invariant.` | `invariant.payment.idempotent` |
| decision | `decision.` | `decision.single-writer` |
| assumption | `assumption.` | `assumption.stripe-retries-are-safe` |
| unknown | `unknown.` | `unknown.cancellation-race` |
| change | `change.` | `change.stripe-webhook-retry` |
| evidence | `evidence.` / `proof.` | `proof.test.webhook-duplicate-event` |

`semanticId(kind, label)` builds/normalises an id (idempotent, dots preserved, reuses `core.slugify`);
`kindOfSemanticId(id)` infers the kind from the prefix (`proof.` → `evidence`); `isValidSemanticId`
checks prefix↔kind agreement. A `RepositoryLink` infers its `kind` from the `ref` prefix
(`sym:`→symbol, `inv:`→invariant, `contract:`, `cap:`, `test:`, `mig:`, `claim:`, `ev:`; anything
else or `file:<path>` → a file link).

## DSL grammar (`.sem`)

One block per node: an unindented `<kind> <id>` header, then 2-space-indented fields.

```
goal goal.checkout.reliable-payment
  statement: A payment event must be applied at most once.
  status: declared
  provenance: author
  tag: checkout

invariant invariant.payment.idempotent
  rule: retry(event) is equivalent to apply_once(event)   # `rule` is a synonym of `statement`
  link: inv:confirmed-never-exceeds-capacity              # a repository link (kind inferred)
  serves: goal.checkout.reliable-payment                  # a relation
  tag: critical

change change.stripe-webhook-retry
  statement: Make the Stripe webhook retry-safe.
  status: active                                          # lifecycle, for a change
  serves: [goal.checkout.reliable-payment]                # inline list form
  preserves:
    - invariant.payment.idempotent                        # block-list form
  requires: proof.test.webhook-duplicate-event            # `requires` = requires_evidence
  unknown: unknown.cancellation-race                      # open unknown (change only)
```

- **Scalars**: `statement` (`rule` synonym on invariants), `status`, `provenance`,
  `appliesAtLevel` (authored L1 through L6).
- **Relations** (each maps to a `SemanticRelationKind`): `serves`, `preserves`, `implements`,
  `depends_on`, `justifies`, `requires_evidence` (`requires` synonym), `proved_by`, `risks`,
  `contradicts`, `supersedes`. Change-only: `unknown`.
- **Multi-value**, all unambiguous: repeated `key: v`, inline `key: [a, b]`, or a bare `key:` with
  `  - item` lines under it.
- `link:` / `file:` → a `RepositoryLink`; `tag:` → a tag; `meta: k=v` → string metadata.
- Comments start with `#`. Lines are ASCII; tabs draw a warning.

The **parser is tolerant** (never throws; returns `{ model, diagnostics }` with file/line/column).
The **formatter is deterministic and idempotent**: canonical field order, repeated-key multi-value
form, relation targets sorted by code unit. Renderers (`symbols` / `ascii`) are views only.

Typed refinement relation blocks use a separate ASCII-canonical grammar with fixed field order:
relation header and tagged source, tagged target, epistemic status, provenance, one or more
evidence references, then `end`. Duplicate/out-of-order fields, unknown values, malformed digests,
untagged endpoints and Unicode tokens produce stable diagnostics rather than inferred meaning.

## Storage

`.semctx/semantic/{goals,invariants,decisions,assumptions,unknowns,evidence}.sem` and
`.semctx/semantic/changes/<id>.sem`, plus immutable target revisions under
`.semctx/semantic/targets/`, are **Git-versioned truth**. `.semctx/working/**` (active change,
handoff) is local scratch. `semctx semantic init` scaffolds comments and inert placeholders only;
no `goal.example.*`, invariant, decision, unknown or target becomes active without an explicit
authored declaration. The empty model is therefore honest and `semctx semantic check` is green out
of the box.
