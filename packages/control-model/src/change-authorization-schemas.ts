import { z } from "zod";
import {
  ControlHandoffRecordV2Schema,
  ControlHandoffReconciliationReasonCodeV2Schema,
} from "./control-handoff";
import { compareCodeUnits } from "./ordering";
import { Sha256HashSchema } from "./primitive-schemas";
import { EvidenceRefV1Schema } from "./refinement-schemas";
import { canonicalizeEvidenceRefs } from "./hashing";
import { QualifiedCoordinateIdSchema } from "./schemas";
import { DeclaredReconciliationScopeV1Schema } from "./task-envelope-schemas";
import type { Sha256Hash } from "./types";
import {
  CHANGE_AUTHORIZATION_CONCLUSIONS,
  CHANGE_AUTHORIZATION_INSUFFICIENCY_REASONS,
  CHANGE_AUTHORIZATION_MODALITIES,
  CHANGE_AUTHORIZATION_NEVER_ALLOWLISTABLE_MODALITIES,
  CHANGE_AUTHORIZATION_PREDICATE_TYPE_V1,
  CHANGE_AUTHORIZATION_PROVIDER_STATUSES,
  CHANGE_AUTHORIZATION_REASON_ORDER,
  CHANGE_AUTHORIZATION_VERDICT_RANK,
  CHANGE_AUTHORIZATION_VIOLATION_REASONS,
  requiredClaimKindForModality,
  type ChangeAuthorizationAssertionV1,
  type ChangeAuthorizationAuthorityDescriptorV1,
  type ChangeAuthorizationCapsuleV1,
  type ChangeAuthorizationClaimV1,
  type ChangeAuthorizationEvidenceBundleV1,
  type ChangeAuthorizationEvidenceUniverseV1,
  type ChangeAuthorizationPolicyEvaluationV1,
  type ChangeAuthorizationReasonCodeV1,
  type ChangeAuthorizationRuleOutcomeV1,
  type ChangeAuthorizationSubjectV1,
} from "./change-authorization-types";
import {
  computeChangeAuthorizationAssertionV1Hash,
  computeChangeAuthorizationAuthorityDescriptorV1Hash,
  computeChangeAuthorizationCapsuleV1Hash,
  computeChangeAuthorizationClaimV1Hash,
  computeChangeAuthorizationEvidenceBundleV1Hash,
  computeChangeAuthorizationEvidenceUniverseV1Hash,
  computeChangeAuthorizationPolicyEvaluationV1Hash,
  computeChangeAuthorizationPolicyRuleSetV1Hash,
  computeChangeAuthorizationSubjectV1Hash,
  computeChangeAuthorizationTrustRootSetV1Hash,
  isChangeAuthorizationJcsSafeV1,
} from "./change-authorization-canonical";

const NonEmptyIdSchema = z.string().min(1);
export const ChangeAuthorizationTimestampV1Schema = z.string().datetime({ offset: true });

export const ChangeAuthorizationModalityV1Schema = z.enum(CHANGE_AUTHORIZATION_MODALITIES);
export const ChangeAuthorizationConclusionV1Schema = z.enum(CHANGE_AUTHORIZATION_CONCLUSIONS);
export const ChangeAuthorizationReasonCodeV1Schema = z.enum(CHANGE_AUTHORIZATION_REASON_ORDER);
export const ChangeAuthorizationVerdictV1Schema = z.enum(["ALLOW", "DENY", "REQUIRE_EVIDENCE"]);
export const ChangeAuthorizationProviderStatusV1Schema = z.enum(CHANGE_AUTHORIZATION_PROVIDER_STATUSES);
export const ChangeAuthorizationRuleOutcomeV1Schema = z.enum(["satisfied", "insufficient", "violated"]);

export const ChangeAuthorizationEvidenceScopeV1Schema = z.object({
  schemaVersion: z.literal(1),
  coordinateIds: z.array(QualifiedCoordinateIdSchema).min(1),
}).strict().superRefine((value, context) => {
  requireCanonicalStrings(value.coordinateIds, context, ["coordinateIds"]);
});

export const ChangeAuthorizationSubjectV1Schema = z.object({
  schemaVersion: z.literal(1),
  changeId: NonEmptyIdSchema,
  changeContractHash: Sha256HashSchema,
  parentIntentIds: z.array(NonEmptyIdSchema),
  nonGoals: z.array(NonEmptyIdSchema),
  expectedBehaviorDelta: z.array(NonEmptyIdSchema),
  declaredReconciliationScope: DeclaredReconciliationScopeV1Schema,
  planningCommit: NonEmptyIdSchema,
  observedCommit: NonEmptyIdSchema,
  observedWorkingDiffHash: Sha256HashSchema,
  touchedCoordinateIds: z.array(QualifiedCoordinateIdSchema),
  reconciliationTerminalStatus: z.enum(["REALIZED", "VIOLATED", "UNPROVEN"]),
  reconciliationReasonCodes: z.array(ControlHandoffReconciliationReasonCodeV2Schema),
  subjectHash: Sha256HashSchema,
}).strict().superRefine((value, context) => {
  for (const [field, values] of [
    ["parentIntentIds", value.parentIntentIds],
    ["nonGoals", value.nonGoals],
    ["expectedBehaviorDelta", value.expectedBehaviorDelta],
    ["touchedCoordinateIds", value.touchedCoordinateIds],
  ] as const) requireCanonicalStrings(values, context, [field]);
  requireMatchingHash(value.subjectHash, value as ChangeAuthorizationSubjectV1,
    computeChangeAuthorizationSubjectV1Hash, context, ["subjectHash"], "subjectHash");
});

export const ChangeAuthorizationProviderV1Schema = z.object({
  schemaVersion: z.literal(1),
  providerId: NonEmptyIdSchema,
  kind: NonEmptyIdSchema,
  version: NonEmptyIdSchema,
  digest: Sha256HashSchema,
  status: ChangeAuthorizationProviderStatusV1Schema,
  capabilities: z.array(NonEmptyIdSchema),
  observedAt: ChangeAuthorizationTimestampV1Schema,
  expiresAt: ChangeAuthorizationTimestampV1Schema,
  trustRootId: NonEmptyIdSchema,
}).strict().superRefine((value, context) => {
  requireCanonicalStrings(value.capabilities, context, ["capabilities"]);
  if (Date.parse(value.observedAt) > Date.parse(value.expiresAt)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["expiresAt"], message: "expiry precedes observation" });
  }
});

export const ChangeAuthorizationClaimSubjectV1Schema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("CHANGE_REQUIREMENT"), changeId: NonEmptyIdSchema, requirementId: NonEmptyIdSchema }).strict(),
  z.object({ kind: z.literal("HUMAN_APPROVAL"), changeId: NonEmptyIdSchema, approverRole: NonEmptyIdSchema }).strict(),
  z.object({ kind: z.literal("ASSERTION_AUTHENTICITY"), changeId: NonEmptyIdSchema, producerId: NonEmptyIdSchema }).strict(),
]);

export const ChangeAuthorizationClaimV1Schema = z.object({
  schemaVersion: z.literal(1),
  claimId: NonEmptyIdSchema,
  statement: NonEmptyIdSchema,
  subject: ChangeAuthorizationClaimSubjectV1Schema,
  claimHash: Sha256HashSchema,
}).strict().superRefine((value, context) => {
  requireMatchingHash(value.claimHash, value as ChangeAuthorizationClaimV1,
    computeChangeAuthorizationClaimV1Hash, context, ["claimHash"], "claimHash");
});

const MethodParametersSchema = z.record(z.unknown());

export const ChangeAuthorizationAssertionV1Schema = z.object({
  schemaVersion: z.literal(1),
  assertionId: NonEmptyIdSchema,
  claimHash: Sha256HashSchema,
  conclusion: ChangeAuthorizationConclusionV1Schema,
  modality: ChangeAuthorizationModalityV1Schema,
  producerId: NonEmptyIdSchema,
  producerVersion: NonEmptyIdSchema,
  sourceCommit: NonEmptyIdSchema,
  sourceDiffHash: Sha256HashSchema,
  methodName: NonEmptyIdSchema,
  methodParameters: MethodParametersSchema,
  scope: ChangeAuthorizationEvidenceScopeV1Schema,
  observedAt: ChangeAuthorizationTimestampV1Schema,
  expiresAt: ChangeAuthorizationTimestampV1Schema,
  providerId: NonEmptyIdSchema,
  artifacts: z.array(EvidenceRefV1Schema),
  dependsOnAssertionHashes: z.array(Sha256HashSchema),
  contradicts: z.array(Sha256HashSchema),
  assertionHash: Sha256HashSchema,
}).strict().superRefine((value, context) => {
  try {
    const canonicalArtifacts = canonicalizeEvidenceRefs(value.artifacts);
    if (JSON.stringify(canonicalArtifacts) !== JSON.stringify(value.artifacts)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["artifacts"],
        message: "artifacts must be unique and canonically ordered",
      });
    }
  } catch {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["artifacts"],
      message: "artifacts must be unique and canonically ordered",
    });
  }
  requireCanonicalStrings(value.dependsOnAssertionHashes, context, ["dependsOnAssertionHashes"]);
  requireCanonicalStrings(value.contradicts, context, ["contradicts"]);
  if (Date.parse(value.observedAt) > Date.parse(value.expiresAt)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["expiresAt"], message: "expiry precedes observation" });
  }
  const assertionJcsSafe = isChangeAuthorizationJcsSafeV1(value);
  if (!assertionJcsSafe) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["methodParameters"],
      message: "assertion content must be JCS-safe",
    });
  }
  if (value.dependsOnAssertionHashes.includes(value.assertionHash)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["dependsOnAssertionHashes"],
      message: "an assertion cannot depend on itself",
    });
  }
  if (value.contradicts.includes(value.assertionHash)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["contradicts"],
      message: "an assertion cannot contradict itself",
    });
  }
  if (assertionJcsSafe) requireMatchingHash(value.assertionHash, value as ChangeAuthorizationAssertionV1,
    computeChangeAuthorizationAssertionV1Hash, context, ["assertionHash"], "assertionHash");
});

export const ChangeAuthorizationEvidenceBundleV1Schema = z.object({
  schemaVersion: z.literal(1),
  bundleId: NonEmptyIdSchema,
  ruleId: NonEmptyIdSchema,
  assertionHashes: z.array(Sha256HashSchema).min(1),
  bundleHash: Sha256HashSchema,
}).strict().superRefine((value, context) => {
  requireCanonicalStrings(value.assertionHashes, context, ["assertionHashes"]);
  requireMatchingHash(value.bundleHash, value as ChangeAuthorizationEvidenceBundleV1,
    computeChangeAuthorizationEvidenceBundleV1Hash, context, ["bundleHash"], "bundleHash");
});

export const ChangeAuthorizationEvidenceUniverseV1Schema = z.object({
  schemaVersion: z.literal(1),
  assertionHashes: z.array(Sha256HashSchema),
  bundleHashes: z.array(Sha256HashSchema),
  universeHash: Sha256HashSchema,
}).strict().superRefine((value, context) => {
  requireCanonicalStrings(value.assertionHashes, context, ["assertionHashes"]);
  requireCanonicalStrings(value.bundleHashes, context, ["bundleHashes"]);
  requireMatchingHash(value.universeHash, value as ChangeAuthorizationEvidenceUniverseV1,
    computeChangeAuthorizationEvidenceUniverseV1Hash, context, ["universeHash"], "universeHash");
});

export const ChangeAuthorizationPolicyRuleV1Schema = z.object({
  schemaVersion: z.literal(1),
  ruleId: NonEmptyIdSchema,
  description: NonEmptyIdSchema,
  requiredClaimHash: Sha256HashSchema,
  allowedModalities: z.array(ChangeAuthorizationModalityV1Schema).min(1),
  scopeCoordinateIds: z.array(QualifiedCoordinateIdSchema).min(1).optional(),
  requiredCapability: NonEmptyIdSchema.optional(),
}).strict().superRefine((value, context) => {
  requireCanonicalStrings(value.allowedModalities, context, ["allowedModalities"]);
  if (value.scopeCoordinateIds !== undefined) {
    requireCanonicalStrings(value.scopeCoordinateIds, context, ["scopeCoordinateIds"]);
  }
  for (const forbidden of CHANGE_AUTHORIZATION_NEVER_ALLOWLISTABLE_MODALITIES) {
    if (value.allowedModalities.includes(forbidden)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["allowedModalities"],
        message: `${forbidden} can never satisfy a policy rule`,
      });
    }
  }
});

export const ChangeAuthorizationPolicyEvaluationV1Schema = z.object({
  schemaVersion: z.literal(1),
  ruleId: NonEmptyIdSchema,
  outcome: ChangeAuthorizationRuleOutcomeV1Schema,
  reasonCodes: z.array(ChangeAuthorizationReasonCodeV1Schema).min(1),
  contributingAssertionHashes: z.array(Sha256HashSchema),
  evaluationHash: Sha256HashSchema,
}).strict().superRefine((value, context) => {
  requireCanonicalReasons(value.reasonCodes, context, ["reasonCodes"]);
  requireCanonicalStrings(value.contributingAssertionHashes, context, ["contributingAssertionHashes"]);
  const positive = value.outcome === "satisfied";
  if (positive !== (value.reasonCodes.length === 1 && value.reasonCodes[0] === "POLICY_SATISFIED")) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["reasonCodes"],
      message: "satisfied outcome requires exactly POLICY_SATISFIED; other outcomes must not carry it",
    });
  }
  if (positive !== (value.contributingAssertionHashes.length > 0)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "satisfied outcome requires contributing evidence; other outcomes carry none",
    });
  }
  const allowedSet: readonly string[] = value.outcome === "violated"
    ? CHANGE_AUTHORIZATION_VIOLATION_REASONS
    : value.outcome === "insufficient"
      ? CHANGE_AUTHORIZATION_INSUFFICIENCY_REASONS
      : [];
  if (value.outcome !== "satisfied" && value.reasonCodes.some((reason) => !allowedSet.includes(reason))) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["reasonCodes"],
      message: `${value.outcome} outcome reasons must be drawn from its own class`,
    });
  }
  requireMatchingHash(value.evaluationHash, value as ChangeAuthorizationPolicyEvaluationV1,
    computeChangeAuthorizationPolicyEvaluationV1Hash, context, ["evaluationHash"], "evaluationHash");
});

export const ChangeAuthorizationPolicyDescriptorV1Schema = z.object({
  schemaVersion: z.literal(1),
  policyId: NonEmptyIdSchema,
  policyVersion: NonEmptyIdSchema,
  policyUri: NonEmptyIdSchema,
}).strict();

export const ChangeAuthorizationTrustPolicyDescriptorV1Schema = z.object({
  schemaVersion: z.literal(1),
  trustPolicyId: NonEmptyIdSchema,
  trustPolicyVersion: NonEmptyIdSchema,
}).strict();

export const ChangeAuthorizationAuthorityDescriptorV1Schema = z.object({
  schemaVersion: z.literal(1),
  policy: ChangeAuthorizationPolicyDescriptorV1Schema,
  policyRulesHash: Sha256HashSchema,
  trustPolicy: ChangeAuthorizationTrustPolicyDescriptorV1Schema,
  trustRootIds: z.array(NonEmptyIdSchema),
  trustedRootSetHash: Sha256HashSchema,
  descriptorDigest: Sha256HashSchema,
}).strict().superRefine((value, context) => {
  requireCanonicalStrings(value.trustRootIds, context, ["trustRootIds"]);
  requireMatchingHash(value.trustedRootSetHash, value.trustRootIds,
    computeChangeAuthorizationTrustRootSetV1Hash, context, ["trustedRootSetHash"], "trustedRootSetHash");
  requireMatchingHash(value.descriptorDigest, value as ChangeAuthorizationAuthorityDescriptorV1,
    computeChangeAuthorizationAuthorityDescriptorV1Hash, context, ["descriptorDigest"], "descriptorDigest");
});

const CapsuleShape = {
  schemaVersion: z.literal(1),
  kind: z.literal("change_authorization_capsule"),
  executionAuthority: z.literal("none"),
  enforcementMode: z.literal("shadow"),
  blockingEnabled: z.literal(false),
  authorizationEffect: z.literal("advisory_record"),
  capsuleId: NonEmptyIdSchema,
  basis: z.object({ record: ControlHandoffRecordV2Schema }).strict(),
  subject: ChangeAuthorizationSubjectV1Schema,
  providers: z.array(ChangeAuthorizationProviderV1Schema),
  claims: z.array(ChangeAuthorizationClaimV1Schema),
  assertions: z.array(ChangeAuthorizationAssertionV1Schema),
  evidenceBundles: z.array(ChangeAuthorizationEvidenceBundleV1Schema),
  evidenceUniverse: ChangeAuthorizationEvidenceUniverseV1Schema,
  policyRules: z.array(ChangeAuthorizationPolicyRuleV1Schema).min(1),
  policyEvaluations: z.array(ChangeAuthorizationPolicyEvaluationV1Schema).min(1),
  authorityDescriptor: ChangeAuthorizationAuthorityDescriptorV1Schema,
  verdict: ChangeAuthorizationVerdictV1Schema,
  reasonCodes: z.array(ChangeAuthorizationReasonCodeV1Schema).min(1),
  evaluatedAt: ChangeAuthorizationTimestampV1Schema,
  capsuleHash: Sha256HashSchema,
};

export const ChangeAuthorizationCapsuleV1Schema = z.object(CapsuleShape).strict()
  .superRefine((value, context) => {
    requireCanonicalReasons(value.reasonCodes, context, ["reasonCodes"]);
    requireCanonicalByKey(value.providers, (provider) => provider.providerId, context, ["providers"]);
    requireCanonicalByKey(value.claims, (claim) => claim.claimHash, context, ["claims"]);
    requireCanonicalByKey(value.assertions, (assertion) => assertion.assertionHash, context, ["assertions"]);
    requireCanonicalByKey(value.evidenceBundles, (bundle) => bundle.bundleHash, context, ["evidenceBundles"]);
    requireUniqueByKey(value.claims, (claim) => claim.claimId, context, ["claims"]);
    requireUniqueByKey(value.assertions, (assertion) => assertion.assertionId, context, ["assertions"]);
    requireUniqueByKey(value.evidenceBundles, (bundle) => bundle.bundleId, context, ["evidenceBundles"]);
    requireCanonicalByKey(value.policyRules, (rule) => rule.ruleId, context, ["policyRules"]);
    requireCanonicalByKey(
      value.policyEvaluations,
      (evaluation) => evaluation.evaluationHash,
      context,
      ["policyEvaluations"],
    );

    const record = value.basis.record;
    const capsuleV2 = record.capsule;
    const taskEnvelope = record.request.planningBundle.taskEnvelope;

    const expectedSubject = {
      changeId: taskEnvelope.changeId,
      changeContractHash: taskEnvelope.changeContractHash,
      parentIntentIds: [...taskEnvelope.parentIntentIds].sort(compareCodeUnits),
      nonGoals: [...taskEnvelope.nonGoals].sort(compareCodeUnits),
      expectedBehaviorDelta: [...taskEnvelope.expectedBehaviorDelta].sort(compareCodeUnits),
      declaredReconciliationScope: taskEnvelope.declaredReconciliationScope,
      planningCommit: taskEnvelope.planningCommit,
      observedCommit: capsuleV2.observedCommit,
      observedWorkingDiffHash: capsuleV2.observedWorkingDiffHash,
      touchedCoordinateIds: [...capsuleV2.touchedCoordinateIds].sort(compareCodeUnits),
      reconciliationTerminalStatus: capsuleV2.reconciliationTerminalStatus,
      reconciliationReasonCodes: capsuleV2.reconciliationReasonCodes,
    };
    if (
      value.subject.changeId !== expectedSubject.changeId
      || value.subject.changeContractHash !== expectedSubject.changeContractHash
      || JSON.stringify(value.subject.parentIntentIds) !== JSON.stringify(expectedSubject.parentIntentIds)
      || JSON.stringify(value.subject.nonGoals) !== JSON.stringify(expectedSubject.nonGoals)
      || JSON.stringify(value.subject.expectedBehaviorDelta)
        !== JSON.stringify(expectedSubject.expectedBehaviorDelta)
      || JSON.stringify(value.subject.declaredReconciliationScope)
        !== JSON.stringify(expectedSubject.declaredReconciliationScope)
      || value.subject.planningCommit !== expectedSubject.planningCommit
      || value.subject.observedCommit !== expectedSubject.observedCommit
      || value.subject.observedWorkingDiffHash !== expectedSubject.observedWorkingDiffHash
      || JSON.stringify(value.subject.touchedCoordinateIds) !== JSON.stringify(expectedSubject.touchedCoordinateIds)
      || value.subject.reconciliationTerminalStatus !== expectedSubject.reconciliationTerminalStatus
      || JSON.stringify(value.subject.reconciliationReasonCodes)
        !== JSON.stringify(expectedSubject.reconciliationReasonCodes)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["subject"],
        message: "subject must be an exact projection of the basis ControlHandoffRecordV2",
      });
    }

    value.claims.forEach((claim, index) => {
      if (claim.subject.changeId !== value.subject.changeId) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["claims", index, "subject", "changeId"],
          message: "claim subject must bind to this capsule's subject changeId",
        });
      }
    });
    const claimByHash = new Map(value.claims.map((claim) => [claim.claimHash, claim]));

    const touchedCoordinateIds = new Set<string>(capsuleV2.touchedCoordinateIds);
    const assertionByHash = new Map(value.assertions.map((assertion) => [assertion.assertionHash, assertion]));
    value.assertions.forEach((assertion, index) => {
      if (
        assertion.sourceCommit !== capsuleV2.observedCommit
        || assertion.sourceDiffHash !== capsuleV2.observedWorkingDiffHash
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["assertions", index],
          message: "assertion source must bind the basis observed commit and diff",
        });
      }
      if (assertion.scope.coordinateIds.some((id) => !touchedCoordinateIds.has(id))) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["assertions", index, "scope"],
          message: "assertion scope must stay within the basis touched coordinates",
        });
      }
      if (!value.providers.some((provider) => provider.providerId === assertion.providerId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["assertions", index, "providerId"],
          message: "assertion must reference a declared provider",
        });
      }
      const claim = claimByHash.get(assertion.claimHash);
      if (claim === undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["assertions", index, "claimHash"],
          message: "assertion must reference a declared claim",
        });
      } else if (requiredClaimKindForModality(assertion.modality) !== claim.subject.kind) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["assertions", index, "modality"],
          message: `modality ${assertion.modality} cannot address a ${claim.subject.kind} claim`,
        });
      }
      for (const dependencyHash of assertion.dependsOnAssertionHashes) {
        if (!assertionByHash.has(dependencyHash)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["assertions", index, "dependsOnAssertionHashes"],
            message: "assertion dependency must resolve within the capsule",
          });
        }
      }
      for (const contradictedHash of assertion.contradicts) {
        if (!assertionByHash.has(contradictedHash)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["assertions", index, "contradicts"],
            message: "contradicted assertion must resolve within the capsule",
          });
        }
      }
    });
    if (hasAssertionDependencyCycle(value.assertions)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["assertions"],
        message: "assertion dependencies must form an acyclic graph",
      });
    }

    const ruleIds = new Set(value.policyRules.map((rule) => rule.ruleId));
    value.policyRules.forEach((rule, index) => {
      if (!claimByHash.has(rule.requiredClaimHash)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["policyRules", index, "requiredClaimHash"],
          message: "policy rule must reference a declared claim",
        });
      }
    });
    value.evidenceBundles.forEach((bundle, index) => {
      if (!ruleIds.has(bundle.ruleId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["evidenceBundles", index, "ruleId"],
          message: "evidence bundle must reference a declared policy rule",
        });
      }
      if (bundle.assertionHashes.some((hash) => !assertionByHash.has(hash))) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["evidenceBundles", index, "assertionHashes"],
          message: "evidence bundle must reference declared assertions",
        });
      }
    });
    const bundleRuleIds = value.evidenceBundles.map((bundle) => bundle.ruleId);
    if (new Set(bundleRuleIds).size !== bundleRuleIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["evidenceBundles"],
        message: "at most one evidence bundle per policy rule",
      });
    }

    const expectedUniverseAssertionHashes = [...new Set(value.assertions.map((assertion) => assertion.assertionHash))]
      .sort(compareCodeUnits);
    const expectedUniverseBundleHashes = [...new Set(value.evidenceBundles.map((bundle) => bundle.bundleHash))]
      .sort(compareCodeUnits);
    if (
      JSON.stringify([...value.evidenceUniverse.assertionHashes].sort(compareCodeUnits))
        !== JSON.stringify(expectedUniverseAssertionHashes)
      || JSON.stringify([...value.evidenceUniverse.bundleHashes].sort(compareCodeUnits))
        !== JSON.stringify(expectedUniverseBundleHashes)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["evidenceUniverse"],
        message: "evidenceUniverse must contain the exact set of declared assertions and evidence bundles",
      });
    }

    requireMatchingHash(value.authorityDescriptor.policyRulesHash, value.policyRules,
      computeChangeAuthorizationPolicyRuleSetV1Hash, context,
      ["authorityDescriptor", "policyRulesHash"], "authorityDescriptor.policyRulesHash");

    const evaluationByRule = new Map(value.policyEvaluations.map((evaluation) => [evaluation.ruleId, evaluation]));
    if (
      evaluationByRule.size !== value.policyEvaluations.length
      || JSON.stringify([...ruleIds].sort(compareCodeUnits))
        !== JSON.stringify([...evaluationByRule.keys()].sort(compareCodeUnits))
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["policyEvaluations"],
        message: "there must be exactly one evaluation per declared policy rule",
      });
    }
    const bundleByRule = new Map(value.evidenceBundles.map((bundle) => [bundle.ruleId, bundle]));
    value.policyEvaluations.forEach((evaluation, index) => {
      const rule = value.policyRules.find((candidate) => candidate.ruleId === evaluation.ruleId);
      const bundleForRule = bundleByRule.get(evaluation.ruleId);
      if (
        evaluation.contributingAssertionHashes.some(
          (hash) => !(bundleForRule?.assertionHashes.includes(hash) ?? false),
        )
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["policyEvaluations", index, "contributingAssertionHashes"],
          message: "contributing assertions must belong to the rule's evidence bundle",
        });
      }
      if (
        rule !== undefined
        && evaluation.contributingAssertionHashes.some((hash) => {
          const assertion = assertionByHash.get(hash);
          return assertion === undefined
            || !rule.allowedModalities.includes(assertion.modality)
            || assertion.claimHash !== rule.requiredClaimHash
            || assertion.conclusion !== "SUPPORTS";
        })
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["policyEvaluations", index, "contributingAssertionHashes"],
          message: "contributing assertions must SUPPORT the rule's required claim with an allowlisted modality",
        });
      }
      if (rule !== undefined && bundleForRule !== undefined) {
        const bundleAssertions = bundleForRule.assertionHashes.map((hash) => assertionByHash.get(hash));
        const hasContradiction = bundleAssertions.some(
          (assertion) => assertion?.claimHash === rule.requiredClaimHash && assertion.conclusion === "CONTRADICTS",
        );
        if (hasContradiction && evaluation.outcome !== "violated") {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["policyEvaluations", index, "outcome"],
            message: "a bundle that contradicts the rule's required claim must be violated",
          });
        }
      }
    });

    const ranks = value.policyEvaluations.map((evaluation) => outcomeRank(evaluation.outcome));
    const ruleAggregateRank = Math.min(...ranks);
    const basisCeiling = capsuleV2.reconciliationTerminalStatus === "VIOLATED"
      ? 0
      : capsuleV2.reconciliationTerminalStatus === "UNPROVEN"
        ? 1
        : 2;
    const expectedRank = Math.min(ruleAggregateRank, basisCeiling);
    if (CHANGE_AUTHORIZATION_VERDICT_RANK[value.verdict] !== expectedRank) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["verdict"],
        message: "verdict must equal the precedence of rule outcomes bounded by the basis reconciliation ceiling",
      });
    }

    const expectedReasons = new Set<ChangeAuthorizationReasonCodeV1>();
    for (const evaluation of value.policyEvaluations) {
      if (evaluation.outcome !== "satisfied") for (const reason of evaluation.reasonCodes) expectedReasons.add(reason);
    }
    if (capsuleV2.reconciliationTerminalStatus !== "REALIZED") expectedReasons.add("OPEN_UNKNOWN");
    if (capsuleV2.reconciliationTerminalStatus === "VIOLATED") expectedReasons.add("INVARIANT_VIOLATED");
    if (expectedReasons.size === 0) expectedReasons.add("POLICY_SATISFIED");
    const canonicalExpected = [...expectedReasons].sort(
      (left, right) =>
        CHANGE_AUTHORIZATION_REASON_ORDER.indexOf(left) - CHANGE_AUTHORIZATION_REASON_ORDER.indexOf(right),
    );
    if (JSON.stringify(value.reasonCodes) !== JSON.stringify(canonicalExpected)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reasonCodes"],
        message: "capsule reasonCodes must equal the aggregation of rule and basis reasons",
      });
    }

    requireMatchingHash(value.capsuleHash, value as ChangeAuthorizationCapsuleV1,
      computeChangeAuthorizationCapsuleV1Hash, context, ["capsuleHash"], "capsuleHash");
  });

export const ChangeAuthorizationInTotoStatementV1Schema = z.object({
  _type: z.literal("https://in-toto.io/Statement/v1"),
  subject: z.array(z.object({
    name: NonEmptyIdSchema,
    digest: z.object({ sha256: z.string().regex(/^[0-9a-f]{64}$/) }).strict(),
  }).strict()).length(1),
  predicateType: z.literal(CHANGE_AUTHORIZATION_PREDICATE_TYPE_V1),
  predicate: ChangeAuthorizationCapsuleV1Schema,
}).strict().superRefine((value, context) => {
  const subject = value.subject[0]!;
  if (subject.name !== value.predicate.subject.changeId) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["subject", 0, "name"],
      message: "in-toto subject name must equal predicate.subject.changeId",
    });
  }
  if (subject.digest.sha256 !== value.predicate.subject.subjectHash.slice("sha256:".length)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["subject", 0, "digest", "sha256"],
      message: "in-toto subject digest must equal predicate.subject.subjectHash (unprefixed)",
    });
  }
});

function outcomeRank(outcome: ChangeAuthorizationRuleOutcomeV1): number {
  return outcome === "violated" ? 0 : outcome === "insufficient" ? 1 : 2;
}

function hasAssertionDependencyCycle(
  assertions: readonly Pick<ChangeAuthorizationAssertionV1, "assertionHash" | "dependsOnAssertionHashes">[],
): boolean {
  const byHash = new Map(assertions.map((assertion) => [assertion.assertionHash, assertion]));
  const visiting = new Set<Sha256Hash>();
  const visited = new Set<Sha256Hash>();
  const visit = (hash: Sha256Hash): boolean => {
    if (visiting.has(hash)) return true;
    if (visited.has(hash)) return false;
    visiting.add(hash);
    for (const dependency of byHash.get(hash)?.dependsOnAssertionHashes ?? []) {
      if (visit(dependency)) return true;
    }
    visiting.delete(hash);
    visited.add(hash);
    return false;
  };
  return assertions.some((assertion) => visit(assertion.assertionHash));
}

function requireMatchingHash<T>(
  actual: Sha256Hash,
  value: T,
  compute: (input: T) => Sha256Hash,
  context: z.RefinementCtx,
  path: (string | number)[],
  label: string,
): void {
  try {
    if (actual !== compute(value)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path, message: `${label} does not match canonical content` });
    }
  } catch {
    context.addIssue({ code: z.ZodIssueCode.custom, path, message: `${label} content is not JCS-safe` });
  }
}

function requireCanonicalStrings(
  values: readonly string[],
  context: z.RefinementCtx,
  path: (string | number)[],
): void {
  const canonical = [...new Set(values)].sort(compareCodeUnits);
  if (canonical.length !== values.length || canonical.some((value, index) => value !== values[index])) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path,
      message: "values must be unique and use canonical ASCII order",
    });
  }
}

function requireCanonicalByKey<T>(
  values: readonly T[],
  key: (value: T) => string,
  context: z.RefinementCtx,
  path: (string | number)[],
): void {
  requireCanonicalStrings(values.map(key), context, path);
}

function requireUniqueByKey<T>(
  values: readonly T[],
  key: (value: T) => string,
  context: z.RefinementCtx,
  path: (string | number)[],
): void {
  const keys = values.map(key);
  if (new Set(keys).size !== keys.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path,
      message: "logical ids must be unique",
    });
  }
}

function requireCanonicalReasons(
  reasons: readonly ChangeAuthorizationReasonCodeV1[],
  context: z.RefinementCtx,
  path: (string | number)[],
): void {
  const canonical = [...new Set(reasons)].sort(
    (left, right) =>
      CHANGE_AUTHORIZATION_REASON_ORDER.indexOf(left) - CHANGE_AUTHORIZATION_REASON_ORDER.indexOf(right),
  );
  if (canonical.length !== reasons.length || canonical.some((reason, index) => reason !== reasons[index])) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path,
      message: "reason codes must be unique and canonically ordered",
    });
  }
}
