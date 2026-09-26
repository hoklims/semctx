---
name: index-control-plane
description: Govern code-intelligence routing, freshness, refresh, consumer generations, provider cost, and fallback across Codex and Claude Code. Use this skill whenever a task asks which code index to use, reports slow or stale indexing, touches CCC/CocoIndex, Graphify, Semctx, Serena, LSP or SCIP, changes index hooks or MCP exposure, opens a substantial Git worktree, or needs architecture/impact retrieval. Prefer this control plane even when the user only says the agent is slow, cannot find code, or seems to use the wrong context.
---

# Index Intelligence Control Plane

## Outcome

Give Codex and Claude the smallest trustworthy retrieval lane for the current question without paying for every index on every task.

An index accelerates discovery. It never proves a source claim. Source, compiler behavior, tests and live evidence remain authoritative.

## Architectural rule

Use one control plane per canonical Git worktree and one lightweight routing surface per host.

Separate these states:

1. `SOURCE_OBSERVED`: the worker recorded an exact source fingerprint.
2. `ARTIFACT_READY`: a provider produced an artefact for that fingerprint and generation.
3. `CONSUMER_READY`: a stateful consumer loaded that same generation.
4. `USABLE`: all requirements for the selected provider are satisfied.

Never infer consumer freshness from a file replacement. This matters especially for Graphify: a fresh `graph.json` does not prove that an already-running MCP reloaded it.

Read [references/gateway-contract.md](references/gateway-contract.md) when changing routing, host exposure or consumer registration. Read [references/evaluation.md](references/evaluation.md) before adding, promoting or retaining a provider.

## Retrieval hierarchy

| Question | Primary lane | Fallback | Persistent index |
| --- | --- | --- | --- |
| exact literal, error, path, config key | `rg` / Grep | direct file reads | none |
| definition, references, implementation, hierarchy | native LSP | Serena, then `rg` | optional SCIP |
| symbolic edit or LSP failure | Serena | source edit with exact proof | no default daemon |
| unknown concept or business vocabulary | CCC | `rg` over candidate terms | CCC only when configured |
| architecture, cross-module path, dependency neighborhood | Graphify | targeted source/LSP traversal | Graphify only when usable |
| authored intent, invariant, contract, semantic impact | Semctx | authoritative docs and source | Semctx only when sealed |

Use a more expensive lane only when the cheaper lane cannot answer the question accurately.

## Provider ownership

### Source and Git

Own the current worktree, exact text and final evidence. They are always available and need no refresh.

### Native LSP

Own live symbol truth. Start language servers only when symbol work requires them and release them after host inactivity. Do not keep one Serena stack per subagent. The reproducible TypeScript/Python lifecycle benchmark is `scripts/lsp_benchmark.py`; the dated baseline in `references/lsp-benchmark.md` shows excellent warm navigation but an approximately 802 MB TypeScript process tree, so reuse a host-owned session server instead of multiplying servers across agents.

### Serena

Own symbolic edit support and demonstrated LSP fallback. Do not expose Serena globally or start it merely because a project contains code.

### CCC / CocoIndex

Own concept discovery when the user does not know the identifier or file. CCC is available only when `.cocoindex_code/settings.yml` exists. Corroborate every relevant hit in source. Use CCC 0.2.41 or newer with its native `daemon.idle_timeout_minutes`; the gateway must not spawn a second lease supervisor. `ccc daemon status` itself auto-starts CCC, so use the control-plane status surface for non-mutating observation.

### Graphify

Own derived structural topology. Store host-local artefacts under `~/.agents/index-control-plane/repos/<worktree>/providers/graphify/`. Refresh dirty worktrees only at a checkpoint or explicit JIT request. Publish a generation-bound `query.sqlite` beside `graph.json`; interactive architecture queries use this bounded FTS/edge sidecar and never deserialize the complete graph. Require a matching consumer receipt only after the gateway validates the sidecar graph hash.

### Semctx

Own authored semantic claims and freshness seals. Semctx is available only when `.semctx/` exists. Keep it outside the interactive edit loop and refresh dirty worktrees only at an explicit checkpoint. An architecture JIT grant authorizes Graphify, never Semctx.

Each host runs its own semctx: Claude the plugin recorded in `~/.claude/plugins/installed_plugins.json`, Codex its highest installed `semctx-control` version. The shared `.semctx` store is stamped with its builder's tool version, so the host that authorizes a build (its checkpoint, or its latest event on a clean worktree) builds with its own binary, and the worker records every host's own `status` verdict on that build. Semctx is usable for a host only when that verdict is fresh. The worker retries negative verdicts on reconciliation without reindexing, and `refresh --host <host> --no-graphify` can publish a newer read-only verdict bound to the same build and source after an operator runs `semctx index --record`. A host on another version reads `SEMCTX_HOST_VERSION_SKEW`; the worker never reindexes to clear it, which would only move the skew to the other host. Align plugin versions, or take the store over explicitly: `reconcile_worker.py invalidate --provider semctx`, then `sync --host <host> --checkpoint`.

### SCIP

Treat SCIP as an optional durable symbol artefact, not an automatic new dependency. The 2026-08-16 reassessment established a non-experimental scripting surface through official `scip v0.9.0 print --json`; use `scripts/scip_json_probe.py` and never depend on `expt-convert` SQLite. The current pilots cover 14/14 TypeScript files and 8/8 Python files with exact task precision, but official `@sourcegraph/scip-python@0.6.6` still crashes on native Windows. A tested upstream patch exists locally; do not adopt SCIP globally or maintain a private indexer fork until that fix is merged and released. Keep native LSP plus exact-source fallback meanwhile.

## Source fingerprint

Bind the repository observation to canonical worktree root, `HEAD`, tracked binary diff content, untracked names and content, index configuration, and controller identity. Also bind each provider to its own corpus fingerprint and provider identity. Carry a READY artefact into a newer global generation only when that provider corpus is byte-identical.

The worker owns expensive fingerprinting. The prompt path reads the worker snapshot and never launches Git.

The fast route expires an old observation and falls back to source/LSP. A false negative is acceptable; a false current result is not.

## Routing fast path

Host hooks should read `~/.<host>/index-control-plane/repos/<worktree>/route-cache.json` directly.

The cache contains the generation, source state, provider and consumer readiness, publication and expiry times, normal context and fail-closed context.

Do not invoke `git status`, hash a worktree, probe providers or start an MCP from `UserPromptSubmit`. The Codex hot path uses the compiled cache reader at `~/.codex/hooks/index-control-routing.exe`; its auditable Rust source is adjacent. A missing or expired cache returns the fixed safe fallback and claims one host-local, worktree-scoped five-second wake lease before starting the detached worker asynchronously. Concurrent prompts reuse that lease; an expired lease permits recovery after a failed launch or crashed worker. Codex and Claude keep separate lease stores. Target the complete index-routing hook at p95 below 50 ms.

## Refresh lifecycle

- `SessionStart`: enqueue `session_start`, start the singleton worker, then publish a host route cache.
- source mutation: atomically mark the host generation dirty, enqueue `source_mutated`, invalidate the route cache and ensure the worker exists.
- CCC: reconcile incrementally after 8 seconds of quiet.
- Graphify: reconcile a clean worktree, or a dirty generation after 20 seconds of quiet and an explicit checkpoint/JIT grant.
- Semctx: reconcile after 45 seconds of quiet and an explicit checkpoint grant; never from an architecture JIT request.
- `Stop`: enqueue `checkpoint`; do not synchronously wait for Semctx.
- worker: poll for external drift, coalesce generations and exit after the settled idle TTL.

External shell, formatter, generator and checkout mutations may bypass edit hooks. The periodic audit detects them; an expired route observation fails closed until it does.

## Commands

Set `$skill` to the absolute directory containing this installed `SKILL.md` and `$python` to
an available Python interpreter. The skill can be installed globally or inside a Semctx plugin;
do not assume a particular user profile or plugin cache path. These commands inspect or operate
an existing index control plane. Installing the Semctx plugin does not install host routing hooks.

```powershell
$python = (Get-Command python).Source
$skill = '<absolute directory containing this SKILL.md>'

& $python "$skill/scripts/index_control.py" doctor --root <repo> --format json
& $python "$skill/scripts/index_control.py" route --host codex --root <repo> --format json
& $python "$skill/scripts/reconcile_worker.py" status --root <repo>
& $python "$skill/scripts/reconcile_worker.py" sync --host codex --root <repo> --checkpoint
& $python "$skill/scripts/gateway.py" --host codex
& $python "$skill/scripts/benchmark.py" --host codex --output "$env:TEMP/index-control-benchmark.json"
```

A trusted stateful Graphify consumer registers only after loading the artefact:

```powershell
& $python "$skill/scripts/index_control.py" consumer-ready --host codex --root <repo> --provider graphify
```

It invalidates the receipt before shutdown or reload:

```powershell
& $python "$skill/scripts/index_control.py" consumer-stale --host codex --root <repo> --provider graphify --reason CONSUMER_STOPPED
```

Do not use `consumer-ready` to make a dashboard green. It is a trusted consumer acknowledgement.

## Status interpretation

- `READY`: artefact and any required consumer match the generation.
- `ARTIFACT_READY`: artefact matches, required consumer does not.
- `STALE`: known mismatch or checkpoint pending.
- `BUILDING`: bounded work in progress.
- `UNKNOWN`: no trustworthy receipt.
- `FAILED`: provider or control-plane failure.
- `UNSUPPORTED`: provider is not configured.

Do not collapse the repository to one red/green answer in user communication. Report each provider, its fallback, and whether the problem is source, artefact or consumer freshness.

`status --live` recomputes the authoritative source fingerprint and compares it with exact cached provider receipts. It never starts CCC, Graphify or Semctx merely to observe their state; an absent receipt is `UNKNOWN` and a source mismatch is `STALE`.

## MCP exposure

Keep heavy project MCP servers disabled globally. An artefact may exist without being exposed, and an exposed MCP may be stale.

The target host surface is the stable `code_intelligence` gateway with exactly five tools: status, search, symbols, architecture and intent. It chooses providers internally, wakes an expired worker asynchronously, and returns provider, source fingerprint, provider corpus fingerprint, artefact generation, consumer generation, fallback and source locations. Keep the supported direct Semctx MCP available until this gateway is configured on that host, its five tools are observed, and its Semctx route works against the current source generation. Only then retire duplicate direct CCC, Graphify, Serena or Semctx MCP exposure beside the validated gateway.

## Failure behavior

- Expired observation: use `rg`/LSP and wake the worker.
- Artefact mismatch: refuse the provider.
- Consumer mismatch: refuse the stateful consumer.
- Refresh failure: retain the previous artefact as stale, never current.
- Concurrent hosts: coalesce events into one shared monotonic generation.
- Missing worktree: stop the worker and retain diagnostic receipts only.

## Performance and value gates

Target complete index-routing-hook p95 below 50 ms, gateway plus idle workers below 150 MB at rest, CCC refresh p95 below 10 seconds, Graphify checkpoint p95 below 30 seconds, Semctx outside the prompt/edit path, and zero stale result presented as current. Persistent global provider daemons are not part of the target architecture; CCC may start on demand and must exit through its native idle timeout.

Retain a provider only if a representative benchmark demonstrates marginal value. File, chunk, node, edge and claim counts are telemetry, not value evidence.

The benchmark corpus contains 30–50 tasks and reports raw query latency separately from time-to-correct-file. A miss must incur an explicit retry penalty; never hide slower raw latency behind the aggregate. Record per-task regressions, provider precision, fallback/stale rates, output-token estimate and memory limitations.

## Verification

After controller, worker, hook or contract changes:

1. run `py_compile`;
2. in the Semctx source checkout, run the complete `plugins/shared/skills/index-control-plane/tests/`
   suite, including gateway, lifecycle and benchmark tests;
3. validate the skill package;
4. measure cached-route latency on a large worktree;
5. exercise consumer mismatch and observation expiry;
6. run one bounded real-repository smoke without claiming universal freshness.

## Report

Return current worktree/generation, provider artefact and consumer readiness, chosen route/fallback, refresh work, latency/resource evidence, and deferred gates.
