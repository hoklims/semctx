## Verdict
PROOF_WEAK

## Frozen epoch

Bounded V2-to-V3 component correction review; no canonical aggregate or delivery approval.

- V3 freeze SHA256 independently matched `bef289a7d15fbdbedff091c5d025ba89641d8fe1c283938417fdf48ec94dc2f9`.
- All 22 entries matched their frozen SHA256 and byte count.
- Helper: `ab9b10ecbc0aa322dc0138b5682f37bca160eedfaab93622160be9e1e3a02228`.
- Caller: `e4aaa0e64808a25b89854b6a7fbfe34cb297074d0f9b6d5371f1a77343d238f2`; embedded template equals caller.rs exactly.
- Delta artifact: `c5a111d9622a899fbcb2a1cdcd12e216f3b6b395860a7aa2f9213925015d5293`.
- Runner `147be1d63805505691b86d269e762efed042a93422ae22429d2d59b7a96f70f1` and freezer `fee4d4bbb0ee2ec0dea044754d5e6feed52ac423c01d8902e4a3003707feaedd` remain identical to V2.
- Historical repository identity from V2: HEAD `96fedbbe14e8585ae1c89e2656604bf5ecabf2c3`, branch `codex/t00-physical-20261022`, worktree `C:/maintenence/semctx.codex-t00-physical-20261022`. Not refreshed during V3 delta review; adopted candidate and canonical dirty digest unavailable.

## Classifier

V2 six-destination classification returned triggered false, all paths unmatched, profile semctx-v1, registry digest b37aa20ccd547cdae4df325c2f80da075bc8db4ea9869d67869c73d9b37efeb6. No V3 aggregate classifier was supplied or asserted. A full aggregate classification remains for canonical admission.

## Claim matrix

| Claim | Enforcement / invocation | Oracle and provenance | Negative witness | Cache/environment | Status |
|---|---|---|---|---|---|
| Late postflight never exports PASS | Helper lines 379-407 / additional Windows acquisition | Source diff; same designated assertion test on V2 and V3 | Supplied red exit 1 on V2 helper, AssertionError naming PASS versus FAILED; green exit 0 on V3 | Synthetic process/build mocks | V2 P2 closed within component scope |
| Capture representation is honest | Caller lines 79-101; report lines 393-394; README | Actual process API source previously inspected; V3 records bounded lossy UTF-8 representation and unchanged original counts/hashes | Supplied malformed-output fixture refused by exact size check | Actual caller execution not reviewed | V2 wording/representation P2 closed; runtime remains unproven |
| Exact success rule remains strict | validate_outcome lines 310-319 / before frozen reader | Same count/hash/cap/kind/typed-exit checks as V2; supplied 18-test output | Malformed prefix, cap, hash and bool-exit rejection controls | Synthetic DTOs | No new false-pass path identified |
| Existing acquisition and freezer behavior retained | Runner and source freezer | Exact unchanged V2 hashes | Prior component controls retain their original scope | No new build or query | Supported by source identity only |

## Findings

**Both V2 P2 findings are closed for this bounded source/evidence review. No new P1/P2 finding identified in the V3 delta.**

The late-postflight exception now sets state FAILED and appends its diagnostic before report serialization, including after two successful adjudications. The supplied designated test asserts both contexts completed, postflight false, FAILED state and the late-drift diagnostic. Its V2 failure is an assertion about the target defect, not a setup error.

The capture fix explicitly describes compatibility `.raw` files as bounded UTF-8-decoded ProcessOutcome strings; it preserves original count/hash metadata separately. It does not recover discarded original bytes. README and report now state that limit. The exact-success checks remain unchanged and reject lossy/truncated captures.

This delta review cannot serve as the sole final audit after a proof-system change. The preserved V2 report is `../windows-as-expression-peer/PUBLIC.md` and its structured companion.

## Evidence boundaries

Independently verified here: every V3 freeze entry, V2 snapshot hashes, exact helper/test/README deltas, unchanged runner/freezer hashes, caller-template equality and raw log/receipt identities. The separate runner supplied red receipt `591e907ed5cb90a66e6d6e2c8241d56b4df8016190018495c501a60286c4e8b6`, green receipt `227bb77be69e27b979782b7523313afaad89ed72a40070c6b9c9ba283ecf869b`, and 18-control receipt `52b390fc590ab6dde2a9d6055a4ebe8f89d3bd6a4dfe56174eabdeae0d94c06f`. Red/green/test commands were not rerun by this reviewer.

No checkout or scratch-candidate edits, build, candidate execution, host access or network actions. Only newly authorized review outputs were written. Root's concurrent harmless DEV compilation/captures were not consumed and are not certified here.

Actual caller compilation/capture, actual Windows two-context acquisition, positive committed-source successor freeze, exact aggregate epoch/classification and fresh canonical audit remain unproven. No ALLOW, qualification credit or R0 decision is produced.

Environment remains fresh_session null; author_independent true; forked null; persistent_memory null (no memory files consulted); sandbox_mode danger-full-access; write_tools_enabled true. This persistent component-review session does not satisfy canonical fresh read-only admission.
