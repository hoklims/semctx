# ChangeImpact report (schema version 1)

`semctx impact diff` reports **what a change can affect, through which link, with what confidence,
and where the modeled reach stops**. It is the input of a proof planner, not a planner: it contains
no proof verdict, no proof level, no list of tests to run, no proof count and no allow/block
decision ([ADR 0030](../adr/0030-change-impact-contract.md)). Its one `verdict` field,
`analysis.binding.freshness.verdict`, is the freshness state of the index the binding read.

```sh
semctx impact diff [--base <ref> [--head <ref>] | --staged] [--surfaces <map.json>] \
  [--format text|json] [--output <path>]
```

The command exits 0 whenever it produces a report. A broken binding or an incomplete reach is data
in the report, not a failure. Only diffs semctx computes itself are accepted (working tree, staged,
or a range); `--from-file` is refused because a supplied diff cannot be bound to the index.

## Reading rules for consumers

1. **Absence is never evidence.** A node missing from every tier is *not shown* to be affected; it
   is not shown to be unaffected. `explicitlyUnaffected` is always `[]` in schema version 1.
2. **`null` means not computed; `[]` means computed and empty.** When `analysis.binding.status` is
   `broken`, every index-derived field (`changes.units`, the three tiers, `exposedClaims`) is
   `null`, confidence is `none`, and the blast radius is `unknown`.
3. **Tiers are kinds of links, not scores.** `direct`/`transitive` rest on behavioural links the
   graph resolves; `possible` rests on a structural link only. Do not collapse them.
4. **`complete: false` or any `unresolved` entry with `affects: "reach"` bounds every conclusion.**
   Read each gap's `code`, `scope` and `file`/`nodeId`: it says exactly where the reach stops.
5. **`analysis.limits` always apply**, even when `complete` is true: static reach cannot see
   dynamic dispatch, function values, runtime configuration or data.
6. **`surfaces[].exposure: "not_reached"`** means no modeled path reaches the surface in a complete,
   untruncated analysis. It is not a statement that the surface is safe.
7. **Codes are open sets.** `reason`, `unresolved[].code`, `limits[].code`, `confidence.reasons`,
   `blastRadius.rationale` and `binding.breaks` may grow within schema version 1. Treat an unknown
   code as opaque and bounding, never as absence.
8. **Confidence is a projection** of the binding and the gaps (`moderate` | `low` | `none`), not a
   probability. `moderate` is the ceiling for static reach.

## Report shape

| field | meaning |
| --- | --- |
| `subject` | `source` (`working-tree` \| `staged` \| `range`), `base`, `head`, resolved `headOid`, `mergeBaseOid`, `diffDigest` (sha256 of the analysed diff), and the digests of every input (`indexSnapshotHash`, `repositoryFactsHash`, `configHash`, `semanticInputHashes` seen by the binding probe, `semanticModelHash` of the authored model actually joined, `surfaceMap`) |
| `analysis.binding` | `status` `bound` \| `broken`; `rangeSide` `old` \| `new` \| `mixed` \| `null` (the diff side whose coordinates the index carries; `mixed` = per file, see each unit's `side`); `breaks`; the verbatim control `freshness` |
| `analysis.confidence` | `level` and the codes that set it |
| `analysis.bounds` | `maxDistance` (default 4), `maxTargets` (default 250) |
| `analysis.semanticLayer` | `joined` \| `absent` \| `unavailable` \| `not_computed` (authored `.semctx/semantic` nodes) |
| `analysis.limits` | static limits of this run (`code`, `detail`) |
| `changes.files` | every changed path with `status` (`modified`, `added`, `deleted`, `renamed` + `oldPath`, `binary`, `mode_only`, `untracked`, `unrecognized`) |
| `changes.units` | classified changes: `kind` (`symbol`, `declaration`, `module_statement`, `file`, `added_declaration`, `removed_declaration`, `doc_comment`, `trivia`, `unclassified`), `side`, `lines`, `names`, `exported` (`true` \| `false` \| `null` = unknown), `behavioral`, `runsOnLoad` (present when the changed code runs as its module loads), `surfaces` |
| `directlyAffected` / `transitivelyAffected` / `possiblyAffected` | targets: `id`, `kind`, `name`, `file`, `package`, `surfaces`, `distance`, `reason`, `via` (each step: `relation`, `from`, `to`, optional `evidence {file, line}`) |
| `exposedClaims` | marker (`@invariant`, `@capability`, …) and authored claims anchored to an exposed node: `source` `marker` \| `semantic`, `exposure` (strongest tier of its anchors), `anchors` with the relation that ties them |
| `surfaces` | per declared surface: `exposure` (`changed` \| `direct` \| `transitive` \| `possible` \| `not_reached` \| `unknown`) and `counts`; `null` without `--surfaces` |
| `blastRadius` | `scope` of the **known** reach (`local` \| `package` \| `repository` \| `unknown`), `complete`, `known {files, packages, surfaces}`, `possible {files, packages, surfaces, omitted}`, `rationale` |
| `unresolved` | boundaries: `code`, `scope` (`run` \| `file` \| `node`), `file`/`nodeId`, `detail`, `affects` (`reach` \| `claims` \| `none`) |

`blastRadius.scope` summarizes only the known reach (behavioural changes plus direct and
transitive targets): `local` = within the changed files, `package` = within the manifest-evidenced
workspace packages of the changed files, `repository` = beyond them or where no package boundary
applies. It is `unknown` whenever the reach is incomplete. The possible tier is reported as facts
only and never summarized into a scope.

## How a change is classified

- **Formatting and comments.** A hunk whose statements have the same token stream on both sides
  (every node and token kind — keywords and operators included — identifier and literal texts,
  template texts as written; without comments, whitespace, positions, list commas or a final `;`),
  and that reaches each statement the same way (its code on both sides, or only its leading
  comment on both sides), is `trivia` or `doc_comment` and `behavioral: false`.
- **Directives.** A line holding a compiler or bundler directive (`@ts-ignore`,
  `@ts-expect-error`, `@ts-nocheck`, `@jsx`/`@jsxImportSource`/`@jsxRuntime`/`@jsxFrag`,
  `#__PURE__`, bundler magic comments, triple-slash directives) never counts as formatting. Inside
  a statement it is an edit of that statement; outside any statement it is `unclassified` with a
  `CHANGE_NOT_CLASSIFIED` gap, since its effect on the file is not modeled.
- **Replacement hunks** are read on both sides: code that appears where a comment or blank line
  was (or disappears) is classified as new or removed code, never as trivia.
- **Load-time code.** A top-level statement whose evaluation can run code (a call, `new`,
  `await`, a decorator, a static initializer, an assignment, or loading another module) gets
  `runsOnLoad` (a `module_statement` always runs on load); every importer then runs it, whether it
  is exported or not, so its importers are listed (`IMPORTS_MODULE_EXECUTING_CHANGE`) and the
  reach beyond them is a `REVERSE_REACH_NOT_MODELED` gap (`cause=module_initialization`). Parameter
  decorators and top-level `using` count as running on load.
- **Added code** is inert (`behavioral: false`) only when it runs nothing on load, merges with no
  existing declaration, and cannot shadow a name re-exported by `export *`. A new import of a
  module the file did not load before runs that module's top-level code. An edit that extends an
  existing statement (a decorator, a continuation line) is an edit of that statement.
- **Imports.** Editing an import changes only the bindings it no longer holds or now takes from
  elsewhere; bindings it adds are `added_declaration` and change nothing indexed. Whether a file
  loads a module is read per module: `never` (`import type`, `export type`), `maybe` (only inline
  `type` bindings, or none: erased or kept depending on the compiler configuration, which semctx
  does not read), `yes` (a side-effect import, `export *`, or a value binding — a value binding
  used only as a type is still taken to load its module). An edit or addition that changes that
  level for a module is a `module_statement` (the module starts or stops running as the file
  loads). Imports that load modules in another order are a `module_statement` too: ES modules
  evaluate their dependencies in import order.
- **Doc comments** exposing a marker claim anchor it as `changed` only when the edit reaches a
  marker line (`@invariant`, `@capability`, `@contract`, `@risk`, …), inserted lines included;
  prose next to a marker anchors it as `possible`. A marker edited inside a symbol's body is
  attributed to the first nested indexed declaration below it (a `doc_comment` unit on that
  declaration).
- **Export status.** `export default local` and `export = local` export `local`; a symbol nested
  in a declaration that is not exported is `exported: false`.

## Target reasons

| reason | tier | link |
| --- | --- | --- |
| `CALLS_CHANGED` | direct | a resolved caller of a changed symbol |
| `TEST_IMPORTS_CHANGED_BY_NAME` | direct | a test importing a changed symbol by name |
| `REFERENCES_CHANGED_DECLARATION` | direct | a same-file statement referencing a changed declaration |
| `CALLS_AFFECTED` | transitive | a resolved caller of an affected symbol |
| `TEST_IMPORTS_AFFECTED_BY_NAME` | transitive | a test importing an affected symbol by name |
| `REFERENCES_AFFECTED_DECLARATION` | transitive | a same-file statement referencing an affected declaration |
| `IMPORTS_FILE_OF_CHANGED_DECLARATION` | possible | imports a file whose exported declaration changed |
| `IMPORTS_MODULE_EXECUTING_CHANGE` | possible | imports a module whose top-level code changed or runs affected code |
| `IMPORTS_FILE_WITH_UNCLASSIFIED_CHANGE` | possible | imports a file with a change that could not be classified |
| `SHARES_FILE_WITH_UNCLASSIFIED_CHANGE` | possible | a top-level symbol in a file with an unclassified change |
| `IMPORTS_MOVED_OR_DELETED_FILE` | possible | imports a renamed or deleted file |
| `IMPORTS_FILE_OF_UNMODELED_DEPENDENCY` | possible | imports the file of an affected declaration whose readers are not followed |
| `REEXPORTS_CHANGED_FILE` / `REEXPORTS_PACKAGE_WITH_CHANGED_FILE` | possible | re-exports (`export … from`) the changed file, or a workspace package containing it |
| `IMPORTS_REEXPORTER_OF_CHANGED_FILE` | possible | imports a module that re-exports the changed file |
| `LOADS_CHANGED_FILE` / `LOADS_PACKAGE_WITH_CHANGED_FILE` | possible | `import()`/`require()` of the changed file or of its package |
| `IMPORTS_PACKAGE_WITH_CHANGED_FILE` | possible | imports a workspace package by name that the indexer did not resolve to a file |
| `IMPORTS_SHADOWED_MODULE` | possible | imports a module whose resolution a new file can take over (`x.ts` added next to `x/index.ts`), or, when the index already describes the new file, imports that file |

`distance` is the length of `via`. `via[0].from` is always the id of a changed unit, or
`file:<path>` for a change reported at file level: a deleted, renamed or emptied file (under its old
path), or a new file taking over a module's resolution. A possible target keeps its
shortest chain. Possible targets sit one hop beyond a known target, plus one hop per re-exporter
crossed, so their distance is not bounded by `maxDistance`.

## Unresolved codes

| code | affects | meaning |
| --- | --- | --- |
| `INDEX_BINDING_BROKEN` | reach | the index is not bound to this diff; see `analysis.binding.breaks` |
| `CHANGED_PATH_NOT_ANALYZED` | reach | a changed path with no indexed facts (binary, unsupported, unselected, failed) |
| `REMOVED_PATH_NOT_INDEXED` | reach | a deleted file the head index no longer describes |
| `RENAMED_PATH_DEPENDENTS_NOT_VISIBLE` | reach | dependents naming the old path are not visible in a head index |
| `UNRECOGNIZED_DIFF_BLOCK` | reach | a diff block that could not be classified |
| `CHANGE_NOT_CLASSIFIED` | reach | changed text the outline could not place (no outline or syntax errors), or a directive comment changed outside any statement |
| `REVERSE_REACH_NOT_MODELED` | reach | dependents of a changed or affected node cannot be followed by call edges (`cause=` `module_initialization`, `non_call_reference`, `declaration` (an added or removed exported declaration), `symbol_kind_<kind>`, `ambiguous_identity`, `language_has_no_call_edges`) |
| `TRAVERSAL_TRUNCATED` | reach | `cause=depth` (node) or `cause=count` (run): expansion stopped at a bound |
| `MODULE_LINKS_NOT_SCANNED` | reach | re-exports, `import()` and `require()` could not be read, for the run or for one indexed file |
| `ADDED_PATH_MAY_SHADOW_MODULE` | reach | a new file may take over the resolution of an indexed module; its importers are listed as possible |
| `MODULE_LOAD_NOT_RESOLVED` | reach | a non-literal `import()`/`require()` that may load a changed module |
| `SEMANTIC_MODEL_UNAVAILABLE` | claims | the authored model could not be loaded or has errors |
| `SEMANTIC_LINK_UNRESOLVED` | claims | an authored link that does not resolve against the index |
| `SEMANTIC_LINK_NOT_POSITIONAL` | claims | an authored link to a claim or evidence record, which has no code position |
| `SEMANTIC_INVARIANT_UNANCHORED` | claims | an authored invariant with no repository link: its exposure is unknown |
| `POSSIBLE_TIER_TRUNCATED` | none | possible targets omitted after `maxTargets` (surfaces then read `unknown`) |
| `ADDED_PATH_NOT_INDEXED` | none | an added file the old-side index cannot describe; no indexed edge points to it |
| `UNTRACKED_PATH_NOT_DIFFED` | none / reach | an untracked file outside the diff: `none` when the index does not describe it either, or when the binding proved it unchanged since the index read it from disk (committed code then reaches it only through the changed files that import it, or by resolution take-over, reported separately); `reach` when the index read it and whether it changed since is unknown |
| `METADATA_ONLY_CHANGE` | none | a file mode change without content change |

### Binding breaks

Binding breaks reuse the index-binding reasons of `verify diff` (`HEAD_MISMATCH`,
`ANALYZED_COMMIT_MISMATCH`, `REPOSITORY_GRAPH_MISMATCH`, `FRESHNESS_PROBE_FAILED`, …) and add:

| break | meaning |
| --- | --- |
| `INDEX_COORDINATES_NOT_ON_DIFF_SIDE` | no diff side carries the indexed coordinates: a local change that did not exist, with the same Git status record, when the index was built on a dirty tree (staging or unstaging a file counts as a change, even with identical bytes); or a staged or range diff over an index that read any uncommitted file, or missed a committed one (deleted from the worktree at indexing). Re-indexing fixes the first case; the second needs an index built on a tree whose analysed files are all committed |
| `DIRTY_INDEX_SEARCH_BOUND_EXCEEDED` | the index was built on a dirty tree and more than 12 local changes exist now, so which of them existed at indexing was not searched |
| `WORKING_TREE_CHANGED_DURING_ANALYSIS` | the worktree or Git index changed while the report was computed |
| `INDEX_CHANGED_DURING_ANALYSIS` | the index was rebuilt while the report was computed, or could not be reopened to check |

An index built on a dirty tree keeps only a hash of that tree's local changes (Git status records,
index blob ids included). semctx recovers which of today's local changes already existed at
indexing by testing subsets of them against that hash (up to 12 changes); files dirty then are
joined on their new side, the others on their committed side (`rangeSide: "mixed"`).

### Limits, confidence and rationale codes

| `analysis.limits[].code` | meaning |
| --- | --- |
| `NO_NEGATIVE_EVIDENCE` | nothing absent from the tiers is shown to be unaffected (ADR 0010) |
| `STATIC_REACH_ONLY` | dynamic dispatch, reflection, configuration, data and runtime state are not modeled |
| `CALLS_UNIQUELY_RESOLVED_ONLY` | an ambiguous call site has no edge |
| `FUNCTION_VALUES_NOT_FOLLOWED` | a function used as a value is covered only through the changed file's importers |
| `TEST_LINK_IS_IMPORT_BY_NAME` | a test is linked because it names a symbol, not because it exercises the change |
| `CROSS_FILE_READS_ARE_FILE_LEVEL` | reads of exported values across files are visible only as file imports |
| `MODULE_LINKS_BY_LITERAL_PATH` | re-exports and dynamic loads are followed for relative paths and workspace package names |

`confidence.reasons`: `STATIC_REACH_CEILING` (level `moderate`: the ceiling for static reach),
`INDEX_BINDING_BROKEN` (level `none`), or the codes of the gaps that affect the reach (level `low`).

`blastRadius.rationale`: `NO_BEHAVIORAL_CHANGE`, `WITHIN_CHANGED_FILES`, `WITHIN_CHANGED_PACKAGES`,
`BEYOND_CHANGED_PACKAGES`, `FILES_WITHOUT_PACKAGE_BOUNDARY`, `INDEX_BINDING_BROKEN`, or the codes of
the reach gaps that make the scope `unknown`.

## Surface map

Surfaces are declared, never inferred. `--surfaces` takes a JSON file:

```json
{
  "schemaVersion": 1,
  "surfaces": [
    { "name": "runtime-live", "include": ["packages/runtime/src/**"] },
    { "name": "protocol", "include": ["packages/protocol/src/pins.ts"], "symbols": ["LIVE_PINS", "matchesProtocolPin"] },
    { "name": "decision-engine", "include": ["packages/decision/src/**"], "exclude": ["packages/decision/src/scoring.ts"] }
  ]
}
```

`include`/`exclude` are repository-relative globs. `symbols` restricts a surface to named
symbol-level units and targets; file-level ones match on the file globs alone. A report records the
map's path and digest in `subject.inputs.surfaceMap`.

## Example

`examples/change-impact-replay` mixes live protocol pins and replay-only canonicalization in one
module, like the incident that motivated this contract. Adding a key to the private
`REPLAY_SAFE_KEYS` constant (abridged output):

```json
{
  "analysis": {
    "binding": { "status": "bound", "rangeSide": "old", "breaks": [] },
    "confidence": { "level": "moderate", "reasons": ["STATIC_REACH_CEILING"] },
    "semanticLayer": "joined"
  },
  "changes": {
    "units": [{ "id": "decl:packages/protocol/src/pins.ts:REPLAY_SAFE_KEYS", "kind": "declaration",
                "exported": false, "behavioral": true, "surfaces": ["replay"] }]
  },
  "directlyAffected": [{ "name": "isReplaySafe", "reason": "REFERENCES_CHANGED_DECLARATION", "distance": 1 }],
  "transitivelyAffected": [
    { "name": "canonicalReplayName", "reason": "CALLS_AFFECTED", "distance": 2 },
    { "name": "diagnoseTurn", "reason": "CALLS_AFFECTED", "distance": 3 },
    { "name": "replayFight", "reason": "CALLS_AFFECTED", "distance": 3 },
    { "name": "pins-check.ts", "reason": "CALLS_AFFECTED", "distance": 3 },
    { "name": "diagnose-turn.ts", "reason": "CALLS_AFFECTED", "distance": 4 }
  ],
  "possiblyAffected": [],
  "exposedClaims": [
    { "id": "inv:replay-never-feeds-live", "source": "marker", "exposure": "transitive" },
    { "id": "invariant.replay.analysis-only", "source": "semantic", "exposure": "transitive" },
    { "id": "invariant.protocol.module-reviewed", "source": "semantic", "exposure": "possible" }
  ],
  "surfaces": [
    { "name": "replay", "exposure": "changed" },
    { "name": "analysis-only", "exposure": "transitive" },
    { "name": "runtime-live", "exposure": "not_reached" },
    { "name": "protocol", "exposure": "not_reached" }
  ],
  "blastRadius": { "scope": "package", "complete": true, "known": { "packages": ["@demo/protocol"] } },
  "unresolved": [{ "code": "SEMANTIC_INVARIANT_UNANCHORED", "nodeId": "invariant.decision.deterministic", "affects": "claims" }]
}
```

The live pin gate (`matchesProtocolPin`) and the live runtime appear in no tier, and nothing says
they are safe: the report says no modeled path reaches them, within the stated limits. Changing
the body of the exported `canonicalReplayName` instead lists `live.ts` and `decide.ts` as
`possible` (`IMPORTS_FILE_OF_CHANGED_DECLARATION`): they import the file, and imports are file-level.

## What a planner can use, and what it must decide itself

A planner can key its policy on: the tier and `reason` of each target, the `via` chain, the exposed
claims and their tier, the declared surfaces reached, the known blast-radius scope and packages, the
confidence level, and every `unresolved` code with its scope.

semctx does not decide which proof a change needs, which tests must run, whether a `possible` link
deserves requalification, whether an exposed invariant still holds, or whether the change may
proceed. Those are policies over this report, owned by its consumer.
