import ts from "typescript";
import { dirname, relative, isAbsolute, join } from "node:path";
import { builtinModules } from "node:module";
import { resolveTypeScriptModule, retainedCompilerSystem, type CompilerInputSnapshot } from "./ts-symbols";

const BUILTIN_MODULES = new Set(builtinModules.map(name => name.replace(/^node:/, "")));

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
  const diagnostics = config.error ? [config.error] : ts.parseJsonConfigFileContent(config.config, { ...system,
    readDirectory: () => [],
    readFile: candidate => {
      if (!contained(candidate)) { escaped = true; return undefined; }
      return system.readFile(candidate);
    },
  }, dirname(configPath)).errors;
  if (escaped) return ["SOURCE_CONFIGURATION_OUTSIDE_REPOSITORY"];
  return diagnostics.filter(diagnostic => diagnostic.code !== 18003).map(diagnostic =>
    `SOURCE_CONFIGURATION_INVALID:${diagnostic.code}:${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`);
}
