import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, relative, resolve, sep } from "node:path";
import cliPackage from "../apps/cli/package.json";
import compatibility from "../compatibility.json";
import { renderPagesWorkflow } from "./pages-workflow";

export interface DocumentationProblem {
  file: string;
  line: number;
  message: string;
}

export interface DocumentationCheckOptions {
  requireReleaseEvidence?: boolean;
}

// Every surface a user copies the Action pin from, including the generated plugin bundles that
// embed the `init --preset github-claude` workflow; `plugin:check` keeps those bundles in sync with
// `preset.ts`, and this gate keeps the pin they carry current.
const CURRENT_ACTION_FILES = [
  "README.md",
  "docs/integrations/github-actions.md",
  "examples/github-actions/semctx.yml",
  "examples/github-actions/semctx-strict.yml",
  "packages/github-action/README.md",
  "apps/cli/src/commands/preset.ts",
  "apps/cli/test/init-preset.test.ts",
  "plugins/claude-code/dist/semctx.js",
  "plugins/semctx-control/dist/semctx.js",
] as const;

const RELEASE_DATE = "2026-09-10";

const CANONICAL_PAGES_PUBLISH_RUN = [
  "gh auth setup-git",
  'git -C published config user.name "github-actions[bot]"',
  'git -C published config user.email "41898282+github-actions[bot]@users.noreply.github.com"',
  "git -C published rm -r --ignore-unmatch .",
  "cp -R _site/. published/",
  "git -C published add -A",
  "if git -C published diff --cached --quiet; then",
  '  echo "PAGES_UP_TO_DATE"',
  "  exit 0",
  "fi",
  'git -C published commit -m "docs: publish $GITHUB_SHA"',
  "git -C published push origin HEAD:gh-pages",
].join("\n");

function registeredToolCount(root: string): number {
  const path = resolve(root, "packages/mcp-server/src/tool-contract.ts");
  const source = readFileSync(path, "utf8");
  const body = source.match(/const TOOL_NAMES = \[([\s\S]*?)\] as const;/)?.[1];
  if (body === undefined) throw new Error("packages/mcp-server/src/tool-contract.ts: TOOL_NAMES contract not found");
  const names = Array.from(body.matchAll(/^\s*"([^"]+)",\s*$/gm), (match) => match[1]);
  if (names.length === 0 || new Set(names).size !== names.length) {
    throw new Error("packages/mcp-server/src/tool-contract.ts: TOOL_NAMES must be a non-empty unique literal list");
  }
  return names.length;
}

function posix(path: string): string {
  return path.split(sep).join("/");
}

function lineAt(text: string, index: number): number {
  return text.slice(0, index).split("\n").length;
}

function documentationFiles(root: string): string[] {
  const output = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "*.md", "*.html"],
    { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  return output.split("\0").filter(Boolean).map(posix).sort();
}

function releaseTagCommit(root: string, version: string): string {
  return execFileSync(
    "git",
    ["rev-parse", "--verify", `refs/tags/v${version}^{commit}`],
    { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
}

function normalizedLinkTarget(raw: string): string {
  const trimmed = raw.trim();
  const closingBracket = trimmed.indexOf(">");
  if (trimmed.startsWith("<") && closingBracket > 1) return trimmed.slice(1, closingBracket);
  return trimmed.split(/\s+["']/)[0] ?? trimmed;
}

function isExternal(target: string): boolean {
  return /^(?:https?:|mailto:)/i.test(target);
}

function withoutQueryOrFragment(target: string): string {
  return target.split(/[?#]/, 1)[0] ?? "";
}

function visibleMarkdown(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, (comment) => comment.replace(/[^\n]/g, " "));
}

function markdownLinks(text: string): Array<{ target: string; index: number }> {
  const links: Array<{ target: string; index: number }> = [];
  const visible = visibleMarkdown(text);
  for (const match of visible.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
    links.push({ target: normalizedLinkTarget(match[1] ?? ""), index: match.index });
  }
  for (const match of visible.matchAll(/^\s*\[[^\]]+\]:\s*(\S+)/gm)) {
    links.push({ target: normalizedLinkTarget(match[1] ?? ""), index: match.index });
  }
  return links;
}

function githubHeadingAnchor(heading: string): string {
  return heading
    .trim()
    .toLocaleLowerCase("en-US")
    .replace(/[`*_~]/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, "-");
}

function localFragmentExists(root: string, source: string, target: string): boolean {
  const rawFragment = target.includes("#") ? target.slice(target.indexOf("#") + 1) : "";
  if (rawFragment.length === 0) return true;
  let fragment: string;
  try {
    fragment = decodeURIComponent(rawFragment).toLocaleLowerCase("en-US");
  } catch {
    return false;
  }
  const clean = withoutQueryOrFragment(target);
  let decoded: string;
  try {
    decoded = decodeURIComponent(clean);
  } catch {
    return false;
  }
  const destination = clean.length === 0 ? resolve(root, source) : resolve(root, dirname(source), decoded);
  if (!existsSync(destination) || ![".md", ".html"].includes(extname(destination))) return false;
  const text = readFileSync(destination, "utf8").replaceAll("\r\n", "\n");
  if (extname(destination) === ".html") {
    return Array.from(text.matchAll(/\b(?:id|name)=["']([^"']+)["']/gi), (match) => match[1]?.toLocaleLowerCase("en-US"))
      .includes(fragment);
  }
  const visible = visibleMarkdown(text);
  const anchors = Array.from(visible.matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm), (match) => githubHeadingAnchor(match[1] ?? ""));
  return anchors.includes(fragment)
    || Array.from(visible.matchAll(/<a\s+[^>]*(?:id|name)=["']([^"']+)["'][^>]*>/gi), (match) => match[1]?.toLocaleLowerCase("en-US"))
      .includes(fragment);
}

function htmlLinks(text: string): Array<{ target: string; index: number }> {
  return Array.from(text.matchAll(/\b(?:href|src)=["']([^"']+)["']/gi), (match) => ({
    target: match[1] ?? "",
    index: match.index,
  }));
}

function localTargetExists(root: string, source: string, target: string): boolean {
  if (source === "site/landing/index.html" && target === "./demo/") {
    return existsSync(resolve(root, "site/index.html"));
  }
  const clean = withoutQueryOrFragment(target);
  if (clean.length === 0) return true;
  let decoded: string;
  try {
    decoded = decodeURIComponent(clean);
  } catch {
    return false;
  }
  const destination = resolve(root, dirname(source), decoded);
  return destination === root || destination.startsWith(`${root}${sep}`)
    ? existsSync(destination)
    : false;
}

function add(
  problems: DocumentationProblem[],
  file: string,
  text: string,
  index: number,
  message: string,
): void {
  problems.push({ file, line: lineAt(text, index), message });
}

function requireText(
  problems: DocumentationProblem[],
  file: string,
  text: string,
  expected: readonly string[],
  label: string,
): void {
  for (const fragment of expected) {
    if (!text.includes(fragment)) add(problems, file, text, 0, `${label} is missing: ${fragment}`);
  }
}

function checkFormFields(
  problems: DocumentationProblem[],
  root: string,
  file: string,
  expectedIds: readonly string[],
  kind: string,
): void {
  const path = resolve(root, file);
  if (!existsSync(path)) return;
  const source = readFileSync(path, "utf8");
  try {
    const form = Bun.YAML.parse(source) as { body?: Array<{ id?: string }> };
    const ids = new Set((form.body ?? []).map((field) => field.id).filter(Boolean));
    for (const id of expectedIds) {
      if (!ids.has(id)) add(problems, file, source, 0, `${kind} intake field is missing: ${id}`);
    }
  } catch (error) {
    add(problems, file, source, 0, `invalid issue form YAML: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function checkInternalLinks(root: string, files: string[]): DocumentationProblem[] {
  const problems: DocumentationProblem[] = [];
  for (const file of files.filter((path) => [".md", ".html"].includes(extname(path)))) {
    const text = readFileSync(resolve(root, file), "utf8").replaceAll("\r\n", "\n");
    const links = extname(file) === ".md" ? markdownLinks(text) : htmlLinks(text);
    for (const { target, index } of links) {
      if (target.length === 0 || isExternal(target)) continue;
      if (target.startsWith("/")) {
        add(problems, file, text, index, `root-absolute link is not repository portable: ${target}`);
      } else if (!localTargetExists(root, file, target)) {
        add(problems, file, text, index, `local link target does not exist: ${target}`);
      } else if (!localFragmentExists(root, file, target)) {
        add(problems, file, text, index, `local link fragment does not exist: ${target}`);
      }
    }
  }
  return problems;
}

function checkCurrentReleaseTruth(root: string, options: DocumentationCheckOptions): DocumentationProblem[] {
  const problems: DocumentationProblem[] = [];
  const version = cliPackage.version;
  const toolCount = registeredToolCount(root);
  const action = `hoklims/semctx/packages/github-action@v${version}`;
  for (const file of CURRENT_ACTION_FILES) {
    if (!existsSync(resolve(root, file))) {
      add(problems, file, "", 0, "current Action surface is missing; update CURRENT_ACTION_FILES if it moved");
      continue;
    }
    const text = readFileSync(resolve(root, file), "utf8");
    if (!text.includes(action)) add(problems, file, text, 0, `current Action pin must be ${action}`);
    for (const match of text.matchAll(/hoklims\/semctx\/packages\/github-action@([^\s"'`)]+)/g)) {
      if (match[1] !== `v${version}`) {
        add(problems, file, text, match.index, `stale or mutable current Action pin: ${match[0]}`);
      }
    }
  }

  const readme = readFileSync(resolve(root, "README.md"), "utf8");
  const documentedCounts = Array.from(
    readme.matchAll(/\b(\d+) schema-declared tools\b/g),
    (match) => ({ count: Number(match[1]), index: match.index }),
  );
  if (documentedCounts.length === 0) {
    add(problems, "README.md", readme, 0, "MCP schema-declared tool count is missing");
  }
  for (const documented of documentedCounts) {
    if (documented.count !== toolCount) {
      add(
        problems,
        "README.md",
        readme,
        documented.index,
        `documented MCP tool count ${documented.count} differs from registered contract ${toolCount}`,
      );
    }
  }

  const changelog = readFileSync(resolve(root, "CHANGELOG.md"), "utf8");
  const expectedHeading = `## [${version}] - ${RELEASE_DATE}`;
  if (!changelog.includes(expectedHeading)) {
    add(problems, "CHANGELOG.md", changelog, 0, `current release heading must be ${expectedHeading}`);
  }

  const roadmap = readFileSync(resolve(root, "ROADMAP.md"), "utf8");
  if (!roadmap.includes(`Released baseline: **v${version}**`)) {
    add(problems, "ROADMAP.md", roadmap, 0, `released baseline must be v${version}`);
  }

  const landing = readFileSync(resolve(root, "site/landing/index.html"), "utf8");
  requireText(problems, "site/landing/index.html", landing, [
    `>${version} ·`,
    `semctx@${version} install`,
    `github-action@v${version}`,
    `releases/tag/v${version}`,
    "Bun 1.4.0 or newer",
    "prefers-reduced-motion: reduce",
    "@media (max-width: 640px)",
    "blob/main/docs/README.md",
    'href="./demo/"',
  ], "landing contract");
  const fallbackStart = landing.indexOf("@supports not (animation-timeline: view())");
  if (fallbackStart < 0) {
    add(problems, "site/landing/index.html", landing, 0, "landing contract is missing: @supports not (animation-timeline: view())");
  } else {
    // Without scroll-driven animation, the scenes keep their inline start state unless the
    // fallback block forces the final state; pin the rules that make the story readable.
    const fallbackEnd = landing.indexOf("\n  }", fallbackStart);
    if (fallbackEnd < 0) {
      add(problems, "site/landing/index.html", landing, fallbackStart, "landing scroll-animation fallback block is not closed");
    } else {
      requireText(problems, "site/landing/index.html", landing.slice(fallbackStart, fallbackEnd), [
        ".scene, .reveal { animation: none !important; opacity: 1 !important; transform: none !important; }",
        ".graph line, .graph path { stroke-dashoffset: 0 !important; }",
      ], "landing scroll-animation fallback");
    }
  }

  const evidenceText = readFileSync(resolve(root, "site/evidence.json"), "utf8");
  try {
    const evidence = JSON.parse(evidenceText) as {
      phase?: unknown;
      releaseCommit?: { value?: unknown; authority?: unknown } | null;
      demo?: { packageVersion?: unknown };
    };
    const supportedPhase = evidence.phase === "candidate" || evidence.phase === "release";
    const requiredPhase = options.requireReleaseEvidence ? "release" : "candidate or release";
    if (!supportedPhase || (options.requireReleaseEvidence && evidence.phase !== "release") || evidence.demo?.packageVersion !== version) {
      add(problems, "site/evidence.json", evidenceText, 0, `demo evidence must be ${requiredPhase} phase for package ${version}`);
    }
    const assertedCommit = evidence.releaseCommit;
    const validCommitShape = assertedCommit === null || assertedCommit === undefined || (
      typeof assertedCommit.value === "string"
      && /^[0-9a-f]{40}$/.test(assertedCommit.value)
      && assertedCommit.authority === "caller-asserted"
    );
    if (!validCommitShape || (evidence.phase === "release" && (assertedCommit === null || assertedCommit === undefined))) {
      add(problems, "site/evidence.json", evidenceText, 0, "release commit must be a full lowercase Git commit labelled caller-asserted");
    } else if (options.requireReleaseEvidence && evidence.phase === "release") {
      try {
        const taggedCommit = releaseTagCommit(root, version);
        if (assertedCommit?.value !== taggedCommit) {
          add(problems, "site/evidence.json", evidenceText, 0, `release commit must match local tag v${version} at ${taggedCommit}`);
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message.split("\n", 1)[0] : String(error);
        add(problems, "site/evidence.json", evidenceText, 0, `cannot resolve local release tag v${version}: ${detail}`);
      }
    }
  } catch (error) {
    add(problems, "site/evidence.json", evidenceText, 0, `invalid evidence JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  const releaseBriefPath = resolve(root, `docs/releases/v${version}.md`);
  if (!existsSync(releaseBriefPath)) {
    problems.push({ file: `docs/releases/v${version}.md`, line: 1, message: "dedicated release brief is missing" });
  } else {
    const brief = readFileSync(releaseBriefPath, "utf8");
    const visibleBrief = visibleMarkdown(brief);
    for (const expected of [
      `bunx semctx@${version} install`,
      "https://hoklims.github.io/semctx/demo/",
      `https://www.npmjs.com/package/semctx/v/${version}`,
      compatibility.evidence,
      `https://github.com/hoklims/semctx/releases/tag/v${version}`,
      "UNKNOWN",
      "NOT_MEASURED",
      "experimental",
      "rollback",
    ]) {
      if (!visibleBrief.toLowerCase().includes(expected.toLowerCase())) {
        add(problems, posix(relative(root, releaseBriefPath)), brief, 0, `release narrative is missing: ${expected}`);
      }
    }
  }

  for (const required of [
    "docs/README.md",
    "docs/troubleshooting.md",
    "SUPPORT.md",
    ".github/ISSUE_TEMPLATE/bug.yml",
    ".github/ISSUE_TEMPLATE/support.yml",
    ".github/ISSUE_TEMPLATE/feature.yml",
    ".github/ISSUE_TEMPLATE/config.yml",
  ]) {
    if (!existsSync(resolve(root, required))) {
      problems.push({ file: required, line: 1, message: "required documentation entry point is missing" });
    }
  }

  checkFormFields(
    problems,
    root,
    ".github/ISSUE_TEMPLATE/bug.yml",
    ["semctx-version", "environment", "command", "expected", "actual", "reproduction", "privacy"],
    "bug",
  );
  checkFormFields(
    problems,
    root,
    ".github/ISSUE_TEMPLATE/feature.yml",
    ["problem", "current", "constraints", "evidence"],
    "feature",
  );
  checkFormFields(
    problems,
    root,
    ".github/ISSUE_TEMPLATE/support.yml",
    ["question", "attempted", "semctx-version", "environment", "privacy"],
    "support",
  );

  const supportPath = resolve(root, "SUPPORT.md");
  if (existsSync(supportPath)) {
    const support = visibleMarkdown(readFileSync(supportPath, "utf8"));
    requireText(
      problems,
      "SUPPORT.md",
      support,
      ["Usage or setup question", "Reproducible bug", "Feature request", "Security vulnerability", "Do not post secrets"],
      "support route",
    );
  }

  const remoteAsset = /<link\b(?=[^>]*\brel=["'](?:stylesheet|preload|modulepreload|icon)["'])[^>]*\bhref=["']https?:\/\//i.test(landing)
    || /<(?:script|img)\b[^>]*\bsrc=["']https?:\/\//i.test(landing);
  if (remoteAsset) {
    add(problems, "site/landing/index.html", landing, 0, "landing must not load remote fonts, scripts, or images");
  }

  const pagesWorkflowPath = resolve(root, ".github/workflows/publish-pages.yml");
  if (!existsSync(pagesWorkflowPath)) {
    problems.push({ file: ".github/workflows/publish-pages.yml", line: 1, message: "Pages publication workflow is missing" });
  } else {
    const source = readFileSync(pagesWorkflowPath, "utf8");
    if (source.replaceAll("\r\n", "\n") !== renderPagesWorkflow()) {
      add(problems, ".github/workflows/publish-pages.yml", source, 0, "Pages workflow must match the complete canonical generated contract");
    }
    try {
      const parsed = Bun.YAML.parse(source) as { jobs?: Record<string, { steps?: Array<{ run?: string; uses?: string; with?: Record<string, unknown> }> }> };
      const steps = parsed.jobs?.build?.steps ?? [];
      const checkIndex = steps.findIndex((step) => step.run?.trim() === "bun run docs:check:publication");
      const assemblyIndex = steps.findIndex((step) => step.run?.trim() === "bun scripts/build-pages-artifact.ts");
      const branchCheckoutIndex = steps.findIndex((step) => step.uses?.startsWith("actions/checkout@") && step.with?.ref === "gh-pages");
      const publishIndex = steps.findIndex((step) => step.run?.trim() === CANONICAL_PAGES_PUBLISH_RUN);
      if (checkIndex < 0 || branchCheckoutIndex < 0 || publishIndex < 0 || checkIndex >= branchCheckoutIndex || branchCheckoutIndex >= publishIndex) {
        add(problems, ".github/workflows/publish-pages.yml", source, 0, "Pages publication must validate release evidence before updating the gh-pages branch");
      }
      if (
        assemblyIndex !== checkIndex + 1
        || branchCheckoutIndex !== assemblyIndex + 1
        || publishIndex !== branchCheckoutIndex + 1
        || publishIndex !== steps.length - 1
      ) {
        add(problems, ".github/workflows/publish-pages.yml", source, 0, "Pages publication tail must be the uninterrupted canonical check, build, checkout, and publish sequence");
      }
    } catch (error) {
      add(problems, ".github/workflows/publish-pages.yml", source, 0, `invalid Pages workflow YAML: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const securityPath = resolve(root, "SECURITY.md");
  if (existsSync(securityPath)) {
    const security = readFileSync(securityPath, "utf8");
    const prose = security.replace(/\s+/g, " ");
    requireText(
      problems,
      "SECURITY.md",
      prose,
      ["## Supported versions", "0.2.x", "GitHub Security Advisory", "Do not open a public issue"],
      "security guidance",
    );
  }
  return problems;
}

export function checkDocumentation(
  root = resolve(import.meta.dir, ".."),
  options: DocumentationCheckOptions = {},
): DocumentationProblem[] {
  let files: string[];
  try {
    files = documentationFiles(root);
  } catch (error) {
    const detail = error instanceof Error ? error.message.split("\n", 1)[0] : String(error);
    return [{ file: ".", line: 1, message: `Git documentation enumeration failed: ${detail}` }];
  }
  return [...checkInternalLinks(root, files), ...checkCurrentReleaseTruth(root, options)]
    .sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line || left.message.localeCompare(right.message));
}

function externalUrls(root: string): Array<{ url: string; source: string }> {
  const seen = new Map<string, string>();
  for (const file of documentationFiles(root)) {
    const text = readFileSync(resolve(root, file), "utf8");
    const links = extname(file) === ".md" ? markdownLinks(text) : htmlLinks(text);
    for (const { target } of links) {
      if (target.startsWith("https://") && !seen.has(target)) seen.set(target, file);
    }
  }
  return Array.from(seen, ([url, source]) => ({ url, source })).sort((a, b) => a.url.localeCompare(b.url));
}

async function checkExternalLinks(root: string): Promise<number> {
  const hardFailures: string[] = [];
  let urls: Array<{ url: string; source: string }>;
  try {
    urls = externalUrls(root);
  } catch (error) {
    console.error(`[docs:external] FAIL .:1: Git documentation enumeration failed: ${error instanceof Error ? error.message.split("\n", 1)[0] : String(error)}`);
    return 1;
  }
  let cursor = 0;
  const workers = Array.from({ length: Math.min(8, urls.length) }, async () => {
    while (cursor < urls.length) {
      const item = urls[cursor++];
      if (item === undefined) return;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8_000);
      try {
        const response = await fetch(item.url, {
          method: "HEAD",
          redirect: "follow",
          signal: controller.signal,
          headers: { "user-agent": "semctx-documentation-integrity/0.2" },
        });
        if (response.status === 404 || response.status === 410) {
          hardFailures.push(`${item.source}: external link returned ${response.status}: ${item.url}`);
        } else if (response.status >= 400) {
          console.warn(`[docs:external] WARN ${response.status} ${item.url} (${item.source}); access/rate status is non-authoritative`);
        }
      } catch (error) {
        console.warn(`[docs:external] WARN ${item.url} (${item.source}): ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        clearTimeout(timeout);
      }
    }
  });
  await Promise.all(workers);
  for (const failure of hardFailures.sort()) console.error(`[docs:external] FAIL ${failure}`);
  console.log(`[docs:external] checked ${urls.length} unique HTTPS links; hard failures=${hardFailures.length}`);
  return hardFailures.length === 0 ? 0 : 1;
}

export async function main(args = process.argv.slice(2)): Promise<number> {
  const root = resolve(import.meta.dir, "..");
  if (args.length === 1 && args[0] === "--external") return checkExternalLinks(root);
  const publication = args.length === 1 && args[0] === "--publication";
  if (args.length > 0 && !publication) {
    console.error("usage: bun scripts/documentation-integrity.ts [--external|--publication]");
    return 2;
  }
  const problems = checkDocumentation(root, { requireReleaseEvidence: publication });
  for (const problem of problems) {
    console.error(`[docs:integrity] ${problem.file}:${problem.line}: ${problem.message}`);
  }
  console.log(problems.length === 0 ? "documentation integrity: PASS" : `documentation integrity: FAIL (${problems.length})`);
  return problems.length === 0 ? 0 : 1;
}

if (import.meta.main) process.exitCode = await main();
