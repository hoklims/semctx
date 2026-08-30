# ADR 0016 — ChangeAuthorizationCapsuleV1: a read-only, replayable change-authorization record

- Status: accepted
- Date: 2026-08-30
- Related: ADR 0003 (task-relative authority), ADR 0008 (versioned machine output),
  ADR 0009 (Plane A/Plane B separation), ADR 0012 (MCP 2026 stable surface),
  [Semantic Reconstruction Control Plane v1](../architecture/control-plane-v1.md),
  [Change authorization v1 specification](../architecture/change-authorization-v1.md)

## Context

The roadmap's M2 workstream ("create an independently verifiable decision record") asks for a
versioned change-authorization record that binds the requested outcome, the exact repository and
tool state, known/approximated/unknown impacts, tests/runtime observations/human approvals with
provenance, and the policy that reached `ALLOW`, `DENY`, or `REQUIRE_EVIDENCE`. It must remain
read-only: an independent verifier replays the decision, but the record itself grants no
permission to modify a repository.

Manual Control Handoff v2 (`ControlHandoffRecordV2`) already produces a sealed, hash-bound
reconciliation terminal status (`REALIZED | VIOLATED | UNPROVEN`) for a task-bound diff. It does
not, however, express a policy-evaluated verdict, distinguish epistemic modalities of evidence, or
bind evidence to providers and trust roots. HOK-89 adds that layer on top of Handoff v2 without
modifying it.

## Decision

Add `ChangeAuthorizationCapsuleV1`, a new, independent public contract in
`@semantic-context/control-model`, plus a pure evaluator in `@semantic-context/control-engine`.

1. **Basis, not a new source of repository truth.** `capsule.basis.record` is a strictly validated
   `ControlHandoffRecordV2`. The capsule's `subject` is an exact, schema-enforced projection of
   that record (change id, intent, declared scope, observed commit/diff, touched coordinates,
   reconciliation terminal status and reasons). Any divergent projection is `INVALID`. This ADR
   does not modify `ControlHandoffRecordV2` or its v2 schema.
2. **Ternary, descriptive verdict.** `verdict: "ALLOW" | "DENY" | "REQUIRE_EVIDENCE"` is a new type,
   independent of the existing binary `AuthorizationDecision` (`ALLOW | DENY`) used by the
   migration-step authorization policy in `control-engine/src/policy.ts`. The existing type is
   untouched.
3. **Shadow-only authority, always.** Every capsule fixes `executionAuthority: "none"`,
   `enforcementMode: "shadow"`, `blockingEnabled: false`, `authorizationEffect: "advisory_record"`.
   `ALLOW` is a descriptive report; it grants nothing.
4. **Named epistemology, no implicit promotion.** Every assertion in the evidence graph carries a
   `modality`: `FORMALLY_PROVED`, `STATICALLY_VERIFIED`, `TEST_OBSERVED`, `RUNTIME_OBSERVED`,
   `HUMAN_APPROVED`, `ATTESTED`, `APPROXIMATED`, or `UNKNOWN`. A policy rule must explicitly
   allowlist the modalities it accepts; `APPROXIMATED` and `UNKNOWN` can never appear in any rule's
   allowlist — the schema rejects a rule that tries. A bundle that offers `APPROXIMATED` or
   `UNKNOWN` evidence to a rule is a policy violation (`POLICY_RULE_VIOLATED`), not silently
   ignored insufficiency: submitting an admitted approximation as proof is itself a signal worth
   surfacing loudly.
5. **Evidence must address the exact claim it is offered for.** Every policy rule declares
   `requiredClaimHash`, pointing at a registered `ChangeAuthorizationClaimV1`; every assertion
   carries `claimHash` and a closed `conclusion: SUPPORTS | CONTRADICTS | INCONCLUSIVE` (never free
   text). An assertion contributes only on an exact claim match with `SUPPORTS`; a matching
   `CONTRADICTS` forces the whole rule `violated`; a foreign claim or `INCONCLUSIVE` never
   contributes. `HUMAN_APPROVED`/`ATTESTED` are further restricted to only address a
   `HUMAN_APPROVAL`/`ASSERTION_AUTHENTICITY` claim. This closes the "unrelated or negative assertion
   satisfies a rule" gap in the original design, where contribution ignored what an assertion
   actually claimed.
6. **RFC 8785 (JCS) canonicalization, I-JSON safe, kept separate.** All ten hash domains
   (`SEMCTX_CHANGE_AUTHORIZATION_{SUBJECT,EVIDENCE,EVIDENCE_BUNDLE,POLICY_EVALUATION,CAPSULE,
   CLAIM,POLICY_RULE_SET,TRUST_ROOT_SET,AUTHORITY_DESCRIPTOR,EVIDENCE_UNIVERSE}_V1`) hash SHA-256
   over a dedicated JCS serializer (`change-authorization-canonical.ts`), distinct from
   `serializeControlReport` (which only sorts keys and does not reject non-finite numbers,
   normalize `-0`, or reject unpaired UTF-16 surrogates). See the specification for exact rules.
7. **Fail-closed, monotone precedence — bounded to one evidence universe.** `DENY` (rank 0)
   outranks `REQUIRE_EVIDENCE` (rank 1) outranks `ALLOW` (rank 2). The capsule verdict is
   `min(minimum per-rule outcome rank, basis reconciliation ceiling)`. A `VIOLATED` basis forces
   `DENY`; an `UNPROVEN` basis ceilings the verdict at `REQUIRE_EVIDENCE` even when every rule is
   satisfied. `compareChangeAuthorizationMonotonicityV1` proves that expiring or degrading evidence
   never raises the verdict rank **only between two capsules sharing the same subject, authority
   descriptor, and evidence universe** (`ChangeAuthorizationEvidenceUniverseV1.universeHash`); it
   refuses the comparison otherwise. Monotonicity was never a claim about comparing across
   different evidence — removing a contradicting assertion legitimately changes the answer.
8. **Authority is pinned and hashed, not caller-supplied at face value.**
   `ChangeAuthorizationAuthorityDescriptorV1` digests the policy and trust-root snapshot an
   evaluation used (`policyRulesHash`, `trustedRootSetHash`, `descriptorDigest`). It is a digested
   evaluation of a caller-supplied snapshot, not a live authority query. `replayChangeAuthorizationV1`
   requires a caller-supplied `expectedAuthorityDescriptorDigest`, sourced independently of the
   capsule, and rejects a capsule whose authority does not match it even when every internal hash
   is self-consistent.
9. **`INVALID` is a distinct channel from the verdict, with two verification paths.** Structural,
   authenticity, substitution, hash, or type errors (a forged subject, an out-of-scope assertion, a
   non-finite method parameter, a dangling dependency hash, a claim/modality mismatch) make the
   pure evaluator throw a typed `ChangeAuthorizationEvaluationError`, or make
   `ChangeAuthorizationCapsuleV1Schema` reject the value — this is **structural** verification.
   `replayChangeAuthorizationV1` adds **semantic** verification: it re-derives the verdict using
   the same pure core the evaluator used (`deriveChangeAuthorizationDecisionV1`) and catches a
   capsule that is internally self-consistent but whose `policyEvaluations` do not actually follow
   from running the disqualification rules (expired evidence, a degraded or untrusted provider) —
   a class of forgery `safeParse` alone cannot see. Neither path ever produces a `DENY` or
   `REQUIRE_EVIDENCE` capsule for a corrupted input.
10. **Bounded interoperability with in-toto, no live crypto.** `buildChangeAuthorizationInTotoStatementV1`
    maps a capsule to an in-toto `Statement v1` predicate under
    `predicateType: "https://github.com/hoklims/semctx/attestation/change-authorization/v1"`, with
    the statement's subject bound to `subject.changeId`/`subject.subjectHash` (the change under
    authorization), never to `capsuleId`/`capsuleHash` (which identify the predicate record only).
    `ChangeAuthorizationInTotoStatementV1Schema` requires exactly one subject and cross-checks both
    fields against the predicate. The DSSE envelope shape (`application/vnd.in-toto+json`) is
    documented as a type only. v1 signs, verifies, or transports nothing.
11. **No providers, no live trust roots, no transport.** `ChangeAuthorizationProviderV1` and
    `authorityDescriptor.trustRootIds` are strict, caller-supplied snapshots evaluated by the pure
    engine. Live provider integration and trust-root registries are HOK-90; DSSE verification,
    cross-host replay, CLI, and MCP surfaces are HOK-91. This ADR adds none of them.

## Compatibility and versioning

This is a new, additive public surface (`@semantic-context/control-model/change-authorization`
plus root re-exports). It does not change any pre-existing (non-HOK-89) schema, hash domain, or
exported type. Within `ChangeAuthorizationCapsuleV1` itself, this revision (still `schemaVersion:
1`, pre-release) replaces `assertion.subjectId`/free-text `conclusion` with `claimHash`/closed
`conclusion`, adds `claims`, `evidenceUniverse`, and `authorityDescriptor`, and moves
`trustedRootIds` from a bare capsule field into `authorityDescriptor.trustRootIds` — this is
recorded here because the contract has no external consumers yet (see Non-goals); once it does,
equivalent future changes require `schemaVersion: 2`. Extending `executionAuthority`,
`enforcementMode`, or `authorizationEffect` beyond their current fixed literals is a breaking
change requiring `schemaVersion: 2`. Adding a new reason code to the classified set (§
specification) is compatible only if it is placed correctly in exactly one of the
positive/violation/insufficiency classes; changing an existing reason's class is not.

## Test evidence

- `packages/control-model/test/change-authorization-contract.test.ts`: JCS/I-JSON canonicalization
  (key sorting, `-0`, non-finite rejection, rejected `undefined`, duplicate-key text boundary, no
  Unicode normalization, lone-surrogate rejection in values and property names, valid-pair
  preservation, domain separation across all ten domains), hash self-checks, subject/scope/commit
  binding invariants, the never-allowlistable-modality invariant, basis-ceiling precedence, claim
  registry binding (foreign claim, `CONTRADICTS`, `INCONCLUSIVE`, modality/claim-kind mismatch,
  claim subject bound to the wrong `changeId`), evidence-universe exact-membership, authority
  descriptor pinning, and the in-toto mapping bound to `subject.changeId`/`subject.subjectHash`
  with forged-subject rejection.
- `packages/control-engine/test/change-authorization-policy.test.ts`: determinism, `ALLOW` on a
  satisfied rule and realized basis, `REQUIRE_EVIDENCE` on missing evidence, the
  `APPROXIMATED`/`UNKNOWN` violation rule, basis-forced `DENY`/`REQUIRE_EVIDENCE`, a same-universe
  monotonicity property test (expiry, provider degradation, trust-root removal never raise the
  verdict), typed `INVALID` errors for malformed input, and the HOK-89 rework's targeted hostile
  regressions: unrelated/negative claims never produce `ALLOW`, monotonicity refuses a
  cross-universe comparison (poison removal), and `replayChangeAuthorizationV1` catches a
  hand-forged, internally self-consistent `DEGRADED`-provider capsule and an authority substitution
  that `safeParse` alone accepts.

## Non-goals

- Modifying `ControlHandoffRecordV2`, `AuthorizationDecision`, or any pre-existing hash domain.
- Providers, app-services, CLI, or MCP surfaces for this contract.
- Live DSSE signing/verification, stateful anti-replay, or any enforcement/blocking effect.
- Real trust-root registries or provider health checks (deferred to HOK-90).

## Consequences

Any host or verifier can construct, or independently structurally and semantically re-check, a
`ChangeAuthorizationCapsuleV1` from a `ControlHandoffRecordV2` plus a sealed evidence graph,
entirely offline, with a single pure evaluator, a single pure replay function, and a single strict
schema. The record settles a policy question about a specific, claim-bound piece of evidence
without ever claiming or granting execution authority, and stays interoperable with in-toto's
attestation model — bound to the change under authorization, not the record — without adopting its
live transport.
