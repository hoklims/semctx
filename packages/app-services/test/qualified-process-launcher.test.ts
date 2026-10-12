import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGlobSelectionConfig } from "@semantic-context/core";
import { initWorkspace } from "@semantic-context/repository-store";
import { indexRepository, runVerify } from "../src";

const git = (root: string, ...args: string[]): void => {
  const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
};
for (const [name, content, reason] of [
  ["builtin fork", "import { fork } from 'node:child_process'; export function run() { return fork('./hidden.js'); }", "PROCESS_LAUNCH_UNSUPPORTED"],
  ["internal higher-order", "function invoke(cb) { return cb(); } function helper() { return 1; } export function run() { return invoke(helper); }", undefined],
] as const) test(name, () => {
  const root = mkdtempSync(join(tmpdir(), "semctx-process-launch-"));
  try {
    mkdirSync(join(root, "src")); writeFileSync(join(root, ".gitignore"), ".semctx/\n");
    writeFileSync(join(root, "src/main.ts"), "export function main() { return 1; }\n");
    writeFileSync(join(root, "src/subject.ts"), content);
    writeFileSync(join(root, "src/hidden.js"), "export function hidden() { return 1; }\n");
    git(root, "init", "-q"); git(root, "add", "."); git(root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture");
    initWorkspace(root, { ...createGlobSelectionConfig(root), selectionMode: "qualified-static-v1", analysisProfile: "modelo-suite-static-v1", include: ["src/**/*"], languages: { typescript: "on", javascript: "on" } });
    if (name === "internal higher-order") writeFileSync(join(root, "src/subject.ts"), content.replace("function helper() { return 1; }", "function helper() { return 2; }"));
    else writeFileSync(join(root, "src/main.ts"), "export function main() { return 2; }\n");
    indexRepository(root, "2026-10-11T10:00:00.000Z");
    const admission = runVerify(root, { kind: "working-tree" }).report.analysisAdmission;
    console.info(JSON.stringify({ name, admission }));
    expect(admission?.status).toBe("rejected");
    if (reason !== undefined) expect(admission?.reasons.some(value => value.includes(reason))).toBe(true);
    else {
      expect(admission?.changeCoverage.expected).toContain("src/subject.ts");
      expect(admission?.changeCoverage.files.some(file => file.path === "src/subject.ts" && file.reasons.some(value => value.includes("QUALIFIED_CALL_COORDINATE_CALLEE_MISSING")))).toBe(true);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 180_000);

test("native fork executes the owned repository target", async () => {
  const root = mkdtempSync(join(tmpdir(), "semctx-native-fork-"));
  try {
    writeFileSync(join(root, "hidden.mjs"), "console.log('OWNED_CHILD_EXECUTED');\n");
    const { fork } = await import("node:child_process");
    const child = fork(join(root, "hidden.mjs"), [], { execPath: process.execPath, silent: true });
    let output = "";
    child.stdout?.on("data", chunk => { output += String(chunk); });
    const code = await new Promise<number | null>((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
    expect(code).toBe(0); expect(output).toContain("OWNED_CHILD_EXECUTED");
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 30_000);

for (const extension of ["ts", "js"]) for (const selected of [true, false]) test(`fork closure ${extension}, selected ${selected}`, () => {
  const root = mkdtempSync(join(tmpdir(), "semctx-fork-closure-"));
  try {
    mkdirSync(join(root, "src")); writeFileSync(join(root, ".gitignore"), ".semctx/\n");
    writeFileSync(join(root, "src/main.ts"), "export function main() { return 1; }\n");
    const prefix = selected ? "src/" : "";
    writeFileSync(join(root, `${prefix}subject.${extension}`), "import { fork } from 'node:child_process'; export function run() { return fork('./hidden.js'); }\n");
    writeFileSync(join(root, `${prefix}hidden.js`), "export function hidden() { return 1; }\n");
    git(root, "init", "-q"); git(root, "add", "."); git(root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture");
    initWorkspace(root, { ...createGlobSelectionConfig(root), selectionMode: "qualified-static-v1", analysisProfile: "modelo-suite-static-v1", include: ["src/**/*"], languages: { typescript: "on", javascript: "on" } });
    writeFileSync(join(root, "src/main.ts"), "export function main() { return 2; }\n");
    indexRepository(root, "2026-10-11T10:00:00.000Z");
    const admission = runVerify(root, { kind: "working-tree" }).report.analysisAdmission;
    console.info(JSON.stringify({ extension, selected, admission }));
    expect(admission?.status).toBe("rejected");
    expect(admission?.reasons.some(value => value.includes("PROCESS_LAUNCH_UNSUPPORTED"))).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 180_000);
