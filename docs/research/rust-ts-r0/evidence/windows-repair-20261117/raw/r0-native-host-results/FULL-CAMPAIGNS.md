# Public native acquisition on a754

Source `a754b59bb1ffe037c5a06f35b7601bde4aae7b89`; immutable public adapter V2 manifest `c9740cb4f4d495a5461ca4b1942b60604a8d89fc790a05d2e6babb6f3de512d1`, review `6337c737e93de55f1638cbc5b73dadb289f0067505c1bc2fb08593757db24bb9`.

| Host | Original command | Supplemental command | Overall adapter |
| --- | --- | --- | --- |
| macOS ARM64 | exit 0, 132.850 s | exit 0, 327.617 s | exit 1, 523.138 s: duplicate cached semctx_gates rlib before separate as-expression query |
| Linux ARM64 | exit 0, 131.701 s | exit 0, 298.393 s | exit 1, 478.625 s: same duplicate rlib precondition |

No timeout or interruption. Source snapshots before/after remain identical. Old source96 evidence was not edited. The separate as-expression witness did not execute in either original acquisition.

Both raw original reports contain 352 PASS and two preserved NONPASS units, plus 51 PASS supports. The two unit differences are `N17c-importhelpers-es5-actual-emission::base` and `ORD-DIALECT-CAPABILITY::base`. Supplemental reports each contain 57 matching source rows plus ten retained digest-representation differences, 24 matching public rows plus one configuration-message difference, five passing digest pairs, eight passing addenda and matching token guards. These report states are not formal qualification.

## Field assessment from actual captures

The versioned V3 assessor ZIP was transferred and verified at SHA256 `cd722329884755db6d40f1334f89c3c78eb450c9ce3fb060fb347307191123b1`. Protocol `3d316de184737264a8c66afeef3bf2fe6695dbe6a26082268ea261dc1bc1a155` validates source a754. Existing raw files were mapped into host manifests without changing payloads or inventing outcomes; `source-after-finally.json` provides the unchanged postflight snapshot of the partial adapter.

- Mac assessment: exit 0, 446 RELEVANT_PASS (395 properties + 51 supports), SHA256 `553488891686c81619bad8b7189f53da5e2254d95351a9845b082a437fa8c9fc`.
- Linux assessment: exit 0, 446 RELEVANT_PASS, SHA256 `3e3fd508acb3896ea06a9c1c52e32e725510546b0ae68b6e0aca0b6227bc7da2`.

Both preserve raw differences and report qualification_credit 0 and R0 null. No `--require-both` claim was made from a one-host execution; the two independent assessments are retained separately.

Local captures: `full-macos-a754/` and `full-linux-a754/` contain command receipts, top-level captured inputs, public reports and outer-supervisor logs. Full raw subtrees remain on their native hosts at the original locations. The tar exports contain 85 and 84 public files respectively.

## Separate as-expression setup recovery

The reviewed standalone package manifest `16b395f6158b1f3dd24115036b6e3fa6e581ebd38a1249ad53e4375e5d49e0fd` was run once on Mac using the original frozen fixture SHA256 `3e126183af100c772b3d8666ac1e5c5e22ae8623d0e9b82ace227e0f6c79cbf0`. It stopped before native queries because offline unfiltered Cargo metadata requested uncached Windows dependency `windows-link 0.2.1`. Exit 1, 3.285 s; postflight true. Original/supplemental campaigns were not rerun.

This setup failure and the original duplicate-rlib failures remain preserved. No failed attempt is reclassified as success. A reviewed host-specific Cargo metadata fix or complete cache is needed for the standalone Unix witness.

## Completed standalone recovery

The Mac gates Cargo cache was completed with `cargo fetch --locked`, exit 0. Its Cargo.lock hash stayed `d7c34e58e5bb2e5a0da55fad216b90a0eba6c6b612224be80a6e469ffe455277`; subsequent `cargo metadata --locked --offline` passed. Linux metadata was already available offline; its container network remains disabled and no cache copy was required.

The same approved standalone package then completed the two frozen as-expression contexts on the existing fixture, without rerunning either complete campaign:

- Mac recovery2: exit 0 in 11.989 s; report SHA256 `b16d01c3f6d1aeb2afca164ef4a4a9a19347cd07ce32b0bc6e33af250ff359d0`.
- Linux recovery: exit 0 in 7.243 s; report SHA256 `6ac4204b70392e7f72203933fc1dd661604dad4830f0d9e829817ceee00dc816`.

Each reports two successful contexts, legacy zero canonical calls and retained one canonical call, identical source/input/tool pins and successful postflight. These remain finite public observations with qualification credit 0 and R0 null.
