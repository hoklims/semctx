export interface CampaignCase {
  name: string;
  indices: number[];
  mode: "raw" | "primitive";
  request: Record<string, unknown>;
  oracleInput: Record<string, unknown>;
  checks: {
    name: string;
    actual: (string | number)[];
    expected: (string | number)[];
    transform?: "outline-statements-without-digest";
  }[];
  gaps?: Record<number, string>;
}

export interface FileRef {
  path: string;
  sha256: string;
  bytes: number;
}

export interface PlatformArtifacts {
  producer: FileRef;
  helper: FileRef;
  sdk: FileRef;
  observer: FileRef;
  oracle: FileRef;
  oracleLibraries: FileRef;
  syntaxOracle: FileRef;
}

export interface CandidateManifest {
  schemaVersion: 1;
  sourceCommit: string;
  purpose?: "rehearsal" | "qualification";
  platforms: Partial<Record<"macos" | "linux", PlatformArtifacts>>;
}
