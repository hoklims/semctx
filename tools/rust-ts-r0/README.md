# T00 native development composition

This private research crate exercises composition C1 for #365. It is not a
production analyzer, a public batch ABI, or a `READY_TS_NATIVE` decision.
The historical Semctx baseline and frozen qualification expectations remain
unchanged. See [the research record](../../docs/research/rust-ts-r0/README.md).

The pinned native compiler receives captured source/configuration/package/SDK
text through an immutable filesystem. Its checker version is 7.1.0-dev; the
provided declarations are the 115 libraries from the pinned TS7 source revision.
The [TS7 research contract](../../docs/research/rust-ts-r0/contract-ts7.md) records
the owner's reference decision and the remaining qualification limits.
Historical TS5.9.3 expectations remain historical evidence.
Owned adapters close selected differences. Their DEV tests establish their
stated observations, not universal compiler equivalence.

The analysis CLI takes `[--batch] REQUEST.json SDK.json`. Default output contains private
development observations; `--batch` projects the facts for the Rust receiver.
The receiver owns acceptance and its opaque in-process receipt. Producer fields,
including coverage declarations and input observations, cannot issue a receipt.
Its supplied freshness state is a controlled boundary, not the complete indexing
or storage implementation.

Use Rust 1.95.0 and the existing #383 supervisor. From the repository root:

```sh
export GOPORT_LIB_PARSE_SNAPSHOT=0 GOPORT_LIB_SNAPSHOT=0 RUST_TEST_THREADS=1
cargo build --manifest-path tools/gates/Cargo.toml --locked
export SEMCTX_PROCESS_HELPER="$PWD/tools/gates/target/debug/semctx-gates"
cargo test --manifest-path tools/rust-ts-r0/Cargo.toml --locked
```

On native Windows, the helper executable has the `.exe` suffix. The two snapshot
options disable upstream optimized libraries so the compiler reads the supplied
SDK. The integration tests fail when their supervisor is unavailable. They use
the real candidate executable and supervisor, retain their byte identities, and
exercise independent DEV expectations and rejection controls. Their output
directory defaults to ignored `development-evidence/`; `SEMCTX_NATIVE_EVIDENCE`
can place it outside the checkout.

`sdk/sdk-input.json` contains the captured declarations, not a JavaScript runtime.
[provenance.json](provenance.json) names their source revision, library manifest and notices.
Input read observations identify text actually returned by the captured
filesystem; the independent verifier must compare them with its own inputs.
This instrumentation does not establish absence of arbitrary operating-system
reads or coherent acquisition of live files.

The [selected optimized checkpoint](../../docs/research/rust-ts-r0/selection/README.md)
records the macOS ARM64 artifact and its six DEV vectors. Separate semantic,
source-parsing and module-configuration observations allow independent component
comparison. `javascriptObservation` composes the owned JavaScript operation;
`javascript` also retains the separate elementary scan. Ordinary import resolution
uses captured workspace inputs while its semantic-dependency scan keeps its own
source-only context. Qualification, reserved cases and Windows/Linux proof remain
separate steps. No outcome in this crate alone opens T01.

Additional private observation commands exercise explicit boundaries:

```text
--observe-primitives REQUEST.json
--observe-system REQUEST.json [SDK.json]
--extract-worker REQUEST.json SDK.json
--consume-worker REQUEST.json
```

These results bind the descriptor and executable bytes. They are observations,
not acceptance receipts. Workspace observations report unsupported grammar and
operations explicitly. Worker capture is a bounded sequential materialization;
it does not claim an atomic live snapshot. Nonrepresentable paths and ambiguous
capture keys are refused.

Default and worker extraction run a native source preflight before creating the
Program. It checks selected sources and reached relative imports/references
against captured paths and live canonical filesystem metadata. Ordinary,
unconfigured TypeScript also probes the native System resolver and checks its
resolved targets. These metadata and package-resolution reads are live; the
captured input-read manifest does not attest their identity. The compiler still
uses captured source/SDK inputs. The [N03/P03 record](../../docs/research/rust-ts-r0/resumption/gap-source-confinement-evidence.json)
bounds the observed refusal and positive control to their exact macOS DEV replay.

Private input and SDK bindings use logical-v3 manifests; capture and snapshot
bindings retain their existing domains in `src/input_identity.rs`. Repository and SDK paths inside their declared
roots are relative content names; external paths stay in a disjoint physical
namespace. SDK version, source revision, library manifest, exact files and source representations remain
bound. Request descriptors and execution scope retain physical paths. The native
receiver DEV flow exercises relocation, changed bytes, old stdout and scope-only
poisons; this is not the full T02 identity port.
