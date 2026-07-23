import { describe, expect, it } from "bun:test";
import type { RefinementRelationV1 } from "@semantic-context/control-model";
import {
  formatModel,
  formatRefinementRelation,
  hasErrors,
  parseSemanticSource,
} from "../src/index";

const HUNK = `sha256:${"a".repeat(64)}` as const;
const DIGEST = "b".repeat(64);

function relation(overrides: Partial<RefinementRelationV1> = {}): RefinementRelationV1 {
  return {
    schemaVersion: 1,
    id: "rel.goal-to-hunk",
    kind: "decomposes_to",
    source: { plane: "B", kind: "semantic_node", nodeId: "goal.checkout" },
    target: { plane: "A", kind: "observed_diff_hunk", coordinateDigest: HUNK },
    epistemicStatus: "human_declared",
    provenance: "author",
    evidenceRefs: [{
      schemaVersion: 1,
      kind: "document_span",
      locator: "docs/plan.md:10",
      digest: { algorithm: "sha256", value: DIGEST },
    }],
    ...overrides,
  };
}

describe("refinement relation DSL v2", () => {
  it("round-trips all closed relation, epistemic, and provenance values", () => {
    const kinds = ["decomposes_to", "realizes", "implements", "constrained_by", "proved_by"] as const;
    const statuses = [
      "human_declared",
      "statically_observed",
      "dynamically_observed",
      "test_observed",
      "historically_observed",
      "llm_inferred",
      "hypothetical",
    ] as const;
    const provenances = ["author", "agent", "derived"] as const;

    for (const kind of kinds) {
      for (const epistemicStatus of statuses) {
        for (const provenance of provenances) {
          const value = relation({ id: `rel.${kind}.${epistemicStatus}.${provenance}`, kind, epistemicStatus, provenance });
          const source = `${formatRefinementRelation(value)}\n`;
          const parsed = parseSemanticSource(source, "relations.sem");
          expect(parsed.diagnostics).toEqual([]);
          expect(parsed.model.refinementRelations).toEqual([value]);
          expect(formatModel(parsed.model)).toBe(source);
        }
      }
    }
  });

  it("sorts relations and evidence canonically without normalizing invalid authored order", () => {
    const value = relation({
      evidenceRefs: [
        { schemaVersion: 1, kind: "test_result", locator: "z", digest: { algorithm: "sha256", value: "f".repeat(64) } },
        { schemaVersion: 1, kind: "commit", locator: "a", digest: { algorithm: "sha256", value: "0".repeat(64) } },
      ],
    });
    const formatted = formatRefinementRelation(value);
    expect(formatted.indexOf("evidenceRef commit")).toBeLessThan(formatted.indexOf("evidenceRef test_result"));

    const reversed = formatted.split("\n");
    [reversed[1], reversed[2]] = [reversed[2]!, reversed[1]!];
    const parsed = parseSemanticSource(`${reversed.join("\n")}\n`, "bad.sem");
    expect(parsed.diagnostics.map((item) => item.code)).toContain("RELATION_FIELD_OUT_OF_ORDER");
    expect(parsed.model.refinementRelations).toEqual([]);
  });

  it("uses tagged endpoints and escaped ASCII tokens", () => {
    const value = relation({
      id: "rel.with space",
      source: { plane: "B", kind: "semantic_node", nodeId: "goal.with space" },
      evidenceRefs: [{
        schemaVersion: 1,
        kind: "document_span",
        locator: "docs/a file.md:1",
        digest: { algorithm: "sha256", value: DIGEST },
      }],
    });
    const formatted = formatRefinementRelation(value);
    expect(formatted).toContain('relation "rel.with space"');
    expect(formatted).toContain('semantic "goal.with space"');
    expect(formatted).toContain('"docs/a file.md:1"');
    expect(parseSemanticSource(`${formatted}\n`, "x.sem").model.refinementRelations).toEqual([value]);
  });

  it.each([
    ["duplicate id", `${formatRefinementRelation(relation())}\n${formatRefinementRelation(relation())}\n`, "RELATION_DUPLICATE_ID"],
    ["unknown kind", formatRefinementRelation(relation()).replace("decomposes_to", "supports"), "RELATION_UNKNOWN_KIND"],
    ["unknown status", formatRefinementRelation(relation()).replace("human_declared", "verified"), "RELATION_UNKNOWN_EPISTEMIC_STATUS"],
    ["unknown provenance", formatRefinementRelation(relation()).replace("provenance author", "provenance alice"), "RELATION_UNKNOWN_PROVENANCE"],
    ["malformed digest", formatRefinementRelation(relation()).replace(HUNK, "sha256:ABC"), "RELATION_MALFORMED_DIGEST"],
    ["missing evidence", formatRefinementRelation(relation()).split("\n").filter((line) => !line.startsWith("evidenceRef ")).join("\n"), "RELATION_MISSING_EVIDENCE"],
    ["missing end", formatRefinementRelation(relation()).replace(/\nend$/, ""), "RELATION_MISSING_END"],
    ["unknown field", formatRefinementRelation(relation()).replace("provenance author", "mystery author"), "RELATION_UNKNOWN_FIELD"],
    ["unicode", formatRefinementRelation(relation()).replace("goal.checkout", "goal.chèque"), "RELATION_NON_ASCII"],
  ])("rejects %s with a stable diagnostic", (_name, source, code) => {
    const parsed = parseSemanticSource(`${source}\n`, "bad.sem");
    expect(hasErrors(parsed.diagnostics)).toBe(true);
    expect(parsed.diagnostics.map((item) => item.code)).toContain(code);
    expect(parsed.diagnostics.find((item) => item.code === code)?.line).toBeGreaterThan(0);
    expect(parsed.diagnostics.find((item) => item.code === code)?.column).toBeGreaterThan(0);
    expect(parsed.model.refinementRelations).toEqual([]);
  });

  it("rejects duplicate evidence and leaves legacy bare relations non-certifying", () => {
    const lines = formatRefinementRelation(relation()).split("\n");
    lines.splice(-1, 0, lines.at(-2)!);
    const duplicate = parseSemanticSource(`${lines.join("\n")}\n`, "bad.sem");
    expect(duplicate.diagnostics.map((item) => item.code)).toContain("RELATION_DUPLICATE_EVIDENCE");

    const legacy = parseSemanticSource("goal goal.legacy\n  statement: Legacy\n  implements: invariant.x\n", "legacy.sem");
    expect(legacy.model.nodes[0]?.appliesAtLevel).toBeUndefined();
    expect(legacy.model.refinementRelations).toEqual([]);
    expect(legacy.compatibility[0]?.uncertainties).toEqual(["appliesAtLevel", "refinementEvidence"]);
  });

  it("rejects noncanonical authored evidence order and cross-tagged endpoint syntax", () => {
    const canonical = formatRefinementRelation(relation({
      evidenceRefs: [
        { schemaVersion: 1, kind: "commit", locator: "a", digest: { algorithm: "sha256", value: "0".repeat(64) } },
        { schemaVersion: 1, kind: "test_result", locator: "z", digest: { algorithm: "sha256", value: "f".repeat(64) } },
      ],
    }));
    const lines = canonical.split("\n");
    [lines[4], lines[5]] = [lines[5]!, lines[4]!];
    expect(parseSemanticSource(`${lines.join("\n")}\n`, "bad.sem").diagnostics.map((item) => item.code))
      .toContain("RELATION_EVIDENCE_OUT_OF_ORDER");

    const crossTagged = canonical.replace("target observed_hunk", "target semantic observed_hunk");
    expect(parseSemanticSource(`${crossTagged}\n`, "bad.sem").diagnostics.map((item) => item.code))
      .toContain("RELATION_INVALID_ENDPOINT");
  });

  it("never silently drops relationDigest from the frozen DSL", () => {
    expect(() => formatRefinementRelation(relation({ relationDigest: HUNK })))
      .toThrow("relationDigest is aggregate metadata");
  });

  it("rejects noncanonical whitespace/token spelling instead of silently rewriting it", () => {
    const canonical = formatRefinementRelation(relation());
    const extraSpace = canonical.replace("target observed_hunk", "target  observed_hunk");
    expect(parseSemanticSource(`${extraSpace}\n`, "bad.sem").diagnostics.map((item) => item.code))
      .toContain("RELATION_NON_CANONICAL_ENCODING");

    const quotedBareId = canonical.replace("relation rel.goal-to-hunk", 'relation "rel.goal-to-hunk"');
    expect(parseSemanticSource(`${quotedBareId}\n`, "bad.sem").diagnostics.map((item) => item.code))
      .toContain("RELATION_NON_CANONICAL_ENCODING");
  });

  it("parses an explicit node level without deriving it from kind", () => {
    const parsed = parseSemanticSource([
      "goal goal.component",
      "  statement: Component-shaped goal",
      "  appliesAtLevel: 2",
      "",
      "invariant invariant.strategy",
      "  statement: Strategy-shaped invariant",
      "  appliesAtLevel: 6",
      "",
    ].join("\n"), "levels.sem");
    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.model.nodes.map(({ kind, appliesAtLevel }) => ({ kind, appliesAtLevel }))).toEqual([
      { kind: "goal", appliesAtLevel: 2 },
      { kind: "invariant", appliesAtLevel: 6 },
    ]);
  });

  it("keeps L0 reserved for tagged observed hunks", () => {
    const parsed = parseSemanticSource("goal goal.not-observed\n  statement: Not L0\n  appliesAtLevel: 0\n", "bad.sem");
    expect(parsed.diagnostics.map((item) => item.code)).toContain("SEMANTIC_LEVEL_INVALID");
    expect(parsed.model.nodes[0]?.appliesAtLevel).toBeUndefined();
  });
});
