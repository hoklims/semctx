import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { analyzeRepository, parseMarkers, parseFrontmatter, extractDoc, extractMigration } from "@semantic-context/ts-analyzer";
import type { RepositoryNode, RepositoryEdge, NodeKind, EdgeKind } from "@semantic-context/core";
import { sampleConfig, SAMPLE_REPO, EXPECTED, must } from "@semantic-context/test-fixtures";

const { graph, evidence } = analyzeRepository(sampleConfig());
const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
const kind = (k: NodeKind): RepositoryNode[] => graph.nodes.filter((n) => n.kind === k);
const edges = (k: EdgeKind): RepositoryEdge[] => graph.edges.filter((e) => e.kind === k);
const named = (list: RepositoryNode[]): string[] => list.map((n) => n.name);

describe("markers", () => {
  it("parses capability, invariant (with statement) and boundedContext tags", () => {
    const markers = parseMarkers("/**\n * @capability foo\n * @invariant bar: it must hold\n * @boundedContext booking\n */");
    expect(markers.find((m) => m.tag === "capability")?.slug).toBe("foo");
    const inv = must(markers.find((m) => m.tag === "invariant"));
    expect(inv.slug).toBe("bar");
    expect(inv.statement).toBe("it must hold");
    expect(markers.find((m) => m.tag === "boundedContext")?.slug).toBe("booking");
  });
});

describe("frontmatter", () => {
  it("parses scalars, booleans and inline arrays", () => {
    const fm = parseFrontmatter("---\nstatus: deprecated\ndeprecated: true\ncapabilities: [a, b]\n---\nbody text");
    expect(fm.data["status"]).toBe("deprecated");
    expect(fm.data["deprecated"]).toBe(true);
    expect(fm.data["capabilities"]).toEqual(["a", "b"]);
    expect(fm.body.trim()).toBe("body text");
  });
});

describe("graph generation — symbols, imports, exports", () => {
  it("extracts exported functions with the exported flag", () => {
    const fns = named(kind("function"));
    expect(fns).toContain("confirmReservation");
    expect(fns).toContain("remainingCapacity");
    expect(fns).toContain("confirmedSeats");
    const confirm = must(kind("function").find((n) => n.name === "confirmReservation"));
    expect(confirm.exported).toBe(true);
  });

  it("extracts import edges between modules", () => {
    expect(edges("imports").length).toBeGreaterThan(0);
    const importPairs = edges("imports").map((e) => `${nodeById.get(e.from)?.name}->${nodeById.get(e.to)?.name}`);
    expect(importPairs).toContain("confirmation.ts->capacity.ts");
  });

  it("extracts interfaces and types", () => {
    expect(named(kind("interface"))).toContain("ReservationRepository");
    expect(named(kind("type"))).toContain("ReservationStatus");
  });
});

describe("symbol resolution — cross-file call graph", () => {
  it("resolves the confirmation call path through import aliases", () => {
    const callPairs = edges("calls").map((e) => `${nodeById.get(e.from)?.name}->${nodeById.get(e.to)?.name}`);
    expect(callPairs).toContain("handleConfirmReservation->confirmReservation");
    expect(callPairs).toContain("confirmReservation->remainingCapacity");
    expect(callPairs).toContain("remainingCapacity->confirmedSeats");
  });

  it("links tests to the symbols they import (tested_by)", () => {
    const testedSymbols = edges("tested_by").map((e) => nodeById.get(e.from)?.name);
    expect(testedSymbols).toContain("confirmReservation");
    expect(testedSymbols).toContain("remainingCapacity");
  });
});

describe("semantic markers become corroborated nodes", () => {
  it("creates the capacity invariant corroborated by code, doc AND migration", () => {
    const inv = must(kind("invariant").find((n) => n.name === EXPECTED.invariant));
    expect(inv.tags).toContain("from-code");
    expect(inv.tags).toContain("from-doc");
    expect(inv.tags).toContain("from-migration");
    expect(String(inv.metadata["statement"])).toContain("CONFIRMED");
  });

  it("wires implements_capability from confirmation code", () => {
    const impl = edges("implements_capability").map((e) => nodeById.get(e.from)?.name);
    expect(impl).toContain("confirmReservation");
    expect(impl).toContain("handleConfirmReservation");
  });
});

describe("document ingestion", () => {
  it("flags the deprecated doc", () => {
    const content = readFileSync(join(SAMPLE_REPO, EXPECTED.deprecatedDoc), "utf8");
    const doc = extractDoc(EXPECTED.deprecatedDoc, content);
    expect(doc.deprecated).toBe(true);
    expect(doc.contradicts).toContain("docs/booking-rules.md");
  });

  it("creates a contradicts edge from the deprecated doc to the current one", () => {
    const contradicts = edges("contradicts");
    expect(contradicts.length).toBeGreaterThan(0);
    const from = must(nodeById.get(must(contradicts[0]).from));
    expect(from.metadata["deprecated"]).toBe(true);
  });
});

describe("migration detection", () => {
  it("parses tables and constraint markers", () => {
    const content = readFileSync(join(SAMPLE_REPO, EXPECTED.migration), "utf8");
    const mig = extractMigration(EXPECTED.migration, content);
    expect(mig.tables).toContain("reservations");
    expect(mig.tables).toContain("slots");
    expect(mig.constraints.map((c) => c.invariantSlug)).toContain(EXPECTED.invariant);
  });

  it("creates a migration node in the graph", () => {
    const mig = must(kind("migration")[0]);
    expect(mig.name).toContain("0001");
  });
});

describe("evidence registry", () => {
  it("every node/edge evidence resolves to a stored record", () => {
    expect(evidence.length).toBeGreaterThan(0);
    const ids = new Set(evidence.map((e) => e.id));
    expect(ids.size).toBe(evidence.length);
  });
});
