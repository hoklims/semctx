import type { CampaignCase } from "./t00-ts7-q-syntax-types.ts";

export const replacesIndices = [176, 177, 179, 190, 191, 197, 214, 222];

function extractionCase(name: string, indices: number[], files: Record<string, string>, roots = Object.keys(files)): CampaignCase {
  return {
    name, indices, mode: "raw",
    request: { files, roots, retained: true, qualified: false },
    oracleInput: { operation: "checker-extraction", files, roots },
    checks: ["modules", "symbols", "imports", "calls"].map(projection => ({
      name: `checker-complete-${projection}`, comparison: "unordered" as const, actual: ["raw_extraction", projection], expected: ["observation", projection],
    })),
  };
}

const declarations = [
  "export default function main() {}",
  "export function helper() {}",
  "export function sibling() {}",
  "export const arrow = () => 1;",
  "export const FLAG = 7;",
  "export class Base {}",
  "export interface Shape { read(): void; write(): void }",
  "export enum Choice { First }",
  "export type Alias = Shape;",
  "export namespace Inner { export function nested() {} }",
].join("\n");

const canonicalCases: CampaignCase[] = [
  extractionCase("x-canonical-v2-e01-star-barrel-alias-chain-base", [177, 179, 197], {
  "leaf.mjs": "export function helper() { return 1; }\nexport function unused() { return 2; }\n",
  "first.mjs": "export * from './leaf.mjs';\n",
  "second.mjs": "export { helper as facade } from './first.mjs';\n",
  "main.ts": "import { facade as renamed } from './second.mjs';\nexport function main() { return renamed(); }\n"
}, ["leaf.mjs", "first.mjs", "second.mjs", "main.ts"]),
  extractionCase("x-canonical-v2-e02-cyclic-barrels-unique-leaf-base", [177, 179, 197], {
  "leaf.ts": "export function helper() { return 1; }\n",
  "a.ts": "export { helper } from './leaf';\nexport { other } from './b';\n",
  "b.ts": "export { helper } from './a';\nexport function other() { return 2; }\n",
  "main.ts": "import { helper as run } from './b';\nexport function main() { return run(); }\n"
}, ["leaf.ts", "a.ts", "b.ts", "main.ts"]),
  extractionCase("x-canonical-v3-e03-ambiguous-stars-arbitrated-refusal-e03-a-then-b", [177, 179, 197], {
  "a.ts": "export function same() { return 1; }",
  "b.ts": "export function same() { return 2; }",
  "barrel.ts": "export * from './a';\nexport * from './b';",
  "main.ts": "import {same} from './barrel';export function main(){return same();}"
}, ["a.ts", "b.ts", "barrel.ts", "main.ts"]),
  extractionCase("x-canonical-v3-e03-ambiguous-stars-arbitrated-refusal-e03-b-then-a", [177, 179, 197], {
  "a.ts": "export function same() { return 1; }",
  "b.ts": "export function same() { return 2; }",
  "barrel.ts": "export * from './b';\nexport * from './a';",
  "main.ts": "import {same} from './barrel';export function main(){return same();}"
}, ["a.ts", "b.ts", "barrel.ts", "main.ts"]),
  extractionCase("x-canonical-v3-e03-ambiguous-stars-arbitrated-refusal-e03-explicit-named-control", [177, 179, 197], {
  "a.ts": "export function same() { return 1; }",
  "b.ts": "export function same() { return 2; }",
  "barrel.ts": "export {same} from './b';\nexport * from './a';",
  "main.ts": "import {same} from './barrel';export function main(){return same();}"
}, ["a.ts", "b.ts", "barrel.ts", "main.ts"]),
  extractionCase("x-canonical-v2-e04-default-through-barrel-test-owner-base", [177, 179, 197], {
  "leaf.mjs": "export default function namedFn() { return 1; }",
  "barrel.mjs": "export {default as facade} from './leaf.mjs';",
  "leaf.test.js": "import * as api from './barrel.mjs'; const {facade: renamed}=api; expect(renamed).toBeDefined();"
}, ["leaf.mjs", "barrel.mjs", "leaf.test.js"]),
  extractionCase("x-canonical-v2-e05-anonymous-default-nested-owner-base", [177, 179, 197], {
  "default.mjs": "export default function () { function nested() { return 1; } return nested(); }",
  "caller.mjs": "import value from './default.mjs'; export function caller() { return value(); }"
}, ["default.mjs", "caller.mjs"]),
  extractionCase("x-canonical-v2-e06-declaration-runtime-companion-base", [197], {
  "main.mjs": "import {leaf} from './dep.js';export function main(){return leaf();}",
  "dep.d.ts": "export declare function leaf(): number;",
  "dep.js": "export function leaf(){return 1;}"
}, ["main.mjs", "dep.js"]),
  extractionCase("x-canonical-v2-e07-declaration-without-runtime-companion-base", [197], {
  "main.mjs": "import {leaf} from './dep.js';export function main(){return leaf();}",
  "dep.d.ts": "export declare function leaf(): number;"
}, ["main.mjs"]),
  extractionCase("x-canonical-v2-g01-generic-call-keeps-declaration-owner-base", [177, 179, 197], {
  "main.ts": "export function identity<T>(value:T):T { return value; }\nexport function main(){return identity<number>(1);}\n"
}, ["main.ts"]),
  extractionCase("x-canonical-v2-c01-constructor-body-owner-missing-invocation-base", [177, 179, 197], {
  "main.ts": "function touch() { return 1; } export class Helper { constructor() { touch(); } } export function make() { return new Helper(); }"
}, ["main.ts"]),
  extractionCase("x-canonical-v2-c02-method-scopes-keep-distinct-locals-base", [177, 179, 197], {
  "main.ts": "export class Service { read(){function leaf(){return 1;} return leaf();} write(){function leaf(){return 2;} return leaf();} }"
}, ["main.ts"]),
  extractionCase("x-canonical-v2-c03-object-literal-caller-unmodeled-base", [177, 179], {
  "main.ts": "function helper(){return 1;} export const box={run(){return helper();}};"
}, ["main.ts"]),
  extractionCase("x-canonical-v2-f05-internal-reference-no-import-fact-base", [177, 179], {
  "reader.ts": "/// <reference path='./core.ts' />\nexport {};",
  "core.ts": "export function core(){return 1;}"
}, ["reader.ts", "core.ts"]),
].map((item): CampaignCase => {
  if (!item.name.includes("v3-e03-")) return item;
  return {
    ...item,
    request: { ...item.request, qualified: true },
    oracleInput: { ...item.oracleInput, qualified: true },
    checks: [...item.checks,
      { name: "ambiguity-reason", actual: ["subjects", 2, "semanticObservation", "reasons"], expected: ["observation", "exportAmbiguity", "barrel.ts", "reasons"] },
      { name: "ambiguity-outcome", actual: ["subjects", 2, "outcome"], expected: ["observation", "exportAmbiguity", "barrel.ts", "outcome"] },
      { name: "ambiguity-canonical-call-edges", actual: ["assembly"], expected: ["observation", "callEdges"], transform: "logical-call-edges" },
    ],
  };
});

export const cases: CampaignCase[] = [
  ...canonicalCases,
  extractionCase("x-checker-export-alias-complete", [177, 179, 197], {
    "main.ts": "import main, { helper as renamed, arrow } from './api';\nimport './absent';\nexport { renamed };\nexport * from './barrel';\nmain(); renamed(); arrow(); missing(); import('./api');\nimport { excluded } from './unused'; excluded();\nclass Service { read() { function local() {} local(); } write() { function local() {} local(); } }\nexport default function () { function nested() {} nested(); }",
    "api.ts": declarations,
    "barrel.ts": "function local() {}\nconst localArrow = () => 1;\nexport { local as alias, localArrow };",
    "unused.ts": "export function excluded() {}",
    "ambient.d.ts": "export declare function declarationOnly(): void;",
  }, ["main.ts", "api.ts", "barrel.ts", "ambient.d.ts"]),
  extractionCase("x-checker-interface-and-method-owners", [176, 197], {
    "main.ts": "import type { Shape } from './api';\ndeclare const shape: Shape;\nshape.read(); shape.write();\nclass Service { read() { function local() {} local(); } write() { function local() {} local(); } }\nexport default function () { function nested() {} nested(); }\nmissing();",
    "api.ts": declarations,
  }),
  extractionCase("x-checker-namespace-targets", [177, 179, 190, 191, 222], {
    "main.ts": "import * as space from './api';\nspace.helper();\nspace.FLAG; space.Choice.First;\nspace['arrow']();\nconst { helper: renamed, 'arrow': other } = space; renamed(); other();\n(space as typeof space).helper();\n(space!).arrow();\n(space as typeof space).Inner.nested();\n(space.FLAG as any)();\nspace.absent;",
    "api.ts": declarations,
  }),
  extractionCase("x-checker-namespace-controls", [190, 191, 222], {
    "main.ts": "import * as space from './api';\nimport type * as typeSpace from './api';\ntype Signature = typeof space.helper;\ntype TypeSignature = typeof typeSpace.arrow;\nconsume(space);\nconst computed = 'sibling'; space[computed];\nconst { ...rest } = space; consume(rest);\nfunction shadow(space: { helper(): void }) { space.helper(); }",
    "api.ts": declarations,
  }),
  extractionCase("x-checker-runtime-origins", [177, 179, 214, 222], {
    "main.ts": "import main, { helper as shorthand, arrow as exported, Base } from './api';\nimport { helper as called } from './api';\nimport { helper as unused, arrow as erased, Base as Shadowed } from './api';\nimport type TypeDefault from './api';\nimport { type Shape } from './api';\nimport type { Base as TypeBase } from './api';\nimport './api';\nmain(); called();\nconst object = { shorthand };\nexport { exported };\nclass Child extends Base {}\ntype Signature = typeof erased;\nfunction shadow(Shadowed: number) { return Shadowed; }\nexport type { erased };",
    "api.ts": declarations,
  }),
  extractionCase("x-checker-runtime-erased-controls", [214, 222], {
    "main.ts": "import { helper as shorthand, arrow as exported, Base } from './api';\ninterface Erased { shorthand: typeof shorthand }\nexport type { exported };\ninterface Child extends Base {}\ndeclare function ambient(value: typeof shorthand): void;\nimport type main from './api';\nimport * as unusedNamespace from './api';\nimport type * as erasedNamespace from './api';",
    "api.ts": declarations,
  }),
  extractionCase("x-checker-declaration-targets", [197], {
    "main.ts": "import { declared } from './declared';\nimport { absent } from './missing';\ndeclared(); absent(); unknown();",
    "declared.d.ts": "export declare function declared(): void;",
  }),
  extractionCase("x-checker-adjacent-runtime-targets", [197], {
    "main.js": "import { declared } from './declared.js'; declared();",
    "declared.d.ts": "export declare function declared(): void;",
    "declared.js": "export function declared() {}",
  }),
];

export const propertyWitnesses: Record<number, Record<string, string[]>> = {
  176: {
    "symbol scopes Service.read / Service.write": ["x-checker-interface-and-method-owners"],
    "default.nested owner coordinate": ["x-checker-interface-and-method-owners"],
  },
  177: { "owning consumer observable rule(s) in canonical family/call-path contract": [...canonicalCases.filter(item => item.indices.includes(177)).map(item => item.name), "x-checker-export-alias-complete", "x-checker-namespace-targets", "x-checker-runtime-origins"] },
  179: { "owning consumer observable rule(s) in canonical family/call-path contract": [...canonicalCases.filter(item => item.indices.includes(179)).map(item => item.name), "x-checker-export-alias-complete", "x-checker-namespace-targets", "x-checker-runtime-origins"] },
  190: {
    "actual helper only, sibling uncovered": ["x-checker-namespace-targets", "x-checker-namespace-controls"],
    "FLAG with VALUE_DECLARATION; no fabricated symbol": ["x-checker-namespace-targets", "x-checker-namespace-controls"],
  },
  191: {
    "static property owner": ["x-checker-namespace-targets", "x-checker-namespace-controls"],
    "namespace destructuring actual owner": ["x-checker-namespace-targets", "x-checker-namespace-controls"],
    "dynamic whole namespace no coverage": ["x-checker-namespace-targets", "x-checker-namespace-controls"],
  },
  197: { "owning consumer observable rule(s) in canonical family/call-path contract": [...canonicalCases.filter(item => item.indices.includes(197)).map(item => item.name), "x-checker-interface-and-method-owners", "x-checker-declaration-targets", "x-checker-adjacent-runtime-targets", "x-checker-export-alias-complete"] },
  214: {
    "named value runtime reference detected; runtimeUsed field absent": ["x-checker-runtime-origins", "x-checker-runtime-erased-controls"],
    "runtimeUsed false": ["x-checker-runtime-origins", "x-checker-runtime-erased-controls"],
    "unused/type-erased/shadowed three false variants": ["x-checker-runtime-origins", "x-checker-runtime-erased-controls"],
  },
  222: {
    "type-only filtering and default/named vs namespace structural distinction": ["x-checker-runtime-origins", "x-checker-runtime-erased-controls", "x-checker-namespace-targets", "x-checker-namespace-controls"],
    "actual named binding runtime reference detected; runtimeUsed field absent": ["x-checker-runtime-origins", "x-checker-runtime-erased-controls"],
  },
};
