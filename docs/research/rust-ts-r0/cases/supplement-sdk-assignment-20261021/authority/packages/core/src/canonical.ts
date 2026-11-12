/**
 * Canonical JSON + content digest, used to detect drift in locally recorded identities (a report
 * or a finding that changed content since a feedback record was created against it). Deliberately
 * independent from `@semantic-context/plane-a-internal`'s own copy: `core` has zero internal
 * dependencies (the leaf of the workspace), so this stays a small local primitive rather than an
 * import that would invert the dependency direction.
 */
import { createHash } from "node:crypto";

type CanonicalValue = null | string | number | boolean | CanonicalValue[] | { [key: string]: CanonicalValue };

function canonicalize(value: unknown): CanonicalValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("canonical values require finite numbers");
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object") {
    const result = Object.create(null) as Record<string, CanonicalValue>;
    for (const key of Object.keys(value).sort()) {
      const member = (value as Record<string, unknown>)[key];
      if (member !== undefined) result[key] = canonicalize(member);
    }
    return result;
  }
  throw new TypeError(`unsupported canonical value type: ${typeof value}`);
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function digestCanonical(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}
