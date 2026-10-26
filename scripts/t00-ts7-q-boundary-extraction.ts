import { isDeepStrictEqual } from "node:util";
import type { Json, Property } from "./t00-ts7-q-boundary-common";

const contract = "Independent ts_goport 7.1.0-dev Program extraction and consumer-contracts assembleRepository graph projection";
const record = (value: unknown): Json => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const check = (name: string, expected: unknown, actual: unknown): Property => ({ name, expected, actual, pass: isDeepStrictEqual(expected, actual), oracle: contract });

export function compareExtraction(label: string, expected: Json, actual: Json): Property[] {
  return ["modules", "symbols", "imports", "calls"].flatMap(key => [
    check(`${label}.${key}.available`, true, Array.isArray(expected[key]) && Array.isArray(actual[key])),
    check(`${label}.${key}.exact`, expected[key], actual[key]),
  ]);
}

export function compareSimpleGraph(label: string, expected: Json, actual: Json): Property[] {
  const nodeCoordinate = (node: Json): string => node.kind === "repository" ? "repository" : `${String(node.kind)}:${String(node.filePath)}:${String(node.name)}`;
  const nodes = list(actual.nodes).map(record);
  const coordinates = new Map(nodes.map(node => [node.id, nodeCoordinate(node)]));
  const expectedNodes: Json[] = [{ coordinate: "repository", evidence: [] }];
  const expectedEdges: Json[] = [];
  for (const path of list(expected.modules)) {
    const module = `module:${String(path)}:${String(path).split("/").at(-1)}`;
    expectedNodes.push({ coordinate: module, evidence: [{ filePath: path, sourceKind: "code" }] });
    expectedEdges.push({ coordinate: `belongs_to:${module}->repository`, evidence: [{ filePath: path, sourceKind: "code" }] });
  }
  for (const value of list(expected.symbols)) {
    const symbol = record(value), coordinate = `${String(symbol.kind)}:${String(symbol.relPath)}:${String(symbol.name)}`;
    expectedNodes.push({ coordinate, exported: symbol.exported, evidence: [{ filePath: symbol.relPath, startLine: symbol.startLine, endLine: symbol.endLine, sourceKind: "code" }] });
    expectedEdges.push({ coordinate: `declares:module:${String(symbol.relPath)}:${String(symbol.relPath).split("/").at(-1)}->${coordinate}`, evidence: [{ filePath: symbol.relPath, startLine: symbol.startLine, sourceKind: "code" }] });
  }
  for (const value of list(expected.imports)) {
    const entry = record(value);
    if (typeof entry.resolvedRelPath !== "string") continue;
    expectedEdges.push({ coordinate: `imports:module:${String(entry.fromRelPath)}:${String(entry.fromRelPath).split("/").at(-1)}->module:${String(entry.resolvedRelPath)}:${String(entry.resolvedRelPath).split("/").at(-1)}`, evidence: [{ filePath: entry.fromRelPath, startLine: entry.line, sourceKind: "code" }] });
  }
  const symbolCoordinate = (path: unknown, scope: unknown): string | undefined => {
    const symbol = list(expected.symbols).map(record).find(symbol => symbol.relPath === path && [...list(symbol.scope), symbol.name].join(".") === scope);
    return symbol ? `${String(symbol.kind)}:${String(symbol.relPath)}:${String(symbol.name)}` : undefined;
  };
  for (const value of list(expected.calls)) {
    const call = record(value), target = symbolCoordinate(call.calleeRelPath, call.calleeSymbolPath);
    if (target === undefined) continue;
    const caller = call.callerSymbolPath === undefined ? `module:${String(call.callerRelPath)}:${String(call.callerRelPath).split("/").at(-1)}` : symbolCoordinate(call.callerRelPath, call.callerSymbolPath);
    expectedEdges.push({ coordinate: `calls:${String(caller)}->${target}`, evidence: [{ filePath: call.callerRelPath, startLine: call.line, sourceKind: "code" }] });
  }
  const sort = (rows: Json[]): Json[] => rows.toSorted((left, right) => String(left.coordinate).localeCompare(String(right.coordinate)));
  return [
    check(`${label}.supported-simple-oracle`, true, Array.isArray(expected.modules) && Array.isArray(expected.symbols) && expected.symbols.every(value => { const symbol = record(value); return Array.isArray(symbol.scope) && symbol.scope.length === 0 && Array.isArray(symbol.markers) && symbol.markers.length === 0; }) && Array.isArray(expected.imports) && Array.isArray(expected.calls)),
    check(`${label}.unique-node-ids`, nodes.length, coordinates.size),
    check(`${label}.nodes`, sort(expectedNodes), sort(nodes.map(node => ({ coordinate: nodeCoordinate(node), ...(node.exported === undefined ? {} : { exported: node.exported }), evidence: node.evidence })))),
    check(`${label}.edges`, sort(expectedEdges), sort(list(actual.edges).map(value => { const edge = record(value); return { coordinate: `${String(edge.kind)}:${String(coordinates.get(edge.from))}->${String(coordinates.get(edge.to))}`, evidence: edge.evidence }; }))),
    check(`${label}.integrity-reasons`, {}, actual.integrityReasons),
  ];
}

export function compareTestRelations(label: string, expected: string[], actual: Json, provenance: { path: string; line: number }): Property[] {
  const nodes = new Map(list(actual.nodes).map(value => { const node = record(value); return [node.id, `${String(node.kind)}:${String(node.filePath)}:${String(node.name)}`]; }));
  const relations = list(actual.edges).map(record).filter(edge => edge.kind === "tested_by" || edge.kind === "covers").map(edge => ({ coordinate: `${String(edge.kind)}:${String(nodes.get(edge.from))}->${String(nodes.get(edge.to))}`, evidence: edge.evidence })).toSorted((left, right) => left.coordinate.localeCompare(right.coordinate));
  return [check(`${label}.test-relations`, expected.toSorted().map(coordinate => ({ coordinate, evidence: [{ filePath: provenance.path, startLine: provenance.line, sourceKind: "test" }] })), relations)];
}

export function compareLeafGraph(label: string, expected: Json, actual: Json): Property[] {
  return [check(`${label}.leaf-has-no-imports-or-calls`, true, Array.isArray(expected.imports) && expected.imports.length === 0 && Array.isArray(expected.calls) && expected.calls.length === 0), ...compareSimpleGraph(label, expected, actual)];
}
