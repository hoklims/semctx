import type { CampaignCase } from "./t00-ts7-q-syntax-types.js";

export const replacesIndices = [184];

export const cases: CampaignCase[] = [
  ["named", "function left() {} left(); export {};"],
  ["parenthesized", "function left() {} (((left)))(); export {};"],
  ["conditional", "function left() {} function right() {} (true ? left : right)(); export {};"],
  ["tagged", "function tag() {} tag`value`; export {};"],
  ["ordinary-tag-call", "function tag() {} tag(); export {};"],
].map(([name, source]) => ({
  name: `checker-parsing-${name}`,
  indices: [184], mode: "raw",
  request: { files: { "main.ts": source }, roots: ["main.ts"], retained: true, qualified: false },
  oracleInput: { operation: "syntax", filename: "main.ts", source },
  checks: [
    { name: "source-reasons", actual: ["subjects", 0, "moduleConfigurationObservations", "retainedWithSource", "reasons"],
      expected: ["observation", "moduleConfigurationReasons"] },
    { name: "source-executed", actual: ["subjects", 0, "moduleConfigurationObservations", "retainedWithSource", "executed"],
      expected: ["observation", "executed"] },
    { name: "source-support", actual: ["subjects", 0, "moduleConfigurationObservations", "retainedWithSource", "unsupported"],
      expected: ["observation", "unsupported"] },
  ],
}));

export const propertyWitnesses: Record<number, Record<string, string[]>> = {
  184: { "TS dynamic versus named callee and tagged template versus call": cases.map(item => item.name) },
};
