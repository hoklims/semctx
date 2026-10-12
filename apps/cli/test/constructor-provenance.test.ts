import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGlobSelectionConfig } from "@semantic-context/core";
import { initWorkspace } from "@semantic-context/repository-store";
import { indexRepository } from "@semantic-context/app-services";

const cli = join(import.meta.dir, "../src/index.ts");
const localConstructor = (extension: string): string => extension === "ts"
  ? "class LocalDate {constructor(_value:unknown){}}\nconst env:typeof globalThis={Date:LocalDate} as unknown as typeof globalThis;\nexport function run(){return new env.Date(1); }\n"
  : "class LocalDate {constructor(value){}}\n/** @type {typeof globalThis} */\nconst env=/** @type {any} */ ({Date:LocalDate});\nexport function run(){return new env.Date(1); }\n";
function verify(source: string, extension: string, excluded: boolean, hiddenOnly = false): { exitCode: number; report: { analysisAdmission: { status: string; reasons: string[]; binding: { status: string } }; verdict: string } } {
  const root = mkdtempSync(join(tmpdir(), "semctx-constructor-origin-"));
  try {
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, ".gitignore"), ".semctx/\n");
    const main = join(root, `src/main.${extension}`);
    writeFileSync(main, hiddenOnly && !excluded ? source : "export function main(){return 1;}\n");
    if (hiddenOnly) {
      writeFileSync(join(root, `src/leaf.${extension}`), "export function hidden(){return 1;}\n");
      writeFileSync(join(root, `src/runner.test.${extension}`), `import {run} from '${excluded ? "../hidden" : "./main"}.${extension}';export function check(){return run();}\n`);
    }
    if (excluded) writeFileSync(join(root, `hidden.${extension}`), source);
    for (const args of [["init", "-q"], ["add", "."], ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"]]) {
      const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
      if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
    }
    initWorkspace(root, { ...createGlobSelectionConfig(root), selectionMode: "qualified-static-v1", analysisProfile: "modelo-suite-static-v1", include: ["src/**/*"], languages: { typescript: "on", javascript: "on" } });
    if (hiddenOnly) writeFileSync(join(root, `src/leaf.${extension}`), "export function hidden(){return 2;}\n");
    else writeFileSync(main, excluded ? "export function main(){return 2;}\n" : source);
    indexRepository(root, "2026-10-12T10:00:00.000Z");
    const result = Bun.spawnSync([process.execPath, cli, "verify", "diff", "--root", root, "--format", "json", "--fail-on", "none"], { cwd: root, stdout: "pipe", stderr: "pipe" });
    return { exitCode: result.exitCode, report: JSON.parse(new TextDecoder().decode(result.stdout)) };
  } finally { rmSync(root, { recursive: true, force: true }); }
}
for (const extension of ["ts", "mjs"]) {
  for (const excluded of [false, true]) test(`qualified CLI rejects SDK-shaped local constructor in ${excluded ? "excluded" : "selected"} ${extension}`, () => {
    const { exitCode, report } = verify(localConstructor(extension), extension, excluded);
    expect(exitCode).toBe(3);
    expect(report.verdict).toBe("BLOCK");
    expect(report.analysisAdmission.status).toBe("rejected");
    expect(report.analysisAdmission.reasons.some(reason => reason.includes("SOURCE_CONSTRUCTION_UNSUPPORTED"))).toBe(true);
  }, 60_000);
  test(`qualified CLI preserves true SDK aliases in ${extension}`, () => {
    const { exitCode, report } = verify("const C=Date;const env=globalThis;const P=globalThis.Date;export function run(){new C(1);new env.Date(1);return new P(1); }\n", extension, false);
    expect(exitCode).toBe(0);
    expect(report.analysisAdmission.status).toBe("admitted");
    expect(report.analysisAdmission.reasons).toEqual([]);
  }, 60_000);
}

for (const extension of ["ts", "mjs"]) for (const excluded of [false, true]) test(`qualified CLI rejects hidden-only edit behind SDK-shaped ${excluded ? "excluded" : "selected"} ${extension} constructor`, () => {
  const source = `import {hidden} from '${excluded ? "./src/leaf" : "./leaf"}.${extension}';\n${localConstructor(extension).replace("constructor(_value:unknown){}", "constructor(_value:unknown){hidden();}").replace("constructor(value){}", "constructor(value){hidden();}")}`;
  const { exitCode, report } = verify(source, extension, excluded, true);
  expect(exitCode).toBe(3);
  expect(report.verdict).toBe("BLOCK");
  expect(report.analysisAdmission.status).toBe("rejected");
  expect(report.analysisAdmission.binding.status).toBe("valid");
  expect(report.analysisAdmission.reasons.some(reason => reason.includes("SOURCE_CONSTRUCTION_UNSUPPORTED"))).toBe(true);
}, 60_000);
