# Git fixture test isolation corrected

The first implementation results are preserved, but their claim that `GIT_CONFIG_GLOBAL` controlled the hostile policy is withdrawn. The actual process supervisor strips every inherited `GIT_`/`GCM_` variable (`tools/gates/src/process.rs:558–568`). The earlier test therefore depended on host Git configuration.

An added assertion queried the actual Git process with `git config --global --show-origin --get core.autocrlf`. `red-global-origin.receipt.json` records exit101: that read returned exit1 instead of the synthetic value. This is the observed negative witness for the missing provenance check.

The final test sets **HOME, USERPROFILE and XDG_CONFIG_HOME only for its child process** and writes the hostile `.gitconfig` under that isolated HOME. It no longer relies on stripped Git environment variables. Actual captured origin records prove:

- Global autocrlf=true comes from the isolated `home/.gitconfig`.
- The unconfigured sibling still uses that same file and produces the LF→CRLF warning.
- Local autocrlf=false and safecrlf=false come from the fixture's own `.git/config`.
- Git may report the local source as relative `.git/config`; the test resolves it against that exact invocation cwd and compares canonical files. The raw origin is retained unchanged.
- Source/index bytes remain LF, the isolated global bytes stay unchanged and the actual bad-ref error remains captured.

`green-isolated-home-v2.receipt.json` records **exit0, one integrated test passed**, source-stable throughout. An intermediate isolated-home run failed only because the test initially compared Git's relative local origin to an absolute spelling; that failed attempt remains preserved.

Production code is unchanged from the earlier candidate (`qualified_public_replay.rs` SHA256 `9c26cec427bc8bd39927ef54344af0ada0ecf908937b3469eac99fded8025c8c`). The final test SHA256 is `47b3bfe1e898a0dcaab2f8a417f399d33ede8d72c685502fd1548505a1813eb4`. The previously passing strict-capture and unborn-recipe checks apply to their unchanged code; they were not needlessly rerun.

The exact final diff and origin values are in `implemented-diff-v2.patch` and `implemented-summary-v2.json`. All earlier logs remain intact. Native Linux execution of this corrected test is **not observed**; the lead explicitly deferred that rerun. No portability result is invented.

The checkout was released after the final test completed. This agent made no commit, push, full campaign or admission claim.
