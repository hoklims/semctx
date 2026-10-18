# Final C2 pass2 replay evidence

This archive preserves the original independent final replay report, diagnostic
classification, correction closure, execution plan, preflight, both458identity
receipts, canonical383Outcome and retained streams. It also includes the exact
launcher/writer/preflight/analysis sources, compiler bindings, original expected
targets, both SDK-order records and the initial independent TypeScript oracle
JavaScript source. Original JSON and outputs are copied byte-for-byte. Absolute
paths remain historical evidence; original-path-aliases.json is a separate
portable map, not a rewrite of those records.

The independent verifier reports one invocation: transport success/exit0,
357ms,541native SDK errors plus17warnings. No project module, expression mapping
or project read occurred. Both required semantic targets were not exercised.
This publication preserves that NONPASS result and assigns no new R0 verdict.
Transport success does not establish semantic success. No additional producer
query, correction or replay was executed by the publisher.

The immutable20file handoff manifest is retained. Its two compiled executables
(supervised-invocation and semctx-gates) are deliberately excluded; their exact
byte/hash identities remain in record.json, original plans and compiler bindings.
No target trees or .rlib files are included. All23archived members are regular
relative files, sorted with uid/gid0, mode0644 and mtime0; gzip has mtime0.
Compare the decoded archive hash and every member with members-manifest.json
before extraction. The publisher decoded and read every member back to verify
its exact bytes without extracting or executing it.

Reconstruction requires the separate C2 pass2 producer source archive
c2-pass2.tar.gz.b64, whose decoded SHA256 is
2e4b0f7aa543e7a520f48a20a30bcc2191ce8f09fea1d3c2e2563ab64c42af9f.
That archive contains the already patched188file Rust source tree, original
registration, freeze and the small request/closure carriers. Follow its README
with Rust1.95.0 and Cargo.lock; do not reapply documentary patches.
A rebuilt binary has a new identity unless its bytes actually match the frozen
artifact. No byte-identical rebuild guarantee is made.

The SDK remains the canonical repository tools/rust-ts-r0/sdk/sdk-input.json,
3218481bytes, SHA256
d1e98c4875cc3d1fe302edea4964aa12a58b391a25e6368c800413d45386b654.
The unchanged expected.json has SHA256
50b739ba978d13b6d011264b1837447d0160088108406abecbd67124da8676ef.
No SDK, request, closure, expected target or observed output was regenerated.

Canonical383replay uses the archived supervised-invocation.rs writer and the
existing semctx_gates::process::run_with_helper API. The writer calls that API
with the selected native argv, cwd, actual helper,20000ms deadline and8388608byte
stream cap. It is not an alternative process controller. Compiler-bindings.json
retains the original runner, helper and dependency identities. The original
exact-command.json and plan retain historical absolute paths.

For a separately authorized reconstruction, rebuild the canonical gates library
and helper from the repository tools/gates/Cargo.toml using its Cargo.lock and
Rust1.95.0, then compile the archived writer against those actual library files:

    cargo +1.95.0 build --manifest-path "<repository>/tools/gates/Cargo.toml" --locked --release --target-dir "<new gates target>"
    rustc +1.95.0 --edition=2024 -O "<extracted>/session/composition2/oracle/pass2-reproduction/supervised-invocation.rs" --extern semctx_gates="<actual gates rlib>" --extern serde_json="<actual serde_json rlib>" -L dependency="<new gates target>/release/deps" -o "<new runner>"

Do not silently reuse the original plan after changing paths or rebuilding.
Prepare a new plan outside this evidence archive: native argv is selected
producer executable, unchanged request, canonical SDK and unchanged closure,
in that order. Bind the actual runner/helper/producer/source/input identities,
set the actual cwd and choose a new absent output directory. Preserve the
original plan and458before/after receipts unchanged. Record the new plan hash,
toolchain, platform and all changed identities; it is a new experiment.

The archived launcher checks all plan identities before invoking the canonical
writer and records them afterward, with an exact PATH/LANG/LC_ALL allowlist and
no inherited GIT_CONFIG_GLOBAL. The documentary launcher command is:

    python3 "<extracted>/session/composition2/oracle/pass2-reproduction/invoke.py" "<new independently prepared plan>"

The original bounded streams were complete: stdout205915bytes and
stderr31295bytes, both retained lengths/hashes matching the whole-stream values
in Outcome. Canonical Outcome can decode malformed UTF8 lossily; these receipts
do not assert a stronger general raw-byte guarantee. Runner stdout/stderr files
are separately preserved.

Source rebinding, canonical supervision and a new run do not create independent
semantic expectations or qualify a rebuilt candidate. The original independent
verifier authored this result; the publisher added no new independence claim.
The source and SDK evidence is local macOS ARM64 DEV. Native Windows/Linux,
reserved cases, full T00 qualification and READY_TS_NATIVE remain unproved by
this replay. Library errors alone do not prove Rust universally infeasible,
especially with the baseline skipLibCheck policy.

The final C2 correction is closed. This documentation is reproduction material,
not authorization for another correction or automatic replay. No repository
file, Git index, GitHub object or reserved corpus was touched by the publisher.
