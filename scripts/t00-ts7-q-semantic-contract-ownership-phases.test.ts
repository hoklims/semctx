import { expect, test } from "bun:test";
import { publicDigest } from "../tools/rust-ts-r0/qualification/public-closure-20261022/public-native-context.mjs";
import { compareOwnershipPhases, type OwnershipPhases } from "./t00-ts7-q-semantic-contract-ownership-phases";

const phase = (reasons: string[]) => ({ status: "projected" as const, reasons, gaps: [], sites: [], branches: [], helperResults: [] });
const expected: OwnershipPhases = {
  beforeAnalysis: phase(["SOURCE_OPAQUE_CALLBACK_UNSUPPORTED"]),
  afterAnalysis: phase([]),
  afterGraphEdgesRemoved: phase(["SOURCE_OPAQUE_CALLBACK_UNSUPPORTED"]),
};
const assembly = { nodes: [{ id: "owner" }, { id: "target" }], edges: [{ kind: "calls", from: "owner", to: "target" }] };
const producer = () => ({ assembly, subjects: [{ path: "main.ts", opaqueCallbackOwnership: {
  executed: true, unsupported: [], observationScope: "native_module_configuration_graph_ownership", globalAdmissionInferred: false,
  graphBeforeEdgeRemovalId: publicDigest(assembly), graphAfterEdgeRemovalId: publicDigest({ ...assembly, edges: [] }),
  ...Object.fromEntries(Object.entries(expected).map(([key, phase]) => [key, { executed: true, unsupported: [], reasons: phase.reasons }])),
} }] });

test("compares every independently projected ownership phase with the same native graph", () => {
  expect(compareOwnershipPhases(producer(), "main.ts", expected)).toBe(true);
  const wrong = producer();
  wrong.subjects[0]!.opaqueCallbackOwnership.graphAfterEdgeRemovalId = publicDigest(assembly);
  expect(compareOwnershipPhases(wrong, "main.ts", expected)).toBe(false);
  expect(compareOwnershipPhases(producer(), "other.ts", expected)).toBe(false);
});

test("missing, stale, unsupported or duplicated native observations cannot pass", () => {
  for (const key of ["beforeAnalysis", "afterAnalysis", "afterGraphEdgesRemoved"] as const) {
    for (const value of [undefined, { executed: false, unsupported: [], reasons: expected[key].reasons }, { executed: true, unsupported: ["missing"], reasons: expected[key].reasons }, { executed: true, unsupported: [], reasons: ["UNRELATED_REASON"] }]) {
      const actual = producer();
      Object.assign(actual.subjects[0]!.opaqueCallbackOwnership, { [key]: value });
      expect(compareOwnershipPhases(actual, "main.ts", expected)).toBe(false);
    }
    expect(compareOwnershipPhases(producer(), "main.ts", { ...expected, [key]: { ...expected[key], status: "unsupported", gaps: ["MISSING_NATIVE_FACT"] } })).toBe(false);
  }
  const duplicate = producer();
  duplicate.subjects.push(duplicate.subjects[0]!);
  expect(compareOwnershipPhases(duplicate, "main.ts", expected)).toBe(false);
  const missingGraph = { ...producer(), assembly: undefined };
  expect(compareOwnershipPhases(missingGraph, "main.ts", expected)).toBe(false);
  expect(compareOwnershipPhases({ ...producer(), assembly: { ...assembly, nodes: [] } }, "main.ts", expected)).toBe(false);
});
