# Windows V3 transport preparation and actual harmless DEV evidence

Proposed destination:
`docs/research/rust-ts-r0/evidence/current-96fedbbe/windows-driver-preparation/`.
This preparation adds no Windows candidate execution, qualification or canonical
admission. Native campaign source `96fedbbe…` remains distinct from the reviewed
transport V3 freeze `bef289a7…` and actual root harmless DEV receipt `db104b4e…`.

`publication-manifest.json` is a **closed list of exactly 69 public support
files** requested by the lead. It includes the V3 draft freeze, delta and controls,
red/green evidence, test/caller/freezer sources, original peer reports, root
adoption, root DEV driver, aggregate and input pins, compile/wrong-pin receipts,
and all five named controls' receipts, streams, specs and four-file captures.
No executable EXE, RLIB cache or unlisted recursively referenced source is copied.
Existing packet publishers and indexes remain untouched.

The actual root DEV record binds a successful caller compilation, five actual
process controls and a wrong-pin pre-execution refusal. Only the success control
is accepted by its adjudicator. Nonzero exit, malformed UTF-8, output-cap excess
and timeout are refused as expected. The separate wrong-pin invocation exits 1
without creating its capture directory. This packet preserves the existing
observations; preparing or reading it reruns none of those controls.

The peer JSON/Markdown reports retain their original verdicts and temporal
limitations. In particular, a peer's earlier `PROOF_WEAK` result is not rewritten
or upgraded by the later root DEV evidence. The final aggregate reviewer must
join these distinct records and apply the actual delivery contract.

## Capture representation matters

The compatibility filename `stdout.raw` does **not** imply byte-exact original
process output for malformed or truncated streams. The V3 capture explicitly
stores bounded UTF-8 strings produced by `String::from_utf8_lossy`.

For `invalid-utf8`, the process outcome preserves original `stdout_bytes = 1`
and SHA256 `a8100ae6aa1940d0b663bb31cd466142ebbdbd5187131b92d93818987832eb89`,
which is the digest of original byte **FF**. Its stored capture is instead the
three-byte UTF-8 replacement character **EF BF BD**. This preparation preserves
those three stored bytes and their separate digest; it never claims to recover
or store the original FF stream. The adjudicator refuses the size/capture
mismatch. Over-cap captures likewise retain their bounded representation and
their distinct original read counts/hashes.

The manifest records both publication storage hashes and decoded source-file
hashes. Gzip decoding yields the original **evidence file bytes**, including
their stated capture limitations, not an inferred original process stream.

## Storage and reproducible assembly

Frozen Python and Rust sources have identity storage and `.source` filenames, so
formatters or lint collectors will not alter archived bytes. JSON and archived
stdout/stderr/capture files use lossless gzip with level 9, empty gzip filename
and mtime zero. Already compressed archives would be refused for recompression;
none belongs to this packet. Source JSON values and original raw evidence are
never rewritten.

After reviewing the manifest and helper, the lead may run:

```text
python assemble.py --source-root C:/Users/Hokli/Documents/Codex/2026-10-21/re --manifest publication-manifest.json --manifest-sha256 EXTERNAL_MANIFEST_SHA256 --output NEW_DIRECTORY --validate-only
python assemble.py --source-root C:/Users/Hokli/Documents/Codex/2026-10-21/re --manifest publication-manifest.json --manifest-sha256 EXTERNAL_MANIFEST_SHA256 --output NEW_DIRECTORY
```

The helper validates every source, destination, codec and hash against its literal
allowlist before creating output. Existing output and aliases are refused.
Writes use exclusive creation, followed by stored and decoded hash readback.
The input manifest is retained under the helper's inherited metadata filename
`additional-publication-manifest.json`. A failed copy retains partial output for
inspection. The helper executes no archived Python/Rust program or native binary.

The scratch `check.py` exercises validation-only, a small local copy/readback,
existing-output preservation, wrong-pin refusal and off-allowlist refusal. It
does not rerun the historical root DEV transport or create any repository file.
No proof admission or formal qualification follows from these byte-storage checks.
