import { describe, expect, it } from "bun:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import {
  ChangeAuthorizationVerificationReportV1Schema,
  serializeChangeAuthorizationVerificationReportV1,
  verifyChangeAuthorizationCapsuleV1,
  type ChangeAuthorizationVerificationRequestV1,
} from "@semantic-context/change-authorization-verifier";
import { evaluateChangeAuthorizationV1 } from "@semantic-context/control-engine";
import type { ChangeAuthorizationCapsuleV1 } from "@semantic-context/control-model";
import { createSemctxServer } from "../src/server";
import { TOOL_OUTPUT_SCHEMAS } from "../src/tool-output-schemas";
import { baseEvaluationInput, record } from "../../change-authorization-verifier/test/fixtures";

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

function textContent(result: unknown): string {
  const content = (result as { content: Array<{ type: string; text?: string }> }).content[0];
  if (content?.type !== "text" || content.text === undefined) throw new Error("expected MCP text result");
  return content.text;
}

async function withLinkedClient(
  run: (client: Client) => Promise<void>,
): Promise<void> {
  const server = createSemctxServer();
  const client = new Client({ name: "semctx-change-authorization-verifier-test", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    await run(client);
  } finally {
    await client.close();
    await server.close();
  }
}

describe("semctx_control_verify_authorization MCP tool", () => {
  it("returns the exact library JCS payload for a genuine ALLOW capsule, with no repositoryRoot input", async () => {
    const capsule = evaluateChangeAuthorizationV1(baseEvaluationInput());
    const request = requestFor(capsule);
    const expected = verifyChangeAuthorizationCapsuleV1(request);

    await withLinkedClient(async (client) => {
      const result = await client.callTool({
        name: "semctx_control_verify_authorization",
        arguments: { request },
      });
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      expect(textContent(result)).toBe(serializeChangeAuthorizationVerificationReportV1(expected));
      expect(JSON.parse(textContent(result))).toMatchObject({ result: "PASSED" });
      expect(result.structuredContent).toEqual(JSON.parse(textContent(result)));
    });
  });

  it("rejects a correctly shaped but self-hash-invalid report at the MCP output boundary", () => {
    const capsule = evaluateChangeAuthorizationV1(baseEvaluationInput());
    const report = verifyChangeAuthorizationCapsuleV1(requestFor(capsule));
    const forged = { ...report, reportHash: `sha256:${"9".repeat(64)}` };

    expect(ChangeAuthorizationVerificationReportV1Schema.safeParse(forged).success).toBe(false);
    expect(TOOL_OUTPUT_SCHEMAS.semctx_control_verify_authorization.safeParse(forged).success).toBe(false);
  });

  it("returns REQUIRE_EVIDENCE when the caller supplies no external authority pin", async () => {
    const capsule = evaluateChangeAuthorizationV1(baseEvaluationInput());
    const request = requestFor(capsule, { expectedAuthorityDescriptorDigest: null });

    await withLinkedClient(async (client) => {
      const result = await client.callTool({
        name: "semctx_control_verify_authorization",
        arguments: { request },
      });
      expect(result.isError).not.toBe(true);
      expect(JSON.parse(textContent(result))).toMatchObject({
        result: "REQUIRE_EVIDENCE",
        authority: { result: "UNKNOWN" },
      });
    });
  });

  it("returns FAILED when the basis reconciliation is VIOLATED", async () => {
    const capsule = evaluateChangeAuthorizationV1(baseEvaluationInput({ basisRecord: record("VIOLATED") }));
    const request = requestFor(capsule);

    await withLinkedClient(async (client) => {
      const result = await client.callTool({
        name: "semctx_control_verify_authorization",
        arguments: { request },
      });
      expect(result.isError).not.toBe(true);
      expect(JSON.parse(textContent(result))).toMatchObject({ result: "FAILED" });
    });
  });

  it("rejects a malformed request at the input boundary, before the handler runs", async () => {
    await withLinkedClient(async (client) => {
      const result = await client.callTool({
        name: "semctx_control_verify_authorization",
        arguments: { request: { schemaVersion: 1, capsule: {}, expectedAuthorityDescriptorDigest: "not-a-hash", verifiedAt: "2026-08-01T10:00:00.000Z" } },
      });
      expect(result.isError).toBe(true);
      expect(JSON.parse(textContent(result))).toEqual({ code: "INVALID_ARGUMENTS", error: "Tool arguments are invalid" });
    });
  });

  it("rejects a calendar-impossible verifiedAt at the input boundary, on the same schema as the library", async () => {
    const capsule = evaluateChangeAuthorizationV1(baseEvaluationInput());
    await withLinkedClient(async (client) => {
      for (const impossible of ["2026-02-30T12:00:00Z", "2026-01-01T24:00:00Z"]) {
        const request = requestFor(capsule, { verifiedAt: impossible });
        const result = await client.callTool({
          name: "semctx_control_verify_authorization",
          arguments: { request },
        });
        expect(result.isError, impossible).toBe(true);
        expect(JSON.parse(textContent(result))).toEqual({ code: "INVALID_ARGUMENTS", error: "Tool arguments are invalid" });
      }
    });
  });

  it("rejects verifiedAt before capsule.evaluatedAt at the input boundary", async () => {
    const capsule = evaluateChangeAuthorizationV1(baseEvaluationInput({
      evaluatedAt: "2026-10-01T10:00:00.000Z",
    }));
    expect(capsule.verdict).toBe("REQUIRE_EVIDENCE");
    const request = requestFor(capsule, { verifiedAt: "2026-08-14T00:00:00.000Z" });
    await withLinkedClient(async (client) => {
      const result = await client.callTool({
        name: "semctx_control_verify_authorization",
        arguments: { request },
      });
      expect(result.isError).toBe(true);
      expect(JSON.parse(textContent(result))).toEqual({ code: "INVALID_ARGUMENTS", error: "Tool arguments are invalid" });
    });
  });

  it("closes the world: an unexpected repositoryRoot argument is rejected, not silently ignored", async () => {
    const capsule = evaluateChangeAuthorizationV1(baseEvaluationInput());
    const request = requestFor(capsule);

    await withLinkedClient(async (client) => {
      const result = await client.callTool({
        name: "semctx_control_verify_authorization",
        arguments: { repositoryRoot: "/tmp/should-not-be-accepted", request },
      });
      expect(result.isError).toBe(true);
      expect(JSON.parse(textContent(result))).toEqual({ code: "INVALID_ARGUMENTS", error: "Tool arguments are invalid" });
    });
  });
});
