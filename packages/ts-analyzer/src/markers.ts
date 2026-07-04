/**
 * Parse explicit, machine-readable semantic markers out of a JSDoc comment.
 *
 * Markers are the ONLY way code declares semantic intent to semctx. Nothing here is
 * inferred: a capability/invariant/contract exists because the author wrote a tag.
 *
 *   @capability reservation-confirmation
 *   @invariant confirmed-never-exceeds-capacity: confirming must never overbook a slot
 *   @contract reservation-repository-port: getSlot / save / ...
 *   @risk overbooking-on-concurrency: read-then-write without a guard
 *   @boundedContext booking
 */

export type MarkerTag = "capability" | "invariant" | "contract" | "risk" | "boundedContext";

export interface ParsedMarker {
  tag: MarkerTag;
  slug: string;
  /** Free text after the colon, if any. Single logical line (multi-line not yet supported). */
  statement?: string;
}

const MARKER_RE =
  /@(capability|invariant|contract|risk|boundedcontext)[ \t]+([A-Za-z0-9][A-Za-z0-9_-]*)[ \t]*(?::[ \t]*([^\r\n*][^\r\n]*))?/gi;

function normalizeTag(raw: string): MarkerTag {
  const lower = raw.toLowerCase();
  if (lower === "boundedcontext") return "boundedContext";
  return lower as MarkerTag;
}

/** Strip JSDoc framing (`/**`, `*​/`, leading `* `) so tags are easy to scan. */
export function stripJsDoc(comment: string): string {
  return comment
    .replace(/^\s*\/\*\*?/, "")
    .replace(/\*\/\s*$/, "")
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*\*[ \t]?/, "").trimEnd())
    .join("\n");
}

export function parseMarkers(commentText: string): ParsedMarker[] {
  const text = stripJsDoc(commentText);
  const markers: ParsedMarker[] = [];
  MARKER_RE.lastIndex = 0;
  let match: RegExpExecArray | null = MARKER_RE.exec(text);
  while (match !== null) {
    const rawTag = match[1];
    const slug = match[2];
    if (rawTag !== undefined && slug !== undefined) {
      const statement = match[3]?.trim();
      const marker: ParsedMarker = { tag: normalizeTag(rawTag), slug };
      if (statement !== undefined && statement.length > 0) marker.statement = statement;
      markers.push(marker);
    }
    match = MARKER_RE.exec(text);
  }
  return markers;
}
