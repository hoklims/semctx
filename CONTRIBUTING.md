# Contributing to semctx

Thanks for your interest. semctx is a local-first, deterministic tool; contributions must
preserve those properties.

## Development setup

```bash
bun install
bun run build   # tsc typecheck (strict, noUncheckedIndexedAccess, verbatimModuleSyntax)
bun test        # bun:test across packages + apps
```

Run the demo end-to-end:

```bash
cd examples/sample-typescript-repo
bun ../../apps/cli/src/index.ts init
bun ../../apps/cli/src/index.ts index
bun ../../apps/cli/src/index.ts task create --from-file tasks/overbooking-bug.md
bun ../../apps/cli/src/index.ts context prepare <task-id>
bun ../../apps/cli/src/index.ts bench
```

## Ground rules

- **Determinism is a hard invariant.** Any output must be a pure function of repository
  state plus the injected clock. No `Math.random`, no ambient `Date` in the pipeline, and
  sort every collection that flows into an output. The benchmark's `determinism` metric
  and `pack.test.ts` will catch regressions.
- **Every conclusion points to evidence.** New nodes/claims must carry `EvidenceRef`s.
- **No marketing vocabulary.** Do not call something "verified" that is only inferred, or
  "exact" that is heuristic. Label heuristics as heuristics.
- **Respect the layering.** `ts-analyzer` parses, `repository-store` persists,
  `context-engine` ranks, CLI/MCP are thin transports. `core` depends on nothing but Zod.
- **Add a test with behaviour, not just a snapshot.** For a new detector or gate, add a
  case (and ideally a `semctx-bench.json` golden expectation) that would fail before your
  change and passes after.

## Commit / PR conventions

- Work on a branch. Small, cohesive commits with explicit messages.
- Do not commit if `bun test` or `bun run build` fails.
- Update the relevant docs in the same PR.

## Adding a semantic marker or authority policy

- Markers: extend `packages/ts-analyzer/src/markers.ts` (+ the analyzer wiring) and add a
  fixture that exercises it.
- Authority: add a row to `AUTHORITY_POLICIES` and a question-classification rule; the
  ranker does not need to change.
