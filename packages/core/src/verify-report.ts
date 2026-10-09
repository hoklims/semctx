/**
 * Stable, versioned machine-output contract for `verify diff` (ADR 0008).
 *
 * This is a deliberate projection of the internal verify result — NOT the internal object.
 * External consumers (the GitHub Action adapter, the Claude Code hook, CI) depend on
 * `schemaVersion`, never on internal types. Within a major `schemaVersion`, changes are
 * additive only (new optional fields); a breaking change bumps the version.
 */

import { z } from "zod";
import type { SeverityTier } from "./types/config";

export const VERIFY_REPORT_SCHEMA_VERSION = 1 as const;

const AdmissionFileSchema = z.object({
  path: z.string(),
  status: z.enum(["analyzed", "excluded", "unsupported", "failed", "missing"]),
  reasons: z.array(z.string()),
}).strict();
const AdmissionDigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const AdmissionCommitSchema = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const AdmissionFreshnessSchema = z.object({ verdict: z.enum(["FRESH", "DIRTY_KNOWN", "STALE", "UNSEALED"]), reasons: z.array(z.string()) }).strict();
export const AnalysisAdmissionSchema = z.object({
  schemaVersion: z.literal(1),
  profile: z.literal("modelo-suite-static-v1"),
  status: z.enum(["admitted", "rejected"]),
  identity: z.object({ source: AdmissionDigestSchema, sourceCommits: z.array(AdmissionCommitSchema), baseCommit: AdmissionCommitSchema.nullable(), diff: AdmissionDigestSchema, config: AdmissionDigestSchema, analyzer: AdmissionDigestSchema, indexSnapshot: AdmissionDigestSchema }).strict(),
  binding: z.object({ status: z.enum(["valid", "invalid", "absent"]), reasons: z.array(z.string()) }).strict(),
  indexFreshness: AdmissionFreshnessSchema,
  checkFreshness: z.object({ status: z.enum(["current", "changed"]), reasons: z.array(z.string()) }).strict(),
  controlFreshness: AdmissionFreshnessSchema,
  repositoryCoverage: z.object({ status: z.enum(["complete", "partial", "insufficient"]), files: z.array(AdmissionFileSchema) }).strict(),
  changeCoverage: z.object({ expected: z.array(z.string()), analyzed: z.array(z.string()), files: z.array(AdmissionFileSchema) }).strict(),
  reasons: z.array(z.string()),
  limitations: z.array(z.string()),
  proofObligations: z.array(z.object({ id: z.string(), status: z.literal("not_observed"), observation: z.string() }).strict()),
}).strict().superRefine((value, context) => {
  if (value.status !== "admitted") return;
  const expected = value.changeCoverage.expected;
  const actual = value.changeCoverage.files;
  if (value.binding.status !== "valid" || value.binding.reasons.length > 0
    || value.identity.sourceCommits.length === 0 || new Set(value.identity.sourceCommits).size !== value.identity.sourceCommits.length
    || [value.indexFreshness, value.controlFreshness].some((freshness) => freshness.verdict === "FRESH" ? freshness.reasons.length > 0 : freshness.verdict === "DIRTY_KNOWN" && (freshness.reasons.length !== 1 || freshness.reasons[0] !== "WORKING_TREE_DIRTY"))
    || !["FRESH", "DIRTY_KNOWN"].includes(value.indexFreshness.verdict)
    || !["FRESH", "DIRTY_KNOWN"].includes(value.controlFreshness.verdict)
    || value.checkFreshness.status !== "current" || value.checkFreshness.reasons.length > 0
    || value.reasons.length > 0 || expected.length === 0
    || new Set(expected).size !== expected.length
    || actual.length !== expected.length
    || actual.some((file) => file.status !== "analyzed" || file.reasons.length > 0 || !expected.includes(file.path))
    || new Set(actual.map((file) => file.path)).size !== expected.length
    || value.changeCoverage.analyzed.length !== expected.length
    || value.changeCoverage.analyzed.some((path) => !expected.includes(path))
    || new Set(value.changeCoverage.analyzed).size !== expected.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "admitted analysis requires current compatible binding and complete non-empty analyzed obligations" });
  }
});
export type AnalysisAdmission = z.infer<typeof AnalysisAdmissionSchema>;

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

export interface VerifyReportCoChange {
  /** A file from the diff. */
  file: string;
  /** Files that historically changed together with `file` (not in the diff), ranked by support. */
  coChanged: { file: string; commits: number }[];
}

export interface VerifyReport {
  analysisAdmission?: AnalysisAdmission;
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
  /**
   * Historical git co-change signal (ADR 0008 additive field, schemaVersion 1): files that
   * changed together with the diff's files in past commits but are not in the diff. Advisory —
   * a structural impact axis the static graph cannot see. Present only when non-empty.
   */
  coChangedFiles?: VerifyReportCoChange[];
  summary: { blockCount: number; warnCount: number };
}

/**
 * Structural validator for an externally-loaded `VerifyReport` (e.g. a file passed to
 * `semctx feedback record`). Additive to the contract, not a change to it: the produced report
 * shape is untouched, this only lets a consumer reject a malformed or foreign JSON file instead of
 * trusting it blindly.
 */
const VerifyReportSymbolSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.string(),
  file: z.string().optional(),
}).passthrough();

const VerifyReportClaimSchema = z.object({
  statement: z.string(),
  kind: z.string(),
  verificationStatus: z.string(),
}).passthrough();

const VerifyReportTestSchema = z.object({
  name: z.string(),
  file: z.string().optional(),
}).passthrough();

const VerifyReportLocationSchema = z.object({
  file: z.string(),
  line: z.number().optional(),
}).passthrough();

const VerifyReportFindingSchema = z.object({
  rule: z.string(),
  tier: z.enum(["strict", "advisory"]),
  severity: z.enum(["warn", "block"]),
  message: z.string(),
  nodeIds: z.array(z.string()),
  locations: z.array(VerifyReportLocationSchema),
}).passthrough();

const VerifyReportConsumerSchema = z.object({
  symbol: VerifyReportSymbolSchema,
  consumers: z.array(VerifyReportSymbolSchema),
}).passthrough();

const VerifyReportCoChangeSchema = z.object({
  file: z.string(),
  coChanged: z.array(z.object({ file: z.string(), commits: z.number() }).passthrough()),
}).passthrough();

export const VerifyReportSchema = z.object({
  analysisAdmission: AnalysisAdmissionSchema.optional(),
  schemaVersion: z.literal(VERIFY_REPORT_SCHEMA_VERSION),
  verdict: z.enum(["PASS", "WARN", "BLOCK"]),
  base: z.string().nullable(),
  head: z.string(),
  mergeBase: z.string().nullable(),
  range: z.string().nullable(),
  changedFiles: z.array(z.string()),
  changedSymbols: z.array(VerifyReportSymbolSchema),
  impactedContracts: z.array(VerifyReportClaimSchema),
  impactedInvariants: z.array(VerifyReportClaimSchema),
  recommendedTests: z.array(VerifyReportTestSchema),
  contradictions: z.array(VerifyReportClaimSchema),
  unknowns: z.array(z.string()),
  findings: z.array(VerifyReportFindingSchema),
  impactedConsumers: z.array(VerifyReportConsumerSchema).optional(),
  coChangedFiles: z.array(VerifyReportCoChangeSchema).optional(),
  summary: z.object({ blockCount: z.number(), warnCount: z.number() }).passthrough(),
}).passthrough().superRefine((value, context) => {
  if (value.analysisAdmission?.status === "rejected" && value.verdict !== "BLOCK") {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["verdict"], message: "rejected qualified analysis must produce BLOCK" });
  }
});
