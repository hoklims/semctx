import ts from "typescript";
import { resolve } from "node:path";
import { extractionContext, unwrapStaticExpression, type CompilerInputSnapshot } from "./ts-symbols";

type Context = { program: ts.Program; retained: Set<string> };
const contexts = new WeakMap<CompilerInputSnapshot, Context>();
const key = (path: string): string => {
  const normalized = resolve(path).replaceAll("\\", "/");
  return ts.sys.useCaseSensitiveFileNames ? normalized : normalized.toLowerCase();
};

/** Semantic refusal only: never invent dependency edges or read uncaptured repository sources. */
export function inspectSemanticDependencies(source: ts.SourceFile, snapshot?: CompilerInputSnapshot, sourcePath = source.fileName): string[] {
  const reasons = new Set<string>();
  const sdk = ts as unknown as { isIntrinsicJsxName(name: string): boolean };
  let needsChecker = false;
  const inspectSyntax = (node: ts.Node): void => {
    if (ts.isDecorator(node)) reasons.add("SOURCE_DECORATOR_UNSUPPORTED");
    if (ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) reasons.add("SOURCE_ACCESSOR_UNSUPPORTED");
    if (ts.isVariableDeclaration(node) && !ts.isIdentifier(node.name)) needsChecker = true;
    if (ts.isExportDeclaration(node) || (ts.isVariableStatement(node)
      && ts.getModifiers(node)?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword))) needsChecker = true;
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName;
      const name = ts.isIdentifier(tag) ? tag.text : ts.isJsxNamespacedName(tag) ? `${tag.namespace.text}:${tag.name.text}` : undefined;
      if (name === undefined || !sdk.isIntrinsicJsxName(name)) reasons.add("SOURCE_JSX_COMPONENT_UNSUPPORTED");
    }
    if ((ts.isPropertyAccessExpression(node) && ["call", "apply", "bind", "constructor"].includes(node.name.text))
      || (ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression) && node.argumentExpression.text === "constructor")) needsChecker = true;
    if (ts.isHeritageClause(node) && node.token === ts.SyntaxKind.ExtendsKeyword && (ts.isClassDeclaration(node.parent) || ts.isClassExpression(node.parent))) needsChecker = true;
    ts.forEachChild(node, inspectSyntax);
  };
  inspectSyntax(source);
  if (!needsChecker) return [...reasons].sort();
  const inputs = snapshot ?? new Map([[source.fileName, source.text]]);
  let context = contexts.get(inputs);
  if (context === undefined) {
    const paths = [...inputs.keys()].filter(path => /\.[cm]?[jt]sx?$/.test(path));
    context = { program: extractionContext.createProgram(paths, inputs), retained: new Set(paths.map(key)) };
    contexts.set(inputs, context);
  }
  const { program, retained } = context;
  const bound = program.getSourceFile(sourcePath);
  if (bound === undefined) return ["SOURCE_SEMANTIC_SOURCE_UNAVAILABLE"];
  const checker = program.getTypeChecker();
  const internal = (node: ts.Node): boolean => retained.has(key(node.getSourceFile().fileName)) && !program.isSourceFileDefaultLibrary(node.getSourceFile());
  const declarations = (expression: ts.Expression): readonly ts.Declaration[] => {
    let symbol = checker.getSymbolAtLocation(unwrapStaticExpression(expression));
    if (symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0) symbol = checker.getAliasedSymbol(symbol);
    return symbol?.getDeclarations() ?? [];
  };
  const destructuredOrigin = (declaration: ts.Declaration, seen = new Set<ts.Node>()): boolean => {
    if (seen.has(declaration)) return false;
    seen.add(declaration);
    if (ts.isBindingElement(declaration)) return true;
    if (!ts.isVariableDeclaration(declaration) || declaration.initializer === undefined) return false;
    const initializer = unwrapStaticExpression(declaration.initializer);
    return ts.isIdentifier(initializer) && declarations(initializer).some(origin => destructuredOrigin(origin, seen));
  };
  const potentiallyCallable = (type: ts.Type): boolean => {
    if ((type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter)) !== 0) return true;
    if (type.isUnionOrIntersection()) return type.types.some(potentiallyCallable);
    return type.getCallSignatures().length > 0 || type.getConstructSignatures().length > 0;
  };
  const moduleSymbol = checker.getSymbolAtLocation(bound);
  if (moduleSymbol !== undefined) for (let exported of checker.getExportsOfModule(moduleSymbol)) {
    if ((exported.flags & ts.SymbolFlags.Alias) !== 0) exported = checker.getAliasedSymbol(exported);
    const origins = exported.getDeclarations() ?? [];
    if (origins.some(origin => internal(origin) && destructuredOrigin(origin))
      && potentiallyCallable(checker.getTypeOfSymbolAtLocation(exported, origins[0] ?? bound))) {
      reasons.add("SOURCE_DESTRUCTURED_CALLABLE_EXPORT_UNSUPPORTED");
    }
    if (origins.some(origin => internal(origin) && ts.isVariableDeclaration(origin)
      && (origin.initializer === undefined || !(ts.isArrowFunction(origin.initializer) || ts.isFunctionExpression(origin.initializer))))
      && potentiallyCallable(checker.getTypeOfSymbolAtLocation(exported, origins[0] ?? bound))) {
      reasons.add("SOURCE_CALLABLE_EXPORT_UNSUPPORTED");
    }
  }
  const internalCallable = (expression: ts.Expression, seen = new Set<ts.Node>()): boolean => {
    const receiver = unwrapStaticExpression(expression);
    if (seen.has(receiver)) return false;
    seen.add(receiver);
    const type = checker.getTypeAtLocation(receiver);
    if ([...type.getCallSignatures(), ...type.getConstructSignatures()].some(signature => {
      const declaration = signature.getDeclaration(); return declaration !== undefined && internal(declaration);
    })) return true;
    return declarations(receiver).some(declaration => ts.isVariableDeclaration(declaration) && declaration.initializer !== undefined
      && internalCallable(declaration.initializer, seen));
  };
  const functionHelper = (node: ts.PropertyAccessExpression): boolean => {
    if (!["call", "apply", "bind"].includes(node.name.text)) return false;
    const receiver = unwrapStaticExpression(node.expression);
    const symbol = checker.getSymbolAtLocation(node) ?? checker.getPropertyOfType(checker.getTypeAtLocation(receiver), node.name.text);
    return (symbol?.getDeclarations() ?? []).some(declaration => program.isSourceFileDefaultLibrary(declaration.getSourceFile())
      && ts.isInterfaceDeclaration(declaration.parent) && ["Function", "CallableFunction", "NewableFunction"].includes(declaration.parent.name.text)
      && ["call", "apply", "bind"].includes(symbol!.getName())) && internalCallable(receiver);
  };
  const intrinsicConstructor = (node: ts.PropertyAccessExpression | ts.ElementAccessExpression): boolean => {
    const name = ts.isPropertyAccessExpression(node) ? node.name.text : ts.isStringLiteral(node.argumentExpression) ? node.argumentExpression.text : undefined;
    if (name !== "constructor") return false;
    const receiver = unwrapStaticExpression(node.expression);
    const type = checker.getTypeAtLocation(receiver);
    if (type.getCallSignatures().length === 0 && type.getConstructSignatures().length === 0) return false;
    const symbol = checker.getSymbolAtLocation(node) ?? checker.getPropertyOfType(type, name);
    return (symbol?.getDeclarations() ?? []).some(declaration => program.isSourceFileDefaultLibrary(declaration.getSourceFile())
      && ts.isInterfaceDeclaration(declaration.parent) && declaration.parent.name.text === "Object" && symbol!.getName() === "constructor");
  };
  const internalBase = (expression: ts.Expression, seen = new Set<ts.Node>()): boolean => {
    const base = unwrapStaticExpression(expression);
    if (seen.has(base)) return false;
    seen.add(base);
    if (ts.isConditionalExpression(base)) return internalBase(base.whenTrue, seen) || internalBase(base.whenFalse, seen);
    if ((checker.getTypeAtLocation(base).getSymbol()?.getDeclarations() ?? []).some(declaration =>
      (ts.isClassDeclaration(declaration) || ts.isClassExpression(declaration)) && internal(declaration))) return true;
    return declarations(base).some(declaration => ((ts.isClassDeclaration(declaration) || ts.isClassExpression(declaration)
      || ts.isFunctionDeclaration(declaration)) && internal(declaration)) || (ts.isVariableDeclaration(declaration)
      && declaration.initializer !== undefined && internalBase(declaration.initializer, seen)));
  };
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && functionHelper(node)) reasons.add("SOURCE_FUNCTION_HELPER_UNSUPPORTED");
    if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) && intrinsicConstructor(node)) reasons.add("SOURCE_DYNAMIC_EVALUATION_UNSUPPORTED");
    if (ts.isHeritageClause(node) && node.token === ts.SyntaxKind.ExtendsKeyword && (ts.isClassDeclaration(node.parent) || ts.isClassExpression(node.parent))) {
      for (const base of node.types) {
        if (internalBase(base.expression)) reasons.add("SOURCE_INTERNAL_HERITAGE_UNSUPPORTED");
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(bound);
  return [...reasons].sort();
}
