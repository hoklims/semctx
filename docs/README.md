# Semctx documentation

Choose the path that matches what you are trying to do. The [project README](../README.md) gives
the short product overview, prerequisites, first command, and current limits; this page is the
navigation hub for the complete documentation.

## Start and learn

- [Install Semctx and verify your first change](getting-started.md)
- [Run the packaged three-case demo](contributing/first-use-demo.md)
- [Understand claims, evidence, and task-relative authority](concepts/claims-and-authority.md)
- [Read the architecture overview](architecture/overview.md)

## Accomplish a task

| I want to... | Guide |
| --- | --- |
| Use the CLI without an agent host | [Getting started](getting-started.md) and [CLI reference](reference/cli.md) |
| Use Semctx from Codex | [Codex control-plane integration](integrations/codex-control-plane.md) |
| Use Semctx from Claude Code | [Claude Code integration](integrations/claude-code.md) |
| Try the experimental Oh My Pi package | [OMP installation and limits](integrations/omp.md) |
| Gate a pull request | [GitHub Actions integration](integrations/github-actions.md) |
| Configure language selection and rules | [Configuration reference](reference/configuration.md) |
| Diagnose installation, activation, version, or index health | [Troubleshooting and FAQ](troubleshooting.md) |
| Ask for help or report a problem | [Support and reporting routes](../SUPPORT.md) |

## Look up a contract

- [CLI commands and machine outputs](reference/cli.md)
- [Configuration schema and analysis modes](reference/configuration.md)
- [Public MCP contribution contracts](contributing/public-mcp-contracts.md)
- [Change contracts](architecture/change-contracts.md)
- [Semantic model](architecture/semantic-model.md)

## Understand the design

- [Architecture decisions](adr/)
- [Architecture documentation](architecture/)
- [Why semantic retrieval is not the product](adr/0005-context-retrieval-pipeline-rejected.md)
- [Why the semantic layer is separate](adr/0009-semantic-layer-is-separate-from-the-repository-graph.md)
- [How the read-only control plane works](architecture/control-plane-v1.md)

## Contribute and maintain

- [Contributor setup and required checks](../CONTRIBUTING.md)
- [First contributor check](contributing/first-check.md)
- [Public-contract change tiers](contributing/public-contracts.md)
- [Release and npm publishing](publishing.md)
- [Security policy](../SECURITY.md)
- [v0.2.1 release brief](releases/v0.2.1.md)
- [v0.2.0 release brief](releases/v0.2.0.md)

Release-specific documents, ADRs, implementation records, and pilot results remain in place as
versioned evidence. This index organizes access to them; it does not rewrite their historical claims.
