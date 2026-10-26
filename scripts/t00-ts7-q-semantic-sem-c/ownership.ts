import type ts from "typescript";
import { basename } from "node:path";
import { createContractFacts, NativeFactsRequired } from "../t00-ts7-q-semantic-contract-facts";
import type { ContractExecutionContext } from "../t00-ts7-q-semantic-contract-support";
import type { OwnershipProjection } from "../t00-ts7-q-semantic-contract-ownership";

type GraphNode = { id: string; kind: "module" | "test" | "function" | "class"; filePath: string; name: string; metadata: { scope?: string } };
type GraphEdge = { kind: "calls" | "covers" | "tested_by"; from: string; to: string; evidence: { filePath: string; startLine: number }[] };
type Ownership = { root: string; callbacks: Map<string, boolean>; graph: { nodes: GraphNode[]; edges: GraphEdge[] } };

export function projectOwnership(oracle: unknown, path: string, files: Record<string, string>, context?: ContractExecutionContext): OwnershipProjection {
  try {
    const facts = createContractFacts(oracle, path, files);
    const syntax = facts.ts as unknown as typeof ts;
    const checker = facts.checker as unknown as ts.TypeChecker;
    const program = facts.program as unknown as ts.Program;
    const declarations: { node: GraphNode; signatureOnly: boolean }[] = [];
    const imports: { owner: string; targetPath: string; targetName: string; filePath: string; startLine: number }[] = [];
    const calls: { owner: string; targetPath: string; targetName: string; filePath: string; startLine: number }[] = [];
    const relative = (file: string): string => {
      if (!file.startsWith("/project/")) throw Error("OWNERSHIP_EXTERNAL_SOURCE");
      return file.slice("/project/".length);
    };
    const scopeName = (node: ts.Node): string | undefined => {
      if (syntax.isFunctionDeclaration(node) || syntax.isClassDeclaration(node)) {
        if (node.name !== undefined) return node.name.text;
        return (syntax.getCombinedModifierFlags(node) & syntax.ModifierFlags.Default) !== 0 ? "default" : undefined;
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
    const addNode = (kind: GraphNode["kind"], filePath: string, name: string, scope: string[], signatureOnly = false): string => {
      const id = JSON.stringify([filePath, kind, ...scope, name]);
      declarations.push({ node: { id, kind, filePath, name, metadata: scope.length > 0 ? { scope: scope.join(".") } : {} }, signatureOnly });
      return id;
    };
    for (const filename of Object.keys(files).filter(file => /\.[cm]?[jt]sx?$/.test(file) && !/\.d\.[cm]?ts$/.test(file))) {
      const absolute = filename.startsWith("/") ? filename : `/project/${filename}`;
      const filePath = relative(absolute);
      const roles = context?.label === "control" ? context.witness.controlRoles ?? context.witness.roles : context?.witness.roles;
      const selection = context?.label === "control" ? context.witness.controlSelection ?? context.witness.selection : context?.witness.selection;
      if (selection?.[filePath] === "excluded") continue;
      const role = roles?.[filePath] ?? "source";
      const source = program.getSourceFile(absolute);
      if (source === undefined) throw Error("OWNERSHIP_SOURCE_UNAVAILABLE");
      const module = addNode(role === "test" ? "test" : "module", filePath, basename(filePath), []);
      const visit = (node: ts.Node, scope: string[], owner: string): void => {
        let nextScope = scope;
        let nextOwner = owner;
        if ((syntax.isFunctionDeclaration(node) || syntax.isClassDeclaration(node)) && scopeName(node) !== undefined) {
          const name = scopeName(node)!;
          nextOwner = addNode(syntax.isClassDeclaration(node) ? "class" : "function", filePath, name, scope, syntax.isFunctionDeclaration(node) && node.body === undefined);
          nextScope = [...scope, name];
        } else if (syntax.isMethodDeclaration(node) && syntax.isIdentifier(node.name)) {
          nextScope = [...scope, node.name.text];
        } else if (syntax.isModuleDeclaration(node) && syntax.isIdentifier(node.name)) {
          nextScope = [...scope, node.name.text];
        } else if (syntax.isVariableStatement(node)) {
          for (const declaration of node.declarationList.declarations) {
            const name = scopeName(declaration);
            const variableOwner = name === undefined ? owner : addNode("function", filePath, name, scope);
            syntax.forEachChild(declaration, child => visit(child, name === undefined ? scope : [...scope, name], variableOwner));
          }
          return;
        } else if (role === "test" && syntax.isImportDeclaration(node) && node.importClause !== undefined && !node.importClause.isTypeOnly) {
          const bindings = node.importClause.namedBindings;
          if (bindings !== undefined && syntax.isNamedImports(bindings)) {
            for (const binding of bindings.elements) {
              if (binding.isTypeOnly) continue;
              let symbol = checker.getSymbolAtLocation(binding.name);
              if (symbol !== undefined && (symbol.flags & syntax.SymbolFlags.Alias) !== 0) symbol = checker.getAliasedSymbol(symbol);
              for (const declaration of symbol?.getDeclarations() ?? []) {
                const source = declaration.getSourceFile();
                const targetName = coordinate(declaration);
                if (!source.isDeclarationFile && source.fileName.startsWith("/project/") && targetName !== undefined) imports.push({ owner: module, targetPath: relative(source.fileName), targetName, filePath, startLine: node.getSourceFile().getLineAndCharacterOfPosition(node.getStart()).line + 1 });
              }
            }
          }
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
    const groups = new Map<string, typeof declarations>();
    for (const declaration of declarations) {
      const group = groups.get(declaration.node.id) ?? [];
      group.push(declaration);
      groups.set(declaration.node.id, group);
    }
    const nodes = [...groups.values()].flatMap(group => {
      const first = group[0]!.node;
      return first.kind === "function" && group.filter(declaration => !declaration.signatureOnly).length > 1
        ? group.map((declaration, index) => ({ ...declaration.node, id: `${first.id}#${index + 1}` }))
        : [first];
    });
    const edges: GraphEdge[] = [];
    for (const call of calls) {
      const targets = nodes.filter(node => node.kind !== "module" && node.filePath === call.targetPath && `${node.metadata.scope ? node.metadata.scope + "." : ""}${node.name}` === call.targetName);
      if (targets.length === 1 && nodes.some(node => node.id === call.owner)) edges.push({ kind: "calls", from: call.owner, to: targets[0]!.id, evidence: [{ filePath: call.filePath, startLine: call.startLine }] });
    }
    for (const entry of imports) {
      const targets = nodes.filter(node => ["function", "class"].includes(node.kind) && node.filePath === entry.targetPath && `${node.metadata.scope ? node.metadata.scope + "." : ""}${node.name}` === entry.targetName);
      if (targets.length !== 1) continue;
      const evidence = [{ filePath: entry.filePath, startLine: entry.startLine }];
      edges.push({ kind: "covers", from: entry.owner, to: targets[0]!.id, evidence }, { kind: "tested_by", from: targets[0]!.id, to: entry.owner, evidence });
    }
    const proof: Ownership = { root: "/project", callbacks: new Map(), graph: { nodes, edges } };
    return { status: "projected", gaps: [], proof } as OwnershipProjection;
  } catch (error) {
    return { status: "unsupported", gaps: [error instanceof Error ? error.message : String(error)], ...(error instanceof NativeFactsRequired ? { queries: error.queries } : {}) };
  }
}
