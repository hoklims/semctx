# Git fixture V2 follow-up review

Read-only review, 2026-11-17. **The prior configuration-isolation finding is closed. No further actionable defect found in the frozen two-file scope.**

Production source `qualified_public_replay.rs` remains SHA256 `9c26cec427bc8bd39927ef54344af0ada0ecf908937b3469eac99fded8025c8c`. Corrected `fixture_git_tests.rs` is SHA256 `47b3bfe1e898a0dcaab2f8a417f399d33ede8d72c685502fd1548505a1813eb4`. Both hashes were recomputed; no provenance file was read or modified during this follow-up.

The test now sets child-only HOME/USERPROFILE and XDG_CONFIG_HOME, puts the hostile config in that owned home's `.gitconfig`, and explicitly removes Git environment overrides. The helper's Git-variable filtering therefore no longer defeats the setup. It checks `git config --show-origin` for both the global/sibling value and both local fixture settings, comparing canonical source paths to the exact expected owned files. This directly establishes that Git reads the synthetic global file and the fixture's `.git/config`.

`green-isolated-home-v2.receipt.json` records native Windows release exit0, one test passed, zero ignored. Its source hashes and raw stdout/stderr hashes match. I read the actual nested Git receipts: global/sibling origins resolve to the synthetic `.gitconfig`; both local false values originate in the fixture's own `.git/config`. The sibling still emits103 stderr bytes, the configured fixture's add emits none, and the actual bad ref exits128 with32 stderr bytes. Working/indexed source and synthetic-global bytes are asserted unchanged.

The production helper remains the previously reviewed narrow local setup: explicit absolute `.git`, directory/symlink rejection, typed local writes/readbacks, captured commands and strict success/stderr checks. Corpus, recipe arrays and `complete_success_capture` are unchanged. The earlier strict-capture and unborn regression evidence remains separate and is not inflated into a new full campaign result.

This closes the specific local review finding. It does not provide native Mac/Linux execution, full campaign acceptance, canonical audit admission or R0. No code edit, test execution, gate, promotion or commit was performed by this reviewer.
