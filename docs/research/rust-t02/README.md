# T02 preparation record

This directory prepares milestone T02 of [#365](https://github.com/hoklims/semctx/issues/365):
preserve identities, schemas, errors and offline replay (G01, G02, G06–G08, G22). That issue owns
acceptance. This record ports nothing, adds no Rust code, dependency, workflow or product change,
and declares no T02 result.

## Status

T02 depends on T01, which depends on T00. #365 forbids substantial ports before T00 reaches
`READY_TS_NATIVE` and T01 passes `ECONOMIC_PROTOTYPE_PASS`; neither has happened. On 2026-10-19
the owner asked for the maximum T02 work possible in that state. This record is that work: an
inventory of the current TypeScript contracts T02 must preserve, observed vectors from those
contracts, the gaps a cross-replay would hit, and the decisions T02 needs before it can start.

It does not replace the T02 qualification: #365 states that R0 vectors do not, and neither do
these. Everything below describes TypeScript as it is; no Rust behavior is claimed.

## Base

Product sources are read at the stack base, `main` `948817473317411b617f238a9e22f46eca5933af`.
On 2026-10-19 `main` had moved on, but `git diff` from that base to `origin/main` is empty for
every source path cited here. The inventory was gathered by three read-only searches, one per
obligation group. Their key claims were then re-read in the source; claims marked *unverified*
were not.

## Findings

1. **Two canonical JSON contracts coexist, and they order keys differently.** Three primitives
   sort keys and then call `JSON.stringify`: `canonicalJson` in `packages/core/src/canonical.ts`
   and `packages/plane-a-internal/src/canonical.ts`, and `serializeControlReport` in
   `packages/control-model/src/canonical.ts`. JavaScript objects emit integer-like keys first, in
   numeric order, so these produce `{"2":…,"10":…,"a":…}`. The change-authorization JCS
   (`packages/control-model/src/change-authorization-canonical.ts`) serializes by hand in pure
   UTF-16 order: `{"10":…,"2":…,"a":…}`. The two also disagree on `undefined` members (omitted
   against rejected) and lone surrogates (escaped against rejected). T00's
   `tools/rust-ts-r0/src/identity.rs` `canonical_json` reproduces the first contract, integer-key
   rule included. It must not be reused for the second. See [vectors.json](vectors.json).
2. **Both contracts order keys by UTF-16 code units, not by code points.** Every primitive emits
   `"a"`, then U+10000, then U+E000. A Rust sort over `char` or UTF-8 bytes would emit U+E000
   before U+10000.
3. **Edge and claim identities hash 32 bits.** `edgeId` and `claimId`
   (`packages/core/src/ids.ts:196`, `:204`) use FNV-1a 32 bits over UTF-16 code units. T01
   already recorded a real collision on VS Code `5b23ab3` that stops assembly with
   `FACT_ID_CONFLICT` (`docs/research/rust-t01/README.md`, checkpoint 1). The 128-bit
   requalification exists only in T01's measurement checkout; the product is unchanged.
4. **`edgeId` has a separator ambiguity, independent of the hash width.** It hashes
   `` `${from}->${to}` `` without escaping. `edgeId("calls", "a->b", "c")` and
   `edgeId("calls", "a", "b->c")` both give `edge:calls:ec262871`. A node id containing `->`
   (for example a path segment on a file system that allows `>`) is enough. Widening the hash
   does not fix it.
5. **The public `VerifyReport` schema has two strictness levels.** The core schema accepts
   additive fields (`.passthrough()`, `packages/core/src/verify-report.ts:216`). The MCP output
   schema rejects them (`.strict()`, `packages/mcp-server/src/tool-output-schemas.ts:173`). No
   test pins the MCP behavior.
6. **Exit codes differ by surface for the same input class.** An invalid `--fail-on` exits 1 in
   the CLI (`apps/cli/src/commands/verify.ts:65-72`, `apps/cli/src/index.ts:222-226`) and 2 in
   the Action adapter (`packages/github-action/src/adapter.mjs:123-126`). CLI exit 3 means both
   a policy BLOCK and `CONTROL_INPUTS_UNSAFE`.
7. **Python line starts split on LF only.** `packages/python-analyzer/src/index.ts:107-111`
   records a line start after code unit 10 alone, so a CRLF line's end column includes the CR.
   No Python test contains `\r`.
8. **Three sorts use `localeCompare` on identities.**
   `packages/app-services/src/reconciliation-index.ts:836`, `:903` and `:1172` sort source-change
   keys, hunk identities and requirement ids with `localeCompare`, unlike the code-unit policy of
   `compareIds`. Whether the order reaches a hashed or public output is *unverified*. A Rust port
   needs a pinned answer either way: `localeCompare` depends on ICU data.

## Inventory

Each row names the TypeScript source of truth, the frozen vectors that already exist, and the
gaps a cross-replay would hit. "Frozen" means a literal expected value in a test or fixture;
property tests are listed only where no frozen vector exists.

### G01 — VerifyReport v1 (ADR 0008, accepted)

| Contract | Source of truth | Frozen vectors | Gaps |
| --- | --- | --- | --- |
| Schema v1, additive fields | `packages/core/src/verify-report.ts:13`, `:197-216` (Zod, no JSON Schema in the repository) | None; field assertions in `apps/cli/test/verify-cli.test.ts:68` | No golden report; no MCP strictness test (finding 5) |
| Null and absence | `base`, `mergeBase`, `range` nullable; `file`, `line`, `impactedConsumers`, `coChangedFiles`, `analysisAdmission` optional (`verify-report.ts:198-215`); omissions in `packages/context-engine/src/verify-diff.ts:868-940` | Null git meta in `packages/context-engine/test/verify.test.ts:407` | No test rejects `line: null` or `file: null`, or a missing `base` |
| Key order on output | Literal insertion order (`verify-diff.ts:909-938`), then `analysisAdmission` (`packages/app-services/src/verify.ts:1105`); `JSON.stringify(…, null, 2)` (`apps/cli/src/output.ts:70`) | None | No byte-exact payload across CLI, Action and MCP |
| Derived renderings | Text from the internal result (`apps/cli/src/commands/verify.ts:116`); GitHub in the CLI (`:97-113`) and the Action (`packages/github-action/src/adapter.mjs:28-64`) | Inline reports in `packages/github-action/test/adapter.test.ts:35-41` | The two GitHub renderings guard line numbers differently (`verify.ts:106`, `adapter.mjs:39`) |
| Schema contradiction refusal | `superRefine` in `verify-report.ts:37-63`, `:216-219` | Property tests in `packages/core/test/qualified-report-scope.test.ts:32-58` | None found |

### G02 — PASS/WARN/BLOCK and fail-on (ADR 0035, accepted)

| Contract | Source of truth | Frozen vectors | Gaps |
| --- | --- | --- | --- |
| Verdict | `packages/context-engine/src/verify-diff.ts:666-670` | None | No multi-case PASS corpus |
| CLI exit | `apps/cli/src/commands/verify.ts:75-79`, `:281` (rejected admission exits 3 under any fail-on) | `packages/app-services/test/qualified-post-image-failure.test.ts:118` (3 under `none`) | No CLI test of WARN under `--fail-on warn`; operational exit 1 asserted only as non-zero |
| Action exit | `packages/github-action/src/adapter.mjs:67-87` (1), `:106-128` (2) | `packages/github-action/test/adapter.test.ts:118`, `:142-150`, `:165` | Finding 6 is untested on both sides |

### G06 — identities (core `ids.ts`)

| Contract | Source of truth | Frozen vectors | Gaps |
| --- | --- | --- | --- |
| Symbol id, no line | `packages/core/src/ids.ts:68-88`, parse `:112-131`, legacy `:146-153` | `packages/core/test/ids.test.ts:16`, `:27-33`, `:37-39`, `:47-48`, `:65` | No nesting of depth three or more with a repeated name |
| FNV-1a 32, UTF-16 input | `ids.ts:37-45` | None in tests; observed values in [vectors.json](vectors.json) | No test calls `fnv1a`, `edgeId`, `claimId` or `evidenceId` with a literal; no non-ASCII or astral input |
| Edge, claim, evidence ids | `ids.ts:196-207` | None | Findings 3 and 4 |
| Path normalization | `ids.ts:10-12` (backslash to slash, leading `./`; no NFC, no `..` rejection) | None | Unlike `packages/control-model/src/hashing.ts:30-42`, which applies NFC and rejects absolute, drive, `.` and `..` segments |
| Code-unit ordering | `compareIds`, `ids.ts:33-35`; `packages/control-model/src/ordering.ts:2-4` | Semantic link order in `packages/semantic-engine/test/link-diagnostics.test.ts:122-124` | Finding 8 |

### G07 — ranges and coordinates

| Contract | Source of truth | Frozen vectors | Gaps |
| --- | --- | --- | --- |
| `EvidenceRef` lines only, one-based | `packages/core/src/types/graph.ts:13-19`; validator `packages/core/src/repository-schemas.ts:62-68` | None | — |
| Python offsets (zero-based UTF-16), lines and columns (one-based UTF-16) | `packages/python-analyzer/src/index.ts:17-25`, `:107-140` | `packages/python-analyzer/test/python-extractor.test.ts:174-197` (astral on other lines only) | No column after a surrogate pair on the same line; no CRLF (finding 7), BOM or tab column test |
| TypeScript lines | `packages/ts-analyzer/src/ts-symbols.ts:233-235` (no column emitted) | None | No BOM, shebang, astral or CRLF test on symbol coordinates |
| Expected coordinate vectors | `docs/research/rust-ts-r0/cases/annexes/encoding-coordinate-expectations.json`, `primitive-inputs.json` (R01–R06) | Hand-computed, marked `PENDING_REVIEW_NOT_NATIVE_PROOF` | Not produced by the TypeScript extractors |

### G08 — three source identities (ADR 0010, ADR 0035, both accepted)

| Identity | Source of truth | Frozen vectors | Gaps |
| --- | --- | --- | --- |
| Plane A source: CRLF to LF | `packages/plane-a-internal/src/canonical.ts:5-7`; used in `packages/app-services/src/freshness.ts:296`, `:312` | CRLF and LF equal in `packages/app-services/test/freshness.test.ts:195-225` | — |
| Qualified raw inputs | `freshness.ts:312` (raw bytes for `.rs`); ADR 0035 | None located | Computation of the qualified digest is *unverified* |
| L0 raw hunks | `packages/context-engine/src/observed-diff.ts:62-76`; frame `packages/control-model/src/hashing.ts:14`, `:44-77` | Literal identity and frame in `packages/context-engine/test/observed-diff.test.ts:14-39`; CRLF differs from LF at `:41-63` | No single witness changing each identity separately; no BOM hunk |

### G22 — capsules and offline verifier (ADR 0016, ADR 0017, both accepted)

| Contract | Source of truth | Frozen vectors | Gaps |
| --- | --- | --- | --- |
| JCS | `packages/control-model/src/change-authorization-canonical.ts:58-156` (`-0` to `0`, non-finite, `undefined` and lone surrogates rejected) | Literals in `packages/control-model/test/change-authorization-contract.test.ts:498-514` | Number formatting is `JSON.stringify`, never tested against RFC 8785 cases; no astral key |
| Domain hashes | `change-authorization-canonical.ts:20-29`, `:54-56`; verifier report domain in `packages/change-authorization-verifier/src/canonical.ts:8` | Ten domains over `{"a":1}` in `change-authorization-contract.test.ts:584-605` | Report domain absent from the golden set; no vector covers the pre-hash normalizations (sort, deduplication) |
| Verification report | `packages/change-authorization-verifier/src/verify.ts:47-196`; reasons in `src/types.ts:11-54` | One `PASSED` vector: `test/fixtures/frozen-request.json`, `frozen-report.json`, `frozen-report.jcs.txt` | No frozen `FAILED`, `REQUIRE_EVIDENCE`, `CAPSULE_SCHEMA_INVALID` or expiry vector; the fixture is generated by the code it checks |
| Time and reuse | `packages/control-model/src/change-authorization-timestamp.ts:5-18`; `packages/change-authorization-verifier/src/reuse.ts:43-81` | Tables in `test/timestamp-contract.test.ts:11-18` and `test/reuse.test.ts:28-32`, `:86-97` | No frozen reuse refusal |

The specification and the code disagree on two points, *unverified* beyond the lines cited:
`docs/architecture/change-authorization-v1.md:185-212` names `replayChangeAuthorizationV1` and
`*_MISMATCH` codes, while the code exposes `verifyChangeAuthorizationCapsuleV1` and
`*_REDERIVATION_MISMATCH`; the specification rejects an invalid schema immediately, while the code
still returns a full report.

Other artifacts hashed with the first canonical contract — handoff v2, continuation, task
envelope, agent lifecycle, freshness seal (`packages/control-model/src/`) — share finding 1 and
fall to T08 for their own semantics.

## Decisions T02 needs before it starts

These fall under D4 of #365 (public formats, invalidation of old indexes, migration, restoration
and coexistence decided before mutation). This record raises them; it decides none.

- Edge and claim identity: keep FNV-1a 32 bits with its known collision, or change the format.
  A change invalidates existing indexes and needs a migration or coexistence rule. Finding 4
  applies in either case.
- Which artifacts keep the integer-key-first canonical contract and which move to the JCS, or
  whether both survive as named contracts. A Rust port must reproduce each one exactly, so the
  choice has to be explicit.
- Whether the `localeCompare` sorts of finding 8 are part of a public order. If they are, pin
  them in code-unit order before the port; if not, record that they are internal.

## Machine record

[vectors.json](vectors.json) records the observed outputs of the TypeScript primitives on
targeted inputs, with the probe's provenance. They are observations of the current code, not
independent expectations.
