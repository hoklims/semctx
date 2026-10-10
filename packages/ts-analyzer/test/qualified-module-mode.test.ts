import { expect, test } from "bun:test";
import ts from "typescript";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectModuleConfiguration } from "../src/javascript-diagnostics";
import { extractionContext } from "../src/ts-symbols";

const root = join(tmpdir(), "semctx-module-snapshot").replaceAll("\\", "/");
for (const [file, content, metadata, rejected] of [
  ["global.ts", "const FLAG = 1;", {}, true],
  ["global.d.ts", "declare const FLAG: number;", {}, true],
  ["augment.ts", "export {}; declare global { const FLAG: number; }", {}, true],
  ["module-augment.ts", "export {}; declare module './main' { interface Registry { extra: number } }", {}, true],
  ["explicit.ts", "export const FLAG = 1;", {}, false],
  ["implicit.mjs", "const FLAG = 1;", {}, false],
  ["implicit.mts", "const FLAG = 1;", {}, false],
  ["packaged.ts", "const FLAG = 1;", { "package.json": '{"type":"module"}' }, true],
  ["nested/file.js", "const FLAG = 1;", { "package.json": '{"type":"module"}', "nested/package.json": '{"type":"commonjs"}' }, true],
  ["forced.ts", "const FLAG = 1;", { "tsconfig.json": '{"extends":"./base.json"}', "base.json": '{"compilerOptions":{"moduleDetection":"force"}}' }, true],
  ["forced.d.ts", "declare const FLAG: number;", { "tsconfig.json": '{"compilerOptions":{"moduleDetection":"force"}}' }, true],
] as const) test(`round3 retained module mode respects ${file}`, () => {
  const path = `${root}/${file}`;
  const inputs = new Map<string, string>([[path, content], ...Object.entries(metadata).map(([name, value]) => [`${root}/${name}`, value] as [string, string])]);
  const source = extractionContext.createProgram([path], inputs).getSourceFile(path)!;
  expect(ts.isExternalModule(source)).toBe(file.includes("augment") || !rejected);
  const reasons = inspectModuleConfiguration(path, root, inputs, source);
  expect(reasons.some(reason => /SOURCE_(?:GLOBAL_SCRIPT|GLOBAL_AUGMENTATION|MODULE_AUGMENTATION)_UNSUPPORTED/.test(reason))).toBe(rejected);
});
