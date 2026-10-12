import { expect, test } from "bun:test";
import { inspectModuleConfiguration } from "../src";

for (const extension of ["ts", "mjs"]) for (const method of ["join", "toLocaleString"]) {
  test(`mutated literal array ${method} refuses ${extension}`, () => {
    const hook = method === "join" ? "toString" : "toLocaleString";
    const assertion = extension === "ts" ? " as any" : "";
    const source = `function hidden() { return 1; } const values = [1]; values[0] = { ${hook}: () => hidden() }${assertion}; export function run() { return values.${method}(); }`;
    const path = `/fixture/main.${extension}`;
    const reasons = inspectModuleConfiguration(path, "/fixture", new Map([[path, source]]));
    console.info(JSON.stringify({ extension, method, reasons }));
    expect(reasons).toContain("SOURCE_COERCION_UNSUPPORTED");
  });
}

for (const method of ["join", "toLocaleString"]) {
  test(`${method} does not trust const array aliases or mutator calls`, () => {
    for (const source of [
      `const values = [1]; export function run() { return values.${method}(); }`,
      `function hidden() { return 1; } const values = [1]; const alias = values; alias[0] = { toString: hidden, toLocaleString: hidden } as any; export function run() { return values.${method}(); }`,
      `function hidden() { return 1; } const values = [1]; values.push({ toString: hidden, toLocaleString: hidden } as any); export function run() { return values.${method}(); }`,
    ]) {
      const path = "/fixture/main.ts";
      expect(inspectModuleConfiguration(path, "/fixture", new Map([[path, source]]))).toContain("SOURCE_COERCION_UNSUPPORTED");
    }
  });
  test(`fresh ${method} primitive literals and primitive aliases stay eligible`, () => {
    for (const source of [
      `export function run() { return [1, 'one', true, null, undefined].${method}(); }`,
      `export function run() { return [].${method}(); }`,
      `const value = 1; const alias = value; export function run() { return [alias].${method}(); }`,
      method === "join"
        ? "const separator = ','; const alias = separator; export function run() { return [1, 2].join(alias); }"
        : "const locale = 'en-US'; const digits = 0; export function run() { return [1].toLocaleString(locale, { maximumFractionDigits: digits }); }",
      `const own = { ${method}() { return 1; } }; export function run() { return own.${method}(); }`,
      `const member = [1].${method}; const alias = member; export function run() { return alias(); }`,
      `export function run() { return ([1] as number[]).${method}(); }`,
    ]) {
      const path = "/fixture/main.ts";
      expect(inspectModuleConfiguration(path, "/fixture", new Map([[path, source]]))).toEqual([]);
    }
  });
}

test("native array coercion actually invokes the replaced element hooks", () => {
  for (const method of ["join", "toLocaleString"]) {
    const hook = method === "join" ? "toString" : "toLocaleString";
    const source = `function hidden() { return 'HIDDEN_CALLED'; } const values = [1]; values[0] = { ${hook}: () => hidden() }; if (values.${method}() !== 'HIDDEN_CALLED') throw Error('missing implicit invocation');`;
    const result = Bun.spawnSync([process.execPath, "-e", source], { stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode).toBe(0);
  }
});
