import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { sha256, type CampaignContext, type Evidence, type ObligationResult, type PropertyResult } from "./t00-ts7-q-config-campaign";
import { programObservationSucceeded } from "./t00-ts7-q-config-pew";

type Value = Record<string, unknown>;
type Observation = { exitCode: number; value: Value; evidence: Evidence[] };
const record = (value: unknown): Value => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Value : {};
const rows = (value: unknown): Value[] => Array.isArray(value) ? value.map(record) : [];
const canonical = (value: unknown): string => JSON.stringify(value, (_key, nested: unknown) => nested !== null && typeof nested === "object" && !Array.isArray(nested) ? Object.fromEntries(Object.entries(nested).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : nested);
const jsxReasons = ["SOURCE_AUTOMATIC_JSX_RUNTIME_UNSUPPORTED", "SOURCE_CLASSIC_JSX_RUNTIME_UNSUPPORTED"];
const options = { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", jsx: "Preserve", allowJs: true, skipLibCheck: true, noEmit: true, strict: false };

export function configurationProgramBound(exitCode: number, stderr: string, value: unknown, requestId: string, producerId: string): boolean {
  const observed = record(value);
  return exitCode === 0 && stderr.trim() === "" && observed["request_id"] === requestId && observed["producer_artifact_id"] === producerId;
}

export function configurationProgramTarget(exitCode: number, value: unknown, target: string | null): boolean {
  if (!programObservationSucceeded(exitCode, value)) return false;
  const extraction = record(record(value)["raw_extraction"]);
  const imports = rows(extraction["imports"]).filter(item => item["fromRelPath"] === "main.ts" && item["moduleSpecifier"] === "@leaf");
  const calls = rows(extraction["calls"]).filter(item => item["callerRelPath"] === "main.ts" && item["callerSymbolPath"] === "main" && item["calleeName"] === "leaf");
  if (imports.length !== 1 || calls.length !== 1) return false;
  const imported = imports[0]!, called = calls[0]!;
  if (target === null) return imported["resolvedRelPath"] === undefined && (imported["bindingTargets"] === undefined || isDeepStrictEqual(imported["bindingTargets"], [])) && called["calleeRelPath"] === undefined && called["calleeSymbolPath"] === undefined;
  return imported["resolvedRelPath"] === target && isDeepStrictEqual(imported["bindingTargets"], [{ relPath: target, symbolPath: "leaf" }]) && called["calleeRelPath"] === target && called["calleeSymbolPath"] === "leaf";
}

export function configurationJsxReasons(exitCode: number, value: unknown, retained: boolean, expected: string[]): boolean {
  if (!programObservationSucceeded(exitCode, value)) return false;
  const subjects = rows(record(value)["subjects"]);
  if (subjects.length !== 1 || subjects[0]?.["path"] !== "view.tsx") return false;
  const observations = record(subjects[0]["moduleConfigurationObservations"]);
  const scopes = retained ? ["retainedWithoutSource", "retainedWithSource"] : ["ordinaryWithoutSnapshot"];
  return scopes.every(scope => {
    const observed = record(observations[scope]);
    const reasons = observed["reasons"];
    return observed["executed"] === true && isDeepStrictEqual(observed["unsupported"], []) && Array.isArray(reasons) && reasons.every(reason => typeof reason === "string") && isDeepStrictEqual(reasons.filter(reason => jsxReasons.includes(String(reason))).sort(), [...expected].sort());
  });
}

export function configurationOracleResolution(exitCode: number, stdout: string, root: string, expected: string | null): { passed: boolean; target: string | null } {
  const matches = [...stdout.matchAll(/Module name '@leaf' was successfully resolved to '([^']+)'/g)];
  const target = matches.length === 1 ? relative(root, matches[0]![1]!).split("\\").join("/") : null;
  const diagnostics = [...stdout.matchAll(/error TS(\d+):/g)].map(match => Number(match[1]));
  const passed = expected === null ? exitCode === 2 && isDeepStrictEqual(diagnostics, [2307]) && matches.length === 0 : exitCode === 0 && diagnostics.length === 0 && target === expected && matches.length === 1;
  return { passed, target };
}

function save(path: string, value: unknown, raw = false): Evidence {
  mkdirSync(dirname(path), { recursive: true });
  const bytes = Buffer.from(raw ? String(value) : JSON.stringify(value, null, 2) + "\n");
  writeFileSync(path, bytes);
  return { path, sha256: sha256(bytes), bytes: bytes.length };
}

class ProgramWitnesses {
  readonly directory: string;
  readonly sdkFiles: string[];
  readonly sdkEvidence: Evidence[] = [];
  constructor(readonly ctx: CampaignContext) {
    this.directory = resolve(ctx.out, "program");
    const files = record(record(JSON.parse(readFileSync(ctx.sdk, "utf8")) as unknown)["files"]);
    if (Object.keys(files).length !== 115) throw Error("Program oracle requires the 115 explicit TS7 SDK libraries");
    this.sdkFiles = Object.entries(files).map(([path, source]) => {
      const name = path.split("/").at(-1)!;
      if (typeof source !== "string" || !/^lib(?:\.[a-z0-9.]+)?\.d\.ts$/.test(name)) throw Error("Invalid Program oracle SDK library");
      const output = resolve(this.directory, "oracle-sdk", name);
      this.sdkEvidence.push(save(output, source, true));
      return output;
    }).sort();
    if (new Set(this.sdkFiles).size !== 115) throw Error("Duplicate Program oracle SDK library");
  }
  fixture(name: string, input: Record<string, string>): { root: string; files: Record<string, string>; evidence: Evidence[] } {
    const root = resolve(this.directory, name, "repository");
    const files = Object.fromEntries(Object.entries(input).map(([path, source]) => [resolve(root, path), source]));
    return { root, files, evidence: Object.entries(files).map(([path, source]) => save(path, source, true)) };
  }
  async analyze(name: string, root: string, files: Record<string, string>, roots: string[], retained: boolean): Promise<Observation> {
    const request = resolve(this.directory, name + ".request.json");
    const descriptor = { id: "program-" + name, cwd: root, sdk_directory: "/sdk/lib", case_sensitive: this.ctx.platform === "linux", roots, files, retained, qualified: false, options, roles: {}, selection: {}, disabled: [], utf16_files: {}, raw_files: {} };
    const input = save(request, descriptor);
    const result = await this.ctx.run("program-" + name, [this.ctx.producer, request, this.ctx.sdk]);
    let value: Value;
    try { value = record(JSON.parse(result.stdout) as unknown); } catch { value = {}; }
    if (!configurationProgramBound(result.exitCode, result.stderr, value, `sha256:${sha256(canonical(descriptor))}`, `sha256:${sha256(readFileSync(this.ctx.producer))}`)) value = {};
    return { exitCode: result.exitCode, value, evidence: [input, ...result.evidence] };
  }
  async oracle(name: string, root: string, roots: string[], extra: Value = {}, emit = false): Promise<{ exitCode: number; stdout: string; stderr: string; evidence: Evidence[]; emitted: string }> {
    const config = resolve(root, "tsconfig.oracle-" + name + ".json");
    const output = resolve(this.directory, "emitted", name);
    const input = save(config, { compilerOptions: { target: "es2022", module: "esnext", moduleResolution: "bundler", jsx: "preserve", allowJs: true, skipLibCheck: true, strict: false, noLib: true, types: [], noEmit: !emit, outDir: output, ...extra }, files: [...this.sdkFiles, ...roots] });
    const result = await this.ctx.run("program-oracle-" + name, [this.ctx.oracle, "--pretty", "false", "--project", config, "--traceResolution"], root);
    let emitted = "";
    const emittedEvidence: Evidence[] = [];
    if (emit && result.exitCode === 0) {
      const path = resolve(output, "view." + (extra["jsx"] === "preserve" ? "jsx" : "js"));
      try { emitted = readFileSync(path, "utf8"); emittedEvidence.push({ path, sha256: sha256(emitted), bytes: Buffer.byteLength(emitted) }); } catch { emitted = ""; }
    }
    return { ...result, emitted, evidence: [input, ...this.sdkEvidence, ...result.evidence, ...emittedEvidence] };
  }
  async aliases(): Promise<PropertyResult[]> {
    const evidence: Evidence[] = [];
    const comparisons: { name: string; passed: boolean; oracleTarget: string | null; expected: string | null; liveMapping: string }[] = [];
    for (const retained of [true, false]) {
      for (const selected of ["leaf", "other", "missing"] as const) {
        const name = `alias-${retained ? "retained" : "ordinary"}-${selected}`;
        const paths = { "@leaf": [`./src/${selected}.ts`] };
        const fixture = this.fixture(name, {
          "main.ts": "import { leaf } from '@leaf'; export function main() { return leaf(); }\n",
          "src/leaf.ts": "export function leaf() { return 1; }\n",
          "src/other.ts": "export function leaf() { return 2; }\n",
          "tsconfig.json": JSON.stringify({ compilerOptions: { target: "es2022", module: "esnext", moduleResolution: "bundler", paths } }),
        });
        const liveMapping = retained ? selected === "leaf" ? "other" : "leaf" : selected;
        if (retained) {
          const configPath = resolve(fixture.root, "tsconfig.json");
          const liveEvidence = save(configPath, JSON.stringify({ compilerOptions: { target: "es2022", module: "esnext", moduleResolution: "bundler", paths: { "@leaf": [`./src/${liveMapping}.ts`] } } }), true);
          fixture.evidence = fixture.evidence.filter(item => item.path !== configPath);
          fixture.evidence.push(liveEvidence);
        }
        const roots = Object.keys(fixture.files).filter(path => path.endsWith(".ts"));
        const oracle = await this.oracle(name, fixture.root, roots, retained ? { paths } : {});
        const expected = retained && selected !== "missing" ? `src/${selected}.ts` : null;
        const oracleResolution = configurationOracleResolution(oracle.exitCode, oracle.stdout, fixture.root, expected);
        const oracleTarget = oracleResolution.target;
        const observed = await this.analyze(name, fixture.root, fixture.files, roots, retained);
        const passed = oracle.stderr.trim() === "" && oracleResolution.passed && configurationProgramTarget(observed.exitCode, observed.value, oracleTarget);
        comparisons.push({ name, passed, oracleTarget, expected, liveMapping });
        evidence.push(...fixture.evidence, ...oracle.evidence, ...observed.evidence);
      }
    }
    evidence.push(save(resolve(this.directory, "aliases.comparison.json"), { authority: "Pinned independent TS7 CLI with explicit fixed Program options; configured retained paths versus ordinary paths omitted by createProgram contract", comparisons }));
    const retained = comparisons.filter(item => item.name.includes("-retained-"));
    const ordinary = comparisons.filter(item => item.name.includes("-ordinary-"));
    return [
      { property: "retained resolver actual target", status: retained.every(item => item.passed) ? "pass" : "fail", reason: "Captured config differs from live config. Independent TS7 chooses captured leaf, alternative other, or unresolved; imported binding and call endpoint must agree.", evidence },
      { property: "historical TS-only does not consume live config", status: comparisons.every(item => item.passed) && ordinary.length === 3 ? "pass" : "fail", reason: "Ordinary TS-only Program keeps @leaf unresolved for leaf/other/missing live mappings while retained controls select the mapped target. Diagnostic configuration reads are outside this Program-resolution property.", evidence },
    ];
  }
  async source(): Promise<PropertyResult> {
    const evidence: Evidence[] = [];
    const comparisons: { name: string; passed: boolean }[] = [];
    const live = "export function transient() { return 9; }\n";
    for (const name of ["leaf", "transient"]) {
      const text = name === "leaf" ? "export function leaf() { return 1; }\n" : live;
      const fixture = this.fixture("source-" + name, { "src/leaf.ts": live });
      const path = resolve(fixture.root, "src/leaf.ts");
      const captured = { [path]: text };
      const oracleFixture = this.fixture("source-oracle-" + name, { "src/leaf.ts": text });
      const oracle = await this.oracle("source-" + name, oracleFixture.root, Object.keys(oracleFixture.files));
      const result = await this.analyze("source-" + name, fixture.root, captured, [path], true);
      const symbols = rows(record(result.value["raw_extraction"])["symbols"]).map(symbol => ({ name: symbol["name"], relPath: symbol["relPath"] }));
      comparisons.push({ name, passed: oracle.exitCode === 0 && oracle.stderr.trim() === "" && programObservationSucceeded(result.exitCode, result.value) && isDeepStrictEqual(symbols, [{ name, relPath: "src/leaf.ts" }]) });
      evidence.push(...fixture.evidence, ...oracleFixture.evidence, ...oracle.evidence, ...result.evidence);
    }
    evidence.push(save(resolve(this.directory, "source.comparison.json"), { authority: "Retained source contract projects leaf versus transient from captured bytes; independent TS7 compiles both captured texts", comparisons }));
    return { property: "source bytes leaf retained instead of transient", status: comparisons.every(item => item.passed) ? "pass" : "fail", reason: "Physical source contains transient; captured leaf still extracts leaf. Capturing transient activates the alternative against the same physical source text.", evidence };
  }
  async jsx(): Promise<PropertyResult> {
    const evidence: Evidence[] = [];
    const comparisons: { name: string; passed: boolean; expected: string[] }[] = [];
    for (const retained of [true, false]) {
      for (const mode of ["preserve", "react-jsx", "react"] as const) {
        const name = `jsx-${retained ? "retained" : "ordinary"}-${mode}`;
        const fixture = this.fixture(name, {
          "view.tsx": "declare const React: { createElement(...args: unknown[]): unknown };\nexport const view = <div/>;\n",
          "tsconfig.json": JSON.stringify({ compilerOptions: { target: "es2022", module: "esnext", moduleResolution: "bundler", jsx: mode } }),
          "node_modules/react/jsx-runtime.d.ts": "export function jsx(type: unknown, props: unknown): unknown;\nexport function jsxs(type: unknown, props: unknown): unknown;\n",
        });
        const root = resolve(fixture.root, "view.tsx");
        const oracle = await this.oracle(name, fixture.root, [root], { jsx: mode }, true);
        const emitted = mode === "preserve" ? oracle.emitted.includes("<div/>") || oracle.emitted.includes("<div />") : mode === "react" ? oracle.emitted.includes("React.createElement(\"div\"") : oracle.emitted.includes("react/jsx-runtime") && oracle.emitted.includes('"div"');
        const expected = retained && mode !== "preserve" ? [jsxReasons[mode === "react-jsx" ? 0 : 1]!] : [];
        const result = await this.analyze(name, fixture.root, fixture.files, [root], retained);
        comparisons.push({ name, expected, passed: oracle.exitCode === 0 && oracle.stderr.trim() === "" && emitted && configurationJsxReasons(result.exitCode, result.value, retained, expected) });
        evidence.push(...fixture.evidence, ...oracle.evidence, ...result.evidence);
      }
    }
    evidence.push(save(resolve(this.directory, "jsx.comparison.json"), { authority: "P17 preserve excludes only AUTOMATIC_JSX/CLASSIC_JSX; retained runtime controls activate those reasons; ordinary configuration observer excludes source-dependent runtime classification", comparisons }));
    return { property: "absence only AUTOMATIC_JSX/CLASSIC_JSX configuration reasons", status: comparisons.every(item => item.passed) ? "pass" : "fail", reason: "TS7 emit independently preserves JSX or generates automatic/classic calls; preserve lacks both named reasons in ordinary and retained configuration observers, with activated retained alternatives. Other reasons are not asserted absent.", evidence };
  }
}

export async function runConfigurationProgram(ctx: CampaignContext, indices: number[]): Promise<ObligationResult[]> {
  if (!indices.some(index => index === 167 || index === 171)) return [];
  const witnesses = new ProgramWitnesses(ctx);
  const started = performance.now();
  const aliases = await witnesses.aliases();
  const results: ObligationResult[] = [];
  for (const index of [167, 171].filter(item => indices.includes(item))) {
    const properties = index === 167 ? [aliases[0]!, await witnesses.jsx()] : [await witnesses.source(), { ...aliases[0]!, property: "retained config chooses leaf target" }, aliases[1]!];
    const qualified = properties.every(item => item.status === "pass");
    const evidence = [...new Map(properties.flatMap(item => item.evidence ?? []).map(item => [item.path, item])).values()];
    results.push({ index, id: index === 167 ? "T00-OBL-packages-ts-analyzer-src-ts-symbols-ts-compiler-options-469a3ad01e" : "T00-OBL-packages-ts-analyzer-src-ts-symbols-ts-createprogram-67dc915614", status: qualified ? "qualified" : "not_qualified", reason: qualified ? "All finite contract properties and independent TS7 activating/control witnesses passed on this platform; final qualification requires frozen cross-platform aggregation." : properties.filter(item => item.status !== "pass").map(item => item.property + ": " + item.reason).join("; "), properties, evidence, durationMs: Math.round(performance.now() - started) });
  }
  return results;
}
