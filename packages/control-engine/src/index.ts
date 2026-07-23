export { buildCoordinateGraph } from "./coordinates";
export { InvalidRefinementRelationError } from "./coordinates";
export type { CoordinateGraphInput } from "./coordinates";
export { lift, lower, refinementCoverage, impact, explainWhy, proof } from "./traversal";
export type { TraversalBounds } from "./traversal";
export { snapshotArchitecture, compareArchitectures, architectureDeltasEqual, fingerprintCoordinateGraph } from "./architecture";
export type { SnapshotIdentity } from "./architecture";
export { compileMigrationPlan } from "./migration";
export { authorizeTransition, authorizeStep, authorizeDeletion } from "./policy";
