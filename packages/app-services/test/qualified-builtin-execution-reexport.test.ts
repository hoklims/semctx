import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGlobSelectionConfig } from "@semantic-context/core";
import { initWorkspace } from "@semantic-context/repository-store";
import { indexRepository, runVerify } from "../src";

for (const extension of ["ts", "js"]) for (const selected of [true, false]) test(`child change through launcher barrel ${extension}, selected ${selected}`, () => {
  const root = mkdtempSync(join(tmpdir(), "semctx-launcher-barrel-"));
  try {
    mkdirSync(join(root, "src")); writeFileSync(join(root, ".gitignore"), ".semctx/\n");
    writeFileSync(join(root, `${selected ? "src/" : ""}launcher.${extension}`), "export { fork } from 'node:child_process';\n");
    writeFileSync(join(root, `src/main.${extension}`), `import { fork } from '${selected ? "./" : "../"}launcher'; export function run() { return fork('./src/child.js'); }\n`);
    const child = join(root, "src/child.js"); writeFileSync(child, "export function child() { return 1; }\n");
    for (const args of [["init", "-q"], ["add", "."], ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"]]) {
      const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" }); if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
    }
    initWorkspace(root, { ...createGlobSelectionConfig(root), selectionMode: "qualified-static-v1", analysisProfile: "modelo-suite-static-v1", include: ["src/**/*"], languages: { typescript: "on", javascript: "on" } });
    writeFileSync(child, "export function child() { return 2; }\n");
    indexRepository(root, "2026-10-11T10:00:00.000Z");
    const result = runVerify(root, { kind: "working-tree" }); const admission = result.report.analysisAdmission;
    console.info(JSON.stringify({ extension, selected, admission, recommendedTests: result.report.recommendedTests }));
    expect(admission?.status).toBe("rejected");
    expect(admission?.reasons.some(value => value.includes("PROCESS_LAUNCH_UNSUPPORTED"))).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 180_000);

test("native launcher barrel executes the owned child", async () => {
  const root = mkdtempSync(join(tmpdir(), "semctx-native-barrel-"));
  try {
    writeFileSync(join(root, "launcher.mjs"), "export { fork } from 'node:child_process';\n");
    writeFileSync(join(root, "child.mjs"), "console.log('OWNED_BARREL_CHILD');\n");
    writeFileSync(join(root, "main.mjs"), "import {fork} from './launcher.mjs'; const child=fork(new URL('./child.mjs', import.meta.url),[],{execPath:process.execPath,silent:true});child.stdout.pipe(process.stdout);child.on('close',code=>{process.exitCode=code;});\n");
    const child = Bun.spawn([process.execPath, join(root, "main.mjs")], { stdout: "pipe", stderr: "pipe" });
    const output = await new Response(child.stdout).text(); const code = await child.exited;
    expect(code).toBe(0); expect(output).toContain("OWNED_BARREL_CHILD");
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 30_000);
