# T00 lot 4 — public finite qualification, 2026-10-23

**0/4 qualified.** This lot adds diagnostic and partial public evidence on macOS
arm64 and Linux aarch64. Every obligation remains `not_qualified`;
`formalR0ObligationQualified` and `allTargetQualified` remain `false`.
Windows, macOS x86_64 and Linux x86_64 were not exercised.

The [four-row machine table](obligations-qualification-lot4-20261023.json)
preserves the original IDs and links each previous assessment to the unchanged
public-closure ledger (`fc8167efff240ac3ff19c3b5033798defd5229606e9512ec303914a5d609d940`,
1,263,092 bytes). The shared 240-row ledger and its earlier 209 finite qualifications
are unchanged. This lot does not recampaign those 209 obligations or grant R0 admission.

| Index | Consumer | macOS arm64 | Linux aarch64 | Reason for `not_qualified` |
| --- | --- | --- | --- | --- |
| 4 | `assertSnapshotInputs` | Five snapshot guard cases match; ordinary missing snapshot diverges | Same | Real baseline `analyzeRepository` executes, but the native retained-only endpoint refuses the ordinary bypass and does not establish the complete owning assembly. |
| 168 | `<dialect-version>` | Two version MISMATCH results; ARB-004, zero credit | Same | Real compiler and executed capability version are `7.1.0-dev`; frozen expected version is `5.9.3`. |
| 229 | `analyzerIdentity` | 9 exact identities, 4 shared refusals, 5 acquisition divergences | Same | No authority accepts the differing confinement, SDK acquisition/version and capture policies; two foreign SDK fallbacks receive zero credit. |
| 235 | `…-plane-a-runtime-ts-produce-extract-plane-a-runtime-analyzere-73e2719cc6` | Public oracle executes; positive extraction/graph match is partial | Same | Ordinary missing input diverges; public composition, workers, composed ownership/provenance and qualified admission remain unestablished. |

The [campaign summary](campaign-summary.json) records results by platform,
artifact hashes and complete raw-output manifests. Raw outputs, scripts, logs and
fixtures remain outside the repository under `~/semctx-evidence/t00/20261023/lot4/`.
The oracle is the unmodified baseline `3e94997fcbefa72ad4d49b2cad180ee79b7c0a9b`,
authenticated against 949 Git blobs, with TypeScript `5.9.3` and Bun `1.4.3`.

Observed producer source: `02b055e3ca3c96d7c4b8ab015aea607507a6053f`, from the existing
freeze recorded at `26263033`. No producer, helper, compiler pin, SDK or expectation
changed; no rebuild was performed. The frozen macOS producer SHA256 is
`78d6a5b50c99bedce983f474bf11d03177ee45260112d19f47debcadf96cc9f1`;
Linux is `8c7b56064812bdf4d17a1ee95b9d6e66fded896928a9a6e7172880cc318782ea`.

`7.1.0-dev` comes from `ts_goport::core::version()` in upstream
`crates/ts_goport/src/core.rs:4907–4915`, SHA256
`93b01fb584dc9f9547290e31172858f4ef8efc3aaf9b60134c468c18b84fc38b`.
The default can be overridden at compilation by `GOPORT_BUILD_VERSION`; changing
that string would not establish compatibility. The observed artifacts report the
default truthfully. `Cargo.toml:17` pins crate `=7.0.0-dev` and Git revision
`780dc512d64f40afebffa6a7028207649fb7ed1c`; `Cargo.lock:699–702` resolves that exact pin.
The crate version, compiler identity and vendored SDK `5.9.3` are separate identities.
`provenance.json` already distinguishes them.

The supplier's pinned `UPSTREAM.md` declares Go source
`microsoft/TypeScript@fed0bf24149fb1ed36039212648bafdafc1ea10e`, subdirectory `tsc/`.
This is locally verified supplier provenance, without independent comparison to
the remote Go source. `UPSTREAM.json.current` is documented there as stale tooling
state. Exact source hashes, line references and pinning details are in
[findings.json](findings.json).

`ORD-DIALECT-CAPABILITY` compares two version assertions: the real compiler and
the nonempty executed subjects' propagated capability versions against `5.9.3`.
It is not a general syntax/semantics capability suite. Both assertions remain
MISMATCH on both platforms. No relabelling or expectation rewrite was applied.

The lot 3 diagnostic hypothesis is confirmed for the exact 6046 messages:
upstream `tsoptions/errors.rs:31–35` filters deprecated keys from the displayed
enumeration. The module message omits `none/amd/system/umd`; the target message
omits `es5` and adds `es2025/es2026`. Controls show `amd` and `es5` do not themselves
produce 6046; AMD retained analysis separately receives a Semctx policy refusal.
This establishes message differences, not removal of every omitted option or ES5
emission support. Missing-inherited 5083 workspace-path differences have no demonstrated
7.x cause here. No lot 3 source or obligation was changed.

For 229, all five divergences originate in the producer identity primitive, with
no helper defect established. The fixed symlink is followed by baseline and refused
by native confinement; missing SDK package/entry trigger observed Bun fallback to
a different package; modified package metadata `5.9.4` is hashed by baseline while
its imported runtime still reports `5.9.3`; native requires metadata `5.9.3`.
The native aggregate capture cap is 67,108,864 bytes, whereas the baseline succeeds
on a 67,108,865-byte fixed input. None is an accepted replacement policy.
This primitive does not execute the native compiler: its SDK version cannot close 168.
The four shared refusals establish outcomes only, not matching error codes.

For 4/235, the final nine-case v3 campaigns each contain 91 comparisons, seven
partial unit agreements and two ordinary-without-snapshot success/refusal divergences.
Three positive controls compare complete extraction under the existing field
projection and complete nonempty graph nodes/edges without projection. The native
producer does provide a graph. The public retained control compares TS ordinary
acquisition without an injected snapshot against explicit native retained input;
only its extraction/graph result is compared. This does not establish identical
public acquisition/admission or global absence of native composition.

The existing targeted replay contains eight passing units and one NONPASS per
platform: snapshot discovery two, retained runtime two, identity four, dialect one.
The dialect test exits 101 on both platforms because its two frozen version
comparisons fail. Earlier Linux attempts on the case-insensitive host bind failed
context binding and receive no credit; the final snapshot/dialect replay and new
boundary campaign run on native Linux container storage. Superseded boundary v1/v2
and setup experiments are retained outside the repository and excluded.

| Decision option | Obligations and freeze/evidence impact | Cost and risk |
| --- | --- | --- |
| A: retain truthful 7.1 and approve a distinct dialect/capability contract | Original 168 remains NONPASS; preserve 5.9.3 evidence and approve a separate contract/oracle freeze. Requalify affected obligations; earlier 209 do not prove the new oracle. | Low immediate source cost; substantive compatibility decision and requalification. |
| B: investigate a genuinely compatible engine | No suitable revision is identified by this lot’s evidence; availability is unknown. Any engine change needs new builds, hashes, freeze and integration recampaign; earlier 209 do not transfer. | Uncertain investigation, possible port/toolchain change, high availability/regression risk. |
| C: implement explicit 5.9.3 compatibility above 7.1 | Retain truthful identity; strict 168 still needs an approved identity/capability distinction. New candidate and integration recampaign; preserve original expectations. | Potentially high maintenance and risk of incomplete emulation. |
| D: retain the present contract and NONPASS | No engine or contract change; 0/4 remains qualified and T00 is not closed. | Low cost; terminal progress remains blocked. |

Recommendation for this checkpoint: D. No product option has been implemented.
Sébastien must choose A/B/C/D before dependent implementation. Separately, for 229,
choose P1 (preserve the complete baseline acquisition contract, then repair/refreeze)
or P2 (approve a distinct confined, bounded, explicit-complete-SDK contract).
Neither choice alone qualifies 229 or resolves compiler identity.

ARB-002 and ARB-003 retain their historical NONPASS and were not replayed in this
lot. ARB-004 was replayed and remains NONPASS. **Combined passing credit: zero.**

The [complete independent audit ledger](independent-claim-audit.md) records author
`/root` and fresh-context auditor `/root/proof_claim_audit`, including the rejected
overclaims. Agent-Reach was unavailable; public TypeScript documentation was read
using the built-in web fallback. It provides context only and does not replace
the frozen 5.9.3 source oracle. No GitHub service or remote CI was used.
