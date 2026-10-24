import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileEvidence, type CampaignContext, type Evidence, type ObligationResult } from "./t00-ts7-q-config-campaign";

type Value = Record<string, unknown>;
const record = (value: unknown): Value => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Value : {};
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === "string");
const runtimeReasons = new Set(["SOURCE_CONFIGURATION_HELPERS_UNSUPPORTED", "SOURCE_AUTOMATIC_JSX_RUNTIME_UNSUPPORTED", "SOURCE_CLASSIC_JSX_RUNTIME_UNSUPPORTED"]);
export const emitHelpersIndices = [12, 13, 14, 15, 16, 20, 21, 22];

export function projectRuntimeReasons(value: unknown, importHelpers: boolean): string[] {
  const envelope = record(value), observation = record(envelope["observation"]);
  const { helpers, imports, jsxSpans, jsxTokenSpans, calls, automaticImportBase, diagnostics } = observation;
  if (envelope["compilerVersion"] !== "7.1.0-dev" || envelope["sourceRevision"] !== "780dc512d64f40afebffa6a7028207649fb7ed1c" || envelope["sdkLibraryCount"] !== 115 || !Array.isArray(helpers) || !helpers.every(item => typeof record(item)["name"] === "string" && typeof record(item)["scoped"] === "boolean") || !strings(imports) || !Array.isArray(jsxSpans) || !jsxSpans.every(item => Array.isArray(item) && item.length === 2 && item.every(Number.isInteger)) || !Array.isArray(jsxTokenSpans) || !jsxTokenSpans.every(item => Array.isArray(item) && item.length === 2 && item.every(Number.isInteger)) || jsxTokenSpans.length !== jsxSpans.length || !Array.isArray(calls) || !calls.every(item => typeof record(item)["synthetic"] === "boolean" && Number.isInteger(record(item)["pos"]) && Number.isInteger(record(item)["end"])) || typeof automaticImportBase !== "string" || !Array.isArray(diagnostics)) throw Error("invalid independent TS7 emit observation");
  const reasons: string[] = [];
  if (importHelpers && helpers.some(item => record(item)["scoped"] === false) && imports.includes("tslib")) reasons.push("SOURCE_CONFIGURATION_HELPERS_UNSUPPORTED");
  if (jsxSpans.length > 0) {
    if (automaticImportBase !== "") reasons.push("SOURCE_AUTOMATIC_JSX_RUNTIME_UNSUPPORTED");
    else if (calls.some(item => { const call = record(item); return call["synthetic"] === true && jsxTokenSpans.some(span => isDeepStrictEqual(span, [call["pos"], call["end"]])); })) reasons.push("SOURCE_CLASSIC_JSX_RUNTIME_UNSUPPORTED");
  }
  return reasons.sort();
}

export function compareRuntimeReasons(value: unknown, expected: string[]): boolean {
  const observation = record(value);
  return observation["executed"] === true && isDeepStrictEqual(observation["unsupported"], []) && strings(observation["reasons"]) && isDeepStrictEqual(observation["reasons"].filter(reason => runtimeReasons.has(reason)).sort(), [...expected].sort());
}

type Fixture = { name: string; source: string; extension?: string; options?: Value; inherited?: boolean; leafOptions?: Value; retained?: boolean; group: "helper" | "jsx" | "tsx" | "parse" };
const fixtures: Fixture[] = [
  { name: "async-imported", source: "export async function run() { return 1; }\n", options: { target: "es2015", importHelpers: true }, group: "helper" },
  { name: "async-inherited", source: "export async function run() { return 1; }\n", options: { target: "es2015", importHelpers: true }, inherited: true, group: "helper" },
  { name: "async-leaf-override", source: "export async function run() { return 1; }\n", options: { target: "es2015", importHelpers: true }, inherited: true, leafOptions: { importHelpers: false }, group: "helper" },
  { name: "async-disabled", source: "export async function run() { return 1; }\n", options: { target: "es2015", importHelpers: false }, group: "helper" },
  { name: "async-native", source: "export async function run() { return 1; }\n", options: { target: "es2022", importHelpers: true }, group: "helper" },
  { name: "async-global", source: "async function run() { return 1; }\n", options: { target: "es2015", importHelpers: true }, group: "helper" },
  { name: "manual-tslib", source: 'import "tslib"; export const value = 1;\n', options: { target: "es2015", importHelpers: true }, group: "helper" },
  { name: "manual-decoy", source: 'import "tslib/decoy"; export const value = 1;\n', options: { target: "es2015", importHelpers: true }, group: "helper" },
  { name: "helper-absent", source: "export const value = 1;\n", options: { target: "es2015", importHelpers: true }, group: "helper" },
  { name: "classic-element", source: "export const view = <section><span /></section>;\n", options: { jsx: "react" }, group: "jsx" },
  { name: "classic-self", source: "export const view = /* trivia */\n <section />;\n", options: { jsx: "react" }, group: "jsx" },
  { name: "classic-fragment", source: "export const view = <><section /></>;\n", options: { jsx: "react", jsxFactory: "h", jsxFragmentFactory: "Fragment" }, group: "jsx" },
  { name: "preserve", source: "export const view = <section />;\n", options: { jsx: "preserve" }, group: "jsx" },
  { name: "automatic", source: "export const view = <section />;\n", options: { jsx: "react-jsx" }, group: "jsx" },
  { name: "automatic-pragma", source: "/** @jsxRuntime automatic */\nexport const view = <section />;\n", group: "jsx" },
  { name: "classic-pragma", source: "/** @jsxRuntime classic */\nexport const view = <section />;\n", options: { jsx: "react-jsx" }, group: "jsx" },
  { name: "import-source", source: "/** @jsxImportSource custom */\nexport const view = <section />;\n", group: "jsx" },
  { name: "last-automatic", source: "/** @jsxRuntime classic */\n/** @jsxRuntime automatic */\nexport const view = <section />;\n", options: { jsx: "react" }, group: "jsx" },
  { name: "last-classic", source: "/** @jsxRuntime automatic */\n/** @jsxRuntime classic */\nexport const view = <section />;\n", options: { jsx: "react-jsx" }, group: "jsx" },
  { name: "no-jsx", source: 'export const text = "<section />";\n', options: { jsx: "react-jsx" }, group: "jsx" },
  { name: "authored-factory", source: "export const view = React.createElement('section');\n", options: { jsx: "react" }, group: "jsx" },
  { name: "ordinary-classic", source: "export const view = <section />;\n", options: { jsx: "react" }, retained: false, group: "jsx" },
  { name: "tsx-automatic-pragma", extension: "tsx", source: "/** @jsxRuntime automatic */\nexport const view = <section />;\n", group: "tsx" },
  { name: "tsx-classic-pragma", extension: "tsx", source: "/** @jsxRuntime classic */\nexport const view = <section />;\n", options: { jsx: "react-jsx" }, group: "tsx" },
  { name: "tsx-import-source", extension: "tsx", source: "/** @jsxImportSource custom */\nexport const view = <section />;\n", group: "tsx" },
  { name: "tsx-last-automatic", extension: "tsx", source: "/** @jsxRuntime classic */\n/** @jsxRuntime automatic */\nexport const view = <section />;\n", options: { jsx: "react" }, group: "tsx" },
  { name: "tsx-no-jsx", extension: "tsx", source: "export function plain() { return 1; }\n", options: { jsx: "react-jsx" }, group: "tsx" },
  { name: "tsx-fragment", extension: "tsx", source: "export const view = <><section /></>;\n", options: { jsx: "react", jsxFactory: "h", jsxFragmentFactory: "Fragment" }, group: "tsx" },
  { name: "tsx-preserve", extension: "tsx", source: "export const view = <section />;\n", group: "tsx" },
  { name: "tsx-element", extension: "tsx", source: "export const view = /* trivia */ <section><span /></section>;\n", options: { jsx: "react" }, group: "tsx" },
  { name: "parse-failed", source: "export const broken = ;\n", extension: "js", group: "parse" },
  { name: "parse-corrected", source: "export const broken = 1;\n", extension: "js", group: "parse" },
  { name: "parse-typescript-in-js", source: "export const value: number = 1;\n", extension: "js", group: "parse" },
];

async function save(path: string, value: unknown): Promise<Evidence> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2) + "\n");
  return fileEvidence(path);
}

type Witness = { name: string; group: Fixture["group"]; evidence: Evidence[]; pass: boolean; parsePass: boolean; expected: string[]; diagnostics: unknown[]; oracle: unknown; actual: unknown };

export async function runEmitHelpers(ctx: CampaignContext, selected: number[]): Promise<ObligationResult[]> {
  const contracts = record(JSON.parse(await readFile(new URL("../docs/research/rust-ts-r0/qualification/suite-20261022/consumer-contracts.json", import.meta.url), "utf8")) as unknown);
  const definitions = Array.isArray(contracts["rows"]) ? contracts["rows"].map(record).filter(row => selected.includes(Number(row["index"]))) : [];
  if (definitions.length !== selected.length) throw Error("emit helper obligation census mismatch");
  if (selected.length === 0) return [];
  const started = performance.now();
  const rows: Witness[] = [];
  if (ctx.emitHelpersOracle !== undefined) {
    for (const fixture of fixtures) {
      const root = resolve(ctx.out, "emit-helpers", fixture.name, "repository");
      const file = resolve(root, `main.${fixture.extension ?? "jsx"}`);
      const options: Value = { target: "es2022", module: "esnext", moduleResolution: "bundler", jsx: "preserve", ...fixture.options, ...fixture.leafOptions };
      const config = fixture.inherited ? { extends: "./tsconfig.base.json", ...(fixture.leafOptions ? { compilerOptions: fixture.leafOptions } : {}) } : { compilerOptions: options };
      const files = { [file]: fixture.source, [resolve(root, "tsconfig.json")]: JSON.stringify(config), ...(fixture.inherited ? { [resolve(root, "tsconfig.base.json")]: JSON.stringify({ compilerOptions: { ...options, ...fixture.options } }) } : {}) };
      const request = await save(resolve(root, "request.json"), { id: fixture.name, cwd: root, sdk_directory: "/sdk/lib", roots: [file], files, retained: fixture.retained !== false, qualified: false, case_sensitive: ctx.platform === "linux", options: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", jsx: "Preserve", allowJs: true, skipLibCheck: true, noEmit: true, strict: false } });
      const oracleRequest = await save(resolve(root, "oracle-request.json"), { sdk_directory: dirname(ctx.oracle), file_name: file, source: fixture.source, options });
      const oracleRun = await ctx.run(`emit-oracle-${fixture.name}`, [ctx.emitHelpersOracle, oracleRequest.path]);
      const producerRun = await ctx.run(`emit-producer-${fixture.name}`, [ctx.producer, request.path, ctx.sdk]);
      const evidence = [request, oracleRequest, ...oracleRun.evidence, ...producerRun.evidence];
      let expected: string[] = [], diagnostics: unknown[] = [], oracle: unknown, actual: unknown;
      let pass = false, parsePass = false;
      try {
        oracle = JSON.parse(oracleRun.stdout) as unknown;
        const observation = record(record(oracle)["observation"]);
        expected = projectRuntimeReasons(oracle, options["importHelpers"] === true);
        if (fixture.retained === false) expected = [];
        const producer = record(JSON.parse(producerRun.stdout) as unknown);
        const subjects = producer["subjects"];
        const subject = Array.isArray(subjects) && subjects.length === 1 ? record(subjects[0]) : {};
        actual = subject["javascriptObservation"];
        pass = observation["fileName"] === file && oracleRun.exitCode === 0 && producerRun.exitCode === 0 && producer["native_compiler_version"] === "7.1.0-dev" && compareRuntimeOwners(subject, expected, fixture.group === "tsx" ? "moduleConfiguration" : fixture.retained === false ? "ordinaryJavaScript" : "javascript");
        diagnostics = observation["diagnostics"] as unknown[];
        const parseReasons = diagnostics.map(item => { const diagnostic = record(item); if (!Number.isInteger(diagnostic["code"]) || typeof diagnostic["message"] !== "string") throw Error("invalid oracle diagnostic"); return `JAVASCRIPT_PARSE_ERROR:${String(diagnostic["code"])}:${diagnostic["message"].replaceAll("\n", " ")}`; }).sort();
        const js = record(actual);
        parsePass = observation["fileName"] === file && oracleRun.exitCode === 0 && producerRun.exitCode === 0 && js["executed"] === true && isDeepStrictEqual(js["unsupported"], []) && js["parseFailed"] === (diagnostics.length > 0) && strings(js["reasons"]) && isDeepStrictEqual(js["reasons"].filter(reason => reason.startsWith("JAVASCRIPT_PARSE_ERROR:")).sort(), parseReasons);
      } catch (error) {
        evidence.push(await save(resolve(root, "comparison-error.json"), { error: String(error) }));
      }
      const comparison = { name: fixture.name, group: fixture.group, pass, parsePass, expected, diagnostics, oracle, actual };
      evidence.push(await save(resolve(root, "comparison.json"), comparison));
      rows.push({ ...comparison, evidence });
    }
  }
  const helper = rows.filter(row => row.group === "helper"), jsx = rows.filter(row => row.group === "jsx"), tsx = rows.filter(row => row.group === "tsx"), parse = rows.filter(row => row.group === "parse");
  return definitions.map(definition => {
    const index = Number(definition["index"]);
    const relevant = index <= 14 ? helper : index === 16 ? parse : index === 15 ? [...jsx, ...parse] : [...jsx, ...tsx];
    const complete = relevant.length === fixtures.filter(fixture => index <= 14 ? fixture.group === "helper" : index === 16 ? fixture.group === "parse" : index === 15 ? ["jsx", "parse"].includes(fixture.group) : ["jsx", "tsx"].includes(fixture.group)).length;
    const witnessesPass = complete && relevant.every(row => index === 16 ? row.parsePass : row.pass && (row.group === "tsx" || row.parsePass));
    const activating = index <= 14 ? helper.some(row => row.expected.includes("SOURCE_CONFIGURATION_HELPERS_UNSUPPORTED")) : index === 16 ? parse.some(row => row.diagnostics.length > 0) : jsx.some(row => row.expected.includes("SOURCE_CLASSIC_JSX_RUNTIME_UNSUPPORTED")) && jsx.some(row => row.expected.includes("SOURCE_AUTOMATIC_JSX_RUNTIME_UNSUPPORTED"));
    const typescriptWitnesses = index < 20 || tsx.some(row => row.expected.includes("SOURCE_CLASSIC_JSX_RUNTIME_UNSUPPORTED")) && tsx.some(row => row.expected.includes("SOURCE_AUTOMATIC_JSX_RUNTIME_UNSUPPORTED")) && tsx.some(row => row.expected.length === 0);
    const control = relevant.some(row => index === 16 ? row.diagnostics.length === 0 : row.expected.length === 0);
    const properties: ObligationResult["properties"] = [{ property: "owning consumer observable rule(s) in canonical family/call-path contract", status: ctx.emitHelpersOracle === undefined ? "not_qualified" : witnessesPass && activating && control && typescriptWitnesses ? "pass" : "fail", reason: ctx.emitHelpersOracle === undefined ? "Missing authenticated emitHelpersOracle API artifact." : "Independent TS7 API observations projected through the owning-operation contract, with activation and controls; finite supported-target witnesses only." }];
    const qualified = properties.every(property => property.status === "pass");
    return { index, id: String(definition["id"]), status: qualified ? "qualified" : "not_qualified", reason: qualified ? "Finite TS7 API witnesses pass; cross-platform frozen-candidate replay still required." : properties.filter(property => property.status !== "pass").map(property => property.reason).join(" "), properties, evidence: relevant.flatMap(row => row.evidence), durationMs: performance.now() - started };
  });
}

export function compareRuntimeOwners(value: unknown, expected: string[], owner: "javascript" | "moduleConfiguration" | "ordinaryJavaScript"): boolean {
  const subject = record(value);
  return compareRuntimeReasons(record(subject["moduleConfigurationObservations"])[owner === "ordinaryJavaScript" ? "ordinaryWithoutSnapshot" : "retainedWithoutSource"], expected) && (owner === "moduleConfiguration" || compareRuntimeReasons(subject["javascriptObservation"], expected));
}
