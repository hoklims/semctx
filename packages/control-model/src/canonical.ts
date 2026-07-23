/** Stable JSON for public reports: object keys are sorted recursively. Array order remains semantic. */
export function serializeControlReport(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function canonicalizeControlValue(value: unknown): unknown {
  return canonicalize(value);
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => compareCodeUnits(left, right))
        .map(([key, nested]) => [key, canonicalize(nested)]),
    );
  }
  return value;
}
import { compareCodeUnits } from "./ordering";
