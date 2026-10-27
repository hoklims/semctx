# Portable C1 pass2 DEV evidence

Current public C1 evidence custody is superseded by the [21 October restoration](../../../evidence/README.md). Earlier local-only statements below describe the 20 October checkpoint.

This archive preserves textual DEV observations, source snapshots and historical
verification attempts. Reports are copied byte for byte. The path map binds each
original absolute path to its safe relative archive member, byte count and SHA256.
The frozen 44-file source snapshot is checked against the original source manifest.
The SDK capture is included as text; the two native executables and Cargo build
outputs are deliberately omitted. Their original identities remain in FREEZE.json.
Rebuilding needs the pinned toolchain and dependencies. This is not an offline
toolchain or binary distribution.

The historical TypeScript baseline package tar is represented by its extracted
UTF-8 regular-file members. The map retains the original tar identity and each
source archive member. Symlinks and unsafe members are never followed or extracted.

The raw records include unsuccessful and intermediate attempts. A filename containing
"green" does not establish success: use the recorded command outcome and report
limits. This publication does not reinterpret failed campaigns, repair expectations,
or grant qualification. Its DEV evidence was produced on macOS ARM64. It does not
prove native Windows/Linux behavior, full supervision, R0 or READY_TS_NATIVE.
Qualification campaigns are published separately.

The four verify-integrated-p2-N-generated.log streams are explicitly pending root
finalization and are absent. Earlier integrated hygiene and plugin-parity failures,
the missing-prerequisite diagnostics, exact dependency pin records, and native
plugin regeneration logs are preserved. No result is inferred for pending runs.

No reserved corpus was inspected or included. No producer, oracle, expected value,
tracked repository file or Git index was modified by this publication task.

The historical base64 payload has moved out of Git. The [local index](../../../evidence/archive-index.json)
retains its identity and citants; the bytes remain only on the owner’s Mac under
the 20 October 16:39 decision. See the [local access guide](../../../evidence/README.md).
From the repository root, restore this archive into a new directory and inspect it:

```sh
python3 tools/rust-ts-r0/qualification/fetch_evidence.py \
  --source-dir "$HOME/semctx-evidence/t00/20261020" \
  --archive selection--pass2--portable-dev--portable-dev \
  --output /tmp/semctx-t00-portable-dev

tar -tzf /tmp/semctx-t00-portable-dev/selection--pass2--portable-dev--portable-dev.tar.gz
```

Archive members are regular files with relative names; deterministic tar metadata
and gzip mtime=0 make the payload reproducible. Compare decoded archive SHA256 with
record.json before extraction. original-path-aliases.json and this README are also
included inside the archive.
