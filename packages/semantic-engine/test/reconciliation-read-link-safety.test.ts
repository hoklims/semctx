import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SemctxError } from "@semantic-context/core";
import { sha256HashUtf8 } from "@semantic-context/control-model";
import { createTargetProposal, type TargetArchitectureProposalInputV1 } from "../src/index";
import { loadSemanticModel, loadTargetArtifact } from "../src/reconciliation-read";

// The reconciliation loader is the read-only Plane-B surface behind task reconciliation. It
// deliberately imports no writer module, so it carries its own link checks: a checkout that plants
// `.semctx`, `semantic`, `targets` or a target directory as a link must not have reconciliation
// read a model or an artifact authored outside the repository (SEC-PB-01, read-only arm).

const GOAL = `goal goal.external.leak
  statement: authored outside the repository
  status: declared
`;

const roots: string[] = [];

function temporary(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  roots.push(path);
  return path;
}

function link(target: string, path: string): void {
  symlinkSync(target, path, process.platform === "win32" ? "junction" : "dir");
}

const linksSupported = ((): boolean => {
  const probe = mkdtempSync(join(tmpdir(), "semctx-reconcile-link-probe-"));
  try {
    link(probe, join(probe, "self"));
    return true;
  } catch {
    return false;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
})();

const linked = test.skipIf(!linksSupported);

function expectUnsafe(run: () => unknown): void {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(SemctxError);
  expect((caught as SemctxError).code).toBe("CONTROL_INPUTS_UNSAFE");
}

function proposal(): TargetArchitectureProposalInputV1 {
  return {
    targetId: "target.checkout",
    revision: 1,
    statement: "Split checkout from catalog",
    baseCommit: "baseline",
    sourceGraphSeal: sha256HashUtf8("graph"),
    elements: [
      { id: "repo:sym:checkout", level: 1 as const, category: "code_entity" as const, fingerprint: "code" },
      { id: "semantic:goal.checkout", level: 6 as const, category: "goal" as const, fingerprint: "goal" },
    ],
    relations: [
      { from: "semantic:goal.checkout", to: "repo:sym:checkout", relation: "realizes", fingerprint: "edge" },
    ],
    preservedInvariantIds: ["invariant.checkout.atomic"],
    authorshipOrigin: "agent" as const,
  };
}

/** A repository whose `.semctx` holds an authored goal and one proposed target. */
function authoredRepository(): string {
  const root = temporary("semctx-reconcile-outside-");
  mkdirSync(join(root, ".semctx", "semantic"), { recursive: true });
  writeFileSync(join(root, ".semctx", "semantic", "goals.sem"), GOAL);
  createTargetProposal(root, proposal());
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("reconciliation reads refuse linked directories", () => {
  test("control: a real tree loads its model and its target artifact", () => {
    const root = authoredRepository();

    expect(loadSemanticModel(root).model.nodes.map((node) => node.id)).toEqual(["goal.external.leak"]);
    expect(loadTargetArtifact(root, "target.checkout", 1).targetId).toBe("target.checkout");
  });

  linked("a linked .semctx is never read for the model or a target", () => {
    const root = temporary("semctx-reconcile-root-");
    const outside = authoredRepository();
    link(join(outside, ".semctx"), join(root, ".semctx"));

    expectUnsafe(() => loadSemanticModel(root));
    expectUnsafe(() => loadTargetArtifact(root, "target.checkout", 1));
  });

  linked("a linked targets directory or target directory is never read", () => {
    const outside = authoredRepository();
    const targetsRoot = temporary("semctx-reconcile-targets-");
    mkdirSync(join(targetsRoot, ".semctx", "semantic"), { recursive: true });
    link(join(outside, ".semctx", "semantic", "targets"), join(targetsRoot, ".semctx", "semantic", "targets"));
    expectUnsafe(() => loadTargetArtifact(targetsRoot, "target.checkout", 1));

    const targetRoot = temporary("semctx-reconcile-target-");
    mkdirSync(join(targetRoot, ".semctx", "semantic", "targets"), { recursive: true });
    link(
      join(outside, ".semctx", "semantic", "targets", "target.checkout"),
      join(targetRoot, ".semctx", "semantic", "targets", "target.checkout"),
    );
    expectUnsafe(() => loadTargetArtifact(targetRoot, "target.checkout", 1));
    // The outside artifact is intact and was the only thing a follow would have read.
    expect(readFileSync(join(outside, ".semctx", "semantic", "targets", "target.checkout", "r1.target.json"), "utf8"))
      .toContain("\"targetId\": \"target.checkout\"");
  });

  linked("a dangling semantic link is refused rather than read as an empty model", () => {
    const root = temporary("semctx-reconcile-dangling-");
    const outside = temporary("semctx-reconcile-outside-");
    mkdirSync(join(root, ".semctx"));
    mkdirSync(join(outside, "gone"));
    link(join(outside, "gone"), join(root, ".semctx", "semantic"));
    rmSync(join(outside, "gone"), { recursive: true, force: true });

    expectUnsafe(() => loadSemanticModel(root));
  });
});
