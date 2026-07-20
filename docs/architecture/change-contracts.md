# Change contracts & composed verification

A **change contract** is a proof-carrying declaration opened before or during a modification. It
answers: *what goal does this change serve, which invariants must it preserve, which symbols/files/
claims does it touch, which proofs are required, which unknowns stay open, and what is its status?*

## Lifecycle

```
draft → active → verified
                → partial
                → blocked
                → stale
                → superseded
```

`change open` creates it (default `active`; `--draft` to stage). `change verify` computes a composite
verdict without mutating the contract. `change close` derives `verified` only after running a fresh
composed verification that returns `VERIFIED` (or records `--superseded` without making a proof
claim). Generic `change update --status` cannot assert `verified`.

## Composed verification

`change verify` **composes** `verify diff` — it never bypasses it. It reuses the exact same
`computeVerifyReport` / `buildVerifyReport` pipeline (ADR 0008) as the underlying Plane-A report,
then folds in the contract:

1. **Underlying impact** — the `VerifyReport` (impacted symbols/contracts/invariants, recommended
   tests, PASS/WARN/BLOCK), embedded verbatim under `underlying`. An underlying **BLOCK** contributes
   a `block` finding; an underlying **WARN** contributes a `warn` finding — so the composite can
   never be more optimistic than the impact analysis it composes (a WARN floors it at PARTIAL).
2. **Preserved invariants** — for each `preserves` id, the invariant's Plane-A **footprint** (its
   linked `inv:`/`sym:` ids, expanded through `constrained_by`) is intersected with the underlying
   findings: touched with a blocking **or advisory** finding (i.e. changed without a covering test,
   regardless of the repo's rule tier) → `unproven`; touched with no finding on it (covered) →
   `proved`; not in the diff → `untouched`; declared `contradicted` → `contradicted`; not declared →
   `missing`. A `critical`-tagged invariant that is `unproven` is BLOCK-worthy **even when the repo
   relaxed its rule to warn** — the semantic layer asserts its own criticality.
3. **Required evidence** — each `requires_evidence` id must have a *proven* status
   (`tested`/`statically_verified`/`runtime_verified`); otherwise it is a pending proof obligation.
4. **Open unknowns** — listed; non-critical contribute PARTIAL, critical (tagged) escalate. An
   unknown can be resolved only after its authored node has a `proved_by` relation to evidence in a
   proven status.
5. **Stale / dangling** — a repository link on the change or a referenced node that no longer
   resolves, or a `preserves`/`requires` id that is not declared.
6. **Superseded decisions** — a decision that `justifies` a preserved invariant and is superseded or
   contradicted.

Each contribution is a typed `SemanticFinding` with severity `block | warn | stale`. The verdict is
derived from the findings with fixed precedence, and is **never more optimistic than the data**:

```
verdict = BLOCKED  if any block finding      (underlying BLOCK, critical unproven invariant,
                                              contradicted invariant, critical open unknown,
                                              or a superseded decision when policy = block)
        | STALE    else if any stale finding  (a link no longer resolves; a ref is not declared)
        | PARTIAL  else if any warn finding    (underlying WARN, pending evidence, open non-critical
                                              unknown, non-critical unproven invariant)
        | VERIFIED otherwise
```

Crucially, `change verify` **never turns PARTIAL into VERIFIED on its own**. `semctx` is static; a
required proof becomes obtained only when you run the test and record the evidence node's status as
`tested`/`runtime_verified`. To resolve an unknown, its node must also declare `proved_by` to that
proven evidence. The tool tracks declared/obtained state — it does not run your tests for you.

This remains a cooperative trust boundary: versioned `.semctx/semantic/*.sem` files can be edited
directly. CLI and MCP mutations enforce the proof gates, but semctx does not provide cryptographic
attestation or prevent a repository author from forging authored state.

## Example verdict (text)

```
Δ change.stripe-webhook-retry  [active]
  underlying verify diff: PASS

preserved
  □ invariant.payment.idempotent [untouched]

proved
  (none)

partial
  ? unknown.cancellation-race

verdict: PARTIAL
WARN unproven / open: unknown.cancellation-race
```

After running the webhook test, marking `proof.test.webhook-duplicate-event` `tested`, and resolving
`unknown.cancellation-race`, the same command returns `VERIFIED`.

## Policy (`.semctx/config.json` → `semantic`)

```jsonc
"semantic": {
  "enabled": true,
  "criticalInvariantTags": ["critical", "security"],  // unproven → BLOCKED, not PARTIAL
  "openUnknownSeverity": "warn",                       // warn → PARTIAL; block → BLOCKED
  "supersededDecisionSeverity": "warn",
  "requireProofForActiveChange": true                  // active change preserving an invariant owes proof
}
```

Absent block → defaults above. The composed report (`ChangeVerifyReport`) is versioned
(`schemaVersion 1`).

## CLI & MCP

```
semctx change open   change.<slug> --preserves <inv-ids> --requires <ev-ids> --unknown <unk-ids>
semctx change update change.<slug> --resolve-unknown <unk-ids> --status <non-verified-lifecycle>
semctx change verify change.<slug> --base origin/main [--format json] [--fail-on block|partial|none]
semctx change close  change.<slug> [--superseded]
```

MCP: `semctx_change_open`, `semctx_change_update`, `semctx_change_verify`, `semctx_change_close`,
`semctx_semantic_inspect` (changes authored via MCP carry `provenance: agent`). Exit codes:
BLOCKED/STALE → 3; PARTIAL/VERIFIED → 0 (unless `--fail-on partial`).
