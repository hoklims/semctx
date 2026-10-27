import { helperResult, type ContractWitness, type ExpectedHelperResult, type NativeExpectation, type NativeIdentitySelector, type NativeIdentityStep, type WitnessVariant } from "../t00-ts7-q-semantic-contract-witness-types";

const boolean = (value: boolean): ExpectedHelperResult => ({ kind: "boolean", value });
const nativeType = (nodeText: string, syntaxKind = "Identifier", steps: NativeIdentitySelector["steps"] = []): Extract<ExpectedHelperResult, { kind: "type" }> => ({
  kind: "type", native: { nodeText, syntaxKind, target: "type", steps },
});
const nativeSymbol = (nodeText: string): ExpectedHelperResult => ({ kind: "symbol", native: { nodeText, syntaxKind: "Identifier", target: "symbol" } });
const absent: ExpectedHelperResult = { kind: "undefined" };
const result = (index: number, variant: WitnessVariant, argument: string | ExpectedHelperResult, expected: ExpectedHelperResult, alternatives: string[]): ReturnType<typeof helperResult> => helperResult(index, variant, argument, expected, alternatives);
const typeResult = (index: number, variant: WitnessVariant, nodeText: string, value: boolean, alternatives: string[], syntaxKind = "Identifier"): NativeExpectation => result(index, variant, nativeType(nodeText, syntaxKind), boolean(value), alternatives);
const symbolResult = (index: number, variant: WitnessVariant, nodeText: string, value: boolean, alternatives: string[]): NativeExpectation => result(index, variant, nativeSymbol(nodeText), boolean(value), alternatives);
const declarationResult = (index: number, variant: WitnessVariant, nodeText: string, syntaxKind: string, defaultLibrary: boolean, alternatives: string[]): NativeExpectation => result(index, variant, {
  kind: "array", values: [{ kind: "node", syntaxKind, text: nodeText, defaultLibrary }],
}, boolean(defaultLibrary), alternatives);

const sdkOrigins = (name: "Math" | "Date"): ExpectedHelperResult => ({ kind: "array", values: (name === "Math" ? [
  ["InterfaceDeclaration", "lib.es5.d.ts"], ["VariableDeclaration", "lib.es5.d.ts"], ["InterfaceDeclaration", "lib.es2015.core.d.ts"], ["InterfaceDeclaration", "lib.es2015.symbol.wellknown.d.ts"],
] : [
  ["InterfaceDeclaration", "lib.es5.d.ts"], ["VariableDeclaration", "lib.es5.d.ts"], ["InterfaceDeclaration", "lib.es5.d.ts"], ["InterfaceDeclaration", "lib.scripthost.d.ts"], ["InterfaceDeclaration", "lib.es2015.symbol.wellknown.d.ts"], ["InterfaceDeclaration", "lib.es2020.date.d.ts"],
]).map(([syntaxKind, file]) => ({ kind: "node", syntaxKind: syntaxKind!, path: "/sdk/lib/" + file!, defaultLibrary: true })) });
const namedResult = (index: number, variant: WitnessVariant, argument: string, value: boolean, names: string[], alternatives: string[]): NativeExpectation => ({ ...result(index, variant, argument, boolean(value), alternatives), argumentConstraints: names.map((value, position) => ({ position: position + 1, expected: { kind: "string", value } })) });

const parameterType = (callee: string, construct: boolean, signature: number, parameter: number): Extract<ExpectedHelperResult, { kind: "type" }> => nativeType(callee, construct ? "Identifier" : "PropertyAccessExpression", [
  { op: construct ? "constructSignature" : "callSignature", index: signature },
  { op: "parameter", index: parameter },
  { op: "symbolType", location: "signatureDeclaration" },
]);

function expectations(witness: ContractWitness): NativeExpectation[] | undefined {
  const { index, idSuffix, requiredAlternatives: alternatives } = witness;
  const active = [alternatives[0]!], control = [alternatives[1]!];
  if (index === 93) {
    const from = idSuffix === "iterable-union-sdk-parameter" || idSuffix === "iterable-nonsdk-protocol";
    const promise = idSuffix === "iterable-constraint-promise-all";
    const callee = from ? "Array.from" : promise ? "Promise.all" : "Set";
    const signature = idSuffix === "iterable-union-sdk-parameter" ? 2 : promise ? 1 : 0;
    const parameter = parameterType(callee, !from && !promise, signature, 0);
    const assertions = (["activate", "control"] as const).map((variant, position) => result(index, variant, parameter, boolean(idSuffix !== "iterable-nonsdk-protocol"), [alternatives[position]!]));
    if (idSuffix === "iterable-union-sdk-parameter" || promise) {
      const step: NativeIdentityStep = promise ? { op: "baseConstraint" } : { op: "union", index: 1 };
      const component = { ...parameter, native: { ...parameter.native!, steps: [...parameter.native!.steps!, step] } };
      for (const variant of ["activate", "control"] as const) assertions.push(result(index, variant, component, boolean(true), []));
      if (idSuffix === "iterable-union-sdk-parameter") parameter.union = true;
      if (promise) { parameter.flagsNames = ["TypeParameter"]; parameter.baseConstraintPresent = true; }
    }
    if (idSuffix !== "iterable-nonsdk-protocol") {
      assertions.push(result(91, "activate", idSuffix === "baseline" ? "v" : "values", boolean(false), []));
      assertions.push(result(91, "control", idSuffix === "baseline" ? "v" : "[1]", boolean(true), []));
    }
    return assertions;
  }
  if (index === 112) {
    const date = idSuffix === "callback-dictionary-date-copy";
    const parameter = parameterType(date ? "Date" : "ReadableStream", true, date ? 1 : 0, 0);
    const assertions = (["activate", "control"] as const).map((variant, position) => result(index, variant, parameter, boolean(!date), [alternatives[position]!]));
    if (!date) {
      parameter.symbol = { kind: "symbol", name: "UnderlyingByteSource", defaultLibrary: true };
      const callback = { kind: "type" as const, callable: true, native: { nodeText: "cancel", sourcePath: "/sdk/lib/lib.dom.d.ts", syntaxKind: "Identifier", nativeByteStart: 74696, nativeByteEnd: 74702, target: "type" as const } };
      for (const variant of ["activate", "control"] as const) assertions.push(result(59, variant, callback, boolean(true), []));
    }
    return assertions;
  }
  if (index === 99) {
    if (idSuffix === "baseline") return [typeResult(index, "activate", "f", true, active), typeResult(index, "control", "f", false, control)];
    if (idSuffix.startsWith("potentially-callable-")) return [typeResult(index, "activate", "value", true, active), typeResult(index, "control", "value", false, control)];
    if (idSuffix === "generic-type-parameter") return [typeResult(index, "activate", "value", true, active), typeResult(index, "control", "value", false, control)];
  }
  if (index === 113) {
    const construct = idSuffix === "callback-signature-construct-helper";
    const target = construct ? "Promise" : "[1].map";
    return [typeResult(index, "activate", target, true, active, construct ? "Identifier" : "PropertyAccessExpression"), typeResult(index, "control", idSuffix === "baseline" ? "[1].at" : target, idSuffix !== "baseline" && !construct, control, construct ? "Identifier" : "PropertyAccessExpression")];
  }
  if (index === 114) {
    const unknown = idSuffix === "sdk-construction-absent-symbol";
    const name = unknown ? "UnknownConstructor" : idSuffix === "baseline" ? "Set" : "Date";
    return [unknown ? result(index, "activate", absent, boolean(false), active) : symbolResult(index, "activate", name, true, active), idSuffix === "sdk-construction-runtime-shadow" ? result(index, "control", absent, boolean(false), control) : symbolResult(index, "control", name === "Set" ? "Set" : "Date", true, control)];
  }
  if (index === 117) {
    if (idSuffix === "global-origins-absent-mixed") return [result(index, "activate", { kind: "array", values: [] }, boolean(false), active), result(index, "control", sdkOrigins("Date"), boolean(true), control)];
    if (idSuffix === "global-origins-shadow") return [declarationResult(index, "activate", "Date=()=>1", "VariableDeclaration", false, active), result(index, "control", sdkOrigins("Date"), boolean(true), control)];
    return [result(index, "activate", sdkOrigins("Math"), boolean(true), active), declarationResult(index, "control", "local=Math", "VariableDeclaration", false, control)];
  }
  if (index === 128) {
    const interval = idSuffix === "timer-interval-and-absence";
    return [symbolResult(index, "activate", interval ? "setInterval" : "setTimeout", true, active), result(index, "control", absent, boolean(false), control)];
  }
  if (index === 118 && idSuffix === "baseline") {
    return (["activate", "control"] as const).map((variant, position) => result(index, variant, "Math.abs.apply(null,[x])", { kind: "object", properties: {
      callee: { kind: "node", syntaxKind: "PropertyAccessExpression", text: "Math.abs", path: "/project/main.ts" },
      receiver: { kind: "node", syntaxKind: "NullKeyword", text: "null", path: "/project/main.ts" },
      arguments: { kind: "array", values: [{ kind: "node", syntaxKind: "Identifier", text: "x", path: "/project/main.ts" }] },
    } }, [alternatives[position]!]));
  }
  if (index === 129) {
    const symbol = (variant: WitnessVariant, argument: string, name: string | undefined, alternatives: string[]): NativeExpectation => result(index, variant, argument, name === undefined ? absent : { kind: "symbol", name, defaultLibrary: true, native: idSuffix === "sdk-value-const-chain" ? { nodeText: "Date", syntaxKind: "Identifier", target: "symbol" } : { nodeText: "window", syntaxKind: "Identifier", target: "type", steps: [{ op: "property", name: "Date" }] } }, alternatives);
    if (idSuffix === "baseline") return [symbol("activate", "D", undefined, active), symbol("control", "D", "Date", control)];
    if (idSuffix === "sdk-value-const-chain") return [symbol("activate", "second", "Date", active), symbol("control", "first", undefined, control)];
    if (idSuffix === "sdk-value-destructured-missing") return [symbol("activate", "Constructor", "Date", active), symbol("control", "Constructor", undefined, control)];
    if (idSuffix === "sdk-value-cycle") return [symbol("activate", "first", undefined, active), symbol("control", "Missing", undefined, control)];
  }
  if (index === 119) {
    if (idSuffix === "baseline") return witness.nativeExpectations.map((expectation, position) => position === 2 ? namedResult(index, "control", "document.createElement", false, ["Math", "createElement"], []) : expectation);
    const module = idSuffix === "sdk-member-module-owner";
    return [witness.nativeExpectations[0]!, result(121, "control", module ? "WebAssembly.instantiate" : "document.write", boolean(false), control), namedResult(index, "control", module ? "Uint8Array" : "Math.abs", !module, module ? ["Math", "Uint8Array"] : ["Math", "abs"], [])];
  }
  if (index === 125 && idSuffix !== "baseline") {
    const destructured = idSuffix === "runtime-binding-destructured";
    return [result(index, "activate", destructured ? "Constructor" : "receiver", boolean(destructured), active), result(index, "control", "receiver", boolean(false), destructured ? [] : control), ...(destructured ? [
      result(129, "control", "Constructor", absent, control),
      { kind: "syntax" as const, variant: "control" as const, syntaxKind: "VariableDeclaration", text: "window={Date:class{}}", minimumCount: 1, alternatives: [] },
      { kind: "syntax" as const, variant: "control" as const, syntaxKind: "BindingElement", text: "Date:Constructor", minimumCount: 1, alternatives: [] },
    ] : [])];
  }
  if (index === 126 && idSuffix === "script-absent-argument-local") return [result(index, "activate", "document.createElement()", boolean(false), active), result(index, "control", "document.createElement('script')", boolean(false), control)];
  if (index === 133) {
    const generic = idSuffix === "unsafe-handler-type-parameter";
    const position = Number(idSuffix.split("-").at(-1));
    const unsafe = idSuffix === "baseline" || generic || [0, 1, 2, 5].includes(position);
    const activation = typeResult(index, "activate", "handler", unsafe, active);
    if (idSuffix === "baseline" && activation.kind === "helper-return" && activation.argument?.kind === "type") activation.argument.native!.nativeByteStart = witness.files[witness.path]!.lastIndexOf("handler,");
    return [activation, typeResult(index, "control", generic ? "handler" : idSuffix === "baseline" ? "Math.abs" : "()=>{}", generic, control, generic ? "Identifier" : idSuffix === "baseline" ? "PropertyAccessExpression" : "ArrowFunction")];
  }
  return undefined;
}

export function replaceWitness(witness: ContractWitness): ContractWitness | undefined {
  const prepared = prepareSource(witness);
  const nativeExpectations = expectations(prepared);
  return nativeExpectations === undefined ? prepared === witness ? undefined : prepared : { ...prepared, nativeExpectations };
}

function prepareSource(witness: ContractWitness): ContractWitness {
  const { index, idSuffix } = witness;
  if (index === 93 && idSuffix === "iterable-nonsdk-protocol") return { ...witness,
    files: { "main.ts": "interface ArrayLike<T>{[Symbol.iterator]():Iterator<T>}const values={length:0,[Symbol.iterator](){return null}};Array.from(values);" },
    controlFiles: { "main.ts": "const values={length:0};Array.from(values);" },
  };
  if (index === 116 && idSuffix === "global-member-computed" || index === 120 && idSuffix === "meta-dynamic-member" || index === 126 && idSuffix === "script-case-alias") return { ...witness,
    files: Object.fromEntries(Object.entries(witness.files).map(([path, source]) => [path, source + "export {}; "])),
    controlFiles: Object.fromEntries(Object.entries(witness.controlFiles).map(([path, source]) => [path, source + "export {}; "])),
  };
  if (index === 119 && idSuffix === "sdk-member-interface-owner") return { ...witness, controlFiles: { "main.ts": witness.controlFiles["main.ts"] + "Math.abs(1);" } };
  if (index === 125 && idSuffix === "runtime-binding-destructured") return { ...witness, controlFiles: { "main.ts": witness.controlFiles["main.ts"] + "declare const receiver:typeof globalThis;new receiver.Date(1);" } };
  if (index === 125 && idSuffix === "runtime-binding-absence-cycle") return { ...witness,
    files: { "main.ts": "declare const receiver:typeof globalThis;new receiver.Date(1);export {};" },
    controlFiles: { "main.ts": "const receiver:typeof globalThis=other;const other=receiver;new receiver.Date(1);export {};" },
  };
  if (index === 126 && idSuffix === "script-absent-argument-local") return { ...witness, controlFiles: { "main.ts": "const document={createElement(){return {}}};globalThis.document.head.appendChild(document.createElement('script'));export {};" } };
  return witness;
}
