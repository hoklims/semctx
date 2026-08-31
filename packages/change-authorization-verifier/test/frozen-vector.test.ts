import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { serializeChangeAuthorizationVerificationReportV1 } from "../src/canonical";
import { verifyChangeAuthorizationCapsuleV1 } from "../src/verify";
import type { ChangeAuthorizationVerificationReportV1, ChangeAuthorizationVerificationRequestV1 } from "../src/types";

/**
 * The expected report is read from a committed fixture, never generated at test runtime through
 * `@semantic-context/control-engine` (see `fixtures/frozen-vector.generate.ts` for the manual
 * regeneration tool). This committed cross-host regression ratchet must reproduce identically on
 * every CI host. Because the generator used this verifier to create the expected report, it proves
 * byte stability and transport independence, not independent semantic correctness.
 */
const FIXTURES_DIR = join(import.meta.dir, "fixtures");

function readJson<T>(name: string): T {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, name), "utf8")) as T;
}

describe("committed cross-host request/capsule -> canonical report regression vector", () => {
  it("reproduces the exact committed report object, byte-exact JCS text, and reportHash", () => {
    const request = readJson<ChangeAuthorizationVerificationRequestV1>("frozen-request.json");
    const expectedReport = readJson<ChangeAuthorizationVerificationReportV1>("frozen-report.json");
    const expectedJcs = readFileSync(join(FIXTURES_DIR, "frozen-report.jcs.txt"), "utf8");

    const report = verifyChangeAuthorizationCapsuleV1(request);

    expect(report).toEqual(expectedReport);
    expect(report.reportHash).toBe(expectedReport.reportHash);
    expect(serializeChangeAuthorizationVerificationReportV1(report)).toBe(expectedJcs);
    expect(report.result).toBe("PASSED");
  });
});
