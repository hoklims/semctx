# Public static consumer qualification

This synthetic consumer contains no professional source, document or link. Its
workspace patterns and declared tool versions reproduce the qualification
consumer topology. `scripts/modelo-static-fixture.ts` generates each repository
under a new output directory, so no live pull request or checkout is modified.

Run the harness against **built** artifacts from the frozen candidate, and retain
a built baseline artifact from before the correction:

```sh
bun scripts/qualify-modelo-static.ts \
  --source-root /path/to/candidate \
  --cli /path/to/candidate/apps/cli/dist/index.js \
  --mcp /path/to/candidate/plugins/claude-code/dist/semctx-mcp.js \
  --plugin-cli /path/to/candidate/plugins/claude-code/dist/semctx.js \
  --legacy-cli /path/to/baseline/apps/cli/dist/index.js \
  --output-dir /path/to/new-evidence-directory
```

The harness installs pinned pnpm 12.9.1 locally through Bun, and installs Turbo
2.11.7, TypeScript 7.0.2 and Vitest 5.0.3 in the disposable consumer. The analyzer's
internal TypeScript version remains a separate artifact identity. Network access
is necessary for the initial installation. Installation errors fail qualification;
declared versions do not count as observed runtime versions.

The process exits nonzero if any scenario fails or if the actual historical
witness is absent. `qualification.json` retains raw commands, stdout, stderr,
exit codes, source identity and bundle SHA-256 hashes. Existing fixture paths
are never overwritten; use a new output directory for each run.

| Witness | Required observation |
| --- | --- |
| Historical `.mjs` omission | Baseline has no `value` symbol; health says STALE; verify nevertheless returns PASS and exit 0 |
| Mixed ESM / TypeScript | Exported `.mjs` symbol, imports and real call edges reach `.ts` bridge and `.js` consumer |
| Refresh | Source edit first refuses; full indexing then admits the covered static change |
| CLI / plugin / MCP | Built artifacts report the same admission; MCP is invoked through real stdio JSON-RPC |
| Added / edited / deleted / renamed | Index taken before the mutation cannot admit the change |
| Failed parse | Invalid `.mjs` cannot be represented as analyzed PASS |
| Unsupported construction | Nonliteral dynamic import refuses admission |
| CommonJS | Diagnostic-only `.cjs` is an explicit negative case |
| Partial / empty selection | Disabled JavaScript or selector matching no source cannot admit obligations |
| Wrong nested root | An initialized parent does not silently turn an uninitialized leaf into success |
| Interrupted indexing | After observing the persisted incomplete marker, kill a real rebuild; the previous complete index cannot admit the source change |
| Test execution | Vitest executes one passing test; a source mutation makes it fail nonzero |
| Synthetic cache / propagation | Turbo first misses, then hits; relevant source mutation causes an actual build failure and nonzero exit |

PASS is a static analysis result. It does not establish test execution, Turbo
cache validity, failure propagation or pipeline health. Those obligations have
separate raw observations here, limited to this synthetic consumer. A `.cjs`
file or unresolved dynamic module expression is outside the admitted profile.

The harness proves package behavior for the named static profile only when all
its assertions pass. It does not prove installation in the real consumer, loading
in an existing editor/agent session, or observed use on a professional pipeline.
Those stages require their own observations. A source, config, analyzer, selected
root, dependency or bundle change invalidates the relevant qualification receipt.
An interrupted rebuild, stale index or new unsupported obligation requires a
fresh analysis before admission. Independent proof review of the frozen candidate
remains required; the modified admission code cannot approve itself.
