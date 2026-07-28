import type { ArtifactScope } from "./model";

export interface PlaneAAdmissibilityRequest {
  task: string;
  operation: string;
  factKind: string;
  scope: ArtifactScope;
}

export interface PlaneAAdmissibilityDecision {
  admissible: boolean;
  reasons: readonly string[];
}

/**
 * Private provisional task policy. Earlier gates own discovery, binding, freshness,
 * capability and completeness; this function decides only whether the exact tuple may
 * participate in the named operation.
 */
export function admissibleFor(
  request: PlaneAAdmissibilityRequest,
): PlaneAAdmissibilityDecision {
  const exactCoordinates =
    request.factKind.length > 0
    && request.scope.repositoryIdentity.length > 0
    && request.scope.selectedPaths.length > 0;
  if (!exactCoordinates) {
    return { admissible: false, reasons: ["EXACT_COORDINATES_REQUIRED"] };
  }
  if (request.task === "verify" && request.operation === "change") {
    return { admissible: true, reasons: [] };
  }
  if (request.task === "index-health" && request.operation === "inspect") {
    return { admissible: true, reasons: [] };
  }
  return {
    admissible: false,
    reasons: ["TASK_OPERATION_NOT_ADMITTED"],
  };
}
