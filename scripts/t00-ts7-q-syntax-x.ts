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
  "function outside() { external(); }",
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

export const cases: CampaignCase[] = [
  extractionCase(
    "x-symbols-scopes-docs-utf16",
    [178, 182, 183, 185, 186, 215],
    {
      "main.ts": symbolSource,
      "types.d.ts": "export declare function ignored(): void;",
    },
    ["symbols"],
    {
      185: "La projection JSDoc est exercée, mais le témoin historique leaf et le contrôle JSDOC_IMPORT ne sont pas liés à cette campagne.",
      186: "Les coordonnées CRLF/non-BMP sont exercées ; l'association cumulative avec le consommateur outline historique reste absente.",
    },
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
    [176, 177, 179, 187, 188, 190, 191, 197, 206, 207, 208, 209, 214, 222],
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
      206: "Les coordonnées privées de toutes les formes callable ne sont pas exposées par le protocole raw utilisé.",
      207: "Le rejet des receivers d'import type-only par retainedCallableCoordinate ne se déduit pas de importedNames.",
      208: "Les alternatives d'éligibilité callable exigent une projection de la frontière privée, absente.",
      209: "Oracle TS7 NodeFactory exerce les quatre couples body/name, dont les deux absents, plus default / nommé ; raw ne publie pas retainedFunctionOwnerCoordinate, donc aucun crédit producer.",
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
      ["x-call-names-wrappers-object-owners"],
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
  "189": {
    "identifier helper endpoint": ["x-call-names-wrappers-object-owners"],
    "property helper endpoint": ["x-call-names-wrappers-object-owners"],
    "conditional name absent/refusal": ["x-call-names-wrappers-object-owners"],
  },
  "215": {
    "default declaration and nested scopes": ["x-symbols-scopes-docs-utf16"],
    "method-contained scopes": ["x-symbols-scopes-docs-utf16"],
  },
  "221": {
    "parentheses retain actual helper": [
      "x-call-names-wrappers-object-owners",
      "x-legacy-export-and-wrapper-controls",
    ],
    "as-expression retained versus legacy absence": [
      "x-call-names-wrappers-object-owners",
      "x-legacy-export-and-wrapper-controls",
    ],
  },
};
