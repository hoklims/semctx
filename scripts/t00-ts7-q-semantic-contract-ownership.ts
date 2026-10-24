import type ts from "typescript";
import { isDeepStrictEqual } from "node:util";
import { createContractFacts, NativeFactsRequired } from "./t00-ts7-q-semantic-contract-facts";
import { record } from "./t00-ts7-q-semantic-core";

type GraphNode = { id: string; kind: "module" | "function" | "class"; filePath: string; name: string; metadata: { scope?: string } };
type GraphEdge = { kind: "calls"; from: string; to: string; evidence: { filePath: string; startLine: number }[] };
type Ownership = { root: string; callbacks: Map<string, boolean>; graph: { nodes: GraphNode[]; edges: GraphEdge[] } };
export type OwnershipProjection = { status: "projected"; proof: Ownership; gaps: [] } | { status: "unsupported"; gaps: string[]; queries?: unknown[] };

export function projectContractOwnership(oracle: unknown, path: string, files: Record<string, string>): OwnershipProjection {
  try {
    const facts = createContractFacts(oracle, path, files);
    const syntax = facts.ts as unknown as typeof ts;
    const checker = facts.checker as unknown as ts.TypeChecker;
    const program = facts.program as unknown as ts.Program;
    const nodes: GraphNode[] = [];
    const calls: { owner: string; targetPath: string; targetName: string; filePath: string; startLine: number }[] = [];
    const relative = (file: string): string => {
      if (!file.startsWith("/project/")) throw Error("OWNERSHIP_EXTERNAL_SOURCE");
      return file.slice("/project/".length);
    };
    const scopeName = (node: ts.Node): string | undefined => {
      if (syntax.isFunctionDeclaration(node) || syntax.isClassDeclaration(node)) {
        if (node.name !== undefined) return node.name.text;
        throw Error("OWNERSHIP_ANONYMOUS_DECLARATION_OUTSIDE_DOMAIN");
      }
      if ((syntax.isMethodDeclaration(node) || syntax.isModuleDeclaration(node)) && syntax.isIdentifier(node.name)) return node.name.text;
      if (syntax.isVariableDeclaration(node) && syntax.isIdentifier(node.name) && node.initializer !== undefined && (syntax.isArrowFunction(node.initializer) || syntax.isFunctionExpression(node.initializer))) return node.name.text;
      return undefined;
    };
    const coordinate = (node: ts.Node): string | undefined => {
      const name = scopeName(node);
      if (name === undefined) return undefined;
      const scope: string[] = [];
      for (let parent: ts.Node | undefined = node.parent; parent !== undefined; parent = parent.parent) {
        const parentName = scopeName(parent);
        if (parentName !== undefined) scope.unshift(parentName);
      }
      return [...scope, name].join(".");
    };
    const addNode = (kind: GraphNode["kind"], filePath: string, name: string, scope: string[]): string => {
      const id = JSON.stringify([filePath, kind, ...scope, name]);
      nodes.push({ id, kind, filePath, name, metadata: scope.length > 0 ? { scope: scope.join(".") } : {} });
      return id;
    };
    for (const filename of Object.keys(files).filter(file => /\.[cm]?[jt]sx?$/.test(file) && !/\.d\.[cm]?ts$/.test(file))) {
      const absolute = filename.startsWith("/") ? filename : `/project/${filename}`;
      const filePath = relative(absolute);
      if (/(?:^|\/)(?:__tests__|[^/]+\.(?:test|spec)\.[cm]?[jt]sx?$)/.test(filePath)) throw Error("OWNERSHIP_TEST_GRAPH_OUTSIDE_DOMAIN");
      const source = program.getSourceFile(absolute);
      if (source === undefined) throw Error("OWNERSHIP_SOURCE_UNAVAILABLE");
      const module = addNode("module", filePath, filePath, []);
      const visit = (node: ts.Node, scope: string[], owner: string): void => {
        let nextScope = scope;
        let nextOwner = owner;
        if (syntax.isFunctionDeclaration(node) || syntax.isClassDeclaration(node)) {
          if (syntax.isFunctionDeclaration(node) && node.body === undefined) throw Error("OWNERSHIP_SIGNATURE_ASSEMBLY_OUTSIDE_DOMAIN");
          const name = scopeName(node)!;
          nextOwner = addNode(syntax.isClassDeclaration(node) ? "class" : "function", filePath, name, scope);
          nextScope = [...scope, name];
        } else if ((syntax.isMethodDeclaration(node) || syntax.isModuleDeclaration(node)) && syntax.isIdentifier(node.name)) {
          nextScope = [...scope, node.name.text];
        } else if (syntax.isVariableStatement(node)) {
          for (const declaration of node.declarationList.declarations) {
            const name = scopeName(declaration);
            const variableOwner = name === undefined ? owner : addNode("function", filePath, name, scope);
            syntax.forEachChild(declaration, child => visit(child, name === undefined ? scope : [...scope, name], variableOwner));
          }
          return;
        } else if (syntax.isCallExpression(node)) {
          let callee: ts.Expression = node.expression;
          while (syntax.isParenthesizedExpression(callee) || syntax.isAsExpression(callee) || syntax.isTypeAssertionExpression(callee) || syntax.isNonNullExpression(callee) || syntax.isSatisfiesExpression(callee)) callee = callee.expression;
          let objectMember = false;
          for (let parent: ts.Node | undefined = node.parent; parent !== undefined; parent = parent.parent) {
            if (parent.parent !== undefined && syntax.isObjectLiteralExpression(parent.parent) && (syntax.isMethodDeclaration(parent) || syntax.isGetAccessorDeclaration(parent) || syntax.isSetAccessorDeclaration(parent))) objectMember = true;
            if (syntax.isArrowFunction(parent) || syntax.isFunctionExpression(parent)) {
              let owner: ts.Node | undefined = parent.parent;
              while (owner !== undefined && (syntax.isParenthesizedExpression(owner) || syntax.isAsExpression(owner) || syntax.isTypeAssertionExpression(owner) || syntax.isNonNullExpression(owner) || syntax.isSatisfiesExpression(owner))) owner = owner.parent;
              if (owner !== undefined && syntax.isPropertyAssignment(owner) && syntax.isObjectLiteralExpression(owner.parent)) objectMember = true;
            }
          }
          if (!objectMember && (syntax.isIdentifier(callee) || syntax.isPropertyAccessExpression(callee))) {
            let symbol = checker.getSymbolAtLocation(callee);
            if (symbol !== undefined && (symbol.flags & syntax.SymbolFlags.Alias) !== 0) symbol = checker.getAliasedSymbol(symbol);
            const declaration = symbol?.getDeclarations()?.[0];
            if (declaration !== undefined && !syntax.isObjectLiteralExpression(declaration.parent)) {
              const targetSource = declaration.getSourceFile();
              const targetName = coordinate(declaration);
              if (!targetSource.isDeclarationFile && targetSource.fileName.startsWith("/project/") && targetName !== undefined) calls.push({ owner, targetName, targetPath: relative(targetSource.fileName), filePath, startLine: source.getLineAndCharacterOfPosition(node.getStart()).line + 1 });
            }
          }
        }
        syntax.forEachChild(node, child => visit(child, nextScope, nextOwner));
      };
      syntax.forEachChild(source, node => visit(node, [], module));
    }
    if (new Set(nodes.map(node => node.id)).size !== nodes.length) throw Error("OWNERSHIP_DUPLICATE_COORDINATE");
    const edges: GraphEdge[] = [];
    for (const call of calls) {
      const targets = nodes.filter(node => node.kind !== "module" && node.filePath === call.targetPath && `${node.metadata.scope ? node.metadata.scope + "." : ""}${node.name}` === call.targetName);
      if (targets.length === 1) edges.push({ kind: "calls", from: call.owner, to: targets[0]!.id, evidence: [{ filePath: call.filePath, startLine: call.startLine }] });
    }
    return { status: "projected", gaps: [], proof: { root: "/project", callbacks: new Map(), graph: { nodes, edges } } };
  } catch (error) {
    return { status: "unsupported", gaps: [error instanceof Error ? error.message : String(error)], ...(error instanceof NativeFactsRequired ? { queries: error.queries } : {}) };
  }
}

export function compareContractOwnership(producer: unknown, projected: OwnershipProjection): boolean {
  if (projected.status !== "projected") return false;
  const normalize = (value: unknown): unknown => {
    const graph = record(value);
    if (!Array.isArray(graph["nodes"]) || !Array.isArray(graph["edges"])) return undefined;
    const nodes = graph["nodes"].map(record).filter(node => ["function", "class", "module", "test"].includes(String(node["kind"])));
    const coordinates = new Map<string, string>();
    for (const node of nodes) {
      const scope = record(node["metadata"])["scope"];
      if (typeof node["id"] !== "string" || coordinates.has(node["id"]) || typeof node["filePath"] !== "string" || typeof node["name"] !== "string" || (scope !== undefined && typeof scope !== "string")) return undefined;
      coordinates.set(node["id"], JSON.stringify([node["kind"], node["filePath"], scope ?? "", node["name"]]));
    }
    const edges: string[] = [];
    for (const edge of graph["edges"].map(record).filter(edge => ["calls", "covers", "tested_by"].includes(String(edge["kind"])))) {
      const from = coordinates.get(String(edge["from"])), to = coordinates.get(String(edge["to"]));
      if (from === undefined || to === undefined || !Array.isArray(edge["evidence"]) || edge["evidence"].length === 0) return undefined;
      for (const entry of edge["evidence"].map(record)) {
        if (typeof entry["filePath"] !== "string" || !Number.isSafeInteger(entry["startLine"]) || Number(entry["startLine"]) < 1) return undefined;
        edges.push(JSON.stringify([edge["kind"], from, to, entry["filePath"], entry["startLine"]]));
      }
    }
    return { nodes: [...coordinates.values()].sort(), edges: [...new Set(edges)].sort() };
  };
  const actual = normalize(record(producer)["assembly"]);
  const expected = normalize(projected.proof.graph);
  return actual !== undefined && expected !== undefined && isDeepStrictEqual(actual, expected);
}
