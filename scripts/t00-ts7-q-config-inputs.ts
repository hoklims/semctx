import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, realpath, stat, symlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { CampaignContext, Evidence, PropertyResult } from "./t00-ts7-q-config-campaign";

export type InputMap = Record<string, string | null>;

export function completeInputsMatch(observed: unknown, expected: InputMap): boolean {
  return isDeepStrictEqual(observed, expected);
}

const rootManifest = '{"workspaces":["Packages/*"],"dependencies":{"Pkg":"workspace:*"}}';
const memberManifest = '{"name":"Pkg","version":"1.0.0"}';
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const hash = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
const canonical = (value: unknown): string => JSON.stringify(value, (_key, nested: unknown) => nested !== null && typeof nested === "object" && !Array.isArray(nested) ? Object.fromEntries(Object.entries(nested).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : nested);

type Query = { operation: "read_file" | "file_exists" | "directory_exists" | "realpath"; path: string };
type Result = Query & { value: string | boolean | null };
type Scenario = "metadata" | "physical" | "workspace" | "installed" | "synthetic-missing-metadata" | "synthetic-missing-read" | "physical-alias" | "synthetic-alias" | "directory-read" | "boundary" | "rootless" | "legacy-boundary" | "workspace-directory" | "installed-directory" | "native-missing-rootless" | "native-missing-boundary" | "above-installed" | "nested-member" | "canonical-escape" | "lexical-boundary-case" | "unknown-installed";
const scenarios: Scenario[] = ["metadata", "physical", "workspace", "installed", "synthetic-missing-metadata", "synthetic-missing-read", "physical-alias", "synthetic-alias", "directory-read", "boundary", "rootless", "legacy-boundary", "workspace-directory", "installed-directory", "native-missing-rootless", "native-missing-boundary", "above-installed", "nested-member", "canonical-escape", "lexical-boundary-case", "unknown-installed"];

async function save(path: string, value: unknown): Promise<Evidence> {
  const bytes = JSON.stringify(value, null, 2) + "\n";
  await writeFile(path, bytes);
  return { path, sha256: hash(bytes), bytes: Buffer.byteLength(bytes) };
}

export async function runWorkspaceInputWitnesses(ctx: CampaignContext): Promise<{ properties: PropertyResult[]; evidence: Evidence[]; durationMs: number }> {
  const started = performance.now();
  const properties: PropertyResult[] = [], evidence: Evidence[] = [];
  const producerId = `sha256:${hash(await readFile(ctx.producer))}`;
  for (const scenario of scenarios) {
    const location = resolve(ctx.out, "workspace-inputs", scenario);
    await mkdir(resolve(location, "Sandbox", "Repository"), { recursive: true });
    const sandbox = await realpath(resolve(location, "Sandbox"));
    const repository = resolve(sandbox, "Repository");
    const files: Record<string, string> = {
      "package.json": rootManifest,
      "Packages/Member/package.json": memberManifest,
      "Packages/Member/Base.json": "workspace bytes\n",
      "Unused.ts": "export {};\n",
      "Read.json": "physical bytes\n",
      "Directory/keep": "",
      ...(scenario === "installed" ? { "node_modules/Pkg/Base.json": "installed bytes\n" } : {}),
    };
    for (const [path, bytes] of Object.entries(files)) {
      await mkdir(dirname(resolve(repository, path)), { recursive: true });
      await writeFile(resolve(repository, path), bytes);
    }
    await writeFile(resolve(sandbox, "Sibling.json"), "sibling bytes\n");
    await symlink(resolve(repository, "Read.json"), resolve(repository, "Alias.json"));
    await symlink(resolve(repository, "Packages/Member/Base.json"), resolve(repository, "Packages/Member/Alias.json"));
    if (scenario === "installed-directory") await mkdir(resolve(repository, "node_modules/Pkg"), { recursive: true });
    if (scenario === "unknown-installed") await mkdir(resolve(sandbox, "node_modules"), { recursive: true });
    if (scenario === "above-installed") {
      await mkdir(resolve(sandbox, "node_modules/Pkg"), { recursive: true });
      await writeFile(resolve(sandbox, "node_modules/Pkg/Base.json"), "above repository bytes\n");
    }
    if (scenario === "nested-member") await writeFile(resolve(repository, "Packages/Member/.git"), "gitdir: private\n");
    if (scenario === "canonical-escape") await symlink(resolve(sandbox, "Sibling.json"), resolve(repository, "Escaped.json"));
    const path = (relative: string) => resolve(repository, relative);
    const results: Result[] = [];
    let inputs: InputMap = {};
    const workspaceInputs = (): InputMap => ({ [path("package.json")]: rootManifest, [path("pnpm-workspace.yaml")]: null, [path("Packages/Member/package.json")]: memberManifest });
    const read = (relative: string, value: string | null) => results.push({ operation: "read_file", path: path(relative), value });
    let root = repository;
    let boundary: string | null | undefined;
    if (scenario === "metadata") {
      results.push({ operation: "file_exists", path: path("Read.json"), value: true }, { operation: "directory_exists", path: repository, value: true }, { operation: "realpath", path: path("Read.json"), value: path("Read.json") });
    } else if (scenario === "physical" || scenario === "physical-alias") {
      const relative = scenario === "physical" ? "Read.json" : "Alias.json";
      read(relative, "physical bytes\n");
      inputs = { [path(relative)]: "physical bytes\n" };
    } else if (scenario === "workspace") {
      read("node_modules/Pkg/Base.json", "workspace bytes\n");
      inputs = { ...workspaceInputs(), [path("Packages/Member/Base.json")]: "workspace bytes\n" };
    } else if (scenario === "installed") {
      read("node_modules/Pkg/Base.json", "installed bytes\n");
      inputs = { [path("node_modules/Pkg/Base.json")]: "installed bytes\n" };
    } else if (scenario === "synthetic-missing-metadata" || scenario === "synthetic-missing-read") {
      const missing = path("node_modules/Pkg/Missing.json");
      results.push({ operation: "file_exists", path: missing, value: false }, { operation: "directory_exists", path: missing, value: false }, { operation: "realpath", path: missing, value: missing });
      inputs = { ...workspaceInputs(), [path("Packages/Member/Missing.json")]: null };
      if (scenario === "synthetic-missing-read") {
        read("node_modules/Pkg/Missing.json", null);
        inputs[missing] = null;
      }
    } else if (scenario === "synthetic-alias") {
      read("node_modules/Pkg/Alias.json", null);
      inputs = { ...workspaceInputs(), [path("Packages/Member/Alias.json")]: null, [path("node_modules/Pkg/Alias.json")]: null };
    } else if (scenario === "directory-read") {
      read("Directory", null);
      inputs = { [path("Directory")]: null };
    } else if (scenario === "workspace-directory") {
      results.push({ operation: "directory_exists", path: path("node_modules"), value: true }, { operation: "directory_exists", path: path("node_modules/Pkg"), value: true }, { operation: "file_exists", path: path("node_modules/Pkg"), value: false }, { operation: "realpath", path: path("node_modules/Pkg"), value: path("Packages/Member") });
      inputs = workspaceInputs();
    } else if (scenario === "installed-directory") {
      results.push({ operation: "directory_exists", path: path("node_modules/Pkg"), value: true }, { operation: "realpath", path: path("node_modules/Pkg"), value: path("node_modules/Pkg") });
    } else if (scenario === "native-missing-rootless" || scenario === "native-missing-boundary") {
      const missing = path("Missing.json");
      boundary = scenario === "native-missing-rootless" ? null : repository;
      results.push({ operation: "file_exists", path: missing, value: false }, { operation: "directory_exists", path: missing, value: false }, { operation: "realpath", path: missing, value: missing });
      inputs = scenario === "native-missing-rootless" ? {} : { [missing]: null };
    } else if (scenario === "unknown-installed") {
      root = sandbox;
      boundary = repository;
      const virtual = path("node_modules/Pkg/Base.json");
      results.push({ operation: "read_file", path: virtual, value: null });
      inputs = { ...workspaceInputs(), [virtual]: null };
    } else if (scenario === "above-installed") {
      root = sandbox;
      boundary = repository;
      const virtual = path("node_modules/Pkg/Base.json");
      const above = resolve(sandbox, "node_modules/Pkg/Base.json");
      results.push({ operation: "read_file", path: virtual, value: null }, { operation: "read_file", path: above, value: null }, { operation: "file_exists", path: above, value: false }, { operation: "realpath", path: above, value: above });
      inputs = { ...workspaceInputs(), [virtual]: null, [above]: null };
    } else if (scenario === "nested-member") {
      const virtual = path("node_modules/Pkg/Base.json");
      results.push({ operation: "read_file", path: virtual, value: null });
      inputs = { [path("package.json")]: rootManifest, [path("pnpm-workspace.yaml")]: null, [virtual]: null };
    } else if (scenario === "lexical-boundary-case") {
      root = sandbox;
      boundary = repository;
      const changedCase = resolve(sandbox, "repository/Read.json");
      results.push({ operation: "read_file", path: path("Read.json"), value: "physical bytes\n" }, { operation: "file_exists", path: changedCase, value: false }, { operation: "read_file", path: changedCase, value: null }, { operation: "realpath", path: changedCase, value: changedCase });
      inputs = { [path("Read.json")]: "physical bytes\n", [changedCase]: null };
    } else if (scenario === "canonical-escape") {
      root = sandbox;
      boundary = repository;
      const alias = path("Escaped.json");
      results.push({ operation: "file_exists", path: alias, value: false }, { operation: "read_file", path: alias, value: null }, { operation: "directory_exists", path: alias, value: false }, { operation: "realpath", path: alias, value: alias });
      inputs = { [alias]: null };
    } else {
      root = sandbox;
      boundary = scenario === "boundary" ? repository : scenario === "rootless" ? null : undefined;
      const sibling = resolve(sandbox, "Sibling.json");
      const bytes = scenario === "boundary" ? null : "sibling bytes\n";
      results.push({ operation: "read_file", path: sibling, value: bytes });
      inputs = { [sibling]: bytes };
    }
    const request = { root, ...(boundary === undefined ? {} : { repository_root: boundary }), inventory: Object.keys(files).map(path), queries: results.map(({ operation, path }) => ({ operation, path })) };
    const expected = { results, inputs };
    evidence.push(await save(resolve(location, "request.json"), request), await save(resolve(location, "independent-expected.json"), { authority: "Frozen consumer contract227 readFile + readText/linked/allowedDirect causal writes; authored exact bytes and native lexical paths fixed before producer execution; complete map equality including every undefined attempt", expected, files, sandbox, repository }));
    let metadataFailureActivated = true;
    let restoreMode: number | undefined;
    const installedParent = resolve(sandbox, "node_modules");
    if (scenario === "unknown-installed") {
      restoreMode = (await stat(installedParent)).mode & 0o777;
      await chmod(installedParent, 0);
      let failure: Record<string, unknown> = {};
      try { await stat(resolve(installedParent, "Pkg")); } catch (error) { failure = object(error); }
      metadataFailureActivated = failure.code === "EACCES";
      evidence.push(await save(resolve(location, "independent-native-stat-failure.json"), { path: resolve(installedParent, "Pkg"), code: failure.code, message: failure.message, metadataFailureActivated }));
    }
    const native = await ctx.run(`workspace-inputs-${scenario}`, [ctx.producer, "--observe-live-system", resolve(location, "request.json")], sandbox).finally(async () => { if (restoreMode !== undefined) await chmod(installedParent, restoreMode); });
    evidence.push(...native.evidence);
    let observed: Record<string, unknown>;
    try { observed = object(JSON.parse(native.stdout)); } catch { observed = {}; }
    const nativePassed = metadataFailureActivated && native.exitCode === 0 && native.stderr.trim() === "" && observed.executed === true && isDeepStrictEqual(observed.unsupported, []) && isDeepStrictEqual(observed.results, results) && observed.request_descriptor_id === `sha256:${hash(canonical(request))}` && observed.producer_artifact_id === producerId;
    properties.push({ property: `workspace inputs ${scenario}: complete causal map and native operation`, status: nativePassed && completeInputsMatch(observed.inputs, inputs) ? "pass" : "fail", reason: "Entire input map compared without projection, filtering, key removal or lowercasing; acquisition is not a causal read. Native query rows must also match the independent contract exactly.", evidence: native.evidence });
    evidence.push(await save(resolve(location, "comparison.json"), { expected, observed, property: properties.at(-1) }));
  }
  return { properties, evidence, durationMs: performance.now() - started };
}
