# ADR 0013 — Govern public changes with one local gate and one required CI result

- Status: accepted
- Date: 2026-08-02
- Related: ADR 0006 (GitHub Action), ADR 0008 (versioned machine output),
  ADR 0012 (stable MCP surface)

## Context

Semctx accepts external contributions across application services, CLI, MCP, plugins, generated
runtimes, and repository governance. The repository already documents its package boundaries and
tests compilation, behavior, and plugin parity. Those controls did not make the contribution
contract operational:

- local validation was split across several commands;
- pull-request workflows repeated the full test suite and exposed several independent, advisory
  results;
- `main` did not require a pull request or a stable CI result;
- no pull-request template classified public-contract risk;
- no ownership file routed architecture-sensitive changes to the maintainer;
- mutable action tags and disabled dependency alerts left avoidable supply-chain gaps.

Static analysis can reject mechanical defects. It cannot decide which layer owns a policy, whether
a public contract changed, or whether an accepted ADR must be revised. Contributor autonomy
therefore needs both executable gates and an explicit human authority boundary.

## Decision

### One contributor gate

`bun run verify:pr` is the canonical pre-PR command. It runs, in fail-fast order:

1. committed, staged, and unstaged diff-hygiene checks;
2. TypeScript typechecks, ESLint, Ruff, and GitHub Actions analysis;
3. Python compilation and the repository-owned portability smoke test;
4. generated plugin-runtime and cross-host parity checks;
5. the full Bun test suite.

Targeted commands remain valid during iteration. They never replace the canonical gate in PR
evidence. The release workflow invokes the same gate without a branch-diff comparison before it
publishes.

### One required CI result

Pull requests and pushes to `main` run the canonical gate on Ubuntu and Windows. A uniquely named
aggregate job, `semctx-required`, succeeds only when the complete matrix succeeds. It has no path
filter and remains stable even if internal CI jobs are reorganized.

GitHub `main` protection requires a pull request, an up-to-date successful `semctx-required`
result, resolved review conversations, and blocks deletion and force-push. Because the repository
currently has one write-capable maintainer, the ruleset does not require an approval or CODEOWNER
approval: either requirement would deadlock maintainer-authored changes. CODEOWNERS routes review;
external contributors still cannot merge their own work. The review requirement must be revisited
when a second eligible maintainer exists.

### Risk-to-authority routing

Every PR selects its highest applicable tier:

- `ROUTINE`: demonstrably behavior- and contract-preserving maintenance, including mechanical
  updates on governed files when public semantics are unchanged;
- `DOMAIN`: application behavior behind an existing public contract;
- `GOVERNED`: behavior, compatibility, packaging semantics, or enforcement changes to public
  machine contracts, authority/root policy, agent workflow, plugins, CI, or release delivery.

Governed changes require an accepted design before implementation. The accepted ADR is the design
authority, the machine source of truth implements or generates it, and the contributor guide
explains the evidence expected from a PR. Guides and transports must not duplicate feature policy.

For every new or materially modified flow, application services own use-case coordination and
complete transport-facing reports. Pure domain evaluation remains in the appropriate engine. CLI
and MCP validate transport inputs, invoke the shared use case, and project its result without
recreating policy or report semantics.

This rule is prospective. The historical context-preparation paths in
`apps/cli/src/commands/context.ts` and `packages/mcp-server/src/tools.ts` still contain direct
coordination and are explicit maintainer-owned debt. Unrelated contributions do not have to
migrate them. A material change to either flow must address the affected boundary or use an
accepted bounded migration plan. Issue
[#77](https://github.com/hoklims/semctx/issues/77) owns the cross-transport migration.

### Native supply-chain controls

- Workflow actions are pinned to full commit SHAs and retain same-line release comments.
- Dependabot maintains Bun, Python quality tools, and GitHub Actions without automerge.
- Dependabot alerts and security updates are enabled.
- CodeQL default setup analyzes the supported repository languages independently of the required
  contributor gate.
- `zizmor` statically audits repository workflows as part of quality validation.

The npm release uses three GitHub-hosted jobs with disjoint permissions. A read-only job verifies
the tag and repository, builds one tarball with the release commit as `gitHead`, records its
SHA-256, and transfers both through a short-lived workflow artifact. An `id-token: write` job with
no checkout or repository scripts verifies and publishes that exact tarball through npm trusted
publishing. Only the final promotion job receives `contents: write`; it advances `stable`
fast-forward through the GitHub API and creates the GitHub Release after npm exposes the expected
`gitHead`.

npm provenance covers the distributed tarball. Public GitHub artifact attestations are deferred
while npm is the only distributed artifact; they become relevant if separately downloadable
binaries or archives are published with a documented verification path.

## Rejected alternatives

- Mandatory local Git hooks: bypassable and an additional installation lifecycle.
- A custom architecture-policy bot: privileged, fallible, and disproportionate to the repository.
- Blanket CODEOWNERS: it would turn routine contributions into a maintainer bottleneck.
- Required signed commits, merge queue, or deployment gates: no current failure mode justifies the
  contributor cost.
- More formatter or linter rules as an architecture control: they cannot establish contract
  ownership or semantic compatibility.

## Consequences

Contributors receive one local command that matches the required repository verdict and a PR form
that makes architectural uncertainty visible before review. CI uses fewer duplicated runner
minutes while preserving cross-platform proof. Public-contract changes remain maintainer-led
without centralizing all implementation work.

The aggregate check name and ruleset are now compatibility surfaces. Renaming the check requires a
staged ruleset migration. A green gate remains necessary but not sufficient evidence for a
`GOVERNED` change; its ADR-specific negative, adversarial, parity, and real-process tests remain
part of review.

Risk classification is effect-based rather than path-based. CODEOWNERS routes review on sensitive
files, but a generated refresh or other mechanical edit with proof of unchanged contract may stay
`ROUTINE`. Conversely, a one-line semantic change to a governed surface is `GOVERNED`.

## Verification

Acceptance requires:

- unit and temporary-repository tests for the verifier and its diff hygiene;
- structural tests for workflow triggers, permissions, action pins, matrix, and aggregate result;
- `bun run verify:pr` green on Windows locally and on both GitHub-hosted CI lanes;
- a successful `semctx-required` run before the ruleset makes that exact context mandatory;
- live confirmation that Dependabot security controls, CodeQL default setup, and the `main`
  ruleset are active.
