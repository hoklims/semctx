import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { Database } from "bun:sqlite";
import { BRIDGE, CONSUMER_VERSIONS, createConsumer, ENTRY, LEAF, LEAF_SOURCE, put } from "./modelo-static-fixture";

type Observation = { command: string[]; code: number; stdout: string; stderr: string };
type Report = { verdict?: string; analysisAdmission?: unknown; impactedSymbols?: unknown; [key: string]: unknown };
function option(name: string, fallback: string): string { const position = process.argv.indexOf(name); return resolve(position < 0 ? fallback : process.argv[position + 1]!); }
const sourceRoot = option("--source-root", resolve(import.meta.dir, ".."));
const cli = option("--cli", join(sourceRoot, "apps/cli/dist/index.js"));
const mcp = option("--mcp", join(sourceRoot, "plugins/claude-code/dist/semctx-mcp.js"));
const pluginCli = option("--plugin-cli", join(sourceRoot, "plugins/claude-code/dist/semctx.js"));
const output = option("--output-dir", join(sourceRoot, ".omx/qualification/modelo-static"));
const legacyCli = process.argv.includes("--legacy-cli") ? option("--legacy-cli", cli) : null;
const regressionCli = process.argv.includes("--regression-cli") ? option("--regression-cli", cli) : null;
const directoryRegressionCli = process.argv.includes("--directory-regression-cli") ? option("--directory-regression-cli", cli) : null;
const auditWitnessesOnly = process.argv.includes("--audit-witnesses-only");
const directoryWitnessesOnly = process.argv.includes("--directory-witnesses-only");
assert(!(auditWitnessesOnly && directoryWitnessesOnly), "Choose one focused witness scope");
const observations: Record<string, unknown> = {};
const failures: string[] = [];
mkdirSync(output, { recursive: true });
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "public-fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "public-fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" };
function run(command: string[], cwd: string, timeout = 60_000): Observation {
  const result = Bun.spawnSync(command, { cwd, env: gitEnv, stdout: "pipe", stderr: "pipe", timeout });
  return { command, code: result.exitCode ?? 1, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}
function git(root: string, args: string[]): void { const result = run(["git", ...args], root); assert.equal(result.code, 0, result.stderr); }
function semctx(root: string, args: string[], bundle = cli): Observation { return run([process.execPath, bundle, ...args, "--root", root], root); }
function fixture(name: string, qualified = true, bundle = cli): string {
  const root = join(output, `consumer-${name}`);
  assert(!existsSync(root), `Refusing to overwrite existing consumer ${root}; choose a new --output-dir`);
  mkdirSync(root, { recursive: true }); createConsumer(root);
  git(root, ["init", "-q"]); git(root, ["add", "-A"]); git(root, ["commit", "-qm", "public fixture"]);
  const initialized = semctx(root, ["init"], bundle); assert.equal(initialized.code, 0, initialized.stderr);
  const configPath = join(root, ".semctx/config.json");
  const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
  if (qualified) Object.assign(config, { version: 2, selectionMode: "qualified-static-v1", analysisProfile: "modelo-suite-static-v1", languages: { typescript: "on", javascript: "on" }, include: ["suite/**/*"], exclude: ["**/node_modules/**", "**/.git/**", "**/.semctx/**"] });
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  git(root, ["add", "-A"]); git(root, ["commit", "-qm", "initialize public analysis policy"]);
  return root;
}
function typescriptAuditFixture(name: string, variant: "reexport" | "literal-import" | "inherited-nodenext", bundle: string): string {
  const root = join(output, `consumer-${name}`);
  assert(!existsSync(root), `Refusing to overwrite existing consumer ${root}`);
  mkdirSync(root, { recursive: true });
  put(root, ".gitignore", ".semctx/\n");
  put(root, "package.json", JSON.stringify({ name: "public-typescript-audit-consumer", private: true, type: "module" }));
  put(root, "src/main.ts", "export function main(input: number): number { return input + 1; }\n");
  put(root, "tsconfig.json", JSON.stringify({ extends: "./configs/base.json", include: ["src/**/*.ts", "hidden.ts"] }));
  const module = variant === "inherited-nodenext" ? "NodeNext" : "ESNext";
  const moduleResolution = variant === "inherited-nodenext" ? "NodeNext" : "Bundler";
  put(root, "configs/base.json", JSON.stringify({ compilerOptions: { strict: true, target: "ES2022", module, moduleResolution, noEmit: true } }));
  if (variant === "reexport") put(root, "hidden.ts", 'export { main } from "./src/main";\n');
  if (variant === "literal-import") put(root, "hidden.ts", 'export async function hidden() { return import("./src/main"); }\n');
  git(root, ["init", "-q"]); git(root, ["add", "-A"]); git(root, ["commit", "-qm", "public TypeScript audit fixture"]);
  const initialized = semctx(root, ["init"], bundle); assert.equal(initialized.code, 0, initialized.stderr);
  const configPath = join(root, ".semctx/config.json");
  const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
  Object.assign(config, { version: 2, selectionMode: "qualified-static-v1", analysisProfile: "modelo-suite-static-v1", languages: { typescript: "on", javascript: "on" }, include: ["**/*.ts"], exclude: ["hidden.ts", "**/node_modules/**", "**/.git/**", "**/.semctx/**"] });
  writeFileSync(configPath, JSON.stringify(config));
  git(root, ["add", "-A"]); git(root, ["commit", "-qm", "initialize qualified audit policy"]);
  const initial = semctx(root, ["index", "--json"], bundle); observations[`${name}:initial-index`] = initial;
  assert.equal(initial.code, 0, initial.stderr);
  put(root, "src/main.ts", "export function main(input: number): number { return input + 2; }\n");
  const refreshed = semctx(root, ["index", "--json"], bundle); observations[`${name}:refreshed-index`] = refreshed;
  assert.equal(refreshed.code, 0, refreshed.stderr);
  return root;
}
function report(result: Observation): Report { return JSON.parse(result.stdout) as Report; }
type DirectoryAdmission = {
  status: string;
  indexFreshness: { verdict: string };
  changeCoverage: { expected: string[]; analyzed: string[]; files: { path: string; status: string; reasons: string[] }[] };
};
const directoryPaths = ["tooling/build/hidden.ts", "dist/hidden.mjs"] as const;
function directoryFixture(name: string, hidden: typeof directoryPaths[number], selected: boolean, bundle: string): string {
  const root = join(output, `consumer-${name}`);
  assert(!existsSync(root), `Refusing to overwrite existing consumer ${root}`);
  mkdirSync(root, { recursive: true });
  put(root, ".gitignore", ".semctx/\nnode_modules/\n");
  put(root, "package.json", JSON.stringify({ name: "public-directory-witness", private: true, type: "module" }));
  put(root, "tsconfig.json", JSON.stringify({ compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", allowJs: true, noEmit: true }, include: ["src/**/*.ts", hidden] }));
  put(root, "src/main.ts", "export function main(input: number): number { return input + 1; }\n");
  put(root, hidden, hidden.endsWith(".ts") ? 'export { main } from "../../src/main";\n' : 'export { main } from "../src/main.ts";\n');
  git(root, ["init", "-q"]); git(root, ["add", "-A"]); git(root, ["commit", "-qm", "public tracked directory witness"]);
  const initialized = semctx(root, ["init"], bundle); assert.equal(initialized.code, 0, initialized.stderr);
  const configPath = join(root, ".semctx/config.json");
  const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
  Object.assign(config, { version: 2, selectionMode: "qualified-static-v1", analysisProfile: "modelo-suite-static-v1", languages: { typescript: "on", javascript: "on" }, include: selected ? ["src/**/*.ts", hidden] : ["src/**/*.ts"], exclude: ["**/node_modules/**", "**/.git/**", "**/.semctx/**"] });
  writeFileSync(configPath, JSON.stringify(config));
  git(root, ["add", "-A"]); git(root, ["commit", "-qm", "initialize qualified directory policy"]);
  const initial = semctx(root, ["index", "--json"], bundle); observations[`${name}:initial-index`] = initial; assert.equal(initial.code, 0, initial.stderr);
  put(root, "src/main.ts", "export function main(input: number): number { return input + 2; }\n");
  const refreshed = semctx(root, ["index", "--json"], bundle); observations[`${name}:refreshed-index`] = refreshed; assert.equal(refreshed.code, 0, refreshed.stderr);
  return root;
}
function directoryHealth(root: string, name: string, bundle: string): { freshness: { verdict: string }; candidates: { path: string; selectionDecision: string; analysisOutcome: string }[] } {
  const result = semctx(root, ["index-health", "--json"], bundle); observations[`${name}:health`] = result;
  assert([0, 2].includes(result.code), result.stderr);
  return JSON.parse(result.stdout) as ReturnType<typeof directoryHealth>;
}
function blocked(result: Observation): void {
  assert.notEqual(result.code, 0, "A gate must receive a nonzero exit when admission is refused");
  if (result.stdout.trim().startsWith("{")) {
    const rejected = report(result);
    if (rejected.verdict !== undefined) {
      assert.equal(rejected.verdict, "BLOCK", "Refusal must be represented by BLOCK");
      assert.equal((rejected.analysisAdmission as { status?: string } | undefined)?.status, "rejected", "Qualified refusal must retain explicit admission evidence");
    }
  }
}
async function scenario(name: string, action: () => void | Promise<void>): Promise<void> {
  if (auditWitnessesOnly && !name.startsWith("audit-")) return;
  if (directoryWitnessesOnly && !name.startsWith("directory-")) return;
  try { await action(); observations[`${name}:assertions`] = "passed"; }
  catch (error) { failures.push(name); observations[`${name}:assertions`] = { status: "failed", error: String(error) }; }
  writeFileSync(join(output, "qualification.json"), JSON.stringify({ profile: "modelo-suite-static-v1", sourceRoot, cli, mcp, pluginCli, runtime: { bun: Bun.version, consumerDeclared: CONSUMER_VERSIONS }, observations, failures }, null, 2));
}
function index(root: string, name: string): Observation { const result = semctx(root, ["index", "--json"]); observations[`${name}:index`] = result; return result; }
function verify(root: string, name: string, bundle = cli): Observation { const result = semctx(root, ["verify", "diff", "--format", "json"], bundle); observations[`${name}:verify`] = result; return result; }
function graph(root: string): { nodes: { id: string; name: string; file_path: string; exported: number }[]; edges: { kind: string; from_id: string; to_id: string }[] } {
  const db = new Database(join(root, ".semctx/semctx.db"), { readonly: true });
  try { return { nodes: db.query("SELECT id,name,file_path,exported FROM nodes").all() as ReturnType<typeof graph>["nodes"], edges: db.query("SELECT kind,from_id,to_id FROM edges").all() as ReturnType<typeof graph>["edges"] }; }
  finally { db.close(); }
}
function reachable(edges: ReturnType<typeof graph>["edges"], start: string, target: string): boolean {
  const seen = new Set<string>([start]); const queue = [start];
  for (const item of queue) for (const edge of edges) if (edge.to_id === item && !seen.has(edge.from_id)) { seen.add(edge.from_id); queue.push(edge.from_id); }
  return seen.has(target);
}
async function mcpVerify(root: string, label = "mixed"): Promise<Record<string, unknown>> {
  const child = Bun.spawn([process.execPath, mcp], { cwd: root, env: { ...gitEnv, SEMCTX_ROOT: root }, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const reader = child.stdout.getReader();
  let pending = "";
  const decoder = new TextDecoder();
  const stderr = new Response(child.stderr).text();
  async function request(id: number, method: string, params: unknown): Promise<Record<string, unknown>> {
    await child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`); await child.stdin.flush();
    while (true) {
      const lineEnd = pending.indexOf("\n");
      if (lineEnd >= 0) {
        const line = pending.slice(0, lineEnd); pending = pending.slice(lineEnd + 1);
        if (!line.trim()) continue;
        const response = JSON.parse(line) as { id?: number; result?: Record<string, unknown>; error?: unknown };
        if (response.id !== id) continue;
        assert(!response.error, JSON.stringify(response.error)); assert(response.result); return response.result;
      }
      const next = await reader.read(); assert(!next.done, "MCP process ended before responding"); pending += decoder.decode(next.value, { stream: true });
    }
  }
  const timeout = setTimeout(() => child.kill(), 30_000);
  try {
    const initialize = await request(1, "initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "public-consumer-qualification", version: "1" } });
    observations[`${label}:mcp-initialize`] = initialize;
    await child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`); await child.stdin.flush();
    return await request(2, "tools/call", { name: "semctx_verify_change", arguments: { repositoryRoot: root } });
  } finally { clearTimeout(timeout); child.kill(); await child.exited; observations[`${label}:mcp-stderr`] = await stderr; reader.releaseLock(); }
}

if (legacyCli) await scenario("legacy-incident", () => {
  const root = fixture("legacy", false, legacyCli);
  observations["legacy:index"] = semctx(root, ["index", "--json"], legacyCli);
  put(root, LEAF, LEAF_SOURCE.replace("+ 1", "+ 7"));
  const health = semctx(root, ["index-health", "--json"], legacyCli); observations["legacy:health"] = health;
  assert.equal((JSON.parse(health.stdout) as { freshness: { verdict: string } }).freshness.verdict, "STALE");
  const result = verify(root, "legacy", legacyCli);
  assert.equal(report(result).verdict, "PASS", "Legacy witness must reproduce the false positive, not merely predict it");
  assert(!graph(root).nodes.some((node) => node.file_path === LEAF && node.name === "value"));
});
if (legacyCli) await scenario("legacy-refuses-qualified-config", () => {
  const root = fixture("legacy-qualified-policy", true, legacyCli);
  put(root, LEAF, LEAF_SOURCE.replace("+ 1", "+ 7"));
  const legacyIndex = semctx(root, ["index", "--json"], legacyCli);
  observations["legacy-qualified-policy:index"] = legacyIndex;
  assert.notEqual(legacyIndex.code, 0, "Legacy indexing must refuse the unsupported qualified selection mode");
  blocked(verify(root, "legacy-qualified-policy", legacyCli));
});
if (legacyCli) await scenario("legacy-before-matrix", () => {
  const root = fixture("legacy-before-matrix", false, legacyCli);
  const initialIndex = semctx(root, ["index", "--json"], legacyCli);
  observations["legacy-before-matrix:index"] = initialIndex;
  assert.equal(initialIndex.code, 0, initialIndex.stderr);
  const configPath = join(root, ".semctx/config.json");
  const originalConfig = readFileSync(configPath, "utf8");
  const added = "suite/tooling/check/legacy-added.mjs";
  const renamed = LEAF.replace("value.mjs", "renamed.mjs");
  const matrix: Record<string, unknown> = {};
  observations["legacy-before-matrix:observations"] = matrix;
  for (const variant of ["edit", "add", "delete", "rename", "parse", "dynamic", "commonjs", "partial-language", "empty-selection", "wrong-root"] as const) {
    let analyzedRoot = root;
    if (variant === "edit") put(root, LEAF, LEAF_SOURCE.replace("+ 1", "+ 4"));
    if (variant === "add") { put(root, added, "export function added() { return 4; }\n"); git(root, ["add", added]); }
    if (variant === "delete") rmSync(join(root, LEAF));
    if (variant === "rename") { renameSync(join(root, LEAF), join(root, renamed)); git(root, ["add", LEAF, renamed]); }
    if (variant === "parse") put(root, LEAF, "export function value( {\n");
    if (variant === "dynamic") put(root, LEAF, "export async function value(name) { return import(name); }\n");
    if (variant === "commonjs") { put(root, "suite/tooling/check/legacy.cjs", "module.exports = function check(input) { return input; };\n"); git(root, ["add", "suite/tooling/check/legacy.cjs"]); }
    if (variant === "partial-language" || variant === "empty-selection") {
      const config = JSON.parse(originalConfig) as Record<string, unknown>;
      Object.assign(config, { version: 2, selectionMode: "globs-v1", languages: { typescript: "on", javascript: "off" }, include: variant === "empty-selection" ? ["absent/**/*.ts"] : ["suite/**/*"] });
      writeFileSync(configPath, JSON.stringify(config)); put(root, LEAF, LEAF_SOURCE.replace("+ 1", "+ 4"));
    }
    if (variant === "wrong-root") { analyzedRoot = join(root, "suite/apps/web"); put(root, LEAF, LEAF_SOURCE.replace("+ 1", "+ 4")); }
    // Parsing/unsupported/selection cases also rebuild: distinguish an omitted file
    // from stale state rather than assuming all old failures had the same cause.
    const refreshed = ["parse", "dynamic", "commonjs", "partial-language", "empty-selection"].includes(variant)
      ? semctx(root, ["index", "--json"], legacyCli) : null;
    const health = semctx(analyzedRoot, ["index-health", "--json"], legacyCli);
    const verified = semctx(analyzedRoot, ["verify", "diff", "--format", "json"], legacyCli);
    matrix[variant] = { refreshed, health, verify: verified, extractedLeaf: graph(root).nodes.filter((node) => node.file_path === LEAF) };
    // Reset only this generated fixture's concrete mutations. Keep every raw
    // result; old refusals are observations, not historical false positives.
    git(root, ["reset", "HEAD", "--", LEAF, added, renamed, "suite/tooling/check/legacy.cjs"]);
    for (const path of [added, renamed, "suite/tooling/check/legacy.cjs"]) rmSync(join(root, path), { force: true });
    put(root, LEAF, LEAF_SOURCE); writeFileSync(configPath, originalConfig);
    if (refreshed) {
      const restored = semctx(root, ["index", "--json"], legacyCli);
      matrix[`${variant}:restored-index`] = restored; assert.equal(restored.code, 0, restored.stderr);
    }
  }
  observations["legacy-before-matrix:interruption"] = "NO_ATTESTED_LEGACY_PROCESS_INTERRUPTION; see actual candidate process interruption witness separately";
});

for (const variant of ["reexport", "literal-import", "inherited-nodenext"] as const) {
  if (regressionCli) await scenario(`audit-before-${variant}`, () => {
    const label = `audit-before-${variant}`;
    const root = typescriptAuditFixture(label, variant, regressionCli);
    const result = verify(root, label, regressionCli);
    const before = report(result);
    assert.equal(result.code, 0, "The actual pre-fix package must reproduce the admitted result");
    assert.equal((before.analysisAdmission as { status: string }).status, "admitted");
    observations[`${label}:health`] = semctx(root, ["index-health", "--json"], regressionCli);
  });
  await scenario(`audit-after-${variant}`, () => {
    const label = `audit-after-${variant}`;
    const root = typescriptAuditFixture(label, variant, cli);
    const result = verify(root, label); blocked(result);
    const admission = report(result).analysisAdmission as { changeCoverage: { expected: string[]; files: { path: string; status: string; reasons: string[] }[] } };
    if (variant === "inherited-nodenext") {
      const serialized = JSON.stringify(admission);
      assert(serialized.includes("SOURCE_CONFIGURATION_MODULE_UNSUPPORTED:NodeNext"), "Inherited module mode must have an explicit diagnostic");
      assert(serialized.includes("SOURCE_CONFIGURATION_RESOLUTION_UNSUPPORTED:NodeNext"), "Inherited module resolution must have an explicit diagnostic");
    } else {
      assert(admission.changeCoverage.expected.includes("hidden.ts"), "Excluded transitive importer must remain an obligation");
      const hidden = admission.changeCoverage.files.find((file) => file.path === "hidden.ts");
      assert(hidden); assert.equal(hidden.status, "excluded"); assert(hidden.reasons.length > 0, "Excluded required importer must retain its reason");
    }
  });
}

for (const hidden of directoryPaths) {
  const directory = hidden.endsWith(".ts") ? "build-ts" : "dist-mjs";
  for (const selected of [false, true]) {
    if (directoryRegressionCli) await scenario(`directory-before-${directory}-${selected ? "selected" : "excluded"}`, () => {
      const label = `directory-before-${directory}-${selected ? "selected" : "excluded"}`;
      const root = directoryFixture(label, hidden, selected, directoryRegressionCli);
      const result = verify(root, label, directoryRegressionCli);
      const admission = report(result).analysisAdmission as DirectoryAdmission;
      assert.equal(result.code, 0, "Actual package 52 must reproduce false admission"); assert.equal(admission.status, "admitted");
      assert(!admission.changeCoverage.expected.includes(hidden), "Before-fix closure must omit the tracked importer");
      const health = directoryHealth(root, label, directoryRegressionCli);
      assert(!health.candidates.some((candidate) => candidate.path === hidden), "Before-fix discovery must omit the tracked importer");
      const stored = graph(root); observations[`${label}:graph`] = stored;
      assert(!stored.nodes.some((node) => node.file_path === hidden), "Before-fix graph must omit the tracked importer");
      // Preserve the old package's existing Git-diff freshness protection separately from the missing closure.
      put(root, hidden, readFileSync(join(root, hidden), "utf8") + "// actual post-index drift\n");
      const drift = verify(root, `${label}-inventory-drift`, directoryRegressionCli);
      assert.equal(drift.code, 3); blocked(drift);
      assert.equal((report(drift).analysisAdmission as DirectoryAdmission).indexFreshness.verdict, "STALE");
    });
    await scenario(`directory-after-${directory}-${selected ? "selected" : "excluded"}`, () => {
      const label = `directory-after-${directory}-${selected ? "selected" : "excluded"}`;
      const root = directoryFixture(label, hidden, selected, cli);
      const result = verify(root, label);
      const admission = report(result).analysisAdmission as DirectoryAdmission;
      assert(admission.changeCoverage.expected.includes(hidden), "Tracked transitive importer must remain a coverage obligation");
      const health = directoryHealth(root, label, cli);
      const candidate = health.candidates.find((item) => item.path === hidden);
      assert(candidate, "Tracked directory importer must persist in discovery");
      const stored = graph(root); observations[`${label}:graph`] = stored;
      if (!selected) {
        assert.equal(result.code, 3, "Excluded required importer must refuse with the actual CLI admission exit"); blocked(result);
        const obligation = admission.changeCoverage.files.find((file) => file.path === hidden);
        assert(obligation); assert.equal(obligation.status, "excluded"); assert(obligation.reasons.length > 0);
        assert.equal(candidate.selectionDecision, "excluded");
      } else {
        assert.equal(result.code, 0); assert.equal(admission.status, "admitted");
        for (const path of ["src/main.ts", hidden]) assert(admission.changeCoverage.analyzed.includes(path), `Selected source ${path} must actually be analyzed`);
        assert.equal(health.freshness.verdict, "DIRTY_KNOWN");
        for (const path of ["src/main.ts", hidden]) assert(health.candidates.some((candidate) => candidate.path === path && candidate.selectionDecision === "selected" && candidate.analysisOutcome === "analyzed"), `Fresh persisted discovery must retain analyzed source ${path}`);
        assert(stored.nodes.some((node) => node.file_path === hidden), "Selected importer must persist in the graph");
      }
    });
  }
  await scenario(`directory-after-${directory}-inventory-drift`, () => {
    const label = `directory-after-${directory}-inventory-drift`;
    const root = directoryFixture(label, hidden, true, cli);
    const before = verify(root, `${label}-fresh`); assert.equal(before.code, 0);
    put(root, hidden, readFileSync(join(root, hidden), "utf8") + "// actual post-index drift\n");
    const drift = verify(root, label); assert.equal(drift.code, 3); blocked(drift);
    assert.equal((report(drift).analysisAdmission as DirectoryAdmission).indexFreshness.verdict, "STALE", "Tracked output-path drift must invalidate the input snapshot");
  });
}

await scenario("mixed-transitive-analysis", async () => {
  const root = fixture("mixed");
  const install = run([process.execPath, "x", `pnpm@${CONSUMER_VERSIONS.pnpm}`, "install", "--ignore-scripts"], join(root, "suite"), 180_000);
  observations["consumer:install"] = install; assert.equal(install.code, 0, install.stderr);
  for (const tool of ["pnpm", "turbo", "tsc", "vitest"] as const) {
    const command = [process.execPath, "x", `pnpm@${CONSUMER_VERSIONS.pnpm}`, ...(tool === "pnpm" ? [] : ["exec", tool]), "--version"];
    const version = run(command, join(root, "suite")); observations[`consumer:${tool}-version`] = version;
    assert.equal(version.code, 0); assert(version.stdout.includes(CONSUMER_VERSIONS[tool === "tsc" ? "typescript" : tool]));
  }
  const typecheck = run([process.execPath, "x", `pnpm@${CONSUMER_VERSIONS.pnpm}`, "exec", "tsc", "--noEmit", "--project", "tsconfig.json"], join(root, "suite"));
  observations["consumer:typecheck"] = typecheck; assert.equal(typecheck.code, 0, typecheck.stdout + typecheck.stderr);
  const test = run([process.execPath, "x", `pnpm@${CONSUMER_VERSIONS.pnpm}`, "exec", "vitest", "run"], join(root, "suite"));
  observations["consumer:tests"] = test; assert.equal(test.code, 0, test.stderr); assert(/1 passed/.test(test.stdout));
  for (const attempt of ["miss", "hit"] as const) {
    const build = run([process.execPath, "x", `pnpm@${CONSUMER_VERSIONS.pnpm}`, "exec", "turbo", "run", "build", "--filter=@public/apps-web", "--output-logs=full"], join(root, "suite"));
    observations[`consumer:turbo-${attempt}`] = build; assert.equal(build.code, 0, build.stderr); assert(build.stdout.includes(`cache ${attempt}`));
  }
  put(root, LEAF, LEAF_SOURCE.replace("+ 1", "+ 9"));
  const failedTest = run([process.execPath, "x", `pnpm@${CONSUMER_VERSIONS.pnpm}`, "exec", "vitest", "run"], join(root, "suite"));
  observations["consumer:failed-test"] = failedTest; assert.notEqual(failedTest.code, 0); assert(failedTest.stdout.includes("1 failed"));
  const failedBuild = run([process.execPath, "x", `pnpm@${CONSUMER_VERSIONS.pnpm}`, "exec", "turbo", "run", "build", "--filter=@public/apps-web", "--output-logs=full"], join(root, "suite"));
  observations["consumer:failed-build"] = failedBuild; assert.notEqual(failedBuild.code, 0); assert((failedBuild.stdout + failedBuild.stderr).includes("synthetic build failure"));
  put(root, LEAF, LEAF_SOURCE);
  git(root, ["add", "suite/pnpm-lock.yaml"]); git(root, ["commit", "-qm", "lock synthetic consumer dependencies"]);
  assert.equal(index(root, "mixed").code, 0);
  put(root, LEAF, LEAF_SOURCE.replace("+ 1", "+ 2"));
  blocked(verify(root, "mixed-before-refresh"));
  blocked(verify(root, "mixed-plugin-before-refresh", pluginCli));
  const rejectedMcp = await mcpVerify(root, "mixed-before-refresh"); observations["mixed-before-refresh:mcp"] = rejectedMcp;
  const rejectedStructured = rejectedMcp.structuredContent as Report | undefined;
  assert(rejectedStructured); assert.equal(rejectedStructured.verdict, "BLOCK");
  assert.equal((rejectedStructured.analysisAdmission as { status: string }).status, "rejected");
  assert.equal(index(root, "mixed-refreshed").code, 0);
  const extracted = graph(root); observations["mixed:graph"] = extracted;
  const value = extracted.nodes.find((node) => node.file_path === LEAF && node.name === "value");
  const bridge = extracted.nodes.find((node) => node.file_path === BRIDGE && node.name === "bridge");
  const entry = extracted.nodes.find((node) => node.file_path === ENTRY && node.name === "entry");
  assert(value?.exported); assert(bridge); assert(entry);
  assert(reachable(extracted.edges.filter((edge) => edge.kind === "calls"), value.id, entry.id), "JS -> TS -> JS call graph must reach the transitive consumer");
  assert(extracted.edges.some((edge) => edge.kind === "imports"), "Imports must actually be extracted");
  const result = verify(root, "mixed-refreshed");
  const verified = report(result);
  const admission = verified.analysisAdmission as { status: string; changeCoverage: { expected: string[]; analyzed: string[] } } | undefined;
  assert(admission, "Qualified results must include explicit admission evidence");
  assert.equal(admission.status, "admitted");
  assert(admission.changeCoverage.expected.includes(LEAF));
  for (const path of admission.changeCoverage.expected) assert(admission.changeCoverage.analyzed.includes(path), `Expected file ${path} must actually be analyzed`);
  assert.notEqual(verified.verdict, "BLOCK", "Fully analyzed supported change must be admissible");
  const impact = semctx(root, ["impact", "diff", "--format", "json"]); observations["mixed:impact"] = impact;
  assert.equal(impact.code, 0);
  const impacted = JSON.parse(impact.stdout) as { directlyAffected: { id: string }[]; transitivelyAffected: { id: string }[] };
  assert(impacted.directlyAffected.some((node) => node.id === bridge.id), "Impact must classify the direct TS consumer");
  assert(impacted.transitivelyAffected.some((node) => node.id === entry.id), "Impact must classify the transitive JS consumer");
  const plugin = verify(root, "mixed-plugin", pluginCli);
  assert.equal(report(plugin).verdict, verified.verdict);
  assert.deepEqual(report(plugin).analysisAdmission, verified.analysisAdmission);
    const response = await mcpVerify(root);
    observations["mixed:mcp"] = response;
    const structured = response.structuredContent as Report | undefined;
    assert(structured); assert.equal(structured.verdict, verified.verdict); assert.deepEqual(structured.analysisAdmission, verified.analysisAdmission);
});

for (const mutation of ["add", "edit", "delete", "rename"] as const) await scenario(`stale-${mutation}`, () => {
  const root = fixture(mutation); assert.equal(index(root, mutation).code, 0);
  if (mutation === "add") { put(root, "suite/tooling/check/added.mjs", "export function added() { return 1; }\n"); git(root, ["add", "suite/tooling/check/added.mjs"]); }
  if (mutation === "edit") put(root, LEAF, LEAF_SOURCE.replace("+ 1", "+ 3"));
  if (mutation === "delete") rmSync(join(root, LEAF));
  if (mutation === "rename") { renameSync(join(root, LEAF), join(root, LEAF.replace("value.mjs", "renamed.mjs"))); git(root, ["add", "-A"]); }
  blocked(verify(root, mutation));
});
for (const broken of ["parse", "dynamic", "commonjs", "empty-selection", "partial-language"] as const) await scenario(broken, () => {
  const root = fixture(broken);
  if (broken === "parse") put(root, LEAF, "export function value( {\n");
  if (broken === "dynamic") put(root, LEAF, "export async function value(name) { return import(name); }\n");
  if (broken === "commonjs") { put(root, "suite/tooling/check/check.cjs", "module.exports = function check(input) { return input; };\n"); git(root, ["add", "suite/tooling/check/check.cjs"]); }
  if (broken === "empty-selection" || broken === "partial-language") {
    const path = join(root, ".semctx/config.json"); const config = JSON.parse(readFileSync(path, "utf8")) as { include: string[]; languages: Record<string, string> };
    if (broken === "empty-selection") config.include = ["missing/**/*.ts"];
    else config.languages.javascript = "off";
    writeFileSync(path, JSON.stringify(config)); put(root, LEAF, LEAF_SOURCE.replace("+ 1", "+ 5"));
  }
  index(root, broken); blocked(verify(root, broken));
});
await scenario("wrong-root", () => {
  const root = fixture("wrong-root"); assert.equal(index(root, "wrong-root").code, 0); put(root, LEAF, LEAF_SOURCE.replace("+ 1", "+ 6"));
  blocked(verify(join(root, "suite/apps/web"), "wrong-root"));
});
await scenario("interrupted-index", async () => {
  const root = fixture("interrupted"); assert.equal(index(root, "interrupted-before").code, 0);
  put(root, LEAF, LEAF_SOURCE.replace("+ 1", "+ 8"));
  for (let file = 0; file < 128; file++) put(root, `suite/platform/shared/pending-${file}.ts`, Array.from({ length: 32 }, (_, item) => `export function pending${item}(input: number) { return input + ${item}; }`).join("\n"));
  git(root, ["add", "suite/platform/shared"]);
  const child = Bun.spawn([process.execPath, cli, "index", "--root", root], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const stdout = new Response(child.stdout).text(); const stderr = new Response(child.stderr).text();
  let observedIncomplete = false;
  try {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && child.exitCode === null) {
      let db: Database | undefined;
      try {
        db = new Database(join(root, ".semctx/semctx.db"), { readonly: true });
        observedIncomplete = (db.query("SELECT value FROM meta WHERE key = 'qualified_analysis_build_v1'").get() as { value: string } | null)?.value === "incomplete";
      } catch (error) {
        // The real writer briefly owns SQLite's lock. Only this transient error
        // is retried; admission still requires observing its persisted marker.
        if (!(error instanceof Error && error.message === "database is locked")) throw error;
      } finally { db?.close(); }
      if (observedIncomplete) break;
      await new Promise<void>((done) => setTimeout(done, 10));
    }
  } finally { child.kill(); await child.exited; }
  observations["interrupted:process"] = { code: child.exitCode, observedIncomplete, stdout: await stdout, stderr: await stderr };
  assert(observedIncomplete, "Must observe the actual rebuild marker before interrupting the process");
  assert.notEqual(child.exitCode, 0); blocked(verify(root, "interrupted"));
});
await scenario(directoryWitnessesOnly ? "directory-artifact-identities" : "artifact-identities", () => {
  const artifacts = directoryWitnessesOnly ? [cli, ...(directoryRegressionCli ? [directoryRegressionCli] : [])] : [cli, mcp, pluginCli, ...(regressionCli ? [regressionCli] : []), ...(directoryRegressionCli ? [directoryRegressionCli] : [])];
  observations["artifacts"] = [...new Set(artifacts)].map((path) => ({ path, sha256: createHash("sha256").update(readFileSync(path)).digest("hex") }));
  observations["source-commit"] = run(["git", "rev-parse", "HEAD"], sourceRoot);
  observations["source-status"] = run(["git", "status", "--porcelain"], sourceRoot);
});
observations["runtime-obligations"] = { testExecution: observations["consumer:tests"] ? "SEE_RAW_OBSERVATION" : "NOT_OBSERVED", turboCache: observations["consumer:turbo-hit"] ? "SEE_RAW_OBSERVATION" : "NOT_OBSERVED", failurePropagation: observations["consumer:failed-build"] ? "SEE_RAW_OBSERVATION" : "NOT_OBSERVED", pipeline: "SYNTHETIC_ONLY_REAL_CONSUMER_NOT_QUALIFIED", consumerToolPins: observations["consumer:install"] ? "SEE_RAW_OBSERVATION" : "DECLARED_ONLY" };
const focused = auditWitnessesOnly || directoryWitnessesOnly;
const directoryWitnessObserved = directoryRegressionCli !== null && !auditWitnessesOnly;
writeFileSync(join(output, "qualification.json"), JSON.stringify({ profile: "modelo-suite-static-v1", sourceRoot, cli, runtime: { bun: Bun.version, consumerDeclared: CONSUMER_VERSIONS }, scope: directoryWitnessesOnly ? "directory-witnesses-only" : auditWitnessesOnly ? "audit-witnesses-only" : "complete", qualified: !focused && failures.length === 0 && legacyCli !== null && regressionCli !== null && directoryWitnessObserved, legacyWitnessObserved: !focused && legacyCli !== null, regressionWitnessObserved: !directoryWitnessesOnly && regressionCli !== null, directoryWitnessObserved, failures, observations }, null, 2));
console.log(JSON.stringify({ profile: "modelo-suite-static-v1", failures, report: join(output, "qualification.json") }));
process.exitCode = failures.length === 0 && (directoryWitnessesOnly ? directoryWitnessObserved : regressionCli !== null && (auditWitnessesOnly || (legacyCli !== null && directoryWitnessObserved))) ? 0 : 1;
