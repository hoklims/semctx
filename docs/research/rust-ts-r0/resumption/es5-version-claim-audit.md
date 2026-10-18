# N17c version-attribution audit

Author: `/root`. Independent auditor: `/root/es5_version_claim_audit`.
The auditor returned this ledger before the arbitration was drafted. The author
retains it here; the auditor's read-only role did not permit writing files.

| claim | authority | mechanism | scope | named behavioral oracle | status | failure mechanism |
| --- | --- | --- | --- | --- | --- | --- |
| TS5.9.3 emits `__awaiter` and `__generator` for the exact N17c ES5 input. | Frozen N17c scenario, historical test at `3e94997f`, pinned TS5.9.3. | `transpileModule` lowers async and generators. | Exact N17c source and options. | Pinned TS5.9.3 ES5 emission oracle; output SHA256 `c3b89ee3b637e0ccf6be2e0054c9a0e509d737c03e757c98afbad8dc66d8d6e4`, no diagnostics. | held | Other source, options or version exceed this oracle. |
| Pinned C1 emits `__awaiter`, retains `function*`, and omits `__generator`. | C1 crate7.0.0-dev, upstream `780dc512`, artifact `02909fb9b6ea7823234f9994cb0e28668b2cfef04ed0e180cdf12c2836aca879`. | Raw native emission capture; unchanged expected value. | Exact N17c and captured macOS environment. | Focused N17c native emission capture; exit0; output SHA256 `d8c5cf03fd65d07f2096cba9250704d347f00e25542bfceeb81344941255aae7`. | held | Rewritten output, another artifact or extrapolation to other helpers invalidates the observation. |
| This omission is individually attributable to the TS7/TS5 version boundary. | Owner2026-10-18; official TS6 notes and dated TS7 announcement; pinned native transformer source. | C1 requested ES5 output exactly equals TS5.9.3 ES2015 output and differs from TS5.9.3 ES5 output; native pipeline has no generator-lowering transform. | Only N17c's omitted `__generator`, at the pinned native revision. | N17c three-way version differential; exact output equality and source inspection. | held | Without the exact ES2015 equality and source mechanism, the difference could remain an unexplained C1 defect. |
| The capture is a canonical supported TS7 ES5 output. | TS7 removes target ES5; ES2015 is the documented floor. | The probe directly injects an internal ES5 enum; this creates no public remapping contract. | This proposed wording only. | No green public TS7/ES5 oracle exists for a removed target. | contradicted | Confusing the pinned internal pipeline's effect with a supported public TS7 contract. |
| Frozen expectations and raw observations stay unchanged; attribution is separate. | Owner instruction; T00-ARB-002 comparison rule; resumption policy. | Bind both raw outputs and hashes without editing scenario, recipe or comparator. | N17c only. | Frozen-expectation/raw-output integrity reconciliation, required after drafting. | target | Removing `__generator` or changing raw output would erase the difference artificially. |
| Attribution grants no qualification PASS; N17c stays NONPASS. | Owner instruction and T00-ARB-002's no-credit-at-registration rule. | Four focused units pass; N17c's `__generator` check stays MISMATCH. | N17c accounting, no global C1/R0 credit. | Focused five-unit frozen replay. | target | Turning causal explanation into a qualified obligation or implicit PASS exceeds the decision. |
| Other ES5, helper or diagnostic differences do not inherit the classification. | Owner instruction and resumption policy requiring individual proof. | Each additional difference needs its own input/version/mechanism and differential oracle. | Only N17c's omitted `__generator`. | Per-divergence version-evidence reconciliation, required for each extension. | target | A class-wide TS7 or ES5 helper exception has no individual proof. |

The reconciled arbitration excludes the contradicted public-support claim.
Documentary reconciliation after drafting is recorded in
[gap-mapping-progress.json](gap-mapping-progress.json). The classification leaves
the frozen comparator red and does not establish a qualification result.

Primary intent sources: [official TS6 release notes](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-6-0.html)
and [Microsoft's TS7 progress announcement, 2025-12-02](https://devblogs.microsoft.com/typescript/progress-on-typescript-7-december-2025/).
The latter is a dated announcement, not evidence of present pipeline completeness.
The local pinned source and three captured outputs establish this case's mechanism.
