import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { planSetupRepository } from "@semantic-context/app-services";

const roots: string[] = [];
const entrypoint = resolve(import.meta.dir, "../src/index.ts");
afterEach(() => {
  for (const root of roots.splice(0)) {
    if (!root.startsWith(join(tmpdir(), "semctx-scope-cli-"))) throw new Error("unsafe fixture cleanup");
    rmSync(root, { recursive: true, force: true });
  }
});
test("real CLI JSON and text expose exact scope while dry-run executes no script or index", () => {
  const root = mkdtempSync(join(tmpdir(), "semctx-scope-cli-"));
  roots.push(root);
  for (const file of ["apps/host/src/index.ts", "domains/sample/api/src/index.ts", "domains/sample/web/src/index.ts", "platform/shared/src/index.ts"]) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), "export const value = 1;\n");
  }
  writeFileSync(join(root, "package.json"), JSON.stringify({ workspaces: ["apps/*", "domains/*/api", "domains/*/web", "platform/*"], scripts: { prepare: "touch SCRIPT_RAN", index: "touch SCRIPT_RAN" } }));
  const snapshot = () => readdirSync(root, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => [join(entry.parentPath, entry.name), readFileSync(join(entry.parentPath, entry.name)).toString("base64")]);
  const before = snapshot();
  const expected = planSetupRepository(root, { polyglot: true });
  if (expected.kind !== "setup_plan") throw new Error("unexpected refusal");
  function run(json: boolean) {
    const child = Bun.spawnSync([process.execPath, entrypoint, "setup", "--root", root, "--polyglot", "--dry-run", ...(json ? ["--json"] : [])], { stdout: "pipe", stderr: "pipe" });
    expect(child.exitCode, new TextDecoder().decode(child.stderr)).toBe(0);
    return new TextDecoder().decode(child.stdout);
  }
  const body = JSON.parse(run(true));
  expect(body.scope).toEqual(expected.scope);
  expect(body.selection.selectedFiles).toBe(1);
  expect(body.index).toEqual({ status: "not-run", reason: "dry-run" });
  const text = run(false);
  for (const root of ["domains/sample/api", "domains/sample/web", "platform/shared"]) expect(text).toContain(root);
  expect(text).toContain("INCLUDE_MISS:1");
  expect(text).toContain("explicitly add desired entries to .semctx/config.json");
  expect(text).toContain('"platform/shared/src/index.ts"');
  expect(snapshot()).toEqual(before);
  expect(existsSync(join(root, ".semctx"))).toBe(false);
  expect(existsSync(join(root, "SCRIPT_RAN"))).toBe(false);
});
