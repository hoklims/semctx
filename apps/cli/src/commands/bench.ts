import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { SemctxError } from "@semantic-context/core";
import { openStore } from "@semantic-context/repository-store";
import { runBench, type BenchCase } from "@semantic-context/eval";
import type { ParsedArgs } from "../args";
import { flagString, flagBool } from "../args";
import { info, heading, json, c } from "../output";

function loadSuite(root: string, args: ParsedArgs): BenchCase[] {
  const suiteArg = flagString(args, "suite");
  const path = suiteArg !== undefined ? resolve(process.cwd(), suiteArg) : join(root, "semctx-bench.json");
  if (!existsSync(path)) {
    throw new SemctxError("IO_ERROR", `no benchmark suite at ${path} (pass --suite <file>)`, { path });
  }
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  const cases = Array.isArray(raw) ? raw : (raw as { cases?: unknown }).cases;
  if (!Array.isArray(cases)) {
    throw new SemctxError("INVALID_TASK_INPUT", "benchmark suite must be an array or have a 'cases' array");
  }
  for (const item of cases) {
    const c2 = item as Partial<BenchCase>;
    if (
      typeof c2.id !== "string" ||
      typeof c2.task !== "string" ||
      c2.expect === null ||
      typeof c2.expect !== "object" ||
      Array.isArray(c2.expect)
    ) {
      throw new SemctxError("INVALID_TASK_INPUT", "invalid benchmark case (need id, task, and an expect object)", { item });
    }
  }
  return cases as BenchCase[];
}

/** `semctx bench` — measure ContextPack effectiveness against golden expectations. */
export function runBenchCmd(root: string, args: ParsedArgs): number {
  const cases = loadSuite(root, args);

  const store = openStore(root);
  if (!store.isIndexed()) {
    store.close();
    throw new SemctxError("REPO_NOT_INDEXED", "repository is not indexed; run 'semctx index' first");
  }
  const graph = store.loadGraph();
  const evidence = store.loadEvidence();
  const claims = store.loadClaims();
  store.close();

  const thresholdRaw = flagString(args, "threshold");
  const threshold = thresholdRaw !== undefined && Number.isFinite(Number(thresholdRaw)) ? Number(thresholdRaw) : 1;

  const report = runBench({ graph, evidence, claims, cases, threshold });

  if (flagBool(args, "json")) {
    json(report);
    return report.passed ? 0 : 1;
  }

  heading(`Benchmark — ${report.cases.length} case(s), threshold ${report.threshold}`);
  for (const caseResult of report.cases) {
    const mark = caseResult.passed ? c.green("PASS") : c.red("FAIL");
    info(`  [${mark}] ${caseResult.id}  ${c.dim(`score ${caseResult.score.toFixed(3)}`)}`);
    for (const metric of caseResult.metrics) {
      const mm = metric.passed ? c.green("ok ") : c.red("bad");
      info(`       ${mm} ${metric.name.padEnd(22)} ${metric.score.toFixed(2)}  ${c.dim(metric.detail)}`);
    }
  }
  const verdict = report.passed ? c.green("PASS") : c.red("FAIL");
  heading(`Aggregate score ${report.score.toFixed(3)}  ->  ${verdict}`);
  return report.passed ? 0 : 1;
}
