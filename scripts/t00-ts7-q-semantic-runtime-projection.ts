import { record } from "./t00-ts7-q-semantic-core";

export type RuntimeProjection = {
  reasons: string[] | null;
  missingFacts: string[];
  traces: { rule: string; start: number; end: number }[];
};

const entries = (value: unknown): Record<string, unknown>[] => Array.isArray(value) ? value.map(record) : [];
const key = (value: unknown): string => {
  const node = record(value);
  return `${String(node["kind"])}:${String(node["start"])}:${String(node["end"])}`;
};
const unavailable = (reason: string): RuntimeProjection => ({ reasons: null, missingFacts: [reason], traces: [] });

function nativeStringParameter(signature: unknown): boolean {
  const parameters = entries(record(signature)["parameters"]);
  return record(record(signature)["declaration"])["defaultLibrary"] === true
    && parameters.length === 1 && record(parameters[0]?.["type"])["flagsBits"] === 32;
}

export function projectRuntimeReasons(oracle: unknown, path: string): RuntimeProjection {
  const files = entries(record(oracle)["files"]);
  const file = files.find(value => value["path"] === path || value["path"] === `/project/${path}`);
  if (file === undefined) return unavailable("SOURCE_FILE_FACTS_MISSING");
  const nodes = entries(file["nodes"]);
  const requiredArrays: Record<string, string[]> = {
    SourceFile: ["statements"], Block: ["statements"], FunctionDeclaration: ["parameters", "modifiers"],
    ArrowFunction: ["parameters", "modifiers"], VariableStatement: ["modifiers"],
  };
  if (nodes.some(node => (requiredArrays[String(node["kind"])] ?? []).some(name => !Array.isArray(record(node["fields"])[name])))) {
    return unavailable("STRUCTURAL_ARRAY_FACTS_MISSING");
  }
  const byReference = new Map(nodes.map(node => [key(node), node]));
  const lookup = (value: unknown): Record<string, unknown> => byReference.get(key(value)) ?? {};
  const field = (node: Record<string, unknown>, name: string) => lookup(record(node["fields"])[name]);
  const children = (node: Record<string, unknown>, name: string) => entries(record(node["fields"])[name]).map(lookup);
  const source = nodes.find(node => node["kind"] === "SourceFile");
  if (source === undefined || !Array.isArray(record(source["fields"])["statements"])) return unavailable("SOURCE_STATEMENT_FACTS_MISSING");
  if (source["start"] !== 0 || nodes.some(node => node["kind"] === "AsteriskToken")) return unavailable("SOURCE_TRIVIA_OR_GENERATOR_NOT_PROJECTED");
  const statements = children(source, "statements").filter(node => node["kind"] !== "EmptyStatement");
  if (statements.length === 2 && ["FunctionDeclaration", "VariableStatement"].includes(String(statements[0]?.["kind"]))
    && statements[1]?.["kind"] === "VariableStatement") {
    const owner = statements[0]!;
    const statement = statements[1]!;
    const list = field(statement, "declarationList");
    const declarations = children(list, "declarations");
    const declaration = declarations[0];
    if (declarations.length !== 1 || declaration === undefined || list["flagsBits"] !== 2
      || children(owner, "modifiers").length !== 0 || children(statement, "modifiers").length !== 1
      || children(statement, "modifiers")[0]?.["kind"] !== "ExportKeyword") return unavailable("CONSTRUCTOR_EXPORT_SHAPE_NOT_PROJECTED");
    let ownerDeclaration = owner;
    if (owner["kind"] === "FunctionDeclaration") {
      if (field(owner, "name")["kind"] !== "Identifier" || field(owner, "body")["kind"] !== "Block"
        || children(field(owner, "body"), "statements").length !== 0 || children(owner, "parameters").length !== 0) return unavailable("CONSTRUCTOR_OWNER_NOT_PROJECTED");
    } else {
      const ownerList = field(owner, "declarationList");
      const ownerDeclarations = children(ownerList, "declarations");
      if (ownerList["flagsBits"] !== 2 || ownerDeclarations.length !== 1) return unavailable("CONSTRUCTOR_OWNER_NOT_PROJECTED");
      ownerDeclaration = ownerDeclarations[0]!;
      const initializer = field(ownerDeclaration, "initializer");
      const properties = children(initializer, "properties");
      const property = properties[0];
      const value = property === undefined ? {} : field(property, "initializer");
      if (field(ownerDeclaration, "name")["kind"] !== "Identifier" || initializer["kind"] !== "ObjectLiteralExpression"
        || properties.length !== 1 || property?.["kind"] !== "PropertyAssignment" || field(property, "name")["text"] !== "constructor"
        || value["kind"] !== "ArrowFunction" || children(value, "parameters").length !== 0 || children(value, "modifiers").length !== 0
        || field(value, "body")["kind"] !== "NumericLiteral") return unavailable("CONSTRUCTOR_OWNER_NOT_PROJECTED");
    }
    const name = field(declaration, "name");
    const access = field(declaration, "initializer");
    const receiver = field(access, "expression");
    const member = field(access, "name");
    const receiverOrigins = entries(record(receiver["symbol"])["declarations"]);
    const receiverType = record(receiver["type"]);
    const exportType = record(name["type"]);
    const memberSymbol = record(access["symbol"] ?? access["receiverPropertySymbol"]);
    const memberOrigins = entries(memberSymbol["declarations"]);
    if (name["kind"] !== "Identifier" || access["kind"] !== "PropertyAccessExpression" || member["text"] !== "constructor"
      || receiver["kind"] !== "Identifier" || receiverOrigins.length !== 1
      || receiverOrigins[0]?.["path"] !== file["path"] || key(receiverOrigins[0]) !== key(ownerDeclaration)
      || receiverType["flagsBits"] !== 1048576 || !Array.isArray(receiverType["callSignatures"]) || !Array.isArray(receiverType["constructSignatures"])
      || exportType["flagsBits"] !== 1048576 || !Array.isArray(exportType["callSignatures"])
      || !Array.isArray(exportType["constructSignatures"]) || !Array.isArray(exportType["unionTypes"])
      || !Array.isArray(exportType["intersectionTypes"]) || entries(exportType["unionTypes"]).length !== 0
      || entries(exportType["intersectionTypes"]).length !== 0
      || typeof access["start"] !== "number" || typeof access["end"] !== "number") return unavailable("CONSTRUCTOR_EXPORT_TYPE_FACTS_MISSING");
    const receiverCallable = entries(receiverType["callSignatures"]).length + entries(receiverType["constructSignatures"]).length > 0;
    if (receiverCallable && (memberSymbol["name"] !== "constructor" || !memberOrigins.some(origin => origin["defaultLibrary"] === true
      && origin["parentKind"] === "InterfaceDeclaration" && origin["parentName"] === "Object"))) return unavailable("INTRINSIC_CONSTRUCTOR_ORIGIN_MISSING");
    const reasons = receiverCallable ? ["SOURCE_DYNAMIC_EVALUATION_UNSUPPORTED"] : [];
    if (entries(exportType["callSignatures"]).length + entries(exportType["constructSignatures"]).length > 0) reasons.push("SOURCE_CALLABLE_EXPORT_UNSUPPORTED");
    return { reasons: reasons.sort(), missingFacts: [], traces: [{ rule: "intrinsicConstructor-and-export-call-signatures", start: access["start"], end: access["end"] }] };
  }
  let declaration: Record<string, unknown> | undefined;
  if (statements.length === 2 && statements[0]?.["kind"] === "VariableStatement") {
    const list = field(statements[0], "declarationList");
    const declarations = children(list, "declarations");
    if (!Array.isArray(record(statements[0]["fields"])["modifiers"]) || children(statements[0], "modifiers").length !== 0
      || typeof list["flagsBits"] !== "number" || (list["flagsBits"] & 2) === 0
      || declarations.length !== 1 || field(declarations[0]!, "name")["kind"] !== "Identifier") return unavailable("CONST_ALIAS_FACTS_MISSING");
    declaration = declarations[0];
  } else if (statements.length !== 1) return unavailable("RUNTIME_SOURCE_SHAPE_NOT_PROJECTED");
  const statement = statements.at(-1);
  if (statement?.["kind"] !== "ExpressionStatement") return unavailable("RUNTIME_SOURCE_SHAPE_NOT_PROJECTED");
  const call = field(statement, "expression");
  if (call["kind"] !== "CallExpression") return unavailable("RUNTIME_INVOCATION_NOT_PROJECTED");
  let callee = field(call, "expression");
  const args = children(call, "arguments");
  const aliasReference = (node: Record<string, unknown>): boolean => declaration !== undefined
    && node["kind"] === "Identifier" && entries(record(node["symbol"])["declarations"]).length === 1
    && entries(record(node["symbol"])["declarations"]).every(origin => origin["path"] === file["path"] && key(origin) === key(declaration));
  if (declaration !== undefined && aliasReference(callee)) callee = field(declaration, "initializer");
  else if (declaration !== undefined && callee["kind"] === "Identifier" && record(callee["symbol"])["name"] === "String") {
    const origins = entries(record(callee["symbol"])["declarations"]);
    const initializer = field(declaration, "initializer");
    const memberOrigins = entries(record(initializer["symbol"])["declarations"]);
    const type = record(initializer["type"]);
    const parameters = entries(record(call["signature"])["parameters"]);
    if (origins.length === 0 || !origins.every(origin => origin["defaultLibrary"] === true)
      || args.length !== 1 || !aliasReference(args[0]!)
      || initializer["kind"] !== "PropertyAccessExpression" || field(initializer, "expression")["kind"] !== "MetaProperty"
      || field(initializer, "expression")["text"] !== "import.meta" || field(initializer, "name")["text"] !== "url"
      || type["flagsBits"] !== 32 || !Array.isArray(type["callSignatures"]) || entries(type["callSignatures"]).length !== 0
      || !Array.isArray(type["constructSignatures"]) || entries(type["constructSignatures"]).length !== 0
      || memberOrigins.length === 0 || !memberOrigins.every(origin => origin["kind"] === "PropertySignature")
      || record(record(call["signature"])["declaration"])["defaultLibrary"] !== true
      || parameters.length !== 1 || record(parameters[0]?.["type"])["flagsBits"] !== 1
      || typeof args[0]?.["start"] !== "number" || typeof args[0]?.["end"] !== "number") return unavailable("STRING_IMPORT_META_COERCION_FACTS_MISSING");
    return {
      reasons: ["SOURCE_COERCION_UNSUPPORTED"], missingFacts: [],
      traces: [{ rule: "inspectSdkCoercion:String-argument-not-primitiveValue", start: args[0]["start"], end: args[0]["end"] }],
    };
  } else if (declaration !== undefined) return unavailable("CONST_ALIAS_USE_NOT_PROJECTED");
  const receiver = field(callee, "expression");
  const name = field(callee, "name");
  if (callee["kind"] !== "PropertyAccessExpression" || receiver["kind"] !== "MetaProperty"
    || receiver["text"] !== "import.meta" || name["text"] !== "resolve"
    || args.length !== 1 || args[0]?.["kind"] !== "StringLiteral") return unavailable("RUNTIME_INVOCATION_NOT_PROJECTED");
  const signatures = entries(record(callee["type"])["callSignatures"]);
  if (signatures.length === 0 || !signatures.every(nativeStringParameter) || !nativeStringParameter(call["signature"])) {
    return unavailable("IMPORT_META_CALL_SIGNATURE_FACTS_MISSING");
  }
  if (typeof callee["start"] !== "number" || typeof callee["end"] !== "number") return unavailable("CALLEE_COORDINATES_MISSING");
  return {
    reasons: ["SOURCE_IMPORT_META_CALLABLE_UNSUPPORTED"],
    missingFacts: [],
    traces: [{ rule: "inspectImportMetaMember:callable-import-meta-member", start: callee["start"], end: callee["end"] }],
  };
}
