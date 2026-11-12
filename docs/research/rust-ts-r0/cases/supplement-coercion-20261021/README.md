# Binary coercion addendum

Frozen baseline-only witnesses for T00 coordinate 61:0, `coercingBinary`, consumer commit `3e94997fcbefa72ad4d49b2cad180ee79b7c0a9b`. Exactly two cases use `PlusToken`: `({}) + 1` has a nonprimitive object operand; `1 + 2` has primitive operands. Each source is a module (`export {}`). No unary operators, calls, SDK mutation or aggregate fixtures can mask this binary contrast.

The baseline produces exactly `["SOURCE_COERCION_UNSUPPORTED"]` for both semantic inspection and module configuration on the object case, and `[]` for both on the primitive control. Full responses and actual argument records are frozen in `expected.json`, with four actual Programs observed at the consumer use site. Records retain real compiler options, roots, SDK file hashes, retained input bytes, binary expression types/flags, and declaration origins. Empty declaration arrays for literal operands are preserved rather than invented SDK provenance.

Dependency: the immutable sibling SDK-assignment addendum manifest SHA256 `a302eb10889e2c14f38f5736894a44d817b7fc14362fa569100a8fb3c820db1d`. It supplies baseline Git-authority source, TypeScript 5.9.3 and SDK bytes, and Zod 3.25.76. Every dependency-manifest byte entry is verified before execution. The dependency is never modified. No network, installation, private inputs, memory, C1/Rust/candidate source or candidate output was used.

Offline portable reproduction requires Bun 1.4.3 and both frozen artifact directories:

```
bun run.ts ./fresh-reproduction --dependency-root /path/to/t00-supplement-sdk-assignment-addendum
bun verify.ts expected.json ./fresh-reproduction/normalized.json
bun verify.ts wrong-expected.json ./fresh-reproduction/normalized.json
```

Verify this manifest and its entries before replay. The normal comparison must exit 0; the poisoned semantic expectation must exit 1 with `ORACLE_EXPECTATION_MISMATCH`. `commands.json` records a second independent fresh runtime and both checks. Absolute artifact/runtime/dependency roots normalize to `$ADDENDUM`, `$RUN`, `$DEPENDENCY` only; raw full outputs remain in both run directories.

The only source transformations are frozen dependency import paths and a single read-only observational call recording the actual semantic Program. `instrumentation.json` binds baseline and transformed hashes; `observer.ts` records types without altering consumer logic. Reconstructible generated source and fixture trees are omitted from this manifest; their baseline bytes, dependency bytes, scripts, input bytes, transformation hashes and complete outputs are pinned. `prepare.ts` and `finalize.ts` are authoring-only and must not be rerun over the sealed lot.

For raw CLI adaptation, execute each retained `main.ts` independently with no tsconfig and compare both complete response arrays; do not reduce the oracle to one reason-presence test. These two cases establish this bounded binary consumer contrast only; no all-operator/all-TypeScript coverage or qualification/R0 credit is claimed.
