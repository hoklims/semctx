import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "../packages/core/node_modules/zod";
import { createGlobSelectionConfig } from "@semantic-context/core";
import { getPlaneASidecar } from "@semantic-context/plane-a-internal";
import { createRepositoryAnalyzer, discoverRepository, getQualifiedCallIntegrityReasons, type AnalysisCompiler, type AnalysisResult, type CompilerInputSnapshot, type TsExtraction } from "@semantic-context/ts-analyzer";
import { analyzePlaneARuntimeAsync } from "../packages/app-services/src/plane-a-runtime";
import type { ExperimentalTypeScriptRuntime } from "../packages/app-services/src/experimental-typescript-runtime";
import { isolatedEnvironment, type Json } from "./t00-ts7-q-boundary-common";

const strings = z.array(z.string());
const line = z.number().int().positive();
const extractionSchema: z.ZodType<TsExtraction> = z.object({
  modules: strings,
  symbols: z.array(z.object({ name: z.string(), kind: z.enum(["function", "class", "interface", "type", "enum"]), relPath: z.string(), scope: strings, startLine: line, endLine: line, exported: z.boolean(), signatureOnly: z.boolean().optional(), jsdoc: z.string().optional(), markers: z.array(z.object({ tag: z.enum(["capability", "invariant", "contract", "risk", "boundedContext", "tag"]), slug: z.string(), statement: z.string().optional() }).passthrough()) }).passthrough()),
  imports: z.array(z.object({ fromRelPath: z.string(), moduleSpecifier: z.string(), resolvedRelPath: z.string().optional(), names: strings, line, bindingTargets: z.array(z.object({ relPath: z.string(), symbolPath: z.string(), runtimeUsed: z.boolean().optional(), unmodeledReason: z.string().optional() }).passthrough()).optional() }).passthrough()),
  calls: z.array(z.object({ callerRelPath: z.string(), callerSymbolPath: z.string().optional(), callerUnmodeledReason: z.string().optional(), calleeName: z.string(), calleeRelPath: z.string().optional(), calleeSymbolPath: z.string().optional(), calleeUnmodeledReason: z.string().optional(), line }).passthrough()),
}).passthrough();
const requestSchema = z.object({ cwd: z.string(), roots: strings, files: z.record(z.string()), roles: z.record(z.enum(["source", "test"])).default({}), qualified: z.boolean().default(false), retained: z.boolean().default(true) }).passthrough();
const observationSchema = z.object({ native_compiler_version: z.literal("7.1.0-dev"), engine_revision: z.literal("780dc512d64f40afebffa6a7028207649fb7ed1c"), sdk_version: z.literal("7.1.0-dev"), complete: z.literal(true), producer_artifact_id: z.string(), raw_extraction: extractionSchema, test_dynamic_import_keys: strings, subjects: z.array(z.object({ path: z.string(), reasons: strings }).passthrough()) }).passthrough();
const ownershipSchema = z.object({ phase: z.literal("ownership"), accepted: z.literal(true), subjects: z.array(z.object({ path: z.string(), reasons: strings }).passthrough()) }).strict();
const componentSchema = z.object({ executed: z.literal(true), reasons: strings, unsupported: z.array(z.never()) }).passthrough();
const recordSchema = z.record(z.unknown());
const parallelSchema = z.object({ executed: z.literal(true), unsupported: z.array(z.never()), extraction: extractionSchema, parallelism: z.object({ requested: z.number().int().min(1).max(8), used: z.number().int().min(1).max(8), mode: z.enum(["parallel", "single", "preflight-fallback", "worker-unavailable-fallback"]), reason: z.string().optional() }).strict() }).passthrough();
const cap = 16_777_216;

class ApplicationOwnershipError extends Error {
  constructor(message: string, readonly diagnosticAssembly: Json) { super(message); }
}

class ApplicationSessionError extends Error {
  constructor(readonly exitCode: number, readonly rejection: string | undefined, stderr: string) { super(`APPLICATION_SESSION_EOF:${exitCode}:${stderr}`); }
}

async function openSession(producer: string, requestPath: string, sdkPath: string, root: string) {
  const child = Bun.spawn([producer, "--experimental-application-session", requestPath, sdkPath], { cwd: root, env: { ...isolatedEnvironment(root), GOPORT_LIB_PARSE_SNAPSHOT: "0", GOPORT_LIB_SNAPSHOT: "0", GOPORT_BUILD_VERSION: undefined }, stdin: "pipe", stdout: "pipe", stderr: "pipe", timeout: 20_000 });
  const reader = child.stdout.getReader();
  const stderr = new Response(child.stderr).text();
  let buffer = new Uint8Array(0);
  let finished = false;
  const next = async (): Promise<unknown> => {
    for (;;) {
      const newline = buffer.indexOf(10);
      if (newline !== -1) {
        if (newline > cap) throw Error("APPLICATION_SESSION_FRAME_TOO_LARGE");
        const frame = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(frame)) as unknown;
      }
      if (buffer.length > cap) throw Error("APPLICATION_SESSION_FRAME_TOO_LARGE");
      const part = await reader.read();
      if (part.done) {
        const exit = await child.exited, errors = await stderr;
        let diagnostic: unknown;
        try { diagnostic = JSON.parse(errors) as unknown; } catch { diagnostic = undefined; }
        const parsed = z.object({ error: z.string() }).strict().safeParse(diagnostic);
        throw new ApplicationSessionError(exit, parsed.success ? parsed.data.error : undefined, errors);
      }
      const combined = new Uint8Array(buffer.length + part.value.length);
      combined.set(buffer); combined.set(part.value, buffer.length); buffer = combined;
    }
  };
  return {
    next,
    async send(value: unknown): Promise<unknown> {
      const bytes = JSON.stringify(value) + "\n";
      if (Buffer.byteLength(bytes) > cap) throw Error("APPLICATION_SESSION_FRAME_TOO_LARGE");
      await child.stdin.write(bytes);
      await child.stdin.flush();
      return next();
    },
    async finish(): Promise<void> {
      await child.stdin.end();
      const exit = await child.exited;
      const errors = await stderr;
      const extra = await reader.read();
      if (exit !== 0 || errors !== "" || buffer.length !== 0 || !extra.done) throw Error(`APPLICATION_SESSION_TERMINAL:${exit}:${errors}`);
      finished = true;
    },
    async close(): Promise<void> { if (!finished) { await child.stdin.end(); await child.exited; await stderr; } reader.releaseLock(); },
  };
}

export async function runExperimentalApplicationRuntime(requestPath: string, sdkPath: string, producer: string, helper: string, workers: number): Promise<Json> {
  if (!Number.isInteger(workers) || workers < 1 || workers > 8) throw Error("APPLICATION_WORKERS_INVALID");
  const request = requestSchema.parse(JSON.parse(await readFile(requestPath, "utf8")) as unknown);
  const sdk = z.object({ version: z.literal("7.1.0-dev"), files: z.record(z.string()) }).passthrough().parse(JSON.parse(await readFile(sdkPath, "utf8")) as unknown);
  if (Object.keys(sdk.files).length !== 115) throw Error("APPLICATION_SDK115_REQUIRED");
  const artifact = "sha256:" + createHash("sha256").update(await readFile(producer)).digest("hex");
  const snapshot = request.retained ? new Map(Object.entries(request.files)) : undefined;
  let session: Awaited<ReturnType<typeof openSession>> | undefined;
  let native: z.infer<typeof observationSchema> | undefined;
  let nativeDisposition: "analyzed" | "controlled_refusal" | undefined;
  let controlledRefusal: ApplicationSessionError | undefined;
  try {
    let ownership: z.infer<typeof ownershipSchema> | undefined;
    let registered: { inputs: CompilerInputSnapshot; graph: AnalysisResult["graph"]; root: string } | undefined;
    let workerObservation: unknown;
    let finalReceiptRevalidated = false;
    const diagnosticAssembly = (analysis: AnalysisResult, stage: string): Json => ({ stage, analysis, sidecar: getPlaneASidecar(analysis), integrityReasons: Object.fromEntries(getQualifiedCallIntegrityReasons(analysis)), nativeObservation: native, workerObservation });
    const subject = (path: string, owned = false) => {
      const found = (owned ? ownership?.subjects : native?.subjects)?.find(item => item.path === path);
      if (found === undefined) throw Error(`APPLICATION_SUBJECT_MISSING:${path}`);
      return found;
    };
    const componentReasons = (path: string, name: string): string[] => componentSchema.parse(subject(path)[name]).reasons;
    const compiler: AnalysisCompiler = {
      producerIdentity: () => ({ identity: "@semantic-context/ts-analyzer/experimental-native-ts7", version: `7.1.0-dev/${artifact}` }),
      dialectVersion: "7.1.0-dev",
      resolutionSemantics: language => `${language}-static-ts7-experimental-v1`,
      extract: () => { throw Error("APPLICATION_ASYNC_EXTRACTION_REQUIRED"); },
      extractParallel: async (paths, root, selected = "auto", inputs) => {
        if (root !== request.cwd || inputs !== snapshot || !isDeepStrictEqual(paths, request.roots)) throw Error("APPLICATION_EXTRACTION_INPUT_MISMATCH");
        if (request.qualified && request.retained) {
          session = await openSession(producer, requestPath, sdkPath, root);
          const produced = z.object({ phase: z.literal("produced"), disposition: z.enum(["analyzed", "controlled_refusal"]), observation: observationSchema }).strict().parse(await session.next());
          native = produced.observation;
          nativeDisposition = produced.disposition;
        } else {
          const ordinary = Bun.spawn([producer, requestPath, sdkPath], { cwd: root, env: { ...isolatedEnvironment(root), GOPORT_LIB_PARSE_SNAPSHOT: "0", GOPORT_LIB_SNAPSHOT: "0", GOPORT_BUILD_VERSION: undefined }, stdout: "pipe", stderr: "pipe", timeout: 20_000 });
          const [stdout, stderr, exit] = await Promise.all([new Response(ordinary.stdout).text(), new Response(ordinary.stderr).text(), ordinary.exited]);
          if (exit !== 0 || Buffer.byteLength(stdout) > cap) throw Error(`APPLICATION_NATIVE_FAILED:${exit}:${stderr}`);
          native = observationSchema.parse(JSON.parse(stdout) as unknown);
        }
        if (native.producer_artifact_id !== artifact) throw Error("APPLICATION_PRODUCER_ARTIFACT_MISMATCH");
        const count = selected === "auto" ? workers : selected;
        if (request.retained) {
          const parallelism = { requested: count, used: 1, mode: "preflight-fallback" as const, reason: "retained compiler input snapshot requires one semantic Program" };
          workerObservation = { executed: false, selectionSource: "retained-native-Program", jobs: [], extraction: native.raw_extraction, parallelism, producer_artifact_id: artifact };
          return { extraction: native.raw_extraction, parallelism };
        }
        const path = resolve(dirname(requestPath), "application-workers.json");
        await writeFile(path, JSON.stringify({ repoRoot: root, rootAbsPaths: paths, workers: count }));
        const child = Bun.spawn([producer, "--extract-parallel", path, sdkPath, helper], { cwd: root, env: { ...isolatedEnvironment(root), GOPORT_LIB_PARSE_SNAPSHOT: "0", GOPORT_LIB_SNAPSHOT: "0", GOPORT_BUILD_VERSION: undefined }, stdout: "pipe", stderr: "pipe", timeout: 20_000 });
        const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
        if (exit !== 0 || Buffer.byteLength(stdout) > cap) throw Error(`APPLICATION_WORKERS_FAILED:${exit}:${stderr}`);
        workerObservation = JSON.parse(stdout) as unknown;
        const observed = parallelSchema.parse(workerObservation);
        if (observed.parallelism.requested !== count || observed.parallelism.used > count || !isDeepStrictEqual(observed.extraction, native.raw_extraction)) throw Error("APPLICATION_WORKER_CAPTURE_DIVERGENCE");
        return { extraction: observed.extraction, parallelism: observed.parallelism };
      },
      dynamicTestImports: () => {
        if (native === undefined) throw Error("APPLICATION_NATIVE_EXTRACTION_REQUIRED");
        return new Set(native.test_dynamic_import_keys);
      },
      readRetained: (inputs, path) => inputs.get(path),
      registerOpaqueCallbackOwnership: (inputs, graph, root) => { registered = { inputs, graph, root }; },
      inspectJavaScriptSource: path => {
        const current = subject(relative(request.cwd, path));
        const diagnostics = z.object({ executed: z.literal(true), parseFailed: z.boolean(), reasons: strings, unsupported: z.array(z.never()) }).passthrough().parse(current.javascriptObservation);
        const javascript = z.object({ staticExports: z.array(z.object({ name: z.string(), declarationKind: z.string() })), staticModuleLinks: z.array(z.object({ specifier: z.string(), resolution: z.enum(["resolved", "external", "unresolved"]) })) }).passthrough().parse(current.javascript);
        return { parseFailed: diagnostics.parseFailed, reasons: diagnostics.reasons, staticExports: javascript.staticExports, staticModuleLinks: javascript.staticModuleLinks };
      },
    };
    const runtime: ExperimentalTypeScriptRuntime = {
      analyzer: createRepositoryAnalyzer(compiler),
      sourceParsingReasons: file => componentReasons(file.relPath, "sourceParsingObservation"),
      configurationReasons: file => componentSchema.parse(recordSchema.parse(subject(file.relPath).moduleConfigurationObservations)[request.retained ? "retainedWithSource" : "ordinaryWithoutSnapshot"]).reasons,
      analysisReasons: file => subject(file.relPath, request.qualified && controlledRefusal === undefined).reasons,
      bindOwnership: async (analysis, inputs) => {
        if (registered?.inputs !== inputs || registered.graph !== analysis.graph || registered.root !== request.cwd) throw Error("APPLICATION_OWNERSHIP_NOT_REGISTERED");
        if (session === undefined) throw Error("APPLICATION_OWNERSHIP_SESSION_REQUIRED");
        try {
          ownership = ownershipSchema.parse(await session.send({ phase: "ownership", graph: analysis.graph, files: Object.fromEntries(inputs) }));
        } catch (error) {
          if (nativeDisposition === "controlled_refusal" && error instanceof ApplicationSessionError && error.exitCode === 1 && error.rejection === "application session: ownership receipt rejected: RefusalHasNoOwnership") {
            controlledRefusal = error;
          } else {
            throw new ApplicationOwnershipError(error instanceof Error ? error.message : String(error), diagnosticAssembly(analysis, "analyzer-before-composition"));
          }
        }
      },
      revalidate: async (analysis, inputs) => {
        if (controlledRefusal !== undefined) throw new ApplicationOwnershipError(controlledRefusal.message, diagnosticAssembly(analysis, "application-composition-refused"));
        if (session === undefined) throw Error("APPLICATION_OWNERSHIP_SESSION_REQUIRED");
        z.object({ phase: z.literal("final"), accepted: z.literal(true) }).strict().parse(await session.send({ phase: "final", graph: analysis.graph, files: Object.fromEntries(inputs) }));
        await session.finish();
        finalReceiptRevalidated = true;
      },
    };
    const config = { ...createGlobSelectionConfig(request.cwd), include: ["**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}"], testGlobs: Object.entries(request.roles).filter(([, role]) => role === "test").map(([path]) => path), languages: { typescript: "on" as const, javascript: "on" as const, python: "off" as const, markdown: "off" as const, sql: "off" as const }, ...(request.qualified ? { selectionMode: "qualified-static-v1" as const, analysisProfile: "public-monorepo-static-v1" as const } : {}) };
    const discovery = discoverRepository(config);
    const result = await analyzePlaneARuntimeAsync(config, discovery, workers, snapshot, runtime);
    return { executed: true, ...result, integrityReasons: Object.fromEntries(getQualifiedCallIntegrityReasons(result.analysis)), nativeObservation: native, ownershipObservation: ownership, workerObservation, finalReceiptRevalidated };
  } finally { await session?.close(); }
}

if (import.meta.main) {
  try {
    const [request, sdk, producer, helper, count, extra] = process.argv.slice(2);
    if (!request || !sdk || !producer || !helper || !count || extra !== undefined) throw Error("expected REQUEST.json SDK.json PRODUCER HELPER WORKERS");
    console.log(JSON.stringify(await runExperimentalApplicationRuntime(request, sdk, producer, helper, Number(count))));
  } catch (error) {
    console.error(JSON.stringify({ error: error instanceof Error ? error.message : String(error), ...(error instanceof ApplicationOwnershipError ? { diagnosticAssembly: error.diagnosticAssembly, finalReceiptRevalidated: false } : {}) }));
    process.exitCode = 1;
  }
}
