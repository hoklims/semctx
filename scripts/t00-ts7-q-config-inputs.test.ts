import { expect, test } from "bun:test";
import { completeInputsMatch } from "./t00-ts7-q-config-inputs";

const expected = {
  "/Sandbox/Repo/package.json": '{"workspaces":["Packages/*"],"dependencies":{"Pkg":"workspace:*"}}',
  "/Sandbox/Repo/pnpm-workspace.yaml": null,
  "/Sandbox/Repo/Packages/Member/package.json": '{"name":"Pkg","version":"1.0.0"}',
  "/Sandbox/Repo/Packages/Member/Base.json": "workspace bytes\n",
};

test("compares every causal input key and exact bytes with lexical casing intact", () => {
  expect(completeInputsMatch(expected, expected)).toBe(true);
  expect(completeInputsMatch(Object.fromEntries(Object.entries(expected).reverse()), expected)).toBe(true);
  expect(completeInputsMatch({}, {})).toBe(true);
});

test("rejects acquisition leakage, missing attempts, wrong content and physical alias substitution", () => {
  for (const altered of [
    { ...expected, "/Sandbox/Repo/Unused.ts": "export {};\n" },
    Object.fromEntries(Object.entries(expected).filter(([path]) => !path.endsWith("pnpm-workspace.yaml"))),
    { ...expected, "/Sandbox/Repo/node_modules/Pkg/Base.json": null },
    { ...expected, "/Sandbox/Repo/Packages/Member/Base.json": "substituted" },
    Object.fromEntries(Object.entries(expected).map(([path, text]) => [path.toLowerCase(), text])),
    [], null, undefined, "invalid", { ...expected, "/Sandbox/Repo/Bad": undefined },
  ]) expect(completeInputsMatch(altered, expected)).toBe(false);
  expect(completeInputsMatch({ "/repo/Alias.json": "bytes" }, { "/repo/Target.json": "bytes" })).toBe(false);
  expect(completeInputsMatch({ "/repo/read": "null" }, { "/repo/read": null })).toBe(false);
});
