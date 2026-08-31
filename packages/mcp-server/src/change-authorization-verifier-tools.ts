import { z } from "zod-v4";
import { ChangeAuthorizationTimestampV1Schema, Sha256HashSchema } from "@semantic-context/control-model";
import {
  ChangeAuthorizationVerificationRequestV1Schema,
  verifyChangeAuthorizationCapsuleV1,
  serializeChangeAuthorizationVerificationReportV1,
  type ChangeAuthorizationVerificationRequestV1,
} from "@semantic-context/change-authorization-verifier";
import { mcpSchema } from "./schema-boundary";
import type { ToolRegistrar } from "./tool-contract";

// `verifiedAt` is bound to the exact same control-model schema the library and the CLI use
// (via `mcpSchema`), so no transport can accept an impossible calendar instant (e.g.
// `2026-02-30T12:00:00Z`, or `24:00:00`) that another transport would reject.
const CHANGE_AUTHORIZATION_VERIFICATION_REQUEST = z.object({
  schemaVersion: z.literal(1),
  capsule: z.unknown(),
  expectedAuthorityDescriptorDigest: mcpSchema(Sha256HashSchema).nullable(),
  verifiedAt: mcpSchema(ChangeAuthorizationTimestampV1Schema),
}).strict().superRefine((value, context) => {
  const parsed = ChangeAuthorizationVerificationRequestV1Schema.safeParse(value);
  if (parsed.success) return;
  for (const issue of parsed.error.issues) {
    context.addIssue({
      code: "custom",
      path: ["verifiedAt"],
      message: issue.message,
      input: value.verifiedAt,
    });
  }
});

interface TextResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
}

/**
 * Offline, host-independent verification of a sealed ChangeAuthorizationCapsuleV1. Deliberately
 * has no `repositoryRoot`: unlike every other tool in this server, it never reads a target
 * repository — the capsule and the external authority digest are the entire input.
 */
export function registerChangeAuthorizationVerifierTools(tools: ToolRegistrar): void {
  tools.registerTool(
    "semctx_control_verify_authorization",
    {
      title: "Verify a Change Authorization capsule",
      description:
        "Read-only, host-independent verification of a sealed ChangeAuthorizationCapsuleV1: re-derives "
        + "the capsule's own verdict at its sealed evaluatedAt (integrity), compares its authority "
        + "descriptor digest against one supplied by the caller from outside the capsule (authority), "
        + "and re-evaluates the capsule's own sealed providers/assertions at the caller's verifiedAt "
        + "(which must not precede the capsule's evaluatedAt) "
        + "(semantic) — this only moves the clock, so it can surface an assertion or provider snapshot "
        + "that has since expired, never a provider status change learned after sealing. Grants no "
        + "execution authority and never touches a target repository, Git, `.semctx/`, or a trust "
        + "registry — it takes no repositoryRoot.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      strictInput: true,
      inputSchema: {
        request: CHANGE_AUTHORIZATION_VERIFICATION_REQUEST,
      },
    },
    ({ request }) => canonical(verifyChangeAuthorizationCapsuleV1(
      request as ChangeAuthorizationVerificationRequestV1,
    )),
  );
}

function canonical(report: ReturnType<typeof verifyChangeAuthorizationCapsuleV1>): TextResult {
  return { content: [{ type: "text", text: serializeChangeAuthorizationVerificationReportV1(report) }] };
}
