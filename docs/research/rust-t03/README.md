# T03 preparation record

This directory prepares milestone T03 of [#365](https://github.com/hoklims/semctx/issues/365):
preserve storage, capture and durable files under failure (G15, G16, G26). That issue owns
acceptance. This record ports nothing, adds no Rust code, dependency, workflow or product change,
and declares no T03 result.

## Status

T03 depends on T01 and T02. #365 forbids substantial ports before T00 reaches `READY_TS_NATIVE`
and T01 passes `ECONOMIC_PROTOTYPE_PASS`; neither has happened. As for
[T02](../rust-t02/README.md), the owner asked on 2026-10-20 for the T03 work possible in that
state: an inventory of the TypeScript storage, capture and file contracts, observed engine
settings, the gaps a Rust qualification would hit, and the decisions T03 needs before it starts.

#365 requires real Git and real SQLite under real crashes for T03, and states that a database
"in the same format" is not that proof. Nothing here is that proof. Everything below describes
TypeScript as it is; no Rust behavior is claimed.

## Base

Product sources are read at the stack base, `main` `948817473317411b617f238a9e22f46eca5933af`.
On 2026-10-20, `git diff` from that base to `origin/main` touches only
`packages/app-services/src/analyzer-identity-generated.ts` among the paths cited here: that file
is the regenerated identity hash after #415. The inventory was gathered by three read-only
searches, one per obligation. Their key claims were then re-read in the source; claims marked
*unverified* were not.

## Findings

1. **The store's durability comes from the SQLite build, not from the code.** The writer sets
   `busy_timeout`, `journal_mode = WAL`, `foreign_keys = OFF` and disables persistent WAL
   (`packages/repository-store/src/store.ts:212-224`). It never sets `synchronous`. With Bun
   1.4.3 on Windows, the bundled SQLite 3.53.4 is compiled with `DEFAULT_WAL_SYNCHRONOUS=2`, so
   writes run at `FULL` ([probes.json](probes.json)). Bun is documented to use the system SQLite
   on macOS instead (*unverified here*), so the effective setting may already differ per
   platform. A Rust store must set the level explicitly, or prove it matches.
2. **The store never refuses a schema version; only the freshness seal compares it.**
   `PRAGMA user_version` stays 0. The version lives in `meta.schema_version`, rewritten to `1`
   on every writer open (`store.ts:224`), so a writer silently restamps any older file. The
   control path reads it into the seal (`packages/app-services/src/control.ts:276-285`), and a
   mismatch or absence makes the seal stale with `STORE_SCHEMA_MISMATCH` or
   `STORE_SCHEMA_UNAVAILABLE` (`packages/control-model/src/freshness.ts:65-77`). Opening a
   database of another version is therefore not refused today; T03 has to decide whether a Rust
   store keeps that (D4).
3. **The immutable reader is guarded only by a sidecar check.** `SqliteRepositoryReader.openExisting`
   opens `?immutable=1` read-only (`store.ts:166-171`). Immutable mode tells SQLite the file cannot
   change, so the only protection against a live writer is the refusal when `-wal` or `-shm`
   sidecars exist (`store.ts:154-164`). The window between that check and the open is not tested.
4. **Only qualified indexes are marked incomplete before a rebuild.** `prepareRepositoryIndex`
   sets `qualified_analysis_build_v1 = "incomplete"` only when the configuration is qualified
   (`packages/app-services/src/indexing.ts:203-206`). The completion mark is written in the same
   transaction as the snapshot. An ordinary rebuild relies on the transaction alone. G16 says
   "rebuild marks the old index incomplete"; today that holds for the qualified profile only.
5. **Drift during capture is refused under `GIT_ERROR`.** After analysis, the final observation
   recomputes the Git state, input hash, discovery ledger, workspace projection, semantic model,
   observed index and lifecycle, and refuses any difference with `GIT_ERROR`, "repository inputs
   changed while the index was being built" (`indexing.ts:304-316`). The code is a public error
   category that a port must keep, or change under D4.
6. **The ordinary capture identity omits lockfiles and the analyzer identity.** The qualified
   input digest hashes raw bytes and includes lockfiles, manifests and the analyzer identity
   (`packages/app-services/src/freshness.ts:208-272`). The ordinary `analysisInputHash`
   (`freshness.ts:275-316`) hashes canonical text of the discovered files, configuration and Rust
   inputs only; manifest drift reaches it through the workspace projection digest. The seal's
   `toolVersion` is `package@version`, not the analyzer identity.
7. **Two durability levels coexist for files outside the database.** The config migration
   coordinator writes a temporary file, fsyncs it, renames it, fsyncs the directory and reads it
   back (`packages/repository-store/src/config-migration-store.ts:109-167`, `:335-364`). The
   generic writer `writeFileNoFollow` (`packages/repository-store/src/workspace.ts:101-126`) and
   the feedback store (`packages/repository-store/src/feedback-store.ts:118-155`) rename without
   any fsync. On Windows, a failed directory fsync is tolerated for five error codes
   (`config-migration-store.ts:109-123`).
8. **A killed feedback writer leaves its lock behind by design.** The lock is created with `wx`
   and removed in `finally`; a killed process leaves it, and the next writer gets `STORE_ERROR`
   with a manual-recovery message (`feedback-store.ts:128-140`; ADR 0021). No test kills a real
   feedback writer.
9. **Hard links are not detected.** Link refusal is an `lstat` of each ancestor under the root
   (`workspace.ts:77-88`) plus `realpath` confinement in the feedback store; nothing checks link
   counts, and ADR 0028 says so.

## Inventory

Each row names the TypeScript source of truth, the tests that use real processes or real
concurrency, and the gaps. Frozen database or file fixtures do not exist for any of these
contracts: every test builds its fixtures at run time.

### G15 — repository store (ADR 0001, accepted)

| Contract | Source of truth | Real-process tests | Gaps |
| --- | --- | --- | --- |
| Schema | `packages/repository-store/src/schema.ts:3-76` (seven tables, no foreign keys) | — | No frozen database for a cross-version replay; finding 2 |
| Engine settings | `store.ts:212-224`; close checkpoints with `TRUNCATE` and returns to `DELETE` (`store.ts:310-342`) | — | Finding 1; `bun:sqlite` `transaction` begin mode *unverified* |
| Atomic publication | `replaceIndex`, one transaction (`store.ts:240-251`) | SIGKILL before and after commit (`packages/repository-store/test/store-process-crash.test.ts:203-273`) | One pre-commit kill point only (during metadata writes); none during row replacement or the closing checkpoint; no power-loss test |
| Contention | `busy_timeout` 1000 ms, no lock file (ADR 0025) | Child-process holder (`store-contention.test.ts:45-134`) | Timing bounds of 800–4000 ms |
| Load validation | Row decoders (`store.ts:529-583`), `STORE_ERROR` "invalid persisted repository row" | — | Truncated or wholly corrupt file not covered |
| Read-only reader | `store.ts:147-202` | — (tree hash unchanged in `readonly-store.test.ts:30-68`, same process) | Finding 3; no concurrent writer in a separate process |

### G16 — capture and freshness (ADR 0035, accepted; ADR 0025, accepted)

| Contract | Source of truth | Tests | Gaps |
| --- | --- | --- | --- |
| Incomplete mark | `indexing.ts:203-206`, read in `packages/app-services/src/verify.ts:1092` | No test names `qualified_analysis_build_v1` | Finding 4; no test interrupts a qualified rebuild and checks the mark |
| Final observation | `indexing.ts:271-328` | In-process barrier: source edit, config, `package.json`/`pyproject.toml` (`packages/app-services/test/indexing-toctou.test.ts:113-155`) | Add, delete, rename and HEAD moves during the window are checked in code but not exercised |
| Captured inputs | Qualified `freshness.ts:208-272`; ordinary `:275-316` | Lifecycle edits before indexing (`index-lifecycle.test.ts:196-326`) | Finding 6; no refusal test for an analyzer identity or lockfile change |
| Seal | `packages/control-model/src/freshness.ts:44-84`; built in `indexing.ts:356-407` | — | No explicit reseal refusal; it follows from recomputation only |
| A→B→A | — | Verify-side (`verify-index-binding.test.ts:113`) and recovery-side (`index-recovery.test.ts:317`, `:341`) | No index rebuild with source bytes restored during the window |
| Concurrency | — | Two linked worktrees in child processes (`index-lifecycle-concurrency.test.ts:150`) | Not two writers on one index |

### G26 — durable files outside the database (ADR 0021, ADR 0028, both accepted)

| Contract | Source of truth | Real-process tests | Gaps |
| --- | --- | --- | --- |
| Config migration | Plan, PREPARED, APPLYING, APPLIED; restore RESTORING, RESTORED (`packages/app-services/src/config-migration.ts:560-695`); coordinator `coordinator.db` with `BEGIN IMMEDIATE` (`config-migration-store.ts:385-461`) | SIGKILL at five persistence boundaries (`packages/app-services/test/config-migration-crash.test.ts:443-560`) | Disk-full and other I/O failures are simulated only |
| Feedback store | `{schemaVersion: 1, records}` (`packages/core/src/feedback-report.ts:82-115`); lock and digest compare-and-swap (`feedback-store.ts:118-155`) | — (`feedback-store.test.ts:43` simulates the lock with a file) | Findings 7 and 8; no two-process writer test |
| Generic writes | `writeFileNoFollow` for config, verification state, context packs (`workspace.ts:101-126`) | Two concurrent writer processes (`workspace-concurrent-writes.test.ts:119`, *body unverified*) | Finding 7 |
| Local reports | `apps/cli/src/report-output.ts:23-79` (new file refuses overwrite; replacement through a temporary file) | Real CLI processes (`apps/cli/test/local-reports.test.ts:39-147`) | The support preview test checks the report kind, not the absence of paths or environment values |
| Privacy | Closed support schema (`packages/core/src/support-report.ts:4-55`); feedback aggregate (`feedback-report.ts:223-281`) | `local-reports.test.ts:81` checks a secret note is absent from the export | — |
| Links and escape | `workspace.ts:40-88`; `feedback-store.ts:42-74`; `report-output.ts:15-61` | Junction and dangling-link refusals (`feedback-store.test.ts:88`, `:97`) | Finding 9 |

## Decisions T03 needs before it starts

These fall under D4 of #365. This record raises them; it decides none.

- The SQLite durability level a Rust store sets explicitly, per platform (finding 1), and
  whether the TypeScript store pins the same level before the port so both can be compared.
- Whether a store refuses, restamps or migrates a database of another `meta.schema_version`
  (finding 2), and whether an old index is invalidated, migrated or read during coexistence.
- Whether ordinary rebuilds get the incomplete mark (finding 4), or the obligation is scoped to
  the qualified profile in writing.
- Whether the files outside the database keep two durability levels (finding 7), and whether a
  stale feedback lock stays a manual recovery (finding 8).

## Machine record

[probes.json](probes.json) records the SQLite engine settings observed under the TypeScript
store, with the probe's provenance. They are observations of one host, not platform guarantees.
