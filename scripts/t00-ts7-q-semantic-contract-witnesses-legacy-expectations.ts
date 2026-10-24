import { helperResult, type NativeExpectation } from "./t00-ts7-q-semantic-contract-witness-types";

const active = ["historical-focal-activation"];
const control = ["historical-focal-control"];

export const legacyExpectations: Record<number, NativeExpectation[]> = {
  50: [helperResult(50, "activate", "alias=f", { kind: "boolean", value: true }, active), helperResult(50, "control", "alias=()=>1", { kind: "boolean", value: false }, control)],
  51: [helperResult(51, "activate", "D", { kind: "node", syntaxKind: "Identifier", text: "Date" }), { kind: "syntax", variant: "activate", syntaxKind: "ObjectLiteralExpression", text: "{valueOf(){return 1}}", minimumCount: 1, alternatives: active }, helperResult(51, "control", "D", { kind: "node", syntaxKind: "Identifier", text: "Date" }), { kind: "syntax", variant: "control", syntaxKind: "NewExpression", text: "new D(1)", minimumCount: 1, alternatives: control }],
  52: [helperResult(52, "activate", "Math.abs=f", { kind: "boolean", value: true }, active), { kind: "syntax", variant: "activate", syntaxKind: "EqualsToken", text: "=", minimumCount: 1 }, helperResult(52, "control", "Math.abs===f", { kind: "boolean", value: false }, control), { kind: "syntax", variant: "control", syntaxKind: "EqualsEqualsEqualsToken", text: "===", minimumCount: 1 }],
  62: [helperResult(62, "activate", "key", { kind: "string", value: "then" }, active), helperResult(62, "control", "key", { kind: "string", value: "plain" }, control)],
  63: [helperResult(63, "activate", "{get(){return 1}}", { kind: "boolean", value: false }, active), helperResult(63, "control", "{value:1}", { kind: "boolean", value: true }, control)],
  64: [helperResult(64, "activate", "f", { kind: "declarations", syntaxKinds: ["BindingElement"], declarationPaths: ["/project/main.ts"] }), { kind: "type", variant: "activate", nodeText: "f", callable: true, alternatives: active }, helperResult(64, "control", "f", { kind: "declarations", syntaxKinds: ["BindingElement"], declarationPaths: ["/project/main.ts"] }), { kind: "type", variant: "control", nodeText: "f", callable: false, constructible: false, alternatives: control }],
  66: [helperResult(66, "activate", "f", { kind: "boolean", value: true }), { kind: "type", variant: "activate", nodeText: "f", callable: true, alternatives: active }, helperResult(66, "control", "f", { kind: "boolean", value: true }), { kind: "type", variant: "control", nodeText: "f", callable: false, constructible: false, alternatives: control }],
  86: [helperResult(86, "activate", "class A{}", { kind: "boolean", value: true }, active), { kind: "symbol-origin", variant: "control", nodeText: "Error", origin: "default-library", alternatives: control }, helperResult(87, "control", "Error", { kind: "boolean", value: false })],
  103: [helperResult(103, "activate", "[key]", { kind: "undefined" }, active), helperResult(103, "control", "[key]", { kind: "string", value: "x" }, control)],
  131: [helperResult(131, "activate", "p[key]", { kind: "string", value: "then" }, active), helperResult(131, "control", "p[key]", { kind: "string", value: "plain" }, control)],
};
