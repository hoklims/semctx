# Final one-file path-repair review

Reviewed 2026-11-17. Read-only code and raw-evidence review; no source edits, tests, native campaign or private-input access performed by this reviewer.

**Verdict: no actionable bug found in the final one-file candidate. Acceptable for lead integration of this bounded correction.** This is not canonical proof admission, a release-build result, full campaign acceptance or an R0 decision.

## Exact reviewed subject

Repository: `C:/Users/Hokli/.codex/worktrees/semctx-r0-path-repair/semctx.codex-t00-reconcile-20261024`.

Base/HEAD: `a754b59bb1ffe037c5a06f35b7601bde4aae7b89`. The sole dirty path is `tools/rust-ts-r0/qualification/qualification_replay.rs`; its SHA256 is `644b6faf16342b607ede51c2d997c5b57f2ba09baa9661ef81578cbaebb147d6`.

`work/r0-path-repair-validation/final-candidate.patch` SHA256 is `03fd6044f29ad99dd1f4b0235758f47d852bdfe8512957208c9c90481d66b09c`. I recomputed both hashes and confirmed the saved patch equals the live `git diff` byte-for-byte. No second changed or untracked source path was reported.

## Code assessment

`materialize` forms captured keys with `std::path::absolute(root)` and the authored relative path. The old post-capture function looked up the canonical physical path instead; Windows canonicalization adds a verbatim namespace, so valid ordinary captured keys were rejected.

The final correction uses the same absolute-root/authored-relative spelling as `materialize` for the retained-map lookup. It neither case-folds nor strips namespace prefixes nor substitutes another captured key. Physical confinement remains a separate canonical path comparison. The request file is now canonicalized before collision comparison, so an ordinary-spelled request path cannot escape the request-write guard merely because its target is canonical. A further canonical equality check binds the selected captured key to the same target before reading or writing it.

The existing checks still reject unsafe relative paths, absent captured keys, mismatched physical pre-mutation bytes, non-string or non-differing replacements, incorrect written bytes, and request mutation. The success proof is retained only after the final request-byte and parsed-value comparison. The patch does not change corpus inputs, expectations, result dispositions or producer code.

## Raw evidence verified

Both phase receipts equal their entries in `result.json`, and their stdout/stderr SHA256 values match the actual files.

* **Red:** source `636bca809611acc4636cfca55c461cb988b10010fe723391df439953dd2e4528`, old implementation plus new tests. Cargo exit101; exactly one test failed after setup reached `apply_physical_post_capture`, with `physical mutation must target captured source`. This is the designated Windows namespace defect, not a compile/setup failure.
* **Green:** final source `644b6faf…147d6`, Cargo exit0, four post-capture tests passed, zero failures, zero ignored. The exact ordinary-root test from the red phase passes. The existing canonical-root test also passes, as do the guards and wrong-namespace rejection tests.

The command used Rust1.95, offline dependencies, the isolated checkout's default debug target, two build jobs, one test thread and both snapshot options set to0. The phase receipts report source unchanged during their runs. The stopped pre-red preparation build remains separate and is not test evidence.

## Limits for integration and later qualification

The four passing tests are native Windows **debug** comparator tests. The `cfg(unix)` symlink escape/request-alias blocks did not run. There is no release qualification-observer rebuild, actual previously failed full recipe replay, full 354/51 or supplemental campaign, or three-host result in these receipts. Those are subsequent execution obligations, not discovered defects in this patch.

The function provides sequential path/read/write checks, not an atomic filesystem seal against concurrent reparse/hardlink changes. No new general filesystem-isolation claim is supported. The current canonical-policy routing gap remains separately recorded; it is not a source-code bug and this review does not waive it.

Any integration that changes the source bytes invalidates this exact review identity. A new candidate SHA and updated pre-query protocol/source bindings are required before counting new full-campaign observations.
