import ts from "typescript";
import { readFileSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";

/**
 * The two ADR-0019 baselines. Both are suggestion sets over repo-relative file paths, produced
 * without invoking the candidate CLI, so they can be compared against it on equal footing.
 */

export function changedFilesBaseline(changedFiles: readonly string[]): string[] {
  return [...new Set(changedFiles)].sort();
}

function toPosix(path: string): string {
  return path.split("\\").join("/");
}

/** Static relative (`./`, `../`) module specifiers only — this is source-level structure, not resolved runtime dependency truth. */
export function extractRelativeImportSpecifiers(sourceText: string, fileName: string): string[] {
  const sourceFile = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, false, ts.ScriptKind.TSX);
  const specifiers: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      && node.moduleSpecifier !== undefined
      && ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const arg = node.arguments[0];
      if (arg !== undefined && ts.isStringLiteral(arg)) specifiers.push(arg.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return specifiers.filter((specifier) => specifier.startsWith("."));
}

const RESOLUTION_SUFFIXES = ["", ".ts", ".tsx", ".d.ts", "/index.ts", "/index.tsx"];

/** Resolves a relative specifier to one member of the known repo-relative file set, or none. */
function resolveRelativeSpecifier(
  fromFileRelative: string,
  specifier: string,
  knownFiles: ReadonlySet<string>,
): string | undefined {
  const fromDirectory = dirname(fromFileRelative);
  const joined = toPosix(normalize(join(fromDirectory, specifier)));
  for (const suffix of RESOLUTION_SUFFIXES) {
    const candidate = `${joined}${suffix}`;
    if (knownFiles.has(candidate)) return candidate;
  }
  return undefined;
}

export interface ImportGraphFile {
  relativePath: string;
  absolutePath: string;
}

/**
 * Declared, bounded one-hop local neighborhood: files the changed files import, plus files that
 * import a changed file, restricted to relative (repo-internal) specifiers. Not a runtime call
 * graph — a cheap syntactic proxy, explicitly labelled as such (ADR 0019).
 */
export function oneHopImportNeighborhoodBaseline(
  workspaceRoot: string,
  changedFiles: readonly string[],
  allFiles: readonly ImportGraphFile[],
): string[] {
  const knownFiles = new Set(allFiles.map((f) => f.relativePath));
  const changedSet = new Set(changedFiles);
  const neighborhood = new Set<string>();

  const importsOf = new Map<string, string[]>();
  for (const file of allFiles) {
    let text: string;
    try {
      text = readFileSync(file.absolutePath, "utf8");
    } catch {
      continue;
    }
    const specifiers = extractRelativeImportSpecifiers(text, file.absolutePath);
    const resolved = specifiers
      .map((specifier) => resolveRelativeSpecifier(file.relativePath, specifier, knownFiles))
      .filter((target): target is string => target !== undefined);
    importsOf.set(file.relativePath, resolved);
  }

  for (const changed of changedFiles) {
    for (const target of importsOf.get(changed) ?? []) {
      if (!changedSet.has(target)) neighborhood.add(target);
    }
  }
  for (const [file, targets] of importsOf) {
    if (changedSet.has(file)) continue;
    if (targets.some((target) => changedSet.has(target))) neighborhood.add(file);
  }

  void workspaceRoot;
  return [...neighborhood].sort();
}

export function discoverTypeScriptFiles(root: string, relativePaths: readonly string[]): ImportGraphFile[] {
  return relativePaths
    .filter((p) => /\.(ts|tsx)$/.test(p))
    .map((relativePath) => ({ relativePath: toPosix(relativePath), absolutePath: join(root, relativePath) }));
}

export function toRepoRelative(root: string, absolutePath: string): string {
  return toPosix(relative(root, absolutePath));
}
