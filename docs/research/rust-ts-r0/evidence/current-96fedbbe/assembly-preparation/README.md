# Public T00 captures at source 96fedbbe

The native source is `96fedbbe14e8585ae1c89e2656604bf5ecabf2c3`. The native
evaluator protocol SHA256 is
`309fbbd74141eaa0d383f340247802cd283c892a6048902adaf29e9e6c18c4c3`;
the Windows evaluator protocol SHA256 is
`7fca4576486e69bc1bc16b062099152c6c763444267f4f3f45da4f65c73769f8`.
These are observed source/evaluator identities, not a later documentary commit.

The Mac and Linux reports each contain 395 property rows and 51 support rows
classified `RELEVANT_PASS`. Five raw `NONPASS` comparisons across four rows per
OS remain preserved under individually scoped arbitrations. The public
regression contains 38 actual phases; a separate public method witness contains
two actual invocations. Original expectations and historical outcomes are intact.

Formal credit remains **0/240**, with **R0 unset**. This packet does not supply
Windows native execution, completed old reserved regression, fresh sealed
reserved execution, root execution adequacy, canonical aggregate proof admission
or exact delivery-head CI. No absence/ownership/admission authority follows from
empty component lists or aggregate row classifications.

## Exact public assembly

The externally pinned `assembly-manifest.json` is a finite list of original
workspace-relative sources, publication destinations, SHA256 values and sizes.
`assemble.py` requires an explicit source root and a **new** output directory.
It validates every source before creating output, refuses aliases and paths
outside the literal public allowlist, opens destination files without overwrite,
and reads copied bytes back. It neither follows receipt references nor extracts
archives. A later copy failure retains the partial output as failure evidence.

The lead runs the reviewed scratch script, substituting the independently read
SHA256 of `assembly-manifest.json` and an approved new destination:

```text
python assemble.py --source-root C:/Users/Hokli/Documents/Codex/2026-10-21/re --manifest assembly-manifest.json --manifest-sha256 EXTERNAL_ASSEMBLY_MANIFEST_SHA256 --output NEW_OUTPUT_DIRECTORY --validate-only
python assemble.py --source-root C:/Users/Hokli/Documents/Codex/2026-10-21/re --manifest assembly-manifest.json --manifest-sha256 EXTERNAL_ASSEMBLY_MANIFEST_SHA256 --output NEW_OUTPUT_DIRECTORY
```

The validator creates no output tree. The copy also retains the exact input
manifest as `assembly-manifest.json`; its bytes are additional to the listed
payload total. `publication-location-map.json` maps published files to their
original workspace paths. Paths inside copied receipts retain their original
meaning and bytes. This is not an automatic resolver for every historical/native
path referenced in those receipts.

## Verify the portable Mac and Linux captures

From this published directory, use the unchanged included capture tool. The
external manifest digests below identify the two current compressed manifests:

```text
python capture-tool/capture_pack.py verify --package macos --manifest-sha256 0f05602549bc7cf5c8f20f7f3d0821e757ed54fd56fe222e6ee362a96c5e3a76
python capture-tool/capture_pack.py verify --package linux --manifest-sha256 c17d70ec53a3d5d1510067a89cd161047bef832c0e5081e16438ced23cb449e7
```

Each package has three segments no larger than 24,000,000 bytes. Verification
streams compressed/raw blob checks and the exact uncompressed TAR identity. It
does not write a TAR, reproduce the original gzip bitstream, materialize a native
filesystem or rerun the assessor.

| Capture | Exact uncompressed TAR SHA256 | Bytes |
| --- | --- | ---: |
| macOS | `d00122da6e3af7277454b25b62db8a88bac280dbb6aa68e27fe28fdab0687b48` | 1,213,265,920 |
| Linux | `c535e68e5c10d0ec960e354bdcbf9503f8ae28962f6bcf93801589533bd0e07f` | 1,240,176,640 |

For a byte-exact TAR file, the same tool accepts `restore-tar --package macos`
or `--package linux`, the corresponding `--manifest-sha256` above, and a new
`--output NEW_TAR_PATH`. Allow the TAR sizes shown in the table. The captures
contain intentional unsafe fixture links, preserved **as archive data**. Their
policy is **exact TAR restoration only**; full native extraction is refused.
No full native tree restoration or offline reassessment from these packages was
performed or claimed during preparation.

## Custody and evidence boundaries

The Mac assessment was acquired separately from its raw source archive. Keep
`macos-custody/assessment-macos.native.json` with its exact SCP custody receipt;
do not claim that the raw archive contains it. Linux assessment/transport/host
and driver receipts remain under `linux-custody/`.

The two compact `preparation/prepared-{macos,linux}.tar.gz` archives retain their
29 metadata files per OS, including original public plans; those large expanded
plans are not redundantly copied beside the archives. The preparation summary
pins each archive and its member identities. Archives are copied as opaque
public bytes and are not extracted by this assembly.

The root draft ledger and source-selection record remain drafts/limited source
evidence; no terminal verdict is generated by the assembly. Pack/verify exit0
results recorded by the portable index originate in the lead's actual tool
history. Separate raw process receipts for those commands do not exist and were
not invented. This preparation only adds byte joins and a reproducible copy plan.
