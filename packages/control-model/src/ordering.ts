/** Locale-independent UTF-16 code-unit ordering for byte-stable Plane C output. */
export function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
