# ADR 0011 — Use pinned `@lezer/python` for the first Plane-A second-language vertical

- Status: accepted for the provisional Python vertical
- Date: 2026-07-28
- Issue: [#61](https://github.com/hoklims/semctx/issues/61)
- Related: ADR 0010 (multi-language Plane-A capability and authority)

## Context

The first non-TypeScript vertical needs deterministic syntax facts inside the existing Bun runtime.
It must not require a Python installation, subprocess protocol, native addon, or WebAssembly
runtime. The dependency choice must remain narrower than a claim of full Python semantic analysis.

## Decision

Pin [`@lezer/python` 1.1.19](https://www.npmjs.com/package/@lezer/python) exactly for the
provisional Python extractor.

The package is MIT-licensed and exposes a Lezer parser as ESM/CJS JavaScript with TypeScript
declarations. Its declared runtime dependencies are `@lezer/common`, `@lezer/highlight`, and
`@lezer/lr`; the current lock resolves them to 1.5.2, 1.2.3, and 1.4.10 respectively. Static
inspection of these locked runtime artifacts found JavaScript/declaration data only: no
subprocess invocation, native addon, or WebAssembly module. This is a dependency-shape observation,
not a security audit.

The semctx capability claim is capped at Python 3.12. Version 1.1.19 includes grammar support for
Python 3.10 match statements, PEP 654 `except*`, and Python 3.12 PEP 695 type parameters. The parser
does not provide module resolution, type checking, call analysis, runtime import behavior, or
negative completeness. The provisional runtime may add an `imports` edge only when a static module
reference resolves uniquely within the selected Python files; all other resolution remains
explicitly incomplete.

Pin the real-repository corpus to
[`pytest-dev/pluggy` 1.6.0 commit `fd08ab5f811a9b2fa9124ae8cbbd393221151e2c`](https://github.com/pytest-dev/pluggy/commit/fd08ab5f811a9b2fa9124ae8cbbd393221151e2c).
That commit is the 1.6.0 release preparation commit, is MIT-licensed, and declares Python `>=3.9`.
The corpus pin is test input, not a production dependency. The vendored subset test pins every
source/license byte and the canonical extraction result. It is bounded evidence for this vertical,
not a claim of complete Python semantic conformance.

## Consequences

- Parsing stays local, deterministic, and portable across semctx's Bun environments.
- Exact version and corpus pins make parser and source drift visible.
- The vertical can emit precise module, declaration, static-import, explicit-marker, source-range,
  and uniquely resolved selected-module import facts.
- Parse errors, star/dynamic imports, `sys.path` mutation, and unsupported syntax reduce capability
  or completeness instead of authorizing negative conclusions.
- Python 3.13+ is outside the declared capability even if the grammar happens to accept a construct.
- No parser package, Plane-A sidecar, or adapter interface becomes a stable public API through this
  decision.

## Revisit

Revisit the parser or dialect ceiling when a newer Python grammar is required, a pinned corpus
exposes material unsupported syntax, or semantic needs require import resolution, type analysis, or
other facts that a concrete-syntax parser cannot supply.
