/**
 * Manual, one-time regeneration tool for the frozen external vector consumed by
 * `frozen-vector.test.ts`. Not auto-discovered by the repository's `bun test` sweep (the filename
 * has no `.test.` segment); run it explicitly:
 *
 *   bun test packages/change-authorization-verifier/test/fixtures/frozen-vector.generate.ts
 *
 * Regenerate ONLY when the verification algorithm intentionally changes and is independently
 * proven. The committed files are a cross-host, byte-stable regression ratchet, not an independent
 * semantic oracle: this generator creates expected output with the verifier under test. Assertion
 * time never calls `@semantic-context/control-engine`.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { evaluateChangeAuthorizationV1 } from "@semantic-context/control-engine";
import {
  serializeChangeAuthorizationVerificationReportV1,
  verifyChangeAuthorizationCapsuleV1,
} from "../../src";
import { baseEvaluationInput } from "../fixtures";

const FIXTURES_DIR = import.meta.dir;

const capsule = evaluateChangeAuthorizationV1(baseEvaluationInput());
const request = {
  schemaVersion: 1 as const,
  capsule,
  expectedAuthorityDescriptorDigest: capsule.authorityDescriptor.descriptorDigest,
  verifiedAt: capsule.evaluatedAt,
};
const report = verifyChangeAuthorizationCapsuleV1(request);

writeFileSync(join(FIXTURES_DIR, "frozen-request.json"), `${JSON.stringify(request, null, 2)}\n`, "utf8");
writeFileSync(join(FIXTURES_DIR, "frozen-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
writeFileSync(
  join(FIXTURES_DIR, "frozen-report.jcs.txt"),
  serializeChangeAuthorizationVerificationReportV1(report),
  "utf8",
);

console.log(`frozen vector regenerated: result=${report.result} reportHash=${report.reportHash}`);
