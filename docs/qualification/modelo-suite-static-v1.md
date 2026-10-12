# Modelo Suite static profile qualification

This qualification concerns `modelo-suite-static-v1`, selected explicitly by configuration
version 2 with `selectionMode: "qualified-static-v1"`. It covers the analyzed ESM/TypeScript
change and its static dependency closure. It does not qualify the entire consumer repository
or its production pipeline. Public fixtures use generated anonymous sources.

## Use and admission

```json
{
  "version": 2,
  "selectionMode": "qualified-static-v1",
  "analysisProfile": "modelo-suite-static-v1",
  "languages": { "typescript": "on", "javascript": "on" },
  "include": ["scripts/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}", "suite/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}"],
  "exclude": ["**/node_modules/**", "**/dist/**", "**/.git/**", "**/.semctx/**"]
}
```

Apply these fields to a complete existing configuration; preserve its blocking rules and other
settings. This excerpt is not a replacement configuration. Select the exact Git worktree root,
inspect the proposed source roots and configure the required paths explicitly. Existing
configuration is never broadened automatically. Rebuild the index after editing the sources.

Consumers must inspect `analysisAdmission.profile`, `analysisAdmission.status`, binding,
index freshness, check freshness, change coverage and the actual exit status. A legacy report
without this admission is not qualified. An older runtime rejects the new selection mode.
The analyzer digest identifies the implementation and actual compiler bytes independently
of the package version. A source build carrying an existing release version is still a new
unreleased candidate until its own artifacts are qualified.

## Coverage and boundaries

| Obligation | Evidence required | Scope and limitation |
| --- | --- | --- |
| JavaScript analysis | Actual `.mjs/.js/.jsx` functions, classes, exports, imports and resolved calls | Non-function exports are explicit module metadata; no invented variable call edges |
| Mixed-language impact | Declaration-free TypeScript to JavaScript and JavaScript to TypeScript paths, transitive callers and inherited aliases | Resolved static ESM only; declarations and CommonJS TypeScript are outside qualification |
| TypeScript-only closure | Static reexports and literal dynamic imports, including excluded inbound importers | Required links are extracted even when no JavaScript file is present |
| Effective module configuration | Direct and inherited compiler options are inspected | The profile uses ESNext/Bundler defaults and refuses explicit incompatible module or resolution semantics |
| Monorepo selection | Exact changed paths plus required dependencies, including excluded importers | A required exclusion, wrong root, empty selection or zero analysis rejects admission |
| Source identity | Exact Git endpoints, diff, raw source/configuration input digest, analyzer and index identities | Selected and excluded/untracked source/configuration drift invalidates qualification |
| Reconstruction | Sources actually consumed; completed snapshot plus explicit build state | Interrupted rebuilding and partial/failed required analysis refuse admission |
| Parsing and unresolved constructs | File outcome and diagnostic, with nonpositive admission | CommonJS, computed loading/evaluation and missing/deleted post-images require another profile |
| CLI, MCP, plugin and Action | Actual structured outputs and process results | A qualified rejection returns nonzero even in advisory consumption |
| Tests | Executed tests on the exact input with retained outcomes | Static test edges and recommendations do not establish execution |
| Turbo cache | Miss, hit and invalidation observed on representative tasks with one fresh cache outside the fixture repository | The synthetic task graph qualifies only that task graph |
| Failure propagation | Injected failed task produces an observed nonzero enclosing command | Static code analysis does not establish pipeline propagation |
| Pipeline | Actual required pipeline execution on the exact candidate | Synthetic consumer observations do not establish the private production pipeline |

The standalone witness uses Bun 1.4.2, pnpm 12.9.1, TypeScript 7.0.2, Vitest 5.0.3
and Turbo 2.11.7 with nested `apps/*`, `contracts/*`, `design-system/*`, `domains/*/*`,
`platform/*` and `tooling/*` workspaces. Semctx's analysis compiler is separately pinned
to TypeScript 5.9.3. Newer consumer syntax that cannot be parsed remains a failure.
The original `createConsumer` fixture retains its `.d.mts` companion and `.cts` source
and is an explicit `original-declaration-bearing-consumer-blocks` witness. Positive
qualification now uses the separately named `createDataProvenConsumer` fixture in
the `data-proven-esm` domain: the same tool pins, topology and runtime call chain,
with no declarations, an explicit ESM `port.ts`, and leaf operands literally `1 + 1`.
Its test describes the fixed primitive fixture value, not input-increment semantics.
The historical `createPrimitiveSafeConsumer` / `primitive-safe-esm` bytes remain unchanged
as `primitive-safe-esm-opaque-data-blocks`: its Node helpers pass unproven data across
opaque calls. The fourth domain changes only those two helpers, rejecting non-string
values with actual runtime guards before the native APIs. Native output bytes, valid
string behavior and the synthetic `+ 9` build failure remain the same.
The original declaration-free `createEligibleConsumer` / `eligible-esm` output is preserved
byte-for-byte and is the additional `eligible-esm-unknown-coercion-blocks` witness:
an unknown `input + 1` can invoke an internal primitive-coercion protocol.
Runtime companion redirection remains distinct from declaration-change
qualification; v2 declaration files remain visible as unsupported. Selector globs
can select `.cts`/declarations, but selection cannot admit their unsupported semantics.
Qualification observations record each fixture domain. Qualified historical/current
artifact pairs both use the explicit `data-proven-esm` domain; the executable path never
selects fixture content. Earlier `eligible-esm` receipts retain their historical source identity.
The original declaration-bearing negative is selected explicitly, and legacy diagnostics
retain their separately recorded original domain.
Observations bind each domain's initial leaf and two Node helper hashes to its Git inputs;
historical receipts keep their original domain and source identity.
Generators are unsupported in retained qualified source: initialization facts do not prove
later cached resumption dependencies. Ordinary extraction still exposes their existing
symbols and calls. Actually used runtime import targets in modeled local modules must
have one exact modeled symbol coordinate, in production and test files. Namespace value
reads retain their actual declaration origin: missing/ambiguous targets and unmodeled
constants or enums fail the importing path rather than silently dropping a dependency
or borrowing a same-named function's test association. Unused and erased type-only
bindings remain distinct. Private extraction/worker metadata carries these checks;
the public graph schema gains no fields, value symbols or approximate edges. Direct
modeled namespace test associations remain supported; this does not establish complete
transitive test recommendations. These limits preserve the four fixture outputs.
The shared JavaScript diagnostic API reports the generator refusal even without this
profile or a supplied snapshot. Its ordinary diagnostics become more conservative while
ordinary extraction retains generator facts.
Classic JSX configurations that actually emit an unmodeled element/fragment factory call
are unsupported, as observed by the pinned SDK transform on retained options/source. The
guard uses synthesized call ranges rather than factory names. Preserve/JSX-free sources
remain eligible under this boundary, and automatic-runtime refusals keep their existing
reason. JavaScript diagnostics report the configuration reason when supplied retained
compiler inputs; ordinary no-snapshot diagnostics and extraction retain their behavior.
Opaque callable arguments are unsupported unless existing facts prove ownership of every
retained callable reference in that exact inline callback. This private proof adds no edges
and requires the actual graph and raw inputs to match the indexed freshness seal; stale
graphs, value escapes, unrelated edges and empty or uncertain references do not qualify.
Primitive data guards must dominate the use in the same execution scope and reference the
same unchanged binding. An annotation, assertion or guard in another function is not proof.
Nested opaque data is limited to recursively proven direct literals without callable or
uncertain members; mutable container aliases are unsupported. Actual SDK serialization
refuses unproven `toJSON` inputs and helper escapes without adding implicit invocation edges.
Qualified working-tree changes with relevant retained untracked inputs refuse explicitly:
Git diff omits their additions. Track those inputs and rebuild before qualifying; ordinary
analysis and ignored/control report artifacts keep their existing behavior.
The check compares the actual retained input paths with Git's tracked index inventory.
Repository `.gitignore`, `.git/info/exclude` and `core.excludesFile` cannot conceal a
retained authored input from this refusal. Actual capture exclusions, including ignored
generated output directories, remain separate. No recursive ignored-tree enumeration is
needed. The existing binding policy marks such an untracked input invalid with its exact
reason; tracking it and rebuilding restores the supported tracked-input domain.
Retained ignore/attribute controls beneath ignored outputs follow this same membership
rule. The tracked positive fixture still checks both control digests, stale rejection
after edits, and recovery after reindexing; identical untracked controls refuse admission.
Working-tree qualification also refuses effective Git clean/process filters on retained
inputs: check-in conversion can hide a raw byte change from the Git diff used for scope.
The driver is inspected without executing a new filter command. Ordinary verification,
text/eol normalization without a filter and a filter name without a configured driver
remain distinct. Ambiguous sentinel-like names with a configured driver are conservatively
unsupported; this refusal does not replace the staged/range attribute-conversion contract.
Object/class definitions of potentially callable hooks at actual SDK protocol symbol keys
also refuse qualification. Erased type members, proven primitive data, string keys and
local symbol homonyms remain distinct; no implicit invocation edges are manufactured.
SDK prototype replacements and accessor/protocol installation through plural descriptors
or `Object.create` are unsupported, including aliases/helper escapes. Actual SDK well-known
RegExp symbol hooks are refused as unmodeled protocol mutations; own APIs, string properties
and directly proven ordinary data descriptors keep their distinct boundary. These checks
add no invocation edges and do not change the four public fixture outputs.
Runtime `child_process` built-in values are unsupported code-launch boundaries without a
retained module link, including aliases, members and helper escapes. This uses actual
built-in import provenance; local homonyms, unused/type-only declarations and the existing
guarded `fs`/`path` data helpers keep their domains. Internal higher-order parameter calls
with missing coordinates remain refused by the existing change/closure guard rather than
being presented as resolved function-pointer invocations.
Explicit runtime re-exports from the existing execution built-ins (`child_process` and
`vm`, including `node:` forms) are also unsupported, even when their consumer reaches
them through a repository barrel. Type-only re-exports remain distinct. This refuses the
unmodeled execution boundary without resolving new Node declarations or creating edges.
Species overrides, SDK-global binding replacements and unproven default-sort coercion
refuse qualification. Default sorting is limited to fresh primitive-element literals,
and Promise combinators independently prove every element's safe assimilation rather
than trusting a const container. Actual built-in VM runtime bindings are unsupported
evaluation boundaries. These checks preserve ordinary local/Node data helpers and the
four fixture outputs, without adding hidden invocation or module edges.
Property membership (`in`) requires a proven primitive/property-symbol left operand;
an ordinary right-hand object remains permitted. Descriptor replacement of an actual
SDK global binding is unsupported even when that binding is a noncallable namespace.
Captured SDK declarations and receiver identity distinguish it from local homonyms.
The shared JavaScript semantic diagnostic API can also report these refusals; ordinary
extraction receives no synthesized invocation facts.
Captured SDK WebAssembly `instantiate`, `instantiateStreaming` and `Instance` construction are unsupported
instantiation boundaries: a module start function may invoke imported internal code.
Compile/validate data operations keep their existing domain. Captured SDK
node insertion with an actual SDK-created `script` argument is also unsupported;
the pinned `Document.createElement` origin and receiver proof distinguish ordinary
objects and type annotations. Standalone script creation and ordinary inert DOM/local
controls remain distinct. The insertion refusal is conservative even for an individual
empty or disconnected script. These are the observed instantiation/insertion routes,
not a claim of complete browser or WebAssembly runtime modeling. Shared JavaScript
diagnostics can report the same refusals without adding invocation or module edges.
The SDK insertion coordinates are `Node.appendChild/insertBefore/replaceChild` argument 0,
all arguments of `ParentNode.append/prepend/replaceChildren` and
`ChildNode.before/after/replaceWith`, `Element.insertAdjacentElement` argument 1, and
`Range.insertNode` argument 0. Reference/replaced nodes and position strings are separate.
The captured checker uses `strict: false`; its actual SDK `onclick` property has one
call signature and replacement is already refused by the existing callable-mutation guard.
That counterexample does not establish behavior for other compiler configurations.
Actual SDK `Date` construction requires primitive provenance for the first seven
arguments, with a separately proven intrinsic Date-copy path. An annotation does not
establish SDK origin. Zero-argument construction and ordinary `Date(...)` calls remain
distinct. Unknown constructor coercion refuses without adding an invocation edge.
Actual `cluster`/`node:cluster` `fork` and `setupPrimary` runtime bindings are unsupported
process-launch boundaries, including the existing alias/destructuring forms. The setup
boundary is conservative even when no fork follows. Inert imports, `isPrimary`, type-only
uses and local homonyms retain their separate domain.
Actual SDK `Document.write` and `writeln` refuse as runtime script boundaries, with
captured member and receiver origin. This is conservative for ordinary HTML/text too;
no HTML parsing, hidden-module extraction or complete browser model is claimed.
Property/element invocations on an ambient receiver without a captured runtime lexical
origin, an actual SDK origin or an explicit supported external import refuse even when
their arguments are plain data. The existing ordinary native `process` members remain
distinct. Bare framework calls retain their existing ownership policy.
A retained local container does not prove its invoked member: erased or unresolved
members require an actual retained callable target before the same data exemptions apply.
Known own methods and callable initializer aliases retain their existing proof. Caller
parameters keep their existing opaque boundary; this is not universal callable resolution.
Members with real captured literal/type declarations continue to the qualified coordinate
check after extraction. The early origin refusal targets absent, erased or synthetic-only
members; a declared member still cannot qualify when its required graph coordinate is missing.
Object-literal prototype setters require the existing closed-data proof for their
initializer. Null/direct closed data remain distinct; an uncertain or callable prototype
refuses. Computed `__proto__` properties, methods and shorthand are ordinary own properties.
Invocation or callable escape of `import.meta` members is unsupported when its runtime
effect is unmodeled. Metadata reads and supported primitive aliases remain distinct.
The observed `import.meta.glob` admission hole is a static loader refusal, supported by
the bundler's documented transform; no native Vite build was observed in this qualification.
Actual SDK `String` conversion requires primitive provenance for its first argument.
Actual SDK array `join` requires a captured literal array of proven primitive elements
and a proven primitive separator when supplied. Unknown ordinary conversion hooks refuse;
local homonyms and primitive controls remain distinct. No implicit invocation edge is added.
Tests using resolved literal dynamic imports without canonical test-binding proof refuse
qualified admission. Their ordinary module-link facts remain visible, and non-test literal
dynamic imports retain their existing closure policy. No coarse test edge is fabricated.
Unknown/internal coercion in addition or template interpolation, async thenable return
assimilation, actual SDK Proxy traps and ServiceWorkerContainer registration are outside
qualification. A type annotation/assertion cannot prove a primitive/native value origin.
These refusals do not add implicit invocation or browser code-loader edges; ordinary/v1
facts and explicitly proven primitive/native boundaries retain their stated domain.
The profile's effective module settings are `module: "ESNext"` and
`moduleResolution: "Bundler"`. Missing settings take those defaults. Explicit incompatible
settings, including inherited NodeNext/Node16 or CommonJS, remain outside qualification and
produce `SOURCE_CONFIGURATION_MODULE_UNSUPPORTED:<name>` or
`SOURCE_CONFIGURATION_RESOLUTION_UNSUPPORTED:<name>`; hashing the configuration cannot
substitute for honoring or refusing its semantics.
Scope reconstruction also refuses CommonJS loading, including a literal `require()` or
external `import = require()` in an excluded source. Such an importer cannot disappear
from the dependency obligation merely because it is outside the configured selector.
Inline TypeScript `import()` type queries are also outside the profile and suspend scope
admission with `DEPENDENCY_SCOPE_IMPORT_TYPE_UNSUPPORTED:<path>` until qualified static
module links are available for that construct.

Ambient Node global origins follow the known static `global` and `globalThis` self aliases,
including quoted member names, before accessing `process`. Exporting the whole ambient
container, passing it to a call or placing it in another container leaves the qualified
grammar and produces `NATIVE_MODULE_MEMBER_UNSUPPORTED:ambient-global` (with the source
path in dependency-scope diagnostics). Ordinary member access such as `globalThis.console`
and locally shadowed names remain distinct. This refusal does not model `Reflect`, invent
runtime dependency edges or claim complete runtime resolution.

The same static boundary applies to the whole native `process` container: opaque arguments,
exports and container escapes produce `NATIVE_MODULE_MEMBER_UNSUPPORTED:ambient-process`.
Computed native members and the legacy `mainModule` loader boundary are explicitly unmodeled
as `process.<computed>` and `process.mainModule`. The ordinary static member set is exactly
`argv`, `cwd`, `env`, `execPath`, `exit`, `exitCode`, `platform`, `stderr`, `stdout` and `versions`.
Every other used native member is explicitly unmodeled as `process.<name>`; unused or
type-only imports and locally shadowed objects remain distinct. This allowlist defines an
opaque runtime boundary, not execution or dependency completeness for these members.
No `Reflect` resolution or runtime CommonJS dependency edge is inferred from these refusals.
Unshadowed ambient `require` and `module`, including their static global-container members,
remain unsupported CommonJS primitives when used. Aliasing a loader cannot remove that
refusal; locally declared names and ordinary global members remain distinct.

The qualified inventory never classifies a source as generated solely because an ancestor
is named `build`, `dist`, `coverage`, `.turbo` or `.next`. It retains tracked sources,
repository-locally nonignored sources and sources selected by the original user configuration.
Repository-local `.gitignore` and `.gitattributes` controls are bound to the input identity.
Host-global/shared Git exclusions do not narrow this profile. An untracked generated output
ignored by repository-local rules and outside the original selector is explicitly excluded
as `IGNORED_GENERATED_OUTPUT`; broad dependency discovery preserves that original boundary.
Named TypeScript configurations, package manifests and lockfiles remain retained even when
Git ignores them beneath an output directory. Repository-local relative `extends` references
are retained as configuration inputs; missing or unsupported configuration references remain
explicit refusals. A retained untracked cache JSON is not exempt from the membership check.
The qualification harness uses the same fresh external Turbo cache for miss, hit and
failing-build observations, keeping those artifacts outside its repository input inventory.
Metadata under `.git` and `.semctx`, and installed dependencies under `node_modules`, remain
outside the qualified source inventory. These boundaries do not establish runtime completeness.

## Reproduction and validation

Build and pack the CLI, install that tarball into a disposable wrapper, generate the plugins
with the repository's pinned Bun 1.4.0, then run the public harness with explicit artifact paths:

```sh
bun scripts/qualify-modelo-static.ts --source-root <candidate> \
  --cli <disposable-install>/node_modules/semctx/dist/index.js \
  --mcp <candidate>/plugins/claude-code/dist/semctx-mcp.js \
  --plugin-cli <candidate>/plugins/claude-code/dist/semctx.js \
  --legacy-cli <baseline>/apps/cli/dist/index.js \
  --regression-cli <pre-audit-correction>/apps/cli/dist/index.js \
  --directory-regression-cli <pre-directory-correction>/apps/cli/dist/index.js \
  --loader-regression-cli <pre-loader-correction>/apps/cli/dist/index.js \
  --output-dir <new-disposable-evidence-directory>
```

The harness preserves actual command output and numeric exit codes. Its baseline reproduces
the incident with `PASS` despite an unanalysed changed `.mjs` and stale index. The corrected
profile requires effective extraction after actual rebuilding. Negative cases cover added,
modified, renamed and deleted files after indexing; failed parsing, unsupported constructs,
partial indexing, empty selectors, wrong roots and real process interruption. The old runtime
must also refuse the qualified selector. No absence of detected violations substitutes for
analyzed obligations.
Build the regression CLI from commit `774bb72027f3ce68b69c29b1f12acf3c110a3ef0`.
It reproduces positive admission for excluded TypeScript-only reexports/literal imports
and incompatible inherited module settings. The candidate must refuse those same inputs.
The directory regression artifact comes from public commit
`52cc7232f691b948b150225118ff2dc4de7f72ad`. Its tracked importers under `build`/`dist`
disappear even with an explicit selector. The corrected package must enumerate the importer,
reject it when excluded, and actually analyze it when selected. Existing drift refusals in
the historical artifact remain recorded as existing protections.

The loader regression artifact comes from public commit
`95744a3c0df2bfe4a0cac06ac5b452d649ce9317`. Its selected direct `createRequire`
loader, excluded named alias, excluded TypeScript namespace factory and excluded
reexport barrel can admit a changed local `.mjs` after a fresh rebuild. The public
witnesses retain those actual outcomes. The corrected package must reject the same
sources with `COMMONJS_UNSUPPORTED` diagnostics naming the offending source, not
invent an import/call edge for the runtime-loaded target. This remains diagnostic
coverage: runtime CommonJS loading is outside the admitted static profile.
`--loader-witnesses-only` runs these before/after cases without dependency installs
or a pipeline campaign; its receipt always has `qualified: false`. Complete
qualification requires all historical artifacts, including `--loader-regression-cli`.
The same matrix includes excluded JavaScript and TypeScript namespaces copied by
assignment before accessing `createRequire`. These reproduce admission in the
historical loader artifact and must produce the same explicit CommonJS refusal.
Namespace escape through assignment is not a qualified static dependency path.
Named `default` imports (including a statically quoted import name), namespace
destructuring of `Module`, and quoted destructuring of `createRequire` have their
own JavaScript/TypeScript before/after witnesses. These known static binding
routes must receive the same loader refusal; this diagnostic coverage does not
establish completeness for every Node module access or runtime loading pattern.
The native-module member grammar admits ordinary use only for `isBuiltin` and
`builtinModules`. Known `createRequire` and `_load` routes receive explicit
CommonJS refusal, including default-module and named-import `_load` witnesses
in JavaScript and TypeScript. Other used native members, such as access to
`Module.prototype.require`, receive `NATIVE_MODULE_MEMBER_UNSUPPORTED` rather
than an inferred dependency edge or a claim that their execution was analyzed.
Default/Module namespace bindings remain eligible only along the understood
immutable/static routes. This closed member policy applies to JavaScript analysis
and broad TypeScript dependency-scope discovery.
The global Node builtin resolver `process.getBuiltinModule` also remains outside
the qualified static profile. Its intermediate namespace-alias witness requires
an explicit unmodeled-member diagnostic; it does not claim that the resolver or
the resulting loader was executed or that its runtime dependency was extracted.
The same resolver refusal is witnessed through a statically quoted default import
from `node:process` and a destructured `getBuiltinModule` alias in TypeScript.
These are equivalent syntax routes to the existing unmodeled resolver, not new
runtime capabilities.

Repository gates, independently executed negative witnesses and the fresh aggregate auditor
must all bind the complete candidate. Source, build, local checks, hosted CI and independent
review remain separate observations. See the PR evidence for the exact commit, commands,
artifact identities and observed results; this document alone is not a readiness receipt.

## Invalidation and delivery states

Any source/configuration/selector, relevant manifest or lockfile, Git endpoint, analyzer/compiler,
index snapshot or store change invalidates the corresponding qualification. Unsupported required
syntax, unresolved scope, failed parsing, stale input, source drift during analysis and interrupted
rebuilding suspend admission. Rebuilding must consume sources and record a new complete result.

Package qualification does not install a global CLI or plugin, reload an existing host session,
activate a consumer gate or establish observed use in that consumer. Those states require their
own observations. Approval gates, brokers and shared agent approval policy are outside this PR.
