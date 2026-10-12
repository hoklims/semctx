import { expect, test } from "bun:test";
import { inspectJavaScriptSource, inspectModuleConfiguration } from "../src";

for (const extension of ["ts", "js"]) for (const [name, content, reason] of [
  ["nested opaque callback", "import { register } from 'opaque'; function helper() { return 1; } export function run() { return register({ handler: helper }); }", "OPAQUE_CALLBACK_UNSUPPORTED"],
  ["SDK serialization hook", "import { value } from './value'; export function run() { return JSON.stringify(value); }", "SERIALIZATION_UNSUPPORTED"],
] as const) test(`${name} is unsupported for ${extension}`, () => {
  const path = `/fixture/main.${extension}`;
  const snapshot = new Map([[path, content], [`/fixture/value.${extension}`, "export const value = { toJSON() { return 1; } };"], ["/fixture/package.json", '{"dependencies":{"opaque":"1.0.0"}}']]);
  const reasons = extension === "js" ? inspectJavaScriptSource(path, content, "/fixture", snapshot).reasons : inspectModuleConfiguration(path, "/fixture", snapshot);
  console.info(JSON.stringify({ name, extension, reasons }));
  expect(reasons).toContain(`${extension === "js" ? "JAVASCRIPT" : "SOURCE"}_${reason}`);
});

test("direct recursive literal data, primitive serialization and actual own APIs remain distinct", () => {
  for (const content of [
    "import { register } from 'opaque'; register({ nested: { count: 1, values: ['x', 2] } }); export function run() { return 1; }",
    "export function run() { return JSON.stringify('data'); }",
    "const JSON = { stringify(value) { return value; } }; export function run() { return JSON.stringify(1); }",
    "const register = value => value; export function run() { return register({ value: 1 }); }",
  ]) {
    const path = "/fixture/main.ts"; const snapshot = new Map([[path, content], ["/fixture/package.json", '{"dependencies":{"opaque":"1.0.0"}}']]);
    expect(inspectModuleConfiguration(path, "/fixture", snapshot)).toEqual([]);
  }
});
test("container aliases and serializer dispatch cannot supply absence-of-callback proof", () => {
  for (const content of [
    "import { register } from 'opaque'; function helper() { return 1; } const value = { handler: helper }; register(value); export function run() { return 1; }",
    "import { register } from 'opaque'; const value = { count: 1 }; register(value); export function run() { return 1; }",
    "import { value } from './value'; const serialize = JSON.stringify; export function run() { return serialize.call(JSON, value); }",
  ]) {
    const path = "/fixture/main.ts";
    const snapshot = new Map([[path, content], ["/fixture/value.ts", "export const value = { toJSON() { return 1; } };"], ["/fixture/package.json", '{"dependencies":{"opaque":"1.0.0"}}']]);
    expect(inspectModuleConfiguration(path, "/fixture", snapshot).some(reason => reason.includes("UNSUPPORTED"))).toBe(true);
  }
});
