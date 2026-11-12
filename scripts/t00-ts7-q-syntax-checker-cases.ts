import { isDeepStrictEqual } from "node:util";
import { logicalCallEdges } from "./t00-ts7-q-syntax-checker-graph.js";
import { comparisonValue } from "./t00-ts7-q-syntax-core.js";
import type { CampaignCase } from "./t00-ts7-q-syntax-types.js";

interface CampaignModule {
  cases: CampaignCase[];
  gaps?: Record<number, string>;
  propertyWitnesses: Record<number, Record<string, string[]>>;
  replacesIndices?: number[];
}

export function combineCampaignCases(modules: CampaignModule[]) {
  let cases: CampaignCase[] = [];
  const gaps: Record<number, string> = {};
  const propertyWitnesses: Record<number, Record<string, string[]>> = {};
  for (const module of modules) {
    const replaced = new Set(module.replacesIndices ?? []);
    for (const index of replaced) {
      if (!module.cases.some(item => item.indices.includes(index)))
        throw new Error(`replacement has no witness: ${index}`);
      delete gaps[index];
      delete propertyWitnesses[index];
    }
    cases = cases.map(item => ({ ...item, indices: item.indices.filter(index => !replaced.has(index)) }))
      .filter(item => item.indices.length > 0);
    cases.push(...module.cases);
    Object.assign(gaps, ...module.cases.map(item => item.gaps ?? {}), module.gaps ?? {});
    Object.assign(propertyWitnesses, module.propertyWitnesses);
  }
  return { cases, gaps, propertyWitnesses };
}

export function projectComparison(value: unknown, transform?: CampaignCase["checks"][number]["transform"]): unknown {
  if (!transform) return value;
  if (transform === "logical-call-edges") return logicalCallEdges(value);
  if (transform === "native-reasons") {
    if (!Array.isArray(value) || !value.every((entry: unknown) => typeof entry === "string"))
      throw new Error("native reasons must be strings");
    return (value as string[]).filter(reason => reason === "JAVASCRIPT_COMMONJS_UNSUPPORTED" ||
      reason.startsWith("JAVASCRIPT_NATIVE_MODULE_MEMBER_UNSUPPORTED:") ||
      reason === "JAVASCRIPT_DYNAMIC_EVALUATION_UNSUPPORTED");
  }
  return comparisonValue(value, transform);
}

export function comparisonMatches(actual: unknown, expected: unknown, comparison?: "unordered"): boolean {
  if (comparison !== "unordered") return isDeepStrictEqual(actual, expected);
  if (!Array.isArray(actual) || !Array.isArray(expected))
    throw new Error("unordered comparison requires two arrays");
  if (actual.length !== expected.length) return false;
  const remaining = [...expected as unknown[]];
  return (actual as unknown[]).every(value => {
    const index = remaining.findIndex(candidate => isDeepStrictEqual(value, candidate));
    if (index < 0) return false;
    remaining.splice(index, 1);
    return true;
  });
}
