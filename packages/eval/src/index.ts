/** Public surface of @semantic-context/eval. */
export type {
  BenchExpectations,
  BenchCase,
  BenchMetric,
  BenchCaseResult,
  BenchReport,
} from "./spec";
export { scoreCase } from "./scorer";
export { runBench } from "./run";
export type { RunBenchArgs } from "./run";
