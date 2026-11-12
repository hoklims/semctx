import { helperResult, witness, type ContractWitness, type NativeExpectation } from "./t00-ts7-q-semantic-contract-witness-types";

const syntax = (variant: "activate" | "control", syntaxKind: string, text: string, alternative: string): NativeExpectation => ({
  kind: "syntax", variant, syntaxKind, text, minimumCount: 1, alternatives: [alternative],
});
const reasons = (variant: "activate" | "control", values: string[]): NativeExpectation => helperResult(49, variant,
  { kind: "node", syntaxKind: "SourceFile", path: "main.ts" },
  { kind: "array", values: values.map(value => ({ kind: "string", value })) });

export const semanticOwnerWitnesses: ContractWitness[] = [
  witness(49, "source-reference", "/// <reference path=\"./absent.ts\"/>\nexport function run(){}", "export function run(){}", ["reference-path", "no-reference"], [
    syntax("activate", "FunctionDeclaration", "export function run(){}", "reference-path"),
    syntax("control", "FunctionDeclaration", "export function run(){}", "no-reference"),
    reasons("activate", ["SOURCE_REFERENCE_PATH_UNSUPPORTED"]), reasons("control", []),
  ]),
  witness(49, "script-checker", "const value=1+2;", "const value=3;", ["checker-script", "syntax-only-script"], [
    syntax("activate", "BinaryExpression", "1+2", "checker-script"),
    syntax("control", "NumericLiteral", "3", "syntax-only-script"),
    reasons("activate", []), reasons("control", []),
  ]),
  witness(49, "direct-variable-export", "export const value=1+2;", "export const value=()=>1;", ["variable-type-query", "function-initializer"], [
    syntax("activate", "VariableDeclaration", "value=1+2", "variable-type-query"),
    syntax("control", "ArrowFunction", "()=>1", "function-initializer"),
    reasons("activate", []), reasons("control", []),
  ]),
  witness(49, "retained-export-alias", { "main.ts": "export {value as alias} from './target';", "target.ts": "export const value=1;" }, "export const alias=1;", ["aliased-export", "direct-export"], [
    syntax("activate", "ExportSpecifier", "value as alias", "aliased-export"),
    { kind: "symbol-origin", variant: "activate", nodeText: "alias", origin: "retained" },
    syntax("control", "VariableDeclaration", "alias=1", "direct-export"),
    reasons("activate", []), reasons("control", []),
  ]),
  ...["(()=>void)|number", "unknown", "new()=>object"].map((type, position) => witness(49, `destructured-export-${position}`,
    `declare const source:{value:${type}};export const {value}=source;`,
    "declare const source:{value:number};export const {value}=source;", ["destructured-potentially-callable", "destructured-primitive"], [
      syntax("activate", "BindingElement", "value", "destructured-potentially-callable"),
      syntax("control", "BindingElement", "value", "destructured-primitive"),
      helperResult(99, "activate", { kind: "type", native: { nodeText: "value", syntaxKind: "Identifier", target: "type" } }, { kind: "boolean", value: true }),
      helperResult(99, "control", { kind: "type", native: { nodeText: "value", syntaxKind: "Identifier", target: "type" } }, { kind: "boolean", value: false }),
      reasons("activate", ["SOURCE_DESTRUCTURED_CALLABLE_EXPORT_UNSUPPORTED"]), reasons("control", []),
    ])),
  witness(49, "callable-variable-export", "declare const value:()=>void;export {value};", "export const value=()=>1;", ["callable-variable", "direct-function-value"], [
    syntax("activate", "VariableDeclaration", "value:()=>void", "callable-variable"),
    syntax("control", "ArrowFunction", "()=>1", "direct-function-value"),
    reasons("activate", ["SOURCE_CALLABLE_EXPORT_UNSUPPORTED"]), reasons("control", []),
  ]),
  witness(49, "overload-body", "function run():void;function run(){}run();export {};", "function run():void;run();export {};", ["overload-implementation", "bodyless-local-function"], [
    syntax("activate", "FunctionDeclaration", "function run(){}", "overload-implementation"),
    syntax("control", "FunctionDeclaration", "function run():void;", "bodyless-local-function"),
    reasons("activate", []), reasons("control", ["SOURCE_AMBIENT_FUNCTION_UNSUPPORTED"]),
  ]),
];
