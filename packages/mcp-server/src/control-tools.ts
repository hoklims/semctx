/** Thin Plane C MCP transport over the shared application services. */

import {
  controlStatus,
  planControlMigration,
  queryControlArchitectureComparison,
  queryControlDeletionAuthorization,
  queryControlExplanation,
  queryControlGraph,
  queryControlImpact,
  queryControlRefinementCoverage,
  queryControlStepAuthorization,
  queryControlTransitionAuthorization,
  queryControlTraversal,
  traceControl,
  type DeletionAuthorizationQueryV1,
  type ExplanationQueryV1,
  type ImpactQueryV1,
  type RefinementCoverageQueryV1,
  type StepAuthorizationQueryV1,
  type TransitionAuthorizationQueryV1,
  type TraversalQueryV1,
} from "@semantic-context/app-services";
import type {
  ArchitectureDelta,
  ArchitectureSnapshot,
  ControlFreshnessStatusReport,
  MigrationPlanReport,
  QualifiedCoordinateId,
  SemanticLevel,
  TraversalDirection,
  TraversalReportV2,
  ControlQueryEnvelopeV1,
} from "@semantic-context/control-model";

export interface ControlTraceInput {
  sourceId: QualifiedCoordinateId;
  targetLevel?: SemanticLevel;
  direction?: TraversalDirection;
  maxDepth?: number;
  maxResults?: number;
}

export interface ControlPlanInput {
  changeId: string;
  target?: ArchitectureSnapshot;
  delta?: ArchitectureDelta;
}

export function controlStatusTool(root: string): ControlFreshnessStatusReport {
  return controlStatus(root);
}

export function controlTraceTool(root: string, input: ControlTraceInput): TraversalReportV2 {
  return traceControl(root, input);
}

export function controlPlanTool(root: string, input: ControlPlanInput): MigrationPlanReport {
  return planControlMigration(root, input);
}

export function controlGraphTool(root: string): Extract<ControlQueryEnvelopeV1, { kind: "coordinate_graph" }> {
  return queryControlGraph(root);
}

export function controlTraversalTool(
  root: string,
  input: TraversalQueryV1,
): Extract<ControlQueryEnvelopeV1, { kind: "traversal" }> {
  return queryControlTraversal(root, input);
}

export function controlRefinementCoverageTool(
  root: string,
  input: RefinementCoverageQueryV1,
): Extract<ControlQueryEnvelopeV1, { kind: "refinement_coverage" }> {
  return queryControlRefinementCoverage(root, input);
}

export function controlImpactTool(
  root: string,
  input: ImpactQueryV1,
): Extract<ControlQueryEnvelopeV1, { kind: "impact" }> {
  return queryControlImpact(root, input);
}

export function controlExplainWhyTool(
  root: string,
  input: ExplanationQueryV1,
): Extract<ControlQueryEnvelopeV1, { kind: "explanation" }> {
  return queryControlExplanation(root, input);
}

export function controlArchitectureComparisonTool(
  root: string,
  target: ArchitectureSnapshot,
): Extract<ControlQueryEnvelopeV1, { kind: "architecture_comparison" }> {
  return queryControlArchitectureComparison(root, target);
}

export function controlAuthorizeTransitionTool(
  root: string,
  input: TransitionAuthorizationQueryV1,
): Extract<ControlQueryEnvelopeV1, { kind: "authorize_transition" }> {
  return queryControlTransitionAuthorization(root, input);
}

export function controlAuthorizeStepTool(
  root: string,
  input: StepAuthorizationQueryV1,
): Extract<ControlQueryEnvelopeV1, { kind: "authorize_step" }> {
  return queryControlStepAuthorization(root, input);
}

export function controlAuthorizeDeletionTool(
  root: string,
  input: DeletionAuthorizationQueryV1,
): Extract<ControlQueryEnvelopeV1, { kind: "authorize_deletion" }> {
  return queryControlDeletionAuthorization(root, input);
}
