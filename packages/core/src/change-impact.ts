/**
 * Versioned machine contract for `semctx impact diff` (ADR 0030): what a change can affect, how
 * the link was established, and where the analysis stops. It is a FACTS document. It carries no
 * verdict, no proof level, no test obligation, no minimum proof count and no ALLOW/BLOCK: those
 * belong to the consumer's policy.
 *
 * Reading rules a consumer must apply:
 * - An absent target is never evidence of no impact. `explicitlyUnaffected` stays empty until a
 *   producer is negative-evidence-eligible (ADR 0010); it is typed as an empty array on purpose.
 * - `null` means "not computed" (the index binding is broken); `[]` means "computed, none found
 *   within the modeled reach". The two are never interchangeable.
 * - Open code sets (`reason`, `unresolved[].code`, `limits[].code`, `confidence.reasons`,
 *   `blastRadius.rationale`, `binding.breaks`) may grow within `schemaVersion: 1`; an unknown code
 *   must be read as an unresolved boundary. Closed enums (tiers, scope, binding status, file
 *   status, unit kind) change only with a version bump.
 */

import { z } from "zod";

export const CHANGE_IMPACT_SCHEMA_VERSION = 1 as const;

/** Strongest-first exposure ladder shared by units, targets, claims and surfaces. */
export type ImpactTier = "changed" | "direct" | "transitive" | "possible";

export type ChangeImpactSource = "working-tree" | "staged" | "range";

export interface ChangeImpactSubject {
  source: ChangeImpactSource;
  /** Requested base ref for a range, else null. */
  base: string | null;
  /** Requested head ref label (e.g. `HEAD`); `headOid` is the resolved identity. */
  head: string;
  headOid: string;
  /** Full merge-base object id for a range, else null. */
  mergeBaseOid: string | null;
  /** sha256 of the exact diff text semctx captured and analysed. */
  diffDigest: string;
  inputs: {
    indexSnapshotHash: string;
    repositoryFactsHash: string;
    configHash: string;
    /** Semantic-model inputs observed by the freshness probe, in observation order. */
    semanticInputHashes: string[];
    /** Fingerprint of the authored model whose nodes were joined into `exposedClaims`; null when none was. */
    semanticModelHash: string | null;
    /** The surface map read for this run (explicit `--surfaces`), or null when none was given. */
    surfaceMap: { path: string; digest: string } | null;
  };
}

export interface ChangeImpactBinding {
  /**
   * `bound`: the stored line ranges are proven to be in the coordinates of `rangeSide`, so hunks
   * and indexed symbols can be joined. `broken`: they are not; every index-derived set is null.
   */
  status: "bound" | "broken";
  /**
   * Diff side whose line coordinates match the index; null when broken. `mixed`: the index was
   * built on a dirty tree, so files already dirty then are joined on the new side and the others on
   * the old side — each unit's `side` says which.
   */
  rangeSide: "old" | "new" | "mixed" | null;
  /** Reasons the binding is broken (open code set). Empty when bound. */
  breaks: string[];
  /** Verbatim control freshness observed for this run; null when the probe failed. */
  freshness: { verdict: string; reasons: string[] } | null;
}

export interface ChangeImpactAnalysis {
  binding: ChangeImpactBinding;
  /**
   * A deterministic projection of `binding` and of the change-specific gaps, not a probability.
   * `moderate` is the ceiling: reach is best-effort static and no producer is negative-evidence
   * eligible. A stronger level would require a new schema version.
   */
  confidence: { level: "moderate" | "low" | "none"; reasons: string[] };
  bounds: { maxDistance: number; maxTargets: number };
  /** Whether authored `.semctx/semantic` nodes were joined into `exposedClaims`. */
  semanticLayer: "joined" | "absent" | "unavailable" | "not_computed";
  /** Static analysis limits that always apply to this run (open code set). */
  limits: { code: string; detail: string }[];
}

export type ChangedFileStatus =
  | "added"
  | "deleted"
  | "modified"
  | "renamed"
  | "binary"
  | "mode_only"
  | "untracked"
  | "unrecognized";

export interface ChangedFile {
  path: string;
  oldPath?: string;
  status: ChangedFileStatus;
  /** Content hunks in the diff (0 for header-only blocks and untracked files). */
  hunks: number;
}

export type ChangeUnitKind =
  /** An indexed symbol whose declaration range intersects a hunk on the bound side. */
  | "symbol"
  /** A top-level declaration with no graph node (constant, import binding, export clause). */
  | "declaration"
  /** Top-level executable code (module initialisation) changed. */
  | "module_statement"
  /** A file whose graph unit is the whole file (test, document, migration). */
  | "file"
  /** Only the leading comment of a declaration changed; markers on it may have changed. */
  | "doc_comment"
  /** Only comments or whitespace outside any declaration changed. */
  | "trivia"
  /** A top-level declaration that exists only on the other side (added on old, removed on new). */
  | "added_declaration"
  | "removed_declaration"
  /** Lines outside every symbol that could not be classified (no outline for the language). */
  | "unclassified";

export interface ChangeUnit {
  /** Graph node id, or `decl:<file>:<name>` for a declaration without a node. */
  id: string;
  kind: ChangeUnitKind;
  file: string;
  side: "old" | "new";
  lines: { start: number; end: number }[];
  /** Declared name(s) involved, when known. */
  names: string[];
  /** Graph kind (function, class, module, …) or declaration kind (variable, import, export). */
  declarationKind?: string;
  /** Whether the declaration is visible to importers; null when it cannot be determined. */
  exported?: boolean | null;
  /** Whether the unit can change the behaviour of existing code (trivia and doc comments cannot). */
  behavioral: boolean;
  /**
   * Present when the changed code runs as its module loads (an initializer with a call, a static
   * initializer, a newly loaded module): every importer runs it, exported or not.
   */
  runsOnLoad?: true;
  surfaces?: string[];
}

export type ImpactRelation =
  | "called_by"
  | "tested_by"
  | "referenced_by"
  | "imported_by"
  | "declared_in_same_file";

export interface ImpactStep {
  relation: ImpactRelation;
  /** Node or unit id closer to the change. */
  from: string;
  /** Node id farther from the change. */
  to: string;
  evidence?: { file: string; line?: number };
}

export interface ImpactTarget {
  id: string;
  kind: string;
  name: string;
  file?: string;
  package?: string;
  surfaces?: string[];
  /** Hops from the nearest changed unit (1 = direct). */
  distance: number;
  /** Why this target is in its tier (open code set, documented in docs/reference/change-impact.md). */
  reason: string;
  /** One shortest deterministic justification path, oriented from the change to the target. */
  via: ImpactStep[];
}

export interface ExposedClaim {
  id: string;
  /** `marker`: a code/doc marker node in the repository graph; `semantic`: an authored `.sem` node. */
  source: "marker" | "semantic";
  kind: string;
  statement?: string;
  tags: string[];
  exposure: ImpactTier;
  anchors: { nodeId: string; exposure: ImpactTier; relation: string }[];
}

export interface SurfaceImpact {
  name: string;
  description?: string;
  /**
   * Strongest tier of any member unit or target. `not_reached`: evaluated, bound and complete, and
   * no modeled path reaches it — which is still not a statement that it is unaffected.
   * `unknown`: the reach is incomplete or was not computed, so no absence can be stated.
   */
  exposure: ImpactTier | "not_reached" | "unknown";
  counts: { changed: number; direct: number; transitive: number; possible: number };
}

export interface BlastRadius {
  /**
   * Containment of the KNOWN reach (behavioural changes plus direct and transitive targets):
   * `local` = within the changed files; `package` = within the manifest-evidenced workspace
   * packages of the changed files; `repository` = beyond them (or no package boundary applies).
   * `unknown` whenever the reach is incomplete or the binding is broken. The possible tier is
   * reported as facts only and never summarized as a scope.
   */
  scope: "local" | "package" | "repository" | "unknown";
  complete: boolean;
  known: { files: string[]; packages: string[]; surfaces: string[] };
  possible: { files: number; packages: string[]; surfaces: string[]; omitted: number };
  rationale: string[];
}

export interface UnresolvedImpact {
  code: string;
  scope: "run" | "file" | "node";
  file?: string;
  nodeId?: string;
  detail: string;
  /** What this gap leaves incomplete: the reach, the exposed claims, or nothing load-bearing. */
  affects: "reach" | "claims" | "none";
}

export interface ChangeImpactReport {
  schemaVersion: typeof CHANGE_IMPACT_SCHEMA_VERSION;
  kind: "change_impact";
  subject: ChangeImpactSubject;
  analysis: ChangeImpactAnalysis;
  changes: { files: ChangedFile[]; units: ChangeUnit[] | null };
  directlyAffected: ImpactTarget[] | null;
  transitivelyAffected: ImpactTarget[] | null;
  possiblyAffected: ImpactTarget[] | null;
  explicitlyUnaffected: never[];
  exposedClaims: ExposedClaim[] | null;
  /** Null when no surface map was given; surfaces are never inferred by the engine. */
  surfaces: SurfaceImpact[] | null;
  blastRadius: BlastRadius;
  unresolved: UnresolvedImpact[];
}

// --- Surface map input (user-owned taxonomy, never hardcoded in the engine) ---

export interface SurfaceDefinition {
  name: string;
  description?: string;
  /** Repository-relative path globs (Bun glob syntax). */
  include: string[];
  exclude?: string[];
  /**
   * Optional symbol-name globs. When present, a symbol-level unit or target belongs to the
   * surface only if its name matches; a file-level one belongs on the file globs alone.
   */
  symbols?: string[];
}

export interface SurfaceMap {
  schemaVersion: 1;
  surfaces: SurfaceDefinition[];
}

const SurfaceNameSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u, "surface names are slugs");

export const SurfaceMapSchema = z
  .object({
    schemaVersion: z.literal(1),
    surfaces: z
      .array(
        z
          .object({
            name: SurfaceNameSchema,
            description: z.string().optional(),
            include: z.array(z.string().min(1)).min(1),
            exclude: z.array(z.string().min(1)).optional(),
            symbols: z.array(z.string().min(1)).min(1).optional(),
          })
          .strict(),
      )
      .refine((surfaces) => new Set(surfaces.map((surface) => surface.name)).size === surfaces.length, {
        message: "surface names must be unique",
      }),
  })
  .strict();

// --- Producer-side schema of the report (tests validate every emitted document against it) ---

const TierSchema = z.enum(["changed", "direct", "transitive", "possible"]);

const ImpactTargetSchema = z
  .object({
    id: z.string(),
    kind: z.string(),
    name: z.string(),
    file: z.string().optional(),
    package: z.string().optional(),
    surfaces: z.array(z.string()).optional(),
    distance: z.number().int().min(1),
    reason: z.string(),
    via: z
      .array(
        z
          .object({
            relation: z.enum(["called_by", "tested_by", "referenced_by", "imported_by", "declared_in_same_file"]),
            from: z.string(),
            to: z.string(),
            evidence: z.object({ file: z.string(), line: z.number().int().optional() }).strict().optional(),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

const ChangeImpactReportShape = z
  .object({
    schemaVersion: z.literal(CHANGE_IMPACT_SCHEMA_VERSION),
    kind: z.literal("change_impact"),
    subject: z
      .object({
        source: z.enum(["working-tree", "staged", "range"]),
        base: z.string().nullable(),
        head: z.string(),
        headOid: z.string(),
        mergeBaseOid: z.string().nullable(),
        diffDigest: z.string(),
        inputs: z
          .object({
            indexSnapshotHash: z.string(),
            repositoryFactsHash: z.string(),
            configHash: z.string(),
            semanticInputHashes: z.array(z.string()),
            semanticModelHash: z.string().nullable(),
            surfaceMap: z.object({ path: z.string(), digest: z.string() }).strict().nullable(),
          })
          .strict(),
      })
      .strict(),
    analysis: z
      .object({
        binding: z
          .object({
            status: z.enum(["bound", "broken"]),
            rangeSide: z.enum(["old", "new", "mixed"]).nullable(),
            breaks: z.array(z.string()),
            freshness: z.object({ verdict: z.string(), reasons: z.array(z.string()) }).strict().nullable(),
          })
          .strict(),
        confidence: z
          .object({ level: z.enum(["moderate", "low", "none"]), reasons: z.array(z.string()) })
          .strict(),
        bounds: z.object({ maxDistance: z.number().int().min(1), maxTargets: z.number().int().min(1) }).strict(),
        semanticLayer: z.enum(["joined", "absent", "unavailable", "not_computed"]),
        limits: z.array(z.object({ code: z.string(), detail: z.string() }).strict()),
      })
      .strict(),
    changes: z
      .object({
        files: z.array(
          z
            .object({
              path: z.string(),
              oldPath: z.string().optional(),
              status: z.enum(["added", "deleted", "modified", "renamed", "binary", "mode_only", "untracked", "unrecognized"]),
              hunks: z.number().int().min(0),
            })
            .strict(),
        ),
        units: z
          .array(
            z
              .object({
                id: z.string(),
                kind: z.enum([
                  "symbol",
                  "declaration",
                  "module_statement",
                  "file",
                  "doc_comment",
                  "trivia",
                  "added_declaration",
                  "removed_declaration",
                  "unclassified",
                ]),
                file: z.string(),
                side: z.enum(["old", "new"]),
                lines: z.array(z.object({ start: z.number().int(), end: z.number().int() }).strict()),
                names: z.array(z.string()),
                declarationKind: z.string().optional(),
                exported: z.boolean().nullable().optional(),
                behavioral: z.boolean(),
                runsOnLoad: z.literal(true).optional(),
                surfaces: z.array(z.string()).optional(),
              })
              .strict(),
          )
          .nullable(),
      })
      .strict(),
    directlyAffected: z.array(ImpactTargetSchema).nullable(),
    transitivelyAffected: z.array(ImpactTargetSchema).nullable(),
    possiblyAffected: z.array(ImpactTargetSchema).nullable(),
    explicitlyUnaffected: z.array(z.never()),
    exposedClaims: z
      .array(
        z
          .object({
            id: z.string(),
            source: z.enum(["marker", "semantic"]),
            kind: z.string(),
            statement: z.string().optional(),
            tags: z.array(z.string()),
            exposure: TierSchema,
            anchors: z.array(z.object({ nodeId: z.string(), exposure: TierSchema, relation: z.string() }).strict()).min(1),
          })
          .strict(),
      )
      .nullable(),
    surfaces: z
      .array(
        z
          .object({
            name: z.string(),
            description: z.string().optional(),
            exposure: z.enum(["changed", "direct", "transitive", "possible", "not_reached", "unknown"]),
            counts: z
              .object({
                changed: z.number().int().min(0),
                direct: z.number().int().min(0),
                transitive: z.number().int().min(0),
                possible: z.number().int().min(0),
              })
              .strict(),
          })
          .strict(),
      )
      .nullable(),
    blastRadius: z
      .object({
        scope: z.enum(["local", "package", "repository", "unknown"]),
        complete: z.boolean(),
        known: z.object({ files: z.array(z.string()), packages: z.array(z.string()), surfaces: z.array(z.string()) }).strict(),
        possible: z
          .object({
            files: z.number().int().min(0),
            packages: z.array(z.string()),
            surfaces: z.array(z.string()),
            omitted: z.number().int().min(0),
          })
          .strict(),
        rationale: z.array(z.string()),
      })
      .strict(),
    unresolved: z.array(
      z
        .object({
          code: z.string(),
          scope: z.enum(["run", "file", "node"]),
          file: z.string().optional(),
          nodeId: z.string().optional(),
          detail: z.string(),
          affects: z.enum(["reach", "claims", "none"]),
        })
        .strict(),
    ),
  })
  .strict();

/**
 * The report shape plus the relations between its fields that keep it from overstating certainty:
 * a broken binding nulls every index-derived field; the reach is complete exactly when no gap
 * affects it; confidence and blast radius follow; a surface is `not_reached` only on a complete,
 * untruncated reach; every chain is as long as its distance.
 */
export const ChangeImpactReportSchema = ChangeImpactReportShape.superRefine((report, context) => {
  const fail = (message: string): void => {
    context.addIssue({ code: z.ZodIssueCode.custom, message });
  };
  const tiers = [report.directlyAffected, report.transitivelyAffected, report.possiblyAffected];
  const reachGap = report.unresolved.some((entry) => entry.affects === "reach");
  if (report.analysis.binding.status === "broken") {
    if (report.analysis.binding.rangeSide !== null || report.changes.units !== null || report.exposedClaims !== null || tiers.some((tier) => tier !== null)) {
      fail("a broken binding must null every index-derived field");
    }
    if (report.analysis.confidence.level !== "none") fail("a broken binding has confidence none");
  } else {
    if (report.analysis.binding.rangeSide === null || report.changes.units === null || report.exposedClaims === null || tiers.some((tier) => tier === null)) {
      fail("a bound report carries every index-derived field");
    }
    if (report.analysis.confidence.level === "none") fail("confidence none is reserved for a broken binding");
    if (reachGap && report.analysis.confidence.level !== "low") fail("a gap affecting the reach caps confidence at low");
    if (!reachGap && report.analysis.confidence.level !== "moderate") fail("confidence is moderate only when no gap affects the reach");
  }
  if (report.blastRadius.complete === reachGap) fail("the reach is complete exactly when no gap affects it");
  if (!report.blastRadius.complete && report.blastRadius.scope !== "unknown") fail("an incomplete reach has an unknown scope");
  const untruncated = report.blastRadius.complete && report.blastRadius.possible.omitted === 0;
  for (const surface of report.surfaces ?? []) {
    if (surface.exposure === "not_reached" && !untruncated) fail(`surface ${surface.name} is not_reached on an incomplete or truncated reach`);
  }
  for (const [name, tier] of [["directlyAffected", report.directlyAffected], ["transitivelyAffected", report.transitivelyAffected], ["possiblyAffected", report.possiblyAffected]] as const) {
    for (const target of tier ?? []) {
      if (target.via.length !== target.distance) fail(`${name} ${target.id}: distance ${target.distance} but a chain of ${target.via.length}`);
      if (name === "directlyAffected" && target.distance !== 1) fail(`directlyAffected ${target.id} is one link away`);
      if (name === "transitivelyAffected" && target.distance < 2) fail(`transitivelyAffected ${target.id} is more than one link away`);
    }
  }
});
