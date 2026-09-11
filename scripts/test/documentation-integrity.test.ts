import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { checkDocumentation } from "../documentation-integrity";

const temporaryDirectories: string[] = [];
const version = "0.2.0";
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
  ]) {
    write(root, path, `${action}\n`);
  }
  write(root, "README.md", `${action}\n${toolCount} schema-declared tools\n${toolCount} schema-declared tools\n`);
  write(
    root,
    "packages/mcp-server/src/tool-contract.ts",
    `const TOOL_NAMES = [\n${Array.from({ length: toolCount }, (_, index) => `  "tool-${index}",`).join("\n")}\n] as const;\n`,
  );
  write(root, "CHANGELOG.md", `## [${version}] - 2026-09-10\n`);
  write(root, "ROADMAP.md", `Released baseline: **v${version}**\n`);
  write(root, "docs/README.md", "# Docs\n");
  write(root, "docs/troubleshooting.md", "# Troubleshooting\n");
  write(root, "docs/contributing/public-contracts.md", "# Contracts\n");
  write(root, "SUPPORT.md", "Usage or setup question\nReproducible bug\nFeature request\nSecurity vulnerability\nDo not post secrets\n");
  write(root, "SECURITY.md", "## Supported versions\n0.2.x\nGitHub Security Advisory\nDo not open a public issue\n");
  write(root, ".github/ISSUE_TEMPLATE/bug.yml", "body:\n  - id: semctx-version\n  - id: environment\n  - id: command\n  - id: expected\n  - id: actual\n  - id: reproduction\n  - id: privacy\n");
  write(root, ".github/ISSUE_TEMPLATE/feature.yml", "body:\n  - id: problem\n  - id: current\n  - id: constraints\n  - id: evidence\n");
  write(root, ".github/ISSUE_TEMPLATE/config.yml", "blank_issues_enabled: false\n");
  write(root, ".github/pull_request_template.md", "[contracts](../docs/contributing/public-contracts.md)\n");
  write(
    root,
    "site/landing/index.html",
    `<span>${version} ·</span><code>semctx@${version} install</code><code>github-action@v${version}</code>`
      + `<a href="https://github.com/hoklims/semctx/releases/tag/v${version}">release</a>`
      + `<p>Bun 1.4.0 or newer</p><style>@media (prefers-reduced-motion: reduce) {} @media (max-width: 640px) {}</style>`
      + '<a href="https://github.com/hoklims/semctx/blob/main/docs/README.md">Docs</a><a href="./demo/">Demo</a>',
  );
  write(root, "site/index.html", "<!doctype html><title>Demo</title>\n");
  write(root, "site/evidence.json", JSON.stringify({ phase: "release", demo: { packageVersion: version } }));
  write(
    root,
    `docs/releases/v${version}.md`,
    `bunx semctx@${version} install\nhttps://hoklims.github.io/semctx/demo/\n`
      + `https://www.npmjs.com/package/semctx/v/${version}\n`
      + "https://github.com/hoklims/semctx/actions/runs/34433110104\n"
      + `https://github.com/hoklims/semctx/releases/tag/v${version}\n`
      + "UNKNOWN NOT_MEASURED experimental rollback\n",
  );
  return root;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("documentation integrity", () => {
  test("accepts one coherent current release fixture", () => {
    expect(checkDocumentation(fixture())).toEqual([]);
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

  test("rejects a stale current Action pin", () => {
    const root = fixture();
    write(root, "examples/github-actions/semctx.yml", "hoklims/semctx/packages/github-action@v0.1.18\n");
    const problems = checkDocumentation(root).filter((problem) => problem.file === "examples/github-actions/semctx.yml");
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

  test("rejects a generated-only release narrative", () => {
    const root = fixture();
    write(root, `docs/releases/v${version}.md`, "What's Changed\n* one pull request\n");
    const problems = checkDocumentation(root).filter((problem) => problem.file === `docs/releases/v${version}.md`);
    expect(problems.some((problem) => problem.message.includes("bunx semctx"))).toBe(true);
    expect(problems.some((problem) => problem.message.includes("rollback"))).toBe(true);
    expect(problems.some((problem) => problem.message.includes("NOT_MEASURED"))).toBe(true);
  });
});
