/** Public surface of @semantic-context/semantic-dsl — parse, format and render `.sem` sources. */

export type { Diagnostic, DiagnosticSeverity } from "./diagnostics";
export { formatDiagnostic, hasErrors } from "./diagnostics";

export { parseSemanticSource } from "./parse";
export type { ParseResult } from "./parse";

export { formatNode, formatChange, formatModel } from "./format";

export { renderNode, renderChange, renderModel } from "./render";
export type { Notation } from "./render";
