import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

const checker = resolve(import.meta.dir, "../tools/rust-ts-r0/qualification/public-closure-20261022/workspace-replay.py");
const python = process.platform === "win32" ? "python" : "python3";
const valid = { units: [{ id: "public", queries: [{ operation: "read_file", path: "/public/a" }], results: [{ operation: "read_file", path: "/public/a", value: "a" }] }] } as const;

function invoke(code: string, value: unknown) {
  return Bun.spawnSync([python, "-c", `import importlib.util,json,sys;spec=importlib.util.spec_from_file_location('checker',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);value=json.load(sys.stdin);${code}`, checker], { stdin: new TextEncoder().encode(JSON.stringify(value)), stdout: "pipe", stderr: "pipe" });
}

describe("public workspace proof refuses missing comparisons", () => {
  test("accepts complete independent query expectations", () => {
    expect(invoke("m.validate_oracle(value)", valid).exitCode).toBe(0);
  });
  for (const [name, value] of [
    ["empty units", { units: [] }],
    ["duplicate units", { units: [valid.units[0], valid.units[0]] }],
    ["missing results", { units: [{ ...valid.units[0], results: [] }] }],
    ["foreign query operation", { units: [{ ...valid.units[0], results: [{ ...valid.units[0].results[0], operation: "realpath" }] }] }],
    ["foreign query path", { units: [{ ...valid.units[0], results: [{ ...valid.units[0].results[0], path: "/other" }] }] }],
  ] as const) {
    test(name, () => {
      const result = invoke("m.validate_oracle(value)", value);
      expect(result.exitCode).not.toBe(0);
      expect(new TextDecoder().decode(result.stderr)).toContain("WORKSPACE_ORACLE_INVALID");
    });
  }
});

test("public workspace proof binds executed configuration to supplied SDK", () => {
  const result = invoke("sdk={'version':'5.9.3'};observed={'executed':True,'unsupported':[],'configuration':{'executed':True,'unsupported':[]},'sdk_input_id':m.canonical_digest(sdk)};assert m.configuration_context_valid(observed,sdk);observed['configuration']['executed']=False;assert not m.configuration_context_valid(observed,sdk);observed['configuration']['executed']=True;observed['sdk_input_id']='foreign';assert not m.configuration_context_valid(observed,sdk);observed['sdk_input_id']=m.canonical_digest(sdk);observed['unsupported']=['fault'];assert not m.configuration_context_valid(observed,sdk)", {});
  expect(result.exitCode).toBe(0);
});
