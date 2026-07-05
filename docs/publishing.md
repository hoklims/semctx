# Publishing semctx to npm — state & decisions

Prep for the "publish" move (competitive-scan 2026-07: publishing is the strongest non-technical
lever against commoditisation — visibility). **Nothing is published here and no `package.json` is
flipped**; every remaining change depends on the owner decisions below.

## Current state (2026-07-05)

- **License**: Apache-2.0 (`LICENSE` present, `"license": "Apache-2.0"`).
- **Privacy**: all `packages/*` and `apps/cli` are already `private: false`; the root is
  `private: true` (correct — a workspace container is never published).
- **CLI bin**: `@semantic-context/cli` → `{ "semctx": "./src/index.ts" }` — points at TypeScript
  **source**.
- **`npm pack --dry-run` (CLI)**: ships 14 `.ts` files, 48.8 kB unpacked. **No JS build.**
- **Deps**: the CLI depends on 6 `@semantic-context/*` workspace packages (`workspace:*`).

## Blockers — decisions, not code

1. **Distribution runtime.** `bin` runs `./src/index.ts`: fine under **bun** (`bunx`), broken under
   `node`/`npx` (node cannot run `.ts`).
   - **(A) bun-only** — keep the `.ts` bin, document `bunx @semantic-context/cli`. Cheapest;
     narrows the audience to bun users.
   - **(B) node-compatible** — add a `bun build`/tsdown step producing `dist/index.js`, point `bin`
     there, add a `prepublishOnly`. Widens reach; adds a build step + `dist` to `files`.
2. **npm scope / name.** Packages are `@semantic-context/*`. Publishing under that scope needs the
   npm org `@semantic-context` to exist and the publisher to have access. Alternatives: publish the
   CLI unscoped as `semctx` (check availability first), or a personal scope.
3. **Publish order.** `workspace:*` deps must be published **first**, topologically
   (core → ts-analyzer → repository-store → context-engine → cocoindex-adapter/eval →
   mcp-server → cli), each `workspace:*` resolving to `^0.1.0`. Use `npm publish --workspaces`
   (topological) or `changesets`.

## Execution checklist (once decided)

- [ ] Pick distribution ((A) bun-only / (B) node build) and name/scope.
- [ ] If (B): add build; `bin` → `dist/index.js`; add `dist` to `files`.
- [ ] Add neutral metadata where missing: `description`, `keywords`, `repository`, `homepage`,
      `bugs`, `author` (license already set).
- [ ] `npm publish --dry-run --workspaces` — verify every tarball.
- [ ] `npm publish --workspaces --access public` (scoped packages need `--access public`).
- [ ] Tag the release; update the README install instructions.

## Deliberately not done here

No `package.json` modified, nothing published. The flip + publish is a separate, deliberate,
outward-facing step that belongs to the maintainer.
