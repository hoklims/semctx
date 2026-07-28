---
name: semctx-control
description: Use semctx through its MCP tools for repository impact analysis, authored goals and invariants, proof-carrying change contracts, handoffs, bounded target proposals, and fail-closed migration planning. Use for non-trivial code changes, refactors, migrations, architecture reconstruction, semantic trace requests, invariant preservation, generic project demonstrations, or pre-commit verification in a semctx-enabled repository.
---

<!-- GENERATED leaves: edit this template only, then run `bun run plugin:build`. -->

# Semctx Control

Use the `semctx` MCP server as a proof surface, not as a replacement for repository search or runtime tests. This workflow contract is shared by the Codex and Claude Code plugins.

For every MCP call, pass `repositoryRoot` as the absolute root of the repository being analyzed. The server rejects missing or relative roots, so both hosts use the same explicit target contract even when Claude also binds `SEMCTX_ROOT`.

## Choose the lane

- **Read-only audit or explanation:** use only inspect, trace, slice, plan, verify, and resume tools. Do not create or update semantic files and do not write a handoff.
- **User-authorized implementation:** open or reuse a change contract before substantial edits, then keep its invariants, evidence, and unknowns current.
- **Migration planning:** require an explicit target architecture supplied by the user or a repository artifact. On a user-authorized write task, `semctx_control_target_propose` may create an immutable hypothetical proposal from explicit target content; never invent the target or treat a proposal as accepted.
- **Generic demonstration:** identify the project's most critical functional path from repository evidence, reconstruct its contracts and invariants, then select one concrete weakness only when the available evidence supports it. If no weakness is proved, report the leading risk and the missing proof instead of inventing a change.

## Shared workflow

The ordered lifecycle below is generated from the strict `AgentWorkflowContractV1`. Treat its
declared effects and conditions as the host-neutral policy; host-specific shell resolution appears
only in the final CLI ladder.

<!-- BEGIN shared-workflow-contract:v1 -->
Machine policy: enforcement is `shadow`, blocking is disabled, repositories
without Semctx follow `no_op`, and execution authority is
`none`.

1. **inspect_repository** — Establish the repository state with normal code search and Git inspection. Do not use Semctx as a substitute for reading the code.
   - Surface: host-local; effect: `read_only`; condition: `always`.
2. **semantic_check** — Check the semantic model and preserve its canonical reason codes. Rehydrate existing intent with semctx_resume, semctx_semantic_inspect or semctx_semantic_slice when an identity exists; absent context stays unknown.
   - Surface: `semctx_semantic_check`, `semctx_resume`, `semctx_semantic_inspect`, `semctx_semantic_slice`; effect: `read_only`; condition: `semantic_context_present`.
3. **status** — Run index health and the control preflight before governed work. Keep coverage separate from freshness, continue only for FRESH or DIRTY_KNOWN, preserve every incomplete-coverage, STALE or UNSEALED reason verbatim, and record seals and bindings as attestations rather than authority.
   - Surface: `semctx_index_health`, `semctx_control_status`; effect: `read_only`; condition: `semantic_context_present`.
4. **frame_task** — Frame the task without promoting task prose, candidates or hypotheses into normative repository scope.
   - Surface: `semctx_control_frame_task`; effect: `read_only`; condition: `write_task`.
5. **bind_scope** — Bind only explicit repository files or coordinates. Keep unresolved or advisory candidates outside the declared reconciliation scope.
   - Surface: `semctx_control_bind_scope`; effect: `read_only`; condition: `write_task`.
6. **trace_impact** — Trace bounded L0-L6 impact and label observed, authored, inferred and ambiguous statements honestly.
   - Surface: `semctx_control_trace`; effect: `read_only`; condition: `write_task`.
7. **authority** — Evaluate the required altitude and its accumulating obligations. The report describes required authority and never grants execution authority.
   - Surface: `semctx_control_authority`; effect: `read_only`; condition: `write_task`.
8. **target_propose** — When explicit user-authorized target content needs a repository artifact, create one immutable proposed revision from a FRESH state. Review and acceptance remain separate.
   - Surface: `semctx_control_target_propose`; effect: `tracked_create_only`; condition: `migration_task`.
9. **refine** — Compile the bound task into the smallest proof-bearing refinement plan with semctx_control_plan_change. Use semctx_control_plan only for an explicit target architecture, and treat every fail-closed refusal as a real planning result.
   - Surface: `semctx_control_plan_change`, `semctx_control_plan`; effect: `read_only`; condition: `write_task`.
10. **change_contract** — Open or update the authored change contract before substantial edits, recording the goal, invariants, evidence requirements and unresolved unknowns.
   - Surface: `semctx_change_open`, `semctx_change_update`; effect: `tracked_create_or_update`; condition: `write_task`.
11. **implement** — Make only the user-authorized coherent change and run the runtime tests selected by repository evidence. Semctx never executes the change or replaces those tests.
   - Surface: host-local; effect: `user_authorized_repository_write`; condition: `write_task`.
12. **reconcile_diff** — Reconcile the actual worktree diff against the sealed envelope, planned edits, target, evidence, invariant impact and round-trip requirements.
   - Surface: `semctx_control_reconcile_diff`; effect: `read_only`; condition: `after_edits`.
13. **verify_change** — Verify the observed diff and record only evidence actually obtained; never upgrade a declared check into proof.
   - Surface: `semctx_verify_change`; effect: `read_only`; condition: `after_edits`.
14. **change_verify** — Compose Plane A evidence with the change contract. Resolve an unknown only after proved_by links it to proven evidence; completion requires a derived verified lifecycle, not a caller assertion.
   - Surface: `semctx_change_verify`; effect: `read_only`; condition: `after_edits`.
15. **handoff** — Capture the bounded handoff before compaction or owner transfer. A fresh context must return through semantic_check and resume the capsule before continuing.
   - Surface: `semctx_handoff`; effect: `working_state_write`; condition: `before_handoff`.

Completion requires: `reconcile_diff` → `verify_change` → `change_verify`.
The bounded transfer stage is `handoff`.
<!-- END shared-workflow-contract -->

## Verdict namespaces

- **Plane A — diff impact:** `PASS`, `WARN`, `BLOCK`. `PASS` is a static policy result, not runtime proof. `WARN` needs attention but is not a failure. `BLOCK` must be resolved or explicitly disabled by user-owned policy.
- **Plane B — change contract:** `VERIFIED`, `PARTIAL`, `BLOCKED`, `STALE`. `PARTIAL` must name every missing proof or open unknown. `STALE` requires re-linking before the model can be trusted.
- **Control freshness preflight:** `FRESH`, `DIRTY_KNOWN`, `STALE`, `UNSEALED`. Only the first two admit high-risk control work.
- **Plane A index coverage:** `complete`, `partial`, `insufficient`. Use `semctx_index_health` before relying on negative evidence; its coverage verdict never replaces or upgrades the separately reported freshness verdict.
- **Plane C — migration plan:** `READY`, `BLOCKED`. `READY` means the plan satisfies its admission rules; it is never execution authority.

## Safety contract

- Never interpret a `READY` plan as authority to edit, cut over, deploy, or delete. Execution requires the user's write scope and normal safety checks.
- Never authorize cutover or legacy deletion from LLM-only, hypothetical, historical-only, or stale evidence.
- Never claim completion on `BLOCK`, `BLOCKED`, or `STALE`.
- Never upgrade declared evidence to obtained evidence without running or observing the corresponding check.
- Never treat a freshness seal as an authenticity signature or invent a verdict from it. Use `semctx_control_status` and preserve its reasons, nulls, and current/indexed mismatches verbatim.
- Never collapse index freshness and analysis coverage into one health claim. Preserve the `semctx_index_health` binding, freshness, coverage, workspace diagnostics, outcome counts, and reasons as separate report fields.
- Preserve the separation of authority: repository facts are observed, semantic intent is authored, and control reports are projections over both.

## Completion report

Report the framed objective, authority sources, freshness verdict, seal hash and input mismatches, L0-L6 impact trace, initial plan verdict, files changed, runtime checks actually run, final Plane A/B/C verdicts, residual unknowns, and what semctx prevented from being changed unsafely.

## Local equivalents when MCP is unavailable

Run `semctx index-health --json` for the same index-health report before using the host-specific fallback ladder below.

<!-- BEGIN host-cli-ladder:semctx-control -->
Prefer MCP tools when they are connected. For shell fallbacks, use a global `semctx` on
PATH (`bun install -g semctx@latest` / `bunx semctx@latest`) — keep it on the **same version** as the plugin
(`semctx --version` should match the marketplace plugin version).

This host does **not** substitute a plugin-root path into skill content, and the agent's shell cwd
is the user's repository (not the plugin package root), so the bundled `dist/semctx.js` is not
addressable via a relative path such as `bun ./dist/semctx.js` or a placeholder. The plugin still
ships the CLI next to the MCP runtime for lockstep releases and for humans who know the absolute
path.

If `semctx` is not available, say so and continue with MCP-only or ask the user to install the CLI
— do not invent results.

```text
# Global / CI CLI — same subcommands as the plugin MCP tools
semctx --version
semctx status --json
semctx semantic check --json
semctx verify diff --base origin/main
```
<!-- END host-cli-ladder -->
