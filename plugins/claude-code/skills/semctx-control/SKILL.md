---
name: semctx-control
description: Use semctx through its MCP tools for repository impact analysis, authored goals and invariants, proof-carrying change contracts, handoffs, and read-only fail-closed migration planning. Use for non-trivial code changes, refactors, migrations, architecture reconstruction, semantic trace requests, invariant preservation, generic project demonstrations, or pre-commit verification in a semctx-enabled repository.
---

# Semctx Control

Use the `semctx` MCP server as a proof surface, not as a replacement for repository search or runtime tests. This workflow contract is shared by the Codex and Claude Code plugins.

For every MCP call, pass `repositoryRoot` as the absolute root of the repository being analyzed. The server rejects missing or relative roots, so both hosts use the same explicit target contract even when Claude also binds `SEMCTX_ROOT`.

## Choose the lane

- **Read-only audit or explanation:** use only inspect, trace, slice, plan, verify, and resume tools. Do not create or update semantic files and do not write a handoff.
- **User-authorized implementation:** open or reuse a change contract before substantial edits, then keep its invariants, evidence, and unknowns current.
- **Migration planning:** require an explicit target architecture supplied by the user or a repository artifact. Never invent the target.
- **Generic demonstration:** identify the project's most critical functional path from repository evidence, reconstruct its contracts and invariants, then select one concrete weakness only when the available evidence supports it. If no weakness is proved, report the leading risk and the missing proof instead of inventing a change.

## Shared workflow

1. Establish the repository state with normal code search and Git inspection. Do not use `semctx_prepare_task` as code search.
2. Rehydrate existing intent with `semctx_resume`, `semctx_semantic_inspect`, or `semctx_semantic_slice` when a change id or semantic id exists. Treat anything absent from the bounded slice as unknown, not false.
3. Use `semctx_control_status` before high-risk control work. Continue only for `FRESH` or `DIRTY_KNOWN`; preserve every `STALE` or `UNSEALED` reason verbatim.
4. Use `semctx_control_trace` to connect repository and semantic coordinates across L0-L6. Keep traversal bounded and label observed, authored, inferred, and ambiguous statements honestly.
5. Record the returned freshness verdict, `freshnessSeal.sealHash`, and current/indexed input pairs. The seal is an attestation; `semctx_control_status` owns the verdict.
6. Use `semctx_control_plan` only for an explicit target architecture. Treat `BLOCKED` for unsafe inputs, a missing target, open unknowns, stale links, or insufficient proof as the correct fail-closed result.
7. On a write-scoped task, use `semctx_change_open` or `semctx_change_update` to record the goal, preserved invariants, required evidence, and unresolved unknowns before substantial edits.
8. Make the smallest coherent change. Run the runtime tests selected by the impact report; semctx never runs or replaces them.
9. After edits, call `semctx_verify_change`, record only evidence actually obtained, then call `semctx_change_verify` when a change contract exists. Resolve an unknown only after its authored node has a `proved_by` relation to evidence in a proven status. A `verified` lifecycle is derived by composed verification and cannot be asserted through a generic update.
10. Before compaction or handoff on a write-scoped task, call `semctx_handoff`. In a fresh context, call `semctx_resume` first. A read-only task must remain mutation-free.

## Verdict namespaces

- **Plane A — diff impact:** `PASS`, `WARN`, `BLOCK`. `PASS` is a static policy result, not runtime proof. `WARN` needs attention but is not a failure. `BLOCK` must be resolved or explicitly disabled by user-owned policy.
- **Plane B — change contract:** `VERIFIED`, `PARTIAL`, `BLOCKED`, `STALE`. `PARTIAL` must name every missing proof or open unknown. `STALE` requires re-linking before the model can be trusted.
- **Control freshness preflight:** `FRESH`, `DIRTY_KNOWN`, `STALE`, `UNSEALED`. Only the first two admit high-risk control work.
- **Plane C — migration plan:** `READY`, `BLOCKED`. `READY` means the plan satisfies its admission rules; it is never execution authority.

## Safety contract

- Never interpret a `READY` plan as authority to edit, cut over, deploy, or delete. Execution requires the user's write scope and normal safety checks.
- Never authorize cutover or legacy deletion from LLM-only, hypothetical, historical-only, or stale evidence.
- Never claim completion on `BLOCK`, `BLOCKED`, or `STALE`.
- Never upgrade declared evidence to obtained evidence without running or observing the corresponding check.
- Never treat a freshness seal as an authenticity signature or invent a verdict from it. Use `semctx_control_status` and preserve its reasons, nulls, and current/indexed mismatches verbatim.
- Preserve the separation of authority: repository facts are observed, semantic intent is authored, and control reports are projections over both.

## Completion report

Report the framed objective, authority sources, freshness verdict, seal hash and input mismatches, L0-L6 impact trace, initial plan verdict, files changed, runtime checks actually run, final Plane A/B/C verdicts, residual unknowns, and what semctx prevented from being changed unsafely.

## Local equivalents when MCP is unavailable

```text
semctx status --json
semctx semantic slice --change change.<slug> --format agent
semctx control trace repo:<graph-id> --direction lift --to 6 --json
semctx control plan change.<slug> --target target-architecture.json --json
semctx verify diff --base origin/main
semctx change verify change.<slug> --base origin/main
semctx semantic handoff
semctx semantic resume
```
