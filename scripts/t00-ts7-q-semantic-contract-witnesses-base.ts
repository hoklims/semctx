import { syntaxContractWitnesses, syntaxWitnessLimitations } from "./t00-ts7-q-semantic-contract-witnesses-syntax";
import { typeContractWitnesses } from "./t00-ts7-q-semantic-contract-witnesses-types";
import { inspectorContractWitnesses, inspectorWitnessLimitations } from "./t00-ts7-q-semantic-contract-witnesses-inspectors";
import { legacyExpectations } from "./t00-ts7-q-semantic-contract-witnesses-legacy-expectations";
import { semanticWitnessesA, semanticWitnessesAFocal } from "./t00-ts7-q-semantic-witnesses-a";
import { semanticWitnessesB } from "./t00-ts7-q-semantic-witnesses-b";
import type { ContractWitness } from "./t00-ts7-q-semantic-contract-witness-types";

const legacyWitnesses: ContractWitness[] = [...semanticWitnessesA, ...semanticWitnessesAFocal, ...semanticWitnessesB]
  .filter(entry => entry.index >= 50 && entry.index <= 135 && ![61, 97, 102].includes(entry.index))
  .map(entry => ({ index: entry.index, path: entry.path, idSuffix: entry.id.includes("--") ? `baseline-${entry.id.split("--")[1]}` : "baseline", files: entry.files,
    controlFiles: entry.controlFiles, requiredAlternatives: ["historical-focal-activation", "historical-focal-control"], nativeExpectations: legacyExpectations[entry.index] ?? [] }));
export const baseContractWitnesses = [...legacyWitnesses, ...syntaxContractWitnesses, ...typeContractWitnesses, ...inspectorContractWitnesses];
export const baseContractWitnessLimitations = [...syntaxWitnessLimitations, ...inspectorWitnessLimitations];
