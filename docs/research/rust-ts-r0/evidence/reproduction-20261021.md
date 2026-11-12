# C1 reproduction and qualification index — 21 October 2026

The [manifest](reproduction-20261021.json) records review head `107bf34e` and the
historical campaign source `37cdaed8`. The [unit-extraction record](../resumption/unit-test-extraction-20261020.json)
binds each macOS/Linux freeze, producer, helper, transport fixture, observer, SDK,
recipes and environment to its SHA256. [The format correction](../resumption/format-ci-repair-20261021.json)
records later changed producer hashes. These are separate milestones; there is no
full 354/51 campaign result for `107bf34e` or the forthcoming evidence-restoration commit.
Rebuild and freeze a new candidate before drawing conclusions about it.

## Archived evidence

Use [archive-index.json](archive-index.json) for decoded SHA256 and sizes, and
[SHA256SUMS](SHA256SUMS) for batch checking. All commands below start at the repository root.
Keep the new evidence directory outside the repository.

```sh
python3 tools/rust-ts-r0/qualification/fetch_evidence.py --verify
export T00_REVIEW_EVIDENCE=$(mktemp -d /tmp/semctx-t00-review.XXXXXX)
python3 tools/rust-ts-r0/qualification/fetch_evidence.py \
  --archive resumption--gap-legacy-identity-evidence \
  --archive macos-unit-extraction-20261020 \
  --archive linux-unit-extraction-20261020 \
  --archive unit-extraction-reproduction-20261020 \
  --output "$T00_REVIEW_EVIDENCE/archives"
mkdir "$T00_REVIEW_EVIDENCE/history"
for archive in "$T00_REVIEW_EVIDENCE"/archives/*unit-extraction*.tar.gz; do
  tar -xzf "$archive" -C "$T00_REVIEW_EVIDENCE/history"
done
```

`macos-unit-extraction-20261020` and `linux-unit-extraction-20261020` contain frozen
binaries, SDK/input/recipe bytes, report and selected raw process requests/outcomes.
Their member manifests identify every included byte stream. Source workspaces generated
by replay are omitted. The reproduction bundle retains the unmodified historical
`local-campaign-runner.py`, build logs, Linux context and cross-run comparison.
The complete local directories remain under
`/Users/sebastien/semctx-evidence/t00/20261020/test-modules-1904/{macos,linux}-campaign-v1`.

## Native macOS: prepare and run a fresh 354-unit / 51-support campaign

Requires the repository's pinned Rust 1.95.0 and Bun 1.4.3. The existing historical
runner creates `freeze.json` with the current `git rev-parse HEAD`, exact binary hashes,
SDK 5.9.3, recipe identity and explicit optimized-freeze signal. It preserves raw
NONPASS version differences; its aggregate PASS is not formal qualification.

```sh
unset GIT_CONFIG_GLOBAL
export RUSTUP_TOOLCHAIN=1.95.0 CARGO_BUILD_JOBS=2 RUST_TEST_THREADS=1
export GOPORT_LIB_PARSE_SNAPSHOT=0 GOPORT_LIB_SNAPSHOT=0
export RUNNER_OS=macOS
export RUNNER_TEMP="$T00_REVIEW_EVIDENCE/macos-fresh"
mkdir "$RUNNER_TEMP"
export SEMCTX_PROCESS_HELPER="$PWD/tools/gates/target/release/semctx-gates"
export T00_LOCAL_LEGACY_ARCHIVE="$T00_REVIEW_EVIDENCE/archives/resumption--gap-legacy-identity-evidence.tar.gz"
cargo build --manifest-path tools/gates/Cargo.toml --locked --release --bins
cargo build --manifest-path tools/rust-ts-r0/Cargo.toml --locked --release --bin semctx-r0-probe
python3 tools/rust-ts-r0/qualification/prepare_recipes.py --output "$RUNNER_TEMP/t00-campaign-recipes"
cargo test --manifest-path tools/rust-ts-r0/Cargo.toml --locked --release \
  --features qualification-observer --test qualification_replay --no-run \
  --message-format=json > "$RUNNER_TEMP/t00-observer-build.jsonl"
python3 "$T00_REVIEW_EVIDENCE/history/local-campaign-runner.py"
```

Retain the full new run directory, build output, environment, source status and hashes.
Do not replace the historical freeze or copy its source identity onto a new run.
Native test discovery and comparator tests are separate from this campaign.

## Linux OrbStack: same commands, separate native artifacts

The retained environment is Linux aarch64, Rust 1.95.0, Python 3.11.2,
image `rust@sha256:6258907abe69656e41cd992e0b705cdcfabcbbe3db374f92ed2d47121282d4a1`,
network `none`. The owner’s Mac has `semctx-t00-oct20-linux-v1`, with a read-only
source bind at the same absolute checkout path and writable native target/evidence
volumes. The manifest records its mounts' context, invocation and environment limits;
this container name alone is not image attestation. A clean machine must provision the
recorded tools/caches and writable native targets before offline execution.

```sh
docker inspect semctx-t00-oct20-linux-v1 --format '{{.Image}} {{.HostConfig.NetworkMode}}'
docker exec --user 501:20 --workdir "$PWD" semctx-t00-oct20-linux-v1 \
  env -u GIT_CONFIG_GLOBAL rustc --version
```

Copy the decoded legacy archive and historical runner to the container evidence volume
with `docker cp`. Choose a fresh directory there, then enter the existing container:

```sh
docker cp "$T00_REVIEW_EVIDENCE/archives/resumption--gap-legacy-identity-evidence.tar.gz" \
  semctx-t00-oct20-linux-v1:/work/evidence/review-legacy-inputs-20261021.tar.gz
docker cp "$T00_REVIEW_EVIDENCE/history/local-campaign-runner.py" \
  semctx-t00-oct20-linux-v1:/work/evidence/review-campaign-runner-20261021.py
docker exec -it --user 501:20 --workdir "$PWD" semctx-t00-oct20-linux-v1 bash
```

Inside, repeat the macOS build/prepare/run block with `RUNNER_OS=Linux`,
`RUNNER_TEMP=/work/evidence/review-linux-20261021-fresh`,
`T00_LOCAL_LEGACY_ARCHIVE=/work/evidence/review-legacy-inputs-20261021.tar.gz`, and
`python3 /work/evidence/review-campaign-runner-20261021.py` as the final command.
Do not reuse macOS executables. Preserve the Linux raw archive without extracting
non-UTF-8 fixture names on macOS as if that were a complete extraction.

## Windows final milestone

The [owner execution decision](../resumption/owner-execution-decisions-20261020.json)
requires the full campaign once at the final pre-R0 milestone, in the existing
`rust-gates (windows-latest)` job through normal `pull_request` CI. Current CI runs
native suites and observer comparators, not the full 354/51 campaign. The final
campaign wiring, freeze and raw report retention remain to be prepared; no Windows
campaign result, local Windows run, workflow change or manual dispatch is claimed here.
Build native `.exe` artifacts and use the same frozen-manifest oracle before R0.

## Obligation → assertion/support → evidence/result

The canonical inventory is [cases/index.json](../cases/index.json), with
[qualification/obligations.json](../cases/qualification/obligations.json),
[scenarios.json](../cases/qualification/scenarios.json) and
[support.json](../cases/qualification/support.json). Input closure/provenance lives in
[allocation/input-index.json](../cases/allocation/input-index.json) and the frozen
source/annex payloads referenced there. Prepared `replay-recipes.json` and
`support-mapping-plan.json` connect these inputs to current projected comparisons.

The newest original-campaign row states are in each archived
`{macos,linux}-campaign-v1/t00-original-campaign/evidence/report.json`: join
`obligations[].obligation_id`, `units[].unit_id` and `supports[].support_id` through the
canonical maps. Individual raw observations/outcomes live below the same evidence root.
Both reports retain 352 PASS / 2 NONPASS units, 50 PASS / 1 NONPASS supports,
239 obligations whose associated units passed, **0/240 qualified obligations**.
`T00-ARB-002/003/004` preserve individually scoped version differences and raw NONPASS;
they do not waive the full inventory. No per-obligation final closure ledger exists
for the new candidate. [final/obligation-states.json](../final/obligation-states.json)
is the older terminal dossier, not this resumed state;
[resumption/record.json](../resumption/record.json) reopens C1 with `r0Decision: null`.

Still open: current-candidate campaigns, per-property/support review and input closure,
the independent 23-case / 26-variant reserved evaluation, the Windows final milestone,
R0 decision, then aggregate audit/admission on the final candidate. Experimental
additional assertions remain local and non-adopted under the recorded format milestone.
The owner supplies the reserved corpus privately, outside GitHub. Use the public commitments in
[PUBLIC-FREEZE-RECEIPT.json](../cases/reserved/PUBLIC-FREEZE-RECEIPT.json), without
copying its payload into Git or exposing its expectations to the producer author.
