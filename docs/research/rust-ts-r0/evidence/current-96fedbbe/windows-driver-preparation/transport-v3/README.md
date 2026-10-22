# Windows as-expression witness transport draft

V1 freeze a0ec681b and V2 freeze72311c64 remain under history/v1 and history/v2.
This is V3: explicit decoded-capture semantics and corrected late postflight state.
This directory is the entire mutation scope. No Semctx checkout, workflow,
native host, candidate, frozen original case or Git state was changed.

## Adoption set

- Copy `public_as_expression_witness.py` to
  `tools/rust-ts-r0/qualification/public_as_expression_witness.py`.
- Review `runner.patch`, then adopt the proposed `run_windows_milestone.py`.
  Its original is pinned at
  `d97763aaa87d3ff3469c102f812b250d2100c1c190bb335eb0df9788b6ab0142`.
- The new separate case directory holds ONLY the opaque prequery capsule.tar.gz,
  its original external manifest.frozen.json, optional package index and a local
  .gitattributes containing * -text. The capsule SHA256 is
  8e69b0e77961542118cb0b721c455ff90a02288014318ff4185e44961cf9bc6c.
  Do not copy raw TS/CJS/Python witness files into the checkout: they are frozen
  data, not new live quality-gate inputs. Original CRLF bytes stay inside the TAR.

The new witness manifest is
`c63f6c126b5a91155fb379034a1c756f3f2f0de487e5bfc628529a5a506f550b`,
oracle `e735077c8e4a2331cae55b3e3779225ba971537d70a8834fc9937675f46ccb2f`,
reader `c4e62e6ce82b2e6675f572c8ceb115d70d0d66c8ad8df59ea12ed6ef7579c4b8`.
All original23 member bytes remain unchanged. The runtime authenticates the
opaque capsule and external C63 manifest, rejects duplicate/noncanonical/link/
foreign/missing members, verifies every required decoded member hash, then writes
ONLY the23 whitelisted originals and manifest into a new owned directory outside
the checkout. The extra10 controller data members are validated as regular
whitelisted archive data, ignored and NEVER materialized or executed. Only the
frozen read_public.py and identity_scope_reader.py are imported explicitly.
The frozen reader's Windows artifact table
entry is supplied from the validated four-artifact build fixture **before** any
candidate output; its oracle, comparison functions and source remain unchanged.

The additional witness is the exact same physical source in two ordinary
contexts: retained=false, then retained=true. Windows case-insensitivity is
measured, not assumed silently; a different measurement refuses this profile.
Source and SDK input paths deliberately use one explicit drive-verbatim
namespace. Raw paths, requests, observations and hashes are not rewritten.

## Existing contracts preserved

The existing job, matrix, workflow steps, triggers and original 354 / 395 / 51 /
590 / 1,386 denominators are unchanged. There are exactly two additional direct
candidate phases inside the already authorized Windows acquisition, not an
extra campaign or job. No query retry exists.

`NativeBuildIdentity` retains its exact three Cargo build commands and four
artifact set. The extra tiny Rust caller has its own build receipt with source,
compiler, all dependency bytes, environment and resulting executable pins. It
uses the existing public `semctx_gates::process::run_with_helper` API; it never
calls the internal `__exec` handshake from Python. Each phase has a 20-second
deadline, 8 MiB per-stream cap and 45-second parent bound. Caller specs have a
separate externally passed byte digest, checked before parsing or side effects.
The existing Windows `run()` owns and terminates only that caller process tree
if its parent deadline expires. The Rust API owns the candidate tree.

The main `source-before.files` scope remains **exactly** the existing
NativeBuildIdentity scope, because the unchanged Windows evaluator requires
those maps to match. An additional `all_tracked_files` map protects all tracked
files, including the new witness bundle. An outer finally records source
postflight even when preparation, compilation or a query fails. The additional
helper separately verifies all bundle/input/SDK/artifact bytes before and after.

The process API returns `String::from_utf8_lossy` decodings of bounded captured
buffers. Compatibility files `stdout.raw` / `stderr.raw` retain those decoded
strings, **not unconditional original byte archives**. On malformed UTF-8 or
truncation, the decoded prefix and original read counts/hashes remain separate;
`capture-storage.json` states this representation. UTF-8 replacement can expand
an8MiB captured buffer into at most24MiB of stored UTF-8. Such data cannot qualify
as exact success: validation requires a successful nontruncated outcome, stored
byte counts and SHA256 matching the original outcome, and the8MiB cap. Invalid
or truncated results refuse without rewriting their metadata. If final source
postflight fails after both adjudications, the report records state FAILED,
the diagnostic and postflightfalse before it raises.

No compiler production source, native evaluator protocol
`309fbbd74141eaa0d383f340247802cd283c892a6048902adaf29e9e6c18c4c3`,
139 native source pins, or any of the five Windows evaluator transport modules
is changed. The original P21 selection and its raw comparison stay intact.
The root must explicitly join the new witness to property (221,1); no automatic
qualification or R0 decision is introduced.

## Source freeze after root adoption

The old `freeze_windows.py` correctly refuses a changed runner. Do not relax it.
The draft `freeze_windows_driver_successor.py` instead consumes the exact parent
Windows package at protocol
`7fca4576486e69bc1bc16b062099152c6c763444267f4f3f45da4f65c73769f8`.
It authenticates every inherited package byte, checks new driver/helper and
the capsule and C63 manifest **Git blobs** at an explicit committed source head
and external hashes, reauthenticates all23 required decoded members, then emits
a separate successor protocol/ZIP. Only runner
binding metadata and the new witness source binding change. Every inherited
evaluator byte and the native protocol remain the same. It creates a new output
and supplies zero query/qualification authority.

```text
python freeze_windows_driver_successor.py --repo REPO --expected-origin EXACT_ORIGIN --source-head COMMITTED_HEAD --parent-package OLD_7FCA_PACKAGE --runner-sha256 REVIEWED_NEW_RUNNER_SHA --helper-sha256 REVIEWED_NEW_HELPER_SHA --output NEW_FREEZE_DIRECTORY
```

Root adoption, the actual committed-source freeze, independent review, local
verification and the single natural CI acquisition remain unperformed here.

## Verification actually performed

The final synthetic suite executes18 tests with fake executable bytes and fake
process outcomes: two context slots pass, authorization and bool-as-int refuse,
missing/mismatched artifact and wrong oracle refuse, opposite-context results
refuse, exit-code type and output cap/hash are strict, foreign producer refuses,
one-shot retry refuses, postflight drift is retained, and the unchanged Windows
transport accepts the separate full-snapshot field but rejects its drift.
Archive controls reject traversal, links, duplicates, missing/foreign required
entries and required-member tampering before any output.
This is **not native capture evidence** and executes no compiler or candidate.

Two actual read-only source-freeze commands also refused the wrong external
driver pin and the uncommitted new helper before creating an output. Ruff F/E9,
Python AST checks and `rustfmt --edition 2024 --check caller.rs` pass. The initial
rustfmt check requested formatting; the formatted exact template is now embedded
in the helper. Initial shell quoting failure occurred before any Python command
or write; `prepare_runner_draft.py` replaced that fragile shell construction.

## Remaining local DEV check before the unique CI run

The Rust template has **not been compiled or typechecked** by this child. Root
should compile it once against current GNU1.95 release rlibs, then use harmless
owned fixture processes to exercise success, nonzero, timeout/output cap and
wrong-pin refusal. Do not query C1 or a frozen case for these DEV checks.

The local repository currently has exactly one matching rlib for each required
crate under `tools/rust-ts-r0/target/release/deps`:

- `libsemctx_gates-8452cf3f524aa8f8.rlib`
- `libserde_json-da886c70eb65d788.rlib`
- `libsha2-df72bb203d6e0754.rlib`

The separate tools/gates release deps directory is empty locally. This is only
a local DEV choice: the CI milestone explicitly builds tools/gates in release
before the extra caller, so its runtime helper uses that declared dependency
directory. `dev_compile_plan.py` prints an exact command and pins without
executing it; ambiguous or missing rlibs refuse.

```text
python dev_compile_plan.py --rustc EXACT_GNU195_RUSTC_EXE --deps REPO/tools/rust-ts-r0/target/release/deps --output NEW_DEV_CALLER_EXE
```

The caller takes `SPEC.json NEW_CAPTURE_DIRECTORY EXTERNAL_SPEC_SHA256`. A
harmless specification can use `[PINNED_PYTHON, "-c", "print('hello')"]` as its
three argv strings, an owned DEV cwd, the pinned existing semctx-gates.exe helper,
exact true authorization, timeout_ms20000 and output_cap8388608, plus source/tool
path/hash pins. It stores the bounded UTF-8-decoded streams and unaltered original
process-outcome counts/hashes before interpretation, with capture-storage
metadata. Use a fresh capture directory per control, preserve every failure,
and verify exact-stream identity before accepting any success. The Windows-only template uses no
new dependency, Cargo workspace or workflow change.
