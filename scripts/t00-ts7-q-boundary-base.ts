import { chmod, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { descriptor, outcome, prepare } from "./t00-ts7-q-boundary-admission";
import { asset, isolatedEnvironment, type Context, type Evidence, type Execution, type Json, type Property } from "./t00-ts7-q-boundary-common";

const oracle = "ADR 0035 accepted: otherwise-admitted removals require immutable HEAD old-scope admission under current policy; current rejection skips capture";
const record = (value: unknown): Json => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
const property = (name: string, expected: unknown, actual: unknown): Property => ({ name, expected, actual, pass: isDeepStrictEqual(expected, actual), oracle });

export function compareBaseCapture(label: string, status: "analyzed" | "unsupported" | "not_required", commit: string, execution: Execution): Property[] {
  const admission = record(execution.value["analysisAdmission"]), capture = record(execution.value["base_capture"]);
  const rejected = status === "unsupported", prefix = `base.${label}`;
  const reasons = admission["reasons"];
  return [
    property(`${prefix}.exit`, rejected ? 3 : 0, execution.exitCode),
    property(`${prefix}.admission`, rejected ? "rejected" : "admitted", admission["status"]),
    property(`${prefix}.verdict`, rejected ? "BLOCK" : "NOT_ASSERTED", execution.value["verdict"]),
    property(`${prefix}.capture`, status, capture["status"]),
    property(`${prefix}.global`, false, execution.value["global_admission_inferred"]),
    property(`${prefix}.reasons`, true, Array.isArray(reasons) && (rejected ? reasons.length === 1 && typeof reasons[0] === "string" && reasons[0].startsWith("QUALIFIED_WORKING_TREE_BASE_CAPTURE_UNSUPPORTED:") : reasons.length === 0)),
    ...(status === "analyzed" ? [property(`${prefix}.commit`, commit, capture["commit"]), property(`${prefix}.old-scope`, ["src/main.ts"], capture["expected"])] : []),
  ];
}

async function git(root: string, args: string[]): Promise<string> {
  const child = Bun.spawn(["git", ...args], { cwd: root, env: { ...isolatedEnvironment(root), GIT_AUTHOR_DATE: "2026-10-23T00:00:00Z", GIT_COMMITTER_DATE: "2026-10-23T00:00:00Z" }, stdout: "pipe", stderr: "pipe" });
  const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (exit !== 0) throw Error(`BASE_FIXTURE_GIT_FAILED:${JSON.stringify({ args, exit, stderr })}`);
  return stdout.trim();
}

const oldSupported = "export function main() { return 3; }\n";
const currentSupported = "export function main() { return 2; }\n";

export async function baseObservations(ctx: Context): Promise<{ properties: Property[]; evidence: Evidence[] }> {
  const properties: Property[] = [], evidence: Evidence[] = [];
  for (const scenario of [
    { id: "supported-removal", old: oldSupported, current: currentSupported, status: "analyzed" },
    { id: "old-computed", old: "export async function main(path: string) { return import(path); }\n", current: currentSupported, status: "unsupported" },
    { id: "old-excluded", old: "export { hidden as main } from '../hidden';\n", current: currentSupported, status: "unsupported" },
    { id: "post-receive-mutation", old: oldSupported, current: currentSupported, status: "unsupported" },
    { id: "pure-addition", old: oldSupported, current: oldSupported + "export const added = 1;\n", status: "not_required" },
  ] as const) {
    const files = { "src/main.ts": scenario.current, "hidden.ts": "export function hidden() { return 7; }\n" };
    const fixture = await prepare(ctx, `base-${scenario.id}`, files);
    const source = resolve(fixture.root, "src/main.ts");
    await writeFile(source, scenario.old);
    await git(fixture.root, ["add", "--", "src/main.ts"]);
    await git(fixture.root, ["-c", "user.name=T00Fixture", "-c", "user.email=t00@example.test", "commit", "-qm", "captured old scope"]);
    fixture.baseCommit = await git(fixture.root, ["rev-parse", "HEAD"]);
    await writeFile(source, scenario.current);
    const oldCompiler = await ctx.oracle(`base-${scenario.id}-old`, { ...files, "src/main.ts": scenario.old });
    const currentCompiler = await ctx.oracle(`base-${scenario.id}-current`, files);
    properties.push(property(`base.${scenario.id}.old-ts7`, 0, oldCompiler.exitCode), property(`base.${scenario.id}.current-ts7`, 0, currentCompiler.exitCode));
    const indexed = await ctx.run(`base-${scenario.id}-index`, "--batch", fixture.analysis, true);
    const request = descriptor(ctx, fixture, outcome(indexed));
    if (scenario.id === "post-receive-mutation") {
      const helper = resolve(ctx.root, "base-mutation-helper");
      const quoted = `'${ctx.helper.replaceAll("'", "'\"'\"'")}'`;
      await writeFile(helper, `#!/bin/sh\nif [ "$3" = --batch ]; then\n  ${quoted} "$@"\n  result=$?\n  printf '%s' 'export function main() { return 19; }' > src/main.ts\n  exit "$result"\nfi\nexec ${quoted} "$@"\n`);
      await chmod(helper, 0o755);
      request["processHelper"] = helper;
      evidence.push(await asset(helper));
    }
    const verified = await ctx.run(`base-${scenario.id}-verify`, "verify", request, true);
    properties.push(property(`base.${scenario.id}.index`, 0, indexed.exitCode), ...compareBaseCapture(scenario.id, scenario.status, fixture.baseCommit, verified));
    properties.push(property(`base.${scenario.id}.current-unchanged`, scenario.current, await readFile(source, "utf8")), property(`base.${scenario.id}.head-unchanged`, fixture.baseCommit, await git(fixture.root, ["rev-parse", "HEAD"])));
    if (scenario.id === "post-receive-mutation") properties.push(property("base.post-receive-mutation.activated", true, String(record(verified.value["base_capture"])["reason"]).includes("immutable base capture changed during analysis")));
    evidence.push(...fixture.evidence, ...oldCompiler.evidence, ...currentCompiler.evidence, ...indexed.evidence, ...verified.evidence, await ctx.save(`base-${scenario.id}-projection`, { old: scenario.old, current: scenario.current, baseCommit: fixture.baseCommit, contract: oracle, expected: scenario.status }));
  }
  return { properties, evidence };
}
