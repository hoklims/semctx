# ADR 0023: a static, reproducible public evidence page

Status: accepted by maintainer-delegated Codex lead, 2026-09-08.
Sources: HOK-634, ROADMAP.md, adoption-plan.md, user waiver of human studies.

## Pre-action record

LATENT_COMPASS_ROUTING_NOTE_V1
- decision_id: semctx-public-evidence-20260908
- objective: let a TypeScript maintainer inspect the real demo and its limits before installing.
- authority: maintainer delegated completion and delivery of v0.2 to Codex.
- candidates: A, static page built from a narrow projection of local reports; B, documentation page with manually transcribed evidence.
- pre_action_evidence:
  - A: SUCCESS, working packaged demo and local pilot schemas exist. VIOLATION, none established; raw paths must not reach the site. COST, small static builder and tests. INFORMATION, reproducible report binding. REVERSIBILITY, removable static directory and workflow.
  - B: SUCCESS, repository Markdown already exists. VIOLATION, none established; transcribed numbers may drift. COST, manual synchronization. INFORMATION, no additional execution evidence. REVERSIBILITY, removable docs.
- result: RECORD
- claim_boundary: no engagement, adoption or benefit measurement exists.
- handoff: Codex lead.

Decision: A, a lightweight static GitHub Pages workbench with the README as its primary source link.
The original decision kept the legacy `gh-pages` root unchanged. Documentation-coherence work in
[#147](https://github.com/hoklims/semctx/issues/147) later added a reviewed root source at
`site/landing/index.html`; the evidence page remains additive at
`https://hoklims.github.io/semctx/demo/` and uses relative assets beneath that path. No framework,
dependency, analytics, remote font, account, server or model calls. Publication is a separate
lead-owned action after candidate review; authoring must not deploy anything.

## Experience and visual direction

English, matching the public repository. Audience: TypeScript maintainers assessing a diff.
Use a documentation workbench: restrained white/ink surface, monospace code identity, clear fine
borders, a compact section rail, an actual before/after diff beside three selectable cases, and a
report below. Use the existing Mintlify/IBM documentation references for hierarchy and spacing,
without copying assets. No generic marketing card grid, fake testimonials, invented measurements,
animated background or oversized slogan. Keyboard selection and mobile layout must work. Use
system-installed fonts to preserve offline operation; readable code and focus states matter more
than a downloaded display font. Build with semantic HTML/CSS/vanilla JS and local assets only.

One primary starting route: packaged `semctx` CLI; reveal Codex/Claude host recipes as secondary
documentation links. Show Bun >=1.4.0 and Git prerequisites, the actual global PASS/WARN/BLOCK
semantics, the next check, and the runtime bug the analyzer does not prove correct. Do not imply
that a marker alone tests business behavior. Labels distinguish candidate, released and unmeasured.
The page must remain useful without JavaScript and display missing evidence honestly.

## Evidence and privacy contract

Add `scripts/build-public-demo.ts` accepting explicit local demo manifest, optional pilot public
summary, output path and phase (candidate/release). Produce `site/evidence.json` as a separate strict
v1 projection, not copied raw input. Root supplies and reviews real data after integration. Until
then the shipped page must show no observation rather than prepopulate invented results.

Allowed values: schema/kind constants; valid semver; SHA-256 digests; optional validated commit
identity explicitly marked caller-asserted unless separately bound; fixed phase; demo status and
global verdict enums; the three fixed case IDs and known rule IDs, matched-expectation booleans;
unknown count (not raw unknown text); fixed disclosure text; pilot evidence/verdict enums and finite
non-negative aggregate counts/durations from PublicSummaryV1. Omit pilot scores until there are
adjudicated labels; never publish precision or gains for UNKNOWN cases. Include human adoption,
retention and contribution-time as NOT_MEASURED constants. Reject malformed/version-mismatched/
inconsistent inputs; unknown fields must not be copied. Never copy local paths, filenames other
than these fixed fixture paths, arbitrary rule IDs, logs, free text, private aliases, case URLs,
raw labels, environment data or source labels. HTML rendering uses textContent for supplied data.

The first-use inputs are in scripts/first-use-demo/runner.ts and fixture.ts in the integration
worktree; the pilot public type is scripts/pilot/report.ts in its isolated worktree. Read those
sources to bind names, but do not mutate other worktrees. Link the raw public JSON and generated
fixture content, not local raw logs. Root will supply exact public corpus references separately.

## Proof and rollout

Test that injected private paths/free text cannot reach serialized output, malformed summaries are
rejected, unsupported cases remain limits, missing data is explicit and all links/assets are local
or fixed repository URLs. Root verifies desktop/mobile/keyboard behavior, then independently reviews
the integrated candidate. No relaxed full gates. Root owns publication into `demo/` on the existing
`gh-pages` branch. The later root-coherence correction reuses that branch and does not migrate Pages
settings; the feature author does not change CI or deploy.
After npm release, regenerate the demo from the exact downloaded release artifact, rebuild the
projection and republish with both candidate/release identities kept distinct.
