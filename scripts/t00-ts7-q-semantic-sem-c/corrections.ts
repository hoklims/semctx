import { baseContractWitnesses } from "../t00-ts7-q-semantic-contract-witnesses-base";
import { helperResult, type ContractWitness, type NativeExpectation } from "../t00-ts7-q-semantic-contract-witness-types";

const original = (index: number, suffix: string): ContractWitness => baseContractWitnesses.find(witness => witness.index === index && witness.idSuffix === suffix)!;
const absentElementSymbol = (index: number, suffix: string): Partial<ContractWitness> => ({
  nativeExpectations: original(index, suffix).nativeExpectations.map(expectation => expectation.kind === "symbol-origin" && expectation.variant === "control" ? { ...expectation, origin: "absent" } : expectation),
});
const bool = (index: number, variant: "activate" | "control", argument: string, value: boolean, alternatives: string[]): NativeExpectation => helperResult(index, variant, argument, { kind: "boolean", value }, alternatives);

export const corrections: Record<string, Partial<ContractWitness>> = {
  "72:sort-element-access": {
    controlFiles: { "main.ts": "[1].sort();" },
    requiredAlternatives: ["element-sort-without-SDK-symbol", "dot-sort-primitive"],
    nativeExpectations: [helperResult(129, "activate", "[{toString(){return 'x'}}]['sort']", { kind: "undefined" }, ["element-sort-without-SDK-symbol"]), bool(100, "control", "1", true, ["dot-sort-primitive"])],
  },
  "88:internal-callable-class-constructor": {
    files: { "main.ts": "class Constructor{constructor(){}};Constructor.call(null);" },
    nativeExpectations: original(88, "internal-callable-class-constructor").nativeExpectations.map(expectation => expectation.kind === "syntax" && expectation.variant === "activate" ? { ...expectation, text: "class Constructor{constructor(){}}" } : expectation),
  },
  "88:internal-callable-cycle": { files: { "main.ts": "const first=second;const second=first;(first as Function).call(null);" } },
  "89:constructor-element-lookup": absentElementSymbol(89, "constructor-element-lookup"),
  "90:date-copy-alias-and-shadow": {
    controlFiles: { "main.ts": "const Date=class{};const value=new Date();new Date(value);new globalThis.Date(value);export {};" },
    nativeExpectations: original(90, "date-copy-alias-and-shadow").nativeExpectations.map(expectation => expectation.kind === "helper-return" && expectation.consumerIndex === 90 && expectation.variant === "control" ? { ...expectation, argumentText: "new globalThis.Date(value)" } : expectation),
  },
  "90:date-copy-arity-and-call": {
    controlFiles: { "main.ts": "getComputedStyle(document.body);" },
    requiredAlternatives: ["Date-zero-arguments", "Date-multiple-arguments", "non-new-SDK-call"],
    nativeExpectations: [bool(90, "activate", "new Date()", false, ["Date-zero-arguments"]), bool(90, "activate", "new Date(new Date(),1)", false, ["Date-multiple-arguments"]), bool(90, "control", "getComputedStyle(document.body)", false, ["non-new-SDK-call"])],
  },
  "134:visitor-type-nodes-and-runtime": { files: { "main.ts": original(134, "visitor-type-nodes-and-runtime").files["main.ts"] + "String(1);" } },
  "135:worklet-element-access": absentElementSymbol(135, "worklet-element-access"),
};
