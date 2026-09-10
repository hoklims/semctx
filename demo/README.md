# Public evidence page

This directory is a static, dependency-free view of the strict public evidence projection. It
contains no analytics, remote font, runtime service, or copied local runner output.
It is intended for the existing Pages site at `/semctx/demo/`; it does not replace the root landing.

Build candidate evidence from explicit local inputs:

```text
bun scripts/build-public-demo.ts --phase candidate --demo <first-use-manifest.json> --pilot <pilot-public-summary.json> --output site/evidence.json
```

Omit `--demo` and `--pilot` to emit the honest `NOT_OBSERVED` state. Release evidence additionally
requires a completed packaged demo. `--commit` and `--fixture-commit` accept only full lowercase Git
commits and label them `caller-asserted`; this builder does not authenticate them.

The builder validates demo case IDs, fixed fixture paths, known rule IDs, pilot count consistency,
score eligibility and bounded identities before writing. Its output omits raw unknown text, local
paths, filenames outside the fixed fixtures, command logs, source aliases and experiment IDs.
