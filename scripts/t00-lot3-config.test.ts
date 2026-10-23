import { expect, test } from "bun:test";
import { configurationChecks, fixtureSource } from "./t00-lot3-config";

test("configuration fixture accepts captured empty source and refuses an uncaptured source", () => {
  expect(fixtureSource({ id: "empty", path: "main.ts", files: { "main.ts": "" } })).toBe("");
  expect(() => fixtureSource({ id: "missing", path: "main.ts", files: {} })).toThrow("source missing from fixture missing");
});

const request = { id: "fixture", cwd: "/fixture", sdk_directory: "/sdk/lib", case_sensitive: true, files: { "/fixture/main.ts": "export {};" }, roots: ["/fixture/main.ts"], raw_files: {}, utf16_files: {} };
const sdk = { version: "5.9.3", archive_sha256: "archive", files: { "/sdk/lib/lib.d.ts": "declare const x: number;" } };
const context = { request, sdk, artifactSha256: "artifact", sdkVersion: "5.9.3", path: "main.ts", mode: "retainedWithSource" };
const observation = {
  request: "fixture", request_id: "sha256:c61b72f59ba6b3db5245559d8d4782738dbddfed20e5a37d6129ec860ec52d30", input_manifest_id: "sha256:7acbaf7c3047c1f4f2cc11336a9e52fe97ea06480bef1cb73727c3825477f668",
  producer_artifact_id: "sha256:artifact", sdk_version: "5.9.3", complete: true,
  status: "development_observation_not_qualification", engine_revision: "780dc512d64f40afebffa6a7028207649fb7ed1c", native_compiler_version: "7.1.0-dev", global_admission_inferred: false,
  subjects: [{ path: "main.ts", outcome: "analyzed", unimplemented: [], moduleConfigurationObservations: { retainedWithSource: { executed: true, unsupported: [], reasons: [] } } }],
};

test("configuration proof accepts complete exact observations", () => {
  expect(configurationChecks(observation, [], context).every(check => check.pass)).toBe(true);
});

for (const [name, changed] of [
  ["missing subject", { ...observation, subjects: [] }],
  ["foreign artifact", { ...observation, producer_artifact_id: "foreign" }],
  ["foreign request", { ...observation, request_id: "foreign" }],
  ["foreign SDK", { ...observation, sdk_version: "foreign" }],
  ["foreign SDK bytes", { ...observation, input_manifest_id: "foreign" }],
  ["global admission", { ...observation, global_admission_inferred: true }],
  ["incomplete output", { ...observation, complete: false }],
  ["component not executed", { ...observation, subjects: [{ ...observation.subjects[0], moduleConfigurationObservations: { retainedWithSource: { executed: false, unsupported: [], reasons: [] } } }] }],
  ["unsupported component", { ...observation, subjects: [{ ...observation.subjects[0], moduleConfigurationObservations: { retainedWithSource: { executed: true, unsupported: ["failure"], reasons: [] } } }] }],
] as const) {
  test(`configuration proof refuses ${name}`, () => {
    expect(configurationChecks(changed, [], context).every(check => check.pass)).toBe(false);
  });
}

test("configuration proof compares complete reasons without path normalization", () => {
  expect(configurationChecks(observation, ["SOURCE_CONFIGURATION_INVALID:5083:Cannot read file '/different/base.json'."], context).find(check => check.name === "reasons")?.pass).toBe(false);
});

test("configuration proof refuses changed SDK bytes at the same version", () => {
  expect(configurationChecks(observation, [], { ...context, sdk: { ...sdk, files: { "/sdk/lib/lib.d.ts": "declare const x: string;" } } }).find(check => check.name === "inputAndSdkIdentity")?.pass).toBe(false);
});
