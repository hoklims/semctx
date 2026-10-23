import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import type { CampaignCase } from "./t00-ts7-q-syntax-types.ts";

export async function declaredExternalOracle(path: string, root: string | undefined, specifier: string): Promise<{ external: boolean; reads: { path: string; found: boolean; error_kind: string | null }[]; system: string }> {
  const reads: { path: string; found: boolean; error_kind: string | null }[] = [];
  const result = (external: boolean) => ({ external, reads, system: "native" });
  const packageName = specifier.split("/").slice(0, specifier.startsWith("@") ? 2 : 1).join("/");
  for (let directory = dirname(path); ; directory = dirname(directory)) {
    if (root) {
      const relation = relative(root, directory);
      if (relation === ".." || relation.startsWith("../") || isAbsolute(relation)) return result(false);
    }
    let source: string | undefined;
    const target = join(directory, "package.json");
    try {
      source = await readFile(target, "utf8");
      reads.push({ path: target, found: true, error_kind: null });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const errorKind = ({ ENOENT: "NotFound", EISDIR: "IsADirectory", EACCES: "PermissionDenied", EPERM: "PermissionDenied", ENOTDIR: "NotADirectory", ELOOP: "FilesystemLoop" })[code ?? ""];
      if (!errorKind) throw new Error(`unmapped native oracle read error: ${code}`, { cause: error });
      reads.push({ path: target, found: false, error_kind: errorKind });
      source = undefined;
    }
    if (source !== undefined) {
      try {
        const manifest = JSON.parse(source) as Record<string, unknown>;
        if (manifest.name === packageName) return result(false);
        for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
          const dependencies = manifest[field];
          if (dependencies && typeof dependencies === "object") {
            const version = (dependencies as Record<string, unknown>)[packageName];
            if (typeof version === "string") return result(!/^(workspace:|file:|link:)/.test(version));
          }
        }
      } catch { return result(false); }
    }
    if (dirname(directory) === directory) return result(false);
  }
}

export function resolutionFromTrace(trace: string, specifier: string): "resolved" | "external" | "unresolved" {
  const prefix = `======== Module name '${specifier}' was `;
  const lines = trace.split("\n").filter(line => line.startsWith(prefix));
  const results = new Set(lines.map(line => line.includes("was not resolved.") ? "unresolved" :
    line.includes("was successfully resolved to '") ? line.includes("/node_modules/") ? "external" : "resolved" : "invalid"));
  if (results.size !== 1 || results.has("invalid")) throw new Error(`resolution trace missing or ambiguous: ${specifier}`);
  return [...results][0] as "resolved" | "external" | "unresolved";
}

export function requireNativeManifestFailures(item: CampaignCase, workspace: string, reads: Awaited<ReturnType<typeof declaredExternalOracle>>["reads"]): void {
  for (const [field, errorKind] of [["manifestDirectories", "IsADirectory"], ["unreadableManifests", "PermissionDenied"]] as const) {
    for (const path of item.request[field] as string[] ?? []) {
      const target = join(workspace, path);
      if (!reads.some(read => read.path === target && !read.found && read.error_kind === errorKind)) {
        throw new Error(`native manifest failure not activated: ${item.name}: ${target}: ${errorKind}`);
      }
    }
  }
}

export async function materializeExternal(item: CampaignCase, workspace: string): Promise<Record<string, unknown>> {
  const files = item.request.files as Record<string, string>;
  for (const [path, source] of Object.entries(files)) {
    if (isAbsolute(path) || path.split("/").some(part => part === ".." || part === "")) throw new Error("unsafe external fixture path");
    await mkdir(dirname(join(workspace, path)), { recursive: true });
    await writeFile(join(workspace, path), source, { flag: "wx" });
  }
  for (const path of item.request.manifestDirectories as string[] ?? []) await mkdir(join(workspace, path), { recursive: true });
  for (const path of item.request.unreadableManifests as string[] ?? []) await chmod(join(workspace, path), 0);
  return { operation: "declared_external_live", path: join(workspace, "repo/src/deep/main.js"),
    ...(item.request.unbounded ? {} : { repository_root: join(workspace, "repo") }), specifier: item.request.specifier ?? "external/sub" };
}

const property = "owning consumer observable rule(s) in canonical family/call-path contract";
const externalCase = (name: string, files: Record<string, string>, extra: Record<string, unknown> = {}): CampaignCase => ({
  name: `LF-external-${name}`, indices: [18], mode: "live-external", request: { files: { "repo/src/deep/main.js": "export {};", ...files }, ...extra },
  oracleInput: { operation: "declared_external_contract", contract: "consumer-contracts.json index 18 predicate; TS7 contract preserves filesystem policy" },
  checks: [
    { name: "declared-external", actual: ["external"], expected: ["observation", "external"] },
    { name: "native-manifest-read-outcomes", actual: ["reads"], expected: ["observation", "reads"] },
    { name: "native-system", actual: ["system"], expected: ["observation", "system"] },
  ],
});
const manifest = (dependencies: unknown, field = "dependencies") => JSON.stringify({ [field]: dependencies });
export const cases: CampaignCase[] = [
  ...["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"].map(field => externalCase(field, { "repo/package.json": manifest({ external: "^1" }, field) })),
  externalCase("scoped", { "repo/package.json": manifest({ "@scope/external": "1" }) }, { specifier: "@scope/external/sub" }),
  externalCase("nearest", { "repo/package.json": manifest({ external: "workspace:*" }), "repo/src/package.json": manifest({ external: "1" }) }),
  externalCase("null", { "repo/package.json": manifest({ external: "1" }), "repo/src/package.json": "null" }),
  externalCase("malformed", { "repo/package.json": manifest({ external: "1" }), "repo/src/package.json": "{" }),
  externalCase("self", { "repo/package.json": manifest({ external: "1" }), "repo/src/package.json": '{"name":"external"}' }),
  ...["workspace:*", "file:../external", "link:../external"].map((version, index) => externalCase(`local-${index}`, { "repo/package.json": manifest({ external: version }) })),
  externalCase("array-field", { "repo/package.json": manifest(["1"]) }, { specifier: "0" }),
  externalCase("array-field-noncanonical-index", { "repo/package.json": manifest(["1"]) }, { specifier: "00" }),
  externalCase("non-string", { "repo/package.json": manifest({ external: false }) }),
  externalCase("ancestor-confined", { "package.json": manifest({ external: "1" }) }),
  externalCase("ancestor-unbounded", { "package.json": manifest({ external: "1" }) }, { unbounded: true }),
  externalCase("native-directory-read-failure", { "repo/package.json": manifest({ external: "1" }) }, { manifestDirectories: ["repo/src/package.json"] }),
  externalCase("native-permission-read-failure", { "repo/package.json": manifest({ external: "1" }), "repo/src/package.json": "{}" }, { unreadableManifests: ["repo/src/package.json"] }),
  externalCase("missing", {}),
  externalCase("unbounded-missing", {}, { unbounded: true, specifier: "@semctx-live-fs-absent/735ac13" }),
  ...[
    ["named", "function value() {} value(); export {};"],
    ["wrapped", "function value() {} (((value)))(); export {};"],
    ["conditional", "function first() {} function second() {} (true ? first : second)(); export {};"],
    ["tagged", "function tag() {} tag`value`; export {};"],
  ].map(([name, source]) => ({ name: `LF-visit-invocation-${name}`, indices: [19], mode: "raw", request: { files: { "main.js": source }, roots: ["main.js"] },
    oracleInput: { operation: "syntax", filename: "main.js", source }, checks: [
      { name: "javascript-visit-reasons", actual: ["subjects", 0, "javascriptObservation", "reasons"], expected: ["observation", "javascriptReasons"] },
      { name: "javascript-visit-executed", actual: ["subjects", 0, "javascriptObservation", "executed"], expected: ["observation", "executed"] },
      { name: "javascript-visit-support", actual: ["subjects", 0, "javascriptObservation", "unsupported"], expected: ["observation", "unsupported"] },
    ] } satisfies CampaignCase)),
  ...[
    ["dynamic-string", 'export function value() { import("./dep.js"); }'],
    ["dynamic-number", "export function value() { import(42); }"],
    ["dynamic-zero", "export function value() { import(); }"],
    ["dynamic-two", 'export function value() { import("./dep.js", {}); }'],
    ["dynamic-template", 'export function value() { import(`./dep.js`); }'],
    ["with", "with ({ value: 1 }) { value; } export {};"],
    ["static-import", 'import { value } from "./dep.js"; export { value };'],
    ["static-export", 'export { value } from "./dep.js";'],
    ["unresolved", 'export { value } from "./missing.js";'],
    ["external", 'export { value } from "external/sub";'],
  ].map(([name, source]) => ({ name: `LF-visit-${name}`, indices: [19], mode: "raw", request: { files: { "main.js": source, "dep.js": "export const value = 1;", "package.json": manifest({ external: "1" }) }, roots: ["main.js"] },
    oracleInput: { operation: "syntax", filename: "main.js", source, liveLinks: true },
    checks: [
      { name: "javascript-visit-reasons", actual: ["subjects", 0, "javascriptObservation", "reasons"], expected: ["observation", "javascriptReasons"] },
      { name: "javascript-visit-links", actual: ["subjects", 0, "javascriptObservation", "staticModuleLinks"], expected: ["observation", "staticModuleLinks"] },
      { name: "javascript-visit-executed", actual: ["subjects", 0, "javascriptObservation", "executed"], expected: ["observation", "executed"] },
      { name: "javascript-visit-support", actual: ["subjects", 0, "javascriptObservation", "unsupported"], expected: ["observation", "unsupported"] },
    ] } satisfies CampaignCase)),
];
const capturedCases: CampaignCase[] = cases.filter(item => item.mode === "live-external" && !item.request.unbounded && !item.request.manifestDirectories && !item.request.unreadableManifests && !item.name.includes("ancestor-")).map(item => {
  const filename = "repo/src/deep/main.js";
  const source = `export { value } from ${JSON.stringify(item.request.specifier ?? "external/sub")};`;
  return { name: item.name.replace("LF-external-", "LF-captured-external-"), indices: [18], mode: "raw", request: { files: { ...item.request.files as Record<string, string>, [filename]: source }, roots: [filename] },
    oracleInput: { operation: "syntax", filename, source, liveLinks: true }, checks: [
      { name: "captured-external-links", actual: ["subjects", 0, "javascriptObservation", "staticModuleLinks"], expected: ["observation", "staticModuleLinks"] },
      { name: "captured-external-reasons", actual: ["subjects", 0, "javascriptObservation", "reasons"], expected: ["observation", "javascriptReasons"] },
      { name: "captured-external-executed", actual: ["subjects", 0, "javascriptObservation", "executed"], expected: ["observation", "executed"] },
      { name: "captured-external-support", actual: ["subjects", 0, "javascriptObservation", "unsupported"], expected: ["observation", "unsupported"] },
    ] };
});
cases.push(...capturedCases);
export const propertyWitnesses: Record<number, Record<string, string[]>> = {
  18: { [property]: cases.filter(item => item.indices.includes(18)).map(item => item.name) },
  19: { [property]: cases.filter(item => item.indices.includes(19)).map(item => item.name) },
};
