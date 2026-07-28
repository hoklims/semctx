import { canonicalJson } from "./canonical";
import type { PlaneASidecarV1 } from "./model";

const sidecars = new WeakMap<object, PlaneASidecarV1>();

export class PlaneACaptureChangedError extends Error {
  readonly code = "CAPTURE_CHANGED_DURING_ANALYSIS";

  constructor(
    readonly coordinate: string,
    readonly expected: unknown,
    readonly actual: unknown,
  ) {
    super(`Plane A capture changed during analysis at ${coordinate}`);
    this.name = "PlaneACaptureChangedError";
  }
}

export function assertStableCapture(
  before: Readonly<Record<string, unknown>>,
  after: Readonly<Record<string, unknown>>,
): void {
  const coordinates = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  for (const coordinate of coordinates) {
    const expected = before[coordinate];
    const actual = after[coordinate];
    if (canonicalJson(expected) !== canonicalJson(actual)) {
      throw new PlaneACaptureChangedError(coordinate, expected, actual);
    }
  }
}

export function attachPlaneASidecar<T extends object>(result: T, sidecar: PlaneASidecarV1): T {
  sidecars.set(result, sidecar);
  return result;
}

export function getPlaneASidecar(result: object): PlaneASidecarV1 | undefined {
  return sidecars.get(result);
}
