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
- **Pinned `@lezer/python` for the first Python vertical (ADR 0011)**: version 1.1.19 keeps
  parsing inside the Bun/JavaScript process with no Python subprocess, native addon or WebAssembly
  runtime. The declared capability stops at Python 3.12 and excludes ambiguous/dynamic/imported-
  symbol resolution, typing, calls and negative completeness. The real-repository corpus is pinned
  to `pytest-dev/pluggy` 1.6.0 commit `fd08ab5f811a9b2fa9124ae8cbbd393221151e2c`.
- **Contributor autonomy uses a governed contract ring (ADR 0013)**: one local `verify:pr` gate
  feeds one stable required CI result, while risk tiers and narrow ownership route public-contract
  decisions to the maintainer without gating demonstrably contract-preserving routine work. The
  thin-transport rule applies to new or materially modified flows; the direct context-preparation
  coordination in `apps/cli/src/commands/context.ts` and `packages/mcp-server/src/tools.ts` is
  tracked as maintainer-owned legacy debt in issue #77, not mandatory collateral migration for
  contributors.
