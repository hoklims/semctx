# T00 — TS7 reference contract

Status: partially specified research contract, owner decisions of 2026-10-23.
This contract applies to the T00 experiment only. It does not migrate the delivered
profiles in accepted ADRs [0034](../../adr/0034-javascript-static-esm.md) and
[0035](../../adr/0035-qualified-static-analysis-admission.md), grant admission,
or declare `READY_TS_NATIVE`.

## Reference and evidence

The owner selected `ts_goport` as the compiler reference instead of TypeScript
5.9.3. Its identities are separate:

| Identity | Pin |
| --- | --- |
| Compiler runtime version | `7.1.0-dev` |
| Rust repository | `https://github.com/pingdotgg/ts-rust` |
| Rust source revision | `780dc512d64f40afebffa6a7028207649fb7ed1c` |
| Crate requirement | `=7.0.0-dev` |
| Build toolchain | Rust/Cargo `1.95.0` |
| Upstream declared by the Rust source | `microsoft/TypeScript@fed0bf24149fb1ed36039212648bafdafc1ea10e`, `tsc/` |

The last row records the port's declaration, not an independent comparison with
the Go implementation. `GOPORT_BUILD_VERSION` must be absent when building the
reference; the executed compiler must report the pinned runtime version.

The owner selected the pinned port's **115 declaration libraries** as the T00
SDK to qualify. `tools/rust-ts-r0/sdk/sdk-input.json` captures their exact UTF-8
bytes from `crates/ts_goport/libs` at the Rust revision above. The canonical
`library-manifest.json` has SHA256
`b1fa7b60aa83d187453b26c0b56a096875a47e61977954aba7deba16161fd7ad`,
identical to the oracle SDK manifest. `provenance.json` records the descriptor
hash, source revision, sizes and notices; this SDK has no npm archive identity.
Compiler and SDK identities remain separate. Inventory validation does not
establish that every library was consumed or that an obligation is qualified.

The [dialect oracle](oracle-ts7.json) executes the pinned upstream `tsgo` CLI separately from the
Semctx producer, with explicit inputs and SDK, snapshots disabled and network
unavailable during campaigns. Source, lockfile, binary, SDK inventory and raw
outputs require size/SHA256 manifests. Build with `--locked --offline --release
-p ts_goport --no-default-features --features noembed --bin tsgo -j 4`, in a
session-specific `CARGO_TARGET_DIR`. Set `GOPORT_LIB_PARSE_SNAPSHOT=0` and
`GOPORT_LIB_SNAPSHOT=0` for execution.

The compiler was built and ten configurations executed on macOS arm64 and Linux
aarch64 with network access denied during execution. The oracle uses 115 libraries
from its own pinned upstream, with identical bytes on both platforms. The producer
now captures those same library bytes; the oracle record describes its earlier
execution and is not a fresh producer qualification. The manifest pins both binaries, the complete
source/SDK manifests and exact raw observations. These are successful builds,
not a claim of bit-identical repeated builds. `--showConfig` is excluded as a
diagnostic oracle because it silently omits invalid options in these controls.

This is independence from Semctx's implementation, not a second implementation
of the compiler. It can establish version and compiler option diagnostics; it
cannot by itself provide Semctx graphs, ownership, scope or admission. Those
obligations still need independent consumer expectations and their actual owning
boundaries. The historical `suite_oracle.mjs` executes TS5.9.3 APIs and remains a
historical oracle; changing its version guard or relabeling its outputs is invalid.

## Configuration and TS5 degradation

TS5 projects must have a degraded mode under the owner's decision. Its project
identification rule, supported analysis/admission surface and diagnostic code,
message and emission point remain unresolved. No implementation or qualification
of that mode is claimed until those choices are approved and exercised.

The [lot 4 findings](qualification/lots-20261023/lot4/findings.json) distinguish
parser behavior from Semctx policy on the previous candidate. Fresh independent
TS7 `--noEmit` compilation now supplies complete expected compiler messages in
`oracle-ts7.json`. The ten identical-input runs have byte-identical stdout/stderr
and exit codes on macOS arm64 and Linux aarch64:

| Configuration | TS7 reference distinction from TS5.9.3 |
| --- | --- |
| Invalid `target`, code 6046 | Allowed-value diagnostic omits `es5`, adds `es2025` and `es2026`. |
| Invalid `module`, code 6046 | Allowed-value diagnostic omits `none`, `amd`, `system` and `umd`. |
| `target: es5` | Parser acceptance does not imply compiler support: compilation exits 2 with TS5108, `Option 'target=ES5' has been removed. Please remove it from your configuration.` |
| `module: none` | Compilation exits 2 with the full module TS6046 diagnostic. |
| `module: amd/system/umd` | Parser acceptance does not imply compiler support: compilation exits 2 with TS5095 and TS5108. Semctx's retained-profile rejection is separate. |
| `target: es2025/es2026` | Compilation of each simple control exits 0 with the oracle's TS7 libraries; no producer qualification follows from this oracle control. |

There is no approved TS5 diagnostic fallback, TS5-compatible emission promise or
permission to accept incompatible qualified module settings. Preserve explicit
Semctx configuration refusals and distinguish them from compiler code 6046.

## Obligation 229 — P2 acquisition

The owner selected confined acquisition, no Bun or foreign-SDK fallback, an
explicit complete SDK and an aggregate **67,108,864-byte** capture limit.
These are requirements, not automatic qualification credit.

The historical `baseline_analyzer_identity` primitive identifies the TS5.9.3
package and its 100 standard libraries; it neither executes nor identifies the
TS7 compiler. Its acquisition failures are reported in stdout JSON as
`identity_success: false` with `error`, while the observation process exits 0.
It does not execute the compiler. Malformed/missing request fields fail earlier
with stderr JSON and exit 1. The following source-observed diagnostics are not a
fresh qualification of the primitive:

| Restriction or failure | Native diagnostic | Emission point |
| --- | --- | --- |
| Read path, traversed directory or enumerated symlink escapes its root | `LEGACY_IDENTITY_OUTSIDE_ROOT:<relative>` | After canonicalization, before opening the target or enumerating its directory. Implementation acquisition uses the repository root; SDK acquisition uses the explicit SDK root, which may be outside the repository. Every symlink encountered in package, recursive source or SDK-library enumeration is checked, including otherwise ignored entries. |
| Enumerated symlink or explicitly read file is dangling or cyclic | `LEGACY_IDENTITY_READ_FAILED:<relative>:<OS error>` | Canonicalization fails closed; no identity is returned. |
| Traversed directory unavailable, including a dangling or cyclic directory link | `LEGACY_IDENTITY_DIRECTORY_READ_FAILED:<relative>:<OS error>` | Directory canonicalization or enumeration fails; no identity is returned. |
| SDK root missing | `LEGACY_IDENTITY_SDK_UNAVAILABLE:<OS error>` | SDK root canonicalization, after implementation capture. |
| SDK package missing | `LEGACY_IDENTITY_READ_FAILED:package.json:<OS error>` | Explicit SDK read; no fallback. |
| SDK entry missing | `LEGACY_IDENTITY_READ_FAILED:lib/typescript.js:<OS error>` | Explicit entry read; no fallback. |
| SDK package malformed | `LEGACY_IDENTITY_SDK_INVALID:<serde error>` | Package decoding. |
| SDK package name/version mismatch | `LEGACY_IDENTITY_SDK_VERSION_MISMATCH` | Before library enumeration; current predicate requires `typescript` / `5.9.3`. |
| Standard library missing or extra | `LEGACY_IDENTITY_SDK_INVENTORY_MISMATCH:missing=<JSON array>;extra=<JSON array>` | Before entry/library reads, comparing sorted `lib*.d.ts` names with the historical published SDK manifest. Compiler API declarations such as `typescript.d.ts` are outside that inventory. |
| SDK not specified | `PRIMITIVE_INVALID_REQUEST:missing field ` followed by backtick-delimited `compiler_package_root` | Request decoding, stderr/exit 1. |
| Aggregate capture exceeds 64 MiB | `LEGACY_IDENTITY_CAPTURE_LIMIT` | Read limited to remaining bytes plus one, before recording that read or returning identity. |

Source inspection shows that the capture count includes implementation, package, entry and library bytes;
package bytes reused in the manifest are not counted twice. OS and serde suffixes
are environment-dependent; campaigns retain their exact native bytes.

Internal symlinks remain accepted: explicitly read files and traversed directory
paths resolve within their acquisition root. Symlinks encountered by recursive
source or package discovery remain excluded from the captured file set and are
not traversed, preserving the existing identity; an internal directory alias or
cycle therefore adds no bytes. SDK library aliases are read within the SDK root.
This is the acquisition scope, not a scan of every repository path or a guarantee
against concurrent filesystem mutation.

`native_identity_confinement` exercises recursive and explicit escapes, internal
aliases and unresolvable links. `native_development_flow::legacy_identity_flow`
exercises an explicit SDK without Bun, missing/invalid/omitted SDKs with a valid
installed alternative, and aggregate captures of exactly 67,108,864 bytes
(accepted) and 67,108,865 bytes (refused). These regression tests do not qualify
obligation 229 or execute the compiler.

The TS7 analysis and extraction-worker paths validate their captured SDK before
compiler execution: exact
version, source revision and manifest identity, then the complete 115-file set
and each file's byte length/SHA256. Its stable errors are
`SDK_LIBRARY_MISSING:<name>`, `SDK_LIBRARY_UNEXPECTED:<name>` and
`SDK_LIBRARY_CONTENT_MISMATCH:<name>`. The first missing name is reported before
extras, in sorted order. These errors abort analysis; no capability is emitted.
Analyzed capabilities distinguish the executed compiler's version/revision from
the validated SDK's version/revision/library manifest. Logical input and SDK
identities use v3 domains for this changed descriptor; historical v2 verification
expectations remain historical and must not be reused as TS7 evidence.

Historical TS5 acquisition observes payload digests
without authenticating their bytes against the archive. Its inventory check does
not change that scope. TS7 payload validation and TS5 identity acquisition are
different boundaries; neither grants qualification of obligation 229 by itself.
The targeted `--observe-system` and `--observe-configured-resolution` primitives
retain partial SDK fixtures and are outside this complete-inventory guarantee.

## Requalification

All 240 obligations require fresh evidence on the integrated candidate. The 209
historical finite TS5 qualifications remain historical; none transfers to TS7.
The `obligationImpact` references in `oracle-ts7.json` identify the exhaustive
240-row static census at `7fac99a9`, its 16 disjoint groups, API/source dependencies,
prior evidence and remaining proof gaps. Every row has a reason and an evidence
reference; wrappers 232–238 lack structured source/API locations in that snapshot.
That census predates these oracle executions and is not a campaign result.
Compiler-dependent AST, types, resolution, diagnostics and emission change the
oracle. Filesystem, worker, identity, receipt and admission obligations also need
fresh candidate-bound evidence even where their intended invariant is unchanged.

Obligations 23/26/27 and 223–228 require fresh complete 6046 expectations; 168
requires actual nonempty analyzed capability subjects and compiler identity.
Obligations 4/235 retain their public composition gap. Obligations 198/204/209
retain their unexercised branches; 220/229 need the explicit acquisition boundary.
Refusal admission and post-emission receipt revalidation remain necessary for
0/1/2/3/232–234/236–238. A version decision closes none of these proof gaps.

Every obligation stays `not_qualified` until all its cumulative properties and
negative controls pass on macOS arm64 and Linux aarch64 against the new reference.
ARB-002/003/004 remain separate, with zero credit. This finite two-platform result
would not establish terminal R0 or native Windows qualification.
