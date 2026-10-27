import { projectContract, type ContractProjection } from "./t00-ts7-q-semantic-contract-projector";
import { compareContractOwnership, projectContractOwnership, type OwnershipProjection } from "./t00-ts7-q-semantic-contract-ownership";
import { compareOwnershipPhases, projectOwnershipPhases, type OwnershipPhases } from "./t00-ts7-q-semantic-contract-ownership-phases";
import { verifyContractWitness } from "./t00-ts7-q-semantic-contract-witness-verifier";
import type { ContractWitness, WitnessVariant } from "./t00-ts7-q-semantic-contract-witness-types";

export type ContractExecutionContext = { witness: ContractWitness; label: WitnessVariant };
export type SemanticContractSupport = {
  project: (oracle: unknown, path: string, files: Record<string, string>, ownership?: unknown, context?: ContractExecutionContext) => ContractProjection;
  ownership: (oracle: unknown, path: string, files: Record<string, string>, context?: ContractExecutionContext) => OwnershipProjection;
  ownershipPhases: (oracle: unknown, path: string, files: Record<string, string>, proof: Extract<OwnershipProjection, { status: "projected" }>["proof"], context?: ContractExecutionContext) => OwnershipPhases;
  compareOwnership: typeof compareContractOwnership;
  compareOwnershipPhases: typeof compareOwnershipPhases;
  verify: typeof verifyContractWitness;
};
export const defaultSemanticContractSupport: SemanticContractSupport = {
  project: projectContract,
  ownership: projectContractOwnership,
  ownershipPhases: projectOwnershipPhases,
  compareOwnership: compareContractOwnership,
  compareOwnershipPhases,
  verify: verifyContractWitness,
};
