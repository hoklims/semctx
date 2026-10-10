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
| Mixed-language impact | TypeScript to JavaScript and JavaScript to TypeScript paths, transitive callers, inherited aliases and `.d.mts` companions | Resolved static ESM only; arbitrary runtime resolution is not complete |
| TypeScript-only closure | Static reexports and literal dynamic imports, including excluded inbound importers | Required links are extracted even when no JavaScript file is present |
| Effective module configuration | Direct and inherited compiler options are inspected | The profile uses ESNext/Bundler defaults and refuses explicit incompatible module or resolution semantics |
| Monorepo selection | Exact changed paths plus required dependencies, including excluded importers | A required exclusion, wrong root, empty selection or zero analysis rejects admission |
| Source identity | Exact Git endpoints, diff, raw source/configuration input digest, analyzer and index identities | Selected and excluded/untracked source/configuration drift invalidates qualification |
| Reconstruction | Sources actually consumed; completed snapshot plus explicit build state | Interrupted rebuilding and partial/failed required analysis refuse admission |
| Parsing and unresolved constructs | File outcome and diagnostic, with nonpositive admission | CommonJS, computed loading/evaluation and missing/deleted post-images require another profile |
| CLI, MCP, plugin and Action | Actual structured outputs and process results | A qualified rejection returns nonzero even in advisory consumption |
| Tests | Executed tests on the exact input with retained outcomes | Static test edges and recommendations do not establish execution |
| Turbo cache | Miss, hit and invalidation observed on representative tasks | The synthetic task graph qualifies only that task graph |
| Failure propagation | Injected failed task produces an observed nonzero enclosing command | Static code analysis does not establish pipeline propagation |
| Pipeline | Actual required pipeline execution on the exact candidate | Synthetic consumer observations do not establish the private production pipeline |

The standalone witness uses Bun 1.4.2, pnpm 12.9.1, TypeScript 7.0.2, Vitest 5.0.3
and Turbo 2.11.7 with nested `apps/*`, `contracts/*`, `design-system/*`, `domains/*/*`,
`platform/*` and `tooling/*` workspaces. Semctx's analysis compiler is separately pinned
to TypeScript 5.9.3. Newer consumer syntax that cannot be parsed remains a failure.
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
as `process.<computed>` and `process.mainModule`. Ordinary static members such as `env`,
`argv` and `cwd`, and locally shadowed objects, remain distinct. No `Reflect` resolution or
runtime CommonJS dependency edge is inferred from these refusals.

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
explicit refusals. Unrelated ignored cache JSON stays outside the source inventory.
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
