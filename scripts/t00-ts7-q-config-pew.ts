import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { CampaignContext, Evidence, ObligationResult } from "./t00-ts7-q-config-campaign";

import { extractionIndices, runExtractionWorkers } from "./t00-ts7-q-config-extraction";

type Value = Record<string, unknown>;
type Property = ObligationResult["properties"][number];
type Observation = { value: Value; exitCode: number; evidence: Evidence[]; stdout: string; stderr: string };
const record = (value: unknown): Value => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Value : {};
const array = (value: unknown): unknown[] => Array.isArray(value) ? value as unknown[] : [];
const definitions = [
  {
    "index": 167,
    "id": "T00-OBL-packages-ts-analyzer-src-ts-symbols-ts-compiler-options-469a3ad01e",
    "properties": [
      "retained resolver actual target",
      "absence only AUTOMATIC_JSX/CLASSIC_JSX configuration reasons"
    ]
  },
  {
    "index": 171,
    "id": "T00-OBL-packages-ts-analyzer-src-ts-symbols-ts-createprogram-67dc915614",
    "properties": [
      "source bytes leaf retained instead of transient",
      "retained config chooses leaf target",
      "historical TS-only does not consume live config"
    ]
  },
  {
    "index": 172,
    "id": "T00-OBL-packages-ts-analyzer-src-ts-symbols-ts-createprogram-callback-171-61dd1124fe",
    "properties": [
      "readFile retained versus live-only",
      "symbols retained leaf, transient absent"
    ]
  },
  {
    "index": 173,
    "id": "T00-OBL-packages-ts-analyzer-src-ts-symbols-ts-createprogram-callback-172-197ebbbd27",
    "properties": [
      "fileExists true retained, false live-only"
    ]
  },
  {
    "index": 174,
    "id": "T00-OBL-packages-ts-analyzer-src-ts-symbols-ts-createprogram-callback-173-b82e64d228",
    "properties": [
      "directoryExists retained ancestors true/missing false"
    ]
  },
  {
    "index": 175,
    "id": "T00-OBL-packages-ts-analyzer-src-ts-symbols-ts-createprogram-callback-180-a0436dd435",
    "properties": [
      "configured alias resolved relative target",
      "unresolved configured target"
    ]
  },
  {
    "index": 12,
    "id": "T00-OBL-packages-ts-analyzer-src-javascript-diagnostics-ts-inspectimportedruntimehelpers-28fdd45ef7",
    "properties": [
      "owning consumer observable rule(s) in canonical family/call-path contract"
    ]
  },
  {
    "index": 13,
    "id": "T00-OBL-packages-ts-analyzer-src-javascript-diagnostics-ts-inspectimportedruntimehelpers-callb-f5054798c5",
    "properties": [
      "owning consumer observable rule(s) in canonical family/call-path contract"
    ]
  },
  {
    "index": 14,
    "id": "T00-OBL-packages-ts-analyzer-src-javascript-diagnostics-ts-inspectimportedruntimehelpers-callb-547b133b32",
    "properties": [
      "owning consumer observable rule(s) in canonical family/call-path contract"
    ]
  },
  {
    "index": 15,
    "id": "T00-OBL-packages-ts-analyzer-src-javascript-diagnostics-ts-inspectjavascriptsource-5e3eda13a6",
    "properties": [
      "owning consumer observable rule(s) in canonical family/call-path contract"
    ]
  },
  {
    "index": 16,
    "id": "T00-OBL-packages-ts-analyzer-src-javascript-diagnostics-ts-inspectjavascriptsource-callback-24-d0ac8d43e4",
    "properties": [
      "owning consumer observable rule(s) in canonical family/call-path contract"
    ]
  },
  {
    "index": 20,
    "id": "T00-OBL-packages-ts-analyzer-src-javascript-diagnostics-ts-inspectjsxruntimeboundary-c6b77f683f",
    "properties": [
      "owning consumer observable rule(s) in canonical family/call-path contract"
    ]
  },
  {
    "index": 21,
    "id": "T00-OBL-packages-ts-analyzer-src-javascript-diagnostics-ts-inspectjsxruntimeboundary-callback--3eab9541f5",
    "properties": [
      "owning consumer observable rule(s) in canonical family/call-path contract"
    ]
  },
  {
    "index": 22,
    "id": "T00-OBL-packages-ts-analyzer-src-javascript-diagnostics-ts-inspectjsxruntimeboundary-visit-26217b99b8",
    "properties": [
      "owning consumer observable rule(s) in canonical family/call-path contract"
    ]
  },
  {
    "index": 192,
    "id": "T00-OBL-packages-ts-analyzer-src-ts-symbols-ts-preflightparallelsafety-9a779575ba",
    "properties": [
      "used2 parallel and declarations omitted from emitted modules",
      "mixed JS preflight-fallback used1"
    ]
  },
  {
    "index": 193,
    "id": "T00-OBL-packages-ts-analyzer-src-ts-symbols-ts-preflightparallelsafety-callback-732-1b412a6696",
    "properties": [
      "exact emitted modules and same extraction"
    ]
  },
  {
    "index": 194,
    "id": "T00-OBL-packages-ts-analyzer-src-ts-symbols-ts-preflightparallelsafety-callback-735-fee21a59f6",
    "properties": [
      "valid repository-root graph"
    ]
  },
  {
    "index": 195,
    "id": "T00-OBL-packages-ts-analyzer-src-ts-symbols-ts-preflightparallelsafety-callback-762-125bbc5421",
    "properties": [
      "globals.d.ts context present but modules only a/b"
    ]
  },
  {
    "index": 196,
    "id": "T00-OBL-packages-ts-analyzer-src-ts-symbols-ts-preflightparallelsafety-visit-149cc4f783",
    "properties": [
      "declaration interface is not augmentation"
    ]
  },
  {
    "index": 210,
    "id": "T00-OBL-packages-ts-analyzer-src-ts-symbols-ts-rootmodulecomponents-574d894c20",
    "properties": [
      "owning consumer observable rule(s) in canonical family/call-path contract"
    ]
  },
  {
    "index": 211,
    "id": "T00-OBL-packages-ts-analyzer-src-ts-symbols-ts-rootmodulecomponents-callback-779-0856ce2426",
    "properties": [
      "owning consumer observable rule(s) in canonical family/call-path contract"
    ]
  },
  {
    "index": 212,
    "id": "T00-OBL-packages-ts-analyzer-src-ts-symbols-ts-rootmodulecomponents-callback-780-852b2c92e5",
    "properties": [
      "owning consumer observable rule(s) in canonical family/call-path contract"
    ]
  },
  {
    "index": 213,
    "id": "T00-OBL-packages-ts-analyzer-src-ts-symbols-ts-rootmodulecomponents-callback-784-ab3344a529",
    "properties": [
      "owning consumer observable rule(s) in canonical family/call-path contract"
    ]
  },
  {
    "index": 239,
    "id": "T00-OBL-packages-ts-analyzer-src-index-worker-ts-worker-extraction-entrypoint-d1cb292fa7",
    "properties": [
      "complete ordinary worker module/symbol/import/call sets",
      "exact child malformed request response",
      "context roots retained while emission filtered",
      "parent response DTO failure"
    ]
  }
];

export function comparePewExtraction(actual: unknown, expected: unknown): boolean {
  return isDeepStrictEqual(actual, expected);
}

export function pewObservationSucceeded(exitCode: number, value: unknown): boolean {
  const observation = record(value);
  return exitCode === 0 && observation["executed"] === true && isDeepStrictEqual(observation["unsupported"], []);
}

export function programObservationSucceeded(exitCode: number, value: unknown): boolean {
  const observed = record(value);
  const subjects = array(observed["subjects"]).map(record);
  return exitCode === 0 && observed["complete"] === true && subjects.length > 0 && subjects.every(subject => subject["outcome"] === "analyzed" && isDeepStrictEqual(subject["unimplemented"], []) && isDeepStrictEqual(subject["parseDiagnostics"], []));
}

function save(path: string, value: unknown, raw = false): Evidence {
  mkdirSync(dirname(path), { recursive: true });
  const bytes = Buffer.from(raw ? String(value) : JSON.stringify(value, null, 2) + "\n");
  writeFileSync(path, bytes);
  return { path, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length };
}

function property(name: string, pass: boolean, reason: string): Property {
  return { property: name, status: pass ? "pass" : "fail", reason };
}

class Witnesses {
  readonly cache = new Map<string, Promise<Observation>>();
  readonly directory: string;
  readonly sdkFiles: string[];
  readonly sdkEvidence: Evidence[] = [];
  constructor(readonly ctx: CampaignContext) {
    this.directory = resolve(ctx.out, "pew");
    const sdk = record(JSON.parse(readFileSync(ctx.sdk, "utf8")) as unknown);
    const files = record(sdk["files"]);
    if (Object.keys(files).length !== 115) throw Error("TS7 oracle requires exactly 115 explicit SDK libraries");
    this.sdkFiles = Object.entries(files).map(([path, text]) => {
      if (typeof text !== "string" || !/^lib(?:\.[a-z0-9.]+)?\.d\.ts$/.test(path.split("/").at(-1) ?? "")) throw Error("Invalid TS7 library input");
      const output = resolve(this.directory, "oracle-sdk", path.split("/").at(-1)!);
      this.sdkEvidence.push(save(output, text, true));
      return output;
    }).sort();
    if (new Set(this.sdkFiles).size !== 115) throw Error("Duplicate TS7 oracle SDK library basename");
  }
  async observe(name: string, mode: string | null, descriptor: unknown, sdk = false): Promise<Observation> {
    const path = resolve(this.directory, name + ".request.json");
    const input = save(path, descriptor);
    const argv = [this.ctx.producer, ...(mode === null ? [] : [mode]), path, ...(sdk ? [this.ctx.sdk] : []), ...(mode === "--extract-parallel" ? [this.ctx.helper] : [])];
    const output = await this.ctx.run("pew-" + name, argv);
    if (output.exitCode < 0) throw Error("Technical candidate execution failure: " + name);
    let value: Value;
    try { value = record(JSON.parse(output.stdout) as unknown); } catch { value = {}; }
    return { ...output, value, evidence: [input, ...output.evidence] };
  }
  fixture(name: string, files: Record<string, string>): { root: string; files: Record<string, string>; evidence: Evidence[] } {
    const root = resolve(this.directory, name, "repository");
    const mapped: Record<string, string> = {};
    const evidence = Object.entries(files).map(([path, text]) => {
      mapped[resolve(root, path)] = text;
      return save(resolve(root, path), text, true);
    });
    return { root, files: mapped, evidence };
  }
  async oracle(name: string, root: string, files: string[], options: Value = {}, emit = false): Promise<Observation> {
    const config = resolve(root, "tsconfig.oracle.json");
    const input = save(config, { compilerOptions: { target: "es2022", module: "esnext", moduleResolution: "bundler", noLib: true, types: [], skipLibCheck: true, noEmit: !emit, outDir: resolve(this.directory, name, "emitted"), ...options }, files: [...this.sdkFiles, ...files] });
    const output = await this.ctx.run("pew-oracle-" + name, [this.ctx.oracle, "--pretty", "false", "--project", config, "--listFiles", "--traceResolution"], root);
    if (output.exitCode < 0) throw Error("Technical oracle execution failure: " + name);
    return { ...output, value: {}, evidence: [input, ...this.sdkEvidence, ...output.evidence] };
  }
  analyze(name: string, root: string, files: Record<string, string>, roots: string[], retained = true): Promise<Observation> {
    return this.observe(name, null, { id: "pew-" + name, cwd: root, sdk_directory: "/sdk/lib", case_sensitive: this.ctx.platform === "linux", roots, files, retained, qualified: false, options: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", jsx: "Preserve", allowJs: true, skipLibCheck: true, noEmit: true, strict: false } }, true);
  }
  once(name: string, action: () => Promise<Observation>): Promise<Observation> {
    const previous = this.cache.get(name);
    if (previous !== undefined) return previous;
    const current = action();
    this.cache.set(name, current);
    return current;
  }
  source(): Promise<Observation> {
    return this.once("retained-source", async () => {
      const text = "export function leaf() { return 1; }\n";
      const fixture = this.fixture("retained-source", { "src/leaf.ts": text, "live-only.ts": "export function transient() { return 9; }\n" });
      const path = resolve(fixture.root, "src/leaf.ts");
      const captured = { [path]: text };
      fixture.evidence.splice(0, 1, save(path, "export function transient() { return 9; }\n", true));
      const oracleFixture = this.fixture("retained-source-oracle", { "src/leaf.ts": text });
      const oracle = await this.oracle("retained-source", oracleFixture.root, Object.keys(oracleFixture.files));
      const result = await this.analyze("retained-source", fixture.root, captured, [path]);
      result.value["oracleSucceeded"] = oracle.exitCode === 0;
      result.evidence.push(...fixture.evidence, ...oracleFixture.evidence, ...oracle.evidence);
      return result;
    });
  }
  system(): Promise<Observation> {
    return this.once("retained-system", async () => {
      const fixture = this.fixture("retained-system", { "captured/leaf.ts": "live transient", "live-only.ts": "live only" });
      const path = resolve(fixture.root, "captured/leaf.ts"), absent = resolve(fixture.root, "live-only.ts");
      const result = await this.observe("retained-system", "--observe-system", { profile: "retained", root: fixture.root, case_sensitive: true, files: { [path]: "retained leaf" }, sdk_directory: null, queries: [ { operation: "read_file", path }, { operation: "read_file", path: absent }, { operation: "file_exists", path }, { operation: "file_exists", path: absent }, { operation: "directory_exists", path: resolve(fixture.root, "captured") }, { operation: "directory_exists", path: resolve(fixture.root, "missing") } ] });
      result.evidence.push(...fixture.evidence, save(resolve(this.directory, "retained-system.expected.json"), ["retained leaf", null, true, false, true, false]));
      return result;
    });
  }
  alias(missing: boolean): Promise<Observation> {
    const name = missing ? "alias-missing" : "alias-present";
    return this.once(name, async () => {
      const files = { "main.ts": "import { leaf } from '@leaf'; export function main() { return leaf(); }\n", "src/leaf.ts": "export function leaf() { return 1; }\n", "tsconfig.json": JSON.stringify({ compilerOptions: { target: "es2022", module: "esnext", moduleResolution: "bundler", paths: { "@leaf": [missing ? "./src/absent.ts" : "./src/leaf.ts"] } } }) };
      const fixture = this.fixture(name, files);
      const oracle = await this.oracle(name, fixture.root, [resolve(fixture.root, "main.ts")], { paths: { "@leaf": [missing ? "./src/absent.ts" : "./src/leaf.ts"] } });
      const result = await this.analyze(name, fixture.root, fixture.files, [resolve(fixture.root, "main.ts"), resolve(fixture.root, "src/leaf.ts")]);
      result.value["oracleSucceeded"] = missing ? oracle.exitCode !== 0 && oracle.stdout.includes("TS2307") : oracle.exitCode === 0 && oracle.stdout.includes(resolve(fixture.root, "src/leaf.ts"));
      result.evidence.push(...fixture.evidence, ...oracle.evidence, save(resolve(this.directory, name + ".expected.json"), { fromRelPath: "main.ts", moduleSpecifier: "@leaf", resolvedRelPath: missing ? null : "src/leaf.ts" }));
      return result;
    });
  }
  parallel(kind: "safe" | "mixed" | "augmentation" | "module-augmentation" | "connected"): Promise<Observation> {
    return this.once("parallel-" + kind, async () => {
      const files: Record<string, string> = kind === "mixed" ? { "a.ts": "export const a = 1;\n", "b.js": "export const b = 2;\n" } : { "a.ts": "export const a: Shared = { value: 1 };\n", "b.ts": "export const b: Shared = { value: 2 };\n", "globals.d.ts": kind === "augmentation" ? "export {}; declare global { interface Shared { value: number } }\n" : "interface Shared { value: number }\n" };
      if (kind === "module-augmentation") {
        files["globals.d.ts"] = 'declare module "foreign" { export interface Shared { value: number } }\n';
        files["a.ts"] = "export const a = 1;\n";
        files["b.ts"] = "export const b = 2;\n";
      }
      if (kind === "connected") files["a.ts"] = "import { b } from './b'; export const a = b;\n";
      const fixture = this.fixture("parallel-" + kind, files);
      const roots = Object.keys(files).sort().map(path => resolve(fixture.root, path));
      const oracle = await this.oracle("parallel-" + kind, fixture.root, roots, { allowJs: kind === "mixed" });
      const result = await this.observe("parallel-" + kind, "--extract-parallel", { repoRoot: fixture.root, rootAbsPaths: roots, workers: 2 }, true);
      result.value["oracleSucceeded"] = oracle.exitCode === 0;
      result.evidence.push(...fixture.evidence, ...oracle.evidence);
      if (kind === "safe") result.evidence.push(save(resolve(this.directory, "parallel-safe.expected.json"), { modules: ["a.ts", "b.ts"], symbols: [], imports: [], calls: [] }));
      return result;
    });
  }
  emission(): Promise<Observation> {
    return this.once("emission", async () => {
      const fixture = this.fixture("emission", { "main.jsx": "export const view = <section />;\n" });
      const oracle = await this.oracle("emission", fixture.root, Object.keys(fixture.files), { allowJs: true, jsx: "react", noEmitOnError: false }, true);
      const result = await this.analyze("emission", fixture.root, fixture.files, Object.keys(fixture.files));
      result.evidence.push(...fixture.evidence, ...oracle.evidence);
      return result;
    });
  }

}

export async function runProgramEmissionWorkers(ctx: CampaignContext, indices: number[]): Promise<ObligationResult[]> {
  const witnesses = new Witnesses(ctx);
  const results: ObligationResult[] = await runExtractionWorkers(ctx, definitions.filter(item => indices.includes(item.index)));
  for (const definition of definitions.filter(item => indices.includes(item.index) && !extractionIndices.has(item.index))) {
    const started = performance.now();
    const properties: Property[] = [];
    const evidence: Evidence[] = [];
    const add = (name: string, pass: boolean, reason: string): void => { properties.push(property(name, pass, reason)); };
    const index = definition.index;
      if (index < 23) {
        const observed = await witnesses.emission();
        evidence.push(...observed.evidence);
        properties.push({ property: definition.properties[0]!, status: "not_qualified", reason: "ARB-003: CLI emit does not independently expose transpileModule transformer helpers, synthesized flags or source spans; zero credit. Raw TS7 and candidate observations retained." });
      } else if ([171, 172, 173, 174].includes(index)) {
        const source = await witnesses.source(), system = await witnesses.system();
        evidence.push(...source.evidence, ...system.evidence);
        const subjects = array(source.value["subjects"]);
        const extraction = record(source.value["raw_extraction"]);
        const symbols = array(extraction["symbols"]).map(record);
        const sourcePass = programObservationSucceeded(source.exitCode, source.value) && source.value["oracleSucceeded"] === true && subjects.length === 1 && symbols.some(symbol => symbol["name"] === "leaf" && symbol["relPath"] === "src/leaf.ts") && !symbols.some(symbol => symbol["name"] === "transient");
        const rows = array(system.value["results"]).map(record);
        const systemPass = pewObservationSucceeded(system.exitCode, system.value) && rows.length === 6 && rows.every(row => row["executed"] === true && isDeepStrictEqual(row["unsupported"], []));
        if (index === 171) {
          add(definition.properties[0]!, sourcePass, "Independent retained source control and tsgo compilation versus changed live bytes.");
          properties.push(...definition.properties.slice(1).map(name => ({ property: name, status: "not_qualified" as const, reason: "Ordinary TS-only config non-consumption and retained config branch require complete consumer-specific projection." })));
        } else if (index === 172) {
          add(definition.properties[0]!, systemPass && rows[0]?.["value"] === "retained leaf" && rows[1]?.["found"] === false, "Retained bytes differ from live bytes; live-only file is absent.");
          add(definition.properties[1]!, sourcePass, "Actual Program extracts retained leaf and omits live transient.");
        } else if (index === 173) add(definition.properties[0]!, sourcePass && systemPass && rows[2]?.["value"] === true && rows[3]?.["value"] === false, "Actual retained Program plus independent retained/live-only existence controls.");
        else add(definition.properties[0]!, sourcePass && systemPass && rows[4]?.["value"] === true && rows[5]?.["value"] === false, "Actual retained Program plus ancestor/missing directory controls.");
      } else if (index === 167 || index === 175) {
        const present = await witnesses.alias(false), missing = await witnesses.alias(true);
        evidence.push(...present.evidence, ...missing.evidence);
        const imports = (value: Value): Value[] => array(record(value["raw_extraction"])["imports"]).map(record).filter(row => row["moduleSpecifier"] === "@leaf");
        const resolved = imports(present.value), unresolved = imports(missing.value);
        const pass = programObservationSucceeded(present.exitCode, present.value) && present.value["oracleSucceeded"] === true && resolved.length === 1 && resolved[0]?.["resolvedRelPath"] === "src/leaf.ts";
        add(definition.properties[0]!, pass, "Explicit TS7 SDK and independent CLI path mapping choose src/leaf.ts.");
        if (index === 175) add(definition.properties[1]!, programObservationSucceeded(missing.exitCode, missing.value) && missing.value["oracleSucceeded"] === true && unresolved.length === 1 && unresolved[0]?.["resolvedRelPath"] === undefined, "Missing alias target independently produces TS2307; the native Program must execute without unsupported operations and have no resolved target.");
        else properties.push({ property: definition.properties[1]!, status: "not_qualified", reason: "Complete configuration reason absence controls across ordinary and retained JSX not independently closed." });
      } else {
        const safe = await witnesses.parallel("safe"), augmentation = await witnesses.parallel("augmentation"), connected = await witnesses.parallel("connected");
        evidence.push(...safe.evidence, ...augmentation.evidence, ...connected.evidence);
        const parallel = record(safe.value["parallelism"]), preflight = record(safe.value["preflight"]), graph = record(preflight["moduleComponents"]);
        const safePass = pewObservationSucceeded(safe.exitCode, safe.value) && safe.value["oracleSucceeded"] === true && parallel["used"] === 2 && parallel["mode"] === "parallel";
        const exact = comparePewExtraction(safe.value["extraction"], { modules: ["a.ts", "b.ts"], symbols: [], imports: [], calls: [] });
        const graphPass = safePass && pewObservationSucceeded(0, graph) && isDeepStrictEqual(graph["loadedRepositorySources"], ["a.ts", "b.ts", "globals.d.ts"]) && isDeepStrictEqual(graph["selectedRoots"], ["a.ts", "b.ts"]) && isDeepStrictEqual(graph["dependencyComponents"], [["a.ts"], ["b.ts"]]) && isDeepStrictEqual(graph["resolvedEdges"], []);
        const fallback = pewObservationSucceeded(augmentation.exitCode, augmentation.value) && augmentation.value["oracleSucceeded"] === true && record(augmentation.value["parallelism"])["mode"] === "preflight-fallback" && record(augmentation.value["parallelism"])["used"] === 1;
        if (index === 192) {
          add(definition.properties[0]!, safePass && exact, "Independent finite TS7 fixture emits two modules and excludes declaration context.");
          const mixed = await witnesses.parallel("mixed");
          evidence.push(...mixed.evidence);
          add(definition.properties[1]!, pewObservationSucceeded(mixed.exitCode, mixed.value) && mixed.value["oracleSucceeded"] === true && record(mixed.value["parallelism"])["mode"] === "preflight-fallback" && record(mixed.value["parallelism"])["used"] === 1, "Mixed JS activates single Program fallback against independent TS7 syntax control.");
        }
        else if (index === 195) add(definition.properties[0]!, graphPass && exact && safePass && fallback, "Declaration context remains loaded; emission filters declaration; augmentation changes preflight.");
        else if (index === 196) {
          const moduleAugmentation = await witnesses.parallel("module-augmentation");
          evidence.push(...moduleAugmentation.evidence);
          add(definition.properties[0]!, safePass && preflight["safe"] === true && fallback && pewObservationSucceeded(moduleAugmentation.exitCode, moduleAugmentation.value) && moduleAugmentation.value["oracleSucceeded"] === true && record(moduleAugmentation.value["parallelism"])["mode"] === "preflight-fallback" && record(moduleAugmentation.value["parallelism"])["used"] === 1, "Plain declaration interface permits parallel extraction; global and named module augmentation each refuse parallel dispatch.");
        }

      }
    const qualified = properties.length > 0 && properties.every(item => item.status === "pass");
    results.push({ index: definition.index, id: definition.id, status: qualified ? "qualified" : "not_qualified", reason: qualified ? "All named finite properties and activating controls passed in this platform run; aggregation still requires both platforms." : properties.filter(item => item.status !== "pass").map(item => item.property + ": " + item.reason).join("; "), properties, evidence: [...new Map(evidence.map(item => [item.path, item])).values()], durationMs: Math.round(performance.now() - started) });
  }
  return results;
}
