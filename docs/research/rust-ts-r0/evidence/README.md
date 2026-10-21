# T00 evidence restored for review

The owner's [21 October decision](../resumption/owner-evidence-publication-20261021.json)
supersedes local-only custody for public C1 evidence. Historical custody records retain
their original scope. The reserved corpus remains private and blind.

[archive-index.json](archive-index.json) lists 33 repository archives: 30 restored
historical archives at their exact original `.tar.gz.b64` paths, plus three bundles
of the 20 October unit-extraction campaigns and their historical runner. The restored
bytes match both the local backup's `SHA256SUMS` and the pre-cleanup Git objects.
[SHA256SUMS](SHA256SUMS) lists decoded archive identities; the index additionally records
sizes, original encoded identities and historical citations. Citations are a literal
census at the recorded source commit, not a semantic dependency graph.

The six abandoned C2 entries remain in `excluded_entries` for historical lookup and are
not restored. C1 recipe preparation uses the retained qualification reproduction archive;
the current campaign runner uses `resumption--gap-legacy-identity-evidence`. Neither
requires the abandoned C2 producer or replays. Existing qualification archives remain
at their original paths and are outside this relocation index.

Verify the repository payloads from any checkout location:

```sh
python3 tools/rust-ts-r0/qualification/fetch_evidence.py --verify
```

Copy verified decoded archives into a fresh directory, without extracting members:

```sh
python3 tools/rust-ts-r0/qualification/fetch_evidence.py --output /tmp/semctx-t00-evidence-copy
(cd /tmp/semctx-t00-evidence-copy && shasum -a 256 -c "$OLDPWD/docs/research/rust-ts-r0/evidence/SHA256SUMS")
```

Repeat `--archive <id>` to select archives; the default is all 33 repository entries.
`--source-dir` and `SEMCTX_T00_EVIDENCE_DIRECTORY` retain compatibility with decoded
local copies and override repository sourcing. A partial local backup may lack the
three newly bundled campaign archives; select IDs or copy those bundles first.
The helper checks decoded size and SHA256 and refuses malformed base64, missing files,
unknown selections and existing output directories. Each copy is published separately;
a later failure can leave earlier verified copies. The batch is not atomic.

[reproduction-20261021.md](reproduction-20261021.md) provides the command index and
qualification-state pointers. [reproduction-20261021.json](reproduction-20261021.json)
binds historical source heads, producer/helper/fixture/observer hashes, SDK 5.9.3,
environments and results. The two campaign `*-members.json` files enumerate the selected
raw evidence and frozen binaries. Generated workspace/compiler/implementation copies
are omitted; complete expanded campaign directories remain on the owner’s Mac.

Byte checks establish archive identities, not successful replay, source-to-binary
attestation, retention guarantees or formal qualification. Historical campaigns are
not evidence of execution of the new review head. Formal credit remains **0/240**,
reserved execution **0/26**, and the current R0 decision remains unset.
