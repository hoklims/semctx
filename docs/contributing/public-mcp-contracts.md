# Public MCP contract review guide

Contributor guidance for changes that touch the **public MCP agent surface**.
This guide **implements** [ADR 0012](../adr/0012-mcp-2026-stable-surface.md); it does
not supersede it. When in doubt, the ADR wins.

Relevant ADR 0012 invariants (non-exhaustive):

- successful tools return one schema-validated value as both `structuredContent` and JSON text,
  except for the scoped `semctx_index_health` V2 contract below;
- **error** responses are catalogue-only (`isError: true`, fixed code + public message, **no**
  `structuredContent`);
- **a handler cannot publish its own `isError` payload** — such a return is normalized as an
  internal contract failure;
- effect annotations, catalogue cache, root confinement, trace non-leakage, plugin parity, and
  App visibility rules remain as stated in the ADR.

The index-health corrective amendment in ADR 0012 returns the bounded V2 report once in
`structuredContent` and a short human status summary in text. This exception is named to that tool
in `ToolRegistrar`; it does not permit other handlers to bypass JSON text equivalence or output
validation. Review index-health for global blocked/degraded status preservation, opt-in bounded
pages, changed-report cursor rejection, and the final serialized-result byte limit. CLI V1 remains
complete by default; CLI V2 and MCP share the same projection and pagination service.

## Blast-radius tiers (not Plane A/B/C)

Do **not** call these “Class A/B/C” — that collides with Semctx’s Plane A/B/C vocabulary
(repository facts / authored semantic truth / control). Use these risk tiers instead:

| Tier | Examples | Bar |
|------|----------|-----|
| **PUBLIC_CONTRACT** | `ToolRegistrar`, MCP output schemas, wire error catalogue, agent success gates in skills/descriptions, annotations, visibility, root confinement, cache boundaries, plugin parity | Fail-closed default; adversarial tests where the surface can leak or widen; treat as security-class |
| **DOMAIN_FEATURE** | Shared app-services mutation (e.g. setup), preflight, policy refuse as structured domain outcome | Unit tests on the SSoT + happy + negative cases |
| **TRANSPORT_DX** | CLI progress lines, human messages, CLI-only presets | Integration tests as needed |

**Rule:** if a DOMAIN_FEATURE need requires changing a PUBLIC_CONTRACT file, the change **is**
PUBLIC_CONTRACT. Do not land it as “nit polish” without the bar below.

## Domain outcomes vs protocol errors (ADR 0012)

Negative **domain** outcomes (policy refuse, not-ready analysis, advisory mismatches) are
**ordinary schema-valid structured results** on the success path:

- `isError` stays **false**;
- agents fail closed by reading `kind` / `verdict` / equivalent fields;
- skill and tool description define the agent success gate explicitly.

Protocol and transport failures remain catalogue errors (`isError: true`, no structured body).

Do **not**:

- allowlist handler-authored `isError: true` + success-schema body for any tool;
- treat schema validity of a forged `isError` payload as trust;
- document an exception to ADR 0012 in this guide without first amending the ADR.

### Example: `semctx_setup` (domain bootstrap)

Illustrative only — not every MCP change involves setup.

| Outcome | Wire | Agent treatment |
|---------|------|-----------------|
| preflight / `SETUP_READY` | structured body, `isError` false | success only if `kind === "setup"` **and** `verdict === "SETUP_READY"` |
| `setup_refused` / `SETUP_NOT_READY` | structured body, `isError` false | agent failure (read `reason` / `nextSteps` / `indexHealth`) |
| invalid root, internal failure | catalogue `isError` true | no setup body |

`SETUP_READY` must stay fail-closed for all config versions (no legacy short-circuit past
insufficient coverage / non-high-risk freshness). That readiness rule is independent of the
error-boundary rule above. The public setup **output schema** also rejects inconsistent bodies: `setupReady` must equal
`check.ok && analysisReady` and `verdict === SETUP_READY`; `SETUP_READY` requires
`binding.status === "valid"`, `freshness.canRunHighRiskControl === true`, and
`coverage.status ∈ {complete, partial}` (typed health subset, not open `unknown`).

## Prefer local exceptions over global openings

When a single tool needs a richer **domain** signal, extend its **output schema** and skill
success wording — do not relax `ToolRegistrar` globally.

When a true new **error code** is needed, add it to the public catalogue with a fixed message
(ADR 0012 bounds), not a free-form handler payload.

## PR self-check

Mark each item `[x]`, `[ ]`, or **`N/A — <reason>`**. Not every public-contract change touches
every row.

### Common (most PUBLIC_CONTRACT diffs)

```markdown
## Public MCP contract self-check

### Common
- [ ] Diff classified: PUBLIC_CONTRACT / DOMAIN_FEATURE / TRANSPORT_DX (not “Class A/B/C”)
- [ ] No silent supersession of ADR 0012 (error catalogue, no handler-authored isError body)
- [ ] Successful results: schema-valid structuredContent + deterministic JSON text, or the named ADR 0012 index-health V2 summary exception
- [ ] Catalogue errors: isError true, fixed code/message, no structuredContent
- [ ] Input gates still fail closed (budget / JSON Schema / Zod) before handler runs
- [ ] Root confinement / pin policy unchanged unless intentionally scoped + tested
- [ ] Annotations + visibility still accurate (writers vs read-only; model vs app)
- [ ] Skill/description success gates match automated asserts where prose defines “success only if…”
- [ ] Plugin rebuild/parity considered when shipping host bundles or shared skills
```

### Conditional — error boundary / forged handlers

```markdown
### Conditional (error boundary)
- [ ] N/A — reason, **or**
- [ ] No global relaxation of ToolRegistrar / public error normalization
- [ ] Adversarial: schema-valid forged handler isError → catalogue, no body leak
```

### Conditional — readiness / bootstrap (e.g. setup)

```markdown
### Conditional (readiness / bootstrap)
- [ ] N/A — reason, **or**
- [ ] Agent success gate fail-closed for all config versions the default path writes
- [ ] Cross-assert: success signal vs indexHealth / coverage (or equivalent)
- [ ] Negative domain outcomes tested as structured results (unconditional asserts; no if-skip)
- [ ] Fixture forces the policy case (explicit v1 / insufficient / …)
```

## Suggested commit order for hybrid work

1. Domain SSoT + unit tests (DOMAIN_FEATURE).
2. Transport wiring with ADR-default error handling (catalogue only).
3. Skill/description updates only after automated gates match the prose.
4. Packaged/child-process smoke for new public tools when practical.
5. PUBLIC_CONTRACT changes in a dedicated commit (not buried as polish).

## Related code and docs

- [ADR 0012 — MCP 2026 stable surface](../adr/0012-mcp-2026-stable-surface.md)
- `packages/mcp-server/src/tool-contract.ts` — registration and error boundary
- `packages/mcp-server/src/tool-output-schemas.ts` — public structured shapes
- `packages/mcp-server/test/mcp-2026-contract.test.ts` — public error contract
