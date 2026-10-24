import type { CampaignCase } from "./t00-ts7-q-syntax-types.js";

function partitionCase(name: string, files: Record<string, string>, roots = Object.keys(files)): CampaignCase {
  return {
    name: `checker-partition-${name}`,
    indices: [187, 188],
    mode: "raw",
    request: { files, roots, retained: false, qualified: false },
    oracleInput: { operation: "checker-partition", files, roots },
    checks: ["executed", "unsupported", "loadedRepositorySources", "selectedRoots", "dependencyComponents", "resolvedEdges"]
      .map(field => ({ name: field, actual: ["partitionObservation", field], expected: ["observation", field] })),
  };
}

const forms = [
  ["re-export", "export { value } from './target'"],
  ["export-type", "export type { Shape } from './target'"],
  ["import-type", "import type { Shape } from './target'; export function read(value: Shape) { return value.id }"],
  ["dynamic-import", "export async function load() { return import('./target') }"],
  ["import-type-expression", "export type Loaded = typeof import('./target')"],
  ["require", "const target = require('./target'); export const loaded = target.value"],
  ["import-equals-require", "import target = require('./target'); export const loaded = target.value"],
] as const;

const conditionalFiles = {
  "cjs.ts": "export const value = 1",
  "esm.ts": "export const value = 2",
  "package.json": JSON.stringify({ type: "module", imports: { "#choice": { import: "./esm.ts", require: "./cjs.ts" } } }),
};

export const cases: CampaignCase[] = [
  ...forms.map(([name, source]) => partitionCase(name, {
    "source.ts": source,
    "target.ts": "export interface Shape { id: string }; export const value = 1",
    "independent.ts": "export const independent = true",
  })),
  partitionCase("loaded-intermediate", {
    "a.ts": "import { middle } from './middle'; export const a = middle + 1",
    "middle.ts": "import { b } from './b'; export const middle = b + 1",
    "b.ts": "export const b = 1",
    "independent.ts": "export const independent = true",
  }, ["a.ts", "b.ts", "independent.ts"]),
  partitionCase("nonliteral-controls", {
    "source.ts": "const specifier = './target'; import(specifier); require(specifier); object.require('./target'); const text = './target'; export {}",
    "target.ts": "export const value = 1",
  }),
  partitionCase("unresolved-control", {
    "source.ts": "export { absent } from './missing'; export const load = () => import('./missing')",
    "target.ts": "export const value = 1",
  }),
  partitionCase("external-control", {
    "a.ts": "import { value } from 'external'; export const a = value",
    "b.ts": "import { value } from 'external'; export const b = value",
    "node_modules/external/package.json": JSON.stringify({ name: "external", types: "index.d.ts" }),
    "node_modules/external/index.d.ts": "export declare const value: number",
  }, ["a.ts", "b.ts"]),
  partitionCase("commonjs-require-condition", {
    ...conditionalFiles, "source.ts": "const loaded = require('#choice'); export { loaded }",
  }, ["source.ts", "cjs.ts", "esm.ts"]),
  partitionCase("esm-import-condition-control", {
    ...conditionalFiles, "source.ts": "export { value } from '#choice'",
  }, ["source.ts", "cjs.ts", "esm.ts"]),
];

const allWitnesses = cases.map(item => item.name);
export const replacesIndices = [187, 188];
export const propertyWitnesses: Record<number, Record<string, string[]>> = {
  187: {
    "component includes selected endpoints only": allWitnesses,
    "loaded intermediate graph connectivity": allWitnesses,
  },
  188: {
    "literal imported intermediate connects": allWitnesses,
    "links only, not partition connectivity": allWitnesses,
  },
};
