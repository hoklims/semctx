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
  if (qualified) Object.assign(config, { version: 2, selectionMode: "globs-v1", analysisProfile: "modelo-suite-static-v1", languages: { typescript: "on", javascript: "on" }, include: ["suite/**/*"], exclude: ["**/node_modules/**", "**/.git/**", "**/.semctx/**"] });
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  git(root, ["add", "-A"]); git(root, ["commit", "-qm", "initialize public analysis policy"]);
  return root;
}
function report(result: Observation): Report { return JSON.parse(result.stdout) as Report; }
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
      const db = new Database(join(root, ".semctx/semctx.db"), { readonly: true });
      try { observedIncomplete = (db.query("SELECT value FROM meta WHERE key = 'qualified_analysis_build_v1'").get() as { value: string } | null)?.value === "incomplete"; }
      finally { db.close(); }
      if (observedIncomplete) break;
      await new Promise<void>((done) => setTimeout(done, 10));
    }
  } finally { child.kill(); await child.exited; }
  observations["interrupted:process"] = { code: child.exitCode, observedIncomplete, stdout: await stdout, stderr: await stderr };
  assert(observedIncomplete, "Must observe the actual rebuild marker before interrupting the process");
  assert.notEqual(child.exitCode, 0); blocked(verify(root, "interrupted"));
});
await scenario("artifact-identities", () => {
  observations["artifacts"] = [cli, mcp, pluginCli].map((path) => ({ path, sha256: createHash("sha256").update(readFileSync(path)).digest("hex") }));
  observations["source-commit"] = run(["git", "rev-parse", "HEAD"], sourceRoot);
  observations["source-status"] = run(["git", "status", "--porcelain"], sourceRoot);
});
observations["runtime-obligations"] = { testExecution: observations["consumer:tests"] ? "SEE_RAW_OBSERVATION" : "NOT_OBSERVED", turboCache: observations["consumer:turbo-hit"] ? "SEE_RAW_OBSERVATION" : "NOT_OBSERVED", failurePropagation: observations["consumer:failed-build"] ? "SEE_RAW_OBSERVATION" : "NOT_OBSERVED", pipeline: "SYNTHETIC_ONLY_REAL_CONSUMER_NOT_QUALIFIED", consumerToolPins: observations["consumer:install"] ? "SEE_RAW_OBSERVATION" : "DECLARED_ONLY" };
writeFileSync(join(output, "qualification.json"), JSON.stringify({ profile: "modelo-suite-static-v1", qualified: failures.length === 0 && legacyCli !== null, legacyWitnessObserved: legacyCli !== null, failures, observations }, null, 2));
console.log(JSON.stringify({ profile: "modelo-suite-static-v1", failures, report: join(output, "qualification.json") }));
process.exitCode = failures.length === 0 && legacyCli !== null ? 0 : 1;
