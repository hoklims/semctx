# Publishing semctx to npm — state & decisions

Prep for the "publish" move (competitive-scan 2026-07: publishing is the strongest non-technical
lever against commoditisation — visibility).

**Decided 2026-07-05** (owner ratified): the CLI publishes as **`semctx`** (unscoped — the name is
free on npm), **bun-only**, as a **single self-contained bundle**. Everything below is done except
the final `npm publish`, which needs `npm login` (credentials) and is the owner's to run.

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
3. **Packaging → single autonomous bundle.** `bun build src/index.ts --target=bun --minify`
   inlines the 6 workspace libs into `apps/cli/dist/index.js` (3.8 MB — it embeds the TypeScript
   compiler, needed by `semctx index`). This **removes the topological publish-order blocker**:
   one package to publish, not seven; no npm org to create.

## What was done here

- `apps/cli/package.json`: renamed `@semantic-context/cli` → `semctx`; `bin` → `./dist/index.js`;
  `files: ["dist", "README.md", "LICENSE"]`; `build` / `prepublishOnly` run the bundle; the 6
  `@semantic-context/*` deps moved to `devDependencies` (dev only; inlined at build; never
  installed by a consumer).
- `apps/cli/README.md` + `apps/cli/LICENSE` added (npm ships them from the package directory).
- Verified end-to-end: `bun build` bundles 62 modules; the shebang is preserved; the **extracted
  tarball runs outside node_modules** — `--help`, `verify diff --dry-run`, and `doctor`
  (exercising `bun:sqlite`) all work.
- `npm pack --dry-run`: exactly 4 files (LICENSE, README.md, dist/index.js, package.json),
  1.1 MB packed / 3.8 MB unpacked.

## Final step — the owner runs this

```bash
npm login                         # or set NPM_TOKEN in the environment
cd apps/cli
npm publish --access public       # 'semctx' is unscoped → public by default;
                                  # prepublishOnly rebuilds dist/index.js from source first
```

Then tag the release: `git tag v0.1.0 && git push --tags` (and optionally announce).

`npm whoami` returned 401 in the prep session — that is the only remaining gate. Nothing about the
package is unresolved.

## Deliberately out of scope (this pass)

- **Publishing the MCP server / libs separately.** Today the Claude Code plugin wires the MCP
  server via a local path (`bun packages/mcp-server/src/index.ts`). Distributing it (e.g. a
  `semctx mcp` subcommand, or a second `bin`) is a deliberate follow-up, not a blocker for the CLI.
- **node compatibility.** Deferred by decision #1; the `RepositoryStore` port keeps it a
  single-file change if real demand appears.
