import { describe, it, expect } from "bun:test";
import { parseSemanticSource } from "../src/index";

describe("parser hardening (from adversarial review)", () => {
  it("keeps a bracketed scalar value literal instead of splitting it into a list", () => {
    const { model, diagnostics } = parseSemanticSource("goal goal.x\n  statement: [a, b]\n", "x.sem");
    expect(model.nodes[0]?.statement).toBe("[a, b]"); // no silent data loss to just 'b'
    expect(diagnostics.filter((d) => d.severity === "error")).toHaveLength(0);
  });

  it("warns on a typo'd (unknown) field key instead of silently dropping it", () => {
    const { model, diagnostics } = parseSemanticSource("change change.c\n  statement: s\n  sereves: goal.x\n", "x.sem");
    expect(model.changes[0]?.serves).toEqual([]); // the typo did not become a relation
    expect(diagnostics.some((d) => d.severity === "warning" && d.message.includes('unknown field "sereves"'))).toBe(true);
  });

  it("still accepts a correctly-spelled relation key", () => {
    const { model } = parseSemanticSource("change change.c\n  statement: s\n  serves: goal.x\n", "x.sem");
    expect(model.changes[0]?.serves).toEqual(["goal.x"]);
  });

  it("points an unknown-status diagnostic at the status field, not the block header", () => {
    const { diagnostics } = parseSemanticSource("goal goal.x\n  statement: s\n  status: bogus\n", "x.sem");
    const d = diagnostics.find((x) => x.message.includes('unknown status "bogus"'));
    expect(d?.line).toBe(3); // the `status:` line, not the header (line 1)
    expect(d?.column).toBe(3); // indent(2) + 1
  });
});

describe("semantic model schema at the DSL boundary", () => {
  it.each(["goal goal.bad", "change change.bad"])("rejects an empty repository ref in %s with its field location", (header) => {
    const source = `goal goal.valid\n  statement: valid\n\n${header}\n  statement: invalid ref\n  link: file:\n`;
    const { model, diagnostics } = parseSemanticSource(source, "schema.sem");
    expect(diagnostics).toContainEqual(expect.objectContaining({
      file: "schema.sem", line: 6, column: 3, severity: "error", code: "SEMANTIC_SCHEMA_INVALID",
      message: expect.stringContaining("repositoryLinks.0.ref"),
    }));
    expect(model.nodes.map((node) => node.id)).toEqual(["goal.valid"]);
    expect(model.changes).toEqual([]);
  });
  it("locates an invalid link after duplicate links at the invalid field", () => {
    const { diagnostics } = parseSemanticSource("goal goal.bad\n  statement: s\n  file: valid.ts\n  file: valid.ts\n  link: file:\n", "duplicate.sem");
    expect(diagnostics).toContainEqual(expect.objectContaining({
      file: "duplicate.sem", line: 5, column: 3, severity: "error", code: "SEMANTIC_SCHEMA_INVALID",
    }));
  });

  it("rejects an out-of-schema relation after duplicates with its field location", () => {
    const { model, diagnostics } = parseSemanticSource("goal goal.bad\n  statement: s\n  preserves: invariant.one\n  preserves: invariant.one\n  constructor: wrong\n", "relation.sem");
    expect(model.nodes).toEqual([]);
    expect(diagnostics).toContainEqual(expect.objectContaining({
      file: "relation.sem", line: 5, column: 3, severity: "error", code: "SEMANTIC_SCHEMA_INVALID",
      message: expect.stringContaining("relations.1.kind"),
    }));
  });

});
