# Native LSP benchmark — 2026-08-16

The reproducible runner is `scripts/lsp_benchmark.py`; its task manifest is
`evals/lsp-benchmark-tasks.json` and the complete machine-readable result is
`references/lsp-benchmark-2026-08-16.json`.

## Scope

- TypeScript: `typescript-language-server 5.3.0` with TypeScript `5.9.3` on BattleBot.
- Python: `pyright 1.1.411` on the Semctx repository.
- One definition and one references task per language.
- The same symbols are queried through the gateway source lane for a functional comparison.
- Cold startup includes process creation, initialize, document open and the first request.
- Memory is the observed working set of the server process tree.
- Shutdown is requested through LSP and process exit is verified.

Run:

```powershell
C:/Python314/python.exe scripts/lsp_benchmark.py --warm-runs 10 --output references/lsp-benchmark-2026-08-16.json
```

## Results

| Lane | Cold initialize + first query | Warm definition p95 | Warm references p95 | Process-tree RAM | Coverage | Exit |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| TypeScript | 2,585 ms | 75.0 ms | 13.2 ms | 802.2 MB | 2/2 | clean |
| Python | 527 ms | 0.7 ms | 30.0 ms | 147.8 MB | 2/2 | clean |
| Gateway source comparison | n/a | 127–172 ms per task | 120–128 ms per task | gateway process only | 4/4 | per call |

## Decision

Keep native LSP as the authoritative definition/reference lane. It is much more
precise than text lookup and very fast after startup, but the TypeScript server
tree is too expensive to multiply across agents. Do not add a persistent LSP
MCP and do not let every subagent start its own server. Reuse the editor/session
server where the host already owns one; otherwise start it on demand and stop it
with that session. The gateway remains the safe source fallback when no native
LSP session is available.
