# SDK variable assignment addendum

Independent baseline-only oracle for T00 coordinate 115:0. Authority: consumer commit `3e94997fcbefa72ad4d49b2cad180ee79b7c0a9b`, TypeScript 5.9.3, Zod 3.25.76, Bun 1.4.3. No C1/Rust/candidate outputs, private inputs, network, installs or prior memory were consulted.

Six witnesses isolate three existing consumer paths: binary identifier assignment, array element assignment, object shorthand assignment. Each positive assigns the SDK `navigator` variable; each control declares a module-local homonym before assigning it. The shorthand pair separately exercises `getShorthandAssignmentValueSymbol`. This is a bounded gap addendum, not a claim of all-TypeScript coverage. Nested defaults, spread and arbitrary syntax combinations are outside this lot.

`inputs/` contains exact source bytes; `cases.json` identifies each independent case. `expected.json` preserves complete outputs of both `inspectSemanticDependencies` and `inspectModuleConfiguration`, full actual argument records, and Programs observed at the consumer use site. Each Program includes actual compiler options, roots, retained inputs, every source-file hash and default-library flag, and identifier declaration origins with source span/text and file hash. `$RUN` and `$ADDENDUM` replace only absolute runtime/artifact roots for portable comparison. Raw absolute records remain under `primary/raw.json` and `reproduction/raw.json`.

`authority/` and `baseline.tar` retain Git baseline bytes. `vendor/` contains the frozen existing dependency bytes; manifest entries pin every file, including all SDK libraries. `instrumentation.json` records source transformations: package imports point to the local frozen dependencies, and a single observational call records the actual Program. Baseline function logic is unchanged. `observer.ts` reads checker provenance only and does not modify Program state.

Reproduce offline after verifying every `manifest.json` file entry and `manifest.sha256`:

```
bun run.ts ./fresh-reproduction
bun verify.ts expected.json ./fresh-reproduction/normalized.json
bun verify.ts wrong-expected.json ./fresh-reproduction/normalized.json
```

The first verification must exit 0; the wrong-expected verification must exit 1 with `ORACLE_EXPECTATION_MISMATCH`. `commands.json` preserves successful second-reproduction checks and the failing negative check. `build.ts` documents baseline extraction and local dependency copying; it is authoring-only and unnecessary for portable replay. `finalize.ts` is authoring-only and requires absent reproduction output; do not rerun it against the frozen lot. Generated runtime source/fixture trees are reconstructible and omitted from the sealed file list; all their baseline inputs, scripts, dependencies, outputs and transformation hashes are sealed.

For raw CLI adaptation, replay each input independently under its own retained `main.ts` snapshot with no tsconfig and compare both complete reason arrays to `response`, preserving the positive/local-control relationship. Do not collapse witnesses into one aggregate. SDK declaration origins are explanatory baseline evidence, not invented native expectations. This lot provides no R0 or qualification credit.
