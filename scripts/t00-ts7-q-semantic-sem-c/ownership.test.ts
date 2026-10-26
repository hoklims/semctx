import { expect, test } from "bun:test";
import { support } from "./index";

const sourceFacts = (path: string, role: "source" | "test" = "source") => {
  const text = "class Owner{run(){}}";
  const source = { kind: "SourceFile", start: 0, end: text.length };
  const owner = { kind: "ClassDeclaration", start: 0, end: text.length };
  const ownerName = { kind: "Identifier", start: 6, end: 11 };
  const method = { kind: "MethodDeclaration", start: 12, end: 19 };
  const methodName = { kind: "Identifier", start: 12, end: 15 };
  const body = { kind: "Block", start: 17, end: 19 };
  const node = (reference: typeof source, parent: unknown, children: unknown[], fields: Record<string, unknown>, literalText = "") => ({ ...reference, pos: reference.start, text: text.slice(reference.start, reference.end), parent, children, fields, literalText });
  const oracle = { files: [{ path: `/project/${path}`, text, isDeclarationFile: false, nodes: [
    node(source, null, [owner], { statements: [owner] }),
    node(owner, source, [ownerName, method], { name: ownerName, members: [method] }),
    node(ownerName, owner, [], {}, "Owner"),
    node(method, owner, [methodName, body], { name: methodName, body }),
    node(methodName, method, [], {}, "run"),
    node(body, method, [], { statements: [] }),
  ] }] };
  const witness = { index: 69, idSuffix: "method-owner", path, files: { [path]: text }, controlFiles: { [path]: text }, roles: { [path]: role }, requiredAlternatives: [], nativeExpectations: [] };
  return { oracle, path, files: witness.files, context: { witness, label: "activate" as const } };
};

test("ownership keeps class methods as scopes without extracting a callable symbol", () => {
  const input = sourceFacts("main.ts");
  const result = support.ownership(input.oracle, input.path, input.files, input.context);
  expect(result.status).toBe("projected");
  if (result.status !== "projected") throw Error(result.gaps.join(","));
  expect(result.proof.graph.nodes.map(node => [node.kind, node.metadata.scope ?? "", node.name])).toEqual([
    ["module", "", "main.ts"], ["class", "", "Owner"],
  ]);
});

test("ownership follows the captured role instead of rejecting a test filename", () => {
  const input = sourceFacts("owner.test.ts", "test");
  const result = support.ownership(input.oracle, input.path, input.files, input.context);
  expect(result.status).toBe("projected");
  if (result.status !== "projected") throw Error(result.gaps.join(","));
  expect(result.proof.graph.nodes[0]).toMatchObject({ kind: "test", filePath: "owner.test.ts" });
  const source = sourceFacts("owner.test.ts");
  const sourceResult = support.ownership(source.oracle, source.path, source.files, source.context);
  expect(sourceResult.status).toBe("projected");
  if (sourceResult.status !== "projected") throw Error(sourceResult.gaps.join(","));
  expect(sourceResult.proof.graph.nodes[0]).toMatchObject({ kind: "module" });
});

test("missing native syntax remains unsupported", () => {
  const input = sourceFacts("main.ts");
  expect(support.ownership({}, input.path, input.files, input.context).status).toBe("unsupported");
});

test("opaque callback projection binds all native phases and graph identities", async () => {
  const { publicDigest } = await import("../../tools/rust-ts-r0/qualification/public-closure-20261022/public-native-context.mjs");
  const witness = { index: 77, idSuffix: "opaque-missing-member-root", path: "main.ts", files: { "main.ts": "" }, controlFiles: { "main.ts": "" }, requiredAlternatives: [], nativeExpectations: [] };
  const oracle = { files: [{ path: "/project/main.ts", text: "", referencedFiles: [], isDeclarationFile: false, nodes: [{ kind: "SourceFile", start: 0, end: 0, pos: 0, text: "", parent: null, children: [], fields: {} }] }] };
  const expected = support.ownership(oracle, witness.path, witness.files, { witness, label: "activate" });
  expect(expected.status).toBe("projected");
  const graph = { nodes: [{ id: "module", kind: "module", filePath: "main.ts", name: "main.ts", metadata: {} }], edges: [] };
  const phase = () => ({ executed: true, reasons: [] as string[], unsupported: [] });
  const observation = {
    executed: true, unsupported: [], observationScope: "native_module_configuration_graph_ownership", globalAdmissionInferred: false,
    graphBeforeEdgeRemovalId: publicDigest(graph), graphAfterEdgeRemovalId: publicDigest(graph),
    beforeAnalysis: phase(), afterAnalysis: phase(), afterGraphEdgesRemoved: phase(),
  };
  const producer = { assembly: graph, subjects: [{ path: "main.ts", opaqueCallbackOwnership: observation }] };
  expect(support.compareOwnership(producer, expected)).toBe(true);
  observation.beforeAnalysis.reasons.push("SOURCE_OPAQUE_CALLBACK_UNSUPPORTED");
  expect(support.compareOwnership(producer, expected)).toBe(false);
  observation.beforeAnalysis.reasons = [];
  observation.graphBeforeEdgeRemovalId = "foreign-graph";
  expect(support.compareOwnership(producer, expected)).toBe(false);
});
