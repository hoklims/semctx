# Working on Semctx

Read [CONTRIBUTING.md](CONTRIBUTING.md) before changing this repository.

## Branches and delivery

- Keep independent changes in separate PRs against `main`.
- For dependent changes, follow the [stacked PR workflow](docs/contributing/stacked-prs.md).
  Use git-spice for the stack and `gh` for checks and exact-head merges.
- Give each stack one dedicated worktree and one author. Preserve unrelated work.
- Check the clone's setup before using git-spice. Run it from the worktree directory.
- For owner-requested maintenance and the Rust migration, follow the
  [solo-maintainer authorization](docs/contributing/solo-maintainer.md). It covers public
  development, affected checks, bounded corrections, branching, PR publication and normal
  merges within the requested task. Do not ask for confirmation at each step or PR.
- Merge from the bottom into `main` after the selected checks pass on the exact head, then
  restack, republish and obtain fresh checks before the next merge. Never bypass branch
  protection or another author's ownership. Release and deployment need separate authority.
- Report the stack's PR links, current stage, check results and any blocker.
