/** Golden-expectation spec for measuring ContextPack effectiveness. */
import type { TaskMode } from "@semantic-context/core";

export interface BenchExpectations {
  /** Paths that MUST appear in recommendedReads. */
  requiredReads?: string[];
  /** Paths that must NOT appear in recommendedReads (decoys, deprecated docs). */
  forbiddenReads?: string[];
  /** Test file paths that MUST appear in relevantTests. */
  requiredTests?: string[];
  /** Claim kinds that MUST appear among hard constraints (e.g. ["invariant"]). */
  requiredHardConstraintKinds?: string[];
  /** Substrings that MUST all appear across the impact-path descriptions. */
  requiredImpactPathContains?: string[];
  /** Substrings (lowercased) that MUST appear across the contradictions. */
  requiredContradictions?: string[];
  /** Verification statuses that must NOT appear on any authoritative/hard claim. */
  forbiddenAuthoritativeStatuses?: string[];
  /** Whether the pack must be deterministic (default true). */
  mustBeDeterministic?: boolean;
}

export interface BenchCase {
  id: string;
  task: string;
  mode?: TaskMode;
  expect: BenchExpectations;
}

export interface BenchMetric {
  name: string;
  score: number;
  passed: boolean;
  detail: string;
}

export interface BenchCaseResult {
  id: string;
  score: number;
  passed: boolean;
  metrics: BenchMetric[];
}

export interface BenchReport {
  threshold: number;
  score: number;
  passed: boolean;
  cases: BenchCaseResult[];
}
