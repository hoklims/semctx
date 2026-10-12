import {
  canonicalJson,
  digestCanonical,
  type PlaneACapabilityRequirement,
  type ProducerIdentity,
} from "@semantic-context/plane-a-internal";

const TYPESCRIPT_PRODUCER: ProducerIdentity = {
  identity: "@semantic-context/ts-analyzer",
  version: "0.1.0",
};

const PYTHON_PRODUCER: ProducerIdentity = {
  identity: "@semantic-context/python-analyzer",
  version: "0.1.0",
};

const LEGACY_FACT_SCHEMA_DIGEST = digestCanonical({
  schemaVersion: 1,
  facts: ["node", "edge"],
  evidence: "source-lines-v1",
});
const POLYGLOT_FACT_SCHEMA_DIGEST = digestCanonical({
  schemaVersion: 1,
  facts: ["node", "edge"],
  evidence: "source-lines-v1",
  languages: ["typescript", "python", "markdown", "sql"],
});

const TYPESCRIPT_FACT_KINDS = [
  "module",
  "test",
  "function",
  "class",
  "interface",
  "type",
  "enum",
  "migration",
  "capability",
  "invariant",
  "contract",
  "risk",
  "bounded_context",
  "belongs_to",
  "declares",
  "imports",
  "calls",
  "tested_by",
  "covers",
  "implements_capability",
  "constrained_by",
  "related_to",
] as const;

const PYTHON_FACT_KINDS = [
  "module",
  "test",
  "function",
  "class",
  "capability",
  "invariant",
  "contract",
  "risk",
  "bounded_context",
  "belongs_to",
  "declares",
  "imports",
  "implements_capability",
  "constrained_by",
  "related_to",
] as const;

const MARKDOWN_FACT_KINDS = [
  "document",
  "capability",
  "invariant",
  "decision",
  "bounded_context",
  "belongs_to",
  "documents",
  "decides",
  "contradicts",
] as const;

const SQL_FACT_KINDS = [
  "migration",
  "invariant",
  "belongs_to",
  "related_to",
] as const;

type RegisteredCapability = Omit<PlaneACapabilityRequirement, "producerConfigurationDigest">;

interface CapabilityRegistration {
  readonly configVersions: readonly (1 | 2)[];
  readonly language: string;
  readonly dialectVersion: string | null;
  readonly producer: ProducerIdentity;
  readonly factKinds: readonly string[];
  readonly resolutionSemantics: string;
  readonly completenessClaims: readonly string[];
}

const REGISTRATIONS: readonly CapabilityRegistration[] = [
  {
    configVersions: [2],
    language: "javascript",
    dialectVersion: "5.9.3",
    producer: { identity: "@semantic-context/ts-analyzer/javascript", version: "0.1.0" },
    factKinds: TYPESCRIPT_FACT_KINDS,
    resolutionSemantics: "javascript-static-esm-v1",
    completenessClaims: ["producer-declared"],
  },
  {
    configVersions: [1, 2],
    language: "typescript",
    dialectVersion: "5.9.3",
    producer: TYPESCRIPT_PRODUCER,
    factKinds: TYPESCRIPT_FACT_KINDS,
    resolutionSemantics: "typescript-static-v1",
    completenessClaims: ["producer-declared"],
  },
  {
    configVersions: [2],
    language: "python",
    dialectVersion: "<=3.12",
    producer: PYTHON_PRODUCER,
    factKinds: PYTHON_FACT_KINDS,
    resolutionSemantics: "python-static-local-imports-v1",
    completenessClaims: ["producer-declared", "partial"],
  },
  {
    configVersions: [1, 2],
    language: "markdown",
    dialectVersion: null,
    producer: TYPESCRIPT_PRODUCER,
    factKinds: MARKDOWN_FACT_KINDS,
    resolutionSemantics: "structural-source-v1",
    completenessClaims: ["producer-declared"],
  },
  {
    configVersions: [1, 2],
    language: "sql",
    dialectVersion: null,
    producer: TYPESCRIPT_PRODUCER,
    factKinds: SQL_FACT_KINDS,
    resolutionSemantics: "structural-source-v1",
    completenessClaims: ["producer-declared"],
  },
] as const;

function capabilityKey(
  configVersion: 1 | 2,
  task: string,
  operation: string,
  language: string,
  factKind: string,
  completenessClaim: string,
): string {
  return canonicalJson([
    configVersion,
    task,
    operation,
    language,
    factKind,
    completenessClaim,
  ]);
}

const REGISTERED_CAPABILITIES = new Map<string, RegisteredCapability>();
for (const registration of REGISTRATIONS) {
  for (const configVersion of registration.configVersions) {
    const factSchemaDigest =
      configVersion === 1 ? LEGACY_FACT_SCHEMA_DIGEST : POLYGLOT_FACT_SCHEMA_DIGEST;
    for (const factKind of registration.factKinds) {
      for (const completenessClaim of registration.completenessClaims) {
        const key = capabilityKey(
          configVersion,
          "verify",
          "change",
          registration.language,
          factKind,
          completenessClaim,
        );
        if (REGISTERED_CAPABILITIES.has(key)) {
          throw new Error(`duplicate Plane A capability policy registration: ${key}`);
        }
        REGISTERED_CAPABILITIES.set(key, {
          language: registration.language,
          dialectVersion: registration.dialectVersion,
          producer: registration.producer,
          factSchemaDigest,
          evidenceContract: "source-lines-v1",
          resolutionSemantics: registration.resolutionSemantics,
          soundnessClaim: "best-effort-static",
          completenessClaim,
        });
      }
    }
  }
}

export const REGISTERED_PLANE_A_CAPABILITY_COUNT = REGISTERED_CAPABILITIES.size;

/**
 * Resolve a consumer-owned requirement. Producer declarations are deliberately not inputs:
 * an unknown tuple has no authority and fails closed at capability gate 4.
 */
export function resolvePlaneACapabilityRequirement(input: {
  readonly configVersion: 1 | 2;
  readonly producerConfigurationDigest: string;
  readonly task: string;
  readonly operation: string;
  readonly language: string;
  readonly factKind: string;
  readonly completenessClaim: string;
}): PlaneACapabilityRequirement | null {
  const registered = REGISTERED_CAPABILITIES.get(capabilityKey(
    input.configVersion,
    input.task,
    input.operation,
    input.language,
    input.factKind,
    input.completenessClaim,
  ));
  if (registered === undefined) return null;
  return {
    ...registered,
    producer: { ...registered.producer },
    producerConfigurationDigest: input.producerConfigurationDigest,
  };
}
