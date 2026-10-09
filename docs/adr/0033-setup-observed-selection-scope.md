# ADR 0033 — Setup exposes observed selection scope without changing it

- Status: accepted
- Date: 2026-10-09
- Issue: [#315](https://github.com/hoklims/semctx/issues/315)
- Related: ADR 0008 (additive output), ADR 0010 (independent trust dimensions),
  ADR 0012 (MCP parity), ADR 0028 (explicit configuration migration), ADR 0032 (dry-run)

## Context and outcome

A developer bootstrapping a monorepo can obtain `SETUP_READY` for one selected source while
three sources under `domains/` and `platform/` remain excluded by the default includes.
Initialization readiness does not establish coverage of the developer's intended task.
The first setup report must identify the observed scope and offer a precise configuration edit.

## Decision

Keep every active include, exclude, language mode, blocking rule and readiness formula unchanged.
Add an optional `scope` projection to setup plan, completed setup and MCP preflight reports.
The shared app-service builds it from the existing discovery result; transports only project or
render it. This is selection information, never freshness, semantic coverage or write authority.

The projection reports observed TypeScript/Python source-family candidate counts and
repository-relative source roots, selected/excluded/unavailable counts and reasons. Selected
file counts come from `discovery.files`; a selected candidate can instead be disabled,
unsupported or failed. Root rows, sample paths and emitted strings have fixed output limits,
with total and omitted counts. The projection adds no filesystem walk;
it does not claim a bounded discovery scan or an exhaustive workspace manifest interpretation.

Only observed `INCLUDE_MISS` candidates in enabled languages may yield proposed include entries.
Use exact paths without glob metacharacters, control characters or excessive length, rather
than broader workspace globs. Withhold other paths with an explicit withheld count; the
existing selector normalizes backslashes, so conventional backslash escaping is not valid.
Refused links, failed/unsupported/disabled candidates and explicit excludes cannot become
proposals. `INCLUDE_MISS` paths are not read: proposals establish neither production/test role,
readability nor import safety. Explicitly applying them still invokes the existing discovery
and analysis refusal gates. Preserve unknowns instead of inventing a safe literal.
Proposals remain separate from active selection and require an explicit user edit to
`.semctx/config.json`; neither fresh setup nor rerunning setup applies them automatically.
The existing selector's semantics remain authoritative, including its existing ignore behavior.

CLI text shows excluded roots and the proposed entries; JSON and MCP carry the same projection.
Dry-run stays read-only, with indexing and readiness unknown. Completed setup retains its
existing success/failure gates. MCP preflight never embeds `confirm:true` or grants execution.

## Compatibility, delivery and rollback

The optional additive field preserves outer schema version 1 and old payload validity.
Existing config migration remains explicit and outside this change. Regenerate both host
bundles from source with pinned Bun 1.4.0 and retain byte parity. Removing the diagnostic can
roll back the presentation without changing stored configuration or index artifacts.

## Acceptance evidence

Use the four-source synthetic monorepo in #315 and a simple `src/` project. Show an unchanged
dry-run snapshot, all excluded roots/reasons, deterministic exact proposals and four selected
sources after an explicit config edit. Cover empty/restricted existing includes, exclude
precedence, disabled languages, unsafe links, glob punctuation and output omission counts.
CLI/MCP parity and declared output schemas must pass; malformed scope payloads are rejected.
Readiness, root confinement and no-auto-confirm negative cases remain green. Review the full
candidate and execute required CI; opening a PR does not establish merge or installed delivery.
