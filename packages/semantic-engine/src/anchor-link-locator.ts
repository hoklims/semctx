/**
 * Locate every `link` field's ref, in whichever of the three syntaxes the author used, as an exact
 * character span inside the line that carries it.
 *
 * This mirrors the subset of `parseSemanticSource`'s tokenizer that decides where a `link` field's
 * value lives — scalar (`link: <ref>`), block list (`link:` then `  - <ref>` lines) and inline list
 * (`link: [<ref>, <ref>]`) — because the migration rewrites text, not a re-serialized model, and a
 * locator that disagreed with the parser about where a ref sits would rewrite the wrong bytes. Any
 * line neither this locator nor the tokenizer above it recognises is left untouched; the caller
 * cross-checks the outcome by reparsing, so a genuine disagreement between the two surfaces as a
 * global refusal rather than a silent corruption.
 */

export type LinkRefForm = "scalar" | "block_list" | "inline_list";

export interface LocatedLinkRef {
  /** 0-based index into the line array the locator was given. */
  lineIndex: number;
  /** Character offset of the ref's first character within that line's text (terminator excluded). */
  start: number;
  /** Character offset one past the ref's last character. */
  end: number;
  ref: string;
  form: LinkRefForm;
}

/**
 * Mirrors `parse.ts` lines ~96-193: indent-0 starts a block and clears the list key, a blank/comment
 * line clears it, a `- item` line consumes it, and any other field line replaces it. Only the
 * consequences that matter for locating `link` spans are kept — block-kind and id validation, scalar
 * fields, tags/meta/relations, and the `change ... target` special case, are irrelevant here and
 * intentionally not reproduced, because the outcome that matters is "was the preceding key `link`",
 * not the full parse tree.
 */
export function locateLinkRefs(lineTexts: readonly string[]): LocatedLinkRef[] {
  const out: LocatedLinkRef[] = [];
  let inBlock = false;
  let listKey: string | undefined;

  for (let lineIndex = 0; lineIndex < lineTexts.length; lineIndex += 1) {
    const raw = lineTexts[lineIndex] ?? "";
    const trimmed = raw.trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      listKey = undefined;
      continue;
    }

    let indent = 0;
    while (indent < raw.length && (raw[indent] === " " || raw[indent] === "\t")) indent += 1;
    const content = raw.slice(indent);

    if (indent === 0) {
      // A header line, `<kind> <id>`. Whether it is a *valid* kind is the tokenizer's job; all this
      // locator needs is that indent-0 always starts a new block and always clears the list key.
      inBlock = true;
      listKey = undefined;
      continue;
    }

    if (!inBlock) continue;

    if (content.startsWith("-")) {
      if (listKey !== "link") continue;
      const dashEnd = 1;
      let itemStart = indent + dashEnd;
      while (itemStart < raw.length && (raw[itemStart] === " " || raw[itemStart] === "\t")) itemStart += 1;
      let itemEnd = raw.length;
      while (itemEnd > itemStart && /\s/.test(raw[itemEnd - 1] ?? "")) itemEnd -= 1;
      if (itemEnd > itemStart) {
        out.push({ lineIndex, start: itemStart, end: itemEnd, ref: raw.slice(itemStart, itemEnd), form: "block_list" });
      }
      continue;
    }

    // Special-cased in the tokenizer for `change` blocks; never a `link` field, so just clear state
    // the same way the tokenizer does and move on.
    if (content === "target" || content.startsWith("target ") || content.startsWith("target:")) {
      listKey = undefined;
      continue;
    }

    const colon = content.indexOf(":");
    if (colon === -1) {
      listKey = undefined;
      continue;
    }
    const key = content.slice(0, colon).trim();
    const valueStartInContent = colon + 1;
    const afterColon = content.slice(valueStartInContent);
    const value = afterColon.trim();

    if (value === "") {
      // Bare key: begins a block list. Only tracked when it is `link` — everything else is opaque to
      // this locator by design.
      listKey = key === "link" ? "link" : undefined;
      continue;
    }
    listKey = undefined;
    if (key !== "link") continue;

    const lineBase = indent + valueStartInContent;
    const inlineList = value.startsWith("[") && value.endsWith("]");
    if (inlineList) {
      // Walk the bracket interior once, splitting on top-level commas, and report each trimmed
      // segment's span relative to the original line — the same segmentation `parse.ts` performs on
      // `inner.split(",")`, just with positions kept instead of discarded.
      const openInContent = afterColon.indexOf("[");
      const innerStartInContent = valueStartInContent + openInContent + 1;
      const closeInContent = afterColon.lastIndexOf("]");
      const innerEndInContent = valueStartInContent + closeInContent;
      const inner = content.slice(innerStartInContent, innerEndInContent);
      let cursor = 0;
      const parts = inner.split(",");
      for (const part of parts) {
        const partStartInInner = cursor;
        cursor += part.length + 1; // +1 for the comma consumed by split
        let s = partStartInInner;
        let e = partStartInInner + part.length;
        while (s < e && /\s/.test(part[s - partStartInInner] ?? "")) s += 1;
        while (e > s && /\s/.test(part[e - partStartInInner - 1] ?? "")) e -= 1;
        if (e <= s) continue;
        const absStart = indent + innerStartInContent + s;
        const absEnd = indent + innerStartInContent + e;
        out.push({ lineIndex, start: absStart, end: absEnd, ref: raw.slice(absStart, absEnd), form: "inline_list" });
      }
      continue;
    }

    // Scalar form: the value, trimmed, is the whole ref.
    let s = 0;
    let e = afterColon.length;
    while (s < e && /\s/.test(afterColon[s] ?? "")) s += 1;
    while (e > s && /\s/.test(afterColon[e - 1] ?? "")) e -= 1;
    const absStart = lineBase + s;
    const absEnd = lineBase + e;
    out.push({ lineIndex, start: absStart, end: absEnd, ref: raw.slice(absStart, absEnd), form: "scalar" });
  }

  return out;
}

/**
 * Apply a set of same-line-safe replacements to line texts, latest-in-line first so earlier offsets
 * on a line already touched stay valid. `replacements` maps a located ref (by identity) to its
 * replacement text; refs not present in the map are left alone.
 */
export function applyLocatedReplacements(
  lineTexts: readonly string[],
  replacements: ReadonlyMap<LocatedLinkRef, string>,
): string[] {
  const byLine = new Map<number, { span: LocatedLinkRef; text: string }[]>();
  for (const [span, text] of replacements) {
    const list = byLine.get(span.lineIndex) ?? [];
    list.push({ span, text });
    byLine.set(span.lineIndex, list);
  }
  return lineTexts.map((line, index) => {
    const edits = byLine.get(index);
    if (edits === undefined) return line;
    edits.sort((a, b) => b.span.start - a.span.start);
    let out = line;
    for (const { span, text } of edits) {
      out = `${out.slice(0, span.start)}${text}${out.slice(span.end)}`;
    }
    return out;
  });
}
