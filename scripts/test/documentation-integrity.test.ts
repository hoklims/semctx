import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { checkDocumentation } from "../documentation-integrity";
import { renderPagesWorkflow } from "../pages-workflow";

const temporaryDirectories: string[] = [];
const version = "0.2.1";
const action = `hoklims/semctx/packages/github-action@v${version}`;
const toolCount = 38;

function write(root: string, path: string, content: string): void {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
}

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "semctx-docs-integrity-"));
  temporaryDirectories.push(root);
  for (const path of [
    "README.md",
    "docs/integrations/github-actions.md",
    "examples/github-actions/semctx.yml",
    "examples/github-actions/semctx-strict.yml",
    "packages/github-action/README.md",
    "apps/cli/src/commands/preset.ts",
    "apps/cli/test/init-preset.test.ts",
    "plugins/claude-code/dist/semctx.js",
    "plugins/semctx-control/dist/semctx.js",
  ]) {
    write(root, path, `${action}\n`);
  }
  write(root, "README.md", `${action}\n${toolCount} schema-declared tools\n${toolCount} schema-declared tools\n`);
  write(
    root,
    "packages/mcp-server/src/tool-contract.ts",
    `const TOOL_NAMES = [\n${Array.from({ length: toolCount }, (_, index) => `  "tool-${index}",`).join("\n")}\n] as const;\n`,
  );
  write(root, "CHANGELOG.md", `## [${version}] - 2026-09-12\n`);
  write(root, "ROADMAP.md", `Released baseline: **v${version}**\n`);
  write(root, "docs/README.md", "# Docs\n");
  write(root, "docs/troubleshooting.md", "# Troubleshooting\n");
  write(root, "docs/contributing/public-contracts.md", "# Contracts\n");
  write(root, "SUPPORT.md", "Usage or setup question\nReproducible bug\nFeature request\nSecurity vulnerability\nDo not post secrets\n");
  write(root, "SECURITY.md", "## Supported versions\n0.2.x\nGitHub Security Advisory\nDo not open a public issue\n");
  write(root, ".github/ISSUE_TEMPLATE/bug.yml", "body:\n  - id: semctx-version\n  - id: environment\n  - id: command\n  - id: expected\n  - id: actual\n  - id: reproduction\n  - id: privacy\n");
  write(root, ".github/ISSUE_TEMPLATE/feature.yml", "body:\n  - id: problem\n  - id: current\n  - id: constraints\n  - id: evidence\n");
  write(root, ".github/ISSUE_TEMPLATE/support.yml", "body:\n  - id: question\n  - id: attempted\n  - id: semctx-version\n  - id: environment\n  - id: privacy\n");
  write(root, ".github/ISSUE_TEMPLATE/config.yml", "blank_issues_enabled: false\n");
  write(
    root,
    ".github/workflows/publish-pages.yml",
    renderPagesWorkflow(),
  );
  write(root, ".github/pull_request_template.md", "[contracts](../docs/contributing/public-contracts.md)\n");
  write(
    root,
    "site/landing/index.html",
    `<span>${version} ·</span><code>semctx@${version} install</code><code>github-action@v${version}</code>`
      + `<a href="https://github.com/hoklims/semctx/releases/tag/v${version}">release</a>`
      + `<p>Bun 1.4.0 or newer</p><style>@media (prefers-reduced-motion: reduce) {} @media (max-width: 640px) {}
  @supports not (animation-timeline: view()) {
    .scene, .reveal { animation: none !important; opacity: 1 !important; transform: none !important; }
    .graph line, .graph path { stroke-dashoffset: 0 !important; }
  }
</style>`
      + '<a href="https://github.com/hoklims/semctx/blob/main/docs/README.md">Docs</a><a href="./demo/">Demo</a>',
  );
  write(root, "site/index.html", "<!doctype html><title>Demo</title>\n");
  write(root, "site/evidence.json", JSON.stringify({ phase: "release", demo: { packageVersion: version } }));
  write(
    root,
    `docs/releases/v${version}.md`,
    `bunx semctx@${version} install\nhttps://hoklims.github.io/semctx/demo/\n`
      + `https://www.npmjs.com/package/semctx/v/${version}\n`
      + "https://github.com/hoklims/semctx/actions/runs/34664142432\n"
      + `https://github.com/hoklims/semctx/releases/tag/v${version}\n`
      + "UNKNOWN NOT_MEASURED experimental rollback\n",
  );
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  execFileSync("git", ["-c", "user.name=Semctx fixture", "-c", "user.email=fixture@semctx.invalid", "commit", "--allow-empty", "--quiet", "-m", "fixture"], { cwd: root });
  const releaseCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  execFileSync("git", ["tag", `v${version}`], { cwd: root });
  write(root, "site/evidence.json", JSON.stringify({
    phase: "release",
    releaseCommit: { value: releaseCommit, authority: "caller-asserted" },
    demo: { packageVersion: version },
  }));
  return root;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("documentation integrity", () => {
  test("accepts one coherent current release fixture", () => {
    expect(checkDocumentation(fixture())).toEqual([]);
  });

  test("accepts candidate evidence before publication but requires release evidence for publication", () => {
    const root = fixture();
    write(root, "site/evidence.json", JSON.stringify({ phase: "candidate", demo: { packageVersion: version } }));
    expect(checkDocumentation(root)).toEqual([]);
    expect(checkDocumentation(root, { requireReleaseEvidence: true })).toContainEqual({
      file: "site/evidence.json",
      line: 1,
      message: `demo evidence must be release phase for package ${version}`,
    });
  });

  test("publication rejects a well-formed release commit that does not match the local tag", () => {
    const root = fixture();
    write(root, "site/evidence.json", JSON.stringify({
      phase: "release",
      releaseCommit: { value: "f".repeat(40), authority: "caller-asserted" },
      demo: { packageVersion: version },
    }));
    expect(checkDocumentation(root)).toEqual([]);
    expect(checkDocumentation(root, { requireReleaseEvidence: true }).some((problem) =>
      problem.message.startsWith(`release commit must match local tag v${version} at `)
    )).toBe(true);
  });

  test("release evidence rejects an unauthorised commit identity", () => {
    const root = fixture();
    write(root, "site/evidence.json", JSON.stringify({
      phase: "release",
      releaseCommit: { value: "f".repeat(40), authority: "observed" },
      demo: { packageVersion: version },
    }));
    expect(checkDocumentation(root)).toContainEqual({
      file: "site/evidence.json",
      line: 1,
      message: "release commit must be a full lowercase Git commit labelled caller-asserted",
    });
  });

  test("reports a broken repository link with file and line", () => {
    const root = fixture();
    write(root, "docs/README.md", "# Docs\n\n[missing](not-here.md)\n");
    expect(checkDocumentation(root)).toContainEqual({
      file: "docs/README.md",
      line: 3,
      message: "local link target does not exist: not-here.md",
    });
  });

  test("reports a broken local fragment with file and line", () => {
    const root = fixture();
    write(root, "docs/target.md", "# Real heading\n");
    write(root, "docs/README.md", "# Docs\n\n[missing fragment](target.md#not-real)\n");
    expect(checkDocumentation(root)).toContainEqual({
      file: "docs/README.md",
      line: 3,
      message: "local link fragment does not exist: target.md#not-real",
    });
  });

  test("ignores documentation files excluded by the repository", () => {
    const root = fixture();
    write(root, ".gitignore", "ignored/\n");
    write(root, "ignored/generated.md", "[broken](missing.md)\n");
    expect(checkDocumentation(root)).toEqual([]);
  });

  test("fails closed with an actionable diagnostic when Git enumeration is unavailable", () => {
    const root = mkdtempSync(join(tmpdir(), "semctx-docs-no-git-"));
    temporaryDirectories.push(root);
    expect(checkDocumentation(root)[0]).toEqual({
      file: ".",
      line: 1,
      message: expect.stringContaining("Git documentation enumeration failed:"),
    });
  });

  test("rejects a stale current Action pin", () => {
    const root = fixture();
    write(root, "examples/github-actions/semctx.yml", "hoklims/semctx/packages/github-action@v0.1.18\n");
    const problems = checkDocumentation(root).filter((problem) => problem.file === "examples/github-actions/semctx.yml");
    expect(problems.map((problem) => problem.message)).toEqual([
      `current Action pin must be ${action}`,
      "stale or mutable current Action pin: hoklims/semctx/packages/github-action@v0.1.18",
    ]);
  });

  test("reports a missing current Action surface as a diagnostic instead of throwing", () => {
    const root = fixture();
    unlinkSync(join(root, "examples/github-actions/semctx-strict.yml"));
    expect(checkDocumentation(root)).toContainEqual({
      file: "examples/github-actions/semctx-strict.yml",
      line: 1,
      message: "current Action surface is missing; update CURRENT_ACTION_FILES if it moved",
    });
  });

  test("rejects a stale pin embedded in a generated plugin bundle", () => {
    const root = fixture();
    write(root, "plugins/claude-code/dist/semctx.js", "uses: hoklims/semctx/packages/github-action@v0.1.18\n");
    const problems = checkDocumentation(root).filter((problem) => problem.file === "plugins/claude-code/dist/semctx.js");
    expect(problems.map((problem) => problem.message)).toEqual([
      `current Action pin must be ${action}`,
      "stale or mutable current Action pin: hoklims/semctx/packages/github-action@v0.1.18",
    ]);
  });

  test("rejects a documented MCP count that differs from the registered contract", () => {
    const root = fixture();
    write(root, "README.md", `${action}\n37 schema-declared tools\n`);
    expect(checkDocumentation(root).some((problem) =>
      problem.message === `documented MCP tool count 37 differs from registered contract ${toolCount}`
    )).toBe(true);
  });

  test("rejects a landing whose release identity drifted", () => {
    const root = fixture();
    write(root, "site/landing/index.html", "<p>0.1.17</p>\n");
    const problems = checkDocumentation(root).filter((problem) => problem.file === "site/landing/index.html");
    expect(problems.length).toBeGreaterThan(5);
    expect(problems.some((problem) => problem.message.includes(`semctx@${version} install`))).toBe(true);
  });

  test("rejects missing structured support intake", () => {
    const root = fixture();
    unlinkSync(join(root, ".github/ISSUE_TEMPLATE/bug.yml"));
    expect(checkDocumentation(root)).toContainEqual({
      file: ".github/ISSUE_TEMPLATE/bug.yml",
      line: 1,
      message: "required documentation entry point is missing",
    });
  });

  test("turns malformed issue-form YAML into an actionable diagnostic", () => {
    const root = fixture();
    write(root, ".github/ISSUE_TEMPLATE/bug.yml", "body: [\n");
    expect(checkDocumentation(root).some((problem) =>
      problem.file === ".github/ISSUE_TEMPLATE/bug.yml"
      && problem.line === 1
      && problem.message.startsWith("invalid issue form YAML:")
    )).toBe(true);
  });

  test("rejects required support guidance hidden in an HTML comment", () => {
    const root = fixture();
    write(root, "SUPPORT.md", "# Support\n\n<!-- Usage or setup question Reproducible bug Feature request Security vulnerability Do not post secrets -->\n");
    const problems = checkDocumentation(root).filter((problem) => problem.file === "SUPPORT.md");
    expect(problems).toHaveLength(5);
    expect(problems.every((problem) => problem.message.startsWith("support route is missing:"))).toBe(true);
  });

  test("turns malformed evidence JSON into an actionable diagnostic", () => {
    const root = fixture();
    write(root, "site/evidence.json", "{\n");
    expect(checkDocumentation(root).some((problem) =>
      problem.file === "site/evidence.json"
      && problem.line === 1
      && problem.message.startsWith("invalid evidence JSON:")
    )).toBe(true);
  });

  test("rejects remote landing assets", () => {
    const root = fixture();
    const landing = readFileSync(join(root, "site/landing/index.html"), "utf8");
    write(root, "site/landing/index.html", `${landing}<link rel="stylesheet" href="https://fonts.example.test/font.css">`);
    expect(checkDocumentation(root)).toContainEqual({
      file: "site/landing/index.html",
      line: 1,
      message: "landing must not load remote fonts, scripts, or images",
    });
  });

  test("rejects a landing whose scroll-animation fallback no longer forces the final state", () => {
    const root = fixture();
    const landing = readFileSync(join(root, "site/landing/index.html"), "utf8");
    const fallbackStart = landing.indexOf("  @supports not");
    const fallbackEnd = landing.indexOf("  }", fallbackStart) + "  }".length;
    const fallback = landing.slice(fallbackStart, fallbackEnd);
    const sceneRule = ".scene, .reveal { animation: none !important; opacity: 1 !important; transform: none !important; }";
    expect(fallback).toContain(sceneRule);

    // The rule still appears in the stylesheet, but outside the fallback block it never applies
    // to a browser without scroll-driven animation.
    const moved = landing.replace(fallback, `${fallback.replace(sceneRule, "")}\n${sceneRule}`);
    write(root, "site/landing/index.html", moved);
    expect(checkDocumentation(root)).toContainEqual({
      file: "site/landing/index.html",
      line: 1,
      message: `landing scroll-animation fallback is missing: ${sceneRule}`,
    });

    write(root, "site/landing/index.html", landing.replace(fallback, ""));
    expect(checkDocumentation(root)).toContainEqual({
      file: "site/landing/index.html",
      line: 1,
      message: "landing contract is missing: @supports not (animation-timeline: view())",
    });
  });

  test("requires the publication gate before updating the legacy Pages branch", () => {
    const root = fixture();
    write(root, ".github/workflows/publish-pages.yml", "jobs:\n  build:\n    steps:\n      - uses: actions/checkout@pinned\n        with:\n          ref: gh-pages\n      - run: git -C published push origin HEAD:gh-pages\n");
    expect(checkDocumentation(root)).toContainEqual({
      file: ".github/workflows/publish-pages.yml",
      line: 1,
      message: "Pages publication must validate release evidence before updating the gh-pages branch",
    });
  });

  test("requires the complete root and demo Pages artifact mapping", () => {
    const root = fixture();
    const workflow = readFileSync(join(root, ".github/workflows/publish-pages.yml"), "utf8");
    write(root, ".github/workflows/publish-pages.yml", workflow.replace("bun scripts/build-pages-artifact.ts", "bun scripts/build-wrong-tree.ts"));
    expect(checkDocumentation(root)).toContainEqual({
      file: ".github/workflows/publish-pages.yml",
      line: 1,
      message: "Pages publication tail must be the uninterrupted canonical check, build, checkout, and publish sequence",
    });
  });

  test("rejects a commented-out Pages artifact builder invocation", () => {
    const root = fixture();
    const workflow = readFileSync(join(root, ".github/workflows/publish-pages.yml"), "utf8");
    write(root, ".github/workflows/publish-pages.yml", workflow.replace(
      "        run: bun scripts/build-pages-artifact.ts",
      "        run: |\n          # bun scripts/build-pages-artifact.ts\n          echo skipped",
    ));
    expect(checkDocumentation(root)).toContainEqual({
      file: ".github/workflows/publish-pages.yml",
      line: 1,
      message: "Pages workflow must match the complete canonical generated contract",
    });
  });

  test("rejects a post-build Pages artifact overwrite step", () => {
    const root = fixture();
    const workflow = readFileSync(join(root, ".github/workflows/publish-pages.yml"), "utf8");
    write(root, ".github/workflows/publish-pages.yml", workflow.replace(
      "      - name: Check out the legacy Pages source branch",
      "      - run: |\n          rm -rf _site\n          mkdir _site\n          printf bad > _site/index.html\n      - name: Check out the legacy Pages source branch",
    ));
    expect(checkDocumentation(root)).toContainEqual({
      file: ".github/workflows/publish-pages.yml",
      line: 1,
      message: "Pages workflow must match the complete canonical generated contract",
    });
  });

  test("rejects a commented-out Pages push", () => {
    const root = fixture();
    const workflow = readFileSync(join(root, ".github/workflows/publish-pages.yml"), "utf8");
    write(root, ".github/workflows/publish-pages.yml", workflow.replace(
      "          git -C published push origin HEAD:gh-pages",
      "          # git -C published push origin HEAD:gh-pages",
    ));
    expect(checkDocumentation(root)).toContainEqual({
      file: ".github/workflows/publish-pages.yml",
      line: 1,
      message: "Pages publication must validate release evidence before updating the gh-pages branch",
    });
  });

  test("rejects an inline overwrite inside the final Pages publish step", () => {
    const root = fixture();
    const workflow = readFileSync(join(root, ".github/workflows/publish-pages.yml"), "utf8");
    write(root, ".github/workflows/publish-pages.yml", workflow.replace(
      "          git -C published add -A",
      "          printf bad > published/index.html\n          git -C published add -A",
    ));
    expect(checkDocumentation(root)).toContainEqual({
      file: ".github/workflows/publish-pages.yml",
      line: 1,
      message: "Pages publication must validate release evidence before updating the gh-pages branch",
    });
  });

  test("rejects a publication check whose failure is ignored", () => {
    const root = fixture();
    const workflow = readFileSync(join(root, ".github/workflows/publish-pages.yml"), "utf8");
    write(root, ".github/workflows/publish-pages.yml", workflow.replace(
      "        run: bun run docs:check:publication",
      "        run: bun run docs:check:publication\n        continue-on-error: true",
    ));
    expect(checkDocumentation(root)).toContainEqual({
      file: ".github/workflows/publish-pages.yml",
      line: 1,
      message: "Pages workflow must match the complete canonical generated contract",
    });
  });

  test("rejects a skipped publication check", () => {
    const root = fixture();
    const workflow = readFileSync(join(root, ".github/workflows/publish-pages.yml"), "utf8");
    write(root, ".github/workflows/publish-pages.yml", workflow.replace(
      "        run: bun run docs:check:publication",
      "        run: bun run docs:check:publication\n        if: ${{ false }}",
    ));
    expect(checkDocumentation(root)).toContainEqual({
      file: ".github/workflows/publish-pages.yml",
      line: 1,
      message: "Pages workflow must match the complete canonical generated contract",
    });
  });

  test("rejects any additional Pages writer job", () => {
    const root = fixture();
    const workflow = readFileSync(join(root, ".github/workflows/publish-pages.yml"), "utf8");
    write(root, ".github/workflows/publish-pages.yml", `${workflow}  overwrite:\n    needs: build\n    runs-on: ubuntu-latest\n    steps:\n      - run: git push origin HEAD:gh-pages\n`);
    expect(checkDocumentation(root)).toContainEqual({
      file: ".github/workflows/publish-pages.yml",
      line: 1,
      message: "Pages workflow must match the complete canonical generated contract",
    });
  });

  test("rejects a generated-only release narrative", () => {
    const root = fixture();
    write(root, `docs/releases/v${version}.md`, "What's Changed\n* one pull request\n");
    const problems = checkDocumentation(root).filter((problem) => problem.file === `docs/releases/v${version}.md`);
    expect(problems.some((problem) => problem.message.includes("bunx semctx"))).toBe(true);
    expect(problems.some((problem) => problem.message.includes("rollback"))).toBe(true);
    expect(problems.some((problem) => problem.message.includes("NOT_MEASURED"))).toBe(true);
  });

  test("rejects required release narration hidden in an HTML comment", () => {
    const root = fixture();
    const path = `docs/releases/v${version}.md`;
    const brief = readFileSync(join(root, path), "utf8");
    write(root, path, brief.replace("UNKNOWN NOT_MEASURED experimental rollback", "UNKNOWN NOT_MEASURED experimental\n<!-- rollback -->"));
    expect(checkDocumentation(root)).toContainEqual({
      file: path,
      line: 1,
      message: "release narrative is missing: rollback",
    });
  });
});
