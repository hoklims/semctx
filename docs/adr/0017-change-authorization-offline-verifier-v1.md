# ADR 0017 — ChangeAuthorization offline verifier v1: independent replay, CLI, and MCP

- Status: accepted
- Date: 2026-08-30
- Related: [ADR 0016](0016-change-authorization-capsule-v1.md) (`ChangeAuthorizationCapsuleV1`),
  [Change authorization v1 specification](../architecture/change-authorization-v1.md)

## Context

ADR 0016 shipped `ChangeAuthorizationCapsuleV1` and a pure evaluator/replay pair in
`@semantic-context/control-engine`, but explicitly deferred "providers, app-services, CLI, or MCP
surfaces for this contract" and "DSSE signing/verification, cross-host replay transport, CLI, and
MCP surfaces" to HOK-91. A capsule that can only be replayed by importing the same engine that
produced it is not independently verifiable in practice: a verifier that shares a runtime
dependency with the producer cannot catch a bug or forgery in that shared dependency.

## Decision

Add `@semantic-context/change-authorization-verifier`, a new package whose `src` depends at
runtime **only** on `@semantic-context/control-model` — never on `@semantic-context/control-engine`,
the filesystem, Git, the network, or `@semantic-context/app-services`. It reimplements the policy
derivation from the specification independently (`derive.ts`), rather than calling the engine's
evaluator, so a verifier running outside the host and process that produced a capsule gives a real
second opinion instead of trusting the same code path twice. An architectural test
(`test/architecture.test.ts`) scans `src` for forbidden imports and fails the build if the boundary
is crossed.

### Public contract

- **Request** (`ChangeAuthorizationVerificationRequestV1`): `{ schemaVersion: 1, capsule: unknown,
  expectedAuthorityDescriptorDigest: Sha256Hash | null, verifiedAt: ISO-8601 with an explicit
  offset }`. `capsule` is `unknown` because it is untrusted input from outside this process.
  `verifiedAt` is mandatory and explicit — there is no ambient clock (no `Date.now()`) anywhere in
  this package, and the caller must supply it even to re-check a capsule the instant it was sealed.
  It must represent the same or a later instant than `capsule.evaluatedAt`; a caller cannot move the
  clock backward to turn evidence that was already expired at sealing time into a passing replay.
- **Report** (`ChangeAuthorizationVerificationReportV1`): a closed, JCS-canonical (RFC 8785) schema
  with `reportHash` under its own hash domain (`SEMCTX_CHANGE_AUTHORIZATION_VERIFICATION_REPORT_V1`),
  fixed `executionAuthority: "none"`, `enforcementMode: "shadow"`, `blockingEnabled: false`,
  `authorizationEffect: "advisory_verification"`. It separates three independent verdicts:
  - `integrity`: structural `safeParse` plus a **historical replay** — the capsule's own declared
    providers/assertions/rules are re-derived at the capsule's own `evaluatedAt` and compared
    byte-exactly against what the capsule claims (subject hash, policy evaluations, verdict, reason
    codes, evidence-universe hash, authority-descriptor digest).
  - `authority`: compares the capsule's `authorityDescriptor.descriptorDigest` against
    `request.expectedAuthorityDescriptorDigest`, a value the caller must source independently of
    the capsule (its own pinned policy/trust-root configuration). A `null` expected digest never
    silently trusts the capsule's own digest.
  - `semantic`: a **second, current-time replay** — the capsule's own sealed
    providers/assertions/rules re-derived at `request.verifiedAt` instead of the capsule's
    `evaluatedAt`. Only the clock moves; no provider or evidence is re-fetched. This catches an
    assertion or provider snapshot that was valid when the capsule was sealed but has since expired
    against its own recorded `expiresAt` — the capsule's own `integrity` section cannot see this,
    because it only checks self-consistency at the moment of sealing. It does **not** detect a
    provider status changing after sealing (e.g. a provider later marked `DEGRADED`): that requires
    a fresh provider snapshot, which is live provider integration (HOK-90), not this replay.
- **Result precedence** (never an implicit promotion): `integrity` invalid, the authority digest
  diverges, or either the recorded or current decision is `DENY` → `FAILED`. Otherwise an absent
  expected digest, or either decision is `REQUIRE_EVIDENCE` → `REQUIRE_EVIDENCE`. Only a recorded
  `ALLOW` that remains `ALLOW` under the current replay can produce `PASSED`.

### Transports

- **Library**: `verifyChangeAuthorizationCapsuleV1(request)` in
  `@semantic-context/change-authorization-verifier`, plus
  `serializeChangeAuthorizationVerificationReportV1(report)` for the canonical JCS text form used
  by every transport.
- **CLI**: `semctx control verify-authorization <request.json>`. Exit `0` only for `PASSED`; exit
  `3` for `FAILED` or `REQUIRE_EVIDENCE`; exit `1` is reserved for transport/envelope failures that
  prevent any report from being produced (missing file, invalid JSON, malformed request envelope).
  The command reads exactly one local file and never touches Git or `.semctx/`.
- **MCP**: `semctx_control_verify_authorization`, read-only, idempotent, closed-world (`strictInput:
  true`). Unlike every other tool in this server it takes **no** `repositoryRoot` — the request is
  the entire input, so there is no target repository to bind. It returns the exact library-canonical
  JCS text in its `content[0].text` field, and the same shape as `structuredContent`.

All three transports call the same library function and serializer, so the payload — and its
`reportHash` — is byte-identical regardless of which one produced it.

## What this does not claim

- **No cryptographic validity.** This is a structural and semantic replay of declared data, not a
  signature check. `ChangeAuthorizationProviderV1` and `authorityDescriptor` remain caller-supplied
  snapshots (ADR 0016 §8, §11); nothing here verifies a DSSE envelope, a certificate chain, or a
  live trust-root registry. That work is scoped to Linear HOK-564 (v0.1.19) and is explicitly out of
  scope here.
- **No single-use / anti-replay guarantee.** `verifiedAt` proves the evidence was re-checked at that
  instant; it does not prove the capsule (or this verification) was consumed exactly once, or
  record that a verification happened anywhere durable. Stateful anti-replay tracking is Linear
  HOK-565 (v0.1.19).
- **Fully offline and stateless.** The verifier makes no network call, holds no state between
  invocations, and mutates nothing — not the capsule, not a target repository, not a trust registry.
  Running it twice with the same request always returns the same `reportHash`.

## Non-goals

- Live provider integrations, trust-root registries, or a policy service (still ADR 0016 §11 /
  HOK-90).
- DSSE signing/verification and cross-host attestation transport (HOK-564).
- Stateful anti-replay (HOK-565) and multi-stack VSA export (HOK-566).

## Consequences

A user (or another service) can take a `ChangeAuthorizationCapsuleV1` produced by any host, hand it
to a process that shares no runtime dependency with the producer beyond the public contract, and get
back the same canonical `PASSED | FAILED | REQUIRE_EVIDENCE` verdict from the library, the CLI, or
MCP — with the reasons for that verdict split cleanly into "is this capsule internally honest",
"do I trust the authority that evaluated it", and "does its evidence still hold right now". The
verification itself remains read-only and grants no execution authority, consistent with ADR 0016.
