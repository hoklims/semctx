import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  AGENT_LIFECYCLE_POLICY_V1,
  AGENT_WORKFLOW_CONTRACT_V1,
} from "@semantic-context/control-model";
import {
  HOST_CLI_STRIP,
  hostCliLadder,
  renderControlSkill,
  renderSharedLifecycleContract,
  type SkillHost,
} from "../scripts/build-plugin-runtime.ts";

const repoRoot = resolve(import.meta.dir, "..");

function read(path: string): string {
  return readFileSync(resolve(repoRoot, path), "utf8").replaceAll("\r\n", "\n");
}

function json<T>(path: string): T {
  return JSON.parse(read(path)) as T;
}

function typescriptLibs(plugin: "claude-code" | "semctx-control"): string[] {
  return readdirSync(resolve(repoRoot, `plugins/${plugin}/dist/typescript-lib`))
    .filter((name) => name.startsWith("lib") && name.endsWith(".d.ts"))
    .sort();
}

function skillPath(host: SkillHost): string {
  return host === "claude-code"
    ? "plugins/claude-code/skills/semctx-control/SKILL.md"
    : "plugins/semctx-control/skills/semctx-control/SKILL.md";
}

/** Shared workflow contract = generated skill with the host CLI ladder region removed. */
function sharedContractBody(skill: string): string {
  const stripped = skill.replace(HOST_CLI_STRIP, "");
  expect(stripped).not.toBe(skill); // host region must be present and strip-able
  return stripped;
}

function sharedLifecycleBody(skill: string): string {
  const match = skill.match(
    /<!-- BEGIN shared-lifecycle-contract:v1 -->\n[\s\S]*?<!-- END shared-lifecycle-contract -->/,
  );
  expect(match).not.toBeNull();
  return match![0];
}

describe("Codex and Claude Code plugin parity", () => {
  test("renders the machine workflow contract into both host adapters", () => {
    const template = read("plugins/shared/skills/semctx-control/SKILL.md");
    expect(template).toContain("{{SHARED_WORKFLOW_CONTRACT}}");

    for (const host of ["claude-code", "semctx-control"] as const) {
      const skill = read(skillPath(host));
      expect(skill).toContain("<!-- BEGIN shared-workflow-contract:v1 -->");
      expect(skill).toContain("<!-- END shared-workflow-contract -->");
      expect(skill).not.toContain("{{SHARED_WORKFLOW_CONTRACT}}");
      for (const stage of AGENT_WORKFLOW_CONTRACT_V1.stages) {
        expect(skill).toContain(`**${stage.id}**`);
        for (const tool of stage.mcpTools) expect(skill).toContain(tool);
      }
    }
  });

  test("renderControlSkill rejects a template without the host marker", () => {
    expect(() => renderControlSkill("claude-code", "# no marker\n")).toThrow(/HOST_CLI_LADDER/);
  });

  test("renderControlSkill rejects a template without the machine workflow marker", () => {
    expect(() => renderControlSkill(
      "claude-code",
      "# incomplete\n{{HOST_CLI_LADDER}}\n",
    )).toThrow(/SHARED_WORKFLOW_CONTRACT/);
  });

  test("renderControlSkill rejects a template without the machine lifecycle marker", () => {
    expect(() => renderControlSkill(
      "claude-code",
      "# incomplete\n{{SHARED_WORKFLOW_CONTRACT}}\n{{HOST_CLI_LADDER}}\n",
    )).toThrow(/SHARED_LIFECYCLE_CONTRACT/);
  });

  test("renderControlSkill rejects a template that embeds CLAUDE_PLUGIN_ROOT", () => {
    const bad = "# x\n{{SHARED_WORKFLOW_CONTRACT}}\n{{SHARED_LIFECYCLE_CONTRACT}}\n{{HOST_CLI_LADDER}}\n${CLAUDE_PLUGIN_ROOT}\n";
    expect(() => renderControlSkill("claude-code", bad)).toThrow(/CLAUDE_PLUGIN_ROOT/);
  });

  test("hostCliLadder option-A invariants (Claude plugin rung, Codex no relative dist)", () => {
    const claude = hostCliLadder("claude-code");
    expect(claude).toContain("Plugin-bundled CLI");
    expect(claude).toContain('bun "${CLAUDE_PLUGIN_ROOT}/dist/semctx.js"');
    expect(claude).toContain("semctx --version");
    // Plugin rung before global fallback in the ordered list.
    expect(claude.indexOf("Plugin-bundled CLI")).toBeLessThan(claude.indexOf("Global `semctx` on PATH"));

    const codex = hostCliLadder("semctx-control");
    expect(codex).not.toContain("CLAUDE_PLUGIN_ROOT");
    expect(codex).not.toContain("Plugin-bundled CLI");
    // Agent-runnable fence must not teach relative plugin paths (prose may name them as forbidden).
    const codexFence = codex.match(/```text\n([\s\S]*?)```/)?.[1] ?? "";
    expect(codexFence.length).toBeGreaterThan(0);
    expect(codexFence).not.toMatch(/bun\s+["']?\.\/dist\/semctx\.js/);
    expect(codexFence).toContain("semctx --version");
    expect(codex).toContain("does **not** substitute a plugin-root path");
  });

  test("ships one shared semctx-control workflow contract with host-generated CLI ladders", () => {
    const template = read("plugins/shared/skills/semctx-control/SKILL.md");
    expect(template).toContain("{{HOST_CLI_LADDER}}");
    expect(template).not.toContain("CLAUDE_PLUGIN_ROOT");

    const codex = read(skillPath("semctx-control"));
    const claude = read(skillPath("claude-code"));

    // Generated artifacts match the build (deterministic).
    expect(claude).toBe(renderControlSkill("claude-code", template));
    expect(codex).toBe(renderControlSkill("semctx-control", template));

    // Host-neutral body is still byte-identical across hosts.
    const shared = sharedContractBody(claude);
    expect(shared).toBe(sharedContractBody(codex));
    // Host leakage must live only inside the strip region.
    expect(shared).not.toContain("CLAUDE_PLUGIN_ROOT");
    expect(shared).not.toContain("Plugin-bundled CLI");
    expect(shared).not.toContain("host-cli-ladder");

    for (const required of [
      "semctx_control_status",
      "semctx_control_trace",
      "semctx_control_plan",
      "semctx_verify_change",
      "semctx_change_verify",
      "READY",
      "BLOCKED",
      "PARTIAL",
      "runtime tests",
      "Local equivalents when MCP is unavailable",
      "Top-down diagnostic frame",
      "L6 strategy/constraints",
      "L0 sealed observed hunks",
      "HIGHEST_BROKEN_LEVEL",
      "WHY_NOT_HIGHER",
      "WHY_NOT_LOWER",
      "PROOF_PLAN",
      "diagnosis-only task",
      "UNKNOWN - missing evidence",
      "not applicable",
    ]) {
      expect(shared).toContain(required);
    }
    expect(shared).not.toContain("L0 outcome");
    expect(shared).not.toContain("L5 implementation");
    expect(shared).not.toContain("reindex before");

    // Claude keeps the plugin-bundled placeholder rung.
    expect(claude).toContain("Plugin-bundled CLI");
    expect(claude).toContain('bun "${CLAUDE_PLUGIN_ROOT}/dist/semctx.js"');
    expect(claude).toContain("semctx --version");
    expect(claude).toContain(hostCliLadder("claude-code").trim());

    // Codex ships only host-working instructions — no Claude placeholder in any form.
    expect(codex).toContain("Global / CI CLI");
    expect(codex).toContain("semctx --version");
    expect(codex).toContain("semctx status --json");
    expect(codex).not.toContain("CLAUDE_PLUGIN_ROOT");
    expect(codex).not.toContain("Plugin-bundled CLI");
    const codexFence = codex.match(/```text\n([\s\S]*?)```/)?.[1] ?? "";
    expect(codexFence).not.toMatch(/bun\s+["']?\.\/dist\/semctx\.js/);
    expect(codex).toContain("does **not** substitute a plugin-root path");
  });

  test("ships one generated advisory lifecycle contract byte-identically across hosts", () => {
    const template = read("plugins/shared/skills/semctx-control/SKILL.md");
    expect(template).toContain("{{SHARED_LIFECYCLE_CONTRACT}}");

    const claude = read(skillPath("claude-code"));
    const codex = read(skillPath("semctx-control"));
    const lifecycle = sharedLifecycleBody(claude);

    expect(lifecycle).toBe(sharedLifecycleBody(codex));
    expect(renderSharedLifecycleContract()).toBe(renderSharedLifecycleContract());
    expect(lifecycle).toBe(renderSharedLifecycleContract());

    expect(lifecycle).toContain(AGENT_LIFECYCLE_POLICY_V1.mcpTool);
    for (const checkpoint of AGENT_LIFECYCLE_POLICY_V1.checkpoints) {
      expect(lifecycle).toContain(checkpoint.id);
    }
    for (const verdict of ["NO_OP", "RECORDED", "INCOMPLETE"]) {
      expect(lifecycle).toContain(verdict);
    }
    for (const stage of AGENT_LIFECYCLE_POLICY_V1.checkpoints[2].requiredStageIds.implementation) {
      expect(lifecycle).toContain(stage);
    }
    expect(lifecycle).toContain("L2");
    expect(lifecycle).toContain("handoff");
    expect(lifecycle).toContain("caller_observed_advisory");
    expect(lifecycle).toContain("stateless_caller_reinjected_unbound");
    expect(lifecycle).toContain("stage outcomes remain unevaluated");
    expect(lifecycle).toContain("shadow");
    expect(lifecycle).toContain("blocking is disabled");
    expect(lifecycle).toContain("execution authority is `none`");
    expect(lifecycle).toContain("hosts are instructed to invoke");
    expect(lifecycle).toContain("not automatic hooks");
  });

  // Claude Code substitutes ${CLAUDE_PLUGIN_ROOT} into skill/agent content, hook and monitor
  // commands, and MCP/LSP server fields — the placeholder form only, via /\$\{CLAUDE_PLUGIN_ROOT\}/g.
  // A bare $CLAUDE_PLUGIN_ROOT is never substituted; it survives into the agent's shell, which does
  // not receive the variable, and expands to nothing. The failure is silent: `bun "/dist/semctx.js"`.
  test("never ships a bare $CLAUDE_PLUGIN_ROOT — only the ${…} placeholder is substituted", () => {
    const shipped = [
      "plugins/claude-code/skills/semctx-control/SKILL.md",
      "plugins/claude-code/skills/semctx-semantic/SKILL.md",
      "plugins/claude-code/skills/semctx-verify/SKILL.md",
      "plugins/semctx-control/skills/semctx-control/SKILL.md",
      "plugins/shared/skills/semctx-control/SKILL.md",
      "plugins/claude-code/hooks/hooks.json",
      "plugins/claude-code/.mcp.json",
      "plugins/claude-code/README.md",
      "plugins/claude-code/examples/guard.json",
      "README.md",
      "docs/integrations/claude-code.md",
      "docs/integrations/claude-code-guarded-mode.md",
      "docs/integrations/codex-control-plane.md",
    ];
    expect(shipped.length).toBeGreaterThan(0);
    // Matches $CLAUDE_PLUGIN_ROOT only when it is NOT the ${…} form.
    const bare = /\$CLAUDE_PLUGIN_ROOT/;
    // Canary: a neutered pattern would leave this suite permanently green.
    expect(bare.test("$CLAUDE_PLUGIN_ROOT/dist/semctx.js")).toBe(true);
    expect(bare.test('bun "${CLAUDE_PLUGIN_ROOT}/dist/semctx.js"')).toBe(false);
    for (const path of shipped) {
      const offenders = read(path)
        .split("\n")
        .map((line, index) => ({ line, number: index + 1 }))
        .filter(({ line }) => bare.test(line));
      expect({ path, offenders }).toEqual({ path, offenders: [] });
    }
  });

  test("Codex plugin never ships CLAUDE_PLUGIN_ROOT in any form", () => {
    const anyForm = /CLAUDE_PLUGIN_ROOT/;
    expect(anyForm.test("${CLAUDE_PLUGIN_ROOT}")).toBe(true);
    expect(anyForm.test("$CLAUDE_PLUGIN_ROOT")).toBe(true);

    // Enumerated text surfaces (not dist/ binaries). Anti-neuter: list must stay non-empty.
    const codexTree = [
      "plugins/semctx-control/skills/semctx-control/SKILL.md",
      "plugins/semctx-control/.mcp.json",
      "plugins/semctx-control/.codex-plugin/plugin.json",
    ];
    expect(codexTree.length).toBeGreaterThan(0);
    for (const path of codexTree) {
      const offenders = read(path)
        .split("\n")
        .map((line, index) => ({ line, number: index + 1 }))
        .filter(({ line }) => anyForm.test(line));
      expect({ path, offenders }).toEqual({ path, offenders: [] });
    }
  });

  test("registers the same MCP server identity and compatible plugin versions", () => {
    const codexMcp = json<{
      mcpServers: {
        semctx: {
          command: string;
          args: string[];
          cwd?: string;
          default_tools_approval_mode?: string;
        };
      };
    }>(
      "plugins/semctx-control/.mcp.json",
    );
    const claudeMcp = json<{
      mcpServers: {
        semctx: {
          command: string;
          args: string[];
          env: Record<string, string>;
        };
      };
    }>(
      "plugins/claude-code/.mcp.json",
    );
    const codexManifest = json<{ version: string }>(
      "plugins/semctx-control/.codex-plugin/plugin.json",
    );
    const claudeManifest = json<{
      version: string;
      skills?: string;
      hooks?: string;
      mcpServers?: string;
    }>(
      "plugins/claude-code/.claude-plugin/plugin.json",
    );
    const marketplace = json<{
      name: string;
      plugins: Array<{ name: string; version: string }>;
    }>(
      ".claude-plugin/marketplace.json",
    );
    const codexMarketplace = json<{
      name: string;
      plugins: Array<{
        name: string;
        source: { source: string; path: string };
        policy?: { installation: string; authentication: string };
        category?: string;
      }>;
    }>(".agents/plugins/marketplace.json");

    expect(Object.keys(codexMcp.mcpServers)).toEqual(["semctx"]);
    expect(Object.keys(claudeMcp.mcpServers)).toEqual(["semctx"]);
    expect(codexMcp.mcpServers.semctx).toEqual({
      command: "bun",
      args: ["./dist/semctx-mcp.js"],
      cwd: ".",
      default_tools_approval_mode: "writes",
    });
    expect(claudeMcp.mcpServers.semctx.command).toBe("bun");
    expect(claudeMcp.mcpServers.semctx.args).toEqual([
      "${CLAUDE_PLUGIN_ROOT}/dist/semctx-mcp.js",
    ]);
    expect(claudeMcp.mcpServers.semctx.env).toEqual({
      SEMCTX_ROOT: "${CLAUDE_PROJECT_DIR}",
    });
    expect(existsSync(resolve(repoRoot, "plugins/claude-code/bin/semctx-mcp-launcher.ts"))).toBe(false);
    expect(read("plugins/claude-code/dist/semctx-mcp.js")).toBe(read("plugins/semctx-control/dist/semctx-mcp.js"));
    expect(existsSync(resolve(repoRoot, "plugins/claude-code/dist/semctx.js"))).toBe(true);
    expect(existsSync(resolve(repoRoot, "plugins/semctx-control/dist/semctx.js"))).toBe(true);
    expect(read("plugins/claude-code/dist/semctx.js")).toBe(read("plugins/semctx-control/dist/semctx.js"));
    const codexLibs = typescriptLibs("semctx-control");
    const claudeLibs = typescriptLibs("claude-code");
    expect(codexLibs.length).toBeGreaterThan(90);
    expect(codexLibs).toContain("lib.d.ts");
    expect(claudeLibs).toEqual(codexLibs);
    for (const lib of codexLibs) {
      expect(read(`plugins/claude-code/dist/typescript-lib/${lib}`)).toBe(
        read(`plugins/semctx-control/dist/typescript-lib/${lib}`),
      );
    }
    expect(codexManifest.version.split("+")[0]).toBe(claudeManifest.version.split("+")[0]);
    expect(claudeManifest.skills).toBeUndefined();
    expect(claudeManifest.hooks).toBeUndefined();
    expect(claudeManifest.mcpServers).toBeUndefined();
    expect(marketplace.plugins.find((plugin) => plugin.name === "semctx")?.version).toBe(
      claudeManifest.version,
    );
    expect(marketplace.name).toBe("semctx-stable");
    expect(codexMarketplace.name).toBe("semctx-stable");
    expect(codexMarketplace.plugins).toContainEqual({
      name: "semctx-control",
      source: { source: "local", path: "./plugins/semctx-control" },
      policy: {
        installation: "AVAILABLE",
        authentication: "ON_INSTALL",
      },
      category: "Productivity",
    });
    expect(json<{ version: string }>("packages/mcp-server/package.json").version).toBe(claudeManifest.version);
    expect(json<{ version: string }>("packages/app-services/package.json").version).toBe(claudeManifest.version);
    // Release SSOT: npm CLI package must ship the same release as the marketplace plugins/MCP.
    expect(json<{ version: string }>("apps/cli/package.json").version).toBe(claudeManifest.version);
    const serverSource = read("packages/mcp-server/src/server.ts");
    expect(serverSource).toContain('import packageJson from "../package.json"');
    expect(serverSource).toContain("version: packageJson.version");
  });

  test("publishes one verified artifact monotonically across npm, stable, and GitHub Release", () => {
    const workflow = read(".github/workflows/release.yml");
    expect(workflow).toContain("environment: npm");
    expect(workflow).toContain("fetch-depth: 0");
    expect(workflow).toContain("persist-credentials: false");
    expect(workflow).toContain("npm install --global npm@12.0.1");
    expect(workflow).toContain('git cat-file -t "$GITHUB_REF_NAME"');
    expect(workflow).toContain('git merge-base --is-ancestor "$GITHUB_SHA" origin/main');
    expect(workflow).toContain("npm_view_field()");
    expect(workflow).toContain("return 44");
    expect(workflow).toContain(
      'published_version="$(npm_view_field version)" || lookup_status=$?',
    );
    expect(workflow).toContain(
      'published_sha="$(npm_view_field gitHead)" || lookup_status=$?',
    );
    expect(workflow).not.toContain("gitHead --json");
    expect(workflow).not.toContain("|| true");
    expect(workflow).toContain(
      '"$published_version" != "$version" || "$published_sha" != "$GITHUB_SHA"',
    );
    expect(workflow).toContain("GH_TOKEN: ${{ github.token }}");
    expect(workflow).toContain('git/ref/heads/stable"');
    expect(workflow).toContain("-F force=false");
    expect(workflow).toContain("grep -q 'HTTP 404'");
    expect(workflow).not.toContain("credential.helper=!f()");
    expect(workflow).toContain("actions/upload-artifact@");
    expect(workflow).toContain("actions/download-artifact@");
    expect(workflow).toContain("sha256sum --check");
    expect(workflow).toContain("pkg.gitHead = process.env.GITHUB_SHA");

    const publish = workflow.indexOf('npm publish "$tarball" --access public --ignore-scripts');
    const confirm = workflow.indexOf('"$confirmed_sha" == "$GITHUB_SHA"');
    const stable = workflow.indexOf('git/ref/heads/stable"');
    const release = workflow.indexOf('gh release create "$GITHUB_REF_NAME"');
    expect(publish).toBeGreaterThanOrEqual(0);
    expect(confirm).toBeGreaterThan(publish);
    expect(stable).toBeGreaterThan(confirm);
    expect(release).toBeGreaterThan(stable);
  });

  test("documents the shared Plane A, B, and C workflow for both hosts", () => {
    const rootReadme = read("README.md");
    const claudeReadme = read("plugins/claude-code/README.md");
    const claudeGuide = read("docs/integrations/claude-code.md");
    const codexGuide = read("docs/integrations/codex-control-plane.md");

    for (const document of [rootReadme, claudeReadme, claudeGuide, codexGuide]) {
      expect(document).toContain("semctx_control_status");
      expect(document).toContain("semctx_control_trace");
      expect(document).toContain("semctx_control_plan");
      expect(document).toContain("semctx_control_agent_lifecycle");
      expect(document).toContain("before_implementation_write");
      expect(document).toContain("after_repository_edits");
      expect(document).toContain("before_completion");
      expect(document).toContain("before_compaction");
      expect(document).toContain("requiredAltitude");
      expect(document).toContain("NO_OP");
      expect(document).toContain("RECORDED");
      expect(document).toContain("INCOMPLETE");
      expect(document).toContain("caller_observed_advisory");
      expect(document).toContain("stateless_caller_reinjected_unbound");
      expect(document).toContain("no automatic lifecycle hooks");
      expect(document).toContain("READY");
      expect(document).toContain("execution authority");
    }
  });
});
