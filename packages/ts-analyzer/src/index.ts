/** Public surface of @semantic-context/ts-analyzer. */
export { analyzeRepository, analyzeRepositoryAsync, assembleRepository } from "./analyze";
export type { AnalysisResult, AsyncAnalysisResult } from "./analyze";

export {
  discoverFiles,
  discoverRepository,
  countTypeScriptFiles,
  isPathSelected,
  sourceLanguage,
} from "./discovery";
export type {
  DiscoveredFile,
  DiscoveryCandidate,
  DiscoveryResult,
  FileRole,
  SourceLanguage,
} from "./discovery";

export {
  extractTypeScript,
  extractTypeScriptParallel,
  resolveWorkerCount,
  TYPESCRIPT_DIALECT_VERSION,
} from "./ts-symbols";
export type {
  TsExtraction,
  ExtractedSymbol,
  ExtractedImport,
  ExtractedCall,
  IndexWorkerSelection,
  ParallelTsExtraction,
  TypeScriptParallelism,
} from "./ts-symbols";

export {
  parseMarkers,
  stripJsDoc,
  detectMarkerDivergence,
  degradeDivergentMarkerNodes,
  degradeDivergentPlaneAFacts,
  summarizeMarkerCoverage,
} from "./markers";
export type {
  ParsedMarker,
  MarkerTag,
  MarkerDeclaration,
  MarkerDivergence,
  MarkerCoverage,
} from "./markers";

export { parseFrontmatter, asStringArray } from "./frontmatter";
export type { Frontmatter, FrontmatterValue } from "./frontmatter";

export { extractDoc } from "./docs";
export type { ExtractedDoc } from "./docs";

export { extractMigration } from "./migrations";
export type { ExtractedMigration, MigrationConstraint } from "./migrations";
