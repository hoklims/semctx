import { baseContractWitnesses } from "./t00-ts7-q-semantic-contract-witnesses-base";
import { semanticSublots, semanticSublotFor } from "./t00-ts7-q-semantic-sublots";
import { semanticOwnerWitnesses } from "./t00-ts7-q-semantic-owner-witnesses";

export { verifyContractWitness } from "./t00-ts7-q-semantic-contract-witness-verifier";
export type { ContractWitness, ContractWitnessLimitation, NativeExpectation } from "./t00-ts7-q-semantic-contract-witness-types";
export const contractWitnesses = [...semanticOwnerWitnesses, ...baseContractWitnesses.filter(witness => witness.index === 52), ...Object.values(semanticSublots).flatMap(sublot => sublot.witnesses)];
export const contractWitnessLimitations = Object.values(semanticSublots).flatMap(sublot => sublot.limitations);

export function selectContractMatrix(index: number, sublot?: string) {
  if (sublot === undefined) return contractWitnesses.filter(witness => witness.index === index);
  const selected = semanticSublotFor(index);
  if (selected?.name !== sublot) throw Error("SEMANTIC_SUBLOT_OBLIGATION_MISMATCH");
  return selected.witnesses.filter(witness => witness.index === index);
}
