import { describe, expect, it } from "bun:test";
import {
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  serializeChangeAuthorizationVerificationReportV1,
  verifyChangeAuthorizationCapsuleV1,
  type ChangeAuthorizationVerificationRequestV1,
} from "@semantic-context/change-authorization-verifier";
import { evaluateChangeAuthorizationV1 } from "@semantic-context/control-engine";
import type { ChangeAuthorizationCapsuleV1 } from "@semantic-context/control-model";
import { CONTROL_VERIFY_AUTHORIZATION_HELP } from "../src/commands/control-verify-authorization";
import { baseEvaluationInput, record } from "../../../packages/change-authorization-verifier/test/fixtures";

const CLI = join(import.meta.dir, "..", "src", "index.ts");

function requestFor(
  capsule: ChangeAuthorizationCapsuleV1,
  overrides: Partial<ChangeAuthorizationVerificationRequestV1> = {},
): ChangeAuthorizationVerificationRequestV1 {
  return {
    schemaVersion: 1,
    capsule,
    expectedAuthorityDescriptorDigest: capsule.authorityDescriptor.descriptorDigest,
    verifiedAt: capsule.evaluatedAt,
    ...overrides,
  };
}

function temporaryJson(name: string, value: unknown): { directory: string; file: string } {
  const directory = mkdtempSync(join(tmpdir(), "semctx-cli-verify-authorization-"));
  const file = join(directory, name);
  writeFileSync(file, JSON.stringify(value), "utf8");
  return { directory, file };
}

function runCli(root: string, argv: readonly string[]): { code: number; out: string; err: string } {
  const process = Bun.spawnSync(["bun", "run", CLI, ...argv, "--root", root], { stdout: "pipe", stderr: "pipe" });
  return {
    code: process.exitCode ?? 1,
    out: new TextDecoder().decode(process.stdout),
    err: new TextDecoder().decode(process.stderr),
  };
}

describe("control verify-authorization CLI transport", () => {
  it("documents a read-only, exit-coded, host-independent verification command", () => {
    expect(CONTROL_VERIFY_AUTHORIZATION_HELP).toContain("verify-authorization <request.json>");
    expect(CONTROL_VERIFY_AUTHORIZATION_HELP).toContain("read-only");
    expect(CONTROL_VERIFY_AUTHORIZATION_HELP).toContain("grants no execution authority");
  });

  it("PASSES a genuine ALLOW capsule and emits the exact library JCS payload, exit 0", () => {
    const capsule = evaluateChangeAuthorizationV1(baseEvaluationInput());
    const request = requestFor(capsule);
    const expected = verifyChangeAuthorizationCapsuleV1(request);
    const { directory, file } = temporaryJson("request.json", request);
    try {
      const result = runCli(directory, ["control", "verify-authorization", file]);
      expect(result.code, result.err).toBe(0);
      expect(result.out).toBe(`${serializeChangeAuthorizationVerificationReportV1(expected)}\n`);
      expect(JSON.parse(result.out)).toEqual(JSON.parse(serializeChangeAuthorizationVerificationReportV1(expected)));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("exits 3 for REQUIRE_EVIDENCE when the caller supplies no external authority pin", () => {
    const capsule = evaluateChangeAuthorizationV1(baseEvaluationInput());
    const request = requestFor(capsule, { expectedAuthorityDescriptorDigest: null });
    const { directory, file } = temporaryJson("request.json", request);
    try {
      const result = runCli(directory, ["control", "verify-authorization", file]);
      expect(result.code, result.err).toBe(3);
      expect(JSON.parse(result.out)).toMatchObject({ result: "REQUIRE_EVIDENCE" });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("exits 3 for FAILED when the basis reconciliation is VIOLATED", () => {
    const capsule = evaluateChangeAuthorizationV1(baseEvaluationInput({ basisRecord: record("VIOLATED") }));
    const request = requestFor(capsule);
    const { directory, file } = temporaryJson("request.json", request);
    try {
      const result = runCli(directory, ["control", "verify-authorization", file]);
      expect(result.code, result.err).toBe(3);
      expect(JSON.parse(result.out)).toMatchObject({ result: "FAILED" });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("exits 1 on a malformed request envelope, producing no report", () => {
    const { directory, file } = temporaryJson("bad-request.json", { schemaVersion: 1, capsule: {} });
    try {
      const result = runCli(directory, ["control", "verify-authorization", file]);
      expect(result.code).toBe(1);
      expect(result.err).toContain("failed its public schema");
      expect(result.out).toBe("");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects help and unknown options instead of turning verification into exit 0", () => {
    const capsule = evaluateChangeAuthorizationV1(baseEvaluationInput());
    const { directory, file } = temporaryJson("request.json", requestFor(capsule));
    try {
      const helpResult = runCli(directory, [
        "control", "verify-authorization", "missing-request.json", "--help",
      ]);
      expect(helpResult.code).toBe(1);
      expect(helpResult.out).toBe("");
      expect(helpResult.err).toContain("unsupported option");

      const unknownResult = runCli(directory, [
        "control", "verify-authorization", file, "--bogus",
      ]);
      expect(unknownResult.code).toBe(1);
      expect(unknownResult.out).toBe("");
      expect(unknownResult.err).toContain("--bogus");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("exits 1 on a calendar-impossible verifiedAt (no evaluated instant, no report)", () => {
    const capsule = evaluateChangeAuthorizationV1(baseEvaluationInput());
    for (const impossible of ["2026-02-30T12:00:00Z", "2026-01-01T24:00:00Z"]) {
      const request = requestFor(capsule, { verifiedAt: impossible });
      const { directory, file } = temporaryJson("request.json", request);
      try {
        const result = runCli(directory, ["control", "verify-authorization", file]);
        expect(result.code, result.err).toBe(1);
        expect(result.err).toContain("failed its public schema");
        expect(result.out).toBe("");
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  });

  it("exits 1 when verifiedAt predates capsule.evaluatedAt, producing no promoted report", () => {
    const capsule = evaluateChangeAuthorizationV1(baseEvaluationInput({
      evaluatedAt: "2026-10-01T10:00:00.000Z",
    }));
    expect(capsule.verdict).toBe("REQUIRE_EVIDENCE");
    const request = requestFor(capsule, { verifiedAt: "2026-08-14T00:00:00.000Z" });
    const { directory, file } = temporaryJson("backward-time-request.json", request);
    try {
      const result = runCli(directory, ["control", "verify-authorization", file]);
      expect(result.code, result.err).toBe(1);
      expect(result.err).toContain("verifiedAt must not precede capsule.evaluatedAt");
      expect(result.out).toBe("");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("is pure transport: run from a directory with no .git/.semctx and create no new files", () => {
    const capsule = evaluateChangeAuthorizationV1(baseEvaluationInput());
    const request = requestFor(capsule);
    const { directory, file } = temporaryJson("request.json", request);
    try {
      const before = readdirSync(directory).sort();
      const result = runCli(directory, ["control", "verify-authorization", file]);
      const after = readdirSync(directory).sort();
      expect(result.code, result.err).toBe(0);
      expect(after).toEqual(before);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
