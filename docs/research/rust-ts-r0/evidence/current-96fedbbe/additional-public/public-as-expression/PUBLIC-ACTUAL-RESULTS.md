# Actual public as-expression contrast

The separately frozen witness was executed once per context on each native
source-96 host, after root metadata GO and distinct root query GO. The original
23-file manifest, source, oracle, TypeScript reference, reader and frozen
controllers remain unchanged.

| Host | Legacy canonical calls | Retained canonical calls | Actual phases | Final stability |
| --- | --- | --- | ---: | --- |
| macOS ARM64 | `[]` | `entry.ts/caller -> entry.ts/helper`, line 2 | 2 | PASS |
| Linux ARM64 | `[]` | `entry.ts/caller -> entry.ts/helper`, line 2 | 2 | PASS |

All four calls exited zero, with the same source syntax Call at UTF16
`[73,101]`. Every context ran once, with a 20-second deadline and an 8-MiB cap
per output stream. There was no retry or build. Final postflight succeeded on
both hosts. Linux's 12 Docker APIs ran under its own live wake assertion, which
was stopped afterward; no other wake process was stopped.

`PUBLIC-ACTUAL-TWO-HOST.json` is the actual aggregate, SHA256
`28900fe0403632cd4aeac0fd56f21a8211ffa9cb0e9069820cdb8e2c5b23c18a`.
The independent local adjudicator verified all 124 regular files in each raw
archive against its export receipt, including the original requests, source,
100 SDK files, one-shot claim, process outcomes, raw streams, adjudications and
input bindings. Each context's 113 process pins match before and after.

The local reader rechecked both captured stdout streams per host against their
own frozen request and exact independent oracle. Their actual canonical call
projections match the reference contrast. Convenience copies of those four
unchanged stdout streams are under `actual-result/`; the original archives and
receipts are under `staging-v1/`.

- Mac archive: SHA256
  `9df302865a8d74e1ea5dd7b89ec4a8a35fc1367acfa0c56bf4c9deb554d73210`,
  938,752 bytes.
- Linux archive: SHA256
  `d55d514a6c73cede3fc693b4c607e288da1f7befbe183d5a0ac7144e5fb76d51`,
  931,001 bytes.

This establishes the finite two-context extraction contrast relevant to public
property `(221,1)`. It does not itself award qualification or decide R0. Empty
legacy calls remain scoped to this exact source and context. The original
354-unit corpus, 395 properties, 51 supports, all historical outcomes and private
inputs were unchanged. The original README remains the immutable prequery
preparation record; this page supplies the later actual execution checkpoint.
