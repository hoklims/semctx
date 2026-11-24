# Dedicated Windows lifecycle collector candidate

Baseline: fresh origin/main ec2d874a (PR432 retired automatic PR milestones).
This isolated candidate preserves that change. No commit, push, dispatch or native
Windows execution is authorized by this document.

1. Keep the existing frozen04b product separate from the collector. Reuse the
   locked three-input Python fixture loader and owned Rust Git transport.
2. Add a manual-only workflow and a pure authority check using runner-owned
   context plus three protected external pins. Empty pins refuse before writes.
   Configuring those pins certifies prior independent admission; PR inputs and
   the candidate cannot approve themselves.
3. Wire the admitted route to a Windows Rust entrypoint:23 fixture workspaces,
   70 public files,161 ordered Git commands plus version observations, fresh
   D:\r, pinned Git/helper, exact raw outcomes and durable ordered receipts.
4. Test denial and the prepared request route on Mac, portable owned-process
   behavior, and cross-check Windows with the already installed toolchain.
   Native Windows filesystem/process cleanup remains NOT_EXECUTED until CI.

The collector only prepares Git fixtures; it launches no semctx candidate probe
and earns no R0 credit. Artifact upload requires successful collection and
postflight identities. The trusted runner/operator remains the authority boundary;
the local process interface is not OS isolation against that owner.

Independent aggregate proof review and exact source admission are required before
configuring the protected workflow/collector/review pins or dispatching collection.

The prior-review pin names the original REVIEW.json bytes, never a DTO or a
locally invented approval. Its bundle contains the actual events, exact prompt,
catalog, stderr, native-evidence.json and NATIVE-REVIEW-RECEIPT.json. The copied
trusted parser enforces the read-only capability inventory and matches its parsed
review to the saved report and favorable product/evidence first line.

Cleanup order is terminate owned tree → wait/reap helper → release Child handle → bounded kernel query
→ bounded pipe drain → second kernel query → close the owned job → seal receipt.
Only after all steps and checkout/executable postflight may the workflow upload.
The two queries share a separate two-second quiescence deadline that also covers
pipe draining; this deadline fails closed. A query is a momentary job-level
observation; it does not prove that an administrator cannot assign a new process
later. The trusted runner/controller must not reuse the job or initiate launches
after sealing. Nested-job restrictions or unavailable QUERY/TERMINATE rights
refuse execution. Native Windows behavior remains NOT_EXECUTED in local tests.

Microsoft primary contracts:
- https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-queryinformationjobobject
- https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_basic_accounting_information
- https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects

The controller releases the reaped Child handle before both job queries, while
retaining ownership of the Job handle. This removes its own process reference
from ActiveProcesses accounting; native Windows validation remains required.

The collector opts into checked termination and bounded try_wait before spawn/ACK.
Its first cleanup fixes one absolute two-second deadline; failure and Drop reuse
that deadline. Failed termination/reap never establishes a complete capture.
The terminate/try_wait cleanup deadline and the quiescence/drain deadline are two
distinct budgets, not one combined two-second limit. These checks provide no
hard realtime guarantee for OS calls or scheduling. After refusal, finalization
may still close the Windows Job with KILL_ON_JOB_CLOSE or send a best-effort Unix
SIGKILL without waiting. Such finalization never establishes a timely successful
reap, quiescence observation or complete capture. Legacy process callers retain
their existing cleanup semantics; no final cleanup action is removed.
Workflow pin syntax is checked by trusted inline PowerShell before checkout;
host Git then checks both exact clean HEADs before any candidate Cargo build.

Git runtime provenance resolves the cmd/git.exe wrapper without executing it to
exactly one existing x64 payload: {mingw64,ucrt64}/bin/git.exe. Explicit payloads
in either layout are accepted; missing, ambiguous, unknown or linked/reparse
layouts refuse. Python identity reads and runtime pins, then Rust NativeGit,
use that same payload. Host OS/DLLs remain trusted, not a hermetic closure.
Primary Git for Windows sources:
- https://gitforwindows.org/git-wrapper.html
- https://github.com/git-for-windows/build-extra/blob/main/ReleaseNotes.md
After both reader joins, the shared stop flag is sticky refusal: even Ok EOF
following the capture cutoff cannot establish a complete capture.

Trusted inline PowerShell resolves and hashes the payload before identity Git
reads and Cargo. It rechecks after those reads and passes path/SHA via GITHUB_ENV
as runtime observation, not a fourth authority. Python requires those original
bytes/path before identity reads and collection; postflight retains them. Both
resolvers inspect ancestors before counting even an absent candidate leaf, so a
dangling alternate layout refuses instead of silently disappearing.

Startup Git payload resolution/pinning precedes checkout actions. Those actions
may perform preparatory internal Git reads; their commit outputs grant nothing.
Only the subsequent exact clean HEAD checks approve candidate identity. No
payload directory is added to global PATH. Postflight Git reads are bracketed
by canonical no-reparse resolution and startup SHA checks, then all three
executables are pinned again before successful provenance is written.

BoundGit captures its frozen path/SHA once at controller startup. Every HEAD,
status and tree read validates that binding before and after Git; expected
identity is never reread from mutable environment. Trusted PowerShell uses
Invoke-ObservedGit with the same per-call before/after assertion, captures the
exit code, and emits stdout only after successful postvalidation.
