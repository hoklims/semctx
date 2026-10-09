import type { SemctxConfig } from "@semantic-context/core";
import type { DiscoveryCandidate, DiscoveryResult } from "@semantic-context/ts-analyzer";

export const SETUP_SCOPE_LIMITS = { roots: 20, samplesPerRoot: 3, proposedIncludes: 20, pathBytes: 240 } as const;
export type SetupScopeCounts = { observed: number; selected: number; excluded: number; unavailable: number };
export type SetupScopeReasonCount = { reason: DiscoveryCandidate["reason"]; count: number };
export interface SetupScopeRoot {
  root: string;
  counts: SetupScopeCounts;
  reasonCounts: SetupScopeReasonCount[];
  samplePaths: string[];
  samplePathsOmitted: number;
}
export interface SetupScopeReport {
  schemaVersion: 1;
  basis: "observed-discovery";
  sourceFamilies: ["typescript", "python"];
  counts: SetupScopeCounts;
  reasonCounts: SetupScopeReasonCount[];
  roots: SetupScopeRoot[];
  rootsTotal: number;
  rootsOmitted: number;
  proposedIncludes: string[];
  proposedIncludesTotal: number;
  proposedIncludesOmitted: number;
  unproposableIncludeMisses: number;
  applyRequired: true;
}

function counts(): SetupScopeCounts {
  return { observed: 0, selected: 0, excluded: 0, unavailable: 0 };
}
function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
export function isSetupScopeDisplayPath(path: string): boolean {
  return Buffer.byteLength(path, "utf8") <= SETUP_SCOPE_LIMITS.pathBytes
    && ![...path].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || (code >= 127 && code <= 159);
    });
}
/** No escaping: the active selector normalizes backslashes into separators. */
export function isExactSetupScopeInclude(path: string): boolean {
  return isSetupScopeDisplayPath(path) && path.length > 0 && !/^[a-z]:/i.test(path)
    && !path.startsWith("/") && !/[*?[\]{}()!\\]/.test(path)
    && path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}
function sourceRoot(path: string): string {
  const parts = path.split("/");
  const src = parts.indexOf("src");
  return (src >= 0 ? parts.slice(0, src) : parts.slice(0, -1)).join("/") || ".";
}
function reasonCounts(candidates: readonly DiscoveryCandidate[]): SetupScopeReasonCount[] {
  const reasons = new Map<DiscoveryCandidate["reason"], number>();
  for (const candidate of candidates) reasons.set(candidate.reason, (reasons.get(candidate.reason) ?? 0) + 1);
  return [...reasons].sort(([left], [right]) => compare(left, right)).map(([reason, count]) => ({ reason, count }));
}
function summarize(candidates: readonly DiscoveryCandidate[], selected: ReadonlySet<string>): SetupScopeCounts {
  const result = counts();
  for (const candidate of candidates) {
    result.observed++;
    if (selected.has(candidate.relPath)) result.selected++;
    else if (candidate.selectionDecision === "excluded") result.excluded++;
    else result.unavailable++;
  }
  return result;
}

/** Pure projection of existing discovery; excluded candidates have not been read or analyzed. */
export function projectSetupScope(config: SemctxConfig, discovery: DiscoveryResult): SetupScopeReport {
  const candidates = discovery.candidates.filter((entry) => entry.language === "typescript" || entry.language === "python")
    .sort((left, right) => compare(left.relPath, right.relPath));
  const selected = new Set(discovery.files.map((file) => file.relPath));
  const groups = new Map<string, DiscoveryCandidate[]>();
  const safeIncludes = new Set<string>();
  let unproposableIncludeMisses = 0;
  for (const candidate of candidates) {
    const root = sourceRoot(candidate.relPath);
    const group = groups.get(root) ?? [];
    group.push(candidate);
    groups.set(root, group);
    if (config.version === 2 && config.languages[candidate.language] === "on"
      && candidate.selectionDecision === "excluded" && candidate.reason === "INCLUDE_MISS"
      && (candidate.analysisOutcome === undefined || candidate.analysisOutcome === "not_applicable")) {
      if (isExactSetupScopeInclude(candidate.relPath)) safeIncludes.add(candidate.relPath);
      else unproposableIncludeMisses++;
    }
  }
  const roots: SetupScopeRoot[] = [];
  for (const [root, group] of [...groups].sort(([left], [right]) => compare(left, right))) {
    if (!isSetupScopeDisplayPath(root) || roots.length === SETUP_SCOPE_LIMITS.roots) continue;
    const samplePaths = group.map((entry) => entry.relPath).filter(isSetupScopeDisplayPath).slice(0, SETUP_SCOPE_LIMITS.samplesPerRoot);
    roots.push({ root, counts: summarize(group, selected), reasonCounts: reasonCounts(group), samplePaths, samplePathsOmitted: group.length - samplePaths.length });
  }
  const proposedIncludes = [...safeIncludes].sort(compare).slice(0, SETUP_SCOPE_LIMITS.proposedIncludes);
  return {
    schemaVersion: 1,
    basis: "observed-discovery",
    sourceFamilies: ["typescript", "python"],
    counts: summarize(candidates, selected),
    reasonCounts: reasonCounts(candidates),
    roots,
    rootsTotal: groups.size,
    rootsOmitted: groups.size - roots.length,
    proposedIncludes,
    proposedIncludesTotal: safeIncludes.size,
    proposedIncludesOmitted: safeIncludes.size - proposedIncludes.length,
    unproposableIncludeMisses,
    applyRequired: true,
  };
}
