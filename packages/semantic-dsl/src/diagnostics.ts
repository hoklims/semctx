/** Parser diagnostics: precise file/line/column pointers, never thrown — collected and returned. */

export type DiagnosticSeverity = "error" | "warning";

export interface Diagnostic {
  /** Stable machine-readable parser diagnostic. */
  code?: string;
  file: string;
  /** 1-based line. */
  line: number;
  /** 1-based column. */
  column: number;
  severity: DiagnosticSeverity;
  message: string;
}

export function formatDiagnostic(d: Diagnostic): string {
  return `${d.file}:${d.line}:${d.column}: ${d.severity}: ${d.message}`;
}

export function hasErrors(diagnostics: readonly Diagnostic[]): boolean {
  return diagnostics.some((d) => d.severity === "error");
}
