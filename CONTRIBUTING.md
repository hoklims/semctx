# Contributing to semctx

For a clean clone, start with [your first check](docs/contributing/first-check.md). It diagnoses
prerequisites and runs explicit existing test scopes; the required CI plan selects the affected
gates under [ADR 0031](docs/adr/0031-change-scoped-ci-gates.md). The [packaged first-use demo](docs/contributing/first-use-demo.md) exercises the
public journey without writing authored declarations or installing a global plugin. The
[packaged continuity demo](docs/contributing/continuity-demo.md) exercises task/plan/reconcile,
Control Handoff v2 capture/explain, staleness detection, and a refused resume, end to end.

<!-- semctx:compatibility:start -->
Semctx **0.4.2** requires **Bun >=1.4.0**.
The supported, tested host baseline is **Codex 0.147.0** and
**Claude Code 2.1.229**. Other host versions are **unknown** until tested;
these pins do not claim the earliest historically compatible versions.
[Baseline delivery evidence](https://github.com/hoklims/semctx/actions/runs/34664142432).
Installation does not reload an active session: open a new Codex task, or run
`/reload-plugins` in Claude Code (restart if reload fails).
<!-- semctx:compatibility:end -->

Thanks for your interest. semctx is a local-first, deterministic change-impact analyzer. Changes
must preserve its evidence, authority, compatibility, and transport-parity guarantees.

## Development setup

Compatibility declarations are derived from `apps/cli/package.json` and `compatibility.json`.
After an intentional version change, run `bun run compatibility:write`; the canonical pre-PR
gate checks these declarations. A changed host pin still needs the real delivery proof.

```bash
bun install
python -m pip install --requirement requirements-quality.txt # use an activated venv locally
```

For iteration, run the narrowest relevant checks:

```bash
bun run quality
bun test packages/app-services
bun test packages/mcp-server
bun run plugin:build && bun run plugin:check
```

Before opening or updating a PR, run the affected local checks and inspect the required CI plan.
Use the complete local gate for a release, uncertain impact or an uncovered obligation:

```bash
bun run verify:pr
```

Stage every intended new file first. The gate rejects any remaining non-ignored untracked file so
that a contributor cannot accidentally omit new source, tests, documentation, or generated output
from the reviewed change.

### Analyze this repository with HEAD

For repository dogfooding and project-configuration evidence, run the CLI source from this
checkout. The root `semctx` script runs `bun apps/cli/src/index.ts`; it does not resolve a
published package or a global binary. From the repository root:

```bash
bun run semctx index
bun run semctx status --json
bun run semctx index-health --json
bun run semctx semantic check --json
bun run semctx verify diff --base upstream/main --format json
bun run semctx change verify change.semctx.project-evidence-config --base upstream/main --format json
```

Fetch `upstream/main` first, or use the actual integration base ref of your checkout. After a
rebase invalidates recorded verification evidence, use `bun run semctx index --record` to
rebuild and verify the working tree. Report freshness, coverage and verification verdicts
separately; a successful index is not evidence of complete coverage or passing runtime tests.
Use this same source entrypoint for any project-managed hook that analyzes this repository.
Published npm packages and pinned consumer Actions remain appropriate for installation,
release-delivery checks and demos that exercise the packaged consumer journey.

The selected CI gates and `semctx-required` must pass on the exact PR SHA. Targeted local checks
must state what they cover; they do not count as a full `verify:pr` result. See the
[public-contract contributor guide](docs/contributing/public-contracts.md) for change tiers,
authority, design, compatibility, test, and generated-artifact requirements.

## Ground rules

- **Determinism is a hard invariant.** Outputs depend only on repository state and explicit
  inputs such as the injected clock. Avoid ambient time and randomness, and sort collections
  before they reach an output.
- **Every conclusion points to evidence.** New nodes and claims carry their `EvidenceRef`s.
- **Proof language stays exact.** Do not call an inference verified or a heuristic exact. Keep
  freshness, completeness, precision, authority, and gate admissibility distinct.
- **Respect the layering for new or materially changed flows.** Analyzers parse, stores persist,
  and the appropriate engine owns pure, reusable domain evaluation. `app-services` coordinates
  use cases and constructs complete transport-facing reports; CLI and MCP should remain thin
  transports. Two historical flows do not yet meet that target:
  `apps/cli/src/commands/context.ts` and `packages/mcp-server/src/tools.ts`. Their migration is
  maintainer-owned debt, not a prerequisite for an unrelated contribution. If a change materially
  modifies either flow, coordinate its boundary treatment with the maintainer.
- **Tests prove behavior.** Add a case that fails before the change and passes after it; use
  negative, adversarial, parity, and real-process coverage when the contract guide requires it.
- **Keep static analysis semantic.** TypeScript uses `tsc` and ESLint; maintained Python quality
  scripts use the pinned tools in `requirements-quality.txt`. Suppressions must be local and
  explain why the code is safe.

## Commit and PR conventions

- Work on a branch and keep commits cohesive.
- Update affected documentation and generated artifacts in the same PR.
- Record each applicable public-contract requirement in the PR evidence. Mark a requirement
  `N/A` only with a reason.
- Do not open or update a PR with a known failing affected check.
- Changes to the **public MCP surface** (tool registration, error catalogue, structured
  schemas, agent success gates, annotations, visibility, root confinement, plugin parity)
  should also follow
  [docs/contributing/public-mcp-contracts.md](docs/contributing/public-mcp-contracts.md)
  and [ADR 0012](docs/adr/0012-mcp-2026-stable-surface.md).
