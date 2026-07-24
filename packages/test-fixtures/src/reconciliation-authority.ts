import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";

const RUNTIME_IMPORT =
  /^[ \t]*import\s+(?!type\b)(?:[^"'`;]*?\bfrom\s+)?["']([^"']+)["'][^;]*;/gm;
const RUNTIME_EXPORT =
  /^[ \t]*export\s+(?!type\b)(?:\*|\{)[^;]*?\bfrom\s+["']([^"']+)["'][^;]*;/gm;

const FORBIDDEN_MODULE_PATHS = [
  /packages\/control-engine\/src\/policy\.ts$/i,
  /(?:^|\/)(?:authorize|authorization)[^/]*(?:\/|\.ts$)/i,
  /(?:^|\/)(?:executor|cutover|delete-runner|patch-application)(?:\/|\.ts$)/i,
  /packages\/app-services\/src\/(?:changes|control|control-queries|target-review)\.ts$/i,
  /packages\/semantic-engine\/src\/(?:store|targets)\.ts$/i,
] as const;

const FORBIDDEN_SOURCE_SYMBOLS = [
  /\b(?:authorize|authorization)[A-Za-z0-9_$]*\b/gi,
  /\bAuthorization[A-Za-z0-9_$]*\b/g,
  /\bALLOW\b/g,
  /\bExecutionState\b/g,
  /\b(?:applyPatch|applyUnifiedPatch|runCutover|runDelete)[A-Za-z0-9_$]*\b/g,
] as const;

export interface ReconciliationAuthorityViolation {
  kind: "module_path" | "source_symbol";
  path: string;
  match: string;
}

export interface ReconciliationAuthorityClosure {
  visitedPaths: readonly string[];
  violations: readonly ReconciliationAuthorityViolation[];
}

export function inspectReconciliationAuthorityClosure(
  repositoryRoot: string,
  entry: string,
): ReconciliationAuthorityClosure {
  const visited = collectImportGraph(repositoryRoot, entry);
  const violations = [...visited]
    .flatMap((path) =>
      findForbiddenReconciliationAuthorityExposures(
        path,
        readFileSync(path, "utf8"),
      )
    )
    .sort((left, right) =>
      compareText(left.path, right.path)
      || compareText(left.kind, right.kind)
      || compareText(left.match, right.match)
    );
  return {
    visitedPaths: [...visited].sort(compareText),
    violations,
  };
}

export function findForbiddenReconciliationAuthorityExposures(
  path: string,
  source: string,
): ReconciliationAuthorityViolation[] {
  const normalizedPath = path.replaceAll("\\", "/");
  const violations: ReconciliationAuthorityViolation[] = [];
  for (const pattern of FORBIDDEN_MODULE_PATHS) {
    const match = normalizedPath.match(pattern)?.[0];
    if (match !== undefined) {
      violations.push({ kind: "module_path", path: normalizedPath, match });
    }
  }
  const uncommented = stripComments(source);
  for (const pattern of FORBIDDEN_SOURCE_SYMBOLS) {
    for (const match of uncommented.matchAll(pattern)) {
      violations.push({
        kind: "source_symbol",
        path: normalizedPath,
        match: match[0],
      });
    }
  }
  return violations.filter(
    (violation, index, all) =>
      all.findIndex((candidate) =>
        candidate.kind === violation.kind
        && candidate.path === violation.path
        && candidate.match === violation.match
      ) === index
  );
}

function collectImportGraph(root: string, entry: string): Set<string> {
  const visited = new Set<string>();
  const visit = (path: string): void => {
    const resolved = resolveModuleFile(path);
    if (visited.has(resolved)) return;
    visited.add(resolved);
    const source = readFileSync(resolved, "utf8");
    for (const specifier of extractRuntimeImportSpecifiers(source)) {
      const target = resolveImport(root, resolved, specifier);
      if (target !== null) visit(target);
    }
  };
  visit(entry);
  return visited;
}

function extractRuntimeImportSpecifiers(source: string): string[] {
  const uncommented = stripComments(source);
  return [
    ...[...uncommented.matchAll(RUNTIME_IMPORT)].map((match) => match[1]!),
    ...[...uncommented.matchAll(RUNTIME_EXPORT)].map((match) => match[1]!),
  ];
}

function resolveImport(
  root: string,
  importer: string,
  specifier: string,
): string | null {
  if (specifier.startsWith("node:") || specifier === "bun:sqlite" || specifier === "zod") {
    return null;
  }
  if (specifier.startsWith(".")) return resolve(dirname(importer), specifier);
  if (!specifier.startsWith("@semantic-context/")) return null;
  const [scope, name, ...subpath] = specifier.split("/");
  const packageRoot = resolve(root, "packages", name!);
  const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
    exports?: Record<string, string> | string;
  };
  const key = subpath.length === 0 ? "." : `./${subpath.join("/")}`;
  const target = typeof manifest.exports === "string"
    ? manifest.exports
    : manifest.exports?.[key];
  if (typeof target !== "string") {
    throw new Error(
      `unresolved workspace export ${scope}/${name}${subpath.length === 0 ? "" : `/${subpath.join("/")}`}`,
    );
  }
  return resolve(packageRoot, target);
}

function resolveModuleFile(path: string): string {
  const candidates = extname(path).length > 0
    ? [path]
    : [`${path}.ts`, join(path, "index.ts")];
  const found = candidates.find(existsSync);
  if (found === undefined) throw new Error(`unresolved runtime import ${path}`);
  return found;
}

function stripComments(source: string): string {
  let result = "";
  let state: "code" | "single" | "double" | "template" | "line" | "block" = "code";
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const current = source[index]!;
    const next = source[index + 1];
    if (state === "line") {
      if (current === "\n" || current === "\r") {
        state = "code";
        result += current;
      } else {
        result += " ";
      }
      continue;
    }
    if (state === "block") {
      if (current === "*" && next === "/") {
        result += "  ";
        index += 1;
        state = "code";
      } else {
        result += current === "\n" || current === "\r" ? current : " ";
      }
      continue;
    }
    if (state === "code") {
      if (current === "/" && next === "/") {
        result += "  ";
        index += 1;
        state = "line";
      } else if (current === "/" && next === "*") {
        result += "  ";
        index += 1;
        state = "block";
      } else {
        result += current;
        if (current === "'") state = "single";
        else if (current === "\"") state = "double";
        else if (current === "`") state = "template";
      }
      continue;
    }
    result += current;
    if (escaped) {
      escaped = false;
    } else if (current === "\\") {
      escaped = true;
    } else if (
      (state === "single" && current === "'")
      || (state === "double" && current === "\"")
      || (state === "template" && current === "`")
    ) {
      state = "code";
    }
  }
  return result;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
