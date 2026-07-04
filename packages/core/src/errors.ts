export type SemctxErrorCode =
  | "CONFIG_NOT_FOUND"
  | "CONFIG_INVALID"
  | "REPO_NOT_INDEXED"
  | "TASK_NOT_FOUND"
  | "INVALID_TASK_INPUT"
  | "ANALYSIS_FAILED"
  | "STORE_ERROR"
  | "GIT_ERROR"
  | "GIT_BASE_UNAVAILABLE"
  | "IO_ERROR"
  | "UNSUPPORTED";

export interface SemctxErrorJSON {
  name: "SemctxError";
  code: SemctxErrorCode;
  message: string;
  details: Record<string, unknown>;
}

export class SemctxError extends Error {
  readonly code: SemctxErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: SemctxErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "SemctxError";
    this.code = code;
    this.details = details;
  }

  toJSON(): SemctxErrorJSON {
    return { name: "SemctxError", code: this.code, message: this.message, details: this.details };
  }
}

export function isSemctxError(value: unknown): value is SemctxError {
  return value instanceof SemctxError;
}
