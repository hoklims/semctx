import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGlobSelectionConfig, VerifyReportSchema } from "@semantic-context/core";
import { initWorkspace } from "@semantic-context/repository-store";
import { indexRepository, runVerify } from "../src";

const roots: string[] = [];
const GUARDED = "/** @invariant fixed-value: the value stays positive */\nexport function value() { return 1; }\n";
const CLI = join(import.meta.dir, "../../../apps/cli/src/index.ts");

function git(root: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-c", "user.name=Semctx Test", "-c", "user.email=semctx@example.test", "-c", "commit.gpgsign=false", ...args], {
    cwd: root, stdout: "pipe", stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
  return new TextDecoder().decode(result.stdout).trim();
}

function range(extension: "ts" | "mjs", edit: (root: string, path: string) => void) {
  const root = mkdtempSync(join(tmpdir(), "semctx-qualified-range-base-"));
  roots.push(root);
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, ".gitignore"), ".semctx/\n");
  const path = `src/value.${extension}`;
  writeFileSync(join(root, path), GUARDED);
  writeFileSync(join(root, `src/helper.${extension}`), "export function helper() { return 1; }\n");
  git(root, "init", "-q", "-b", "main");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "base");
  initWorkspace(root, { ...createGlobSelectionConfig(root), selectionMode: "qualified-static-v1", analysisProfile: "modelo-suite-static-v1", include: ["src/**/*"], languages: { typescript: "on", javascript: "on" } });
  git(root, "checkout", "-q", "-b", "change");
  edit(root, path);
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "head");
  indexRepository(root, "2026-10-12T00:00:00.000Z");
  let observed: ReturnType<typeof runVerify> | undefined;
  let failure: unknown;
  try { observed = runVerify(root, { kind: "range", base: "main" }); }
  catch (error) { failure = error; }
  return { root, path, observed, failure };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

for (const extension of ["ts", "mjs"] as const) describe(`qualified ${extension} committed range base boundary`, () => {
  for (const kind of ["delete", "strip-marker", "body-only"] as const) it(`returns explicit BLOCK, not an internal exception, for ${kind}`, () => {
    const { root, path, observed, failure } = range(extension, (root, path) => {
      if (kind === "delete") git(root, "rm", "-q", path);
      else writeFileSync(join(root, path), kind === "strip-marker" ? GUARDED.split("\n").slice(1).join("\n") : GUARDED.replace("return 1", "return 2"));
    });
    expect(failure).toBeUndefined();
    expect(observed?.result.verdict).toBe("BLOCK");
    expect(observed?.report.analysisAdmission?.status).toBe("rejected");
    expect(observed?.result.findings).toEqual(expect.arrayContaining([expect.objectContaining({ rule: "analysis_scope_incomplete", severity: "block" })]));
    expect(observed?.result.unknowns.join("\n")).toContain(path);
    const processResult = Bun.spawnSync([process.execPath, CLI, "verify", "diff", "--root", root, "--base", "main", "--format", "json", "--fail-on", "none"], {
      stdout: "pipe", stderr: "pipe",
    });
    expect(processResult.exitCode).toBe(3);
    const report = JSON.parse(new TextDecoder().decode(processResult.stdout));
    expect(report.verdict).toBe("BLOCK");
    expect(report.analysisAdmission.status).toBe("rejected");
    expect(VerifyReportSchema.safeParse(report).success).toBe(true);
  }, 60_000);

  it("keeps a clean pure addition eligible without base recovery", () => {
    const { observed, failure } = range(extension, (root) => writeFileSync(join(root, `src/added.${extension}`), "export function added() { return 3; }\n"));
    expect(failure).toBeUndefined();
    expect(observed?.report.analysisAdmission?.status).toBe("admitted");
    expect(observed?.result.verdict).not.toBe("BLOCK");
  }, 60_000);
});

for (const [control, content] of [
  ["package.json", '{"name":"fixture","type":"module"}\n'],
  ["tsconfig.json", '{"compilerOptions":{"module":"ESNext","moduleResolution":"Bundler"}}\n'],
  [".gitignore", ".semctx/\n# head ignore policy\n"],
] as const) it(`head ${control} changes cannot substitute for qualified base capture`, () => {
  const { observed, failure } = range("ts", (root, path) => {
    writeFileSync(join(root, path), GUARDED.replace("return 1", "return 2"));
    writeFileSync(join(root, control), content);
  });
  expect(failure).toBeUndefined();
  expect(observed?.result.verdict).toBe("BLOCK");
  expect(observed?.report.analysisAdmission?.status).toBe("rejected");
  expect(observed?.report.analysisAdmission?.reasons).toContain("QUALIFIED_BASE_RECOVERY_UNSUPPORTED");
}, 60_000);
