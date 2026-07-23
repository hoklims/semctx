/** Thin Plane C MCP transport over the shared application services. */

import { controlStatus, planControlMigration, traceControl } from "@semantic-context/app-services";
import type {
  ArchitectureDelta,
  ArchitectureSnapshot,
  ControlFreshnessStatusReport,
  MigrationPlanReport,
  QualifiedCoordinateId,
  SemanticLevel,
  TraversalDirection,
  TraversalReport,
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

export function controlTraceTool(root: string, input: ControlTraceInput): TraversalReport {
  return traceControl(root, input);
}

export function controlPlanTool(root: string, input: ControlPlanInput): MigrationPlanReport {
  return planControlMigration(root, input);
}
