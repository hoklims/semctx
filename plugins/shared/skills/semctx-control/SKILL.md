---
name: semctx-control
description: Use semctx through its MCP tools for top-down root-cause diagnosis, repository impact analysis, authored goals and invariants, proof-carrying change contracts, handoffs, bounded target proposals, and fail-closed migration planning. Use for non-trivial code changes, refactors, migrations, architecture reconstruction, semantic trace requests, invariant preservation, generic project demonstrations, or pre-commit verification in a semctx-enabled repository.
---

<!-- GENERATED leaves: edit this template only, then run `bun run plugin:build`. -->

# Semctx Control

Use the `semctx` MCP server as a proof surface, not as a replacement for repository search or runtime tests. This workflow contract is shared by the Codex and Claude Code plugins.

For every MCP call, pass `repositoryRoot` as the absolute root of the repository being analyzed. The server rejects missing or relative roots, so hosts use the same explicit target contract even when Claude also binds `SEMCTX_ROOT`. An unexpanded `${CLAUDE_PROJECT_DIR}` process env is treated as unset (pin-on-first-request), not as a bound root.

**One exception:** `semctx_control_verify_authorization` takes **no** `repositoryRoot` and rejects the field if supplied. Its entire input is `{ request }` — a `ChangeAuthorizationCapsuleV1` to verify, an externally sourced `expectedAuthorityDescriptorDigest`, and `verifiedAt` (the same instant as, or later than, the capsule's `evaluatedAt`) — because it never reads a target repository; it verifies a sealed capsule offline.

## Choose the lane

- **Read-only audit, diagnosis, or explanation:** use only read-only surfaces. After repository evidence establishes that Semctx context exists, semantic check and status are allowed alongside inspect, trace, slice, plan, verify, and resume. Do not create or update semantic files and do not write a handoff.
- **User-authorized implementation:** open or reuse a change contract before substantial edits, then keep its invariants, evidence, and unknowns current.
- **Migration planning:** require an explicit target architecture supplied by the user or a repository artifact. On a user-authorized write task, `semctx_control_target_propose` may create an immutable hypothetical proposal from explicit target content; never invent the target or treat a proposal as accepted.
- **Generic demonstration:** identify the project's most critical functional path from repository evidence, reconstruct its contracts and invariants, then select one concrete weakness only when the available evidence supports it. If no weakness is proved, report the leading risk and the missing proof instead of inventing a change.

## Top-down diagnostic frame

Before substantial edits, locate the highest broken contract by descending the normative ladder:
**L6 strategy/constraints → L5 product intent → L4 invariants/policies → L3 capabilities →
L2 components/boundaries → L1 symbols/tests/schemas/contracts → L0 sealed observed hunks**.

Record this frame:

```text
HIGHEST_BROKEN_LEVEL = L?_NAME | UNKNOWN
WHY_NOT_HIGHER = evidence that the next higher level is healthy | UNKNOWN - missing evidence
WHY_NOT_LOWER = why a lower-level patch would only move or mask the symptom | UNKNOWN - missing evidence
PROOF_PLAN = the smallest check that can falsify this diagnosis
```

Descend only after evidence clears the current level; ascend only from a concrete repository,
runtime, or control-plane signal. This frame is diagnostic and advisory: it does not become
authored repository truth until explicitly bound through the semantic workflow. Missing links,
`STALE`, and `UNSEALED` states remain unknowns; never reindex or reseal merely to make them green.

For a diagnosis-only task, this frame and its observed evidence are the result; stages conditioned
on `write_task` or `after_edits` stay inactive. `PROOF_PLAN` is a falsification plan, not a request
to call `semctx_control_plan_change` or `semctx_control_plan`. Use the latter only in their declared
write-task or explicit-target-architecture lanes.

## Shared workflow

The ordered lifecycle below is generated from the strict `AgentWorkflowContractV1`. Treat its
declared effects and conditions as the host-neutral policy; host-specific shell resolution appears
only in the final CLI ladder.

{{SHARED_WORKFLOW_CONTRACT}}

## Workspace bootstrap (plugin-native)

If the workspace is **not initialized** (no `.semctx/` / preflight `initialized: false`),
**do not** require a global `semctx` package install. Prefer the plugin MCP tool:

1. Call `semctx_setup` with `{ repositoryRoot }` (preflight only — no writes).
   Preflight returns `requiresUserAuthorization: true` and a `next` **template without**
   `confirm: true` — **never** auto-follow preflight `next.arguments` as a write.
2. After **explicit user authorisation**, call `semctx_setup` with
   `{ repositoryRoot, confirm: true }` (optional `polyglot: true` **only** for a **fresh**
   multi-language config; on an existing non-v2 config this returns `kind: "setup_refused"`).
3. Treat the confirm:true result as success **only** when
   `kind === "setup"` **and** `verdict === "SETUP_READY"`.
   Domain outcomes are ordinary structured results (`isError` false per ADR 0012):
   - `setup_refused` / `verdict: "SETUP_REFUSED"` → agent failure; read `reason` + `nextSteps`.
   - `verdict: "SETUP_NOT_READY"` → agent failure; inspect `check` / `indexHealth`;
     re-check with `semctx_index_health`.
   Do **not** treat `isError` false alone as bootstrap success — always read `kind`/`verdict`.
   `SETUP_READY` is not coverage-complete: still call `semctx_index_health` before
   negative-evidence or high-risk claims when coverage is only `partial`.
4. Re-check with `semctx_control_status` / `semctx_index_health`.

Do **not** auto-run setup merely because control status is `UNSEALED` or `STALE` when
`.semctx/` already exists — that may be a seal/freshness issue; use `semctx_index_health`
and an explicit re-index policy instead of silent re-setup.

Never auto-setup silently. Never invent `confirm: true` from a preflight payload alone.
CLI fallbacks (`bun "<plugin-root>/dist/semctx.js" setup` or global `semctx setup`) remain
valid when MCP is unavailable.

## CLI compatibility preflight

Before relying on a global `semctx` shell fallback, call `semctx_cli_compatibility` with the same
absolute `repositoryRoot`. Treat `compatible: false` as an offline advisory: report the canonical
`reason` and `upgradeCommand`, continue using MCP, and never install or upgrade automatically. The
public MCP report intentionally omits the local executable path.

## Shared lifecycle checkpoints

{{SHARED_LIFECYCLE_CONTRACT}}

## Verdict namespaces

- **Plane A — diff impact:** `PASS`, `WARN`, `BLOCK`. `PASS` is a static policy result, not runtime proof. `WARN` needs attention but is not a failure. `BLOCK` must be resolved or explicitly disabled by user-owned policy.
- **Plane B — change contract:** `VERIFIED`, `PARTIAL`, `BLOCKED`, `STALE`. `PARTIAL` must name every missing proof or open unknown. `STALE` requires re-linking before the model can be trusted.
- **Control freshness preflight:** `FRESH`, `DIRTY_KNOWN`, `STALE`, `UNSEALED`. Only the first two admit high-risk control work.
- **Plane A index health:** binding is `valid`, `invalid`, or `absent`; coverage is `complete`, `partial`, or `insufficient`; freshness retains its own verdict and reasons. Use `semctx_index_health` before relying on negative evidence, and never let one field replace or upgrade another or the independent control-freshness verdict.
- **CLI compatibility:** `CLI_VERSION_COMPATIBLE` confirms exact lockstep; all other reasons are advisory. They never grant authority and never block an MCP-only workflow.
- **Plane C — migration plan:** `READY`, `BLOCKED`. `READY` means the plan satisfies its admission rules; it is never execution authority.
- **Workspace bootstrap (`semctx_setup`):** `verdict` is `SETUP_READY` / `SETUP_NOT_READY` / `SETUP_REFUSED` (or preflight without a verdict). Agent success requires `kind === "setup"` and `verdict === "SETUP_READY"`. Domain refuse/not-ready are structured results with `isError` false (ADR 0012: catalogue errors have no `structuredContent`; handlers do not author `isError`). Namespaced `SETUP_*` values are **not** Plane C `READY`/`BLOCKED` (migration admission, never execution authority).

## Safety contract

- Never interpret a `READY` plan as authority to edit, cut over, deploy, or delete. Execution requires the user's write scope and normal safety checks.
- Never authorize cutover or legacy deletion from LLM-only, hypothetical, historical-only, or stale evidence.
- Never claim completion on `BLOCK`, `BLOCKED`, or `STALE`.
- Never upgrade declared evidence to obtained evidence without running or observing the corresponding check.
- Never treat Control Handoff v2 progress as execution history. `completedRefinementStepId` requests a current-state proof-bearing boundary; count only machine-proved proof-bearing steps as complete.
- Keep `descriptiveRefinementStepIds` separate from completed progress. Skip only those explicit zero-obligation labels, fail closed on an empty legacy step whose completion-evidence field is absent, and keep unsupported migration obligations `UNPROVEN`.
- For an edit-only completed step, accept only the exact sealed observed hunk SHA-256 coordinate as the L0 current focus. Manual Handoff v2 remains shadow-only, non-blocking, and grants no execution authority.
- Never treat a freshness seal as an authenticity signature or invent a verdict from it. Use `semctx_control_status` and preserve its reasons, nulls, and current/indexed mismatches verbatim.
- Never collapse index freshness and analysis coverage into one health claim. Preserve the `semctx_index_health` binding, freshness, coverage, workspace diagnostics, outcome counts, and reasons as separate report fields.
- Preserve the separation of authority: repository facts are observed, semantic intent is authored, and control reports are projections over both.
- Never install or upgrade the global CLI automatically from a compatibility advisory.

## Completion report

Report the framed objective and authority sources; index binding, index freshness, analysis
coverage, workspace diagnostics, outcome counts, and their reasons as separate fields; then the
independent control-freshness verdict, seal hash and input mismatches, L0-L6 impact trace, initial
plan verdict, files changed, runtime checks actually run, final Plane A/B/C verdicts, residual
unknowns, and what semctx prevented from being changed unsafely. Mark conditional fields as `not
run` or `not applicable`; never invent them. A diagnosis-only report stops at the observed
evidence, unknowns, and `PROOF_PLAN`.

## Local equivalents when MCP is unavailable

Never use a global CLI's own `doctor` output to certify plugin parity: that process knows only its
own package version. If the host-specific ladder below provides a plugin-bundled CLI rung, use that
rung with `doctor --json` before falling back globally. Otherwise report CLI compatibility as
unverified. Then use the selected rung with `index-health --json`; a missing `cliCompatibility`
field remains uncertainty, never evidence of compatibility.

{{HOST_CLI_LADDER}}
