/**
 * Minimal, dependency-free frontmatter parser for a documented subset of YAML:
 *   - `key: scalar`
 *   - `key: [a, b, c]`  (inline flow sequence)
 *   - `key: true|false|number`
 *
 * We intentionally do NOT pull a full YAML dependency. The subset is enough for the
 * `capabilities`, `invariants`, `status`, `contradicts`, `boundedContext`, `decision`,
 * `type` keys we support, and unsupported shapes are ignored rather than guessed.
 */

export type FrontmatterValue = string | string[] | boolean | number;

export interface Frontmatter {
  data: Record<string, FrontmatterValue>;
  /** Line (1-based) where the document body begins after the closing `---`. */
  bodyStartLine: number;
  body: string;
}

const DELIMITER = /^---\s*$/;

function parseScalar(raw: string): FrontmatterValue {
  const value = raw.trim().replace(/^["']|["']$/g, "");
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return value;
}

function parseValue(raw: string): FrontmatterValue {
  const trimmed = raw.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    const inner = trimmed.slice(1, -1).trim();
    if (inner.length === 0) return [];
    return inner.split(",").map((item) => String(parseScalar(item)));
  }
  return parseScalar(trimmed);
}

export function parseFrontmatter(source: string): Frontmatter {
  const lines = source.split(/\r?\n/);
  if (lines.length === 0 || lines[0] === undefined || !DELIMITER.test(lines[0])) {
    return { data: {}, bodyStartLine: 1, body: source };
  }

  const data: Record<string, FrontmatterValue> = {};
  let closingIndex = -1;
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === undefined) continue;
    if (DELIMITER.test(line)) {
      closingIndex = i;
      break;
    }
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    if (key.length === 0) continue;
    data[key] = parseValue(line.slice(colon + 1));
  }

  if (closingIndex === -1) {
    return { data: {}, bodyStartLine: 1, body: source };
  }

  const body = lines.slice(closingIndex + 1).join("\n");
  return { data, bodyStartLine: closingIndex + 2, body };
}

/** Coerce a frontmatter value to a string array (single scalar -> singleton). */
export function asStringArray(value: FrontmatterValue | undefined): string[] {
  if (value === undefined) return [];
  if (Array.isArray(value)) return value;
  return [String(value)];
}
