import { additionalWitnesses } from "./additional";
import { replaceWitness } from "./expectations";
import { baseContractWitnesses, baseContractWitnessLimitations } from "../t00-ts7-q-semantic-contract-witnesses-base";
import { semanticSublotIndices } from "../t00-ts7-q-semantic-sublot-scope";
import type { ContractWitness } from "../t00-ts7-q-semantic-contract-witness-types";

const indices: readonly number[] = semanticSublotIndices.b;
const replacements: ContractWitness[] = baseContractWitnesses
  .filter(witness => indices.includes(witness.index))
  .flatMap(witness => {
    const replacement = replaceWitness(witness);
    return replacement === undefined ? [] : [replacement];
  });
const additional: ContractWitness[] = additionalWitnesses;
const replaced = new Set(replacements.map(witness => `${witness.index}:${witness.idSuffix}`));
export const witnesses = [
  ...baseContractWitnesses.filter(witness => indices.includes(witness.index) && !replaced.has(`${witness.index}:${witness.idSuffix}`)),
  ...replacements,
  ...additional,
];
export const limitations = baseContractWitnessLimitations.filter(limitation => indices.includes(limitation.index));
