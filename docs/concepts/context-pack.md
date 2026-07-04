# ContextPack

The **ContextPack** is the compiled output for a code agent: minimal, structured, and
entirely justified. It is a pure function of the repository graph + the TaskFrame (plus
an injected timestamp).

## Contents

- `taskFrame` — the structured task.
- `hardConstraints` — eligible invariant claims (non-negotiable).
- `authoritativeClaims` — the top eligible non-invariant claims, ranked.
- `primaryNodes` / `secondaryNodes` — the code to read first vs. supporting context.
- `impactPaths` — call paths from the task entrypoints (e.g. the confirmation path).
- `relevantTests` — tests covering the primary symbols.
- `contradictions` — deprecated/contradicted claims, shown as **non-normative**.
- `unknowns` — what could not be verified (e.g. a concurrency race that static analysis
  cannot prove; an invariant that is only inferred).
- `recommendedReads` — a prioritised reading list, each with a `reason` and `evidenceIds`.
- `verificationPlan` — run tests / static-check invariants / reproduce, with target nodes.
- `evidence` — every `EvidenceRef` (file + line + source kind) referenced anywhere.
- `priorityExplanations` — the full ranking rationale for every claim, eligible or not.
- `meta` — question kind, `deterministic`, generator, `candidateProviders`, warnings.

## Provenance guarantee

Every `recommendedRead` resolves to `evidenceIds`, and every evidence id resolves to a
concrete file + line + source kind in `evidence`. There is no assertion in the pack that
cannot be traced to a checkable source. Example reason, verbatim from the fixture:

```
src/domain/confirmation.ts
priority: critical
reason: implements capability "reservation-confirmation"; constrained by invariant
        "confirmed-never-exceeds-capacity"; covered by 1 test(s); on the confirmation call path
```

## Determinism

`generatedAt` (pack) and `taskFrame.createdAt` are the only non-deterministic values,
both injected via a clock. Strip them and two builds over identical repo state are
byte-identical — this is checked by the benchmark's `determinism` metric and by
`pack.test.ts`.

## Output

`semctx context prepare <task-id>` writes `<task>.json` and `<task>.md` under
`.semctx/context-packs/` (filenames are sanitised for cross-platform safety) and prints a
readable console view. `--json` emits the full pack to stdout.
