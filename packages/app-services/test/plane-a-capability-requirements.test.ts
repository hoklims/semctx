import { describe, expect, it } from "bun:test";
import { TYPESCRIPT_DIALECT_VERSION } from "@semantic-context/ts-analyzer";
import {
  REGISTERED_PLANE_A_CAPABILITY_COUNT,
  resolvePlaneACapabilityRequirement,
} from "../src/plane-a-capability-requirements";

const producerConfigurationDigest = `sha256:${"a".repeat(64)}`;

function requirement(input: {
  configVersion: 1 | 2;
  task?: string;
  operation?: string;
  language: string;
  factKind: string;
  completenessClaim?: string;
}) {
  return resolvePlaneACapabilityRequirement({
    producerConfigurationDigest,
    task: input.task ?? "verify",
    operation: input.operation ?? "change",
    completenessClaim: input.completenessClaim ?? "producer-declared",
    ...input,
  });
}

describe("consumer-owned Plane A capability requirements", () => {
  it("registers the exact closed TS, JavaScript ESM, Python, Markdown, and SQL policy surface", () => {
    expect(REGISTERED_PLANE_A_CAPABILITY_COUNT).toBe(122);
    expect(TYPESCRIPT_DIALECT_VERSION).toBe("5.9.3");
    expect(requirement({
      configVersion: 2,
      language: "typescript",
      factKind: "function",
    })).toEqual({
      language: "typescript",
      dialectVersion: "5.9.3",
      producer: {
        identity: "@semantic-context/ts-analyzer",
        version: "0.1.0",
      },
      producerConfigurationDigest,
      factSchemaDigest:
        "sha256:4972b087e684b19f14c54f03d4fa511b4642c91ca8c1bb0175ae030d91cbc61d",
      evidenceContract: "source-lines-v1",
      resolutionSemantics: "typescript-static-v1",
      soundnessClaim: "best-effort-static",
      completenessClaim: "producer-declared",
    });
    expect(requirement({
      configVersion: 2,
      language: "python",
      factKind: "imports",
    })?.resolutionSemantics).toBe("python-static-local-imports-v1");
    expect(requirement({
      configVersion: 2,
      language: "python",
      factKind: "imports",
      completenessClaim: "partial",
    })?.completenessClaim).toBe("partial");
    expect(requirement({
      configVersion: 2,
      language: "markdown",
      factKind: "documents",
    })?.resolutionSemantics).toBe("structural-source-v1");
    expect(requirement({
      configVersion: 1,
      language: "sql",
      factKind: "migration",
    })?.factSchemaDigest).toBe(
      "sha256:473c6a84852bb31d160a1f7b5feaaf43d35eacdeb39687ddc687e84d0550866f",
    );
  });

  it.each([
    { configVersion: 1 as const, language: "python", factKind: "module" },
    { configVersion: 2 as const, language: "ruby", factKind: "module" },
    { configVersion: 2 as const, language: "typescript", factKind: "documents" },
    { configVersion: 2 as const, language: "typescript", factKind: "analysis" },
    {
      configVersion: 2 as const,
      task: "index-health",
      operation: "inspect",
      language: "typescript",
      factKind: "module",
    },
  ])("fails closed for an unregistered tuple: %o", (input) => {
    expect(requirement(input)).toBeNull();
  });
});
