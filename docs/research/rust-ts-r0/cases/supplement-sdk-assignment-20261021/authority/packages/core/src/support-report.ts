/**
 * Privacy-safe support/diagnostic report shape (ADR 0021 / HOK-644).
 *
 * A closed, allowlisted projection: every field here is safe to share. There is deliberately no
 * field for raw check detail, paths, environment, remote URLs, Git identities, config or prose —
 * callers that build a `SupportReportV1` cannot smuggle any of that in without failing the schema.
 */
import { z } from "zod";

export const SUPPORT_REPORT_SCHEMA_VERSION = 1 as const;

const SemverSchema = z.string().max(64).regex(
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/,
);

export const SupportHealthStatusSchema = z.enum(["healthy", "degraded", "blocked", "unknown"]);
export type SupportHealthStatus = z.infer<typeof SupportHealthStatusSchema>;

/** Bounded, closed reason vocabulary — never the underlying check's raw detail string. */
export const SupportReasonCodeSchema = z.enum([
  "WORKSPACE_NOT_INITIALIZED",
  "CONFIG_INVALID",
  "INDEX_ABSENT",
  "INDEX_BINDING_INVALID",
  "INDEX_COVERAGE_PARTIAL",
  "INDEX_COVERAGE_INSUFFICIENT",
  "FRESHNESS_UNSEALED",
  "FRESHNESS_STALE",
  "HEALTH_CHECK_UNAVAILABLE",
]);
export type SupportReasonCode = z.infer<typeof SupportReasonCodeSchema>;

export const SupportHealthSectionSchema = z
  .object({
    status: SupportHealthStatusSchema,
    reasons: z.array(SupportReasonCodeSchema),
  })
  .strict();
export type SupportHealthSectionV1 = z.infer<typeof SupportHealthSectionSchema>;

export const SupportReportSchema = z
  .object({
    schemaVersion: z.literal(SUPPORT_REPORT_SCHEMA_VERSION),
    kind: z.literal("support_report"),
    /** Injected observation time (ISO 8601), never `Date.now()` inside a pure builder. */
    observedAt: z.string().datetime(),
    semctxVersion: SemverSchema,
    bunVersion: SemverSchema,
    platform: z.enum(["aix", "android", "darwin", "freebsd", "haiku", "linux", "openbsd", "sunos", "win32", "cygwin", "netbsd"]),
    arch: z.enum(["arm", "arm64", "ia32", "loong64", "mips", "mipsel", "ppc", "ppc64", "riscv64", "s390", "s390x", "x64"]),
    workspace: SupportHealthSectionSchema,
    index: SupportHealthSectionSchema,
  })
  .strict();
export type SupportReportV1 = z.infer<typeof SupportReportSchema>;
