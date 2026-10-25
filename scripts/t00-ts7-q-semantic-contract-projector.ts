import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { isBuiltin } from "node:module";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { createContractFacts, NativeFactsRequired, type NativeFactQuery } from "./t00-ts7-q-semantic-contract-facts";

type Site = { index: number; site: string; expression: string };
type Branch = { index: number; id: string };
export type ContractProjection = {
  status: "projected" | "unsupported";
  reasons: string[];
  queries?: NativeFactQuery[];
  gaps: string[];
  sites: (Site & { value: unknown })[];
  branches: (Branch & { outcome: boolean })[];
  helperResults: { index: number; arguments: unknown[]; value: unknown }[];
};
type Inventory = { sites: Site[]; branches: Branch[]; gaps: string[] };
type Row = { index: number; consumer: string; inputContract: { consumerPredicate: string }; source: { apiSites: { expression: string; line: number; column: number }[] } };
const rows = (JSON.parse(readFileSync(new URL("../docs/research/rust-ts-r0/qualification/suite-20261022/consumer-contracts.json", import.meta.url), "utf8")) as { rows: Row[] }).rows;
const normalize = (value: string): string => value.replace(/\s+/g, "");
const unavailable = (name: string): never => { throw new Error(`CONTRACT_EXTERNAL_UNAVAILABLE:${name}`); };
const ordinaryNativeProcessMembers = new Set(["argv", "cwd", "env", "execPath", "exit", "exitCode", "platform", "stderr", "stdout", "versions"]);

function compileContract(): { executable: string; inventory: Inventory } {
  const owner = rows.find(row => row.index === 49)!;
  const source = ts.createSourceFile("semantic-contract.ts", owner.inputContract.consumerPredicate, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const rowByName = new Map(rows.filter(row => row.index >= 50 && row.index <= 135).map(row => [row.consumer.split(" > ").at(-1)!, row]));
  const scopes = new Map<ts.Node, Row>();
  const scopeRoots = new Map<number, ts.Node>();
  const callbackPredicate = normalize(rows.find(row => row.index === 50)!.inputContract.consumerPredicate);
  const findScopes = (node: ts.Node): void => {
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
      const parent = node.parent;
      const row = ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name) ? rowByName.get(parent.name.text)
        : normalize(node.getText(source)) === callbackPredicate ? rows.find(row => row.index === 50) : undefined;
      if (row !== undefined) { scopes.set(node, row); scopeRoots.set(row.index, node); }
    }
    ts.forEachChild(node, findScopes);
  };
  findScopes(source);
  const ownerOf = (node: ts.Node): Row | undefined => {
    for (let parent: ts.Node | undefined = node; parent !== undefined; parent = parent.parent) {
      const row = scopes.get(parent);
      if (row !== undefined) return row;
    }
    return undefined;
  };
  const sites: Site[] = [];
  const gaps: string[] = [];
  const siteNodes = new Map<ts.Node, Site[]>();
  for (const row of rows.filter(row => row.index >= 50 && row.index <= 135)) {
    const root = scopeRoots.get(row.index);
    if (root === undefined) { gaps.push(`CONTRACT_HELPER_MISSING:${row.index}`); continue; }
    const candidates = new Map<string, ts.Node[]>();
    const collect = (node: ts.Node): void => {
      if (node !== root && scopes.has(node)) return;
      if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node) || ts.isIdentifier(node)) {
        const expression = normalize(node.getText(source));
        const matching = candidates.get(expression) ?? [];
        matching.push(node);
        candidates.set(expression, matching);
      }
      ts.forEachChild(node, collect);
    };
    collect(root);
    const sorted = row.source.apiSites.map((site, position) => ({ ...site, position })).sort((a, b) => a.line - b.line || a.column - b.column);
    for (const canonical of sorted) {
      const site = { index: row.index, site: `${row.index}:${canonical.position}`, expression: canonical.expression };
      sites.push(site);
      const match = candidates.get(normalize(canonical.expression))?.shift();
      if (match === undefined) { gaps.push(`CONTRACT_SITE_NOT_BOUND:${site.site}:${site.expression}`); continue; }
      const target = ts.isCallExpression(match.parent) && match.parent.expression === match ? match.parent : match;
      siteNodes.set(target, [...siteNodes.get(target) ?? [], site]);
    }
  }
  const branches: Branch[] = [];
  const branchNodes = new Map<ts.Node, Branch>();
  const collectBranches = (node: ts.Node): void => {
    const row = ownerOf(node);
    const condition = ts.isIfStatement(node) ? node.expression : ts.isConditionalExpression(node) ? node.condition
      : ts.isBinaryExpression(node) && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken].includes(node.operatorToken.kind) ? node.left : undefined;
    if (row !== undefined && condition !== undefined && !branchNodes.has(condition)) {
      const branch = { index: row.index, id: `${row.index}:branch:${condition.getStart(source) - scopeRoots.get(row.index)!.getStart(source)}:${condition.getEnd() - scopeRoots.get(row.index)!.getStart(source)}` };
      branchNodes.set(condition, branch);
      branches.push(branch);
    }
    ts.forEachChild(node, collectBranches);
  };
  collectBranches(source);
  const factory = ts.factory;
  const wrap = (name: string, args: ts.Expression[]): ts.CallExpression => factory.createCallExpression(factory.createIdentifier(name), undefined, args);
  const json = (value: unknown): ts.Expression => factory.createCallExpression(factory.createPropertyAccessExpression(factory.createIdentifier("JSON"), "parse"), undefined, [factory.createStringLiteral(JSON.stringify(value))]);
  const transformer: ts.TransformerFactory<ts.SourceFile> = context => root => {
    const visit: ts.Visitor = original => {
      let updated = ts.visitEachChild(original, visit, context);
      const scoped = scopes.get(original);
      if (scoped !== undefined && (ts.isArrowFunction(updated) || ts.isFunctionExpression(updated))) {
        updated = wrap("__helper", [factory.createNumericLiteral(scoped.index), updated]);
      }
      for (const site of siteNodes.get(original) ?? []) updated = wrap("__site", [json(site), updated as ts.Expression]);
      const branch = branchNodes.get(original);
      if (branch !== undefined) updated = wrap("__branch", [json(branch), updated as ts.Expression]);
      return updated;
    };
    return ts.visitNode(root, visit) as ts.SourceFile;
  };
  const dependencies = [221, 183, 189, 184, 215, 176, 197, 206, 209].map(index => rows.find(row => row.index === index)!.inputContract.consumerPredicate).join("\n");
  const transformed = ts.transform(source, [transformer]);
  const text = ts.createPrinter().printFile(transformed.transformed[0]!);
  transformed.dispose();
  const executable = ts.transpileModule(`const key = ${rows.find(row => row.index === 136)!.inputContract.consumerPredicate};\n${dependencies}\n${text}`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  return { executable, inventory: { sites, branches, gaps } };
}

let compiled: ReturnType<typeof compileContract> | undefined;
const contract = (): ReturnType<typeof compileContract> => compiled ??= compileContract();
export const contractProjectionInventory = (): Inventory => contract().inventory;

export function projectContract(oracle: unknown, path: string, files: Record<string, string>, ownership?: unknown): ContractProjection {
  const result: ContractProjection = { status: "unsupported", reasons: [], gaps: [], sites: [], branches: [], helperResults: [] };
  try {
    const facts = createContractFacts(oracle, path, files);
    const prepared = contract();
    if (prepared.inventory.gaps.length > 0) { result.gaps.push(...prepared.inventory.gaps); return result; }
    const globals: Record<string, unknown> = {
      ts: facts.ts,
      contexts: new Map(),
      extractionContext: { createProgram: () => facts.program },
      ownership: ownership === undefined
        ? { get: () => unavailable("ownership") }
        : new Map(ownership === null ? [] : [[facts.snapshot, ownership]]),
      dirname, relative, resolve, isBuiltin,
      symbolScopePath: (scope: string[], name: string) => [...scope, name].join("."),
      normalizePath: (file: string) => file.replaceAll("\\", "/"),
      existsSync: () => unavailable("existsSync"),
      snapshotSystem: (snapshot: Map<string, string>) => ({
        fileExists: (file: string) => {
          const normalized = file.replaceAll("\\", "/");
          if (normalized.startsWith("/sdk/")) return unavailable("snapshotSystem-sdk-fileExists");
          const sensitive = (facts.ts["sys"] as { useCaseSensitiveFileNames: boolean }).useCaseSensitiveFileNames;
          return [...snapshot.keys()].some(key => sensitive ? key === normalized : key.toLowerCase() === normalized.toLowerCase());
        },
      }),
      isOrdinaryNativeProcessMember: (name: string) => ordinaryNativeProcessMembers.has(name),
      __site: (site: Site, value: unknown) => { result.sites.push({ ...site, value: facts.describe(value) }); return value; },
      __branch: (branch: Branch, value: unknown) => { result.branches.push({ ...branch, outcome: Boolean(value) }); return value; },
      __helper: (index: number, fn: (...args: unknown[]) => unknown) => (...args: unknown[]) => {
        const argumentsBeforeCall = args.map(facts.describe);
        const value = fn(...args);
        result.helperResults.push({ index, arguments: argumentsBeforeCall, value: facts.describe(value) });
        return value;
      },
    };
    const exports: Record<string, unknown> = {};
    runInNewContext(prepared.executable, { exports, ...globals });
    const inspect = exports["inspectSemanticDependencies"] as (source: unknown, snapshot: unknown, path: string) => unknown;
    const reasons = inspect(facts.source, facts.snapshot, path.startsWith("/") ? path : `/project/${path}`);
    if (!Array.isArray(reasons) || !reasons.every(reason => typeof reason === "string")) throw new Error("CONTRACT_REASON_RESULT_INVALID");
    result.reasons = reasons;
    result.status = "projected";
  } catch (error) {
    result.gaps.push(error instanceof Error ? error.message : String(error));
    if (error instanceof NativeFactsRequired) result.queries = error.queries;
  }
  return result;
}
