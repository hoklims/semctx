import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "../packages/core/node_modules/zod";

const phases = ["beforeAnalysis", "afterAnalysis", "afterGraphEdgesRemoved"] as const;
const reasonsSchema = z.array(z.string());
const phaseSchema = z.object({ executed: z.literal(true), unsupported: z.tuple([]), reasons: reasonsSchema });
const sourceSchema = z.object({ beforeAnalysis: reasonsSchema, afterAnalysis: reasonsSchema, afterGraphEdgesRemoved: reasonsSchema });
const nativeSchema = z.object({ executed: z.literal(true), unsupported: z.tuple([]), beforeAnalysis: phaseSchema, afterAnalysis: phaseSchema, afterGraphEdgesRemoved: phaseSchema });
const objectSchema = z.record(z.string(), z.unknown());
const fixtureIds = ["inline-call", "returned-value", "constant-return", "unknown-return"] as const;
export function compareOpaquePhases(source: unknown, native: unknown): { compared: number; pass: boolean; differences: string[] } {
  const expected = sourceSchema.safeParse(source);
  const actual = nativeSchema.safeParse(native);
  if (!expected.success || !actual.success) return { compared: 0, pass: false, differences: ["missing or incomplete ownership observation"] };
  const differences = phases.filter(phase => JSON.stringify([...expected.data[phase]].sort()) !== JSON.stringify([...actual.data[phase].reasons].sort()));
  return { compared: phases.length, pass: differences.length === 0, differences };
}
export function validateOpaqueCampaign(value: unknown): void {
  const units = z.array(z.object({ id: z.string(), phases: sourceSchema })).parse(value);
  if (JSON.stringify(units.map(unit => unit.id).sort()) !== JSON.stringify([...fixtureIds].sort())) throw new Error("EXACT_UNIQUE_OPAQUE_FIXTURE_SET_REQUIRED");
  const inline = units.find(unit => unit.id === "inline-call")!;
  const returned = units.find(unit => unit.id === "returned-value")!;
  const reason = "SOURCE_OPAQUE_CALLBACK_UNSUPPORTED";
  if (!inline.phases.beforeAnalysis.includes(reason) || inline.phases.afterAnalysis.includes(reason) || !inline.phases.afterGraphEdgesRemoved.includes(reason) || !phases.every(phase => returned.phases[phase].includes(reason))) throw new Error("OPAQUE_ACTIVATION_AND_VALUE_CONTROL_REQUIRED");
}

const digest = (bytes: string | Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const save = (path: string, value: unknown): void => writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
const load = (path: string): unknown => JSON.parse(readFileSync(path, "utf8")) as unknown;
const outcomeSchema = z.object({ kind: z.string(), exit_code: z.number().nullable(), stdout: z.string(), stderr: z.string(), stdout_bytes: z.number(), stderr_bytes: z.number(), stdout_hash: z.string(), stderr_hash: z.string(), duration_ms: z.number() });
type Outcome = z.infer<typeof outcomeSchema>;
const freezeSchema = z.object({ source_head: z.string(), artifact_path: z.string(), artifact_sha256: z.string(), helper_path: z.string(), helper_sha256: z.string(), sdk_path: z.string(), sdk_sha256: z.string() });
function invoke(argv: string[], cwd: string, timeout = 40_000): Outcome {
  const start = performance.now();
  const observed = Bun.spawnSync(argv, { cwd, env: { ...process.env, GOPORT_LIB_PARSE_SNAPSHOT: "0", GOPORT_LIB_SNAPSHOT: "0" }, stdout: "pipe", stderr: "pipe", timeout });
  const stdout = observed.stdout.toString(); const stderr = observed.stderr.toString();
  return { kind: observed.exitCode === 0 ? "success" : "nonzero", exit_code: observed.exitCode, duration_ms: Math.round(performance.now() - start), stdout, stderr, stdout_bytes: observed.stdout.length, stderr_bytes: observed.stderr.length, stdout_hash: digest(observed.stdout), stderr_hash: digest(observed.stderr) };
}
function parsed(outcome: Outcome): Record<string, unknown> | null {
  try { return objectSchema.parse(JSON.parse(outcome.stdout) as unknown); } catch { return null; }
}
function baselinePaths(baseline: string): Record<string, string[]> {
  const paths: Record<string, string[]> = {};
  const packageSchema = z.object({ name: z.string(), main: z.string().optional(), exports: z.record(z.string(), z.unknown()).optional() });
  for (const directory of readdirSync(join(baseline, "packages"))) {
    const root = join(baseline, "packages", directory);
    const metadata = packageSchema.parse(load(join(root, "package.json")));
    for (const [key, value] of Object.entries(metadata.exports ?? {})) if (typeof value === "string") paths[metadata.name + (key === "." ? "" : key.slice(1))] = [resolve(root, value)];
    paths[metadata.name] ??= [resolve(root, metadata.main ?? "src/index.ts")];
  }
  const dependencySchema = z.object({ name: z.string().optional(), version: z.string().optional(), module: z.string().optional(), main: z.string().optional() });
  const coreDependencies = z.object({ dependencies: z.record(z.string(), z.string()) }).parse(load(join(baseline, "packages/core/package.json"))).dependencies;
  const dependencyPaths = ["*/node_modules/*/package.json", "*/node_modules/@*/*/package.json"].flatMap(pattern => Array.from(new Bun.Glob(pattern).scanSync({ cwd: join(baseline, "node_modules/.bun"), absolute: true, followSymlinks: true })));
  for (const path of dependencyPaths) {
    const metadata = dependencySchema.parse(load(path));
    const entry = metadata.module ?? metadata.main;
    if (metadata.name && entry) paths[metadata.name] ??= [resolve(path, "..", entry)];
    if (metadata.name && entry && metadata.version && coreDependencies[metadata.name] && Bun.semver.satisfies(metadata.version, coreDependencies[metadata.name]!)) paths[metadata.name] = [resolve(path, "..", entry)];
  }
  return paths;
}
async function campaign(freezePath: string, baseline: string, output: string): Promise<void> {
  if (Bun.version !== "1.4.3") throw new Error("Bun 1.4.3 required");
  const freeze = freezeSchema.parse(load(freezePath));
  const verifyInputs = (): void => {
    for (const [path, hash] of [[freeze.artifact_path, freeze.artifact_sha256], [freeze.helper_path, freeze.helper_sha256], [freeze.sdk_path, freeze.sdk_sha256]]) if (digest(readFileSync(path!)) !== hash) throw new Error(`immutable input mismatch: ${path}`);
  };
  verifyInputs();
  mkdirSync(output, { recursive: false });
  const runnerInputs = ["t00-lot1-opaque.ts", "t00-lot1-opaque-oracle.ts"].map(path => { const bytes = readFileSync(resolve(import.meta.dir, path)); return { path, sha256: digest(bytes), bytes: bytes.length }; });
  save(join(output, "runner-source-manifest.json"), runnerInputs);
  const baselineCommit = "3e94997fcbefa72ad4d49b2cad180ee79b7c0a9b";
  const repository = resolve(import.meta.dir, "..");
  const inventory = invoke(["git", "ls-tree", "-r", "--name-only", baselineCommit, "--", "packages", "tsconfig.json", "tsconfig.base.json", "bun.lock", "package.json", "apps/cli/package.json"], repository);
  if (inventory.exit_code !== 0 || inventory.stdout.trim() === "") throw new Error("ORACLE_BASELINE_INVENTORY_MISSING");
  const verifyBaseline = (): { path: string; sha256: string; bytes: number }[] => inventory.stdout.trim().split("\n").map(path => {
    const expected = Bun.spawnSync(["git", "show", `${baselineCommit}:${path}`], { cwd: repository, stdout: "pipe", stderr: "pipe" });
    const bytes = readFileSync(resolve(baseline, path));
    if (expected.exitCode !== 0 || !Buffer.from(expected.stdout).equals(bytes)) throw new Error(`ORACLE_BASELINE_FILE_MISMATCH:${path}`);
    return { path, sha256: digest(bytes), bytes: bytes.length };
  });
  const baselineBefore = verifyBaseline();
  save(join(output, "baseline-source-manifest-before.json"), { baselineCommit, files: baselineBefore });
  const cases = [
    ["inline-call", "return register(() => helper());"],
    ["returned-value", "helper(); return register(() => helper);"],
    ["constant-return", "return register(() => 1);"],
    ["unknown-return", "const value = JSON.parse('1'); return register(() => value);"],
  ] as const;
  const units = [];
  for (const [id, body] of cases) {
    const directory = join(output, id); const root = join(directory, "workspace"); mkdirSync(join(root, "src"), { recursive: true });
    const files: Record<string, string> = { "src/main.ts": "export function main() { return 1; }\n", "package.json": '{"name":"lot1-opaque","dependencies":{"opaque":"1.0.0"}}', "tsconfig.json": '{"compilerOptions":{"module":"ESNext","moduleResolution":"Bundler"}}', ".gitignore": ".semctx/\n" };
    for (const [path, text] of Object.entries(files)) writeFileSync(join(root, path), text);
    const setup = [["init", "-q"], ["add", "."], ["-c", "user.name=T00", "-c", "user.email=t00@example.test", "commit", "-qm", "initial"]].map(args => invoke(["git", ...args], root));
    save(join(directory, "git-setup.json"), setup);
    if (setup.some(result => result.exit_code !== 0)) throw new Error(`fixture setup failed: ${id}`);
    const head = invoke(["git", "rev-parse", "HEAD"], root).stdout.trim();
    files["src/main.ts"] = `import { register } from 'opaque'; function helper() { return 1; } export function main() { ${body} }\n`;
    writeFileSync(join(root, "src/main.ts"), files["src/main.ts"]);
    const request = { id, cwd: root, case_sensitive: process.platform !== "darwin", files: Object.fromEntries(Object.entries(files).map(([path, text]) => [join(root, path), text])), roots: [join(root, "src/main.ts")], options: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", allowJs: true, jsx: "Preserve", skipLibCheck: true, noEmit: true, strict: false }, retained: true, qualified: true, sdk_directory: "/sdk/lib", roles: {}, selection: {}, disabled: [], utf16_files: {}, raw_files: {} };
    const requestPath = join(directory, "request.json"); save(requestPath, request);
    const raw = invoke([freeze.artifact_path, requestPath, freeze.sdk_path], root);
    save(join(directory, "raw-capture.json"), raw);
    const index = invoke([freeze.artifact_path, "--batch", requestPath, freeze.sdk_path], root);
    save(join(directory, "index-capture.json"), index);
    const descriptor = { repositoryRoot: root, processHelper: freeze.helper_path, include: ["src/**/*.ts"], exclude: ["node_modules", "dist", ".semctx", ".git", "coverage"], index: { analysis: request, outcome: index, baseCommit: head } };
    const descriptorPath = join(directory, "descriptor.json"); save(descriptorPath, descriptor);
    const native = invoke([freeze.artifact_path, "verify", "working-tree", descriptorPath, freeze.sdk_path, "--fail-on", "none"], root);
    save(join(directory, "native-capture.json"), native);
    const guards = [];
    if (id === "inline-call") for (const [name, replace] of [
      ["stdout-hash", { stdout_hash: "0".repeat(64) }], ["nonzero-process", { kind: "nonzero", exit_code: 9 }], ["cancelled-process", { kind: "cancelled", exit_code: null }], ["truncated-stdout", { stdout: index.stdout.slice(0, -3) }],
    ] as const) {
      const altered = structuredClone(descriptor); altered.index.outcome = outcomeSchema.parse({ ...index, ...replace });
      const path = join(directory, `descriptor-${name}.json`); save(path, altered);
      const capture = invoke([freeze.artifact_path, "verify", "working-tree", path, freeze.sdk_path, "--fail-on", "none"], root); save(join(directory, `guard-${name}.json`), capture);
      guards.push({ name, exit: capture.exit_code, stdout: capture.stdout, stderr: capture.stderr, rejected: capture.exit_code !== 0 });
    }
    units.push({ id, root, raw: parsed(raw), rawExit: raw.exit_code, index: parsed(index), indexExit: index.exit_code, native: parsed(native), nativeExit: native.exit_code, guards });
  }
  const oracleInput = join(output, "oracle-input.json"); save(oracleInput, { units: units.map(({ id, root }) => ({ id, root })) });
  const configPath = join(output, "oracle-tsconfig.json"); save(configPath, { extends: join(baseline, "tsconfig.json"), compilerOptions: { baseUrl: baseline, paths: baselinePaths(baseline) } });
  const oracleOutput = join(output, "oracle-output.json");
  const oracle = invoke([process.execPath, "--tsconfig-override", configPath, resolve(import.meta.dir, "t00-lot1-opaque-oracle.ts"), baseline, oracleInput, oracleOutput], baseline, 300_000);
  save(join(output, "oracle-capture.json"), oracle);
  if (oracle.exit_code !== 0) throw new Error(`oracle failed: ${oracle.stderr}`);
  const expected = z.object({ typescript: z.literal("5.9.3"), units: z.array(z.object({ id: z.string(), phases: sourceSchema, admission: z.unknown(), tokenGuards: z.unknown() })) }).parse(load(oracleOutput));
  validateOpaqueCampaign(expected.units);
  const baselineAfter = verifyBaseline();
  save(join(output, "baseline-source-manifest-after.json"), { baselineCommit, files: baselineAfter });
  if (JSON.stringify(baselineBefore) !== JSON.stringify(baselineAfter)) throw new Error("ORACLE_BASELINE_CHANGED_DURING_CAMPAIGN");
  const results = units.map(unit => {
    const source = expected.units.find(item => item.id === unit.id); if (!source) throw new Error(`oracle unit missing: ${unit.id}`);
    const subjects = z.array(objectSchema).parse(unit.raw?.subjects);
    const subject = subjects.find(item => item.path === "src/main.ts");
    const received = unit.index;
    const receiptRepresentation = { observedProcessExit: unit.indexExit, stdoutCapture: { path: join(output, unit.id, "index-capture.json"), sha256: digest(readFileSync(join(output, unit.id, "index-capture.json"))) }, producerArtifact: freeze.artifact_sha256, facts: received?.facts, bindings: received === null ? null : Object.fromEntries(Object.entries(received).filter(([key]) => key.endsWith("_id"))), publicReceiverObserved: unit.native?.indexed_extraction_received === true, nativeReceiptRepresentationExposed: false, nativePostIssuanceRevalidationObserved: false };
    save(join(output, unit.id, "independent-receipt-representation.json"), receiptRepresentation);
    return { id: unit.id, phases: compareOpaquePhases(source.phases, subject?.opaqueCallbackOwnership), sourceAdmission: source.admission, nativeAdmission: unit.native?.analysisAdmission ?? null, rawExit: unit.rawExit, indexExit: unit.indexExit, nativeExit: unit.nativeExit, guards: unit.guards, sourceTokenGuards: source.tokenGuards, independentReceiptRepresentation: { path: join(output, unit.id, "independent-receipt-representation.json"), sha256: digest(readFileSync(join(output, unit.id, "independent-receipt-representation.json"))) } };
  });
  verifyInputs();
  for (const input of runnerInputs) if (digest(readFileSync(resolve(import.meta.dir, input.path))) !== input.sha256) throw new Error(`RUNNER_CHANGED_DURING_CAMPAIGN:${input.path}`);
  const manifest = readdirSync(output, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile() && !entry.parentPath.includes("/workspace/") && !entry.parentPath.endsWith("/workspace")).map(entry => { const path = join(entry.parentPath, entry.name); const bytes = readFileSync(path); return { path, sha256: digest(bytes), bytes: bytes.length }; });
  save(join(output, "summary.json"), { schemaVersion: 1, environment: { platform: process.platform, arch: process.arch, bun: Bun.version }, candidate: freeze, oracle: { baselineCommit: "3e94997fcbefa72ad4d49b2cad180ee79b7c0a9b", typescript: expected.typescript, baselineSourceHash: digest(readFileSync(join(baseline, "packages/app-services/src/qualified-analysis.ts"))) }, obligations: [232, 234, 238], results, manifest, qualification: "not_qualified", reason: "Native public verification issues a receipt but neither exposes an independently checkable native receipt nor observes post-issuance receipt revalidation; controlled process mutations are partial evidence only.", formalR0ObligationQualified: false, allTargetQualified: false });
  process.stdout.write(JSON.stringify({ output, cases: results.length, phaseMatches: results.filter(row => row.phases.pass).length, qualification: "not_qualified" }) + "\n");
}
if (import.meta.main) {
  const [freeze, baseline, output] = process.argv.slice(2);
  if (!freeze || !baseline || !output) throw new Error("usage: t00-lot1-opaque.ts FREEZE_JSON BASELINE_ROOT OUTPUT_DIR");
  await campaign(resolve(freeze), resolve(baseline), resolve(output));
}
