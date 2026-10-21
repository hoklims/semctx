import { normalizePath } from "@semantic-context/core";
import { parseFrontmatter, asStringArray } from "./frontmatter";

export interface ExtractedDoc {
  relPath: string;
  title: string;
  type: string;
  boundedContext?: string;
  status?: string;
  deprecated: boolean;
  capabilities: string[];
  invariants: string[];
  decision?: string;
  /** Normalised paths or slugs this document declares itself to contradict. */
  contradicts: string[];
  frontmatterEndLine: number;
}

const HEADING_RE = /^#\s+(.+)$/m;

function titleOf(body: string, fallback: string): string {
  const match = HEADING_RE.exec(body);
  const captured = match?.[1];
  return captured !== undefined ? captured.trim() : fallback;
}

export function extractDoc(relPath: string, content: string): ExtractedDoc {
  const { data, body, bodyStartLine } = parseFrontmatter(content);

  const status = typeof data["status"] === "string" ? (data["status"] as string) : undefined;
  const boundedContext =
    typeof data["boundedContext"] === "string" ? (data["boundedContext"] as string) : undefined;
  const decision = typeof data["decision"] === "string" ? (data["decision"] as string) : undefined;
  const type = typeof data["type"] === "string" ? (data["type"] as string) : "doc";

  return {
    relPath: normalizePath(relPath),
    title: titleOf(body, relPath),
    type,
    ...(boundedContext !== undefined ? { boundedContext } : {}),
    ...(status !== undefined ? { status } : {}),
    deprecated: status === "deprecated" || data["deprecated"] === true,
    capabilities: asStringArray(data["capabilities"]),
    invariants: asStringArray(data["invariants"]),
    ...(decision !== undefined ? { decision } : {}),
    contradicts: asStringArray(data["contradicts"]).map((c) => normalizePath(c)),
    frontmatterEndLine: bodyStartLine,
  };
}
