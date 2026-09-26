# Provider evaluation

## Corpus

Use 30 to 50 real questions across at least three repositories. Include exact lookup, symbol navigation, concept discovery, architecture impact and authored-intent questions.

Each case records expected files or symbols and the source evidence required to confirm success.

## Metrics

- correct file or symbol in top 1 and top 5;
- time to first correct source;
- end-to-end task success;
- p50 and p95 route/query latency;
- peak and idle RAM;
- context tokens returned;
- stale/fallback rate;

Measure the whole configured index-routing command, including process startup and JSON serialization. A micro-benchmark of cache parsing alone is insufficient. Keep unrelated prompt hooks (for example governance or continual learning) as separate latency lanes so their cost is not falsely attributed to indexing.
- refresh duration and failure rate.

For native definition/reference navigation, run `scripts/lsp_benchmark.py`. Report server startup, first query, warm requests, process-tree memory, coverage and verified shutdown separately; do not label source text lookup as LSP latency. The dated baseline and routing decision live in `references/lsp-benchmark.md`.

For SCIP, use the official `scip print --json` scripting surface and `scripts/scip_json_probe.py`; do not base promotion evidence on the experimental `expt-convert` SQLite schema. Bind any derived query artefact to the exact SCIP file and source generation. The dated Windows/query reassessment lives in `references/scip-reassessment.md`.

## Comparison

Compare the smallest lane against the candidate provider. Do not compare only provider A against provider B without an `rg`/LSP baseline.

Exercise checkout, shell-generated changes, concurrent hosts, process crash, provider upgrade and consumer-generation drift.

## Promotion and removal

Promote only with no correctness regression and a measured operational or retrieval gain. Remove or quarantine a provider that adds less than 10 percent marginal value on its owned question class or violates the resource budget.
