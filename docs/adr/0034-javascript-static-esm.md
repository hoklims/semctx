# ADR 0034 — Opt-in JavaScript static ESM analysis

- Status: accepted
- Date: 2026-10-09
- Related: [ADR 0010](0010-multilanguage-plane-a-capability-and-authority.md)

## Decision

Version 2 selection can explicitly enable `languages.javascript: "on"` and select
`.js`, `.mjs`, `.jsx` and `.cjs`. Version 1 retains its existing selected file set.
Extension recognition is discovery, not completed analysis.

The existing pinned TypeScript 5.9.3 compiler extracts JavaScript function and class
declarations, function-valued variables, imports, static reexports and resolved
calls in the same program as TypeScript. Literal dynamic imports produce genuine
module dependency edges. Mixed calls traverse in both language directions; the
regression fixture proves three inbound call hops under an inherited tsconfig and
an internal paths alias. Runtime `.mjs` sources remain the dependency endpoint when
a `.d.mts` declaration companion is present. Named local export clauses are read
through the compiler export table, including alias bindings.
That runtime redirection does not extract or qualify the companion's API/dependency
facts. Configuration v2 reports repository declarations as unsupported, and the
named ESM profile refuses declaration-bearing scope (ADR 0035). The separately
eligible public mixed fixture contains no declaration companion or CommonJS source.

Named exported non-function variables are recorded in module `staticExports`
metadata as a JSON string containing their names and declaration kinds. These are
module export facts, not invented function nodes or resolved variable-reference
edges. Ordinary graph metadata remains scalar and graph schema remains unchanged.
Module `staticModuleLinks` metadata separately records resolved, external and
unresolved module specifiers. Node builtins and installed dependencies under
`node_modules` are explicit external links. Unknown bare package aliases remain
unresolved and partial, rather than being silently classified as external.

JavaScript capabilities use producer identity
`@semantic-context/ts-analyzer/javascript`, version `0.1.0`, compiler dialect
`5.9.3` and resolution semantics `javascript-static-esm-v1`. They register complete
producer-declared static facts only. Partial JavaScript facts have no consumer
capability registration and cannot admit a change. Negative evidence remains
ineligible: this vertical does not prove the absence of tests or all runtime paths.

Parsing failures, including TypeScript-only annotations in JavaScript files, are
terminal failed outcomes. CommonJS, computed dynamic imports, dynamic evaluation,
dynamic scope, computed calls, unresolved relative imports and exported
destructuring remain explicit diagnostic limitations. CommonJS extensions are
discovered and reported but are not included in the qualified ESM profile.
TypeScript parsing failures and invalid tsconfig options are also terminal failures
in version 2; compiler syntax recovery must not count as completed analysis.

Nearest tsconfig options, inherited `extends`, `paths` and `baseUrl` inform mixed
module resolution. Resolver configuration is read fresh, with no process-global
configuration cache. Qualification must bind those configuration inputs and
withdraw admission after they change. The analyzer does not create missing built
outputs or establish arbitrary package/workspace aliases by directory name.
Configuration outside the repository boundary, including inherited `extends`,
is reported explicitly and cannot support a qualified positive result.
The qualified profile uses ESNext/Bundler when module settings are absent and
refuses explicitly incompatible direct or inherited settings, including NodeNext,
Node16 and CommonJS. Those semantics are not silently replaced by defaults.
Mixed JavaScript/TypeScript extraction uses one compiler Program. Explicit worker
requests fall back to a single Program with a reported reason, preserving alias
and declaration-companion semantics across the full selected source set.

## Evidence and boundaries

The independent Plane-A operation registry admits the 22 declared JavaScript
fact kinds only for configuration v2, compiler dialect 5.9.3 and static
`verify` / `change` analysis. Capability and completeness checks still reject
partial CommonJS, computed imports and parsing failures. This registration
grants no approval, execution, merge or deployment authority.

Public fixtures contain only generated, anonymous sources. The JavaScript
discovery regression fails on the previous source because all four JavaScript
variants are absent from analyzed files. It passes after real symbol/call/module
extraction. Runtime regressions separately demonstrate recovered-AST rejection,
partial capability denial, mixed alias/companion resolution and transitive calls.

CLI, MCP and packaged-consumer qualification, exact source/configuration identity,
change coverage and index freshness remain responsibilities of the shared
admission path. This analyzer ADR does not itself declare a consumer ready, an
installed package, an active session, executed tests or functioning pipeline.
Static PASS is not runtime or pipeline evidence. Approval gates, brokers and
shared agent policy are outside this change.
