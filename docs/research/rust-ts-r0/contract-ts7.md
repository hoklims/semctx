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

The current captured T00 SDK is still TypeScript **5.9.3**, with 100 declaration
libraries. Its provenance-declared archive SHA256 is
`10e108c9cf7d5f2879053dff18515fb405abf2ccef63eaaf017d9c571687a1d3`;
the committed `sdk-input.json` SHA256 is
`d1e98c4875cc3d1fe302edea4964aa12a58b391a25e6368c800413d45386b654`.
These bytes must not be relabeled TS7. Retaining this SDK or replacing it with the
pinned port's libraries is an unresolved owner decision. Compiler identity alone
does not establish SDK compatibility or actual library consumption.

The [dialect oracle](oracle-ts7.json) executes the pinned upstream `tsgo` CLI separately from the
Semctx producer, with explicit inputs and SDK, snapshots disabled and network
unavailable during campaigns. Source, lockfile, binary, SDK inventory and raw
outputs require size/SHA256 manifests. Build with `--locked --offline --release
-p ts_goport --no-default-features --features noembed --bin tsgo -j 4`, in a
session-specific `CARGO_TARGET_DIR`. Set `GOPORT_LIB_PARSE_SNAPSHOT=0` and
`GOPORT_LIB_SNAPSHOT=0` for execution.

The compiler was built and ten configurations executed on macOS arm64 and Linux
aarch64 with network access denied during execution. The oracle uses 115 libraries
from its own pinned upstream, with identical bytes on both platforms; this does
not replace Semctx's captured SDK. The manifest pins both binaries, the complete
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
| `target: es2025/es2026` | Compilation of each simple control exits 0 with the oracle's TS7 libraries; no compatibility claim for the T00 SDK follows. |

There is no approved TS5 diagnostic fallback, TS5-compatible emission promise or
permission to accept incompatible qualified module settings. Preserve explicit
Semctx configuration refusals and distinguish them from compiler code 6046.

## Obligation 229 — P2 acquisition

The owner selected confined acquisition, no Bun or foreign-SDK fallback, an
explicit complete SDK and an aggregate **67,108,864-byte** capture limit.
These are requirements, not automatic qualification credit.

Source inspection shows that the current native primitive reports acquisition failures in stdout JSON as
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

Acquisition still does not check the library set against a canonical complete
SDK inventory; that requirement belongs to the separate SDK lot. Missing
individual libraries therefore have no current diagnostic. A changed SDK payload
changes its digest; this identity primitive does not authenticate that payload
against the published archive. No-fallback must not be advertised as
authentication of every explicit SDK.

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
