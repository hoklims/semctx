# SCIP reassessment — 2026-08-16

## Outcome

The query-surface blocker is lifted. Official `scip v0.9.0 print --json` is
explicitly suitable for scripts and is not marked experimental. The prior
`expt-convert` SQLite path is no longer part of the proposed architecture.

Global adoption remains blocked only by the unreleased native-Windows fix for
`@sourcegraph/scip-python`. The upstream issue is
<https://github.com/sourcegraph/scip-python/issues/210>.

## Upstream Windows patch

Isolated clone:
`C:/Users/Hokli/.agent-reach/worktrees/scip-python-windows`

Changes:

- replace the invalid `new RegExp(path.sep, 'g')` with a separator expression
  that accepts both Windows and POSIX paths;
- add a Jest regression that imports the module on Windows and resolves both
  separator forms.

Evidence:

- regression before fix: module import fails with `Invalid regular expression`;
- targeted regression after fix: 1/1 passed;
- unit suite: 8/8 passed;
- Prettier: passed;
- development build: passed;
- real native-Windows indexing: 8/8 Python documents, 85 external symbols,
  239,722-byte SCIP artefact;
- snapshot suite reaches a separate pre-existing Windows-only editable-package
  fixture failure; the production index smoke is green.

The patch has not been committed, pushed or submitted upstream. A public PR is
an external action and remains the final operator gate.

## Stable official query surface

Official asset: `scip v0.9.0` Linux amd64, SHA-256
`fc2e7273e110be9f35924da1066000183791e8bfdb0391355de6eaaa070fec75`,
executed through WSL without a daemon.

The CLI itself warns only against scripting the TTY form; `--json` is the
supported machine-readable form.

| Corpus | Coverage | Precision | JSON parse | Parse peak | Query p95 | Full print p95 | CLI max RSS |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| TestForge TypeScript | 14/14 | 6/6 | 53.3 ms | 9.73 MB | 2.76 ms | 451 ms | 40.75 MB |
| Semctx Python | 8/8 | 2/2 | 9.1 ms | 1.78 MB | 0.30 ms | 213 ms | 30.75 MB |

Historical raw results are held in the private source skill repository and are
not bundled with the Semctx host plugins. They are available to authorized
readers at the immutable HOK-834 skill commit:

- [TypeScript pilot](https://github.com/hoklims/index-control-plane/blob/f75c6866f3f4d1b598a60f65651b04f83bec4662/evals/scip-json-typescript-2026-08-16.json)
- [Python pilot](https://github.com/hoklims/index-control-plane/blob/f75c6866f3f4d1b598a60f65651b04f83bec4662/evals/scip-json-python-2026-08-16.json)

The local clone path above records the historical patch workspace, not an
installation requirement or a currently published upstream fix.

## Routing decision

Do not enable SCIP globally yet. Once the Windows fix is present in an official
`scip-python` release, SCIP becomes eligible as a headless, durable symbol lane:

1. generate `index.scip` at a checkpoint;
2. export official JSON once per generation;
3. build or keep a bounded host-local query artefact;
4. bind it to the source fingerprint and generation;
5. keep native LSP authoritative for live editor navigation;
6. run no persistent SCIP daemon.
