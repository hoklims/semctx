# Public diagnostic consumer evidence

This additive campaign leaves the prior candidate, helper, frozen contracts, runner and reserved experiment unchanged. The independent oracle is baseline `3e94997fcbefa72ad4d49b2cad180ee79b7c0a9b` with TypeScript 5.9.3. No reserved input is used.

`diagnostics-inputs.json` contains 96 public units. `diagnostics-manifest.json` compares complete JavaScript observations (`parseFailed`, `reasons`, `staticExports`, `staticModuleLinks`), complete configuration reason arrays in three explicit modes, or complete syntax reason arrays. Each component also requires `executed=true` and `unsupported=[]`. Expected values come exclusively from the baseline operation.

`diagnostics-activation.json` records 165 source API sites across 24 consumers. A disposable copy of the baseline diagnostics module wraps each exact source expression, preserving original comments and pragmas; when the expression is a callee, the complete call is wrapped to retain its receiver. The wrapper returns the original value and records execution plus a bounded value summary. All 96 complete owning-operation outputs were identical before and after instrumentation on macOS arm64. Activation alone gives no qualification credit.

The instrumentation guard was challenged in a disposable copy by changing JavaScript `parseFailed` to false. Generation stopped on `PUBLIC-DIAG-js-syntaxerror` with `instrumentation changed output`, exit 1. Restoring the instrumented source completed all 96 units, exit 0. Raw mutation and restoration logs remain outside the repository in the public campaign evidence directory.

`diagnostics-proof-map.json` maps each exact site to activation witnesses and selected consumer-specific controls. Twenty-one rows are proposed for independent bounded review, conditional on both native platform reports. Rows 23, 26 and 27 remain open because the native campaign disagrees with the baseline for invalid target configuration or missing inherited configuration. The original macOS oracle observes case sensitivity false. A second execution of the unchanged generator against the exact baseline under Linux observes true at site46:0 for the same10 fixtures. Their expected arrays match exactly across oracle manifests and all10 native witnesses pass on both platforms. Row46 is proposed only for this finite pair of real environments, with no general case-collision or Windows claim. The six native NONPASS units remain unchanged in the manifest and receive no credit.

Rows 12–14 execute through `inspectModuleConfiguration`; the older generic declaration naming `inspectJavaScriptSource` is retained as historical frozen metadata and supplies no proof. The JSX matrix also contributes exact configuration observations for row 167; resolver option consumption must be established separately. Native campaign results and the final qualification decision are maintained by the parent campaign, not inferred from this activation report. Formal R0 qualification remains false.

Generation on macOS arm64 with Bun 1.4.3:

```sh
bun --tsconfig-override "$BASELINE/tsconfig.json" \
  tools/rust-ts-r0/qualification/public-closure-20261022/diagnostics-oracle.mjs \
  "$BASELINE" \
  docs/research/rust-ts-r0/qualification/public-closure-20261022/diagnostics-inputs.json \
  docs/research/rust-ts-r0/qualification/suite-20261022/consumer-observable-contracts.json \
  "$MANIFEST" "$ACTIVATION" "$FRESH_ORACLE_WORK"
```

All output arguments refer to fresh evidence locations outside the repository. The script writes its disposable instrumented module beside the extracted baseline source, also outside the repository. Windows, macOS x86_64 and Linux x86_64 were not exercised by this oracle generation.
