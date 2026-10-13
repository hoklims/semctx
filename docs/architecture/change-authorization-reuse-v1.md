# Change authorization reuse policy v1

[Issue #260](https://github.com/hoklims/semctx/issues/260) adds an opt-in library policy for
capsule age and consumption identity. It is separate from the offline replay defined by
[accepted ADR 0017](../adr/0017-change-authorization-offline-verifier-v1.md). The existing
`verifyChangeAuthorizationCapsuleV1`, CLI and MCP verification surfaces remain stateless.

## Inputs and verdict

`evaluateChangeAuthorizationReuseV1(request, policy, state)` is exported by
`@semantic-context/change-authorization-verifier`. Inputs must be plain JSON data; the existing
JCS validator snapshots them before evaluation and rejects accessors or executable properties.
Dense ordinary arrays from another JavaScript realm are copied without invoking their methods.
Object prototypes must be the library realm's `Object.prototype`, or `null`; complete foreign-realm
object trees remain outside the current input contract.

- `request` is the existing `ChangeAuthorizationVerificationRequestV1`. Its mandatory
  `verifiedAt` is the explicit clock, with a valid calendar date and timezone offset; it must
  not precede the capsule's `evaluatedAt`.
- `policy` supplies `maxAgeMs`, a nonnegative safe integer, and a nonempty
  `authorityContextId`. There is no default clock or maximum age. The maximum age is inclusive:
  an age of exactly `maxAgeMs` is accepted, while a greater age is refused.
- `state` supplies `schemaVersion: 1`, `authorityContextId`, an externally pinned
  `authorityDescriptorDigest`, and unique, nonempty `consumedCapsuleIds`. An empty list means
  an explicitly initialized partition, not evidence that no other host consumed a capsule.

The helper returns a versioned `change_authorization_reuse_report`, with
`executionAuthority: "none"`, the independent offline `verification`, an `ACCEPTED | REFUSED`
result, one stable `reasonCode`, and a proposed `nextState`. Precedence is:

| Condition | Result / reason |
| --- | --- |
| Policy context differs from state context, or the request's authority pin differs from the state's pin | `REFUSED / AUTHORITY_CONTEXT_MISMATCH` |
| Offline verification is not `PASSED` | `REFUSED / CAPSULE_VERIFICATION_NOT_PASSED` |
| Capsule age exceeds `maxAgeMs` | `REFUSED / CAPSULE_EXPIRED` |
| `capsuleId` is already present in this partition | `REFUSED / CAPSULE_ALREADY_CONSUMED` |
| All checks pass | `ACCEPTED / CAPSULE_REUSABLE` |

An accepted result proposes a new state with the capsule's `capsuleId` appended. A refusal
returns the supplied state unchanged. Neither path mutates the input or persists anything.
Malformed policy or consumption state throws `invalid change authorization reuse policy` or
`invalid change authorization consumption state`. A malformed verification request retains the
existing verifier's request-schema error boundary. Exceptions produce no transition and must not be treated as
acceptance. With the same valid request, policy and state, the structural report is deterministic;
this report has no separate canonical serializer or hash.

The consumption identity is `capsuleId`, within the caller's partition identified by context and
authority digest. Re-sealing the same identity with a different hash or timestamp does not remove
its consumption marker. Issuers and callers must preserve that identity for the same consumption:
renaming it creates another identity. Another explicitly selected context or authority partition
has independent consumption history. This is not a global nonce registry or signature check.

## Caller-owned storage, rollback and retention

No storage adapter, ledger, network dependency or SaaS is introduced. The caller owns the
policy, trusted clock, authority pin, partition selection and state. An accepted report only
proposes a transition; two calls reading the same snapshot can both accept.

An integration protecting an effect must atomically compare the current state, commit the
consumption marker and perform that effect in its own transaction, or use a supported protocol
with equivalent coordination. On transaction failure, roll back both the marker and the effect;
on a concurrent state conflict, re-read and evaluate again. If the effect cannot participate in
that transaction, the integration must define its idempotency and recovery protocol before
claiming single-use behavior. This library provides and tests no such integration.

Retain consumption identities for the lifetime of their authority partition. Capsule age alone
is insufficient justification for pruning: a producer could re-seal the same identity at a later
time, or a caller could change its maximum age. Retire a partition only when the integration
also prevents its reuse. Do not restore an older state snapshot as a successful rollback after a
committed effect. Missing or unreadable durable state is an integration failure, not an empty
history to initialize silently. The helper does not delete markers or enforce retention.

## Evidence and limits

`packages/change-authorization-verifier/test/reuse.test.ts` exercises age boundaries, explicit
offsets and invalid clocks, repeated identity after re-sealing, context and digest mismatches,
invalid policy/state, integrity and semantic refusals, input immutability, determinism and retained
offline replay. `test/architecture.test.ts` checks the package's runtime dependency and no-I/O,
no-ambient-clock boundary. These tests exercise the library, not a durable consumer integration.

The helper is advisory, grants no execution authority and performs no DSSE/PKI verification.
Existing CLI and MCP replay do not enforce this opt-in policy. A lost, stale or independently
initialized state can allow reuse; global or durable single-use behavior requires a separate
integration with its own green behavioral oracle.
