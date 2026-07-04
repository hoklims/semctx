import ts from "typescript";
import { relative } from "node:path";
import { normalizePath } from "@semantic-context/core";
import type { NodeKind } from "@semantic-context/core";
import { parseMarkers, type ParsedMarker } from "./markers";

export interface ExtractedSymbol {
  name: string;
  kind: Extract<NodeKind, "function" | "class" | "interface" | "type" | "enum">;
  relPath: string;
  startLine: number;
  endLine: number;
  exported: boolean;
  jsdoc?: string;
  markers: ParsedMarker[];
}

export interface ExtractedImport {
  fromRelPath: string;
  moduleSpecifier: string;
  resolvedRelPath?: string;
  names: string[];
  line: number;
}

export interface ExtractedCall {
  callerRelPath: string;
  callerSymbol?: string;
  calleeName: string;
  calleeRelPath?: string;
  calleeSymbol?: string;
  line: number;
}

export interface TsExtraction {
  modules: string[];
  symbols: ExtractedSymbol[];
  imports: ExtractedImport[];
  calls: ExtractedCall[];
}

const COMPILER_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  allowJs: false,
  skipLibCheck: true,
  noEmit: true,
  strict: false,
};

function isExported(node: ts.Node): boolean {
  return (ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Export) !== 0;
}

function lineOf(sf: ts.SourceFile, pos: number): number {
  return sf.getLineAndCharacterOfPosition(pos).line + 1;
}

/** The closest preceding block-doc (`/** ... *​/`) for a node, if any. */
function leadingJsDoc(sf: ts.SourceFile, node: ts.Node): string | undefined {
  const ranges = ts.getLeadingCommentRanges(sf.text, node.getFullStart());
  if (ranges === undefined) return undefined;
  let doc: string | undefined;
  for (const range of ranges) {
    const text = sf.text.slice(range.pos, range.end);
    if (text.startsWith("/**")) doc = text;
  }
  return doc;
}

function nameOfCallee(expr: ts.Expression): string | undefined {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  return undefined;
}

function resolveModule(specifier: string, containingFile: string): string | undefined {
  const resolved = ts.resolveModuleName(specifier, containingFile, COMPILER_OPTIONS, ts.sys);
  return resolved.resolvedModule?.resolvedFileName;
}

/** Extract modules, symbols, imports and best-effort resolved calls from source/test files. */
export function extractTypeScript(rootAbsPaths: string[], repoRoot: string): TsExtraction {
  const program = ts.createProgram(rootAbsPaths, COMPILER_OPTIONS);
  const checker = program.getTypeChecker();
  const rootSet = new Set(rootAbsPaths.map((p) => normalizePath(p)));

  const modules: string[] = [];
  const symbols: ExtractedSymbol[] = [];
  const imports: ExtractedImport[] = [];
  const calls: ExtractedCall[] = [];

  const relOf = (abs: string): string => normalizePath(relative(repoRoot, abs));

  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile) continue;
    if (!rootSet.has(normalizePath(sf.fileName))) continue;
    const relPath = relOf(sf.fileName);
    modules.push(relPath);

    const symbolStack: string[] = [];

    const recordSymbol = (
      node: ts.Node,
      name: string,
      kind: ExtractedSymbol["kind"],
    ): void => {
      const jsdoc = leadingJsDoc(sf, node);
      symbols.push({
        name,
        kind,
        relPath,
        startLine: lineOf(sf, node.getStart()),
        endLine: lineOf(sf, node.getEnd()),
        exported: isExported(node),
        ...(jsdoc !== undefined ? { jsdoc } : {}),
        markers: jsdoc !== undefined ? parseMarkers(jsdoc) : [],
      });
    };

    const visit = (node: ts.Node): void => {
      let pushedSymbol: string | undefined;

      if (ts.isFunctionDeclaration(node) && node.name) {
        recordSymbol(node, node.name.text, "function");
        pushedSymbol = node.name.text;
      } else if (ts.isClassDeclaration(node) && node.name) {
        recordSymbol(node, node.name.text, "class");
        pushedSymbol = node.name.text;
      } else if (ts.isInterfaceDeclaration(node)) {
        recordSymbol(node, node.name.text, "interface");
      } else if (ts.isTypeAliasDeclaration(node)) {
        recordSymbol(node, node.name.text, "type");
      } else if (ts.isEnumDeclaration(node)) {
        recordSymbol(node, node.name.text, "enum");
      } else if (ts.isVariableStatement(node)) {
        const exported = isExported(node);
        for (const decl of node.declarationList.declarations) {
          if (ts.isIdentifier(decl.name) && decl.initializer && isFunctionLike(decl.initializer)) {
            const jsdoc = leadingJsDoc(sf, node);
            symbols.push({
              name: decl.name.text,
              kind: "function",
              relPath,
              startLine: lineOf(sf, node.getStart()),
              endLine: lineOf(sf, decl.getEnd()),
              exported,
              ...(jsdoc !== undefined ? { jsdoc } : {}),
              markers: jsdoc !== undefined ? parseMarkers(jsdoc) : [],
            });
            pushedSymbol = decl.name.text;
          }
        }
      } else if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const specifier = node.moduleSpecifier.text;
        const resolvedAbs = resolveModule(specifier, sf.fileName);
        const names = importedNames(node);
        imports.push({
          fromRelPath: relPath,
          moduleSpecifier: specifier,
          ...(resolvedAbs !== undefined ? { resolvedRelPath: relOf(resolvedAbs) } : {}),
          names,
          line: lineOf(sf, node.getStart()),
        });
      } else if (ts.isCallExpression(node)) {
        const calleeName = nameOfCallee(node.expression);
        if (calleeName !== undefined) {
          const resolved = resolveCallTarget(checker, node.expression, relOf);
          calls.push({
            callerRelPath: relPath,
            ...(symbolStack.length > 0 ? { callerSymbol: symbolStack[symbolStack.length - 1] } : {}),
            calleeName,
            ...(resolved?.relPath !== undefined ? { calleeRelPath: resolved.relPath } : {}),
            ...(resolved?.name !== undefined ? { calleeSymbol: resolved.name } : {}),
            line: lineOf(sf, node.getStart()),
          });
        }
      }

      if (pushedSymbol !== undefined) symbolStack.push(pushedSymbol);
      ts.forEachChild(node, visit);
      if (pushedSymbol !== undefined) symbolStack.pop();
    };

    ts.forEachChild(sf, visit);
  }

  return { modules, symbols, imports, calls };
}

function isFunctionLike(node: ts.Node): boolean {
  return ts.isArrowFunction(node) || ts.isFunctionExpression(node);
}

/**
 * Value-imported binding names only. Type-only imports (`import type { X }` or
 * `import { type X }`) execute nothing, so they must NOT create tested_by coverage.
 * Structural `imports` edges do not use these names, so they are unaffected.
 */
function importedNames(node: ts.ImportDeclaration): string[] {
  const clause = node.importClause;
  if (clause === undefined) return [];
  if (clause.isTypeOnly) return [];
  const names: string[] = [];
  if (clause.name) names.push(clause.name.text);
  const bindings = clause.namedBindings;
  if (bindings) {
    if (ts.isNamespaceImport(bindings)) {
      names.push(bindings.name.text);
    } else {
      for (const element of bindings.elements) {
        if (element.isTypeOnly) continue;
        names.push(element.name.text);
      }
    }
  }
  return names;
}

function resolveCallTarget(
  checker: ts.TypeChecker,
  expr: ts.Expression,
  relOf: (abs: string) => string,
): { relPath?: string; name?: string } | undefined {
  let symbol = checker.getSymbolAtLocation(expr);
  if (symbol === undefined) return undefined;
  // Follow import aliases to the real declaration (imported functions call across files).
  if ((symbol.flags & ts.SymbolFlags.Alias) !== 0) {
    symbol = checker.getAliasedSymbol(symbol);
  }
  const declarations = symbol.getDeclarations();
  if (declarations === undefined || declarations.length === 0) return undefined;
  const decl = declarations[0];
  if (decl === undefined) return undefined;
  const sf = decl.getSourceFile();
  if (sf.isDeclarationFile) return { name: symbol.getName() };
  return { relPath: relOf(sf.fileName), name: symbol.getName() };
}
