# Multi-language Plane A runtime

> Status: provisional runtime for issues
> [#58](https://github.com/hoklims/semctx/issues/58)–[#61](https://github.com/hoklims/semctx/issues/61).
> The compatibility and trust invariants in
> [ADR 0010](../adr/0010-multilanguage-plane-a-capability-and-authority.md) are stable. The package
> boundaries, TypeScript interfaces, sidecar shape, and adapter API are private and may change.

This runtime adds a second-language vertical without weakening the existing TypeScript result or
conflating selection, analysis coverage, freshness, and authority.

## Compatibility boundary

The existing public TypeScript analysis result remains `{ graph, evidence }`. The provisional
runtime attaches additional Plane-A facts to that result through an in-memory private sidecar.
Nothing in the private packages is re-exported as a stable public adapter surface.

The compatibility path keeps:

- config v1 discovery and its analysis-input fingerprint;
- existing graph, evidence, claim, and verification bytes;
- existing `belongs_to` relations and traversals;
- the current `ControlFreshnessSeal` and its `FRESH`, `DIRTY_KNOWN`, `STALE`, and `UNSEALED`
  verdicts.

Config v2 opts into a different selected path set. That migration is explicit because applying
globs can intentionally shrink or expand Plane A.

## Private Plane-A sidecar

The private sidecar binds facts to:

- the exact repository and selected path set;
- source, producer-configuration, and fact-schema digests;
- producer identity and version;
- language and dialect coordinates;
- evidence, resolution, soundness, and completeness claims;
- one discovery decision and one terminal analysis outcome;
- deterministic fact batches and producer results.

Assembly rejects conflicting ids, missing edge endpoints, out-of-scope facts, invalid evidence,
and changed capture coordinates. A matching label such as `structural` never authorizes a fact.
Negative conclusions remain ineligible unless completeness is established for the exact fact kind
and scope.

The sidecar is an implementation mechanism, not a serialized CLI/MCP schema and not a public
plugin contract.

## Selection: v1 and v2

| configuration | selection |
| --- | --- |
| v1 | Historical whole-repository discovery. `include` remains informational and `exclude` retains the legacy substring behavior. |
| v2 + `selectionMode: "globs-v1"` | Deterministic repository-relative glob matching. Include selects, exclude wins, and an empty include list selects nothing. |

Version 2 records every considered path in deterministic order. `excluded` pairs only with
`not_applicable`; `selected` pairs with exactly one of `disabled`, `unsupported`, `failed`, or
`analyzed`. A selected path is not proof that an analyzer exists or that a semantic conclusion is
complete.

See [Configuration reference](../reference/configuration.md) for the on-disk formats.

## Index health is additive

The additive `IndexHealthReportV1` answers whether selected scopes were analyzed with the required
capabilities. It reports a `complete`, `partial`, or `insufficient` coverage status; candidate and
outcome counts; per-candidate selection/analysis state; capability profiles; workspace projection;
binding state; and ordered reason codes.

Control freshness answers a different question: whether a captured source/index binding still
matches the repository state being evaluated.

The dimensions never replace each other:

| control freshness | index health | meaning |
| --- | --- | --- |
| `FRESH` | complete for the requested capability | the captured state is current and the requested analysis is covered; later authority gates still apply |
| `FRESH` | partial, unsupported, disabled, or failed | the captured inputs are current, but analysis is insufficient |
| `STALE` or `UNSEALED` | otherwise healthy | historical facts may remain inspectable, but they are not load-bearing for the current state |

Freshness remains an explicitly nested, independently computed field in the report. Index health is
therefore additive evidence. It does not rewrite `ControlFreshnessSeal`, turn freshness into a
scalar coverage score, or grant task-relative authority.

## Manifest-evidenced workspace projection

Workspace units are admitted only from supported manifest evidence:

- `package.json`: `name` plus `workspaces` or `workspaces.packages`;
- `pyproject.toml`: `[project].name` plus `[tool.uv.workspace].members`.

Directories such as `packages/` and `apps/` are layout candidates only. Directory names do not
create workspace nodes.

The private workspace sidecar uses two dedicated relations:

| relation | from | to | cardinality |
| --- | --- | --- | --- |
| `contained_in_workspace` | file-backed module, test, document, or migration | most-specific admitted workspace | zero or one |
| `workspace_member_of` | admitted workspace | nearest admitted ancestor or repository | exactly one |

There is no synthetic root package. An uncontained artifact retains repository scope and legacy
graph behavior. External paths, `..` escapes, symlinked/reparse-backed roots, conflicting same-root
identities or parents, non-ancestor overlaps, and cycles are rejected with
`AMBIGUOUS_LAYOUT`; rejected candidates emit no conflicting sidecar relation.

Containment never implies imports, dependencies, refinement, proof, capability, or authority.

## First vertical: Python through 3.12

The first vertical uses `@lezer/python` 1.1.19 through the private
`@semantic-context/python-analyzer` package. Parsing runs in the Bun/JavaScript process; the runtime
does not launch Python and does not require a native addon or WebAssembly module.

The support claim is intentionally capped at Python 3.12. The parser may accept some later syntax,
but that does not widen the declared dialect capability.

The vertical emits deterministic local positive facts for:

- modules;
- function and class declarations;
- static `import` and `from ... import ...` statements, aliases, and relative levels;
- an `imports` edge when a static module reference resolves uniquely to one selected Python module;
- adjacent explicit `# @capability`, `# @invariant`, `# @contract`, `# @risk`,
  `# @boundedContext`, and `# @tag` markers;
- zero-based UTF-16 offsets plus one-based line and UTF-16 column positions.

It reports parse-error nodes, star imports, dynamic imports, `sys.path` mutation, and
unrepresentable imports as limitations. It does not:

- resolve star imports, dynamic imports, ambiguous modules, or imported names to symbols;
- infer dynamic imports or runtime path behavior;
- emit call edges;
- infer contracts without an explicit marker, or infer `covers` or `tested_by` relations;
- establish negative reference, dependency, test, or impact completeness;
- perform type checking or execute Python.

Unsupported or partial syntax lowers capability and completeness for the exact scope. It never
falls back to a green negative conclusion.

## Verification preflight

Config v2 verification checks health for each selected changed path before accepting the ordinary
graph result:

- invalid/absent binding, stale or inadmissible freshness, a missing persisted candidate, or a
  terminal result other than `analyzed` adds a blocking `analysis_scope_incomplete` finding;
- analyzed Python with incomplete negative evidence or recorded limitations adds a warning and an
  explicit unknown for negative reference, dependency, test-link, and impact conclusions.

Config v1 retains the legacy verification path. The preflight consumes health evidence; it does not
turn the private adapter boundary into a public API.

## Reproducible corpus pin

The real-repository corpus target is `pytest-dev/pluggy` 1.6.0 at commit
[`fd08ab5f811a9b2fa9124ae8cbbd393221151e2c`](https://github.com/pytest-dev/pluggy/commit/fd08ab5f811a9b2fa9124ae8cbbd393221151e2c).
The pin fixes source bytes independently of a moving branch or tag. The vendored subset gate checks
the exact upstream source/license bytes, deterministic extraction, positive symbols/imports, and
ineligible negative conclusions. It is corpus evidence, not a runtime dependency or a claim of
complete Python semantic analysis.

## Public-status boundary

`IndexHealthReportV1` is a versioned shared read-only report exposed as `semctx index-health` and
`semctx_index_health`. That transport does not expose or stabilize the private producer seam.

This runtime does not freeze a public language adapter, stable sidecar schema, or producer plugin
API. Adapter stabilization still requires the ADR 0010 conformance cases, deterministic unit and
mixed-workspace fixtures, the pinned real-repository corpus gate, and TypeScript compatibility
evidence.
