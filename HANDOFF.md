# Semctx v0.3 delivery handoff

## Objective and authority

Deliver 0.3.3 through the existing annotated-tag release pipeline. The maintainer requested
implementation, review, correction and publication. Codex owns acceptance and external actions;
preserve every unrelated dirty checkout.

0.3.3 publishes the `ChangeImpact` v1 contract and `semctx impact diff` (ADR 0030, PR #184).
0.3.1 was published under [HOK-772](https://linear.app/hoklims/issue/HOK-772) and 0.3.0 under
[HOK-752](https://linear.app/hoklims/issue/HOK-752).
Mac/lobby performance and independent human outcomes remain NOT_MEASURED; original roadmap
criteria stay open. Publication does not complete the whole 0.3 roadmap.

## Governing sources

- [Release scope and rollback](docs/releases/v0.3.3.md); previous release: [v0.3.1](docs/releases/v0.3.1.md)
- [Delivery checkpoint](docs/implementation/v0.3-delivery.md)
- ADRs [0025](docs/adr/0025-explicit-index-recovery-records-new-verification.md),
  [0026](docs/adr/0026-repeated-index-baselines-before-optimization.md),
  [0027](docs/adr/0027-continuation-and-evidence-applicability.md),
  [0028](docs/adr/0028-explicit-config-migration-and-restoration.md),
  [0029](docs/adr/0029-guarded-content-proof-in-project-managed-hook-chains.md) and
  [0030](docs/adr/0030-change-impact-contract.md)
- [Publishing contract](docs/publishing.md), [configuration reference](docs/reference/configuration.md)
  and [contribution contract](docs/contributing/public-contracts.md)

## Resume from current evidence

Read main, annotated v0.3.3, npm gitHead, stable, GitHub Release and release-workflow jobs.
Publication and isolated Codex/Claude delivery require the same exact released commit.
An installation does not reload an existing session. OMP remains experimental and outside
two-host stable-delivery proof. Do not force stable or rewrite a published tag.

Run the unchanged canonical `bun run verify:pr` on the final staged candidate after frozen
dependency installation and artifact generation. On Windows use the real Bun binary and
platform-safe quality commands. Stage intended new files first. A changed proof surface requires
fresh aggregate independent review and observed negative witnesses. Hosted CI, merge, tag,
registry, promotion and delivery remain separate gates.

Regenerate the public demo from the candidate and, after publication, the downloaded release.
Keep runtime digests and both identities. Preserve historic pilot evidence and failed attempts.
Use only personal Hoklims Linear; never translate unknown outcomes into successful observations.
