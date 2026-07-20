# Semantic layer — reservation example (PARTIAL → VERIFIED)

A complete, reproducible walkthrough on the bundled sample repo
([`examples/sample-typescript-repo`](../../examples/sample-typescript-repo)): declare an invariant,
open a change contract, obtain a bounded slice, and watch the composed verdict move from **PARTIAL**
to **VERIFIED**. It uses no LLM.

## 0. Index the repository (Plane A)

```bash
semctx init
semctx index
# find the real graph ids you'll link to:
semctx inspect invariant confirmed-never-exceeds-capacity   # -> inv:confirmed-never-exceeds-capacity
semctx inspect symbol confirmReservation                     # -> sym:function:src/domain/confirmation.ts:confirmReservation:<line>
```

## 1. Author the semantic truth (Plane B)

```bash
semctx semantic init            # scaffolds .semctx/semantic/ (versioned)
```

Edit `.semctx/semantic/goals.sem`, `invariants.sem`, `unknowns.sem`, `evidence.sem`:

```
goal goal.booking.reliable-confirmation
  statement: A confirmation is applied at most once and never overbooks a slot.

invariant invariant.booking.no-overbooking
  statement: confirming a reservation must never exceed slot capacity
  status: declared
  serves: goal.booking.reliable-confirmation
  link: inv:confirmed-never-exceeds-capacity
  tag: critical

unknown unknown.booking.concurrency-race
  statement: two concurrent confirmations can both pass the capacity check and overbook.
  proved_by: proof.test.confirmation

evidence proof.test.confirmation
  statement: test/confirmation.test.ts asserts capacity is enforced on confirmation.
  status: declared
  link: test:test/confirmation.test.ts
```

Validate — links now resolve against the indexed graph:

```bash
semctx semantic check          # OK: semantic model is consistent
```

## 2. Open a change contract

```bash
semctx change open change.confirm-retry-safe \
  --statement "make confirmation idempotent under webhook retries" \
  --serves goal.booking.reliable-confirmation \
  --preserves invariant.booking.no-overbooking \
  --requires proof.test.confirmation \
  --unknown unknown.booking.concurrency-race \
  --link sym:function:src/domain/confirmation.ts:confirmReservation:12
```

## 3. Pull a bounded slice (the rehydration capsule)

```bash
semctx semantic slice --change change.confirm-retry-safe --format agent
```

```
# Semantic slice — scope: change=change.confirm-retry-safe, maxNodes=60  (truncated: no)
## Intentions
  - ◇ goal.booking.reliable-confirmation — A confirmation is applied at most once ... [declared]
## Invariants
  - □ invariant.booking.no-overbooking — confirming a reservation must never exceed slot capacity [declared]  (links: inv:confirmed-never-exceeds-capacity)
## Forbidden / safety constraints
  - □ invariant.booking.no-overbooking — ... [declared]
## Open unknowns
  - ? unknown.booking.concurrency-race — two concurrent confirmations can both pass ... [declared]
## Next expected proofs
  - proof.test.confirmation
```

## 4. Edit code, then verify — PARTIAL

```bash
# ... make the confirmation retry-safe ...
semctx verify diff --base origin/main               # Plane A: impact + PASS/WARN/BLOCK
semctx change verify change.confirm-retry-safe --base origin/main
```

```
Δ change.confirm-retry-safe  [active]
  underlying verify diff: PASS
preserved
  □ invariant.booking.no-overbooking [proved]        # touched & covered by test/confirmation.test.ts
pending proof
  ⊢ proof.test.confirmation [declared]
partial
  ? unknown.booking.concurrency-race
verdict: PARTIAL
WARN unproven / open: proof.test.confirmation, unknown.booking.concurrency-race
```

PARTIAL is honest: the code compiles and the invariant is covered, but you have not yet *obtained*
the required proof, and a real unknown (the concurrency race) is still open.

## 5. Obtain proof, resolve the unknown — VERIFIED

Run the test, then record the obtained proof and close the unknown (add a guard first if the race is
real — here we assume it was addressed):

```bash
# after the test passes, in .semctx/semantic/evidence.sem set: status: tested
# the unknown already declares: proved_by: proof.test.confirmation
semctx change update change.confirm-retry-safe --resolve-unknown unknown.booking.concurrency-race
semctx change verify change.confirm-retry-safe --base origin/main
```

```
Δ change.confirm-retry-safe  [active]
  underlying verify diff: PASS
preserved
  □ invariant.booking.no-overbooking [proved]
proved
  ⊢ proof.test.confirmation [tested]
verdict: VERIFIED
```

```bash
semctx change close change.confirm-retry-safe        # reruns composed verification, then derives verified
```

## Automated stress harness

An automated version of this walkthrough — plus the **BLOCKED**, **STALE**, **diagnostics** and
**determinism** cases — is in [`scripts/semantic-stress-test.sh`](../../scripts/semantic-stress-test.sh).
It scaffolds a throwaway `@invariant`-marked repo and asserts every verdict and exit code:

```bash
bash scripts/semantic-stress-test.sh        # Git Bash; CLI runs under Bun
KEEP=1 bash scripts/semantic-stress-test.sh  # keep the throwaway repo for inspection
```

From PowerShell, a thin wrapper delegates to the same script through Git Bash:

```powershell
.\scripts\semantic-stress-test.ps1
$env:KEEP = '1'; .\scripts\semantic-stress-test.ps1   # keep the throwaway repo
```

## What this demonstrates

- The verdict is **never more optimistic than the data**: PARTIAL until the proof is actually
  obtained and the unknown resolved.
- `change verify` **composes** `verify diff` (the `underlying verify diff: PASS` line) — it does not
  replace or soften it.
- Everything is deterministic and traceable: each invariant/evidence/unknown points to a source, and
  a stale link (e.g. deleting the test) would flip the verdict to STALE.
