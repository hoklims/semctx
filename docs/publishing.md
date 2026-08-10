# Publishing semctx to npm — state & decisions

Prep for the "publish" move (competitive-scan 2026-07: publishing is the strongest non-technical
lever against commoditisation — visibility).

**Decided 2026-07-05** (owner ratified): the CLI publishes as **`semctx`** (unscoped — the name is
free on npm), **bun-only**, as a **single self-contained bundle**. `0.1.0` and `0.1.1` were the
first published versions. From `0.1.11`, the npm CLI and both plugins are one lockstep release and
tag-driven npm + GitHub Release publication is automated by `.github/workflows/release.yml`.

## Decisions (ratified)

1. **Distribution runtime → bun-only.** The code is bun-first to the bone (`bun:sqlite` in the
   store, `Bun.spawnSync` in the CLI's git path). A `--target=node` bundle would compile then
   crash at runtime; true node support needs a real port (`bun:sqlite` → `better-sqlite3` — a
   native dependency whose `npx` install can fail per-platform — plus a spawn shim). Rejected as
   dishonest and adoption-negative for a first release. The `RepositoryStore` port keeps the node
   door open for later (one file to swap) at zero cost now.
2. **Name → `semctx`** (unscoped, verified free on npm). Install = `bunx semctx`. Product name =
   install name. The internal libs stay `@semantic-context/*` and are **not** published — they are
   inlined into the bundle.
3. **Packaging → one autonomous portable bundle.** `bun run cli:build` inlines the workspace libs
   into `apps/cli/dist/index.js`, rewrites the TypeScript compiler's build-machine paths, and ships
   its `typescript-lib/*.d.ts` files beside the bundle. This **removes the topological publish-order
   blocker**: one package to publish, not seven; no npm org to create.

## What was done here

- `apps/cli/package.json`: renamed `@semantic-context/cli` → `semctx`; `bin` → `./dist/index.js`;
  `files: ["dist", "README.md", "LICENSE"]`; `build` / `prepack` run the bundle; the
  `@semantic-context/*` deps moved to `devDependencies` (dev only; inlined at build; never
  installed by a consumer).
- `apps/cli/README.md` + `apps/cli/LICENSE` added (npm ships them from the package directory).
- Verified end-to-end: `npm pack` runs `prepack`, the tarball is installed into a clean consumer
  project, and its generated npm `semctx` bin runs `--version` plus a real `setup` outside the
  checkout.

## Release path

One-time npm configuration: register `hoklims/semctx`, workflow filename `release.yml`, and
environment name `npm` as the package's GitHub Actions trusted publisher. Protect the GitHub
`npm` environment for `v*` tags and protect matching tags from update/deletion. The workflow uses
short-lived OIDC credentials; no long-lived `NPM_TOKEN` is stored. Its permissions are split:

1. `verify` has `contents: read`, accepts only an annotated version-matching tag already on
   `origin/main`, runs the canonical gate, builds the portable CLI, embeds the immutable release
   commit as `gitHead`, and uploads the tarball plus its SHA-256;
2. `publish` has only `id-token: write`, performs no checkout or repository script, verifies the
   downloaded checksum and manifest, and publishes that exact tarball with npm trusted publishing;
3. `promote` has only `contents: write` and advances `stable` with a non-forced GitHub API update
   before creating the GitHub Release.

The jobs use Node 24 and pinned npm. The verification gate covers TypeScript, ESLint, Ruff,
workflow analysis, Python 3.10 compilation and portability smoke, tests, and plugin artifacts.

After that one-time registry setting, push the annotated release tag:

```bash
git tag -a v<package-version> -m "semctx v<package-version>"
git push origin v<package-version>
```

The tag workflow publishes npm first, advances the automation-owned `stable` branch to that exact
release commit, then creates the GitHub Release. This ordering keeps `bunx semctx@latest` and both
plugin marketplaces on the same public version. Do not push `stable` manually. All steps are
rerunnable only for the same commit: an existing npm version must expose a `gitHead` exactly equal
to the tag commit before `stable` can move. An unchanged `stable` ref or GitHub Release is treated
as already complete. npm trusted publishing also emits provenance automatically.

Local/manual fallback remains:

```bash
npm login
cd apps/cli
npm publish --access public --provenance
```

The lockstep policy resolves the release-cadence decision in
[#38](https://github.com/hoklims/semctx/issues/38): plugin-facing changes do not advance the plugin
version without advancing and publishing the npm CLI at the same version.

## Plugin runtime

The Claude Code and Codex plugins ship one byte-identical committed Bun build split across three
root-level artifacts:

| artifact | source | role |
| --- | --- | --- |
| `dist/semctx-mcp.js` | `packages/mcp-server/src/index.ts` | MCP server (agent tools) |
| `dist/semctx.js` | `apps/cli/src/index.ts` | CLI for setup / verify / shell fallbacks |
| `dist/semctx-shared.js` | shared imports from both entrypoints | fixed-name shared runtime chunk |

Each `dist/` also carries the TypeScript standard-library declarations used by the analyzer, and
the generated runtimes resolve them relative to the installed plugin directory rather than the
build checkout:

```bash
bun run plugin:build   # refresh tracked dist/* + host-generated control skills on both plugins
bun run plugin:check   # fail if any tracked artifact is missing or stale
```

Artifact generation requires the repository-pinned Bun `1.3.13`; the build fails with an explicit
version diagnostic otherwise. `plugin:check` compares the complete expected plugin artifact set
and bytes: runtime JavaScript as one exact set and TypeScript declarations as another. A missing,
stale, or extra generated file therefore fails CI. The fixed root name keeps the shared chunk
portable and deterministic across Windows and Ubuntu.

`plugin:build` also renders `plugins/*/skills/semctx-control/SKILL.md` from
`plugins/shared/skills/semctx-control/SKILL.md`: Claude gets the `${CLAUDE_PLUGIN_ROOT}` CLI rung;
Codex gets only global `semctx` instructions (#40). The template's
`{{SHARED_WORKFLOW_CONTRACT}}` region is generated from the strict
`AGENT_WORKFLOW_CONTRACT_V1` policy in `packages/control-model/src/agent-workflow.ts`. Edit that
policy for workflow semantics, the shared template for surrounding prose, and never edit the
generated host leaves.

Agent sessions should prefer the plugin-bundled CLI so a marketplace update keeps MCP and CLI in
lockstep. The npm `semctx` package remains the channel for CI, GitHub Actions, and non-plugin shells.

### Version SSOT (release lockstep)

These surfaces must share the same `x.y.z` on every plugin/CLI release:

| Surface | Path |
| --- | --- |
| Claude plugin | `plugins/claude-code/.claude-plugin/plugin.json` |
| Codex plugin | `plugins/semctx-control/.codex-plugin/plugin.json` |
| Marketplace | `.claude-plugin/marketplace.json` |
| MCP package | `packages/mcp-server/package.json` (also `McpServer({ version })`) |
| App services | `packages/app-services/package.json` |
| npm CLI | `apps/cli/package.json` (`semctx --version` / `doctor`) |

`plugins/plugin-parity.test.ts` fails CI when plugins, marketplace, MCP, app-services, or the npm
CLI package diverge. The plugin MCP/CLI entries and shared runtime chunk are rebuilt together via
`plugin:build` (same entrypoint sources). The npm CLI uses a separate `apps/cli` prepack bundle for
CI/global installs — same version number, two packagers by design.

Plugin, marketplace, MCP package and runtime versions move together. CI runs the freshness check,
rejects build-machine paths, and performs a real stdio handshake (MCP) plus a packaged CLI smoke
(`setup`, `doctor --json`, `verify diff --dry-run` on a foreign sample repo) from a copied plugin
directory on Windows and Ubuntu before the plugin snapshot is publishable.

## Deliberately out of scope (this pass)

- **Publishing the MCP server as a separate npm package.** Plugin installs use their committed,
  self-contained runtime and therefore need no global `bun link` or package publish order.
- **node compatibility.** Deferred by decision #1; the `RepositoryStore` port keeps it a
  single-file change if real demand appears.
