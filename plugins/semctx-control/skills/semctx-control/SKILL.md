---
name: semctx-control
description: Use semctx through its MCP tools for repository impact analysis, authored goals and invariants, proof-carrying change contracts, handoffs, and read-only fail-closed migration planning. Use for non-trivial code changes, refactors, migrations, architecture reconstruction, semantic trace requests, invariant preservation, or pre-commit verification in a semctx-enabled repository.
---

# Semctx Control

Use the `semctx` MCP server as a proof surface, not as a replacement for repository search or runtime tests.

## Choose the lane

- For a read-only audit or explanation, use only inspect, trace, slice, plan, verify, and resume tools. Do not create or update semantic files.
- For a user-authorized implementation, open or reuse a change contract before substantial edits, then keep its invariants, evidence, and unknowns current.
- For a migration plan, require an explicit target architecture supplied by the user or a repository artifact. Never invent the target.

## Workflow

1. Establish the repository state with normal code search and Git inspection. Do not use `semctx_prepare_task` as code search.
2. Rehydrate existing intent with `semctx_resume`, `semctx_semantic_inspect`, or `semctx_semantic_slice` when a change id or semantic id exists.
3. Use `semctx_control_trace` to connect repository or semantic coordinates across L0-L6. Keep traversal bounded.
4. Use `semctx_control_plan` for migrations. Treat `BLOCKED` without a target, open unknowns, or insufficient proofs as the correct fail-closed result.
5. On a write-scoped task, use `semctx_change_open` or `semctx_change_update` to record the goal, preserved invariants, required evidence, and unresolved unknowns.
6. After edits, call `semctx_verify_change`, run the selected runtime tests, record only evidence actually obtained, then call `semctx_change_verify` when a change contract exists.
7. Before compaction or handoff, call `semctx_handoff`; in a fresh context, call `semctx_resume` first.

## Safety contract

- Never interpret a `READY` plan as execution authority. Plane C is read-only and has no executor.
- Never authorize cutover or legacy deletion from LLM-only evidence.
- Never claim completion on `BLOCK`, `BLOCKED`, or `STALE`. Report `PARTIAL` as partial and name the missing proof.
- Never upgrade declared evidence to obtained evidence without running or observing the corresponding check.
- Preserve the separation of authority: repository facts are observed, semantic intent is authored, and control reports are projections over both.
