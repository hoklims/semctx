# ADR 0038 — Bounded Rust Plane A profile

- Status: accepted for B01/B03/B04 by the maintainer on 2026-10-17
- Date: 2026-10-17
- Issue: #347, after the #346 discovery
- Related: accepted ADR 0010 (Plane A trust dimensions), ADR 0009 (authored intent), ADR 0030 (impact), ADR 0035 (qualified TS/ESM admission)

## Context

The #346 discovery recommended tree-sitter Rust WASM for source structure and a conditional rust-analyzer LSP process for resolved navigation. The maintainer accepted that engine combination, a conservative refusal of glob imports, and the bounded B01/B03/B04 profile below. The discovery's B05–B07 and the acceptance evidence in #347 remain open.

This decision authorizes Cargo/LSP execution only for a repository and toolchain the caller explicitly trusts, and admits only the named partial Rust fact tuples. It does not establish shipped Rust support, all-platform packaging, performance budgets or M01–M22 parity.

## Candidate behavior

Rust is an explicit v2 language selection. The default path loads the pinned tree-sitter Rust grammar through WASM and records declarations, attributes, written imports and calls, and parse/conditional/macro limitations. Structural extraction does not evaluate cfg, expand macros, resolve names or establish the absence of a relation. Source evidence retains the original text and offsets; Plane A source-state identities canonicalize CRLF to LF under accepted ADR 0010.

Resolved navigation is an additional opt-in requiring `trusted:true`, a SHA-256 pinned rust-analyzer binary, a Rust 1.98.1 toolchain with rust-src and target library, target, features and a deadline. It runs against a temporary copy of selected source and Cargo inputs with offline Cargo, build scripts and proc macros disabled in LSP configuration. These settings do not sandbox Cargo or make an arbitrary repository safe to load. The B01 trust boundary is a repository and toolchain the caller already trusts.

The candidate rejects external dependencies and repository escapes before Cargo loading. Any glob import withdraws all LSP navigation relations for that request, because the pinned analyzer returned a singleton for a compiler-ambiguous glob trial. Source targets must join one selected, confined declaration by exact URI and range. Missing, multiple, generated or external targets remain unresolved. Indirect dispatch and macro expansion are outside the resolved-call claim. Conditional declarations outside the inline `cfg(test)` test context are omitted from ordinary facts. Inline `cfg(test)` declarations carry test evidence and no production export authority; external `cfg(test)` modules are unsupported until their test-world role is explicit. The selected feature/target world is not completely evaluated.

The accepted Plane A mapping projects crate identity from a Cargo manifest as a workspace `package`. The source graph maps a Rust file as `module` or `test`, struct/trait/type/union as `type`, enum as `enum`, impl block as `symbol`, and function/method as `function`. Rust kind, visibility, scope and source coordinates remain metadata. Conventional Cargo roots, automatic target flags and explicit target paths establish initial file membership; explicit external modules, including those inside inline modules, extend it. Ambiguous, unreferenced or redirected `#[path]` sources are unsupported. The structural mode validates a bounded manifest subset, including package name, version and edition, but does not replace Cargo's manifest validation. B03 accepts this mapping and the consumer-owned partial capability/authority tuples for editions 2018, 2021 and 2024.

Profiles declare partial completeness and `negativeEvidenceEligible:false`. A valid binding, fresh index or resolved LSP location cannot independently grant negative evidence or task authority. The candidate keeps the qualified `public-monorepo-static-v1` profile limited to TS/ESM under accepted ADR 0035. The existing impact v1 contract retains `explicitlyUnaffected: []` and null index-derived fields on broken binding under accepted ADR 0030.

## Compatibility and evidence required before delivery

Config v1 selection stays unchanged. Config v2 requires explicit Rust activation; removing it returns Rust files to disabled/unsupported outcomes. Existing graph kinds and versioned CLI/MCP report shapes are reused, but a changed v2 fact-schema digest requires rebuilding an old index. The rollout can be withdrawn by disabling Rust and rebuilding; no persisted schema migration is proposed.

The local macOS arm64/Bun 1.4.3 candidate has focused extraction, navigation, SQLite/Git freshness, impact, corpus and packaged-runtime tests. Those tests establish only their named paths. #347 still requires the public M01–M22 matrix and downstream consumer witnesses, independent review of the final candidate, a complete local gate, and CI on the exact head for Ubuntu, native Windows and macOS. B05 packaging and B06 representative budgets cannot be established from the local smoke. B07 remains open until the downstream paths are exercised.

Acceptance of B01/B03/B04 is an architecture decision. Public Rust support remains contingent on the #347 delivery evidence; a green index or local test cannot replace it.
