# ADR 0012 — Adopt the complete stable MCP 2026 surface without widening authority

- Status: accepted
- Date: 2026-07-29
- Related: ADR 0003 (task-relative authority), ADR 0008 (versioned machine output),
  ADR 0009 (Plane A/Plane B separation)

## Context

The MCP TypeScript SDK v2 can negotiate the 2026-07-28 protocol while continuing to serve legacy
stdio clients. It also adds structured tool results, catalogue cache hints, W3C trace metadata, and
the resource metadata needed by MCP Apps.

Semctx currently exposes a local stdio server through two byte-identical plugin bundles. Its tools
include both read-only analyses and operations that persist SQLite or Plane-B state. Plane C remains
descriptive and non-authorizing. A protocol upgrade must therefore preserve local compatibility,
deterministic outputs, plugin parity, freshness semantics, and the existing authority boundary.

The 2026 Tasks extension has no compatible v2 TypeScript runtime package at the time of this
decision. The v2 SDK deliberately rejects the deprecated `tasks/*` wire vocabulary on modern
connections. A remote HTTP surface would additionally require repository identities, principal
isolation, authentication, quotas, and a root policy that is stronger than the local stdio
contract.

## Decision

Adopt the complete stable and locally safe MCP 2026 surface:

1. Pin `@modelcontextprotocol/server` and the test-only client to version `2.0.0`.
2. Serve stdio through `serveStdio(factory, { legacy: "serve" })`.
3. Keep business validation on the repository's existing Zod version and use Zod 4 only at the MCP
   schema boundary.
4. Give every tool a declared input schema, output schema, effect annotation, and explicit UI
   visibility.
5. Return one canonical result object as both `structuredContent` and deterministic JSON text for
   legacy hosts, subject to the scoped index-health corrective amendment below.
6. Cache only the deterministic tool/discovery catalogues and the versioned static App resource,
   with private scope. Do not cache repository reports, freshness decisions, authority decisions,
   errors, or tool calls.
7. Accept W3C `traceparent` and `tracestate` as request-scoped observability context. Validate their
   shape before use, never persist or return them, and never log or propagate `baggage`.
8. Add one read-only MCP App resource and aggregate explorer tool. The app receives only a bounded
   snapshot, performs no tool call, has no network permission, and always displays
   `executionAuthority: "none"`.
9. Keep the Claude Code and Codex plugin bundles byte-identical and preserve a text fallback for
   hosts without MCP Apps.

The public tool catalogue remains deterministic. Effect annotations are descriptive hints, never
authorization. Tools that can persist under any valid input are classified as writers for their
whole contract.

## Exposure profiles

| Profile | Transport | Surface | Authority |
| --- | --- | --- | --- |
| `local-full` | stdio | Existing read and write tools plus the read-only explorer | Existing local policy only |
| `app-readonly` | MCP App snapshot | Explorer data only; no callable writer | None |
| `remote-readonly` | Reserved | Not served | None |

Every normal tool is explicitly visible to the model and invisible to an app. The explorer is
visible to both the model and supporting app hosts. The app cannot call change, handoff, prepare,
target, indexing, shell, patch, or any other mutating operation.

## Repository root policy

When `SEMCTX_ROOT` is a concrete filesystem path, the local stdio server is bound to that
canonical repository root at process construction. Missing, empty, whitespace-only, and
unsubstituted host placeholders of the form `${NAME}` (for example `${CLAUDE_PROJECT_DIR}`
passed literally by a host that does not expand Claude Code plugin env templates) are
equivalent to unset. Without a usable process-bound root, the first valid tool call pins one
canonical repository root for that connection so portable hosts (Codex, Grok, and any other
stdio launcher that starts outside the target checkout) can still connect. Every later call
on the connection must name the same root.

A different absolute path, relative escape, or symlink escape is rejected before repository, Git,
SQLite, or source access. The same policy applies to the new explorer. This connection-local
pinning does not by itself authorize a remote transport.

## Structured result contract

For every successful tool call:

- the application service produces one canonical JSON-compatible value;
- that value is validated against the tool's declared output schema;
- `structuredContent` contains the canonical value;
- the text fallback is derived from the same value using the existing deterministic formatting,
  subject to the scoped index-health corrective amendment below;
- neither transport metadata nor trace context can change the value.

Error responses remain `isError: true`, bounded, and text-compatible. Their text is deterministic
JSON with exactly one stable error code and one fixed public message. Public messages come from an
exhaustive catalogue and stay within 512 UTF-16 code units; raw exception messages, schema issues,
arguments, repository paths, trace context, and diagnostic causes never enter the response. Error
responses do not carry `structuredContent`.

The advertised input JSON Schema remains authoritative. Because SDK v2 validates registered schemas
before invoking a tool callback, the stdio registration adapter preserves that exact catalogue
schema while `ToolRegistrar` owns execution-time validation: a raw structural budget, fail-fast
JSON-Schema validation, then the original Zod parse for defaults, stripping, transforms, and custom
refinements. The raw budget rejects inputs deeper than 64 levels, above 100,000 visited values, with
an array longer than 50,000 items, or with a key longer than 1,024 UTF-16 code units. No business
handler runs before all three gates pass.

Local diagnostic and request-context observers are advisory. They may receive original causes
in-process, but their own failures cannot change a successful tool result or escape into the public
error envelope. A handler cannot publish its own `isError` payload; such a return is normalized as
an internal contract failure.

## MCP App contract

The Control Explorer resource uses a versioned `ui://` URI and
`text/html;profile=mcp-app`. Its HTML, CSS, and JavaScript are self-contained. Content security
policy denies network, nested frames, and external resources. Rendering treats all repository data
as text and never injects it as HTML.

The snapshot keeps these dimensions separate:

- source freshness;
- bounded L6-L0 coordinate coverage;
- graph and impact evidence;
- authority regime and obligations.

The bounded graph also reports exact omission counts by cause: node limit, edge
limit, or a refinement endpoint absent from the full raw graph. Missing
endpoints are classified before node bounding, totals reconcile with returned
items plus omissions, and omitted identifiers are never exposed.

`FRESH` does not imply complete analysis. `STALE` and `UNSEALED` never expose refused historical
payloads as current facts. `ALLOW` and `DENY` are descriptive reports, not controls.

## Explicit non-goals

- Do not implement or advertise Tasks until a compatible stable v2 extension exists.
- Do not emulate Tasks with custom method names or deprecated wire messages.
- Do not add `input_required` as a human-authorization channel.
- Do not start an HTTP listener, public endpoint, tunnel, OAuth server, or remote repository API.
- Do not add a frontend framework or the v1-only MCP Apps SDK dependency.
- Do not grant the app execution, write, shell, patch, approval, or model-context authority.

These are upstream or security gates, not partially delivered features.

## Verification

The migration is accepted only when all of the following are fresh and green:

- real-process stdio smoke tests for legacy and 2026 negotiation;
- catalogue tests covering every tool's schemas, annotations, and visibility;
- structured-result equivalence and schema validation tests;
- bound-root and symlink-escape adversarial tests;
- trace non-leakage and cache-boundary tests;
- MCP App resource, CSP, payload-bound, rendering, and zero-writer tests;
- repository typecheck and test suite;
- plugin rebuild and byte-parity checks for Claude Code and Codex.

## Consequences

Modern MCP clients receive typed results, catalogue caching, trace correlation, and a native
read-only control view. Legacy clients keep the same stdio path; index-health text result semantics
change under the scoped corrective amendment below. The protocol becomes easier to consume without
turning semctx into a remote service or expanding Plane C into execution authority.

Tasks and HTTP remain honest future work behind explicit upstream, identity, isolation, and
security gates.

## Accepted corrective transport bound — 0.4.1

The maintainer-approved 0.4.1 correction supplies a finite 32 MiB serialized-message buffer to
the existing `serveStdio` factory. The SDK's implicit 10 MiB default closed a valid connection
when a caller provided the reproduced 17,664,355-byte diff. The source of truth is the MCP
entrypoint's transport construction; both plugin bundles regenerate from that entrypoint.

This widens message admission without changing a tool schema, result version, era negotiation,
root binding or analysis authority. The JSON envelope and escaped content count toward the
bound; it is not a total-memory guarantee. Larger inputs close the transport and receive a
payload-free stderr diagnostic directing callers to omit `gitDiff` and use the existing Git-read
path. Caller-provided diffs still do not establish Git source identity.

No consumer migration is required for previously admitted messages. Rollback to 0.4.0 restores
the smaller SDK default, while the Git-read fallback remains available. Runtime process tests
must cover admitted large messages, follow-up RPC, rejection above the bound, stderr-only
guidance, and modern/legacy negotiation. Source and cross-host generated-byte parity remain
required before publication; publication and fresh-session activation are separate evidence.

## Accepted corrective index-health contract — #316

This amendment was accepted with the correction for [#316](https://github.com/hoklims/semctx/issues/316),
merged in [#317](https://github.com/hoklims/semctx/pull/317).
The complete V1 health report grows with repository candidates and was serialized twice. The issue
reports a 16.6 MB response for 1,000 files and connection closure on larger responses. Increasing
the transport buffer again would leave that growth unbounded.

The scoped decision is to expose a shared `IndexHealthReportV2` through `semctx_index_health`:

- return a summary by default, preserving full-report status, binding, freshness reasons, coverage,
  evaluation outcome counts, and detail totals;
- opt into one of the seven detail sections per request, with deterministic pagination, a default
  limit of 20, a maximum of 100, and shorter pages when the byte budget requires it;
- bind cursors to the section and canonical digest of the complete V1 report; changed reports
  require restarting rather than combining different snapshots;
- limit the canonical V2 report to 240 KiB and the serialized MCP result to 255 KiB before the
  JSON-RPC envelope;
- return a catalogue error when a summary or indivisible entry cannot fit, rather than truncate it;
- place the V2 payload once in `structuredContent`, with a short deterministic human status summary
  in `content`, for this tool only.

The [MCP 2026-07-28 structured-content specification](https://modelcontextprotocol.io/specification/2026-07-28/server/tools#structured-content)
recommends serialized text duplication with `SHOULD`, rather than requiring it with `MUST`.
This exception deliberately gives up the JSON text fallback for index-health to avoid duplicating
the bounded report. Other tools retain the original structured/text equivalence contract, and
catalogue error handling is unchanged.

The CLI keeps complete V1 `index-health --json` output for compatibility; `--summary --json` and
`--section … --json` use exactly the shared V2 projection and pagination service. Both supported
MCP protocol negotiations return V2. Existing clients must migrate from V1 or JSON text parsing to
the V2 `structuredContent`; text-only hosts receive a basic status summary. An omitted page does
not claim absent details, and pagination never upgrades blocked or degraded health.

The correction requires regression oracles for a synthetic 1,000-file repository, result byte
bounds including escaped UTF-8, all detail sections and continuations, stale and invalid cursors,
oversized indivisible entries, full-report health gates, CLI V1 compatibility and V2 parity, and
follow-up calls through legacy and 2026 stdio. These bound the delivered result, not repository
size, indexing work, or total runtime memory. Repository checks and plugin byte parity remain
required before publication.
