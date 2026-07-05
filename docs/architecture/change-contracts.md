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
verdict; `change close` marks it `verified` (or `--superseded`). The lifecycle is authored state — it
is not silently mutated by `verify` (the verdict maps to a lifecycle via `lifecycleForVerdict`, which
you can apply with `change update --status`).

## Composed verification

`change verify` **composes** `verify diff` — it never bypasses it. It reuses the exact same
`computeVerifyReport` / `buildVerifyReport` pipeline (ADR 0008) as the underlying Plane-A report,
then folds in the contract:

1. **Underlying impact** — the `VerifyReport` (impacted symbols/contracts/invariants, recommended
   tests, PASS/WARN/BLOCK), embedded verbatim under `underlying`.
2. **Preserved invariants** — for each `preserves` id, the invariant's Plane-A **footprint** (its
   linked `inv:`/`sym:` ids, expanded through `constrained_by`) is intersected with the underlying
   findings: touching it with a blocking finding → `unproven`; touched and covered → `proved`; not in
   the diff → `untouched`; declared `contradicted` → `contradicted`; not declared → `missing`.
3. **Required evidence** — each `requires_evidence` id must have a *proven* status
   (`tested`/`statically_verified`/`runtime_verified`); otherwise it is a pending proof obligation.
4. **Open unknowns** — listed; non-critical contribute PARTIAL, critical (tagged) escalate.
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
        | PARTIAL  else if any warn finding    (pending evidence, open non-critical unknown,
                                              non-critical unproven invariant on an active change)
        | VERIFIED otherwise
```

Crucially, `change verify` **never turns PARTIAL into VERIFIED on its own**. `semctx` is static; a
required proof becomes obtained only when you run the test and record the evidence node's status as
`tested`/`runtime_verified` (then resolve the unknown). The tool tracks declared/obtained state — it
does not run your tests for you.

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
semctx change update change.<slug> --resolve-unknown <unk-ids> --status <lifecycle>
semctx change verify change.<slug> --base origin/main [--format json] [--fail-on block|partial|none]
semctx change close  change.<slug> [--superseded]
```

MCP: `semctx_change_open`, `semctx_change_update`, `semctx_change_verify`, `semctx_semantic_inspect`
(changes authored via MCP carry `provenance: agent`). Exit codes: BLOCKED/STALE → 3; PARTIAL/VERIFIED
→ 0 (unless `--fail-on partial`).
