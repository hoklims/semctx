# ADR 0008 — `verify diff` has a versioned machine-output contract

- Status: accepted
- Date: 2026-07-04

## Context

The GitHub Action adapter, the Claude Code hook, and any CI consumer parse `verify diff` output.
An ad-hoc JSON dump (the current `--json` that serialises the internal `VerifyResult`) couples
external consumers to internal types: an internal refactor would silently break every consumer.

## Decision

`verify diff --format json` emits a **stable, versioned report** — a deliberate projection of the
internal result, not the internal object:

```json
{
  "schemaVersion": 1,
  "verdict": "WARN",
  "base": "origin/main",
  "head": "HEAD",
  "mergeBase": "abc123",
  "range": "abc123..def456",
  "changedFiles": [],
  "changedSymbols": [{ "id": "", "name": "", "kind": "", "file": "" }],
  "impactedContracts": [],
  "impactedInvariants": [],
  "recommendedTests": [],
  "findings": [{ "rule": "", "tier": "strict", "severity": "block", "message": "", "nodeIds": [] }],
  "summary": { "blockCount": 0, "warnCount": 1 }
}
```

Rules:

- `schemaVersion` is an integer. Within a major version, changes are **additive only** (new
  optional fields); a breaking change bumps `schemaVersion`.
- The report is produced by an explicit mapper in `core` (`buildVerifyReport`), so the projection
  is a tested, owned boundary — internal `VerifyResult` can change freely underneath it.
- `--format github` is a **derived view** over the same report (annotations + summary). It does
  not add fields; it renders them for GitHub. GitHub-specific code stays out of `core`.
- `--format text` is the human view (unchanged behaviour). The legacy `--json` flag maps to
  `--format json` for compatibility.

## Consequences

- External consumers depend on `schemaVersion`, not on internal types. We can refactor the engine
  without breaking the Action or the hook.
- New signals are added as optional fields without a version bump; consumers ignore what they do
  not know.
- One tested mapper (`buildVerifyReport`) is the single source of truth for the machine contract.
