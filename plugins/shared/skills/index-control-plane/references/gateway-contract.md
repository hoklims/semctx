# Gateway contract

## Purpose

Expose one stable code-intelligence surface per host while keeping provider lifecycle, freshness and cost behind the control plane.

## Required response envelope

Every indexed response carries:

```json
{
  "provider": "graphify",
  "source_state_id": "sha256:...",
  "artifact_generation": 42,
  "consumer_generation": 42,
  "freshness": "READY",
  "fallback_used": false,
  "sources": []
}
```

If a provider cannot supply this envelope, treat it as a legacy direct tool and corroborate its output against source.

## Stateful consumer protocol

1. Read the provider receipt.
2. Open the named bounded query artefact; do not deserialize a complete Graphify graph on the request path.
3. Verify the query artefact's graph hash belongs to the receipt generation and source state.
4. Publish `consumer-ready` only after validation and a successful bounded query.
5. Invalidate the receipt before reload, shutdown or project switch.

Never acknowledge readiness during startup before the artefact is actually loaded.

## Stable tools

Prefer `status`, `search`, `symbols`, `architecture` and `intent`. Provider startup is internal. Dynamic MCP discovery is optional, not a correctness dependency.

## Host boundary

Codex and Claude may keep separate gateway processes and host receipts. They share worktree generations and provider artefacts, not permissions, conversation state or authority.

A shared artefact is not necessarily usable by both hosts. Semctx is a probed consumer: the worker records each host's own `status` verdict on every build and retries negative verdicts on later reconciliations. A host `refresh` may publish a newer read-only `status` verdict only when the build and source match before and after its probe. The route chooses the latest matching verdict. Neither path runs `index --record` or treats `consumer-ready` as a Semctx status probe.
