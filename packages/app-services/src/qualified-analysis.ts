import type { AnalysisAdmission, RepositoryGraph, SemctxConfig } from "@semantic-context/core";
import { digestCanonical } from "@semantic-context/plane-a-internal";
import { discoverRepository, extractTypeScript, inspectSourceParsing, inspectModuleConfiguration } from "@semantic-context/ts-analyzer";
import type { IndexHealthReportV1 } from "./index-health";
import { QUALIFIED_ANALYZER_IDENTITY } from "./analyzer-identity.generated";
import { isBuiltin } from "node:module";
import ts from "typescript";
import { evaluateAnalysisAdmission } from "@semantic-context/context-engine";
import { captureQualifiedAnalysisInputs } from "./freshness";
import { dirname, resolve } from "node:path";

export const QUALIFIED_BUILD_META = "qualified_analysis_build_v1";
export function isQualified(config: SemctxConfig): boolean {
  return config.version === 2 && config.selectionMode === "qualified-static-v1" && config.analysisProfile === "modelo-suite-static-v1";
}
export function qualifiedAdmission(input: {
  config: SemctxConfig; graph: RepositoryGraph; changedPaths: readonly string[];
  health: IndexHealthReportV1; sourceHash: string; diff: string; indexSnapshot: string;
  bindingReasons: string[]; checkChanged: boolean; buildState: string | undefined;
  sourceCommits: string[]; baseCommit: string | null;
  expectedInputHash: string;
}): AnalysisAdmission {
  const { config, health } = input;
  const evaluationsByCandidate = new Map<string, typeof health.evaluations.decisions>();
  for (const decision of health.evaluations.decisions) {
    const group = evaluationsByCandidate.get(decision.candidateIdentity) ?? [];
    evaluationsByCandidate.set(decision.candidateIdentity, [...group, decision]);
  }
  // Re-discover outside configured selectors: an excluded importer must not vanish from closure.
  const broad = discoverRepository({ ...config, version: 2, selectionMode: "globs-v1", include: ["**/*"], exclude: [], languages: {
    typescript: "on", javascript: "on", python: "on", markdown: "on", sql: "on",
  } });
  const links: [string, string][] = [];
  const consumed = captureQualifiedAnalysisInputs(config);
  const sourceFiles = consumed.files.filter((file) => /\.[cm]?[jt]sx?$/.test(file.path)).map((file) => ({ relPath: file.path, absPath: resolve(config.repositoryRoot, file.path), content: Buffer.from(file.bytes).toString("utf8") }));
  const compilerInputs = new Map(consumed.files.map((file) => [resolve(config.repositoryRoot, file.path), Buffer.from(file.bytes).toString("utf8")]));
  const workspaceNames = new Set<string>();
  const externalPackages = new Map<string, Set<string>>();
  const aliases: string[] = [];
  for (const file of consumed.files.filter((entry) => /(?:^|\/)package\.json$/.test(entry.path) || /(?:^|\/)tsconfig[^/]*\.json$/.test(entry.path))) {
    const parsed = ts.parseConfigFileTextToJson(file.path, Buffer.from(file.bytes).toString("utf8"));
    if (parsed.error !== undefined) continue; // The retained configuration inspection reports errors.
    const manifest = parsed.config as { name?: unknown; dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown>; peerDependencies?: Record<string, unknown>; compilerOptions?: { paths?: Record<string, unknown> } };
    if (manifest === null || typeof manifest !== "object") continue;
    if (file.path.endsWith("package.json") && typeof manifest.name === "string") workspaceNames.add(manifest.name);
    const declared = new Set<string>();
    for (const [name, version] of Object.entries({ ...manifest.dependencies, ...manifest.devDependencies, ...manifest.peerDependencies })) {
      if (typeof version === "string" && !/^(?:workspace:|file:|link:)/.test(version)) declared.add(name);
    }
    if (file.path.endsWith("package.json")) externalPackages.set(dirname(resolve(config.repositoryRoot, file.path)), declared);
    aliases.push(...Object.keys(manifest.compilerOptions?.paths ?? {}));
  }
  const isExternal = (specifier: string, from: string): boolean => {
    if (isBuiltin(specifier)) return true;
    if (specifier.startsWith(".") || specifier.startsWith("/") || aliases.some((alias) => new Bun.Glob(alias).match(specifier))) return false;
    const name = specifier.split("/").slice(0, specifier.startsWith("@") ? 2 : 1).join("/");
    if (workspaceNames.has(name)) return false;
    let directory = dirname(resolve(config.repositoryRoot, from));
    for (;;) {
      if (externalPackages.get(directory)?.has(name)) return true;
      if (directory === resolve(config.repositoryRoot) || dirname(directory) === directory) return false;
      directory = dirname(directory);
    }
  };
  const extraction = extractTypeScript(sourceFiles.map((file) => file.absPath), config.repositoryRoot, compilerInputs);
  for (const entry of extraction.imports) if (entry.resolvedRelPath !== undefined) links.push([entry.fromRelPath, entry.resolvedRelPath]);
  const byId = new Map(input.graph.nodes.map((node) => [node.id, node.filePath]));
  for (const edge of input.graph.edges) {
    if (!["imports", "exports", "calls", "depends_on"].includes(edge.kind)) continue;
    const from = byId.get(edge.from); const to = byId.get(edge.to);
    if (from !== undefined && to !== undefined) links.push([from, to]);
  }
  const reasons: string[] = [];
  if (consumed.digest !== input.expectedInputHash) reasons.push("DEPENDENCY_SCOPE_INPUT_CHANGED");
  for (const entry of extraction.imports) {
    if (entry.resolvedRelPath === undefined && !isExternal(entry.moduleSpecifier, entry.fromRelPath)) {
      reasons.push(`DEPENDENCY_SCOPE_UNRESOLVED_IMPORT:${entry.fromRelPath}:${entry.moduleSpecifier}`);
    }
  }
  // An excluded or failed importer can hide a required inbound edge. Scope discovery itself
  // therefore needs syntactically inspectable files and literal dependency specifiers.
  for (const candidate of broad.candidates) {
    if (candidate.reason === "READ_FAILED" || candidate.reason.endsWith("OUTSIDE_REPOSITORY")) reasons.push(`DEPENDENCY_SCOPE_UNREADABLE:${candidate.relPath}`);
  }
  for (const source of sourceFiles) {
    const ast = ts.createSourceFile(source.relPath, source.content, ts.ScriptTarget.Latest, true);
    for (const diagnostic of inspectSourceParsing(source.relPath, source.content)) reasons.push(`DEPENDENCY_SCOPE_PARSE_FAILED:${source.relPath}:${diagnostic}`);
    for (const diagnostic of inspectModuleConfiguration(source.absPath, config.repositoryRoot, compilerInputs)) reasons.push(`DEPENDENCY_SCOPE_CONFIGURATION:${source.relPath}:${diagnostic}`);
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const dynamic = node.expression.kind === ts.SyntaxKind.ImportKeyword;
        const requireCall = ts.isIdentifier(node.expression) && node.expression.text === "require";
        if ((dynamic || requireCall) && (node.arguments.length !== 1 || !ts.isStringLiteral(node.arguments[0]!))) reasons.push(`DEPENDENCY_SCOPE_COMPUTED_IMPORT:${source.relPath}`);
        if (ts.isIdentifier(node.expression) && ["eval", "Function"].includes(node.expression.text)) reasons.push(`DEPENDENCY_SCOPE_RUNTIME_CODE:${source.relPath}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
  }
  const admission = evaluateAnalysisAdmission({
    changedPaths: input.changedPaths, links, candidates: health.candidates.map((candidate) => {
      const evaluations = evaluationsByCandidate.get(candidate.candidateIdentity) ?? [];
      return { ...candidate, admissible: evaluations.length > 0 && evaluations.every((decision) => decision.decisionKind !== "pre_subject"
        && [decision.gates.discoveryAndScope, decision.gates.bindingAndIntegrity, decision.gates.currentFreshness, decision.gates.capabilityMatch, decision.gates.taskRelativeAuthority].every((gate) => gate === "passed")) };
    }),
    current: discoverRepository(config).candidates.map((candidate) => ({ path: candidate.relPath, selectionDecision: candidate.selectionDecision, reason: candidate.reason })),
    unresolvedImports: extraction.imports.filter((entry) => entry.resolvedRelPath === undefined && !isExternal(entry.moduleSpecifier, entry.fromRelPath)).map((entry) => ({ path: entry.fromRelPath, specifier: entry.moduleSpecifier })),
    scopeReasons: reasons, bindingReasons: input.bindingReasons, bindingStatus: health.binding.status,
    canRunHighRiskControl: health.freshness.canRunHighRiskControl, freshnessReasons: health.freshness.reasons,
    buildComplete: input.buildState === "complete", checkChanged: input.checkChanged, repositoryCoverageStatus: health.coverage.status,
  });
  return {
    schemaVersion: 1, profile: "modelo-suite-static-v1", ...admission,
    identity: { source: input.sourceHash, sourceCommits: input.sourceCommits, baseCommit: input.baseCommit, diff: digestCanonical(input.diff), config: digestCanonical(config), analyzer: QUALIFIED_ANALYZER_IDENTITY, indexSnapshot: input.indexSnapshot },
    binding: { status: input.bindingReasons.length > 0 ? "invalid" : health.binding.status, reasons: input.bindingReasons },
    indexFreshness: { verdict: health.freshness.verdict, reasons: health.freshness.reasons },
    controlFreshness: { verdict: health.freshness.verdict, reasons: health.freshness.reasons },
    checkFreshness: { status: input.checkChanged ? "changed" : "current", reasons: input.checkChanged ? ["CHECK_INPUT_CHANGED"] : [] },
    limitations: ["Bounded static ESM/TypeScript analysis; no runtime dependency completeness or pipeline guarantee.", "Deleted source post-images and unknown configurations require separate qualification.", "PASS does not observe tests, Turbo cache behavior, failure propagation, or pipeline execution.",
      `Opaque external static module boundaries (built-ins or manifest-declared non-workspace packages): ${[...new Set(extraction.imports.filter((entry) => isExternal(entry.moduleSpecifier, entry.fromRelPath)).map((entry) => entry.moduleSpecifier))].sort().join(", ") || "none"}. Their runtime behavior and APIs are not qualified.`,
    ],
    proofObligations: [
      { id: "tests-execution", status: "not_observed", observation: "Run required tests and retain exact candidate exit status." },
      { id: "turbo-cache", status: "not_observed", observation: "Observe cache miss/hit and invalidation with representative tasks." },
      { id: "failure-propagation", status: "not_observed", observation: "Inject a failing task and observe nonzero pipeline exit." },
      { id: "pipeline-execution", status: "not_observed", observation: "Execute the actual required pipeline on the exact candidate." },
    ],
  };
}
