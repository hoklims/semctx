# TaskFrame

A **TaskFrame** turns a raw task into an explicit, structured object. It is produced by a
`TaskFrameExtractor`; the MVP ships a deterministic, heuristic one (no LLM). The interface
is pluggable so an LLM-backed extractor can be added later without touching the engine.

## Shape

```ts
interface TaskFrame {
  id: string;              // deterministic: task:<fnv1a(rawTask)>
  rawTask: string;
  mode: TaskMode;          // bugfix | feature | refactor | audit | performance | security | migration
  capabilities: string[];
  observedBehavior: string[];
  expectedBehavior: string[];
  boundedContexts: string[];
  hardInvariants: string[];
  softConstraints: string[];
  acceptanceEvidence: string[];
  nonGoals: string[];
  riskSurfaces: string[];
  hypotheses: TaskHypothesis[];
  createdAt: string;       // ISO timestamp — the only non-deterministic field
}
```

## Inputs

The extractor accepts three shapes, all without any LLM:

- **JSON** (`task.json`) validated by `TaskFrameInputSchema` (Zod, boundary validation);
- **Labelled Markdown** — lines like `mode:`, `capability:`, `invariant:`,
  `bounded context:`, `observed:`, `expected:`, `non-goal:`, `risk:` are parsed
  (`parseTaskDocument`); free text becomes `rawTask`;
- **Plain text** (`--text "..."`) — everything is inferred from the text.

## Heuristics (all deterministic, all labelled as heuristic)

- **mode** — explicit hint, else keyword detection ("fix"/"bug"/"regression" -> bugfix, etc.).
- **capabilities / invariants / bounded contexts** — explicit hints, plus any known graph
  slug whose significant word (>=4 chars) appears in the task text.
- **graph wiring** — a matched capability additionally pulls in the invariants and
  bounded contexts its implementing symbols are wired to, so a terse task
  ("fix the confirmation") still resolves the invariant it must not break.
- **hypotheses** — templated from mode + matched capability/invariant/risk; all start
  `unverified`.

Nothing here is presented as exact: it is heuristic extraction, and the pack's downstream
selection re-derives the authoritative set from the graph, not from the extractor's guesses.
