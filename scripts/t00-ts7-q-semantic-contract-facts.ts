import ts from "typescript";
import { createHash } from "node:crypto";
import { types as runtimeTypes } from "node:util";
import { record } from "./t00-ts7-q-semantic-core";

type Fact = Record<string, unknown>;
type NativeFunction = (...args: unknown[]) => unknown;
export type NativeFactQuery = { id: string; file: string; route: unknown; operation: "properties" | "symbolType" | "moduleExports" | "node" | "resolve"; location?: unknown };
export class NativeFactsRequired extends Error {
  readonly queries: NativeFactQuery[];
  constructor(query: NativeFactQuery) { super(`NATIVE_QUERY_REQUIRED:${query.operation}:${query.id}`); this.queries = [query]; }
}
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const nativeList = (value: unknown): unknown[] => Array.isArray(value) ? value : missing("NATIVE_ARRAY_INVALID");
const canonicalPath = (path: string): string => path.startsWith("/") ? path : `/project/${path}`;
const missing = (name: string): never => { throw new Error(name); };
const required = (fact: Fact, field: string, context: string): unknown => field in fact ? fact[field] : missing(`${context}:${field}`);
const nativeNumber = (value: unknown): number => typeof value === "number" && Number.isSafeInteger(value) ? value : missing("NATIVE_INTEGER_INVALID");
const nativeBoolean = (value: unknown): boolean => typeof value === "boolean" ? value : missing("NATIVE_BOOLEAN_INVALID");
const nativeString = (value: unknown): string => typeof value === "string" ? value : missing("NATIVE_STRING_INVALID");
const referenceKey = (fact: Fact): string => `${String(fact["kind"])}:${String(fact["start"])}:${String(fact["end"])}`;
const syntaxKind = (kind: unknown): number => {
  const name = kind === "EndOfFile" ? "EndOfFileToken" : String(kind);
  const value = (ts.SyntaxKind as unknown as Fact)[name];
  return typeof value === "number" ? value : missing(`NATIVE_SYNTAX_KIND_UNSUPPORTED:${name}`);
};

export type ContractFacts = {
  source: Fact;
  checker: Record<string, NativeFunction>;
  program: Fact;
  ts: Fact;
  snapshot: Map<string, string>;
  describe: (value: unknown) => unknown;
};

export function createContractFacts(oracle: unknown, path: string, files: Record<string, string>): ContractFacts {
  const native = record(oracle);
  const capturedFiles = list(native["files"]).map(record);
  const sourceFiles = list(native["sourceFiles"]).map(record);
  const byPath = new Map([...sourceFiles, ...capturedFiles].map(file => [canonicalPath(String(file["path"])), file]));
  for (const file of capturedFiles) {
    const normalized = canonicalPath(String(file["path"]));
    const metadata = { ...sourceFiles.find(source => canonicalPath(String(source["path"])) === normalized), ...file };
    if (normalized !== canonicalPath(path)) delete metadata["nodes"];
    byPath.set(normalized, metadata);
  }
  const contextFile = capturedFiles.find(file => canonicalPath(String(file["path"])) === canonicalPath(path));
  const graph = record(contextFile?.["factsGraph"] ?? native["factsGraph"]);
  if (graph["truncated"] === true) missing("NATIVE_GRAPH_TRUNCATED");
  const queryResults = new Map(list(graph["queryResults"]).map(record).map(result => [String(result["id"]), result]));
  const query = (operation: NativeFactQuery["operation"], fact: Fact, location?: Fact): unknown => {
    const route = fact["route"] ?? (fact["kind"] === undefined ? undefined : { anchor: fact["anchor"] ?? { path: fact["path"], kind: fact["kind"], start: fact["start"], end: fact["end"] }, steps: [] });
    if (route === undefined) return missing(`NATIVE_QUERY_ROUTE_MISSING:${operation}`);
    const payload = { file: canonicalPath(path), route, operation, ...(location === undefined ? {} : { location: location["anchor"] ?? { path: location["path"], kind: location["kind"], start: location["start"], end: location["end"] } }) };
    const id = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
    const result = queryResults.get(id);
    if (result === undefined) throw new NativeFactsRequired({ id, ...payload });
    if ("error" in result) return missing(`NATIVE_QUERY_FAILED:${id}:${String(result["error"])}`);
    const step = record(list(record(route)["steps"]).at(-1))["op"];
    const expectedKind = operation === "node" ? "node" : operation === "symbolType" ? "type"
      : operation === "properties" || operation === "moduleExports" ? "symbols"
        : ["symbol", "shorthandValueSymbol", "aliasTarget", "property", "parameter", "export"].includes(String(step)) ? "symbol"
          : ["type", "symbolType", "numberIndexType", "baseConstraint", "returnType", "union", "intersection"].includes(String(step)) ? "type"
            : ["callSignature", "constructSignature"].includes(String(step)) ? "signature" : "node";
    if (result["kind"] !== expectedKind) return missing(`NATIVE_QUERY_KIND_INVALID:${expectedKind}:${String(result["kind"])}`);
    return required(result, "value", "NATIVE_QUERY_VALUE_MISSING");
  };
  const graphTables = Object.fromEntries(["nodes", "types", "symbols", "signatures"].map(name => [name, new Map(list(graph[name]).map(record).map(value => [String(value["id"]), value]))])) as Record<string, Map<string, Fact>>;
  const resolveGraph = (name: string, value: unknown): Fact => {
    if (typeof value === "string" || typeof value === "number") return graphTables[name]?.get(String(value)) ?? missing(`NATIVE_GRAPH_REFERENCE_MISSING:${name}:${String(value)}`);
    const reference = record(value);
    const id = reference["id"];
    return typeof id === "string" || typeof id === "number" ? graphTables[name]?.get(String(id)) ?? reference : reference;
  };
  const routed = (fact: Fact, step: Fact): Fact => {
    const route = record(fact["route"] ?? { anchor: fact["anchor"] ?? { path: fact["path"], kind: fact["kind"], start: fact["start"], end: fact["end"] }, steps: [] });
    if (record(route["anchor"])["path"] === undefined) return missing("NATIVE_QUERY_ROUTE_MISSING");
    return { ...fact, route: { ...route, steps: [...nativeList(route["steps"]), step] } };
  };
  const nodeValue = (fact: Fact, field: string, label: string): unknown => {
    if (field in fact) return fact[field];
    return required(resolveGraph("nodes", query("node", fact)), field, label);
  };
  const nativeValue = (fact: Fact, fields: string[], step: string): unknown => {
    const present = fields.find(field => field in fact);
    return present === undefined ? query("resolve", routed(fact, { op: step })) : fact[present];
  };
  const rawByObject = new WeakMap<object, Fact>();
  const nodeCache = new Map<string, Fact>();
  const symbolCache = new Map<string, Fact>();
  const typeCache = new Map<string, Fact>();
  const sourceCache = new Map<string, Fact>();
  const nodeFacts = new Map<string, Fact>();
  for (const file of capturedFiles) {
    const filePath = canonicalPath(String(file["path"]));
    const sourceFact = list(file["nodes"]).map(record).find(node => node["kind"] === "SourceFile");
    const text = byPath.get(filePath)?.["text"] ?? sourceFact?.["text"];
    const supplied = files[filePath] ?? files[filePath.replace(/^\/project\//, "")];
    if (supplied !== undefined && text !== supplied) missing(`SOURCE_TEXT_MISMATCH:${filePath}`);
    if (filePath !== canonicalPath(path)) continue;
    for (const value of list(file["nodes"])) {
      const fact = { ...record(value), path: filePath };
      nodeFacts.set(`${filePath}:${referenceKey(fact)}`, fact);
    }
  }
  for (const value of graphTables["nodes"]?.values() ?? []) {
    nodeFacts.set(`${canonicalPath(String(value["path"]))}:${referenceKey(value)}`, value);
  }
  const raw = (value: unknown): Fact => value !== null && typeof value === "object"
    ? rawByObject.get(value) ?? missing("NATIVE_OBJECT_NOT_BOUND") : missing("NATIVE_OBJECT_REQUIRED");
  const sourceBytes = new Map<string, Buffer>();
  const sourcePositions = new Map<string, Map<number, number>>();
  const bytesOfSource = (filePath: string): Buffer | undefined => {
    const cached = sourceBytes.get(filePath);
    if (cached !== undefined) return cached;
    const file = byPath.get(filePath);
    const sourceFact = list(file?.["nodes"]).map(record).find(entry => entry["kind"] === "SourceFile");
    const text = file?.["text"] ?? sourceFact?.["text"];
    if (typeof text !== "string") return undefined;
    const bytes = Buffer.from(text);
    sourceBytes.set(filePath, bytes);
    return bytes;
  };
  const utf16Position = (filePath: string, position: number): number | undefined => {
    const bytes = bytesOfSource(filePath);
    if (bytes === undefined || !Number.isSafeInteger(position) || position < 0 || position > bytes.length) return undefined;
    const positions = sourcePositions.get(filePath) ?? new Map<number, number>();
    const cached = positions.get(position);
    if (cached !== undefined) return cached;
    const prefix = bytes.subarray(0, position).toString("utf8");
    if (Buffer.byteLength(prefix) !== position) return undefined;
    positions.set(position, prefix.length);
    sourcePositions.set(filePath, positions);
    return prefix.length;
  };
  const source = (filePath: string): Fact => {
    const normalized = canonicalPath(filePath);
    const cached = sourceCache.get(normalized);
    if (cached !== undefined) return cached;
    const file = byPath.get(normalized) ?? missing(`NATIVE_SOURCE_MISSING:${normalized}`);
    const fact = list(file["nodes"]).map(record).find(value => value["kind"] === "SourceFile")
      ?? [...graphTables["nodes"]?.values() ?? []].find(value => value["kind"] === "SourceFile" && canonicalPath(String(value["path"])) === normalized)
      ?? (file["sourceNode"] === undefined ? missing(`NATIVE_SOURCE_NODE_MISSING:${normalized}`) : record(file["sourceNode"]));
    const result = node({ ...fact, path: normalized, ...(file["text"] === undefined ? {} : { text: file["text"] }) });
    sourceCache.set(normalized, result);
    return result;
  };
  const node = (value: unknown, parentPath?: string): Fact => {
    const candidate = resolveGraph("nodes", value);
    const nativePath = candidate["path"] ?? parentPath;
    if (typeof nativePath !== "string") return missing("NATIVE_NODE_PATH_MISSING");
    const filePath = canonicalPath(nativePath);
    const cacheKey = `${filePath}:${referenceKey(candidate)}`;
    const cached = nodeCache.get(cacheKey);
    if (cached !== undefined) return cached;
    const fact = { ...candidate, ...nodeFacts.get(cacheKey) };
    if (fact["kind"] === "SourceFile" && byPath.get(filePath)?.["text"] !== undefined) fact["text"] = byPath.get(filePath)!["text"];
    const fields = record(fact["fields"]);
    const file = byPath.get(filePath);
    const utf16 = (field: string): number => {
      const position = required(fact, field, "NATIVE_COORDINATE_MISSING");
      if (typeof position !== "number") return missing("NATIVE_COORDINATE_INVALID");
      const bytes = bytesOfSource(filePath);
      if (bytes === undefined) return missing(`NATIVE_SOURCE_TEXT_MISSING:${filePath}`);
      if (position < 0 || position > bytes.length) return missing("NATIVE_COORDINATE_OUT_OF_RANGE");
      return utf16Position(filePath, position) ?? missing("NATIVE_COORDINATE_SPLITS_CODE_POINT");
    };
    const methods: Fact = {
      getStart: () => utf16("start"),
      getEnd: () => utf16("end"),
      getText: () => required(fact, "text", "NATIVE_TEXT_MISSING"),
      getSourceFile: () => source(filePath),
      getLineAndCharacterOfPosition: (position: number) => {
        const text = String(required(fact, "text", "NATIVE_SOURCE_TEXT_MISSING"));
        const before = text.slice(0, position).split(/\r\n|\r|\n|\u2028|\u2029/u);
        return { line: before.length - 1, character: before.at(-1)!.length };
      },
    };
    const result = new Proxy(methods, {
      get(target, field) {
        if (typeof field !== "string") return undefined;
        if (field in target) return target[field];
        if (field === "kind") return syntaxKind(required(fact, "kind", "NATIVE_KIND_MISSING"));
        if (field === "flags") return nativeNumber(nodeValue({ ...fact, path: filePath }, "flagsBits", "NATIVE_NODE_FLAGS_MISSING"));
        if (field === "pos" || field === "end") return utf16(field);
        if (field === "fileName") return filePath;
        if (field === "text") return nativeString(fact["kind"] === "SourceFile" ? required(fact, "text", "NATIVE_TEXT_MISSING") : required(fact, "literalText", "NATIVE_LITERAL_TEXT_MISSING"));
        if (field === "parent") {
          const parent = nodeValue({ ...fact, path: filePath }, "parent", "NATIVE_PARENT_MISSING");
          return parent === null ? undefined : node(parent, filePath);
        }
        if (field === "referencedFiles") return nativeList(required(file ?? {}, field, "NATIVE_SOURCE_METADATA_MISSING"));
        if (field === "isDeclarationFile") return nativeBoolean(required(file ?? {}, field, "NATIVE_SOURCE_METADATA_MISSING"));
        if (field === "operator") return syntaxKind(required(fact, "operator", "NATIVE_OPERATOR_MISSING"));
        const values = record(fact["syntaxValues"]);
        if (field in values) return field === "keywordToken" || field === "token" ? syntaxKind(values[field]) : nativeBoolean(values[field]);
        if (field in fields) {
          const entry = fields[field];
          return entry === null ? undefined : Array.isArray(entry) ? entry.map(child => node(child, filePath)) : node(entry, filePath);
        }
        const enriched = node(query("node", { ...fact, path: filePath }), filePath);
        return enriched === result ? missing(`NATIVE_NODE_FIELD_MISSING:${String(fact["kind"])}:${field}`) : enriched[field];
      },
      has(_target, field) { return typeof field === "string" && field in fields && fields[field] !== null; },
    });
    nodeCache.set(cacheKey, result);
    rawByObject.set(result, { ...fact, path: filePath });
    return result;
  };
  const symbol = (value: unknown): Fact | undefined => {
    if (value === null) return undefined;
    const fact = resolveGraph("symbols", value);
    const cacheKey = typeof fact["id"] === "string" || typeof fact["id"] === "number" ? String(fact["id"]) : JSON.stringify([fact["name"], fact["flagsBits"], fact["declarations"]]);
    const cached = symbolCache.get(cacheKey);
    if (cached !== undefined) return cached;
    const result: Fact = {
      getName: () => nativeString(required(fact, "name", "NATIVE_SYMBOL_NAME_MISSING")),
      getDeclarations: () => nativeList(required(fact, "declarations", "NATIVE_SYMBOL_DECLARATIONS_MISSING")).map(value => node(value)),
    };
    Object.defineProperty(result, "flags", { get: () => nativeNumber(required(fact, "flagsBits", "NATIVE_SYMBOL_FLAGS_MISSING")) });
    rawByObject.set(result, fact);
    symbolCache.set(cacheKey, result);
    return result;
  };
  const signature = (value: unknown): Fact => {
    const fact = resolveGraph("signatures", value);
    return {
      getDeclaration: () => fact["declaration"] === null ? undefined : node(required(fact, "declaration", "NATIVE_SIGNATURE_DECLARATION_MISSING")),
      getParameters: () => nativeList(required(fact, "parameters", "NATIVE_SIGNATURE_PARAMETERS_MISSING")).map(symbol),
    };
  };
  const type = (value: unknown): Fact => {
    if (value === undefined || value === null) return missing("NATIVE_TYPE_MISSING");
    const fact = resolveGraph("types", value);
    const id = fact["id"];
    const cacheKey = id === undefined ? JSON.stringify(fact) : typeof id === "string" || typeof id === "number" ? String(id) : missing("NATIVE_TYPE_ID_INVALID");
    const cached = typeCache.get(cacheKey);
    if (cached !== undefined) return cached;
    const components = () => [...nativeList(required(fact, "unionTypes", "NATIVE_UNION_TYPES_MISSING")), ...nativeList(required(fact, "intersectionTypes", "NATIVE_INTERSECTION_TYPES_MISSING"))];
    const result: Fact = {
      getCallSignatures: () => nativeList(required(fact, "callSignatures", "NATIVE_CALL_SIGNATURES_MISSING")).map(signature),
      getConstructSignatures: () => nativeList(required(fact, "constructSignatures", "NATIVE_CONSTRUCT_SIGNATURES_MISSING")).map(signature),
      getProperties: () => nativeList("properties" in fact ? fact["properties"] : query("properties", fact)).map(symbol),
      getNumberIndexType: () => fact["numberIndexType"] === null ? undefined : type(required(fact, "numberIndexType", "NATIVE_NUMBER_INDEX_MISSING")),
      getSymbol: () => symbol(required(fact, "symbol", "NATIVE_TYPE_SYMBOL_MISSING")),
      isUnion: () => (nativeNumber(required(fact, "flagsBits", "NATIVE_TYPE_FLAGS_MISSING")) & nativeNumber(required(record(constants["typeFlags"]), "Union", "NATIVE_TYPE_CONSTANT_MISSING"))) !== 0,
      isIntersection: () => (nativeNumber(required(fact, "flagsBits", "NATIVE_TYPE_FLAGS_MISSING")) & nativeNumber(required(record(constants["typeFlags"]), "Intersection", "NATIVE_TYPE_CONSTANT_MISSING"))) !== 0,
      isUnionOrIntersection: () => (nativeNumber(required(fact, "flagsBits", "NATIVE_TYPE_FLAGS_MISSING")) & (nativeNumber(required(record(constants["typeFlags"]), "Union", "NATIVE_TYPE_CONSTANT_MISSING")) | nativeNumber(required(record(constants["typeFlags"]), "Intersection", "NATIVE_TYPE_CONSTANT_MISSING")))) !== 0,
    };
    Object.defineProperties(result, {
      flags: { get: () => nativeNumber(required(fact, "flagsBits", "NATIVE_TYPE_FLAGS_MISSING")) },
      types: { get: () => components().map(type) },
    });
    typeCache.set(cacheKey, result);
    rawByObject.set(result, fact);
    return result;
  };
  const checker: Record<string, NativeFunction> = {
    getSymbolAtLocation: value => symbol(nativeValue(raw(value), ["symbolId", "symbol"], "symbol")),
    getTypeAtLocation: value => type(nativeValue(raw(value), ["typeId", "type"], "type")),
    getAliasedSymbol: value => symbol(nativeValue(raw(value), ["aliasTarget"], "aliasTarget")),
    getExportsOfModule: value => nativeList("exports" in raw(value) ? raw(value)["exports"] : query("moduleExports", raw(value))).map(symbol),
    getTypeOfSymbolAtLocation: (value, location) => {
      const symbolFact = raw(value);
      const locationFact = raw(location);
      const locationAnchor = record(locationFact["anchor"] ?? locationFact);
      const observed = list(graph["symbolTypes"]).map(record).find(entry => entry["symbolId"] === symbolFact["id"]
        && ["path", "kind", "start", "end"].every(field => record(entry["location"])[field] === locationAnchor[field]));
      return type(observed === undefined ? query("symbolType", symbolFact, locationFact) : required(observed, "typeId", "NATIVE_SYMBOL_TYPE_MISSING"));
    },
    getPropertyOfType: (value, name) => {
      if (typeof name !== "string") return missing("NATIVE_PROPERTY_NAME_INVALID");
      const observed = list(graph["propertyLookups"]).map(record).find(entry => entry["typeId"] === raw(value)["id"] && entry["name"] === name);
      return symbol(observed === undefined ? query("resolve", routed(raw(value), { op: "property", name })) : required(observed, "symbolId", "NATIVE_PROPERTY_SYMBOL_MISSING"));
    },
    getBaseConstraintOfType: value => {
      const constraint = nativeValue(raw(value), ["baseConstraint"], "baseConstraint");
      return constraint === null ? undefined : type(constraint);
    },
    getShorthandAssignmentValueSymbol: value => symbol(nativeValue(raw(value), ["shorthandValueSymbolId", "shorthandValueSymbol"], "shorthandValueSymbol")),
  };
  const program: Fact = {
    getSourceFile: (filePath: string) => byPath.has(canonicalPath(filePath)) ? source(filePath) : undefined,
    getTypeChecker: () => checker,
    isSourceFileDefaultLibrary: (value: unknown) => {
      const fact = raw(value);
      return nativeBoolean(required(byPath.get(canonicalPath(String(fact["path"]))) ?? fact, "defaultLibrary", "NATIVE_DEFAULT_LIBRARY_MISSING"));
    },
  };
  const constants = record(native["compilerConstants"]);
  const nativeTs = new Proxy<Fact>({
    SyntaxKind: ts.SyntaxKind,
    sys: { get useCaseSensitiveFileNames() { return nativeBoolean(required(constants, "useCaseSensitiveFileNames", "NATIVE_HOST_CASE_SENSITIVITY_MISSING")); } },
    TypeFlags: new Proxy(record(constants["typeFlags"]), { get: (target, field) => nativeNumber(required(target, String(field), "NATIVE_TYPE_CONSTANT_MISSING")) }),
    SymbolFlags: new Proxy(record(constants["symbolFlags"]), { get: (target, field) => nativeNumber(required(target, String(field), "NATIVE_SYMBOL_CONSTANT_MISSING")) }),
    ModifierFlags: new Proxy(record(constants["modifierFlags"]), { get: (target, field) => nativeNumber(required(target, String(field), "NATIVE_MODIFIER_CONSTANT_MISSING")) }),
    getCombinedModifierFlags: (value: unknown) => nativeNumber(nodeValue(raw(value), "modifierFlagsBits", "NATIVE_MODIFIER_FLAGS_MISSING")),
    isIntrinsicJsxName: (value: unknown) => {
      const name = nativeString(value);
      return nativeBoolean(required(record(native["intrinsicJsxNames"]), name, "NATIVE_JSX_NAME_MISSING"));
    },
    NodeFlags: new Proxy(record(constants["nodeFlags"]), { get: (target, field) => nativeNumber(required(target, String(field), "NATIVE_NODE_CONSTANT_MISSING")) }),
    forEachChild: (value: unknown, callback: NativeFunction) => {
      const fact = raw(value);
      for (const child of nativeList(nodeValue(fact, "children", "NATIVE_CHILDREN_MISSING"))) {
        const result = callback(node(child, String(fact["path"])));
        if (result) return result;
      }
      return undefined;
    },
    getModifiers: (value: unknown) => nativeList(required(record(nodeValue(raw(value), "fields", "NATIVE_FIELDS_MISSING")), "modifiers", "NATIVE_MODIFIERS_MISSING")).map(entry => node(entry, String(raw(value)["path"]))),
  }, {
    get(target, field) {
      if (typeof field !== "string") return undefined;
      if (field in target) return target[field];
      if (["isTypeNode", "isFunctionLike", "isClassLike", "isExpression", "canHaveModifiers", "isStringLiteralLike"].includes(field)) {
        return (value: unknown) => nativeBoolean(nodeValue(raw(value), field, "NATIVE_PREDICATE_MISSING"));
      }
      if (field.startsWith("is")) {
        const kind = ({ isGetAccessorDeclaration: "GetAccessor", isSetAccessorDeclaration: "SetAccessor", isConstructorDeclaration: "Constructor" } as Record<string, string>)[field] ?? field.slice(2);
        if (typeof (ts.SyntaxKind as unknown as Fact)[kind] !== "number") return missing(`NATIVE_PREDICATE_UNSUPPORTED:${field}`);
        return (value: unknown) => value !== undefined && value !== null && raw(value)["kind"] === kind;
      }
      return missing(`NATIVE_API_UNSUPPORTED:${field}`);
    },
  });
  const describe = (value: unknown): unknown => {
    const seenObjects = new Set<object>();
    const seenFacts = new Set<Fact>();
    let remaining = 1024;
    const unavailable = (reason: string): Fact => ({ kind: "unavailable", reason });
    const capturedReference = (table: string, value: unknown): Fact | undefined => {
      if (value === null || value === undefined) return undefined;
      if (typeof value === "string" || typeof value === "number") return graphTables[table]?.get(String(value));
      const reference = record(value);
      const id = reference["id"];
      return typeof id === "string" || typeof id === "number" ? graphTables[table]?.get(String(id)) ?? reference : reference;
    };
    const array = (values: unknown[], visit: (entry: unknown) => unknown): unknown => values.length > 256
      ? unavailable("DESCRIPTION_ARRAY_LIMIT") : values.map(visit);
    const nativeDescription = (kind: "node" | "symbol" | "type", fact: Fact | undefined, depth: number): unknown => {
      if (fact === undefined) return unavailable("NATIVE_FACT_NOT_CAPTURED");
      if (depth > 8 || --remaining < 0) return unavailable("DESCRIPTION_LIMIT");
      if (seenFacts.has(fact)) return unavailable("DESCRIPTION_CYCLE");
      seenFacts.add(fact);
      const result: Fact = { kind, checkerFile: canonicalPath(path) };
      for (const [output, input] of [["nativeId", "id"], ["route", "route"], ["anchor", "anchor"], ["flagsBits", "flagsBits"]]) {
        if (input! in fact) result[output!] = fact[input!];
      }
      if (fact["kind"] !== "SourceFile" && typeof fact["text"] === "string" && fact["text"].length <= 1024) result["text"] = fact["text"];
      const reference = (table: string, childKind: typeof kind, value: unknown): unknown => value === null
        ? { kind: "undefined" } : nativeDescription(childKind, capturedReference(table, value), depth + 1);
      if (kind === "node") {
        result["syntaxKind"] = fact["kind"];
        const anchor = record(fact["anchor"] ?? fact);
        const filePath = fact["path"] ?? anchor["path"];
        if (typeof filePath === "string") result["path"] = filePath;
        const file = typeof filePath === "string" ? byPath.get(canonicalPath(filePath)) : undefined;
        const bytes = typeof filePath === "string" ? bytesOfSource(canonicalPath(filePath)) : undefined;
        if (fact["kind"] === "SourceFile" && bytes !== undefined) result["byteLength"] = bytes.length;
        for (const [input, output] of [["start", "nativeByteStart"], ["end", "nativeByteEnd"]]) {
          const coordinate = fact[input!] ?? anchor[input!];
          if (typeof coordinate !== "number") continue;
          result[output!] = coordinate;
          if (bytes === undefined || typeof filePath !== "string") continue;
          const position = utf16Position(canonicalPath(filePath), coordinate);
          if (position === undefined) return unavailable("NATIVE_COORDINATE_INVALID");
          result[input!] = position;
        }
        if (typeof fact["literalText"] === "string") result["literalText"] = fact["literalText"];
        const defaultLibrary = fact["defaultLibrary"] ?? file?.["defaultLibrary"];
        if (typeof defaultLibrary === "boolean") result["defaultLibrary"] = defaultLibrary;
        const fields = record(fact["fields"]);
        if ("dotDotDotToken" in fields) result["rest"] = fields["dotDotDotToken"] !== null;
      } else if (kind === "symbol") {
        if ("name" in fact) result["name"] = fact["name"];
        if (Array.isArray(fact["declarations"])) result["declarations"] = array(fact["declarations"], value => reference("nodes", "node", value));
      } else if (kind === "type") {
        if (typeof fact["flagsBits"] === "number" && "typeFlags" in constants) {
          const flags = fact["flagsBits"];
          result["flagsNames"] = Object.entries(record(constants["typeFlags"])).filter(([, mask]) => typeof mask === "number" && mask !== 0 && (flags & mask) !== 0).map(([name]) => name).sort();
        }
        for (const [field, count] of [["callSignatures", "callSignatureCount"], ["constructSignatures", "constructSignatureCount"]]) {
          const signatures = fact[field!];
          if (Array.isArray(signatures)) result[count!] = signatures.length;
          else if (typeof fact[count!] === "number") result[count!] = fact[count!];
        }
        for (const field of ["unionTypes", "intersectionTypes"]) {
          if (Array.isArray(fact[field])) result[field] = array(fact[field], value => reference("types", "type", value));
        }
        if ("baseConstraint" in fact) {
          result["baseConstraintPresent"] = fact["baseConstraint"] !== null;
          if (fact["baseConstraint"] !== null) result["baseConstraint"] = reference("types", "type", fact["baseConstraint"]);
        }
        if ("symbol" in fact) result["symbol"] = reference("symbols", "symbol", fact["symbol"]);
        if (Array.isArray(fact["properties"])) result["properties"] = array(fact["properties"], value => reference("symbols", "symbol", value));
      }
      seenFacts.delete(fact);
      return result;
    };
    const visit = (value: unknown, depth: number): unknown => {
      if (depth > 8 || --remaining < 0) return unavailable("DESCRIPTION_LIMIT");
      if (value === undefined) return { kind: "undefined" };
      if (typeof value === "function") return { kind: "function" };
      if (value === null || typeof value !== "object") return { kind: typeof value, value };
      const fact = rawByObject.get(value);
      if (fact !== undefined) return nativeDescription(fact["kind"] !== undefined ? "node" : fact["name"] !== undefined ? "symbol" : "type", fact, depth);
      if (runtimeTypes.isProxy(value)) return unavailable("UNBOUND_PROXY");
      if (seenObjects.has(value)) return unavailable("DESCRIPTION_CYCLE");
      seenObjects.add(value);
      let result: unknown;
      if (Array.isArray(value)) {
        result = value.length > 256 ? unavailable("DESCRIPTION_ARRAY_LIMIT") : { kind: "array", values: Array.from({ length: value.length }, (_, index) => {
          const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
          return descriptor === undefined ? unavailable("ARRAY_HOLE") : "value" in descriptor ? visit(descriptor.value, depth + 1) : unavailable("ACCESSOR_PROPERTY");
        }) };
      } else {
        const prototype: unknown = Object.getPrototypeOf(value);
        if (prototype !== null && Object.getPrototypeOf(prototype) !== null) result = unavailable("NON_PLAIN_OBJECT");
        else result = { kind: "object", properties: Object.fromEntries(Object.entries(Object.getOwnPropertyDescriptors(value)).map(([key, descriptor]) => [key, "value" in descriptor ? visit(descriptor.value, depth + 1) : unavailable("ACCESSOR_PROPERTY")])) };
      }
      seenObjects.delete(value);
      return result;
    };
    return visit(value, 0);
  };
  return { source: source(path), checker, program, ts: nativeTs, snapshot: new Map(Object.entries(files).map(([filePath, text]) => [canonicalPath(filePath), text])), describe };
}
