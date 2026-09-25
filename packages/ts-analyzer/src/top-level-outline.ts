import { createHash } from "node:crypto";
import ts from "typescript";

/**
 * File-scope outline of one TypeScript source text, used to classify diff lines that fall outside
 * every indexed symbol range: top-level constants, imports, export clauses, module statements and
 * comments. It is a pure syntax pass over the given text — no program, no resolution — so it can
 * be run at impact time on exactly the side of the diff whose line coordinates are being joined.
 *
 * References are collected by identifier text, not by symbol resolution: a local variable that
 * shadows a top-level name is reported as a reference. That over-approximation is deliberate; a
 * reference that is missed would read as "no dependent" and a spurious one only widens the reach.
 */

export type TopLevelStatementKind =
  | "function"
  | "class"
  | "interface"
  | "type"
  | "enum"
  | "namespace"
  | "variable"
  | "import"
  | "export"
  | "statement";

export interface TopLevelStatementOutline {
  kind: TopLevelStatementKind;
  /** 1-based line of the statement's first token (leading comments excluded). */
  startLine: number;
  /** 1-based line of the statement's last character. */
  endLine: number;
  /** 1-based line where the statement's leading comments start; equals `startLine` without comments. */
  leadingStartLine: number;
  /** Names the statement binds at file scope (imports: local bindings). Empty for plain statements. */
  declaredNames: string[];
  /** Identifier texts referenced by the statement, minus its own declared names and property names. */
  referencedNames: string[];
  /** A side-effect import (`import "./x"`) that binds nothing but runs a module. */
  sideEffectImport?: true;
  /**
   * Digest of the statement's token stream: every node and token kind (keywords and operators
   * included), identifier and literal texts, template texts as written — without comments,
   * whitespace, positions, list commas or a final `;`. Equal digests mean the edit between two
   * texts of the statement is formatting or comments only.
   */
  digest: string;
  /**
   * Whether evaluating the statement when the module loads can run code: a call, `new`, `await`,
   * a decorator, a static initializer, an assignment, or loading another module. Function bodies,
   * which run only when called, are not inspected.
   */
  executesOnLoad: boolean;
  /** For an import or re-export: the module specifier. */
  moduleSpecifier?: string;
  /** For an import: each local binding, the name it imports, and whether it is type-only. */
  importBindings?: { local: string; imported: string; typeOnly: boolean }[];
  /**
   * For an import or re-export: whether it loads the module at run time. `never` for `import type`
   * and `export type`; `maybe` when every binding is an inline `type` or there is none (erased or
   * kept depending on the compiler configuration); `yes` for a side-effect import, a value binding
   * or `export *` (a value binding used only as a type is still taken to load its module).
   */
  loadsModule?: "never" | "maybe" | "yes";
}

export interface TopLevelOutline {
  statements: TopLevelStatementOutline[];
  /** Local names made visible to importers: export modifiers, local export clauses, `default`. */
  exportedNames: string[];
  /** True when the parser reported syntax errors; the outline is then best-effort. */
  hasSyntaxErrors: boolean;
  /**
   * Lines holding a comment that changes compilation or bundling (`@ts-ignore`, `@ts-expect-error`,
   * `@ts-nocheck`, `#__PURE__`, bundler magic comments, triple-slash directives): an edit there is
   * never "comments only".
   */
  directiveLines: number[];
  /** Lines holding a Plane-A marker (`@invariant`, `@capability`, `@contract`, `@risk`, …). */
  markerLines: number[];
}

function scriptKindFor(relPath: string): ts.ScriptKind {
  if (relPath.endsWith(".tsx")) return ts.ScriptKind.TSX;
  return ts.ScriptKind.TS;
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === kind);
}

function bindingNames(name: ts.BindingName, out: string[]): void {
  if (ts.isIdentifier(name)) {
    out.push(name.text);
    return;
  }
  for (const element of name.elements) {
    if (ts.isOmittedExpression(element)) continue;
    bindingNames(element.name, out);
  }
}

/** An identifier in a position that names a member rather than referencing a binding. */
function isMemberName(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (parent === undefined) return false;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return true;
  if (ts.isQualifiedName(parent) && parent.right === node) return true;
  if (
    (ts.isPropertyAssignment(parent)
      || ts.isPropertyDeclaration(parent)
      || ts.isPropertySignature(parent)
      || ts.isMethodDeclaration(parent)
      || ts.isMethodSignature(parent)
      || ts.isGetAccessorDeclaration(parent)
      || ts.isSetAccessorDeclaration(parent)
      || ts.isEnumMember(parent))
    && parent.name === node
  ) return true;
  if (ts.isBindingElement(parent) && parent.propertyName === node) return true;
  if ((ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent)) && parent.propertyName === node) return true;
  if (ts.isJsxAttribute(parent) && parent.name === node) return true;
  return false;
}

function referencedIdentifiers(statement: ts.Statement, declared: ReadonlySet<string>): string[] {
  const names = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      if (!isMemberName(node) && !declared.has(node.text)) names.add(node.text);
      return;
    }
    if (ts.isShorthandPropertyAssignment(node)) names.add(node.name.text);
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(statement, visit);
  return [...names].sort();
}

function lineOf(sf: ts.SourceFile, position: number): number {
  return sf.getLineAndCharacterOfPosition(position).line + 1;
}

function leadingCommentStart(sf: ts.SourceFile, statement: ts.Statement): number | undefined {
  const ranges = ts.getLeadingCommentRanges(sf.text, statement.getFullStart());
  return ranges === undefined || ranges.length === 0 ? undefined : ranges[0]!.pos;
}

function describeStatement(statement: ts.Statement): {
  kind: TopLevelStatementKind;
  declaredNames: string[];
  exportedLocals: string[];
  sideEffectImport?: true;
} {
  const exported = hasModifier(statement, ts.SyntaxKind.ExportKeyword);
  const isDefault = hasModifier(statement, ts.SyntaxKind.DefaultKeyword);
  const named = (kind: TopLevelStatementKind, name: ts.Identifier | undefined) => {
    const declaredNames = name === undefined ? (isDefault ? ["default"] : []) : [name.text];
    const exportedLocals = exported ? [...declaredNames, ...(isDefault && name !== undefined ? ["default"] : [])] : [];
    return { kind, declaredNames, exportedLocals };
  };
  if (ts.isFunctionDeclaration(statement)) return named("function", statement.name);
  if (ts.isClassDeclaration(statement)) return named("class", statement.name);
  if (ts.isInterfaceDeclaration(statement)) return named("interface", statement.name);
  if (ts.isTypeAliasDeclaration(statement)) return named("type", statement.name);
  if (ts.isEnumDeclaration(statement)) return named("enum", statement.name);
  if (ts.isModuleDeclaration(statement)) {
    return named("namespace", ts.isIdentifier(statement.name) ? statement.name : undefined);
  }
  if (ts.isVariableStatement(statement)) {
    const declaredNames: string[] = [];
    for (const declaration of statement.declarationList.declarations) bindingNames(declaration.name, declaredNames);
    return { kind: "variable", declaredNames, exportedLocals: exported ? declaredNames : [] };
  }
  if (ts.isImportDeclaration(statement)) {
    const clause = statement.importClause;
    if (clause === undefined) return { kind: "import", declaredNames: [], exportedLocals: [], sideEffectImport: true };
    const declaredNames: string[] = [];
    if (clause.name !== undefined) declaredNames.push(clause.name.text);
    const bindings = clause.namedBindings;
    if (bindings !== undefined) {
      if (ts.isNamespaceImport(bindings)) declaredNames.push(bindings.name.text);
      else for (const element of bindings.elements) declaredNames.push(element.name.text);
    }
    return { kind: "import", declaredNames, exportedLocals: [] };
  }
  if (ts.isImportEqualsDeclaration(statement)) {
    return { kind: "import", declaredNames: [statement.name.text], exportedLocals: exported ? [statement.name.text] : [] };
  }
  if (ts.isExportDeclaration(statement)) {
    // `export { a, b as c }` exports local bindings; `export ... from` re-exports another module.
    const exportedLocals: string[] = [];
    if (statement.moduleSpecifier === undefined && statement.exportClause !== undefined && ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) exportedLocals.push((element.propertyName ?? element.name).text);
    }
    return { kind: "export", declaredNames: [], exportedLocals };
  }
  if (ts.isExportAssignment(statement)) {
    // `export default local` / `export = local` exports the local binding itself (and a property
    // chain `export default local.member` exports part of it).
    let root: ts.Expression = statement.expression;
    while (ts.isPropertyAccessExpression(root) || ts.isElementAccessExpression(root) || ts.isParenthesizedExpression(root)) {
      root = root.expression;
    }
    return { kind: "export", declaredNames: ["default"], exportedLocals: ["default", ...(ts.isIdentifier(root) ? [root.text] : [])] };
  }
  return { kind: "statement", declaredNames: [], exportedLocals: [] };
}

/**
 * Walks tokens, not only child nodes: operators, `let`/`const`/`using`, `extends`/`implements`,
 * `type` and `export =` are tokens or flags that `forEachChild` never visits.
 */
function structuralDigest(statement: ts.Node, sf: ts.SourceFile): string {
  const parts: string[] = [];
  const visit = (node: ts.Node): void => {
    parts.push(String(node.kind));
    if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) parts.push(node.text);
    else if (ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      // A tag (`String.raw`) sees the escapes as written.
      parts.push(JSON.stringify(node.rawText ?? node.text));
    } else if (ts.isLiteralExpression(node) || ts.isJsxText(node)) {
      parts.push(JSON.stringify(node.text));
    }
    const children = node.getChildren(sf);
    children.forEach((child, position) => {
      if (ts.isJSDoc(child) || child.kind === ts.SyntaxKind.CommaToken) return;
      if (child.kind === ts.SyntaxKind.SemicolonToken && position === children.length - 1) return;
      visit(child);
    });
    parts.push(")");
  };
  visit(statement);
  return createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 32);
}

const DEFERRED_BODY_KINDS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.ArrowFunction,
  ts.SyntaxKind.FunctionExpression,
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.MethodDeclaration,
  ts.SyntaxKind.GetAccessor,
  ts.SyntaxKind.SetAccessor,
  ts.SyntaxKind.Constructor,
]);

const ASSIGNMENT_OPERATORS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.EqualsToken,
  ts.SyntaxKind.PlusEqualsToken,
  ts.SyntaxKind.MinusEqualsToken,
  ts.SyntaxKind.AsteriskEqualsToken,
  ts.SyntaxKind.AsteriskAsteriskEqualsToken,
  ts.SyntaxKind.SlashEqualsToken,
  ts.SyntaxKind.PercentEqualsToken,
  ts.SyntaxKind.LessThanLessThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.AmpersandEqualsToken,
  ts.SyntaxKind.BarEqualsToken,
  ts.SyntaxKind.CaretEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
]);

/** Whether evaluating `node` (not calling what it defines) can run code. */
function expressionExecutes(node: ts.Node): boolean {
  if (DEFERRED_BODY_KINDS.has(node.kind)) {
    // The body runs only when called; decorators and computed names still run now.
    const withNames = node as ts.Node & { name?: ts.Node };
    return (ts.canHaveDecorators(node) && (ts.getDecorators(node) ?? []).length > 0)
      || (withNames.name !== undefined && ts.isComputedPropertyName(withNames.name) && expressionExecutes(withNames.name.expression));
  }
  if (ts.isClassLike(node)) return classExecutes(node);
  if (
    ts.isCallExpression(node)
    || ts.isNewExpression(node)
    || ts.isTaggedTemplateExpression(node)
    || ts.isAwaitExpression(node)
    || ts.isYieldExpression(node)
    || ts.isDeleteExpression(node)
    || ts.isDecorator(node)
  ) return true;
  if (ts.isBinaryExpression(node) && ASSIGNMENT_OPERATORS.has(node.operatorToken.kind)) return true;
  if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node))
    && (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)) return true;
  let executes = false;
  ts.forEachChild(node, (child) => {
    if (!executes && !ts.isTypeNode(child)) executes = expressionExecutes(child);
  });
  return executes;
}

function classExecutes(node: ts.ClassLikeDeclaration): boolean {
  if ((ts.getDecorators(node) ?? []).length > 0) return true;
  for (const clause of node.heritageClauses ?? []) {
    if (clause.token === ts.SyntaxKind.ExtendsKeyword && clause.types.some((type) => expressionExecutes(type.expression))) return true;
  }
  for (const member of node.members) {
    if (ts.isClassStaticBlockDeclaration(member)) return true;
    if (ts.canHaveDecorators(member) && (ts.getDecorators(member) ?? []).length > 0) return true;
    // Parameter decorators run at class definition (`__param`), like member decorators.
    if (ts.isFunctionLike(member) && member.parameters.some((parameter) => (ts.getDecorators(parameter) ?? []).length > 0)) return true;
    if (member.name !== undefined && ts.isComputedPropertyName(member.name) && expressionExecutes(member.name.expression)) return true;
    const isStatic = ts.canHaveModifiers(member) && (ts.getModifiers(member) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword);
    if (isStatic && ts.isPropertyDeclaration(member) && member.initializer !== undefined && expressionExecutes(member.initializer)) return true;
  }
  return false;
}

function statementExecutes(statement: ts.Statement): boolean {
  if (hasModifier(statement, ts.SyntaxKind.DeclareKeyword)) return false;
  if (ts.isFunctionDeclaration(statement) || ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) return false;
  if (ts.isImportDeclaration(statement)) return statement.importClause?.isTypeOnly !== true;
  if (ts.isImportEqualsDeclaration(statement)) return !statement.isTypeOnly;
  if (ts.isExportDeclaration(statement)) return statement.moduleSpecifier !== undefined && !statement.isTypeOnly;
  if (ts.isExportAssignment(statement)) return expressionExecutes(statement.expression);
  if (ts.isClassDeclaration(statement)) return classExecutes(statement);
  if (ts.isEnumDeclaration(statement)) {
    if (hasModifier(statement, ts.SyntaxKind.ConstKeyword)) return false;
    return statement.members.some((member) => member.initializer !== undefined && expressionExecutes(member.initializer));
  }
  if (ts.isModuleDeclaration(statement)) {
    const body = statement.body;
    if (body === undefined) return false;
    if (ts.isModuleBlock(body)) return body.statements.some(statementExecutes);
    return statementExecutes(body as unknown as ts.Statement);
  }
  if (ts.isVariableStatement(statement)) {
    // `using` / `await using` run the disposer when module evaluation ends.
    if ((statement.declarationList.flags & ts.NodeFlags.Using) !== 0) return true;
    return statement.declarationList.declarations.some((declaration) =>
      declaration.initializer !== undefined && expressionExecutes(declaration.initializer));
  }
  return true;
}

function moduleLoad(statement: ts.Statement): TopLevelStatementOutline["loadsModule"] {
  if (ts.isImportDeclaration(statement)) {
    const clause = statement.importClause;
    if (clause === undefined) return "yes";
    if (clause.isTypeOnly) return "never";
    const named = clause.namedBindings;
    if (clause.name !== undefined || (named !== undefined && ts.isNamespaceImport(named))) return "yes";
    return named !== undefined && named.elements.some((element) => !element.isTypeOnly) ? "yes" : "maybe";
  }
  if (ts.isImportEqualsDeclaration(statement) && ts.isExternalModuleReference(statement.moduleReference)) {
    return statement.isTypeOnly ? "never" : "yes";
  }
  if (ts.isExportDeclaration(statement) && statement.moduleSpecifier !== undefined) {
    if (statement.isTypeOnly) return "never";
    const clause = statement.exportClause;
    return clause !== undefined && ts.isNamedExports(clause) && clause.elements.every((element) => element.isTypeOnly) ? "maybe" : "yes";
  }
  return undefined;
}

function importDetails(statement: ts.Statement): Pick<TopLevelStatementOutline, "moduleSpecifier" | "importBindings"> {
  if (ts.isExportDeclaration(statement) && statement.moduleSpecifier !== undefined && ts.isStringLiteralLike(statement.moduleSpecifier)) {
    return { moduleSpecifier: statement.moduleSpecifier.text };
  }
  if (ts.isImportEqualsDeclaration(statement) && ts.isExternalModuleReference(statement.moduleReference) && ts.isStringLiteralLike(statement.moduleReference.expression)) {
    return {
      moduleSpecifier: statement.moduleReference.expression.text,
      importBindings: [{ local: statement.name.text, imported: "=", typeOnly: statement.isTypeOnly }],
    };
  }
  if (!ts.isImportDeclaration(statement) || !ts.isStringLiteralLike(statement.moduleSpecifier)) return {};
  const bindings: { local: string; imported: string; typeOnly: boolean }[] = [];
  const clause = statement.importClause;
  const clauseTypeOnly = clause?.isTypeOnly === true;
  if (clause?.name !== undefined) bindings.push({ local: clause.name.text, imported: "default", typeOnly: clauseTypeOnly });
  const named = clause?.namedBindings;
  if (named !== undefined) {
    if (ts.isNamespaceImport(named)) bindings.push({ local: named.name.text, imported: "*", typeOnly: clauseTypeOnly });
    else {
      for (const element of named.elements) {
        bindings.push({
          local: element.name.text,
          imported: (element.propertyName ?? element.name).text,
          typeOnly: clauseTypeOnly || element.isTypeOnly,
        });
      }
    }
  }
  return { moduleSpecifier: statement.moduleSpecifier.text, importBindings: bindings };
}

const DIRECTIVE_RE = /@ts-(?:ignore|expect-error|nocheck|check)\b|@jsx(?:Frag|ImportSource|Runtime)?\b|#__PURE__|@__PURE__|__NO_SIDE_EFFECTS__|webpack[A-Z][A-Za-z]*\s*:|@vite-ignore|^\s*\/\/\/\s*<(?:reference|amd-module)/;

/** Same tag set as the marker parser; a marker and its statement sit on one line. */
const MARKER_LINE_RE = /@(?:capability|invariant|contract|risk|boundedcontext|tag)[ \t]+[A-Za-z0-9]/i;

/** Outline every file-scope statement of a TypeScript source text. */
export function outlineTopLevel(sourceText: string, relPath: string): TopLevelOutline {
  const sf = ts.createSourceFile(relPath, sourceText, ts.ScriptTarget.Latest, true, scriptKindFor(relPath));
  const exportedNames = new Set<string>();
  const statements: TopLevelStatementOutline[] = [];
  for (const statement of sf.statements) {
    const described = describeStatement(statement);
    for (const name of described.exportedLocals) exportedNames.add(name);
    const startLine = lineOf(sf, statement.getStart(sf));
    const commentStart = leadingCommentStart(sf, statement);
    const loadsModule = moduleLoad(statement);
    statements.push({
      kind: described.kind,
      startLine,
      endLine: lineOf(sf, statement.getEnd()),
      leadingStartLine: commentStart === undefined ? startLine : lineOf(sf, commentStart),
      declaredNames: described.declaredNames,
      referencedNames: referencedIdentifiers(statement, new Set(described.declaredNames)),
      ...(described.sideEffectImport === true ? { sideEffectImport: true as const } : {}),
      digest: structuralDigest(statement, sf),
      executesOnLoad: statementExecutes(statement),
      ...importDetails(statement),
      ...(loadsModule !== undefined ? { loadsModule } : {}),
    });
  }
  const diagnostics = (sf as unknown as { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
  const directiveLines: number[] = [];
  const markerLines: number[] = [];
  sourceText.split(/\r?\n/).forEach((line, index) => {
    if (DIRECTIVE_RE.test(line)) directiveLines.push(index + 1);
    if (MARKER_LINE_RE.test(line)) markerLines.push(index + 1);
  });
  return {
    statements,
    exportedNames: [...exportedNames].sort(),
    hasSyntaxErrors: diagnostics.length > 0,
    directiveLines,
    markerLines,
  };
}

/**
 * A module-to-module link written in a source text. The indexer turns only resolved `import`
 * declarations into `imports` edges; re-exports (`export … from`), `import()` and `require()` leave
 * no edge, so change impact reads them here to keep modules that reach a change through them from
 * disappearing from every tier. `specifier` is null for a non-literal `import()`/`require()`.
 */
export interface ModuleLinkOutline {
  kind: "import" | "reexport" | "dynamic_import" | "require";
  specifier: string | null;
  line: number;
  /**
   * The link reads the module whole — a value namespace import (`import * as`), a star re-export
   * (`export *`, `export * as`), `import()` or `require()` — so an export added to that module
   * changes what the linking module sees, though nothing there names it.
   */
  whole?: true;
}

/** Every module link of a TypeScript/JavaScript source text, in source order. */
export function outlineModuleLinks(sourceText: string, relPath: string): ModuleLinkOutline[] {
  const sf = ts.createSourceFile(relPath, sourceText, ts.ScriptTarget.Latest, true, scriptKindFor(relPath));
  const links: ModuleLinkOutline[] = [];
  const literal = (node: ts.Node | undefined): string | null =>
    node !== undefined && ts.isStringLiteralLike(node) ? node.text : null;
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      const whole = clause !== undefined && !clause.isTypeOnly && clause.namedBindings !== undefined && ts.isNamespaceImport(clause.namedBindings);
      links.push({ kind: "import", specifier: literal(node.moduleSpecifier), line: lineOf(sf, node.getStart(sf)), ...(whole ? { whole: true as const } : {}) });
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined) {
      const whole = !node.isTypeOnly && (node.exportClause === undefined || ts.isNamespaceExport(node.exportClause));
      links.push({ kind: "reexport", specifier: literal(node.moduleSpecifier), line: lineOf(sf, node.getStart(sf)), ...(whole ? { whole: true as const } : {}) });
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      links.push({ kind: "require", specifier: literal(node.moduleReference.expression), line: lineOf(sf, node.getStart(sf)), ...(node.isTypeOnly ? {} : { whole: true as const }) });
    } else if (ts.isCallExpression(node)) {
      const isImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
      if (isImport || isRequire) {
        links.push({
          kind: isImport ? "dynamic_import" : "require",
          specifier: literal(node.arguments[0]),
          line: lineOf(sf, node.getStart(sf)),
          whole: true,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return links;
}
