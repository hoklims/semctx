import ts from "typescript";
import { dirname, relative, isAbsolute, join } from "node:path";
import { builtinModules } from "node:module";
import { resolveTypeScriptModule, retainedCompilerSystem, type CompilerInputSnapshot } from "./ts-symbols";

const BUILTIN_MODULES = new Set(builtinModules.map(name => name.replace(/^node:/, "")));

/** Closed native-module eligibility, without inventing dependencies loaded at runtime. */
export function inspectNativeModuleBindings(source: ts.SourceFile): { commonJsUnsupported: boolean; unmodeledMembers: string[] } {
  type Origin = "factory" | "namespace" | "global" | "process" | "ordinary" | "unmodeled" | "other";
  const unmodeledMembers = new Set<string>();
  let found = false;
  const result = () => ({ commonJsUnsupported: found, unmodeledMembers: [...unmodeledMembers].sort() });
  const nativeExportOrigin = (name: string | undefined): Origin => {
    if (name === "createRequire" || name === "_load") return "factory";
    if (name === "default" || name === "Module") return "namespace";
    if (name === "isBuiltin" || name === "builtinModules") return "ordinary";
    unmodeledMembers.add(name ?? "<computed>");
    return "unmodeled";
  };
  const staticName = (node: ts.Node | undefined): string | undefined => node !== undefined
    && (ts.isIdentifier(node) || ts.isStringLiteral(node)) ? node.text : undefined;
  const isNodeModule = (node: ts.Node | undefined): boolean => node !== undefined && ts.isStringLiteral(node)
    && ["node:module", "module"].includes(node.text);
  const isNodeProcess = (node: ts.Node | undefined): boolean => node !== undefined && ts.isStringLiteral(node)
    && ["node:process", "process"].includes(node.text);
  const unmodeledResolver = (): Origin => {
    unmodeledMembers.add("process.getBuiltinModule");
    return "unmodeled";
  };
  const processExportOrigin = (name: string | undefined): Origin => {
    if (name === "default") return "process";
    if (name === "getBuiltinModule") return unmodeledResolver();
    return "other";
  };
  const globalMemberOrigin = (name: string | undefined): Origin => name === "process" ? "process"
    : name === "global" || name === "globalThis" ? "global" : "other";
  for (const statement of source.statements) {
    if (!ts.isExportDeclaration(statement) || statement.isTypeOnly) continue;
    if (isNodeProcess(statement.moduleSpecifier)) {
      if (!statement.exportClause || ts.isNamespaceExport(statement.exportClause)) unmodeledResolver();
      else for (const element of statement.exportClause.elements) {
        if (!element.isTypeOnly && processExportOrigin(staticName(element.propertyName ?? element.name)) === "process") unmodeledResolver();
      }
      continue;
    }
    if (!isNodeModule(statement.moduleSpecifier)) continue;
    if (!statement.exportClause || ts.isNamespaceExport(statement.exportClause)) found = true;
    else for (const element of statement.exportClause.elements) {
      if (element.isTypeOnly) continue;
      const kind = nativeExportOrigin(staticName(element.propertyName ?? element.name));
      if (kind === "factory" || kind === "namespace") found = true;
    }
  }
  let importsNodeModule = false;
  const findModule = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) && (isNodeModule(node) || isNodeProcess(node))
      && (ts.isImportDeclaration(node.parent) || (ts.isCallExpression(node.parent) && node.parent.expression.kind === ts.SyntaxKind.ImportKeyword))) importsNodeModule = true;
    if (ts.isImportDeclaration(node) && isNodeProcess(node.moduleSpecifier)) importsNodeModule = true;
    if (ts.isIdentifier(node) && ["globalThis", "global"].includes(node.text)) importsNodeModule = true;
    if ((ts.isPropertyAccessExpression(node) && node.name.text === "getBuiltinModule")
      || (ts.isElementAccessExpression(node) && staticName(node.argumentExpression) === "getBuiltinModule")
      || (ts.isBindingElement(node) && staticName(node.propertyName ?? node.name) === "getBuiltinModule")) importsNodeModule = true;
    ts.forEachChild(node, findModule);
  };
  findModule(source);
  if (!importsNodeModule) return result();
  // Bind only the supplied AST. No source, dependency or configuration is read from disk.
  const options: ts.CompilerOptions = { noLib: true, noResolve: true, allowJs: true, target: ts.ScriptTarget.ESNext };
  const host = ts.createCompilerHost(options);
  host.getSourceFile = (path) => path === source.fileName ? source : undefined;
  host.fileExists = (path) => path === source.fileName;
  host.readFile = (path) => path === source.fileName ? source.text : undefined;
  host.resolveModuleNames = (names) => names.map(() => undefined);
  const checker = ts.createProgram([source.fileName], options, host).getTypeChecker();
  const origin = (node: ts.Node, seen = new Set<ts.Symbol>()): Origin => {
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node) || ts.isAwaitExpression(node)) return origin(node.expression, seen);
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && isNodeModule(node.arguments[0])) return "namespace";
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && isNodeProcess(node.arguments[0])) return "process";
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const property = ts.isPropertyAccessExpression(node) ? node.name.text : ts.isStringLiteral(node.argumentExpression) ? node.argumentExpression.text : undefined;
      if (origin(node.expression, seen) === "namespace") return nativeExportOrigin(property);
      if (origin(node.expression, seen) === "global") return globalMemberOrigin(property);
      if (origin(node.expression, seen) === "process") return processExportOrigin(property);
      return "other";
    }
    if (!ts.isIdentifier(node)) return "other";
    const symbol = checker.getSymbolAtLocation(node);
    if (symbol === undefined) return node.text === "process" ? "process" : ["globalThis", "global"].includes(node.text) ? "global" : "other";
    // TypeScript binds the intrinsic globalThis even without libraries. Local names
    // have declarations and must not acquire the ambient native process origin.
    if (node.text === "globalThis" && symbol.name === "globalThis" && !symbol.declarations?.length) return "global";
    if (seen.has(symbol)) return "other";
    const next = new Set(seen).add(symbol);
    for (const declaration of symbol.declarations ?? []) {
      if (ts.isImportSpecifier(declaration) && !declaration.isTypeOnly && !declaration.parent.parent.isTypeOnly
        && isNodeProcess(declaration.parent.parent.parent.moduleSpecifier)) return processExportOrigin(staticName(declaration.propertyName ?? declaration.name));
      if (ts.isNamespaceImport(declaration) && !declaration.parent.isTypeOnly && isNodeProcess(declaration.parent.parent.moduleSpecifier)) return "process";
      if (ts.isImportClause(declaration) && !declaration.isTypeOnly && isNodeProcess(declaration.parent.moduleSpecifier)) return "process";
      if (ts.isImportSpecifier(declaration) && !declaration.isTypeOnly && !declaration.parent.parent.isTypeOnly
        && isNodeModule(declaration.parent.parent.parent.moduleSpecifier)) return nativeExportOrigin(staticName(declaration.propertyName ?? declaration.name));
      if (ts.isNamespaceImport(declaration) && !declaration.parent.isTypeOnly && isNodeModule(declaration.parent.parent.moduleSpecifier)) return "namespace";
      if (ts.isImportClause(declaration) && !declaration.isTypeOnly && isNodeModule(declaration.parent.moduleSpecifier)) return "namespace";
      if (ts.isVariableDeclaration(declaration) && declaration.initializer) return origin(declaration.initializer, next);
      if (ts.isBindingElement(declaration) && ts.isObjectBindingPattern(declaration.parent)
        && ts.isVariableDeclaration(declaration.parent.parent) && declaration.parent.parent.initializer) {
        const container = origin(declaration.parent.parent.initializer, next);
        const member = staticName(declaration.propertyName ?? declaration.name);
        if (container === "namespace") return nativeExportOrigin(member);
        if (container === "global") return globalMemberOrigin(member);
        if (container === "process") return processExportOrigin(member);
      }
    }
    return "other";
  };
  const safeNamespaceUse = (node: ts.Node): boolean => {
    const parent = node.parent;
    if ((ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) && parent.expression === node) {
      return true; // Unknown/computed members are classified separately as unmodeled.
    }
    if ((ts.isParenthesizedExpression(parent) || ts.isAsExpression(parent) || ts.isNonNullExpression(parent) || ts.isAwaitExpression(parent)) && parent.expression === node) return true;
    if (ts.isTypeOfExpression(parent) || ts.isTypeNode(parent)) return true;
    if (!ts.isVariableDeclaration(parent) || parent.initializer !== node
      || (parent.parent.flags & ts.NodeFlags.Const) === 0) return false;
    return ts.isIdentifier(parent.name) || (ts.isObjectBindingPattern(parent.name) && parent.name.elements.every((element) =>
      !element.dotDotDotToken && ts.isIdentifier(element.name)
      && (element.propertyName === undefined || ts.isIdentifier(element.propertyName) || ts.isStringLiteral(element.propertyName))));
  };
  const markNativeEscape = (kind: Origin): void => {
    if (kind === "factory" || kind === "namespace") found = true;
    if (kind === "global") unmodeledMembers.add("ambient-global");
  };
  const visit = (node: ts.Node): void => {
    if (ts.isTypeNode(node)) return; // Type queries do not access the native runtime getter.
    if (ts.isImportDeclaration(node)) return; // An unused binding is not a loader use.
    if (ts.isShorthandPropertyAssignment(node)) {
      const target = checker.getShorthandAssignmentValueSymbol(node);
      for (const declaration of target?.declarations ?? []) {
        const name = (declaration as ts.NamedDeclaration).name;
        if (name && ts.isIdentifier(name)) markNativeEscape(origin(name));
      }
    }
    if (ts.isExportAssignment(node)) markNativeEscape(origin(node.expression));
    if (ts.isVariableStatement(node) && ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
      for (const declaration of node.declarationList.declarations) {
        if (declaration.initializer) markNativeEscape(origin(declaration.initializer));
      }
    }
    if (ts.isExportSpecifier(node) && !node.isTypeOnly && !node.parent.parent.isTypeOnly) {
      const target = checker.getExportSpecifierLocalTargetSymbol(node);
      for (const declaration of target?.declarations ?? []) {
        const name = (declaration as ts.NamedDeclaration).name;
        if (name && ts.isIdentifier(name)) markNativeEscape(origin(name));
      }
    }
    const declarationName = ts.isIdentifier(node) && ((ts.isVariableDeclaration(node.parent) && node.parent.name === node)
      || (ts.isBindingElement(node.parent) && (node.parent.name === node || node.parent.propertyName === node))
      || (ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)
      || (ts.isPropertyAssignment(node.parent) && node.parent.name === node)
      || (ts.isParameter(node.parent) && node.parent.name === node));
    if (!declarationName && origin(node) === "factory") found = true;
    // A namespace containing createRequire cannot leave the understood immutable binding
    // routes: assignment, return, container and callback flows have no modeled load edges.
    if (!declarationName && origin(node) === "namespace" && !safeNamespaceUse(node)) found = true;
    if (!declarationName && origin(node) === "global" && (!safeNamespaceUse(node)
      || (ts.isElementAccessExpression(node.parent) && node.parent.expression === node && !ts.isStringLiteral(node.parent.argumentExpression)))) {
      unmodeledMembers.add("ambient-global");
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return result();
}

/** Compatibility predicate: unknown native members are not claimed to execute CommonJS. */
export function hasNodeCreateRequireUse(source: ts.SourceFile): boolean {
  return inspectNativeModuleBindings(source).commonJsUnsupported;
}

/** Diagnostic-only constructs never acquire a complete ESM capability by extension recognition. */
export function inspectJavaScriptSource(path: string, content: string, repositoryRoot?: string, compilerInputs?: CompilerInputSnapshot): {
  parseFailed: boolean;
  reasons: string[];
  staticExports: { name: string; declarationKind: string }[];
  staticModuleLinks: { specifier: string; resolution: "resolved" | "external" | "unresolved" }[];
} {
  const source = ts.createSourceFile(path, content, ts.ScriptTarget.ES2022, true,
    path.endsWith(".jsx") ? ts.ScriptKind.JSX : ts.ScriptKind.JS);
  const diagnostics = ts.transpileModule(content, { fileName: path, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.Preserve }, reportDiagnostics: true }).diagnostics ?? [];
  const reasons = new Set<string>(diagnostics.map(diagnostic =>
    `JAVASCRIPT_PARSE_ERROR:${diagnostic.code}:${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`));
  if (path.endsWith(".cjs")) reasons.add("JAVASCRIPT_COMMONJS_UNSUPPORTED");
  const native = inspectNativeModuleBindings(source);
  if (native.commonJsUnsupported) reasons.add("JAVASCRIPT_COMMONJS_UNSUPPORTED");
  for (const member of native.unmodeledMembers) reasons.add(`JAVASCRIPT_NATIVE_MODULE_MEMBER_UNSUPPORTED:${member}`);
  const staticExports: { name: string; declarationKind: string }[] = [];
  const staticModuleLinks: { specifier: string; resolution: "resolved" | "external" | "unresolved" }[] = [];
  const isDeclaredExternal = (specifier: string): boolean => {
    const packageName = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0]!;
    const system = compilerInputs === undefined ? ts.sys : retainedCompilerSystem(compilerInputs);
    for (let directory = dirname(path); ; directory = dirname(directory)) {
      if (repositoryRoot) {
        const relation = relative(repositoryRoot, directory).replaceAll("\\", "/");
        if (relation === ".." || relation.startsWith("../") || isAbsolute(relation)) return false;
      }
      const text = system.readFile(join(directory, "package.json"));
      if (text !== undefined) {
        try {
          const manifest = JSON.parse(text) as Record<string, unknown>;
          if (manifest.name === packageName) return false;
          for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
            const dependencies = manifest[field];
            if (dependencies && typeof dependencies === "object") {
              const version = (dependencies as Record<string, unknown>)[packageName];
              if (typeof version === "string") return !/^(workspace:|file:|link:)/.test(version);
            }
          }
        } catch { return false; }
      }
      if (dirname(directory) === directory) return false;
    }
  };
  const recordModuleLink = (specifier: string): void => {
    const resolved = resolveTypeScriptModule(specifier, path, undefined, true, compilerInputs);
    const external = BUILTIN_MODULES.has(specifier.replace(/^node:/, "")) || (resolved !== undefined && /[/\\]node_modules[/\\]/.test(resolved)) || (resolved === undefined && !specifier.startsWith(".") && isDeclaredExternal(specifier));
    staticModuleLinks.push({ specifier, resolution: external ? "external" : resolved !== undefined ? "resolved" : "unresolved" });
    if (resolved === undefined && !external) reasons.add(`JAVASCRIPT_IMPORT_UNRESOLVED:${specifier}`);
  };
  for (const statement of source.statements) {
    if (ts.isExportDeclaration(statement)) {
      if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) staticExports.push({ name: element.name.text, declarationKind: statement.moduleSpecifier ? "reexport" : "local-binding" });
      } else if (statement.exportClause && ts.isNamespaceExport(statement.exportClause)) staticExports.push({ name: statement.exportClause.name.text, declarationKind: "namespace-reexport" });
      else staticExports.push({ name: "*", declarationKind: "reexport" });
    } else if (ts.isExportAssignment(statement)) staticExports.push({ name: "default", declarationKind: "expression" });
    else if ((ts.isVariableStatement(statement) || ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) &&
      ts.getModifiers(statement)?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name)) staticExports.push({ name: declaration.name.text, declarationKind: "variable" });
          else reasons.add("JAVASCRIPT_EXPORTED_DESTRUCTURING_UNSUPPORTED");
        }
      } else if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) {
        const name = (ts.getCombinedModifierFlags(statement) & ts.ModifierFlags.Default) !== 0 ? "default" : statement.name?.text;
        if (name) staticExports.push({ name, declarationKind: ts.isFunctionDeclaration(statement) ? "function" : "class" });
      }
    }
  }
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      if (ts.isElementAccessExpression(node.expression) || ts.isCallExpression(node.expression)) reasons.add("JAVASCRIPT_DYNAMIC_CALL_UNSUPPORTED");
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        if (node.arguments.length !== 1 || !ts.isStringLiteral(node.arguments[0]!)) reasons.add("JAVASCRIPT_DYNAMIC_IMPORT_UNSUPPORTED");
        else {
          const specifier = (node.arguments[0] as ts.StringLiteral).text;
          recordModuleLink(specifier);
        }
      }
      if (ts.isIdentifier(node.expression) && node.expression.text === "require") reasons.add("JAVASCRIPT_COMMONJS_UNSUPPORTED");
      if (ts.isIdentifier(node.expression) && node.expression.text === "eval") reasons.add("JAVASCRIPT_DYNAMIC_EVALUATION_UNSUPPORTED");
    }
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Function") reasons.add("JAVASCRIPT_DYNAMIC_EVALUATION_UNSUPPORTED");
    if (ts.isWithStatement(node)) reasons.add("JAVASCRIPT_DYNAMIC_SCOPE_UNSUPPORTED");
    if (ts.isPropertyAccessExpression(node) &&
      ((ts.isIdentifier(node.expression) && node.expression.text === "module" && node.name.text === "exports") ||
       (ts.isIdentifier(node.expression) && node.expression.text === "exports"))) reasons.add("JAVASCRIPT_COMMONJS_UNSUPPORTED");
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const specifier = node.moduleSpecifier.text;
      recordModuleLink(specifier);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  for (const reason of inspectModuleConfiguration(path, repositoryRoot, compilerInputs)) reasons.add(reason);
  return { parseFailed: diagnostics.length > 0, reasons: [...reasons].sort(), staticExports: staticExports.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0), staticModuleLinks };
}

/** v2 runtime parsing guard for TS as well as JS; compiler recovery is not completed analysis. */
export function inspectSourceParsing(path: string, content: string): string[] {
  const kind = path.endsWith(".jsx") ? ts.ScriptKind.JSX : path.endsWith(".tsx") ? ts.ScriptKind.TSX : /\.(js|mjs|cjs)$/.test(path) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const source = ts.createSourceFile(path, content, ts.ScriptTarget.ES2022, true, kind);
  return ((source as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? []).map(diagnostic =>
    `SOURCE_PARSE_ERROR:${diagnostic.code}:${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`);
}

export function inspectModuleConfiguration(path: string, repositoryRoot?: string, compilerInputs?: CompilerInputSnapshot): string[] {
  const system = compilerInputs === undefined ? ts.sys : retainedCompilerSystem(compilerInputs);
  const configPath = ts.findConfigFile(dirname(path), candidate => system.fileExists(candidate));
  if (!configPath) return [];
  const contained = (candidate: string): boolean => {
    if (!repositoryRoot) return true;
    const relation = relative(repositoryRoot, candidate).replaceAll("\\", "/");
    return relation !== ".." && !relation.startsWith("../") && !isAbsolute(relation);
  };
  if (!contained(configPath)) return ["SOURCE_CONFIGURATION_OUTSIDE_REPOSITORY"];
  const config = ts.readConfigFile(configPath, candidate => system.readFile(candidate));
  let escaped = false;
  const parsed = config.error ? undefined : ts.parseJsonConfigFileContent(config.config, { ...system,
    readDirectory: () => [],
    readFile: candidate => {
      if (!contained(candidate)) { escaped = true; return undefined; }
      return system.readFile(candidate);
    },
  }, dirname(configPath));
  if (escaped) return ["SOURCE_CONFIGURATION_OUTSIDE_REPOSITORY"];
  const diagnostics = config.error ? [config.error] : parsed?.errors ?? [];
  const reasons = diagnostics.filter(diagnostic => diagnostic.code !== 18003).map(diagnostic =>
    `SOURCE_CONFIGURATION_INVALID:${diagnostic.code}:${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`);
  // The named snapshot profile qualifies ESNext/Bundler, including inherited options. Hashing
  // NodeNext bytes does not authorize analyzing them under overwritten Bundler semantics.
  if (compilerInputs !== undefined && parsed !== undefined) {
    if (parsed.options.module !== undefined && parsed.options.module !== ts.ModuleKind.ESNext) {
      reasons.push(`SOURCE_CONFIGURATION_MODULE_UNSUPPORTED:${ts.ModuleKind[parsed.options.module]}`);
    }
    if (parsed.options.moduleResolution !== undefined && parsed.options.moduleResolution !== ts.ModuleResolutionKind.Bundler) {
      reasons.push(`SOURCE_CONFIGURATION_RESOLUTION_UNSUPPORTED:${ts.ModuleResolutionKind[parsed.options.moduleResolution]}`);
    }
  }
  return reasons;
}
