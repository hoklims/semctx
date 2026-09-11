# Semctx support

Semctx is maintained in public on GitHub. Choose the route below so questions, reproducible defects,
feature ideas, and security reports reach the right place.

## Before opening a report

Check the [documentation index](docs/README.md) and [troubleshooting guide](docs/troubleshooting.md).
For a local diagnostic snapshot, run:

```bash
semctx doctor --json
semctx plugin-status --json
semctx index-health --json
semctx support --output semctx-support.json
```

`semctx support` creates an allowlisted local report. Nothing is uploaded automatically. Review any
file before sharing it and remove paths or details you do not want to disclose.

## Where to report

- **Usage or setup question:** check [troubleshooting](docs/troubleshooting.md), then use the
  support-question form in the GitHub issue chooser if the answer is still missing.
- **Reproducible bug:** open the bug form. Include the Semctx and Bun versions, operating system,
  command, expected result, actual result, and the smallest safe reproduction you can provide.
- **Feature request:** open the feature form and describe the user outcome and limits, not only a
  proposed implementation.
- **Security vulnerability:** follow [SECURITY.md](SECURITY.md). Never disclose an unpatched
  vulnerability in a public issue.

Do not post secrets, credentials, private repository source, proprietary logs, personal data, or a
full `.semctx` database. A minimal synthetic example is preferred. Maintainers may ask for a narrow
additional diagnostic after reviewing the initial report.
