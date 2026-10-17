# T00 native development composition

This private research crate exercises composition C1 for #365. It is not a
production analyzer, a public batch ABI, or a `READY_TS_NATIVE` decision.
The historical Semctx baseline and frozen qualification expectations remain
unchanged. See [the research record](../../docs/research/rust-ts-r0/README.md).

The pinned native compiler receives captured source/configuration/package/SDK
text through an immutable filesystem. Its checker version is 7.1.0-dev; the
provided declarations and the reference behavior are TypeScript 5.9.3.
Owned adapters close selected differences. Their DEV tests establish their
stated observations, not universal compiler equivalence.

The CLI takes `[--batch] REQUEST.json SDK.json`. Default output contains private
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
[provenance.json](provenance.json) names their package/archive and notices.
Input read observations identify text actually returned by the captured
filesystem; the independent verifier must compare them with its own inputs.
This instrumentation does not establish absence of arbitrary operating-system
reads or coherent acquisition of live files.

The [selected optimized checkpoint](../../docs/research/rust-ts-r0/selection/README.md)
records the macOS ARM64 artifact and its six DEV vectors. Separate semantic,
source-parsing and module-configuration observations allow independent component
comparison. Elementary JavaScript scan reasons do not represent the complete
historical JavaScript consumer. Qualification, reserved cases and Windows/Linux
proof remain separate steps. No outcome in this crate alone opens T01.
