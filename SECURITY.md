# Security Policy

## Scope

semctx runs locally against repositories that may be untrusted. It:

- reads source files, docs and migrations under the configured root;
- shells out to `git` (for `verify diff`) and, only when explicitly configured, to `ccc`
  (the optional CocoIndex provider) — both with fixed argument lists, never a shell string;
- stores results in a local SQLite file (`.semctx/semctx.db`) using bound parameters;
- performs no network I/O in its deterministic core.

## Reporting a vulnerability

Please report suspected vulnerabilities privately by opening a
[GitHub Security Advisory](https://docs.github.com/en/code-security/security-advisories)
on the repository, or by emailing the maintainers listed in `package.json`. Do not open a
public issue for an unpatched vulnerability.

We aim to acknowledge reports within a few business days and to ship a fix or mitigation
as quickly as the severity warrants.

## Hardening notes

- External command arguments are passed as arrays (`Bun.spawnSync([...])`), so task text
  or file contents cannot inject shell commands.
- All SQL uses parameter binding; no value is concatenated into a query string.
- Config and task files are parsed with `JSON.parse` and validated with Zod at the boundary.

## Integrations

- **GitHub Action** (`packages/github-action`): uses the standard `pull_request` trigger,
  **never** `pull_request_target`. Requires `permissions: contents: read` only — no write token,
  no secret. It never comments on PRs. All user-controlled inputs are routed through the step
  `env:` and referenced as shell variables, so the `${{ }}` template engine never interpolates a
  value into a run script (no Actions injection). It runs a fixed set of `semctx` commands plus a
  Node adapter — it does not execute arbitrary PR scripts.
- **Claude Code guarded hook** (`plugins/claude-code`): advisory (never blocks) by default. When
  a project opts in, it gates only `git commit`/`git push`, keyed on a diff hash — it runs no
  analysis and parses the command structurally (argv tokens, never a shell eval). It is strictly
  disableable with `SEMCTX_GUARD=off`. The verification-state file is git-ignored and written
  atomically.
