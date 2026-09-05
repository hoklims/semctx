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
3. `registry-ready` has no write permissions and waits up to 30 minutes for the exact published
   version to expose the tag's `gitHead`; temporary E404 means pending, while wrong/missing identity,
   access errors and deadline expiry block promotion;
4. `promote` has only `contents: write` and advances `stable` with a non-forced GitHub API update
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

npm can accept a package while its availability scan is still pending. A successful `publish`
job is therefore followed by a separate read-only `registry-ready` job. If that wait times out,
use **Re-run failed jobs** after checking registry status: the already successful publisher is not
re-executed. Do not rerun all jobs while the accepted version remains hidden. The wait never
publishes or promotes anything, and a timeout does not mean npm rejected the accepted package.

`main` is not a channel. npm `latest` and the plugin `stable` branch are the two public channels;
`main` is where development lands and no host tracks it, so **merging `main` does not update an
installed plugin**. Because a merge into `main` does not bump the version either, `main` and
`stable` routinely carry the same SemVer at different commits — compare commits, not version
strings. `semctx plugin-status` reports that comparison read-only, and never advances `stable`.

### Proving stable delivery (`deliver`)

The verified host baseline is Codex CLI **0.147.0** and Claude Code **2.1.229**:
[the successful v0.1.18 delivery replay](https://github.com/hoklims/semctx/actions/runs/33556339309)
records both resolved binary versions, successful marketplace/plugin installs, and passing
CLI/MCP smokes. These are tested versions, not a claim about the earliest historical version
that supported plugins. Local Codex CLI 0.148.0 also exposes `plugin` and `marketplace`.

Hosts without that interface have degraded support: Semctx cannot inspect or install their
plugins through its supported CLI path. Since v0.1.19, recognized parser rejections produce
`HOST_INTERFACE_UNSUPPORTED` and an upgrade remedy, not a retry of the same failed plan.
`plugin-status` JSON uses schema 2: unavailable inventory has `marketplace.configured: null`;
only a successfully observed absence is `false`. Consumers must accept schema 2 and handle
unknown values explicitly. Semctx does not read private host configuration as a fallback.

The `deliver` job runs after `promote`, never before: installing from a marketplace that has not been
advanced yet would prove the *previous* release. It stands up one throwaway home per host, installs
through each host's own supported interface — Codex `plugin marketplace add hoklims/semctx --ref
stable` then `plugin add semctx-control@semctx-stable`; Claude `plugin marketplace add
hoklims/semctx@stable` then `plugin install semctx@semctx-stable --scope user` — and archives a
versioned `stable_delivery_proof` artifact for 90 days.

**What it proves, and in what order.** That a machine with nothing installed can obtain this exact
release, and that no authority is ever relied on after the effect it was supposed to authorise. A
global preflight runs first: the tag/version identity must agree, the checkout's own `git rev-parse
HEAD` must equal `GITHUB_SHA`, both bundle witnesses must be complete and agree, and the `npm ls
--global` query must have succeeded. If
any of it fails, **neither host is installed at all** — not a marketplace add, not a plugin install.
Then, per host, the globally resolved package and the binary's `--version` banner must both equal the
pinned specifier before a single mutating command runs; the read-only `--version` probe is what
establishes that identity, so it is the one thing allowed before the gate. Only then is the host
installed, its exact marketplace source/ref/commit, resolved plugin and cache/manifest versions are
validated, and its cache is attested bundle by bundle against a witness read from the **blobs of the
published commit** (`git cat-file blob <sha>:plugins/<plugin>/dist/<bundle>`, immune to a working
tree edited after Git answers correctly). Only a host for which that complete authority holds is
executed. Both plugins are
witnessed separately and archived separately under `witnesses`; a bundle the two disagree on enters
no comparison at all. The executed payload then answers `doctor --json` at the released version and
completes a real MCP stdio handshake whose `semctx_control_status` reply must be a
`control_freshness_status` report. Its `tools/list` catalogue must be structurally valid and advertise
that tool with an input schema before the call is attempted; a non-empty array or a callable but
undiscoverable tool is not delivery. `isError: true` travels inside a syntactically valid response, so
the envelope alone is not enough.

**What actually executes is an orchestrator-owned copy of the attested bytes.** The host cache is *not*
launched. Re-admitting a path proves it is still a regular file inside the sandbox; it cannot prove
the file still holds the bytes that were digested, because a host can rewrite a regular file in place
between the two. So each bundle is read **once**, that single buffer is digested against the witness,
and — if the whole coherent set attests — the same buffers are written into two separately named
directories under the sandbox. Each copy is re-digested against the witness immediately before its
single consumer runs: the CLI copy first, then a newly created MCP copy whose path did not exist while
the CLI was executing. `executionSnapshots.cli` and `.mcp` in the artifact name them. This closes
cache rewrites and prevents the CLI smoke from changing what the MCP smoke consumes. It is **not** an
immutability or secrecy claim against an unrelated process already running as the same OS user; no
OS sandbox is present. The proof no longer asserts that the cache itself was executed, because it is
not.

**Each host is read through its own contract.** The shapes are the ones `pluginDeliveryStatus`
already parses, not a convenient approximation: Codex nests its marketplaces under `marketplaces` and
names the snapshot root `root` with the source under `marketplaceSource.source`; Claude returns a
bare array and names the root `installLocation`, with the executed cache under the plugin entry's
`installPath`. The Codex cache entry is derived by the shared authority
`codexCacheEntryFromMarketplaceRoot`, so this proof and the diagnostic cannot drift apart on where a
host executes from.

**The marketplace authority is exact, not resemblance.** The reported source is normalised exactly as
`normalizeGitSource` does in `packages/app-services/src/plugin-delivery.ts` — lowercased, `git@` form
rewritten to `https://`, URL userinfo stripped, trailing slashes and `.git` removed — and then
compared for **equality** against `hoklims/semctx` or `https://github.com/hoklims/semctx`. A matcher
that merely looked for the slug would accept `https://evil.example/hoklims/semctx.git` and
`attacker/hoklims/semctx`; both are refused here, and the accepted/refused contract is pinned by test.
The helper is currently duplicated because the shared implementation is private, so future changes
must update both until that maintenance seam is exported. The ref is its own authority: it must exist
and be exactly `stable`. Claude reports it in the marketplace list; Codex records it as `ref_name` in
`.codex-marketplace-install.json`. `main`, an empty ref and an unknown ref each fail closed.

**Nothing a host says is a location, and nothing stays admitted.** Every path a host CLI hands back
— Claude's `installLocation` and `installPath`, Codex's `root`, and the cache path derived from a
host-reported version — is admitted only after it is proven absolute, canonical, local, free of UNC
and device forms, inside the temporary sandbox, and mapped to the same resolved suffix below that
sandbox. The sandbox's physical root is the baseline, so a runner-owned junction above it is allowed
while a symlink, junction, reparse point or short-name alias at or below it is refused. Admission is
a fact about a moment, so every consumed descendant — the manifest, each `dist` bundle, each
entrypoint, the snapshot metadata — is re-admitted together with its anchor immediately before it is
read, digested or launched. A version that is not a semver token never becomes a path segment, and an escaped path
is refused lexically, so the filesystem is never even asked about it.

**Isolation: what is imposed, what is observed, and what is not.** Three distinct claims, kept
distinct on purpose because they are not the same strength.
*Imposed* — the child environment inherits nothing but a small system allow-list; every home, XDG
root, `APPDATA` and temp directory is replaced by one under the host's temporary root, and `GIT_*`,
`npm_config_*`, `NODE_OPTIONS` and `SEMCTX_ROOT` do not survive. `PATH` is carried deliberately,
because an environment that cannot launch the CLI under proof would make every host look broken.
*Observed* — every path the orchestrator itself reads, digests, writes, stats or uses as a spawn
working directory is
recorded, and the verdict fails on any entry outside the sandbox, the release checkout, the foreign
repository and the artifact path, or inside `~/.codex` or `~/.claude`.
*Not covered* — there is **no OS- or syscall-level sandbox**. The ledger does not trace what Git,
npm, a host CLI or the MCP server open once started, so an empty ledger is **not** proof that a child
never read a user profile. The artifact says so in `syscallSandbox: "none"` rather than implying
more. The orchestrator does not open the real profiles: reading them to prove they were not read
would itself be the crossing this boundary forbids. This statement does not extend to child syscalls.

**The MCP child's bounds are named for what they are.** `exchangeDeadlineMs` bounds the protocol
exchange — it is deliberately not called a total, because teardown must keep a real budget of its own:
a teardown clamped to zero would return promptly while leaving a live child behind, which is the
opposite of the guarantee. `mcpWorstCaseMs` states the actual worst case (the exchange plus every
bounded teardown wait). Within it: a cap on stdout *seen* (a server that floods without ever writing a
newline is a protocol failure, not backpressure), a cap on the stderr bytes *retained* — the stream
itself is drained continuously and without bound, which is what stops a chatty server blocking on a
full pipe — a polite termination escalated to `SIGKILL`, and bounded waits for the child and both
streams. A closed stream releases every pending request immediately. The outcome carries the child's
pid so a caller can *observe* it is gone rather than assume it.

**What it does not prove.** That any running session loaded it. `session.proven` is always `false`
with reason `SESSION_VERSION_NOT_EXPOSED`, because no supported host exposes the version a live
session holds — the same rule ADR 0014 applies to `plugin-status`. Delivery and activation stay
separate dimensions, and the artifact carries each host's exact activation action (a new Codex task;
`/reload-plugins` or a Claude Code restart) instead of a verdict. A green `deliver` job means the
next session resolves this release, never that the current one did.

**How it fails.** Fail-closed everywhere: a checkout that is not `GITHUB_SHA`, an incomplete or
divergent witness, a failed `npm ls`, an absent pinned package, a CLI whose npm version or binary
banner is not the pin, an unusable environment, a refused install, a marketplace that is not exactly
this repository on exactly `stable`, an unknown or mismatched marketplace commit, a refused or
re-refused host path, a ledger entry outside the allowed roots, a missing bundle, an undigestible
bundle, a digest that differs from the committed witness, an execution copy that does not
reproduce the attested bytes, two plugins or two hosts disagreeing on the same bundle, or a smoke
that did not run are each a named reason that clears `ok` and exits non-zero. Absence is never a
neutral state, and an invalid authority stops the effects it was supposed to authorise rather than
merely being reported afterwards.

**A failure always leaves an artifact, and the artifact is the authority.** The reservation step is
the **first** step of the `deliver` job — before the checkout, before any provisioning — and writes a
`stage: "placeholder"` JSON at the uploaded path, so a failed checkout, a failed provisioning, an
import error, a syntax error or a crash before `main()` still uploads a parseable diagnostic. What it
cannot cover is honest to state: a runner that dies before any step starts, or an infrastructure
failure that prevents the upload itself, is outside the workflow's control. The script overwrites the
placeholder with `stage: "final"`, then re-reads the bytes it just wrote and requires them to be
**byte-identical** to the rendering of the verdict this run computed. Equality is the check rather
than a structural re-validation, because a structural check still accepts a minimal hand-written
document carrying only `schemaVersion`, `kind`, `stage`, `ok`, `release` and `run`. A truncated write,
a partial rewrite, a flipped `ok`, a placeholder left in place (`PROOF_PLACEHOLDER_NOT_REPLACED`) and
a forged minimal archive (`PROOF_ARCHIVE_MISMATCH`) therefore all exit non-zero. Identity is checked
with `proofBelongsToRun` against both the release identity *and* the run identity
(`GITHUB_REPOSITORY`, `GITHUB_RUN_ID`, `GITHUB_RUN_ATTEMPT`): two attempts of one tag share a release
identity, so the attempt is what separates them, and an artifact left by an earlier attempt is a
genuine, whole proof of the wrong run.

**Host CLIs are pinned in the repository.** `HOST_CLI_SPECIFICATION` in
`scripts/compatibility.ts`, derived from `compatibility.json`, is the authority — `@openai/codex@0.147.0` and
`@anthropic-ai/claude-code@2.1.229` — and `plugins/plugin-parity.test.ts` fails when the workflow
drifts from it. A repository variable would put the identity of the interface under proof outside the
commit: an unset one is silently empty, and a changed one rewrites what a past run meant. The proof
archives all four facts per host: the package requested, the version expected, the package npm
actually resolved, and the normalised `--version` the binary on `PATH` prints. Both readings must
match the pin, because a stale global install can shadow a fresh one.

The hostile scenarios each carry a deterministic regression in
`scripts/test/prove-stable-delivery.test.ts`; the decision layer is pure, so they run without a
release. The first real post-release execution remains a live witness that no offline test replaces.

**The CLI smoke's exit code is not the verdict; `doctor --json`'s named checks are (schema v2,
HOK-582).** `semctx doctor --json` exits 1 whenever *any* of its checks is red, including
`workspace` on the throwaway foreign repository this smoke deliberately never runs `semctx init`
against — that is the expected, legitimate state, not a broken runtime. Exit 0 or 1 is accepted only
when the report is parseable, its `version` is the released one, and the two checks that actually
prove the runtime rather than the workspace — `cli` and `runtime` — are both present and `ok: true`;
any other exit code, an unparseable report, a wrong version, or a
missing/red required check stays red. The archived proof also carries `installAttempts` per host —
every official install command's argv, exit code and character-bounded stdout/stderr, whether it succeeded or
not — so a `HOST_INSTALL_FAILED` verdict is diagnosable from the artifact alone.

**Re-proving an already-published release without republishing anything.** A red `deliver` job on a
release npm, `stable` and the GitHub Release already agree on does not warrant another tag: the
`stable delivery proof (manual rerun)` workflow (`workflow_dispatch`, input `tag`) re-runs the same
proof against that exact commit. Its `identity` job fails closed — before either host CLI is
provisioned — unless the tag is annotated, the tagged commit's own `apps/cli/package.json` version
matches the tag, and npm's `gitHead`, `stable` and the GitHub Release all still resolve to that same
SHA. `deliver` then checks out the reparative `main` for the (possibly since-fixed) proof script and
its dependencies, and checks out the tag *separately* as the sole source `SEMCTX_RELEASE_CHECKOUT`
witnesses from — so a repaired `main` can never license itself with its own bundles. The workflow
archives the exact `main` commit that supplied the verifier separately from the released SHA, and
refuses a dirty tracked verifier checkout immediately before execution. It
holds no publish, tag, `stable` or Release permission; it only reads and uploads an artifact.

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

The Claude Code and Codex plugins ship one byte-identical committed Bun runtime across four
root-level artifacts:

| artifact | source | role |
| --- | --- | --- |
| `dist/semctx-mcp.js` | `packages/mcp-server/src/index.ts` | MCP server (agent tools) |
| `dist/semctx.js` | `apps/cli/src/index.ts` | CLI for setup / verify / shell fallbacks |
| `dist/semctx-shared.js` | shared imports from both entrypoints | fixed-name shared runtime chunk |
| `dist/semctx-index-worker.js` | `packages/ts-analyzer/src/index-worker.ts` | standalone TypeScript index worker |

Each `dist/` also carries the TypeScript standard-library declarations used by the analyzer, and
the generated runtimes resolve them relative to the installed plugin directory rather than the
build checkout:

```bash
bun run plugin:build   # refresh tracked dist/* + host-generated control skills on both plugins
bun run plugin:check   # fail if any tracked artifact is missing or stale
```

Artifact generation requires the repository-pinned Bun `1.4.0`; the build fails with an explicit
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

`plugin:build` also renders the shadow lifecycle hook into `plugins/*/hooks/`:
`semctx-lifecycle.mjs` is copied from `plugins/shared/hooks/semctx-lifecycle.mjs`, and
`semctx-lifecycle-contract.json` is projected from `AGENT_WORKFLOW_CONTRACT_V1` and
`AGENT_LIFECYCLE_POLICY_V1`. Both land byte-identically in each host tree and `plugin:check`
fails on drift, which is what keeps the out-of-process evaluator from restating a policy that
has moved. Edit the shared hook for behaviour and the two contracts for policy; never edit the
generated host copies. `hooks/hooks.json` is host-specific wiring and stays hand-written.

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
| OMP marketplace catalog | `.omp-plugin/marketplace.json` |
| OMP plugin manifest | `plugins/claude-code/.omp-plugin/plugin.json` |
| OMP extension manifest | `plugins/claude-code/package.json` (generated by `plugin:build`) |

`plugins/plugin-parity.test.ts` fails CI when plugins, marketplace, MCP, app-services, the npm CLI
package, or the OMP catalog/manifest diverge. The plugin MCP/CLI entries and shared runtime chunk
are rebuilt together via `plugin:build` (same entrypoint sources). The npm CLI uses a separate
`apps/cli` prepack bundle for CI/global installs — same version number, two packagers by design.

Plugin, marketplace, MCP package and runtime versions move together. CI runs the freshness check,
rejects build-machine paths, and performs a real stdio handshake (MCP) plus a packaged CLI smoke
(`setup`, `doctor --json`, `verify diff --dry-run` on a foreign sample repo) from a copied plugin
directory on Windows and Ubuntu before the plugin snapshot is publishable.

**Oh My Pi is not part of that proof.** Its two surfaces above are held at the same `x.y.z` by the
same test, so a stale OMP manifest cannot ship silently — but the `deliver` job's
`stable_delivery_proof` only ever installs and attests Codex and Claude. OMP is an experimental,
opt-in consumer of the Claude plugin tree (ADR 0015): no `plugin-status` support, no delivery
attestation, no live install/initialize evidence beyond what a contributor observes locally. That
gap is tracked in HOK-456, not closed by this table.

## Deliberately out of scope (this pass)

- **Publishing the MCP server as a separate npm package.** Plugin installs use their committed,
  self-contained runtime and therefore need no global `bun link` or package publish order.
- **node compatibility.** Deferred by decision #1; the `RepositoryStore` port keeps it a
  single-file change if real demand appears.
