import type { createRepositoryAnalyzer, DiscoveredFile, CompilerInputSnapshot, AnalysisResult } from "@semantic-context/ts-analyzer";

export interface ExperimentalTypeScriptRuntime {
  readonly analyzer: ReturnType<typeof createRepositoryAnalyzer>;
  sourceParsingReasons(file: DiscoveredFile): readonly string[];
  configurationReasons(file: DiscoveredFile): readonly string[];
  analysisReasons(file: DiscoveredFile): readonly string[];
  bindOwnership(analysis: AnalysisResult, inputs: CompilerInputSnapshot): Promise<void>;
  revalidate(analysis: AnalysisResult, inputs: CompilerInputSnapshot): Promise<void>;
}
