import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { SemctxError, createDefaultConfig } from "@semantic-context/core";
import type { ParsedArgs } from "../args";
import { flagBool } from "../args";
import { info, heading, success, c, json } from "../output";

interface PresetFile {
  /** repo-relative path */
  path: string;
  content: string;
}

interface PresetOptions {
  githubAction: boolean;
  claudeCode: boolean;
  devcontainer: boolean;
}

const WORKFLOW = `# semctx PR gate: BLOCK fails the check, WARN does not. Read-only, no secrets.
# Uses the semctx GitHub Action from hoklims/semctx, pinned at v0.1.0.
name: Semctx

on:
  pull_request:
    types: [opened, synchronize, reopened]

permissions:
  contents: read

jobs:
  semctx:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: hoklims/semctx/packages/github-action@v0.1.0
        with:
          base: \${{ github.event.pull_request.base.sha }}
          head: \${{ github.sha }}
          fail-on: block
`;

const CLAUDE_MD = `# semctx — change verification

Before finishing a non-trivial change, and before committing:

1. Run \`semctx verify diff\` (or the MCP tool \`semctx_verify_change\`).
2. PASS → proceed. WARN → consider a test (not a failure). BLOCK → resolve before finishing.
3. Run the recommended tests.
4. Never declare the work done while a BLOCK is unresolved. Never cite evidence not in the report.

semctx maps a diff to affected symbols, contracts, invariants and tests. It is **not** a
code-search tool and does not "understand the whole repository".

Optional guarded mode (opt-in): create \`.semctx/guard.json\` with \`{ "enabled": true }\` to block
\`git commit\`/\`git push\` until \`semctx verify diff --record\` has verified the current diff.
Disable strictly with \`SEMCTX_GUARD=off\`.
`;

const DEVCONTAINER = `{
  "name": "semctx consumer",
  "image": "mcr.microsoft.com/devcontainers/typescript-node:20",
  "features": {
    "ghcr.io/devcontainers/features/git:1": {}
  },
  "postCreateCommand": "curl -fsSL https://bun.sh/install | bash",
  "remoteEnv": {
    "PATH": "\${containerEnv:HOME}/.bun/bin:\${containerEnv:PATH}"
  }
}
`;

function configJson(root: string): string {
  const hasPackages = existsSync(join(root, "packages"));
  const base = createDefaultConfig(".");
  const config = {
    ...base,
    repositoryRoot: ".", // the loader always trusts the on-disk root at runtime
    include: hasPackages ? ["packages/*/src/**/*.ts", "src/**/*.ts"] : base.include,
  };
  return `${JSON.stringify(config, null, 2)}\n`;
}

function presetFiles(root: string, opts: PresetOptions): PresetFile[] {
  const files: PresetFile[] = [{ path: ".semctx/config.json", content: configJson(root) }];
  if (opts.githubAction) files.push({ path: ".github/workflows/semctx.yml", content: WORKFLOW });
  if (opts.claudeCode) files.push({ path: ".claude/semctx.md", content: CLAUDE_MD });
  if (opts.devcontainer) files.push({ path: ".devcontainer/devcontainer.json", content: DEVCONTAINER });
  return files;
}

function writeAtomic(abs: string, content: string): void {
  mkdirSync(dirname(abs), { recursive: true });
  const tmp = `${abs}.tmp`;
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, abs);
}

type Action = "create" | "skip-exists" | "overwrite";

/** Ensure `.gitignore` contains `.semctx/` without clobbering existing content. */
function ensureGitignore(root: string, dryRun: boolean): { path: string; action: "create" | "append" | "present" } {
  const abs = join(root, ".gitignore");
  if (!existsSync(abs)) {
    if (!dryRun) writeAtomic(abs, ".semctx/\n");
    return { path: ".gitignore", action: "create" };
  }
  const current = readFileSync(abs, "utf8");
  if (/^\.semctx\/?\s*$/m.test(current)) return { path: ".gitignore", action: "present" };
  if (!dryRun) writeFileSync(abs, current + (current.endsWith("\n") ? "" : "\n") + ".semctx/\n", "utf8");
  return { path: ".gitignore", action: "append" };
}

const AVAILABLE_PRESETS = ["github-claude"] as const;

/** `semctx init --preset <name>` — preview-first bootstrap. Never overwrites without --force. */
export function runPreset(root: string, preset: string, args: ParsedArgs): number {
  if (!AVAILABLE_PRESETS.includes(preset as (typeof AVAILABLE_PRESETS)[number])) {
    throw new SemctxError("UNSUPPORTED", `unknown preset "${preset}" (available: ${AVAILABLE_PRESETS.join(", ")})`, { preset });
  }
  const dryRun = flagBool(args, "dry-run");
  const force = flagBool(args, "force");
  // github-claude enables the action + claude config by default; devcontainer is opt-in.
  const opts: PresetOptions = {
    githubAction: true || flagBool(args, "with-github-action"),
    claudeCode: true || flagBool(args, "with-claude-code"),
    devcontainer: flagBool(args, "with-devcontainer"),
  };

  const files = presetFiles(root, opts);
  const planned: Array<{ path: string; action: Action }> = files.map((f) => {
    const abs = join(root, f.path);
    const exists = existsSync(abs);
    const action: Action = !exists ? "create" : force ? "overwrite" : "skip-exists";
    if (!dryRun && action !== "skip-exists") writeAtomic(abs, f.content);
    return { path: f.path, action };
  });
  const gi = ensureGitignore(root, dryRun);

  if (flagBool(args, "json")) {
    json({ preset, dryRun, force, files: planned, gitignore: gi });
    return 0;
  }

  heading(dryRun ? `Preset "${preset}" — preview (dry run, no writes)` : `Preset "${preset}"`);
  for (const p of planned) {
    const mark =
      p.action === "create" ? c.green("create ") : p.action === "overwrite" ? c.yellow("overwrite") : c.dim("skip    ");
    const note = p.action === "skip-exists" ? c.dim("  (exists; pass --force to overwrite)") : "";
    info(`  ${mark} ${p.path}${note}`);
  }
  const giMark = gi.action === "present" ? c.dim("present ") : c.green(gi.action === "create" ? "create  " : "append  ");
  info(`  ${giMark} ${gi.path}${gi.action === "append" ? c.dim("  (+ .semctx/)") : ""}`);

  info("");
  if (dryRun) {
    info(c.dim("Dry run — nothing was written. Re-run without --dry-run to apply."));
  } else {
    success(`preset applied`);
    info(c.dim("Next: semctx index   then   semctx verify diff --base origin/main"));
  }
  return 0;
}
