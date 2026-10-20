# Local T00 evidence

The owner’s 20 October 16:39 decision selects `LOCAL_ONLY_OWNER_CUSTODY`: the evidence
stays on this Mac. The cleanup commit and normal push are authorized; no GitHub
release, tag or upload to any hosting is authorized. The previous hosting proposal
is rejected rather than pending. The [owner record](../resumption/owner-execution-and-custody-20261020.json)
retains that supersession and the unchanged existing-input/local-first case rules.

[archive-index.json](archive-index.json) maps original repository paths to decoded
`.tar.gz` identities, byte sizes, local filenames and literal citants observed at
source commit `dec0bd9522d0672e6f58fb539a83356716af4e0c`. The citation census is not
an exhaustive semantic dependency graph. The entries, hashes, members and citants
remain the relocation identities, independently of the custody policy metadata.

The owner’s local directory is `/Users/sebastien/semctx-evidence/t00/20261020`.
Its 35 decoded archives and `composition2-records.tar.gz` account for 36 indexed
files; the latter’s 38 members retain the historical C2 registrations, freezes,
reports, manifests and README. `SHA256SUMS` and the backup manifest accompany the
local copies. The index records expected bytes; availability still requires
access to that exact local directory and successful verification.

Historical JSON records and claim audits keep their original paths and hashes.
For a removed archive, look up `original_path` in the index. For a removed C2
nonarchive document, use its original path in the `composition2-records` entry’s
member list. Those coordinates identify historical evidence rather than current
Git files. Qualification archives remain in Git, including the reproduction
archive consumed by `prepare_recipes.py`. The [C2 summary](../composition2/README.md)
and [historical final dossier](../final/README.md) retain their result limits.

From the repository root, verify the local copies without creating an output:

```sh
python3 tools/rust-ts-r0/qualification/fetch_evidence.py \
  --source-dir /Users/sebastien/semctx-evidence/t00/20261020 \
  --verify
```

Or copy them into a new directory, retaining `.tar.gz` form:

```sh
python3 tools/rust-ts-r0/qualification/fetch_evidence.py \
  --source-dir /Users/sebastien/semctx-evidence/t00/20261020 \
  --output /tmp/semctx-t00-evidence-copy
```

`SEMCTX_T00_EVIDENCE_DIRECTORY` can supply the source directory instead of
`--source-dir`. Repeat `--archive <id>` to select entries; the default is all 36.
The helper verifies size and SHA256, does not extract archives and refuses an
existing output directory. Files are placed individually after verification;
a later failure can leave earlier verified copies, so the batch is not atomic.
No download URL or network transport is configured. A reader without access to
the owner’s Mac does not obtain these payloads from the repository or CI.

These checks establish copied byte identities, not archive completeness, replay,
source-to-binary attestation, byte-identical rebuilds or semantic qualification.
Relocation changes no case, result, counter or R0 decision. This local custody
provides no guarantee of retention period, redundant backup, CI/third-party
availability or recovery after loss of this Mac.
