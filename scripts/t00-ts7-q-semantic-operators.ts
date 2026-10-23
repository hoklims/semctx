export type OperatorProjection = {
  status: "projected" | "unsupported";
  reasons: string[];
  sites: { index: number; expression: string; activation: boolean }[];
  gaps: string[];
  operators?: { kind: string; operator: string; start: number; end: number; numericUnary: boolean; coercingBinary: boolean; propertyMembership: boolean; leftPrimitive?: boolean; rightPrimitive?: boolean }[];
};

type Fact = Record<string, unknown> & { kind: string; start: number; end: number };

const binaryOperators = [
  ["PlusToken", "+"], ["MinusToken", "-"], ["AsteriskToken", "*"], ["SlashToken", "/"],
  ["PercentToken", "%"], ["AsteriskAsteriskToken", "**"], ["LessThanLessThanToken", "<<"],
  ["GreaterThanGreaterThanToken", ">>"], ["GreaterThanGreaterThanGreaterThanToken", ">>>"],
  ["AmpersandToken", "&"], ["BarToken", "|"], ["CaretToken", "^"], ["LessThanToken", "<"],
  ["LessThanEqualsToken", "<="], ["GreaterThanToken", ">"], ["GreaterThanEqualsToken", ">="],
  ["EqualsEqualsToken", "=="], ["ExclamationEqualsToken", "!="], ["PlusEqualsToken", "+="],
  ["MinusEqualsToken", "-="], ["AsteriskEqualsToken", "*="], ["SlashEqualsToken", "/="],
  ["PercentEqualsToken", "%="], ["AsteriskAsteriskEqualsToken", "**="],
  ["LessThanLessThanEqualsToken", "<<="], ["GreaterThanGreaterThanEqualsToken", ">>="],
  ["GreaterThanGreaterThanGreaterThanEqualsToken", ">>>="], ["AmpersandEqualsToken", "&="],
  ["BarEqualsToken", "|="], ["CaretEqualsToken", "^="],
] as const;
const numericOperators = ["PlusToken", "MinusToken", "TildeToken", "PlusPlusToken", "MinusMinusToken"];
const literalKinds = new Set(["NumericLiteral", "BigIntLiteral", "StringLiteral", "NoSubstitutionTemplateLiteral", "TrueKeyword", "FalseKeyword", "NullKeyword"]);
const excludedBinaryOperators = ["EqualsEqualsEqualsToken", "ExclamationEqualsEqualsToken"];
const allowedKinds = new Set([
  "SourceFile", "ExpressionStatement", "EmptyStatement", "EndOfFile", "VariableStatement",
  "VariableDeclarationList", "VariableDeclaration", "Identifier", "ObjectLiteralExpression",
  "ParenthesizedExpression", "BinaryExpression", "PrefixUnaryExpression", "PostfixUnaryExpression",
  "VoidExpression", "TypeOfExpression", "InKeyword", "ExclamationToken", ...literalKinds,
  ...numericOperators, ...binaryOperators.map(([name]) => name), ...excludedBinaryOperators,
]);

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function fact(value: unknown): Fact | undefined {
  const item = record(value);
  return item !== undefined && typeof item.kind === "string" && Number.isInteger(item.start) && Number.isInteger(item.end)
    ? item as Fact : undefined;
}

function key(node: Fact): string {
  return `${node.kind}:${node.start}:${node.end}`;
}

export function projectOperators(oracle: unknown, path: string): OperatorProjection {
  const refused = (gap: string): OperatorProjection => ({ status: "unsupported", reasons: [], sites: [], gaps: [gap] });
  const files = record(oracle)?.files;
  if (!Array.isArray(files)) return refused("ORACLE_FILES_MISSING");
  const matches = files.map(record).filter(file => file?.path === path);
  if (matches.length !== 1) return refused("SOURCE_FILE_NOT_UNIQUE");
  const rawNodes = matches[0]?.nodes;
  if (!Array.isArray(rawNodes) || rawNodes.length === 0) return refused("ORACLE_NODES_MISSING");
  const nodes = rawNodes.map(fact);
  if (nodes.some(node => node === undefined)) return refused("ORACLE_NODE_INVALID");
  const facts = nodes as Fact[];
  const index = new Map(facts.map(node => [key(node), node]));
  if (index.size !== facts.length) return refused("ORACLE_NODE_DUPLICATE");
  const sourceFiles = facts.filter(node => node.kind === "SourceFile");
  if (sourceFiles.length !== 1) return refused("SOURCE_NODE_NOT_UNIQUE");
  if (sourceFiles[0]!.start !== 0) return refused("LEADING_TRIVIA_OUTSIDE_OPERATOR_DOMAIN");
  const parents = new Map<string, Fact>();
  const resolve = (value: unknown): Fact | undefined => {
    const reference = fact(value);
    return reference === undefined ? undefined : index.get(key(reference));
  };
  for (const node of facts) {
    if (!allowedKinds.has(node.kind)) return refused(`SYNTAX_OUTSIDE_OPERATOR_DOMAIN:${node.kind}`);
    if (!Array.isArray(node.children) || record(node.fields) === undefined) return refused(`AST_STRUCTURE_MISSING:${node.kind}`);
    if (node.kind === "ObjectLiteralExpression" && node.children.length !== 0) return refused("NONEMPTY_OBJECT_OUTSIDE_OPERATOR_DOMAIN");
    for (const childRef of node.children) {
      const child = resolve(childRef);
      if (child === undefined || child === node || parents.has(key(child))) return refused("AST_CHILD_INVALID");
      parents.set(key(child), node);
    }
    const declarations = record(node.symbol)?.declarations;
    if (Array.isArray(declarations) && declarations.some(declaration => record(declaration)?.path !== path)) {
      return refused("EXTERNAL_SYMBOL_OUTSIDE_OPERATOR_DOMAIN");
    }
  }
  if (facts.some(node => node.kind !== "SourceFile" && !parents.has(key(node)))) return refused("AST_ORPHAN_NODE");
  const reachable = new Set<string>();
  const pending = [...sourceFiles];
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (reachable.has(key(node))) return refused("AST_CYCLE");
    reachable.add(key(node));
    for (const child of node.children as unknown[]) pending.push(resolve(child)!);
  }
  if (reachable.size !== facts.length) return refused("AST_DISCONNECTED");
  for (const node of facts) {
    if (node.kind !== "Identifier") continue;
    const parent = parents.get(key(node));
    const name = resolve(record(parent?.fields)?.name);
    if (parent?.kind === "VariableDeclaration" && name === node) continue;
    const origins = record(node.symbol)?.declarations;
    if (!Array.isArray(origins) || origins.length === 0 || origins.some(origin => resolve(origin)?.kind !== "VariableDeclaration")) {
      return refused("IDENTIFIER_BINDING_OUTSIDE_OPERATOR_DOMAIN");
    }
  }
  const field = (node: Fact, name: string): Fact | undefined => {
    const child = resolve(record(node.fields)?.[name]);
    return child !== undefined && parents.get(key(child)) === node ? child : undefined;
  };
  let missing: string | undefined;
  const requiredField = (node: Fact, name: string): Fact | undefined => {
    const child = field(node, name);
    if (child === undefined) missing = `AST_FIELD_MISSING:${node.kind}.${name}`;
    return child;
  };
  const requiredFields: Record<string, string[]> = {
    ExpressionStatement: ["expression"], ParenthesizedExpression: ["expression"],
    VoidExpression: ["expression"], TypeOfExpression: ["expression"],
    PrefixUnaryExpression: ["operand"], PostfixUnaryExpression: ["operand"],
    BinaryExpression: ["left", "right", "operatorToken"], VariableDeclaration: ["name"],
    VariableStatement: ["declarationList"],
  };
  for (const node of facts) {
    for (const name of requiredFields[node.kind] ?? []) requiredField(node, name);
    if (node.kind === "VariableDeclarationList" && typeof node.flagsBits !== "number") missing = "DECLARATION_FLAGS_MISSING";
  }
  if (missing !== undefined) return refused(missing);
  const primitive = (node: Fact | undefined, seen = new Set<string>()): boolean => {
    if (node === undefined || seen.has(key(node))) return false;
    const next = new Set(seen).add(key(node));
    if (literalKinds.has(node.kind)) return true;
    if (node.kind === "VoidExpression" || node.kind === "TypeOfExpression") return true;
    if (node.kind === "ParenthesizedExpression") return primitive(requiredField(node, "expression"), next);
    if (node.kind === "PrefixUnaryExpression") {
      if (typeof node.operator !== "string") missing = "UNARY_OPERATOR_MISSING";
      return node.operator === "ExclamationToken" || primitive(requiredField(node, "operand"), next);
    }
    if (node.kind === "BinaryExpression" && requiredField(node, "operatorToken")?.kind === "PlusToken") {
      const left = requiredField(node, "left");
      const right = requiredField(node, "right");
      return primitive(left, next) && primitive(right, next);
    }
    if (node.kind !== "Identifier") return false;
    const origins = record(node.symbol)?.declarations;
    if (!Array.isArray(origins)) return false;
    return origins.some(origin => {
      const declaration = resolve(origin);
      if (declaration?.kind !== "VariableDeclaration") return false;
      const owner = parents.get(key(declaration));
      if (owner?.kind !== "VariableDeclarationList") return false;
      if (typeof owner.flagsBits !== "number") {
        missing = "DECLARATION_FLAGS_MISSING";
        return false;
      }
      return (owner.flagsBits & 2) !== 0 && primitive(field(declaration, "initializer"), next);
    });
  };
  const sites: OperatorProjection["sites"] = [];
  const observe = (owner: number, expressions: string[]) => {
    for (const expression of expressions) {
      if (!sites.some(site => site.index === owner && site.expression === expression)) sites.push({ index: owner, expression, activation: true });
    }
  };
  const reasons = new Set<string>();
  const operators: NonNullable<OperatorProjection["operators"]> = [];
  for (const node of facts) {
    if (node.kind === "PrefixUnaryExpression" || node.kind === "PostfixUnaryExpression") {
      if (typeof node.operator !== "string") return refused("UNARY_OPERATOR_MISSING");
      if (![...numericOperators, "ExclamationToken"].includes(node.operator)) return refused(`UNARY_OPERATOR_OUTSIDE_DOMAIN:${node.operator}`);
      const operand = requiredField(node, "operand");
      operators.push({ kind: node.kind, operator: node.operator, start: node.start, end: node.end, numericUnary: numericOperators.includes(node.operator), coercingBinary: false, propertyMembership: false });
      observe(97, [node.kind === "PrefixUnaryExpression" ? "ts.isPrefixUnaryExpression" : "ts.isPostfixUnaryExpression", ...numericOperators.filter(operator => operator === node.operator).map(operator => `ts.SyntaxKind.${operator}`), "node.operator"]);
      if (numericOperators.includes(node.operator) && !primitive(operand)) reasons.add("SOURCE_COERCION_UNSUPPORTED");
    }
    if (node.kind === "BinaryExpression") {
      const operator = requiredField(node, "operatorToken")?.kind;
      const left = requiredField(node, "left");
      const right = requiredField(node, "right");
      const leftPrimitive = primitive(left);
      const rightPrimitive = primitive(right);
      if (operator !== undefined) operators.push({ kind: node.kind, operator, start: node.start, end: node.end, numericUnary: false, coercingBinary: binaryOperators.some(([name]) => name === operator), propertyMembership: operator === "InKeyword", leftPrimitive, rightPrimitive });
      observe(61, ["ts.isBinaryExpression", ...binaryOperators.filter(([name]) => name === operator).map(([name]) => `ts.SyntaxKind.${name}`), "node.operatorToken.kind", "node.operatorToken"]);
      observe(102, ["ts.isBinaryExpression", ...(operator === "InKeyword" ? ["ts.SyntaxKind.InKeyword"] : []), "node.operatorToken.kind", "node.operatorToken"]);
      if (operator === "InKeyword") {
        if (!leftPrimitive) reasons.add("SOURCE_COERCION_UNSUPPORTED");
      } else if (binaryOperators.some(([name]) => name === operator)) {
        if (!leftPrimitive || !rightPrimitive) reasons.add("SOURCE_COERCION_UNSUPPORTED");
      } else if (operator !== undefined && !excludedBinaryOperators.includes(operator)) return refused(`BINARY_OPERATOR_OUTSIDE_DOMAIN:${operator}`);
    }
  }
  if (missing !== undefined) return refused(missing);
  return { status: "projected", reasons: [...reasons].sort(), sites, gaps: [], operators };
}

export const operatorWitnesses = [
  ...binaryOperators.map(([name, operator]) => ({
    index: 61, expectedKind: "BinaryExpression", controlKind: "BinaryExpression", idSuffix: `operator-${name}`, activationReasons: ["SOURCE_COERCION_UNSUPPORTED"], controlReasons: [], alternatives: [name, "primitive-operands"], expectedOperator: name, controlOperator: name,
    files: { "main.ts": `const value={}; value ${operator} 1;` },
    controlFiles: { "main.ts": `const value=1; value ${operator} 1;` },
  })),
  ...binaryOperators.map(([name, operator]) => ({
    index: 61, expectedKind: "BinaryExpression", controlKind: "BinaryExpression", idSuffix: `right-${name}`, activationReasons: ["SOURCE_COERCION_UNSUPPORTED"], controlReasons: [], alternatives: [name, "nonprimitive-right-operand"], expectedOperator: name, controlOperator: name,
    files: { "main.ts": `const value=1; value ${operator} {};` },
    controlFiles: { "main.ts": `const value=1; value ${operator} 1;` },
  })),
  { index: 61, expectedKind: "BinaryExpression", controlKind: "BinaryExpression", idSuffix: "strict-equality", activationReasons: [], controlReasons: [], alternatives: ["EqualsEqualsEqualsToken", "ExclamationEqualsEqualsToken"], expectedOperator: "EqualsEqualsEqualsToken", controlOperator: "ExclamationEqualsEqualsToken", files: { "main.ts": "const value={}; value === 1;" }, controlFiles: { "main.ts": "const value={}; value !== 1;" } },
  ...([["PlusToken", "+"], ["MinusToken", "-"], ["TildeToken", "~"], ["PlusPlusToken", "++"], ["MinusMinusToken", "--"]] as const).map(([name, operator]) => ({
    index: 97, expectedKind: "PrefixUnaryExpression", controlKind: "PrefixUnaryExpression", idSuffix: `prefix-${name}`, activationReasons: ["SOURCE_COERCION_UNSUPPORTED"], controlReasons: [], alternatives: ["PrefixUnaryExpression", name, "primitive-operand"], expectedOperator: name, controlOperator: name,
    files: { "main.ts": `const value={}; ${operator}value;` }, controlFiles: { "main.ts": `const value=1; ${operator}value;` },
  })),
  ...([["PlusPlusToken", "++"], ["MinusMinusToken", "--"]] as const).map(([name, operator]) => ({
    index: 97, expectedKind: "PostfixUnaryExpression", controlKind: "PostfixUnaryExpression", idSuffix: `postfix-${name}`, activationReasons: ["SOURCE_COERCION_UNSUPPORTED"], controlReasons: [], alternatives: ["PostfixUnaryExpression", name, "primitive-operand"], expectedOperator: name, controlOperator: name,
    files: { "main.ts": `const value={}; value${operator};` }, controlFiles: { "main.ts": `const value=1; value${operator};` },
  })),
  { index: 97, expectedKind: "PrefixUnaryExpression", controlKind: "PrefixUnaryExpression", idSuffix: "logical-negation", activationReasons: [], controlReasons: [], alternatives: ["ExclamationToken"], expectedOperator: "ExclamationToken", controlOperator: "ExclamationToken", files: { "main.ts": "const value={}; !value;" }, controlFiles: { "main.ts": "const value=1; !value;" } },
  { index: 102, expectedKind: "BinaryExpression", controlKind: "BinaryExpression", idSuffix: "membership", activationReasons: ["SOURCE_COERCION_UNSUPPORTED"], controlReasons: [], alternatives: ["InKeyword", "nonprimitive-key", "primitive-key"], expectedOperator: "InKeyword", controlOperator: "InKeyword", files: { "main.ts": "const key={}; key in {};" }, controlFiles: { "main.ts": "const key=1; key in {};" } },
  { index: 102, expectedKind: "BinaryExpression", controlKind: "BinaryExpression", idSuffix: "non-membership", activationReasons: [], controlReasons: [], alternatives: ["EqualsEqualsEqualsToken", "ExclamationEqualsEqualsToken"], expectedOperator: "EqualsEqualsEqualsToken", controlOperator: "ExclamationEqualsEqualsToken", files: { "main.ts": "const key={}; key === {};" }, controlFiles: { "main.ts": "const key={}; key !== {};" } },
];
