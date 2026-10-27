import ts from "typescript";
import type { ProducerIdentity } from "@semantic-context/plane-a-internal";
import type { DiscoveredFile } from "./discovery";
import { extractTypeScript, extractTypeScriptParallel, retainedCompilerSystem, TYPESCRIPT_DIALECT_VERSION, type CompilerInputSnapshot } from "./ts-symbols";
import { inspectJavaScriptSource } from "./javascript-diagnostics";
import { registerOpaqueCallbackOwnership } from "./semantic-dependency-diagnostics";

type CompilerLanguage = "typescript" | "javascript";

export interface TypeScriptAnalysisCompiler {
  producerIdentity(language: CompilerLanguage): ProducerIdentity;
  readonly dialectVersion: string;
  resolutionSemantics(language: CompilerLanguage): string;
  extract: typeof extractTypeScript;
  extractParallel: typeof extractTypeScriptParallel;
  dynamicTestImports(files: readonly DiscoveredFile[], snapshot: CompilerInputSnapshot): ReadonlySet<string>;
  registerOpaqueCallbackOwnership: typeof registerOpaqueCallbackOwnership;
  readRetained(snapshot: CompilerInputSnapshot, path: string): string | undefined;
  inspectJavaScriptSource: typeof inspectJavaScriptSource;
}

export type AnalysisCompiler = TypeScriptAnalysisCompiler;

const TYPESCRIPT_PRODUCER: ProducerIdentity = {
  identity: "@semantic-context/ts-analyzer",
  version: "0.1.0",
};
const JAVASCRIPT_PRODUCER: ProducerIdentity = {
  identity: "@semantic-context/ts-analyzer/javascript",
  version: "0.1.0",
};

export const legacyTypeScriptAnalysisCompiler: TypeScriptAnalysisCompiler = {
  producerIdentity: language => language === "javascript" ? JAVASCRIPT_PRODUCER : TYPESCRIPT_PRODUCER,
  dialectVersion: TYPESCRIPT_DIALECT_VERSION,
  resolutionSemantics: language => language === "javascript" ? "javascript-static-esm-v1" : "typescript-static-v1",
  extract: extractTypeScript,
  extractParallel: extractTypeScriptParallel,
  dynamicTestImports: (files, snapshot) => {
    const imports = new Set<string>();
    for (const file of files.filter(file => file.role === "test")) {
      const text = snapshot.get(file.absPath);
      if (text === undefined) continue;
      const source = ts.createSourceFile(file.absPath, text, ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments.length === 1
          && ts.isStringLiteral(node.arguments[0]!)) imports.add(`${file.relPath}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}:${node.arguments[0]!.text}`);
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    return imports;
  },
  registerOpaqueCallbackOwnership,
  readRetained: (snapshot, path) => retainedCompilerSystem(snapshot).readFile(path),
  inspectJavaScriptSource,
};
