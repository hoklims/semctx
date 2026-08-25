import { extractTypeScript } from "./ts-symbols";
import { relative } from "node:path";

interface ExtractionWorkerRequest {
  schemaVersion: 1;
  jobId: string;
  repoRoot: string;
  rootAbsPaths: string[];
  emitAbsPaths: string[];
}

declare const self: Worker;

self.onmessage = (event: MessageEvent<unknown>): void => {
  const request = event.data;
  if (!isRequest(request)) {
    self.postMessage({ schemaVersion: 1, jobId: "unbound", ok: false, error: "malformed extraction request" });
    return;
  }
  try {
    self.postMessage({
      schemaVersion: 1,
      jobId: request.jobId,
      ok: true,
      extraction: restrictToEmitRoots(
        extractTypeScript(request.rootAbsPaths, request.repoRoot),
        request.emitAbsPaths,
        request.repoRoot,
      ),
    });
  } catch (error) {
    self.postMessage({
      schemaVersion: 1,
      jobId: request.jobId,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

function isRequest(value: unknown): value is ExtractionWorkerRequest {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return record["schemaVersion"] === 1
    && typeof record["jobId"] === "string"
    && typeof record["repoRoot"] === "string"
    && Array.isArray(record["rootAbsPaths"])
    && record["rootAbsPaths"].every((path) => typeof path === "string")
    && Array.isArray(record["emitAbsPaths"])
    && record["emitAbsPaths"].every((path) => typeof path === "string");
}

function restrictToEmitRoots(
  extraction: ReturnType<typeof extractTypeScript>,
  emitAbsPaths: readonly string[],
  repoRoot: string,
): ReturnType<typeof extractTypeScript> {
  const emit = new Set(emitAbsPaths.map((path) => relative(repoRoot, path).replaceAll("\\", "/")));
  const local = (path: string | undefined): string | undefined =>
    path !== undefined && !path.startsWith("../") && !path.startsWith("/") ? path : undefined;
  return {
    modules: extraction.modules.filter((path) => emit.has(path)),
    symbols: extraction.symbols.filter((symbol) => emit.has(symbol.relPath)),
    imports: extraction.imports.filter((item) => emit.has(item.fromRelPath)).map((item) => {
      const resolvedRelPath = local(item.resolvedRelPath);
      return {
        fromRelPath: item.fromRelPath,
        moduleSpecifier: item.moduleSpecifier,
        ...(resolvedRelPath === undefined ? {} : { resolvedRelPath }),
        names: item.names,
        line: item.line,
      };
    }),
    calls: extraction.calls.filter((item) => emit.has(item.callerRelPath)).map((item) => {
      const calleeRelPath = local(item.calleeRelPath);
      return {
        callerRelPath: item.callerRelPath,
        ...(item.callerSymbol === undefined ? {} : { callerSymbol: item.callerSymbol }),
        calleeName: item.calleeName,
        ...(calleeRelPath === undefined ? {} : { calleeRelPath }),
        ...(item.calleeSymbol === undefined ? {} : { calleeSymbol: item.calleeSymbol }),
        line: item.line,
      };
    }),
  };
}
