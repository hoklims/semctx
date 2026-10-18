# T00 reopened: C1, R0 pending

Sébastien reopened T00 on 2026-10-18 from `STOP_BUDGET`. Work continues on
`rust/365-t00`, PR [#386](https://github.com/hoklims/semctx/pull/386), from
`6270bc10765d697a4311150e3e1a4aea8a726335`. This is the same T00; no new branch,
PR or separate experiment is authorized. C1 is the only active composition. C2
is abandoned for this resumption, with its history preserved.

[record.json](record.json) is the current decision and budget record. It adds
two C1 correction passes after the two historical passes. Neither new pass had
started at registration. The first additional pass is now open, with
[current focused harness evidence](worker-case-mode-evidence.json). Approximately 3–4 days is the owner's planning estimate,
not measured effort or an inferred exact ceiling. [effort-ledger.json](effort-ledger.json)
records the resumed work separately from the [historical ledger](../final/effort-ledger.json).
The [old terminal dossier](../final/README.md), raw outcomes, frozen expectations
and historical budget counters remain traceable.

The owner classifies diagnostic `1490` versus frozen `1127` for
`ENC::UTF16LE-lone-high-surrogate::ordinary` as a TS7-versus-TS5.9.3 difference.
[T00-ARB-002](../arbitrations.json) binds that decision to the exact support,
artifact and observed versions: crate `7.0.0-dev`, compiler `7.1.0-dev`, upstream
`780dc512d64f40afebffa6a7028207649fb7ed1c`, SDK `5.9.3`. This is an owner
adjudication, not newly isolated upstream root-cause evidence. Each additional
version-attributed difference needs individual proof; all others remain actual
divergences. Raw observations and frozen expected codes are not rewritten.

The ordered work is:

1. Register this reopening, budget and arbitration, preserving history.
2. Correct the ten failed harness observations: seven qualification units and three supports.
3. Resolve the 64 GAP units through comparators, recipes and mappings.
4. Review the 178 obligations still requiring property/support review.
5. Replay all 354 units on macOS, Linux and Windows; use GitHub Actions for Linux/Windows.
6. Execute the 23 reserved cases / 26 variants once, after the preceding campaign.
7. Decide `READY_TS_NATIVE`, or `STOP_SEMANTIC` if unarbitrable native divergences remain.

At registration, the last observation is still **0/240 qualified obligations**.
The historical counts remain 283 limited PASS, 7 NONPASS and 64 GAP units;
42 limited PASS, 4 NONPASS and 5 GAP supports. Qualification has run on macOS
only. Existing three-OS evidence covers four DEV vectors. Reserved inputs remain
unaccessed and unexecuted during this registration. No resumed campaign or R0
passage is claimed. [The independent claim ledger](claim-audit.md) records the
authority and limits of this registration.

The [previous incomplete checkpoint](harness-repair-evidence.json) preserves the
case-insensitive alias bypass and its red witness. The user reactivated the blocked
goal after that reported local workflow stop; the
[bounded continuation](local-review-continuation.json) records the resumed
correction without resetting counters or changing the C1 budget. The ten original
observations and four guard comparators now pass focused macOS DEV checks, with
case sensitivity measured by the harness. The guard comparators and seven recipe
CLI tests are wired into the native three-OS CI lane; new remote evidence remains
to be collected. Steps3–7, the full campaign, reserved run and R0 remain pending.

Normal pushes to the same branch and PR-description updates are authorized.
Every GitHub comment is prohibited. Pins remain exact, Actions use full commit
SHAs, and `verify:pr` uses Bun `1.4.3` with `GIT_CONFIG_GLOBAL` unset. A required
owner decision stops dependent work and is explained in the terminal. T01,
substantial ports, merge, release and deployment remain outside this resumption.
