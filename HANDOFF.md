# Semctx v0.2 delivery handoff

## Objective and authority

Deliver v0.2 through the existing release pipeline. The maintainer delegated implementation,
review, correction and delivery to Codex. Use Codex only: no Claude model calls, runners or
reviewers. Deterministic host-installation checks do not invoke a model.

The maintainer explicitly waived human participant studies. Do not recruit volunteers or schedule
J+14 follow-up. Adoption, retention, comprehension and contribution time stay NOT_MEASURED.
Thirty public changes have UNKNOWN ground truth; no accuracy or benefit claim follows from replay.

## Governing sources

- [Release scope and limits](docs/releases/v0.2.1.md)
- ADRs [0018](docs/adr/0018-packaged-first-use-demo.md),
  [0019](docs/adr/0019-local-pilot-evidence.md), [0020](docs/adr/0020-omp-standard-plugin.md),
  [0021](docs/adr/0021-voluntary-local-reports.md), [0022](docs/adr/0022-contributor-first-check.md),
  [0023](docs/adr/0023-public-evidence-page.md)
- [Delivery checkpoint](docs/implementation/v0.2-delivery.md)
- [Publishing contract](docs/publishing.md) and [pilot protocol](docs/pilot/README.md)

## Resume from evidence

Read current main, stable, v0.2.1, npm gitHead, GitHub Release and release-workflow jobs before
reporting delivery. They must identify the same immutable released commit. Host delivery is a
separate proof; existing sessions do not reload merely because installation succeeded. OMP remains
experimental and is not part of --host all attestation. Its selected installation route is the
existing semctx-stable catalogue, with an exact-tag git-subdir source and no mirror.

The public evidence page is additive under gh-pages/demo/. Preserve the existing root landing
page. Generate public data from the selected package and sanitized pilot summary; never copy raw
local reports, logs or source mappings to Pages. Keep candidate and downloaded-release identities
separate and retain failed attempts.

## Verification

Use frozen Bun dependencies, build generated plugin and CLI artifacts, then run the unchanged
canonical bun run verify:pr gate. On Windows, put the real Bun binary directory first on PATH;
Scoop wrappers and extensionless POSIX shims are not execution evidence. Quality-tool versions
come from requirements-quality.txt. Stage intended new files before the canonical gate.

A proof-system change requires fresh aggregate independent read-only review and real red/green
witnesses bound to the final candidate; local success is insufficient. Cross-platform required CI,
merge, tag publication, npm availability, stable promotion and host delivery remain distinct.
Use only personal Hoklims Linear for HOK-629/632/633/634/645 and HOK-637/642/643/644. Reconcile issue
status only after reading the corresponding proof. Historical earliest-compatibility HOK-585 and
OMP stable-attestation HOK-456 remain separate from the tested baseline.
