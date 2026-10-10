# ADR 0035 — Qualified static analysis admission

- Status: accepted
- Date: 2026-10-09
- Related: ADR 0008 (additive reports), ADR 0010 (trust dimensions), ADR 0012
  (transport parity), ADR 0028 (explicit configuration migration), ADR 0036 (scope)

## Decision

Configuration v2 can opt into `analysisProfile: "modelo-suite-static-v1"` together
with `selectionMode: "qualified-static-v1"`. Both values require each other.
Older runtimes reject the new selector instead of stripping an unknown profile
and silently producing a legacy positive result.
Legacy diagnostics retain their existing behavior. The named profile adds a versioned
`analysisAdmission` to the shared verification report. CLI, MCP and plugin use the same
application service. Rejection produces `BLOCK`; CLI returns 3 and the Action returns 1
even under `fail-on: none`. The structured schema rejects contradictory positive admissions.

Admission requires exact Git worktree-root selection, a Git-derived diff with resolved
commit identities, a current bound index, completed reconstruction and a non-empty
effectively analyzed change scope. The scope starts with both sides of the exact diff,
including renames and deletions, then closes over statically extracted imports, exports,
calls and dependency relations. Discovery outside configured selectors detects excluded
importers. Static reexports and literal dynamic imports also contribute to the closure
when the repository contains only TypeScript. Parse failure, unreadable sources,
CommonJS loading (including literal `require()` and external `import = require()`),
unresolved non-external imports and computed imports that could conceal
an inbound dependency prevent admission. Exclusions remain visible and never discharge
an obligated source. Unknown configuration/runtime semantics and deleted post-images
are conservatively outside this bounded ESM/TypeScript profile.

Output directory names are not source-eligibility evidence. Qualified discovery and retained
input capture share a tracked/nonignored/originally-selected policy for sources beneath
`build`, `dist`, `coverage`, `.turbo` and `.next`. Repository-local ignore controls are bound;
host/shared excludes cannot silently narrow the scope. Ignored untracked generated outputs
outside the original selector carry a named exclusion. Administrative metadata and installed
dependencies remain explicit external boundaries.

Source identity hashes raw bytes, including excluded/untracked source and repository
manifests, lockfiles and JSON/YAML configuration. It includes the generated analyzer
implementation digest; rebuilding a seal without consuming sources cannot restore it.
Reconstruction marks the old index incomplete before analysis and completes that state
atomically with the new snapshot. An interrupted rebuild cannot authorize the old graph.
Working-tree results use refreshed post-image symbol ranges. A final observation rejects
source, Git diff/commit or snapshot changes during analysis.

Binding, index freshness, repository coverage, change coverage, check freshness and
control freshness are separate fields. `DIRTY_KNOWN` means the exact dirty source was
indexed and sealed; `STALE`, `UNSEALED`, incompatible implementation/configuration or
partial obligated analysis refuse admission. Repository coverage may remain partial
outside the named change closure; the report enumerates both scopes.

A dirty qualified index supports working-tree verification only. Staged and range
sources require a clean indexed post-image; a range destination must also match the
indexed commit. `DIRTY_KNOWN` proves retained worktree bytes, not equality with the
Git index or a committed range destination. Exact dirty staged-post-image matching
is not implemented and cannot be inferred from stable input observations.

The profile refuses actual global scripts, global declaration files, and global or
string-named module augmentations because their cross-file bindings are not modeled.
Explicit import/export boundaries and the `.mjs`/`.mts` modes marked external by the
current extraction Program remain eligible. That Program does not propagate
configured `moduleDetection` or infer bare TypeScript/JavaScript module scope solely
from package `type: "module"` under ESNext/Bundler. Such bare files remain unsupported,
including those configured with `moduleDetection: "force"`; configuration intent does
not replace observed compiler scope.

Qualified inputs retain `package.json` and `pyproject.toml` workspace manifest bytes,
including ignored manifests outside the reserved internal directories. The input
identity also binds directory membership consumed by the workspace projection, so
adding or removing an empty declared workspace invalidates freshness. Reserved
`.semctx` artifacts and unrelated empty output directories do not supply workspace
evidence. Workspace projection consumes retained manifest bytes; index reconstruction
still compares its projection against the final current layout to detect drift.

## Proof boundary

Every required closure member must also have admitted Plane-A fact-use tuples.
The JavaScript registration covers the 22 declared ESM fact kinds for v2,
dialect 5.9.3 and `verify` / `change` only. It does not replace capability,
completeness, binding or freshness checks and grants no execution or approval authority.

`PASS` is a static analysis result. It does not prove test execution, Turbo cache
invalidation, failure propagation or pipeline execution. The report names those as
unobserved proof obligations and specifies the required observations. Static admission
qualifies only the named source/dependency subset, never runtime dependency completeness.
Built-in Node modules are an explicit external boundary; unresolved package/self-name
imports require resolution or a separately qualified profile.

Package qualification, installation, session loading and observed use are separate
states. Qualification is invalidated by any source, selector/configuration, Git coordinate,
analyzer, store or snapshot change, interrupted indexing or incomplete required coverage.
Consumers must retain the actual report and exit code on the exact candidate. Independent
aggregate review and negative witnesses are required before delivery; the modified
mechanism is not its own admissibility authority. Public fixtures contain no private
consumer source, documents or links. Approval gates, brokers and shared agent policy
remain a distinct project.
