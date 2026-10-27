import { publicDigest } from "../tools/rust-ts-r0/qualification/public-closure-20261022/public-native-context.mjs";
import { compareReasons, record } from "./t00-ts7-q-semantic-core";
import { projectContract, type ContractProjection } from "./t00-ts7-q-semantic-contract-projector";
import type { OwnershipProjection } from "./t00-ts7-q-semantic-contract-ownership";

export type OwnershipPhases = Record<"beforeAnalysis" | "afterAnalysis" | "afterGraphEdgesRemoved", ContractProjection>;

export function projectOwnershipPhases(oracle: unknown, path: string, files: Record<string, string>, proof: Extract<OwnershipProjection, { status: "projected" }>["proof"]): OwnershipPhases {
  return {
    beforeAnalysis: projectContract(oracle, path, files, null),
    afterAnalysis: projectContract(oracle, path, files, { ...proof, callbacks: new Map() }),
    afterGraphEdgesRemoved: projectContract(oracle, path, files, { ...proof, callbacks: new Map(), graph: { ...proof.graph, edges: [] } }),
  };
}

export function compareOwnershipPhases(producer: unknown, path: string, expected: OwnershipPhases): boolean {
  const native = record(producer), graph = record(native["assembly"]);
  if (!Array.isArray(graph["nodes"]) || !Array.isArray(graph["edges"]) || !Array.isArray(native["subjects"])) return false;
  const subjects = native["subjects"].map(record).filter(subject => subject["path"] === path);
  if (subjects.length !== 1) return false;
  const observation = record(subjects[0]!["opaqueCallbackOwnership"]);
  if (observation["executed"] !== true || JSON.stringify(observation["unsupported"]) !== "[]"
    || observation["observationScope"] !== "native_module_configuration_graph_ownership" || observation["globalAdmissionInferred"] !== false
    || observation["graphBeforeEdgeRemovalId"] !== publicDigest(graph)
    || observation["graphAfterEdgeRemovalId"] !== publicDigest({ ...graph, edges: [] })) return false;
  return (["beforeAnalysis", "afterAnalysis", "afterGraphEdgesRemoved"] as const).every(phase => expected[phase].status === "projected"
    && expected[phase].gaps.length === 0 && compareReasons(observation[phase], expected[phase].reasons));
}
