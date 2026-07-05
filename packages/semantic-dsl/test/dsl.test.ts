import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseSemanticSource, formatModel, renderModel, renderNode, hasErrors } from "../src/index";
import type { SemanticModel } from "@semantic-context/semantic-model";

const FIXTURE = readFileSync(join(import.meta.dir, "fixtures", "reservation.sem"), "utf8");

describe("parseSemanticSource — the reservation fixture", () => {
  const { model, diagnostics } = parseSemanticSource(FIXTURE, "reservation.sem");

  it("parses without errors", () => {
    expect(hasErrors(diagnostics)).toBe(false);
  });

  it("collects the truth nodes and the change contract", () => {
    // ids are kept verbatim from the source (the `proof.` alias is preserved as authored).
    expect(model.nodes).toHaveLength(4);
    expect(model.nodes.find((n) => n.id === "goal.checkout.reliable-payment")?.kind).toBe("goal");
    expect(model.nodes.find((n) => n.id === "invariant.payment.idempotent")?.kind).toBe("invariant");
    expect(model.nodes.find((n) => n.id === "proof.test.webhook-duplicate-event")?.kind).toBe("evidence");
    expect(model.changes).toHaveLength(1);
  });

  it("accepts the `rule` synonym for an invariant statement", () => {
    const inv = model.nodes.find((n) => n.id === "invariant.payment.idempotent");
    expect(inv?.statement).toBe("retry(event) is equivalent to apply_once(event)");
  });

  it("infers repository-link kinds from ref prefixes", () => {
    const inv = model.nodes.find((n) => n.id === "invariant.payment.idempotent");
    const kinds = inv?.repositoryLinks.map((l) => l.kind).sort();
    expect(kinds).toEqual(["invariant", "symbol"]);
  });

  it("populates the change contract's typed relation arrays from all list forms", () => {
    const change = model.changes[0];
    expect(change?.lifecycle).toBe("active");
    expect(change?.serves).toEqual(["goal.checkout.reliable-payment"]); // inline [ ] form
    expect(change?.preserves).toEqual(["invariant.payment.idempotent"]); // block-list form
    expect(change?.requiresEvidence).toEqual(["proof.test.webhook-duplicate-event"]); // `requires` synonym
    expect(change?.openUnknowns).toEqual(["unknown.cancellation-race"]);
  });
});

describe("formatModel — deterministic and idempotent", () => {
  const parseModel = (text: string): SemanticModel => parseSemanticSource(text, "x.sem").model;

  it("is idempotent: format(parse(format(parse(x)))) === format(parse(x))", () => {
    const once = formatModel(parseModel(FIXTURE));
    const twice = formatModel(parseModel(once));
    expect(twice).toBe(once);
  });

  it("emits a stable, canonical shape (repeated-key, sorted targets)", () => {
    const out = formatModel(parseModel(FIXTURE));
    // Canonical multi-value uses repeated keys, not inline arrays.
    expect(out).not.toContain("[");
    // Truth nodes come before change contracts; blocks are id-sorted.
    expect(out.indexOf("goal goal.checkout.reliable-payment")).toBeLessThan(out.indexOf("change change.stripe-webhook-retry"));
    expect(out.endsWith("\n")).toBe(true);
  });

  it("round-trips the model structure through format→parse", () => {
    const model = parseModel(FIXTURE);
    const reparsed = parseModel(formatModel(model));
    expect(reparsed.nodes.length).toBe(model.nodes.length);
    expect(reparsed.changes.length).toBe(model.changes.length);
    expect(reparsed.changes[0]?.preserves).toEqual(model.changes[0]?.preserves ?? []);
  });
});

describe("diagnostics — precise and non-throwing", () => {
  it("reports an unknown block kind with a line/column", () => {
    const { diagnostics } = parseSemanticSource("frobnicate goal.x\n  statement: hi\n", "x.sem");
    expect(diagnostics.some((d) => d.severity === "error" && d.message.includes("unknown block kind"))).toBe(true);
    expect(diagnostics[0]?.line).toBe(1);
  });

  it("reports a bad status and a missing id", () => {
    const missingId = parseSemanticSource("goal\n", "x.sem");
    expect(missingId.diagnostics.some((d) => d.message.includes("missing an id"))).toBe(true);
    const badStatus = parseSemanticSource("goal goal.x\n  statement: hi\n  status: banana\n", "x.sem");
    expect(badStatus.diagnostics.some((d) => d.message.includes('unknown status "banana"'))).toBe(true);
  });

  it("warns on a mismatched id prefix but still parses the block", () => {
    const { model, diagnostics } = parseSemanticSource("goal invariant.x\n  statement: hi\n", "x.sem");
    expect(model.nodes[0]?.kind).toBe("goal");
    expect(diagnostics.some((d) => d.severity === "warning" && d.message.includes("prefix"))).toBe(true);
  });

  it("flags a list item with no preceding key", () => {
    const { diagnostics } = parseSemanticSource("goal goal.x\n  statement: hi\n  - orphan\n", "x.sem");
    expect(diagnostics.some((d) => d.message.includes("no preceding key"))).toBe(true);
  });
});

describe("renderers — symbols and ascii projections", () => {
  const { model } = parseSemanticSource(FIXTURE, "reservation.sem");

  it("renders an invariant with a rule label in symbol notation", () => {
    const inv = model.nodes.find((n) => n.id === "invariant.payment.idempotent");
    const out = renderNode(inv!, "symbols");
    expect(out).toContain("□ invariant.payment.idempotent");
    expect(out).toContain("rule:");
  });

  it("offers a glyph-free ascii projection", () => {
    const ascii = renderModel(model, "ascii");
    expect(ascii).toContain("[goal] goal.checkout.reliable-payment");
    expect(ascii).not.toContain("◇");
    expect(ascii).not.toContain("Δ");
  });
});
