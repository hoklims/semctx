## Summary

Describe the problem, the chosen change, and any intentionally excluded scope.

## Change tier

Select exactly one: the highest tier reached by this change. See the
[public-contract contribution guide](/docs/contributing/public-contracts.md).

- [ ] **ROUTINE** — behavior-preserving internal maintenance with no domain-policy or public-contract effect.
- [ ] **DOMAIN** — changes application behavior behind an unchanged governed public contract.
- [ ] **GOVERNED** — changes a public contract, ADR, machine source of truth, governance rule, or compatibility policy.

## Governing sources and compatibility

- Governing ADR(s): <!-- Link ADRs, or write N/A with a reason. -->
- Machine source(s) of truth: <!-- Link schemas/manifests/contracts, or write N/A with a reason. -->
- Compatibility and migration impact: <!-- Describe compatibility/migration, or write N/A with a reason. -->

## Validation

- [ ] `bun run verify:pr` passes locally, or the validation gap is explained below.
- [ ] Tests cover changed behavior.
- [ ] Generated plugin artifacts are updated when their sources change.

## Contracts and documentation

- [ ] Public CLI, MCP, schema, or plugin contract changes are documented.
- [ ] Architecture decisions or tradeoffs are recorded in an ADR when appropriate.
- [ ] Breaking changes and migration steps are called out explicitly.
- [ ] Every N/A above includes a reason.

## Additional context

Link related issues and include logs, screenshots, or follow-up work as needed.
