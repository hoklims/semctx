import ts from "typescript";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

type Identity = { request: string; sdk: string; producer: string };
type NativeResolution = {
  executed?: boolean;
  unsupported?: unknown[];
  resolved_file_name?: string | null;
  native_error?: unknown;
  native_diagnostics?: unknown[];
  request_descriptor_id?: string;
  sdk_input_id?: string;
  producer_artifact_id?: string;
  configuration?: { executed?: boolean; unsupported?: unknown[] };
};

export function compareResolution(value: NativeResolution, expected: string | null, identity: Identity): boolean {
  return value.executed === true && Array.isArray(value.unsupported) && value.unsupported.length === 0
    && value.resolved_file_name === expected && value.native_error === null
    && Array.isArray(value.native_diagnostics) && value.native_diagnostics.length === 0
    && value.request_descriptor_id === identity.request && value.sdk_input_id === identity.sdk
    && value.producer_artifact_id === identity.producer && value.configuration?.executed === true
    && Array.isArray(value.configuration.unsupported) && value.configuration.unsupported.length === 0;
}

const canonical = (value: unknown): string => JSON.stringify(value, (_key: string, field: unknown) => field !== null && typeof field === "object" && !Array.isArray(field)
  ? Object.fromEntries(Object.entries(field).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : field);
const sha = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
const digest = (value: unknown): string => "sha256:" + sha(canonical(value));

interface Fixture {
  id: string;
  control: string;
  files: Record<string, string>;
  specifier: string;
}

const source = 'import { value } from "alias"; export function call() { return value(); }\n';
const target = "export function value() { return 1; }\n";
const config = JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { alias: ["./target.ts"] } } });
const fixtures: Fixture[] = [
  { id: "no-config-relative", control: "no-config-missing", files: { "main.js": source, "target.ts": target }, specifier: "./target" },
  { id: "no-config-missing", control: "no-config-relative", files: { "main.js": source, "target.ts": target }, specifier: "./missing" },
  { id: "paths-active", control: "paths-control", files: { "main.js": source, "target.ts": target, "tsconfig.json": config }, specifier: "alias" },
  { id: "paths-control", control: "paths-active", files: { "main.js": source, "target.ts": target, "tsconfig.json": "{}" }, specifier: "alias" },
  { id: "config-malformed", control: "paths-active", files: { "main.js": source, "target.ts": target, "tsconfig.json": "{ broken" }, specifier: "alias" },
  { id: "extends-active", control: "extends-missing", files: { "main.js": source, "target.ts": target, "tsconfig.json": '{"extends":"./base.json"}', "base.json": config }, specifier: "alias" },
  { id: "extends-missing", control: "extends-active", files: { "main.js": source, "target.ts": target, "tsconfig.json": '{"extends":"./base.json"}' }, specifier: "alias" },
  { id: "package-realpath", control: "package-missing", files: { "main.js": source, "node_modules/pkg/package.json": '{"name":"pkg","types":"index.d.ts"}', "node_modules/pkg/index.d.ts": "export declare function value(): number;" }, specifier: "pkg" },
  { id: "package-missing", control: "package-realpath", files: { "main.js": source }, specifier: "pkg" },
];

type Owner = { resolveTypeScriptModule: (specifier: string, containing: string, mode: undefined, configured: boolean, snapshot: ReadonlyMap<string, string> | undefined, workspace: undefined, root: string) => string | undefined };
type TraceGlobal = typeof globalThis & { __t00ResolutionTrace?: (id: string, value: unknown) => unknown };

async function campaign(baseline: string, freezePath: string, output: string): Promise<void> {
  if (ts.version !== "5.9.3" || Bun.version !== "1.4.3") throw new Error("requires TS5.9.3 Bun1.4.3");
  await mkdir(output);
  const freeze = JSON.parse(await readFile(freezePath, "utf8")) as { artifact_path: string; artifact_sha256: string; sdk_path: string; sdk_sha256: string; source_head: string };
  const sdkBytes = await readFile(freeze.sdk_path);
  const sdk: unknown = JSON.parse(sdkBytes.toString());
  const artifactBytes = await readFile(freeze.artifact_path);
  if (sha(artifactBytes) !== freeze.artifact_sha256 || sha(sdkBytes) !== freeze.sdk_sha256) throw new Error("frozen artifact mismatch");
  const sourcePath = resolve(baseline, "packages/ts-analyzer/src/ts-symbols.ts");
  const sourceText = await readFile(sourcePath, "utf8");
  if (sha(sourceText) !== "259b92fde8c66d72adb5dce767248bd8426f017c7885007f6ec6107a3b54716e") throw new Error("foreign baseline source");
  const tracedRoot = resolve(output, "traced-source");
  await cp(dirname(sourcePath), tracedRoot, { recursive: true });
  await symlink(resolve(baseline, "node_modules"), resolve(tracedRoot, "node_modules"));
  const parsed = ts.createSourceFile(sourcePath, sourceText, ts.ScriptTarget.Latest, true);
  const targets: Record<string, { text: string; line: number }> = {};
  const transformed = ts.transform(parsed, [context => {
    const visit = (node: ts.Node, inOwner: boolean): ts.VisitResult<ts.Node> => {
      const selected = inOwner || (ts.isFunctionDeclaration(node) && node.name?.text === "resolveConfiguredModule");
      let result = ts.visitEachChild(node, child => visit(child, selected), context);
      const isTrace = selected && (ts.isBinaryExpression(node) || ts.isCallExpression(node)
        || (ts.isPropertyAccessExpression(node) && node.expression.getText(parsed) === "ts" && node.name.text === "sys"));
      if (isTrace) {
        const id = `${node.getStart(parsed)}:${node.getEnd()}`;
        targets[id] = { text: node.getText(parsed), line: parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1 };
        result = context.factory.createCallExpression(context.factory.createPropertyAccessExpression(context.factory.createIdentifier("globalThis"), "__t00ResolutionTrace"), undefined, [context.factory.createStringLiteral(id), result as ts.Expression]);
      }
      return result;
    };
    return node => ts.visitNode(node, child => visit(child, false)) as ts.SourceFile;
  }]);
  await writeFile(resolve(tracedRoot, "ts-symbols.ts"), ts.createPrinter().printFile(transformed.transformed[0]!));
  transformed.dispose();
  const original = await import(sourcePath) as Owner;
  const traced = await import(resolve(tracedRoot, "ts-symbols.ts")) as Owner;
  const rows = [];
  for (const fixture of fixtures) {
    const root = resolve(output, "world-" + fixture.id);
    await mkdir(root);
    const files = Object.fromEntries(Object.entries(fixture.files).map(([path, text]) => [resolve(root, path), text]));
    for (const [path, text] of Object.entries(files)) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, text);
    }
    const containing = resolve(root, "main.js");
    const ownerResults = [];
    for (const mode of ["live", "snapshot"] as const) {
      const snapshot = mode === "snapshot" ? new Map(Object.entries(files)) : undefined;
      const expected = original.resolveTypeScriptModule(fixture.specifier, containing, undefined, true, snapshot, undefined, root) ?? null;
      const hits: Record<string, unknown[]> = {};
      (globalThis as TraceGlobal).__t00ResolutionTrace = (id, value) => {
        const summary = value === undefined ? { undefined: true } : value !== null && typeof value === "object" ? { object: true } : value;
        const values = hits[id] ??= [];
        if (!values.some(previous => canonical(previous) === canonical(summary))) values.push(summary);
        return value;
      };
      const actual = traced.resolveTypeScriptModule(fixture.specifier, containing, undefined, true, snapshot, undefined, root) ?? null;
      delete (globalThis as TraceGlobal).__t00ResolutionTrace;
      if (actual !== expected) throw new Error("instrumentation changed complete owning output: " + fixture.id);
      ownerResults.push({ mode, expected, instrumented: actual, completeOwningOutputEqual: true, hits });
    }
    const request = { root, sdk_directory: "/sdk/lib", case_sensitive: ts.sys.useCaseSensitiveFileNames, files, directories: [], containing_file: containing, specifier: fixture.specifier };
    const requestPath = resolve(output, fixture.id + "-request.json");
    await writeFile(requestPath, JSON.stringify(request, null, 2) + "\n");
    const result = Bun.spawnSync([freeze.artifact_path, "--observe-configured-resolution", requestPath, freeze.sdk_path], { env: { ...process.env, GOPORT_LIB_PARSE_SNAPSHOT: "0", GOPORT_LIB_SNAPSHOT: "0" }, timeout: 40_000, stdout: "pipe", stderr: "pipe" });
    await writeFile(resolve(output, fixture.id + "-native.stdout.json"), result.stdout);
    await writeFile(resolve(output, fixture.id + "-native.stderr.txt"), result.stderr);
    if (result.exitCode !== 0) throw new Error(`native process failed ${fixture.id}: ${result.exitCode}`);
    const observed = JSON.parse(new TextDecoder().decode(result.stdout)) as NativeResolution;
    const comparisons = ownerResults.map(owner => ({ mode: owner.mode, expected: owner.expected, pass: compareResolution(observed, owner.expected, { request: digest(request), sdk: digest(sdk), producer: "sha256:" + freeze.artifact_sha256 }) }));
    rows.push({ id: fixture.id, control: fixture.control, ownerResults, comparisons, native: observed });
  }
  if (sha(await readFile(freeze.artifact_path)) !== freeze.artifact_sha256 || sha(await readFile(freeze.sdk_path)) !== freeze.sdk_sha256) throw new Error("frozen artifacts changed");
  const report = { schemaVersion: 1, platform: process.platform, arch: process.arch, bun: Bun.version, typescript: ts.version, candidate: freeze.source_head, artifactSha256: freeze.artifact_sha256, sdkSha256: freeze.sdk_sha256, baselineSourceSha256: sha(sourceText), baseline: "3e94997fcbefa72ad4d49b2cad180ee79b7c0a9b", scope: "complete resolveTypeScriptModule string-or-undefined result for finite files; captured native configured resolver; live filesystem branch equivalence and complete compiler diagnostics not claimed", targets, rows, allFiniteComparisonsPass: rows.every(row => row.comparisons.every(comparison => comparison.pass)), obligations: [{ index: 198, status: "not_qualified", reason: "default system expression not evaluated by owning callers; finite witnesses do not cover all owned failure paths" }, { index: 204, status: "not_qualified", reason: "realpath directoryExists alternative not reached; native capture has no live symlink/failure semantics" }], formalR0Qualified: false };
  await writeFile(resolve(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  process.stdout.write(JSON.stringify({ output, rows: rows.length, comparisons: rows.length * 2, pass: report.allFiniteComparisonsPass }) + "\n");
}

if (import.meta.main) {
  const [baseline, freeze, output] = process.argv.slice(2);
  if (!baseline || !freeze || !output) throw new Error("expected BASELINE FREEZE FRESH_OUTPUT");
  await campaign(resolve(baseline), resolve(freeze), resolve(output));
}
