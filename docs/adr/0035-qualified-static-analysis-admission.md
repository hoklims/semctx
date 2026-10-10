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
Clean Git status also does not prove post-image membership: ignored retained sources,
manifests or empty workspace roots may be absent from the candidate. Staged/range
admission compares retained repository inputs with Git blobs and consumed
workspace roots with the selected directory inventory. Git >= 2.41 is required for
qualified staged/range verification: retained payloads are converted through Git using
the selected commit's attributes before object-identity comparison. Attribute metadata
is observed in batches and rechecked; conversion errors or drift refuse comparison.
Raw retained bytes still bind the compiler snapshot and input digest. Missing inputs
or differing converted objects refuse admission.

Qualified verification refuses sparse checkout and relevant tracked inputs marked
`skip-worktree` or `assume-unchanged`: these flags can hide an unmaterialized importer
from working-tree discovery and diff coverage. Ordinary analysis and verification keep
their existing behavior. Changed Python files already receive unsupported coverage with
`OUTSIDE_BOUNDED_ESM_TYPESCRIPT_PROFILE`; the ordinary Python producer does not establish
the broad Python dependency closure required to qualify those changes.

The profile refuses actual global scripts, global declaration files, and global or
string-named module augmentations because their cross-file bindings are not modeled.
Explicit import/export boundaries and the `.mjs`/`.mts` modes marked external by the
current extraction Program remain eligible. That Program does not propagate
configured `moduleDetection` or infer bare TypeScript/JavaScript module scope solely
from package `type: "module"` under ESNext/Bundler. Such bare files remain unsupported,
including those configured with `moduleDetection: "force"`; configuration intent does
not replace observed compiler scope.

Repository declaration files (`.d.ts`, `.d.mts`, `.d.cts`) are unsupported in configuration
v2 until their API and dependency facts are extracted. They remain visible as unsupported
per-path outcomes and prevent qualified admission when retained in the broad repository
scope, including excluded declarations. CommonJS TypeScript `.cts`/`.d.cts` format is
outside the ESM profile even when it contains explicit exports. Legacy v1 behavior is
unchanged. Existing runtime-companion resolution does not qualify declaration changes.

Default export expression assignments are unsupported, including identifier aliases,
inline functions, conditionals, calls, class/object expressions and literals. Transparent
parentheses and TypeScript assertion wrappers cannot hide this boundary. This closed
profile does not infer an export owner from an expression's apparent shape. Anonymous
default function/class declarations retain their existing extracted symbols; legacy v1
extraction behavior is unchanged.

Opt-in semantic extraction resolves calls through transparent parentheses and
TypeScript type-only wrappers to the same callable owner. JavaScript calls whose
unwrapped callee is outside the modeled identifier/property/literal-import forms
remain partial. Test associations use canonical checker-resolved value-binding
coordinates, including import aliases and named/anonymous default declarations;
the structurally imported module remains unchanged across reexports. These import
associations do not establish test execution. Legacy v1 no-snapshot extraction keeps
its previous call and import-name behavior.

Semantic JavaScript JSDoc import types and import tags are outside this profile until
their dependency links are extracted. Actual attached JSDoc AST nodes make selected
producers partial and prevent broad qualified scope from silently omitting an importer.
Ordinary prose mentions of imports and nonsemantic TypeScript JSDoc are not dependencies.

Namespace test associations use explicit calls or constructions whose receiver is the
actual namespace import binding and whose target has an existing modeled declaration.
Canonical leaf/default coordinates are preserved through barrels. Dynamic whole reads,
local shadows and unmodeled object members do not provide `tested_by`/`covers` evidence.
These associations do not observe test execution. Whole-module impact reads use the
indexed import target, including TypeScript extension substitution, before fallback probes.

TypeScript/TSX files classified as migrations retain legacy structural migration facts,
but this profile refuses their selected producer scope and broad dependency scope because
their executable symbols and calls are not extracted. Retained TypeScript export clauses
and named default declarations use the same semantic export coordinates as JavaScript.

Sources containing JSX are unsupported when the pinned compiler's configuration or
semantic file pragmas introduce an implicit JSX runtime import. This includes automatic
JSX modes and `jsxImportSource`; extraction still preserves JSX without modeling that
runtime dependency. JSX-free files remain eligible under those options. Classic pragma
overrides follow the pinned SDK semantics, including repeated pragma precedence.

For this named profile, already extracted calls whose named endpoint belongs to a
modeled local module require exactly one grouped symbol coordinate. A missing or
ambiguous caller/callee makes the caller file partial before capability and discovery
ledger construction. Unmodeled object-literal callable members cannot reuse same-named
file-level caller or callee coordinates. Module-level callers and opaque external/declaration boundaries
remain distinct. This checks coherence of extracted local coordinates, not completeness
of all possible calls; legacy and manually selected v2 analysis retain their behavior.

Qualified TypeScript also refuses `CallExpression` callees outside the shared extractor
and JavaScript domain after transparent parentheses/type wrappers are removed. Conditional,
comma, inline-function and other unnamed call forms receive `SOURCE_DYNAMIC_CALL_UNSUPPORTED`
for selected producers and broad excluded scope. Identifier/property calls keep their actual
coordinates; literal `import()` remains a separately guarded module link. This shape check
does not establish constructor call edges or expand the existing class-construction domain.

Tagged-template invocations have no extracted callee edges and are explicitly unsupported:
JavaScript producers report `JAVASCRIPT_TAGGED_TEMPLATE_UNSUPPORTED`, while qualified
retained TS/JS scope reports `SOURCE_TAGGED_TEMPLATE_UNSUPPORTED`, including excluded
sources. Ordinary template literals keep their existing call references and eligibility.

Verification captures qualified inputs directly at each before-analysis, after-analysis
and final stability boundary. The digest and retained files from the same after-analysis
capture serve admission and Git post-image comparison together; no capture is reused across
later temporal checks. Useful discovery for candidate/ledger scope remains separate. Source,
configuration and inventory drift still refuses admission.

Unmodeled JSX component invocations are unsupported; intrinsic lowercase/custom-element
tags and ordinary literals retain their existing domain, and the automatic JSX-runtime
gate remains separate. Actual SDK Function/CallableFunction/NewableFunction `call`, `apply`
and `bind` helpers on retained callable receivers are refused, including aliases. Own class
methods with those names do not acquire that prototype origin. Class heritage whose base
resolves to an internal retained class/constructor is unsupported until dependency edges
are modeled; plain classes and known SDK/external base boundaries retain their existing
contract. No component, helper or heritage edge is invented. Semantic inspection shares
one retained Program per snapshot identity and never reuses it across a new boundary;
repository source reads remain limited to retained bytes plus the pinned SDK libraries.

Decorator AST nodes are unsupported in qualified scope, including bare, property and
factory-call forms: extracting the explicit factory call does not model the implicit
application of the returned decorator. Exported callable or constructible bindings
originating in destructuring, including local export clauses and identifier aliases,
are unsupported because extraction does not create their symbol coordinates. Unknown,
any and possibly callable union bindings receive the same refusal; known noncallable
local bindings retain their module-metadata boundary. Modeled identifier declarations
and ordinary TypeScript analysis without retained inputs remain unchanged. These guards
apply to selected and broad retained sources, and to the JavaScript producer; no new
decorator edge, destructured symbol or test-coverage fact is invented.

Other exported variable bindings that are possibly callable or constructible also
require an existing extraction coordinate. Only direct arrow/function initializers
currently create variable callable symbols; class expressions, conditionals, aliases,
calls and wrapped initializers are unsupported exports. Known noncallable bindings and
modeled function/class declarations retain their existing domain. Actual SDK
`Object.constructor` access on a callable/constructible receiver is refused as a
dynamic-evaluation route, including subsequent helper-call chains; own constructor
properties and noncallable object receivers do not acquire that intrinsic origin.
Bun `import.meta.require`, including retained aliases and destructuring, is a runtime
loader outside the qualified static-module domain. Computed metadata access and
container escapes also refuse qualification when the loader origin cannot be excluded.
Ordinary metadata such as
`import.meta.url` remains supported. No coordinate, evaluation or loader edge is invented.

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
