---
name: semctx-semantic
description: >-
  Carry intent, invariants, decisions, evidence and unknowns through a non-trivial change using the
  semctx semantic layer. Use when starting substantial work: open or select a change contract, pull a
  bounded semantic slice, then keep the contract honest as you edit — verify impact, compose the
  change verdict, run the recommended tests, and record proofs/unknowns. Never conclude on a BLOCK.
---

# Working a change with the semctx semantic layer

The semantic layer is **authored truth** (Plane B) that sits beside the deterministic repository
graph (Plane A). It answers *"which intention, invariants, decisions, evidence and unknowns must
survive while I change this system?"* — it does **not** find files for a task (that is grep/BM25/
embeddings; see ADR 0005). Everything is deterministic and works with no LLM; you make it better.

## The loop (non-trivial change)

1. **Open or select a change contract.**
   - `semctx_change_open` with `{ id: "change.<slug>", statement, preserves: [...], serves: [...],
     requires: [...], unknowns: [...] }`. It becomes the active change (provenance `agent`).
   - `preserves` are the invariants this change must not break; `requires` are the proofs you will
     owe; `unknowns` are the open questions you must not silently drop.

2. **Pull a bounded semantic slice.** `semctx_semantic_slice { changeId }` (or `symbolRef` /
   `claimRef`). Read the capsule: Intentions, Invariants, Decisions, Linked symbols/claims, Evidence
   obtained, Open unknowns, **Forbidden / safety constraints**, Next expected proofs. It is bounded
   and every line points to a source — treat anything absent as **unknown**, not as false.

3. **Edit the code.**

4. **Analyse impact.** Call `semctx_verify_change` (Plane A: impacted symbols/contracts/invariants,
   recommended tests, PASS/WARN/BLOCK). This is unchanged and still first-class.

5. **Compose the change verdict.** Call `semctx_change_verify { changeId }`. It reuses the impact
   report verbatim and folds in the contract:
   - **VERIFIED** — all preserved invariants proved/untouched, all required evidence proved, no open
     blocking unknown, no stale link.
   - **PARTIAL** — open non-critical unknowns or unproven required evidence; nothing blocking.
   - **BLOCKED** — an underlying BLOCK, a critical preserved invariant touched without a test, a
     contradicted invariant, or (per config) a superseded decision in use.
   - **STALE** — a repository link no longer resolves (the model drifted from the code) — re-link
     before trusting the verdict.

6. **Run the recommended tests** from the impact report. They must pass.

7. **Record progress.** When you actually obtain a proof (you ran the test and it passed), update the
   evidence node's status to `tested` / `runtime_verified`, and resolve unknowns with
   `semctx_change_update { id, resolveUnknowns: [...] }`. `change_verify` will **not** turn PARTIAL
   into VERIFIED on its own — obtaining proof is your job (semctx is static; running the test is the
   dynamic step).

## Rules

- **Never conclude "done" on a BLOCKED verdict.** Resolve the finding (add the test / fix the change)
  or the user explicitly disables the rule in `.semctx/config.json`.
- **On PARTIAL, say exactly what remains unproven** — list the pending evidence and open unknowns.
  PARTIAL is honest, not finished.
- **On STALE, re-link before trusting anything** — a stale link means the declared coupling drifted.
- **Never invent a relation, a proof or an invariant.** Only cite what the slice / reports show. If
  the model does not declare it, it is an open unknown.
- **Keep the two planes distinct.** A structural fact ("X calls Y") is Plane A; an intention ("X must
  never happen twice") is Plane B. Do not launder one into the other.

## Handoff before compaction

Before a context compaction or handing the work to a fresh agent, call `semctx_handoff` (optionally
with a `note`). It captures the active change, touched invariants, obtained/pending proofs, open
unknowns and next validations into `.semctx/working/`. On resume, call `semctx_resume` to rehydrate a
short, stable capsule. These are explicit tools — do not rely on any implicit compaction hook.

## Local equivalents (no MCP)

```
semctx semantic init                         # scaffold .semctx/semantic/ (versioned)
semctx change open change.<slug> --preserves <inv-ids> --unknown <unknown-ids>
semctx semantic slice --change change.<slug> --format agent
semctx verify diff --base origin/main         # Plane A impact
semctx change verify change.<slug> --base origin/main   # composed verdict
semctx semantic handoff                       # / semctx semantic resume
```
