import { canonicalJson, digestCanonical, SemctxError } from "@semantic-context/core";
import { indexHealth, indexHealthStatus, type IndexHealthReportV1, type IndexHealthStatus } from "./index-health";

export const INDEX_HEALTH_SECTIONS = [
  "candidates", "capabilities", "evaluations", "workspace_nodes", "workspace_edges",
  "workspace_candidates", "workspace_diagnostics",
] as const;

export const INDEX_HEALTH_VIEW_MAX_BYTES = 240 * 1024;

export type IndexHealthSection = typeof INDEX_HEALTH_SECTIONS[number];

export interface IndexHealthViewRequest {
  section?: IndexHealthSection;
  cursor?: string;
  limit?: number;
}

type Workspace = NonNullable<IndexHealthReportV1["workspace"]>;

interface SectionItems {
  candidates: IndexHealthReportV1["candidates"];
  capabilities: IndexHealthReportV1["capabilities"];
  evaluations: IndexHealthReportV1["evaluations"]["decisions"];
  workspace_nodes: Workspace["nodes"];
  workspace_edges: Workspace["edges"];
  workspace_candidates: Workspace["candidates"];
  workspace_diagnostics: Workspace["diagnostics"];
}

export type IndexHealthPageV2 = {
  [Section in IndexHealthSection]: {
    section: Section;
    total: number;
    offset: number;
    returned: number;
    nextCursor: string | null;
    items: SectionItems[Section];
  }
}[IndexHealthSection];

export interface IndexHealthReportV2 {
  schemaVersion: 2;
  kind: "index_health";
  status: IndexHealthStatus;
  capturedAt: IndexHealthReportV1["capturedAt"];
  binding: IndexHealthReportV1["binding"];
  freshness: IndexHealthReportV1["freshness"];
  coverage: IndexHealthReportV1["coverage"];
  reasonSummary: IndexHealthReportV1["reasonSummary"];
  evaluations: {
    reasonSummary: IndexHealthReportV1["evaluations"]["reasonSummary"];
    primaryReason?: IndexHealthReportV1["evaluations"]["primaryReason"];
    outcomeCounts: Record<IndexHealthReportV1["evaluations"]["decisions"][number]["outcome"], number>;
  };
  details: {
    candidates: number;
    capabilities: number;
    evaluations: number;
    workspace: null | {
      repositoryId: string;
      nodes: number;
      edges: number;
      candidates: number;
      diagnostics: number;
    };
  };
  page: IndexHealthPageV2 | null;
}

function summary(report: IndexHealthReportV1): IndexHealthReportV2 {
  const outcomeCounts: IndexHealthReportV2["evaluations"]["outcomeCounts"] = {
    PASS: 0, UNKNOWN: 0, INSUFFICIENT_ANALYSIS: 0, POLICY_DENIED: 0,
  };
  for (const decision of report.evaluations.decisions) outcomeCounts[decision.outcome] += 1;
  const workspace = report.workspace;
  return {
    schemaVersion: 2,
    kind: "index_health",
    status: indexHealthStatus(report),
    capturedAt: report.capturedAt,
    binding: report.binding,
    freshness: { ...report.freshness, reasons: [...new Set(report.freshness.reasons)] },
    coverage: report.coverage,
    reasonSummary: [...new Set(report.reasonSummary)],
    evaluations: {
      reasonSummary: [...new Set(report.evaluations.reasonSummary)],
      ...(report.evaluations.primaryReason !== undefined ? { primaryReason: report.evaluations.primaryReason } : {}),
      outcomeCounts,
    },
    details: {
      candidates: report.candidates.length,
      capabilities: report.capabilities.length,
      evaluations: report.evaluations.decisions.length,
      workspace: workspace === null ? null : {
        repositoryId: workspace.repositoryId,
        nodes: workspace.nodes.length,
        edges: workspace.edges.length,
        candidates: workspace.candidates.length,
        diagnostics: workspace.diagnostics.length,
      },
    },
    page: null,
  };
}

function requireBounded(report: IndexHealthReportV2): IndexHealthReportV2 {
  if (Buffer.byteLength(canonicalJson(report), "utf8") > INDEX_HEALTH_VIEW_MAX_BYTES) {
    throw new SemctxError("INDEX_HEALTH_RESPONSE_TOO_LARGE", "Index health response exceeds the byte limit.", {
      maximumBytes: INDEX_HEALTH_VIEW_MAX_BYTES,
    });
  }
  return report;
}

function validateRequest(request: IndexHealthViewRequest): void {
  const invalid = () => {
    throw new SemctxError("INVALID_TASK_INPUT", "Index health requires an allowed section and an integer limit from 1 to 100; cursor and limit require section.");
  };
  if (typeof request !== "object" || request === null || Array.isArray(request)) invalid();
  if (request.section !== undefined && !INDEX_HEALTH_SECTIONS.includes(request.section)) invalid();
  if (request.section === undefined && (request.cursor !== undefined || request.limit !== undefined)) invalid();
  if (request.limit !== undefined && (!Number.isInteger(request.limit) || request.limit < 1 || request.limit > 100)) invalid();
  if (request.cursor !== undefined && typeof request.cursor !== "string") invalid();
}

interface Cursor {
  schemaVersion: 1;
  reportDigest: string;
  section: IndexHealthSection;
  offset: number;
}

function encodeCursor(reportDigest: string, section: IndexHealthSection, offset: number): string {
  return Buffer.from(canonicalJson({ schemaVersion: 1, reportDigest, section, offset })).toString("base64url");
}

function decodeCursor(cursor: string, section: IndexHealthSection): Cursor {
  const invalid = () => new SemctxError("INDEX_HEALTH_CURSOR_INVALID", "Index health cursor is malformed or does not match the requested section. Start a new page request without a cursor.");
  if (cursor.length === 0 || cursor.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw invalid();
  try {
    const bytes = Buffer.from(cursor, "base64url");
    const json = bytes.toString("utf8");
    const body = JSON.parse(json) as unknown;
    if (typeof body !== "object" || body === null || Array.isArray(body)) throw invalid();
    const value = body as Record<string, unknown>;
    if (
      bytes.toString("base64url") !== cursor || canonicalJson(body) !== json
      || Object.keys(value).length !== 4 || value["schemaVersion"] !== 1
      || typeof value["reportDigest"] !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value["reportDigest"])
      || value["section"] !== section || typeof value["offset"] !== "number"
      || !Number.isSafeInteger(value["offset"]) || value["offset"] < 1
    ) throw invalid();
    return value as unknown as Cursor;
  } catch {
    throw invalid();
  }
}

function detailSections(report: IndexHealthReportV1): SectionItems {
  return {
    candidates: report.candidates,
    capabilities: report.capabilities,
    evaluations: report.evaluations.decisions,
    workspace_nodes: report.workspace?.nodes ?? [],
    workspace_edges: report.workspace?.edges ?? [],
    workspace_candidates: report.workspace?.candidates ?? [],
    workspace_diagnostics: report.workspace?.diagnostics ?? [],
  };
}

export function projectIndexHealth(report: IndexHealthReportV1, request: IndexHealthViewRequest = {}): IndexHealthReportV2 {
  validateRequest(request);
  const view = requireBounded(summary(report));
  const section = request.section;
  if (section === undefined) return view;
  const items = detailSections(report)[section];
  const total = items.length;
  const reportDigest = digestCanonical(report);
  const cursor = request.cursor === undefined ? undefined : decodeCursor(request.cursor, section);
  if (cursor !== undefined && cursor.reportDigest !== reportDigest) {
    throw new SemctxError("INDEX_HEALTH_CURSOR_STALE", "Index health changed since this cursor was issued. Start a new page request without a cursor.");
  }
  const offset = cursor?.offset ?? 0;
  if (cursor !== undefined && offset >= total) {
    throw new SemctxError("INDEX_HEALTH_CURSOR_INVALID", "Index health cursor offset is outside the requested section. Start a new page request without a cursor.");
  }
  const reportBytesWithoutPage = Buffer.byteLength(canonicalJson(view), "utf8") - 4;
  let returned = 0;
  let itemBytes = 0;
  const limit = Math.min(request.limit ?? 20, total - offset);
  const metadata = (count: number) => ({
    section, total, offset, returned: count,
    nextCursor: offset + count < total ? encodeCursor(reportDigest, section, offset + count) : null,
    items: [],
  });
  while (returned < limit) {
    const count = returned + 1;
    const bytes = itemBytes + Buffer.byteLength(canonicalJson(items[offset + returned]), "utf8");
    const responseBytes = reportBytesWithoutPage + Buffer.byteLength(canonicalJson(metadata(count)), "utf8")
      + bytes + Math.max(0, count - 1);
    if (responseBytes > INDEX_HEALTH_VIEW_MAX_BYTES) {
      if (returned === 0) {
        throw new SemctxError("INDEX_HEALTH_RESPONSE_TOO_LARGE", "One index health detail item exceeds the response byte limit and cannot be paginated. Inspect the full report with the CLI.", {
          section, offset, maximumBytes: INDEX_HEALTH_VIEW_MAX_BYTES,
        });
      }
      break;
    }
    returned = count;
    itemBytes = bytes;
  }
  const page = { ...metadata(returned), items: items.slice(offset, offset + returned) } as IndexHealthPageV2;
  return requireBounded({ ...view, page });
}

export function indexHealthView(root: string, request: IndexHealthViewRequest = {}): IndexHealthReportV2 {
  validateRequest(request);
  return projectIndexHealth(indexHealth(root), request);
}
