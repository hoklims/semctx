# Exact-head native CI dispatch

Commit `568c271f86adc45db7bfcce9ef902b29eef164c9` is published with four
local `verify:pr` shards passing on macOS ARM64, Bun 1.4.3 and Rust 1.95.0.
GitHub reports PR #386 as conflicting although its own compare endpoint reports
that the head is seven commits ahead and zero behind its base. The pull-request
merge ref still points to older head and base commits. The retained diagnostic
records exact refs and does not identify a branch conflict requiring a rebase.

The existing CI workflow gains a manual dispatch entry with an explicit base
commit. Its planner and gates receive that base; checkouts retain the immutable
workflow-run head SHA. Actions, jobs, permissions, mandatory aggregate and native
Windows/Linux execution remain the existing mechanisms. This is an additional
entry into the same checks, not a separate result controller. Local actionlint
and the bounded independent review cover the configuration. A public dispatch
must still establish the run head, base, job matrix and retained native results.

A manual run is evidence for its observed head and platforms. It does not prove
PR mergeability or supply missing pull-request merge-context checks. GitHub
[documents conflict suppression and dispatch behavior](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows).

No native Windows/Linux result or R0 decision is recorded by this checkpoint.

The first dispatch-validation run failed on shard4: three assertions compared the
changed YAML to its former literal declarations. The focused reproduction failed
2 tests; removing only those three mirror assertions yielded 28/28 passing tests.
The permission, cancellation and pull_request_target checks remain. The planner's
native invalid-base/valid-base executions and workflow actionlint remain the
configuration evidence; the public run is still required. A subsequent invocation
omitted the already installed quality-tool directory from PATH and failed to launch
ruff (exit127); its visible log is preserved. Neither failure is credited green.

The next native-workspace step failed because this local invocation omitted
SEMCTX_PROCESS_HELPER. The unchanged native_common_portability test reproduces
the missing-supervisor failure before analysis. The corrected command supplies
the existing immutable #383 helper; no test, deadline or controller was changed.
The task-local environment wrapper remains outside the repository.

The exact JavaScript pins also change the canonical analyzer implementation hash.
A subsequent real identity test detected its stale generated module. The four
running checks were deliberately interrupted, with no green credit, before the
native analyzer-identity generator and plugin builder regenerated their outputs.
The existing identity tests and plugin check then passed; a fresh four-shard
canonical run targets those outputs. [The retained record](analyzer-identity-regeneration.json)
contains the failure, interruptions, native regeneration and focused results.
The frozen C1 producer, SDK and expected corpus remain unchanged.

The [fresh four-shard canonical run](canonical-pass2/record.json) passed after
regeneration on macOS ARM64 with Bun1.4.3, Rust1.95.0 and GIT_CONFIG_GLOBAL
removed. The indexed runtime patch remained unchanged. Subsequent research-only
metadata was checked separately. This local result grants no native Windows/Linux
qualification, PR merge-context result or R0 decision.

## Final bounded checkpoint

[The final local delivery run](canonical-final/record.json) passes all four
verify:pr shards with Bun1.4.3 and GIT_CONFIG_GLOBAL removed; runtime source is
unchanged from49fa9830, with subsequent research-only documentation checked
separately. [Actual optimized C1 platform evidence](../platforms-49fa/README.md)
now exists on native Windows/Linux/macOS for the same four DEV vectors and
bounded receiver controls. The general Windows shard1/4 failed an unrelated
unchanged plugin inode-replacement test, preserved without retry, skip or fix;
no aggregate green or PR merge-context result is inferred. [R0 stops for the
exhausted research budget](../../final/README.md), independently of that CI failure.
