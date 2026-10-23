import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type Json = Record<string, unknown>;
export type Evidence = { path: string; sha256: string; bytes: number };
export type Property = { name: string; pass: boolean; expected: unknown; actual: unknown; oracle: string };
export type Observation = { index: number; properties: Property[]; evidence: Evidence[]; complete: boolean; reason: string };
export type Execution = { exitCode: number; stdout: string; stderr: string; value: Json; evidence: Evidence[] };
export type Context = {
  root: string; sdk: Json; sdk5?: Json; platform: "macos" | "linux"; producerSha256: string; helperSha256: string; helper: string;
  analysis(files: Record<string, string>, overrides?: Json): Json;
  run(label: string, mode: string, descriptor: Json, withSdk?: boolean, sdkOverride?: Json): Promise<Execution>;
  save(label: string, value: unknown): Promise<Evidence>;
  extractionOracle(label: string, request: Json): Promise<Execution>;
  applicationRuntime(label: string, request: Json, workers: number): Promise<Execution>;
  oracle(label: string, files: Record<string, string>, options?: Json): Promise<Execution>;
};

export async function asset(path: string): Promise<Evidence> {
  const bytes = await readFile(path);
  return { path, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length };
}

export async function checkAsset(value: Evidence): Promise<void> {
  if (!isAbsolute(value.path) || !/^[a-f0-9]{64}$/.test(value.sha256) || !Number.isSafeInteger(value.bytes) || value.bytes < 1) throw Error("invalid asset descriptor");
  const actual = await asset(value.path);
  if (actual.sha256 !== value.sha256 || actual.bytes !== value.bytes) throw Error(`artifact mismatch: ${value.path}`);
}

export function selectShard(indices: number[], shard = "1/1"): number[] {
  const match = /^([1-9]\d*)\/([1-9]\d*)$/.exec(shard);
  if (!match) throw Error("invalid shard; expected i/n, 1 <= i <= n");
  const part = Number(match[1]), total = Number(match[2]);
  if (!Number.isSafeInteger(total) || part > total) throw Error("invalid shard boundary");
  return indices.filter((_, position) => position % total === part - 1);
}

export function parseArguments(args: string[]): { candidate: string; platform: "macos" | "linux"; out: string; shard: string } {
  const flags = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index]!, value = args[index + 1];
    if (!["--candidate", "--platform", "--out", "--shard"].includes(flag) || flags.has(flag) || !value || value.startsWith("--")) throw Error(`invalid or duplicate argument: ${flag}`);
    flags.set(flag, value);
  }
  const candidate = flags.get("--candidate"), platform = flags.get("--platform"), out = flags.get("--out"), shard = flags.get("--shard") ?? "1/1";
  if (!candidate || !out || (platform !== "macos" && platform !== "linux")) throw Error("required: --candidate MANIFEST --platform macos|linux --out DIR [--shard i/n]");
  selectShard([], shard);
  return { candidate: resolve(candidate), platform, out: resolve(out), shard };
}

export function resultStatus(value: Observation, dryRun: boolean): "qualified" | "not_qualified" {
  return !dryRun && value.complete && value.properties.length > 0 && value.properties.every(property => property.pass) && value.evidence.length > 0 ? "qualified" : "not_qualified";
}

export async function sdkMatchesLibraries(sdk: Json, directory: string, inventoryPath: string): Promise<boolean> {
  const files = record(sdk.files);
  const inventory: unknown = JSON.parse(await readFile(inventoryPath, "utf8"));
  if (!Array.isArray(inventory)) return false;
  const expectedNames = inventory.map(item => descriptor(item).path).toSorted();
  const names = Object.keys(files).map(path => basename(path)).toSorted();
  if (expectedNames.length !== 115 || new Set(names).size !== 115 || JSON.stringify(names) !== JSON.stringify(expectedNames)) return false;
  for (const [path, text] of Object.entries(files)) {
    if (typeof text !== "string" || await readFile(join(directory, basename(path)), "utf8") !== text) return false;
  }
  return true;
}

export function record(value: unknown): Json {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw Error("expected JSON object");
  return value as Json;
}

export function isolatedEnvironment(root: string): Record<string, string | undefined> {
  return { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))), HOME: join(root, ".home"), XDG_CONFIG_HOME: join(root, ".config"), GIT_CONFIG_NOSYSTEM: "1" };
}

function descriptor(value: unknown): Evidence {
  const input = record(value);
  if (typeof input.path !== "string" || typeof input.sha256 !== "string" || typeof input.bytes !== "number") throw Error("invalid asset descriptor");
  return { path: input.path, sha256: input.sha256, bytes: input.bytes };
}

export type PlatformAssets = { producer: Evidence; helper: Evidence; observer: Evidence; sdk: Evidence; oracle: Evidence; oracleLibraries: Evidence; transportFixture?: Evidence; ts5Sdk?: Evidence; extractionOracle?: Evidence };
export type Candidate = { schemaVersion: 1; sourceCommit: string; dryRun: boolean; platforms: Partial<Record<"macos" | "linux", PlatformAssets>> };

export async function loadCandidate(path: string, platform: "macos" | "linux"): Promise<{ candidate: Candidate; assets: PlatformAssets }> {
  const input = record(JSON.parse(await readFile(path, "utf8")) as unknown);
  if (input.schemaVersion !== 1 || typeof input.sourceCommit !== "string" || !/^[a-f0-9]{40}$/.test(input.sourceCommit) || (input.dryRun !== undefined && typeof input.dryRun !== "boolean")) throw Error("invalid candidate schemaVersion/sourceCommit/dryRun");
  const selected = record(record(input.platforms)[platform]);
  const assets: PlatformAssets = { producer: descriptor(selected.producer), helper: descriptor(selected.helper), observer: descriptor(selected.observer), sdk: descriptor(selected.sdk), oracle: descriptor(selected.oracle), oracleLibraries: descriptor(selected.oracleLibraries), ...(selected.transportFixture === undefined ? {} : { transportFixture: descriptor(selected.transportFixture) }), ...(selected.ts5Sdk === undefined ? {} : { ts5Sdk: descriptor(selected.ts5Sdk) }), ...(selected.extractionOracle === undefined ? {} : { extractionOracle: descriptor(selected.extractionOracle) }) };
  const candidate: Candidate = { schemaVersion: 1, sourceCommit: input.sourceCommit, dryRun: input.dryRun === true, platforms: { [platform]: assets } };
  await verifyAssets(assets, platform);
  return { candidate, assets };
}

export async function verifyAssets(assets: PlatformAssets, platform: "macos" | "linux"): Promise<void> {
  for (const item of [assets.producer, assets.helper, assets.observer, assets.sdk, assets.oracle, assets.oracleLibraries]) await checkAsset(item);
  if (assets.transportFixture) await checkAsset(assets.transportFixture);
  if (assets.ts5Sdk) await checkAsset(assets.ts5Sdk);
  if (assets.extractionOracle) await checkAsset(assets.extractionOracle);
  const pins = record(JSON.parse(await readFile(new URL("../docs/research/rust-ts-r0/oracle-ts7.json", import.meta.url), "utf8")) as unknown);
  const pinnedBinary = descriptor(record(record(pins.platforms)[platform === "macos" ? "macosArm64" : "linuxAarch64"]).binary);
  const pinnedManifest = descriptor(record(pins.oracleSdk).manifest);
  if (pinnedBinary.sha256 !== assets.oracle.sha256 || pinnedBinary.bytes !== assets.oracle.bytes || pinnedManifest.sha256 !== assets.oracleLibraries.sha256 || pinnedManifest.bytes !== assets.oracleLibraries.bytes) throw Error("oracle differs from independent TS7 pin");
  const inventory: unknown = JSON.parse(await readFile(assets.oracleLibraries.path, "utf8"));
  if (!Array.isArray(inventory) || inventory.length !== 115) throw Error("TS7 oracle requires 115 libraries");
  const entries = inventory.map(descriptor);
  const names = entries.map(entry => entry.path).toSorted();
  const actualNames = (await readdir(dirname(assets.oracle.path))).filter(name => /^lib.*\.d\.ts$/.test(name)).toSorted();
  if (JSON.stringify(names) !== JSON.stringify(actualNames) || new Set(names).size !== 115) throw Error("oracle SDK inventory mismatch");
  for (const entry of entries) {
    if (basename(entry.path) !== entry.path) throw Error("invalid oracle library path");
    await checkAsset({ ...entry, path: join(dirname(assets.oracle.path), entry.path) });
  }
}

export async function createContext(out: string, platform: "macos" | "linux", assets: PlatformAssets, rehearsal = false): Promise<Context> {
  const root = join(out, "workspace");
  await mkdir(root, { recursive: true });
  const sdk = record(JSON.parse(await readFile(assets.sdk.path, "utf8")) as unknown);
  const sdk5 = assets.ts5Sdk ? record(JSON.parse(await readFile(assets.ts5Sdk.path, "utf8")) as unknown) : undefined;
  let sequence = 0;
  const location = (label: string): string => join(out, "raw", label.replace(/[^a-zA-Z0-9_.-]/g, "_"));
  const save = async (label: string, value: unknown): Promise<Evidence> => {
    const path = location(label + ".json");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(value, null, 2) + "\n");
    return asset(path);
  };
  const execute = async (label: string, argv: string[], cwd: string): Promise<Execution> => {
    const started = performance.now();
    const timeoutMs = rehearsal ? 300_000 : 60_000;
    const child = Bun.spawn(argv, { cwd, env: { ...isolatedEnvironment(root), GOPORT_LIB_PARSE_SNAPSHOT: "0", GOPORT_LIB_SNAPSHOT: "0", GOPORT_BUILD_VERSION: undefined }, stdout: "pipe", stderr: "pipe", timeout: timeoutMs });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    let value: Json;
    try { value = record(JSON.parse(stdout) as unknown); } catch { value = {}; }
    const execution = { argv, cwd, exitCode, stdout, stderr, durationMs: performance.now() - started, timeoutMs, signalCode: child.signalCode };
    return { exitCode, stdout, stderr, value, evidence: [await save(label + "-execution", execution)] };
  };
  return {
    root, sdk, ...(sdk5 === undefined ? {} : { sdk5 }), platform, producerSha256: assets.producer.sha256, helperSha256: assets.helper.sha256, helper: assets.helper.path, save,
    analysis(files, overrides = {}) {
      return { id: "q-boundary", cwd: root, sdk_directory: "/sdk/lib", case_sensitive: platform === "linux", roots: Object.keys(files).filter(path => /\.[cm]?[jt]sx?$/.test(path) && !/\.d\.[cm]?ts$/.test(path)).map(path => resolve(root, path)).toSorted(), files: Object.fromEntries(Object.entries(files).map(([path, text]) => [resolve(root, path), text])), options: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", allowJs: true, jsx: "Preserve", skipLibCheck: true, noEmit: true, strict: false }, retained: true, qualified: true, roles: {}, selection: {}, disabled: [], utf16_files: {}, raw_files: {}, ...overrides };
    },
    async run(label, mode, input, withSdk = false, sdkOverride) {
      await verifyAssets(assets, platform);
      const id = `${++sequence}-${label}`;
      const request = await save(id + "-request", input);
      const selectedSdk = sdkOverride ? await save(id + "-sdk", sdkOverride) : assets.sdk;
      const argv = mode === "verify" ? [assets.producer.path, "verify", "working-tree", request.path, selectedSdk.path, "--fail-on", "none"] : [assets.producer.path, ...(mode ? [mode] : []), request.path, ...(!mode || mode === "--batch" || withSdk ? [selectedSdk.path] : [])];
      const execution = await execute(id, argv, root);
      execution.evidence.push(request, selectedSdk);
      return execution;
    },
    async applicationRuntime(label, input, workers) {
      await verifyAssets(assets, platform);
      const id = `${++sequence}-application-${label}`;
      const request = await save(id + "-request", input);
      const script = await asset(fileURLToPath(new URL("./t00-ts7-application-runtime.ts", import.meta.url)));
      const result = await execute(id, [process.execPath, script.path, request.path, assets.sdk.path, assets.producer.path, assets.helper.path, String(workers)], root);
      await checkAsset(script);
      await verifyAssets(assets, platform);
      result.evidence.push(request, script, assets.sdk, assets.producer, assets.helper);
      return result;
    },
    async extractionOracle(label, input) {
      if (!assets.extractionOracle) throw Error("independent extraction oracle missing from candidate manifest");
      await verifyAssets(assets, platform);
      const id = `${++sequence}-extraction-oracle-${label}`;
      const request = await save(id + "-request", input);
      const result = await execute(id, [assets.extractionOracle.path, request.path, assets.sdk.path], root);
      result.evidence.push(request, assets.extractionOracle, assets.sdk);
      if (result.exitCode !== 0 || result.value.compilerVersion !== "7.1.0-dev" || result.value.revision !== "780dc512d64f40afebffa6a7028207649fb7ed1c" || result.value.sdkLibraries !== 115) throw Error(`independent extraction oracle failed: ${result.stderr}`);
      return result;
    },
    async oracle(label, files, options = {}) {
      await verifyAssets(assets, platform);
      const id = `${++sequence}-oracle-${label}`;
      const directory = join(out, "oracle-workspace", id);
      await mkdir(directory, { recursive: true });
      const evidence: Evidence[] = [];
      for (const [path, content] of Object.entries(files)) {
        const target = resolve(directory, path);
        if (!target.startsWith(directory + "/")) throw Error("oracle fixture escapes workspace");
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, content);
        evidence.push(await asset(target));
      }
      const { args, ...compilerOptions } = options;
      if (args !== undefined && (!Array.isArray(args) || !args.every(item => typeof item === "string"))) throw Error("oracle args must be strings");
      const config = join(directory, "tsconfig.json");
      await writeFile(config, JSON.stringify({ compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", skipLibCheck: true, ...compilerOptions }, files: Object.keys(files).filter(path => /\.[cm]?[jt]sx?$/.test(path)) }));
      evidence.push(await asset(config));
      const extra = args as string[] | undefined;
      const argv = extra?.includes("--version") ? [assets.oracle.path, "--version"] : [assets.oracle.path, "--noEmit", "--pretty", "false", "--project", config, ...(extra ?? [])];
      const result = await execute(id, argv, directory);
      result.evidence.push(...evidence);
      return result;
    },
  };
}
