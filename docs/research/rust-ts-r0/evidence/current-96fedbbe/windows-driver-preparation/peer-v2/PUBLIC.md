## Verdict
PROOF_WEAK

## Frozen epoch

Preserved V2 component review, originally returned before V3 was supplied. This is not canonical aggregate admission.

- Repository HEAD observed: `96fedbbe14e8585ae1c89e2656604bf5ecabf2c3`.
- Branch: `codex/t00-physical-20261022`.
- Worktree: `C:/maintenence/semctx.codex-t00-physical-20261022`.
- Staged publication files were observed; canonical dirty digest unavailable.
- V2 draft freeze SHA256 matched `72311c6487f8223ce94cb5df4d47f8031008aae9839c19f962daa3f90cb51d92`.
- Helper `672067cda1a292d86dc3032950f45e5adc3428fa2d9041af4f55c08c5158bbb1`; runner `147be1d63805505691b86d269e762efed042a93422ae22429d2d59b7a96f70f1`; freezer `fee4d4bbb0ee2ec0dea044754d5e6feed52ac423c01d8902e4a3003707feaedd` matched.

## Classifier

The installed classifier was executed against the six adoption destinations. It returned `triggered:false`, all six paths unmatched, profile `semctx-v1`, registry digest `b37aa20ccd547cdae4df325c2f80da075bc8db4ea9869d67869c73d9b37efeb6`. This path result does not establish adequacy of the changed qualification mechanism.

## Claim matrix

| Claim | Enforcement / invocation | Oracle / negative evidence | Cache/environment | Status |
|---|---|---|---|---|
| Exact frozen archive, safe materialization | inspect_capsule / acquisition and freezer | Frozen hashes; supplied traversal/link/duplicate/missing/tamper controls | Opaque pinned archive | Supported within reviewed scope |
| Two distinct context projections | Frozen reader / additional acquisition | Independent expected oracle; supplied opposite-context and identity controls | Same source and SDK | Synthetic evidence only |
| Bounded candidate process | Rust caller / existing Windows acquisition | Public process API; supplied tests mock execution | Release rlibs; unique glob required | Actual execution unproven |
| Preserve four Cargo artifact identities | Existing NativeBuildIdentity; separate caller receipt | Source inspection and supplied snapshot compatibility control | Existing release dependencies | Supported structurally |
| Drift refusal across failure paths | Helper and outer finally | Supplied first-context drift control | All tracked files plus input/tool pins | Exported report inconsistency below |
| Preserve failed raw capture | Caller serialization | Process API source inspection | Lossy UTF-8 and bounded capture | Exact raw-preservation claim unsupported |
| Successor source/package freeze | Committed blob checks and inherited package hashes | Two supplied real Git refusal records | Adopted committed candidate absent | Positive freeze unproven |

## Findings

1. **P2: Failed captures are not always exact raw bytes.** V2 helper lines 79-84 write the process API's string fields to compatibility names ending in `.raw`. The API returns lossy UTF-8 decoding of bounded buffers while hashes/counts describe original streams. Malformed or over-cap output cannot support unconditional exact raw preservation. Validation refuses these outcomes; no resulting false pass was identified. Correct the representation claim or provide genuine raw capture, and verify malformed-output behavior.
2. **P2: Final drift can leave a contradictory PASS report.** V2 helper line 359 assigns PASS before final postflight. Lines 370-387 serialize that state even if postflight fails, allowing PASS with failure null and postflight_ok false. The function raises, preserving orchestration failure. Set FAILED and its diagnostic before serialization; add a control failing only after both adjudications.

No P1 implementation defect identified in the bounded V2 review. Original V2 source is retained by the author under `windows-as-expression-transport/history/v2/`; the findings above describe those frozen bytes, not subsequently changed live paths.

## Evidence boundaries

Independently observed: frozen hashes, source behavior, classifier output and Git identity/status. Supplied runner evidence inspected: 16 synthetic controls and two Git-freeze refusals; tests were not rerun by this reviewer.

No build, candidate query, host access, network action or candidate mutation was performed. Actual Windows execution, adopted-source positive freeze and canonical aggregate admission remained unproven.

Environment: fresh_session null; author_independent true; forked null; persistent_memory null (no memory files consulted); sandbox_mode danger-full-access; write_tools_enabled true. This session cannot satisfy canonical read-only audit admission. These durable review files were written only after a later explicit request to preserve the review.
