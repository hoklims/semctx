import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { McpServer } from "@modelcontextprotocol/server";
import { isSemctxError, createDefaultConfig, createGlobSelectionConfig } from "@semantic-context/core";
import { SAMPLE_REPO } from "@semantic-context/test-fixtures";
import {
  configPath,
  isInitialized,
  loadConfig,
  saveConfig,
  semctxDir,
} from "@semantic-context/repository-store";
import { createSemctxServer } from "../src/server";
import {
  SETUP_POLYGLOT_INPUT_DESCRIPTION,
  SETUP_POLYGLOT_V1_REFUSE_REASON_CODE,
  isSetupAgentSuccess,
  isSetupDomainFailure,
  setupTool,
  type SetupToolResult,
} from "../src/setup-tools";
import { TOOL_OUTPUT_SCHEMAS } from "../src/tool-output-schemas";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "semctx-test",
  GIT_AUTHOR_EMAIL: "semctx-test@example.com",
  GIT_COMMITTER_NAME: "semctx-test",
  GIT_COMMITTER_EMAIL: "semctx-test@example.com",
};

function git(cwd: string, ...args: string[]): void {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: GIT_ENV,
  });
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }
}

function assertKind<K extends SetupToolResult["kind"]>(
  report: SetupToolResult,
  kind: K,
): Extract<SetupToolResult, { kind: K }> {
  expect(report.kind).toBe(kind);
  return report as Extract<SetupToolResult, { kind: K }>;
}

describe("semctx_setup MCP tool", () => {
  let server: McpServer | undefined;
  let client: Client | undefined;
  let root: string | undefined;

  afterEach(async () => {
    await client?.close();
    await server?.close();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  function freshRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), "semctx-mcp-setup-"));
    cpSync(SAMPLE_REPO, dir, {
      recursive: true,
      filter: (src) => !src.includes(".semctx") && !src.includes("node_modules"),
    });
    git(dir, "init", "-q");
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", "fixture");
    return dir;
  }

  function expectConfigInvalid(run: () => unknown): void {
    try {
      run();
      expect.unreachable("expected CONFIG_INVALID throw");
    } catch (error) {
      expect(isSemctxError(error)).toBe(true);
      expect(isSemctxError(error) && error.code).toBe("CONFIG_INVALID");
    }
  }

  test("preflight refuses writes without confirm:true", () => {
    root = freshRepo();
    const omitted = assertKind(setupTool(root, {}), "setup_preflight");
    expect(omitted.initialized).toBe(false);
    expect(omitted.confirmRequired).toBe(true);
    expect(omitted.requiresUserAuthorization).toBe(true);
    // No auto-follow write bait: next.arguments must not embed confirm:true.
    expect(omitted.next.arguments).toEqual({ repositoryRoot: root });
    expect("confirm" in omitted.next.arguments).toBe(false);
    expect(omitted.message).toMatch(/Do not auto-follow/i);
    expect(isSetupDomainFailure(omitted)).toBe(false);
    expect(isSetupAgentSuccess(omitted)).toBe(false);
    expect(isInitialized(root)).toBe(false);
    expect(TOOL_OUTPUT_SCHEMAS.semctx_setup.safeParse(omitted).success).toBe(true);

    const explicitFalse = assertKind(setupTool(root, { confirm: false }), "setup_preflight");
    expect(explicitFalse.initialized).toBe(false);
    expect(isInitialized(root)).toBe(false);
  });

  test("preflight after init reports initialized without re-writing", () => {
    root = freshRepo();
    const first = assertKind(
      setupTool(root, { confirm: true, now: "2026-08-01T12:00:00.000Z" }),
      "setup",
    );
    expect(first.verdict).toBe("SETUP_READY");

    const preflight = assertKind(setupTool(root, {}), "setup_preflight");
    expect(preflight.initialized).toBe(true);
    expect(preflight.requiresUserAuthorization).toBe(true);
    expect(preflight.message).toMatch(/already has \.semctx/);
    expect("confirm" in preflight.next.arguments).toBe(false);
    expect(TOOL_OUTPUT_SCHEMAS.semctx_setup.safeParse(preflight).success).toBe(true);
  });

  test("preflight polyglot on existing v1 refuses without writes", () => {
    root = freshRepo();
    saveConfig(root, createDefaultConfig(root));
    const before = loadConfig(root);
    const report = assertKind(
      setupTool(root, { polyglot: true }),
      "setup_refused",
    );
    expect(report.reasonCode).toBe(SETUP_POLYGLOT_V1_REFUSE_REASON_CODE);
    expect(report.verdict).toBe("SETUP_REFUSED");
    expect(isSetupDomainFailure(report)).toBe(true);
    expect(isSetupAgentSuccess(report)).toBe(false);
    expect(loadConfig(root).version).toBe(before.version);
    expect(TOOL_OUTPUT_SCHEMAS.semctx_setup.safeParse(report).success).toBe(true);
  });

  test("preflight with malformed config fails closed even without polyglot (CONFIG_INVALID)", () => {
    root = freshRepo();
    const dir = root;
    mkdirSync(semctxDir(dir), { recursive: true });
    writeFileSync(configPath(dir), "{not-json\n", "utf8");
    expect(isInitialized(dir)).toBe(true);
    expectConfigInvalid(() => setupTool(dir, {}));
    expectConfigInvalid(() => setupTool(dir, { polyglot: true }));
  });

  test("preflight and confirm reject an invalid .gitignore before any workspace write", () => {
    root = freshRepo();
    const currentRoot = root;
    const gitignore = join(currentRoot, ".gitignore");
    rmSync(gitignore, { recursive: true, force: true });
    mkdirSync(gitignore);

    expectConfigInvalid(() => setupTool(currentRoot, {}));
    expectConfigInvalid(() => setupTool(currentRoot, { confirm: true, now: "2026-08-01T12:00:00.000Z" }));
    expect(existsSync(semctxDir(currentRoot))).toBe(false);
  });

  test("preflight with schema-invalid config fails closed even without polyglot (CONFIG_INVALID)", () => {
    root = freshRepo();
    const dir = root;
    mkdirSync(semctxDir(dir), { recursive: true });
    writeFileSync(
      configPath(dir),
      `${JSON.stringify({ version: 99, not: "a valid config" }, null, 2)}\n`,
      "utf8",
    );
    expect(isInitialized(dir)).toBe(true);
    expectConfigInvalid(() => setupTool(dir, {}));
    expectConfigInvalid(() => setupTool(dir, { polyglot: true }));
  });

  test("confirm:true with malformed config is catalogue CONFIG_INVALID", () => {
    root = freshRepo();
    const dir = root;
    mkdirSync(semctxDir(dir), { recursive: true });
    writeFileSync(configPath(dir), "{not-json\n", "utf8");
    expectConfigInvalid(() =>
      setupTool(dir, { confirm: true, now: "2026-08-01T12:00:00.000Z" }),
    );
  });

  test("confirm:true with schema-invalid config is catalogue CONFIG_INVALID", () => {
    root = freshRepo();
    const dir = root;
    mkdirSync(semctxDir(dir), { recursive: true });
    writeFileSync(
      configPath(dir),
      `${JSON.stringify({ version: 99, not: "a valid config" }, null, 2)}\n`,
      "utf8",
    );
    expectConfigInvalid(() =>
      setupTool(dir, { confirm: true, now: "2026-08-01T12:00:00.000Z" }),
    );
  });

  test("confirm:true bootstraps via shared setup path (no global CLI)", () => {
    root = freshRepo();
    const report = assertKind(
      setupTool(root, { confirm: true, now: "2026-08-01T12:00:00.000Z" }),
      "setup",
    );
    expect(report.setupReady).toBe(true);
    expect(report.verdict).toBe("SETUP_READY");
    expect(isSetupAgentSuccess(report)).toBe(true);
    expect(report.nodes).toBeGreaterThan(0);
    expect(report.semctxDir).toContain(".semctx");
    expect(isInitialized(root)).toBe(true);
    expect(TOOL_OUTPUT_SCHEMAS.semctx_setup.safeParse(report).success).toBe(true);
  });

  test("polyglot on existing v1 config returns setup_refused with guidance", () => {
    root = freshRepo();
    saveConfig(root, createDefaultConfig(root));
    const report = assertKind(
      setupTool(root, { confirm: true, polyglot: true, now: "2026-08-01T12:00:00.000Z" }),
      "setup_refused",
    );
    expect(report.reasonCode).toBe(SETUP_POLYGLOT_V1_REFUSE_REASON_CODE);
    expect(report.verdict).toBe("SETUP_REFUSED");
    expect(isSetupDomainFailure(report)).toBe(true);
    expect(report.nextSteps.length).toBeGreaterThan(0);
    expect(TOOL_OUTPUT_SCHEMAS.semctx_setup.safeParse(report).success).toBe(true);
  });

  test("preflight and confirmed setup expose identical polyglot refusal contract", () => {
    // Deep parity: MCP preflight and confirm paths must both consume app-services
    // evaluatePolyglotSetupPolicy — no second refuse literal in the transport.
    root = freshRepo();
    saveConfig(root, createDefaultConfig(root));
    const preflight = assertKind(
      setupTool(root, { polyglot: true }),
      "setup_refused",
    );
    const confirmed = assertKind(
      setupTool(root, { confirm: true, polyglot: true, now: "2026-08-01T12:00:00.000Z" }),
      "setup_refused",
    );
    expect(preflight).toEqual(confirmed);
    expect(preflight.reasonCode).toBe(SETUP_POLYGLOT_V1_REFUSE_REASON_CODE);
    expect(preflight.reason).toBe(confirmed.reason);
    expect(preflight.nextSteps).toEqual(confirmed.nextSteps);
    expect(preflight.verdict).toBe("SETUP_REFUSED");
    expect(preflight.configVersion).toBe(1);
    expect(preflight.setupReady).toBe(false);
    expect(preflight.analysisReady).toBe(false);
    expect(preflight.alreadyInitialized).toBe(true);
    expect(preflight.polyglot).toBe(true);
    expect(isSetupAgentSuccess(preflight)).toBe(false);
    expect(isSetupDomainFailure(preflight)).toBe(true);
    expect(TOOL_OUTPUT_SCHEMAS.semctx_setup.safeParse(preflight).success).toBe(true);
    expect(TOOL_OUTPUT_SCHEMAS.semctx_setup.safeParse(confirmed).success).toBe(true);
    // No mutation on either refuse path: config stays v1, no graph index created.
    expect(loadConfig(root).version).toBe(1);
    expect(existsSync(join(semctxDir(root), "index.sqlite"))).toBe(false);
  });

  test("not-ready analysis surfaces verdict SETUP_NOT_READY", () => {
    root = mkdtempSync(join(tmpdir(), "semctx-mcp-setup-nr-"));
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "value.py"), "def value():\n    return 1\n");
    writeFileSync(join(root, ".gitignore"), ".semctx/\n");
    git(root, "init", "-q");
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "fixture");
    const base = createGlobSelectionConfig(root);
    saveConfig(root, {
      ...base,
      languages: { ...base.languages, python: "off" },
    });

    const report = assertKind(
      setupTool(root, { confirm: true, now: "2026-08-01T12:00:00.000Z" }),
      "setup",
    );
    expect(report.setupReady).toBe(false);
    expect(report.verdict).toBe("SETUP_NOT_READY");
    expect(isSetupDomainFailure(report)).toBe(true);
    const coverage = report.indexHealth.coverage as { status: string };
    expect(coverage.status).toBe("insufficient");
    expect(TOOL_OUTPUT_SCHEMAS.semctx_setup.safeParse(report).success).toBe(true);
  });

  test("schema rejects malformed setup payloads", () => {
    expect(TOOL_OUTPUT_SCHEMAS.semctx_setup.safeParse({ kind: "setup" }).success).toBe(false);
    expect(TOOL_OUTPUT_SCHEMAS.semctx_setup.safeParse({
      schemaVersion: 1,
      kind: "setup_refused",
      confirmRequired: false,
    }).success).toBe(false);

    const baseSetup = {
      schemaVersion: 1 as const,
      kind: "setup" as const,
      repositoryRoot: "/tmp/x",
      configWritten: true,
      semctxDir: "/tmp/x/.semctx",
      alreadyInitialized: false,
      polyglot: false,
      sourceFiles: 0,
      selectedFiles: 0,
      selection: {
        configVersion: 1,
        mode: "legacy-v1",
        selectedByLanguage: {},
        excluded: 0,
        disabled: 0,
        unsupported: 0,
        failed: 0,
      },
      nodes: 0,
      edges: 0,
      claims: 0,
      freshnessSeal: null,
      indexHealth: {
        binding: { status: "valid" as const },
        freshness: { canRunHighRiskControl: true },
        coverage: { status: "partial" as const },
        workspaceDiagnostics: [] as unknown[],
        reasonSummary: [] as unknown[],
      },
      semanticFilesCreated: 0,
      gitignore: "create" as const,
      check: { ok: true, nodes: 0, changes: 0, errors: 0 },
      setupReady: true,
      analysisReady: true,
      verdict: "SETUP_READY" as const,
    };

    expect(TOOL_OUTPUT_SCHEMAS.semctx_setup.safeParse({
      ...baseSetup,
      verdict: "READY",
    }).success).toBe(false);

    expect(TOOL_OUTPUT_SCHEMAS.semctx_setup.safeParse(baseSetup).success).toBe(true);
    expect(TOOL_OUTPUT_SCHEMAS.semctx_setup.safeParse({
      ...baseSetup,
      setupReady: false,
      analysisReady: false,
      verdict: "SETUP_NOT_READY",
      indexHealth: {
        ...baseSetup.indexHealth,
        coverage: { status: "insufficient" as const },
      },
    }).success).toBe(true);
    expect(TOOL_OUTPUT_SCHEMAS.semctx_setup.safeParse({
      ...baseSetup,
      setupReady: false,
      verdict: "SETUP_READY",
    }).success).toBe(false);
    expect(TOOL_OUTPUT_SCHEMAS.semctx_setup.safeParse({
      ...baseSetup,
      analysisReady: false,
      setupReady: false,
      verdict: "SETUP_READY",
    }).success).toBe(false);
    expect(TOOL_OUTPUT_SCHEMAS.semctx_setup.safeParse({
      ...baseSetup,
      check: { ok: false, nodes: 0, changes: 0, errors: 1 },
      setupReady: false,
      verdict: "SETUP_READY",
    }).success).toBe(false);
    expect(TOOL_OUTPUT_SCHEMAS.semctx_setup.safeParse({
      ...baseSetup,
      indexHealth: {
        ...baseSetup.indexHealth,
        coverage: { status: "insufficient" as const },
      },
    }).success).toBe(false);
    expect(TOOL_OUTPUT_SCHEMAS.semctx_setup.safeParse({
      ...baseSetup,
      indexHealth: {
        ...baseSetup.indexHealth,
        binding: { status: "invalid" as const },
      },
    }).success).toBe(false);
    expect(TOOL_OUTPUT_SCHEMAS.semctx_setup.safeParse({
      ...baseSetup,
      indexHealth: {
        ...baseSetup.indexHealth,
        freshness: { canRunHighRiskControl: false },
      },
    }).success).toBe(false);
    expect(TOOL_OUTPUT_SCHEMAS.semctx_setup.safeParse({
      ...baseSetup,
      setupReady: true,
      analysisReady: true,
      verdict: "SETUP_NOT_READY",
    }).success).toBe(false);
  });

  test("MCP wire: READY success; refuse/NOT_READY are structured domain results (isError false)", async () => {
    root = freshRepo();
    server = createSemctxServer(root);
    client = new Client({ name: "semctx-setup-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const { tools } = await client.listTools();
    const tool = tools.find((candidate) => candidate.name === "semctx_setup");
    expect(tool?.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    expect(tool?.description).toContain("SETUP_READY");
    expect(tool?.inputSchema.required).toContain("repositoryRoot");

    const preflight = await client.callTool({
      name: "semctx_setup",
      arguments: { repositoryRoot: root },
    });
    expect(preflight.isError).not.toBe(true);
    expect((preflight.structuredContent as { kind?: string }).kind).toBe("setup_preflight");

    const applied = await client.callTool({
      name: "semctx_setup",
      arguments: { repositoryRoot: root, confirm: true },
    });
    expect(applied.isError).not.toBe(true);
    const ready = applied.structuredContent as {
      kind?: string;
      verdict?: string;
      nodes?: number;
      semctxDir?: string;
      indexHealth?: { coverage?: { status?: string } };
    };
    expect(ready.kind).toBe("setup");
    expect(ready.verdict).toBe("SETUP_READY");
    expect((ready.nodes ?? 0)).toBeGreaterThan(0);
    expect(ready.semctxDir).toContain(".semctx");
    expect(ready.indexHealth?.coverage?.status).toMatch(/^(complete|partial)$/);
    expect(TOOL_OUTPUT_SCHEMAS.semctx_setup.safeParse(ready).success).toBe(true);

    const refused = await client.callTool({
      name: "semctx_setup",
      arguments: { repositoryRoot: root, confirm: true, polyglot: true },
    });
    expect(refused.isError).not.toBe(true);
    expect((refused.structuredContent as { kind?: string }).kind).toBe("setup_refused");
    const refusedBody = refused.structuredContent as {
      verdict?: string;
      reasonCode?: string;
      nextSteps?: string[];
    };
    expect(refusedBody.verdict).toBe("SETUP_REFUSED");
    expect(refusedBody.reasonCode).toBe(SETUP_POLYGLOT_V1_REFUSE_REASON_CODE);
    expect((refusedBody.nextSteps ?? []).length).toBeGreaterThan(0);
    expect(TOOL_OUTPUT_SCHEMAS.semctx_setup.safeParse(refused.structuredContent).success).toBe(true);
  });

  test("MCP metadata: polyglot description names canonical refuse reasonCode (no CONFIG_INVALID drift)", async () => {
    root = freshRepo();
    server = createSemctxServer(root);
    client = new Client({ name: "semctx-setup-meta", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const { tools } = await client.listTools();
    const tool = tools.find((candidate) => candidate.name === "semctx_setup");
    const polyglotProp = (tool?.inputSchema as {
      properties?: { polyglot?: { description?: string } };
    })?.properties?.polyglot;
    expect(polyglotProp?.description).toBe(SETUP_POLYGLOT_INPUT_DESCRIPTION);
    expect(polyglotProp?.description).toContain(SETUP_POLYGLOT_V1_REFUSE_REASON_CODE);
    expect(polyglotProp?.description).not.toContain("CONFIG_INVALID");
  });

  test("MCP wire: malformed config + polyglot preflight is catalogue CONFIG_INVALID (not setup_preflight)", async () => {
    root = freshRepo();
    mkdirSync(semctxDir(root), { recursive: true });
    writeFileSync(configPath(root), "{not-json\n", "utf8");
    server = createSemctxServer(root);
    client = new Client({ name: "semctx-setup-bad-cfg", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const result = await client.callTool({
      name: "semctx_setup",
      arguments: { repositoryRoot: root, polyglot: true },
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    const text = result.content.find((item) => item.type === "text")?.text ?? "";
    expect(JSON.parse(text)).toEqual({
      code: "CONFIG_INVALID",
      error: "Semctx configuration is invalid",
    });
  });

  test("MCP wire: SETUP_NOT_READY is structured body with isError false (ADR 0012)", async () => {
    root = mkdtempSync(join(tmpdir(), "semctx-mcp-setup-wire-nr-"));
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "value.py"), "def value():\n    return 1\n");
    writeFileSync(join(root, ".gitignore"), ".semctx/\n");
    git(root, "init", "-q");
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "fixture");
    const base = createGlobSelectionConfig(root);
    saveConfig(root, {
      ...base,
      languages: { ...base.languages, python: "off" },
    });

    server = createSemctxServer(root);
    client = new Client({ name: "semctx-setup-nr-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const result = await client.callTool({
      name: "semctx_setup",
      arguments: { repositoryRoot: root, confirm: true },
    });
    expect(result.isError).not.toBe(true);
    const body = result.structuredContent as {
      kind?: string;
      verdict?: string;
      setupReady?: boolean;
      indexHealth?: { coverage?: { status?: string }; freshness?: { canRunHighRiskControl?: boolean } };
    };
    expect(body.kind).toBe("setup");
    expect(body.verdict).toBe("SETUP_NOT_READY");
    expect(body.setupReady).toBe(false);
    expect(body.indexHealth?.coverage?.status).toBe("insufficient");
    expect(body.indexHealth?.freshness?.canRunHighRiskControl).toBe(true);
    expect(TOOL_OUTPUT_SCHEMAS.semctx_setup.safeParse(body).success).toBe(true);
  });
});
