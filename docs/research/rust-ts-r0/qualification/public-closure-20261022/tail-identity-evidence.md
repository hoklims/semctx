# Row 229: public live identity acquisition experiment

Row 229 remains `not_qualified`. On both macOS arm64 and Linux aarch64, the frozen native primitive reproduces the complete `analyzerIdentity` return value for nine public fixtures and shares four refusal outcomes. Five additional fixtures demonstrate different acquisition policies. These results cannot close the whole owning consumer or T02.

## Authority and execution boundary

The oracle executes the unmodified exported `analyzerIdentity(root)` from baseline `3e94997fcbefa72ad4d49b2cad180ee79b7c0a9b`, Git blob `5cb90f86095332e0af182b1579a49958e7fc2b31`, SHA256 `cfbf37a7affe4829b40d962ce91130b71ae4b6572db2384597a1c18b388d0e0d`. The module is copied outside every specimen root and loaded with Bun; its imported TypeScript runtime is 5.9.3. No source transformation or native-derived expected identity is used.

Each isolated fixture contains the six fixed input files and package manifests from that baseline, plus small public source files. The initial identity contains 12 implementation/configuration paths, the TypeScript entry digest and all 101 compiler-library/package descriptors. Fixtures also contain excluded generated, `.tsx` and text inputs with CRLF to activate inclusion/exclusion policy. The complete historical 290-file specimen and existing 20 identity supports remain separate evidence.

The native invocation is the frozen executable's existing `--observe-primitives request.json`, with operation `baseline_analyzer_identity` and explicit repository/compiler roots. No producer, helper, observer, contract or maintained runner was changed. The experiment is a temporary external Python orchestration file retained in the raw evidence directory, with its hash recorded in each report.

[macOS results](tail-identity-macos.json) and [Linux results](tail-identity-linux.json) retain complete oracle identities, native identities, native reported reads, request descriptors and process output hashes. The raw reports retain every specimen and compiler file hash before and after execution. The tracked reports bind those inventories by canonical hash and raw JSON pointer. Producer hashes, frozen fixture hashes, immutable shared compiler inventories and exact oracle source hashes are unchanged; every process exited zero with empty stderr. Native request descriptor IDs and producer artifact IDs were independently checked against their explicit inputs.

## Outcomes on each platform

| Cases | Count | Observed boundary |
| --- | ---: | --- |
| Base, relocation, generated-file exclusion, non-source exclusion, nested source addition, source byte change, compiler-library byte change, compiler-entry byte change, source symlink exclusion | 9 | Complete `{schemaVersion, files, compiler, digest}` equality, including every file path and digest |
| Missing fixed file, missing `apps/cli/src`, missing `packages`, implementation CRLF | 4 | Both refuse; missing-input error encodings differ, and CRLF error text matches |
| Fixed input symlink outside repository | 1 | TS reads its target and succeeds; native returns `LEGACY_IDENTITY_OUTSIDE_ROOT:tsconfig.base.json` |
| Missing package manifest or compiler entry in the fixture compiler package | 2 | Bun resolves another installed public 5.9.3 package and TS succeeds; native refuses the explicitly supplied incomplete package |
| Compiler package declares 5.9.4 while the imported TypeScript runtime reports 5.9.3 | 1 | TS returns imported runtime version 5.9.3 and hashes the modified package; native returns `LEGACY_IDENTITY_SDK_VERSION_MISMATCH` |
| `bun.lock` exceeds 64 MiB | 1 | TS hashes the bytes and succeeds; native returns `LEGACY_IDENTITY_CAPTURE_LIMIT` |

`acquisitionDiagnostic` records a separate unchanged-fixture `Bun.resolveSync` invocation and hashes the resolved entry/package. In the two incomplete-package controls, the resolved entry belongs to the immutable installed public package, outside the incomplete specimen package. This is observed fallback in this environment; it is not an assertion that Bun always falls back for every malformed package. The native operation instead receives a compiler root explicitly and does not execute the compiler.

A source symlink is excluded by both directory walks because it is not a regular-file directory entry. A fixed input symlink is read by the TS consumer because the fixed inventory bypasses that walk; native confinement rejects the same bytes. These are distinct paths and both were exercised.

## Reproduction and limits

The raw macOS root is `/Users/sebastien/semctx-evidence/t00/20261022/public-closure/tail-identity/`; Linux uses `/work/evidence/qualification-20261022/public-closure/tail-identity/` in container `semctx-t00-oct20-linux-v1`, whose network mode is `none`. Each `cases/<name>/result.json` contains the exact native and Bun argument vectors; `request.json`, `oracle.stdout`, `oracle.stderr`, `native.stdout` and `native.stderr` retain the direct process evidence. The Linux raw report is also copied to the macOS raw root as `report-linux.json`.

The environments exercised are macOS 27.0.1 arm64 and the existing Linux aarch64 container, with exact versions in their JSON reports. Windows was not exercised. Permission-denied reads, invalid filesystem-name encodings, concurrent filesystem mutation and every possible malformed compiler package were not tested. Missing-input refusals establish refusal outcome, not error-code equivalence. No existing support descriptor is promoted by inheritance, and there is no ARB credit, terminal R0 qualification or whole T02 claim.

The frozen primitive's explicit-package acquisition, confinement and bounded capture cannot be reported as the baseline consumer's complete live policy on these observations. Closing this row requires a separately authorized decision about that policy boundary and relevant implementation/evidence; this experiment does not change either policy.
