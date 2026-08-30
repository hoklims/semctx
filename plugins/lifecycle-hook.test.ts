import { describe, expect, test } from "bun:test";
// The shadow lifecycle hook ships as runnable Node ESM (it runs on machines without Bun). bun:test
// imports it directly; main() is not exported and is guarded by an argv check, so importing it here
// does not execute it.
import {
  canonicalSemctxTool,
  canonicalStageIds,
  computeReportHash,
  evaluateBeforeCompletion,
  formatLifecycleAdvisory,
  hookRepositoryState,
  isHookContract,
  ledgerKey,
  ledgerPath,
  lifecycleEnabled,
  loadHookContract,
  normalizeHookEnvelope,
  pruneLedgerDirectory,
  readLedger,
  resolveRepositoryRoot,
  serializeCanonicalReport,
  stageForToolName,
  MAX_LEDGER_BYTES,
  MAX_LEDGER_FILES,
} from "./claude-code/hooks/semctx-lifecycle.mjs";
import {
  AGENT_LIFECYCLE_POLICY_V1,
  AGENT_LIFECYCLE_REPORT_DOMAIN_V1,
  AGENT_WORKFLOW_CONTRACT_V1,
  computeAgentLifecycleReportV1Hash,
  evaluateAgentLifecycleCheckpointV1,
  type AgentLifecycleCheckpointV1,
  type AgentLifecycleProfileV1,
  type AgentLifecycleRepositoryStateV1,
  type AgentWorkflowStageIdV1,
} from "@semantic-context/control-model";
import {
  AUTOMATED_LIFECYCLE_CHECKPOINT,
  LIFECYCLE_HOOK_CONTRACT_NAME,
  LIFECYCLE_HOOK_SOURCE_NAME,
  renderLifecycleHookContract,
} from "../scripts/build-plugin-runtime.ts";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "..");

function json<T>(relativePath: string): T {
  return JSON.parse(readFileSync(resolve(repoRoot, relativePath), "utf8")) as T;
}
const hostHookDirs = {
  "claude-code": resolve(repoRoot, "plugins/claude-code/hooks"),
  "semctx-control": resolve(repoRoot, "plugins/semctx-control/hooks"),
} as const;
type HookHost = keyof typeof hostHookDirs;
const HOSTS = Object.keys(hostHookDirs) as HookHost[];

const contract = loadHookContract(hostHookDirs["claude-code"]);
const COMPLETION_STAGES = ["reconcile_diff", "verify_change", "change_verify"] as const;
const COMPLETION_TOOLS = {
  reconcile_diff: "semctx_control_reconcile_diff",
  verify_change: "semctx_verify_change",
  change_verify: "semctx_change_verify",
} as const;

/** A minimal Semctx repository: enough for the runtime's own `non_semctx` rule to say "not that". */
function makeRepository(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `semctx-lifecycle-${label}-`));
  mkdirSync(join(root, ".semctx"), { recursive: true });
  writeFileSync(join(root, ".semctx", "config.json"), `${JSON.stringify({ version: 1 }, null, 2)}\n`, "utf8");
  return root;
}

/** Claude Code envelope shape. */
function claudeEnvelope(fields: Record<string, unknown>): Record<string, unknown> {
  return { hook_event_name: "PostToolUse", ...fields };
}

/** Codex envelope shape: same shared fields, plus the turn-scoped and host-specific ones. */
function codexEnvelope(fields: Record<string, unknown>): Record<string, unknown> {
  return {
    hook_event_name: "PostToolUse",
    model: "gpt-5-codex",
    permission_mode: "auto",
    turn_id: "turn-1",
    ...fields,
  };
}

function runHook(
  host: HookHost,
  envelope: unknown,
  options: { env?: Record<string, string | undefined> } = {},
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("node", [join(hostHookDirs[host], LIFECYCLE_HOOK_SOURCE_NAME)], {
    input: JSON.stringify(envelope),
    encoding: "utf8",
    env: { ...process.env, ...options.env },
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function observeSequence(
  host: HookHost,
  root: string,
  sessionId: string,
  tools: readonly string[],
  envelopeShape: (fields: Record<string, unknown>) => Record<string, unknown> = claudeEnvelope,
): void {
  for (const tool of tools) {
    const run = runHook(host, envelopeShape({ session_id: sessionId, cwd: root, tool_name: tool }));
    expect({ tool, status: run.status, stdout: run.stdout }).toEqual({ tool, status: 0, stdout: "" });
  }
}

function stopHook(
  host: HookHost,
  root: string,
  sessionId: string,
  envelopeShape: (fields: Record<string, unknown>) => Record<string, unknown> = claudeEnvelope,
): { status: number | null; stdout: string; stderr: string } {
  return runHook(host, { ...envelopeShape({ session_id: sessionId, cwd: root }), hook_event_name: "Stop" });
}

describe("shadow lifecycle contract is generated from the canonical contracts", () => {
  test("the shipped contract is exactly what the generator renders, in both plugin trees", () => {
    const expected = renderLifecycleHookContract();
    for (const host of HOSTS) {
      const shipped = readFileSync(join(hostHookDirs[host], LIFECYCLE_HOOK_CONTRACT_NAME), "utf8");
      expect({ host, shipped: shipped.replaceAll("\r\n", "\n") }).toEqual({ host, shipped: expected });
    }
  });

  test("both trees ship the same hook body and the same contract, byte for byte", () => {
    for (const name of [LIFECYCLE_HOOK_SOURCE_NAME, LIFECYCLE_HOOK_CONTRACT_NAME]) {
      expect(readFileSync(join(hostHookDirs["claude-code"], name))).toEqual(
        readFileSync(join(hostHookDirs["semctx-control"], name)),
      );
    }
    // The shared source is the SSOT; a hand-edited host copy must be visible here.
    expect(readFileSync(resolve(repoRoot, "plugins/shared/hooks", LIFECYCLE_HOOK_SOURCE_NAME), "utf8")
      .replaceAll("\r\n", "\n"))
      .toBe(readFileSync(join(hostHookDirs["claude-code"], LIFECYCLE_HOOK_SOURCE_NAME), "utf8")
        .replaceAll("\r\n", "\n"));
  });

  test("the tool table is the canonical workflow table, recomputed independently", () => {
    // Rebuilt from AGENT_WORKFLOW_CONTRACT_V1 rather than from the generator, so a generator that
    // learned to emit a divergent table cannot make this test agree with itself.
    const expected: Record<string, string> = {};
    for (const stage of AGENT_WORKFLOW_CONTRACT_V1.stages) {
      for (const tool of stage.mcpTools) expected[tool] = stage.id;
    }
    expect(contract.toolStages).toEqual(expected);
    expect(Object.keys(expected).length).toBeGreaterThan(0);
    // Host-local stages carry no tool and must not appear as observable.
    expect(Object.values(expected)).not.toContain("inspect_repository");
    expect(Object.values(expected)).not.toContain("implement");
  });

  test("checkpoint, stages, altitude, accumulation and hash domain all come from the policy", () => {
    const checkpoint = AGENT_LIFECYCLE_POLICY_V1.checkpoints.find(
      (candidate) => candidate.id === AUTOMATED_LIFECYCLE_CHECKPOINT,
    );
    expect(checkpoint).toBeDefined();
    expect(contract.checkpoint).toBe(AUTOMATED_LIFECYCLE_CHECKPOINT);
    expect(contract.requiredAltitude).toBe(checkpoint!.minimumAltitude);
    expect(contract.requiredStageIds.implementation).toEqual([
      ...checkpoint!.requiredStageIds.implementation,
    ]);
    expect(contract.requiredStageIds.migration).toEqual([...checkpoint!.requiredStageIds.migration]);
    expect(contract.stageOrder).toEqual(AGENT_WORKFLOW_CONTRACT_V1.stages.map((stage) => stage.id));
    expect(contract.policy.accumulationSemantics).toBe(AGENT_LIFECYCLE_POLICY_V1.coordinateAccumulation);
    expect(contract.policy.maxRecordedStageIds).toBe(AGENT_LIFECYCLE_POLICY_V1.limits.maxRecordedStageIds);
    expect(contract.reportDomain).toBe(AGENT_LIFECYCLE_REPORT_DOMAIN_V1);
    // The migration signal is derived from the canonical condition, not named by the generator.
    const migrationStages = AGENT_WORKFLOW_CONTRACT_V1.stages
      .filter((stage) => stage.condition === "migration_task")
      .map((stage) => stage.id);
    expect(migrationStages).toEqual([contract.profileStageId]);
  });

  test("every stage the checkpoint requires is reachable through an MCP tool", () => {
    // A tool observer can only record a stage some MCP tool carries. If a required completion stage
    // were host-local, the hook would report INCOMPLETE forever and every green-path test would
    // still pass — the automation would have become a permanent false accusation.
    const observable = new Set(Object.values(contract.toolStages));
    for (const profile of ["implementation", "migration"] as const) {
      const unobservable = contract.requiredStageIds[profile]
        .filter((stage: string) => !observable.has(stage));
      expect({ profile, unobservable }).toEqual({ profile, unobservable: [] });
    }
    // The two tool-less stages are exactly the host-local ones the workflow schema pins as such,
    // and neither is required by this checkpoint.
    const toolLess = AGENT_WORKFLOW_CONTRACT_V1.stages
      .filter((stage) => stage.mcpTools.length === 0)
      .map((stage) => stage.id)
      .sort();
    expect(toolLess).toEqual(["implement", "inspect_repository"]);
    // Canary: the check would fire on a host-local required stage.
    expect(["reconcile_diff", "implement"].filter((stage) => !observable.has(stage)))
      .toEqual(["implement"]);
  });

  test("the generator refuses a workflow whose migration signal is not unique", () => {
    const twoMigrationStages = {
      ...AGENT_WORKFLOW_CONTRACT_V1,
      stages: AGENT_WORKFLOW_CONTRACT_V1.stages.map((stage) =>
        stage.id === "refine" ? { ...stage, condition: "migration_task" as const } : stage),
    };
    expect(() => renderLifecycleHookContract(twoMigrationStages)).toThrow(/migration_task/);
  });

  test("the hook never calls process.exit, so an async stderr pipe cannot truncate the advisory", () => {
    // Node writes stderr asynchronously to a pipe on macOS. `process.exit` right after the advisory
    // would drop it there, and the CI matrix runs macOS — a regression would be invisible on Windows.
    const source = readFileSync(
      resolve(repoRoot, "plugins/shared/hooks/semctx-lifecycle.mjs"),
      "utf8",
    );
    expect(source).not.toMatch(/process\.exit\s*\(/);
    expect(source).toContain("process.exitCode = 0");
    // Canary: the pattern does match a real call, so the assertion above is not vacuous.
    expect(/process\.exit\s*\(/.test("  process.exit(0);")).toBe(true);
  });

  test("the generated contract only describes before_completion", () => {
    const serialized = readFileSync(join(hostHookDirs["claude-code"], LIFECYCLE_HOOK_CONTRACT_NAME), "utf8");
    for (const deferred of ["before_implementation_write", "after_repository_edits", "before_compaction"]) {
      expect(serialized).not.toContain(deferred);
    }
  });
});

describe("the hook reproduces the control model exactly", () => {
  const REPOSITORY_STATES: AgentLifecycleRepositoryStateV1[] = [
    "non_semctx",
    "semctx_unready",
    "semctx_ready",
  ];
  const SEQUENCES: AgentWorkflowStageIdV1[][] = [
    [],
    ["status"],
    ["reconcile_diff"],
    ["reconcile_diff", "verify_change"],
    ["reconcile_diff", "verify_change", "change_verify"],
    ["change_verify", "reconcile_diff", "verify_change"], // caller order must not matter
    ["target_propose", "reconcile_diff", "verify_change", "change_verify"],
    ["target_propose", "verify_change"],
    [...AGENT_WORKFLOW_CONTRACT_V1.stages.map((stage) => stage.id)],
  ];

  test("same verdict, same fields and same reportHash as evaluateAgentLifecycleCheckpointV1", () => {
    let compared = 0;
    for (const repositoryState of REPOSITORY_STATES) {
      for (const recordedStageIds of SEQUENCES) {
        const hookReport = evaluateBeforeCompletion(contract, { repositoryState, recordedStageIds });
        // The profile the hook derives is recomputed here from the canonical migration condition,
        // then handed to the control model — the two implementations must agree on it.
        const profile: AgentLifecycleProfileV1 = recordedStageIds.includes("target_propose")
          ? "migration"
          : "implementation";
        expect(hookReport.profile).toBe(profile);
        const modelReport = evaluateAgentLifecycleCheckpointV1(repositoryState, {
          schemaVersion: 1,
          checkpoint: AUTOMATED_LIFECYCLE_CHECKPOINT,
          profile,
          requiredAltitude: 0,
          recordedStageIds,
          priorTouchedCoordinateIds: [],
          newlyObservedTouchedCoordinateIds: [],
        });
        // Compared as plain records: the control model returns readonly arrays and the hook is
        // untyped JS, so the readonly-ness would fail assignability before the values are compared.
        const actual: Record<string, unknown> = { ...hookReport };
        const expected: Record<string, unknown> = { ...modelReport };
        expect({ repositoryState, recordedStageIds, report: actual })
          .toEqual({ repositoryState, recordedStageIds, report: expected });
        compared += 1;
      }
    }
    expect(compared).toBe(REPOSITORY_STATES.length * SEQUENCES.length);
  });

  test("canary: a drifted hook report would be caught, hash included", () => {
    const good = evaluateBeforeCompletion(contract, {
      repositoryState: "semctx_ready",
      recordedStageIds: [...COMPLETION_STAGES],
    });
    const model = evaluateAgentLifecycleCheckpointV1("semctx_ready", {
      schemaVersion: 1,
      checkpoint: AUTOMATED_LIFECYCLE_CHECKPOINT,
      profile: "implementation",
      requiredAltitude: 0,
      recordedStageIds: [...COMPLETION_STAGES],
      priorTouchedCoordinateIds: [],
      newlyObservedTouchedCoordinateIds: [],
    });
    expect(good.reportHash).toBe(model.reportHash);
    const drifted = { ...good, stagePresenceVerdict: "RECORDED", profile: "migration" as const };
    const { reportHash: _dropped, ...preimage } = drifted;
    expect(computeReportHash(contract.reportDomain, preimage)).not.toBe(good.reportHash);
    // The hook's canonical serializer and hash are the control model's, not a look-alike.
    const { reportHash: _modelHash, ...modelPreimage } = model;
    expect(computeReportHash(contract.reportDomain, modelPreimage))
      .toBe(computeAgentLifecycleReportV1Hash(modelPreimage));
    expect(serializeCanonicalReport({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  test("before_completion is altitude-invariant, which is what licenses the hook's fixed altitude", () => {
    const decisionOf = (checkpoint: AgentLifecycleCheckpointV1, requiredAltitude: 0 | 1 | 2 | 3 | 4 | 5 | 6) => {
      const report = evaluateAgentLifecycleCheckpointV1("semctx_ready", {
        schemaVersion: 1,
        checkpoint,
        profile: "implementation",
        requiredAltitude,
        recordedStageIds: [...COMPLETION_STAGES],
        priorTouchedCoordinateIds: [],
        newlyObservedTouchedCoordinateIds: [],
      });
      const { reportHash: _hash, requiredAltitude: _altitude, ...decision } = report;
      return decision;
    };
    const altitudes = [0, 1, 2, 3, 4, 5, 6] as const;
    const completion = altitudes.map((altitude) => decisionOf("before_completion", altitude));
    for (const decision of completion) expect(decision).toEqual(completion[0]!);
    // Canary: the same sweep on the L2-gated checkpoint is NOT invariant, so the assertion above is
    // a property of before_completion and not of the decision table in general.
    const preWrite = altitudes.map((altitude) => decisionOf("before_implementation_write", altitude));
    expect(preWrite.some((decision) => JSON.stringify(decision) !== JSON.stringify(preWrite[0]!))).toBe(true);
  });

  test("both profiles require the same completion stages, so profile cannot change the verdict", () => {
    for (const profile of ["implementation", "migration"] as const) {
      const report = evaluateAgentLifecycleCheckpointV1("semctx_ready", {
        schemaVersion: 1,
        checkpoint: "before_completion",
        profile,
        requiredAltitude: 0,
        recordedStageIds: [...COMPLETION_STAGES],
        priorTouchedCoordinateIds: [],
        newlyObservedTouchedCoordinateIds: [],
      });
      expect(report.stagePresenceVerdict).toBe("RECORDED");
      expect(report.missingStageIds).toEqual([]);
    }
  });
});

describe("pure surfaces", () => {
  test("only the bundled semctx MCP server can produce canonical lifecycle stages", () => {
    expect(stageForToolName(contract, "mcp__semctx__semctx_control_reconcile_diff")).toBe("reconcile_diff");
    expect(canonicalSemctxTool(contract, "mcp__semctx__semctx_control_trace")).toBe("semctx_control_trace");
    // A different server cannot manufacture Semctx evidence by exposing the same method name.
    expect(stageForToolName(contract, "mcp__renamed-server__semctx_verify_change")).toBeNull();
    expect(stageForToolName(contract, "mcp__other__semctx_verify_change")).toBeNull();
    // Not lifecycle tools, raw method names, and substring matches are all refused.
    expect(stageForToolName(contract, "semctx_change_verify")).toBeNull();
    expect(stageForToolName(contract, "Bash")).toBeNull();
    expect(stageForToolName(contract, "mcp__semctx__semctx_setup")).toBeNull();
    expect(stageForToolName(contract, "semctx_verify_change_extra")).toBeNull();
    expect(stageForToolName(contract, "mcp__other__read_file")).toBeNull();
    expect(stageForToolName(contract, "")).toBeNull();
    expect(stageForToolName(contract, "__proto__")).toBeNull();
    expect(stageForToolName(contract, "mcp__x__constructor")).toBeNull();
  });

  test("envelopes from either host normalize to the same four fields and nothing else", () => {
    const claude = normalizeHookEnvelope({
      hook_event_name: "PostToolUse",
      session_id: "s-1",
      cwd: "/repo",
      tool_name: "mcp__semctx__semctx_verify_change",
      transcript_path: "/home/user/.claude/projects/x.jsonl",
      tool_input: { secret: "hunter2" },
      tool_response: { content: "PRIVATE" },
    });
    const codex = normalizeHookEnvelope({
      hook_event_name: "PostToolUse",
      session_id: "s-1",
      cwd: "/repo",
      tool_name: "mcp__semctx__semctx_verify_change",
      model: "gpt-5-codex",
      permission_mode: "auto",
      turn_id: "turn-9",
      transcript_path: "/home/user/.codex/sessions/x.jsonl",
    });
    expect(claude).toEqual(codex);
    expect(Object.keys(claude!).sort()).toEqual(["cwd", "event", "sessionId", "toolName"]);
    expect(normalizeHookEnvelope({ session_id: "s" })).toBeNull();
    expect(normalizeHookEnvelope(null)).toBeNull();
    expect(normalizeHookEnvelope([])).toBeNull();
    expect(normalizeHookEnvelope("Stop")).toBeNull();
  });

  test("the hook never asserts semctx_ready, even for a fully configured repository", () => {
    const root = makeRepository("ready");
    try {
      mkdirSync(join(root, ".semctx", "semantic"), { recursive: true });
      writeFileSync(join(root, ".semctx", "semctx.db"), "not-a-real-store", "utf8");
      expect(hookRepositoryState(root)).toBe("semctx_unready");
      const bare = mkdtempSync(join(tmpdir(), "semctx-lifecycle-bare-"));
      try {
        expect(hookRepositoryState(bare)).toBe("non_semctx");
      } finally {
        rmSync(bare, { recursive: true, force: true });
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the repository is cwd itself, never an ancestor, and untrusted cwd values resolve to null", () => {
    const root = makeRepository("root-bind");
    try {
      expect(resolveRepositoryRoot(root)).toBe(resolve(root));
      expect(resolveRepositoryRoot(join(root, "does-not-exist"))).toBeNull();
      expect(resolveRepositoryRoot("")).toBeNull();
      expect(resolveRepositoryRoot(null)).toBeNull();
      expect(resolveRepositoryRoot(join(root, ".semctx", "config.json"))).toBeNull(); // a file, not a dir
      // A relative cwd is refused, not resolved: resolve() would anchor it to the hook process's own
      // working directory, which is not the host's repository.
      expect(resolveRepositoryRoot(".")).toBeNull();
      expect(resolveRepositoryRoot("packages")).toBeNull();
      expect(resolveRepositoryRoot("../semctx")).toBeNull();

      // No ancestor walk: a scratch directory inside a Semctx repository is `non_semctx` on its own.
      // An ancestor walk would bind the hook to the enclosing repository and write its ledger there,
      // which is how a home directory carrying `.semctx` captures unrelated sessions.
      const nested = join(root, "packages", "app", "src");
      mkdirSync(nested, { recursive: true });
      expect(resolveRepositoryRoot(nested)).toBe(resolve(nested));
      expect(hookRepositoryState(nested)).toBe("non_semctx");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a session inside an enclosing Semctx repository never writes that repository's ledger", () => {
    // The regression this pins: a scratch directory whose ANCESTOR is a Semctx repository. The hook
    // must treat it as `non_semctx` and touch nothing, rather than adopting the ancestor.
    const enclosing = makeRepository("enclosing");
    try {
      const scratch = join(enclosing, "tmp", "scratch");
      mkdirSync(scratch, { recursive: true });
      const run = runHook(
        "claude-code",
        claudeEnvelope({
          session_id: "session-nested",
          cwd: scratch,
          tool_name: `mcp__semctx__${COMPLETION_TOOLS.verify_change}`,
        }),
      );
      expect({ status: run.status, stdout: run.stdout, stderr: run.stderr })
        .toEqual({ status: 0, stdout: "", stderr: "" });
      expect(readdirSync(join(enclosing, ".semctx"))).toEqual(["config.json"]);
      expect(readdirSync(scratch)).toEqual([]);
    } finally {
      rmSync(enclosing, { recursive: true, force: true });
    }
  });

  test("the ledger key is an opaque digest that separates sessions and repositories", () => {
    const a = ledgerKey("session-a", "/repo/one");
    const b = ledgerKey("session-b", "/repo/one");
    const c = ledgerKey("session-a", "/repo/two");
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(new Set([a, b, c]).size).toBe(3);
    expect(a).not.toContain("session-a");
    expect(ledgerKey("session-a", "/repo/one")).toBe(a); // deterministic
    expect(ledgerPath("/repo/one", a).replaceAll("\\", "/"))
      .toBe(`/repo/one/.semctx/working/agent-lifecycle/${a}.ndjson`);
  });

  test("a hostile session id cannot escape the ledger directory or name a file", () => {
    const root = makeRepository("hostile-session");
    const hostile = [
      "../../../../etc/passwd",
      "..\\..\\..\\windows\\system32",
      "a".repeat(4096),
      "sess ion",
      "session‮exe",
      ".",
      "..",
    ];
    try {
      for (const sessionId of hostile) {
        const run = runHook(
          "claude-code",
          claudeEnvelope({
            session_id: sessionId,
            cwd: root,
            tool_name: `mcp__semctx__${COMPLETION_TOOLS.verify_change}`,
          }),
        );
        expect({ sessionId: sessionId.slice(0, 12), status: run.status, stderr: run.stderr })
          .toEqual({ sessionId: sessionId.slice(0, 12), status: 0, stderr: "" });
      }
      // Every ledger is a digest inside the one directory: the identifier never reaches a path.
      const directory = join(root, ".semctx", "working", "agent-lifecycle");
      const entries = readdirSync(directory).sort();
      expect(entries).toHaveLength(hostile.length);
      for (const entry of entries) expect(entry).toMatch(/^[0-9a-f]{64}\.ndjson$/);
      // Nothing was created anywhere else under the repository.
      expect(readdirSync(join(root, ".semctx")).sort()).toEqual(["config.json", "working"]);
      expect(readdirSync(join(root, ".semctx", "working"))).toEqual(["agent-lifecycle"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a malformed contract is refused instead of half-trusted", () => {
    expect(isHookContract(contract)).toBe(true);
    expect(isHookContract(null)).toBe(false);
    expect(isHookContract({ ...contract, schemaVersion: 2 })).toBe(false);
    expect(isHookContract({ ...contract, checkpoint: "before_compaction" })).toBe(false);
    expect(isHookContract({ ...contract, reportDomain: "" })).toBe(false);
    expect(isHookContract({ ...contract, stageOrder: [] })).toBe(false);
    expect(isHookContract({ ...contract, toolStages: null })).toBe(false);
    expect(isHookContract({ ...contract, requiredStageIds: { implementation: [] } })).toBe(false);
    expect(isHookContract({ ...contract, policy: { accumulationSemantics: "x" } })).toBe(false);
    expect(loadHookContract(mkdtempSync(join(tmpdir(), "semctx-lifecycle-nocontract-")))).toBeNull();
  });

  test("the off switch is honoured and everything else leaves the observer on", () => {
    for (const value of ["off", "OFF", "0", "false"]) {
      expect(lifecycleEnabled({ SEMCTX_LIFECYCLE: value })).toBe(false);
    }
    for (const value of [undefined, "", "on", "1", "true", "anything"]) {
      expect(lifecycleEnabled({ SEMCTX_LIFECYCLE: value })).toBe(true);
    }
  });

  test("the advisory names the checkpoint's limits and never carries an authorization", () => {
    const report = evaluateBeforeCompletion(contract, {
      repositoryState: "semctx_unready",
      recordedStageIds: ["reconcile_diff"],
    });
    const text = formatLifecycleAdvisory(report).join("\n");
    expect(text).toContain("before_completion: INCOMPLETE");
    expect(text).toContain("missing stages: verify_change, change_verify");
    expect(text).toContain("enforcement is shadow");
    expect(text).toContain("blocking is disabled");
    expect(text).toContain("execution authority is none");
    expect(text).toContain("never asserts semctx_ready");
    expect(text).toContain("checkpoint floor, not a task claim");
    expect(text).toContain(report.reportHash);
    // Whole tokens: `UNREADY` legitimately contains `READY`, and a substring scan would either miss
    // a real verdict leak or fire on the reason code.
    for (const forbidden of [/\ballow\b/, /\bdeny\b/, /permissionDecision/, /\bapproved\b/, /\bauthorized\b/, /\bREADY\b/, /\bBLOCK\b/]) {
      expect({ pattern: forbidden.source, leaked: forbidden.test(text) })
        .toEqual({ pattern: forbidden.source, leaked: false });
    }
    // Canary: the token scan does fire on a real verdict leak.
    expect(/\bREADY\b/.test("plan verdict: READY")).toBe(true);
  });
});

describe("ledger reading is a verdict, never a throw", () => {
  test("missing, torn, corrupt, oversized and non-file ledgers each get their own verdict", () => {
    const directory = mkdtempSync(join(tmpdir(), "semctx-lifecycle-ledger-"));
    try {
      const path = join(directory, "ledger.ndjson");
      expect(readLedger(contract, path))
        .toEqual({ state: "missing", stageIds: [], reportedStageIds: null });

      writeFileSync(path, '{"schemaVersion":1,"stageId":"verify_change"}\n', "utf8");
      expect(readLedger(contract, path))
        .toEqual({ state: "valid", stageIds: ["verify_change"], reportedStageIds: null });

      // A torn final record is the tail of a racing append: dropped, the rest survives.
      writeFileSync(path, '{"schemaVersion":1,"stageId":"verify_change"}\n{"schemaVersion":1,"stag', "utf8");
      expect(readLedger(contract, path))
        .toEqual({ state: "valid", stageIds: ["verify_change"], reportedStageIds: null });

      // A broken record that is NOT the tail is corruption, not a race.
      writeFileSync(path, 'garbage\n{"schemaVersion":1,"stageId":"verify_change"}\n', "utf8");
      expect(readLedger(contract, path))
        .toEqual({ state: "invalid", stageIds: [], reportedStageIds: null });

      writeFileSync(path, '{"schemaVersion":1,"stageId":"not_a_stage"}\n', "utf8");
      expect(readLedger(contract, path))
        .toEqual({ state: "invalid", stageIds: [], reportedStageIds: null });

      writeFileSync(path, '{"schemaVersion":2,"stageId":"verify_change"}\n', "utf8");
      expect(readLedger(contract, path))
        .toEqual({ state: "invalid", stageIds: [], reportedStageIds: null });

      // Whole-file garbage with no trailing newline: dropping the unterminated tail must not turn it
      // into an empty-but-valid ledger that the observer would then append to.
      writeFileSync(path, "totally not json", "utf8");
      expect(readLedger(contract, path))
        .toEqual({ state: "invalid", stageIds: [], reportedStageIds: null });
      // An empty file is the absence of records, not garbage.
      writeFileSync(path, "", "utf8");
      expect(readLedger(contract, path))
        .toEqual({ state: "valid", stageIds: [], reportedStageIds: null });

      writeFileSync(path, `${"x".repeat(MAX_LEDGER_BYTES + 1)}\n`, "utf8");
      expect(readLedger(contract, path))
        .toEqual({ state: "invalid", stageIds: [], reportedStageIds: null });

      rmSync(path, { force: true });
      mkdirSync(path);
      expect(readLedger(contract, path))
        .toEqual({ state: "invalid", stageIds: [], reportedStageIds: null });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("a report watermark is read back and never counted as an observation", () => {
    const directory = mkdtempSync(join(tmpdir(), "semctx-lifecycle-watermark-"));
    try {
      const path = join(directory, "ledger.ndjson");
      writeFileSync(
        path,
        [
          JSON.stringify({ schemaVersion: 1, stageId: "reconcile_diff" }),
          JSON.stringify({ schemaVersion: 1, reportedStageIds: ["reconcile_diff"] }),
          JSON.stringify({ schemaVersion: 1, stageId: "verify_change" }),
        ].join("\n") + "\n",
        "utf8",
      );
      expect(readLedger(contract, path)).toEqual({
        state: "valid",
        stageIds: ["reconcile_diff", "verify_change"],
        reportedStageIds: ["reconcile_diff"],
      });

      // A watermark naming an unknown stage is corruption, exactly like an unknown observation.
      writeFileSync(path, `${JSON.stringify({ schemaVersion: 1, reportedStageIds: ["nope"] })}\n`, "utf8");
      expect(readLedger(contract, path).state).toBe("invalid");
      // A record that is neither shape is corruption too.
      writeFileSync(path, `${JSON.stringify({ schemaVersion: 1, other: true })}\n`, "utf8");
      expect(readLedger(contract, path).state).toBe("invalid");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("records are deduplicated and returned in canonical workflow order", () => {
    const directory = mkdtempSync(join(tmpdir(), "semctx-lifecycle-order-"));
    try {
      const path = join(directory, "ledger.ndjson");
      writeFileSync(
        path,
        ["change_verify", "reconcile_diff", "verify_change", "reconcile_diff"]
          .map((stageId) => `${JSON.stringify({ schemaVersion: 1, stageId })}\n`)
          .join(""),
        "utf8",
      );
      expect(readLedger(contract, path)).toEqual({
        state: "valid",
        stageIds: ["reconcile_diff", "verify_change", "change_verify"],
        reportedStageIds: null,
      });
      expect(canonicalStageIds(contract, ["change_verify", "status", "status"]))
        .toEqual(["status", "change_verify"]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("retention is a cap on ledger count, and never evicts the ledger being written", () => {
    const directory = mkdtempSync(join(tmpdir(), "semctx-lifecycle-prune-"));
    try {
      const names: string[] = [];
      for (let index = 0; index < MAX_LEDGER_FILES + 10; index += 1) {
        const name = `${ledgerKey(`session-${index}`, "/repo").slice(0, 64)}.ndjson`;
        writeFileSync(join(directory, name), '{"schemaVersion":1,"stageId":"status"}\n', "utf8");
        const stamp = new Date((index + 1) * 1000);
        utimesSync(join(directory, name), stamp, stamp);
        names.push(name);
      }
      writeFileSync(join(directory, "unrelated.txt"), "keep me", "utf8");
      const oldest = names[0]!;
      const keep = names[names.length - 1]!;
      const removed = pruneLedgerDirectory(directory, keep);
      expect(removed).toContain(oldest);
      expect(removed).not.toContain(keep);
      const remaining = readdirSync(directory);
      expect(remaining).toContain(keep);
      expect(remaining).toContain("unrelated.txt"); // only ledger files are eligible
      expect(remaining.filter((name) => name.endsWith(".ndjson"))).toHaveLength(MAX_LEDGER_FILES);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("end to end on both hosts", () => {
  test("a complete sequence reports RECORDED identically on Codex and Claude Code", () => {
    const claudeRepo = makeRepository("parity-claude");
    const codexRepo = makeRepository("parity-codex");
    try {
      const tools = COMPLETION_STAGES.map((stage) => `mcp__semctx__${COMPLETION_TOOLS[stage]}`);
      observeSequence("claude-code", claudeRepo, "session-x", tools, claudeEnvelope);
      observeSequence("semctx-control", codexRepo, "session-x", tools, codexEnvelope);

      const claude = stopHook("claude-code", claudeRepo, "session-x", claudeEnvelope);
      const codex = stopHook("semctx-control", codexRepo, "session-x", codexEnvelope);

      expect({ status: claude.status, stdout: claude.stdout }).toEqual({ status: 0, stdout: "" });
      expect({ status: codex.status, stdout: codex.stdout }).toEqual({ status: 0, stdout: "" });
      // Same observed sequence, same report and same reportHash under two native envelopes.
      expect(claude.stderr).toBe(codex.stderr);
      expect(claude.stderr).toContain("before_completion: RECORDED");
      expect(claude.stderr).toContain("recorded stages: reconcile_diff, verify_change, change_verify");
      expect(claude.stderr).toMatch(/reportHash: sha256:[0-9a-f]{64}/);

      const expected = evaluateBeforeCompletion(contract, {
        repositoryState: "semctx_unready",
        recordedStageIds: [...COMPLETION_STAGES],
      });
      expect(claude.stderr.trimEnd()).toBe(formatLifecycleAdvisory(expected).join("\n"));
    } finally {
      rmSync(claudeRepo, { recursive: true, force: true });
      rmSync(codexRepo, { recursive: true, force: true });
    }
  });

  test("a partial sequence names exactly the missing completion stages", () => {
    const root = makeRepository("partial");
    try {
      observeSequence("claude-code", root, "session-partial", [
        "mcp__semctx__semctx_control_status",
        "mcp__semctx__semctx_control_reconcile_diff",
      ]);
      const stop = stopHook("claude-code", root, "session-partial");
      expect(stop.status).toBe(0);
      expect(stop.stderr).toContain("before_completion: INCOMPLETE");
      expect(stop.stderr).toContain("missing stages: verify_change, change_verify");
      expect(stop.stderr).toContain("recorded stages: status, reconcile_diff");
      expect(stop.stderr).toContain("reason codes: SEMCTX_REPOSITORY_UNREADY, REQUIRED_STAGE_NOT_RECORDED");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the advisory speaks only when the observed set changed, so a green never goes stale", () => {
    // The host ends a turn many times per session while the ledger spans the whole session. Without
    // a watermark, one completed cycle would keep reporting RECORDED over every later turn — turns
    // that produced no evidence at all — which is a false green on a governance advisory.
    const root = makeRepository("change-only");
    try {
      observeSequence("claude-code", root, "session-turns", [
        `mcp__semctx__${COMPLETION_TOOLS.reconcile_diff}`,
      ]);
      const first = stopHook("claude-code", root, "session-turns");
      expect(first.stderr).toContain("before_completion: INCOMPLETE");

      // Same turn boundary again, nothing new observed: silence, not a repeat.
      const repeated = stopHook("claude-code", root, "session-turns");
      expect({ status: repeated.status, stderr: repeated.stderr }).toEqual({ status: 0, stderr: "" });

      observeSequence("claude-code", root, "session-turns", [
        `mcp__semctx__${COMPLETION_TOOLS.verify_change}`,
        `mcp__semctx__${COMPLETION_TOOLS.change_verify}`,
      ]);
      const completed = stopHook("claude-code", root, "session-turns");
      expect(completed.stderr).toContain("before_completion: RECORDED");

      // The regression this pins: later turns with no new evidence must NOT keep claiming RECORDED.
      for (const attempt of [1, 2, 3]) {
        const later = stopHook("claude-code", root, "session-turns");
        expect({ attempt, status: later.status, stderr: later.stderr })
          .toEqual({ attempt, status: 0, stderr: "" });
      }

      // A new observation makes it speak again.
      observeSequence("claude-code", root, "session-turns", [
        "mcp__semctx__semctx_control_handoff",
      ]);
      expect(stopHook("claude-code", root, "session-turns").stderr)
        .toContain("before_completion: RECORDED");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("observing target_propose is what makes the report a migration, and it is observed not assumed", () => {
    const root = makeRepository("migration");
    try {
      observeSequence("claude-code", root, "session-migration", [
        "mcp__semctx__semctx_control_target_propose",
        ...COMPLETION_STAGES.map((stage) => `mcp__semctx__${COMPLETION_TOOLS[stage]}`),
      ]);
      expect(stopHook("claude-code", root, "session-migration").stderr)
        .toContain("profile: migration (observed)");

      observeSequence("claude-code", root, "session-implementation", [
        `mcp__semctx__${COMPLETION_TOOLS.reconcile_diff}`,
      ]);
      expect(stopHook("claude-code", root, "session-implementation").stderr)
        .toContain("profile: implementation (observed)");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("silence, not a false accusation, when nothing was observed", () => {
    const root = makeRepository("silent");
    try {
      // No tool events at all: a host that cannot deliver them must not look like a skipped agent.
      const cold = stopHook("claude-code", root, "session-cold");
      expect({ status: cold.status, stdout: cold.stdout, stderr: cold.stderr })
        .toEqual({ status: 0, stdout: "", stderr: "" });

      // Only non-lifecycle tools: nothing is recorded and no ledger file is created.
      observeSequence("claude-code", root, "session-noise", [
        "Bash",
        "Read",
        "mcp__semctx__semctx_setup",
        "mcp__other__something",
      ]);
      const noise = stopHook("claude-code", root, "session-noise");
      expect({ status: noise.status, stderr: noise.stderr }).toEqual({ status: 0, stderr: "" });
      // Not merely an empty ledger: a non-lifecycle tool must not even create the scratch directory.
      expect(readdirSync(join(root, ".semctx"))).toEqual(["config.json"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("sessions and repositories stay isolated when their events interleave", () => {
    const repoOne = makeRepository("iso-one");
    const repoTwo = makeRepository("iso-two");
    try {
      // Interleaved, so a shared ledger would let one session's calls satisfy another's checkpoint.
      observeSequence("claude-code", repoOne, "session-a", [`mcp__semctx__${COMPLETION_TOOLS.reconcile_diff}`]);
      observeSequence("claude-code", repoOne, "session-b", [`mcp__semctx__${COMPLETION_TOOLS.verify_change}`]);
      observeSequence("claude-code", repoTwo, "session-a", [`mcp__semctx__${COMPLETION_TOOLS.change_verify}`]);
      observeSequence("claude-code", repoOne, "session-a", [`mcp__semctx__${COMPLETION_TOOLS.verify_change}`]);

      const oneA = stopHook("claude-code", repoOne, "session-a").stderr;
      const oneB = stopHook("claude-code", repoOne, "session-b").stderr;
      const twoA = stopHook("claude-code", repoTwo, "session-a").stderr;

      expect(oneA).toContain("recorded stages: reconcile_diff, verify_change");
      expect(oneA).toContain("missing stages: change_verify");
      expect(oneB).toContain("recorded stages: verify_change");
      expect(oneB).toContain("missing stages: reconcile_diff, change_verify");
      expect(twoA).toContain("recorded stages: change_verify");
      expect(twoA).toContain("missing stages: reconcile_diff, verify_change");

      expect(readdirSync(join(repoOne, ".semctx", "working", "agent-lifecycle"))).toHaveLength(2);
      expect(readdirSync(join(repoTwo, ".semctx", "working", "agent-lifecycle"))).toHaveLength(1);
    } finally {
      rmSync(repoOne, { recursive: true, force: true });
      rmSync(repoTwo, { recursive: true, force: true });
    }
  });

  test("secrets carried by the envelope reach neither the ledger nor the output", () => {
    const root = makeRepository("secrets");
    const secrets = [
      "sk-live-DO-NOT-LEAK-0123456789",
      "/home/agent/.claude/projects/private-transcript.jsonl",
      "PASSWORD=correct-horse-battery-staple",
      "session-with-a-very-identifiable-name",
    ];
    try {
      const run = runHook("claude-code", {
        hook_event_name: "PostToolUse",
        session_id: secrets[3],
        cwd: root,
        tool_name: `mcp__semctx__${COMPLETION_TOOLS.verify_change}`,
        prompt: secrets[0],
        transcript_path: secrets[1],
        tool_input: { command: secrets[2], repositoryRoot: root },
        tool_response: { content: secrets[0] },
        model: "gpt-5-codex",
        permission_mode: "bypassPermissions",
      });
      expect({ status: run.status, stdout: run.stdout, stderr: run.stderr })
        .toEqual({ status: 0, stdout: "", stderr: "" });

      const directory = join(root, ".semctx", "working", "agent-lifecycle");
      const entries = readdirSync(directory);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatch(/^[0-9a-f]{64}\.ndjson$/);
      const bytes = readFileSync(join(directory, entries[0]!), "utf8");
      expect(bytes).toBe('{"schemaVersion":1,"stageId":"verify_change"}\n');
      const stop = stopHook("claude-code", root, secrets[3]!);
      for (const secret of secrets) {
        expect({ secret, inLedger: bytes.includes(secret) }).toEqual({ secret, inLedger: false });
        expect({ secret, inName: entries[0]!.includes(secret) }).toEqual({ secret, inName: false });
        expect({ secret, inOutput: `${stop.stdout}${stop.stderr}`.includes(secret) })
          .toEqual({ secret, inOutput: false });
      }
      // Canary: the assertion above is only meaningful if the secrets were actually delivered.
      expect(secrets.every((secret) => secret.length > 8)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("nothing is read, written or printed outside a Semctx repository", () => {
    const foreign = mkdtempSync(join(tmpdir(), "semctx-lifecycle-foreign-"));
    try {
      for (const event of ["PostToolUse", "Stop"]) {
        const run = runHook("claude-code", {
          hook_event_name: event,
          session_id: "session-foreign",
          cwd: foreign,
          tool_name: `mcp__semctx__${COMPLETION_TOOLS.verify_change}`,
        });
        expect({ event, status: run.status, stdout: run.stdout, stderr: run.stderr })
          .toEqual({ event, status: 0, stdout: "", stderr: "" });
      }
      expect(readdirSync(foreign)).toEqual([]); // no .semctx was created
    } finally {
      rmSync(foreign, { recursive: true, force: true });
    }
  });

  test("SEMCTX_LIFECYCLE=off records nothing and reports nothing", () => {
    const root = makeRepository("disabled");
    try {
      const observed = runHook(
        "claude-code",
        claudeEnvelope({
          session_id: "session-off",
          cwd: root,
          tool_name: `mcp__semctx__${COMPLETION_TOOLS.verify_change}`,
        }),
        { env: { SEMCTX_LIFECYCLE: "off" } },
      );
      expect({ status: observed.status, stderr: observed.stderr }).toEqual({ status: 0, stderr: "" });
      expect(readdirSync(join(root, ".semctx"))).not.toContain("working");

      // With the observer back on, a Stop over an empty ledger is still silent.
      const stop = stopHook("claude-code", root, "session-off");
      expect({ status: stop.status, stderr: stop.stderr }).toEqual({ status: 0, stderr: "" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("every hostile input exits 0 with an empty stdout on both hosts", () => {
    const root = makeRepository("hostile");
    const ledgerDirectory = join(root, ".semctx", "working", "agent-lifecycle");
    try {
      const key = ledgerKey("session-corrupt", root);
      mkdirSync(ledgerDirectory, { recursive: true });
      writeFileSync(join(ledgerDirectory, `${key}.ndjson`), "not json at all\n", "utf8");

      const cases: Array<[string, unknown]> = [
        ["empty object", {}],
        ["null envelope", null],
        ["array envelope", []],
        ["unknown event", { hook_event_name: "PreCompact", session_id: "s", cwd: root }],
        ["no session id", { hook_event_name: "Stop", cwd: root }],
        ["no cwd", { hook_event_name: "Stop", session_id: "s" }],
        ["cwd outside any repository", { hook_event_name: "Stop", session_id: "s", cwd: "/nope/nowhere" }],
        ["non-string tool name", { hook_event_name: "PostToolUse", session_id: "s", cwd: root, tool_name: 42 }],
        ["corrupt ledger on Stop", { hook_event_name: "Stop", session_id: "session-corrupt", cwd: root }],
        [
          "corrupt ledger on PostToolUse",
          {
            hook_event_name: "PostToolUse",
            session_id: "session-corrupt",
            cwd: root,
            tool_name: `mcp__semctx__${COMPLETION_TOOLS.verify_change}`,
          },
        ],
      ];
      for (const host of HOSTS) {
        for (const [label, envelope] of cases) {
          const run = runHook(host, envelope);
          expect({ host, label, status: run.status, stdout: run.stdout })
            .toEqual({ host, label, status: 0, stdout: "" });
          expect({ host, label, stderr: run.stderr }).toEqual({ host, label, stderr: "" });
        }
        // Not JSON at all on stdin.
        const raw = spawnSync("node", [join(hostHookDirs[host], LIFECYCLE_HOOK_SOURCE_NAME)], {
          input: "}{ not json",
          encoding: "utf8",
        });
        expect({ host, status: raw.status, stdout: raw.stdout, stderr: raw.stderr })
          .toEqual({ host, status: 0, stdout: "", stderr: "" });
      }
      // Corruption is never repaired by appending to it.
      expect(readFileSync(join(ledgerDirectory, `${key}.ndjson`), "utf8")).toBe("not json at all\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a symlinked scratch directory is refused instead of writing the ledger outside the repository", () => {
    const root = makeRepository("symlinked-scratch");
    const outside = mkdtempSync(join(tmpdir(), "semctx-lifecycle-outside-"));
    let linked: boolean;
    try {
      try {
        symlinkSync(outside, join(root, ".semctx", "working"), "junction");
        linked = true;
      } catch {
        linked = false; // unprivileged Windows sessions cannot create links; skip the assertion
      }
      if (linked) {
        const run = runHook(
          "claude-code",
          claudeEnvelope({
            session_id: "session-symlink",
            cwd: root,
            tool_name: `mcp__semctx__${COMPLETION_TOOLS.verify_change}`,
          }),
        );
        expect({ status: run.status, stdout: run.stdout, stderr: run.stderr })
          .toEqual({ status: 0, stdout: "", stderr: "" });
        // The refusal is what matters: nothing was written through the link.
        expect(readdirSync(outside)).toEqual([]);
      }
    } finally {
      rmSync(join(root, ".semctx", "working"), { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("an unwritable ledger location degrades to silence instead of a failed host turn", () => {
    const root = makeRepository("unwritable");
    try {
      // A regular file where the ledger directory belongs makes every fs call on that path throw.
      mkdirSync(join(root, ".semctx", "working"), { recursive: true });
      writeFileSync(join(root, ".semctx", "working", "agent-lifecycle"), "not a directory", "utf8");
      const run = runHook(
        "claude-code",
        claudeEnvelope({
          session_id: "session-unwritable",
          cwd: root,
          tool_name: `mcp__semctx__${COMPLETION_TOOLS.verify_change}`,
        }),
      );
      expect({ status: run.status, stdout: run.stdout, stderr: run.stderr })
        .toEqual({ status: 0, stdout: "", stderr: "" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the Codex command resolves from PLUGIN_ROOT independently of the session cwd", () => {
    const root = makeRepository("codex-cwd");
    const pluginDirectory = resolve(repoRoot, "plugins/semctx-control");
    const wired = json<{ hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> }>(
      "plugins/semctx-control/hooks/hooks.json",
    );
    try {
      for (const event of ["PostToolUse", "Stop"] as const) {
        const command = wired.hooks[event]![0]!.hooks[0]!.command;
        expect(command).toBe('node "${PLUGIN_ROOT}/hooks/semctx-lifecycle.mjs"');
        const expanded = command.replace("${PLUGIN_ROOT}", pluginDirectory.replaceAll("\\", "/"));
        const match = /^node "(.+)"$/.exec(expanded);
        expect(match).not.toBeNull();
        const run = spawnSync("node", [match![1]!], {
          cwd: root,
          input: JSON.stringify({
            hook_event_name: event,
            session_id: "session-codex-cwd",
            cwd: root,
            tool_name: `mcp__semctx__${COMPLETION_TOOLS.verify_change}`,
          }),
          encoding: "utf8",
        });
        // Resolved and ran from the repository cwd, which is the cwd Codex supplies to commands.
        expect({ event, status: run.status, stdout: run.stdout }).toEqual({ event, status: 0, stdout: "" });
        expect({ event, notFound: (run.stderr ?? "").includes("MODULE_NOT_FOUND") })
          .toEqual({ event, notFound: false });
      }
      // The observation really landed, so the run was the hook and not a silent no-op.
      expect(readdirSync(join(root, ".semctx", "working", "agent-lifecycle"))).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a hook without its generated contract is inert rather than guessing the policy", () => {
    const root = makeRepository("nocontract");
    const isolated = mkdtempSync(join(tmpdir(), "semctx-lifecycle-isolated-"));
    try {
      const copied = join(isolated, LIFECYCLE_HOOK_SOURCE_NAME);
      writeFileSync(
        copied,
        readFileSync(join(hostHookDirs["claude-code"], LIFECYCLE_HOOK_SOURCE_NAME), "utf8"),
        "utf8",
      );
      const run = spawnSync("node", [copied], {
        input: JSON.stringify(
          claudeEnvelope({
            session_id: "session-nocontract",
            cwd: root,
            tool_name: `mcp__semctx__${COMPLETION_TOOLS.verify_change}`,
          }),
        ),
        encoding: "utf8",
      });
      expect({ status: run.status, stdout: run.stdout, stderr: run.stderr })
        .toEqual({ status: 0, stdout: "", stderr: "" });
      expect(readdirSync(join(root, ".semctx"))).not.toContain("working");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(isolated, { recursive: true, force: true });
    }
  });
});
