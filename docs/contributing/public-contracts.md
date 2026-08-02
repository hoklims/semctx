# Public-contract contributor guide

This guide is the maintainer-owned change contract for semctx. It defines how contributors
classify and prove changes; feature-specific behavior remains in accepted ADRs and machine-owned
sources.

## Change tiers

Classify a change by its highest applicable tier:

| Tier | Scope | Required treatment |
| --- | --- | --- |
| `ROUTINE` | Demonstrably behavior- and contract-preserving maintenance, such as a refactor, private test cleanup, generated refresh from an unchanged machine source, or mechanical metadata update. This may touch a governed file when its public semantics provably do not change. | State why the change is contract-preserving, provide targeted regression or parity evidence, and run the pre-PR gate. |
| `DOMAIN` | Changes application behavior, evidence, authority, policy, or report construction without changing a governed public surface. | State the domain rule, keep pure reusable evaluation in the appropriate engine, coordinate the use case in `app-services`, and add behavioral tests. |
| `GOVERNED` | Adds, removes, or changes a governed public surface, its compatibility promise, packaging, or delivery enforcement. | Accepted design before code, explicit compatibility and migration treatment, contract-focused tests, regenerated artifacts, and the pre-PR gate. |

When uncertain, use the higher tier. A maintainer may reclassify a PR as review reveals its actual
surface.

## Authority and ownership

For contributor decisions, authority is resolved in this order:

1. An accepted ADR.
2. The machine source of truth (machine SSOT) that implements or generates the contract.
3. This guide.

If these disagree, do not silently choose the convenient interpretation. Align the lower
authority with the higher one, or propose a new ADR when the accepted decision must change.

For every new flow, and every existing flow that is materially modified, pure reusable domain
evaluation belongs in the appropriate engine, including `control-engine` or `context-engine`
where applicable. `packages/app-services` owns use-case coordination and construction of complete
transport-facing reports. CLI and MCP handlers validate transport inputs, call the shared
application service, and project its result without recreating policy, authority, status
aggregation, or report semantics. Analyzers, stores, and engines retain their existing package
responsibilities.

This is a forward constraint, not a claim that every historical path is already compliant.
`apps/cli/src/commands/context.ts` and `packages/mcp-server/src/tools.ts` still coordinate parts of
context preparation directly. They are explicit maintainer-owned architecture debt. Contributors
must not migrate those paths as collateral work for an unrelated PR. A PR that materially changes
one of those flows must either move the affected coordination behind `app-services` or follow a
maintainer-approved, bounded migration plan. The cross-transport migration is tracked in
[issue #77](https://github.com/hoklims/semctx/issues/77).

## Governed public surfaces

The following are governed public surfaces. A change to their behavior, contract, compatibility
promise, packaging semantics, or enforcement is `GOVERNED` even when the diff is small. A
demonstrably mechanical, contract-preserving update can remain `ROUTINE`; file location alone does
not raise the tier.

- MCP tool input and output schemas, error and success envelopes, declared effects, and
  repository-root policy.
- Versioned CLI JSON, including schema identity, field meaning, omission rules, and exit/status
  semantics consumed by automation.
- The agent workflow and its machine-owned generated instructions or handoff contracts.
- Plugin manifests, packaging, generated runtimes, public filenames, host launch contracts, and
  Claude Code/Codex parity.
- CI and release gates, artifact composition, publication inputs, and compatibility checks.

This list names surfaces, not their feature rules. Follow the accepted ADR and machine source of
truth for the current contract.

## Design before code

Before implementing a `GOVERNED` change, obtain an accepted ADR or an accepted update to the ADR
that owns the surface. The design must identify:

- the problem, intended contract, and machine source of truth;
- compatibility impact, consumers, versioning, migration, and rollback or rejection behavior;
- authority and failure boundaries, including what must remain unknown or fail closed;
- generated artifacts and parity obligations;
- the test evidence that will prove the change.

Do not make an incompatible behavior appear additive by retaining a field name or schema version.
When old and new consumers must coexist, specify the transition, deprecation window, and removal
gate. If compatibility is intentionally broken, version the contract and document the migration.

## Implementation and evidence

Use the narrowest test set that proves the applicable contract, then run `bun run verify:pr`.
Before running it, stage every intended new file. The gate refuses any remaining non-ignored
untracked file because an omitted file cannot be included in diff hygiene or PR evidence.
Depending on the surface, evidence includes:

- positive behavior plus negative and incomplete-input cases;
- adversarial cases for authority, root boundaries, malformed output, stale state, and failure
  isolation;
- CLI/MCP parity from the same `app-services` result;
- plugin source, generated-runtime, manifest, filename, and cross-host byte parity;
- a real child-process or host negotiation test when process lifecycle or protocol behavior is
  part of the claim;
- deterministic regeneration followed by a clean generated-artifact check.

Never hand-edit a generated artifact when a generator owns it. Change the source, run the
repository generator, commit all resulting artifacts, and run the corresponding check mode.

In the PR description, report every applicable item above with the command and observed result.
Use `N/A — <reason>` when an item truly does not apply; a blank entry or unexplained `N/A` is not
evidence. `bun run verify:pr` is the sole documented pre-PR gate, but it does not replace
surface-specific evidence or live release verification.
