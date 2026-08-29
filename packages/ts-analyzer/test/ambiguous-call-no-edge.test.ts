/**
 * A structural collision must never produce a guessed `calls` edge.
 *
 * Two block-scoped `function twin() {}` declarations share one scope path (`collisionHost.twin`) —
 * legal TypeScript, and the one case grouping cannot fold into a single logical symbol nor own the
 * bare coordinate (`symbol-grouping.ts`). The TS checker still resolves each call to its own
 * declaration internally, but the coordinate both calls resolve to for graph purposes is the same
 * ambiguous one. `assembleRepository` must refuse to pick a target rather than attach the call to
 * whichever of the two collision members happens to be first — an approximate edge is worse than a
 * missing one.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDefaultConfig } from "@semantic-context/core";
import { analyzeRepository } from "@semantic-context/ts-analyzer";

const roots: string[] = [];

function fixture(source: string): string {
  const root = mkdtempSync(join(tmpdir(), "semctx-ambiguous-call-"));
  roots.push(root);
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "collision.ts"), source, "utf8");
  return root;
}

const SOURCE = [
  "export function collisionHost(flag: boolean): number {",
  "  if (flag) {",
  "    function twin(): number { return 1; }",
  "    return twin();",
  "  }",
  "  {",
  "    function twin(): number { return 2; }",
  "    return twin();",
  "  }",
  "  return 0;",
  "}",
  "",
].join("\n");

describe("ambiguous structural symbol — no guessed call edge", () => {
  it("creates two ordinal-suffixed collision nodes, neither owning the bare coordinate", () => {
    const root = fixture(SOURCE);
    const { graph } = analyzeRepository(createDefaultConfig(root));

    const bare = "sym:function:src/collision.ts:collisionHost.twin";
    const twins = graph.nodes.filter((node) => node.id.startsWith(`${bare}#`));

    expect(twins).toHaveLength(2);
    expect(graph.nodes.some((node) => node.id === bare)).toBe(false);
  });

  it("emits zero 'calls' edges targeting the ambiguous coordinate", () => {
    const root = fixture(SOURCE);
    const { graph } = analyzeRepository(createDefaultConfig(root));

    const bare = "sym:function:src/collision.ts:collisionHost.twin";
    const guessedCalls = graph.edges.filter(
      (edge) => edge.kind === "calls" && edge.to.startsWith(bare),
    );

    // Fail-closed: a coordinate that resolves to several declarations gets no edge at all, rather
    // than an edge landing on whichever collision member the builder saw first.
    expect(guessedCalls).toEqual([]);
  });

  it("does not silently pick the ordinal-suffixed id as a call target either", () => {
    const root = fixture(SOURCE);
    const { graph } = analyzeRepository(createDefaultConfig(root));

    const twinIds = graph.nodes
      .filter((node) => node.id.startsWith("sym:function:src/collision.ts:collisionHost.twin#"))
      .map((node) => node.id);
    expect(twinIds).toHaveLength(2);

    const callsIntoEitherTwin = graph.edges.filter(
      (edge) => edge.kind === "calls" && twinIds.includes(edge.to),
    );
    expect(callsIntoEitherTwin).toEqual([]);
  });
});

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
