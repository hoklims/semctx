# Semctx GitHub Action

Run `semctx verify diff` on a pull request: map the diff to affected symbols, exported
contracts, declared invariants and relevant tests, and gate the PR on a **PASS / WARN / BLOCK**
verdict. `WARN` never fails the check by default; `BLOCK` does. **No PR comments, no secrets, no
write token, read-only.**

> This is a **composite** action that sets up Bun and runs the semctx CLI, because the verify
> engine depends on `bun:sqlite` and cannot run under plain Node (ADR 0006). The annotation /
> summary / outputs / exit-code logic is a small Node adapter (`src/adapter.mjs`) that consumes
> the CLI's stable JSON report (ADR 0008).

## Usage

```yaml
name: Semctx
on:
  pull_request:
    types: [opened, synchronize, reopened]
permissions:
  contents: read
jobs:
  semctx:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0            # merge-base with the base must be available locally
      - uses: hoklims/semctx/packages/github-action@v0.1.0
        with:
          base: ${{ github.event.pull_request.base.sha }}
          head: ${{ github.sha }}
          fail-on: block
```

`hoklims/semctx` is the repository that hosts this action, pinned here at `v0.1.0`.

## Inputs

| input | default | description |
| --- | --- | --- |
| `base` | — (required) | base ref to compare against (usually the PR base SHA) |
| `head` | `HEAD` | head ref to analyse |
| `fail-on` | `block` | fail the job on `block`, `warn`, or `none` |
| `working-directory` | `.` | repository directory to analyse |
| `config-path` | `""` | optional `config.json` to use instead of the generated default |
| `report-path` | `semctx-report.json` | where the JSON report is written (in `working-directory`) |
| `upload-report` | `false` | upload the JSON report as a workflow artifact |

## Outputs

| output | description |
| --- | --- |
| `verdict` | `PASS` \| `WARN` \| `BLOCK` |
| `block-count` | number of blocking findings |
| `warn-count` | number of warning findings |
| `changed-symbol-count` | number of changed symbols |
| `recommended-test-count` | number of recommended tests |
| `report-path` | path to the written JSON report |

## What it produces

- **GitHub annotations** on the changed lines (`error` for BLOCK findings, `warning` for WARN).
- A **job summary** (verdict, findings table, recommended tests).
- The **JSON report** (stable `schemaVersion`), optionally uploaded as an artifact.
- Action **outputs** for downstream steps.

It does **not** comment on the PR. If you want a comment, add your own step that reads the
outputs — the action stays read-only by default.

## Security

- Requires only `permissions: contents: read`.
- Never uses `pull_request_target`; the standard `pull_request` trigger runs against the PR head
  checkout with a read-only token.
- No secret is required. No PR content is executed as an ad-hoc shell command; the action runs a
  fixed set of `semctx` commands via argv arrays.
- The Bun toolchain is pinned in `action.yml`.

## How it works

1. `oven-sh/setup-bun` installs a pinned Bun.
2. `bun install` in the action's own checkout.
3. `semctx init` + `semctx index` on your repository, then `verify diff --base … --head … --format
   json --output <report> --fail-on none` (always exit 0, always writes the report).
4. `src/adapter.mjs` reads the report, emits annotations + summary, sets outputs, and exits
   non-zero according to `fail-on`. The adapter is the single job-exit-code authority.
