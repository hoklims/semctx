# Current native T00 evidence: source 96fedbbe

The macOS ARM64 and Linux ARM64 executions used source
`96fedbbe14e8585ae1c89e2656604bf5ecabf2c3`. Each assessment contains 395 property
rows and 51 support rows classified `RELEVANT_PASS`. Each preserves five raw
`NONPASS` comparisons across four rows with their scoped dispositions. Frozen
expectations and historical results remain unchanged.

This packet also contains the 38-phase public regression and two separate
public method invocations. The unchanged old reader accepts the method witness;
it is not evidence of an old-reader failure.

The separate [additional public manifest](additional-public/additional-publication-manifest.json)
stores the named-default invocation on both hosts and the two-context
`as`-expression witness on both hosts. All six additional phases passed their
independently frozen readers. The named-default witness reproduces the old
reader's refusal while its canonical call target remains correct. The
`as`-expression witness compares the same source and compiler inputs with only
the retained snapshot context changed. Its legacy graph has no call; its
retained graph contains the expected caller-to-helper edge. The additional
manifest preserves both original raw archives per witness and their frozen
reference, expectation and reader bytes. These are finite public observations,
with no qualification credit of their own.

**Formal qualification remains 0/240 and R0 is unset.** Windows, the completed
old exposed regression, the fresh reserved execution, final property adequacy,
canonical proof admission and exact delivery-head CI remain separate gates.
An assessed field alone does not qualify an obligation or establish general
compiler equivalence. A later documentary head cannot replace the actual native
source identity in these records.

## Byte identities and storage

The native protocol is
`309fbbd74141eaa0d383f340247802cd283c892a6048902adaf29e9e6c18c4c3`;
the Windows protocol is
`7fca4576486e69bc1bc16b062099152c6c763444267f4f3f45da4f65c73769f8`.
Their frozen packages and receipts are under `protocol/`.

[publication-storage-index.json](publication-storage-index.json) records every
asset's codec, encoded and decoded digests, and sizes. Its SHA256 is
`a5d91d14286d3471c74bbcfd3a04527db04b725cd60eca30bf7fd9521b57d146`.
Large JSON documents and original CRLF evidence use lossless gzip storage. Every decoded byte
stream was read back and matched its original digest; all other payloads are
exact copies. The listed original payload falls from 266,972,069 to 147,096,198 bytes.
Storage conversion changes no observed value or qualification outcome.

The original assembly manifest is
[assembly-manifest.original.json](assembly-manifest.original.json). Its original
uncompressed assembly proposal is retained under `assembly-preparation/`;
the storage index maps logical paths to actual published assets.
[publication-location-map.json](publication-location-map.json) retains workspace
locations. Paths inside receipts keep their original meaning and bytes.

The Mac assessment was acquired separately and is **not in its raw archive**.
Its compressed original and independent transfer receipt are under
`macos-custody/`. Linux assessment, transport, host and driver evidence are under
`linux-custody/`. The two compact archives in `preparation/` retain the 29
prepared metadata files per OS, pinned by the preparation summary.

Inspect a compressed asset with the standard gzip library and verify its decoded
SHA256 against the storage index. For example, from this directory:

```text
python -c "import gzip,hashlib,json,pathlib; b=gzip.decompress(pathlib.Path('macos-custody/assessment-macos.native.json.gz').read_bytes()); assert hashlib.sha256(b).hexdigest()=='f07710107109f559681c14bcbe3b7b742d748a329c094192ca0ce5e2d17e7380'; print(json.loads(b)['counts'])"
```

The source-selection record and draft ledger retain their original limited
scope. The 17 reference-only identity/primitive supports establish their frozen
transformations, not native identity, input consumption or receiver refusal.
Those claims require separate native carriers.

The separate [finite execution review index](execution-review/index.json) binds
all native raw-reference authentication and the disjoint property reviews. The
lead accepted 394 finite Mac/Linux selections there. The later independently
frozen `as`-expression contrast closes the remaining two-host selection with a
separate source-owner correction in
`source-selection/current-source-mechanisms.root-v2.json.gz` (decoded SHA256
`1ed202376cc7b2ae1a2b28e78e1476e26712aa9f0332eecc2ffc462eb931c09c`).
It selects ordinary call extraction and conditional wrapper unwrapping for
property `(221,1)`; the original SDK-reason selection is retained as uncredited
history. Windows and all terminal gates remain pending.

## Verify the complete portable captures

The original capture tool used for the recorded pack and verify runs is retained
as `capture-tool/original-capture_pack.py.source`, SHA256
`07b7dbedaa22cdc06afd28be7f9896f9c87ba7eebeaad4a7ca690738098b91ec`.
The maintained executable copy changes only an unused pack-loop binding from
`key` to `_key`, satisfying the repository lint rule. Its SHA256 is
`af4cce48f3d318d2ffe67b55d49ebed030f0d41682aff0e00162662b0d2f2e38`;
verification and extraction code are unchanged. Its existing 16 controls ran:
15 passed and the native-Linux extraction positive was skipped on Windows.
Frozen baseline and reader snapshots elsewhere in the packet retain their exact
bytes as `.source` archival data; they are not edited to satisfy live-code lint.

```text
python capture-tool/capture_pack.py verify --package macos --manifest-sha256 0f05602549bc7cf5c8f20f7f3d0821e757ed54fd56fe222e6ee362a96c5e3a76
python capture-tool/capture_pack.py verify --package linux --manifest-sha256 c17d70ec53a3d5d1510067a89cd161047bef832c0e5081e16438ced23cb449e7
```

The actual pack and verify commands exited zero for both packages. Their output
is retained in the lead's tool history; separate raw process logs were not
recorded and are not invented by the portable index.

| Capture | Exact uncompressed TAR SHA256 | Bytes |
| --- | --- | ---: |
| macOS | `d00122da6e3af7277454b25b62db8a88bac280dbb6aa68e27fe28fdab0687b48` | 1,213,265,920 |
| Linux | `c535e68e5c10d0ec960e354bdcbf9503f8ae28962f6bcf93801589533bd0e07f` | 1,240,176,640 |

Verification streams the complete TAR identity without writing a TAR. The tool's
`restore-tar` command can write an exact TAR into a new output using the same
package and external manifest pin; it cannot reconstruct the original gzip
bitstream. Intentional unsafe fixture links remain **archive data**. Full native
extraction is refused. No native tree restoration or offline reassessment from
this portable layout is claimed.
