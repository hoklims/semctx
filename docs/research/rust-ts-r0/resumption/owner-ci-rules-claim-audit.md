# Owner CI/publication rules: independent claim ledger

Author task: `/root/retained_unresolved_evidence_author`.
Auditor task: `/root/retained_unresolved_evidence_author/owner_ci_rules_auditor`,
a fresh distinct child with the dedicated `design-claim-auditor` role. The caller
`/root` is not the documentary author. The child received only the CI/publication
scope and approved owner rules, without an expected verdict. It returned the
complete six-row ledger below before author evidence reading or drafting.
No Rust behavior, historical behavioral checkpoint, budget decision, reserved
payload or external event was audited. All six claims are approved prospective
targets; this audit supplies no green execution oracle.

The [CI rules record](owner-ci-rules-20261019.json) records the retained rules.
The following ledger is the dedicated child's complete final result.

| claim | authority | mechanism | scope | named behavioral oracle | status | failure mechanism |
|---|---|---|---|---|---|---|
| Push only complete coherent milestones after green local `verify:pr` with Bun `1.4.3` and `GIT_CONFIG_GLOBAL` absent. | Sébastien’s retained rule, confirmed by « Les autres règles restent valables »; relayed by `/root`. | Withhold push until the exact milestone head passes under the pinned environment. | Future pushes to `rust/365-t00` / PR 386. | Exact-head local `verify:pr`; no current milestone result supplied. | target | An incomplete milestone is pushed, or verification is missing, red, or run under another environment. |
| Do not launch CI manually, including `workflow_dispatch`. | Same approved owner decision. | Abstain from every manual-dispatch path. | T00 CI runs after the correction. | GitHub Actions run-event provenance; none supplied or inspected. | target | Any manual CI launch occurs. |
| Make no further workflow changes. | Same approved owner decision. | Freeze workflow files at the approved published state. | Remaining T00 workflow definitions. | Exact-head workflow diff against the approved baseline; no result supplied. | target | Any workflow definition is edited. |
| Post no GitHub comments. | Same approved owner decision. | Abstain from issue, PR, review, and commit comments. | All GitHub comments associated with this continuation. | GitHub comment-event audit; none supplied or inspected. | target | Any GitHub comment is posted. |
| Run Windows Rust tests if an available permitted route exists; infer no Windows success without a green execution. | Same approved owner decision. | Use a permitted non-manual route when available and bind success to its result. | Current correction’s Windows Rust behavior. | Exact-SHA Windows Rust test result; none supplied. | target | An available route is skipped, a forbidden route is used, or success is claimed without a green result. |
| Do not merge, release, or deploy. | Same approved owner decision. | Withhold merge, release, and deployment actions. | T00 branch, PR, and resulting artifacts. | Merge/release/deployment event audit; none supplied or inspected. | target | The PR is merged, a release is created, or an artifact is deployed. |

Author reconciliation: current record/README publish these CI constraints only.
Future milestones require their own named execution evidence; no constraint is
presented as already executed or externally enforced. No budget, qualification
or R0 conclusion is added.
