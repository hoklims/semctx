export interface CampaignCase {
  name: string;
  indices: number[];
  mode: "raw" | "primitive" | "live-external";
  request: Record<string, unknown>;
  oracleInput: Record<string, unknown>;
  checks: {
    name: string;
    actual: (string | number)[];
    expected: (string | number)[];
    comparison?: "unordered";
    transform?: "outline-statements-without-digest" | "native-reasons" | "logical-call-edges" | "outline-digest-relation" | "opaque-callback-reason" | "construction-reason" | "call-edge-count";
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
