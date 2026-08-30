# Change authorization v1 — normative specification

> Status: implemented, read-only, shadow-only. See
> [ADR 0016](../adr/0016-change-authorization-capsule-v1.md) for the accepted decision and
> rationale. This document is the machine-source-adjacent specification: schemas and pure
> functions in `@semantic-context/control-model` / `@semantic-context/control-engine` remain the
> executable source of truth; this specification explains their invariants.

## Purpose

`ChangeAuthorizationCapsuleV1` turns a sealed `ControlHandoffRecordV2` plus a sealed evidence graph
into a deterministic, replayable `ALLOW | DENY | REQUIRE_EVIDENCE` verdict. It never grants
execution, write, or enforcement authority. It is the read-only decision record described by the
roadmap's M2 workstream ("create an independently verifiable decision record").

## Threat model

| Invariant | Hostile scenario | Minimal proof |
| --- | --- | --- |
| `ALLOW` grants no authority | A consumer treats `verdict: "ALLOW"` as permission to write | `executionAuthority`, `enforcementMode`, `blockingEnabled`, `authorizationEffect` are fixed literals in both the type and the schema; every test asserts them alongside the verdict. |
| No implicit promotion between modalities | `ATTESTED` or `APPROXIMATED` evidence satisfies a rule that expects proof | A policy rule's `allowedModalities` is an explicit allowlist; `APPROXIMATED` and `UNKNOWN` are rejected from any rule's allowlist at the schema level, unconditionally. |
| Evidence must address the exact claim it is offered for | An assertion that is unrelated, or that actively contradicts a rule's required claim, is treated as satisfying evidence | Every policy rule declares `requiredClaimHash`, pointing at one registered `ChangeAuthorizationClaimV1`. An assertion contributes only when its own `claimHash` equals the rule's `requiredClaimHash` **and** its `conclusion` is `SUPPORTS`; `CONTRADICTS` on the matching claim forces the whole rule `violated`; a foreign claim or `INCONCLUSIVE` never contributes. `HUMAN_APPROVED` and `ATTESTED` modalities are additionally restricted to only address a `HUMAN_APPROVAL` / `ASSERTION_AUTHENTICITY` claim respectively — this is checked both at evaluation time and by the capsule schema. |
| Exact binding | An assertion's diff, commit, scope, or intent is substituted | The capsule schema recomputes and compares `sourceCommit`/`sourceDiffHash` against the basis's `observedCommit`/`observedWorkingDiffHash`, and rejects any assertion scope outside the basis's `touchedCoordinateIds`. Mismatches are `INVALID`, never a business verdict. |
| Determinism / JCS / I-JSON | Key order, `-0`, non-finite numbers, or an unpaired UTF-16 surrogate changes or corrupts the hash | `serializeChangeAuthorizationJcsV1` sorts keys by UTF-16 code unit, normalizes `-0` to `0`, rejects non-finite numbers, and rejects any string (value or property name) containing an unpaired high/low surrogate; golden tests assert byte-exact output and hash equality across key-insertion orders, and that a valid surrogate pair is preserved. |
| Fail-closed / monotone, bounded to one evidence universe | Removing or degrading evidence raises the verdict | Contribution to a rule is computed by strict disqualification (expired, degraded provider, untrusted root, wrong modality, wrong or unsupported claim); `compareChangeAuthorizationMonotonicityV1` asserts that expiry, provider degradation, and trust-root removal never raise the verdict rank **between two capsules that share the same subject, the same authority descriptor, and the same evidence universe**. Comparing across a different evidence universe (for example, one where a contradicting assertion was removed rather than merely degraded) is refused, not silently treated as monotone or non-monotone — see "Monotonicity is bounded" below. |
| Semantic replay, not structural `safeParse` alone | A capsule is hand-authored with self-consistent hashes but a `policyEvaluations` outcome that does not follow from actually running the disqualification rules (e.g. claiming a `DEGRADED`-provider assertion "satisfied") | `replayChangeAuthorizationV1` re-derives the verdict from the capsule's own declared providers/assertions/rules using the same pure core the evaluator used (`deriveChangeAuthorizationDecisionV1`) and compares every re-derived value byte-exactly. `ChangeAuthorizationCapsuleV1Schema.safeParse` alone only proves internal self-consistency; it is not a substitute for replay. |
| Authority is pinned outside the capsule | A capsule recomputes every internal hash correctly but substitutes a different policy rule set or trust-root set | `authorityDescriptor.descriptorDigest` hashes the policy and trust-root snapshot the evaluation actually used. `replayChangeAuthorizationV1` requires a caller-supplied `expectedAuthorityDescriptorDigest`, sourced independently of the capsule, and rejects the capsule if the two do not match — even when the capsule's own internal hashes are all self-consistent. |

## Data model

### Subject (`ChangeAuthorizationSubjectV1`)

An exact, schema-enforced projection of the basis `ControlHandoffRecordV2`:

- `changeId`, `changeContractHash`, `parentIntentIds`, `nonGoals`, `expectedBehaviorDelta`,
  `declaredReconciliationScope` — copied from `request.planningBundle.taskEnvelope`.
- `planningCommit`, `observedCommit`, `observedWorkingDiffHash`, `touchedCoordinateIds`,
  `reconciliationTerminalStatus`, `reconciliationReasonCodes` — copied from `capsule` (the Handoff
  v2 capsule).

The capsule schema recomputes this projection from `basis.record` and rejects any capsule whose
`subject` diverges. There is no free-text field a caller can substitute independently.

### Claims (`ChangeAuthorizationClaimV1`)

The registry of machine-verifiable claims a capsule can reason about. Every claim has a closed
`subject` (a discriminated union on `kind`):

- `CHANGE_REQUIREMENT { changeId, requirementId }` — the default kind; any modality except
  `HUMAN_APPROVED`/`ATTESTED` may address it.
- `HUMAN_APPROVAL { changeId, approverRole }` — only a `HUMAN_APPROVED` assertion may address it.
- `ASSERTION_AUTHENTICITY { changeId, producerId }` — only an `ATTESTED` assertion may address it.

`changeId` is never caller-chosen independently: the evaluator injects it from the basis record's
subject, and the capsule schema rejects any claim whose `subject.changeId` diverges from the
capsule's own `subject.changeId`. `requiredClaimKindForModality(modality)` is the single closed
function mapping a modality to the one claim kind it may address; both the pure evaluator and the
capsule schema enforce it independently (defense in depth).

### Providers (`ChangeAuthorizationProviderV1`)

A caller-supplied, strict snapshot: `providerId`, `kind`, `version`, `digest`,
`status: AVAILABLE | DEGRADED | UNAVAILABLE | UNTRUSTED`, `capabilities`, `observedAt`/`expiresAt`,
`trustRootId`. v1 has no live provider registry or health check (HOK-90); the evaluator only
consumes the snapshot it is given.

### Assertions (`ChangeAuthorizationAssertionV1`)

The unit of evidence. Every field required by the packet is present: `claimHash` (the single claim
this assertion addresses — never a free-text reference), `conclusion` (closed:
`SUPPORTS | CONTRADICTS | INCONCLUSIVE`, never free text), `modality`, `producerId`/
`producerVersion`, `sourceCommit`/`sourceDiffHash` (bound to the basis, not caller-chosen),
`methodName`/`methodParameters`, `scope` (coordinate ids, bound within the basis's touched
coordinates), `observedAt`/`expiresAt`, `providerId`, `artifacts` (`EvidenceRefV1`),
`dependsOnAssertionHashes` and `contradicts` (forming an acyclic evidence graph), and a
self-verifying `assertionHash`.

The pure evaluator (`evaluateChangeAuthorizationV1`) accepts raw, unhashed assertion input keyed by
a caller-local `assertionId`; dependencies and contradictions are wired by that id and must be
declared earlier in the same evaluation call. This is not an arbitrary ordering rule: an
assertion's hash covers its dependency hashes, so a true hash-reference cycle cannot be constructed
honestly — the DAG property is a consequence of hash chaining, not a separately enforced rule. The
capsule schema still runs an independent cycle check over the hash graph as defense in depth for a
capsule received from elsewhere, without ordering assumptions.

### Evidence bundles, evidence universe, and policy rules

An `EvidenceBundle` groups the assertions offered to one `ruleId` (at most one bundle per rule). A
`ChangeAuthorizationPolicyRuleV1` declares `requiredClaimHash` (the one claim this rule requires
`SUPPORTS`-contributed evidence for), `allowedModalities` (non-empty, never containing
`APPROXIMATED` or `UNKNOWN`), and may narrow admissible evidence to `scopeCoordinateIds` or require
a `requiredCapability` from the provider.

`ChangeAuthorizationEvidenceUniverseV1` records the exact set of assertion and evidence-bundle
hashes an evaluation considered (`assertionHashes`, `bundleHashes`, and a `universeHash` over both,
sorted and deduplicated). It is always derived by the evaluator from what it was actually given —
never caller-supplied — and the capsule schema rejects any `evidenceUniverse` whose declared
membership diverges from the capsule's own `assertions`/`evidenceBundles`. Its purpose is narrow:
it is the precondition for a monotonicity comparison between two capsules (see below), not a
general audit index.

### Policy evaluation

For each rule, in order:

1. If the bundle offers any assertion with modality `APPROXIMATED` or `UNKNOWN`: `violated` /
   `POLICY_RULE_VIOLATED`. Submitting an admitted approximation or unknown as evidence for a
   governed rule is itself the finding, not a gap to fill quietly.
2. Else if `scopeCoordinateIds` is set and any assertion's scope escapes it: `violated` /
   `SCOPE_EXCEEDED`.
3. Else if any assertion in the bundle is mutually referenced by `contradicts`: `violated` /
   `EVIDENCE_CONTRADICTED`.
4. Else if any assertion addresses the rule's `requiredClaimHash` with `conclusion: "CONTRADICTS"`:
   `violated` / `REQUIRED_CLAIM_CONTRADICTED`. Actively contradicting the exact claim a rule
   requires is a finding about the rule, not a fact to quietly exclude.
5. Else, for each assertion, in this order, the first disqualifying condition determines its
   exclusion reason: addressing a different claim (`REQUIRED_CLAIM_UNBOUND`), addressing the right
   claim inconclusively (`REQUIRED_CLAIM_INCONCLUSIVE`), unresolved provider
   (`REQUIRED_EVIDENCE_UNBOUND`), modality not allowlisted
   (`REQUIRED_EVIDENCE_MODALITY_INSUFFICIENT`), expired or not-yet-observed
   (`REQUIRED_EVIDENCE_EXPIRED`), untrusted provider (`PROVIDER_CAPABILITY_UNTRUSTED`), unavailable
   provider (`PROVIDER_CAPABILITY_MISSING`), degraded provider (`PROVIDER_CAPABILITY_DEGRADED`),
   provider's own snapshot expired (`SOURCE_SEAL_STALE`), untrusted trust root
   (`TRUST_ROOT_UNAVAILABLE`), or missing required capability (`PROVIDER_CAPABILITY_MISSING`).
   Assertions that clear every check contribute.
6. If no assertion contributes: `insufficient`, with the union of collected reasons (or
   `REQUIRED_EVIDENCE_MISSING` if the bundle itself is absent).
7. Else: `satisfied` / `POLICY_SATISFIED`.

An assertion that is unrelated to a rule (wrong `claimHash`) or that actively contradicts the
rule's claim can therefore never produce `ALLOW`: it either never contributes (insufficiency) or
forces the whole rule `violated`.

### Verdict aggregation

```
ruleRank = min(outcomeRank(evaluation) for evaluation in policyEvaluations)   // violated=0, insufficient=1, satisfied=2
basisCeiling = VIOLATED -> 0 | UNPROVEN -> 1 | REALIZED -> 2
rank = min(ruleRank, basisCeiling)
verdict = rank==0 ? DENY : rank==1 ? REQUIRE_EVIDENCE : ALLOW
```

`reasonCodes` is the union of every non-satisfied rule evaluation's reasons, plus `OPEN_UNKNOWN`
whenever the basis is not `REALIZED`, plus `INVARIANT_VIOLATED` whenever the basis is `VIOLATED`,
canonically ordered; if that union is empty, `reasonCodes = ["POLICY_SATISFIED"]`.

## Monotonicity is bounded to a single evidence universe

"Removing or degrading evidence never raises the verdict" is only provable **between two
evaluations of the exact same evidence** — the same subject, the same authority descriptor, and
the same evidence universe (`evidenceUniverse.universeHash`). Comparing across a *different*
evidence universe is not a monotonicity claim: for example, removing an assertion that mutually
`contradicts` another (a "poisoned" bundle) changes what evidence exists, and can legitimately
raise the rank — that is expected behavior for different evidence, not a violation of fail-closed
evaluation.

`compareChangeAuthorizationMonotonicityV1(previous, next)` makes this explicit. It first checks
`previous.subject.subjectHash === next.subject.subjectHash`,
`previous.authorityDescriptor.descriptorDigest === next.authorityDescriptor.descriptorDigest`, and
`previous.evidenceUniverse.universeHash === next.evidenceUniverse.universeHash`; if any differ, the
result is `INVALID` with the specific mismatch reason (`SUBJECT_MISMATCH`,
`AUTHORITY_DESCRIPTOR_MISMATCH`, or `EVIDENCE_UNIVERSE_MISMATCH`) and **no monotonicity claim is
made**. Only when all three match does it compare verdict rank, returning `INVALID` with
`VERDICT_RANK_INCREASED` if the rank rose.

## Authority descriptor: policy and trust are pinned and hashed, not caller-supplied at face value

`ChangeAuthorizationAuthorityDescriptorV1` digests the policy and trust-root snapshot an evaluation
actually used: `policy` (id/version/URI), `policyRulesHash` (a hash over the capsule's own declared
`policyRules`), `trustPolicy` (id/version), `trustRootIds`, `trustedRootSetHash`, and a
`descriptorDigest` over all of the above. The capsule schema cross-checks `policyRulesHash` and
`trustedRootSetHash` against the capsule's own declared `policyRules`/`trustRootIds`.

This is **a digested evaluation of a caller-supplied snapshot, not a live authority query or proof**
— v1 has no provider registry or policy service (HOK-90 remains deferred). What it buys is
pinning: `replayChangeAuthorizationV1` requires a caller-supplied `expectedAuthorityDescriptorDigest`
sourced independently of the capsule (for example, a verifier's own configuration) and rejects the
capsule if `authorityDescriptor.descriptorDigest` does not match it — even when every hash inside
the capsule is internally self-consistent. Without this external pin, a capsule that recomputes its
own hashes correctly but was evaluated against a substituted policy or trust-root set would pass
`safeParse` undetected.

## Replay: re-deriving the verdict, not merely parsing it

`ChangeAuthorizationCapsuleV1Schema.safeParse` proves **structural** self-consistency: every hash
matches its own recomputed content, and cross-references (assertion→provider, bundle→rule,
contributing assertion→claim/modality) resolve and satisfy the schema's own closed checks. It does
**not** re-run the disqualification rules that depend on `evaluatedAt` (expiry, provider status,
trust-root membership) — a hand-authored `policyEvaluations` entry that says `"satisfied"` for an
assertion whose provider is `DEGRADED` can still be internally self-consistent and pass `safeParse`.

`replayChangeAuthorizationV1(capsule, { expectedAuthorityDescriptorDigest })` closes that gap. It:

1. Rejects immediately (`CAPSULE_SCHEMA_INVALID`) if `safeParse` fails.
2. Re-derives the subject from `basis.record` and compares `subjectHash`
   (`SUBJECT_REDERIVATION_MISMATCH` on divergence).
3. Calls the same pure core the evaluator used, `deriveChangeAuthorizationDecisionV1`, over the
   capsule's own declared `providers`/`assertions`/`evidenceBundles`/`policyRules` and
   `authorityDescriptor`, and compares every re-derived `policyEvaluations` hash, `verdict`,
   `reasonCodes`, `evidenceUniverse.universeHash`, and `authorityDescriptor.descriptorDigest`
   byte-exactly against what the capsule claims.
4. Rejects if the capsule's own `authorityDescriptor.descriptorDigest` does not match the
   caller-supplied `expectedAuthorityDescriptorDigest`.

The result is a closed `"VALID" | "INVALID"` with a stable, non-exhaustive-but-fixed set of reasons
(`CAPSULE_SCHEMA_INVALID`, `SUBJECT_REDERIVATION_MISMATCH`,
`POLICY_EVALUATION_REDERIVATION_MISMATCH`, `VERDICT_REDERIVATION_MISMATCH`,
`REASON_CODES_REDERIVATION_MISMATCH`, `EVIDENCE_UNIVERSE_MISMATCH`,
`AUTHORITY_DESCRIPTOR_MISMATCH`).

## Reason codes (minimum set)

| Class | Codes |
| --- | --- |
| Positive | `POLICY_SATISFIED` |
| Violation | `POLICY_RULE_VIOLATED`, `SCOPE_EXCEEDED`, `EVIDENCE_CONTRADICTED`, `REQUIRED_CLAIM_CONTRADICTED`, `INVARIANT_VIOLATED` |
| Insufficiency | `REQUIRED_EVIDENCE_MISSING`, `REQUIRED_EVIDENCE_EXPIRED`, `REQUIRED_EVIDENCE_UNBOUND`, `REQUIRED_EVIDENCE_MODALITY_INSUFFICIENT`, `REQUIRED_CLAIM_UNBOUND`, `REQUIRED_CLAIM_INCONCLUSIVE`, `PROVIDER_CAPABILITY_MISSING`, `PROVIDER_CAPABILITY_DEGRADED`, `PROVIDER_CAPABILITY_UNTRUSTED`, `OPEN_UNKNOWN`, `SOURCE_SEAL_STALE`, `TRUST_ROOT_UNAVAILABLE`, `CLOCK_UNAVAILABLE` |

`CLOCK_UNAVAILABLE` is reserved and currently unreachable: v1's evaluator takes `evaluatedAt` as an
explicit required input (never an ambient clock), so there is no provider-supplied clock to fail.
It becomes live only if a future provider integration (HOK-90) supplies its own clock domain.

A rule evaluation with `outcome: "satisfied"` must carry exactly `["POLICY_SATISFIED"]` and at
least one contributing assertion; `"insufficient"`/`"violated"` must carry at least one reason
drawn only from their own class and zero contributing assertions. The schema enforces this
partition; nothing upstream can forge a `"satisfied"` outcome without contributing evidence that
also actually addresses the rule's required claim with an allowlisted modality — the schema checks
both, and a bundle that contradicts the required claim must be `violated`, never `satisfied`.

## Canonicalization (RFC 8785 / JCS, I-JSON safe)

`serializeChangeAuthorizationJcsV1` is deliberately distinct from the repository's existing
`serializeControlReport` (used by Handoff v2 and the reconciliation contracts), which only sorts
object keys and otherwise defers to `JSON.stringify`'s native (lossy) number handling. The
change-authorization serializer:

- sorts object keys by UTF-16 code unit (`compareCodeUnits`), matching the repository's existing
  ordering convention and RFC 8785's code-unit sort;
- normalizes `-0` to `0` explicitly (defense in depth; `JSON.stringify(-0)` already yields `"0"`
  natively, but the canonicalizer does not rely on that incidentally);
- rejects `NaN` and `±Infinity` explicitly rather than letting `JSON.stringify` silently coerce
  them to `null`;
- rejects any string — a property value or a property name — containing an unpaired (lone) UTF-16
  high or low surrogate, which is not valid I-JSON and cannot be losslessly represented; a genuine
  surrogate *pair* (a real astral character) is preserved;
- rejects object keys whose value is `undefined`; callers must omit absent properties before
  hashing because `undefined` is outside the JSON data model and silently dropping it would make
  distinct runtime objects collide;
- performs **no** Unicode normalization. Two strings that are canonically equivalent under NFC vs
  NFD remain distinct code-unit sequences and hash differently. Callers that need normalized
  content must normalize before constructing an assertion; the capsule format does not paper over
  input hygiene it cannot verify.
- is defined over the parsed value, not raw JSON text: a text boundary with duplicate keys is
  already resolved by `JSON.parse` (last key wins) before canonicalization ever sees it.

Hash domains (SHA-256, lower-case hex, `sha256:` prefix, all NUL-terminated):

```
SEMCTX_CHANGE_AUTHORIZATION_SUBJECT_V1\0
SEMCTX_CHANGE_AUTHORIZATION_EVIDENCE_V1\0
SEMCTX_CHANGE_AUTHORIZATION_EVIDENCE_BUNDLE_V1\0
SEMCTX_CHANGE_AUTHORIZATION_POLICY_EVALUATION_V1\0
SEMCTX_CHANGE_AUTHORIZATION_CAPSULE_V1\0
SEMCTX_CHANGE_AUTHORIZATION_CLAIM_V1\0
SEMCTX_CHANGE_AUTHORIZATION_POLICY_RULE_SET_V1\0
SEMCTX_CHANGE_AUTHORIZATION_TRUST_ROOT_SET_V1\0
SEMCTX_CHANGE_AUTHORIZATION_AUTHORITY_DESCRIPTOR_V1\0
SEMCTX_CHANGE_AUTHORIZATION_EVIDENCE_UNIVERSE_V1\0
```

Every hashed object is normalized first (arrays of ids sorted and deduplicated by
`compareCodeUnits`; reason codes canonically ordered by their fixed class order) so that two
semantically identical objects with different construction order hash identically.

## `INVALID` vs. the verdict channel

Structural, authenticity, substitution, hash, or type errors are never expressed as `DENY` or
`REQUIRE_EVIDENCE`. They are a separate, out-of-band failure:

- The pure evaluator (`evaluateChangeAuthorizationV1`) throws a typed
  `ChangeAuthorizationEvaluationError` with a closed `reason` enum (basis record invalid,
  undeclared provider/claim/rule reference, a modality bound to the wrong claim kind, scope escape,
  non-JCS-safe method parameters, unresolved dependency, duplicate id, malformed capsule) before
  any verdict is computed.
- `ChangeAuthorizationCapsuleV1Schema` independently rejects (via `safeParse` failure) any
  capsule — however constructed — whose hashes, cross-references, claim bindings, evidence
  universe, or authority descriptor do not match its own content. This is the **structural**
  replay-verification path: a verifier with no access to the original evaluator can still catch
  every one of the same failure classes that do not depend on the evaluation clock.
- `replayChangeAuthorizationV1` is the **semantic** replay-verification path: it re-derives the
  verdict itself (see "Replay" above) and catches the failure classes that do depend on
  `evaluatedAt` and on an externally pinned authority — the ones structural `safeParse` cannot see.

## Interoperability (bounded)

`buildChangeAuthorizationInTotoStatementV1` maps a capsule to an
[in-toto Statement v1](https://in-toto.io) predicate, binding the statement's subject to the change
under authorization — never to the capsule record itself:

```json
{
  "_type": "https://in-toto.io/Statement/v1",
  "subject": [{ "name": "<subject.changeId>", "digest": { "sha256": "<subject.subjectHash, unprefixed>" } }],
  "predicateType": "https://github.com/hoklims/semctx/attestation/change-authorization/v1",
  "predicate": { /* the capsule itself */ }
}
```

`ChangeAuthorizationInTotoStatementV1Schema` requires exactly one subject and cross-checks
`subject[0].name === predicate.subject.changeId` and
`subject[0].digest.sha256 === predicate.subject.subjectHash` (unprefixed); a statement whose
subject was forged independently of the predicate is rejected. `capsuleHash` identifies the
predicate record only — it is never a valid substitute for `subject.subjectHash` in the outer
statement.

`ChangeAuthorizationDsseEnvelopeShapeV1` documents the bound DSSE envelope shape
(`application/vnd.in-toto+json`) as a type only. v1 implements no signing, no verification, and no
transport of this envelope — that is HOK-91.

## Deferred (explicitly out of scope for v1)

- Live provider integrations and trust-root registries (`authorityDescriptor.trustRootIds` is a
  caller-supplied snapshot, not a queried registry) — HOK-90.
- DSSE signing/verification, cross-host replay transport, CLI, and MCP surfaces — HOK-91.
- Any enforcement, blocking, or execution effect. `authorizationEffect` is permanently
  `"advisory_record"` in v1; changing it is a v2 decision gated by the same M3/M4 evidence process
  the roadmap requires before any enforcement.
