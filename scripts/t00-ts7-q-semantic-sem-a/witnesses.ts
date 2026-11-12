import { baseContractWitnesses, baseContractWitnessLimitations } from "../t00-ts7-q-semantic-contract-witnesses-base";
import { semanticSublotIndices } from "../t00-ts7-q-semantic-sublot-scope";
import { expectations } from "./expectations";
import { helperResult, witness } from "../t00-ts7-q-semantic-contract-witness-types";
import type { ContractWitness } from "../t00-ts7-q-semantic-contract-witness-types";

const indices: readonly number[] = semanticSublotIndices.a;
const replacements: ContractWitness[] = [...baseContractWitnesses.flatMap(entry => {
  const nativeExpectations = expectations[`${entry.index}:${entry.idSuffix}`];
  return nativeExpectations === undefined ? [] : [{ ...entry, nativeExpectations }];
}), ...baseContractWitnesses.filter(entry => entry.index === 86 && entry.idSuffix === "retained-versus-sdk-declaration").map(entry => ({
  ...entry,
  controlFiles: { "main.ts": `${entry.controlFiles["main.ts"]}export {Date};` },
  nativeExpectations: [...entry.nativeExpectations, helperResult(86, "control", "Date: DateConstructor", { kind: "boolean", value: false }, undefined, "/sdk/lib/lib.es5.d.ts")],
}))];
const additional: ContractWitness[] = [
  witness(54, "imported-async-alias", { "main.ts": "import {target as alias} from './target';async function run(){return await alias()}", "target.ts": "export async function target(){return 1}" }, { "main.ts": "import {target as alias} from './target';async function run(){return await alias()}", "target.ts": "export function target(){return {then(){}}}" }, ["async-import-alias", "sync-import-alias"], [
    helperResult(54, "activate", "alias", { kind: "boolean", value: true }, ["async-import-alias"]),
    helperResult(54, "control", "alias", { kind: "boolean", value: false }, ["sync-import-alias"]),
  ]),
  ...["of", "in"].map(operator => witness(56, `guard-loop-${operator}`, `import {accept} from 'opaque';function run(value){for(value ${operator} []){};if(typeof value!=='string')throw Error();accept(value)}`, `import {accept} from 'opaque';function run(value){for(const other ${operator} []){};if(typeof value!=='string')throw Error();accept(value)}`, ["loop-writes-binding", "loop-declares-other-binding"], [
    helperResult(56, "activate", { kind: "symbol", name: "value", native: { nodeText: "value", syntaxKind: "Identifier", target: "symbol" } }, { kind: "boolean", value: true }, ["loop-writes-binding"]),
    helperResult(56, "control", { kind: "symbol", name: "value", native: { nodeText: "value", syntaxKind: "Identifier", target: "symbol" } }, { kind: "boolean", value: false }, ["loop-declares-other-binding"]),
  ])),
  witness(60, "cluster-unrenamed-import-binding", "import {fork} from 'node:cluster';fork();", "import * as cluster from 'node:cluster';const {fork}=cluster;fork();", ["import-local-name", "binding-local-name"], [
    helperResult(60, "activate", "fork", { kind: "boolean", value: true }, ["import-local-name"]),
    helperResult(60, "control", "fork", { kind: "boolean", value: true }, ["binding-local-name"]),
  ]),
  witness(65, "destructured-local-factory", "const source={defineProperty(){}};const {defineProperty:define}=source;define({},'plain',{value:1});", "const source={defineProperty(){}};const {defineProperty}=source;defineProperty({},'plain',{value:1});", ["renamed-local-factory", "unrenamed-local-factory"], [
    helperResult(65, "activate", "define", { kind: "boolean", value: false }, ["renamed-local-factory"]),
    helperResult(65, "control", "defineProperty", { kind: "boolean", value: false }, ["unrenamed-local-factory"]),
  ]),
  witness(67, "helper-absent-symbol-fallback", "declare const target:unknown;target.call(null);", "function target(){};target.call(null);", ["missing-member-symbol", "sdk-member-symbol"], [
    helperResult(67, "activate", "target.call", { kind: "boolean", value: false }, ["missing-member-symbol"]),
    helperResult(67, "control", "target.call", { kind: "boolean", value: true }, ["sdk-member-symbol"]),
  ]),

];
const replaced = new Set(replacements.map(witness => `${witness.index}:${witness.idSuffix}`));
export const witnesses = [
  ...baseContractWitnesses.filter(witness => indices.includes(witness.index) && !replaced.has(`${witness.index}:${witness.idSuffix}`)),
  ...replacements,
  ...additional,
];
export const limitations = baseContractWitnessLimitations.filter(limitation => indices.includes(limitation.index));
