import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectJavaScriptSource, inspectModuleConfiguration } from "@semantic-context/ts-analyzer";
import { createDataProvenConsumer, LEAF } from "./modelo-static-fixture";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("fourth producer guarded build helper keeps public module acceptance and real output", () => {
  const root = mkdtempSync(join(tmpdir(), "public-fourth-build-positive-"));
  roots.push(root);
  createDataProvenConsumer(root);
  const inputs = new Map<string, string>();
  const retain = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) retain(path);
      else inputs.set(path, readFileSync(path, "utf8"));
    }
  };
  retain(root);
  const buildPath = join(root, "suite/tooling/check/build.mjs");
  const buildSource = inputs.get(buildPath)!;
  expect(inspectModuleConfiguration(buildPath, root, inputs)).toEqual([]);
  const module = inspectJavaScriptSource(buildPath, buildSource, root, inputs);
  expect(module.parseFailed).toBe(false);
  expect(module.reasons).toEqual([]);
  expect(module.staticModuleLinks).toEqual([{ specifier: "node:fs", resolution: "external" }]);
  const result = Bun.spawnSync([process.execPath, buildPath], {
    cwd: join(root, "suite/apps/web"), stdout: "pipe", stderr: "pipe",
  });
  expect(result.exitCode).toBe(0);
  expect(result.stderr.toString()).toBe("");
  expect(readFileSync(join(root, "suite/apps/web/out/result.txt"), "utf8"))
    .toBe(readFileSync(join(root, LEAF), "utf8"));
}, 60_000);
