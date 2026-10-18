# T00 qualification observer under correction

These sources continue the historical C1 v2 observer in the same T00 experiment.
The [registration](../../../docs/research/rust-ts-r0/resumption/correction-pass1-registration.json)
and [current mapping progress](../../../docs/research/rust-ts-r0/resumption/gap-mapping-progress.json)
identify the first additional correction pass. The original v1/v2 sources and
immutable predecessor recipes remain in the [reproduction archive](../../../docs/research/rust-ts-r0/qualification/reproduction/README.md).
The two auxiliary JSON maps are copied byte for byte from v2. Their original
absolute paths are provenance, not required filesystem locations: the generator
checks canonical repository inputs and the packaged predecessor against the
original audit digests.

Prepare new recipes without replacing an existing output directory:

    python tools/rust-ts-r0/qualification/prepare_recipes.py --output <fresh-absolute-directory>
    python -m unittest discover -s tools/rust-ts-r0/qualification -p test_prepare_recipes.py

The Python tests exercise the CLI, output collisions, a dangling symlink and a
relocated checkout with reads of the original author paths forbidden. The frozen
expectations remain the source of expected values. The current remaining GAP inventory is recorded in the linked mapping progress;
preparing recipes does not qualify them.

Build and exercise the observer with the pinned Rust1.95.0 toolchain:

    cargo test --manifest-path tools/rust-ts-r0/Cargo.toml --locked --release --features qualification-observer --test qualification_replay comparator_ -- --nocapture

The explicit feature keeps the campaign requiring frozen inputs outside default
Cargo discovery. The existing three-OS native CI lane now explicitly runs the
filtered comparator tests, including the worker guard tests, and seven recipe CLI tests
using Python3.13.16. Remote results must still be collected for the new checkpoint.
Its existing optimized DEV artifact is retained before compiling the observer
with the feature. The reproduction archive's standalone `rustc --test` build also
remains available; do not mix historical and rebuilt libraries.

Focused repair tests need `SEMCTX_REPAIR_RECIPES` (new recipes JSON),
`SEMCTX_REPAIR_FIXTURE` (producer/helper/SDK/input identities) and
`SEMCTX_REPAIR_EVIDENCE` (fresh evidence root). Use the fixture's exact artifact
hashes. Set `GOPORT_LIB_PARSE_SNAPSHOT=0` and `GOPORT_LIB_SNAPSHOT=0`, unset
`GIT_CONFIG_GLOBAL`, then invoke:

    cargo test --manifest-path tools/rust-ts-r0/Cargo.toml --locked --release --features qualification-observer --test qualification_replay repair_ -- --nocapture

The initial native harness repair groups covered seven units and three supports. Four
comparator tests exercise the worker guard, including normalized aliases and
pathless native case-sensitivity probes. Worker refusals are accepted only for
strict repository ancestors and their `node_modules/@types` directories, bound
to negative `directory_exists` probes. Tests cover reads, positive probes,
unknown issues, malformed coordinates and missing bindings. The case-alias
regression, now `comparator_worker_case_insensitive_probe_aliases_cannot_hide_nonnegative_operations`,
passes with the fixed comparison. The harness measures case sensitivity in the
fresh worker directory before materializing authored files, passes that mode to
the verifier, and refuses contradictory or malformed native case probes. Root,
ancestor, issue and probe keys use that mode; raw observations remain unchanged.
The earlier red witness and incomplete checkpoint remain in the historical
[harness repair evidence](../../../docs/research/rust-ts-r0/resumption/harness-repair-evidence.json).
This checks captured observations, without asserting atomic capture or absence
of all operating-system reads.

The full campaign test requires a separately frozen, authorized manifest and
fresh evidence directory. Focused repairs and the ordinary native CI do not
substitute for the ordered 354-unit macOS/Linux/Windows campaign, property/support
review, reserved execution or R0 decision. The first additional C1 pass remains
open; no reserved payload was accessed during these repairs.

The native transport controls additionally require a separately identified
`transport_fixture_path` and `transport_fixture_sha256` in the focused fixture or
campaign manifest. This is the compiled `semctx-gates-fixture` fault injector,
separate from the C1 fact producer. A proxy forwards an actual C1 refused batch
using the explicitly declared exit 3 convention; it also truncates or omits the
batch for negative controls. The cancellation fixture waits for an owned
child/descendant readiness marker before requesting cancellation. Reader-error
qualification remains an explicit GAP. Ordinary Cargo discovery includes the
native transport integration test; focused qualification uses
`gap_real_native_refusal_truncation_and_owned_cancellation`.
