import { helperResult, type ExpectedHelperResult, type NativeExpectation, type WitnessVariant } from "../t00-ts7-q-semantic-contract-witness-types";

const bool = (index: number, variant: WitnessVariant, argument: string, value: boolean, alternatives: string[]): ReturnType<typeof helperResult> => helperResult(index, variant, argument, { kind: "boolean", value }, alternatives);
const syntax = (variant: WitnessVariant, syntaxKind: string, text: string, alternatives: string[]): NativeExpectation => ({ kind: "syntax", variant, syntaxKind, text, minimumCount: 1, alternatives });
const node = (syntaxKind: string, text: string): ExpectedHelperResult => ({ kind: "node", syntaxKind, text });
const invocation = (variant: WitnessVariant, callee: string, args: ExpectedHelperResult[], alternatives: string[]): NativeExpectation => helperResult(82, variant, {
  kind: "object", properties: { callee: node("PropertyAccessExpression", callee), arguments: { kind: "array", values: args } },
}, { kind: "undefined" }, alternatives);
const normalized = (call: string, alternative: string): NativeExpectation => helperResult(118, "activate", call, {
  kind: "object", properties: { callee: node("PropertyAccessExpression", "Math.abs"), receiver: node("NullKeyword", "null"), arguments: { kind: "array", values: [node("ObjectLiteralExpression", "{}")] } },
}, [alternative]);
const active = ["historical-focal-activation"];
const control = ["historical-focal-control"];

export const assertions: Record<string, NativeExpectation[]> = {
  "69:baseline": [bool(69, "activate", "()=>target()", true, active), bool(69, "control", "()=>1", false, control)],
  "69:baseline-inline-owner-and-unmodeled-property": [bool(69, "activate", "()=>target()", true, active), bool(69, "control", "()=>target()", false, control)],
  "69:ownership-named-method": [bool(69, "activate", "()=>target()", false, ["method-owner-coordinate"]), bool(69, "control", "()=>target()", false, ["property-owner-refused"])],
  "69:ownership-reference-not-invoked": [bool(69, "activate", "()=>target()", true, ["invoked-owned-reference"]), bool(69, "control", "()=>target", false, ["escaping-owned-reference"])],
  "69:ownership-top-level-and-no-reference": [bool(69, "activate", "()=>target()", true, ["module-owner-fallback"]), bool(69, "control", "()=>1", false, ["no-callable-reference-count"])],
  "76:baseline": [helperResult(103, "activate", "then", { kind: "string", value: "then" }, active), bool(100, "activate", "()=>1", false, []), helperResult(103, "control", "plain", { kind: "string", value: "plain" }, control)],
  "79:reflect-set-protocol-primitive": [bool(123, "activate", "Symbol.iterator", true, ["protocol-symbol-always-refused"]), helperResult(62, "control", "'then'", { kind: "string", value: "then" }, ["primitive-then-set"]), bool(100, "control", "1", true, [])],
  "77:baseline": [bool(95, "activate", "{x:x}", false, active), bool(95, "control", "{x:x}", true, control)],
  "77:baseline-shorthand-binding": [helperResult(131, "activate", "process.cwd", { kind: "string", value: "cwd" }, active), helperResult(131, "control", "process.cwd", { kind: "string", value: "cwd" }, control)],
  "77:opaque-native-process-member": [bool(98, "activate", "process.cwd", true, ["ordinary-native-process-member"]), bool(98, "control", "process.unknownMember", true, ["unknown-native-process-member"])],
  "77:opaque-sdk-argument-and-callback": [bool(121, "activate", "Math.abs", true, ["SDK-callable-argument"]), bool(95, "activate", "1", true, ["primitive-argument"]), bool(69, "control", "()=>1", false, ["inline-callback-without-ownership"])],
  "81:baseline": [bool(100, "activate", "()=>1", false, active), bool(100, "control", "undefined", true, control)],
  "81:sdk-callback-constructor-and-iterable": [bool(100, "activate", "()=>{}", false, ["construct-callback-parameter"]), bool(91, "activate", "{[Symbol.iterator](){return null}}", false, ["construct-iterable-parameter"]), bool(91, "control", "[1]", true, ["intrinsic-iterable-argument"])],
  "81:sdk-callback-sdk-value": [bool(121, "activate", "Math.abs", true, ["SDK-callable-callback-value"]), bool(100, "control", "()=>1", false, ["authored-callback-value"])],
  "82:baseline": [bool(100, "activate", "x", false, active), bool(100, "control", "x", true, control)],
  "82:baseline-numeric-rest-index-type": [bool(100, "activate", "{valueOf(){return 1}}", false, active), bool(100, "control", "1", true, control)],
  "82:baseline-shorthand-locale-options": [bool(100, "activate", "style", false, active), bool(100, "control", '"decimal"', true, control)],
  "82:numeric-rest-arguments": [bool(100, "activate", "{valueOf(){return 2}}", false, ["numeric-rest-slice"]), bool(100, "control", "3", true, ["primitive-rest-slice"])],
  "82:numeric-call-bind-and-missing": [normalized("Math.abs.call(null,{})", "call-normalized-numeric-argument"), normalized("Math.abs.bind(null,{})()", "bind-normalized-numeric-argument"), invocation("control", "Math.abs", [], ["numeric-argument-absent"])],
  "82:array-join-separator": [bool(100, "activate", "{toString(){return ','}}", false, ["nonprimitive-join-separator"]), bool(100, "control", "','", true, ["primitive-join-separator"])],
  "82:locale-array-options": [bool(100, "activate", "'en'", true, ["primitive-locale-array"]), bool(100, "control", "{toString(){return 'en'}}", false, ["nonprimitive-locale-array"]), bool(95, "activate", "{style:'decimal'}", true, ["literal-locale-options"])],
  "85:timer-wrapped-and-type-context": [syntax("activate", "AsExpression", "setTimeout as typeof setTimeout", ["wrapped-timer-use"]), bool(132, "activate", "setTimeout", true, []), syntax("control", "TypeQuery", "typeof setTimeout", ["type-position-timer"]), syntax("control", "VariableDeclaration", "value:Timer=setTimeout", ["const-timer-alias"])],
  "92:baseline": [bool(91, "activate", "v", false, active), bool(91, "control", "v", true, control)],
  "92:iterable-parameter-rest-exclusion": [syntax("activate", "CallExpression", "Math.max(1,2)", ["rest-parameter-excluded"]), bool(91, "control", "{ [Symbol.iterator](){return null}}", false, ["SDK-iterable-parameter-included"])],
  "92:iterable-union-parameter": [bool(91, "activate", "{ [Symbol.iterator](){return null}}", false, ["union-iterable-parameter"]), bool(91, "control", "[1]", true, ["intrinsic-iterable-argument"])],
  "134:visitor-type-nodes-and-runtime": [
    { kind: "helper-descendants-absent", variant: "activate", consumerIndex: 134, parent: { nodeText: "interface Value{method():void}", syntaxKind: "InterfaceDeclaration" }, alternatives: ["interface-excluded"] },
    { kind: "helper-descendants-absent", variant: "activate", consumerIndex: 134, parent: { nodeText: "()=>void", syntaxKind: "FunctionType" }, alternatives: ["type-nodes-excluded"] },
    helperResult(134, "control", "value()", { kind: "undefined" }, ["runtime-call-visited"]),
  ],
  "134:visitor-mutation-and-coercion": [{ ...bool(110, "activate", "Math", true, ["SDK-mutation-visited"]), argumentConstraints: [{ position: 1, expected: { kind: "string", value: "abs" } }] }, bool(100, "activate", "value", false, ["coercion-visited"]), bool(123, "activate", "Symbol.iterator", true, ["protocol-write-visited"]), bool(115, "control", "target.plain", false, ["ordinary-write-control"])],
  "134:visitor-construction-and-loader": [helperResult(129, "activate", "Worker", { kind: "symbol", native: { nodeText: "Worker", target: "symbol" }, name: "Worker", defaultLibrary: true }, ["worker-construction"]), helperResult(129, "activate", "Proxy", { kind: "symbol", native: { nodeText: "Proxy", target: "symbol" }, name: "Proxy", defaultLibrary: true }, ["proxy-construction"]), helperResult(134, "activate", "document.write('text')", { kind: "undefined" }, ["document-runtime-code"]), bool(121, "control", "Worker", false, ["local-constructor-control"])],
};

assertions["81:sdk-callback-helper-alternatives"] = [
  helperResult(81, "activate", "[1].map.apply([1],[()=>1])", { kind: "undefined" }, ["apply-callback-helper"]),
  helperResult(81, "activate", "[1].map.bind([1],()=>1)", { kind: "undefined" }, ["bind-callback-helper"]),
  helperResult(81, "control", "[1].map.call([1],undefined)", { kind: "undefined" }, ["call-primitive-callback"]),
];
