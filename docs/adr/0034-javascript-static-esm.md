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

## Amendment — path mapping in TypeScript-only graphs (2026-10-14)

Status: proposed; awaiting maintainer acceptance with the pull request that implements it.
Issue: #354.

A version 2 repository that imports by tsconfig `paths` alias and selects no JavaScript indexed
with no `imports` edge, no cross-file `calls` edge and no test link: the TypeScript-only
extraction resolved every specifier with the analyzer's fixed Bundler options and never read
the nearest tsconfig, which this ADR applied only to mixed graphs. Impact and verification
then returned empty sets that read as "no dependents".

- **Rule.** Under configuration v2, with no retained snapshot and no JavaScript root, a
  non-relative specifier written in a selected file and governed by that file's nearest
  tsconfig `paths` or `baseUrl` (`extends` included) is resolved with those two fields over the
  historical Bundler options, by the resolver and by the Program the checker uses. Nothing else of
  the configuration is applied. The mapping only adds a repository module: a specifier no mapping
  governs, one the mapping cannot reach, one that resolves to an installed package and one that
  resolves to nothing under confinement (a `node_modules` hoisted above the analyzed root) keep
  the historical resolution, with the usage mode the compiler applies to the import form. A
  configuration whose selected files are governed by neither field leaves the extraction
  byte-identical.
- **Selected files.** Only imports written in a selected file are mapped. A file the Program
  loads through an alias without being selected keeps the historical resolution for its own
  specifiers: its tsconfig is not an input freshness binds, so the extraction must not depend on
  it. A re-export through an unselected barrel therefore stays unresolved until the barrel is
  selected.
- **Legacy.** Version 1 keeps its resolution in this amendment. Its analysis input identity
  deliberately does not inspect live configuration, so reading `paths` there would add an input the
  freshness seal cannot bind (extended to version 1 by the amendment below). Mixed
  JavaScript/TypeScript graphs and qualified snapshots already applied the complete nearest
  configuration and are unchanged.
- **Freshness.** Version 2 identity already binds the nearest configuration and its `extends`
  chain for every selected TypeScript and JavaScript file, including failed link probes, so an
  edited mapping withdraws the index. The extraction reads the same files through the same
  confined, workspace-link aware system, and only for selected files.
- **Confinement.** Resolution reuses the configured resolver's admission: a mapped target outside
  the analyzed root, or behind a link leaving it, is neither read nor produced. It is refused as
  an unresolved specifier, not as `IMPORT_OUTSIDE_REPOSITORY`, so that an existing configuration
  with an out-of-repository alias keeps indexing. A repository file a mapping reaches from a
  selected file is repository-authored traversal like a relative import: the confinement walk
  follows it, and a relative import or reference of that file leaving the repository is refused
  with `IMPORT_OUTSIDE_REPOSITORY` or `REFERENCE_OUTSIDE_REPOSITORY` as the relative spelling of
  the same chain is. The confinement walk classifies a specifier with the predicate the Program's
  mapping uses (`ts.isExternalModuleNameRelative`): a name beginning with a dot that TypeScript
  does not call relative is mapped and followed, and an absolute specifier is traversal like a
  relative one. Nothing outside the repository is read through an alias.
- **Determinism and cost.** The governing mapping is derived once per directory and per
  configuration in one pass, never across passes. Resolutions use the compiler's own cache, which
  is keyed by importing directory and usage mode, so what depends on the importer (`package.json`
  `imports`, a self-name reference, a `node_modules` lookup) is never shared across directories.
  Only the absence of a mapped candidate is shared, because `paths` and `baseUrl` candidates are
  the same from every directory and the rest is resolved by the historical resolution as well.
  The result therefore does not depend on the order of the roots, and a catch-all `"*"` mapping
  does not make every bare import a confined, uncached resolution. Worker partitioning and the
  preflight Program resolve aliases too, so serial and parallel extraction stay identical, in
  source order as well.
- **Not claimed.** A specifier that stays unresolved is still not reported: an alias with no
  target is silence, not a completeness diagnostic. `package.json` `imports` and `exports`
  entries targeting build output need `outDir`/`rootDir` and remain unresolved in an unbuilt
  checkout; entries targeting sources already resolved. `export ... from` and `import()` produce
  no dependency edge in this graph for relative and aliased specifiers alike. A file loaded
  through an alias but not selected is read; its content is not part of the analysis input
  identity, as for a relative import. For the same reason, a file created at a higher-priority
  target of a `paths` entry that is not selected (a git-ignored `gen/`) changes the resolved edge
  without making the index stale until it is rebuilt.

## Amendment — path mapping in version 1 (2026-10-17)

Status: proposed; awaiting maintainer acceptance with the pull request that implements it.
Refines the Legacy and Freshness bullets of the amendment above.

The previous amendment left version 1 on the historical resolution because its analysis input
identity did not bind the configuration files that resolution reads. A version 1 repository whose
tests import by tsconfig `paths` alias (for example `@/lib/guard`) therefore still indexed no
`imports`, `tested_by` or `covers` edge for those tests, and `change verify` reported an
invariant-constrained symbol as changed without a covering test although a test imports it. Moving
to version 2 is not a repair for that repository: it changes the selected file set (ADR 0028), and
a committed-range verification there reports `analysis_scope_incomplete` for every changed
path because the TypeScript profile sets `negativeEvidenceEligible` to false.

- **Rule.** The mapping of the previous amendment applies in version 1 as well, with the same scope:
  no retained snapshot, no JavaScript root, imports written in a selected file, `paths` and
  `baseUrl` only, and an unmapped specifier resolved as before.
- **Freshness.** The version 1 identity binds the configuration files the mapping reads, the
  nearest tsconfig of each selected file and its `extends` chain, as version 2 does. It binds them
  only while some selected file is governed by `paths` or `baseUrl`. A version 1 repository whose
  configuration declares neither keeps its extraction and its analysis input identity byte-identical,
  so nothing is withdrawn by upgrading. A repository that declares one has a new identity once, and
  its index is stale until it is rebuilt: that rebuild is what adds the alias edges.
- **Not claimed.** Version 1 does not gain live configuration inspection or its diagnostics
  (`SOURCE_CONFIGURATION_*`), and it does not read `module` or `moduleResolution`. A tsconfig
  created closer to a selected file than the one read is not an input until some bound file changes,
  as in version 2.
