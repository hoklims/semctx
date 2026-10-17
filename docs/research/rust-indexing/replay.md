# Replay the Rust indexing discovery

This is an experiment protocol, not a product installer or a new CI gate. Run from the repository
root on trusted inputs. The measured host was macOS 27.0.1 arm64, Apple M4 Max (16 cores), 64 GiB,
Bun 1.4.3, Python 3.15.0, Rust/Cargo 1.98.1 with `rust-src`. The repository barrier separately uses
Python 3.11.15, Ruff 0.16.10 and Zizmor 1.30.1. Linux arm64 container smokes are recorded below;
complete native distribution replay remains B05.

## Pins and preparation

Use a separate scratch directory and keep generated targets outside the checkout:

```sh
ROOT=$(git rev-parse --show-toplevel)
RUN=$(mktemp -d "${TMPDIR:-/tmp}/semctx-rust-346.XXXXXX")
export RUN
export PATH="$HOME/.cargo/bin:$PATH"
export RUSTUP_TOOLCHAIN=1.98.1
export CARGO_TARGET_DIR="$RUN/target"
export CARGO_NET_OFFLINE=true
mkdir -p "$RUN/tools" "$RUN/raw"
rustc --version
cargo --version
bun --version
python3 --version
```

## Materialize the research workspaces

The eight research manifests are stored as `Cargo.toml.snapshot`, with their original bytes.
They include intentionally invalid worlds and crates without tests; they are experimental data,
not native product crates. Keep the repository's automatic product-crate gate unchanged.
Materialize a fresh sibling layout under `$RUN` before invoking Cargo or rust-analyzer:

```sh
python3 - <<'PY' || exit 1
import os
from pathlib import Path
import shutil

source = Path("docs/research/rust-indexing")
destination = Path(os.environ["RUN"]) / "rust-indexing"
shutil.copytree(source, destination, ignore=shutil.ignore_patterns("target", "__pycache__"))
for snapshot in sorted(destination.rglob("Cargo.toml.snapshot")):
    snapshot.rename(snapshot.with_name("Cargo.toml"))
PY
export RESEARCH="$RUN/rust-indexing"
```

The destination must not exist: copying refuses rather than overwriting a previous replay.
Sources and lockfiles retain their sibling paths, including `syn-probe`'s reference to `fixture`.
Historical result recordings retain their original checkout paths; this materialization does not
rebind those observations to a new execution. Run both owned Python suites with
`python3 -m unittest discover -s scripts/test -p 'test_rust_indexing_*.py'`.

The toolchain and `rust-src` must already be installed. Dependency acquisition is a separate,
networked preparation step: use `CARGO_NET_OFFLINE=false cargo fetch --locked --manifest-path
"$RESEARCH/syn-probe/Cargo.toml"`, then return to offline operation. Do not infer
offline readiness from an empty Cargo cache. Do not run these probes on an unreviewed Cargo config.

macOS arm64 commands used for the binary/parser assets:

```sh
curl -fLsS --max-time 60 https://github.com/rust-lang/rust-analyzer/releases/download/2026-10-12/rust-analyzer-aarch64-apple-darwin.gz -o "$RUN/tools/rust-analyzer.gz"
curl -fLsS --max-time 60 https://github.com/tree-sitter/tree-sitter-rust/releases/download/v0.24.2/tree-sitter-rust.wasm -o "$RUN/tools/tree-sitter-rust.wasm"
curl -fLsS --max-time 60 https://registry.npmjs.org/web-tree-sitter/-/web-tree-sitter-0.27.1.tgz -o "$RUN/tools/web-tree-sitter-0.27.1.tgz"
curl -fLsS --max-time 60 https://github.com/scip-code/scip/releases/download/v0.10.0/scip-darwin-arm64.tar.gz -o "$RUN/tools/scip.tar.gz"
```

Verify all downloads before extracting or executing them. A missing asset or hash mismatch
stops the replay:

```sh
shasum -a 256 -c <<EOF || { printf '%s\n' 'Downloaded asset verification failed' >&2; exit 1; }
a2e45e828b37bfc4b507c2ca456e8b61096e0bdfbae225f3d33295546d1eeacf  $RUN/tools/rust-analyzer.gz
24c89bd9252255e4aebbcbd7d2d308bd92c86dd95a130fdc80efa49577b8d738  $RUN/tools/tree-sitter-rust.wasm
7346db659eb870a5284242851ab7aedea41d7397b8c7e95ff8d9ec5b5a80270f  $RUN/tools/web-tree-sitter-0.27.1.tgz
7ea200390e0790b3da8999b7b1cd4e3597700dcb3d354911872523bfe0090779  $RUN/tools/scip.tar.gz
EOF
gzip -dk "$RUN/tools/rust-analyzer.gz"
chmod +x "$RUN/tools/rust-analyzer"
tar -xzf "$RUN/tools/web-tree-sitter-0.27.1.tgz" -C "$RUN/tools"
tar -xzf "$RUN/tools/scip.tar.gz" -C "$RUN/tools"
"$RUN/tools/rust-analyzer" --version
"$RUN/tools/scip" --version
```

The expected hashes are:

| Asset | SHA-256 |
| --- | --- |
| `rust-analyzer.gz` | `a2e45e828b37bfc4b507c2ca456e8b61096e0bdfbae225f3d33295546d1eeacf` |
| `tree-sitter-rust.wasm` | `24c89bd9252255e4aebbcbd7d2d308bd92c86dd95a130fdc80efa49577b8d738` |
| `web-tree-sitter-0.27.1.tgz` | `7346db659eb870a5284242851ab7aedea41d7397b8c7e95ff8d9ec5b5a80270f` |
| `scip.tar.gz` | `7ea200390e0790b3da8999b7b1cd4e3597700dcb3d354911872523bfe0090779` |

For other platforms select the same release's corresponding asset and record its actual hash,
architecture and execution result. Availability of an asset is not packaging validation.

## Source integrity

Public corpus source: `RazrFalcon/pico-args` commit
`56e8872fa31f168fd87e84fdc5f24bd60875daea` (tag `v0.5.0`). The archive URL is
`https://codeload.github.com/RazrFalcon/pico-args/tar.gz/56e8872fa31f168fd87e84fdc5f24bd60875daea`,
observed SHA-256 `9fc09f5e522a0cc4fd004405dce8b783deecad1bb3cf54e8283eb281676f59af`.
Compare extracted bytes with the vendored subset, which is authoritative for these trials even if
GitHub changes archive encoding. Code, manifest bytes (stored as `Cargo.toml.snapshot`) and README are unchanged; the vendored license
only removes the final empty line for repository diff hygiene. The original license SHA-256 is
`f71452d91682fdae0ca948b18cfed53a953d1237740dd80371c76a5c1c7bbe91`.

```sh
shasum -a 256 "$RESEARCH/corpus/pico-args-0.5.0/Cargo.toml" \
  "$RESEARCH/corpus/pico-args-0.5.0/LICENSE" \
  "$RESEARCH/corpus/pico-args-0.5.0/README.md" \
  "$RESEARCH/corpus/pico-args-0.5.0/src/lib.rs"
```

| Vendored file | SHA-256 |
| --- | --- |
| `Cargo.toml` | `1a8913f660858e58d226ae45c7ca24913137e2777219eca5f59cbac591af87bc` |
| `LICENSE` | `be8e392dd41994a6df38da0dd0e61a131d30179ce3e4c287f49311e6b8f6b2b8` |
| `README.md` | `003d937d623b9556736f046059e44530aabf954d725e6fb35e48da3b19af91cc` |
| `src/lib.rs` | `a3bec80854f4b259944720f3d984de4da19b230e24010e1fac374f6f32cc6865` |

## Native oracles and owned probe tests

```sh
cargo test --locked --offline --all-features --manifest-path "$RESEARCH/fixture/Cargo.toml"
cargo run --locked --offline --manifest-path "$RESEARCH/fixture/Cargo.toml" -p indexing-app
cargo test --locked --offline --manifest-path "$RESEARCH/syn-probe/Cargo.toml"
cargo fmt --all --check --manifest-path "$RESEARCH/fixture/Cargo.toml"
cargo fmt --all --check --manifest-path "$RESEARCH/syn-probe/Cargo.toml"
python3 -m unittest discover -s scripts/test -p test_rust_indexing_lsp.py
cargo build --release --locked --offline --manifest-path "$RESEARCH/syn-probe/Cargo.toml"
```

Fixture tests establish concrete/generic/dynamic positive-amount results, not the behavior of a
Semctx adapter. Helper tests exercise real subprocess output, syntax rejection, missing/unreadable
input, invalid UTF-8, and the owned scalar-column→byte conversion. Transport tests exercise
consecutive UTF-8 frames and corrupt/truncated JSON bodies. Tests were observed red before helper,
fixture and transport implementations were completed. No test reimplements a parser grammar.

## T — WASM parsing

This command calls the official parser directly. Timings cover `parse`, with source reading and
AST serialization outside the timed interval. Run each normal source in the fixed order below,
then the two negative files and the real corpus; save the full JSONL, including native ASTs:

```sh
bun --eval '
const {Parser,Language}=await import(process.env.RUN+"/tools/package/web-tree-sitter.js");
await Parser.init({locateFile:()=>process.env.RUN+"/tools/package/web-tree-sitter.wasm"});
const parser=new Parser();
parser.setLanguage(await Language.load(process.env.RUN+"/tools/tree-sitter-rust.wasm"));
for(const file of process.argv.slice(1)){
  const source=await Bun.file(file).text();
  const samples=[];
  let ast="",hasError=false;
  for(let run=0;run<3;run++){
    const start=performance.now();
    const tree=parser.parse(source);
    samples.push(performance.now()-start);
    ast=tree.rootNode.toString();hasError=tree.rootNode.hasError;tree.delete();
  }
  console.log(JSON.stringify({file,bytes:Buffer.byteLength(source),parseMs:samples,hasError,ast}));
}' \
"$RESEARCH/fixture/domain/src/model.rs" \
"$RESEARCH/fixture/domain/src/operations.rs" \
"$RESEARCH/fixture/domain/src/lib.rs" \
"$RESEARCH/fixture/domain/tests/dispatch.rs" \
"$RESEARCH/fixture/app/src/main.rs" \
"$RESEARCH/fixture/negative/malformed.rs" \
"$RESEARCH/fixture/negative/unresolved.rs" \
"$RESEARCH/corpus/pico-args-0.5.0/src/lib.rs" > "$RUN/raw/tree.jsonl"
```

The command imports the pinned downloaded runtime rather than modifying root dependencies.
Expected: only `malformed.rs` has a parse error;
`unresolved.rs` is valid syntax. Inspect AST declaration names against W01, not a count copied
from a previous engine. This binding's Unicode trial yielded `startIndex/column = 22` for a function
after a crab emoji, versus UTF-8 offset 24; native C byte-column assumptions do not apply to JS strings.

## Y — syn helper

```sh
"$CARGO_TARGET_DIR/release/semctx-rust-syn-probe" "$RESEARCH/fixture/domain/src/model.rs"
"$CARGO_TARGET_DIR/release/semctx-rust-syn-probe" "$RESEARCH/fixture/domain/src/lib.rs"
"$CARGO_TARGET_DIR/release/semctx-rust-syn-probe" "$RESEARCH/corpus/pico-args-0.5.0/src/lib.rs"
"$CARGO_TARGET_DIR/release/semctx-rust-syn-probe" "$RESEARCH/fixture/negative/malformed.rs"
```

Each invocation writes TSV on stdout and parser-only nanoseconds on stderr. The malformed invocation
must exit nonzero with no partial summary. Repeat all five normal files three times for comparable
fixture parsing scope; sum their parser times, not their count of differently defined AST items.
`extra_quote` is present despite Cargo's feature being disabled: the helper does not evaluate cfg.

## S — batch SCIP and native decoder

```sh
for n in 1 2 3; do
  /usr/bin/time -l "$RUN/tools/rust-analyzer" scip "$RESEARCH/fixture" --output "$RUN/raw/fixture-$n.scip" --num-threads 4 > "$RUN/raw/fixture-$n.stdout" 2> "$RUN/raw/fixture-$n.time" || exit $?
  /usr/bin/time -l "$RUN/tools/rust-analyzer" scip "$RESEARCH/corpus/pico-args-0.5.0" --output "$RUN/raw/pico-$n.scip" --num-threads 4 > "$RUN/raw/pico-$n.stdout" 2> "$RUN/raw/pico-$n.time" || exit $?
done
"$RUN/tools/scip" print --json "$RUN/raw/fixture-1.scip" > "$RUN/raw/fixture-1.json" || exit $?
"$RUN/tools/scip" print --json "$RUN/raw/pico-1.scip" > "$RUN/raw/pico-1.json" || exit $?
```

`/usr/bin/time -l` is the macOS measurement tool. On Linux use its native RSS/time equivalent;
Windows requires native process accounting. SCIP printer JSON is diagnostic output, not a Semctx
ingestion schema. The exporter's pinned protocol is [SCIP 0.7.1](https://github.com/scip-code/scip/blob/v0.7.1/scip.proto);
do not derive a product decoder from whatever `main` contains later.

Expected fixture: five documents, 174 occurrences, no symbol relationships, and duplicate-symbol /
missing-definition diagnostics on stderr even though exit is zero. Real corpus: one document,
983 occurrences, no relationships. Repeated fixture artifacts had equal SHA-256
`82a460788d93e2b2bcf669772dcadc44aafa2e04381eeb48f5621de2936af8fa` at the original root;
absolute `project_root` means another checkout is not expected to reproduce that hash.

To exercise cfg, write `{"cargo":{"features":["extra"],"offline":true}}` to `$RUN/extra.json`
and repeat the fixture with `--config-path "$RUN/extra.json"`. The decoded output then includes
`extra_quote`; default output omits it. Both include the inline test. This is one feature world,
not evidence for all combinations. `rust-analyzer scip fixture/negative/manifest` (using the full
fixture path) exits nonzero without producing an index; the stderr observation is retained.

## L — LSP navigation, lifecycle and edit

```sh
for n in 1 2 3; do
  /usr/bin/time -l python3 scripts/rust-indexing-lsp.py "$RUN/tools/rust-analyzer" "$RESEARCH/fixture" app/src/main.rs > "$RUN/raw/fixture-lsp-$n.json" 2> "$RUN/raw/fixture-lsp-$n.time" || exit $?
  /usr/bin/time -l python3 scripts/rust-indexing-lsp.py "$RUN/tools/rust-analyzer" "$RESEARCH/corpus/pico-args-0.5.0" src/lib.rs --line 124 --character 14 --definition-line 125 --definition-character 14 > "$RUN/raw/pico-lsp-$n.json" 2> "$RUN/raw/pico-lsp-$n.time" || exit $?
done
```

Coordinates are zero-based UTF-16. The probe negotiates readiness, disables build scripts/proc
macros/check-on-save, opens the source, queries symbols, a deliberately absent workspace symbol,
call hierarchy and definition, changes the in-memory document by appending LF, queries symbols
again, then shuts down. The absent-name result is an observation, never negative completeness.
The current probe honors the server's synchronization capability: incremental mode appends LF
at the UTF-16 end position; full mode sends the whole replacement; absent/disabled synchronization
refuses the edit. Source text is read explicitly as UTF-8. A nonzero server exit preserves the
diagnostic JSON, including `exitCode`, and makes the probe exit nonzero.
JSON uses ASCII escapes so Unicode values also survive legacy Windows stdout encodings.
The retained measurements predate these corrections: their full-text change was accepted by the
pinned server despite its incremental capability. They do not qualify negotiated incremental
editing or the corrected probe's latency; that requires a new native measurement series.
The real API query targets `Arguments::from_env`, with four outgoing navigation targets. First
pilot coordinates missed a function; retained serial measurements use the corrected coordinates.

`--timeout 0.001` produces a real `TimeoutError`; a nonexistent binary produces `FileNotFoundError`.
The probe refuses headers larger than 8 KiB, message bodies larger than 4 MiB, more than
16 MiB of cumulative wire input (headers included), or more than 10,000 messages. These limits
bound captured protocol input; they do not measure or cap the server's resident memory.
Message bodies are decoded strictly as UTF-8 before parsing JSON. UTF-16 and UTF-32 JSON,
with or without a byte order mark, are refused rather than accepted through encoding detection.
An omitted charset defaults to UTF-8; an explicit charset accepts `utf-8` or the legacy `utf8`
alias, case-insensitively, including quoted parameter values. Duplicate Content-Type headers,
duplicate charset parameters and unsupported charsets are refused. JSON numeric extensions
`NaN`, `Infinity` and `-Infinity`, and numeric literals that overflow the finite float range,
are refused so diagnostic JSON does not acquire non-JSON infinities. Finite numbers and strings
such as `"NaN"` remain valid. Numeric range limits follow [RFC 8259 section 6](https://www.rfc-editor.org/rfc/rfc8259#section-6).
Encoding checks follow the
[LSP 3.17 content-part encoding contract](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/#contentPart).
After sending `exit`, stdout is drained in 64 KiB chunks without retaining further diagnostics,
so a server's trailing output cannot block its exit behind a full pipe. On cancellation or refusal,
the direct RA child is killed, stdin is closed, and stdout drainage and child reaping share a
separate one-second cleanup deadline. Thus `--timeout` bounds the main probe, with up to one
additional second for cleanup. An exit racing the kill is tolerated. These bounds do not promise
isolation or termination of an arbitrary Cargo process tree. No product subprocess manager is implemented.
Responses are retained verbatim apart from documented root/temp prefix normalization. The Python
probe is intentionally not a production LSP client: it cannot establish a coherent whole-index
generation or qualify arbitrary server requests.

## Benign execution sentinel

Reproduce W07 only in a disposable directory under `$RUN`, with no external dependencies:

```sh
mkdir -p "$RUN/execution/src"
printf '[package]\nname="execution-probe"\nversion="0.0.0"\nedition="2021"\n' > "$RUN/execution/Cargo.toml"
printf 'pub fn visible() {}\n' > "$RUN/execution/src/lib.rs"
printf 'fn main() { std::fs::write("executed", "build.rs ran").unwrap(); }\n' > "$RUN/execution/build.rs"
printf '{"cargo":{"buildScripts":{"enable":false},"offline":true},"procMacro":{"enable":false}}\n' > "$RUN/disable.json"
CARGO_TARGET_DIR="$RUN/execution-target" "$RUN/tools/rust-analyzer" scip "$RUN/execution" --config-path "$RUN/disable.json" --output "$RUN/raw/execution.scip" --num-threads 4
cat "$RUN/execution/executed"
```

Observed content: `build.rs ran`. The source-level loader finding and this native execution agree.
The protocol does not run untrusted proc macros; their origin/timeout/target cases remain B01/B04.

## Replay limits

Now executable: structure, concrete/generic/dyn fixture behavior, alias resolution, outgoing
navigation, cfg feature/target deltas, real-corpus parsing/export/navigation, invalid and ambiguous
references, function values, macro/generated origin limits, invalid syntax/manifest, transport
framing, timeout, absent executable and build-script execution. Native compiler rejection
of `negative/unresolved.rs` can be replayed with `rustc --crate-type lib --out-dir "$RUN/target"`.

Not executed as Rust Semctx integration: source/config capture drift, index tampering, symlink/path
escape, add/delete/rename/checkout/worktree, mixed TS/JS/Python/Rust indexing and admitted
macro-origin/multi-target facts. They are named #347 proof obligations P01–P22; raw parser success
does not stand in for them. This distinction is part of the recommendation's blockers.

## Edge-world trials (W11–W13)

The separate `edge-cases` workspace has no registry dependencies. It contains a benign proc macro,
a build script writing only its Cargo OUT_DIR, declarative expansion, indirect calls, feature/target
branches and a deliberately invalid module behind the `invalid` feature. Native oracle commands:

```sh
cargo test --locked --offline --workspace --manifest-path "$RESEARCH/edge-cases/Cargo.toml"
cargo test --locked --offline --workspace --manifest-path "$RESEARCH/edge-cases/Cargo.toml" --features alternate
cargo check --locked --offline --manifest-path "$RESEARCH/edge-cases/Cargo.toml" --features invalid
cargo check --locked --offline --manifest-path "$RESEARCH/edge-cases/Cargo.toml" --target x86_64-pc-windows-msvc
```

Default/alternate test results are 40/41 on Unix. The invalid command must fail with E0659 and
E0425; the local Windows cross-check failed E0463 because target std was absent. It is not native
Windows evidence. Do not run `--all-features` expecting the intentionally invalid world to compile.

For each row call `python3 scripts/rust-indexing-lsp.py "$RUN/tools/rust-analyzer"
"$RESEARCH/edge-cases" FILE --line L --character C --definition-line DL
--definition-character DC`, with the following zero-based coordinates and optional flags:

| Case | FILE | L:C | DL:DC | Extra arguments | Observed definition |
| --- | --- | --- | --- | --- | --- |
| Feature default | `src/lib.rs` | 42:7 | 48:12 | none | configured at 15:7–17 |
| Feature alternate | `src/lib.rs` | 42:7 | 48:12 | `--features alternate` | configured at 20:7–17 |
| Target Unix | `src/lib.rs` | 42:7 | 49:12 | none | platform at 25:7–15 |
| Target Windows | `src/lib.rs` | 42:7 | 49:12 | `--target x86_64-pc-windows-msvc` | platform at 30:7–15 despite absent target std |
| Ambiguous import | `src/invalid.rs` | 15:7 | 16:8 | `--features invalid` | only left::shared at 1:11–17, despite Cargo E0659 |
| Missing name | `src/invalid.rs` | 19:7 | 20:8 | `--features invalid` | [] |
| Function parameter call | `src/lib.rs` | 38:7 | 39:6 | none | callback parameter at 38:27–35; outgoing wrapper hierarchy [] |
| Function-value origin | `src/lib.rs` | 42:7 | 43:33 | none | concrete at 34:7–15; does not resolve the indirect call |
| Declarative macro call | `src/lib.rs` | 42:7 | 44:8 | none | definition 4:15–26 and invocation 10:0–19 |
| Procedural macro call | `src/lib.rs` | 42:7 | 45:12 | none | []; expansion-disabled diagnostic |
| Generated call | `src/lib.rs` | 42:7 | 46:12 | none | []; OUT_DIR absent diagnostic |

Exact original argv arrays for the scripted scenarios are retained as `edge-lsp-*.command.json`;
the consolidated `edge-summary.json` retains definitions, calls, native exits and syntax results.
The recommended resolver's singleton target **does not certify uniqueness**: both RA transports
choose left::shared while the compiler rejects the world. An integration must refuse such a world
or establish an independent diagnostic boundary, rather than trusting the one returned location.

Replay batch SCIP on this workspace with default config and with
`{"cargo":{"features":["alternate"],"offline":true}}`,
`{"cargo":{"features":["invalid"],"offline":true}}`, or
`{"cargo":{"target":"x86_64-pc-windows-msvc","offline":true}}` in `--config-path`.
All four original exports exited zero, even the invalid/target-unavailable worlds. The benign
proc macro was built/executed and build.rs ran. Procedural/generated calls have occurrence ranges,
but no corresponding generated definition occurrence; generated.rs is not an exported document.
Tree/syn accept all these source files, including invalid.rs, and retain both cfg branches.

The owned helper's BOM regression is separate: `syn::parse_file` 3.0.9 strips a leading BOM
([pinned source](https://github.com/dtolnay/syn/blob/3.0.9/src/lib.rs)); converting its spans against
the original first line previously lost the final brace. The CLI test now checks original-byte
ranges 3..15 and 3..16 for BOM+ASCII/LF and BOM+Unicode/CRLF. No upstream bug is recorded as intended
Semctx behavior.

An external-crate query uses this helper workspace itself: run the LSP probe on `syn-probe`
`src/main.rs --line 16 --character 4 --definition-line 23 --definition-character 24`.
The pinned `syn::parse_file` dependency resolves to registry source `syn-3.0.9/src/lib.rs` at
1107:7–17. This is outside-repository diagnostic navigation, not a repository-owned declaration.

## Linux arm64 container smoke

Exact acquired images were `rust:1.98.1-slim` manifest digest
`sha256:4cd829461bd5c4d511c32e269da9cb8929223b666519d8004e35fc8d1d771ab7` and
`oven/bun:1.4.3` digest
`sha256:ec06c3b6cea04192ae6770c434f668ca41d343ad19fa6472216c7b48be39c598`.
Recorded execution used `--network none`, a read-only repository mount at `/repo`, and a
writable temporary target. The replay command below adapts that layout to the materialized
research tree at `/research`; the retained observations describe the original run.

```sh
docker run --rm --network none \
  --mount "type=bind,source=$RESEARCH,target=/research,readonly" \
  --mount "type=bind,source=$HOME/.cargo/registry,target=/usr/local/cargo/registry,readonly" \
  -e CARGO_TARGET_DIR=/target -e CARGO_NET_OFFLINE=true -w /research \
  rust@sha256:4cd829461bd5c4d511c32e269da9cb8929223b666519d8004e35fc8d1d771ab7 \
  cargo test --locked --offline --manifest-path /research/syn-probe/Cargo.toml
```

Repeat with `cargo test --locked --offline --all-features --manifest-path
/research/fixture/Cargo.toml` in the same container; `$RESEARCH` is a host path, not a container
path. Seven helper tests (including BOM)
and two fixture tests passed on Linux aarch64. WASM smoke in the pinned Bun image loaded the same
runtime/grammar and parsed pico-args without error. Use the replay T command with tool assets
mounted read-only and their path adjusted to `/tools`; `linux-tree.txt` retains version/platform.

The RA Linux arm64 asset is `rust-analyzer-aarch64-unknown-linux-gnu.gz` from release 2026-10-12,
SHA-256 `d7219d5d8f5537bb227b521157aebddfe7e4a90f4a85a74f31e53722f5691025`.
The same no-network Rust container ran its fixture SCIP command successfully, but stderr reports
missing `rust-src`; only 117 occurrences/11,750 B were exported, versus 174/16,162 B on the macOS
profile with source installed. The duplicate-ID issue persists. This demonstrates the packaging
prerequisite and partial result; it does not qualify complete Linux semantics. Full Linux LSP,
distribution packaging and native Windows remain B05.

The Linux wire artifact is retained as `results/linux-fixture.scip.gz`, uncompressed SHA-256
`289aefee2c72f5648cacb89baa06e66b1d0c0c4f1fb8e089cc7a24ebb68c3a26`.
The pinned decoder can inspect its five documents and 117 occurrences after decompression.

The original real-corpus SCIP artifact is retained compressed in `results/pico-1.scip.gz`.
Decompress then use the pinned native printer to inspect its 983 occurrences / 99,070 B:
uncompressed SHA-256 `01b4a3741ed36dfef08ceeac3a1be4906fc66c52e68a8a0ff958fe063dfb9be6`.
Unlike text recordings, both binary artifacts retain the original `project_root`; they are not a
source/result attestation.

## Current Windows reanalysis replay

The [2026-10-17 A3 record](results/reanalysis-windows-2026-10-17/README.md) contains the
completed four-engine, three-repeat function-addition series, original invocation, full
profile pins and portable validation commands. Hash the retained bytes before reading them.
This uses Node rather than the historical Bun T driver; S batch and decoder timings are
separate, and Windows SCIP association is explicitly diagnostic because native paths violate
the protocol. The earlier commands and measurements above retain their historical identity.
Captured manifests end in `.capture`, so the eight research `Cargo.toml.snapshot` inputs
remain the only manifests selected by this document's original materializer.
All current Windows `*/inputs/**` bytes are archived as data. Follow that record's
hash-check → scratch copy → controlled unpack → `--validate` sequence; do not extract
captured Rust tests or README files into this repository's active discovery surface.
