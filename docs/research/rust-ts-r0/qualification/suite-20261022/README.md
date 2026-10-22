# Suite Phase A — 2026-10-22

This supplement is separate from the immutable 354 qualification units and 51
supports. It adds 319 units whose expected values are produced by the original
baseline `3e94997fcbefa72ad4d49b2cad180ee79b7c0a9b` with TypeScript 5.9.3.
No reserved payload was used to author these inputs, contracts or comparisons.

`consumer-contracts.json` specifies all 240 source contracts, including the 105
previously generic contracts: API sites, exact owning source predicates, inputs,
finite cumulative properties, comparisons and failure paths. A source predicate
is a specification, not an executed witness. No contract receives qualification
credit merely because its owning family has passing units.

`inputs.json` contains authored controls and source literals selected from public
baseline tests. Literal fragments execute as the complete program shown here;
they do not inherit omitted setup or coverage from their historical test.
`oracle-recipes.json` preserves independent oracle values and operation bindings.
The generator is `tools/rust-ts-r0/qualification/suite_oracle.mjs`; its arguments
are the extracted baseline root, inputs, output manifest and a fresh workspace.
Run it with Bun 1.4.3 and the baseline tsconfig override. The recorded five source
hashes and input hash permit independent regeneration. The Rust manifest guard
checks protocol structure; provenance authenticity additionally depends on that
regeneration and the committed file hashes.

Comparisons retain exact reason arrays, native-binding classifications,
ordered module links and all outline semantic fields. Structural digest bytes
are algorithm-private: the original contract compares change/equality relations.
Seventeen independent TS pairs exercise those relations; the oracle's original
digest values remain recorded. The extraction comparison sorts only the four
outer fact collections and removes native-only `startUtf16`/`endUtf16` fields
from symbols, since baseline `TsExtraction` exposes line coordinates instead.
Every other field, absence, multiplicity and nested sequence remains exact.
These comparisons make no UTF16-coordinate or digest-byte compatibility claim.
Initial development mismatches from comparing those non-contractual fields are
retained outside the repository; no original frozen expectation was changed.

The opt-in Rust replay uses the real frozen producer and process helper, input
binding checks, capability outcomes and reported successful-read provenance.
Missing execution, unsupported scope, mismatches and process failures remain
NONPASS. A demonstrated `actual_filter` bypass was rejected by strict comparison
key validation; negative and restored witnesses were retained independently.
Default comparator tests cover this guard and the two projections. Campaigns
must select the opt-in test explicitly with the frozen manifest SHA256 and fresh
evidence directory; a hash or a green comparator unit test is not a campaign.

The Phase A ledger distinguishes finite macOS/Linux property qualification from
terminal R0: native Windows, independent audit/admission and other named missing
properties remain unproved. ARB-002/003/004 receive zero passing credit. The native
compiler truthfully reports 7.1.0-dev; changing that identity to 5.9.3 would violate
the implemented dialect identity contract rather than repair a producer defect.
