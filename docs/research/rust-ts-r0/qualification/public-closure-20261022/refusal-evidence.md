# Public confinement and snapshot evidence

This finite capture adds evidence for obligations 169, 6 and 4. It changes no producer,
existing observer, contract, qualification ledger or runner. Expected outcomes come from the
unmodified TypeScript 5.9.3 baseline at `3e94997fcbefa72ad4d49b2cad180ee79b7c0a9b`.
The baseline source hashes in all four reports match their frozen consumer-contract rows.

| Obligation | Public executions on each host | Result and credited boundary |
| --- | --- | --- |
| 169, `assertConfinedTypeScriptSources` | Retained and ordinary import escape; retained and ordinary reference escape; actual in-root call control | Five passing native processes. Every refusal is exit 1, empty complete stdout and exactly the complete baseline error serialized as the sole JSON stderr field. Import and reference reasons differ. The positive control compares the complete extraction, using the existing projection that removes native symbol UTF-16 extension fields and sorts collections; its real call resolves `main.ts:entry` to `leaf.ts:leaf`. |
| 6, `escapedDependencyReason` | Missing in-root JavaScript relative import; missing outside relative import; existing outside import; outside reference | Four complete `discoverRepository` outputs exactly match native `--discover-repository` files and candidates. The in-root missing import stays selected. One additional native analysis compares the complete independent `inspectJavaScriptSource` reason list, including `JAVASCRIPT_IMPORT_UNRESOLVED:./missing`. The three escaping alternatives fail with the respective import/reference reason. |
| 4, `assertSnapshotInputs` | Qualified missing snapshot; ordinary missing snapshot | Baseline `analyzeRepository` refuses the qualified case and succeeds in the ordinary case. Native raw `analyze` exhibits the same guard distinction; the ordinary case also matches the complete extraction. This is partial evidence: the native retained-runtime owner rejects missing snapshots unconditionally, so its ordinary bypass is not demonstrated. Obligation 4 remains open. |

For obligation 4 the explicit source mapping is from baseline `analyzeRepository` →
`assertSnapshotInputs` to native raw `analyze` in `tools/rust-ts-r0/src/main.rs`.
Its `qualified && !retained` guard corresponds to the baseline qualified missing-input
branch; falling through corresponds to the baseline ordinary missing-input branch.
This mapping does not establish the complete owning analysis contract. The sole message
mapping converts the entire baseline exception
`SOURCE_SNAPSHOT_REQUIRED: qualified analysis requires retained source and configuration inputs`
to native `SOURCE_SNAPSHOT_REQUIRED`; every byte of the resulting stderr is compared.
It grants no generic prefix acceptance and no owner closure.

The captures ran on macOS arm64 and the existing Linux aarch64 container
`semctx-t00-oct20-linux-v1` with network mode `none`. Frozen native artifacts are
`78d6a5b50c99bedce983f474bf11d03177ee45260112d19f47debcadf96cc9f1` (macOS) and
`8c7b56064812bdf4d17a1ee95b9d6e66fded896928a9a6e7172880cc318782ea` (Linux).
The SDK hash on both is `f57257876a383d13839a94adefb42b3d40bad2e93489a0f1a5ab29f045f139e5`.
Producer, SDK, baseline owner source, authored inputs and capture script hashes were
checked before and after execution. Each process records actual argv, cwd, timeout,
output cap, exit state, request bytes hash and complete stdout/stderr byte counts and hashes.
The timeout and capture failures cannot pass as analysis or as expected refusal.

Retained reports:

- [Confinement and partial snapshot, macOS](refusal-report-macos.json)
- [Confinement and partial snapshot, Linux](refusal-report-linux.json)
- [Discovery, macOS](refusal-discovery-report-macos.json)
- [Discovery, Linux](refusal-discovery-report-linux.json)

Raw captures are outside the repository under
`/Users/sebastien/semctx-evidence/t00/20261022/public-closure/refusals/` in
`macos-v3`, `linux-v3`, `discovery-macos-v3` and `discovery-linux-v3`.
Linux raw paths recorded in reports retain their actual container `/work/evidence/...`
locations; those directories were also copied to the preceding host evidence location.
Earlier `v1` and `v2` attempts are not the credited captures.

Reproduction uses the new capture scripts with the same four positional arguments:
baseline root, frozen campaign descriptor, the respective `refusal*-inputs.json`, and
a fresh external output directory. Run Bun with the baseline `tsconfig.json` override.
Neither script changes an existing gate or contributes formal R0 admission. Only the
finite public properties listed above were exercised. Other architectures and Windows
were not exercised.

The final captures reject empty or duplicate unit inputs, bind successful responses to the exact physical request and logical project/SDK identity, and require complete supported root observations. Discovery responses bind their complete descriptor. The imported public context evaluator is included in every before/after source identity inventory. Refusal-only outcomes retain exact complete error-byte comparison.
