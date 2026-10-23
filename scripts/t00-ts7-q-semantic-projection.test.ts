import { expect, test } from "bun:test";
import { closeProjection } from "./t00-ts7-q-semantic-projection";
import type { ProjectionRun } from "./t00-ts7-q-semantic-projection";

const scenarios = ["unary-minus", "logical-negation"];
const pair = (): ProjectionRun[] => scenarios.flatMap(scenario => (["activate", "control"] as const).map(label => ({
  scenario, label, predicateMatched: scenario === "unary-minus", projected: true, exactReasons: true, processVerified: true,
  sites: [{ expression: "node.operator", activation: true }], gaps: [],
})));

test("cumulative closure requires independent projections and both fresh exact comparisons", () => {
  expect(closeProjection(97, ["node.operator"], scenarios, pair()).status).toBe("passed");
  for (const key of ["projected", "exactReasons", "processVerified"] as const) {
    const runs = pair();
    runs[1]![key] = false;
    expect(closeProjection(97, ["node.operator"], scenarios, runs).status).not.toBe("passed");
  }
});

test("missing sites, controls, alternatives and unresolved projection gaps cannot pass", () => {
  expect(closeProjection(97, ["node.operator", "node.operand"], scenarios, pair()).status).toBe("not_run");
  expect(closeProjection(97, ["node.operator"], scenarios, pair().slice(0, 1)).status).toBe("not_run");
  expect(closeProjection(97, ["node.operator"], [...scenarios, "postfix"], pair()).status).toBe("not_run");
  const runs = pair();
  runs[0]!.gaps.push("unresolved operand type");
  expect(closeProjection(97, ["node.operator"], scenarios, runs).status).toBe("not_run");
  expect(closeProjection(97, [], scenarios, pair()).status).toBe("not_run");
  expect(closeProjection(97, ["node.operator"], [], []).status).toBe("not_run");
});

test("duplicate runs cannot substitute for a missing control or conceal failed observations", () => {
  const runs = pair();
  expect(closeProjection(97, ["node.operator"], scenarios, [runs[0]!, runs[0]!]).status).toBe("not_run");
  expect(closeProjection(97, ["node.operator"], scenarios, [...runs, { ...runs[0]!, exactReasons: false }]).status).toBe("failed");
});

test("site declarations cannot replace an unobserved negative predicate alternative", () => {
  const runs = pair().map(run => ({ ...run, predicateMatched: true }));
  expect(closeProjection(97, ["node.operator"], scenarios, runs).status).toBe("not_run");
});

test("binary closure requires the right operand to independently activate coercion", () => {
  const runs = pair().map(run => ({ ...run, operands: { leftPrimitive: run.label === "control", rightPrimitive: true } }));
  expect(closeProjection(61, ["node.operator"], scenarios, runs).status).toBe("not_run");
  const right: ProjectionRun[] = pair().slice(0, 2).map(run => ({ ...run, scenario: "right", operands: { leftPrimitive: true, rightPrimitive: run.label === "control" } }));
  expect(closeProjection(61, ["node.operator"], [...scenarios, "right"], [...runs, ...right]).status).toBe("passed");
});
