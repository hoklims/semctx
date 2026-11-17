# Retained consumer-map V2 review

Reviewed 2026-11-17, read-only. **The prior dot-segment finding is resolved. No further actionable bug found in this bounded two-file candidate; approve for lead integration.** This is not full qualification or canonical admission.

Base: `5080f2a867581b889d4f03d878a0b47cd919f2b9`.

* `tools/rust-ts-r0/src/main.rs`: SHA256 `1a01e684e2b00e98135f0ae0cd63e31ed0a9f3a3c427ff3b76975863aee2c21c`.
* `tools/rust-ts-r0/tests/unit/main_tests.rs`: SHA256 `28a3e0720a7284674125fcd47eb2ddcf489102de60f3adc2dbf630cff0ca0026`.
* `final-diff-v2.patch`: SHA256 `6451c11b663c0ceb328003e0239b27ff532cd6f2027dde05fe36d62aa3ee527b`,6082 bytes. Its bytes match the live Git diff; only the two named files are dirty.

The consumer map now applies `tspath::normalize_path` before the existing case fold. This normalizes slash and dot/parent segments using the same compiler path routines that produce SourceFile names, while preserving drive and drive-verbatim roots. It avoids CaptureFs's extra leading slash for Windows paths. CaptureFs storage, raw Request identity, collision checks, source containment and the case-sensitive retained-reference rule are unchanged.

The new tests retain the original six-program checks for each namespace and add `sub/../main.ts` variants for drive-local, drive-verbatim and POSIX-style roots. The saved red-dot run uses the previous slash/case-only implementation and the same final test bytes: three designated assertions fail with unexpected `SOURCE_OPAQUE_CALLBACK_UNSUPPORTED`. The corrected version passes all six path tests, including all36 full captured-source analyses and the external object-helper negative controls.

I recomputed the source/diff hashes and every red/green/regression stream digest; all match their receipts. The final source passes18 distinct native Windows release tests: six path tests plus twelve existing casefold, case-sensitive, retained-reference, callable, opaque-observation and received-ownership controls. All report exit0 and zero ignored tests. The red run reports exit101 with three assertion failures, not setup errors.

The proof remains local Windows release-unit evidence. POSIX-style paths in those tests are not a native Linux/macOS run. Standalone producer rebuild, current-source complete campaign assessment, source-role applicability and canonical admission remain separate obligations. The earlier V1 review/result remains historical; its resolved finding should not be represented as an unresolved defect of these V2 bytes.

No source edits, tests, builds or queries were executed by this reviewer.
