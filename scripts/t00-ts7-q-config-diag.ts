import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { CampaignContext, Evidence, ObligationResult, PropertyResult } from "./t00-ts7-q-config-campaign";
import { compilerDiagnostics } from "./t00-ts7-q-config-cr";
import { runConfigurationLiveBoundaries } from "./t00-ts7-q-config-diag-boundaries";
import { liveConfigurationWitnesses } from "./t00-ts7-q-config-live";
import { semanticWitnessesA, semanticWitnessesAFocal } from "./t00-ts7-q-semantic-witnesses-a";
import { semanticWitnessesB } from "./t00-ts7-q-semantic-witnesses-b";

type Value = Record<string, unknown>;
type PairWitness = { role: "activation" | "control"; pass: boolean; evidence: Evidence[] };
const object = (value: unknown): Value => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Value : {};
const sha = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
const canonical = (value: unknown): string => JSON.stringify(value, (_key, nested: unknown) => nested !== null && typeof nested === "object" && !Array.isArray(nested) ? Object.fromEntries(Object.entries(nested).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : nested);

export function compareConfigurationObservation(value: unknown, expected: string[]): boolean {
  const observation = object(value);
  return observation.executed === true && isDeepStrictEqual(observation.unsupported, []) && Array.isArray(observation.reasons) && observation.reasons.every(reason => typeof reason === "string") && isDeepStrictEqual([...observation.reasons].sort(), [...expected].sort());
}

export function projectConfigurationObservation(value: unknown, prefixes: string[], excludedPrefixes: string[] = []): Value {
  const component = object(value);
  return { ...component, reasons: Array.isArray(component.reasons) && component.reasons.every(reason => typeof reason === "string") ? component.reasons.filter(reason => prefixes.some(prefix => reason.startsWith(prefix)) && !excludedPrefixes.some(prefix => reason.startsWith(prefix))) : component.reasons };
}

export function assessConfigurationPair(property: string, witnesses: PairWitness[]): PropertyResult {
  const evidence = witnesses.flatMap(witness => witness.evidence);
  if (!witnesses.some(witness => witness.role === "activation") || !witnesses.some(witness => witness.role === "control") || witnesses.some(witness => witness.evidence.length === 0)) {
    return { property, status: "not_qualified", reason: "Both activating and control executions with bound evidence are required; incomplete allocation receives no credit.", evidence };
  }
  const passed = witnesses.every(witness => witness.pass);
  return { property, status: passed ? "pass" : "fail", reason: passed ? "Every allocated activation and control matches its independent expected owning-component projection." : "At least one allocated activation/control disagrees with its independent expected result or did not execute cleanly.", evidence };
}

type Fixture = {
  name: string;
  pair: string;
  role: PairWitness["role"];
  indices: number[];
  files: Record<string, string>;
  subject?: string;
  component?: "retainedWithoutSource" | "retainedWithSource" | "ordinaryWithoutSnapshot" | "ordinaryWithSource";
  prefixes?: string[];
  expected?: string[];
  excludedPrefixes?: string[];
  qualified?: boolean;
  retained?: boolean;
  compiler?: boolean;
  suppression?: boolean;
  optionalSource?: boolean;
  sourceAvailable?: boolean;
  parsedSource?: boolean;
  contractSource?: string;
};
const defaults = { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", skipLibCheck: true, noEmit: true };
const source = "export const value = 1;\n";
const config = (options: Value = {}, extra: Value = {}) => JSON.stringify({ compilerOptions: { ...defaults, ...options }, ...extra });
const namedReason = "SOURCE_NAMED_CONFIGURATION_UNSUPPORTED";
const namedPrefixes = ["SOURCE_NAMED_CONFIGURATION_"];
const all = [23, 24, 25, 26, 27, 44, 45, 46, 47];
const fixtures: Fixture[] = [];
function pair(name: string, indices: number[], activation: Omit<Fixture, "name" | "pair" | "role" | "indices">, control: Omit<Fixture, "name" | "pair" | "role" | "indices">): void {
  fixtures.push({ name: `${name}-activation`, pair: name, role: "activation", indices, ...activation }, { name: `${name}-control`, pair: name, role: "control", indices, ...control });
}
for (const depth of [0, 1, 2]) {
  const prefix = "nested/".repeat(depth);
  pair(`named-discovery-depth-${depth}`, [44, 45], {
    files: { "main.ts": source, [`${prefix}main.ts`]: source, [`${prefix}tsconfig.json`]: config({}, { extends: "./tsconfig.extra.json" }), [`${prefix}tsconfig.extra.json`]: "{}" },
    prefixes: namedPrefixes, expected: [],
  }, {
    files: { "main.ts": source, [`${prefix}main.ts`]: source, [`${prefix}tsconfig.extra.json`]: "{}" },
    prefixes: namedPrefixes, expected: [namedReason],
  });
}
for (const extension of ["ts", "tsx", "js", "jsx", "mts", "mtsx", "cts", "ctsx", "mjs", "mjsx", "cjs", "cjsx"]) {
  pair(`named-source-extension-${extension}`, [44, 45], {
    files: { "main.ts": source, [`nested/extra.${extension}`]: source, "nested/tsconfig.json": config({}, { extends: "./tsconfig.extra.json" }), "nested/tsconfig.extra.json": "{}" },
    prefixes: namedPrefixes, expected: [],
  }, {
    files: { "main.ts": source, [`nested/extra.${extension}.txt`]: source, "nested/tsconfig.json": config({}, { extends: "./tsconfig.extra.json" }), "nested/tsconfig.extra.json": "{}" },
    prefixes: namedPrefixes, expected: [namedReason],
  });
}
pair("named-nearest-config", [44, 45], {
  files: { "nested/child/main.ts": source, "tsconfig.json": config({}, { extends: "./tsconfig.extra.json" }), "tsconfig.extra.json": "{}" }, subject: "nested/child/main.ts", prefixes: namedPrefixes, expected: [],
}, {
  files: { "nested/child/main.ts": source, "nested/tsconfig.json": config(), "tsconfig.json": config({}, { extends: "./tsconfig.extra.json" }), "tsconfig.extra.json": "{}" }, subject: "nested/child/main.ts", prefixes: namedPrefixes, expected: [namedReason],
});
pair("named-malformed-governing", [44, 47], {
  files: { "main.ts": source, "tsconfig.json": "{ broken", "tsconfig.extra.json": "{}" }, prefixes: namedPrefixes, expected: [namedReason],
}, {
  files: { "main.ts": source, "tsconfig.json": config({}, { extends: "./tsconfig.extra.json" }), "tsconfig.extra.json": "{}" }, prefixes: namedPrefixes, expected: [],
});
pair("named-malformed-extended-consumed", [44, 47], {
  files: { "main.ts": source, "tsconfig.json": config({}, { extends: "./tsconfig.extra.json" }), "tsconfig.extra.json": "{ broken" }, prefixes: namedPrefixes, expected: [],
}, {
  files: { "main.ts": source, "tsconfig.json": config(), "tsconfig.extra.json": "{ broken" }, prefixes: namedPrefixes, expected: [namedReason],
});
pair("named-transitive-consumption", [44, 47], {
  files: { "main.ts": source, "tsconfig.json": config({}, { extends: "./base.json" }), "base.json": '{"extends":"./tsconfig.extra.json"}', "tsconfig.extra.json": "{}" }, prefixes: namedPrefixes, expected: [],
}, {
  files: { "main.ts": source, "tsconfig.json": config({}, { references: [{ path: "./tsconfig.extra.json" }] }), "tsconfig.extra.json": "{}" }, prefixes: namedPrefixes, expected: [namedReason],
});
for (const [name, text, reason] of [
  ["retained-default-expression", "export default 1;\n", "SOURCE_DEFAULT_EXPRESSION_UNSUPPORTED"],
  ["retained-jsdoc", '/** @typedef {import("./dep").Value} Value */\nexport const value=1;\n', "SOURCE_JSDOC_IMPORT_UNSUPPORTED"],
  ["retained-commonjs", "module.exports = 1;\n", "SOURCE_COMMONJS_UNSUPPORTED"],
] as const) {
  pair(name, [23], { files: { "main.js": text, "dep.d.ts": "export type Value = number;" }, subject: "main.js", prefixes: [reason], expected: [reason] }, { files: { "main.js": source }, subject: "main.js", prefixes: [reason], expected: [] });
}
pair("retained-module-policy", [23], {
  files: { "main.ts": source, "tsconfig.json": config({ module: "CommonJS", moduleResolution: "Node16" }) }, prefixes: ["SOURCE_CONFIGURATION_MODULE_UNSUPPORTED:"], expected: ["SOURCE_CONFIGURATION_MODULE_UNSUPPORTED:CommonJS"],
}, {
  files: { "main.ts": source, "tsconfig.json": config() }, prefixes: ["SOURCE_CONFIGURATION_MODULE_UNSUPPORTED:"], expected: [],
});
pair("retained-resolution-policy", [23], {
  files: { "main.ts": source, "tsconfig.json": config({ module: "NodeNext", moduleResolution: "NodeNext" }) }, prefixes: ["SOURCE_CONFIGURATION_RESOLUTION_UNSUPPORTED:"], expected: ["SOURCE_CONFIGURATION_RESOLUTION_UNSUPPORTED:NodeNext"],
}, {
  files: { "main.ts": source, "tsconfig.json": config() }, prefixes: ["SOURCE_CONFIGURATION_RESOLUTION_UNSUPPORTED:"], expected: [],
});
pair("parsed-source-module-scope", [23], {
  files: { "main.ts": "const value = 1;\n" }, component: "retainedWithSource", prefixes: ["SOURCE_GLOBAL_SCRIPT_UNSUPPORTED"], expected: ["SOURCE_GLOBAL_SCRIPT_UNSUPPORTED"],
}, {
  files: { "main.ts": source }, component: "retainedWithSource", prefixes: ["SOURCE_GLOBAL_SCRIPT_UNSUPPORTED"], expected: [],
});
pair("outside-extends-refusal", [23, 27], {
  files: { "main.ts": source, "tsconfig.json": config({}, { extends: "../base.json" }), "../base.json": config() }, prefixes: ["SOURCE_CONFIGURATION_OUTSIDE_REPOSITORY"], expected: ["SOURCE_CONFIGURATION_OUTSIDE_REPOSITORY"],
}, {
  files: { "main.ts": source, "tsconfig.json": config({}, { extends: "./base.json" }), "base.json": config() }, prefixes: ["SOURCE_CONFIGURATION_OUTSIDE_REPOSITORY"], expected: [],
});
for (const [name, content, extraFiles] of [
  ["configuration-circular-chain", config({}, { extends: "./base.json" }), { "base.json": '{"extends":"./tsconfig.json"}' }],
  ["configuration-multiple-invalid-options", config({ module: "bad", target: "bad" }), {}],
  ["configuration-extends-type", config({}, { extends: 123 }), {}],
  ["configuration-multiline-chain", config({ baseUrl: "./src" }), {}],
] as [string, string, Record<string, string>][]) {
  pair(name, [23, 26], { files: { "main.ts": source, "tsconfig.json": content, ...extraFiles }, compiler: true }, { files: { "main.ts": source, "tsconfig.json": config() }, compiler: true });
}
for (const module of ["esnext", null]) {
  pair(`configuration-inherited-none-${module ?? "null"}`, [23, 26], {
    files: { "main.ts": source, "tsconfig.json": config({ module }, { extends: "./base.json" }), "base.json": config({ module: "none" }) }, compiler: true,
  }, {
    files: { "main.ts": source, "tsconfig.json": config({ module }, { extends: "./base.json" }), "base.json": config() }, compiler: true,
  });
}
pair("configuration-no-input-suppression", [23, 26], {
  files: { "main.ts": source, "tsconfig.json": config({ noLib: true }, { include: ["missing/**/*.ts"] }) }, compiler: true, suppression: true,
}, {
  files: { "main.ts": source, "tsconfig.json": config({ noLib: true }, { include: ["main.ts"] }) }, compiler: true,
});

const configurationLayerPrefixes = ["SOURCE_CONFIGURATION_", "SOURCE_NAMED_CONFIGURATION_", "SOURCE_AUTOMATIC_JSX_", "SOURCE_CLASSIC_JSX_", "SOURCE_DEFAULT_EXPRESSION_", "SOURCE_JSDOC_IMPORT_", "SOURCE_COMMONJS_", "SOURCE_TAGGED_TEMPLATE_", "SOURCE_DYNAMIC_CALL_", "SOURCE_GLOBAL_SCRIPT_", "SOURCE_GLOBAL_AUGMENTATION_", "SOURCE_MODULE_AUGMENTATION_"];
const semanticComposition = [...semanticWitnessesA, ...semanticWitnessesAFocal, ...semanticWitnessesB];
const semanticConfigurationProjections: Record<number, { activation: string[]; control: string[]; basis: string }> = {
  51: { activation: ["SOURCE_COERCION_UNSUPPORTED", "SOURCE_SDK_CALLBACK_UNSUPPORTED"], control: [], basis: "The SDK Date parameter includes Date, whose getVarDate member is a callable PropertySignature from loaded lib.scripthost.d.ts. Canonical sdkCallbackDictionary therefore applies to the non-literal object as well as numeric coercion; a numeric literal triggers neither." },
  56: { activation: ["SOURCE_COERCION_UNSUPPORTED", "SOURCE_OPAQUE_CALLBACK_UNSUPPORTED"], control: [], basis: "TS7 keeps x as parameter and narrows its final use to string; the canonical bindingWritten predicate invalidates runtime value provenance after x++, so both numeric coercion and opaque argument remain refused." },
  63: { activation: ["SOURCE_DESCRIPTOR_ACCESSOR_UNSUPPORTED"], control: [], basis: "SDK PropertyDescriptor.get/set are MethodSignature declarations, excluded by canonical sdkCallbackDictionary, which requires PropertySignature. Its value PropertySignature has any type without call signatures. The accessor descriptor refusal still applies." },
  65: { activation: ["SOURCE_DESCRIPTOR_ACCESSOR_UNSUPPORTED"], control: [], basis: "The immutable alias retains SDK Reflect.defineProperty. PropertyDescriptor.get/set are MethodSignature declarations, so canonical sdkCallbackDictionary does not apply; only the accessor descriptor refusal remains." },
  68: { activation: ["SOURCE_IMPORT_META_CALLABLE_UNSUPPORTED"], control: ["SOURCE_COERCION_UNSUPPORTED"], basis: "TS7 resolves import.meta.resolve to the SDK DOM method. The control url has string type but originates from a property access, which the canonical primitiveValue contract does not accept as runtime provenance for String(url)." },
  69: { activation: [], control: [], basis: "The source provides a unique named owner and retained target declaration with one direct target call inside the callback; the canonical graph projection requires its owner-to-target calls edge. The unmodeled property-owner control is projected separately below." },
  71: { activation: ["SOURCE_PROMISE_ASSIMILATION_UNSUPPORTED"], control: [], basis: "TS7 resolves Promise.all through its alias; the literal array is intrinsic iterable, but its then-method object is not a safe await value." },
  74: { activation: ["SOURCE_IMPORT_META_CALLABLE_UNSUPPORTED"], control: ["SOURCE_COERCION_UNSUPPORTED"], basis: "Direct import.meta.resolve resolves to the same SDK method; String(import.meta.url alias) lacks primitive runtime provenance under the canonical policy." },
  75: { activation: ["SOURCE_DESCRIPTOR_UNSUPPORTED"], control: [], basis: "SDK Object.defineProperties consumes a descriptor map; the get-method descriptor violates the canonical dataDescriptor whitelist, while value:1 is accepted." },
  77: { activation: ["SOURCE_UNRESOLVED_CALLEE_UNSUPPORTED"], control: ["SOURCE_UNRESOLVED_CALLEE_UNSUPPORTED"], basis: "TS7 gives both process receivers a retained BindingElement declaration and gives neither process.cwd a callable member declaration. The first caller-owned-member branch requires a retained callable coordinate before the later ordinary-process exemption." },
  78: { activation: ["SOURCE_PROMISE_ASSIMILATION_UNSUPPORTED"], control: [], basis: "TS7 resolves SDK Promise.resolve; a then-method object is not a safe await value, while numeric literal is." },
  82: { activation: ["SOURCE_COERCION_UNSUPPORTED"], control: [], basis: "TS7 resolves Math.abs number parameter and Function.apply; the canonical sdkInvocation unwraps its literal argument list, exposing object versus literal numeric value." },
  89: { activation: ["SOURCE_DYNAMIC_EVALUATION_UNSUPPORTED"], control: ["SOURCE_CALLABLE_EXPORT_UNSUPPORTED"], basis: "TS7 gives f.constructor and exported x type Function with no call signatures; independent CLI TS2351 confirms no construct signatures. Canonical potentiallyCallable therefore emits no callable-export refusal for this activation, while the retained arrow-valued constructor control has a call signature." },
  90: { activation: ["SOURCE_COERCION_UNSUPPORTED", "SOURCE_SDK_CALLBACK_UNSUPPORTED"], control: [], basis: "Loaded lib.scripthost.d.ts adds Date.getVarDate as a callable PropertySignature, making the Date parameter an SDK callback dictionary. The valueOf-method object is not literal data; explicit new Date(new Date()) activates the independent Date-copy exception." },
  135: { activation: ["SOURCE_UNRESOLVED_CALLEE_UNSUPPORTED", "SOURCE_WORKLET_LOADER_UNSUPPORTED"], control: [], basis: "TS7 resolves ambient Worklet.addModule to the DOM SDK method, but its receiver declaration remains retained ambient data with no runtime SDK provenance. Loader refusal and unresolved retained-receiver refusal both apply; retained method body control has neither." },
};
const shorthandLocaleProjection = {
  activation: ["SOURCE_COERCION_UNSUPPORTED", "SOURCE_SDK_ITERATION_UNSUPPORTED"],
  control: ["SOURCE_SDK_ITERATION_UNSUPPORTED"],
  basis: "The SDK locales parameter is string | string[]; explicit undefined is not an intrinsic iterable, so canonical iterableParameter applies in both roles. TS7 resolves shorthand style to a ShorthandPropertyAssignment symbol, distinct from its shorthandValueSymbol VariableDeclaration; canonical primitiveValue does not follow that symbol, so only the shorthand activation also fails safeOptions.",
};
for (const [ordinal, witness] of semanticComposition.entries()) {
  const incomplete = witness.expectedReasons === null || witness.controlExpectedReasons === null;
  const revised = incomplete || witness.index === 89 || witness.id.endsWith("--shorthand-locale-options");
  const projection = witness.id.endsWith("--shorthand-locale-options") ? shorthandLocaleProjection : semanticConfigurationProjections[witness.index];
  const expected = revised ? projection?.activation : witness.expectedReasons;
  const controlExpected = revised ? witness.index === 69 && witness.id.includes("--inline-owner-and-unmodeled-property") ? ["SOURCE_OPAQUE_CALLBACK_UNSUPPORTED"] : projection?.control : witness.controlExpectedReasons;
  if (expected === undefined || expected === null || controlExpected === undefined || controlExpected === null) throw new Error(`Missing independent semantic composition projection ${witness.id}`);
  const authority = revised ? `${witness.contractSource}; independent pinned TS7 semantic API facts and canonical policy projection: ${projection!.basis}` : witness.contractSource;
  pair(`retained-semantic-composition-${witness.index}-${ordinal}`, [23], {
    files: witness.files, subject: witness.path, prefixes: ["SOURCE_"], excludedPrefixes: configurationLayerPrefixes, expected, qualified: true, contractSource: authority,
  }, {
    files: witness.controlFiles, subject: witness.path, prefixes: ["SOURCE_"], excludedPrefixes: configurationLayerPrefixes, expected: controlExpected, qualified: true, contractSource: authority,
  });
}
for (const [name, text, expected, subject] of [
  ["source-tagged-template", "const tag=(text:TemplateStringsArray)=>text;export const value=tag`value`;", ["SOURCE_TAGGED_TEMPLATE_UNSUPPORTED"], "main.ts"],
  ["source-dynamic-call-ts", "export const value=(()=>1)();", ["SOURCE_DYNAMIC_CALL_UNSUPPORTED"], "main.ts"],
  ["source-dynamic-call-js", "export const value=(()=>1)();", [], "main.js"],
] as [string, string, string[], string][]) {
  pair(name, [23], { files: { [subject]: text }, subject, prefixes: ["SOURCE_TAGGED_TEMPLATE_", "SOURCE_DYNAMIC_CALL_"], expected }, { files: { [subject]: source }, subject, prefixes: ["SOURCE_TAGGED_TEMPLATE_", "SOURCE_DYNAMIC_CALL_"], expected: [] });
}
const jsxPrefixes = ["SOURCE_AUTOMATIC_JSX_RUNTIME_UNSUPPORTED", "SOURCE_CLASSIC_JSX_RUNTIME_UNSUPPORTED"];
for (const [name, options, text, expected] of [
  ["jsx-automatic", { jsx: "react-jsx" }, "export const page=<main/>;", ["SOURCE_AUTOMATIC_JSX_RUNTIME_UNSUPPORTED"]],
  ["jsx-automatic-development", { jsx: "react-jsxdev" }, "export const page=<main/>;", ["SOURCE_AUTOMATIC_JSX_RUNTIME_UNSUPPORTED"]],
  ["jsx-classic", { jsx: "react" }, "export const page=<main/>;", ["SOURCE_CLASSIC_JSX_RUNTIME_UNSUPPORTED"]],
  ["jsx-pragma-automatic", { jsx: "preserve" }, "/** @jsxRuntime automatic */\nexport const page=<main/>;", ["SOURCE_AUTOMATIC_JSX_RUNTIME_UNSUPPORTED"]],
  ["jsx-pragma-classic-override", { jsx: "react-jsx" }, "/** @jsxRuntime classic */\nexport const page=<main/>;", ["SOURCE_CLASSIC_JSX_RUNTIME_UNSUPPORTED"]],
  ["jsx-pragma-last-wins", { jsx: "react-jsx" }, "/** @jsxRuntime automatic */\n/** @jsxRuntime classic */\nexport const page=<main/>;", ["SOURCE_CLASSIC_JSX_RUNTIME_UNSUPPORTED"]],
] as [string, Value, string, string[]][]) {
  pair(name, [23], { files: { "main.tsx": text, "tsconfig.json": config(options) }, subject: "main.tsx", prefixes: jsxPrefixes, expected }, { files: { "main.tsx": "export const page=<main/>;", "tsconfig.json": config({ jsx: "preserve" }) }, subject: "main.tsx", prefixes: jsxPrefixes, expected: [] });
}
pair("jsx-source-absent", [23], {
  files: { "main.tsx": "export const page=<main/>;", "tsconfig.json": config({ jsx: "react-jsx" }) }, subject: "main.tsx", prefixes: jsxPrefixes, expected: ["SOURCE_AUTOMATIC_JSX_RUNTIME_UNSUPPORTED"],
}, {
  files: { "main.tsx": source, "tsconfig.json": config({ jsx: "react-jsx" }) }, subject: "main.tsx", prefixes: jsxPrefixes, expected: [],
});
pair("jsx-no-configuration-pragma", [23], {
  files: { "main.tsx": "/** @jsxRuntime automatic */\nexport const page=<main/>;" }, subject: "main.tsx", prefixes: jsxPrefixes, expected: ["SOURCE_AUTOMATIC_JSX_RUNTIME_UNSUPPORTED"],
}, {
  files: { "main.tsx": "export const page=<main/>;" }, subject: "main.tsx", prefixes: jsxPrefixes, expected: [],
});
pair("jsx-malformed-configuration-skips-runtime", [23], {
  files: { "main.tsx": "/** @jsxRuntime automatic */\nexport const page=<main/>;", "tsconfig.json": "{ broken" }, subject: "main.tsx", prefixes: jsxPrefixes, expected: [],
}, {
  files: { "main.tsx": "/** @jsxRuntime automatic */\nexport const page=<main/>;", "tsconfig.json": config() }, subject: "main.tsx", prefixes: jsxPrefixes, expected: ["SOURCE_AUTOMATIC_JSX_RUNTIME_UNSUPPORTED"],
});
const helperSource = "export async function run(){return 1;}";
pair("runtime-import-helpers", [23], {
  files: { "main.ts": helperSource, "tsconfig.json": config({ target: "ES2015", importHelpers: true }) }, prefixes: ["SOURCE_CONFIGURATION_HELPERS_UNSUPPORTED"], expected: ["SOURCE_CONFIGURATION_HELPERS_UNSUPPORTED"],
}, {
  files: { "main.ts": helperSource, "tsconfig.json": config({ target: "ES2015", importHelpers: false }) }, prefixes: ["SOURCE_CONFIGURATION_HELPERS_UNSUPPORTED"], expected: [],
});
pair("runtime-helpers-requested-versus-no-helper", [23], {
  files: { "main.ts": helperSource, "tsconfig.json": config({ target: "ES2015", importHelpers: true }) }, prefixes: ["SOURCE_CONFIGURATION_HELPERS_UNSUPPORTED"], expected: ["SOURCE_CONFIGURATION_HELPERS_UNSUPPORTED"],
}, {
  files: { "main.ts": source, "tsconfig.json": config({ target: "ES2015", importHelpers: true }) }, prefixes: ["SOURCE_CONFIGURATION_HELPERS_UNSUPPORTED"], expected: [],
});
for (const [name, text, subject, reason] of [
  ["scope-global-augmentation", "declare global { interface Window { value:number } } export {};", "main.ts", "SOURCE_GLOBAL_AUGMENTATION_UNSUPPORTED"],
  ["scope-module-augmentation", 'declare module "dep" { export const value:number; } export {};', "main.ts", "SOURCE_MODULE_AUGMENTATION_UNSUPPORTED"],
  ["scope-cts-extension", source, "main.cts", "SOURCE_COMMONJS_EXTENSION_UNSUPPORTED"],
  ["scope-cjs-extension", source, "main.cjs", "SOURCE_COMMONJS_EXTENSION_UNSUPPORTED"],
] as const) {
  pair(name, [23], { files: { [subject]: text }, subject, component: "retainedWithSource", prefixes: [reason], expected: [reason] }, { files: { "main.ts": source }, component: "retainedWithSource", prefixes: [reason], expected: [] });
}
for (const extension of ["mts", "mjs"]) {
  pair(`scope-implicit-module-${extension}`, [23], { files: { [`main.${extension}`]: "const value=1;" }, subject: `main.${extension}`, component: "retainedWithSource", prefixes: ["SOURCE_GLOBAL_SCRIPT_UNSUPPORTED"], expected: [] }, { files: { "main.ts": "const value=1;" }, component: "retainedWithSource", prefixes: ["SOURCE_GLOBAL_SCRIPT_UNSUPPORTED"], expected: ["SOURCE_GLOBAL_SCRIPT_UNSUPPORTED"] });
}
for (const depth of [0, 1, 2, 3]) {
  const subject = `${"nested/".repeat(depth)}main.ts`;
  pair(`governing-discovery-ancestor-${depth}`, [23, 24], {
    files: { [subject]: source, "tsconfig.json": config({ module: "CommonJS", moduleResolution: "Node16" }) }, subject, prefixes: ["SOURCE_CONFIGURATION_MODULE_UNSUPPORTED:"], expected: ["SOURCE_CONFIGURATION_MODULE_UNSUPPORTED:CommonJS"],
  }, {
    files: { [subject]: source }, subject, prefixes: ["SOURCE_CONFIGURATION_MODULE_UNSUPPORTED:"], expected: [],
  });
}
pair("governing-discovery-nearest-shadows-ancestor", [23, 24], {
  files: { "nested/main.ts": source, "nested/tsconfig.json": config(), "tsconfig.json": config({ module: "CommonJS", moduleResolution: "Node16" }) }, subject: "nested/main.ts", prefixes: ["SOURCE_CONFIGURATION_MODULE_UNSUPPORTED:"], expected: [],
}, {
  files: { "nested/main.ts": source, "tsconfig.json": config({ module: "CommonJS", moduleResolution: "Node16" }) }, subject: "nested/main.ts", prefixes: ["SOURCE_CONFIGURATION_MODULE_UNSUPPORTED:"], expected: ["SOURCE_CONFIGURATION_MODULE_UNSUPPORTED:CommonJS"],
});

pair("optional-retained-source-named-predicate", [23], {
  files: { "tsconfig.extra.json": "{}" }, prefixes: namedPrefixes, expected: [], optionalSource: true, sourceAvailable: false,
}, {
  files: { "main.ts": source, "tsconfig.extra.json": "{}" }, prefixes: namedPrefixes, expected: [namedReason], optionalSource: true, sourceAvailable: true,
});
pair("optional-retained-source-default-expression", [23], {
  files: {}, prefixes: ["SOURCE_DEFAULT_EXPRESSION_UNSUPPORTED"], expected: [], optionalSource: true, sourceAvailable: false,
}, {
  files: { "main.ts": "export default 1;" }, prefixes: ["SOURCE_DEFAULT_EXPRESSION_UNSUPPORTED"], expected: ["SOURCE_DEFAULT_EXPRESSION_UNSUPPORTED"], optionalSource: true, sourceAvailable: true,
});
pair("optional-retained-source-preserves-module-policy", [23], {
  files: { "tsconfig.json": config({ module: "ES2015" }) }, prefixes: ["SOURCE_CONFIGURATION_MODULE_UNSUPPORTED:"], expected: ["SOURCE_CONFIGURATION_MODULE_UNSUPPORTED:ES2015"], optionalSource: true, sourceAvailable: false,
}, {
  files: { "main.ts": source, "tsconfig.json": config({ module: "ES2015" }) }, prefixes: ["SOURCE_CONFIGURATION_MODULE_UNSUPPORTED:"], expected: ["SOURCE_CONFIGURATION_MODULE_UNSUPPORTED:ES2015"], optionalSource: true, sourceAvailable: true,
});
pair("optional-parsed-source-controls-module-scope", [23], {
  files: { "main.ts": "const value=1;" }, prefixes: ["SOURCE_GLOBAL_SCRIPT_UNSUPPORTED"], expected: ["SOURCE_GLOBAL_SCRIPT_UNSUPPORTED"], optionalSource: true, sourceAvailable: true, parsedSource: true,
}, {
  files: { "main.ts": "const value=1;" }, prefixes: ["SOURCE_GLOBAL_SCRIPT_UNSUPPORTED"], expected: [], optionalSource: true, sourceAvailable: true, parsedSource: false,
});

pair("ordinary-explicit-source-default-expression", [23], {
  files: { "main.ts": "export default 1;" }, prefixes: ["SOURCE_DEFAULT_EXPRESSION_UNSUPPORTED"], expected: ["SOURCE_DEFAULT_EXPRESSION_UNSUPPORTED"], optionalSource: true, sourceAvailable: true, parsedSource: true, retained: false,
}, {
  files: { "main.ts": "export default 1;" }, prefixes: ["SOURCE_DEFAULT_EXPRESSION_UNSUPPORTED"], expected: [], optionalSource: true, sourceAvailable: true, parsedSource: false, retained: false,
});
pair("ordinary-explicit-source-jsdoc", [23], {
  files: { "main.js": '/** @typedef {import("./dep").Value} Value */\nexport const value=1;', "dep.d.ts": "export type Value=number;" }, subject: "main.js", prefixes: ["SOURCE_JSDOC_IMPORT_UNSUPPORTED"], expected: ["SOURCE_JSDOC_IMPORT_UNSUPPORTED"], optionalSource: true, sourceAvailable: true, parsedSource: true, retained: false,
}, {
  files: { "main.js": source }, subject: "main.js", prefixes: ["SOURCE_JSDOC_IMPORT_UNSUPPORTED"], expected: [], optionalSource: true, sourceAvailable: true, parsedSource: true, retained: false,
});

pair("outside-configuration-overrides-source-reasons", [23], {
  files: { "main.ts": "export default 1;", "tsconfig.json": config({}, { extends: "../base.json" }), "../base.json": config() }, prefixes: ["SOURCE_"], expected: ["SOURCE_CONFIGURATION_OUTSIDE_REPOSITORY"],
}, {
  files: { "main.ts": "export default 1;", "tsconfig.json": config({}, { extends: "./base.json" }), "base.json": config() }, prefixes: ["SOURCE_"], expected: ["SOURCE_DEFAULT_EXPRESSION_UNSUPPORTED"],
});
pair("governing-outside-configuration-overrides-source-reasons", [23, 24], {
  files: { "main.ts": "export default 1;", "../tsconfig.json": config() }, prefixes: ["SOURCE_"], expected: ["SOURCE_CONFIGURATION_OUTSIDE_REPOSITORY"],
}, {
  files: { "main.ts": "export default 1;", "tsconfig.json": config() }, prefixes: ["SOURCE_"], expected: ["SOURCE_DEFAULT_EXPRESSION_UNSUPPORTED"],
});
pair("malformed-configuration-keeps-source-default-predicate", [23], {
  files: { "main.ts": "export default 1;", "tsconfig.json": "{ broken" }, prefixes: ["SOURCE_DEFAULT_EXPRESSION_UNSUPPORTED"], expected: ["SOURCE_DEFAULT_EXPRESSION_UNSUPPORTED"],
}, {
  files: { "main.ts": source, "tsconfig.json": "{ broken" }, prefixes: ["SOURCE_DEFAULT_EXPRESSION_UNSUPPORTED"], expected: [],
});

async function save(path: string, value: unknown): Promise<Evidence> {
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(path, bytes);
  return { path, sha256: sha(bytes), bytes: Buffer.byteLength(bytes) };
}

type Completed = PairWitness & { fixture: Fixture; durationMs: number };
async function execute(ctx: CampaignContext, fixture: Fixture, libraries: string[]): Promise<Completed> {
  const started = performance.now();
  const directory = resolve(ctx.out, "config-diag", fixture.name);
  const root = resolve(directory, "workspace");
  await mkdir(root, { recursive: true });
  const files = Object.fromEntries(Object.entries(fixture.files).map(([path, text]) => [resolve(root, path), text]));
  if (fixture.compiler && !fixture.suppression) {
    const path = resolve(root, "tsconfig.json");
    const project = object(JSON.parse(files[path]!));
    files[path] = JSON.stringify({ ...project, compilerOptions: { ...object(project.compilerOptions), noLib: true }, files: [resolve(root, fixture.subject ?? "main.ts"), ...libraries], include: [] });
  }
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);
  }
  const subject = fixture.subject ?? "main.ts";
  const analysisRequest = { id: `ts7-w2-config-diag-${fixture.name}`, cwd: root, sdk_directory: "/sdk/lib", case_sensitive: ctx.platform === "linux", roots: [resolve(root, subject)], files, options: { ...defaults, allowJs: true, jsx: "Preserve", strict: false }, retained: fixture.retained ?? true, qualified: fixture.qualified ?? false, roles: {}, selection: {}, disabled: [], utf16_files: {}, raw_files: {} };
  const request = fixture.optionalSource ? { root, source: resolve(root, subject), files, parsed_source: fixture.parsedSource ?? false, retained: fixture.retained ?? true } : analysisRequest;
  const requestPath = resolve(directory, "request.json");
  const evidence = [await save(requestPath, request), ...Object.entries(files).map(([path, text]) => ({ path, sha256: sha(text), bytes: Buffer.byteLength(text) }))];
  let expected = fixture.expected ?? [];
  let oracleReady = true;
  let oracleDiagnostics: ReturnType<typeof compilerDiagnostics> = [];
  let oracleFailure: string | undefined;
  if (fixture.compiler) {
    const projectPath = resolve(root, "tsconfig.json");
    const oracle = await ctx.run(`config-diag-${fixture.name}-oracle`, [ctx.oracle, "--noEmit", "--pretty", "false", "--project", projectPath], root);
    evidence.push(...oracle.evidence);
    try { oracleDiagnostics = compilerDiagnostics(oracle.stdout); }
    catch (error) { oracleFailure = String(error); }
    oracleReady = oracleFailure === undefined && oracle.stderr.trim() === "" && oracle.exitCode === (oracleDiagnostics.length === 0 ? 0 : 2) && (!fixture.suppression || oracleDiagnostics.some(diagnostic => diagnostic.code === 18003));
    expected = oracleDiagnostics.filter(diagnostic => diagnostic.code !== 18003).map(diagnostic => `SOURCE_CONFIGURATION_INVALID:${diagnostic.code}:${diagnostic.message}`);
  }
  const processResult = await ctx.run(`config-diag-${fixture.name}-producer`, [ctx.producer, ...(fixture.optionalSource ? ["--observe-configuration-source"] : []), requestPath, ctx.sdk], root);
  evidence.push(...processResult.evidence);
  let result: Value = {};
  let parseError: string | undefined;
  try { result = object(JSON.parse(processResult.stdout)); }
  catch (error) { parseError = String(error); }
  const subjects = Array.isArray(result.subjects) ? result.subjects.map(object).filter(item => item.path === subject) : [];
  const componentName = fixture.component ?? (fixture.compiler ? "ordinaryWithoutSnapshot" : "retainedWithoutSource");
  const component = fixture.optionalSource ? object(result.component) : object(object(subjects[0]?.moduleConfigurationObservations)[componentName]);
  const prefixes = fixture.prefixes ?? ["SOURCE_CONFIGURATION_INVALID:"];
  const actual = projectConfigurationObservation(component, prefixes, fixture.excludedPrefixes);
  const requestBound = fixture.optionalSource ? result.executed === true && result.profile === "optional_configuration_source" && result.source_available === fixture.sourceAvailable && result.parsed_source_argument === (fixture.parsedSource ?? false) && result.retained_source_profile === (fixture.retained ?? true) && result.request_descriptor_id === `sha256:${sha(canonical(request))}` : subjects.length === 1 && result.request_id === `sha256:${sha(canonical(request))}`;
  const processBound = processResult.exitCode === 0 && processResult.stderr.trim() === "" && parseError === undefined && requestBound && result.producer_artifact_id === `sha256:${sha(await readFile(ctx.producer))}`;
  const pass = oracleReady && processBound && compareConfigurationObservation(actual, expected);
  evidence.push(await save(resolve(directory, "comparison.json"), { authority: fixture.compiler ? "Independent pinned TS7 CLI complete diagnostics; only contract-suppressed TS18003 is excluded" : fixture.contractSource ?? "Independent finite owning-consumer predicate projection from frozen consumer-contracts.json, not from producer output", fixture: fixture.name, role: fixture.role, property: fixture.pair, component: componentName, projectionPrefixes: prefixes, excludedPrefixes: fixture.excludedPrefixes ?? [], expected, actual: component, oracleDiagnostics, oracleFailure, processBound, parseError, pass }));
  return { fixture, role: fixture.role, pass, evidence, durationMs: performance.now() - started };
}

const remaining: Partial<Record<number, string[]>> = {
  23: ["Fresh source-optional, semantic/runtime, live/retained discovery and initial/inherited read allocations must all pass at the owning module-configuration boundary; any failed or missing allocation remains unqualified."],
  24: ["Exact activating/control ancestor discovery must pass through both retained and real live Systems; an unexecuted or mismatching live observation cannot be replaced by captured parity."],
  25: ["The real live initial-read boundary must pass successful, undefined, explicit-error and OS-error controls with normalized content-or-undefined attribution."],
  27: ["The real live inherited-read boundary must pass delegated success, undefined/error alternatives and lexical/canonical escape controls before any read delegation."],
  44: ["WeakMap cache identity, same-snapshot repeated calls and later-pass invalidation have no public native observation. Malformed and transitive named chains are now exercised, but cache lifecycle and failed-read consumption remain unproved. Preserve the contract and expose lifecycle observations, or decide an explicit TS7 contract migration."],
  46: ["Native case mode accepts only normalized unique captured keys; case-colliding aliases may be rejected before the owning named consumer. No consumer execution proves relative/backslash/case-collision normalization. Preserve and expose the owning boundary, or explicitly change the contract; recommendation: no qualification from a request-level refusal."],
  47: ["The component reports the final named reason, not consumed-read order or failed/undefined read attribution. Successful malformed-chain controls do not establish consume-before-failed-delegate semantics. Preserve and expose this observation, or approve a contract migration; recommendation: no qualification from final-reason parity alone."],
};

export async function enrichConfigurationDiagnostics(ctx: CampaignContext, rows: ObligationResult[]): Promise<ObligationResult[]> {
  const selected = rows.filter(row => all.includes(row.index));
  if (selected.length === 0) return rows;
  const sdk = object(JSON.parse(await readFile(ctx.sdk, "utf8")));
  const sdkFiles = Object.entries(object(sdk.files));
  const libraryDirectory = resolve(ctx.out, "config-diag", "oracle-sdk");
  await mkdir(libraryDirectory, { recursive: true });
  const libraries: string[] = [];
  const libraryEvidence: Evidence[] = [];
  for (const [path, text] of sdkFiles) {
    if (typeof text !== "string" || !/^lib[.a-z0-9-]*\.d\.ts$/.test(basename(path))) throw new Error("invalid TS7 SDK entry for configuration diagnostics");
    const target = resolve(libraryDirectory, basename(path));
    if (libraries.includes(target)) throw new Error("duplicate TS7 SDK basename");
    await writeFile(target, text);
    libraries.push(target);
    libraryEvidence.push({ path: target, sha256: sha(text), bytes: Buffer.byteLength(text) });
  }
  if (sdk.version !== "7.1.0-dev" || libraries.length !== 115) throw new Error("configuration diagnostic oracle requires explicit TS7 SDK115");
  const live = await runConfigurationLiveBoundaries(ctx, selected.map(row => row.index));
  const liveReadStarted = performance.now();
  const liveReads = selected.some(row => [23, 25, 27].includes(row.index)) ? await liveConfigurationWitnesses(ctx) : new Map<number, PropertyResult[]>();
  const liveReadDurationMs = performance.now() - liveReadStarted;
  const completed: Completed[] = [];
  for (const fixture of fixtures.filter(fixture => selected.some(row => fixture.indices.includes(row.index)))) completed.push(await execute(ctx, fixture, libraries));
  return rows.map(row => {
    if (!all.includes(row.index)) return row;
    const relevant = completed.filter(witness => witness.fixture.indices.includes(row.index));
    const pairs = [...new Set(fixtures.filter(fixture => fixture.indices.includes(row.index)).map(fixture => fixture.pair))];
    const liveRelevant = live.filter(witness => witness.indices.includes(row.index));
    const livePairs = [...new Set(liveRelevant.map(witness => witness.property))];
    const liveComplete = liveRelevant.length > 0 && liveRelevant.every(witness => witness.pass);
    const reads = liveReads.get(row.index) ?? [];
    const liveReadComplete = reads.length > 0 && reads.every(property => property.status === "pass");
    const optionalSources = relevant.filter(witness => witness.fixture.optionalSource);
    const optionalSourceComplete = optionalSources.length > 0 && optionalSources.every(witness => witness.pass);
    const replacesGap = [26, 45].includes(row.index) || row.index === 24 && liveComplete || [25, 27].includes(row.index) && liveReadComplete || row.index === 23 && liveComplete && liveReadComplete && optionalSourceComplete;
    const properties = [...row.properties.filter(property => property.status !== "not_qualified" || !replacesGap), ...pairs.map(name => assessConfigurationPair(name, relevant.filter(witness => witness.fixture.pair === name))), ...livePairs.map(name => assessConfigurationPair(name, liveRelevant.filter(witness => witness.property === name))), ...reads];
    for (const reason of replacesGap ? [] : remaining[row.index] ?? []) properties.push({ property: `obligation ${row.index}: remaining cumulative consumer boundary`, status: "not_qualified", reason, evidence: [] });
    const evidence = [...row.evidence, ...libraryEvidence, ...relevant.flatMap(witness => witness.evidence), ...liveRelevant.flatMap(witness => witness.evidence), ...reads.flatMap(property => property.evidence ?? [])];
    const status = properties.length > 0 && properties.every(property => property.status === "pass") ? "qualified" : "not_qualified";
    const qualifiedReason = row.index === 23 ? "All allocated owning module-configuration branches passed: optional source/snapshot selection, canonical source predicates, independent semantic projections, runtime/JSX/helper policy, parsed scope, complete diagnostics, live/retained discovery and live read attribution/failures." : row.index === 25 ? "Real live initial reads match independent TS7 success/failure diagnostics and normalized content-or-undefined attribution." : row.index === 27 ? "Real live inherited reads match independent TS7 success/failure diagnostics and pre-delegation lexical/canonical confinement controls." : row.index === 24 ? "Nearest configuration discovery matches exact activating/control ancestor outcomes in both the real live System and the retained System, including termination, nearest masking, absence and outside-root refusal." : row.index === 26 ? "Complete TS7 diagnostics are compared with the independent pinned CLI, including removed options, malformed input, multiple diagnostics, circular chains, a real multiline TS5102 chain and TS18003-only suppression, each with a valid control." : "The named-configuration discovery callback matches every allocated nearest/absent/shadowed ancestor and source-extension control; no broader named-cache or read-attribution claim is made.";
    return { ...row, status, reason: status === "qualified" ? qualifiedReason : (remaining[row.index] ?? ["At least one independent activation/control comparison failed."]).join(" "), properties, evidence, durationMs: row.durationMs + relevant.reduce((total, witness) => total + witness.durationMs, 0) + liveRelevant.reduce((total, witness) => total + witness.durationMs, 0) + (reads.length > 0 ? liveReadDurationMs : 0) };
  });
}
