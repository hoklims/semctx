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

<!-- BEGIN shared-workflow-contract:v1 -->
Machine policy: enforcement is `shadow`, blocking is disabled, repositories
without Semctx follow `no_op`, and execution authority is
`none`.

1. **inspect_repository** — Establish the repository state with normal code search and Git inspection. Before substantial edits, frame the top-down diagnosis from the highest potentially broken L6-L0 contract and record HIGHEST_BROKEN_LEVEL, WHY_NOT_HIGHER, WHY_NOT_LOWER and PROOF_PLAN without promoting that diagnostic into authored truth. Determine semantic_context_present only from repository evidence or an explicit user-provided identity, without initializing state. Do not use Semctx as a substitute for reading the code.
   - Surface: host-local; effect: `read_only`; condition: `always`.
2. **semantic_check** — Check the semantic model and preserve its canonical reason codes. Resume an exact task-bound Control Handoff v2 capsule with semctx_control_resume when its hash exists; use semctx_resume only for legacy semantic-intent handoffs, and semctx_semantic_inspect or semctx_semantic_slice for repository intent identities. A refused or stale task capsule stays unavailable, and absent context stays unknown.
   - Surface: `semctx_semantic_check`, `semctx_control_resume`, `semctx_resume`, `semctx_semantic_inspect`, `semctx_semantic_slice`; effect: `read_only`; condition: `semantic_context_present`.
3. **status** — Run index health as a distinct binding, index-freshness and analysis-coverage diagnostic, then run the control-freshness preflight before governed work. Never collapse those four fields into one health claim. Continue only for a control-freshness verdict of FRESH or DIRTY_KNOWN, preserve every invalid-binding, incomplete-coverage, STALE or UNSEALED reason verbatim, and record seals and bindings as attestations rather than authority.
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
15. **handoff** — Capture a manual task-bound Control Handoff v2 capsule from the current reconciled state before compaction or owner transfer. Treat the progress pointer as a requested proof-bearing boundary, never execution history. Descriptive refinement ids are non-completable planner labels; skip only those explicit labels, fail closed on legacy empty steps, and preserve UNPROVEN migration obligations. An edit-only step may focus the exact sealed observed hunk SHA-256 node at L0. Use semctx_handoff only for the legacy semantic-intent handoff. A fresh context must return through semantic_check and resume the exact capsule hash before continuing. This shadow surface is non-blocking and grants no execution authority.
   - Surface: `semctx_control_handoff`, `semctx_handoff`; effect: `working_state_write`; condition: `before_handoff`.

Completion requires: `reconcile_diff` → `verify_change` → `change_verify`.
The bounded transfer stage is `handoff`.
<!-- END shared-workflow-contract -->

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

<!-- BEGIN shared-lifecycle-contract:v1 -->
Codex and Claude Code expose `semctx_control_agent_lifecycle` through the same Semctx MCP runtime.
Both hosts are instructed to invoke these checkpoints. Each plugin also ships a shadow lifecycle
hook that automates only the `before_completion` checkpoint: it observes which
Semctx MCP tools the host actually invoked and reports that one checkpoint when the agent turn ends,
and only when the observed set has changed since its last advisory — a completed cycle never
re-reports over later turns that produced no evidence, and its silence is absence of evidence rather
than a renewed claim. It never blocks, and it grants nothing. Every other checkpoint has no automatic
host hook, so an instruction to invoke it is not proof that a host event ran.

This is a presence-only advisory contract. `NO_OP` means no stage-presence obligation applies,
`RECORDED` means every required stage id was caller-recorded, and `INCOMPLETE` means required
stage ids are missing. Recorded stage outcomes remain unevaluated and admissibility is not evaluated.
Enforcement is `shadow`, blocking is disabled, and execution authority is `none`.

Invoke the checkpoints in policy order:
- **before_implementation_write** — minimum altitude L2. Eligible from L2 through L6; L0-L1 is `NO_OP`. Manual: no automatic host hook.
  Implementation stages: `inspect_repository` → `semantic_check` → `status` → `frame_task` → `bind_scope` → `trace_impact` → `authority` → `refine` → `change_contract`.
  Migration stages: `inspect_repository` → `semantic_check` → `status` → `frame_task` → `bind_scope` → `trace_impact` → `authority` → `target_propose` → `refine` → `change_contract`.
- **after_repository_edits** — minimum altitude L0. Manual: no automatic host hook.
  Implementation stages: no stage-presence requirement.
  Migration stages: no stage-presence requirement.
- **before_completion** — minimum altitude L0. Also reported automatically by the shipped shadow lifecycle hook.
  Implementation stages: `reconcile_diff` → `verify_change` → `change_verify`.
  Migration stages: `reconcile_diff` → `verify_change` → `change_verify`.
- **before_compaction** — minimum altitude L0. Manual: no automatic host hook.
  Implementation stages: `handoff`.
  Migration stages: `handoff`.

After repository edits, fold prior and newly observed touched coordinate ids as
`caller_observed_advisory` evidence. Accumulation is
`stateless_caller_reinjected_unbound`: the caller must reinject prior ids, and Semctx binds them to
no task, session, diff, commit, or handoff. Before completion, record the required completion
stages; before compaction or owner transfer, record `handoff`.

The shadow lifecycle hook keeps that separation: it accumulates canonical stage ids only, in a
session-local git-ignored ledger, never coordinate ids, never source content, and never a prompt,
transcript or tool payload. It does not start the Semctx runtime, so it never asserts
`semctx_ready`, and its report carries the same `shadow` enforcement, disabled blocking and
`none` execution authority as the tool.
<!-- END shared-lifecycle-contract -->

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

<!-- BEGIN host-cli-ladder:claude-code -->
Prefer MCP tools when they are connected. For shell fallbacks, resolve the CLI in this order
(stop at the first that works):

1. **Plugin-bundled CLI** (same release as the MCP bundle) — the `bun "…/dist/semctx.js"` path in
   the block below. Claude Code substitutes the plugin root into this skill **when the skill is
   loaded**, so the path you read is already absolute. Never expect `CLAUDE_PLUGIN_ROOT` to exist
   in the shell — where it is set at all, it is exported to hooks and MCP servers, not to your
   terminal. Do not try to guess the plugin directory, and do not assume the shell's cwd is the
   plugin package root: it is the user's repository.
2. **Global `semctx` on PATH** (`bun install -g semctx@latest` / `bunx semctx@latest`) — keep it on the **same
   version** as the plugin (`semctx --version` should match the marketplace plugin version).
3. If neither is available, say so and continue with MCP-only or ask the user to update the plugin /
   install the CLI — do not invent results.

```text
# Plugin CLI (path substituted at skill load)
bun "${CLAUDE_PLUGIN_ROOT}/dist/semctx.js" status --json
bun "${CLAUDE_PLUGIN_ROOT}/dist/semctx.js" semantic check --json
bun "${CLAUDE_PLUGIN_ROOT}/dist/semctx.js" semantic slice --change change.<slug> --format agent
bun "${CLAUDE_PLUGIN_ROOT}/dist/semctx.js" control trace repo:<graph-id> --direction lift --to 6 --json
bun "${CLAUDE_PLUGIN_ROOT}/dist/semctx.js" control plan change.<slug> --target target-architecture.json --json
bun "${CLAUDE_PLUGIN_ROOT}/dist/semctx.js" verify diff --base origin/main
bun "${CLAUDE_PLUGIN_ROOT}/dist/semctx.js" change verify change.<slug> --base origin/main

# Control Handoff v2 — manual shadow surface
bun "${CLAUDE_PLUGIN_ROOT}/dist/semctx.js" control handoff <input.json> --json
bun "${CLAUDE_PLUGIN_ROOT}/dist/semctx.js" control resume-handoff <capsule-hash> --json

# Legacy Plane-B Handoff v1 compatibility
bun "${CLAUDE_PLUGIN_ROOT}/dist/semctx.js" semantic handoff
bun "${CLAUDE_PLUGIN_ROOT}/dist/semctx.js" semantic resume

# Global / CI fallback — same subcommands, no path
semctx --version
semctx status --json
semctx control handoff <input.json> --json
semctx control resume-handoff <capsule-hash> --json
```
<!-- END host-cli-ladder -->
