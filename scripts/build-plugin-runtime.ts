import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import {
  AGENT_LIFECYCLE_POLICY_V1,
  AGENT_WORKFLOW_CONTRACT_V1,
  AgentLifecyclePolicyV1Schema,
  AgentWorkflowContractV1Schema,
  type AgentLifecyclePolicyV1,
  type AgentWorkflowContractV1,
} from "@semantic-context/control-model";

const root = resolve(import.meta.dir, "..");
const pluginDists = [
  resolve(root, "plugins/claude-code/dist"),
  resolve(root, "plugins/semctx-control/dist"),
];
const check = process.argv.includes("--check");
const typescriptEntrypoint = Bun.resolveSync("typescript", root);
const typescriptLibSource = dirname(typescriptEntrypoint);
const typescriptLibs = readdirSync(typescriptLibSource)
  .filter((name) => name.startsWith("lib") && name.endsWith(".d.ts"))
  .sort();

const absoluteTypeScriptPrelude = `var __dirname=${JSON.stringify(typescriptLibSource)},__filename=${JSON.stringify(typescriptEntrypoint)};`;
const portableTypeScriptPrelude =
  'var __dirname=import.meta.dir+"/typescript-lib",__filename=__dirname+"/typescript.js";';
const escapedRoot = JSON.stringify(root).slice(1, -1);

export const PLUGIN_BUILD_BUN_VERSION = "1.3.13";
const pluginRuntimeArtifactPaths = [
  "semctx-mcp.js",
  "semctx-shared.js",
  "semctx.js",
] as const;

export interface BundleSpec {
  /** Output basename under each plugin dist/ */
  name: string;
  entrypoint: string;
  label: string;
}

export const CLI_BUNDLE_SPEC: BundleSpec = {
  name: "semctx.js",
  entrypoint: "apps/cli/src/index.ts",
  label: "plugin CLI",
};

/** Host-specific shell ladder for the shared control skill (issue #40 option A). */
export type SkillHost = "claude-code" | "semctx-control";

const HOST_CLI_MARKER = "{{HOST_CLI_LADDER}}";
const SHARED_WORKFLOW_MARKER = "{{SHARED_WORKFLOW_CONTRACT}}";
const SHARED_LIFECYCLE_MARKER = "{{SHARED_LIFECYCLE_CONTRACT}}";
const HOST_CLI_BEGIN = (host: SkillHost) => `<!-- BEGIN host-cli-ladder:${host} -->`;
const HOST_CLI_END = "<!-- END host-cli-ladder -->";
// Strip markers + host body so parity can assert the shared contract is still one document.
export const HOST_CLI_STRIP =
  /<!-- BEGIN host-cli-ladder:(?:claude-code|semctx-control) -->\n[\s\S]*?<!-- END host-cli-ladder -->\n?/;

const skillTemplatePath = resolve(root, "plugins/shared/skills/semctx-control/SKILL.md");
const skillOutputs: Record<SkillHost, string> = {
  "claude-code": resolve(root, "plugins/claude-code/skills/semctx-control/SKILL.md"),
  "semctx-control": resolve(root, "plugins/semctx-control/skills/semctx-control/SKILL.md"),
};

/**
 * Claude: load-time `${CLAUDE_PLUGIN_ROOT}` placeholder + global fallback.
 * Codex: global `semctx` only — no plugin-root substitution on that host.
 */
export function hostCliLadder(host: SkillHost): string {
  if (host === "claude-code") {
    return `Prefer MCP tools when they are connected. For shell fallbacks, resolve the CLI in this order
(stop at the first that works):

1. **Plugin-bundled CLI** (same release as the MCP bundle) — the \`bun "…/dist/semctx.js"\` path in
   the block below. Claude Code substitutes the plugin root into this skill **when the skill is
   loaded**, so the path you read is already absolute. Never expect \`CLAUDE_PLUGIN_ROOT\` to exist
   in the shell — where it is set at all, it is exported to hooks and MCP servers, not to your
   terminal. Do not try to guess the plugin directory, and do not assume the shell's cwd is the
   plugin package root: it is the user's repository.
2. **Global \`semctx\` on PATH** (\`bun install -g semctx@latest\` / \`bunx semctx@latest\`) — keep it on the **same
   version** as the plugin (\`semctx --version\` should match the marketplace plugin version).
3. If neither is available, say so and continue with MCP-only or ask the user to update the plugin /
   install the CLI — do not invent results.

\`\`\`text
# Plugin CLI (path substituted at skill load)
bun "\${CLAUDE_PLUGIN_ROOT}/dist/semctx.js" status --json
bun "\${CLAUDE_PLUGIN_ROOT}/dist/semctx.js" semantic check --json
bun "\${CLAUDE_PLUGIN_ROOT}/dist/semctx.js" semantic slice --change change.<slug> --format agent
bun "\${CLAUDE_PLUGIN_ROOT}/dist/semctx.js" control trace repo:<graph-id> --direction lift --to 6 --json
bun "\${CLAUDE_PLUGIN_ROOT}/dist/semctx.js" control plan change.<slug> --target target-architecture.json --json
bun "\${CLAUDE_PLUGIN_ROOT}/dist/semctx.js" verify diff --base origin/main
bun "\${CLAUDE_PLUGIN_ROOT}/dist/semctx.js" change verify change.<slug> --base origin/main

# Control Handoff v2 — manual shadow surface
bun "\${CLAUDE_PLUGIN_ROOT}/dist/semctx.js" control handoff <input.json> --json
bun "\${CLAUDE_PLUGIN_ROOT}/dist/semctx.js" control resume-handoff <capsule-hash> --json

# Legacy Plane-B Handoff v1 compatibility
bun "\${CLAUDE_PLUGIN_ROOT}/dist/semctx.js" semantic handoff
bun "\${CLAUDE_PLUGIN_ROOT}/dist/semctx.js" semantic resume

# Global / CI fallback — same subcommands, no path
semctx --version
semctx status --json
semctx control handoff <input.json> --json
semctx control resume-handoff <capsule-hash> --json
\`\`\`
`;
  }

  return `Prefer MCP tools when they are connected. For shell fallbacks, use a global \`semctx\` on
PATH (\`bun install -g semctx@latest\` / \`bunx semctx@latest\`) — keep it on the **same version** as the plugin
(\`semctx --version\` should match the marketplace plugin version).

This host does **not** substitute a plugin-root path into skill content, and the agent's shell cwd
is the user's repository (not the plugin package root), so the bundled \`dist/semctx.js\` is not
addressable via a relative path such as \`bun ./dist/semctx.js\` or a placeholder. The plugin still
ships the CLI next to the MCP runtime for lockstep releases and for humans who know the absolute
path.

If \`semctx\` is not available, say so and continue with MCP-only or ask the user to install the CLI
— do not invent results.

\`\`\`text
# Global / CI CLI — same subcommands as the plugin MCP tools
semctx --version
semctx status --json
semctx semantic check --json
semctx verify diff --base origin/main

# Control Handoff v2 — manual shadow surface
semctx control handoff <input.json> --json
semctx control resume-handoff <capsule-hash> --json

# Legacy Plane-B Handoff v1 compatibility
semctx semantic handoff
semctx semantic resume
\`\`\`
`;
}

export function renderSharedWorkflowContract(
  contract: AgentWorkflowContractV1 = AGENT_WORKFLOW_CONTRACT_V1,
): string {
  const parsed = AgentWorkflowContractV1Schema.parse(contract) as AgentWorkflowContractV1;
  const stages = parsed.stages.map((stage, index) => {
    const tools = stage.mcpTools.length > 0
      ? stage.mcpTools.map((tool) => `\`${tool}\``).join(", ")
      : "host-local";
    return `${index + 1}. **${stage.id}** — ${stage.instruction}\n`
      + `   - Surface: ${tools}; effect: \`${stage.effect}\`; condition: \`${stage.condition}\`.`;
  }).join("\n");
  return `<!-- BEGIN shared-workflow-contract:v1 -->
Machine policy: enforcement is \`${parsed.enforcementMode}\`, blocking is disabled, repositories
without Semctx follow \`${parsed.nonSemctxRepository}\`, and execution authority is
\`${parsed.executionAuthority}\`.

${stages}

Completion requires: ${parsed.completion.requiredStageIds.map((id) => `\`${id}\``).join(" → ")}.
The bounded transfer stage is \`${parsed.completion.handoffStageId}\`.
<!-- END shared-workflow-contract -->`;
}

export function renderSharedLifecycleContract(
  policy: AgentLifecyclePolicyV1 = AGENT_LIFECYCLE_POLICY_V1,
): string {
  const parsed = AgentLifecyclePolicyV1Schema.parse(policy) as AgentLifecyclePolicyV1;
  const checkpoints = parsed.checkpoints.map((checkpoint) => {
    const implementation = checkpoint.requiredStageIds.implementation.length > 0
      ? checkpoint.requiredStageIds.implementation.map((id) => `\`${id}\``).join(" → ")
      : "no stage-presence requirement";
    const migration = checkpoint.requiredStageIds.migration.length > 0
      ? checkpoint.requiredStageIds.migration.map((id) => `\`${id}\``).join(" → ")
      : "no stage-presence requirement";
    const threshold = checkpoint.minimumAltitude === 2
      ? " Eligible from L2 through L6; L0-L1 is `NO_OP`."
      : "";
    return `- **${checkpoint.id}** — minimum altitude L${checkpoint.minimumAltitude}.${threshold}\n`
      + `  Implementation stages: ${implementation}.\n`
      + `  Migration stages: ${migration}.`;
  }).join("\n");

  return `<!-- BEGIN shared-lifecycle-contract:v1 -->
Codex and Claude Code expose \`${parsed.mcpTool}\` through the same Semctx MCP runtime.
Both hosts are instructed to invoke these checkpoints; these instructions are not automatic hooks
and do not prove that a host event ran.

This is a presence-only advisory contract. \`NO_OP\` means no stage-presence obligation applies,
\`RECORDED\` means every required stage id was caller-recorded, and \`INCOMPLETE\` means required
stage ids are missing. Recorded stage outcomes remain unevaluated and admissibility is not evaluated.
Enforcement is \`${parsed.enforcementMode}\`, blocking is disabled, and execution authority is \`${parsed.executionAuthority}\`.

Invoke the checkpoints in policy order:
${checkpoints}

After repository edits, fold prior and newly observed touched coordinate ids as
\`caller_observed_advisory\` evidence. Accumulation is
\`${parsed.coordinateAccumulation}\`: the caller must reinject prior ids, and Semctx binds them to
no task, session, diff, commit, or handoff. Before completion, record the required completion
stages; before compaction or owner transfer, record \`handoff\`.
<!-- END shared-lifecycle-contract -->`;
}

export function renderControlSkill(host: SkillHost, template: string = readSkillTemplate()): string {
  if (!template.includes(HOST_CLI_MARKER)) {
    throw new Error(
      `skill template missing ${HOST_CLI_MARKER}: ${skillTemplatePath}`,
    );
  }
  if (!template.includes(SHARED_WORKFLOW_MARKER)) {
    throw new Error(
      `skill template missing ${SHARED_WORKFLOW_MARKER}: ${skillTemplatePath}`,
    );
  }
  if (!template.includes(SHARED_LIFECYCLE_MARKER)) {
    throw new Error(
      `skill template missing ${SHARED_LIFECYCLE_MARKER}: ${skillTemplatePath}`,
    );
  }
  if (template.includes("CLAUDE_PLUGIN_ROOT")) {
    throw new Error(
      `skill template must not embed CLAUDE_PLUGIN_ROOT (host-specific; lives in hostCliLadder only): ${skillTemplatePath}`,
    );
  }
  const body = hostCliLadder(host).replace(/\n$/, "");
  const workflow = renderSharedWorkflowContract();
  const lifecycle = renderSharedLifecycleContract();
  const filled = template.replace(
    SHARED_WORKFLOW_MARKER,
    workflow,
  ).replace(
    SHARED_LIFECYCLE_MARKER,
    lifecycle,
  ).replace(
    HOST_CLI_MARKER,
    `${HOST_CLI_BEGIN(host)}\n${body}\n${HOST_CLI_END}`,
  );
  // Normalize to LF for deterministic committed artifacts across platforms.
  return filled.replaceAll("\r\n", "\n");
}

function readSkillTemplate(): string {
  if (!existsSync(skillTemplatePath)) {
    throw new Error(`missing shared skill template: ${skillTemplatePath}`);
  }
  return readFileSync(skillTemplatePath, "utf8").replaceAll("\r\n", "\n");
}

export function assertPluginBuildBunVersion(actualVersion: string = Bun.version): void {
  if (actualVersion !== PLUGIN_BUILD_BUN_VERSION) {
    throw new Error(
      `plugin artifact generation requires Bun ${PLUGIN_BUILD_BUN_VERSION}; found Bun ${actualVersion}`,
    );
  }
}

export async function buildPortableBundle(spec: BundleSpec): Promise<Uint8Array> {
  const result = await Bun.build({
    entrypoints: [spec.entrypoint],
    root,
    target: "bun",
    minify: true,
    packages: "bundle",
  });

  if (!result.success || result.outputs.length !== 1) {
    for (const log of result.logs) process.stderr.write(`${log.message}\n`);
    throw new Error(`failed to build the ${spec.label}`);
  }

  const generated = await result.outputs[0]!.text();
  const preludeCount = generated.split(absoluteTypeScriptPrelude).length - 1;
  if (preludeCount !== 1) {
    throw new Error(
      `expected one bundled TypeScript path prelude in ${spec.label}, found ${preludeCount}`,
    );
  }
  const portable = generated
    .replace(absoluteTypeScriptPrelude, portableTypeScriptPrelude)
    .replace(/[ \t]+(?=\r?\n)/g, "");
  if (portable.includes(escapedRoot)) {
    throw new Error(`generated ${spec.label} still contains the build checkout path`);
  }
  return new TextEncoder().encode(portable);
}

/**
 * `BuildMessage` declares no `toString()`, so interpolating a Bun log would
 * stringify it as `[object Object]`. Render both shapes field by field instead,
 * keeping the resolution detail that only `ResolveMessage` carries.
 */
function formatBuildLog(log: BuildMessage | ResolveMessage): string {
  const where = log.position
    ? ` (${log.position.file}:${log.position.line}:${log.position.column})`
    : "";
  const resolution =
    log.name === "ResolveMessage"
      ? ` [${log.code}] ${log.importKind} "${log.specifier}" from "${log.referrer}"`
      : "";
  return `${log.level}: ${log.message}${where}${resolution}`;
}

export async function buildPortablePluginArtifacts(): Promise<Map<string, Uint8Array>> {
  assertPluginBuildBunVersion();

  const temporaryRoot = mkdtempSync(resolve(tmpdir(), "semctx-plugin-build-"));
  const outdir = resolve(temporaryRoot, "dist");
  const mcpEntrypoint = resolve(root, "semctx-mcp.ts");
  const cliEntrypoint = resolve(root, "semctx.ts");

  try {
    const result = await Bun.build({
      entrypoints: [mcpEntrypoint, cliEntrypoint],
      files: {
        [mcpEntrypoint]: 'import { main } from "./packages/mcp-server/src/index.ts";\nmain();\n',
        [cliEntrypoint]: 'import "./apps/cli/src/index.ts";\n',
      },
      root,
      outdir,
      target: "bun",
      minify: true,
      packages: "bundle",
      splitting: true,
      naming: {
        entry: "[name].[ext]",
        chunk: "semctx-shared.[ext]",
        asset: "[name]-[hash].[ext]",
      },
    });

    if (!result.success) {
      for (const log of result.logs) process.stderr.write(`${formatBuildLog(log)}\n`);
      throw new Error("failed to build the split plugin runtimes");
    }

    let preludeCount = 0;
    const built = new Map<string, Uint8Array>();
    for (const output of result.outputs) {
      const relativePath = relative(outdir, output.path).replaceAll("\\", "/");
      if (
        relativePath.length === 0
        || isAbsolute(relativePath)
        || relativePath === ".."
        || relativePath.startsWith("../")
      ) {
        throw new Error(`generated plugin artifact escaped its output directory: ${output.path}`);
      }
      if (built.has(relativePath)) {
        throw new Error(`generated duplicate plugin artifact: ${relativePath}`);
      }

      const generated = await output.text();
      preludeCount += generated.split(absoluteTypeScriptPrelude).length - 1;
      const portable = generated
        .replace(absoluteTypeScriptPrelude, portableTypeScriptPrelude)
        .replace(/[ \t]+(?=\r?\n)/g, "");
      if (portable.includes(escapedRoot)) {
        throw new Error(`generated plugin artifact still contains the build checkout path: ${relativePath}`);
      }
      built.set(relativePath, new TextEncoder().encode(portable));
    }

    if (preludeCount !== 1) {
      throw new Error(
        `expected one bundled TypeScript path prelude across plugin artifacts, found ${preludeCount}`,
      );
    }

    const actualPaths = [...built.keys()].sort();
    const expectedPaths = [...pluginRuntimeArtifactPaths].sort();
    if (actualPaths.join("\n") !== expectedPaths.join("\n")) {
      throw new Error(
        `unexpected split plugin artifact set; expected ${expectedPaths.join(", ")}, found ${actualPaths.join(", ")}`,
      );
    }

    return new Map(actualPaths.map((path) => [path, built.get(path)!]));
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

export function writePortableTypeScriptLibs(dist: string): void {
  const typescriptLibOutput = resolve(dist, "typescript-lib");
  rmSync(typescriptLibOutput, { recursive: true, force: true });
  mkdirSync(typescriptLibOutput, { recursive: true });
  for (const lib of typescriptLibs) {
    copyFileSync(resolve(typescriptLibSource, lib), resolve(typescriptLibOutput, lib));
  }
}

function filesEqual(left: string, right: string): boolean {
  const leftBytes = readFileSync(left);
  const rightBytes = readFileSync(right);
  return leftBytes.length === rightBytes.length && leftBytes.every((value, index) => value === rightBytes[index]);
}

function bytesEqual(current: Buffer, expected: Uint8Array): boolean {
  return current.length === expected.length && current.every((value, index) => value === expected[index]);
}

function listPluginRuntimeArtifacts(dist: string, directory: string = dist): string[] {
  if (!existsSync(directory)) return [];

  const artifacts: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (directory === dist && entry.name === "typescript-lib" && entry.isDirectory()) continue;

    const absolutePath = resolve(directory, entry.name);
    const relativePath = relative(dist, absolutePath).replaceAll("\\", "/");
    if (entry.isDirectory()) {
      artifacts.push(...listPluginRuntimeArtifacts(dist, absolutePath));
    } else {
      artifacts.push(relativePath);
    }
  }
  return artifacts.sort();
}

export function assertPluginRuntimeArtifactsExact(
  dist: string,
  expected: ReadonlyMap<string, Uint8Array>,
): void {
  const expectedPaths = [...expected.keys()].sort();
  const actualPaths = listPluginRuntimeArtifacts(dist);
  if (actualPaths.join("\n") !== expectedPaths.join("\n")) {
    throw new Error(
      `stale generated plugin artifact set: ${dist}; expected ${expectedPaths.join(", ")}, found ${actualPaths.join(", ")}; run 'bun run plugin:build'`,
    );
  }

  for (const relativePath of expectedPaths) {
    const current = readFileSync(resolve(dist, relativePath));
    const expectedBytes = expected.get(relativePath)!;
    if (!bytesEqual(current, expectedBytes)) {
      throw new Error(
        `stale generated plugin artifact: ${resolve(dist, relativePath)}; run 'bun run plugin:build'`,
      );
    }
  }
}

function textEqual(current: string, expected: string): boolean {
  return current.replaceAll("\r\n", "\n") === expected.replaceAll("\r\n", "\n");
}

async function main(): Promise<void> {
  const built = await buildPortablePluginArtifacts();

  const skillTemplate = readSkillTemplate();
  const renderedSkills = {
    "claude-code": renderControlSkill("claude-code", skillTemplate),
    "semctx-control": renderControlSkill("semctx-control", skillTemplate),
  } as const;

  for (const dist of pluginDists) {
    const typescriptLibOutput = resolve(dist, "typescript-lib");

    if (check) {
      if (!existsSync(typescriptLibOutput)) {
        throw new Error(`missing generated TypeScript libraries: ${typescriptLibOutput}`);
      }
      const currentLibs = readdirSync(typescriptLibOutput).sort();
      if (currentLibs.join("\n") !== typescriptLibs.join("\n")) {
        throw new Error(`stale generated TypeScript library set: ${typescriptLibOutput}; run 'bun run plugin:build'`);
      }
      for (const lib of typescriptLibs) {
        if (!filesEqual(resolve(typescriptLibSource, lib), resolve(typescriptLibOutput, lib))) {
          throw new Error(`stale generated TypeScript library: ${resolve(typescriptLibOutput, lib)}; run 'bun run plugin:build'`);
        }
      }
      assertPluginRuntimeArtifactsExact(dist, built);
      continue;
    }

    rmSync(dist, { recursive: true, force: true });
    mkdirSync(dist, { recursive: true });
    for (const [relativePath, bytes] of built) {
      const output = resolve(dist, relativePath);
      mkdirSync(dirname(output), { recursive: true });
      await Bun.write(output, bytes);
    }
    writePortableTypeScriptLibs(dist);
    assertPluginRuntimeArtifactsExact(dist, built);
  }

  // Host-generated control skills (always build + check — independent of dist loop).
  for (const host of Object.keys(skillOutputs) as SkillHost[]) {
    const output = skillOutputs[host];
    const expected = renderedSkills[host];
    if (check) {
      if (!existsSync(output)) {
        throw new Error(`missing generated control skill: ${output}; run 'bun run plugin:build'`);
      }
      const current = readFileSync(output, "utf8");
      if (!textEqual(current, expected)) {
        throw new Error(`stale generated control skill: ${output}; run 'bun run plugin:build'`);
      }
      continue;
    }
    mkdirSync(dirname(output), { recursive: true });
    await Bun.write(output, expected);
  }

  const sizes = [...built].map(([path, bytes]) => `${path}=${bytes.length}`).join(", ");
  process.stdout.write(
    `${check ? "verified" : "built"} byte-identical plugin runtimes (${sizes}; ${typescriptLibs.length} TypeScript libraries) + host control skills\n`,
  );
}

if (import.meta.main) {
  await main();
}
