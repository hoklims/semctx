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

Namespace test associations use static member references whose receiver is the
actual namespace import binding and whose target has an existing modeled declaration.
Canonical leaf/default coordinates are preserved through barrels. Dynamic whole reads,
local shadows and unmodeled object members do not provide `tested_by`/`covers` evidence.
These associations do not observe test execution. Whole-module impact reads use the
indexed import target, including TypeScript extension substitution, before fallback probes.
Object destructuring from the actual namespace binding also supplies canonical member
associations, including renamed/barrel/default owners. Local binding-element names do
not become fictional callee coordinates. This is semantic opt-in metadata with the
existing worker DTO shape, without a new invocation extractor.

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
does not establish constructor call edges. Qualified construction now requires a proven
SDK constructor value origin: internal and uncertain `NewExpression` targets are
unsupported. Transparent immutable aliases of actual SDK values retain that opaque
boundary; an annotation, assertion or call-return type alone cannot establish it.
Ordinary/legacy construction facts and static namespace class-test associations remain
available, but those associations do not qualify the constructor invocation itself.
Actual SDK Worker/SharedWorker constructors are code loaders and remain unsupported,
including transparent aliases and URL-valued arguments; no worker dependency edge is
invented. Other known SDK constructor boundaries retain their domain.

Browser SDK setTimeout/setInterval calls with string, possibly string, any/unknown or
generic handlers are unsupported runtime evaluation. Known function callbacks are also
unsupported because callback invocation edges are not extracted; earlier callback
controls remain visible as explicit BLOCK cases. Timer aliases and destructuring are
tracked; helpers and value escapes without a proven safe direct call are refused.
Local/own methods and Node timer imports do not acquire the browser SDK origin merely
from their spelling. Ordinary TypeScript without retained inputs remains unchanged.
SDK Object.defineProperty accessor descriptors and unproved descriptor/function
escapes are unsupported. Only a direct data-descriptor literal containing known own
value/writable/enumerable/configurable fields retains its boundary; get/set, spreads,
unknown fields and a prototype-setting field do not prove accessor absence. A mutable const descriptor
alias is not an absence proof. Own homonyms and type-only SDK references stay distinct.
SDK data descriptors replacing iterator/then protocols or SDK-callable properties are
also unsupported; a direct descriptor does not restore intrinsic mutability safety.
Nonprimitive writes to members whose callable/constructible coordinates come from
the actual loaded SDK revoke that opaque call boundary. Own source declarations are
distinct; an annotation is not proof of an unmodified native value.
The current ES2022.full Program loads lib.webworker.importscripts.d.ts: importScripts
is an actual SDK loader and is unsupported, including transparent value aliases.
No worker library is added and no SDK origin is fabricated from its spelling.
Retained bodyless-only function declarations are not evidence of a runtime lexical
shadow and are unsupported. A binder overload set with a real implementation remains
distinct; ordinary signature facts and SDK/declaration boundaries are preserved.

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

Source getter/setter declarations are unsupported in qualified scope because implicit
accessor invocation dependencies are not extracted. Ordinary data properties, methods
and SDK/external boundaries keep their existing domain; ordinary TypeScript analysis
without retained inputs is unchanged. Retained filesystem inputs must be regular files:
symlinks, FIFOs, sockets and devices do not provide captured source bytes.

Triple-slash `reference path` directives are unmodeled compiler-input dependencies and
are unsupported in selected producers and broad retained scope, whether their targets
are retained or absent. Missing-target diagnostics remain available. This refusal does
not fabricate runtime imports, and ordinary TypeScript extraction remains unchanged.

Qualified CLI report publication must not create or replace a potentially retained
repository input after the final capture. The writer checks the prospective canonical
path, including nonexistent destinations and aliases above the checkout. Use an output
only under the dedicated `.semctx/reports` subtree or outside the repository; ordinary report
publication and atomic symlink safeguards remain unchanged. The Action defaults to
`.semctx/reports/verify.json`, preserving the qualified-rejection report and adapter hand-off.
Workspace and Git control paths remain protected even when Git metadata lives outside
the checkout. Reports cannot replace configuration, database or verification state.

Actual SDK `Reflect.apply`/`Reflect.construct` and their aliases/escapes are unsupported
reflective invocations. Iteration via `for...of` (including await) or iterable spread
requires a proven intrinsic array/string or SDK collection value; internal or uncertain
iterator origins are refused without inventing invocation edges. Ordinary facts remain unchanged.
The same iteration refusal covers array binding/assignment, array-binding parameters and
delegated `yield*`. `await` refuses internal or uncertain thenable origins; primitive
values, actual native promises and genuine async-function results retain their supported
boundary. Type annotations or assertions alone do not prove that boundary. `instanceof`
requires an actual SDK constructor origin; internal or uncertain `Symbol.hasInstance`
invocations are unsupported. No protocol invocation edges are added.
Unknown or internal primitive coercion at addition/concatenation and template interpolation
is unsupported, including numeric addition over unknown parameters. Primitive annotations
or assertions do not prove value origin. Async return resolution, including expression-bodied
async arrows, applies the same thenable-origin boundary as explicit await; nested ordinary
function returns remain distinct. Actual SDK Proxy construction and ServiceWorkerContainer
register references are unsupported implicit trap and code-loader routes. No protocol,
proxy-trap or browser-loader edges are invented; actual primitive/native promise values
and ordinary own-name methods retain their supported domains.

The original declaration-bearing fixture and the historical declaration-free `eligible-esm`
fixture retain their complete original source bytes. The latter's unknown `input + 1`
coercion is now the explicit `eligible-esm-unknown-coercion-blocks` witness. Positive
qualification uses the separately named `data-proven-esm` domain with literal `1 + 1`
operands and guarded Node data, the same tool pins/topology/static call chain, and test copy
describing its fixed primitive value. The historical `primitive-safe-esm` bytes remain a
distinct opaque-data BLOCK witness. Artifact pairs use identical explicit fixture domains;
earlier receipts remain bound to their original sources and are never relabeled.
Array/collection initialization behind a const binding does not prove an immutable
object or exclude a later `then` override. Those iterable objects are outside safe
await/async-return eligibility; primitive values and unmodified native promise origins
retain their boundary. Explicit nonprimitive `then` writes, including immutable static
key aliases, are unsupported. A native promise's own `then` override is not invoked by
direct native await, but it can be invoked by async-return assimilation; the mutation
refusal conservatively prevents that missing dependency.
The same object mutability limit applies to iteration: assignments through a proven
SDK `Symbol.iterator` or `Symbol.asyncIterator` key (including const key aliases)
are unsupported. This source-level refusal applies before for-of, await-for-of,
destructuring, delegated yield or spread eligibility; it does not fabricate protocol
edges. Unmodified intrinsic origins retain their boundary, and string properties
named `iterator` or own homonyms are distinct from actual SDK protocol symbols.
Actual SDK call and constructor signatures with callable callback parameters are
unsupported when their supplied callback is internal or unproven: the extractor
does not model the implicit invocation. This includes array callback APIs and a
native Promise executor; eligibility of the resulting native promise value does
not prove the executor dependency. Primitive/noncallback SDK operations and real
own source APIs remain distinct. No callback or constructor edge is fabricated.
JavaScript files under migration directories are currently classified as executable
sources, unlike TypeScript migration-role files; directory spelling alone does not
turn them into structural migrations or silently remove their executable facts.
The same SDK signature boundary covers iterable parameters: internal or uncertain
iterable arguments are unsupported because their protocol invocation has no edge.
Literal arrays/strings and the existing proven SDK collection origins remain distinct.
SDK `Object.assign` cannot restore native callable authority after an internal or
unknown patch; callable/protocol writes and uncertain sources on SDK targets refuse.
Ordinary data patches and actual own APIs keep their boundary. Numeric unary,
arithmetic/bitwise/relational and loose-comparison coercions require primitive value
proof; strict identity, logical truthiness, `typeof` and `void` are distinct.
Actual SDK Worklet `addModule` loaders are unsupported without a module link.
Retained configurations that actually emit imported runtime helpers are unsupported:
the pinned SDK emitter observes helper metadata and the emitted `tslib` dependency,
without manufacturing an edge. Configurations emitting no helpers remain eligible.

Computed property access/names require a proven primitive key or actual SDK symbol
origin, without relying on a Symbol/string annotation. Resource declarations carrying
the SDK Using/AwaitUsing flags are unsupported implicit disposal, while ordinary
identifiers named `using` remain distinct. CommonJS JavaScript `.cjs` is unsupported
in retained broad module scope even with ESM-looking syntax; its existing selected
JavaScript-producer refusal remains in place. No property-coercion/disposal edges are added.

Retained named `tsconfig*.json` files whose options are not actually consumed are
unsupported. Conventional `tsconfig.json` reads and their SDK-parsed `extends` read set
are recognized across the retained sources; project references and inventory/hash
membership alone do not establish consumption. There is no guessed named-config selector.
This binds the publication operation only; it does not guarantee arbitrary future edits.

Qualified inputs retain `package.json` and `pyproject.toml` workspace manifest bytes,
including ignored manifests outside the reserved internal directories. The input
identity also binds directory membership consumed by the workspace projection, so
adding or removing an empty declared workspace invalidates freshness. Reserved
`.semctx` artifacts and unrelated empty output directories do not supply workspace
evidence. Workspace projection consumes retained manifest bytes; index reconstruction
still compares its projection against the final current layout to detect drift.

## Proof boundary

`Symbol.species` is a callable protocol key: overrides through the existing SDK mutator
routes refuse without inventing constructor edges. Comparator-free actual SDK sorting
requires a fresh literal receiver with proven primitive elements; const containers and
element annotations do not establish immutability. Actual SDK global-binding replacements
invalidate native authority and refuse, while local bindings stay distinct. Promise
combinator inputs must be fresh literal arrays whose individual values satisfy the existing
safe-assimilation proof; internal/unknown thenables and mutable container/helper escapes
are unsupported. Literal primitive/native promise values retain their boundary.
The exact built-in `vm` / `node:vm` runtime bindings share captured import/alias provenance
with process launchers and are unsupported code evaluation, including value escapes.
Type-only/unused imports and own homonyms remain distinct; no Node declarations, implicit
invocation edges or global SDK policy rewrite is added. The existing explicit
`Symbol.toPrimitive` write refusal already covers the reported `String(value)` case.

Runtime values actually imported from the built-in `child_process` / `node:child_process`
module are outside qualification: an opaque launcher can execute retained repository code
without a module link. Import bindings, immutable aliases, namespace members and helper/
container escapes use captured AST provenance, not a new Node declaration provider or API
catalogue. Unused/type-only imports, real local homonyms and unrelated primitive Node
helpers remain distinct. No launch edge is manufactured. Internal calls through an
unmodeled callable parameter already fail the existing exact call-coordinate guard when
their file is in the effective change/closure; no function-pointer propagation is added.

Actual SDK `Object.setPrototypeOf` / `Reflect.setPrototypeOf` references are unsupported
prototype mutations, including retained aliases and helper escapes. SDK `Object.create`
and `Object.defineProperties` use the descriptor boundary: accessor/protocol installations,
unknown descriptor maps or prototype values refuse; directly proven data descriptors stay
distinct. The loaded SDK symbols `match`, `matchAll`, `replace`, `search` and `split` join the
well-known callable protocol-key refusals. Own-name APIs and string properties are not
classified as native hooks. No implicit invocation edges, new libraries or fixture changes
are introduced; ordinary/v1 extraction remains unchanged.

Opaque data arguments require actual primitive provenance or recursively proven direct
literal data without callable/uncertain members. A const object/container initializer
does not prove immutability or absence of callbacks; nested callable members are unsupported.
Actual SDK `JSON.stringify` uses the same closed data domain to refuse unmodeled `toJSON`
hooks, including aliased/helper escapes, while own APIs remain distinct. No callback or
serialization edges are invented and the four public fixture outputs remain unchanged.

Named qualified working-tree verification refuses relevant untracked inputs present in
the retained inventory. Git diff does not describe their additions, so merely adding paths
to expected coverage cannot establish their effects. The reason names each untracked
retained path; ignored/hard-excluded artifacts and the separately sealed raw control config
do not become obligations through this guard. Ordinary/v1 diff semantics stay unchanged.

Qualified identity separately binds the exact `.semctx/config.json` bytes, including an
explicit absent state. Equivalent JSON rewrites invalidate the input seal; malformed
configuration still refuses normal loading. These control bytes do not become retained
repository files or Git post-image members, and database/report artifacts stay excluded.

Actual SDK descriptor/mutator routes cannot overwrite `Symbol.iterator`,
`Symbol.asyncIterator`, `Symbol.hasInstance` or `Symbol.toPrimitive` and then claim an
intrinsic boundary. Formal primitive property-key slots are not iterable API contracts.
Every actual SDK `Promise.resolve` route must establish safe assimilation of its value.
Opaque calls cannot accept unproven callable data. Specific inline obligations may be
discharged after assembly by existing uniquely owned calls or paired canonical test edges;
the exact snapshot, callback span, current graph and indexed raw-input seal bind that proof.
No new invocation edges, framework whitelist or public proof field is introduced.
Runtime primitive guards are proof only for the same unmodified binding in the same
executing scope. Type annotations and assertions alone do not establish value provenance.

The three historical public consumer domains remain byte-identical and visible BLOCK
witnesses. The fourth `data-proven-esm` domain preserves the primitive leaf and changes only
the two Node helpers to check real string values before native calls. Current/historical
artifact comparisons use identical explicitly selected domain inputs. Native pipeline
behavior and source hashes are observed separately; prior receipts are never relabeled.

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
