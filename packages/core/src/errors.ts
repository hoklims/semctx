export type SemctxErrorCode =
  | "CONFIG_NOT_FOUND"
  | "CONFIG_INVALID"
  | "REPO_NOT_INDEXED"
  | "INDEX_HEALTH_CURSOR_INVALID"
  | "INDEX_HEALTH_CURSOR_STALE"
  | "INDEX_HEALTH_RESPONSE_TOO_LARGE"
  | "TASK_NOT_FOUND"
  | "INVALID_TASK_INPUT"
  | "ANALYSIS_FAILED"
  | "STORE_ERROR"
  | "FEEDBACK_CONFLICT"
  | "GIT_ERROR"
  | "GIT_BASE_UNAVAILABLE"
  | "CONTROL_INPUTS_UNSAFE"
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

export interface ErrorWithSuppressed extends Error {
  readonly suppressed: readonly Error[];
}

function normalizeError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function previousSuppressed(error: Error): readonly Error[] {
  try {
    const value = (error as Partial<ErrorWithSuppressed>).suppressed;
    return Array.isArray(value) ? value.filter((item): item is Error => item instanceof Error) : [];
  } catch {
    return [];
  }
}

function errorEvidence(error: Error): unknown {
  return error instanceof SemctxError
    ? error.toJSON()
    : { name: error.name, message: error.message };
}

/** Preserve a primary failure as the cause while retaining structured secondary cleanup failures. */
export function attachSuppressedError(primary: unknown, suppressed: unknown): ErrorWithSuppressed {
  const primaryError = normalizeError(primary);
  const suppressedError = normalizeError(suppressed);
  const failures = [...previousSuppressed(primaryError), suppressedError];
  const combined = primaryError instanceof SemctxError
    ? new SemctxError(primaryError.code, primaryError.message, {
      ...primaryError.details,
      suppressed: failures.map(errorEvidence),
    })
    : new Error(primaryError.message, { cause: primaryError });
  combined.name = primaryError.name;
  if (primaryError instanceof SemctxError) {
    Object.defineProperty(combined, "cause", { value: primaryError });
  }
  Object.defineProperty(combined, "suppressed", { value: failures });
  return combined as ErrorWithSuppressed;
}
