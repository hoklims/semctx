# Portable finite-field assessor v2

This package freezes 395 property selections and 51 support scopes independently
of final host outcomes. The deduplicated map contains 590 unique check definitions
and is approximately 320 KB compressed. It includes no host raw captures or report PASS
observations. No qualification credit or R0 decision is issued.

## Run

```text
python -B poison_controls.py
python -B check_protocol.py --repo /path/to/semctx --source-head FINAL_COMMITTED_HEAD --protocol-sha256 PRE_QUERY_SCOPE_MAP_SHA256
python -B assess_final.py --repo /path/to/semctx --manifest /path/to/hosts.json --protocol-sha256 PRE_QUERY_SCOPE_MAP_SHA256 --require-both --output /path/to/assessment.json
```

Python3.11+ and Git are required. Node is required only for the frozen public
graph projection. This executes local projection code on existing facts; it
does not launch a native candidate. Bundled6046/digest helpers are fixed evaluator code. Candidate projection code is read from the
manifest's exact Git HEAD in the supplied repository. Its bytes must match the
pre-outcome verifier-source pins in the scope map; foreign or changed verifier
code is rejected. The output retains each code pin.

The expected scope-map SHA256 must be supplied independently through the flag
or the manifest's `evaluation_protocol_sha256`. It must have been recorded
before native queries. `package-manifest.json` records bundle-relative file hashes;
the enclosing ZIP SHA256 binds the complete published evaluator. Source pins are
content hashes, so integrating and committing this package introduces no Git HEAD
cycle. The final candidate's Git blobs must equal those pre-query content hashes.
`check_protocol.py` performs this source/corpus preflight without host reports.

All frozen corpus files and the complete original/support/source recipe inputs
and checks are pinned independently of exported host recipes. Provenance-only
`manifest_sha256` values may change. The newly explicit `expected_error` field is
excluded only for `snapshot_boundary_cli`, where the complete expected message
is read directly from the pinned frozen case. Other input or check changes fail.

The host manifest uses the final join shape, with one `raw_root` per host. Every
document or artifact has explicit `path` and `sha256`. Relative paths resolve
against the manifest directory. `raw_root` points to an exported/extracted host
campaign root containing `original-evidence`, `original-recipes` and `evidence`.
Provide `legacy_identity_inputs` as an explicit pin when legacy identity cases
are assessed. No execution host or project directory is inferred from this
package. Use `--cache-dir` to place immutable Git projection copies elsewhere.

Each host provides:

- `original`: report, freeze and recipes pins.
- `supplement`: report, fixture, registry, addenda and plan pins, plus evidence_root.
- `source`: before and after pins.
- `build_receipts`: exact successful build-command pins.
- `artifact_files`: actual artifact, helper, SDK and qualification_observer pins.
- `raw_root` and optional `legacy_identity_inputs` pin.
- `token_family` pin for the enabled, independently frozen 21-control plan.
- `native_compiler_identity` with `receipt`, `core`, and `build_environment` pins.

Build environment receipts include the exact source epoch, unchanged safe
environment snapshots, the absent version override, actual build argv, complete
stdout/stderr and receipt hashes, plus each frozen artifact. Export those raw
build streams beside the campaign root. Compiler identity checks every emitted
TypeScript/JavaScript capability scope against actual native 7.1, preserving the
original 5.9.3 comparisons and ARB004.

`expected_source_head` is a single exact40hex SHA shared by both hosts. The
`--require-both` guard rejects a single-host manifest. Tests can inspect one host
without that option, while preserving missing-host proof as a limitation.

## Scope and remaining gaps

The scorer distinguishes RELEVANT_PASS, NONPASS and GAP per coordinate. It reads
actual stdout/stderr bytes and hashes, complete requests, SDK/source read bytes,
artifact identities, and typed consumer fields. Report PASS flags are not used
as acceptance evidence. Whole-projection mismatches remain alongside narrowly
reviewed namespace, ownership, parallelism,6046 and digest-relation dispositions.

The full frozen snapshot error text is required. Historical code-only stderr
does not satisfy it. A successful valid-capture node control does not waive that
message difference. UTF16LE parser-code1127 versus1490 remains a real mismatch.

Strict adapters exist for all formerly missing families. Token controls require
the complete raw native process, exact frozen plan and actual Rust token rows,
joined to native ownership graphs/configuration phases and successful source/SDK
reads. Its qualified native transport profile requests ownership observation;
it confers no application admission or qualification. Full public Verify reads
all three native profiles, process/Git/discovery/physical-read captures, actual
stored graph/batch and the pinned Rust consumer projection. Missing captures
remain GAP. The two identity supports independently recompute the three actual
batch identities and join the receiver's rejection; no report PASS is consumed.
Mandatory native frames require `native_c1` to be the boolean true and the exact
artifact, mode, request-file and SDK argv. An admitted flow removing base lines
also requires its actual base native frame, with base files reconstructed from
captured Git HEAD ls-tree/show outcomes. Current bytes cannot substitute that base.

Source scopes were reviewed against baseline3e94997f and native2e97f5d0. A newer
candidate requires acceptance of its source delta. The pure poison controls are
self-contained; they do not replace the independent proof-mechanism audit or
the actual-host family controls. Root integration into qualification tooling,
registration of all final token-family expectations and the independent audit
must precede the final native campaign.

Historical Mac 2e97 replay with its separately pinned evaluator produces 429
RELEVANT_PASS, 14 GAP, and 3 NONPASS. Those figures describe required selected
fields only. The additional 13 unobserved physical System reads occur outside
the selected 395 comparisons and retain their own raw failure evidence. A package
pinned to newer verifier code intentionally rejects the older candidate blobs.
