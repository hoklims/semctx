# T00 qualification observer under correction

These sources continue the historical C1 v2 observer in the same T00 experiment.
The [registration](../../../docs/research/rust-ts-r0/resumption/correction-pass1-registration.json)
and [focused evidence](../../../docs/research/rust-ts-r0/resumption/harness-repair-evidence.json)
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
expectations remain the source of expected values. Current recipes still expose
64 GAP units; preparing recipes does not qualify them.

Build the observer using the pinned Rust1.95.0 release libraries belonging to the
selected producer and helper, following the reproduction archive's `rustc --test`
instructions with this `qualification_replay.rs`. Use explicit matching rlibs;
do not mix historical and rebuilt libraries. The observer is currently standalone
and is not discovered by ordinary Cargo test discovery. Native Actions wiring is
pending in step5, before final delivery.

    <observer-test-binary> comparator_ --nocapture

Focused repair tests need `SEMCTX_REPAIR_RECIPES` (new recipes JSON),
`SEMCTX_REPAIR_FIXTURE` (producer/helper/SDK/input identities) and
`SEMCTX_REPAIR_EVIDENCE` (fresh evidence root). Use the fixture's exact artifact
hashes. Set `GOPORT_LIB_PARSE_SNAPSHOT=0` and `GOPORT_LIB_SNAPSHOT=0`, unset
`GIT_CONFIG_GLOBAL`, then invoke:

    <observer-test-binary> repair_ --nocapture

The four native repair groups cover seven units and three supports. Two passing
repair tests exercise the worker guard, including normalized aliases and
pathless native case-sensitivity probes. Worker refusals are accepted only for
strict repository ancestors and their `node_modules/@types` directories, bound
to negative `directory_exists` probes. Tests cover reads, positive probes,
unknown issues, malformed coordinates and missing bindings. A third guard test,
`repair_worker_case_insensitive_probe_aliases_cannot_hide_nonnegative_operations`,
currently fails: the verifier forces case-sensitive matching even when the native
worker reports an insensitive filesystem. Differently cased reads and positive
probes can therefore escape the negative-probe group. The guard is incomplete,
and the full `repair_` selector is not green with this regression included.
This checks captured observations, without asserting atomic capture or absence
of all operating-system reads.

The full campaign test requires a separately frozen, authorized manifest and
fresh evidence directory. Focused repairs and the existing four-vector CI do not
substitute for the ordered 354-unit macOS/Linux/Windows campaign, property/support
review, reserved execution or R0 decision. The first additional C1 pass remains
open; no reserved payload was accessed during these repairs.
