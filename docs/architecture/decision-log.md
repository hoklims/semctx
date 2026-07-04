# Decision Log

Running log of non-obvious engineering decisions. ADRs capture the big ones; this file
captures the smaller judgement calls.

- **License Apache-2.0** (not MIT): explicit patent grant lowers legal friction for B2B
  enterprise adoption. Both maximise adoption; Apache-2.0 is the safer enterprise signal.
- **Bun native test runner (`bun:test`) for our packages**, Vitest inside the fixture:
  the fixture's Vitest files are *data the analyzer detects*, not tests we execute. This
  keeps `bun test` working out of the box while still exercising Vitest detection.
- **Isolated bun linker kept** (default in 1.3): per-package `node_modules` symlinks
  resolve for both `bun` runtime and `tsc`. Verified before building on top.
- **Semantic nodes from explicit markers**, never LLM inference: `@capability`,
  `@invariant`, `@contract` JSDoc tags + markdown frontmatter. This is what makes
  authority deterministic and traceable. Lexical association is a labelled weak signal.
- **Timestamp is the only non-determinism**, injected via `Clock` so tests pin it.
- **Path normalisation centralised in `core`** so no other package needs backslash
  regexes (keeps Windows/POSIX behaviour identical and the code portable).
- **Product repositioned to a change-impact analyzer (ADR 0005)**: a comparative eval on
  16 real commits (`benchmarks/change-impact-eval`) showed `task → ContextPack` loses to a
  plain BM25 content retriever (R@10 0.31 vs 0.97) and that semctx's own graph+scoring stages
  are net-negative on unannotated code. `verify diff` is the shipped surface; the retriever is
  withdrawn (not tuned) because the deficit is architectural — it never reads file content.
- **Severity tiers `strict`/`advisory`** on blocking rules: strict → BLOCK (invariant or a
  `critical`/`security`-tagged contract changed without a proving test), advisory → WARN
  (plain exported contract without a direct test, or a touched contradiction). `tier` is
  optional on disk and derived from `severity` when absent (`tierOf`) for backward compat.
