import { expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { indexRepository, queryControlGraph } from "@semantic-context/app-services";
import { createGlobSelectionConfig } from "@semantic-context/core";
import { initWorkspace } from "@semantic-context/repository-store";
import { SAMPLE_RUST_REPO } from "@semantic-context/test-fixtures";
import { newChangeContract, writeActiveChange, writeChangeFile, writeKindFile } from "@semantic-context/semantic-engine";
import { inspectTool } from "../src/index";
import { handoffTool, resumeTool, semanticCheckTool, semanticSliceTool } from "../src/semantic-tools";

const CLI = join(import.meta.dir, "../../../apps/cli/src/index.ts");

test("CLI and MCP inspect persisted Rust facts and CLI verifies a Rust invariant change", () => {
  const root = mkdtempSync(join(tmpdir(), "semctx-rust-public-inspect-"));
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
  };
  try {
    cpSync(SAMPLE_RUST_REPO, root, { recursive: true });
    writeFileSync(join(root, ".gitignore"), ".semctx/\ntarget/\n");
    git("init", "-q"); git("add", ".");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture");
    initWorkspace(root, { ...createGlobSelectionConfig(root), include: ["**/*.rs", "docs/**/*.md"],
      languages: { rust: "on", markdown: "on" } });
    indexRepository(root, "2026-10-17T10:00:00.000Z");
    const mcp = inspectTool(root, { query: "confirm", kind: "symbol" });
    expect(mcp.matchedNodes).toContainEqual(expect.objectContaining({ kind: "function", name: "confirm", filePath: "domain/src/reservation.rs" }));
    expect(mcp.relations).toContainEqual(expect.objectContaining({ kind: "constrained_by", to: "inv:confirmed-never-exceeds-capacity" }));
    expect(mcp.evidence).toContainEqual(expect.objectContaining({ filePath: "domain/src/reservation.rs" }));
    expect(inspectTool(root, { query: "sym:function:domain/src/reservation.rs:confirm", kind: "symbol" }).matchedNodes)
      .toEqual([expect.objectContaining({ name: "confirm" })]);
    const cli = Bun.spawnSync(["bun", "run", CLI, "inspect", "symbol", "confirm", "--root", root, "--json"],
      { stdout: "pipe", stderr: "pipe" });
    expect(cli.exitCode).toBe(0);
    expect(JSON.parse(new TextDecoder().decode(cli.stdout))).toEqual(mcp);
    const sourcePath = join(root, "domain/src/reservation.rs");
    writeFileSync(sourcePath, readFileSync(sourcePath, "utf8").replace("> 0", ">= 0"));
    indexRepository(root, "2026-10-17T10:01:00.000Z");
    const verification = Bun.spawnSync(["bun", "run", CLI, "verify", "diff", "--root", root, "--format", "json"],
      { stdout: "pipe", stderr: "pipe" });
    expect(verification.exitCode).toBe(3);
    const report = JSON.parse(new TextDecoder().decode(verification.stdout));
    expect(report.verdict).toBe("BLOCK");
    expect(report.findings).toContainEqual(expect.objectContaining({ rule: "invariant_touched_without_test", tier: "strict" }));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("MCP semantic slice retains a Rust authored anchor and its open unknown after source deletion", () => {
  const root = mkdtempSync(join(tmpdir(), "semctx-rust-slice-"));
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
  };
  try {
    cpSync(SAMPLE_RUST_REPO, root, { recursive: true });
    writeFileSync(join(root, ".gitignore"), ".semctx/\ntarget/\n");
    git("init", "-q"); git("add", ".");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture");
    initWorkspace(root, { ...createGlobSelectionConfig(root), include: ["**/*.rs"], languages: { rust: "on" } });
    const anchor = "sym:function:domain/src/reservation.rs:confirm";
    writeKindFile(root, "unknown", [{ id: "unknown.rust-impact", kind: "unknown", statement: "Runtime outcome not observed",
      status: "declared", provenance: "author", sourceRefs: [{ file: ".semctx/semantic/unknowns.sem", line: 1 }],
      repositoryLinks: [], relations: [], tags: [] }]);
    writeKindFile(root, "invariant", [{ id: "invariant.rust-impact", kind: "invariant", statement: "Keep confirmation bounded",
      status: "declared", provenance: "author", sourceRefs: [{ file: ".semctx/semantic/invariants.sem", line: 1 }],
      appliesAtLevel: 4, repositoryLinks: [{ kind: "symbol", ref: anchor }], relations: [], tags: [] }]);
    const change = newChangeContract({ id: "change.rust-impact", statement: "Check Rust impact",
      lifecycle: "active", links: [anchor], openUnknowns: ["unknown.rust-impact"],
      file: ".semctx/semantic/changes/change.rust-impact.sem" });
    writeChangeFile(root, change);
    writeActiveChange(root, change);
    indexRepository(root, "2026-10-17T10:00:00.000Z");
    const initial = semanticSliceTool(root, { symbolRef: anchor }).slice;
    expect(initial.changes.map((change) => change.id)).toEqual(["change.rust-impact"]);
    expect(initial.linkedRepository).toContainEqual({ kind: "symbol", ref: anchor });
    expect(initial.openUnknowns).toContainEqual(expect.objectContaining({ id: "unknown.rust-impact", provenance: "author" }));
    expect(semanticCheckTool(root).staleLinks).toEqual([]);
    const graph = queryControlGraph(root);
    expect(graph.terminalStatus).toBe("success");
    expect(graph.payload?.structuralEdges).toContainEqual(expect.objectContaining({
      from: `repo:${anchor}`, to: "semantic:invariant.rust-impact", sourceRelation: "repository_link:symbol",
    }));
    const handoff = handoffTool(root, {});
    expect(handoff).toMatchObject({ activeChangeId: "change.rust-impact",
      exploredLinks: [anchor], openUnknowns: ["unknown.rust-impact"] });
    expect(resumeTool(root)).toEqual(handoff);
    const source = join(root, "domain/src/reservation.rs");
    writeFileSync(source, readFileSync(source, "utf8").replace("pub fn confirm", "pub fn renamed"));
    expect(queryControlGraph(root)).toMatchObject({ terminalStatus: "refused", reasonCodes: ["INDEX_STALE"], payload: null });
    indexRepository(root, "2026-10-17T10:01:00.000Z");
    const after = semanticSliceTool(root, { symbolRef: anchor }).slice;
    expect(after.linkedRepository).toContainEqual({ kind: "symbol", ref: anchor });
    expect(after.openUnknowns.map((item) => item.id)).toEqual(["unknown.rust-impact"]);
    expect(resumeTool(root)).toEqual(handoff);
    expect(semanticCheckTool(root).staleLinks).toContainEqual(expect.objectContaining({ reasonCode: "symbol_gone" }));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
