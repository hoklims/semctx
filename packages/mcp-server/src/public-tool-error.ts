export type ToolPublicErrorCode =
  | "INTERNAL_ERROR"
  | "INVALID_ARGUMENTS"
  | "INVALID_OUTPUT"
  | "RESPONSE_TOO_LARGE"
  | "REPOSITORY_ROOT_INVALID"
  | "REPOSITORY_ROOT_UNAVAILABLE"
  | "REPOSITORY_ROOT_MISMATCH";

/** A stable code plus internal-only cause; raw messages never cross MCP. */
export class ToolPublicError extends Error {
  constructor(
    readonly code: ToolPublicErrorCode,
    options: { cause?: unknown } = {},
  ) {
    super(code, options);
    this.name = "ToolPublicError";
  }
}
