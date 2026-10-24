import { expect, test } from "bun:test";
import { inspectModuleConfiguration } from "../packages/ts-analyzer/src/javascript-diagnostics.js";
import { cases } from "./t00-ts7-q-syntax-j.js";

for (const [name, semanticImport] of [
  ["J-jsdoc-type", true],
  ["J-jsdoc-typedef", true],
  ["J-jsdoc-import-tag", true],
  ["J-jsdoc-nested", true],
  ["J-jsdoc-prose-control", false],
  ["J-jsdoc-ordinary-control", false],
  ["J-jsdoc-typescript-control", false],
] as const) {
  test(`historical diagnostic consumer isolates the JSDoc boundary: ${name}`, () => {
    const item = cases.find(item => item.name === name)!;
    const files = item.request.files as Record<string, string>;
    const filename = item.oracleInput.filename as string;
    const path = `/fixture/${filename}`;
    const inputs = new Map(Object.entries(files).map(([name, source]) => [`/fixture/${name}`, source]));
    expect(inspectModuleConfiguration(path, "/fixture", inputs)).toEqual(
      semanticImport ? ["SOURCE_JSDOC_IMPORT_UNSUPPORTED"] : [],
    );
  });
}
