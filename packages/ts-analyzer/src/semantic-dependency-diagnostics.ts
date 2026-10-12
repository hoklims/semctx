import ts from "typescript";
import { dirname, relative, resolve } from "node:path";
import type { RepositoryGraph, RepositoryNode } from "@semantic-context/core";
import { isBuiltin } from "node:module";
import { extractionContext, unwrapStaticExpression, retainedCallableCoordinate, retainedFunctionOwnerCoordinate, isModeledCallCallee, type CompilerInputSnapshot } from "./ts-symbols";
import { isOrdinaryNativeProcessMember } from "./javascript-diagnostics";

type Context = { program: ts.Program; retained: Set<string> };
const contexts = new WeakMap<CompilerInputSnapshot, Context>();
const ownership = new WeakMap<CompilerInputSnapshot, { graph: RepositoryGraph; root: string; callbacks: Map<string, boolean> }>();
/** Internal, per-assembly replacement. Never transfers proof between temporal captures. */
export function registerOpaqueCallbackOwnership(inputs: CompilerInputSnapshot, graph: RepositoryGraph, root: string): void {
  ownership.set(inputs, { graph, root, callbacks: new Map() });
}
const key = (path: string): string => {
  const normalized = resolve(path).replaceAll("\\", "/");
  return ts.sys.useCaseSensitiveFileNames ? normalized : normalized.toLowerCase();
};

/** Semantic refusal only: never invent dependency edges or read uncaptured repository sources. */
export function inspectSemanticDependencies(source: ts.SourceFile, snapshot?: CompilerInputSnapshot, sourcePath = source.fileName): string[] {
  const reasons = new Set<string>();
  if (source.referencedFiles.length > 0) reasons.add("SOURCE_REFERENCE_PATH_UNSUPPORTED");
  const sdk = ts as unknown as { isIntrinsicJsxName(name: string): boolean };
  let needsChecker = false;
  const executionModule = (name: string): string | undefined => ["child_process", "node:child_process"].includes(name) ? "SOURCE_PROCESS_LAUNCH_UNSUPPORTED"
    : ["vm", "node:vm"].includes(name) ? "SOURCE_RUNTIME_EVALUATION_UNSUPPORTED" : undefined;
  const assignment = (node: ts.Node): node is ts.BinaryExpression => ts.isBinaryExpression(node)
    && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment;
  const numericUnary = (node: ts.Node): node is ts.PrefixUnaryExpression | ts.PostfixUnaryExpression => (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node))
    && [ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken, ts.SyntaxKind.TildeToken, ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator);
  const propertyMembership = (node: ts.Node): node is ts.BinaryExpression => ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.InKeyword;
  const coercingBinary = (node: ts.Node): node is ts.BinaryExpression => ts.isBinaryExpression(node) && [
    ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken, ts.SyntaxKind.AsteriskToken, ts.SyntaxKind.SlashToken, ts.SyntaxKind.PercentToken, ts.SyntaxKind.AsteriskAsteriskToken,
    ts.SyntaxKind.LessThanLessThanToken, ts.SyntaxKind.GreaterThanGreaterThanToken, ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken,
    ts.SyntaxKind.AmpersandToken, ts.SyntaxKind.BarToken, ts.SyntaxKind.CaretToken,
    ts.SyntaxKind.LessThanToken, ts.SyntaxKind.LessThanEqualsToken, ts.SyntaxKind.GreaterThanToken, ts.SyntaxKind.GreaterThanEqualsToken,
    ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken,
    ts.SyntaxKind.PlusEqualsToken, ts.SyntaxKind.MinusEqualsToken, ts.SyntaxKind.AsteriskEqualsToken, ts.SyntaxKind.SlashEqualsToken, ts.SyntaxKind.PercentEqualsToken,
    ts.SyntaxKind.AsteriskAsteriskEqualsToken, ts.SyntaxKind.LessThanLessThanEqualsToken, ts.SyntaxKind.GreaterThanGreaterThanEqualsToken,
    ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken, ts.SyntaxKind.AmpersandEqualsToken, ts.SyntaxKind.BarEqualsToken, ts.SyntaxKind.CaretEqualsToken,
  ].includes(node.operatorToken.kind);
  const asyncOwner = (node: ts.Node): boolean => {
    for (let owner: ts.Node | undefined = node.parent; owner !== undefined; owner = owner.parent) if (ts.isFunctionLike(owner)) {
      return ts.canHaveModifiers(owner) && ts.getModifiers(owner)?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword) === true;
    }
    return false;
  };
  const inspectSyntax = (node: ts.Node): void => {
    if (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword) needsChecker = true;
    if (ts.isPropertyAssignment(node) && !ts.isComputedPropertyName(node.name)
      && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) && node.name.text === "__proto__") needsChecker = true;
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && executionModule(node.moduleSpecifier.text) !== undefined) needsChecker = true;
    if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier)
      && !(node.exportClause !== undefined && ts.isNamedExports(node.exportClause) && node.exportClause.elements.every(element => element.isTypeOnly))) {
      const kind = executionModule(node.moduleSpecifier.text); if (kind !== undefined) reasons.add(kind);
    }
    if (ts.isCallExpression(node)) needsChecker = true;
    if (ts.isVariableDeclarationList(node) && (node.flags & ts.NodeFlags.Using) !== 0) reasons.add("SOURCE_DISPOSAL_UNSUPPORTED");
    if (ts.isElementAccessExpression(node) || ts.isComputedPropertyName(node)) needsChecker = true;
    if (ts.isTemplateExpression(node) || coercingBinary(node) || numericUnary(node) || propertyMembership(node)
      || (ts.isReturnStatement(node) && asyncOwner(node))
      || (ts.isArrowFunction(node) && ts.getModifiers(node)?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword))) needsChecker = true;
    if ((ts.isIdentifier(node) || ts.isStringLiteral(node)) && node.text === "register") needsChecker = true;
    if ((ts.isIdentifier(node) || ts.isStringLiteral(node)) && node.text === "defineProperty") needsChecker = true;
    if ((ts.isIdentifier(node) || ts.isStringLiteral(node)) && node.text === "importScripts") needsChecker = true;
    if (ts.isFunctionDeclaration(node) && node.body === undefined) needsChecker = true;
    if ((ts.isIdentifier(node) || ts.isStringLiteral(node)) && ["Proxy", "revocable"].includes(node.text)) needsChecker = true;
    if (ts.isDecorator(node)) reasons.add("SOURCE_DECORATOR_UNSUPPORTED");
    if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isMethodDeclaration(node))
      && node.asteriskToken !== undefined) reasons.add("SOURCE_ITERATION_UNSUPPORTED");
    if (ts.isNewExpression(node)) needsChecker = true;
    if (ts.isForOfStatement(node) || ts.isSpreadElement(node)) needsChecker = true;
    if (ts.isAwaitExpression(node) || (ts.isYieldExpression(node) && node.asteriskToken !== undefined)
      || assignment(node) || (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword)) needsChecker = true;
    if (ts.isParameter(node) && ts.isArrayBindingPattern(node.name)) needsChecker = true;
    if ((ts.isIdentifier(node) || ts.isStringLiteral(node)) && ["Reflect", "construct"].includes(node.text)) needsChecker = true;
    if ((ts.isIdentifier(node) || ts.isStringLiteral(node)) && ["setTimeout", "setInterval"].includes(node.text)) needsChecker = true;
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
  const sdkValue = (expression: ts.Expression, seen = new Set<ts.Node>()): ts.Symbol | undefined => {
    const value = unwrapStaticExpression(expression);
    if (seen.has(value) || !(ts.isIdentifier(value) || ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value))) return undefined;
    seen.add(value);
    const origins = declarations(value);
    if (origins.length > 0 && origins.every(origin => program.isSourceFileDefaultLibrary(origin.getSourceFile()))) {
      let symbol = checker.getSymbolAtLocation(value);
      if (symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0) symbol = checker.getAliasedSymbol(symbol);
      return symbol;
    }
    // An annotation or returned SDK type is not the runtime constructor's origin.
    // Only immutable transparent value aliases can preserve a proven SDK binding.
    for (const origin of origins) if (ts.isVariableDeclaration(origin) && ts.isVariableDeclarationList(origin.parent)
      && (origin.parent.flags & ts.NodeFlags.Const) !== 0 && origin.initializer !== undefined) {
      const symbol = sdkValue(origin.initializer, seen); if (symbol !== undefined) return symbol;
    }
    for (const origin of origins) if (ts.isBindingElement(origin) && ts.isObjectBindingPattern(origin.parent)
      && ts.isVariableDeclaration(origin.parent.parent) && origin.parent.parent.initializer !== undefined
      && ts.isVariableDeclarationList(origin.parent.parent.parent) && (origin.parent.parent.parent.flags & ts.NodeFlags.Const) !== 0
      && sdkValue(origin.parent.parent.initializer, seen) !== undefined) {
      const member = origin.propertyName ?? origin.name;
      if (ts.isIdentifier(member) || ts.isStringLiteral(member)) {
        const symbol = checker.getPropertyOfType(checker.getTypeAtLocation(origin.parent.parent.initializer), member.text);
        if ((symbol?.getDeclarations()?.length ?? 0) > 0 && symbol!.getDeclarations()!.every(declaration => program.isSourceFileDefaultLibrary(declaration.getSourceFile()))) return symbol;
      }
    }
    return undefined;
  };
  const sdkConstruction = (symbol: ts.Symbol | undefined): boolean => symbol !== undefined
    && checker.getTypeOfSymbolAtLocation(symbol, symbol.getDeclarations()![0]!).getConstructSignatures().some(signature => {
      const declaration = signature.getDeclaration(); return declaration !== undefined && program.isSourceFileDefaultLibrary(declaration.getSourceFile());
    });
  const primitiveValue = (expression: ts.Expression, seen = new Set<ts.Node>()): boolean => {
    const value = unwrapStaticExpression(expression);
    if (seen.has(value)) return false;
    seen.add(value);
    if (ts.isNumericLiteral(value) || ts.isBigIntLiteral(value) || ts.isStringLiteralLike(value) || ts.isVoidExpression(value)
      || [ts.SyntaxKind.NullKeyword, ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword].includes(value.kind)) return true;
    if (ts.isIdentifier(value) && value.text === "undefined" && declarations(value).length === 0
      && (checker.getTypeAtLocation(value).flags & ts.TypeFlags.Undefined) !== 0) return true;
    if (ts.isTypeOfExpression(value)) return true;
    if (ts.isTemplateExpression(value)) return value.templateSpans.every(span => primitiveValue(span.expression, new Set(seen)));
    if (ts.isBinaryExpression(value) && value.operatorToken.kind === ts.SyntaxKind.PlusToken) return primitiveValue(value.left, new Set(seen)) && primitiveValue(value.right, new Set(seen));
    if (ts.isPrefixUnaryExpression(value)) return value.operator === ts.SyntaxKind.ExclamationToken || primitiveValue(value.operand, new Set(seen));
    return declarations(value).some(declaration => ts.isVariableDeclaration(declaration) && ts.isVariableDeclarationList(declaration.parent)
      && (declaration.parent.flags & ts.NodeFlags.Const) !== 0 && declaration.initializer !== undefined && primitiveValue(declaration.initializer, new Set(seen)));
  };
  const constantString = (expression: ts.Expression, seen = new Set<ts.Node>()): string | undefined => {
    const value = unwrapStaticExpression(expression);
    if (seen.has(value)) return undefined;
    seen.add(value);
    if (ts.isStringLiteralLike(value)) return value.text;
    for (const declaration of declarations(value)) if (ts.isVariableDeclaration(declaration) && ts.isVariableDeclarationList(declaration.parent)
      && (declaration.parent.flags & ts.NodeFlags.Const) !== 0 && declaration.initializer !== undefined) {
      const name = constantString(declaration.initializer, seen); if (name !== undefined) return name;
    }
    return undefined;
  };
  const staticMemberName = (expression: ts.Expression): string | undefined => ts.isPropertyAccessExpression(expression) ? expression.name.text
    : ts.isElementAccessExpression(expression) ? constantString(expression.argumentExpression) : undefined;
  const propertyKey = (expression: ts.Expression, seen = new Set<ts.Node>()): boolean => {
    const value = unwrapStaticExpression(expression);
    if (seen.has(value)) return false;
    seen.add(value);
    if (primitiveValue(value)) return true;
    if ((ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value)) && sdkValue(value.expression)?.getName() === "Symbol") {
      const symbol = sdkValue(value);
      if (symbol !== undefined && (checker.getTypeAtLocation(value).flags & ts.TypeFlags.ESSymbolLike) !== 0) return true;
    }
    return declarations(value).some(declaration => ts.isVariableDeclaration(declaration) && ts.isVariableDeclarationList(declaration.parent)
      && (declaration.parent.flags & ts.NodeFlags.Const) !== 0 && declaration.initializer !== undefined && propertyKey(declaration.initializer, seen));
  };
  const sdkProtocolKey = (expression: ts.Expression, names: readonly string[], seen = new Set<ts.Node>()): boolean => {
    const value = unwrapStaticExpression(expression);
    if (seen.has(value)) return false;
    seen.add(value);
    if ((ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value)) && sdkValue(value.expression)?.getName() === "Symbol") {
      return names.includes(sdkValue(value)?.getName() ?? "");
    }
    return declarations(value).some(origin => {
      if (ts.isVariableDeclaration(origin) && ts.isVariableDeclarationList(origin.parent)
        && (origin.parent.flags & ts.NodeFlags.Const) !== 0 && origin.initializer !== undefined) return sdkProtocolKey(origin.initializer, names, seen);
      return ts.isBindingElement(origin) && ts.isObjectBindingPattern(origin.parent)
        && ts.isVariableDeclaration(origin.parent.parent) && origin.parent.parent.initializer !== undefined
        && ts.isVariableDeclarationList(origin.parent.parent.parent) && (origin.parent.parent.parent.flags & ts.NodeFlags.Const) !== 0
        && sdkValue(origin.parent.parent.initializer)?.getName() === "Symbol"
        && names.includes(sdkValue(value)?.getName() ?? "");
    });
  };
  const iteratorKey = (expression: ts.Expression): boolean => sdkProtocolKey(expression, ["iterator", "asyncIterator"]);
  const protocolKey = (expression: ts.Expression): boolean => sdkProtocolKey(expression, ["iterator", "asyncIterator", "hasInstance", "toPrimitive", "match", "matchAll", "replace", "search", "split", "species"]);
  const propertyName = (name: ts.PropertyName | ts.BindingName): string | undefined => ts.isComputedPropertyName(name) ? constantString(name.expression)
    : ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name) ? name.text : undefined;
  const sdkCallableMember = (expression: ts.Expression, name: string | undefined): boolean => {
    if (name === undefined) return false;
    const receiver = unwrapStaticExpression(expression);
    const symbol = checker.getPropertyOfType(checker.getTypeAtLocation(receiver), name);
    const origins = symbol?.getDeclarations() ?? [];
    if (origins.length === 0 || !origins.every(origin => program.isSourceFileDefaultLibrary(origin.getSourceFile()))) return false;
    const type = checker.getTypeOfSymbolAtLocation(symbol!, receiver);
    return type.getCallSignatures().length > 0 || type.getConstructSignatures().length > 0;
  };
  const sdkCallableProperty = (expression: ts.Expression): boolean => {
    const target = unwrapStaticExpression(expression);
    return (ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target)) && sdkCallableMember(target.expression, staticMemberName(target));
  };
  const actualValue = (expression: ts.Expression, seen = new Set<ts.Node>()): ts.Expression => {
    const value = unwrapStaticExpression(expression);
    if (seen.has(value)) return value;
    seen.add(value);
    for (const origin of declarations(value)) if (ts.isVariableDeclaration(origin) && ts.isVariableDeclarationList(origin.parent)
      && (origin.parent.flags & ts.NodeFlags.Const) !== 0 && origin.initializer !== undefined) return actualValue(origin.initializer, seen);
    return value;
  };
  const sdkOrigin = (expression: ts.Expression, seen = new Set<ts.Node>()): boolean => {
    const value = actualValue(expression);
    if (seen.has(value)) return false;
    seen.add(value);
    if (ts.isArrayLiteralExpression(value) || ts.isStringLiteralLike(value)) return true;
    if (ts.isNewExpression(value)) return sdkConstruction(sdkValue(actualValue(value.expression)));
    if (ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value)) return sdkOrigin(value.expression, seen) && sdkValue(value) !== undefined;
    const origins = declarations(value);
    return (origins.length > 0 && origins.every(origin => program.isSourceFileDefaultLibrary(origin.getSourceFile())))
      || (ts.isIdentifier(value) && value.text === "globalThis" && origins.length === 0 && checker.getSymbolAtLocation(value) !== undefined);
  };
  const callableType = (expression: ts.Expression): ts.Type => {
    const value = actualValue(expression);
    if (ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value)) {
      const receiver = actualValue(value.expression); const name = staticMemberName(value);
      const symbol = name === undefined ? undefined : checker.getPropertyOfType(checker.getTypeAtLocation(receiver), name);
      if (symbol !== undefined) return checker.getTypeOfSymbolAtLocation(symbol, receiver);
    }
    return checker.getTypeAtLocation(value);
  };
  const callbackType = (type: ts.Type): boolean => type.getCallSignatures().length > 0 || type.getConstructSignatures().length > 0
    || (type.isUnionOrIntersection() && type.types.some(callbackType))
    || (type.getSymbol()?.getName() === "Function" && type.getSymbol()!.getDeclarations()?.every(origin => program.isSourceFileDefaultLibrary(origin.getSourceFile())) === true);
  const iterableType = (type: ts.Type, seen = new Set<ts.Type>()): boolean => {
    if (seen.has(type)) return false;
    seen.add(type);
    if ((type.flags & (ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike | ts.TypeFlags.BigIntLike | ts.TypeFlags.BooleanLike | ts.TypeFlags.ESSymbolLike | ts.TypeFlags.Null | ts.TypeFlags.Undefined)) !== 0) return false;
    if (type.isUnionOrIntersection()) return type.types.some(part => iterableType(part, new Set(seen)));
    const constraint = checker.getBaseConstraintOfType(type);
    if (constraint !== undefined && constraint !== type && iterableType(constraint, new Set(seen))) return true;
    return type.getProperties().some(property => property.getDeclarations()?.some(declaration => program.isSourceFileDefaultLibrary(declaration.getSourceFile())
      && (ts.isMethodSignature(declaration) || ts.isPropertySignature(declaration)) && ts.isComputedPropertyName(declaration.name)
      && iteratorKey(declaration.name.expression)));
  };
  const iterableParameter = (parameter: ts.Symbol, declaration: ts.SignatureDeclaration): boolean => !parameter.getDeclarations()?.some(origin => ts.isParameter(origin) && origin.dotDotDotToken !== undefined)
    && iterableType(checker.getTypeOfSymbolAtLocation(parameter, declaration));
  const sdkCallbackSignature = (type: ts.Type): boolean => [...type.getCallSignatures(), ...type.getConstructSignatures()].some(signature => {
    const declaration = signature.getDeclaration();
    return declaration !== undefined && program.isSourceFileDefaultLibrary(declaration.getSourceFile())
      && signature.getParameters().some(parameter => callbackType(checker.getTypeOfSymbolAtLocation(parameter, declaration)));
  });
  const inspectSdkCallbacks = (node: ts.CallExpression | ts.NewExpression): void => {
    const callee = actualValue(node.expression);
    if ((ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) && ["call", "apply", "bind"].includes(staticMemberName(callee) ?? "")) {
      const receiver = actualValue(callee.expression); const name = staticMemberName(callee)!;
      const helper = checker.getPropertyOfType(callableType(receiver), name);
      if (helper?.getDeclarations()?.some(declaration => program.isSourceFileDefaultLibrary(declaration.getSourceFile())
        && ts.isInterfaceDeclaration(declaration.parent) && ["Function", "CallableFunction", "NewableFunction"].includes(declaration.parent.name.text))
        && sdkCallbackSignature(callableType(receiver))) reasons.add("SOURCE_SDK_CALLBACK_UNSUPPORTED");
      if (helper?.getDeclarations()?.some(declaration => program.isSourceFileDefaultLibrary(declaration.getSourceFile())
        && ts.isInterfaceDeclaration(declaration.parent) && ["Function", "CallableFunction", "NewableFunction"].includes(declaration.parent.name.text))
        && [...callableType(receiver).getCallSignatures(), ...callableType(receiver).getConstructSignatures()].some(signature => {
          const declaration = signature.getDeclaration();
          return declaration !== undefined && program.isSourceFileDefaultLibrary(declaration.getSourceFile())
            && signature.getParameters().some(parameter => iterableParameter(parameter, declaration));
        })) reasons.add("SOURCE_SDK_ITERATION_UNSUPPORTED");
    }
    const type = callableType(callee);
    const signatures = ts.isNewExpression(node) ? type.getConstructSignatures() : type.getCallSignatures();
    for (const signature of signatures) {
      const declaration = signature.getDeclaration();
      if (declaration === undefined || !program.isSourceFileDefaultLibrary(declaration.getSourceFile())) continue;
      for (const [index, parameter] of signature.getParameters().entries()) {
        const argument = node.arguments?.[index]; if (argument === undefined) continue;
        if (iterableParameter(parameter, declaration) && !intrinsicIterable(argument)) reasons.add("SOURCE_SDK_ITERATION_UNSUPPORTED");
        if (callbackType(checker.getTypeOfSymbolAtLocation(parameter, declaration)) && (!sdkOrigin(callee)
          || (!primitiveValue(actualValue(argument)) && !(sdkOrigin(argument) && callbackType(callableType(argument)))))) reasons.add("SOURCE_SDK_CALLBACK_UNSUPPORTED");
      }
    }
  };
  const mutationFactory = (expression: ts.Expression): boolean => {
    const value = actualValue(expression);
    if ((ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value)) && staticMemberName(value) === "assign"
      && sdkValue(actualValue(value.expression))?.getName() === "Object") return true;
    const symbol = sdkValue(value);
    return symbol?.getName() === "assign" && symbol.getDeclarations()?.some(declaration => program.isSourceFileDefaultLibrary(declaration.getSourceFile())
      && ts.isInterfaceDeclaration(declaration.parent) && declaration.parent.name.text === "ObjectConstructor") === true;
  };
  const inspectMutationUse = (node: ts.Identifier | ts.PropertyAccessExpression | ts.ElementAccessExpression): void => {
    if (!mutationFactory(node)) return;
    if (ts.isIdentifier(node) && ((ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)
      || (ts.isVariableDeclaration(node.parent) && node.parent.name === node) || ts.isBindingElement(node.parent))) return;
    let usage: ts.Expression = node;
    while (ts.isParenthesizedExpression(usage.parent) || ts.isAsExpression(usage.parent) || ts.isTypeAssertionExpression(usage.parent)
      || ts.isNonNullExpression(usage.parent) || ts.isSatisfiesExpression(usage.parent)) usage = usage.parent;
    const container = usage.parent;
    if (ts.isVariableDeclaration(container) && container.initializer === usage && ts.isIdentifier(container.name)
      && ts.isVariableDeclarationList(container.parent) && (container.parent.flags & ts.NodeFlags.Const) !== 0) return;
    if (!ts.isCallExpression(container) || container.expression !== usage || container.arguments[0] === undefined) {
      reasons.add("SOURCE_SDK_MUTATION_UNSUPPORTED"); return;
    }
    const target = actualValue(container.arguments[0]);
    for (const argument of container.arguments.slice(1)) {
      const source = unwrapStaticExpression(argument);
      if (!ts.isObjectLiteralExpression(source)) {
        if (sdkOrigin(target)) reasons.add("SOURCE_SDK_MUTATION_UNSUPPORTED");
        continue;
      }
      for (const property of source.properties) {
        if (ts.isSpreadAssignment(property)) {
          if (sdkOrigin(target)) reasons.add("SOURCE_SDK_MUTATION_UNSUPPORTED");
          continue;
        }
        const name = propertyName(property.name);
        const value = ts.isPropertyAssignment(property) ? property.initializer : ts.isShorthandPropertyAssignment(property) ? property.name : undefined;
        if ((ts.isComputedPropertyName(property.name) && protocolKey(property.name.expression))
          || (name === "then" && (value === undefined || !primitiveValue(value)))
          || (name !== undefined && sdkCallableMember(target, name) && (value === undefined || !primitiveValue(value)))
          || (name === undefined && sdkOrigin(target))) reasons.add("SOURCE_SDK_MUTATION_UNSUPPORTED");
      }
    }
  };
  const descriptorFactory = (expression: ts.Expression, seen = new Set<ts.Node>()): boolean => {
    const value = unwrapStaticExpression(expression);
    if (seen.has(value)) return false;
    seen.add(value);
    if ((ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value)) && staticMemberName(value) === "defineProperty"
      && ["Object", "Reflect"].includes(sdkValue(actualValue(value.expression))?.getName() ?? "")) return true;
    const symbol = sdkValue(value);
    if (symbol?.getName() === "defineProperty" && symbol.getDeclarations()?.some(origin => ts.isModuleBlock(origin.parent)
      && ts.isModuleDeclaration(origin.parent.parent) && origin.parent.parent.name.getText() === "Reflect" && program.isSourceFileDefaultLibrary(origin.getSourceFile()))) return true;
    return declarations(value).some(origin => {
      if (ts.isVariableDeclaration(origin) && ts.isVariableDeclarationList(origin.parent)
        && (origin.parent.flags & ts.NodeFlags.Const) !== 0 && origin.initializer !== undefined) return descriptorFactory(origin.initializer, seen);
      return ts.isBindingElement(origin) && ts.isObjectBindingPattern(origin.parent)
        && propertyName(origin.propertyName ?? origin.name) === "defineProperty" && ts.isVariableDeclaration(origin.parent.parent)
        && origin.parent.parent.initializer !== undefined && ts.isVariableDeclarationList(origin.parent.parent.parent)
        && (origin.parent.parent.parent.flags & ts.NodeFlags.Const) !== 0 && ["Object", "Reflect"].includes(sdkValue(origin.parent.parent.initializer)?.getName() ?? "");
    });
  };
  const dataDescriptor = (expression: ts.Expression): boolean => {
    const value = unwrapStaticExpression(expression);
    return ts.isObjectLiteralExpression(value) && value.properties.every(property => {
      if (ts.isSpreadAssignment(property)) return false;
      const name = propertyName(property.name);
      return name !== undefined && ["value", "writable", "enumerable", "configurable"].includes(name);
    });
  };
  const sdkMetaOperation = (expression: ts.Expression, names: readonly string[], owners: readonly string[]): boolean => {
    const value = actualValue(expression);
    if ((ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value)) && names.includes(staticMemberName(value) ?? "")
      && owners.includes(sdkValue(actualValue(value.expression))?.getName() ?? "")) return true;
    const symbol = sdkValue(value);
    return names.includes(symbol?.getName() ?? "") && symbol?.getDeclarations()?.some(declaration => {
      if (!program.isSourceFileDefaultLibrary(declaration.getSourceFile())) return false;
      const parent = declaration.parent;
      return (ts.isInterfaceDeclaration(parent) && owners.some(owner => parent.name.text === `${owner}Constructor`))
        || (ts.isModuleBlock(parent) && ts.isModuleDeclaration(parent.parent) && owners.includes(parent.parent.name.getText()));
    }) === true;
  };
  const inspectMetaObjectUse = (node: ts.Identifier | ts.PropertyAccessExpression | ts.ElementAccessExpression): void => {
    if (ts.isIdentifier(node) && ((ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)
      || (ts.isVariableDeclaration(node.parent) && node.parent.name === node) || ts.isBindingElement(node.parent))) return;
    if (sdkMetaOperation(node, ["setPrototypeOf"], ["Object", "Reflect"])) { reasons.add("SOURCE_PROTOTYPE_MUTATION_UNSUPPORTED"); return; }
    if (!sdkMetaOperation(node, ["defineProperties", "create"], ["Object"])) return;
    let usage: ts.Expression = node;
    while (ts.isParenthesizedExpression(usage.parent) || ts.isAsExpression(usage.parent) || ts.isTypeAssertionExpression(usage.parent)
      || ts.isNonNullExpression(usage.parent) || ts.isSatisfiesExpression(usage.parent)) usage = usage.parent;
    const parent = usage.parent;
    if (ts.isVariableDeclaration(parent) && parent.initializer === usage && ts.isIdentifier(parent.name)
      && ts.isVariableDeclarationList(parent.parent) && (parent.parent.flags & ts.NodeFlags.Const) !== 0) return;
    if (!ts.isCallExpression(parent) || parent.expression !== usage) { reasons.add("SOURCE_DESCRIPTOR_UNSUPPORTED"); return; }
    const create = sdkMetaOperation(node, ["create"], ["Object"]);
    if (create && (parent.arguments[0] === undefined || !literalData(parent.arguments[0]))) reasons.add("SOURCE_PROTOTYPE_MUTATION_UNSUPPORTED");
    const map = parent.arguments[1];
    if (map === undefined && create) return;
    const descriptors = map === undefined ? undefined : unwrapStaticExpression(map);
    if (descriptors === undefined || !ts.isObjectLiteralExpression(descriptors)) { reasons.add("SOURCE_DESCRIPTOR_UNSUPPORTED"); return; }
    for (const entry of descriptors.properties) {
      if (!ts.isPropertyAssignment(entry)) { reasons.add("SOURCE_DESCRIPTOR_UNSUPPORTED"); continue; }
      if (ts.isComputedPropertyName(entry.name) && protocolKey(entry.name.expression)) reasons.add("SOURCE_PROTOCOL_DESCRIPTOR_UNSUPPORTED");
      const name = propertyName(entry.name);
      const knownKey = name !== undefined || (ts.isComputedPropertyName(entry.name) && propertyKey(entry.name.expression));
      if (!knownKey || name === "__proto__" || !dataDescriptor(entry.initializer)) reasons.add("SOURCE_DESCRIPTOR_UNSUPPORTED");
      const descriptor = unwrapStaticExpression(entry.initializer);
      if (name !== undefined && ts.isObjectLiteralExpression(descriptor)) {
        const value = descriptor.properties.find(property => !ts.isSpreadAssignment(property) && propertyName(property.name) === "value");
        if (sdkCallableMember(parent.arguments[0]!, name) && value !== undefined
          && (!ts.isPropertyAssignment(value) || !primitiveValue(value.initializer))) reasons.add("SOURCE_SDK_CALLABLE_MUTATION_UNSUPPORTED");
      }
    }
  };
  const inspectDescriptorUse = (node: ts.Identifier | ts.PropertyAccessExpression | ts.ElementAccessExpression): void => {
    const parent = node.parent;
    if (ts.isIdentifier(node) && ((ts.isPropertyAccessExpression(parent) && parent.name === node)
      || (ts.isVariableDeclaration(parent) && parent.name === node) || ts.isBindingElement(parent))) return;
    if (!descriptorFactory(node)) return;
    let usage: ts.Expression = node;
    while (ts.isParenthesizedExpression(usage.parent) || ts.isAsExpression(usage.parent) || ts.isTypeAssertionExpression(usage.parent)
      || ts.isNonNullExpression(usage.parent) || ts.isSatisfiesExpression(usage.parent)) usage = usage.parent;
    const container = usage.parent;
    if (ts.isVariableDeclaration(container) && container.initializer === usage && ts.isIdentifier(container.name)
      && ts.isVariableDeclarationList(container.parent) && (container.parent.flags & ts.NodeFlags.Const) !== 0) return;
    if (ts.isCallExpression(container) && container.expression === usage && container.arguments[2] !== undefined && dataDescriptor(container.arguments[2])) {
      if (container.arguments[1] !== undefined && (protocolKey(container.arguments[1]) || constantString(container.arguments[1]) === "then")) {
        reasons.add("SOURCE_PROTOCOL_DESCRIPTOR_UNSUPPORTED"); return;
      }
      if (container.arguments[0] !== undefined && container.arguments[1] !== undefined && sdkGlobalMember(container.arguments[0], constantString(container.arguments[1]))) {
        reasons.add("SOURCE_SDK_GLOBAL_MUTATION_UNSUPPORTED"); return;
      }
      if (container.arguments[0] !== undefined && container.arguments[1] !== undefined && sdkCallableMember(container.arguments[0], constantString(container.arguments[1]))) {
        reasons.add("SOURCE_SDK_CALLABLE_MUTATION_UNSUPPORTED"); return;
      }
      return;
    }
    reasons.add("SOURCE_DESCRIPTOR_ACCESSOR_UNSUPPORTED");
  };
  const sdkReflectSet = (expression: ts.Expression): boolean => {
    const value = actualValue(expression);
    if ((ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value)) && staticMemberName(value) === "set"
      && sdkValue(actualValue(value.expression))?.getName() === "Reflect") return true;
    const symbol = sdkValue(value);
    return symbol?.getName() === "set" && symbol.getDeclarations()?.some(origin => program.isSourceFileDefaultLibrary(origin.getSourceFile())
      && ts.isModuleBlock(origin.parent) && ts.isModuleDeclaration(origin.parent.parent) && origin.parent.parent.name.getText() === "Reflect") === true;
  };
  const inspectReflectSetUse = (node: ts.Identifier | ts.PropertyAccessExpression | ts.ElementAccessExpression): void => {
    if (!sdkReflectSet(node)) return;
    if (ts.isIdentifier(node) && ((ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)
      || (ts.isVariableDeclaration(node.parent) && node.parent.name === node) || ts.isBindingElement(node.parent))) return;
    let usage: ts.Expression = node;
    while (ts.isParenthesizedExpression(usage.parent) || ts.isAsExpression(usage.parent) || ts.isTypeAssertionExpression(usage.parent)
      || ts.isNonNullExpression(usage.parent) || ts.isSatisfiesExpression(usage.parent)) usage = usage.parent;
    const container = usage.parent;
    if (ts.isVariableDeclaration(container) && container.initializer === usage && ts.isIdentifier(container.name)
      && ts.isVariableDeclarationList(container.parent) && (container.parent.flags & ts.NodeFlags.Const) !== 0) return;
    if (!ts.isCallExpression(container) || container.expression !== usage || container.arguments[0] === undefined || container.arguments[1] === undefined) {
      reasons.add("SOURCE_PROTOCOL_MUTATION_UNSUPPORTED"); return;
    }
    const target = actualValue(container.arguments[0]); const name = container.arguments[1]; const value = container.arguments[2];
    if (protocolKey(name) || (constantString(name) === "then" && (value === undefined || !primitiveValue(value)))) reasons.add("SOURCE_PROTOCOL_MUTATION_UNSUPPORTED");
    else if (sdkCallableMember(target, constantString(name)) && (value === undefined || !primitiveValue(value))) reasons.add("SOURCE_SDK_CALLABLE_MUTATION_UNSUPPORTED");
  };
  const sdkPromiseResolve = (expression: ts.Expression): boolean => {
    const value = actualValue(expression);
    if ((ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value)) && staticMemberName(value) === "resolve"
      && sdkValue(actualValue(value.expression))?.getName() === "Promise") return true;
    const symbol = sdkValue(value);
    return symbol?.getName() === "resolve" && symbol.getDeclarations()?.some(origin => program.isSourceFileDefaultLibrary(origin.getSourceFile())
      && ts.isInterfaceDeclaration(origin.parent) && origin.parent.name.text === "PromiseConstructor") === true;
  };
  const inspectPromiseResolveUse = (node: ts.Identifier | ts.PropertyAccessExpression | ts.ElementAccessExpression): void => {
    if (!sdkPromiseResolve(node)) return;
    if (ts.isIdentifier(node) && ((ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)
      || (ts.isVariableDeclaration(node.parent) && node.parent.name === node) || ts.isBindingElement(node.parent))) return;
    let usage: ts.Expression = node;
    while (ts.isParenthesizedExpression(usage.parent) || ts.isAsExpression(usage.parent) || ts.isTypeAssertionExpression(usage.parent)
      || ts.isNonNullExpression(usage.parent) || ts.isSatisfiesExpression(usage.parent)) usage = usage.parent;
    const container = usage.parent;
    if (ts.isVariableDeclaration(container) && container.initializer === usage && ts.isIdentifier(container.name)
      && ts.isVariableDeclarationList(container.parent) && (container.parent.flags & ts.NodeFlags.Const) !== 0) return;
    if (ts.isCallExpression(container) && container.expression === usage && (container.arguments[0] === undefined || safeAwaitValue(container.arguments[0]))) return;
    reasons.add("SOURCE_PROMISE_ASSIMILATION_UNSUPPORTED");
  };
  const opaqueCallee = (expression: ts.Expression): boolean => {
    const value = actualValue(expression);
    if (sdkOrigin(value)) return false;
    return !declarations(value).some(origin => internal(origin) && ((ts.isFunctionDeclaration(origin) && origin.body !== undefined)
      || (ts.isMethodDeclaration(origin) && origin.body !== undefined) || (ts.isVariableDeclaration(origin) && origin.initializer !== undefined
        && (ts.isArrowFunction(origin.initializer) || ts.isFunctionExpression(origin.initializer)))));
  };
  const builtinModuleValue = (expression: ts.Expression, seen = new Set<ts.Node>()): string | undefined => {
    const value = unwrapStaticExpression(expression);
    if (seen.has(value)) return undefined;
    seen.add(value);
    if (ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value)) return builtinModuleValue(value.expression, seen);
    if (ts.isAwaitExpression(value)) return builtinModuleValue(value.expression, seen);
    if (ts.isCallExpression(value) && value.expression.kind === ts.SyntaxKind.ImportKeyword && value.arguments[0] !== undefined
      && ts.isStringLiteralLike(value.arguments[0])) return value.arguments[0].text;
    const origins = checker.getSymbolAtLocation(value)?.getDeclarations() ?? [];
    for (const origin of origins) {
      if (ts.isImportSpecifier(origin) || ts.isNamespaceImport(origin) || ts.isImportClause(origin)) {
        if ((ts.isImportSpecifier(origin) && origin.isTypeOnly) || (ts.isImportClause(origin) && origin.isTypeOnly)) continue;
        let statement: ts.Node | undefined = origin;
        while (statement !== undefined && !ts.isImportDeclaration(statement)) statement = statement.parent;
        if (statement !== undefined && ts.isImportDeclaration(statement) && statement.importClause?.isTypeOnly !== true
          && ts.isStringLiteral(statement.moduleSpecifier)) {
          return statement.moduleSpecifier.text;
        }
      }
      if (ts.isVariableDeclaration(origin) && ts.isVariableDeclarationList(origin.parent)
        && (origin.parent.flags & ts.NodeFlags.Const) !== 0 && origin.initializer !== undefined) {
        const module = builtinModuleValue(origin.initializer, seen); if (module !== undefined) return module;
      }
      if (ts.isBindingElement(origin) && ts.isObjectBindingPattern(origin.parent) && ts.isVariableDeclaration(origin.parent.parent)
        && origin.parent.parent.initializer !== undefined && ts.isVariableDeclarationList(origin.parent.parent.parent)
        && (origin.parent.parent.parent.flags & ts.NodeFlags.Const) !== 0) {
        const module = builtinModuleValue(origin.parent.parent.initializer, seen); if (module !== undefined) return module;
      }
    }
    return undefined;
  };
  const clusterLauncherValue = (expression: ts.Expression): boolean => {
    const value = actualValue(expression);
    const names = ["fork", "setupPrimary"];
    if (names.includes(staticMemberName(value) ?? "")) return true;
    return (checker.getSymbolAtLocation(value)?.getDeclarations() ?? []).some(origin => {
      const member = ts.isImportSpecifier(origin) ? origin.propertyName ?? origin.name
        : ts.isBindingElement(origin) ? origin.propertyName ?? origin.name : undefined;
      return member !== undefined && (ts.isIdentifier(member) || ts.isStringLiteral(member)) && names.includes(member.text);
    });
  };
  const inspectBuiltinProcessUse = (node: ts.Identifier | ts.PropertyAccessExpression | ts.ElementAccessExpression): void => {
    if (ts.isIdentifier(node) && (ts.isImportSpecifier(node.parent) || ts.isNamespaceImport(node.parent) || ts.isImportClause(node.parent)
      || ts.isBindingElement(node.parent) || (ts.isVariableDeclaration(node.parent) && node.parent.name === node)
      || (ts.isPropertyAccessExpression(node.parent) && node.parent.name === node))) return;
    const module = builtinModuleValue(node);
    const kind = executionModule(module ?? "");
    if (kind !== undefined) reasons.add(kind);
    else if (["cluster", "node:cluster"].includes(module ?? "") && clusterLauncherValue(node)) reasons.add("SOURCE_PROCESS_LAUNCH_UNSUPPORTED");
  };
  const inspectDefaultSort = (node: ts.CallExpression): void => {
    const callee = unwrapStaticExpression(node.expression); const symbol = sdkValue(callee);
    if (symbol?.getName() !== "sort" || !symbol.getDeclarations()?.some(declaration => program.isSourceFileDefaultLibrary(declaration.getSourceFile())
      && ts.isInterfaceDeclaration(declaration.parent) && declaration.parent.name.text === "Array")) return;
    const comparator = node.arguments[0] === undefined ? undefined : actualValue(node.arguments[0]);
    if (comparator !== undefined && !((checker.getTypeAtLocation(comparator).flags & ts.TypeFlags.Undefined) !== 0 && primitiveValue(comparator))) return;
    const receiver = ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee) ? unwrapStaticExpression(callee.expression) : undefined;
    if (receiver === undefined || !ts.isArrayLiteralExpression(receiver) || !receiver.elements.every(element => ts.isExpression(element) && primitiveValue(element))) {
      reasons.add("SOURCE_SORT_COERCION_UNSUPPORTED");
    }
  };
  const inspectCombinatorUse = (node: ts.Identifier | ts.PropertyAccessExpression | ts.ElementAccessExpression): void => {
    if (ts.isIdentifier(node) && ((ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)
      || (ts.isVariableDeclaration(node.parent) && node.parent.name === node) || ts.isBindingElement(node.parent))) return;
    const symbol = sdkValue(node);
    if (!["all", "allSettled", "race", "any"].includes(symbol?.getName() ?? "") || !symbol?.getDeclarations()?.some(declaration => program.isSourceFileDefaultLibrary(declaration.getSourceFile())
      && ts.isInterfaceDeclaration(declaration.parent) && declaration.parent.name.text === "PromiseConstructor")) return;
    let usage: ts.Expression = node;
    while (ts.isParenthesizedExpression(usage.parent) || ts.isAsExpression(usage.parent) || ts.isTypeAssertionExpression(usage.parent)
      || ts.isNonNullExpression(usage.parent) || ts.isSatisfiesExpression(usage.parent)) usage = usage.parent;
    const parent = usage.parent;
    if (ts.isVariableDeclaration(parent) && parent.initializer === usage && ts.isIdentifier(parent.name)
      && ts.isVariableDeclarationList(parent.parent) && (parent.parent.flags & ts.NodeFlags.Const) !== 0) return;
    const argument = ts.isCallExpression(parent) && parent.expression === usage ? parent.arguments[0] : undefined;
    const array = argument === undefined ? undefined : unwrapStaticExpression(argument);
    if (array === undefined || !ts.isArrayLiteralExpression(array) || !array.elements.every(element => ts.isExpression(element) && safeAwaitValue(element))) {
      reasons.add("SOURCE_PROMISE_ASSIMILATION_UNSUPPORTED");
    }
  };
  const inlineOwned = (callback: ts.ArrowFunction | ts.FunctionExpression): boolean => {
    const proof = ownership.get(inputs);
    if (proof === undefined) return false;
    const span = `${key(bound.fileName)}:${callback.getStart()}:${callback.getEnd()}`;
    const cached = proof.callbacks.get(span); if (cached !== undefined) return cached;
    const path = relative(proof.root, bound.fileName).replaceAll("\\", "/");
    const lookup = (coordinate: { relPath?: string; symbolPath?: string; unmodeledReason?: string } | undefined): RepositoryNode | undefined => {
      if (coordinate?.relPath === undefined || coordinate.symbolPath === undefined || coordinate.unmodeledReason !== undefined) return undefined;
      const matches = proof.graph.nodes.filter(node => ["function", "class"].includes(node.kind) && node.filePath === coordinate.relPath
        && `${typeof node.metadata["scope"] === "string" ? `${node.metadata["scope"]}.` : ""}${node.name}` === coordinate.symbolPath);
      return matches.length === 1 ? matches[0] : undefined;
    };
    let owner: RepositoryNode | undefined; let namedOwner = false;
    for (let parent: ts.Node | undefined = callback.parent; parent !== undefined; parent = parent.parent) {
      if (ts.isFunctionDeclaration(parent)) { namedOwner = true; owner = lookup(retainedFunctionOwnerCoordinate(parent, proof.root)); break; }
      if (ts.isMethodDeclaration(parent) && ts.isIdentifier(parent.name)) { namedOwner = true; owner = lookup(retainedCallableCoordinate(checker, parent.name, proof.root, inputs)); break; }
      if ((ts.isArrowFunction(parent) || ts.isFunctionExpression(parent)) && ts.isVariableDeclaration(parent.parent) && ts.isIdentifier(parent.parent.name)) {
        namedOwner = true; owner = lookup(retainedCallableCoordinate(checker, parent.parent.name, proof.root, inputs)); break;
      }
      if (ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent)) { proof.callbacks.set(span, false); return false; }
    }
    if (!namedOwner) owner = proof.graph.nodes.find(node => node.filePath === path && (node.kind === "test" || node.kind === "module"));
    let valid = owner !== undefined; let count = 0;
    const originalImport = (expression: ts.Expression): boolean => {
      const value = unwrapStaticExpression(expression);
      const symbol = checker.getSymbolAtLocation(value);
      return symbol?.getDeclarations()?.some(origin => {
        if (!(ts.isImportSpecifier(origin) || ts.isImportClause(origin) || ts.isNamespaceImport(origin))) return false;
        let statement: ts.Node | undefined = origin;
        while (statement !== undefined && !ts.isImportDeclaration(statement)) statement = statement.parent;
        if (statement === undefined || !ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) return false;
        const name = statement.moduleSpecifier.text;
        if (statement.importClause?.isTypeOnly || (ts.isImportSpecifier(origin) && origin.isTypeOnly)) return false;
        if (isBuiltin(name)) return true;
        const packageName = name.startsWith("@") ? name.split("/").slice(0, 2).join("/") : name.split("/")[0]!;
        return [...inputs].some(([file, text]) => {
          if (!file.replaceAll("\\", "/").endsWith("/package.json")) return false;
          try {
            const manifest = JSON.parse(text) as Record<string, unknown>;
            return ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"].some(field => {
              const values = manifest[field] as Record<string, unknown> | undefined;
              const version = values?.[packageName]; return typeof version === "string" && !/^(?:workspace:|file:|link:)/.test(version);
            });
          } catch { return false; }
        });
      }) === true;
    };
    const externalValue = (expression: ts.Expression, seen = new Set<ts.Node>()): boolean => {
      const value = actualValue(expression);
      if (seen.has(value)) return false; seen.add(value);
      if (originalImport(value) && declarations(value).length === 0) return true;
      if (ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value)) return externalValue(value.expression, seen);
      if (ts.isCallExpression(value)) return externalValue(value.expression, seen);
      return false;
    };
    const visitReference = (node: ts.Node): void => {
      if (!valid || ts.isTypeNode(node)) return;
      if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
        const parent = node.parent;
        const binding = ts.isIdentifier(node) && ((ts.isPropertyAccessExpression(parent) && parent.name === node)
          || ("name" in parent && parent.name === node && !ts.isShorthandPropertyAssignment(parent)) || ts.isBindingElement(parent));
        if (!binding && potentiallyCallable(checker.getTypeAtLocation(node)) && !sdkOrigin(node) && !externalValue(node)) {
          const coordinate = retainedCallableCoordinate(checker, node, proof.root, inputs); const target = lookup(coordinate);
          if (target === undefined) { valid = false; return; }
          count += 1;
          let usage: ts.Expression = node;
          while (ts.isParenthesizedExpression(usage.parent) || ts.isAsExpression(usage.parent) || ts.isTypeAssertionExpression(usage.parent)
            || ts.isNonNullExpression(usage.parent) || ts.isSatisfiesExpression(usage.parent)) usage = usage.parent;
          const pairedTest = owner!.kind === "test" && proof.graph.edges.some(edge => edge.kind === "covers" && edge.from === owner!.id && edge.to === target.id)
            && proof.graph.edges.some(edge => edge.kind === "tested_by" && edge.from === target.id && edge.to === owner!.id);
          const invoked = ts.isCallExpression(usage.parent) && usage.parent.expression === usage && isModeledCallCallee(usage)
            && proof.graph.edges.some(edge => edge.kind === "calls" && edge.from === owner!.id && edge.to === target.id
              && edge.evidence.some(evidence => evidence.filePath === path && evidence.startLine === bound.getLineAndCharacterOfPosition(usage.getStart()).line + 1));
          if (!pairedTest && !invoked) { valid = false; return; }
        }
      }
      ts.forEachChild(node, visitReference);
    };
    visitReference(callback.body);
    valid &&= count > 0;
    proof.callbacks.set(span, valid); return valid;
  };
  const bindingWritten = (symbol: ts.Symbol, source: ts.SourceFile): boolean => {
    let written = false;
    const writesBinding = (node: ts.Node): boolean => {
      if (ts.isShorthandPropertyAssignment(node) && checker.getShorthandAssignmentValueSymbol(node) === symbol) return true;
      if (checker.getSymbolAtLocation(node) === symbol) return true;
      let found = false;
      ts.forEachChild(node, child => { found ||= writesBinding(child); });
      return found;
    };
    const inspectWrites = (node: ts.Node): void => {
      if ((assignment(node) && writesBinding(node.left))
        || ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node))
          && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator)
          && checker.getSymbolAtLocation(unwrapStaticExpression(node.operand)) === symbol)) written = true;
      ts.forEachChild(node, inspectWrites);
    };
    inspectWrites(source);
    return written;
  };
  const runtimePrimitiveValue = (expression: ts.Expression): boolean => {
    const value = unwrapStaticExpression(expression);
    if (!ts.isIdentifier(value)) return false;
    const symbol = checker.getSymbolAtLocation(value);
    const origins = symbol?.getDeclarations() ?? [];
    if (symbol === undefined || origins.length !== 1) return false;
    const origin = origins[0]!;
    if (!(ts.isParameter(origin) && ts.isIdentifier(origin.name))
      && !(ts.isVariableDeclaration(origin) && ts.isIdentifier(origin.name) && ts.isVariableDeclarationList(origin.parent)
        && (origin.parent.flags & ts.NodeFlags.Const) !== 0)) return false;
    // A type annotation is not value provenance. The same binding must survive
    // an actual dominating typeof refusal, with no reassignment in this source.
    if (bindingWritten(symbol, bound)) return false;
    const throws = (node: ts.Statement): boolean => ts.isThrowStatement(node)
      || (ts.isBlock(node) && node.statements.length === 1 && ts.isThrowStatement(node.statements[0]!));
    for (let child: ts.Node = value, parent = child.parent; parent !== undefined; child = parent, parent = parent.parent) {
      if (ts.isFunctionLike(parent)) break;
      if (!ts.isBlock(parent) && !ts.isSourceFile(parent)) continue;
      for (const statement of parent.statements) {
        if (statement.end > child.pos) break;
        if (!ts.isIfStatement(statement) || !throws(statement.thenStatement)) continue;
        const condition = unwrapStaticExpression(statement.expression);
        if (!ts.isBinaryExpression(condition) || condition.operatorToken.kind !== ts.SyntaxKind.ExclamationEqualsEqualsToken) continue;
        const left = unwrapStaticExpression(condition.left); const right = unwrapStaticExpression(condition.right);
        if (ts.isTypeOfExpression(left) && ts.isStringLiteral(right)
          && ["string", "number", "bigint", "boolean", "symbol", "undefined"].includes(right.text)
          && checker.getSymbolAtLocation(unwrapStaticExpression(left.expression)) === symbol
          && (ts.isParameter(origin) || statement.pos > origin.end)) return true;
      }
    }
    return false;
  };
  const returnedPrimitiveValue = (expression: ts.Expression): boolean => {
    const value = unwrapStaticExpression(expression);
    if (!ts.isCallExpression(value)) return false;
    const callee = actualValue(value.expression);
    const implementations = declarations(callee).flatMap<ts.FunctionDeclaration | ts.MethodDeclaration | ts.ArrowFunction | ts.FunctionExpression>(declaration => {
      if (ts.isFunctionDeclaration(declaration) || ts.isMethodDeclaration(declaration)) return declaration.body === undefined ? [] : [declaration];
      if (ts.isVariableDeclaration(declaration) && ts.isIdentifier(declaration.name) && declaration.initializer !== undefined
        && (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))) return [declaration.initializer];
      return [];
    });
    if (implementations.length !== 1) return false;
    const implementation = implementations[0]!;
    if (!internal(implementation) || (!ts.isArrowFunction(implementation) && implementation.asteriskToken !== undefined)
      || ts.getModifiers(implementation)?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword)) return false;
    let symbol = checker.getSymbolAtLocation(callee);
    if (symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0) symbol = checker.getAliasedSymbol(symbol);
    if (symbol === undefined || bindingWritten(symbol, implementation.getSourceFile())) return false;
    const body = implementation.body;
    if (body === undefined) return false;
    if (!ts.isBlock(body)) return primitiveValue(body);
    let count = 0; let valid = true;
    const inspectReturns = (node: ts.Node): void => {
      if (node !== body && ts.isFunctionLike(node)) return;
      if (ts.isReturnStatement(node)) { count++; valid &&= node.expression === undefined || primitiveValue(node.expression); }
      ts.forEachChild(node, inspectReturns);
    };
    inspectReturns(body);
    return count > 0 && valid;
  };
  const literalData = (expression: ts.Expression): boolean => {
    const value = unwrapStaticExpression(expression);
    if (primitiveValue(value)) return true;
    if (ts.isArrayLiteralExpression(value)) return value.elements.every(element => ts.isExpression(element) && !ts.isSpreadElement(element) && literalData(element));
    if (!ts.isObjectLiteralExpression(value)) return false;
    return value.properties.every(property => {
      if (ts.isShorthandPropertyAssignment(property)) return property.objectAssignmentInitializer === undefined && primitiveValue(property.name);
      if (!ts.isPropertyAssignment(property)) return false;
      const name = ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name) || ts.isNumericLiteral(property.name) ? property.name.text : undefined;
      return name !== undefined && name !== "__proto__" && literalData(property.initializer);
    });
  };
  const inspectOpaqueCallbacks = (node: ts.CallExpression): void => {
    if (!opaqueCallee(node.expression)) return;
    const callee = actualValue(node.expression);
    if (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) {
      const receiver = unwrapStaticExpression(callee.expression);
      const callerOwned = declarations(receiver).some(origin => internal(origin)
        && (ts.isVariableDeclaration(origin) || (ts.isBindingElement(origin) && ts.isVariableDeclaration(origin.parent.parent))));
      const module = builtinModuleValue(receiver);
      const external = module !== undefined && !module.startsWith(".") && !module.startsWith("/") && !/^[A-Za-z]:/.test(module);
      if (callerOwned && !external && sdkValue(callee) === undefined) {
        const members = declarations(callee);
        // Real retained members keep the existing post-extraction coordinate refusal.
        // Erased or synthetic assignment members have no declaration to extract.
        const declaredMember = members.length > 0 && members.every(origin => internal(origin)
          && (ts.isPropertyAssignment(origin) || ts.isShorthandPropertyAssignment(origin) || ts.isMethodDeclaration(origin)
            || ts.isPropertyDeclaration(origin) || ts.isPropertySignature(origin) || ts.isMethodSignature(origin)));
        if (!declaredMember) {
          const root = ownership.get(inputs)?.root ?? dirname(bound.fileName);
          const coordinate = retainedCallableCoordinate(checker, callee, root, inputs);
          if (coordinate?.relPath === undefined || coordinate.symbolPath === undefined || coordinate.unmodeledReason !== undefined
            || !retained.has(key(resolve(root, coordinate.relPath)))) reasons.add("SOURCE_UNRESOLVED_CALLEE_UNSUPPORTED");
        }
      }
      let root = actualValue(callee.expression);
      const members = [staticMemberName(callee)];
      const seen = new Set<ts.Node>();
      while (!seen.has(root)) {
        seen.add(root);
        if (ts.isPropertyAccessExpression(root) || ts.isElementAccessExpression(root)) {
          members.push(staticMemberName(root)); root = actualValue(root.expression); continue;
        }
        const binding = (checker.getSymbolAtLocation(root)?.getDeclarations() ?? []).find(origin => ts.isBindingElement(origin)
          && ts.isObjectBindingPattern(origin.parent) && ts.isVariableDeclaration(origin.parent.parent)
          && origin.parent.parent.initializer !== undefined && ts.isVariableDeclarationList(origin.parent.parent.parent)
          && (origin.parent.parent.parent.flags & ts.NodeFlags.Const) !== 0);
        if (binding === undefined || !ts.isBindingElement(binding) || !ts.isVariableDeclaration(binding.parent.parent)) break;
        members.push(propertyName(binding.propertyName ?? binding.name)); root = actualValue(binding.parent.parent.initializer!);
      }
      if (ts.isIdentifier(root)) {
        const origins = checker.getSymbolAtLocation(root)?.getDeclarations() ?? [];
        const runtime = origins.some(origin => {
          if (!internal(origin) || origin.getSourceFile().isDeclarationFile) return false;
          for (let parent: ts.Node | undefined = origin; parent !== undefined; parent = parent.parent) {
            if ((ts.canHaveModifiers(parent) && ts.getModifiers(parent)?.some(modifier => modifier.kind === ts.SyntaxKind.DeclareKeyword))
              || (ts.isImportClause(parent) && parent.isTypeOnly) || (ts.isImportSpecifier(parent) && parent.isTypeOnly)) return false;
          }
          return ts.isVariableDeclaration(origin) || ts.isParameter(origin) || ts.isBindingElement(origin)
            || (ts.isFunctionDeclaration(origin) && origin.body !== undefined) || ts.isClassDeclaration(origin) || ts.isImportClause(origin)
            || ts.isNamespaceImport(origin) || ts.isImportSpecifier(origin);
        });
        const ambient = origins.length === 0 || origins.every(origin => ts.isBinaryExpression(origin) || ts.isSourceFile(origin)
          || ts.isPropertyAccessExpression(origin) || ts.isElementAccessExpression(origin)
          || (ts.isIdentifier(origin) && (ts.isPropertyAccessExpression(origin.parent) || ts.isElementAccessExpression(origin.parent))
            && origin.parent.expression === origin));
        const member = root.text === "process" ? members.at(-1)
          : ["globalThis", "global"].includes(root.text) && members.at(-1) === "process" ? members.at(-2) : undefined;
        const ordinaryProcess = ambient && member !== undefined && isOrdinaryNativeProcessMember(member);
        const sdk = sdkOrigin(callee) || (sdkOrigin(root) && sdkValue(callee) !== undefined);
        if (!runtime && !sdk && !ordinaryProcess) reasons.add("SOURCE_UNRESOLVED_CALLEE_UNSUPPORTED");
      }
    }
    for (const argument of node.arguments) {
      const value = unwrapStaticExpression(argument);
      const actual = actualValue(value);
      const sdkData = sdkOrigin(value) && (potentiallyCallable(checker.getTypeAtLocation(actual))
        || (checker.getTypeAtLocation(actual).flags & (ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike | ts.TypeFlags.BigIntLike | ts.TypeFlags.BooleanLike | ts.TypeFlags.ESSymbolLike)) !== 0);
      if (literalData(value) || runtimePrimitiveValue(value) || returnedPrimitiveValue(value) || sdkData) continue;
      if ((ts.isArrowFunction(value) || ts.isFunctionExpression(value)) && inlineOwned(value)) continue;
      reasons.add("SOURCE_OPAQUE_CALLBACK_UNSUPPORTED");
    }
  };
  const sdkSerializer = (expression: ts.Expression): boolean => {
    const value = actualValue(expression);
    if ((ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value)) && staticMemberName(value) === "stringify"
      && sdkValue(actualValue(value.expression))?.getName() === "JSON") return true;
    const symbol = sdkValue(value);
    return symbol?.getName() === "stringify" && symbol.getDeclarations()?.some(declaration => program.isSourceFileDefaultLibrary(declaration.getSourceFile())
      && ts.isInterfaceDeclaration(declaration.parent) && declaration.parent.name.text === "JSON") === true;
  };
  const inspectSerializerUse = (node: ts.Identifier | ts.PropertyAccessExpression | ts.ElementAccessExpression): void => {
    if (!sdkSerializer(node)) return;
    if (ts.isIdentifier(node) && ((ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)
      || (ts.isVariableDeclaration(node.parent) && node.parent.name === node) || ts.isBindingElement(node.parent))) return;
    let usage: ts.Expression = node;
    while (ts.isParenthesizedExpression(usage.parent) || ts.isAsExpression(usage.parent) || ts.isTypeAssertionExpression(usage.parent)
      || ts.isNonNullExpression(usage.parent) || ts.isSatisfiesExpression(usage.parent)) usage = usage.parent;
    const parent = usage.parent;
    if (ts.isVariableDeclaration(parent) && parent.initializer === usage && ts.isIdentifier(parent.name)
      && ts.isVariableDeclarationList(parent.parent) && (parent.parent.flags & ts.NodeFlags.Const) !== 0) return;
    if (ts.isCallExpression(parent) && parent.expression === usage && (parent.arguments[0] === undefined || literalData(parent.arguments[0]))) return;
    reasons.add("SOURCE_SERIALIZATION_UNSUPPORTED");
  };
  const serviceWorkerLoader = (expression: ts.Expression): boolean => {
    const value = unwrapStaticExpression(expression);
    if ((ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value)) && staticMemberName(value) === "register"
      && sdkValue(value.expression)?.getName() === "serviceWorker") return true;
    const symbol = sdkValue(expression);
    return symbol?.getName() === "register" && (symbol.getDeclarations() ?? []).some(declaration => program.isSourceFileDefaultLibrary(declaration.getSourceFile())
      && ts.isInterfaceDeclaration(declaration.parent) && declaration.parent.name.text === "ServiceWorkerContainer");
  };
  const workletLoader = (expression: ts.Expression): boolean => {
    const value = actualValue(expression);
    const name = staticMemberName(value);
    const symbol = (ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value)) && name !== undefined
      ? checker.getPropertyOfType(checker.getTypeAtLocation(actualValue(value.expression)), name) : sdkValue(value);
    return symbol?.getName() === "addModule" && symbol.getDeclarations()?.some(declaration => program.isSourceFileDefaultLibrary(declaration.getSourceFile())
      && ts.isInterfaceDeclaration(declaration.parent) && declaration.parent.name.text === "Worklet") === true;
  };
  const proxyFactory = (expression: ts.Expression): boolean => {
    const value = unwrapStaticExpression(expression);
    if ((ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value)) && staticMemberName(value) === "revocable" && sdkValue(value.expression)?.getName() === "Proxy") return true;
    const symbol = sdkValue(value);
    return symbol?.getName() === "revocable" && (symbol.getDeclarations() ?? []).some(declaration => program.isSourceFileDefaultLibrary(declaration.getSourceFile())
      && ts.isInterfaceDeclaration(declaration.parent) && declaration.parent.name.text === "ProxyConstructor");
  };
  const reflectedInvocation = (expression: ts.Expression): boolean => {
    const symbol = sdkValue(expression);
    return symbol !== undefined && ["apply", "construct"].includes(symbol.getName())
      && (symbol.getDeclarations() ?? []).some(declaration => ts.isModuleBlock(declaration.parent)
        && ts.isModuleDeclaration(declaration.parent.parent) && declaration.parent.parent.name.getText() === "Reflect"
        && program.isSourceFileDefaultLibrary(declaration.getSourceFile()));
  };
  const intrinsicIterable = (expression: ts.Expression, seen = new Set<ts.Node>()): boolean => {
    const value = unwrapStaticExpression(expression);
    if (seen.has(value)) return false;
    seen.add(value);
    if (ts.isArrayLiteralExpression(value) || ts.isStringLiteralLike(value) || ts.isTemplateExpression(value)) return true;
    if (ts.isNewExpression(value) && ["Array", "Map", "Set"].includes(sdkValue(value.expression)?.getName() ?? "")) return true;
    return declarations(value).some(declaration => ts.isVariableDeclaration(declaration) && ts.isVariableDeclarationList(declaration.parent)
      && (declaration.parent.flags & ts.NodeFlags.Const) !== 0 && declaration.initializer !== undefined && intrinsicIterable(declaration.initializer, seen));
  };
  const literalArray = (expression: ts.Expression, seen = new Set<ts.Node>()): ts.ArrayLiteralExpression | undefined => {
    const value = unwrapStaticExpression(expression);
    if (seen.has(value)) return undefined;
    seen.add(value);
    if (ts.isArrayLiteralExpression(value)) return value;
    for (const declaration of declarations(value)) if (ts.isVariableDeclaration(declaration) && ts.isVariableDeclarationList(declaration.parent)
      && (declaration.parent.flags & ts.NodeFlags.Const) !== 0 && declaration.initializer !== undefined) {
      const array = literalArray(declaration.initializer, seen); if (array !== undefined) return array;
    }
    return undefined;
  };
  const bindingValue = (pattern: ts.ArrayBindingPattern): ts.Expression | undefined => {
    const parent = pattern.parent;
    if (ts.isVariableDeclaration(parent)) return parent.initializer;
    if (!ts.isBindingElement(parent) || !ts.isArrayBindingPattern(parent.parent) || parent.dotDotDotToken !== undefined) return undefined;
    const outer = bindingValue(parent.parent);
    const array = outer === undefined ? undefined : literalArray(outer);
    const index = parent.parent.elements.indexOf(parent);
    if (array === undefined || array.elements.slice(0, index + 1).some(element => ts.isSpreadElement(element))) return undefined;
    const item = array.elements[index];
    return item === undefined || ts.isOmittedExpression(item) ? undefined : item;
  };
  const asyncValue = (expression: ts.Expression, seen = new Set<ts.Node>()): boolean => {
    const value = unwrapStaticExpression(expression);
    if (seen.has(value)) return false;
    seen.add(value);
    const isAsync = (node: ts.Node): boolean => ts.canHaveModifiers(node)
      && ts.getModifiers(node)?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword) === true;
    if (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) return isAsync(value);
    return declarations(value).some(declaration => ((ts.isFunctionDeclaration(declaration) || ts.isMethodDeclaration(declaration)) && isAsync(declaration))
      || (ts.isVariableDeclaration(declaration) && ts.isVariableDeclarationList(declaration.parent)
        && (declaration.parent.flags & ts.NodeFlags.Const) !== 0 && declaration.initializer !== undefined && asyncValue(declaration.initializer, seen)));
  };
  const safeAwaitValue = (expression: ts.Expression, seen = new Set<ts.Node>()): boolean => {
    const value = unwrapStaticExpression(expression);
    if (seen.has(value)) return false;
    seen.add(value);
    if (ts.isAwaitExpression(value)) return safeAwaitValue(value.expression, seen);
    // Iterable objects remain mutable even behind a const binding; an initializer is
    // not proof that a then override or prototype cannot participate in assimilation.
    if (primitiveValue(value)) return true;
    if (ts.isNewExpression(value) && sdkValue(value.expression)?.getName() === "Promise") return true;
    if (ts.isCallExpression(value)) {
      const callee = unwrapStaticExpression(value.expression);
      if (callee.kind === ts.SyntaxKind.ImportKeyword && value.arguments.length === 1 && ts.isStringLiteralLike(value.arguments[0]!)) return true;
      if (asyncValue(callee)) return true;
      if (ts.isPropertyAccessExpression(callee) && sdkValue(callee.expression)?.getName() === "Promise"
        && sdkValue(callee) !== undefined) {
        if (callee.name.text === "reject") return true;
        if (callee.name.text === "resolve") return value.arguments[0] === undefined || safeAwaitValue(value.arguments[0], seen);
      }
    }
    return declarations(value).some(declaration => ts.isVariableDeclaration(declaration) && ts.isVariableDeclarationList(declaration.parent)
      && (declaration.parent.flags & ts.NodeFlags.Const) !== 0 && declaration.initializer !== undefined && safeAwaitValue(declaration.initializer, seen));
  };
  const timerNames = new Set(["setTimeout", "setInterval"]);
  const sdkTimer = (symbol: ts.Symbol | undefined): boolean => symbol !== undefined && timerNames.has(symbol.getName())
    && (symbol.getDeclarations()?.length ?? 0) > 0 && symbol.getDeclarations()!.every(declaration => program.isSourceFileDefaultLibrary(declaration.getSourceFile()));
  const timerValue = (expression: ts.Expression, seen = new Set<ts.Node>()): boolean => {
    const value = unwrapStaticExpression(expression);
    if (seen.has(value)) return false;
    seen.add(value);
    if (sdkTimer(sdkValue(value))) return true;
    for (const declaration of declarations(value)) {
      if (ts.isVariableDeclaration(declaration) && ts.isVariableDeclarationList(declaration.parent)
        && (declaration.parent.flags & ts.NodeFlags.Const) !== 0 && declaration.initializer !== undefined
        && timerValue(declaration.initializer, seen)) return true;
      if (ts.isBindingElement(declaration) && ts.isObjectBindingPattern(declaration.parent)
      && ts.isVariableDeclaration(declaration.parent.parent) && declaration.parent.parent.initializer !== undefined
      && ts.isVariableDeclarationList(declaration.parent.parent.parent) && (declaration.parent.parent.parent.flags & ts.NodeFlags.Const) !== 0) {
      const member = declaration.propertyName ?? declaration.name;
      if ((ts.isIdentifier(member) || ts.isStringLiteral(member)) && sdkTimer(checker.getPropertyOfType(checker.getTypeAtLocation(declaration.parent.parent.initializer), member.text))) return true;
      }
    }
    return false;
  };
  const unsafeHandler = (type: ts.Type): boolean => {
    if ((type.flags & (ts.TypeFlags.StringLike | ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter)) !== 0) return true;
    if (type.isUnion()) return type.types.some(unsafeHandler);
    if (type.isIntersection() && type.types.some(part => (part.flags & (ts.TypeFlags.StringLike | ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter)) !== 0)) return true;
    return type.getCallSignatures().length === 0 && !(type.getSymbol()?.getName() === "Function"
      && type.getSymbol()!.getDeclarations()?.every(declaration => program.isSourceFileDefaultLibrary(declaration.getSourceFile())));
  };
  const inspectTimerUse = (node: ts.Identifier | ts.PropertyAccessExpression | ts.ElementAccessExpression): void => {
    const parent = node.parent;
    if (ts.isIdentifier(node) && ((ts.isPropertyAccessExpression(parent) && parent.name === node)
      || (ts.isVariableDeclaration(parent) && parent.name === node) || ts.isBindingElement(parent))) return;
    if (!timerValue(node)) return;
    for (let current: ts.Node | undefined = node; current !== undefined; current = current.parent) if (ts.isTypeNode(current)) return;
    let usage: ts.Expression = node;
    while (ts.isParenthesizedExpression(usage.parent) || ts.isAsExpression(usage.parent) || ts.isTypeAssertionExpression(usage.parent)
      || ts.isNonNullExpression(usage.parent) || ts.isSatisfiesExpression(usage.parent)) {
      if (unwrapStaticExpression(usage.parent) !== unwrapStaticExpression(node)) break;
      usage = usage.parent;
    }
    const container = usage.parent;
    if (ts.isVariableDeclaration(container) && container.initializer === usage && ts.isIdentifier(container.name)
      && ts.isVariableDeclarationList(container.parent) && (container.parent.flags & ts.NodeFlags.Const) !== 0) return;
    if (ts.isCallExpression(container) && container.expression === usage && container.arguments[0] !== undefined
      && !unsafeHandler(checker.getTypeAtLocation(unwrapStaticExpression(container.arguments[0])))) {
      reasons.add("SOURCE_TIMER_CALLBACK_UNSUPPORTED"); return;
    }
    reasons.add("SOURCE_TIMER_EVALUATION_UNSUPPORTED");
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
  const sdkGlobalOrigins = (origins: readonly ts.Declaration[]): boolean => origins.length > 0
    && origins.every(origin => program.isSourceFileDefaultLibrary(origin.getSourceFile()))
    && origins.some(origin => ts.isVariableDeclaration(origin));
  const sdkGlobalMember = (expression: ts.Expression, name: string | undefined): boolean => {
    const receiver = actualValue(expression);
    const origins = declarations(receiver);
    // JavaScript descriptor inference adds identifier/call declarations to these SDK symbols.
    const global = ts.isIdentifier(receiver) && receiver.text === "globalThis" && checker.getSymbolAtLocation(receiver) !== undefined
      && origins.every(origin => ts.isIdentifier(origin) && origin.text === "globalThis");
    return name !== undefined && (global || sdkOrigin(receiver))
      && sdkGlobalOrigins((checker.getPropertyOfType(checker.getTypeAtLocation(receiver), name)?.getDeclarations() ?? [])
        .filter(origin => program.isSourceFileDefaultLibrary(origin.getSourceFile())));
  };
  const sdkGlobalAssignment = (expression: ts.Expression): boolean => {
    const target = unwrapStaticExpression(expression);
    if (ts.isArrayLiteralExpression(target)) return target.elements.some(element =>
      ts.isSpreadElement(element) ? sdkGlobalAssignment(element.expression) : ts.isExpression(element) && sdkGlobalAssignment(element));
    if (ts.isObjectLiteralExpression(target)) return target.properties.some(property => {
      if (ts.isPropertyAssignment(property)) return sdkGlobalAssignment(property.initializer);
      if (ts.isSpreadAssignment(property)) return sdkGlobalAssignment(property.expression);
      if (ts.isShorthandPropertyAssignment(property)) return sdkGlobalOrigins(checker.getShorthandAssignmentValueSymbol(property)?.getDeclarations() ?? []);
      return false;
    });
    if (assignment(target)) return sdkGlobalAssignment(target.left);
    return sdkGlobalOrigins(declarations(target));
  };
  const runtimeProperty = (node: ts.Node): boolean => {
    if (node.getSourceFile().isDeclarationFile) return false;
    for (let owner: ts.Node | undefined = node; owner !== undefined; owner = owner.parent) {
      if (ts.canHaveModifiers(owner) && ts.getModifiers(owner)?.some(modifier => modifier.kind === ts.SyntaxKind.DeclareKeyword)) return false;
    }
    return true;
  };
  const sdkMemberOf = (expression: ts.Expression, owner: string, member: string): boolean => {
    const symbol = sdkValue(actualValue(expression));
    return symbol?.getName() === member && symbol.getDeclarations()?.some(origin => {
      for (let parent: ts.Node | undefined = origin.parent; parent !== undefined; parent = parent.parent) {
        if ((ts.isInterfaceDeclaration(parent) || ts.isModuleDeclaration(parent)) && parent.name.text === owner) return true;
      }
      return false;
    }) === true;
  };
  const sdkScriptElement = (expression: ts.Expression): boolean => {
    const value = actualValue(expression);
    if (!ts.isCallExpression(value) || value.arguments[0] === undefined || constantString(value.arguments[0]) !== "script") return false;
    const callee = actualValue(value.expression);
    return (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee))
      && sdkOrigin(callee.expression) && sdkMemberOf(callee, "Document", "createElement");
  };
  // DOM insertion algorithms reach HTML script post-connection preparation.
  // Coordinates select inserted nodes, never reference/replaced nodes or position strings.
  const sdkNodeInsertions = [
    ["Node", "appendChild", 0], ["Node", "insertBefore", 0], ["Node", "replaceChild", 0],
    ["ParentNode", "append", "all"], ["ParentNode", "prepend", "all"], ["ParentNode", "replaceChildren", "all"],
    ["ChildNode", "before", "all"], ["ChildNode", "after", "all"], ["ChildNode", "replaceWith", "all"],
    ["Element", "insertAdjacentElement", 1], ["Range", "insertNode", 0],
  ] as const;
  const importMetaMember = (expression: ts.Expression, seen = new Set<ts.Node>()): boolean => {
    const value = actualValue(expression);
    if (seen.has(value)) return false;
    seen.add(value);
    if (ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value)) {
      const receiver = actualValue(value.expression);
      if (ts.isMetaProperty(receiver) && receiver.keywordToken === ts.SyntaxKind.ImportKeyword) return staticMemberName(value) !== "require";
      const primitive = (checker.getTypeAtLocation(receiver).flags & (ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike | ts.TypeFlags.BooleanLike | ts.TypeFlags.BigIntLike | ts.TypeFlags.ESSymbolLike)) !== 0;
      return !primitive && importMetaMember(receiver, seen);
    }
    return (checker.getSymbolAtLocation(value)?.getDeclarations() ?? []).some(origin => ts.isBindingElement(origin)
      && ts.isObjectBindingPattern(origin.parent) && ts.isVariableDeclaration(origin.parent.parent)
      && origin.parent.parent.initializer !== undefined
      && ts.isMetaProperty(actualValue(origin.parent.parent.initializer)) && propertyName(origin.propertyName ?? origin.name) !== "require");
  };
  const inspectImportMetaMember = (node: ts.Identifier | ts.PropertyAccessExpression | ts.ElementAccessExpression): void => {
    if (!importMetaMember(node)) return;
    const value = actualValue(node);
    const type = checker.getTypeAtLocation(value);
    if (!potentiallyCallable(type)) return;
    const parent = node.parent;
    if ((ts.isPropertyAccessExpression(parent) && parent.name === node) || (ts.isVariableDeclaration(parent) && parent.name === node)
      || ts.isBindingElement(parent)) return;
    if ((ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) && parent.expression === node) return;
    if (ts.isVariableDeclaration(parent) && parent.initializer === node && ts.isVariableDeclarationList(parent.parent)
      && (parent.parent.flags & ts.NodeFlags.Const) !== 0 && ts.isIdentifier(parent.name)) return;
    reasons.add("SOURCE_IMPORT_META_CALLABLE_UNSUPPORTED");
  };
  const inspectRuntimeCode = (node: ts.CallExpression | ts.NewExpression): void => {
    if (sdkOrigin(node.expression) && ["String", "Number"].includes(sdkValue(actualValue(node.expression))?.getName() ?? "")
      && node.arguments?.[0] !== undefined && !primitiveValue(node.arguments[0])) reasons.add("SOURCE_COERCION_UNSUPPORTED");
    if (sdkOrigin(node.expression) && ((ts.isCallExpression(node) && ["instantiate", "instantiateStreaming"].some(member => sdkMemberOf(node.expression, "WebAssembly", member)))
      || (ts.isNewExpression(node) && sdkMemberOf(node.expression, "WebAssembly", "Instance")))) {
      reasons.add("SOURCE_WASM_INSTANTIATION_UNSUPPORTED");
    }
    if (!ts.isCallExpression(node)) return;
    const callee = actualValue(node.expression);
    if ((ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) && sdkOrigin(callee.expression)) {
      if (sdkMemberOf(callee, "Math", sdkValue(callee)?.getName() ?? "")) {
        const signature = checker.getResolvedSignature(node); const declaration = signature?.getDeclaration();
        if (signature !== undefined && declaration !== undefined && program.isSourceFileDefaultLibrary(declaration.getSourceFile())) {
          for (const [index, parameter] of signature.getParameters().entries()) {
            const rest = parameter.getDeclarations()?.some(origin => ts.isParameter(origin) && origin.dotDotDotToken !== undefined) === true;
            const type = checker.getTypeOfSymbolAtLocation(parameter, declaration);
            const numeric = rest ? type.getNumberIndexType() : type;
            if (numeric === undefined || (numeric.flags & ts.TypeFlags.NumberLike) === 0) continue;
            const consumed = rest ? node.arguments.slice(index) : node.arguments.slice(index, index + 1);
            if (consumed.some(argument => !primitiveValue(argument))) reasons.add("SOURCE_COERCION_UNSUPPORTED");
          }
        }
      }
      if (sdkMemberOf(callee, "Array", "join")) {
        const array = literalArray(callee.expression);
        if (array === undefined || !array.elements.every(element => ts.isExpression(element) && primitiveValue(element))
          || (node.arguments[0] !== undefined && !primitiveValue(node.arguments[0]))) reasons.add("SOURCE_COERCION_UNSUPPORTED");
      }
      if (sdkMemberOf(callee, "Array", "toLocaleString")) {
        const array = literalArray(callee.expression);
        const locales = node.arguments[0]; const options = node.arguments[1];
        const localeValue = locales === undefined ? undefined : unwrapStaticExpression(locales);
        const optionValue = options === undefined ? undefined : unwrapStaticExpression(options);
        const safeLocales = locales === undefined || primitiveValue(locales) || (localeValue !== undefined && ts.isArrayLiteralExpression(localeValue)
          && localeValue.elements.every(element => ts.isExpression(element) && primitiveValue(element)));
        const safeOptions = options === undefined || primitiveValue(options) || (optionValue !== undefined && ts.isObjectLiteralExpression(optionValue)
          && literalData(optionValue) && optionValue.properties.every(property => ts.isPropertyAssignment(property) ? primitiveValue(property.initializer)
            : ts.isShorthandPropertyAssignment(property) && primitiveValue(property.name)));
        if (array === undefined || !array.elements.every(element => ts.isExpression(element) && primitiveValue(element))
          || !safeLocales || !safeOptions) reasons.add("SOURCE_COERCION_UNSUPPORTED");
      }
      if (["write", "writeln"].some(member => sdkMemberOf(callee, "Document", member))) reasons.add("SOURCE_DOCUMENT_WRITE_UNSUPPORTED");
      const insertion = sdkNodeInsertions.find(([owner, member]) => sdkMemberOf(callee, owner, member));
      if (insertion !== undefined) {
        const inserted = insertion[2] === "all" ? node.arguments : node.arguments.slice(insertion[2], insertion[2] + 1);
        if (inserted.some(sdkScriptElement)) reasons.add("SOURCE_SCRIPT_INSERTION_UNSUPPORTED");
      }
    }
  };
  const visit = (node: ts.Node): void => {
    if (ts.isTypeNode(node) || ts.isInterfaceDeclaration(node)) return;
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) { inspectSdkCallbacks(node); inspectRuntimeCode(node); }
    if (ts.isCallExpression(node)) { inspectOpaqueCallbacks(node); inspectDefaultSort(node); }
    if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) inspectImportMetaMember(node);
    if (ts.isPropertyAssignment(node) && ts.isObjectLiteralExpression(node.parent)
      && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) && node.name.text === "__proto__"
      && !literalData(node.initializer)) reasons.add("SOURCE_PROTOTYPE_MUTATION_UNSUPPORTED");
    if (ts.isFunctionDeclaration(node) && node.body === undefined && (node.name === undefined || !declarations(node.name).some(origin =>
      ts.isFunctionDeclaration(origin) && origin.body !== undefined && internal(origin)
      && !ts.getModifiers(origin)?.some(modifier => modifier.kind === ts.SyntaxKind.DeclareKeyword)))) reasons.add("SOURCE_AMBIENT_FUNCTION_UNSUPPORTED");
    if (runtimeProperty(node) && ((ts.isElementAccessExpression(node) && !propertyKey(node.argumentExpression))
      || (ts.isComputedPropertyName(node) && !propertyKey(node.expression)))) reasons.add("SOURCE_PROPERTY_KEY_UNSUPPORTED");
    if (ts.isComputedPropertyName(node) && runtimeProperty(node) && protocolKey(node.expression)
      && (ts.isMethodDeclaration(node.parent)
        || (ts.isPropertyAssignment(node.parent) && !primitiveValue(node.parent.initializer))
        || (ts.isPropertyDeclaration(node.parent) && node.parent.initializer !== undefined && !primitiveValue(node.parent.initializer)))) {
      reasons.add("SOURCE_PROTOCOL_DEFINITION_UNSUPPORTED");
    }
    if (assignment(node)
      && staticMemberName(unwrapStaticExpression(node.left)) === "then" && !primitiveValue(node.right)) reasons.add("SOURCE_THENABLE_MUTATION_UNSUPPORTED");
    if (assignment(node)) {
      const target = unwrapStaticExpression(node.left);
      if (sdkGlobalAssignment(target)) reasons.add("SOURCE_SDK_GLOBAL_MUTATION_UNSUPPORTED");
      if (ts.isElementAccessExpression(target) && iteratorKey(target.argumentExpression)) reasons.add("SOURCE_ITERATOR_MUTATION_UNSUPPORTED");
      else if (ts.isElementAccessExpression(target) && protocolKey(target.argumentExpression)) reasons.add("SOURCE_PROTOCOL_MUTATION_UNSUPPORTED");
      if (sdkCallableProperty(target) && !primitiveValue(node.right)) reasons.add("SOURCE_SDK_CALLABLE_MUTATION_UNSUPPORTED");
    }
    if ((coercingBinary(node)
      && (!primitiveValue(node.left) || !primitiveValue(node.right)))
      || (propertyMembership(node) && !propertyKey(node.left))
      || (numericUnary(node) && !primitiveValue(node.operand))
      || (ts.isTemplateExpression(node) && node.templateSpans.some(span => !primitiveValue(span.expression)))) reasons.add("SOURCE_COERCION_UNSUPPORTED");
    if ((ts.isReturnStatement(node) && node.expression !== undefined && asyncOwner(node) && !safeAwaitValue(node.expression))
      || (ts.isArrowFunction(node) && !ts.isBlock(node.body) && ts.getModifiers(node)?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword)
        && !safeAwaitValue(node.body))) reasons.add("SOURCE_ASYNC_RETURN_UNSUPPORTED");
    if ((ts.isIdentifier(node) || ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) && serviceWorkerLoader(node)) reasons.add("SOURCE_SERVICE_WORKER_LOADER_UNSUPPORTED");
    if ((ts.isIdentifier(node) || ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) && workletLoader(node)) reasons.add("SOURCE_WORKLET_LOADER_UNSUPPORTED");
    if ((ts.isIdentifier(node) || ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) && sdkValue(node)?.getName() === "importScripts") reasons.add("SOURCE_WORKER_LOADER_UNSUPPORTED");
    if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) inspectDescriptorUse(node);
    if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      inspectReflectSetUse(node);
      inspectMetaObjectUse(node);
      inspectBuiltinProcessUse(node);
    }
    if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      inspectPromiseResolveUse(node);
      inspectSerializerUse(node);
      inspectCombinatorUse(node);
    }
    if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) inspectMutationUse(node);
    if ((ts.isIdentifier(node) || ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) && proxyFactory(node)) reasons.add("SOURCE_PROXY_UNSUPPORTED");
    if (ts.isAwaitExpression(node) && !safeAwaitValue(node.expression)) reasons.add("SOURCE_AWAIT_UNSUPPORTED");
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword
      && !sdkConstruction(sdkValue(node.right))) reasons.add("SOURCE_INSTANCEOF_UNSUPPORTED");
    if (ts.isArrayBindingPattern(node)) {
      const value = bindingValue(node);
      if (value === undefined || !intrinsicIterable(value)) reasons.add("SOURCE_ITERATION_UNSUPPORTED");
    }
    if ((ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isArrayLiteralExpression(node.left) && !intrinsicIterable(node.right))
      || (ts.isYieldExpression(node) && node.asteriskToken !== undefined && (node.expression === undefined || !intrinsicIterable(node.expression)))) reasons.add("SOURCE_ITERATION_UNSUPPORTED");
    if ((ts.isIdentifier(node) || ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))
      && reflectedInvocation(node)) reasons.add("SOURCE_REFLECT_INVOCATION_UNSUPPORTED");
    if ((ts.isForOfStatement(node) || ts.isSpreadElement(node)) && !intrinsicIterable(node.expression)) reasons.add("SOURCE_ITERATION_UNSUPPORTED");
    if (ts.isNewExpression(node)) {
      const origin = sdkValue(node.expression);
      if (!sdkConstruction(origin)) reasons.add("SOURCE_CONSTRUCTION_UNSUPPORTED");
      else if (origin!.getName() === "Date" && sdkOrigin(node.expression)) {
        const argumentsToCoerce = node.arguments?.slice(0, 7) ?? [];
        const first = argumentsToCoerce[0] === undefined ? undefined : actualValue(argumentsToCoerce[0]);
        const copiedDate = argumentsToCoerce.length === 1 && first !== undefined && ts.isNewExpression(first)
          && sdkOrigin(first.expression) && sdkValue(first.expression)?.getName() === "Date" && sdkConstruction(sdkValue(first.expression));
        if (!copiedDate && argumentsToCoerce.some(argument => !primitiveValue(argument))) reasons.add("SOURCE_COERCION_UNSUPPORTED");
      }
      else if (["Worker", "SharedWorker"].includes(origin!.getName())) reasons.add("SOURCE_WORKER_LOADER_UNSUPPORTED");
      else if (origin!.getName() === "Proxy") reasons.add("SOURCE_PROXY_UNSUPPORTED");
    }
    if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) inspectTimerUse(node);
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
