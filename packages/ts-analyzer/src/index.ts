/** Public surface of @semantic-context/ts-analyzer. */
export { analyzeRepository } from "./analyze";
export type { AnalysisResult } from "./analyze";

export { discoverFiles } from "./discovery";
export type { DiscoveredFile, FileRole } from "./discovery";

export { extractTypeScript } from "./ts-symbols";
export type {
  TsExtraction,
  ExtractedSymbol,
  ExtractedImport,
  ExtractedCall,
} from "./ts-symbols";

export { parseMarkers, stripJsDoc } from "./markers";
export type { ParsedMarker, MarkerTag } from "./markers";

export { parseFrontmatter, asStringArray } from "./frontmatter";
export type { Frontmatter, FrontmatterValue } from "./frontmatter";

export { extractDoc } from "./docs";
export type { ExtractedDoc } from "./docs";

export { extractMigration } from "./migrations";
export type { ExtractedMigration, MigrationConstraint } from "./migrations";
