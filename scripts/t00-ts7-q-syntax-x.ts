import type { CampaignCase } from "./t00-ts7-q-syntax-types.ts";

const symbolSource = [
  "/** Earlier 😀 */",
  "/** Closest documentation */",
  "export function outer() {",
  " const arrow = () => { function nestedArrow() {} };",
  " const expression = function () { function nestedExpression() {} };",
  " const ordinary = 3, wrapped = (() => 1);",
  " class Service { method() { function nestedMethod() {} } ['quoted']() { function underQuoted() {} } }",
  "}",
  "// ordinary comment",
  "class Local {}",
  "export interface Shape { member(): void }",
  "export type Alias = Shape;",
  "export enum Choice { First }",
  "declare function declared(value: string): void;",
  "namespace Space { export const arrow = () => { function local() {} }; export const expression = function () { class Inner {} }; }",
  "export default function () { function underDefault() {} }",
  "export default class { method() { function underClass() {} } }",
  "function plain() {}",
].join("\r\n");

const callerSource = [
  "unresolved(); receiver.method(); receiver['excluded'](); (condition ? left : right)(); tag`excluded`;",
  "(paren)(); (asserted as any)(); (<any>assertion)(); nonnull!(); (satisfied satisfies any)();",
  "const value = { method() { insideMethod(); }, get property() { insideGetter(); return 1; }, set property(v) { insideSetter(); },",
  " arrow: (() => insideArrow()), asserted: ((() => insideAs()) as any),",
  " typed: (<any>(() => insideAssertion())), nonnull: (() => insideNonnull())!,",
  " satisfied: ((() => insideSatisfies()) satisfies any) };",
  "function outside() { absentExternalForT00(); }",
  "const localArrow = () => externalArrow(), localExpression = function () { externalExpression(); };",
  "import('./absent'); import(dynamicSpecifier); new MissingConstructor();",
].join("\n");

const importSource = [
  "import './side-effect';",
  "import DefaultName from './default';",
  "import * as space from './namespace';",
  "import { original, original as renamed, type TypeOnly } from './named';",
  "import Both, { original as local, type TypeOnly } from './combined';",
  "import type TypeDefault from './type-default';",
  "import type * as typeSpace from './type-namespace';",
  "import type { TypeOnly } from './type-named';",
].join("\n");

function extractionCase(
  name: string,
  indices: number[],
  files: Record<string, string>,
  projections: string[],
  gaps?: Record<number, string>,
  retained = true,
): CampaignCase {
  return {
    name,
    indices,
    mode: "raw",
    request: { files, roots: Object.keys(files), retained, qualified: false },
    oracleInput: {
      operation: "extraction",
      files,
      retained,
      syntheticOwnerAbsence: indices.includes(209),
    },
    checks: [
      ...new Set([...projections, "modules", "symbols", "imports", "calls"]),
    ].map((projection) => ({
      name: `complete-${projection}`,
      actual: ["raw_extraction", projection],
      expected: ["observation", projection],
    })),
    ...(gaps === undefined ? {} : { gaps }),
  };
}

const historicalLeaf = "/** Public leaf. */\nexport function leaf() { return 1; }\nexport interface Shape { value: number }\nexport type Flag = boolean;\n";

function historicalLeafCase(name: string, source: string): CampaignCase {
  const item = extractionCase(name, [185, 186], { "entry.ts": source }, ["symbols"]);
  return {
    ...item,
    oracleInput: { ...item.oracleInput, historicalConsumerFile: "entry.ts" },
    checks: [...item.checks,
      { name: "historical-outline", actual: ["outlines", "entry.ts", "outline", "statements"], expected: ["observation", "outline", "statements"], transform: "outline-statements-without-digest" },
      { name: "historical-jsdoc-reasons", actual: ["subjects", 0, "moduleConfigurationObservations", "retainedWithSource", "reasons"], expected: ["observation", "syntax", "moduleConfigurationReasons"] },
    ],
  };
}

function callableCase(name: string, source: string): CampaignCase {
  const files = { "main.ts": source, "dep.ts": "export function helper() {} export default function main() {}" };
  return {
    name,
    indices: [206, 207, 208],
    mode: "raw",
    request: { files, roots: ["main.ts"], retained: true, qualified: false },
    oracleInput: { operation: "extraction", files, filename: "main.ts", callableInitializers: true },
    checks: [{ name: "retained-callable-initializers", actual: ["subjects", 0, "retainedCallableInitializers"], expected: ["observation"] }],
  };
}

function opaqueOwnershipCase(name: string, body: string): CampaignCase {
  const files = { "main.ts": `import { register } from 'opaque'; function helper() { return 1; } export function main() { return register(() => ${body}); }`, "package.json": '{"dependencies":{"opaque":"1.0.0"}}' };
  return {
    name, indices: [206], mode: "raw",
    request: { files, roots: ["main.ts"], retained: true, qualified: true },
    oracleInput: { operation: "extraction", callableInitializers: true, opaqueOwnership: true, filename: "main.ts", files },
    checks: [
      { name: "opaque-call-coordinates", actual: ["raw_extraction", "calls"], expected: ["observation", "calls"] },
      { name: "opaque-ownership-executed", actual: ["subjects", 0, "opaqueCallbackOwnership", "executed"], expected: ["observation", "executed"] },
      { name: "opaque-ownership-support", actual: ["subjects", 0, "opaqueCallbackOwnership", "unsupported"], expected: ["observation", "unsupported"] },
      ...([ ["beforeAnalysis", "beforeOpaqueReason"], ["afterAnalysis", "afterOpaqueReason"], ["afterGraphEdgesRemoved", "removedOpaqueReason"] ] as const).flatMap(([phase, expected]) => [
        { name: `opaque-${phase}-reason`, actual: ["subjects", 0, "opaqueCallbackOwnership", phase, "reasons"], expected: ["observation", expected], transform: "opaque-callback-reason" as const },
        { name: `opaque-${phase}-executed`, actual: ["subjects", 0, "opaqueCallbackOwnership", phase, "executed"], expected: ["observation", "executed"] },
        { name: `opaque-${phase}-supported`, actual: ["subjects", 0, "opaqueCallbackOwnership", phase, "unsupported"], expected: ["observation", "unsupported"] },
      ]),
    ],
  };
}

function resolvedHelperCase(name: string, filename: string, source: string, dependencies: Record<string, string> = {}): CampaignCase {
  const files = { [filename]: source, ...dependencies };
  return {
    name, indices: [189, 221], mode: "raw",
    request: { files, roots: [filename], retained: true, qualified: false },
    oracleInput: { operation: "extraction", files, filename, callableInitializers: true, opaqueOwnership: true },
    checks: [{ name: "actual-helper-endpoints", actual: ["raw_extraction", "calls"], expected: ["observation", "calls"] }],
  };
}

function owningExtractionCase(name: string, indices: number[], files: Record<string, string>, qualified = false): CampaignCase {
  const roots = Object.keys(files);
  return {
    name, indices, mode: "raw",
    request: { files, roots, retained: true, qualified },
    oracleInput: { operation: "extraction", files, roots, filename: roots[0], completeExtraction: true },
    checks: ["modules", "symbols", "imports", "calls"].map(projection => ({
      name: `complete-${projection}`, actual: ["raw_extraction", projection], expected: ["observation", projection],
    })),
  };
}

function objectOwnerCase(name: string, source: string): CampaignCase {
  const item = owningExtractionCase(name, [180], { "main.ts": source }, true);
  return {
    ...item,
    checks: [...item.checks,
      { name: "qualified-caller-integrity", actual: ["assembly", "integrityReasons"], expected: ["observation", "integrityReasons"] },
      { name: "qualified-call-edge-count", actual: ["assembly", "edges"], expected: ["observation", "callEdgeCount"], transform: "call-edge-count" },
    ],
  };
}

const constructorExtraction = owningExtractionCase("x-owning-constructor-invocation-gap", [209], { "main.ts": "function touch() { return 1; } export class Helper { constructor() { touch(); } } export function make() { return new Helper(); }" });

export const cases: CampaignCase[] = [
  objectOwnerCase("x-owning-object-member-caller", "function helper(){return 1;} export const box={run(){return helper();}};"),
  objectOwnerCase("x-owning-named-caller-control", "function helper(){return 1;} export function run(){return helper();}"),
  {
    ...constructorExtraction,
    checks: [...constructorExtraction.checks,
      { name: "construction-remains-unmodeled", actual: ["subjects", 0, "moduleConfigurationObservations", "retainedWithSource", "reasons"], expected: ["observation", "constructionReason"], transform: "construction-reason" },
    ],
  },
  owningExtractionCase("x-owning-anonymous-default-nested-caller", [209], {
    "default.mjs": "export default function () { function nested() { return 1; } return nested(); }",
    "caller.mjs": "import value from './default.mjs'; export function caller() { return value(); }",
  }),
  resolvedHelperCase("x-resolved-helper-wrappers", "main.ts", 'import * as endpointNamespace from "./lib.mjs"; function helper() {} export function caller() { helper(); (((helper)))(); ((helper as typeof helper))(); (<typeof helper>helper)(); ((helper satisfies typeof helper))!(); endpointNamespace.helper(); (true ? helper : helper)(); }', { "lib.mjs": "export function helper() {} export function unused() {}" }),
  resolvedHelperCase("x-resolved-helper-parentheses-mjs", "lib.mjs", "export function helper() {} export function unused() {} export function caller() { return (((helper)))(); }"),
  opaqueOwnershipCase("x-opaque-inline-graph-owner", "helper()"),
  opaqueOwnershipCase("x-opaque-no-owned-reference-control", "1"),
  {
    name: "x-historical-jsdoc-import-active",
    indices: [185],
    mode: "raw",
    request: { files: { "main.js": '/** @type {import("./types.js").Shape} */\nlet value; export {};' }, roots: ["main.js"], retained: true },
    oracleInput: { operation: "syntax", filename: "main.js", source: '/** @type {import("./types.js").Shape} */\nlet value; export {};' },
    checks: [{ name: "jsdoc-import-reason-active", actual: ["subjects", 0, "moduleConfigurationObservations", "retainedWithSource", "reasons"], expected: ["observation", "moduleConfigurationReasons"] }],
  },
  historicalLeafCase("x-historical-leaf-doc-lines", historicalLeaf),
  historicalLeafCase("x-historical-leaf-doc-lines-crlf", historicalLeaf.replaceAll("\n", "\r\n")),
  historicalLeafCase("x-historical-no-jsdoc-control", historicalLeaf.replace("/** Public leaf. */", "/* ordinary 😀 */")),
  ...[
    ["value-origin", 'import { helper } from "./dep"; const observed = helper;'],
    ["specifier-type-origin", 'import { type helper } from "./dep"; const observed = helper;'],
    ["clause-type-origin", 'import type main from "./dep"; const observed = main;'],
    ["namespace-type-origin", 'import type * as ns from "./dep"; const observed = ns.helper;'],
    ["arrow-data-control", 'const value = () => 1; const observed = value; const data = 1; const observedData = data; let uninitialized;'],
    ["callable-forms", 'class Service { method() {} } function implemented() {} declare function signatureOnly(): void; const expression = function() {}; const observedClass = Service; const observedFunction = implemented; const observedSignature = signatureOnly; const observedExpression = expression; const observedMethod = Service.prototype.method;'],
  ].map(([name, source]) => callableCase(`x-callable-${name}`, source!)),
  {
    ...extractionCase("x-function-owner-coordinates", [209], { "owners.ts": "declare function declared(): void;\nexport default function () { function nested() {} }\nfunction named() {}" }, ["symbols"]),
    checks: [
      { name: "retained-function-owner-coordinates", actual: ["subjects", 0, "retainedFunctionOwners", "functions"], expected: ["observation", "functionOwners"] },
      { name: "retained-function-owner-absence-pairs", actual: ["subjects", 0, "retainedFunctionOwners", "ownerAbsenceCases"], expected: ["observation", "ownerAbsenceCases"] },
    ],
  },
  extractionCase(
    "x-symbols-scopes-docs-utf16",
    [178, 182, 183, 185, 186, 215],
    {
      "main.ts": symbolSource,
      "types.d.ts": "export declare function ignored(): void;",
    },
    ["symbols"],
    undefined,
  ),
  extractionCase(
    "x-call-names-wrappers-object-owners",
    [180, 184, 189, 221],
    { "calls.ts": callerSource },
    ["calls"],
    {
      184: "Les appels et tagged templates sont comparés ; les raisons SOURCE_ du consommateur parsing ne sont pas liées ici.",
    },
  ),
  extractionCase(
    "x-legacy-export-and-wrapper-controls",
    [182, 221],
    {
      "legacy.ts":
        "function leaf() {}\nexport { leaf };\nunresolved(); (parenthesized)(); (asserted as any)();",
    },
    ["symbols", "calls"],
    undefined,
    false,
  ),
  extractionCase(
    "x-import-name-forms-and-type-controls",
    [181],
    { "imports.ts": importSource },
    ["imports"],
  ),
  extractionCase(
    "x-checker-and-private-frontier-gaps",
    [176, 177, 179, 187, 188, 190, 191, 197, 214, 222],
    {
      "owners.ts": [
        "declare function declared(): void;",
        "function () {}",
        "export default function () {}",
        "function named() {}",
      ].join("\n"),
    },
    ["symbols"],
    {
      176: "Le raw extractor ne projette pas le propriétaire interface de retainedCallableCoordinate ; oracle checker indépendant absent.",
      177: "Program/checker, exports et alias non projetés par cet oracle syntaxique ; comparaison cumulative de l'extraction complète manquante.",
      179: "Le parcours syntaxique est exercé, mais résolution checker et ensemble complet modules/imports/calls ne disposent pas d'oracle indépendant.",
      187: "Les usages littéraux avec leur mode de résolution ne sont pas exposés par la projection raw employée.",
      188: "Les sept formes et les contrôles du mode CommonJS exigent une projection indépendante du partitionnement ; absente.",
      190: "Alias et déclarations de cibles namespace exigent le checker ; aucun attendu issu du producer n'est substitué.",
      191: "Récepteurs namespace, bindings destructurés, types et cibles bracket nécessitent un oracle checker indépendant non livré.",
      197: "Cibles importées, absentes, déclaratives et runtime adjoint ne sont pas prouvées par les appels lexicaux non résolus.",
      214: "Les origines runtime shorthand/export/extends et leurs témoins type-only nécessitent un oracle checker indépendant non livré.",
      222: "Les listes importedNames sont exercées ; les bindingTargets runtime/type-only restent sans oracle checker indépendant.",
    },
  ),
];

export const propertyWitnesses: Record<number, Record<string, string[]>> = {
  "178": {
    "owning consumer observable rule(s) in canonical family/call-path contract":
      ["x-symbols-scopes-docs-utf16"],
  },
  "180": {
    "owning consumer observable rule(s) in canonical family/call-path contract":
      ["x-call-names-wrappers-object-owners", "x-owning-object-member-caller", "x-owning-named-caller-control"],
  },
  "181": {
    "canonical default/original names and erased type-only names": [
      "x-import-name-forms-and-type-controls",
    ],
  },
  "182": {
    "symbols exported true": [
      "x-symbols-scopes-docs-utf16",
      "x-legacy-export-and-wrapper-controls",
    ],
    "legacy clause export remains false": [
      "x-symbols-scopes-docs-utf16",
      "x-legacy-export-and-wrapper-controls",
    ],
  },
  "183": {
    "function-expression deferred source specimen exists but is not extractor coverage":
      ["x-symbols-scopes-docs-utf16"],
    "function-declaration owner scope": ["x-symbols-scopes-docs-utf16"],
    "Arrow variable yields actual function symbol; numeric data variable yields no matching symbol.":
      ["x-symbols-scopes-docs-utf16"],
  },
  "185": {
    "leaf.jsdoc exact Public leaf block": ["x-historical-leaf-doc-lines", "x-historical-leaf-doc-lines-crlf", "x-historical-no-jsdoc-control"],
    "JSDOC_IMPORT reason absent only": ["x-historical-leaf-doc-lines", "x-historical-no-jsdoc-control", "x-historical-jsdoc-import-active"],
  },
  "186": {
    "symbol start/end lines 2,3,4": ["x-historical-leaf-doc-lines", "x-historical-leaf-doc-lines-crlf", "x-historical-no-jsdoc-control", "x-symbols-scopes-docs-utf16"],
    "outline statement 1..4 only, separate lineOf consumer": ["x-historical-leaf-doc-lines", "x-historical-leaf-doc-lines-crlf"],
  },
  "206": {
    "actual opaque graph owner association": ["x-opaque-inline-graph-owner", "x-opaque-no-owned-reference-control"],
    "type-only receiver undefined versus value function coordinate": ["x-callable-value-origin", "x-callable-specifier-type-origin", "x-callable-clause-type-origin", "x-callable-namespace-type-origin"],
    "Callable declaration coordinate versus undefined for noncallable data after same origin guard": ["x-callable-arrow-data-control", "x-callable-callable-forms"],
  },
  "207": {
    "three receiver origin refusals and value control": ["x-callable-value-origin", "x-callable-specifier-type-origin", "x-callable-clause-type-origin", "x-callable-namespace-type-origin"],
  },
  "208": {
    "function implementation accepted; type-only denied earlier": ["x-callable-value-origin", "x-callable-specifier-type-origin", "x-callable-clause-type-origin", "x-callable-namespace-type-origin", "x-callable-callable-forms"],
    "Callable arrow declaration gives main.ts/value; data declaration gives undefined after same receiver-origin guard.": ["x-callable-arrow-data-control"],
  },
  "209": {
    "owning consumer observable rule(s) in canonical family/call-path contract": ["x-function-owner-coordinates", "x-owning-constructor-invocation-gap", "x-owning-anonymous-default-nested-caller"],
  },
  "189": {
    "identifier helper endpoint": ["x-call-names-wrappers-object-owners", "x-resolved-helper-wrappers", "x-resolved-helper-parentheses-mjs"],
    "property helper endpoint": ["x-call-names-wrappers-object-owners", "x-resolved-helper-wrappers"],
    "conditional name absent/refusal": ["x-call-names-wrappers-object-owners"],
  },
  "215": {
    "default declaration and nested scopes": ["x-symbols-scopes-docs-utf16"],
    "method-contained scopes": ["x-symbols-scopes-docs-utf16"],
  },
  "221": {
    "parentheses retain actual helper": [
      "x-resolved-helper-wrappers", "x-resolved-helper-parentheses-mjs",
      "x-call-names-wrappers-object-owners",
      "x-legacy-export-and-wrapper-controls",
    ],
    "as-expression retained versus legacy absence": [
      "x-resolved-helper-wrappers",
      "x-call-names-wrappers-object-owners",
      "x-legacy-export-and-wrapper-controls",
    ],
  },
};
