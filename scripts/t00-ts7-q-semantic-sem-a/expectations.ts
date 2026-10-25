import { helperResult, type NativeExpectation, type ExpectedHelperResult, type NativeIdentitySelector, type WitnessVariant } from "../t00-ts7-q-semantic-contract-witness-types";

type ExpectedTypeResult = Extract<ExpectedHelperResult, { kind: "type" }>;

const type = (nodeText: string, native: Omit<NativeIdentitySelector, "nodeText" | "target"> = {}, callable = true): ExpectedTypeResult => ({
  kind: "type", native: { nodeText, target: "type", ...native }, callable,
});
const member = (receiver: string): ExpectedTypeResult => type(receiver, {
  steps: [{ op: "property", name: "map" }, { op: "symbolType", location: { nodeText: receiver } }],
});
const callback = (nodeText: string, parameter: number, steps: NonNullable<NativeIdentitySelector["steps"]> = []): ExpectedTypeResult => type(nodeText, {
  steps: [{ op: "callSignature", index: 0 }, { op: "parameter", index: parameter }, { op: "symbolType", location: "signatureDeclaration" }, ...steps],
});
const callbackResult = (variant: WitnessVariant, argument: ExpectedHelperResult, value: boolean, alternatives?: string[]): NativeExpectation => helperResult(59, variant, argument, { kind: "boolean", value }, alternatives);

export const expectations: Record<string, NativeExpectation[]> = {
  "58:baseline": [
    helperResult(58, "activate", "[1].map", member("[1]"), ["historical-focal-activation"]),
    helperResult(58, "control", "[1].map", member("[1]"), ["historical-focal-control"]),
  ],
  "58:member-receiver-alias": [
    helperResult(58, "activate", "alias.map", member("[1]"), ["actual-receiver-property-type"]),
    helperResult(58, "control", "alias.map", member("{map(value){return value}}"), ["local-receiver-property-type"]),
  ],
  "58:element-and-missing-member": [
    helperResult(58, "activate", "receiver['map']", member("[1]"), ["static-element-property"]),
    helperResult(58, "control", "receiver['missing']", { ...type("receiver['missing']", {}, false), flagsNames: ["Any"] }, ["absent-property-type-fallback"]),
  ],
  "58:dynamic-member-name": [
    helperResult(58, "activate", "[1][key]", member("[1]"), ["constant-member-name"]),
    helperResult(58, "control", "[1][key]", { ...type("[1][key]", {}, false), flagsNames: ["Any"] }, ["unknown-member-name-fallback"]),
  ],
  "59:baseline": [
    callbackResult("activate", type("[1]", { steps: [{ op: "property", name: "map" }, { op: "symbolType", location: { nodeText: "[1]" } }, { op: "callSignature", index: 0 }, { op: "parameter", index: 0 }, { op: "symbolType", location: "signatureDeclaration" }] }), true, ["historical-focal-activation"]),
    callbackResult("control", type("[1]", { steps: [{ op: "property", name: "map" }, { op: "symbolType", location: { nodeText: "[1]" } }, { op: "callSignature", index: 0 }, { op: "parameter", index: 0 }, { op: "symbolType", location: "signatureDeclaration" }] }), true, ["historical-focal-control"]),
  ],
  "59:callback-constructor-signature": [
    callbackResult("activate", { ...callback("customElements.define", 1), callable: false, constructible: true }, true, ["construct-signature-callback"]),
    callbackResult("control", { ...callback("Math.abs", 0), callable: false, constructible: false, flagsNames: ["NumberLike"] }, false, ["noncallback-primitive"]),
  ],
  "59:callback-union-intersection": [
    callbackResult("activate", { ...callback("setTimeout", 0), callable: false, union: true }, true, ["union-callback-component"]),
    callbackResult("activate", { ...callback("setTimeout", 0, [{ op: "union", index: 0 }]), callable: false, flagsNames: ["StringLike"] }, false),
    callbackResult("activate", { ...callback("setTimeout", 0, [{ op: "union", index: 1 }]), callable: false, symbol: { kind: "symbol", name: "Function", defaultLibrary: true } }, true),
    callbackResult("control", { ...callback("Object.defineProperty", 2), callable: false, intersection: true }, false, ["intersection-noncallable-components"]),
    ...[0, 1].map(index => callbackResult("control", { ...callback("Object.defineProperty", 2, [{ op: "intersection", index }]), callable: false, constructible: false }, false)),
  ],
  "59:sdk-function-versus-shadow": [
    callbackResult("activate", { ...callback("setTimeout", 0, [{ op: "union", index: 1 }]), callable: false, symbol: { kind: "symbol", name: "Function", defaultLibrary: true } }, true, ["default-library-Function"]),
    callbackResult("control", { ...callback("setTimeout", 0, [{ op: "union", index: 1 }]), callable: false, symbol: { kind: "symbol", name: "Function", declarations: [
      { kind: "node", syntaxKind: "InterfaceDeclaration", path: "/sdk/lib/lib.es5.d.ts", defaultLibrary: true },
      { kind: "node", syntaxKind: "VariableDeclaration", path: "/sdk/lib/lib.es5.d.ts", defaultLibrary: true },
      { kind: "node", syntaxKind: "InterfaceDeclaration", path: "/sdk/lib/lib.es2015.core.d.ts", defaultLibrary: true },
      { kind: "node", syntaxKind: "InterfaceDeclaration", path: "/sdk/lib/lib.es2015.symbol.wellknown.d.ts", defaultLibrary: true },
      { kind: "node", syntaxKind: "InterfaceDeclaration", path: "main.ts", text: "interface Function {tag:string}", defaultLibrary: false },
    ] } }, false, ["mixed-Function-declarations"]),
  ],
};
