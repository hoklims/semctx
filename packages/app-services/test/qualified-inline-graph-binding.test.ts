import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGlobSelectionConfig } from "@semantic-context/core";
import { initWorkspace } from "@semantic-context/repository-store";
import { indexRepository, runVerify } from "../src";
import { createPrimitiveSafeConsumer } from "../../../scripts/modelo-static-fixture";

const git = (root: string, ...args: string[]): void => {
  const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
};
test("same indexed dirty source owns its inline edge; stale same-coordinate graph cannot prove a new value escape", () => {
  const root = mkdtempSync(join(tmpdir(), "semctx-inline-seal-"));
  try {
    mkdirSync(join(root, "src")); writeFileSync(join(root, ".gitignore"), ".semctx/\n");
    writeFileSync(join(root, "package.json"), '{"dependencies":{"opaque":"1.0.0"}}');
    const main = join(root, "src/main.ts");
    writeFileSync(main, "import { register } from 'opaque'; import { helper } from './helper'; export function main() { return register(() => helper()); }\n");
    writeFileSync(join(root, "src/helper.ts"), "export function helper() { return 1; }\n");
    writeFileSync(join(root, "src/main.test.ts"), "import { main } from './main'; import { helper } from './helper'; export function check() { helper(); return main(); }\n");
    git(root, "init", "-q"); git(root, "add", "."); git(root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture");
    initWorkspace(root, { ...createGlobSelectionConfig(root), selectionMode: "qualified-static-v1", analysisProfile: "modelo-suite-static-v1", include: ["src/**/*"] });
    writeFileSync(join(root, "src/helper.ts"), "export function helper() { return 2; }\n");
    indexRepository(root, "2026-10-11T10:00:00.000Z");
    const positive = runVerify(root, { kind: "working-tree" }).report;
    console.info(JSON.stringify({ inlineDirtyPositive: positive.analysisAdmission }));
    expect(positive.analysisAdmission?.status).toBe("admitted");
    expect(positive.recommendedTests.some(test => test.file === "src/main.test.ts")).toBe(true);
    // Same caller/callee coordinates and line: only the sealed source bytes distinguish
    // this graph from the new callback body. A fresh registry must not borrow old edges.
    writeFileSync(main, "import { register } from 'opaque'; import { helper } from './helper'; export function main() { return register(() => { return helper(); }); }\n");
    const staleCalls = runVerify(root, { kind: "working-tree" }).report;
    expect(staleCalls.analysisAdmission?.status).toBe("rejected");
    expect(staleCalls.analysisAdmission?.reasons.some(reason => reason.includes("OPAQUE_CALLBACK_UNSUPPORTED"))).toBe(true);
    indexRepository(root, "2026-10-11T10:00:30.000Z");
    expect(runVerify(root, { kind: "working-tree" }).report.analysisAdmission?.status).toBe("admitted");
    writeFileSync(main, "import { register } from 'opaque'; import { helper } from './helper'; export function main() { return register(() => helper); }\n");
    const stale = runVerify(root, { kind: "working-tree" }).report;
    expect(stale.analysisAdmission?.status).toBe("rejected");
    expect(stale.analysisAdmission?.reasons.some(reason => reason.includes("OPAQUE_CALLBACK_UNSUPPORTED"))).toBe(true);
    indexRepository(root, "2026-10-11T10:01:00.000Z");
    expect(runVerify(root, { kind: "working-tree" }).report.analysisAdmission?.status).toBe("rejected");
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 60_000);

test("public primitive-safe consumer source bytes remain an explicit opaque-data refusal", () => {
  const root = mkdtempSync(join(tmpdir(), "semctx-inline-public-"));
  try {
    createPrimitiveSafeConsumer(root);
    git(root, "init", "-q"); git(root, "add", "."); git(root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture");
    initWorkspace(root, { ...createGlobSelectionConfig(root), selectionMode: "qualified-static-v1", analysisProfile: "modelo-suite-static-v1", include: ["suite/**/*"], languages: { typescript: "on", javascript: "on" } });
    const path = join(root, "suite/domains/sample/core/value.mjs");
    writeFileSync(path, "export function value(input) { return 2 + 2; }\n");
    indexRepository(root, "2026-10-11T10:00:00.000Z");
    const report = runVerify(root, { kind: "working-tree" }).report;
    console.info(JSON.stringify({ publicConsumerAdmission: report.analysisAdmission }));
    expect(report.analysisAdmission?.status).toBe("rejected");
    expect(report.analysisAdmission?.reasons.some(reason => reason.includes("SOURCE_OPAQUE_CALLBACK_UNSUPPORTED"))).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 60_000);
