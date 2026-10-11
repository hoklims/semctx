import {
  canonicalJson,
  type ArtifactScope,
} from "@semantic-context/plane-a-internal";

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

interface AuthorityRegistration {
  readonly configVersions: readonly (1 | 2)[];
  readonly language: string;
  readonly dialectVersion: string | null;
  readonly factKinds: readonly string[];
}

const AUTHORITY_REGISTRATIONS: readonly AuthorityRegistration[] = [
  {
    configVersions: [1, 2],
    language: "typescript",
    dialectVersion: "5.9.3",
    factKinds: TYPESCRIPT_FACT_KINDS,
  },
  {
    // Static ESM fact use only. Capability/completeness gates separately reject partial sources.
    configVersions: [2],
    language: "javascript",
    dialectVersion: "5.9.3",
    factKinds: TYPESCRIPT_FACT_KINDS,
  },
  {
    configVersions: [2],
    language: "python",
    dialectVersion: "<=3.12",
    factKinds: PYTHON_FACT_KINDS,
  },
  {
    configVersions: [1, 2],
    language: "markdown",
    dialectVersion: null,
    factKinds: MARKDOWN_FACT_KINDS,
  },
  {
    configVersions: [1, 2],
    language: "sql",
    dialectVersion: null,
    factKinds: SQL_FACT_KINDS,
  },
] as const;

function authorityKey(input: {
  readonly configVersion: 1 | 2;
  readonly task: string;
  readonly operation: string;
  readonly language: string;
  readonly dialectVersion: string | null;
  readonly factKind: string;
}): string {
  return canonicalJson([
    input.configVersion,
    input.task,
    input.operation,
    input.language,
    input.dialectVersion,
    input.factKind,
  ]);
}

const ADMITTED_OPERATIONS = new Set<string>();
for (const registration of AUTHORITY_REGISTRATIONS) {
  for (const configVersion of registration.configVersions) {
    for (const factKind of registration.factKinds) {
      const key = authorityKey({
        configVersion,
        task: "verify",
        operation: "change",
        language: registration.language,
        dialectVersion: registration.dialectVersion,
        factKind,
      });
      if (ADMITTED_OPERATIONS.has(key)) {
        throw new Error(`duplicate Plane A authority policy registration: ${key}`);
      }
      ADMITTED_OPERATIONS.add(key);
    }
  }
}

export const REGISTERED_PLANE_A_AUTHORITY_COUNT = ADMITTED_OPERATIONS.size;

/** Independent task-relative policy. Capability registration alone never grants authority. */
export function isPlaneAOperationAdmitted(input: {
  readonly configVersion: 1 | 2;
  readonly task: string;
  readonly operation: string;
  readonly factKind: string;
  readonly scope: ArtifactScope;
}): boolean {
  return ADMITTED_OPERATIONS.has(authorityKey({
    configVersion: input.configVersion,
    task: input.task,
    operation: input.operation,
    language: input.scope.language,
    dialectVersion: input.scope.dialectVersion ?? null,
    factKind: input.factKind,
  }));
}
