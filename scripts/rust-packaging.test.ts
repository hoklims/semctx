import { expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createGlobSelectionConfig } from "@semantic-context/core";
import { initWorkspace } from "@semantic-context/repository-store";
import { SAMPLE_RUST_REPO } from "@semantic-context/test-fixtures";

const repository = resolve(import.meta.dir, "..");

function run(root: string, args: string[], expectedExitCode = 0): string {
  const result = Bun.spawnSync(args, { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== expectedExitCode) throw new Error(`${args.join(" ")} (${result.exitCode}, expected ${expectedExitCode}): ${new TextDecoder().decode(result.stdout).slice(0, 500)} ${new TextDecoder().decode(result.stderr).slice(0, 500)}`);
  return new TextDecoder().decode(result.stdout);
}

function expectPackagedRustIndex(entrypoint: string): void {
  const root = mkdtempSync(join(tmpdir(), "semctx-rust-package-"));
  try {
    cpSync(SAMPLE_RUST_REPO, root, { recursive: true });
    writeFileSync(join(root, ".gitignore"), ".semctx/\ntarget/\n");
    run(root, ["git", "init", "-q"]);
    run(root, ["git", "add", "."]);
    run(root, ["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"]);
    initWorkspace(root, { ...createGlobSelectionConfig(root), include: ["**/*.rs"], languages: { rust: "on" } });
    const command = [process.execPath, entrypoint];
    const index = JSON.parse(run(root, [...command, "index", "--json"]));
    expect(index.indexed).toBe(true);
    expect(index.nodeKinds["function"] > 0).toBe(true);
    const health = JSON.parse(run(root, [...command, "index-health", "--json"], 2));
    expect(health).toMatchObject({ binding: { status: "valid" }, freshness: { verdict: "FRESH" }, coverage: { status: "partial" } });
    const rust = health.candidates.filter((candidate: { language: string }) => candidate.language === "rust");
    expect(rust.length).toBeGreaterThan(0);
    expect(rust.every((candidate: { analysisOutcome: string }) => candidate.analysisOutcome === "analyzed")).toBe(true);
    const inspection = JSON.parse(run(root, [...command, "inspect", "symbol", "confirm", "--json"]));
    expect(inspection.matchedNodes).toContainEqual(expect.objectContaining({ name: "confirm", filePath: "domain/src/reservation.rs" }));
    const sourcePath = join(root, "domain/src/reservation.rs");
    writeFileSync(sourcePath, readFileSync(sourcePath, "utf8").replace("> 0", ">= 0"));
    run(root, [...command, "index", "--json"]);
    const verification = JSON.parse(run(root, [...command, "verify", "diff", "--format", "json"], 3));
    expect(verification.verdict).toBe("BLOCK");
    expect(verification.findings).toContainEqual(expect.objectContaining({ rule: "invariant_touched_without_test" }));
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test("packaged CLI and plugin runtimes index Rust with colocated workers and WASM", () => {
  run(repository, [process.execPath, "scripts/build-cli-package.ts"]);
  for (const entrypoint of ["apps/cli/dist/index.js", "plugins/claude-code/dist/semctx.js"]) {
    expectPackagedRustIndex(join(repository, entrypoint));
  }
}, 60_000);

test("the package smoke rejects a plugin whose Rust worker is absent", () => {
  const copy = mkdtempSync(join(tmpdir(), "semctx-rust-package-artifacts-"));
  try {
    cpSync(join(repository, "plugins/claude-code/dist"), copy, { recursive: true });
    rmSync(join(copy, "semctx-rust-worker.js"));
    expect(() => expectPackagedRustIndex(join(copy, "semctx.js"))).toThrow();
  } finally { rmSync(copy, { recursive: true, force: true }); }
}, 60_000);
