import { parser } from "@lezer/python";

export type PythonMarkerTag =
  | "capability"
  | "invariant"
  | "contract"
  | "risk"
  | "boundedContext"
  | "tag";

export interface PythonMarker {
  tag: PythonMarkerTag;
  slug: string;
  statement?: string;
}

export interface PythonRange {
  /** Zero-based UTF-16 offsets, matching JavaScript string slicing and Lezer positions. */
  startOffset: number;
  endOffset: number;
  /** One-based line and UTF-16 column positions. */
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

export interface PythonSource {
  relPath: string;
  source: string;
}

export interface PythonModule {
  relPath: string;
  range: PythonRange;
}

export interface PythonSymbol {
  name: string;
  kind: "function" | "class";
  relPath: string;
  /** Enclosing named function/class declarations, outermost first. Empty at module scope. */
  scope: string[];
  range: PythonRange;
  markers: PythonMarker[];
}

export interface PythonImportName {
  name: string;
  alias?: string;
}

export interface PythonImport {
  kind: "import" | "from";
  fromRelPath: string;
  module?: string;
  relativeLevel: number;
  names: PythonImportName[];
  range: PythonRange;
}

export type PythonLimitationKind =
  | "parse-error"
  | "star-import"
  | "dynamic-import"
  | "sys-path-mutation"
  | "unresolved-construct";

export interface PythonLimitation {
  kind: PythonLimitationKind;
  relPath: string;
  range: PythonRange;
  detail: string;
}

export interface PythonExtraction {
  modules: PythonModule[];
  symbols: PythonSymbol[];
  imports: PythonImport[];
  limitations: PythonLimitation[];
}

type PythonTree = ReturnType<typeof parser.parse>;
type PythonCursor = ReturnType<PythonTree["cursor"]>;

const MARKER_RE =
  /@(capability|invariant|contract|risk|boundedcontext|tag)[ \t]+([A-Za-z0-9][A-Za-z0-9_-]*)[ \t]*(?::[ \t]*([^\r\n]+))?/gi;

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizedRelPath(input: string): string {
  const normalized = input.replaceAll("\\", "/").replace(/^\.\//, "");
  if (
    normalized.length === 0 ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:\//.test(normalized) ||
    normalized.split("/").includes("..")
  ) {
    throw new Error("Python source relPath must be a non-empty repository-relative path");
  }
  return normalized;
}

function lineStarts(source: string): number[] {
  const starts = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source.charCodeAt(index) === 10) starts.push(index + 1);
  }
  return starts;
}

function lineIndexAt(starts: readonly number[], offset: number): number {
  let low = 0;
  let high = starts.length;
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2);
    if ((starts[middle] ?? 0) <= offset) low = middle;
    else high = middle;
  }
  return low;
}

function rangeOf(
  starts: readonly number[],
  startOffset: number,
  endOffset: number,
): PythonRange {
  const startIndex = lineIndexAt(starts, startOffset);
  const endIndex = lineIndexAt(starts, endOffset);
  return {
    startOffset,
    endOffset,
    startLine: startIndex + 1,
    startColumn: startOffset - (starts[startIndex] ?? 0) + 1,
    endLine: endIndex + 1,
    endColumn: endOffset - (starts[endIndex] ?? 0) + 1,
  };
}

function syntaxRange(
  source: string,
  starts: readonly number[],
  startOffset: number,
  rawEndOffset: number,
): PythonRange {
  let endOffset = rawEndOffset;
  while (endOffset > startOffset && /\s/u.test(source[endOffset - 1] ?? "")) {
    endOffset -= 1;
  }
  return rangeOf(starts, startOffset, endOffset);
}

function forEachNode(cursor: PythonCursor, visit: (cursor: PythonCursor) => void): void {
  while (true) {
    visit(cursor);
    if (cursor.firstChild()) continue;
    while (!cursor.nextSibling()) {
      if (!cursor.parent()) return;
    }
  }
}

/**
 * Enclosing named function/class declarations of a node, outermost first.
 *
 * Two methods with the same name in two different classes (or two nested `def` with the same name)
 * are two symbols, not one: without a scope path they collide on a bare (kind, relPath, name) key
 * once identity no longer includes a source line.
 */
function enclosingPythonScope(node: PythonCursor["node"], source: string): string[] {
  const scope: string[] = [];
  for (let current = node.parent; current !== null; current = current.parent) {
    if (current.name !== "FunctionDefinition" && current.name !== "ClassDefinition") continue;
    const statement = source.slice(current.from, current.to);
    const nameMatch =
      current.name === "FunctionDefinition"
        ? /^(?:async\s+)?def\s+([^\s(:[]+)/u.exec(statement)
        : /^class\s+([^\s(:[]+)/u.exec(statement);
    const name = nameMatch?.[1];
    if (name !== undefined) scope.unshift(name);
  }
  return scope;
}

function parseMarkers(lines: readonly string[], symbolLine: number): PythonMarker[] {
  const expectedIndent = /^([ \t]*)/u.exec(lines[symbolLine - 1] ?? "")?.[1] ?? "";
  const adjacent: string[] = [];
  for (let index = symbolLine - 2; index >= 0; index -= 1) {
    const line = lines[index] ?? "";
    const match = /^([ \t]*)#(.*)$/.exec(line);
    if (match === null || match[1] !== expectedIndent) break;
    adjacent.push(match[2] ?? "");
  }

  const markers: PythonMarker[] = [];
  for (const comment of adjacent.reverse()) {
    MARKER_RE.lastIndex = 0;
    let match = MARKER_RE.exec(comment);
    while (match !== null) {
      const rawTag = match[1];
      const slug = match[2];
      if (rawTag !== undefined && slug !== undefined) {
        const lower = rawTag.toLowerCase();
        const tag: PythonMarkerTag =
          lower === "boundedcontext" ? "boundedContext" : (lower as PythonMarkerTag);
        const statement = match[3]?.trim();
        markers.push({
          tag,
          slug,
          ...(statement !== undefined && statement.length > 0 ? { statement } : {}),
        });
      }
      match = MARKER_RE.exec(comment);
    }
  }
  return markers;
}

const IDENTIFIER = String.raw`[^\s.,()]+`;
const DOTTED_NAME_RE = new RegExp(
  String.raw`^(${IDENTIFIER}(?:\.${IDENTIFIER})*)(?:\s+as\s+(${IDENTIFIER}))?$`,
  "u",
);

function withoutImportTrivia(statement: string): string {
  return statement
    .replace(/\\\r?\n/g, " ")
    .replace(/#[^\r\n]*/g, "")
    .replace(/[\r\n]/g, " ")
    .trim();
}

function parseImportNames(input: string): PythonImportName[] | undefined {
  const names: PythonImportName[] = [];
  const body = input.trim().replace(/^\(/, "").replace(/\)$/, "");
  for (const part of body.split(",")) {
    const candidate = part.trim();
    if (candidate.length === 0) continue;
    const match = DOTTED_NAME_RE.exec(candidate);
    const name = match?.[1];
    if (name === undefined) return undefined;
    const alias = match?.[2];
    names.push({ name, ...(alias !== undefined ? { alias } : {}) });
  }
  return names;
}

function recordImport(
  statement: string,
  relPath: string,
  range: PythonRange,
  imports: PythonImport[],
  limitations: PythonLimitation[],
): void {
  const cleaned = withoutImportTrivia(statement);
  if (cleaned.startsWith("import ")) {
    const names = parseImportNames(cleaned.slice("import ".length));
    if (names === undefined) {
      limitations.push({
        kind: "unresolved-construct",
        relPath,
        range,
        detail: "Static import statement could not be represented",
      });
      return;
    }
    for (const imported of names) {
      imports.push({
        kind: "import",
        fromRelPath: relPath,
        module: imported.name,
        relativeLevel: 0,
        names: [imported],
        range,
      });
    }
    return;
  }

  const fromMatch = /^from\s+([^\s]+)\s+import\s+(.+)$/u.exec(cleaned);
  if (fromMatch === null) {
    limitations.push({
      kind: "unresolved-construct",
      relPath,
      range,
      detail: "Import statement could not be represented",
    });
    return;
  }

  const rawModule = fromMatch[1] ?? "";
  const rawNames = fromMatch[2] ?? "";
  const relativePrefix = /^\.+/.exec(rawModule)?.[0] ?? "";
  const module = rawModule.slice(relativePrefix.length);
  if (rawNames.trim().replace(/^\(/, "").replace(/\)$/, "").trim() === "*") {
    imports.push({
      kind: "from",
      fromRelPath: relPath,
      ...(module.length > 0 ? { module } : {}),
      relativeLevel: relativePrefix.length,
      names: [{ name: "*" }],
      range,
    });
    limitations.push({
      kind: "star-import",
      relPath,
      range,
      detail: "Star imports do not expose deterministic imported names",
    });
    return;
  }

  const names = parseImportNames(rawNames);
  if (names === undefined) {
    limitations.push({
      kind: "unresolved-construct",
      relPath,
      range,
      detail: "From-import names could not be represented",
    });
    return;
  }
  imports.push({
    kind: "from",
    fromRelPath: relPath,
    ...(module.length > 0 ? { module } : {}),
    relativeLevel: relativePrefix.length,
    names,
    range,
  });
}

interface ImportedCallAliases {
  importlibModules: ReadonlySet<string>;
  importModuleFunctions: ReadonlySet<string>;
  sysModules: ReadonlySet<string>;
  sysPathObjects: ReadonlySet<string>;
}

function importedCallAliases(imports: readonly PythonImport[]): ImportedCallAliases {
  const importlibModules = new Set<string>(["importlib"]);
  const importModuleFunctions = new Set<string>();
  const sysModules = new Set<string>(["sys"]);
  const sysPathObjects = new Set<string>();
  for (const imported of imports) {
    for (const name of imported.names) {
      const localName = name.alias ?? name.name;
      if (imported.kind === "import" && name.name.split(".")[0] === "importlib") {
        importlibModules.add(name.alias ?? "importlib");
      } else if (
        imported.kind === "from"
        && imported.module === "importlib"
        && name.name === "import_module"
      ) {
        importModuleFunctions.add(localName);
      } else if (imported.kind === "import" && name.name.split(".")[0] === "sys") {
        sysModules.add(name.alias ?? "sys");
      } else if (
        imported.kind === "from"
        && imported.module === "sys"
        && name.name === "path"
      ) {
        sysPathObjects.add(localName);
      }
    }
  }
  return { importlibModules, importModuleFunctions, sysModules, sysPathObjects };
}

function callLimitation(
  callText: string,
  aliases: ImportedCallAliases,
): Pick<PythonLimitation, "kind" | "detail"> | undefined {
  if (/^__import__\s*\(/u.test(callText)) {
    return {
      kind: "dynamic-import",
      detail: "__import__ calls are dynamic and are not resolved",
    };
  }
  if (/^exec\s*\(/u.test(callText)) {
    return {
      kind: "dynamic-import",
      detail: "exec calls can perform imports that static extraction cannot resolve",
    };
  }
  const callee = /^([^\s(]+)\s*\(/u.exec(callText)?.[1];
  if (
    callee !== undefined
    && (
      aliases.importModuleFunctions.has(callee)
      || [...aliases.importlibModules].some((moduleName) =>
        callee === `${moduleName}.import_module`)
    )
  ) {
    return {
      kind: "dynamic-import",
      detail: "importlib.import_module calls are dynamic and are not resolved",
    };
  }
  if (
    callee !== undefined
    && (
      [...aliases.sysModules].some((moduleName) =>
        new RegExp(`^${escapeRegExp(moduleName)}\\.path\\.(?:append|extend|insert|remove)$`, "u")
          .test(callee))
      || [...aliases.sysPathObjects].some((pathName) =>
        new RegExp(`^${escapeRegExp(pathName)}\\.(?:append|extend|insert|remove)$`, "u")
          .test(callee))
    )
  ) {
    return {
      kind: "sys-path-mutation",
      detail: "sys.path mutation can change import resolution at runtime",
    };
  }
  return undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractOne(file: PythonSource): PythonExtraction {
  const relPath = normalizedRelPath(file.relPath);
  const starts = lineStarts(file.source);
  const lines = file.source.split(/\r?\n/);
  const tree = parser.parse(file.source);
  const symbols: PythonSymbol[] = [];
  const imports: PythonImport[] = [];
  const limitations: PythonLimitation[] = [];
  const calls: Array<{ text: string; range: PythonRange }> = [];
  const parseErrorLines = new Set<number>();

  forEachNode(tree.cursor(), (cursor) => {
    const nodeRange = rangeOf(starts, cursor.from, cursor.to);
    if (cursor.name === "FunctionDefinition" || cursor.name === "ClassDefinition") {
      const symbolRange = syntaxRange(file.source, starts, cursor.from, cursor.to);
      const statement = file.source.slice(cursor.from, cursor.to);
      const nameMatch =
        cursor.name === "FunctionDefinition"
          ? /^(?:async\s+)?def\s+([^\s(:[]+)/u.exec(statement)
          : /^class\s+([^\s(:[]+)/u.exec(statement);
      const name = nameMatch?.[1];
      if (name !== undefined) {
        const parent = cursor.node.parent;
        const markerAnchor =
          parent?.name === "DecoratedStatement"
            ? rangeOf(starts, parent.from, parent.to)
            : nodeRange;
        symbols.push({
          name,
          kind: cursor.name === "FunctionDefinition" ? "function" : "class",
          relPath,
          scope: enclosingPythonScope(cursor.node, file.source),
          range: symbolRange,
          markers: parseMarkers(lines, markerAnchor.startLine),
        });
      }
    } else if (cursor.name === "ImportStatement") {
      recordImport(
        file.source.slice(cursor.from, cursor.to),
        relPath,
        nodeRange,
        imports,
        limitations,
      );
    } else if (cursor.name === "CallExpression") {
      calls.push({
        text: file.source.slice(cursor.from, cursor.to),
        range: nodeRange,
      });
    } else if (cursor.name === "⚠" && !parseErrorLines.has(nodeRange.startLine)) {
      parseErrorLines.add(nodeRange.startLine);
      limitations.push({
        kind: "parse-error",
        relPath,
        range: nodeRange,
        detail: "Lezer reported an error node; extraction for this construct is incomplete",
      });
    }
  });
  const aliases = importedCallAliases(imports);
  for (const callExpression of calls) {
    const call = callLimitation(callExpression.text, aliases);
    if (call !== undefined) {
      limitations.push({ ...call, relPath, range: callExpression.range });
    }
  }
  limitations.sort(
    (left, right) =>
      left.range.startOffset - right.range.startOffset
      || left.range.endOffset - right.range.endOffset
      || compareText(left.kind, right.kind),
  );

  return {
    modules: [{ relPath, range: rangeOf(starts, 0, file.source.length) }],
    symbols,
    imports,
    limitations,
  };
}

export function extractPython(files: readonly PythonSource[]): PythonExtraction {
  const canonicalFiles = files
    .map((file) => ({ ...file, relPath: normalizedRelPath(file.relPath) }))
    .sort(
      (left, right) =>
        compareText(left.relPath, right.relPath) || compareText(left.source, right.source),
    );
  const seen = new Set<string>();
  const result: PythonExtraction = { modules: [], symbols: [], imports: [], limitations: [] };

  for (const file of canonicalFiles) {
    if (seen.has(file.relPath)) {
      throw new Error("Python source relPath values must be unique");
    }
    seen.add(file.relPath);
    const extracted = extractOne(file);
    result.modules.push(...extracted.modules);
    result.symbols.push(...extracted.symbols);
    result.imports.push(...extracted.imports);
    result.limitations.push(...extracted.limitations);
  }
  return result;
}
