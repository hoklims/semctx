import { syntaxContractWitnesses, syntaxWitnessLimitations } from "./t00-ts7-q-semantic-contract-witnesses-syntax";
import { typeContractWitnesses } from "./t00-ts7-q-semantic-contract-witnesses-types";
import { inspectorContractWitnesses, inspectorWitnessLimitations } from "./t00-ts7-q-semantic-contract-witnesses-inspectors";
import { legacyExpectations } from "./t00-ts7-q-semantic-contract-witnesses-legacy-expectations";
import { semanticWitnessesA, semanticWitnessesAFocal } from "./t00-ts7-q-semantic-witnesses-a";
import { semanticWitnessesB } from "./t00-ts7-q-semantic-witnesses-b";
import { record } from "./t00-ts7-q-semantic-core";
import type { ContractWitness, ExpectedHelperResult, NativeExpectation, WitnessVariant } from "./t00-ts7-q-semantic-contract-witness-types";

export type { ContractWitness, ContractWitnessLimitation, NativeExpectation } from "./t00-ts7-q-semantic-contract-witness-types";
const legacyWitnesses: ContractWitness[] = [...semanticWitnessesA, ...semanticWitnessesAFocal, ...semanticWitnessesB]
  .filter(entry => entry.index >= 50 && entry.index <= 135 && ![61, 97, 102].includes(entry.index))
  .map(entry => ({ index: entry.index, path: entry.path, idSuffix: entry.id.includes("--") ? `baseline-${entry.id.split("--")[1]}` : "baseline", files: entry.files,
    controlFiles: entry.controlFiles, requiredAlternatives: ["historical-focal-activation", "historical-focal-control"], nativeExpectations: legacyExpectations[entry.index] ?? [] }));
export const contractWitnesses = [...legacyWitnesses, ...syntaxContractWitnesses, ...typeContractWitnesses, ...inspectorContractWitnesses];
export const contractWitnessLimitations = [...syntaxWitnessLimitations, ...inspectorWitnessLimitations];

const records = (value: unknown): Record<string, unknown>[] => Array.isArray(value) ? value.map(record) : [];

function resultMatches(value: unknown, expected: ExpectedHelperResult): boolean {
  const actual = record(value);
  if (expected.kind === "boolean" || expected.kind === "string") return actual["kind"] === expected.kind && actual["value"] === expected.value;
  if (expected.kind === "undefined") return actual["kind"] === "undefined";
  if (expected.kind === "node") return actual["kind"] === "node" && actual["syntaxKind"] === expected.syntaxKind && (expected.text === undefined || actual["text"] === expected.text);
  if (actual["kind"] !== "array" || !Array.isArray(actual["values"])) return false;
  const declarations = records(actual["values"]);
  return declarations.length === expected.syntaxKinds.length && declarations.every(entry => entry["kind"] === "node")
    && JSON.stringify(declarations.map(entry => entry["syntaxKind"]).sort()) === JSON.stringify([...expected.syntaxKinds].sort())
    && (expected.declarationPaths === undefined || JSON.stringify(declarations.map(entry => entry["path"]).sort()) === JSON.stringify([...expected.declarationPaths].sort()));
}

function nativeMatches(expectation: NativeExpectation, nodes: Record<string, unknown>[], helpers: Record<string, unknown>[], filePath: string, files: Record<string, string>): boolean {
  if (expectation.kind === "helper-return") return helpers.some(helper => {
    const argument = records(helper["arguments"])[0];
    return helper["index"] === expectation.consumerIndex && argument?.["text"] === expectation.argumentText
      && (argument["kind"] !== "node" || argument["path"] === (expectation.argumentPath ?? filePath)) && resultMatches(helper["value"], expectation.expected);
  });
  if (expectation.kind === "syntax") return nodes.filter(node => node["kind"] === expectation.syntaxKind && (expectation.text === undefined || node["text"] === expectation.text)).length >= expectation.minimumCount;
  const candidates = nodes.filter(node => node["text"] === expectation.nodeText);
  if (candidates.length === 0) return false;
  if (expectation.kind === "symbol-origin") return candidates.every(node => {
    if (!("symbol" in node)) return false;
    const symbol = node["aliasedSymbol"] ?? node["symbol"];
    if (expectation.origin === "absent") return symbol === null;
    const origins = records(record(symbol)["declarations"]);
    return origins.length > 0 && origins.every(origin => expectation.origin === "default-library"
      ? origin["defaultLibrary"] === true
      : origin["defaultLibrary"] === false && typeof origin["path"] === "string" && Object.keys(files).some(path => origin["path"] === path || origin["path"] === `/project/${path}`));
  });
  return candidates.every(node => {
    const type = record(node["type"]);
    for (const [option, signatures, count] of [["callable", "callSignatures", "callSignatureCount"], ["constructible", "constructSignatures", "constructSignatureCount"]] as const) {
      if (expectation[option] === undefined) continue;
      const observed = typeof type[count] === "number" ? type[count] : Array.isArray(type[signatures]) ? (type[signatures] as unknown[]).length : undefined;
      if (observed === undefined || (observed > 0) !== expectation[option]) return false;
    }
    for (const [option, parts] of [["union", "unionTypes"], ["intersection", "intersectionTypes"]] as const) {
      if (expectation[option] !== undefined && (!Array.isArray(type[parts]) || ((type[parts] as unknown[]).length > 0) !== expectation[option])) return false;
    }
    return Object.keys(type).length > 0;
  });
}

export function verifyContractWitness(
  oracle: unknown,
  projection: unknown,
  witness: ContractWitness,
  label: WitnessVariant,
  path: string,
): { passed: boolean; gaps: string[] } {
  const observation = record(projection);
  const file = records(record(oracle)["files"]).find(entry => entry["path"] === path || entry["path"] === `/project/${path}`);
  const gaps: string[] = [];
  if (witness.requiredAlternatives.length === 0 || new Set(witness.requiredAlternatives).size !== witness.requiredAlternatives.length) gaps.push("WITNESS_ALTERNATIVE_INVENTORY_INVALID");
  for (const alternative of witness.requiredAlternatives) {
    if (!witness.nativeExpectations.some(expectation => expectation.alternatives?.includes(alternative))) gaps.push(`WITNESS_ALTERNATIVE_ASSERTION_MISSING:${alternative}`);
  }
  const variantExpectations = witness.nativeExpectations.filter(expectation => expectation.variant === label);
  if (variantExpectations.length === 0) gaps.push(`WITNESS_VARIANT_ASSERTION_MISSING:${label}`);
  if (witness.nativeExpectations.some(expectation => expectation.alternatives?.some(alternative => !witness.requiredAlternatives.includes(alternative)))) gaps.push("WITNESS_UNDECLARED_ALTERNATIVE_ASSERTION");
  if (file === undefined || typeof file["path"] !== "string" || !Array.isArray(file["nodes"]) || file["nodes"].length === 0) gaps.push("WITNESS_NATIVE_FILE_MISSING");
  if (observation["status"] !== "projected" || !Array.isArray(observation["gaps"]) || observation["gaps"].length !== 0) gaps.push("WITNESS_PROJECTION_INCOMPLETE");
  const helpers = records(observation["helperResults"]);
  if (!helpers.some(helper => helper["index"] === witness.index && Array.isArray(helper["arguments"]) && typeof record(helper["value"])["kind"] === "string")) gaps.push("WITNESS_TARGET_HELPER_NOT_EXECUTED");
  if (file !== undefined && typeof file["path"] === "string") {
    for (const [position, expectation] of witness.nativeExpectations.entries()) {
      if (expectation.variant !== label) continue;
      const expectedPath = expectation.sourcePath === undefined ? file["path"] : expectation.sourcePath.startsWith("/") ? expectation.sourcePath : `/project/${expectation.sourcePath}`;
      const expectedFile = records(record(oracle)["files"]).find(entry => entry["path"] === expectedPath);
      if (expectedFile === undefined) { gaps.push(`WITNESS_EXPECTATION_SOURCE_MISSING:${position}:${expectedPath}`); continue; }
      if (expectation.kind === "syntax" && (!Number.isSafeInteger(expectation.minimumCount) || expectation.minimumCount < 1)) gaps.push(`WITNESS_SYNTAX_EXPECTATION_INVALID:${position}`);
      if (!nativeMatches(expectation, records(expectedFile["nodes"]), helpers, expectedPath, label === "activate" ? witness.files : witness.controlFiles)) gaps.push(`WITNESS_EXPECTATION_UNSATISFIED:${position}:${expectation.kind}`);
    }
  }
  return { passed: gaps.length === 0, gaps };
}
