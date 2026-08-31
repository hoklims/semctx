import { describe, expect, it } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import ts from "typescript";

const SRC_DIR = join(import.meta.dir, "..", "src");
const CONTROL_MODEL_PACKAGE = "@semantic-context/control-model";
const RUNTIME_SOURCE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs",
]);
const RESTRICTED_GLOBAL_LABELS = new Map<string, string>([
  ["require", "CommonJS require"],
  ["module", "CommonJS module"],
  ["global", "global host access"],
  ["globalThis", "globalThis host access"],
  ["self", "self host access"],
  ["window", "window host access"],
  ["process", "process"],
  ["Bun", "Bun host API"],
  ["Deno", "Deno host API"],
  ["fetch", "fetch"],
  ["WebSocket", "WebSocket"],
  ["Worker", "Worker"],
  ["SharedWorker", "SharedWorker"],
  ["performance", "ambient clock"],
  ["Temporal", "ambient clock"],
  ["Intl", "ambient locale or clock"],
  ["crypto", "ambient entropy"],
  ["eval", "dynamic code evaluation"],
  ["Function", "dynamic code evaluation"],
]);
const ALLOWED_DETERMINISTIC_STATIC_MEMBERS = new Map<string, ReadonlySet<string>>([
  ["Date", new Set(["parse"])],
  ["Math", new Set(["min"])],
]);
const RESTRICTED_STATIC_ROOT_LABELS = new Map<string, string>([
  ["Date", "ambient clock"],
  ["Math", "ambient entropy"],
]);

/**
 * The verifier is a second, independent implementation, not a wrapper around the engine that
 * produced a capsule. Every runtime source import must therefore be internal or come from the one
 * allowed package, and runtime code may not reach process/filesystem/network APIs through globals.
 */
interface RuntimeSourceTree {
  files: readonly string[];
  unsafePaths: readonly string[];
}

function isPathContained(root: string, target: string): boolean {
  const relativeTarget = relative(root, target);
  return relativeTarget === ""
    || (!isAbsolute(relativeTarget) && relativeTarget !== ".." && !relativeTarget.startsWith(`..${sep}`));
}

function inspectRuntimeSourceTree(rootDir: string): RuntimeSourceTree {
  const files: string[] = [];
  const unsafePaths: string[] = [];
  const canonicalRoot = realpathSync(rootDir);
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        unsafePaths.push(full);
        continue;
      }
      const canonicalEntry = realpathSync(full);
      if (!isPathContained(canonicalRoot, canonicalEntry)) {
        unsafePaths.push(full);
        continue;
      }
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile() && RUNTIME_SOURCE_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
        files.push(full);
      } else if (!entry.isFile()) {
        unsafePaths.push(full);
      }
    }
  };
  visit(rootDir);
  return { files, unsafePaths };
}

function listRuntimeSourceFilesRecursive(rootDir: string): readonly string[] {
  return inspectRuntimeSourceTree(rootDir).files;
}

interface ArchitectureViolation {
  file: string;
  kind: "import" | "restricted-global" | "unsafe-path";
  detail: string;
}

function loaderFor(file: string): "ts" | "tsx" | "js" | "jsx" {
  const extension = extname(file).toLowerCase();
  if (extension === ".tsx") return "tsx";
  if (extension === ".jsx") return "jsx";
  if (extension === ".ts" || extension === ".mts" || extension === ".cts") return "ts";
  return "js";
}

function isInside(rootDir: string, target: string): boolean {
  const lexicalRoot = resolve(rootDir);
  const lexicalTarget = resolve(target);
  if (!isPathContained(lexicalRoot, lexicalTarget)) return false;
  try {
    return isPathContained(realpathSync(lexicalRoot), realpathSync(dirname(lexicalTarget)));
  } catch {
    return false;
  }
}

function isAllowedImport(specifier: string, importingFile: string, rootDir: string): boolean {
  if (specifier === CONTROL_MODEL_PACKAGE || specifier.startsWith(`${CONTROL_MODEL_PACKAGE}/`)) {
    return true;
  }
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) return false;
  return isInside(rootDir, resolve(dirname(importingFile), specifier));
}

function isPropertyNameOnly(identifier: ts.Identifier): boolean {
  const parent = identifier.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.name === identifier) return true;
  if (ts.isBindingElement(parent) && parent.propertyName === identifier) return true;
  return (
    ts.isPropertyAssignment(parent)
    || ts.isMethodDeclaration(parent)
    || ts.isGetAccessorDeclaration(parent)
    || ts.isSetAccessorDeclaration(parent)
    || ts.isPropertyDeclaration(parent)
    || ts.isEnumMember(parent)
  ) && parent.name === identifier;
}

/** Parse executable JavaScript, then distinguish unbound host globals from strings and locals. */
function findRestrictedRuntimeReferences(runtimeContent: string, sourcePath: string): readonly string[] {
  const fileName = `${resolve(sourcePath)}.architecture-runtime.js`;
  const sourceFile = ts.createSourceFile(
    fileName,
    runtimeContent,
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.JS,
  );

  type ScopeKind = "source" | "function" | "block" | "loop" | "catch" | "class";
  interface LexicalScope {
    bindings: Set<string>;
    kind: ScopeKind;
    parent: LexicalScope | null;
  }

  const sourceScope: LexicalScope = { bindings: new Set(), kind: "source", parent: null };
  const scopeByNode = new WeakMap<ts.Node, LexicalScope>();
  const addBindingName = (scope: LexicalScope, name: ts.BindingName): void => {
    if (ts.isIdentifier(name)) {
      scope.bindings.add(name.text);
      return;
    }
    for (const element of name.elements) {
      if (ts.isBindingElement(element)) addBindingName(scope, element.name);
    }
  };
  const functionOrSourceScope = (scope: LexicalScope): LexicalScope => {
    let current: LexicalScope | null = scope;
    while (current !== null && current.kind !== "function" && current.kind !== "source") {
      current = current.parent;
    }
    return current ?? sourceScope;
  };
  const childScope = (kind: ScopeKind, parent: LexicalScope): LexicalScope => ({
    bindings: new Set(),
    kind,
    parent,
  });

  const collectScopes = (node: ts.Node, incomingScope: LexicalScope): void => {
    let scope = incomingScope;

    if (ts.isFunctionDeclaration(node) && node.name !== undefined) {
      incomingScope.bindings.add(node.name.text);
    }
    if (ts.isClassDeclaration(node) && node.name !== undefined) {
      incomingScope.bindings.add(node.name.text);
    }

    if (ts.isFunctionLike(node)) {
      scope = childScope("function", incomingScope);
      if (ts.isFunctionExpression(node) && node.name !== undefined) scope.bindings.add(node.name.text);
      for (const parameter of node.parameters) addBindingName(scope, parameter.name);
    } else if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      scope = childScope("class", incomingScope);
      if (node.name !== undefined) scope.bindings.add(node.name.text);
    } else if (
      ts.isForStatement(node)
      || ts.isForInStatement(node)
      || ts.isForOfStatement(node)
    ) {
      scope = childScope("loop", incomingScope);
    } else if (ts.isCatchClause(node)) {
      scope = childScope("catch", incomingScope);
      if (node.variableDeclaration !== undefined) addBindingName(scope, node.variableDeclaration.name);
    } else if (ts.isBlock(node) || ts.isCaseBlock(node)) {
      scope = childScope("block", incomingScope);
    }

    scopeByNode.set(node, scope);

    if (ts.isVariableDeclaration(node)) {
      const declarationList = ts.isVariableDeclarationList(node.parent) ? node.parent : undefined;
      const isBlockScoped = declarationList !== undefined
        && (declarationList.flags & ts.NodeFlags.BlockScoped) !== 0;
      addBindingName(isBlockScoped ? scope : functionOrSourceScope(scope), node.name);
    }
    if (ts.isImportEqualsDeclaration(node)) scope.bindings.add(node.name.text);
    if (ts.isImportClause(node) && node.name !== undefined) scope.bindings.add(node.name.text);
    if (ts.isNamespaceImport(node) || ts.isImportSpecifier(node)) scope.bindings.add(node.name.text);

    ts.forEachChild(node, (child) => collectScopes(child, scope));
  };
  collectScopes(sourceFile, sourceScope);

  const isLocallyBound = (identifier: ts.Identifier): boolean => {
    let scope: LexicalScope | null = scopeByNode.get(identifier) ?? sourceScope;
    while (scope !== null) {
      if (scope.bindings.has(identifier.text)) return true;
      scope = scope.parent;
    }
    return false;
  };
  const isUnboundGlobalThis = (node: ts.Expression): boolean => (
    ts.isIdentifier(node) && node.text === "globalThis" && !isLocallyBound(node)
  );
  const allowedStaticMember = (identifier: ts.Identifier): boolean => {
    const allowed = ALLOWED_DETERMINISTIC_STATIC_MEMBERS.get(identifier.text);
    if (allowed === undefined) return false;
    const parent = identifier.parent;
    if (ts.isPropertyAccessExpression(parent) && parent.expression === identifier) {
      return allowed.has(parent.name.text);
    }
    return ts.isElementAccessExpression(parent)
      && parent.expression === identifier
      && parent.argumentExpression !== undefined
      && ts.isStringLiteralLike(parent.argumentExpression)
      && allowed.has(parent.argumentExpression.text);
  };
  const labels = new Set<string>();

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node)
      && node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      labels.add("dynamic import");
    }
    if (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword) {
      labels.add("import.meta host access");
    }
    if (
      (ts.isPropertyAccessExpression(node) && node.name.text === "constructor")
      || (
        ts.isElementAccessExpression(node)
        && node.argumentExpression !== undefined
        && ts.isStringLiteralLike(node.argumentExpression)
        && node.argumentExpression.text === "constructor"
      )
    ) {
      labels.add("dynamic code evaluation");
    }
    if (ts.isPropertyAccessExpression(node) && isUnboundGlobalThis(node.expression)) {
      const label = RESTRICTED_GLOBAL_LABELS.get(node.name.text);
      if (label !== undefined) labels.add(label);
    }
    if (
      ts.isElementAccessExpression(node)
      && isUnboundGlobalThis(node.expression)
      && node.argumentExpression !== undefined
      && ts.isStringLiteralLike(node.argumentExpression)
    ) {
      const label = RESTRICTED_GLOBAL_LABELS.get(node.argumentExpression.text);
      if (label !== undefined) labels.add(label);
    }
    if (
      ts.isIdentifier(node)
      && RESTRICTED_GLOBAL_LABELS.has(node.text)
      && !isPropertyNameOnly(node)
      && !isLocallyBound(node)
    ) {
      labels.add(RESTRICTED_GLOBAL_LABELS.get(node.text) ?? node.text);
    }
    if (
      ts.isIdentifier(node)
      && RESTRICTED_STATIC_ROOT_LABELS.has(node.text)
      && !isPropertyNameOnly(node)
      && !isLocallyBound(node)
      && !allowedStaticMember(node)
    ) {
      labels.add(RESTRICTED_STATIC_ROOT_LABELS.get(node.text) ?? node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return [...labels];
}

function findArchitectureViolations(rootDir: string): readonly ArchitectureViolation[] {
  const violations: ArchitectureViolation[] = [];
  const tree = inspectRuntimeSourceTree(rootDir);
  for (const unsafePath of tree.unsafePaths) {
    violations.push({ file: unsafePath, kind: "unsafe-path", detail: "symbolic link or reparse escape" });
  }
  for (const file of tree.files) {
    const content = readFileSync(file, "utf8");
    const transpiler = new Bun.Transpiler({ loader: loaderFor(file) });
    for (const imported of transpiler.scan(content).imports) {
      if (!isAllowedImport(imported.path, file, rootDir)) {
        violations.push({ file, kind: "import", detail: imported.path });
      }
    }
    const runtimeContent = transpiler.transformSync(content);
    for (const label of findRestrictedRuntimeReferences(runtimeContent, file)) {
      violations.push({ file, kind: "restricted-global", detail: label });
    }
  }
  return violations;
}

describe("change-authorization-verifier architecture boundary", () => {
  it("scans every supported runtime source extension recursively", () => {
    expect(listRuntimeSourceFilesRecursive(SRC_DIR).length).toBeGreaterThan(0);
  });

  it("allows only internal/control-model imports and no host I/O, ambient clock, or entropy", () => {
    expect(findArchitectureViolations(SRC_DIR)).toEqual([]);
  });

  it("declares only @semantic-context/control-model as a runtime dependency", () => {
    const packageJson = JSON.parse(
      readFileSync(join(import.meta.dir, "..", "package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };
    expect(Object.keys(packageJson.dependencies ?? {})).toEqual([CONTROL_MODEL_PACKAGE]);
  });

  it("mutation witness: the same oracle detects imports, host globals, ambient inputs, and path escapes", () => {
    const witnessRoot = mkdtempSync(join(tmpdir(), "semctx-verifier-architecture-witness-"));
    const outsideRoot = mkdtempSync(join(tmpdir(), "semctx-verifier-architecture-outside-"));
    try {
      const nestedDir = join(witnessRoot, "nested", "deeper");
      mkdirSync(nestedDir, { recursive: true });
      writeFileSync(
        join(witnessRoot, "clean.ts"),
        'import type { Sha256Hash } from "@semantic-context/control-model";\nexport type { Sha256Hash };\n',
        "utf8",
      );
      writeFileSync(
        join(witnessRoot, "clean-globals.js"),
        `// fetch(), new Worker(), and new SharedWorker() are inert in comments and strings.\n`
          + `export const labels = ["fetch()", "new Worker(", "new SharedWorker(", "import.meta"];\n`
          + `export const deterministic = [Date.parse("2026-08-30T00:00:00Z"), Math.min(1, 2)];\n`
          + `export function useLocal(fetch, Worker, SharedWorker, WebSocket, process, require, module, globalThis, global, self, window, Bun, Deno, Function, Date, Math, performance, Temporal, Intl, crypto) {\n`
          + `  fetch(); new Worker(); new SharedWorker(); new WebSocket(); require(); module.require();\n`
          + `  Date.now(); Math.random(); performance.now(); Temporal.Now.instant(); Intl.DateTimeFormat(); crypto.randomUUID();\n`
          + `  self.Date.now(); window.Date.now();\n`
          + `  global.fetch(); Bun.file(); Deno.readTextFile(); return new Function(globalThis.fetch(process.cwd()));\n}\n`
          + `export function useDeclaredBindings(host) {\n`
          + `  const globalThis = { fetch() {} }; globalThis.fetch();\n`
          + `  { const { require, globalThis } = host; require(); globalThis.fetch(); }\n}\n`,
        "utf8",
      );
      writeFileSync(
        join(nestedDir, "engine-violation.ts"),
        'import { evaluateChangeAuthorizationV1 } from "@semantic-context/control-engine";\nexport { evaluateChangeAuthorizationV1 };\n',
        "utf8",
      );
      writeFileSync(
        join(nestedDir, "builtin-violation.mjs"),
        'import { readFile } from "node:fs";\nexport { readFile };\n',
        "utf8",
      );
      writeFileSync(
        join(nestedDir, "dynamic-violation.tsx"),
        'export async function load() {\n  return import("@semantic-context/app-services");\n}\n',
        "utf8",
      );
      writeFileSync(
        join(nestedDir, "require-violation.cjs"),
        'module.exports = require("child_process");\n',
        "utf8",
      );
      writeFileSync(
        join(nestedDir, "process-violation.js"),
        'export const cwd = process.cwd();\n',
        "utf8",
      );
      writeFileSync(
        join(nestedDir, "relative-escape.ts"),
        'import { evaluateChangeAuthorizationV1 } from "../../../control-engine/src/change-authorization-policy";\nexport { evaluateChangeAuthorizationV1 };\n',
        "utf8",
      );
      writeFileSync(
        join(nestedDir, "computed-fetch.js"),
        'export const request = globalThis["fetch"]("https://example.invalid");\n',
        "utf8",
      );
      writeFileSync(
        join(nestedDir, "worker-violation.js"),
        'export const worker = new Worker("worker.js");\nexport const shared = new SharedWorker("shared.js");\n',
        "utf8",
      );
      writeFileSync(
        join(nestedDir, "host-alias-violation.cjs"),
        'const load = require;\nload("node:fs");\nrequire.resolve("node:path");\nmodule.require("node:fs");\nconst nodeRoot = global;\nnodeRoot.fetch("https://example.invalid");\nconst host = globalThis;\nhost.fetch("https://example.invalid");\nconst { fetch: request } = globalThis;\nrequest("https://example.invalid");\nBun.file("secret");\nDeno.readTextFile("secret");\nnew WebSocket("wss://example.invalid");\neval("0");\nnew Function("return 0");\n',
        "utf8",
      );
      writeFileSync(
        join(nestedDir, "import-meta-violation.mjs"),
        'export const url = import.meta.url;\n',
        "utf8",
      );
      const ambientInputMutants = [
        ["date-now-violation.js", "export const now = Date.now();\n", "ambient clock"],
        ["date-alias-violation.js", "const Clock = Date;\nexport const now = Clock.now();\n", "ambient clock"],
        ["performance-violation.js", "export const now = performance.now();\n", "ambient clock"],
        ["temporal-violation.js", "export const now = Temporal.Now.instant();\n", "ambient clock"],
        ["intl-violation.js", "export const now = new Intl.DateTimeFormat().format();\n", "ambient locale or clock"],
        ["self-violation.js", "export const now = self.Date.now();\n", "self host access"],
        ["window-violation.js", "export const now = window.Date.now();\n", "window host access"],
        ["math-random-violation.js", "export const random = Math.random();\n", "ambient entropy"],
        ["crypto-violation.js", "export const random = crypto.randomUUID();\n", "ambient entropy"],
        ["constructor-violation.js", "export const run = Date.parse.constructor(\"return Date.now()\");\n", "dynamic code evaluation"],
      ] as const;
      for (const [file, content] of ambientInputMutants) {
        writeFileSync(join(nestedDir, file), content, "utf8");
      }

      const linkedDir = join(witnessRoot, "linked-runtime");
      writeFileSync(join(outsideRoot, "outside.js"), "export const outside = true;\n", "utf8");
      symlinkSync(outsideRoot, linkedDir, process.platform === "win32" ? "junction" : "dir");
      writeFileSync(
        join(witnessRoot, "linked-import.js"),
        'import { outside } from "./linked-runtime/outside.js";\nexport { outside };\n',
        "utf8",
      );

      const violations = findArchitectureViolations(witnessRoot);
      expect(violations).toContainEqual({
        file: join(nestedDir, "engine-violation.ts"),
        kind: "import",
        detail: "@semantic-context/control-engine",
      });
      expect(violations).toContainEqual({
        file: join(nestedDir, "builtin-violation.mjs"),
        kind: "import",
        detail: "node:fs",
      });
      expect(violations).toContainEqual({
        file: join(nestedDir, "dynamic-violation.tsx"),
        kind: "restricted-global",
        detail: "dynamic import",
      });
      expect(violations).toContainEqual({
        file: join(nestedDir, "require-violation.cjs"),
        kind: "restricted-global",
        detail: "CommonJS require",
      });
      expect(violations).toContainEqual({
        file: join(nestedDir, "process-violation.js"),
        kind: "restricted-global",
        detail: "process",
      });
      expect(violations).toContainEqual({
        file: join(nestedDir, "relative-escape.ts"),
        kind: "import",
        detail: "../../../control-engine/src/change-authorization-policy",
      });
      expect(violations).toContainEqual({
        file: join(nestedDir, "computed-fetch.js"),
        kind: "restricted-global",
        detail: "fetch",
      });
      expect(violations).toContainEqual({
        file: join(nestedDir, "worker-violation.js"),
        kind: "restricted-global",
        detail: "Worker",
      });
      expect(violations).toContainEqual({
        file: join(nestedDir, "worker-violation.js"),
        kind: "restricted-global",
        detail: "SharedWorker",
      });
      expect(violations).toContainEqual({
        file: join(nestedDir, "host-alias-violation.cjs"),
        kind: "restricted-global",
        detail: "CommonJS require",
      });
      expect(violations).toContainEqual({
        file: join(nestedDir, "host-alias-violation.cjs"),
        kind: "restricted-global",
        detail: "globalThis host access",
      });
      for (const detail of [
        "global host access",
        "Bun host API",
        "Deno host API",
        "WebSocket",
        "dynamic code evaluation",
      ]) {
        expect(violations).toContainEqual({
          file: join(nestedDir, "host-alias-violation.cjs"),
          kind: "restricted-global",
          detail,
        });
      }
      expect(violations).toContainEqual({
        file: join(nestedDir, "import-meta-violation.mjs"),
        kind: "restricted-global",
        detail: "import.meta host access",
      });
      for (const [file, _content, detail] of ambientInputMutants) {
        expect(violations).toContainEqual({
          file: join(nestedDir, file),
          kind: "restricted-global",
          detail,
        });
      }
      expect(violations).toContainEqual({
        file: linkedDir,
        kind: "unsafe-path",
        detail: "symbolic link or reparse escape",
      });
      expect(violations).toContainEqual({
        file: join(witnessRoot, "linked-import.js"),
        kind: "import",
        detail: "./linked-runtime/outside.js",
      });
      expect(violations.some((violation) => violation.file === join(witnessRoot, "clean.ts"))).toBe(false);
      expect(violations.some((violation) => violation.file === join(witnessRoot, "clean-globals.js"))).toBe(false);
    } finally {
      rmSync(witnessRoot, { recursive: true, force: true });
      rmSync(outsideRoot, { recursive: true, force: true });
    }
  });
});
