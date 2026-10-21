import { normalizePath } from "@semantic-context/core";

export interface MigrationConstraint {
  invariantSlug: string;
  statement?: string;
  line: number;
}

export interface ExtractedMigration {
  relPath: string;
  /** Table names created by the migration (best-effort, `CREATE TABLE <name>`). */
  tables: string[];
  constraints: MigrationConstraint[];
}

const CONSTRAINT_RE =
  /--\s*@constraint[ \t]+([A-Za-z0-9][A-Za-z0-9_-]*)[ \t]*(?::[ \t]*([^\r\n]*))?/gi;
const CREATE_TABLE_RE = /create\s+table\s+(?:if\s+not\s+exists\s+)?["'`]?([A-Za-z0-9_]+)["'`]?/gi;

export function extractMigration(relPath: string, content: string): ExtractedMigration {
  const lines = content.split(/\r?\n/);
  const constraints: MigrationConstraint[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === undefined) continue;
    CONSTRAINT_RE.lastIndex = 0;
    const match = CONSTRAINT_RE.exec(line);
    const slug = match?.[1];
    if (slug !== undefined) {
      const statement = match?.[2]?.trim();
      constraints.push({
        invariantSlug: slug,
        ...(statement !== undefined && statement.length > 0 ? { statement } : {}),
        line: i + 1,
      });
    }
  }

  const tables: string[] = [];
  CREATE_TABLE_RE.lastIndex = 0;
  let tableMatch: RegExpExecArray | null = CREATE_TABLE_RE.exec(content);
  while (tableMatch !== null) {
    const name = tableMatch[1];
    if (name !== undefined) tables.push(name);
    tableMatch = CREATE_TABLE_RE.exec(content);
  }

  return { relPath: normalizePath(relPath), tables, constraints };
}
