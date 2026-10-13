/**
 * Compares validated authorization instants against an integer millisecond age.
 * Fractional seconds retain their full decimal precision; no decision rule is applied.
 */
export function compareChangeAuthorizationTimestampAgeV1(verifiedAt: string, evaluatedAt: string, maxAgeMs = 0): number {
  // Some runtimes round long fractions during parsing; truncate explicitly first.
  const wholeMilliseconds = (timestamp: string): number => Date.parse(timestamp.replace(/(\.\d{3})\d+/, "$1"));
  const age = wholeMilliseconds(verifiedAt) - wholeMilliseconds(evaluatedAt);
  if (age !== maxAgeMs) return age < maxAgeMs ? -1 : 1;
  const remainder = (timestamp: string): string =>
    (/\.(\d+)(?:Z|[+-]\d{2}:?\d{2})$/.exec(timestamp)?.[1] ?? "").slice(3);
  const verifiedRemainder = remainder(verifiedAt);
  const evaluatedRemainder = remainder(evaluatedAt);
  const width = verifiedRemainder.length > evaluatedRemainder.length ? verifiedRemainder.length : evaluatedRemainder.length;
  const left = verifiedRemainder.padEnd(width, "0");
  const right = evaluatedRemainder.padEnd(width, "0");
  return left === right ? 0 : left < right ? -1 : 1;
}
