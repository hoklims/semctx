import { expect, test } from "bun:test";
import { verifyContractWitness } from "./t00-ts7-q-semantic-contract-witnesses";
import { helperResult, witness } from "./t00-ts7-q-semantic-contract-witness-types";

const node = (text: string) => ({ kind: "node", syntaxKind: "Identifier", text, start: 0, end: text.length, path: "/project/main.ts" });
const oracle = { files: [{ path: "/project/main.ts", nodes: [{ kind: "Identifier", text: "alias", start: 0, end: 5 }] }] };
const scenario = witness(51, "const-alias", "const alias=target;alias();", "let alias=target;alias();", ["const-followed", "let-retained"], [
  helperResult(51, "activate", "alias", { kind: "node", syntaxKind: "Identifier", text: "target" }, ["const-followed"]),
  helperResult(51, "control", "alias", { kind: "node", syntaxKind: "Identifier", text: "alias" }, ["let-retained"]),
]);
const projected = (argument: string, value: unknown) => ({ status: "projected", gaps: [], helperResults: [{ index: 51, arguments: [node(argument)], value }] });

test("matches a helper return at its observed input rather than a scenario label", () => {
  expect(verifyContractWitness(oracle, projected("alias", node("target")), scenario, "activate", "main.ts")).toEqual({ passed: true, gaps: [] });
  expect(verifyContractWitness(oracle, projected("alias", node("alias")), scenario, "control", "main.ts")).toEqual({ passed: true, gaps: [] });
});

test("declared alternatives without executable native assertions cannot pass", () => {
  const native = projected("alias", node("target"));
  expect(verifyContractWitness(oracle, native, { ...scenario, nativeExpectations: [] }, "activate", "main.ts").passed).toBe(false);
  expect(verifyContractWitness(oracle, native, { ...scenario, requiredAlternatives: [...scenario.requiredAlternatives, "missing-cycle"] }, "activate", "main.ts").passed).toBe(false);
  expect(verifyContractWitness(oracle, native, { ...scenario, nativeExpectations: scenario.nativeExpectations.filter(expectation => expectation.variant === "control") }, "activate", "main.ts").passed).toBe(false);
});

test("rejects the expected return observed on another argument or consumer", () => {
  expect(verifyContractWitness(oracle, projected("unrelated", node("target")), scenario, "activate", "main.ts").passed).toBe(false);
  const other = projected("alias", node("target"));
  other.helperResults[0]!.index = 62;
  expect(verifyContractWitness(oracle, other, scenario, "activate", "main.ts").passed).toBe(false);
  const foreign = projected("alias", node("target"));
  foreign.helperResults[0]!.arguments[0]!.path = "/project/other.ts";
  expect(verifyContractWitness(oracle, foreign, scenario, "activate", "main.ts").passed).toBe(false);
  expect(verifyContractWitness(oracle, projected("alias", node("target")), scenario, "control", "main.ts").passed).toBe(false);
});

test("refuses missing or unsupported execution even when labels and expected values are supplied", () => {
  expect(verifyContractWitness(oracle, { ...projected("alias", node("target")), status: "unsupported" }, scenario, "activate", "main.ts").passed).toBe(false);
  expect(verifyContractWitness(oracle, { status: "projected", gaps: [], helperResults: [] }, scenario, "activate", "main.ts").passed).toBe(false);
  expect(verifyContractWitness({ files: [] }, projected("alias", node("target")), scenario, "activate", "main.ts").passed).toBe(false);
});

test("does not turn absent declarations into an observed empty array", () => {
  const empty = witness(64, "missing", "missing();", "known();", ["missing-symbol"], [helperResult(64, "activate", "missing", { kind: "declarations", syntaxKinds: [] }, ["missing-symbol"])]);
  const projection = { status: "projected", gaps: [], helperResults: [{ index: 64, arguments: [node("missing")], value: { kind: "undefined" } as unknown }] };
  expect(verifyContractWitness(oracle, projection, empty, "activate", "main.ts").passed).toBe(false);
  projection.helperResults[0]!.value = { kind: "array", values: [] };
  expect(verifyContractWitness(oracle, projection, empty, "activate", "main.ts").passed).toBe(true);
});

test("requires an actual syntax match at the selected native file", () => {
  const selected = { ...scenario, requiredAlternatives: ["identifier"], nativeExpectations: [{ kind: "syntax" as const, variant: "activate" as const, syntaxKind: "Identifier", text: "alias", minimumCount: 1, alternatives: ["identifier"] }] };
  expect(verifyContractWitness(oracle, projected("alias", node("target")), selected, "activate", "main.ts").passed).toBe(true);
  expect(verifyContractWitness({ files: [{ path: "/project/main.ts", nodes: [{ kind: "StringLiteral", text: "alias" }] }] }, projected("alias", node("target")), selected, "activate", "main.ts").passed).toBe(false);
});

test("does not call mixed or missing declaration origins SDK provenance", () => {
  const selected = { ...scenario, requiredAlternatives: ["sdk-origin"], nativeExpectations: [{ kind: "symbol-origin" as const, variant: "activate" as const, nodeText: "alias", origin: "default-library" as const, alternatives: ["sdk-origin"] }] };
  const native = (origins: unknown[]) => ({ files: [{ path: "/project/main.ts", nodes: [{ kind: "Identifier", text: "alias", symbol: { declarations: origins } }] }] });
  expect(verifyContractWitness(native([{ defaultLibrary: true }]), projected("alias", node("target")), selected, "activate", "main.ts").passed).toBe(true);
  expect(verifyContractWitness(native([{ defaultLibrary: true }, { defaultLibrary: false }]), projected("alias", node("target")), selected, "activate", "main.ts").passed).toBe(false);
  expect(verifyContractWitness(native([]), projected("alias", node("target")), selected, "activate", "main.ts").passed).toBe(false);
  const ambiguous = native([{ defaultLibrary: true }]);
  ambiguous.files[0]!.nodes.push({ kind: "Identifier", text: "alias", symbol: { declarations: [{ defaultLibrary: false }] } });
  expect(verifyContractWitness(ambiguous, projected("alias", node("target")), selected, "activate", "main.ts").passed).toBe(false);
});

test("distinguishes observed noncallability from missing type signature facts", () => {
  const selected = { ...scenario, requiredAlternatives: ["noncallable"], nativeExpectations: [{ kind: "type" as const, variant: "activate" as const, nodeText: "alias", callable: false, constructible: false, alternatives: ["noncallable"] }] };
  const native = (type: unknown) => ({ files: [{ path: "/project/main.ts", nodes: [{ kind: "Identifier", text: "alias", type }] }] });
  expect(verifyContractWitness(native({ callSignatures: [], constructSignatures: [] }), projected("alias", node("target")), selected, "activate", "main.ts").passed).toBe(true);
  expect(verifyContractWitness(native({ text: "Function" }), projected("alias", node("target")), selected, "activate", "main.ts").passed).toBe(false);
  expect(verifyContractWitness(native({ callSignatureCount: 0, constructSignatureCount: 1 }), projected("alias", node("target")), selected, "activate", "main.ts").passed).toBe(false);
});

test("binds secondary source assertions and declaration results to their native file", () => {
  const selected = { ...scenario, requiredAlternatives: ["reexport"], nativeExpectations: [{ kind: "syntax" as const, variant: "activate" as const, syntaxKind: "ExportSpecifier", text: "target as alias", minimumCount: 1, alternatives: ["reexport"], sourcePath: "bridge.ts" }] };
  const bridge = { path: "/project/bridge.ts", nodes: [{ kind: "ExportSpecifier", text: "target as alias", start: 0, end: 15 }] };
  expect(verifyContractWitness({ files: [...oracle.files, bridge] }, projected("alias", node("target")), selected, "activate", "main.ts").passed).toBe(true);
  expect(verifyContractWitness(oracle, projected("alias", node("target")), selected, "activate", "main.ts").passed).toBe(false);
  const declarationWitness = { ...scenario, nativeExpectations: [helperResult(51, "activate", "alias", { kind: "declarations", syntaxKinds: ["FunctionDeclaration"], declarationPaths: ["/project/target.ts"] }, scenario.requiredAlternatives)] };
  const wrong = projected("alias", { kind: "array", values: [{ kind: "node", syntaxKind: "FunctionDeclaration", path: "/project/main.ts" }] });
  expect(verifyContractWitness(oracle, wrong, declarationWitness, "activate", "main.ts").passed).toBe(false);
});

test("SDK helper arguments require the declared origin path", () => {
  const selected = { ...scenario, nativeExpectations: [helperResult(51, "activate", "Date", { kind: "boolean", value: false }, scenario.requiredAlternatives, "/sdk/lib/lib.es5.d.ts")] };
  const result = projected("Date", { kind: "boolean", value: false });
  expect(verifyContractWitness(oracle, result, selected, "activate", "main.ts").passed).toBe(false);
  result.helperResults[0]!.arguments[0]!.path = "/sdk/lib/lib.es5.d.ts";
  expect(verifyContractWitness(oracle, result, selected, "activate", "main.ts").passed).toBe(true);
});
