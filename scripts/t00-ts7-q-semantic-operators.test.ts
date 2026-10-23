import { expect, test } from "bun:test";
import { projectOperators } from "./t00-ts7-q-semantic-operators";

function unary(operator: string, operandKind = "ObjectLiteralExpression") {
  const operand = { kind: operandKind, start: 1, end: 3, fields: {}, children: [] };
  const expression = { kind: "PrefixUnaryExpression", start: 0, end: 3, operator, fields: { operand }, children: [operand] };
  const statement = { kind: "ExpressionStatement", start: 0, end: 4, fields: { expression }, children: [expression] };
  const source = { kind: "SourceFile", start: 0, end: 4, fields: { statements: [statement] }, children: [statement] };
  return { files: [{ path: "/project/main.ts", nodes: [source, statement, expression, operand] }] };
}

test("numeric coercion rejects object operands and keeps logical negation safe", () => {
  expect(projectOperators(unary("PlusToken"), "/project/main.ts")).toMatchObject({ status: "projected", reasons: ["SOURCE_COERCION_UNSUPPORTED"] });
  expect(projectOperators(unary("ExclamationToken"), "/project/main.ts")).toMatchObject({ status: "projected", reasons: [] });
});

test("unobserved syntax and malformed captures cannot project an empty reason set", () => {
  expect(projectOperators(unary("PlusToken", "CallExpression"), "/project/main.ts").status).toBe("unsupported");
  expect(projectOperators({}, "/project/main.ts").status).toBe("unsupported");
});

type TestNode = { kind: string; start: number; end: number; fields: Record<string, unknown>; children: TestNode[]; [name: string]: unknown };

function syntax(kind: string, start: number, fields: Record<string, unknown> = {}, children: TestNode[] = []): TestNode {
  return { kind, start, end: start + 1, fields, children };
}

function capture(expression: TestNode, declarations: TestNode[] = []) {
  const statement = syntax("ExpressionStatement", 1000, { expression }, [expression]);
  const source = syntax("SourceFile", 0, {}, [...declarations, statement]);
  const nodes: TestNode[] = [];
  const visit = (node: TestNode) => { nodes.push(node); node.children.forEach(visit); };
  visit(source);
  return { files: [{ path: "/project/main.ts", nodes }] };
}

test("leading trivia cannot hide reference directives from the complete reason projection", () => {
  const oracle = unary("PlusToken");
  oracle.files[0]!.nodes[0]!.start = 38;
  expect(projectOperators(oracle, "/project/main.ts")).toMatchObject({ status: "unsupported", gaps: ["LEADING_TRIVIA_OUTSIDE_OPERATOR_DOMAIN"] });
});

function binary(operator: string, leftKind: string, rightKind = "NumericLiteral") {
  const left = syntax(leftKind, 1);
  const right = syntax(rightKind, 3);
  const operatorToken = syntax(operator, 2);
  return capture(syntax("BinaryExpression", 0, { left, right, operatorToken }, [left, operatorToken, right]));
}

test("binary and membership operators use operand facts and strict equality stays safe", () => {
  expect(projectOperators(binary("PlusToken", "ObjectLiteralExpression"), "/project/main.ts").reasons).toEqual(["SOURCE_COERCION_UNSUPPORTED"]);
  expect(projectOperators(binary("InKeyword", "ObjectLiteralExpression", "ObjectLiteralExpression"), "/project/main.ts").reasons).toEqual(["SOURCE_COERCION_UNSUPPORTED"]);
  expect(projectOperators(binary("InKeyword", "NumericLiteral", "ObjectLiteralExpression"), "/project/main.ts").reasons).toEqual([]);
  expect(projectOperators(binary("EqualsEqualsEqualsToken", "ObjectLiteralExpression"), "/project/main.ts").reasons).toEqual([]);
});

test("const aliases follow declaration initializers rather than asserted type text", () => {
  const initializer = syntax("NumericLiteral", 3);
  const name = syntax("Identifier", 2);
  const declaration = syntax("VariableDeclaration", 1, { name, initializer }, [name, initializer]);
  const declarationList = { ...syntax("VariableDeclarationList", 0, {}, [declaration]), flagsBits: 2 };
  const use = { ...syntax("Identifier", 5), symbol: { declarations: [{ path: "/project/main.ts", kind: declaration.kind, start: declaration.start, end: declaration.end }] }, type: { text: "object" } };
  const expression = { ...syntax("PrefixUnaryExpression", 4, { operand: use }, [use]), operator: "PlusToken" };
  expect(projectOperators(capture(expression, [declarationList]), "/project/main.ts").reasons).toEqual([]);
  declarationList.flagsBits = 0;
  expect(projectOperators(capture(expression, [declarationList]), "/project/main.ts").reasons).toEqual(["SOURCE_COERCION_UNSUPPORTED"]);
});

test("unresolved identifiers and missing operator fields refuse instead of fabricating primitive decisions", () => {
  expect(projectOperators(unary("PlusToken", "Identifier"), "/project/main.ts").status).toBe("unsupported");
  const malformed = binary("PlusToken", "NumericLiteral");
  const binaryNode = malformed.files[0]!.nodes.find(node => node.kind === "BinaryExpression")!;
  delete binaryNode.fields.operatorToken;
  expect(projectOperators(malformed, "/project/main.ts").status).toBe("unsupported");
});

test("shared, cyclic and foreign AST references cannot supply successful evidence", () => {
  const shared = binary("PlusToken", "NumericLiteral");
  const root = shared.files[0]!.nodes[0]!;
  root.children.push(shared.files[0]!.nodes.at(-1)!);
  expect(projectOperators(shared, "/project/main.ts").status).toBe("unsupported");
  const cycle = binary("PlusToken", "NumericLiteral");
  cycle.files[0]!.nodes.at(-1)!.children.push(cycle.files[0]!.nodes[0]!);
  expect(projectOperators(cycle, "/project/main.ts").status).toBe("unsupported");
  const foreign = binary("PlusToken", "NumericLiteral");
  foreign.files[0]!.nodes.find(node => node.kind === "BinaryExpression")!.fields.left = syntax("NumericLiteral", 2000);
  expect(projectOperators(foreign, "/project/main.ts").status).toBe("unsupported");
});

test("unknown operators and SDK symbols remain outside the finite projection", () => {
  expect(projectOperators(unary("FutureOperator"), "/project/main.ts").status).toBe("unsupported");
  const external = unary("PlusToken", "Identifier");
  Object.assign(external.files[0]!.nodes.at(-1)!, { symbol: { declarations: [{ path: "/sdk/lib.d.ts", kind: "VariableDeclaration", start: 20, end: 30 }] } });
  expect(projectOperators(external, "/project/main.ts").status).toBe("unsupported");
});

test("operator observations distinguish predicate rejection and prefix/postfix evaluation", () => {
  expect(projectOperators(unary("ExclamationToken"), "/project/main.ts").operators).toEqual([
    { kind: "PrefixUnaryExpression", operator: "ExclamationToken", start: 0, end: 3, numericUnary: false, coercingBinary: false, propertyMembership: false },
  ]);
  const postfix = unary("PlusPlusToken", "NumericLiteral");
  for (const node of postfix.files[0]!.nodes) if (node.kind === "PrefixUnaryExpression") node.kind = "PostfixUnaryExpression";
  expect(projectOperators(postfix, "/project/main.ts").operators?.[0]).toMatchObject({ kind: "PostfixUnaryExpression", numericUnary: true });
});

test("a value-classifying expression with missing children cannot be treated as primitive", () => {
  expect(projectOperators(unary("PlusToken", "VoidExpression"), "/project/main.ts").status).toBe("unsupported");
});
