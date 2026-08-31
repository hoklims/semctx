import { afterEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createDefaultConfig, createGlobSelectionConfig } from "@semantic-context/core";
import { initWorkspace, saveConfig } from "@semantic-context/repository-store";
import { indexRepository } from "@semantic-context/app-services";
import { SAMPLE_REPO } from "@semantic-context/test-fixtures";
import packageJson from "../../../apps/cli/package.json";

const repoRoot = resolve(import.meta.dir, "../../..");
const pluginDist = resolve(repoRoot, "plugins/semctx-control/dist");
const temporary: string[] = [];

// Copy ~8 MB of bundles + typescript-lib, git-init a fixture, then spawn several 4 MB bun processes
// including full `setup` indexing. ~0.5s on Linux; 15-26s on a Windows runner (same class as the
// L6-L0 fixture). Budget for the slow platform rather than the 5s bun default.
const PACKAGED_SMOKE_TIMEOUT_MS = 120_000;

function git(cwd: string, ...args: string[]): void {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
}

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("packaged MCP runtime", () => {
  test(
    "ships a portable plugin CLI next to the MCP runtime",
    () => {
    const bundle = resolve(pluginDist, "semctx.js");
    expect(existsSync(bundle)).toBe(true);
    const runtime = readFileSync(bundle, "utf8");
    expect(runtime).not.toContain(JSON.stringify(repoRoot).slice(1, -1));
    expect(runtime).not.toMatch(/typescript@[^"']+node_modules[^"']+typescript[^"']+lib/);

    const cache = mkdtempSync(resolve(tmpdir(), "semctx-plugin-cli-cache-"));
    const target = mkdtempSync(resolve(tmpdir(), "semctx-plugin-cli-target-"));
    temporary.push(cache, target);
    const packagedDist = resolve(cache, "dist");
    cpSync(pluginDist, packagedDist, { recursive: true });
    const packagedCli = resolve(packagedDist, "semctx.js");
    const help = Bun.spawnSync(["bun", packagedCli, "--help"], {
      cwd: cache,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(help.exitCode).toBe(0);
    const helpText = new TextDecoder().decode(help.stdout);
    expect(helpText).toContain("semctx — repository change-impact analyzer");
    expect(helpText).toContain("verify diff");

    // Behavioural smoke beyond --help: portable CLI must index/status a foreign repo.
    cpSync(SAMPLE_REPO, target, {
      recursive: true,
      filter: (src) => !src.includes(".semctx") && !src.includes("node_modules"),
    });
    git(target, "init");
    git(target, "add", ".");
    git(target, "-c", "user.name=Semctx Test", "-c", "user.email=semctx@example.test", "commit", "-m", "fixture");
    const setup = Bun.spawnSync(["bun", packagedCli, "setup", "--root", target], {
      cwd: cache,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(setup.exitCode).toBe(0);
    const doctor = Bun.spawnSync(["bun", packagedCli, "doctor", "--root", target, "--json"], {
      cwd: cache,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(doctor.exitCode).toBe(0);
    const doctorPayload = JSON.parse(new TextDecoder().decode(doctor.stdout));
    expect(doctorPayload.healthy).toBe(true);
    expect(doctorPayload.version).toBe(packageJson.version);
    const health = Bun.spawnSync(
      ["bun", packagedCli, "index-health", "--root", target, "--json"],
      { cwd: cache, stdout: "pipe", stderr: "pipe" },
    );
    expect(health.exitCode).toBe(2);
    const healthPayload = JSON.parse(new TextDecoder().decode(health.stdout));
    expect(healthPayload.kind).toBe("index_health");
    expect(healthPayload.binding.status).toBe("valid");
    expect(healthPayload.coverage.status).toBe("partial");
    const dryRun = Bun.spawnSync(
      ["bun", packagedCli, "verify", "diff", "--root", target, "--dry-run"],
      { cwd: cache, stdout: "pipe", stderr: "pipe" },
    );
    expect(dryRun.exitCode).toBe(0);
  },
    PACKAGED_SMOKE_TIMEOUT_MS,
  );

  test(
    "starts outside the checkout and targets an explicit Codex repository root",
    async () => {
    const cache = mkdtempSync(resolve(tmpdir(), "semctx-plugin-cache-"));
    const target = mkdtempSync(resolve(tmpdir(), "semctx-plugin-target-"));
    temporary.push(cache, target);
    const packagedDist = resolve(cache, "dist");
    cpSync(pluginDist, packagedDist, { recursive: true });
    const bundle = resolve(packagedDist, "semctx-mcp.js");
    const runtime = readFileSync(bundle, "utf8");
    expect(runtime).not.toContain(JSON.stringify(repoRoot).slice(1, -1));
    expect(runtime).not.toMatch(/typescript@[^"']+node_modules[^"']+typescript[^"']+lib/);
    cpSync(SAMPLE_REPO, target, { recursive: true, filter: (src) => !src.includes(".semctx") && !src.includes("node_modules") });
    git(target, "init");
    initWorkspace(target);
    git(target, "add", ".");
    git(target, "-c", "user.name=Semctx Test", "-c", "user.email=semctx@example.test", "commit", "-m", "fixture");
    indexRepository(target, "2026-07-20T00:00:00.000Z");

    const environment = Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
    );
    delete environment["SEMCTX_ROOT"];
    const transport = new StdioClientTransport({ command: "bun", args: [bundle], cwd: cache, env: environment, stderr: "pipe" });
    const client = new Client({ name: "semctx-packaged-runtime-test", version: "0.1.0" });
    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(38);
      expect(tools.some((tool) => tool.name === "semctx_control_agent_lifecycle")).toBe(true);
      expect(tools.some((tool) => tool.name === "semctx_cli_compatibility")).toBe(true);
      expect(tools.some((tool) => tool.name === "semctx_control_explorer")).toBe(true);
      expect(tools.some((tool) => tool.name === "semctx_semantic_check")).toBe(true);
      expect(tools.some((tool) => tool.name === "semctx_control_authority")).toBe(true);
      expect(tools.some((tool) => tool.name === "semctx_index_health")).toBe(true);
      expect(tools.some((tool) => tool.name === "semctx_setup")).toBe(true);
      expect(tools.some((tool) => tool.name === "semctx_control_frame_task")).toBe(true);
      expect(tools.some((tool) => tool.name === "semctx_control_bind_scope")).toBe(true);
      expect(tools.some((tool) => tool.name === "semctx_control_target_propose")).toBe(true);
      expect(tools.some((tool) => tool.name === "semctx_change_close")).toBe(true);
      expect(tools.some((tool) => tool.name === "semctx_control_plan_change")).toBe(true);
      expect(tools.some((tool) => tool.name === "semctx_control_reconcile_diff")).toBe(true);
      expect(tools.some((tool) => tool.name === "semctx_control_handoff")).toBe(true);
      expect(tools.some((tool) => tool.name === "semctx_control_resume")).toBe(true);
      expect(tools.some((tool) => tool.name === "control_authorize_transition")).toBe(true);
      expect(tools.some((tool) => tool.name === "control_authorize_step")).toBe(true);
      expect(tools.some((tool) => tool.name === "control_authorize_deletion")).toBe(true);
      const status = await client.callTool({
        name: "semctx_control_status",
        arguments: { repositoryRoot: target },
      });
      expect(status.isError).not.toBe(true);
      if (!Array.isArray(status.content)) throw new Error("MCP status content must be an array");
      const statusBlock = status.content[0];
      if (typeof statusBlock !== "object" || statusBlock === null || !("type" in statusBlock)) {
        throw new Error("MCP status must contain a typed content block");
      }
      const statusPayload = JSON.parse(
        statusBlock.type === "text" && "text" in statusBlock && typeof statusBlock.text === "string"
          ? statusBlock.text
          : "{}",
      );
      expect(statusPayload.verdict).toBe("FRESH");
      const health = await client.callTool({
        name: "semctx_index_health",
        arguments: { repositoryRoot: target },
      });
      expect(health.isError).not.toBe(true);
      if (!Array.isArray(health.content)) throw new Error("MCP health content must be an array");
      const healthBlock = health.content[0];
      if (healthBlock?.type !== "text") throw new Error("MCP health must contain text");
      const healthPayload = JSON.parse(healthBlock.text);
      expect(healthPayload.kind).toBe("index_health");
      expect(healthPayload.binding.status).toBe("valid");
      const response = await client.callTool({
        name: "semctx_verify_change",
        arguments: {
          repositoryRoot: target,
          gitDiff: [
            "diff --git a/noop.ts b/noop.ts",
            "--- a/noop.ts",
            "+++ b/noop.ts",
            "@@ -1 +1 @@",
            "-old",
            "+new",
          ].join("\n"),
        },
      });
      expect(response.isError).not.toBe(true);
      if (!Array.isArray(response.content)) throw new Error("MCP response content must be an array");
      const first = response.content[0];
      if (typeof first !== "object" || first === null || !("type" in first)) {
        throw new Error("MCP response must contain a typed content block");
      }
      expect(first?.type).toBe("text");
      const payload = JSON.parse(first.type === "text" && "text" in first && typeof first.text === "string" ? first.text : "{}");
      expect(payload.schemaVersion).toBe(1);
      expect(payload.head).toBe("(provided)");
    } finally {
      await client.close();
    }
  },
    PACKAGED_SMOKE_TIMEOUT_MS,
  );

  test(
    "packaged semctx_setup: preflight no-write, confirm bootstrap, structured NOT_READY and refuse",
    async () => {
      // Server pins the first repositoryRoot per process — use one MCP child per fixture.
      const cache = mkdtempSync(resolve(tmpdir(), "semctx-setup-smoke-cache-"));
      const fresh = mkdtempSync(resolve(tmpdir(), "semctx-setup-smoke-fresh-"));
      const notReady = mkdtempSync(resolve(tmpdir(), "semctx-setup-smoke-nr-"));
      const refuse = mkdtempSync(resolve(tmpdir(), "semctx-setup-smoke-refuse-"));
      temporary.push(cache, fresh, notReady, refuse);
      const packagedDist = resolve(cache, "dist");
      cpSync(pluginDist, packagedDist, { recursive: true });
      const bundle = resolve(packagedDist, "semctx-mcp.js");

      cpSync(SAMPLE_REPO, fresh, {
        recursive: true,
        filter: (src) => !src.includes(".semctx") && !src.includes("node_modules"),
      });
      git(fresh, "init");
      git(fresh, "add", ".");
      git(fresh, "-c", "user.name=Semctx Test", "-c", "user.email=semctx@example.test", "commit", "-m", "fixture");

      mkdirSync(join(notReady, "src"), { recursive: true });
      writeFileSync(join(notReady, "src", "value.py"), "def value():\n    return 1\n");
      writeFileSync(join(notReady, ".gitignore"), ".semctx/\n");
      git(notReady, "init");
      git(notReady, "add", ".");
      git(notReady, "-c", "user.name=Semctx Test", "-c", "user.email=semctx@example.test", "commit", "-m", "fixture");
      const base = createGlobSelectionConfig(notReady);
      saveConfig(notReady, {
        ...base,
        languages: { ...base.languages, python: "off" },
      });

      mkdirSync(join(refuse, "src"), { recursive: true });
      writeFileSync(join(refuse, "src", "value.ts"), "export const value = 1;\n");
      writeFileSync(join(refuse, ".gitignore"), ".semctx/\n");
      git(refuse, "init");
      git(refuse, "add", ".");
      git(refuse, "-c", "user.name=Semctx Test", "-c", "user.email=semctx@example.test", "commit", "-m", "fixture");
      saveConfig(refuse, createDefaultConfig(refuse));

      const environment = Object.fromEntries(
        Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
      );
      delete environment["SEMCTX_ROOT"];

      async function withPackagedClient<T>(
        fn: (client: Client) => Promise<T>,
      ): Promise<T> {
        const transport = new StdioClientTransport({
          command: "bun",
          args: [bundle],
          cwd: cache,
          env: environment,
          stderr: "pipe",
        });
        const client = new Client({ name: "semctx-setup-packaged-smoke", version: "0.1.0" });
        await client.connect(transport);
        try {
          return await fn(client);
        } finally {
          await client.close();
        }
      }

      await withPackagedClient(async (client) => {
        const preflight = await client.callTool({
          name: "semctx_setup",
          arguments: { repositoryRoot: fresh },
        });
        expect(preflight.isError).not.toBe(true);
        expect((preflight.structuredContent as { kind?: string }).kind).toBe("setup_preflight");
        expect(existsSync(join(fresh, ".semctx"))).toBe(false);

        const applied = await client.callTool({
          name: "semctx_setup",
          arguments: { repositoryRoot: fresh, confirm: true },
        });
        expect(applied.isError).not.toBe(true);
        const ready = applied.structuredContent as {
          kind?: string;
          verdict?: string;
          indexHealth?: { coverage?: { status?: string } };
        };
        expect(ready.kind).toBe("setup");
        expect(ready.verdict).toBe("SETUP_READY");
        expect(ready.indexHealth?.coverage?.status).toMatch(/^(complete|partial)$/);
        expect(existsSync(join(fresh, ".semctx", "config.json"))).toBe(true);
      });

      await withPackagedClient(async (client) => {
        const nr = await client.callTool({
          name: "semctx_setup",
          arguments: { repositoryRoot: notReady, confirm: true },
        });
        // Domain not-ready: structured result, isError false (ADR 0012).
        expect(nr.isError).not.toBe(true);
        const nrBody = nr.structuredContent as { kind?: string; verdict?: string };
        expect(nrBody.kind).toBe("setup");
        expect(nrBody.verdict).toBe("SETUP_NOT_READY");
      });

      await withPackagedClient(async (client) => {
        const refused = await client.callTool({
          name: "semctx_setup",
          arguments: { repositoryRoot: refuse, confirm: true, polyglot: true },
        });
        expect(refused.isError).not.toBe(true);
        const refusedBody = refused.structuredContent as {
          kind?: string;
          verdict?: string;
          nextSteps?: string[];
        };
        expect(refusedBody.kind).toBe("setup_refused");
        expect(refusedBody.verdict).toBe("SETUP_REFUSED");
        expect((refusedBody.nextSteps ?? []).length).toBeGreaterThan(0);
      });
    },
    PACKAGED_SMOKE_TIMEOUT_MS,
  );
});
