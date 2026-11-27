# Solo-maintainer authorization

On 2026-11-27 the repository owner requested removal of procedural approval gates so work
could continue with one maintainer. This standing decision applies to owner-requested
Semctx maintenance and the Rust migration. The owner may narrow or revoke it in a task.

The following table defines the operational decisions. `CONTINUE` covers the requested task;
`HOLD` withholds the affected action until its condition is satisfied. It never blocks unrelated
authorized work. Explicit current user instructions take precedence.

| Operation | Decision | Required condition or authority |
| --- | --- | --- |
| Public development, validation and bounded correction | CONTINUE | Owner-requested task; record scope and resource estimate |
| Read a public metadata receipt | CONTINUE | Public metadata only; private payloads stay with their custodian |
| Commit, branch and publish a PR | CONTINUE | Within the owner-requested task; affected checks pass |
| Normal merge into main | CONTINUE | Exact-head selected CI passes; findings addressed; conversations resolved; branch protection respected |
| Exceed an explicit current user limit | HOLD | Owner must change that limit |
| Retry the closed N17c capture | HOLD | This policy does not reopen its consumed 1+1 envelope |
| Read a reserved payload or launch a reserved experiment | HOLD | Separate custodian authority and applicable campaign envelope |
| Release or deploy | HOLD | Separate delivery authority |
| Start a new paid resource | HOLD | Separate spending authority |
| Deliver with missing or failed mandatory proof | HOLD | Satisfy the proof required for that action; continue independent work |
| Declare READY_TS_NATIVE | HOLD | Frozen R0 criteria and required executed evidence satisfied |

## Continue the authorized task

The agent handles public development and validation, bounded corrections, commits, branches,
PR publication, required checks and normal merges into `main`. It does not request a new
human approval for each command, public case, correction, PR or routine delivery step.
Record the next useful scope and an estimate in the existing plan, run the affected checks,
and continue. Report material overruns and new findings. Stop adding optional work when the
requested outcome and its required checks are satisfied.

There is no requirement for another human to approve the owner's own PR. An independent
proof review may use a separate read-only agent; its opinion does not replace executed
acceptance. Wait for the selected `semctx-required` result on the exact head, address review
findings and resolve conversations before a normal merge. Preserve branch protection and
other authors' branches. Release, deployment, new paid resources and destructive operations
outside the requested task require their own authority.

## Public R0 development

This decision replaces repeated per-tranche permission requests for public development,
correction and validation under [issue #365](https://github.com/hoklims/semctx/issues/365).
The agent records a bounded work scope and resource estimate itself; a separate owner reply
is not required solely to begin that next public scope. Keep the actual counters and results
in the existing research record. Do not manufacture a new approval requirement from an
estimate, historical pass ceiling or an unavailable historical budget log.

An explicit current user limit on time, spend, cases, invocations or retries remains binding.
Do not reset a closed campaign, relabel a forbidden retry or carry its receipts to a new
candidate. This decision does not reopen the completed N17c 1+1 capture, grant access to
reserved payloads or authorize a new reserved experiment. Public metadata receipts may be
read without a separate approval, while private case contents remain with their custodian.
Public validation may prepare and exercise controls such as J04/J05; a formal qualification
campaign still needs its protocol, frozen identities, expectations and recorded envelope.

## Preserve technical acceptance

Keep frozen inputs, expected results, obligation identifiers and denominators. Retain raw
differences, failures, unknowns, old candidates and their receipts. A changed candidate needs
new evidence where the change invalidates the old evidence. Development checks, CI, review,
merge, product admission and R0 qualification remain separate claims.

Changes to a proof mechanism or normative acceptance rule still require the applicable
independent aggregate review and relevant negative witnesses. Qualification and reserved-case
independence, native platform requirements and the criteria for `READY_TS_NATIVE` remain in
force. No human confirmation or review comment can turn a missing test or a failed gate into
a pass. If a mandatory check is unavailable, report that specific gap and withhold only the
delivery or claim that depends on it; continue independent authorized work.
