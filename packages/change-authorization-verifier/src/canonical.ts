import {
  changeAuthorizationDomainHashV1,
  serializeChangeAuthorizationJcsV1,
  type Sha256Hash,
} from "@semantic-context/control-model";
import type { ChangeAuthorizationVerificationReportV1 } from "./types";

const VERIFICATION_REPORT_DOMAIN = "SEMCTX_CHANGE_AUTHORIZATION_VERIFICATION_REPORT_V1\0";

export function computeChangeAuthorizationVerificationReportV1Hash(
  value: Omit<ChangeAuthorizationVerificationReportV1, "reportHash"> & { reportHash?: Sha256Hash },
): Sha256Hash {
  const { reportHash: _hash, ...payload } = value;
  return changeAuthorizationDomainHashV1(VERIFICATION_REPORT_DOMAIN, payload);
}

/** Byte-stable JCS text; identical across the library, the CLI, and the MCP transport. */
export function serializeChangeAuthorizationVerificationReportV1(
  report: ChangeAuthorizationVerificationReportV1,
): string {
  return serializeChangeAuthorizationJcsV1(report);
}
