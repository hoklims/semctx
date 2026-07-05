/**
 * Stable, versioned machine-output contract for `verify diff` (ADR 0008).
 *
 * This is a deliberate projection of the internal verify result — NOT the internal object.
 * External consumers (the GitHub Action adapter, the Claude Code hook, CI) depend on
 * `schemaVersion`, never on internal types. Within a major `schemaVersion`, changes are
 * additive only (new optional fields); a breaking change bumps the version.
 */

import type { SeverityTier } from "./types/config";

export const VERIFY_REPORT_SCHEMA_VERSION = 1 as const;

export interface VerifyReportSymbol {
  id: string;
  name: string;
  kind: string;
  file?: string;
}

export interface VerifyReportClaim {
  statement: string;
  kind: string;
  verificationStatus: string;
}

export interface VerifyReportTest {
  name: string;
  file?: string;
}

export interface VerifyReportLocation {
  file: string;
  line?: number;
}

export interface VerifyReportFinding {
  rule: string;
  tier: SeverityTier;
  severity: "warn" | "block";
  message: string;
  nodeIds: string[];
  /** Concrete file+line anchors for annotations (derived from impacted nodes). */
  locations: VerifyReportLocation[];
}

export interface VerifyReportConsumer {
  /** The impacted exported symbol whose in-repo dependents are listed. */
  symbol: VerifyReportSymbol;
  /**
   * In-repo nodes that depend on `symbol`: symbol-level callers (via `calls`) and file-level
   * importers of the declaring module (via `imports`). Granularity is mixed because the static
   * graph resolves calls symbol-to-symbol but imports file-to-file (call graph is best-effort).
   */
  consumers: VerifyReportSymbol[];
}

export interface VerifyReport {
  schemaVersion: typeof VERIFY_REPORT_SCHEMA_VERSION;
  verdict: "PASS" | "WARN" | "BLOCK";
  /** The git base ref requested, or null when the diff came from --staged/--from-file/HEAD. */
  base: string | null;
  head: string;
  mergeBase: string | null;
  /** Human-readable git range analysed (e.g. "abc123..def456"), or null. */
  range: string | null;
  changedFiles: string[];
  changedSymbols: VerifyReportSymbol[];
  impactedContracts: VerifyReportClaim[];
  impactedInvariants: VerifyReportClaim[];
  recommendedTests: VerifyReportTest[];
  contradictions: VerifyReportClaim[];
  unknowns: string[];
  findings: VerifyReportFinding[];
  /**
   * Per-impacted-export list of in-repo consumers (ADR 0008 additive field, schemaVersion 1).
   * Present only when at least one impacted export has consumers; omitted otherwise.
   */
  impactedConsumers?: VerifyReportConsumer[];
  summary: { blockCount: number; warnCount: number };
}
