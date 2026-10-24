import type { CampaignCase } from "./t00-ts7-q-syntax-types.ts";

const raw = (
  name: string,
  indices: number[],
  filename: string,
  source: string,
  checks: CampaignCase["checks"],
  files: Record<string, string> = {},
): CampaignCase => ({
  name,
  indices,
  mode: "raw",
  request: { files: { [filename]: source, ...files }, roots: [filename], retained: true },
  oracleInput: { operation: "syntax", filename, source, files },
  checks: [...checks,
    { name: "parsing-executed", actual: ["subjects", 0, "sourceParsingObservation", "executed"], expected: ["observation", "executed"] },
    { name: "parsing-support", actual: ["subjects", 0, "sourceParsingObservation", "unsupported"], expected: ["observation", "unsupported"] },
    ...(checks.some(check => check.name === "module-configuration-reasons") ? [
      { name: "configuration-executed", actual: ["subjects", 0, "moduleConfigurationObservations", "retainedWithSource", "executed"], expected: ["observation", "executed"] },
      { name: "configuration-support", actual: ["subjects", 0, "moduleConfigurationObservations", "retainedWithSource", "unsupported"], expected: ["observation", "unsupported"] },
    ] : []),
  ],
});

const scan = { name: "syntax-reasons", actual: ["subjects", 0, "javascript", "reasons"], expected: ["observation", "scanReasons"] } satisfies CampaignCase["checks"][number];
const scope = { name: "module-configuration-reasons", actual: ["subjects", 0, "moduleConfigurationObservations", "retainedWithSource", "reasons"], expected: ["observation", "moduleConfigurationReasons"] } satisfies CampaignCase["checks"][number];
const exports = { name: "static-exports", actual: ["subjects", 0, "javascriptObservation", "staticExports"], expected: ["observation", "staticExports"] } satisfies CampaignCase["checks"][number];
const parsing = { name: "source-parsing-diagnostics", actual: ["subjects", 0, "sourceParsingObservation", "reasons"], expected: ["observation", "parsingReasons"] } satisfies CampaignCase["checks"][number];

const javascriptChecks: CampaignCase["checks"] = [
  { name: "javascript-parse", actual: ["subjects", 0, "javascriptObservation", "parseFailed"], expected: ["observation", "javascriptParseFailed"] },
  { name: "javascript-reasons", actual: ["subjects", 0, "javascriptObservation", "reasons"], expected: ["observation", "javascriptReasons"] },
  { name: "javascript-links", actual: ["subjects", 0, "javascriptObservation", "staticModuleLinks"], expected: ["observation", "staticModuleLinks"] },
  { name: "javascript-executed", actual: ["subjects", 0, "javascriptObservation", "executed"], expected: ["observation", "executed"] },
  { name: "javascript-support", actual: ["subjects", 0, "javascriptObservation", "unsupported"], expected: ["observation", "unsupported"] },
];

export const cases: CampaignCase[] = [
  ...[
    ["type", '/** @type {import("./types.js").Shape} */\nlet value; export {};'],
    ["typedef", '/** @typedef {import("./types.js").Shape} Shape */\nlet value; export {};'],
    ["import-tag", '/** @import { Shape } from "./types.js" */\nlet value; export {};'],
    ["nested", 'export function outer() {\n/** @type {import("./types.js").Shape} */\nlet value; return value;\n}'],
    ["prose-control", '/** Import prose: import("./types.js") is text. */\nexport const value = 1;'],
    ["ordinary-control", '/** @type {number} */\nexport let value;'],
  ].map(([name, source]) => raw(`J-jsdoc-${name}`, [7, 8, 9], "main.js", source!, [scan, scope, parsing, exports, ...javascriptChecks])),
  raw("J-default-as-expression", [10, 11], "main.ts", "const posix = 1; type NodePath = number; export default posix as NodePath;", [scan, scope, parsing]),
  raw("J-jsdoc-typescript-control", [7, 8, 9], "main.ts", '/** @type {import("./types.js").Shape} */\nexport const value = 1;', [scan, scope, parsing]),
  ...[
    ["expression", "export default 1;"],
    ["identifier", "const value = 1; export default value;"],
    ["declaration-control", "export default function named() {}"],
    ["anonymous-declaration-control", "export default function() {}"],
    ["class-control", "export default class {}"],
    ["export-equals-control", "const value = 1; export = value;"],
  ].flatMap(([name, source]) => [raw(`J-default-${name}`, [10, 11], "main.ts", source!, [scan, scope, parsing]), ...(name === "export-equals-control" ? [] : [raw(`J-default-js-${name}`, [10, 11], "main.js", source!, [scan, scope, parsing, exports, ...javascriptChecks])])]),
  ...[
    ["exports", "export const value = 1; export function action() {} export class Service {}"],
    ["default", "export default function () {}"],
    ["private-control", "const value = 1; function action() {} class Service {} export {};"],
    ["destructuring", "export const { value } = { value: 1 };"],
    ["local-exports", "const value = 1; export { value as publicValue };"],
  ].map(([name, source]) => raw(`J-js-exports-${name}`, [17], "main.js", source!, [exports, scan, ...javascriptChecks])),
  ...[
    ["esm", "main.ts", "export const value = 1;"],
    ["script", "main.ts", "const value = 1;"],
    ["mts", "main.mts", "const value = 1;"],
    ["mjs", "main.mjs", "const value = 1;"],
    ["cts", "main.cts", "export const value = 1;"],
    ["cjs", "main.cjs", "export const value = 1;"],
    ["global-augmentation", "main.ts", "export {}; declare global { interface Window { value: number } }"],
    ["module-augmentation", "main.ts", 'export {}; declare module "external" { interface Value {} }'],
    ["namespace-control", "main.ts", "export namespace Local { export const value = 1; }"],
  ].map(([name, filename, source]) => raw(`J-scope-${name}`, [40, 41], filename!, source!, [scope, parsing])),
  ...["main.ts", "main.tsx", "main.js", "main.mjs", "main.cjs", "main.jsx", "main.mts", "main.cts"].flatMap(filename => [
    raw(`J-parser-error-${filename}`, [42, 43], filename, "export const broken = ;", [parsing]),
    raw(`J-parser-type-control-${filename}`, [42, 43], filename, filename.match(/\.(?:ts|tsx|mts|cts)$/) ? 'export const value: number = "wrong";' : "export const value = 1;", [parsing]),
  ]),
  ...[
    ["named-control", "function a() {} a(); export {};"],
    ["wrapped-control", "function a() {} (((a)))(); export {};"],
    ["conditional", "function a() {} function b() {} (true ? a : b)(); export {};"],
    ["element", "const value = { a() {} }; value['a'](); export {};"],
    ["tagged", "function tag() {} tag`value`; export {};"],
  ].flatMap(([name, source]) => ["main.ts", "main.js"].map(filename => raw(`J-invocation-${name}-${filename}`, [19, 48], filename, source!, name === "element" ? [scan, parsing] : [scan, scope, parsing]))),
  ...["main.ts", "main.tsx", "main.js", "main.jsx"].map(filename => {
    const source = "\uFEFFexport const emoji = '😀';\r\nexport function broken( {\u2028";
    return {
      name: `J-primitive-parser-utf16-${filename}`,
      indices: [42, 43],
      mode: "primitive",
      request: { operation: "utf16", units: Array.from({ length: source.length }, (_, i) => source.charCodeAt(i)), offsets_utf16: [], filename },
      oracleInput: { operation: "syntax", source, filename },
      checks: [{ name: "native-parser-diagnostic-coordinates", actual: ["source_parsing_observation", "diagnostics"], expected: ["observation", "diagnostics"] }],
    } satisfies CampaignCase;
  }),
];

export const gaps: Record<number, string> = Object.fromEntries<string>([
  [18, "Declared-external manifest ascent, malformed JSON, workspace/self/ancestor confinement and native system read failures require independent retained-system witnesses; omitted from this syntax projection."],
  ...Array.from({ length: 12 }, (_, index): [number, string] => [28 + index, "Native module alias consumer cumulative closure remains unproved: checker symbol declarations/shorthand/export targets, shadowing, wrapper/destructuring origins, namespace escapes and host module resolution need an independent TS7 Program/checker oracle; parser witnesses alone do not qualify these obligations."]),
  [19, "Tagged/call traversal covered; computed import arity/string controls, with statement, static import/export link resolution and declared-external behavior remain unexercised."],
]);

const jsdocWitnesses = ["J-jsdoc-type", "J-jsdoc-typedef", "J-jsdoc-import-tag", "J-jsdoc-nested", "J-jsdoc-prose-control", "J-jsdoc-ordinary-control", "J-jsdoc-typescript-control"];
const defaultWitnesses = ["J-default-as-expression", "J-default-expression", "J-default-identifier", "J-default-declaration-control", "J-default-anonymous-declaration-control", "J-default-js-expression", "J-default-js-declaration-control", "J-default-js-anonymous-declaration-control"];
const scopeWitnesses = ["J-scope-esm", "J-scope-script", "J-scope-mts", "J-scope-mjs", "J-scope-cts", "J-scope-cjs", "J-scope-global-augmentation", "J-scope-module-augmentation", "J-scope-namespace-control"];
const parserWitnesses = ["J-parser-error-main.ts", "J-parser-error-main.tsx", "J-parser-error-main.js", "J-parser-error-main.jsx", "J-parser-type-control-main.ts", "J-parser-type-control-main.tsx", "J-parser-type-control-main.js", "J-parser-type-control-main.jsx"];

export const propertyWitnesses: Record<number, Record<string, string[]>> = {
  7: { "semantic JS import type/typedef/import tag versus prose/TS documentation": jsdocWitnesses },
  8: { "semantic JS import type/typedef/import tag versus prose/TS documentation": jsdocWitnesses },
  9: { "semantic JS import type/typedef/import tag versus prose/TS documentation": jsdocWitnesses },
  10: { "default export assignment versus declaration": defaultWitnesses },
  11: { "default export assignment versus declaration": defaultWitnesses },
  17: { "owning consumer observable rule(s) in canonical family/call-path contract": ["J-js-exports-exports", "J-js-exports-default", "J-js-exports-private-control", "J-js-exports-destructuring", "J-js-exports-local-exports"] },
  40: { "owning consumer observable rule(s) in canonical family/call-path contract": scopeWitnesses },
  41: { "owning consumer observable rule(s) in canonical family/call-path contract": scopeWitnesses },
  42: { "owning consumer observable rule(s) in canonical family/call-path contract": parserWitnesses },
  43: { "owning consumer observable rule(s) in canonical family/call-path contract": parserWitnesses },
  48: { "TS dynamic versus named callee and tagged template versus call": ["J-invocation-named-control-main.ts", "J-invocation-wrapped-control-main.ts", "J-invocation-conditional-main.ts", "J-invocation-element-main.ts", "J-invocation-tagged-main.ts", "J-invocation-named-control-main.js", "J-invocation-wrapped-control-main.js", "J-invocation-conditional-main.js", "J-invocation-element-main.js", "J-invocation-tagged-main.js"] },
};
