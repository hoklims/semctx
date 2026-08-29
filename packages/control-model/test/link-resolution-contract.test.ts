import { describe, expect, it } from "bun:test";
import {
  CanonicalLinkResolutionSchema,
  UnresolvedRepositoryLinkSchema,
} from "../src/link-resolution";

const stale = {
  ownerId: "invariant.links",
  link: { kind: "symbol" as const, ref: "sym:function:src/a.ts:run" },
  resolved: false as const,
  reason: "several declarations match",
  reasonCode: "ambiguous" as const,
  candidates: ["sym:function:src/a.ts:outer.run", "sym:function:src/a.ts:run"],
};

describe("canonical link-resolution contract", () => {
  it("accepts a canonical unresolved diagnostic", () => {
    expect(UnresolvedRepositoryLinkSchema.parse(stale)).toEqual(stale);
  });

  it("rejects unknown fields and contradictory resolved states", () => {
    expect(CanonicalLinkResolutionSchema.safeParse({ ...stale, invented: true }).success).toBe(false);
    expect(CanonicalLinkResolutionSchema.safeParse({
      ...stale,
      resolved: true,
    }).success).toBe(false);
    expect(CanonicalLinkResolutionSchema.safeParse({
      ownerId: stale.ownerId,
      link: stale.link,
      resolved: false,
      reason: stale.reason,
      reasonCode: stale.reasonCode,
      legacy: true,
    }).success).toBe(false);
  });

  it("rejects invalid reason codes and non-canonical candidates", () => {
    expect(UnresolvedRepositoryLinkSchema.safeParse({ ...stale, reasonCode: "moved_maybe" }).success).toBe(false);
    expect(UnresolvedRepositoryLinkSchema.safeParse({
      ...stale,
      candidates: [...stale.candidates].reverse(),
    }).success).toBe(false);
    expect(UnresolvedRepositoryLinkSchema.safeParse({
      ...stale,
      reasonCode: "path_absent",
      candidates: ["src/a.ts"],
    }).success).toBe(false);
  });
});
