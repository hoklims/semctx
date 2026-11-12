# Public workspace supplement — 2026-10-22

Author: `/root/public_workspace_boundaries`. This supplement preserves three newly
constructed public fixture worlds. The independent oracle invokes the historical
`workspaceLinkedSystem` and `inspectModuleConfiguration` with TypeScript 5.9.3.
The frozen native producer consumes captured inputs through its existing System
and configured-resolution observation surfaces. No frozen source, producer,
observer, helper, recipe, contract or runner changed.

`workspace-results.json` inventories exact evidence files and SHA256 hashes.
`workspace-macos.json` and `workspace-linux.json` preserve complete oracle output,
requests, native output and comparison results. Physical fixture paths differ by
platform; each request uses the exact paths independently materialized there.
The input fixture specification is `workspace-inputs.json`.

The above-repository case supplies an existing enclosing workspace declaration and
member configuration outside the analyzed repository. A `.git` marker and a
workspace dependency declaration are present inside the repository. Its four
operations return absent file, absent read, absent directory and unchanged
realpath. The native alias map is empty, no successful reported read crosses the
root, and the historical resolver records no successful outside-root input. The
uninstalled fixture provides a positive workspace-link control with exact consumed
bytes, digest and successful reported read binding.

The installed fixture reads installed invalid-module bytes and emits diagnostic
6046. Its full owning diagnostic differs on both platforms: TypeScript includes
`none`, `amd`, `system` and `umd` among the allowed module values; the frozen
native producer omits them. This comparison remains NONPASS. The comparison does
not strip the message or reduce it to a diagnostic code.

Reproduce with a fresh output directory and fixture world. The scripts fail on
existing output/world directories to preserve prior evidence:

```sh
bun tools/rust-ts-r0/qualification/public-closure-20261022/workspace-oracle.mjs \
  BASELINE_ROOT \
  docs/research/rust-ts-r0/qualification/public-closure-20261022/workspace-inputs.json \
  ORACLE_JSON FRESH_WORLD
python3 tools/rust-ts-r0/qualification/public-closure-20261022/workspace-replay.py \
  ORACLE_JSON FREEZE_JSON FRESH_NATIVE_OUTPUT
```

macOS execution used baseline
`/Users/sebastien/semctx-evidence/t00/20261022/suite-a`, freeze
`/Users/sebastien/semctx-evidence/t00/20261022/campaign-v2-macos/t00-original-campaign/freeze.json`,
and evidence root
`/Users/sebastien/semctx-evidence/t00/20261022/public-closure/workspace`.
Native outputs are `replay-macos-v3`; oracle is `oracle-macos.json`.

Linux execution used existing container `semctx-t00-oct20-linux-v1` with networking
disabled; Bun
`/work/evidence/qualification-20261022/runner-runtime/bun`, baseline
`/work/evidence/qualification-20261022/public-closure/linux-oracle-baseline`,
`--tsconfig-override BASELINE_ROOT/tsconfig.json`, freeze
`/work/evidence/qualification-20261022/campaign-v2-linux/t00-original-campaign/freeze.json`,
and evidence root `/work/evidence/qualification-20261022/public-closure/workspace`.
Native outputs are `replay-linux-v3`; oracle is `oracle-linux.json`. A local copy is
under the macOS evidence root's `linux` directory.

Checks exercise macOS ARM64 and Linux ARM64 only. Windows, reserved cases, remote
CI, complete System equivalence, filesystem sandboxing, public admission and
formal R0 qualification are outside this supplement. No comments were added.

The final replay rejects empty or duplicate units and incomplete query expectations before executing. Configuration observations also require exact SDK identity and executed/supported outer and component contexts. The ordinary regression tests are in `scripts/t00-public-workspace.test.ts`.
