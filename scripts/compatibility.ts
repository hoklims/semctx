import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import manifest from "../compatibility.json";
import cliPackage from "../apps/cli/package.json";

if (manifest.schemaVersion !== 1 || manifest.otherHostVersions !== "unknown") {
  throw new Error("unsupported compatibility declaration");
}

export const HOST_CLI_SPECIFICATION = {
  codex: { ...manifest.hosts.codex, specifier: `${manifest.hosts.codex.package}@${manifest.hosts.codex.version}` },
  claude: { ...manifest.hosts.claude, specifier: `${manifest.hosts.claude.package}@${manifest.hosts.claude.version}` },
};

const start = "<!-- semctx:compatibility:start -->";
const end = "<!-- semctx:compatibility:end -->";
export const COMPATIBILITY_DOCS = ["README.md", "apps/cli/README.md", "docs/getting-started.md", "CONTRIBUTING.md"];

export function compatibilityBlock(
  version = cliPackage.version,
  bunRange = cliPackage.engines.bun,
): string {
  return `${start}
Semctx **${version}** requires **Bun ${bunRange}**.
The supported, tested host baseline is **Codex ${manifest.hosts.codex.version}** and
**Claude Code ${manifest.hosts.claude.version}**. Other host versions are **${manifest.otherHostVersions}** until tested;
these pins do not claim the earliest historically compatible versions.
[Baseline delivery evidence](${manifest.evidence}).
Installation does not reload an active session: open a new Codex task, or run
\`/reload-plugins\` in Claude Code (restart if reload fails).
${end}`;
}

interface Workflow {
  jobs: Record<string, {
    steps: Array<{ uses?: string; name?: string; with?: Record<string, unknown>; run?: string }>;
  }>;
}

/** Read-only consistency check; no inferred compatibility outside the declared baseline. */
export function checkCompatibility(root: string): string[] {
  const errors: string[] = [];
  const pkg = JSON.parse(readFileSync(resolve(root, "apps/cli/package.json"), "utf8")) as {
    version: string; engines: { bun: string };
  };
  const lock = Bun.JSONC.parse(readFileSync(resolve(root, "bun.lock"), "utf8")) as {
    workspaces: Record<string, { version?: string }>;
  };
  const workspacePatterns = (JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as { workspaces: string[] }).workspaces;
  for (const pattern of workspacePatterns) {
    for (const file of [...new Bun.Glob(`${pattern}/package.json`).scanSync({ cwd: root, onlyFiles: true })].sort()) {
      const workspace = file.replaceAll("\\", "/").slice(0, -"/package.json".length);
      const workspacePackage = JSON.parse(readFileSync(resolve(root, file), "utf8")) as { version?: string };
      if (workspacePackage.version !== lock.workspaces[workspace]?.version) {
        errors.push(`${workspace}/package.json: version differs from bun.lock workspace metadata; regenerate bun.lock`);
      }
    }
  }
  const expected = compatibilityBlock(pkg.version, pkg.engines.bun);
  for (const file of COMPATIBILITY_DOCS) {
    const text = readFileSync(resolve(root, file), "utf8").replaceAll("\r\n", "\n");
    const first = text.indexOf(start);
    const last = text.indexOf(end);
    if (first < 0 || last < first || text.slice(first, last + end.length) !== expected
      || text.indexOf(start, first + start.length) !== -1
      || text.indexOf(end, last + end.length) !== -1) {
      errors.push(`${file}: compatibility block differs; run bun run compatibility:write`);
    }
    for (const match of text.matchAll(/(?:Bun\]?\)?(?:\([^\n)]*\))?\s*(?:≥|>=)\s*)(\d+\.\d+(?:\.\d+)?)/g)) {
      if (`>=${match[1]}` !== pkg.engines.bun) errors.push(`${file}: contradictory Bun requirement ${match[1]}`);
    }
  }
  for (const file of [".github/workflows/ci.yml", ".github/workflows/release.yml"]) {
    const workflow = Bun.YAML.parse(readFileSync(resolve(root, file), "utf8")) as Workflow;
    let bunSteps = 0;
    for (const job of Object.values(workflow.jobs)) {
      for (const step of job.steps ?? []) {
        if (step.uses?.startsWith("oven-sh/setup-bun@")) {
          bunSteps++;
          const pin = step.with?.["bun-version"];
          if (typeof pin !== "string" || `>=${pin}` !== pkg.engines.bun) errors.push(`${file}: Bun pin differs from package minimum`);
        }
      }
    }
    if (bunSteps === 0) errors.push(`${file}: Bun provisioning missing`);
    if (file.endsWith("release.yml")) {
      const script = workflow.jobs.deliver?.steps.find((step) => step.name === "Provision both host CLIs")?.run ?? "";
      const command = script.match(/^\s*npm install --global ((?:"[^"\n]+"\s*)+)$/m)?.[1] ?? "";
      const specifiers = Array.from(command.matchAll(/"([^"\n]+)"/g), (match) => match[1]);
      for (const host of Object.values(HOST_CLI_SPECIFICATION)) {
        if (!specifiers.includes(host.specifier)) errors.push(`${file}: tested host ${host.specifier} not provisioned`);
      }
    }
  }
  return errors;
}

export function writeCompatibility(root: string): void {
  for (const file of COMPATIBILITY_DOCS) {
    const path = resolve(root, file);
    let text = readFileSync(path, "utf8").replaceAll("\r\n", "\n");
    const first = text.indexOf(start);
    const last = text.indexOf(end);
    if (first >= 0 && last > first) {
      text = text.slice(0, first) + compatibilityBlock() + text.slice(last + end.length);
    } else if (first === -1 && last === -1) {
      const headingEnd = text.indexOf("\n");
      text = text.slice(0, headingEnd + 1) + `\n${compatibilityBlock()}\n` + text.slice(headingEnd + 1);
    } else {
      throw new Error(`${file}: malformed compatibility markers`);
    }
    writeFileSync(path, text);
  }
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, "..");
  if (process.argv.slice(2).join(" ") === "--write") writeCompatibility(root);
  else if (process.argv.length > 2) throw new Error("expected no arguments or --write");
  const errors = checkCompatibility(root);
  for (const error of errors) console.error(error);
  console.log(errors.length === 0 ? "compatibility: PASS" : "compatibility: FAIL");
  process.exitCode = errors.length === 0 ? 0 : 1;
}
