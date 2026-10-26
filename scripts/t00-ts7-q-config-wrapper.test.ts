import { expect, test } from "bun:test";
import { projectRuntimeModule, type WrapperOracleInput } from "./t00-ts7-q-config-wrapper";

const base: WrapperOracleInput = {
  containing_file: "/repo/main.mjs", specifier: "./target.mjs", configured: true, retained: false,
  declaration_path: "/repo/target.d.mts", runtime_exists: true,
  repository_root: "/repo", canonical_root: { path: "/repo" }, canonical_runtime: { path: "/repo/target.mjs" },
};

test("wrapper oracle preserves configured and snapshot alternatives without consulting producer output", () => {
  expect(projectRuntimeModule(base).resolved_path).toBe("/repo/target.mjs");
  expect(projectRuntimeModule({ ...base, configured: false }).resolved_path).toBe("/repo/target.d.mts");
  expect(projectRuntimeModule({ ...base, configured: false }).runtime_exists).toBe(null);
  expect(projectRuntimeModule({ ...base, runtime_exists: false }).resolved_path).toBe("/repo/target.d.mts");
  expect(projectRuntimeModule({ ...base, declaration_path: null }).resolved_path).toBe(null);
  expect(projectRuntimeModule({ ...base, declaration_path: "/repo/target.ts" }).resolved_path).toBe("/repo/target.ts");
  expect(projectRuntimeModule({ ...base, retained: true, canonical_root: { error: "must_not_be_used" } }).resolved_path).toBe("/repo/target.mjs");
});

test("wrapper oracle rejects canonical escape and both exception sites while recording the lexical refused input", () => {
  for (const variant of [
    { canonical_runtime: { path: "/outside/target.mjs" } },
    { canonical_root: { error: "root_failure" } },
    { canonical_runtime: { error: "runtime_failure" } },
  ]) {
    const result = projectRuntimeModule({ ...base, ...variant });
    expect(result.resolved_path).toBe(null);
    expect(result.canonical_attempted).toBe(true);
    expect(result.refused_inputs).toEqual(["/repo/target.mjs"]);
  }
  expect(projectRuntimeModule({ ...base, repository_root: undefined, canonical_runtime: { path: "/outside/target.mjs" } }).resolved_path).toBe("/repo/target.mjs");
  expect(projectRuntimeModule({ ...base, canonical_runtime: { path: "/repository/target.mjs" } }).resolved_path).toBe(null);
});

test("wrapper oracle projects each declaration extension and requires complete canonical evidence when activated", () => {
  for (const [declaration, runtime] of [["target.d.ts", "target.js"], ["target.d.mts", "target.mjs"], ["target.d.cts", "target.cjs"]]) {
    expect(projectRuntimeModule({ ...base, retained: true, declaration_path: `/repo/${declaration}` }).resolved_path).toBe(`/repo/${runtime}`);
  }
  expect(() => projectRuntimeModule({ ...base, canonical_runtime: undefined })).toThrow("canonical evidence missing");
  expect(() => projectRuntimeModule({ ...base, canonical_root: undefined })).toThrow("canonical evidence missing");
});

test("owning wrapper comparison requires extraction, exact branch activation and refused-input presence", async () => {
  const { evaluateRuntimeWrapper } = await import("./t00-ts7-q-config-wrapper");
  const input = { ...base, canonical_runtime: { path: "/outside/target.mjs" } };
  const expected = projectRuntimeModule(input);
  const trace = { configured: input.configured, retained: input.retained, declaration_path: input.declaration_path,
    runtime_path: expected.runtime_path, runtime_exists: expected.runtime_exists, canonical_attempted: expected.canonical_attempted,
    canonical_errors: expected.canonical_errors, resolved_path: expected.resolved_path };
  const observed = { executed: true, unsupported: [], configured: true, retained: false,
    extraction: { imports: [{ fromRelPath: "main.mjs", moduleSpecifier: "./target.mjs" }] }, sdk_input_id: "sdk", runtime_resolution: [trace], inputs: { "/repo/target.mjs": null } };
  expect(evaluateRuntimeWrapper(observed, expected, input, "/repo", "sdk")).toBe(true);
  for (const altered of [
    { ...observed, executed: false }, { ...observed, unsupported: ["unsupported"] },
    { ...observed, sdk_input_id: "stale-sdk" }, { ...observed, sdk_input_id: undefined },
    { ...observed, runtime_resolution: [{ ...trace, runtime_exists: false }] },
    { ...observed, runtime_resolution: [{ ...trace, canonical_attempted: false }] },
    { ...observed, extraction: { imports: [{ fromRelPath: "main.mjs", moduleSpecifier: "./target.mjs", resolvedRelPath: "target.d.mts" }] } },
    { ...observed, inputs: {} },
  ]) expect(evaluateRuntimeWrapper(altered, expected, input, "/repo", "sdk")).toBe(false);
});
