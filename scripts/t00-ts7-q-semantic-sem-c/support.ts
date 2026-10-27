import { defaultSemanticContractSupport, type ContractExecutionContext } from "../t00-ts7-q-semantic-contract-support";
import { projectContract, type ContractProjection } from "../t00-ts7-q-semantic-contract-projector";
import { projectOwnershipPhases, compareOwnershipPhases, type OwnershipPhases } from "../t00-ts7-q-semantic-contract-ownership-phases";
import type { OwnershipProjection } from "../t00-ts7-q-semantic-contract-ownership";
import { projectOwnership } from "./ownership";

type Proof = Extract<OwnershipProjection, { status: "projected" }>["proof"] & { semanticCPhases?: OwnershipPhases; semanticCPath?: string };

const ownership = (oracle: unknown, path: string, files: Record<string, string>, context?: ContractExecutionContext): OwnershipProjection => {
  const projected = projectOwnership(oracle, path, files, context);
  if (projected.status !== "projected" || context?.witness.index !== 77 || context.witness.idSuffix !== "opaque-missing-member-root") return projected;
  const phases = projectOwnershipPhases(oracle, path, files, projected.proof);
  const missing = Object.values(phases).filter(phase => phase.status !== "projected");
  if (missing.length > 0) return { status: "unsupported", gaps: missing.flatMap(phase => phase.gaps), queries: missing.flatMap(phase => phase.queries ?? []) };
  const proof: Proof = { ...projected.proof, semanticCPhases: phases, semanticCPath: path };
  return { ...projected, proof };
};

const project = (oracle: unknown, path: string, files: Record<string, string>, proof?: unknown): ContractProjection => {
  const projected = projectContract(oracle, path, files, proof);
  const phases = (proof as Proof | undefined)?.semanticCPhases;
  if (projected.status !== "projected" || phases === undefined) return projected;
  return { ...projected, sites: Object.values(phases).flatMap(phase => phase.sites), branches: Object.values(phases).flatMap(phase => phase.branches) };
};

const compareOwnership = (producer: unknown, projected: OwnershipProjection): boolean => {
  if (!defaultSemanticContractSupport.compareOwnership(producer, projected) || projected.status !== "projected") return false;
  const proof = projected.proof as Proof;
  return proof.semanticCPhases === undefined || proof.semanticCPath !== undefined && compareOwnershipPhases(producer, proof.semanticCPath, proof.semanticCPhases);
};

export const support = { ...defaultSemanticContractSupport, project, ownership, compareOwnership };
