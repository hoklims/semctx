# T00 independent qualification supplement v1

50 source variants in 14 contrast groups, plus 11 narrowly selected baseline public test invocations. This separate supplement does not replace the original 354-unit / 51-support freeze or the reserved holdout.

Authority: Git baseline 3e94997fcbefa72ad4d49b2cad180ee79b7c0a9b; Bun 1.4.3; actual TypeScript 5.9.3 Compiler API with baseline extractionContext options and real SDK declaration origins. Raw observations, exact SDK byte manifest, source fixtures and baseline public test authorities are retained. expected-observables.json is the portable relevant projection. Raw compiler diagnostics are evidence, not a full typecheck success claim.

All 11 public invocations completed successfully, including the 3 previously blocked admission tests after authorized clean dependency recovery. The initial missing-module failure is preserved in scope-admission.stderr and scope-admission-initial-unknown.json; scope-admission-clean.stderr records the successful retry. Dependency recovery used only exact baseline bun.lock, frozen-lockfile, ignore-scripts and the public npm registry. Lock SHA256 stayed unchanged. Official package versions and file hashes are retained; no current Semctx package was read.

Reproduce into a NEW directory with Bun 1.4.3:

`bun reproduce.ts <repository-with-baseline-object> <official-typescript-5.9.3-package-directory> <new-output-directory> --recover-oracle-deps`

Without the final flag, replay uses only the installed official compiler and records UNKNOWN for unavailable admission dependencies. With the flag, it performs the explicitly authorized lock-preserving recovery in the new baseline extraction before running selected baseline tests. It never runs a candidate or lifecycle scripts. Public test scratch stays within the new output.

SDK/local contrasts use real compiler origins. Protocol assignment remains refused even with primitive RHS. A retained reference still has SOURCE_REFERENCE_PATH_UNSUPPORTED but drops the unretained-reference reason. Neither negative control implies admission.

manifest-sha256.json covers every file except itself and freeze.json; freeze.json pins the manifest bytes. Do not edit the frozen tree. New evidence requires a new version.
