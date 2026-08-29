/**
 * The MCP transport is the third surface that must say the same thing about a broken anchor.
 *
 * Validating hand-written literals against the output schema proves the schema is well-formed, not
 * that the tool emits what it declares. These oracles run the real tool over a real indexed
 * repository and push its actual output through the registered output schema, so a code the engine
 * invents and the schema does not know is a failure here rather than a surprise at runtime.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SAMPLE_REPO } from "@semantic-context/test-fixtures";
import { indexRepository } from "@semantic-context/app-services";
import { initWorkspace, openStore } from "@semantic-context/repository-store";
import { initSemanticScaffold } from "@semantic-context/semantic-engine";
import { CanonicalLinkResolutionSchema } from "@semantic-context/control-model";
import { semanticCheckTool } from "../src/semantic-tools";
import { TOOL_OUTPUT_SCHEMAS } from "../src/tool-output-schemas";
import { parseArgs } from "../../../apps/cli/src/args";
import { runSemantic } from "../../../apps/cli/src/commands/semantic";

let root: string;
let known: { canonical: string; relPath: string; name: string };
let indexedAt = 0;

function git(cwd: string, ...args: string[]): void {
  const result = Bun.spawnSync(
    ["git", "-c", "user.name=Semctx Test", "-c", "user.email=semctx@example.test", ...args],
    { cwd, stdout: "pipe", stderr: "pipe" },
  );
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
}

/** Author one record carrying the given links, and re-index so the seal covers it. */
function authorLinks(kind: "invariant" | "evidence", id: string, refs: readonly string[]): void {
  mkdirSync(join(root, ".semctx", "semantic"), { recursive: true });
  writeFileSync(
    join(root, ".semctx", "semantic", "anchors.sem"),
    [
      `${kind} ${id}`,
      "  statement: the anchored coordinate is what this record is about",
      "  status: declared",
      ...refs.map((ref) => `  link: ${ref}`),
      "",
    ].join("\n"),
    "utf8",
  );
  indexedAt += 1;
  indexRepository(root, new Date(Date.UTC(2026, 0, 1, 0, indexedAt)).toISOString());
}

/** The tool's real output, run through the schema the MCP server publishes for it. */
function checked(): ReturnType<typeof semanticCheckTool> {
  const report = semanticCheckTool(root);
  const parsed = TOOL_OUTPUT_SCHEMAS.semctx_semantic_check.safeParse(
    JSON.parse(JSON.stringify(report)),
  );
  if (!parsed.success) throw new Error(`output violates its published schema: ${parsed.error.message}`);
  return report;
}

function cli(argv: string[]): { code: number; output: string } {
  const originalWrite = process.stdout.write.bind(process.stdout);
  let output = "";
  (process.stdout.write as unknown) = (chunk: string): boolean => {
    output += chunk;
    return true;
  };
  try {
    return {
      code: runSemantic(root, parseArgs([...argv, "--root", root])),
      output,
    };
  } finally {
    process.stdout.write = originalWrite;
  }
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "semctx-anchor-mcp-"));
  cpSync(SAMPLE_REPO, root, {
    recursive: true,
    filter: (src) => !src.includes(".semctx") && !src.includes("node_modules"),
  });
  writeFileSync(join(root, ".gitignore"), ".semctx/\n", "utf8");
  git(root, "init", "-q");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "fixture");
  initWorkspace(root);
  initSemanticScaffold(root);
  indexRepository(root, "2026-01-01T00:00:00.000Z");

  const store = openStore(root);
  try {
    const byKey = new Map<string, string[]>();
    for (const node of store.loadGraph().nodes) {
      const parts = node.id.split(":");
      if (parts.length !== 4 || parts[0] !== "sym" || parts[1] !== "function") continue;
      byKey.set(`${parts[2]} ${parts[3]}`, [...(byKey.get(`${parts[2]} ${parts[3]}`) ?? []), node.id]);
    }
    const unique = [...byKey.entries()]
      .filter(([key, ids]) => ids.length === 1 && !key.split(" ")[1]!.includes("."))
      .sort(([left], [right]) => (left < right ? -1 : 1))[0];
    if (unique === undefined) throw new Error("sample repository has no uniquely named function");
    const [relPath, name] = unique[0].split(" ") as [string, string];
    known = { canonical: unique[1][0]!, relPath, name };
  } finally {
    store.close();
  }
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("semctx_semantic_check — anchor diagnostics over MCP", () => {
  it("publishes role_removed with its candidates, inside its declared schema", () => {
    authorLinks("evidence", "evidence.mcp.role", [`sym:class:${known.relPath}:${known.name}`]);

    const report = checked();

    expect(report.staleLinks).toHaveLength(1);
    expect(report.staleLinks[0]!.reasonCode).toBe("role_removed");
    expect(report.staleLinks[0]!.candidates).toEqual([known.canonical]);
    expect(report.reasonCodes).toContain("STALE_REPOSITORY_LINK");
  });

  it("publishes symbol_gone", () => {
    authorLinks("evidence", "evidence.mcp.gone", ["sym:function:src/nowhere.ts:vanished"]);

    expect(checked().staleLinks[0]!.reasonCode).toBe("symbol_gone");
  });

  it("publishes ambiguous for an ordinal-bearing anchor and hands back no target", () => {
    authorLinks("evidence", "evidence.mcp.ordinal", [
      `sym:function:${known.relPath}:${known.name}#2`,
    ]);

    const report = checked();
    expect(report.staleLinks[0]!.reasonCode).toBe("ambiguous");
    expect(report.staleLinks[0]!.resolved).toBe(false);
  });

  it("publishes DURABLE_ANCHOR_IS_TRANSIENT with the exact finding shape", () => {
    authorLinks("invariant", "invariant.mcp.durable", [known.canonical]);

    const report = checked();

    expect(report.reasonCodes).toContain("DURABLE_ANCHOR_IS_TRANSIENT");
    expect(report.anchorFindings).toContainEqual({
      code: "DURABLE_ANCHOR_IS_TRANSIENT",
      severity: "warning",
      ownerId: "invariant.mcp.durable",
      ownerKind: "invariant",
      ref: known.canonical,
      message: `invariant "invariant.mcp.durable" anchors on a symbol coordinate (${known.canonical}); durable intent should anchor on inv:, cap: or contract:`,
    });
    expect(report.ok).toBe(true);
  });

  it("publishes DEPRECATED_SYMBOL_ANCHOR for a link that survived on the legacy form", () => {
    const legacy = `sym:function:${known.relPath}:${known.name}:1`;
    authorLinks("evidence", "evidence.mcp.legacy", [legacy]);

    const report = checked();

    expect(report.reasonCodes).toContain("DEPRECATED_SYMBOL_ANCHOR");
    expect(report.anchorFindings).toContainEqual({
      code: "DEPRECATED_SYMBOL_ANCHOR",
      severity: "warning",
      ownerId: "evidence.mcp.legacy",
      ownerKind: "link",
      ref: legacy,
      message: `"evidence.mcp.legacy" resolves only through the deprecated line-bearing anchor ${legacy}; run 'semctx migrate anchors'`,
    });
    expect(report.staleLinks).toEqual([]);
  });

  it("rejects output carrying a code the vocabulary does not contain", () => {
    authorLinks("evidence", "evidence.mcp.gone", ["sym:function:src/nowhere.ts:vanished"]);
    const tampered = JSON.parse(JSON.stringify(semanticCheckTool(root))) as {
      staleLinks: { reasonCode: string }[];
    };
    tampered.staleLinks[0]!.reasonCode = "role_vanished";

    expect(TOOL_OUTPUT_SCHEMAS.semctx_semantic_check.safeParse(tampered).success).toBe(false);
  });

  it("rejects unknown fields and contradictory resolved states", () => {
    authorLinks("evidence", "evidence.mcp.gone", ["sym:function:src/nowhere.ts:vanished"]);
    const unknown = JSON.parse(JSON.stringify(semanticCheckTool(root))) as {
      staleLinks: Record<string, unknown>[];
    };
    unknown.staleLinks[0]!.invented = true;
    expect(TOOL_OUTPUT_SCHEMAS.semctx_semantic_check.safeParse(unknown).success).toBe(false);

    const contradictory = JSON.parse(JSON.stringify(semanticCheckTool(root))) as {
      staleLinks: Record<string, unknown>[];
    };
    contradictory.staleLinks[0]!.resolved = true;
    expect(TOOL_OUTPUT_SCHEMAS.semctx_semantic_check.safeParse(contradictory).success).toBe(false);
  });

  it("publishes no candidate key at all for symbol_gone", () => {
    authorLinks("evidence", "evidence.mcp.gone", ["sym:function:src/nowhere.ts:vanished"]);

    const stale = checked().staleLinks[0]!;

    expect(stale.reasonCode).toBe("symbol_gone");
    expect(Object.hasOwn(stale, "candidates")).toBe(false);
  });
});

describe("CLI/MCP semantic-check parity", () => {
  it("exposes the exact same canonical payload and renders actionable text", () => {
    authorLinks("invariant", "invariant.mcp.parity", [
      known.canonical,
      `sym:class:${known.relPath}:${known.name}`,
    ]);

    const mcp = semanticCheckTool(root);
    const parsedMcp = TOOL_OUTPUT_SCHEMAS.semctx_semantic_check.parse(
      JSON.parse(JSON.stringify(mcp)),
    );
    const cliJson = cli(["semantic", "check", "--json"]);
    expect(cliJson.code).toBe(1);
    expect(JSON.parse(cliJson.output)).toEqual(parsedMcp);

    const text = cli(["semantic", "check"]);
    expect(text.code).toBe(1);
    expect(text.output).toContain("[role_removed]");
    expect(text.output).toContain(`candidates=[${known.canonical}]`);
    expect(text.output).toContain("DURABLE_ANCHOR_IS_TRANSIENT:");
    expect(text.output).toContain("durable intent should anchor");
  });
});

/**
 * The producer sorts and de-duplicates today. That is a property of one function, and the schema is
 * what a consumer actually gates on — so the schema has to refuse a list no producer should ever
 * emit, rather than trusting the producer to keep being right.
 */
describe("the published schema — candidate list canonicality", () => {
  it("rejects a reordered candidate list", () => {
    authorLinks("evidence", "evidence.mcp.role", [`sym:class:${known.relPath}:${known.name}`]);
    const payload = JSON.parse(JSON.stringify(semanticCheckTool(root))) as {
      staleLinks: { candidates?: string[] }[];
    };
    payload.staleLinks[0]!.candidates = [...(payload.staleLinks[0]!.candidates ?? []), "sym:function:z.ts:zz"]
      .sort()
      .reverse();

    expect(TOOL_OUTPUT_SCHEMAS.semctx_semantic_check.safeParse(payload).success).toBe(false);
  });

  it("accepts and rejects the same fixtures as the shared control-model schema", () => {
    const valid = {
      ownerId: "evidence.schema.parity",
      link: { kind: "symbol", ref: "sym:function:src/a.ts:run" },
      resolved: false,
      reason: "multiple symbols match",
      reasonCode: "ambiguous",
      candidates: [
        "sym:function:src/a.ts:outer.run",
        "sym:function:src/a.ts:run",
      ],
    } as const;
    const fixtures: unknown[] = [
      valid,
      { ...valid, invented: true },
      { ...valid, candidates: [...valid.candidates].reverse() },
      { ...valid, candidates: [valid.candidates[0], valid.candidates[0]] },
      { ...valid, reasonCode: "node_absent" },
      { ...valid, resolved: true },
    ];

    for (const fixture of fixtures) {
      const controlAccepted = CanonicalLinkResolutionSchema.safeParse(fixture).success;
      const payload = checked();
      payload.staleLinks = [fixture as (typeof payload.staleLinks)[number]];
      const mcpAccepted = TOOL_OUTPUT_SCHEMAS.semctx_semantic_check.safeParse(payload).success;
      expect(mcpAccepted).toBe(controlAccepted);
    }
  });
});
