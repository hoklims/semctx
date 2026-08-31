import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  ChangeAuthorizationVerificationRequestV1Schema,
  serializeChangeAuthorizationVerificationReportV1,
  verifyChangeAuthorizationCapsuleV1,
} from "@semantic-context/change-authorization-verifier";
import type { ParsedArgs } from "../args";
import { info } from "../output";

export const CONTROL_VERIFY_AUTHORIZATION_HELP =
  `  control verify-authorization <request.json> [--json]
      offline, host-independent verification of a ChangeAuthorizationCapsuleV1; read-only,
      grants no execution authority. Exit 0 on PASSED, 3 on FAILED/REQUIRE_EVIDENCE.`;

/** Read-only offline verification of a sealed capsule; never touches Git, `.semctx/`, or a trust registry. */
export function runControlVerifyAuthorization(
  root: string,
  args: ParsedArgs,
): number | undefined {
  if (args.positionals[1] !== "verify-authorization") return undefined;

  const usage = "semctx control verify-authorization <request.json>";
  const unsupportedFlags = [...args.flags.keys()].filter((flag) => flag !== "json" && flag !== "root");
  if (unsupportedFlags.length > 0) {
    throw new Error(`unsupported option(s) for ${usage}: ${unsupportedFlags.map((flag) => `--${flag}`).join(", ")}`);
  }
  if (args.positionals.length !== 3) throw new Error(`usage: ${usage}`);
  const requestFile = args.positionals[2];
  if (requestFile === undefined || requestFile.length === 0) throw new Error(`usage: ${usage}`);

  const rawRequest = readJsonValue(root, requestFile, "change authorization verification request");
  const parsed = ChangeAuthorizationVerificationRequestV1Schema.safeParse(rawRequest);
  if (!parsed.success) {
    throw new Error(
      `change authorization verification request failed its public schema: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
    );
  }

  const report = verifyChangeAuthorizationCapsuleV1(parsed.data);
  info(serializeChangeAuthorizationVerificationReportV1(report));
  return report.result === "PASSED" ? 0 : 3;
}

function readJsonValue(root: string, file: string, label: string): unknown {
  const path = resolve(root, file);
  if (!existsSync(path)) throw new Error(`${label} file does not exist: ${path}`);
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (cause) {
    throw new Error(`${label} file is not valid JSON: ${String(cause)}`, { cause });
  }
}
