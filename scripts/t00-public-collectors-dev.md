# Synthetic collector regressions

These independent DEV witnesses use synthetic baselines and controlled executables.
They do not acquire original or private qualification cases and grant no T00 credit.
They require POSIX, Bun 1.4.3, Python 3.13 and the existing public TypeScript 5.9.3
installation. No package installation is needed.

Set `DEV_REPO` to this checkout, `DEV_BUN` to the existing Bun executable and
`DEV_EVIDENCE_ROOT` to an existing, absolute, resolved directory owned by the test
operator. Use a fresh evidence parent for each invocation. Fixtures, child argv,
exit codes and raw streams remain there for inspection.

- `t00-public-collectors-dev.py -v` runs the three confinement, baseline preservation
  and nonzero subprocess evidence tests.
- `t00-diagnostics-import-binding-dev.py DiagnosticsImportBindingWitness.test_relative_and_real_typescript_imports_preserve_results_and_baseline -v`
  additionally requires `DEV_BASE_TEST_FILE` to point to `t00-public-collectors-dev.py`.
  Select this exact method: default discovery also inherits the base tests.
- `t00-suite-producer-source-binding-dev.py SuiteProducerSourceBinding.test_foreign_sources_refused_before_import_or_output -v`
  requires `DEV_SUITE_COLLECTOR` to point to
  `tools/rust-ts-r0/qualification/suite_oracle.mjs` and `DEV_PUBLIC_TYPESCRIPT` to
  the existing public `typescript/lib/typescript.js` file.

The diagnostics import test covers static relative and TypeScript imports. The
suite test covers an entirely foreign five-source baseline. Neither establishes
the full transitive dependency closure of the frozen oracle. The suite's external
trusted manifest hash remains a separate requirement.
