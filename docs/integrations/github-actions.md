# GitHub Actions integration

Gate pull requests with `semctx verify diff`. The action maps the PR diff to affected symbols,
exported contracts, declared invariants and relevant tests, and fails the check on `BLOCK`.

## Quick start

Copy [`examples/github-actions/semctx.yml`](../../examples/github-actions/semctx.yml) to
`.github/workflows/semctx.yml`. It already targets `hoklims/semctx`, the repository that hosts the
action, so no edit is needed. That is the whole setup — no secrets, no app install, no account.

```yaml
permissions:
  contents: read            # least privilege
steps:
  - uses: actions/checkout@v4
    with:
      fetch-depth: 0        # required: the merge-base with the base must be local
  - uses: hoklims/semctx/packages/github-action@v0.1.0
    with:
      base: ${{ github.event.pull_request.base.sha }}
      head: ${{ github.sha }}
      fail-on: block        # BLOCK fails; WARN does not
```

## The two profiles

| profile | `fail-on` | effect |
| --- | --- | --- |
| standard (`semctx.yml`) | `block` | `BLOCK` fails the check; `WARN` is advisory (annotations only) |
| strict (`semctx-strict.yml`) | `warn` | `BLOCK` and `WARN` both fail the check |

Start with standard. `BLOCK` is meant to be rare and actionable (an invariant or a critical,
`critical`/`security`-tagged contract changed without a covering test). Move to strict only when
your team has agreed to treat advisory findings as blocking.

## Why `fetch-depth: 0`

semctx computes the real merge-base between the PR base and head, and **never fetches
implicitly**. A shallow checkout (the default `fetch-depth: 1`) does not contain the base commit,
so the merge-base cannot be computed. `actions/checkout` with `fetch-depth: 0` provides the full
history. If the base is missing, the action fails with a clear message pointing here.

## Reading the results

- **Annotations** appear inline on the changed lines (error = BLOCK, warning = WARN).
- The **job summary** shows the verdict, a findings table, and recommended tests.
- **Outputs** (`verdict`, `block-count`, `warn-count`, `changed-symbol-count`,
  `recommended-test-count`, `report-path`) are available to later steps — e.g. to post your own
  comment or upload the report. The action itself never comments on the PR.
- Set `upload-report: "true"` to keep the JSON report (stable `schemaVersion`) as an artifact.

## Security notes

- Uses the standard `pull_request` trigger, never `pull_request_target` — no elevated token is
  exposed to PR content.
- Requires only `contents: read`. No secret is needed for the standard integration.
- The action runs a fixed set of `semctx` commands (argv arrays, no shell interpolation of PR
  content) plus a small Node adapter. It does not execute arbitrary PR scripts.

## Monorepos and custom config

- `working-directory`: point the action at a sub-package to analyse only that directory.
- `config-path`: supply a `config.json` (e.g. a monorepo `include` of `packages/*/src/**/*.ts`)
  to use instead of the generated default.

## Packaging note (ADR 0006)

This is a composite action that sets up Bun and runs the CLI, because the verify engine uses
`bun:sqlite` and cannot run under plain Node. The annotation/summary/exit-code adapter is pure
Node and consumes the CLI's versioned JSON report (ADR 0008).
