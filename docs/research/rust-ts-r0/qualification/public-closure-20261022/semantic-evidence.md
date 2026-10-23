# Public semantic consumer evidence — 22 October 2026

This supplement nominates 56 of 62 formerly generic semantic consumer rows for independent bounded review. The nomination is not a qualification verdict. Six rows remain open because actual baseline API site activation is incomplete. Formal R0 is not acquired by this supplement.

The candidate, helper, original corpus, reserved corpus contract and runner remain untouched. No reserved input or output was accessed. The expected values come exclusively from the public exact baseline `3e94997fcbefa72ad4d49b2cad180ee79b7c0a9b` with TypeScript 5.9.3. No native value supplies an expectation.

## Artifacts and boundary

- `semantic-inputs.json`: 328 public units, including 152 public semantic inputs reused with fresh IDs, 42 activating/control pairs and additional API site witnesses.
- `semantic-completion-inputs.json`: 26 additional public units, including direct controls and JS global inference, bracket element access and imported SDK alias witnesses.
- `semantic-runtime-inputs.json`: two inputs retaining the SDK constructor type while changing the runtime receiver from `const` to `let`.
- The three corresponding `*-manifest.json` files contain complete exact reason arrays, `executed=true`, `unsupported=[]`, no filters, no arbitration and the source identities emitted by the existing frozen `suite_oracle.mjs`.
- `semantic-activation.json`: complete API site inventory with at least one real unit for each observed outcome category. Raw reports retain every hit and count outside the repository; their hashes and input hashes are recorded. The compact publication retains every source site, every observed category and an actual witness for that category.
- `semantic-proof-map.json`: explicit per-row activating/control inputs, complete expected reasons, focal reason toggles, observed consumer site IDs, changed API outcomes, missing sites and pending qualification status.

The native manifests exercise the full owning `inspectSemanticDependencies` reason boundary through the existing raw observer. They do not compare private helper return values, certify an unobserved branch, or certify callback graph ownership. The independent review must assess the focal pair's relevance to its particular consumer; all-site execution or a nearby family example alone is insufficient.

## Baseline activation observation

`tools/rust-ts-r0/qualification/public-closure-20261022/semantic-activation.mjs` transforms only an external disposable copy of the baseline semantic source. It matches the exact source span of every declared Compiler API site. Each wrapper records the evaluated result category and returns the exact original value. Method calls are wrapped as complete calls to retain their receiver and optional call behavior. No wrapped result is used to manufacture a native expectation.

For every one of the 356 public units, the unmodified baseline is evaluated first and the instrumented copy is then required to return the exact same complete sorted reason array. All 356 equality checks passed on macOS arm64 with Bun 1.4.3 and TypeScript 5.9.3. The emitted source hash is compared through the committed public baseline source identities during review; this observation tool itself is not a repository authenticity guard.

Generation, from the repository root:

```sh
bun --tsconfig-override /Users/sebastien/semctx-evidence/t00/20261022/suite-a/tsconfig.json \
  tools/rust-ts-r0/qualification/suite_oracle.mjs \
  /Users/sebastien/semctx-evidence/t00/20261022/suite-a \
  docs/research/rust-ts-r0/qualification/public-closure-20261022/semantic-inputs.json \
  /tmp/semantic-manifest.json /tmp/fresh-semantic-oracle
```

Use the corresponding completion or runtime input for the other two manifests. Every work root must be fresh. The recorded generation used fresh roots under `/Users/sebastien/semctx-evidence/t00/20261022/public-closure/semantic/`.

Activation replay:

```sh
bun --tsconfig-override /Users/sebastien/semctx-evidence/t00/20261022/suite-a/tsconfig.json \
  tools/rust-ts-r0/qualification/public-closure-20261022/semantic-activation.mjs \
  /Users/sebastien/semctx-evidence/t00/20261022/suite-a \
  docs/research/rust-ts-r0/qualification/suite-20261022/consumer-observable-contracts.json \
  docs/research/rust-ts-r0/qualification/public-closure-20261022/semantic-inputs.json \
  /tmp/semantic-activation.json /tmp/fresh-semantic-activation
```

## Negative witness and restoration

A disposable external copy of the observation tool changes only the returned value at site `61:0`, forcing `ts.isBinaryExpression` to false for `coercingBinary`. On `PUBLIC-SEM-coercion-binary-activate`, the real baseline still returns `SOURCE_COERCION_UNSUPPORTED`, while the corrupted instrumented copy loses that reason. The actual equivalence check rejected this mutation with exit 1 and `instrumentation changed observable PUBLIC-SEM-coercion-binary-activate`.

The same input with the original identity wrapper passed with exit 0. Raw evidence is `negative-v2.log`, `restored.log` and `restored-report.json` under the external evidence root. An earlier disposable attempt had a TypeScript module-resolution setup error; it is retained as `negative.log` and gives no negative-witness credit.

## Remaining six semantic gaps

| Row | Consumer | API sites observed | Missing evidence |
| --- | --- | --- | --- |
| 49 | `inspectSemanticDependencies` | 12/15 | Default source path and absent-snapshot fallback are not activated by the frozen observer invocation. |
| 69 | `inlineOwned` | 0/75 | No registered opaque callback ownership graph is supplied by these reason-only oracle invocations. |
| 77 | `inspectOpaqueCallbacks` | 81/97 | Rare member, declaration, imported and ambient-origin API sites remain unobserved. |
| 82 | `inspectSdkCoercion` | 27/29 | The shorthand-property option path is unobserved; the earlier `literalData` check rejects the supplied shorthand values. No unreachability proof is claimed. |
| 84 | `inspectSyntax` | 96/128 | Several re-export, JSX tag and class-expression sites remain unobserved. |
| 134 | `visit` | 132/164 | Ambient implementation, protocol class field, location navigation and iteration sites remain unobserved. |

No per-site omission is converted into acceptance. Rows 116, 126 and 129 were initially incomplete and have actual completion witnesses in the final union. The mutable SDK receiver pair directly exercises construction refusal without changing the declared SDK member type. Source-only declarations and instrumentation counts never replace both-platform native comparisons.

Windows, macOS x86_64, Linux x86_64 and terminal R0 admission are outside this baseline observation. The parent campaign records the actual macOS/Linux native outcomes and independent reviews separately. No new source comments were added.
