/**
 * Voluntary local feedback on a `VerifyReport` finding (ADR 0021 / HOK-645).
 *
 * Pure schemas, identity derivation and projection. No filesystem access here: persistence lives
 * in `@semantic-context/repository-store`, orchestration (clock, store I/O) in
 * `@semantic-context/app-services`. Feedback is an opinion about a finding, never verified
 * correction evidence, and its absence is never approval or rejection.
 */
import { z } from "zod";
import { digestCanonical } from "./canonical";
import { BlockingConditionSchema } from "./schemas";
import type { VerifyReport } from "./verify-report";

export const FEEDBACK_SCHEMA_VERSION = 1 as const;

/** The closed vocabulary a `VerifyReportFinding.rule` is drawn from; anything else is "other". */
export const KNOWN_FEEDBACK_RULE_NAMES: ReadonlySet<string> = new Set(BlockingConditionSchema.options);

export const FeedbackOutcomeSchema = z.enum(["useful", "ignored", "unclear", "suspected-error"]);
export type FeedbackOutcome = z.infer<typeof FeedbackOutcomeSchema>;

/** Bounded, closed reason vocabulary — the only reason information ever eligible for export. */
export const FeedbackReasonCodeSchema = z.enum([
  "false-positive",
  "already-known",
  "not-relevant",
  "too-noisy",
  "confirmed-correct",
  "other",
]);
export type FeedbackReasonCode = z.infer<typeof FeedbackReasonCodeSchema>;

export const FEEDBACK_NOTE_MAX_LENGTH = 500;
/** Free-form local text. Never leaves the private store — the aggregate export omits it entirely. */
export const FeedbackNoteSchema = z.string().max(FEEDBACK_NOTE_MAX_LENGTH);

const Sha256Schema = z.string().regex(/^sha256:[0-9a-f]{64}$/, "expected a sha256:<hex> digest");

export const FeedbackReportIdentitySchema = z
  .object({
    schemaVersion: z.number().int().nonnegative(),
    contentDigest: Sha256Schema,
  })
  .strict();
export type FeedbackReportIdentityV1 = z.infer<typeof FeedbackReportIdentitySchema>;

export const FeedbackFindingIdentitySchema = z
  .object({
    index: z.number().int().nonnegative(),
    rule: z.string().min(1),
    digest: Sha256Schema,
  })
  .strict();
export type FeedbackFindingIdentityV1 = z.infer<typeof FeedbackFindingIdentitySchema>;

/** Observed source scope the report was computed from, kept locally for display; never exported. */
export const FeedbackSourceIdentitySchema = z
  .object({
    base: z.string().nullable(),
    head: z.string(),
    range: z.string().nullable(),
  })
  .strict();
export type FeedbackSourceIdentityV1 = z.infer<typeof FeedbackSourceIdentitySchema>;

export const FeedbackRecordSchema = z
  .object({
    schemaVersion: z.literal(FEEDBACK_SCHEMA_VERSION),
    recordId: z.string().regex(/^fb:[0-9a-f]{64}$/),
    report: FeedbackReportIdentitySchema,
    finding: FeedbackFindingIdentitySchema,
    source: FeedbackSourceIdentitySchema,
    outcome: FeedbackOutcomeSchema,
    reason: FeedbackReasonCodeSchema.optional(),
    note: FeedbackNoteSchema.optional(),
    recordedAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type FeedbackRecordV1 = z.infer<typeof FeedbackRecordSchema>;

export const FeedbackStoreFileSchema = z
  .object({
    schemaVersion: z.literal(FEEDBACK_SCHEMA_VERSION),
    records: z.array(FeedbackRecordSchema),
  })
  .strict()
  .superRefine((file, context) => {
    const seen = new Set<string>();
    file.records.forEach((record, index) => {
      if (record.recordId !== computeFeedbackRecordId(record.report, record.finding, record.source)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "feedback recordId does not match report/finding/source identity",
          path: ["records", index, "recordId"],
        });
      }
      if (seen.has(record.recordId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "duplicate feedback recordId",
          path: ["records", index, "recordId"],
        });
      }
      if (Date.parse(record.updatedAt) < Date.parse(record.recordedAt)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "feedback updatedAt must not precede recordedAt",
          path: ["records", index, "updatedAt"],
        });
      }
      seen.add(record.recordId);
    });
  });
export type FeedbackStoreFileV1 = z.infer<typeof FeedbackStoreFileSchema>;

export function emptyFeedbackStoreFile(): FeedbackStoreFileV1 {
  return { schemaVersion: FEEDBACK_SCHEMA_VERSION, records: [] };
}

export function computeFeedbackReportIdentity(report: VerifyReport): FeedbackReportIdentityV1 {
  return { schemaVersion: report.schemaVersion, contentDigest: digestCanonical(report) };
}

/** `undefined` when `findingIndex` does not select an existing finding in `report`. */
export function computeFeedbackFindingIdentity(
  report: VerifyReport,
  findingIndex: number,
): FeedbackFindingIdentityV1 | undefined {
  const finding = report.findings[findingIndex];
  if (finding === undefined) return undefined;
  return { index: findingIndex, rule: finding.rule, digest: digestCanonical(finding) };
}

export function computeFeedbackSourceIdentity(report: VerifyReport): FeedbackSourceIdentityV1 {
  return { base: report.base, head: report.head, range: report.range };
}

/**
 * The record key. A pure function of the report, finding and observed source identities so that a
 * loaded record cannot claim a different source scope while retaining a valid key. Repeating the
 * exact same recording remains idempotent by construction.
 */
export function computeFeedbackRecordId(
  reportIdentity: FeedbackReportIdentityV1,
  findingIdentity: FeedbackFindingIdentityV1,
  sourceIdentity: FeedbackSourceIdentityV1,
): string {
  return `fb:${digestCanonical({
    report: reportIdentity,
    finding: findingIdentity,
    source: sourceIdentity,
  }).slice("sha256:".length)}`;
}

export interface FeedbackAnswer {
  outcome: FeedbackOutcome;
  reason?: FeedbackReasonCode;
  note?: string;
}

export function sameFeedbackAnswer(record: FeedbackRecordV1, answer: FeedbackAnswer): boolean {
  return (
    record.outcome === answer.outcome
    && (record.reason ?? undefined) === (answer.reason ?? undefined)
    && (record.note ?? undefined) === (answer.note ?? undefined)
  );
}

export interface BuildFeedbackRecordInput extends FeedbackAnswer {
  report: VerifyReport;
  findingIndex: number;
  /** Injected observation time (ISO 8601) — never `Date.now()` inside a pure function. */
  now: string;
}

export type BuildFeedbackRecordResult =
  | { status: "ok"; record: FeedbackRecordV1 }
  | { status: "finding-not-found" };

/** Pure construction of a new record. Duplicate/conflict resolution is the caller's concern. */
export function buildFeedbackRecord(input: BuildFeedbackRecordInput): BuildFeedbackRecordResult {
  const findingIdentity = computeFeedbackFindingIdentity(input.report, input.findingIndex);
  if (findingIdentity === undefined) return { status: "finding-not-found" };
  const reportIdentity = computeFeedbackReportIdentity(input.report);
  const sourceIdentity = computeFeedbackSourceIdentity(input.report);
  const record: FeedbackRecordV1 = {
    schemaVersion: FEEDBACK_SCHEMA_VERSION,
    recordId: computeFeedbackRecordId(reportIdentity, findingIdentity, sourceIdentity),
    report: reportIdentity,
    finding: findingIdentity,
    source: sourceIdentity,
    outcome: input.outcome,
    ...(input.reason === undefined ? {} : { reason: input.reason }),
    ...(input.note === undefined ? {} : { note: input.note }),
    recordedAt: input.now,
    updatedAt: input.now,
  };
  return { status: "ok", record };
}

/**
 * Apply an explicit update's answer onto an existing record. The new answer replaces the previous
 * one wholesale — an omitted `reason`/`note` clears it rather than leaving a stale prior value.
 */
export function applyFeedbackUpdate(record: FeedbackRecordV1, answer: FeedbackAnswer, now: string): FeedbackRecordV1 {
  const { reason: _priorReason, note: _priorNote, ...rest } = record;
  return {
    ...rest,
    outcome: answer.outcome,
    ...(answer.reason === undefined ? {} : { reason: answer.reason }),
    ...(answer.note === undefined ? {} : { note: answer.note }),
    updatedAt: now,
  };
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

const CountSchema = z.number().int().nonnegative();

export const FeedbackAggregateExportSchema = z
  .object({
    schemaVersion: z.literal(FEEDBACK_SCHEMA_VERSION),
    kind: z.literal("feedback_aggregate"),
    generatedAt: z.string().datetime(),
    /** `known` counts records whose finding rule is in the closed standard vocabulary; the rest are `absent`. */
    totals: z.object({ total: CountSchema, known: CountSchema, absent: CountSchema }).strict(),
    byOutcome: z.array(z.object({ outcome: FeedbackOutcomeSchema, count: CountSchema }).strict()),
    /** A standard rule name or `other`; custom rule text is never part of this public schema. */
    byRuleOutcome: z.array(z.object({
      rule: z.union([BlockingConditionSchema, z.literal("other")]),
      outcome: FeedbackOutcomeSchema,
      count: CountSchema,
    }).strict()),
    /** Known reason codes only; free-form `note` text never appears here. */
    byReason: z.array(z.object({ reason: FeedbackReasonCodeSchema, count: CountSchema }).strict()),
  })
  .strict();
export type FeedbackAggregateExportV1 = z.infer<typeof FeedbackAggregateExportSchema>;

/**
 * Sanitised aggregate for sharing. Omits report metadata, source identity, and every note/free-text
 * field by construction — it is built only from `outcome`, the closed `reason` vocabulary, and
 * whether `finding.rule` is a recognised standard name.
 */
export function buildFeedbackAggregateExport(
  records: readonly FeedbackRecordV1[],
  generatedAt: string,
): FeedbackAggregateExportV1 {
  const known = records.filter((record) => KNOWN_FEEDBACK_RULE_NAMES.has(record.finding.rule)).length;
  const byOutcome = new Map<FeedbackOutcome, number>();
  const byRuleOutcome = new Map<string, number>();
  const byReason = new Map<FeedbackReasonCode, number>();
  for (const record of records) {
    byOutcome.set(record.outcome, (byOutcome.get(record.outcome) ?? 0) + 1);
    const rule = KNOWN_FEEDBACK_RULE_NAMES.has(record.finding.rule) ? record.finding.rule : "other";
    const ruleOutcomeKey = `${rule}::${record.outcome}`;
    byRuleOutcome.set(ruleOutcomeKey, (byRuleOutcome.get(ruleOutcomeKey) ?? 0) + 1);
    if (record.reason !== undefined) byReason.set(record.reason, (byReason.get(record.reason) ?? 0) + 1);
  }
  return FeedbackAggregateExportSchema.parse({
    schemaVersion: FEEDBACK_SCHEMA_VERSION,
    kind: "feedback_aggregate",
    generatedAt,
    totals: { total: records.length, known, absent: records.length - known },
    byOutcome: [...byOutcome.entries()]
      .sort(([a], [b]) => compareStrings(a, b))
      .map(([outcome, count]) => ({ outcome, count })),
    byRuleOutcome: [...byRuleOutcome.entries()]
      .sort(([a], [b]) => compareStrings(a, b))
      .map(([key, count]) => {
        const [rule, outcome] = key.split("::") as [string, FeedbackOutcome];
        return { rule, outcome, count };
      }),
    byReason: [...byReason.entries()]
      .sort(([a], [b]) => compareStrings(a, b))
      .map(([reason, count]) => ({ reason, count })),
  });
}
