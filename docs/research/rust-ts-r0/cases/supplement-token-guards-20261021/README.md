# V3 packaging with explicit standalone Git fixture precondition

Packaging only. The archive contains all 1,906 V1 regular files byte for byte: 1,904 manifest entries plus the original manifest and freeze record. Outer `expected.json`, `baseline-authority.json`, `manifest.json` and `freeze.json` are identical copies. The original manifest SHA-256 is `58036fdf209e27bb8d37027b29afc3b8646c3671dfd9e09dfa22f0421b46f3e5`. Original observations contain 21 actual semantic Program records, 13 issuance observations, seven token revalidation observations and one retained Map identity contrast.

Custody inspection found no symbolic links, hard links, special files or outside targets. The only files intentionally absent from the original manifest are `manifest.json` and `freeze.json`; both are present in the archive and pinned by their identical outer copies. V1, V2 and their raw outputs/manifests remain untouched. No new expected behavior, native observation or obligation credit was produced.

V1 executed inside an ambient enclosing Git checkout. The baseline `createQualifiedPathEligibility` calls `git ls-files` with the fixture as its working directory, so a standalone extraction needs an explicit Git precondition. V3 runs only `git init --quiet FRESH_OUT/fixture` before the unchanged driver. It creates no commit and changes no global config. The archive, source, fixture bytes and frozen expected values are unchanged. One V3 baseline replay was performed in `C:/Users/Hokli/token-guard-v3-baseline-20261021-01`: Git init, baseline and verifier each exited 0, preserving 13 issuance, seven revalidation, one Map identity contrast and 21 actual Program records.

`v3-replay-evidence.tar.gz.b64` retains the new raw observations, exact command exits/provenance, and untouched stdout/stderr streams. Its hashes are in `index.json`; `package-pin.json` freezes the outer package. The replay provenance pins the relocated source/dependency/observer files, unchanged expected bytes and fixture Git envelope. Actual Program records retain source input bytes, options, SDK file hashes and default-library classification. Replay evidence is separate from V1 evidence.

Extract into a **nonexistent directory whose real parent already exists, outside every Git checkout**:

```powershell
node ./unpack.mjs --extract C:/temp/token-guard-v3-extracted-001
```

Extraction validates the base64/gzip/tar hashes, tar checksums, all 1,904 original manifest hashes and sizes, the two outer freeze/manifest copies, the exact regular file count and safe relative paths before writing any file. Links and special entries are refused. It does not execute baseline code. Importing `unpack.mjs` does not extract or replay.

Explicit optional reproduction into a **different fresh directory**, with outputs confined to that directory:

```powershell
node ./unpack.mjs --replay C:/temp/token-guard-v3-baseline-001 C:/Users/Hokli/.bun/bin/bun.exe
```

The reproduction validates/extracts first, relocates the original dependency aliases and passive observer import from frozen authority (the V1 runtime contained absolute paths), then runs the unchanged driver and verifier. It records `replay.stdout`, `replay.stderr`, `replay-verify.stdout`, `replay-verify.stderr` and the driver's `raw-observations.json` under that explicitly named fresh directory. The original archive and outer expectations never change. Reproduction replaces the extracted runtime paths/outputs, so its working copy is distinct from the initial hash-validated V1 extraction. Pinned runtimes: Bun 1.4.3, Node 22.23.2, TypeScript 5.9.3 and Zod 3.25.76. No installation or network is needed.
