/**
 * The one vocabulary every plane uses to say why a repository link did not resolve.
 *
 * Plane B computes it, Plane C projects it, reconciliation validation parses it and MCP publishes
 * it. Four copies of "the same" list drift, and a consumer that gates on one while reading another
 * disagrees about a link neither of them re-derived. It lives here — the lowest package all four
 * already depend on — as a single frozen tuple with a version, so adding a code is one edit and a
 * schema bump rather than four edits and a silent divergence.
 */

import { z } from "zod";

/**
 * Version of the reason-code vocabulary itself, distinct from any payload schema version.
 * Bump it when a code is added, removed or given a different meaning.
 */
export const LINK_RESOLUTION_REASON_VOCABULARY_VERSION = 2;

/**
 * Ordered most-specific first, so a report can rank without re-deriving intent.
 *
 * The three symbol codes are deliberately distinct because they call for different repairs:
 * `role_removed` means the coordinate holds a declaration of another kind, `symbol_gone` means
 * nothing matches at all, and `ambiguous` means semctx found several and refuses to pick.
 */
export const LINK_RESOLUTION_REASON_CODES = [
  "role_removed",
  "symbol_gone",
  "ambiguous",
  "path_absent",
  "claim_absent",
  "evidence_absent",
  "node_absent",
] as const;

export type LinkResolutionReasonCode = (typeof LINK_RESOLUTION_REASON_CODES)[number];

/** Strict: an unknown code is a contract break, not a value to pass through. */
export const LinkResolutionReasonCodeSchema = z.enum(LINK_RESOLUTION_REASON_CODES);

/**
 * Upper bound on reported candidates. A diagnostic exists to be read; an unbounded list of every
 * same-named symbol in a large file is noise, and an unsorted one is not reproducible.
 */
export const MAX_LINK_CANDIDATES = 8;

/**
 * Strictly increasing under the repository's binary collation — sorted *and* unique in one pass.
 *
 * The comparison is `<` on UTF-16 code units, matching `compareIds` in `@semantic-context/core`
 * rather than `localeCompare`, which is ICU-dependent and would make canonicality mean different
 * things on different machines. It is spelled out here instead of imported because this module is
 * the lowest one all four planes already share, and it depends on nothing but zod.
 */
export function isCanonicalLinkCandidateList(values: readonly string[]): boolean {
  for (let index = 1; index < values.length; index += 1) {
    if (!(values[index - 1]! < values[index]!)) return false;
  }
  return true;
}

/**
 * Bounded, non-empty per element, sorted and unique.
 *
 * Canonicality is enforced here rather than left to the producer. "The producer sorts" is a property
 * of one function; the schema is what a consumer gates on, and a list that arrives reordered,
 * duplicated or truncated is a different diagnostic wearing the same shape. Refusing it is what
 * keeps CLI, MCP and Plane C saying the same thing about the same broken anchor.
 */
export const LinkCandidatesSchema = z
  .array(z.string().min(1))
  .max(MAX_LINK_CANDIDATES)
  .refine(isCanonicalLinkCandidateList, {
    message: "candidates must be sorted by binary collation and free of duplicates",
  });

export const REPOSITORY_LINK_KINDS = [
  "symbol",
  "file",
  "claim",
  "invariant",
  "contract",
  "capability",
  "test",
  "migration",
  "evidence",
] as const;

export type CanonicalRepositoryLinkKind = (typeof REPOSITORY_LINK_KINDS)[number];

export const CanonicalRepositoryLinkSchema = z.object({
  kind: z.enum(REPOSITORY_LINK_KINDS),
  ref: z.string().min(1),
}).strict();

const LinkResolutionIdentitySchema = z.object({
  ownerId: z.string().min(1),
  link: CanonicalRepositoryLinkSchema,
});

export const ResolvedRepositoryLinkSchema = LinkResolutionIdentitySchema.extend({
  resolved: z.literal(true),
  legacy: z.literal(true).optional(),
}).strict();

export const UnresolvedRepositoryLinkSchema = LinkResolutionIdentitySchema.extend({
  resolved: z.literal(false),
  reason: z.string().min(1),
  reasonCode: LinkResolutionReasonCodeSchema,
  candidates: LinkCandidatesSchema.optional(),
}).strict().superRefine((value, context) => {
  if (
    value.candidates !== undefined
    && ["path_absent", "claim_absent", "evidence_absent", "node_absent"].includes(value.reasonCode)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["candidates"],
      message: `${value.reasonCode} cannot carry symbol candidates`,
    });
  }
});

/** Canonical external link-resolution payload shared by Plane C and transport boundaries. */
export const CanonicalLinkResolutionSchema = z.union([
  ResolvedRepositoryLinkSchema,
  UnresolvedRepositoryLinkSchema,
]);

export type CanonicalLinkResolution = z.infer<typeof CanonicalLinkResolutionSchema>;
export type UnresolvedRepositoryLink = z.infer<typeof UnresolvedRepositoryLinkSchema>;

export function isLinkResolutionReasonCode(value: unknown): value is LinkResolutionReasonCode {
  return typeof value === "string"
    && (LINK_RESOLUTION_REASON_CODES as readonly string[]).includes(value);
}

/** Rank within the vocabulary. `-1` for anything outside it, so a caller can fail closed. */
export function linkResolutionReasonRank(code: string): number {
  return (LINK_RESOLUTION_REASON_CODES as readonly string[]).indexOf(code);
}
