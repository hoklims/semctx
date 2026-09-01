import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..");
const read = (path: string): string => readFileSync(join(root, path), "utf8");
const ci = read(".github/workflows/ci.yml");
const release = read(".github/workflows/release.yml");
const stableDeliveryProof = read(".github/workflows/stable-delivery-proof.yml");
const publishing = read("docs/publishing.md");
const devcontainer = read(".devcontainer/Dockerfile");

interface WorkflowStep {
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  env?: Record<string, unknown>;
}

interface WorkflowJob {
  name?: string;
  if?: string;
  needs?: string | string[];
  environment?: string;
  permissions?: Record<string, string>;
  "runs-on": string;
  "timeout-minutes"?: number;
  strategy?: {
    "fail-fast"?: boolean;
    matrix?: Record<string, unknown>;
  };
  env?: Record<string, unknown>;
  steps: WorkflowStep[];
}

interface Workflow {
  on: Record<string, unknown>;
  permissions: Record<string, string>;
  concurrency?: Record<string, unknown>;
  jobs: Record<string, WorkflowJob>;
}

const ciWorkflow = Bun.YAML.parse(ci) as Workflow;
const releaseWorkflow = Bun.YAML.parse(release) as Workflow;
const stableDeliveryProofWorkflow = Bun.YAML.parse(stableDeliveryProof) as Workflow;
const job = (workflow: Workflow, name: string): WorkflowJob => {
  const selected = workflow.jobs[name];
  if (selected === undefined) {
    throw new Error(`workflow job not found: ${name}`);
  }
  return selected;
};

const CHECKOUT =
  "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1";
const SETUP_PYTHON =
  "actions/setup-python@5fda3b95a4ea91299a34e894583c3862153e4b97 # v7.0.0";
const SETUP_BUN =
  "oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2.2.0";
const SETUP_NODE =
  "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0";
const UPLOAD_ARTIFACT =
  "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1";
const DOWNLOAD_ARTIFACT =
  "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8.0.1";

describe("CI governance", () => {
  test("uses safe triggers, least privilege, and PR-only cancellation", () => {
    expect(Object.keys(ciWorkflow.on).sort()).toEqual(["pull_request", "push"]);
    expect(ciWorkflow.on.pull_request).toBeNull();
    expect(ciWorkflow.on.push).toEqual({ branches: ["main"] });
    expect(ciWorkflow.permissions).toEqual({ contents: "read" });
    expect(ciWorkflow.concurrency?.["cancel-in-progress"]).toBe(
      "${{ github.event_name == 'pull_request' }}",
    );
    expect(ci).not.toContain("pull_request_target");
  });

  test("runs the canonical verifier on the full cross-platform matrix", () => {
    const verify = job(ciWorkflow, "verify");
    const checkout = verify.steps.find((step) =>
      step.uses?.startsWith("actions/checkout@"),
    );
    const python = verify.steps.find((step) =>
      step.uses?.startsWith("actions/setup-python@"),
    );
    const bun = verify.steps.find((step) =>
      step.uses?.startsWith("oven-sh/setup-bun@"),
    );

    expect(verify.strategy).toEqual({
      "fail-fast": false,
      matrix: { os: ["ubuntu-latest", "windows-latest", "macos-15"] },
    });
    expect(verify["runs-on"]).toBe("${{ matrix.os }}");
    expect(checkout?.with).toEqual({
      ref: "${{ github.event.pull_request.head.sha || github.sha }}",
      "fetch-depth": 0,
      "persist-credentials": false,
    });
    expect(python?.with?.["python-version"]).toBe("3.10");
    expect(bun?.with?.["bun-version"]).toBe("1.4.0");
    expect(ci).toContain("bun install --frozen-lockfile");
    expect(ci).toContain("bun run verify:pr");
    expect(verify["timeout-minutes"]).toBe(30);
    expect(verify.env?.SEMCTX_VERIFY_BASE).toBe(
      "${{ github.event_name == 'pull_request' && github.event.pull_request.base.sha || github.event.before }}",
    );
  });

  test("pins third-party actions and exposes one stable required check", () => {
    expect(ci).toContain(CHECKOUT);
    expect(ci).toContain(SETUP_PYTHON);
    expect(ci).toContain(SETUP_BUN);
    expect(ciWorkflow.jobs["semctx-required"]).toMatchObject({
      name: "semctx-required",
      if: "always()",
      needs: "verify",
      "runs-on": "ubuntu-latest",
      "timeout-minutes": 5,
    });
    expect(ci).toContain('test "$VERIFY_RESULT" = "success"');
    expect(ci).not.toMatch(/uses:\s+\S+@v\d/);
  });

  test("removes superseded workflow entry points", () => {
    for (const path of ["quality.yml", "test.yml", "plugin-runtime.yml"]) {
      expect(existsSync(join(root, ".github", "workflows", path))).toBe(false);
    }
  });
});

describe("release governance", () => {
  test("replays published delivery proof without publication authority", () => {
    expect(Object.keys(stableDeliveryProofWorkflow.on)).toEqual(["workflow_dispatch"]);
    expect(stableDeliveryProofWorkflow.permissions).toEqual({});

    const identity = job(stableDeliveryProofWorkflow, "identity");
    const deliver = job(stableDeliveryProofWorkflow, "deliver");
    expect(deliver.needs).toBe("identity");
    expect(identity.permissions).toEqual({ contents: "read" });
    expect(deliver.permissions).toEqual({ contents: "read" });

    const mainCheckout = identity.steps.find((step) => step.uses?.startsWith("actions/checkout@"));
    expect(mainCheckout?.with?.ref).toBe("main");
    const releaseCheckout = deliver.steps.find(
      (step) => step.uses?.startsWith("actions/checkout@") && step.with?.path === "release-checkout",
    );
    expect(releaseCheckout?.with?.ref).toBe("${{ inputs.tag }}");

    const prove = deliver.steps.find(
      (step) => step.name === "Prove both hosts can install the already-published release",
    );
    expect(prove?.env?.SEMCTX_RELEASE_CHECKOUT).toContain("release-checkout");
    expect(prove?.run).toContain('GITHUB_SHA="$RELEASE_SHA"');

    expect(stableDeliveryProof).toContain('"schemaVersion": 2');
    expect(stableDeliveryProof).not.toMatch(/npm publish|git push|gh release create/);
    expect(stableDeliveryProof).not.toContain("contents: write");
    expect(stableDeliveryProof).not.toContain("id-token: write");
  });

  test("separates read-only verification, OIDC publication, and repository promotion", () => {
    const verify = job(releaseWorkflow, "verify");
    const publish = job(releaseWorkflow, "publish");
    const promote = job(releaseWorkflow, "promote");

    expect(releaseWorkflow.permissions).toEqual({});
    expect(verify.permissions).toEqual({ contents: "read" });
    expect(publish.permissions).toEqual({ "id-token": "write" });
    expect(promote.permissions).toEqual({ contents: "write" });
    expect(publish.environment).toBe("npm");
    expect(publish.needs).toBe("verify");
    expect(promote.needs).toBe("publish");
    expect(verify["timeout-minutes"]).toBe(30);
    expect(publish["timeout-minutes"]).toBe(10);
    expect(promote["timeout-minutes"]).toBe(10);
  });

  test("pins actions and delegates validation to the canonical verifier", () => {
    const bunSteps = Object.values(releaseWorkflow.jobs).flatMap((releaseJob) =>
      releaseJob.steps.filter((step) => step.uses?.startsWith("oven-sh/setup-bun@")),
    );

    expect(release).toContain(CHECKOUT);
    expect(release).toContain(SETUP_NODE);
    expect(release).toContain(SETUP_PYTHON);
    expect(release).toContain(SETUP_BUN);
    expect(release).toContain(UPLOAD_ARTIFACT);
    expect(release).toContain(DOWNLOAD_ARTIFACT);
    expect(release).toContain("persist-credentials: false");
    expect(release).toContain("package-manager-cache: false");
    expect(release).toContain("no-cache: true");
    expect(bunSteps).toHaveLength(2);
    expect(bunSteps.map((step) => step.with?.["bun-version"])).toEqual([
      "1.4.0",
      "1.4.0",
    ]);
    expect(publishing).toContain("repository-pinned Bun `1.4.0`");
    expect(devcontainer).toContain('bash -s "bun-v1.4.0"');
    expect(release).toContain("bun run verify:pr -- --skip-diff");
    expect(release).not.toContain("bun run quality");
    expect(release).not.toContain("bun run plugin:check");
    expect(release).toContain("npm install --global npm@12.0.1");
    expect(release).toContain("npm pack --ignore-scripts");
    expect(release).toContain("pkg.gitHead = process.env.GITHUB_SHA");
    expect(release).toContain("sha256sum --check");
    expect(release).toContain('npm publish "$tarball" --access public --ignore-scripts');
    expect(release).toContain("GH_TOKEN: ${{ github.token }}");
    expect(release).toContain('git/ref/heads/stable"');
    expect(release).toContain("-F force=false");
    expect(release).toContain("npm_view_field()");
    expect(release).toContain("return 44");
    expect(release).toContain("grep -q 'HTTP 404'");
    expect(release).not.toContain("|| true");
    expect(release).not.toContain("credential.helper=!f()");
    expect(release).not.toMatch(/uses:\s+\S+@v\d/);
  });

  test("keeps repository code out of the OIDC publisher", () => {
    const publish = job(releaseWorkflow, "publish");
    const publishUses = publish.steps.flatMap((step) =>
      step.uses === undefined ? [] : [step.uses],
    );
    const publishRuns = publish.steps.flatMap((step) =>
      step.run === undefined ? [] : [step.run],
    );

    expect(publishUses).toContain(SETUP_NODE.replace(/ # .*/, ""));
    expect(publishUses).toContain(DOWNLOAD_ARTIFACT.replace(/ # .*/, ""));
    expect(publishUses.some((use) => use.startsWith("actions/checkout@"))).toBe(false);
    expect(publishRuns.join("\n")).not.toContain("bun install");
    expect(publishRuns.join("\n")).not.toContain("bun run");
    expect(publishRuns.join("\n")).not.toContain("python");

    const promote = job(releaseWorkflow, "promote");
    const promoteUses = promote.steps.flatMap((step) =>
      step.uses === undefined ? [] : [step.uses],
    );
    expect(promoteUses.some((use) => use.startsWith("actions/checkout@"))).toBe(false);
  });
});

describe("contributor governance", () => {
  test("provides a focused CODEOWNERS policy and PR checklist", () => {
    const codeowners = read(".github/CODEOWNERS");
    const template = read(".github/pull_request_template.md");

    expect(codeowners).toContain("/.github/ @hoklims");
    expect(codeowners).toContain("/CONTRIBUTING.md @hoklims");
    expect(codeowners).toContain(
      "/docs/contributing/public-contracts.md @hoklims",
    );
    expect(codeowners).toContain("/package.json @hoklims");
    expect(codeowners).toContain("/apps/cli/package.json @hoklims");
    expect(codeowners).toContain("/packages/app-services/package.json @hoklims");
    expect(codeowners).toContain("/docs/publishing.md @hoklims");
    expect(codeowners).toContain("/requirements-quality.txt @hoklims");
    expect(codeowners).toContain("/scripts/verify-pr.ts @hoklims");
    expect(codeowners).toContain("/docs/adr/ @hoklims");
    expect(codeowners).toContain("/docs/architecture/ @hoklims");
    expect(codeowners).toContain(
      "/packages/mcp-server/src/tool-contract.ts @hoklims",
    );
    expect(codeowners).toContain(
      "/packages/mcp-server/src/public-tool-error.ts @hoklims",
    );
    expect(codeowners).toContain(
      "/packages/mcp-server/src/repository-root.ts @hoklims",
    );
    expect(codeowners).toContain(
      "/packages/mcp-server/src/control-explorer.ts @hoklims",
    );
    expect(codeowners).toContain(
      "/packages/core/src/verify-report.ts @hoklims",
    );
    expect(codeowners).toContain("/packages/control-model/package.json @hoklims");
    expect(codeowners).toContain("/packages/control-model/src/ @hoklims");
    expect(codeowners).toContain(
      "/packages/control-model/test/fixtures/l0-conformance.ts @hoklims",
    );
    expect(codeowners).toContain(
      "/plugins/shared/skills/semctx-control/SKILL.md @hoklims",
    );
    expect(codeowners).toContain("/scripts/build-plugin-runtime.ts @hoklims");
    expect(codeowners).toContain("/.claude-plugin/marketplace.json @hoklims");
    expect(codeowners).toContain("/.agents/plugins/marketplace.json @hoklims");
    expect(codeowners).toContain("/plugins/claude-code/.mcp.json @hoklims");
    expect(codeowners).toContain("/plugins/semctx-control/.mcp.json @hoklims");
    expect(codeowners).not.toMatch(/^\*\s/m);
    expect(template).toContain("bun run verify:pr");
    expect(template).toContain(
      "Public CLI, MCP, schema, or plugin contract changes",
    );
    expect(template).toContain("ROUTINE");
    expect(template).toContain("DOMAIN");
    expect(template).toContain("GOVERNED");
    expect(template).toContain("Governing ADR(s)");
    expect(template).toContain("Machine source(s) of truth");
    expect(template).toContain("Compatibility and migration impact");
    expect(template).toContain("N/A with a reason");
    expect(template).toContain("/docs/contributing/public-contracts.md");
  });

  test("configures weekly dependency updates without automerge", () => {
    const dependabot = read(".github/dependabot.yml");

    for (const ecosystem of ["bun", "pip", "github-actions"]) {
      expect(dependabot).toContain(`package-ecosystem: ${ecosystem}`);
    }
    expect(dependabot.match(/interval: weekly/g)).toHaveLength(3);
    expect(dependabot.toLowerCase()).not.toContain("automerge");
  });
});
